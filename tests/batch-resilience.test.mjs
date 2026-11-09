import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCheckpointWriter } from "../src/checkpoint-writer.mjs";
import { isTransientConnectionError, retryTransient } from "../src/transient-errors.mjs";

const runner = await readFile(new URL("../src/batch-runner.mjs", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

/**
 * 三条翻译期的韧性加固：
 * ① 批次落盘节流（别把 Directus 压出压力保护）；
 * ② 连接层失败自动重试一次（内容层错误不重试）；
 * ③ 界面遇 Directus 503 自动重试一次并给友好提示。
 */
test("批次落盘节流：段落开始按阈值落盘，段落结果必须落盘", async () => {
  let clock = 1_000_000;
  let writes = 0;
  const writer = createCheckpointWriter({
    save: async () => { writes += 1; },
    now: () => clock,
    minSegments: 10,
    minIntervalMs: 30_000
  });
  // 第一次 mark 立刻落盘（让"正在跑"这件事可见），之后 9 次只动内存。
  assert.equal(await writer.mark(), true);
  for (let index = 0; index < 9; index += 1) assert.equal(await writer.mark(), false);
  assert.equal(writes, 1);
  // 第 10 次按段数阈值落盘
  assert.equal(await writer.mark(), true);
  assert.equal(writes, 2);
  // 时间到了也落盘
  clock += 31_000;
  assert.equal(await writer.mark(), true);
  assert.equal(writes, 3);
  // 段落结果：无条件落盘
  await writer.commit();
  assert.equal(writes, 4);

  // 78 段的批次（每段约 20 秒，低于 30 秒阈值）：整行写从 ~156 次降到 79 次。
  let bulkWrites = 0;
  let bulkClock = 3_000_000;
  const bulk = createCheckpointWriter({ save: async () => { bulkWrites += 1; }, now: () => bulkClock });
  await bulk.commit();
  for (let index = 0; index < 78; index += 1) {
    bulkClock += 20_000; // 一段约 20 秒
    await bulk.mark();
    bulkClock += 1_000;
    await bulk.commit();
  }
  assert.equal(bulkWrites, 1 + 78, "每段只写一次结果：初始 1 次 + 78 次");
  assert.ok(bulkWrites < 156, "比「每段两次整行写」少一半以上");

  // 长时间没有结果落盘时（例如将来有别的调用方只 mark），段数阈值仍然兜底。
  let guardedWrites = 0;
  const guarded = createCheckpointWriter({ save: async () => { guardedWrites += 1; }, now: () => 4_000_000, minSegments: 10, minIntervalMs: 30_000 });
  for (let index = 0; index < 11; index += 1) await guarded.mark();
  assert.equal(guardedWrites, 2, "第一次立刻落盘，其后每累计 10 次再落一次");
});

test("连接层失败才重试：内容层错误直接抛出", async () => {
  assert.equal(isTransientConnectionError(new TypeError("fetch failed")), true);
  assert.equal(isTransientConnectionError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientConnectionError(new Error("模型服务返回 502，请稍后重试")), true);
  assert.equal(isTransientConnectionError(new Error("翻译：DeepSeek Messages transport failed")), true);
  assert.equal(isTransientConnectionError(new Error("AIQA：DeepSeek Messages transport failed")), true);
  assert.equal(isTransientConnectionError(new Error("模型没有返回译文（连续两次都是空白输出）")), false);
  assert.equal(isTransientConnectionError(new Error("Directus GET /items/batch_runs 失败（503 Service \"api\" is unavailable. Under pressure.）")), false,
    "我们自己的库报错不在翻译重试范围内");

  let calls = 0;
  const sleeps = [];
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return "ok";
  };
  const result = await retryTransient(flaky, { delayMs: 2_000, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result, "ok");
  assert.equal(calls, 2, "只重试一次");
  assert.deepEqual(sleeps, [2_000]);

  let contentCalls = 0;
  await assert.rejects(
    retryTransient(async () => { contentCalls += 1; throw new Error("术语校验未通过"); }, { sleep: async () => {} }),
    /术语校验通过|术语校验未通过/u
  );
  assert.equal(contentCalls, 1, "内容层错误不重试");
});

test("批次翻译接上了节流与重试，且不再逐段整行写两次", () => {
  assert.match(runner, /const checkpoint = createCheckpointWriter\(\{ save: \(\) => saveRun\(run\) \}\);/u);
  assert.match(runner, /await checkpoint\.mark\(\);/u);
  assert.match(runner, /await checkpoint\.commit\(\);/u);
  assert.match(runner, /const result = await retryTransient\(translateOnce, \{\r?\n\s*attempts: 2,\r?\n\s*delayMs: SEGMENT_RETRY_DELAY_MS,/u);
  const translationRunner = runner.slice(runner.indexOf("export async function runServerBatch"), runner.indexOf("export async function retryServerBatchQa"));
  const perSegmentWrites = [...translationRunner.matchAll(/await saveRun\(run\);/gu)].length;
  assert.equal(perSegmentWrites, 0, "段落循环里不应再有裸的整行写");
});

test("界面遇 Directus 压力保护会自动重试一次并给友好提示", () => {
  assert.match(app, /const DIRECTUS_BUSY_RETRY_MS = 1_500;/u);
  assert.match(app, /function isDirectusBusyError\(error\)/u);
  assert.match(app, /await sleepMs\(DIRECTUS_BUSY_RETRY_MS\);/u);
  assert.match(app, /Directus 正忙（服务压力保护）：已自动重试一次仍未成功，稍等片刻再试即可，数据没有丢/u);
  // 第一次 503 不写 error 日志（别刷一屏红字），重试仍失败才记 warn。
  assert.match(app, /recordClientLog\("warn", `\$\{options\.method \|\| "GET"\} \$\{path\} 遇 Directus 压力保护，自动重试后仍失败`/u);
});

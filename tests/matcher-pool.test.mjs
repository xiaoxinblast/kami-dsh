import test from "node:test";
import assert from "node:assert/strict";

import { createMatcherPool } from "../src/matcher-pool.mjs";
import { matchTerms } from "../src/matcher.mjs";

const assets = {
  locale: "ja-JP",
  terms: [{
    id: "t1",
    source: "ナビマップ",
    aliases: [],
    target: "导览地图",
    forbidden: [],
    domains: ["game"],
    contentTypes: ["general"],
    enforcement: "required",
    status: "approved"
  }]
};

test("术语匹配 worker 的结果与同步实现一致，并复用同一份资产", async () => {
  const pool = createMatcherPool();
  try {
    const text = "ナビマップを起動して、設定画面を開きます。";
    const options = { contentType: "general", domain: "game" };
    const [viaWorker, second] = await Promise.all([
      pool.match(text, assets, options),
      pool.match("ナビマップを終了します。", assets, options)
    ]);
    assert.deepEqual(viaWorker, matchTerms(text, assets, options));
    assert.deepEqual(second, matchTerms("ナビマップを終了します。", assets, options));
    // 命中结果里必须保留条目对象，后续提示词/QA 依赖这些字段。
    assert.equal(viaWorker[0].term.target, "导览地图");
  } finally {
    await pool.close();
  }
});

/**
 * 真机事故：单 worker 被长句占住时，后面并发请求从入队就开始计时，
 * 60 秒一到先超时，触发同步模糊匹配把主线程堵死。超时必须从"真正开始执行"算。
 */
test("并发请求在队列里不会提前超时，超时按单条执行时间计", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "kami-matcher-"));
  const workerFile = join(dir, "slow-worker.mjs");
  await writeFile(workerFile, `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (message) => {
  if (message?.type !== "match") return;
  setTimeout(() => parentPort.postMessage({ id: message.id, matches: [] }), 150);
});
`, "utf8");
  const pool = createMatcherPool({ workerUrl: pathToFileURL(workerFile), timeoutMs: 400 });
  try {
    const started = Date.now();
    const results = await Promise.all([0, 1, 2, 3].map(() => pool.match("テスト", assets, {})));
    assert.equal(results.length, 4, "四条都要成功，不能有排队等待导致的超时");
    assert.ok(Date.now() - started >= 550, "确认确实是串行执行（4 × 150ms）");
  } finally {
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("术语匹配 worker 超时后只回退精确匹配，不再同步跑模糊匹配", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("回退精确匹配"));
  assert.ok(server.includes("exactOnly: true"));
  assert.equal(server.includes("回退同步"), false, "不能再回退到阻塞主线程的全量匹配");
});

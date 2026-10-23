import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIGINAL_UPLOAD_DIRECTORY, deleteBatchOriginal, originalRelativePath, readBatchOriginal, saveBatchOriginal } from "../src/batch-originals.mjs";

/**
 * 批次原文件存档：导入时上传的原文件按批次存到磁盘，导出写回时直接用，
 * 不用再让用户重新选一遍（这是"选择原文件并写回"那一步的替代方案）。
 */
test("原文件按批次存档，可读回，也可删除", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "kami-originals-"));
  const saved = await saveBatchOriginal({ dataRoot, batchId: "batch-1", filename: "lines.mqxliff", buffer: Buffer.from("hello") });
  assert.equal(saved.relative, `${ORIGINAL_UPLOAD_DIRECTORY}/batch-1.mqxliff`);
  assert.equal(saved.bytes, 5);
  assert.equal((await readBatchOriginal({ dataRoot, relativePath: saved.relative })).toString("utf8"), "hello");
  assert.equal(await deleteBatchOriginal({ dataRoot, relativePath: saved.relative }), true);
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: saved.relative }), null);
});

test("只接受已知扩展名，拒绝路径穿越与超大文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "kami-originals-"));
  assert.equal(originalRelativePath("b", "a.txt"), "uploads/b.txt");
  assert.equal(originalRelativePath("b", "a.exe"), "uploads/b", "未知扩展名不拼后缀");
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: "../directus/.env" }), null, "不能读到存档目录之外");
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: "other/b.txt" }), null);
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: "" }), null);
  await assert.rejects(() => saveBatchOriginal({ dataRoot, batchId: "b", filename: "a.xlsx", buffer: Buffer.alloc(33 * 1024 * 1024) }), /超过/u);
  await assert.rejects(() => saveBatchOriginal({ dataRoot, batchId: "", filename: "a.xlsx", buffer: Buffer.from("x") }), /缺少批次 ID/u);
  await assert.rejects(() => saveBatchOriginal({ dataRoot, batchId: "b", filename: "a.xlsx", buffer: Buffer.alloc(0) }), /内容为空/u);
});

test("导入时存档、导出时补存档：服务端两条路径都接上了", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  // 导入（/api/batch/prepare）时按批次存档
  assert.match(server, /const saved = await saveBatchOriginal\(\{ dataRoot: DATA_ROOT, batchId, filename: prepared\.filename \|\| body\.filename, buffer: originalBuffer \}\);/u);
  // 导出时优先用存档（用户不用再选）
  assert.match(server, /const stored = await readBatchOriginal\(\{ dataRoot: DATA_ROOT, relativePath: run\?\.runnerOptions\?\.originalFile \}\);/u);
  // 老批次用户补选时顺手存档，下次免选
  assert.match(server, /已把用户补选的原文件存档到批次/u);
  assert.match(server, /if \(run && !run\.runnerOptions\?\.originalFile\) \{/u);
  // 前端：任务中心与翻译界面用同一套选择（缺存档时都给"选择原文件并写回"）
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.equal((app.match(/id: "pick-source"/gu) || []).length, 1, "所有入口共用同一个缺原文件兜底选项");
});

test("任务可完整删除：批次先中断再删，关联记录一起清理", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /req\.method === "DELETE" && url\.pathname\.startsWith\("\/api\/tasks\/"\)/u);
  assert.match(server, /这条批次还在运行：请选择「停止并删除」或先中断它/u);
  assert.match(server, /worker\.cancelRequested = true;/u);
  assert.match(server, /await deleteBackgroundTask\(task\.id\)/u);
  assert.match(server, /await deleteBatchOriginal\(\{ dataRoot: DATA_ROOT, relativePath: run\.runnerOptions\.originalFile \}\)/u);
  assert.match(server, /const deleted = await deleteBatchRun\(batchId\);/u);
  // 文件质检也要存进任务中心（可回放、可删除）
  assert.match(server, /title: `\$\{filename\} 质检`/u);
  assert.match(server, /report: result/u);
  // 前端：删除必须先问"停止并删除 / 仅删记录"
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /async function confirmTaskDelete/u);
  assert.match(app, /data-action="delete-task">删除/u);
  assert.match(app, /\/api\/tasks\/\$\{encodeURIComponent\(batchId\)\}\?stop=/u);
  // 跳过说明：XLIFF 的锁定/已有译文要在界面上讲清楚，避免"段数不对"的误会
  assert.match(app, /function batchSkipSummary\(structure\)/u);
  assert.match(app, /跳过 \$\{skipped\}（\$\{reasons\}）/u);
});

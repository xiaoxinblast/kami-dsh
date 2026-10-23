import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import vm from "node:vm";
import { prepareBatchDocument, exportBatchDocument } from "../src/batch-document.mjs";
import { readBatchOriginal, saveBatchOriginal } from "../src/batch-originals.mjs";

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const start = serverSource.indexOf('  if (req.method === "GET" && url.pathname.startsWith("/api/export-tasks/")');
const end = serverSource.indexOf('  if (req.method === "DELETE" && url.pathname.startsWith("/api/background-tasks/")', start);

test("真实下载路由按导出格式读取文件，MQXLIFF / CSV / DOCX 不再误找 XLSX", async () => {
  const root = await mkdtemp(join(tmpdir(), "kami-export-download-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "exports"));
  const tasks = new Map();
  const handler = vm.runInNewContext(`(async (req, res, url) => { ${serverSource.slice(start, end)} })`, {
    getBackgroundTask: async (id) => tasks.get(id), DATA_ROOT: root, readFile, join, extname
  });
  const server = createServer(async (req, res) => {
    try { await handler(req, res, new URL(req.url, "http://localhost")); }
    catch (error) { res.writeHead(error.statusCode || 500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const extension of [".mqxliff", ".xliff", ".csv", ".docx", ".xlsx", ".txt"]) {
      const id = `export-${extension.slice(1)}`;
      const filename = `双语导出${extension}`;
      const bytes = Buffer.from(`actual file ${extension}`);
      await writeFile(join(root, "exports", `${id}${extension}`), bytes);
      // 已存在的导出任务没有 extension 字段，也必须能恢复下载。
      tasks.set(id, { type: "batch_export", status: "completed", payload: { filename, mimeType: "application/octet-stream", downloadUrl: `/api/export-tasks/${id}/download` } });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/export-tasks/${id}/download`);
      assert.equal(response.status, 200, `${extension} 必须下载实际生成的文件`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.match(response.headers.get("content-disposition"), new RegExp(encodeURIComponent(filename)));
    }
    await writeFile(join(root, "exports", "legacyundefined"), "legacy MQXLIFF");
    tasks.set("legacy", { type: "batch_export", status: "completed", payload: { filename: "legacy.mqxliff", downloadUrl: "/api/export-tasks/legacy/download" } });
    const legacy = await fetch(`http://127.0.0.1:${server.address().port}/api/export-tasks/legacy/download`);
    assert.equal(legacy.status, 200);
    assert.equal(await legacy.text(), "legacy MQXLIFF");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("下载返回 JSON 错误时不触发假下载，也不报告导出成功", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("async function deliverExportedFile(");
  const end = app.indexOf("\nconst BATCH_COLUMN_ROLES", start);
  let downloads = 0;
  let saves = 0;
  const deliver = vm.runInNewContext(`(${app.slice(start, end).trim()})`, {
    fetch: async () => new Response(JSON.stringify({ error: "导出文件已丢失，请重新导出" }), { status: 404, headers: { "content-type": "application/json" } }),
    saveExportedFile: async () => { saves += 1; }, downloadUrl: () => { downloads += 1; },
    Uint8Array, btoa
  });
  await assert.rejects(deliver({ payload: { filename: "file.mqxliff" } }, "id"), /导出文件已丢失/u);
  assert.equal(downloads, 0);
  assert.equal(saves, 0);
});

test("后台生成 MQXLIFF 后可下载真实译文；原文件下载保持字节一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "kami-export-api-"));
  const original = Buffer.from('<?xml version="1.0"?><xliff version="1.2"><file><body><trans-unit id="1"><source>こんにちは</source><target></target></trans-unit></body></file></xliff>');
  const prepared = await prepareBatchDocument({ filename: "story.mqxliff", locale: "zh-CN", base64: original.toString("base64") });
  const saved = await saveBatchOriginal({ dataRoot: root, batchId: "batch-test", filename: "story.mqxliff", buffer: original });
  const run = { ...prepared, batchId: "batch-test", projectId: "project-test", locale: "zh-CN", runnerOptions: { originalFile: saved.relative },
    segments: prepared.segments.map((segment) => ({ ...segment, selected: true, status: "done", translation: "你好", result: { qaScore: 97 } })) };
  const tasks = new Map();
  const exportStart = serverSource.indexOf('  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/export"))');
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); return true; };
  const handler = vm.runInNewContext(`(async (req, res, url) => { ${serverSource.slice(exportStart, end)} })`, {
    readJsonBody: async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); },
    getBatchRun: async () => run, saveBatchRun: async () => {}, getBackgroundTask: async (id) => tasks.get(id),
    createBackgroundTask: async (input) => { const task = { ...input, id: `export-${tasks.size}`, status: "in_progress" }; tasks.set(task.id, task); return task; },
    updateBackgroundTaskProgress: async (id, update) => tasks.set(id, { ...tasks.get(id), ...update }),
    assertActiveLocale: () => {}, json, exportBatchDocument, saveBatchOriginal, readBatchOriginal,
    DATA_ROOT: root, Buffer, readFile, writeFile, mkdir: (await import("node:fs/promises")).mkdir, join, extname, logInfo: () => {}, console,
    loadBatchWorkflow: async () => ({ qualityReport: { status: "not_started" } }), batchQualityReportPending: () => false
  });
  const server = createServer(async (req, res) => {
    try { await handler(req, res, new URL(req.url, "http://localhost")); }
    catch (error) { json(res, error.statusCode || 500, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/tasks/batch-test/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-test", mode: "bilingual", format: "bilingual", sourceFormat: "mqxliff" }) });
    assert.equal(response.status, 202);
    const { backgroundTaskId } = await response.json();
    // 等真实文件写完；无需固定 sleep，也不调用任何外部模型或用户数据库。
    const task = await new Promise((resolve, reject) => {
      const check = () => {
        const task = tasks.get(backgroundTaskId);
        if (task.status === "completed") resolve(task);
        else if (task.status === "failed") reject(new Error(task.progress.message));
        else setImmediate(check);
      };
      check();
    });
    assert.equal(task.payload.extension, ".mqxliff");
    const download = await fetch(`${base}${task.payload.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.match(await download.text(), /<target>你好<\/target>/u);
    assert.match(download.headers.get("content-disposition"), /story.zh-CN.mqxliff/u);
    const source = await fetch(`${base}/api/tasks/batch-test/original?projectId=project-test`);
    assert.equal(source.status, 200);
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), original);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

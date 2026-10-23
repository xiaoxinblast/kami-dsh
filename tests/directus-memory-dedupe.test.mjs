import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { memorySourceHash } from "../src/translation-memory.mjs";

/**
 * 重复导入同一份 TM 时，和库里完全一致的条目不能再逐条 PATCH：
 * 真机踩过 8.5 万条重导，5.9 万条逐条更新把任务卡在"入库 N / N"几十分钟。
 * 未变的跳过、变了的批量更新。
 */
const calls = [];
const SOURCE = "用語A";
const TARGET = "术语A";
const baseRow = {
  id: "m-1",
  source: SOURCE,
  target: TARGET,
  entry_id: "",
  entry_key: "",
  source_hash: memorySourceHash(SOURCE),
  previous_source: "",
  next_source: "",
  domain: "general",
  content_type: "general",
  content_tags: [],
  quality_status: "human_approved",
  qa_score: 100,
  provenance: "table-import:x.xlsx#2",
  source_file: "x.xlsx",
  source_row: 2,
  asset_tier: "formal",
  project_id: "p1",
  library_id: "lib1"
};
let rows = [baseRow];

const server = http.createServer((req, res) => {
  const url = new URL(`http://directus${req.url}`);
  let data = null;
  if (req.method === "GET" && url.pathname === "/items/translation_memory_zh_cn") {
    calls.push({ method: "GET", query: url.search });
    data = rows;
  } else if (req.method === "PATCH" && url.pathname === "/items/translation_memory_zh_cn") {
    calls.push({ method: "PATCH" });
    data = (req.bodyData || []).map((item) => ({ id: item.id }));
  } else if (req.method === "POST" && url.pathname === "/items/translation_memory_zh_cn") {
    calls.push({ method: "POST" });
    data = (req.bodyData || []).map((item, index) => ({ id: `new-${index}`, ...item }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
server.on("request", (req, res) => {
  if (req.method !== "PATCH" && req.method !== "POST") return;
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try { req.bodyData = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { req.bodyData = []; }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { saveDirectusMemories } = await import("../src/directus-store.mjs");

const input = {
  source: SOURCE,
  target: TARGET,
  projectId: "p1",
  libraryId: "lib1",
  qualityStatus: "human_approved",
  qaScore: 100,
  provenance: "table-import:x.xlsx#2",
  sourceFile: "x.xlsx",
  sourceRow: 2,
  embedding: [0.1]
};

test("内容和库里完全一致时跳过更新，不逐条 PATCH", async () => {
  calls.length = 0;
  rows = [baseRow];
  const saved = await saveDirectusMemories("zh-CN", [{ ...input }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "m-1");
  assert.equal(saved[0].unchanged, true, "未变的重复要标成 unchanged，调用方据此跳过并计入跳过数");
  assert.equal(calls.some((call) => call.method === "PATCH"), false, "未变的重复不能发 PATCH");
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("条目 ID 相同但译法变了才批量更新，仍然一次请求", async () => {
  calls.length = 0;
  rows = [{ ...baseRow, entry_key: "K-1", target: "旧译法" }];
  const saved = await saveDirectusMemories("zh-CN", [{ ...input, entryKey: "K-1", target: "新译法" }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "m-1");
  assert.equal(saved[0].unchanged, undefined);
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 1, "多条更新要批成一个请求");
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test.after(() => new Promise((resolve) => server.close(resolve)));

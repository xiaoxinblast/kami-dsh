import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBatchReferences, verifyBatchReferenceAcceptance } from "../src/batch-verse.mjs";
import { buildContextPack } from "../src/context-pack.mjs";
import { classifyContent } from "../src/classifier.mjs";
import { runServerBatch } from "../src/batch-runner.mjs";
import { selectPatternReferences } from "../src/pattern-memory.mjs";
import { contextPackText, packPrompt, translateWithReflection, proofreadTranslationWithModel, evaluateTranslationWithModel, reviseTranslationWithQa } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun } from "../src/store.mjs";

const references = [
  { segmentId: "human", source: "残り3秒", target: "人工确认表达", accepted: true },
  { segmentId: "machine", source: "残り4秒", target: "未确认机器表达", accepted: false, qaScore: 100 },
  { source: "残り5秒", target: "旧版机器表达" },
  { source: "残り6秒", target: "字符串确认标记", accepted: "true" }
];
const context = () => buildContextPack({ source: "残り7秒", locale: "zh-CN", classification: classifyContent("残り7秒", "dialogue"), matches: [],
  batchReferences: references, patternReferences: selectPatternReferences({ source: "残り7秒", previous: references, limit: 4 }) });

function assertSeparated(text) {
  const lines = text.split("\n");
  const approved = lines.filter(line => /·人工确认稿（/.test(line)).join("\n");
  const drafts = lines.filter(line => /·机器草稿或未确认译文（/.test(line)).join("\n");
  assert.match(approved, /人工确认表达/);
  assert.doesNotMatch(approved, /未确认机器表达|旧版机器表达|字符串确认标记/);
  assert.match(drafts, /未确认机器表达/);
  assert.match(drafts, /旧版机器表达/);
  assert.doesNotMatch(drafts, /人工确认表达/);
  assert.match(drafts, /不得.*沿用错误/);
  assert.doesNotMatch(text, /本批已定稿译文|固定部分必须沿用|必须保持句式与风格完全一致/);
}

test("批次及句式参考保留人工采纳身份，旧记录和机器高分不会升级", () => {
  const normalized = normalizeBatchReferences(references);
  assert.deepEqual(normalized.map(item => item.accepted), [true, false, false, false]);
  assert.equal(normalized[0].segmentId, "human");
  const pack = context();
  assert.deepEqual(pack.batchReferences.map(item => item.accepted), [true, false, false, false]);
  assert.deepEqual(pack.patternReferences.map(item => item.accepted), [true, false, false]);
});

test("来源记录缺失、身份不符或内容已改动时按未确认稿处理", () => {
  const segments = [{ id: "human", source: "原文", translation: "人工译文", accepted: true },
    { id: "machine", source: "机器原文", translation: "机器译文", accepted: "true", qaScore: 100 }];
  const input = [
    { segmentId: "human", source: "原文", target: "人工译文" },
    { segmentId: "other", source: "原文", target: "人工译文", accepted: true },
    { segmentId: "human", source: "原文已变", target: "人工译文", accepted: true },
    { segmentId: "human", source: "原文", target: "过期译文", accepted: true },
    { segmentId: "machine", source: "机器原文", target: "机器译文", accepted: true }
  ];
  assert.deepEqual(verifyBatchReferenceAcceptance(input, segments).map(item => item.accepted), [true, false, false, false, false]);
  assert.ok(verifyBatchReferenceAcceptance(input).every(item => item.accepted === false));
});

test("初译与审校按来源分别呈现同批及同句式参考，兼容旧 context pack", () => {
  const pack = context();
  // Include the human pattern alongside old entries; raw historical packs bypass the builder.
  pack.patternReferences = references;
  const before = structuredClone(pack);
  for (const value of [pack, { ...pack, batchReferences: references }]) {
    assertSeparated(packPrompt(value));
    for (const purpose of ["review", "revise", "reflect"]) assertSeparated(contextPackText(value, purpose));
  }
  assert.deepEqual(pack, before);
  const legacy = packPrompt({ ...pack, batchReferences: [references[2]], patternReferences: [], batchVerse: { active: true, shape: "3+6" } });
  assert.doesNotMatch(legacy, /·人工确认稿（/);
  assert.match(legacy, /·机器草稿或未确认译文（/);
  assert.doesNotMatch(legacy, /后续各行必须严格仿照/);
});

test("续跑传递人工采纳记录，新生成及 QA 通过稿仍是机器稿", async () => {
  const run = { batchId: "authority-batch", projectId: "p", filename: "test.txt", locale: "zh-CN", contentType: "dialogue", segments: [
    { id: "human", source: "残り3秒", translation: "剩余3秒", status: "done", accepted: true },
    { id: "machine", source: "残り4秒", translation: "剩余4秒", status: "done", result: { aiQa: { status: "passed", score: 100 } } },
    { id: "next", source: "残り5秒", status: "pending" }, { id: "last", source: "残り6秒", status: "pending" }
  ] };
  const calls = [];
  await runServerBatch(run.batchId, { loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }),
    classifyDocument: async () => "dialogue", translateSegment: async body => { calls.push(body); return { translation: "机器新稿", qaScore: 100 }; } });
  assert.equal(run.runState, "completed");
  assert.deepEqual(calls[0].batchReferences.map(item => [item.segmentId, item.accepted]), [["human", true], ["machine", false]]);
  assert.deepEqual(calls[0].patternReferences.map(item => [item.segmentId, item.accepted]), [["human", true], ["machine", false]]);
  assert.equal(calls[1].batchReferences.at(-1).accepted, false);
  assert.equal(calls[1].patternReferences.at(-1).accepted, false);
});

test("翻译、校对、QA、修订和自检实际请求均保留来源边界", async () => {
  const pack = { ...context(), patternReferences: references }, calls = [];
  await withRuntimeCall({ modelAdapter: async (messages, options) => {
    calls.push({ label: options.requestLabel, messages });
    return { content: options.requestLabel === "AIQA" ? '{"issues":[]}' : options.requestLabel === "翻译自检" ? "PASS" : "剩余7秒" };
  } }, async () => {
    await translateWithReflection(pack, { reflect: true });
    await proofreadTranslationWithModel({ contextPack: pack, translation: "机器初稿" });
    await evaluateTranslationWithModel({ contextPack: pack, translation: "机器初稿" });
    await reviseTranslationWithQa({ contextPack: pack, translation: "机器初稿", issues: [{ message: "措辞生硬" }] });
  });
  for (const call of calls) {
    const text = call.messages.map(item => item.content).join("\n");
    assertSeparated(text);
    assert.doesNotMatch(text, /与本批已定稿译文的句式、节奏与用词风格是否一致/);
  }
  assert.ok(calls.some(call => call.label === "模型校对"));
  assert.ok(calls.some(call => call.label === "翻译自检"));
});

test("API 用保存的原文、译文和人工采纳记录确认身份，不相信请求或过期标记", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-reference-authority-"));
  const calls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    calls.push({ label: options.requestLabel, text: messages.map(item => item.content).join("\n") });
    return { content: "剩余7秒" };
  } });
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "authority fixture" } }, { human: true });
    const run = await saveBatchRun({ projectId: project.id, filename: "test.txt", locale: "zh-CN", contentType: "dialogue", segments: references.slice(0, 2).map(item => ({
      id: item.segmentId, source: item.source, translation: item.target, status: "done", accepted: item.accepted
    })) });
    const provided = [references[0], { ...references[1], accepted: true }, { ...references[0], target: "已失效的旧译文", accepted: true }, references[2]];
    await workbench.invoke({ path: "/api/translate", method: "POST", body: { projectId: project.id, batchId: run.batchId, source: "残り7秒", locale: "zh-CN", contentType: "dialogue", useModelClassification: false,
      batchReferences: provided, patternReferences: provided } }, { human: true });
    assert.deepEqual(calls.map(call => call.label), ["翻译", "模型校对"]);
    for (const call of calls) {
      assertSeparated(call.text);
      assert.doesNotMatch(call.text.split("\n").filter(line => /·人工确认稿（/.test(line)).join("\n"), /已失效的旧译文/);
    }
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

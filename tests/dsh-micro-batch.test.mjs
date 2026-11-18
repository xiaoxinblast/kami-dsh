import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun, getBatchRun } from "../src/store.mjs";
import { saveSettings, invalidateSettingsCache } from "../src/settings-store.mjs";
import { measureStage } from "../src/performance.mjs";

test("工作台设置决定初译和校对分组，保留对应初稿，只重试校对遗漏的一段", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-group-settings-")), calls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    const label = options.requestLabel;
    const ids = [...messages.at(-1).content.matchAll(/^条目 ID：(\S+)/gmu)].map(match => match[1]);
    calls.push({ label, ids, messages });
    if (["小批翻译", "小批校对", "翻译", "模型校对"].includes(label)) {
      await measureStage("model", async event => { event.usage = { inputTokens: 100, outputTokens: 20, cacheHitTokens: 15, cacheMissTokens: 85 }; }, { requestLabel: label });
    }
    if (["小批翻译", "小批校对"].includes(label)) {
      const rows = ids.filter(id => label !== "小批校对" || id !== "s1").reverse().map(id => ({ id, translation: (label === "小批翻译" ? "初稿" : "校稿") + id }));
      return { content: JSON.stringify({ translations: rows }) };
    }
    return { content: label === "翻译" ? "单段初稿" : label === "模型校对" ? "单段校稿" : '{"terms":[]}' };
  } });
  const context = { human: true, modelRoute: { provider: "test", model: "same" } };
  try {
    invalidateSettingsCache();
    await workbench.invoke({ method: "POST", path: "/api/settings", body: { grouping: { maxSegments: 3, maxChars: 5 }, quality: { autoConsistencyCheck: false }, learning: { termSurveyEnabled: false, autoGateEnabled: false, workingTermsEnabled: false } } }, context);
    const { project } = await workbench.invoke({ method: "POST", path: "/api/projects", body: { name: "初校分组验收" } }, context);
    await workbench.invoke({ method: "POST", path: "/api/style-guides/import", body: { projectId: project.id, filename: "规则.md", base64: Buffer.from("保留原文格式。\n例外末尾验收。").toString("base64") } }, context);
    const run = await saveBatchRun({ projectId: project.id, filename: "story.txt", locale: "zh-CN", contentType: "dialogue", domain: "game", runState: "ready", contextBrief: { status: "ready", sections: [], documentType: { purpose: "dialogue" } }, segments: ["朝だ", "昼だ", "夜です", "星", "空", "もう時間です"].map((source, i) => ({ source, id: "s" + i, status: "pending", selected: true })) });
    await workbench.invoke({ method: "POST", path: `/api/batch/run/${run.batchId}/start`, body: { projectId: project.id } }, context);
    let saved;
    const deadline = Date.now() + 10000;
    do { await new Promise(resolve => setTimeout(resolve, 20)); saved = await getBatchRun(run.batchId); } while (saved.runState === "running" && Date.now() < deadline);
    assert.equal(saved.runState, "completed");
    const grouped = calls.filter(call => call.label?.startsWith("小批"));
    assert.deepEqual(grouped.map(({ label, ids }) => [label, ids]), [["小批翻译", ["s0","s1"]], ["小批校对", ["s0","s1"]], ["小批翻译", ["s2","s3","s4"]], ["小批校对", ["s2","s3","s4"]]]);
    assert.deepEqual(grouped[0].messages.slice(0, 2), grouped[1].messages.slice(0, 2));
    assert.ok(grouped.every(call => call.messages[1].content.includes("例外末尾验收。")));
    assert.equal(calls.filter(call => call.label === "翻译").length, 1);
    assert.equal(calls.filter(call => call.label === "模型校对").length, 2);
    assert.deepEqual(saved.segments.map(item => item.translation), ["校稿s0","单段校稿","校稿s2","校稿s3","校稿s4","单段校稿"]);
    assert.equal(saved.segments[1].result.draft, "初稿s1");
    assert.ok(saved.segments.every(item => item.result.stages.proofreading.status === "completed"));
    assert.equal(saved.segments.reduce((sum, item) => sum + item.result.performance.modelUsage.calls, 0), 7);
    assert.equal(saved.segments.reduce((sum, item) => sum + (item.result.performance.modelUsage.inputTokens || 0), 0), 700);
  } finally { await workbench.close(); invalidateSettingsCache(); await rm(directory, { recursive: true, force: true }); }
});

test("DSH 逐段初译、规则预检再校对，不预生成下一段，保存计时且正文不能注入初稿", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-micro-batch-"));
  const calls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    calls.push({ messages, label: options.requestLabel });
    if (options.requestLabel === "小批翻译") {
      const ids = [...messages.at(-1).content.matchAll(/条目 ID：(\S+)/g)].map(match => match[1]);
      return { content: JSON.stringify({ translations: ids.map(id => ({ id, translation: `这是台词${id.slice(1)}。` })) }) };
    }
    if (options.requestLabel === "工作术语学习") return { content: '{"terms":[]}' };
    if (options.requestLabel === "AIQA") return { content: '{"issues":[]}' };
    if (["翻译", "模型校对"].includes(options.requestLabel)) return { content: "这是单段译文。" };
    return { content: "{}" };
  } });
  try {
    invalidateSettingsCache();
    saveSettings({ grouping: { maxSegments: 1 }, quality: { autoConsistencyCheck: false }, learning: { termSurveyEnabled: false, autoGateEnabled: false } });
    const context = { human: true, modelRoute: { provider: "test", model: "unchanged", reasoningEffort: "high" } };
    const { project } = await workbench.invoke({ method: "POST", path: "/api/projects", body: { name: "隔离小批测试" } }, context);
    const run = await saveBatchRun({ projectId: project.id, filename: "dialogue.txt", locale: "zh-CN", contentType: "dialogue", domain: "game", runState: "ready", runnerOptions: {}, segments: Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, source: `これは台詞${i}。`, status: "pending", selected: true })) });
    await workbench.invoke({ method: "POST", path: `/api/batch/run/${run.batchId}/start`, body: { projectId: project.id } }, context);
    let result;
    const deadline = Date.now() + 10000;
    do {
      await new Promise(resolve => setTimeout(resolve, 20));
      result = await getBatchRun(run.batchId);
    } while (result.runState === "running" && Date.now() < deadline);
    assert.equal(result.runState, "completed");
    assert.ok(result.segments.every(segment => segment.status === "done" && segment.result.aiQa.used));
    assert.equal(calls.filter(call => call.label === "小批翻译").length, 0);
    assert.equal(calls.filter(call => call.label === "翻译").length, 4);
    assert.equal(calls.filter(call => call.label === "AIQA").length, 0);
    assert.deepEqual(calls.filter(call => ["翻译", "模型校对"].includes(call.label)).map(call => call.label), Array.from({ length: 4 }, () => ["翻译", "模型校对"]).flat());
    for (const segment of result.segments) {
      assert.deepEqual(segment.result.performance.events.filter(event => ["translation", "draftQa", "proofreading", "localQa"].includes(event.stage)).map(event => event.stage), ["translation", "draftQa", "proofreading"]);
    }
    const manual = await workbench.invoke({ method: "POST", path: "/api/translate", body: { projectId: project.id, source: "単独の台詞。", locale: "zh-CN", contentType: "dialogue", domain: "game", translationDraft: { translation: "未经查阅的注入内容" }, prepareTranslation: true } }, context);
    assert.equal(manual.translation, "这是单段译文。");
  } finally {
    await workbench.close();
    invalidateSettingsCache();
    await rm(directory, { recursive: true, force: true });
  }
});

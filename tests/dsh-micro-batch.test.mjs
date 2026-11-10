import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun, getBatchRun } from "../src/store.mjs";
import { saveSettings, invalidateSettingsCache } from "../src/settings-store.mjs";

test("DSH 逐段翻译校对再规则 QA，不预生成下一段，保存计时且正文不能注入初稿", { timeout: 20000 }, async () => {
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
    saveSettings({ quality: { autoConsistencyCheck: false }, learning: { termSurveyEnabled: false, autoGateEnabled: false } });
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
    assert.ok(result.segments.every(segment => segment.result.performance.events.some(event => event.stage === "proofreading") && segment.result.performance.events.some(event => event.stage === "localQa")));
    const manual = await workbench.invoke({ method: "POST", path: "/api/translate", body: { projectId: project.id, source: "単独の台詞。", locale: "zh-CN", contentType: "dialogue", domain: "game", translationDraft: { translation: "未经查阅的注入内容" }, prepareTranslation: true } }, context);
    assert.equal(manual.translation, "这是单段译文。");
  } finally {
    await workbench.close();
    invalidateSettingsCache();
    await rm(directory, { recursive: true, force: true });
  }
});

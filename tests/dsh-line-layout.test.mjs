import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun, getBatchRun } from "../src/store.mjs";
import { invalidateSettingsCache } from "../src/settings-store.mjs";

test("工作台实际初校入口共用一次有出处的查证；本地 QA、定向重试和指南换版", { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-line-layout-"));
  const calls = [];
  let width = 6;
  let badProof = false;
  const quote = () => "每行最多 " + width + " 字，最多 2 行。";
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    const label = options.requestLabel;
    calls.push({ label, messages });
    if (label === "换行规则核对") {
      const doc = JSON.parse(messages.at(-1).content).sources[0];
      assert.ok(doc.text.includes(quote()));
      return { content: JSON.stringify({ rules: [{ source: doc.path, quote: quote(), maxChars: width, maxLines: 2, counting: "characters" }], unresolved: "" }) };
    }
    const ids = [...messages.at(-1).content.matchAll(/^条目 ID：(\S+)/gmu)].map(m => m[1]);
    const draft = "天亮了\n，回家吧。", proof = badProof ? draft : "天亮了，\n回家吧。";
    if (["小批翻译", "小批校对"].includes(label)) return { content: JSON.stringify({ translations: ids.map(id => ({ id, translation: label === "小批翻译" ? draft : proof })) }) };
    if (label === "翻译" || label === "模型校对") return { content: label === "翻译" ? draft : proof };
    return { content: '{"terms":[]}' };
  } });
  const context = { human: true, modelRoute: { provider: "test", model: "layout" } };
  const post = (path, body) => workbench.invoke({ method: "POST", path, body }, context);
  const lookups = () => calls.filter(c => c.label === "换行规则核对").length;
  try {
    invalidateSettingsCache();
    await post("/api/settings", { grouping: { maxSegments: 4, maxChars: 300 }, quality: { autoConsistencyCheck: false }, learning: { termSurveyEnabled: false, autoGateEnabled: false, workingTermsEnabled: false } });
    const { project } = await post("/api/projects", { name: "离线换行验收" });
    const guide = () => post("/api/style-guides/import", { projectId: project.id, filename: "排版.md", base64: Buffer.from("# 对白排版\n" + quote() + "\n说明：按语义断句。").toString("base64") });
    await guide();
    const run = await saveBatchRun({ projectId: project.id, filename: "scenario.txt", locale: "zh-CN", contentType: "dialogue", domain: "game", runState: "ready", contextBrief: { status: "ready", sections: [], documentType: { purpose: "dialogue" } }, segments: ["朝だ。\n帰ろう。", "昼だ。\n帰ろう。", "夜だ。\n帰ろう。"].map((source, i) => ({ source, id: "s" + i, status: "pending", selected: true })) });
    await post("/api/batch/run/" + run.batchId + "/start", { projectId: project.id });
    let saved;
    const deadline = Date.now() + 15000;
    do { await new Promise(r => setTimeout(r, 25)); saved = await getBatchRun(run.batchId); } while (saved.runState === "running" && Date.now() < deadline);
    assert.equal(saved.runState, "completed", JSON.stringify(saved.segments.map(s => s.error)));
    assert.equal(lookups(), 1);
    const grouped = calls.filter(c => c.label === "小批翻译" || c.label === "小批校对");
    assert.deepEqual(grouped.map(c => c.label), ["小批翻译", "小批校对"]);
    assert.ok(grouped.every(c => c.messages[0].content.includes("固定标记原样保序") && c.messages.at(-1).content.includes("每行最多 6 字") && c.messages.at(-1).content.includes("排版")));
    for (const call of grouped) {
      assert.equal((call.messages.at(-1).content.match(/已核对本类文本的换行规定/gu) || []).length, 1);
      assert.equal((call.messages.at(-1).content.match(/字数和行数规定同条目 s0/gu) || []).length, 2);
    }
    assert.match(grouped[1].messages.at(-1).content, /第 2 行以「，」开头/u);
    assert.ok(saved.segments.every(s => s.result.lineLayout?.rules[0]?.maxChars === 6 && s.result.stages.proofreading.status === "completed"));
    const s = saved.segments[0], request = { projectId: project.id, batchId: run.batchId, locale: "zh-CN", source: s.source, contentType: "dialogue", domain: "game", segmentId: s.id };
    const qa = await post("/api/qa", { ...request, translation: "明天见\n，拜拜拜拜拜拜。" });
    assert.ok(qa.issues.some(i => i.type === "line_layout_length" && i.message.includes("第 2 行")));
    assert.equal(lookups(), 1);
    const unchanged = await post("/api/translate", { ...request, workflowStage: "proofreading", stages: s.result.stages, translation: s.translation });
    assert.equal(unchanged.stages.proofreading.status, "completed");
    assert.equal(lookups(), 1, "重试同一段时应复用存档规则");
    width = 4;
    await guide();
    badProof = true;
    const retry = await post("/api/translate", { ...request, workflowStage: "proofreading", stages: s.result.stages, translation: s.translation });
    assert.equal(lookups(), 2);
    assert.equal(retry.stages.proofreading.status, "failed");
    assert.match(retry.stages.proofreading.error, /第 2 行.*「，」/u);
    assert.equal(retry.contextPack.lineLayout.rules[0].maxChars, 4);
  } finally { await workbench.close(); invalidateSettingsCache(); await rm(directory, { recursive: true, force: true }); }
});

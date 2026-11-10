import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";

test("统一质检减少严苛档调用，保留语境，失败与不收敛均不冒充通过", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-quality-flow-"));
  let calls = [], mode = "pass";
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    calls.push({ label: options.requestLabel, text: JSON.stringify(messages) });
    if (options.requestLabel === "AIQA") {
      if (mode === "failure") throw new Error("QA unavailable probe");
      return { content: JSON.stringify({ issues: ["stalled", "repair"].includes(mode) ? [{ severity: "major", category: "accuracy_mistranslation", message: "测试误译", suggestion: "修正测试误译", sourceSpan: "保存", targetSpan: "保存", confidence: 1 }] : [] }) };
    }
    if (options.requestLabel === "翻译自检") return { content: "PASS" };
    if (mode === "repair" && options.requestLabel === "翻译") return { content: "存储设定。" };
    return { content: "保存设置。" };
  } });
  const context = { human: true };
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "quality workflow" } }, context);
    const translate = (qualityTier) => workbench.invoke({ path: "/api/translate", method: "POST", body: {
      projectId: project.id, locale: "zh-CN", source: "設定を保存します。", segmentPurpose: "ui", qualityTier, useModelClassification: false,
      documentBrief: { document: { purpose: "ui", summary: "全文语境探针_2491" }, notes: [], crossRefs: [] }
    } }, context);
    for (const tier of ["standard", "strict"]) {
      calls = [];
      const result = await translate(tier);
      assert.equal(calls.length, 2, `${tier}: ${calls.map((call) => call.label)}`);
      assert.ok(calls.every((call) => call.text.includes("全文语境探针_2491")), "初译与质检均收到全文语境");
      assert.equal(result.qualityRoute.decision, "auto_pass");
    }
    mode = "failure"; calls = [];
    const failed = await translate("standard");
    assert.equal(failed.aiQa.used, false);
    assert.notEqual(failed.qualityRoute.decision, "auto_pass");
    assert.match(failed.aiQa.fallbackReason, /QA unavailable/);
    mode = "stalled"; calls = [];
    const stalled = await translate("standard");
    assert.equal(calls.filter((call) => call.label === "翻译").length, 1, "升档继续审查已有译文");
    assert.notEqual(stalled.qualityRoute.decision, "auto_pass");
    assert.equal(calls.length, 3, "初译、QA、无变化修订后停止，不重复升档检查");
    assert.equal(stalled.aiQa.revisionStalled, true);
    mode = "repair";
    for (const tier of ["standard", "strict"]) {
      calls = [];
      const revised = await translate(tier);
      assert.deepEqual(calls.map(call => call.label), ["翻译", "AIQA", "AIQA 修订"], "只审一次、修订一次，不复检或升档重审");
      assert.equal(revised.translation, "保存设置。");
      assert.equal(revised.aiQa.status, "revised");
      assert.equal(revised.aiQa.used, true);
      assert.equal(revised.aiQa.iterations, 1);
      assert.equal(revised.qaScore, null, "修订前分数不能当作最终译文分数");
      assert.equal(revised.aiQa.memoryCandidate, null);
      assert.deepEqual(revised.issues, [], "修订前的问题不能继续挂在最终译文上");
      assert.equal(revised.qualityRoute.decision, "auto_pass");
      assert.match(revised.qualityRoute.reason, /规则检查通过/);
    }
    const pending = await workbench.invoke({ path: `/api/qa-cases/pending?locale=zh-CN&projectId=${project.id}` }, context);
    const revisedCases = pending.filter(item => item.rejectedTranslation === "存储设定。");
    assert.equal(revisedCases.length, 2);
    assert.ok(revisedCases.every(item => item.scoreAfter === null && item.scoreBefore === 88));
    const approved = await workbench.invoke({ method: "POST", path: `/api/qa-cases/${revisedCases[0].id}/approve` }, context);
    assert.equal(approved.status, "human_approved");
    assert.ok(!approved.regression?.error, "人工采纳后可以正常并入回归集");
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

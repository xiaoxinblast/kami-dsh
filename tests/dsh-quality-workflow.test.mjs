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
      return { content: JSON.stringify({ issues: mode === "stalled" ? [{ severity: "major", category: "accuracy_mistranslation", message: "测试误译", suggestion: "修正测试误译", sourceSpan: "保存", targetSpan: "保存", confidence: 1 }] : [] }) };
    }
    if (options.requestLabel === "翻译自检") return { content: "PASS" };
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
    assert.ok(calls.length <= 6, "相同译文不反复修订");
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

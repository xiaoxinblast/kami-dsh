import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun } from "../src/store.mjs";

test("逐段翻译、模型校对润色、规则 QA，各阶段重试独立结束", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-quality-flow-"));
  let calls = [], mode = "pass";
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    calls.push({ label: options.requestLabel, text: JSON.stringify(messages) });
    if (options.requestLabel === "模型校对" && mode === "failure") throw new Error("proofreading unavailable probe");
    if (options.requestLabel === "模型校对" && mode === "empty") return { content: "" };
    return { content: options.requestLabel === "翻译" ? "对设置进行保存。" : "保存设置。" };
  } });
  const context = { human: true };
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "quality workflow" } }, context);
    const translate = (qualityTier, extra = {}) => workbench.invoke({ path: "/api/translate", method: "POST", body: {
      projectId: project.id, locale: "zh-CN", source: "設定を保存します。", segmentPurpose: "ui", qualityTier, useModelClassification: false,
      documentBrief: { document: { purpose: "ui", summary: "全文语境探针_2491" }, notes: [], crossRefs: [] }, ...extra
    } }, context);
    for (const tier of ["fast", "standard", "strict"]) {
      calls = [];
      const result = await translate(tier);
      assert.deepEqual(calls.map(call => call.label), ["翻译", "模型校对"]);
      assert.ok(calls.every(call => call.text.includes("全文语境探针_2491") && call.text.includes("10. 性别人称代词核实")));
      assert.match(calls[1].text, /自然流畅的语言润色/);
      assert.equal(result.translation, "保存设置。");
      assert.equal(result.draft, "对设置进行保存。");
      assert.equal(result.stages.localQa.status, "completed");
      assert.equal(result.qaScore, null, "直接输出校对稿的阶段不能虚构评分");
      assert.equal(result.qualityRoute.decision, "auto_pass");
    }
    for (mode of ["failure", "empty"]) {
      calls = [];
      const failed = await translate("standard");
      assert.equal(failed.translation, "对设置进行保存。");
      assert.equal(failed.stages.proofreading.status, "failed");
      assert.equal(failed.stages.localQa.status, "pending");
      assert.notEqual(failed.qualityRoute.decision, "auto_pass");
      assert.equal(calls.length, 2, "不复检或重新翻译");
    }
    mode = "pass";
    let current;
    for (const workflowStage of ["translation", "proofreading", "localQa"]) {
      calls = [];
      current = await translate("standard", { workflowStage, translation: current?.translation, stages: current?.stages });
      assert.deepEqual(calls.map(call => call.label), workflowStage === "translation" ? ["翻译"] : workflowStage === "proofreading" ? ["模型校对"] : []);
      assert.equal(current.stages[workflowStage].status, "completed");
      if (workflowStage !== "localQa") assert.equal(current.stages.localQa.status, "pending");
    }
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

test("批次校对和本地 QA 重试只补对应阶段，保持其他段及历史报告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-phase-retry-")), calls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (_messages, options) => {
    calls.push(options.requestLabel); return { content: "保存设置。" };
  } });
  const context = { human: true };
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "独立重试" } }, context);
    const stages = { translation: { status: "completed" }, proofreading: { status: "failed", error: "timeout" }, localQa: { status: "pending" } };
    const run = await saveBatchRun({ projectId: project.id, locale: "zh-CN", filename: "retry.txt", runState: "needs_attention", contentType: "ui",
      runnerOptions: { termSurvey: { generatedAt: "2026-01-01", marker: "保留普查" } }, qualityReport: { report: { generatedAt: "2026-01-01", marker: "保留报告" } },
      segments: [{ id: "one", source: "設定を保存します。", translation: "对设置进行保存。", status: "done", selected: true, result: { stages, draft: "对设置进行保存。" } },
        { id: "human", source: "戻る", translation: "返回", status: "done", selected: true, accepted: true }] });
    const path = `/api/batch/run/${run.batchId}`;
    const settled = async () => {
      for (let i = 0; i < 200; i++) {
        const value = await workbench.invoke({ path }, context);
        if (!value.workflow.writeBusy) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("阶段未结束");
    };
    const proof = await workbench.invoke({ path: `${path}/retry-proofreading`, method: "POST", body: { projectId: project.id, segmentIds: ["one"] } }, context);
    assert.equal(proof.total, 1);
    let latest = await settled();
    assert.deepEqual(calls, ["模型校对"]);
    assert.equal(latest.segments[0].translation, "保存设置。");
    assert.equal(latest.segments[0].result.stages.localQa.status, "pending");
    assert.equal(latest.workflow.qualityReport.status, "not_started");
    assert.equal(latest.workflow.termSurvey.status, "not_started");
    calls.length = 0;
    await workbench.invoke({ path: `${path}/retry-qa`, method: "POST", body: { projectId: project.id } }, context);
    latest = await settled();
    assert.deepEqual(calls, [], "本地 QA 重试不调用任何模型");
    assert.equal(latest.segments[0].result.stages.localQa.status, "completed");
    assert.equal(latest.segments[1].translation, "返回");
    assert.equal(latest.segments[1].accepted, true);
    assert.equal(latest.qualityReport.report.marker, "保留报告");
    assert.equal(latest.runnerOptions.termSurvey.marker, "保留普查");
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

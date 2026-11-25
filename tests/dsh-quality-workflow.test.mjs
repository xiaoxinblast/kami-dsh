import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun } from "../src/store.mjs";

test("初稿规则提示合入校对，手动 QA 只检查校对稿", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-quality-flow-"));
  let calls = [], mode = "pass";
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    calls.push({ label: options.requestLabel, text: JSON.stringify(messages) });
    if (options.requestLabel === "模型校对" && mode === "failure") throw new Error("proofreading unavailable probe");
    if (options.requestLabel === "模型校对" && mode === "empty") return { content: "" };
    if (options.requestLabel === "模型校对" && messages.at(-1).content.includes("初稿规则提示") && messages.at(-1).content.includes("百分比缺失或发生变化")) return { content: "把 {value} 设为百分之十五。" };
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
      assert.equal(result.stages.localQa.status, "optional");
      assert.doesNotMatch(calls[1].text, /初稿规则提示/);
      assert.equal(result.qaScore, null, "直接输出校对稿的阶段不能虚构评分");
      assert.equal(result.qualityRoute.decision, "proofread_only");
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
    calls = [];
    const flagged = await translate("standard", { source: "設定を15%にします。{value}" });
    const hints = calls[1].text.split("初稿规则提示")[1];
    assert.deepEqual(calls.map(call => call.label), ["翻译", "模型校对"]);
    assert.equal(flagged.translation, "把 {value} 设为百分之十五。");
    assert.match(hints, /百分比缺失或发生变化/);
    assert.equal((hints.match(/\{value\}/g) || []).length, 1, "占位符只提示一次");
    assert.equal(flagged.stages.draftQa.hintCount, 2);
    assert.deepEqual(flagged.issues, [], "初稿问题不冒充对校对稿的检查");
    let current;
    for (const workflowStage of ["translation", "proofreading", "localQa"]) {
      calls = [];
      current = await translate("standard", { workflowStage, translation: current?.translation, stages: current?.stages });
      assert.deepEqual(calls.map(call => call.label), workflowStage === "translation" ? ["翻译"] : workflowStage === "proofreading" ? ["模型校对"] : []);
      assert.equal(current.stages[workflowStage].status, "completed");
      if (workflowStage !== "localQa") assert.equal(current.stages.localQa.status, workflowStage === "translation" ? "pending" : "optional");
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
        { id: "human", source: "戻る", translation: "返回", status: "done", selected: true, accepted: true },
        // 仍有一段未开始：批次没补齐，补试阶段不能自动收尾，历史报告要保留。
        { id: "unstarted", source: "次へ進む。", status: "pending", selected: true }] });
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
    assert.equal(latest.segments[0].result.stages.localQa.status, "optional");
    assert.equal(latest.workflow.summary.qaIncomplete, 0);
    assert.equal(latest.workflow.qualityReport.status, "not_started");
    assert.equal(latest.workflow.termSurvey.status, "not_started");
    calls.length = 0;
    const noRetry = await workbench.invoke({ path: `${path}/retry-qa`, method: "POST", body: { projectId: project.id } }, context);
    assert.equal(noRetry.total, 0);
    await workbench.invoke({ path: `${path}/retry-qa`, method: "POST", body: { projectId: project.id, segmentIds: ["one"] } }, context);
    latest = await settled();
    assert.deepEqual(calls, [], "本地 QA 重试不调用任何模型");
    assert.equal(latest.segments[0].result.stages.localQa.status, "completed");
    assert.equal(latest.segments[1].translation, "返回");
    assert.equal(latest.segments[1].accepted, true);
    assert.equal(latest.qualityReport.report.marker, "保留报告");
    assert.equal(latest.runnerOptions.termSurvey.marker, "保留普查");
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

test("已做本地 QA 的旧段按 ID 重试修订后的模型 QA，保留译文和其他阶段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-revision-qa-")), calls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    if (options.requestLabel === "AIQA") assert.match(JSON.stringify(messages), /RULE_FROM_ORIGINAL/);
    calls.push(options.requestLabel); return { content: '{"issues":[]}' };
  } });
  const batchId = "batch-qa-retry-original";
  const ctx = { human: true, referenceTools: ({ evidenceCache }) => {
    assert.equal(evidenceCache?.batchId, batchId);
    return { tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      prepareEvidence: async () => ({ guides: [{ path: "guide.docx", content: "RULE_FROM_ORIGINAL" }] }),
      execute: async () => { throw new Error("已通过原件工具读取"); } };
  } };
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "补检" } }, ctx);
    const stages = { translation: { status: "completed" }, proofreading: { status: "completed" }, localQa: { status: "completed" } };
    const one = { id: "one", source: "設定を保存。", translation: "保存设置。", selected: true, status: "done",
      result: { stages, aiQa: { status: "review", fallbackReason: "指南读取失败" } } };
    const two = { ...one, id: "two", source: "次へ", translation: "下一步" };
    const workspaceSnapshot = { batchId, projectId: project.id, workspace: directory, styleGuideMode: "agent-native", resources: [{ path: "guide.docx", purpose: "style-guide" }] };
    const run = await saveBatchRun({ batchId, projectId: project.id, runnerOptions: { workspaceSnapshot }, locale: "zh-CN", filename: "old.txt", runState: "completed", contentType: "ui", segments: [one, two] });
    const path = `/api/batch/run/${run.batchId}`;
    const retry = await workbench.invoke({ path: path + "/retry-qa", method: "POST", body: { projectId: project.id, segmentIds: ["one"] } }, ctx);
    assert.equal(retry.total, 1);
    let latest;
    for (let i = 0; i < 200; i++) {
      latest = await workbench.invoke({ path }, ctx);
      if (!latest.workflow.writeBusy) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(calls.includes("AIQA")); assert.ok(!calls.includes("模型校对"));
    assert.equal(latest.segments[0].translation, one.translation);
    assert.deepEqual(latest.segments[0].result.stages, stages);
    assert.ok(!latest.segments[0].result.aiQa.fallbackReason);
    assert.equal(latest.segments[1].result.aiQa.fallbackReason, "指南读取失败");
    assert.equal(latest.workflow.summary.qaIncomplete, 1);
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

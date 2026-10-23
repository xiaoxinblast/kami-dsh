import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { batchQualityReportPending, buildBatchWorkflow } from "../public/batch-status.js";

const segments = [
  { id: "s1", source: "原文1", translation: "译文1", status: "done", selected: true, result: { aiQa: { used: true } } },
  { id: "s2", source: "原文2", translation: "译文2", status: "done", selected: true, result: { aiQa: { used: true } } }
];
const run = {
  batchId: "batch-completion", runState: "completed", segments,
  runnerOptions: { translationCompletedAt: new Date().toISOString(), workflowTasks: { qualityReport: "task-report" } }
};

test("质量报告（含 AI 终审）没跑完时，这一批仍算进行中", () => {
  const workflow = buildBatchWorkflow(run, { qualityTask: { status: "in_progress", progress: { message: "AI 终审待核对项：2 条", percent: 45 } } });
  assert.equal(workflow.overall.status, "in_progress");
  assert.match(workflow.overall.message, /正在生成质量报告/u);
  assert.match(workflow.overall.message, /AI 终审/u);
  assert.equal(workflow.translation.finished, true, "翻译本身确实结束了");
  assert.equal(batchQualityReportPending(run, workflow), true);
});

test("质量报告完成后才算批次完成，导出放行", () => {
  const doneRun = { ...run, qualityReport: { report: { generatedAt: new Date().toISOString() }, findings: [] } };
  const workflow = buildBatchWorkflow(doneRun, { qualityTask: { status: "completed", progress: { message: "质量报告已生成" } } });
  assert.equal(workflow.overall.status, "completed");
  assert.equal(batchQualityReportPending(doneRun, workflow), false);
});

test("老批次没有报告任务不会被永久挡住导出", () => {
  const oldRun = { batchId: "old", runState: "completed", segments, runnerOptions: {} };
  const workflow = buildBatchWorkflow(oldRun, {});
  assert.equal(workflow.overall.status, "completed");
  assert.equal(batchQualityReportPending(oldRun, workflow), false);
});

test("质量报告失败后允许导出（只挡住生成中的）", () => {
  const failedTask = { status: "failed", progress: { message: "质量报告未完成：模型 503" } };
  const workflow = buildBatchWorkflow(run, { qualityTask: failedTask });
  assert.equal(workflow.qualityReport.status, "needs_attention");
  assert.equal(batchQualityReportPending(run, workflow), false);
});

test("导出端点与任务中心都按质量报告状态收口", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(server, /质量报告还在生成（含 AI 终审），完成后才能导出/u);
  assert.match(server, /status: reportPending \? "in_progress" : item\.status/u);
  assert.match(script, /质量报告还在生成（含 AI 终审），完成后才能导出/u);
  assert.match(script, /质量报告生成中/u);
});

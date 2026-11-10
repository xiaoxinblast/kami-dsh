import test from "node:test";
import assert from "node:assert/strict";
import { runServerBatch } from "../src/batch-runner.mjs";
import { buildQualityReport } from "../src/consistency-check.mjs";

function fixture() {
  return {
    batchId: "batch-workflow-test", projectId: "project-test", filename: "dialogue.txt", locale: "zh-CN",
    contentType: "dialogue", runState: "needs_attention", runnerOptions: {},
    segments: [
      { id: "ok", source: "a", translation: "甲", status: "done", selected: true, result: { qualityTier: "standard", qaScore: 97, aiQa: { used: true, status: "passed", score: 97 } } },
      { id: "qa", source: "b", translation: "乙", status: "done", selected: true, result: { qualityTier: "standard", aiQa: { used: false, status: "review", fallbackReason: "terminated" } } },
      { id: "error", source: "c", status: "error", selected: true, error: "invalid translation" },
      { id: "skip", source: "d", translation: "丁", status: "done", selected: false, result: { aiQa: { fallbackReason: "terminated" } } }
    ]
  };
}

test("部分翻译失败不启动全批检查；重试只补翻译阶段", async () => {
  const run = fixture();
  const translated = [];
  const finalized = [];
  const options = {
    loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }),
    classifyDocument: async () => "dialogue",
    translateSegment: async ({ source }) => { translated.push(source); throw new Error("invalid translation"); },
    finalize: async (value) => finalized.push(value.segments.filter((segment) => segment.status === "done" && segment.selected !== false).length)
  };
  run.segments.find(segment => segment.id === "error").status = "pending";
  const failed = await runServerBatch(run.batchId, options);
  assert.equal(failed.runState, "needs_attention");
  assert.deepEqual(finalized, [], "全批未完成时不能启动收尾");
  const completed = await runServerBatch(run.batchId, {
    ...options, segmentIds: ["error"], translateSegment: async ({ source }) => { translated.push(source); return { translation: "丙", issues: [] }; }
  });
  assert.equal(completed.runState, "completed");
  assert.deepEqual(translated, ["c", "c"], "成功段和 QA 未完成段都不能被重翻");
  assert.deepEqual(finalized, [], "重试完成后不启动收尾");
});

test("QA 重试只检查现有译文，保留成功段与翻译失败段", async () => {
  const { retryServerBatchQa } = await import("../src/batch-runner.mjs");
  assert.equal(typeof retryServerBatchQa, "function");
  const run = fixture();
  run.runnerOptions.workingGlossary = { terms: [{ source: "b", target: "机器候选" }] };
  run.segments[0].result = { qaScore: null, aiQa: { used: true, status: "revised", score: null, iterations: 1 } };
  const untouched = structuredClone([run.segments[0], run.segments[2], run.segments[3]]);
  const requests = [];
  const progress = [];
  await retryServerBatchQa(run.batchId, {
    loadRun: async () => run, saveRun: async (value) => Object.assign(run, value),
    recheckSegment: async (body) => { requests.push(body); return { translation: body.translation, qaScore: 95, issues: [], aiQa: { used: true, status: "passed", score: 95, fallbackReason: "" } }; },
    report: async (value) => progress.push(value)
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source, "b");
  assert.equal(requests[0].segmentId, run.segments[1].id, "重复原文须用句段 ID 取回对应语境");
  assert.equal(requests[0].translation, "乙");
  assert.equal(requests[0].aiQa, true);
  assert.deepEqual(requests[0].workingTerms, [], "未确认工作术语不能强制覆盖现有译文");
  assert.equal(run.segments[1].translation, "乙");
  assert.equal(run.segments[1].result.qualityTier, "standard");
  assert.equal(run.segments[1].result.aiQa.fallbackReason, "");
  assert.deepEqual([run.segments[0], run.segments[2], run.segments[3]], untouched);
  assert.equal(progress.at(-1).completed, 1);
  assert.equal(progress.at(-1).failed, 0);
});

test("QA 返回其他译文时不改写原译，也不套用其他译文的评分", async () => {
  const { retryServerBatchQa } = await import("../src/batch-runner.mjs");
  const run = fixture();
  const outcome = await retryServerBatchQa(run.batchId, {
    loadRun: async () => run, saveRun: async value => Object.assign(run, value),
    recheckSegment: async () => ({ translation: "改写后的乙", qaScore: 100, aiQa: { used: true, score: 100, status: "passed" } })
  });
  assert.equal(run.segments[1].translation, "乙");
  assert.notEqual(run.segments[1].result.qaScore, 100);
  assert.match(run.segments[1].result.aiQa.fallbackReason, /译文不一致/u);
  assert.equal(outcome.failed, 1);
});

test("QA 再次失败保留译文并报告未完成，不能误报通过", async () => {
  const { retryServerBatchQa } = await import("../src/batch-runner.mjs");
  assert.equal(typeof retryServerBatchQa, "function");
  const run = fixture();
  const progress = [];
  await retryServerBatchQa(run.batchId, {
    loadRun: async () => run, saveRun: async (value) => Object.assign(run, value),
    recheckSegment: async () => { throw new Error("invalid QA response"); },
    report: async (value) => progress.push(value)
  });
  assert.equal(run.segments[1].translation, "乙");
  assert.equal(run.segments[1].status, "done");
  assert.match(run.segments[1].result.aiQa.fallbackReason, /invalid QA response/u);
  assert.equal(progress.at(-1).failed, 1);
});

test("手动修改后 not_run 的译文可单独补做 QA", async () => {
  const { retryServerBatchQa } = await import("../src/batch-runner.mjs");
  const run = fixture();
  run.segments[1].result.aiQa = { status: "not_run", used: false, score: null };
  let calls = 0;
  await retryServerBatchQa(run.batchId, {
    loadRun: async () => run, saveRun: async value => Object.assign(run, value),
    recheckSegment: async body => { calls += 1; return { translation: body.translation, aiQa: { used: true, score: 100, status: "passed", fallbackReason: "" } }; }
  });
  assert.equal(calls, 1);
  assert.equal(run.segments[1].result.aiQa.used, true);
});

test("未选中、规则检查与低分 QA 不计入执行失败；阶段进度及旧报告可区分", async () => {
  const { summarizeBatchSegments, buildBatchWorkflow } = await import("../public/batch-status.js");
  const run = fixture();
  run.segments.push({ id: "fast", source: "e", translation: "戊", selected: true, status: "done", result: { qualityTier: "fast", aiQa: { used: false, status: "deterministic_only", fallbackReason: "" } } });
  run.segments.push({ id: "review", source: "f", translation: "己", selected: true, status: "done", result: { qaScore: 80, aiQa: { used: true, status: "review", score: 80 } } });
  const summary = summarizeBatchSegments(run.segments);
  assert.equal(summary.total, 5);
  assert.equal(summary.completed, 4);
  assert.equal(summary.failed, 1);
  assert.equal(summary.qaIncomplete, 1);
  assert.equal(summary.ruleOnly, 1);
  run.segments[1].result.qaScore = 95;
  const report = buildQualityReport({ segments: run.segments });
  assert.equal(report.coverage.qaIncomplete, 1);
  assert.equal(report.coverage.modelQa, 2, "QA 中途失败时已有分数不能计入完成覆盖率");
  run.runnerOptions.translationCompletedAt = "2026-10-03T01:00:00Z";
  run.qualityReport = { report: { generatedAt: "2026-10-03T00:00:00Z" } };
  const workflow = buildBatchWorkflow(run, {
    qualityTask: { status: "in_progress", progress: { phase: "checking", message: "正在核对：2 / 8 片", percent: 25 } },
    termTask: { status: "failed", progress: { message: "术语普查失败：terminated" } }
  });
  assert.equal(workflow.qualityReport.status, "in_progress");
  assert.match(workflow.qualityReport.message, /2 \/ 8/u);
  assert.equal(workflow.termSurvey.status, "needs_attention");
  assert.match(workflow.termSurvey.message, /terminated/u);
  const waiting = buildBatchWorkflow(run);
  assert.equal(waiting.qualityReport.status, "blocked");
  assert.match(waiting.qualityReport.message, /需先完成全部译段/u);
  assert.equal(buildBatchWorkflow(run, { autoConsistencyCheck: false }).qualityReport.status, "disabled");
  run.segments[2].status = "pending";
  run.runnerOptions.translationError = "Directus 503";
  const interrupted = buildBatchWorkflow(run);
  assert.equal(interrupted.translation.status, "needs_attention");
  assert.match(interrupted.translation.message, /1 段未执行/u);
  assert.match(interrupted.translation.message, /Directus 503/u);
});

test("任务中心合并同批次的执行记录，不重复计数；其他后台任务保留", async () => {
  const { mergeBatchTaskRows } = await import("../public/batch-status.js");
  const batches = [{ batchId: "b1", type: "batch", totalSegments: 979 }];
  const background = [
    { id: "old", type: "background", taskType: "batch_translation", payload: { batchId: "b1" }, totalSegments: 979 },
    { id: "new", type: "background", taskType: "batch_translation", payload: { batchId: "b1" }, totalSegments: 979 },
    { id: "qa", type: "background", taskType: "batch_qa_retry", payload: { batchId: "b1" } },
    { id: "report", type: "background", taskType: "consistency_check", payload: { batchId: "b1" } },
    { id: "survey", type: "background", taskType: "term_survey", payload: { batchId: "b1" } },
    { id: "import", type: "background", taskType: "term_import", payload: { batchId: "b1" } },
    { id: "orphan", type: "background", taskType: "batch_translation", payload: { batchId: "b2" } }
  ];
  const result = mergeBatchTaskRows(batches, background);
  assert.deepEqual(result.map((item) => item.batchId || item.id), ["b1", "import", "orphan"]);
  assert.equal(result.reduce((sum, item) => sum + (item.totalSegments || 0), 0), 979);
});

test("QA 重试不使已有报告和普查过期，新一轮翻译仍需收尾", async () => {
  const { buildBatchWorkflow, batchQualityReportPending } = await import("../public/batch-status.js");
  const run = fixture();
  run.runnerOptions.translationCompletedAt = "2026-10-03T01:00:00Z";
  run.runnerOptions.qaCompletedAt = "2026-10-03T03:00:00Z";
  run.runnerOptions.workflowTasks = { qualityReport: "report", termSurvey: "survey" };
  run.qualityReport = { report: { generatedAt: "2026-10-03T02:00:00Z" } };
  run.runnerOptions.termSurvey = { generatedAt: "2026-10-03T02:00:00Z" };
  const completed = { status: "completed", updatedAt: "2026-10-03T02:00:00Z" };
  const workflow = buildBatchWorkflow(run, { qualityTask: completed, termTask: completed });
  assert.equal(workflow.qualityReport.status, "completed");
  assert.equal(workflow.termSurvey.status, "completed");
  assert.equal(batchQualityReportPending(run, workflow), false);
  const failed = buildBatchWorkflow(run, { qualityTask: { ...completed, status: "failed", progress: { message: "原报告失败" } }, termTask: completed });
  assert.equal(failed.qualityReport.status, "needs_attention", "失败报告继续保留失败状态，不因重试 QA 重新排队");
  run.runnerOptions.translationCompletedAt = "2026-10-03T04:00:00Z";
  const translated = buildBatchWorkflow(run, { qualityTask: completed, termTask: completed });
  assert.equal(translated.qualityReport.status, "blocked");
  assert.equal(translated.termSurvey.status, "blocked");
  assert.equal(batchQualityReportPending(run, translated), false);
});

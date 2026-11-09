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

test("部分翻译失败也为已有译文执行报告和术语普查；重试只补失败段", async () => {
  const run = fixture();
  const translated = [];
  const finalized = [];
  const options = {
    loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }),
    classifyDocument: async () => "dialogue",
    translateSegment: async ({ source }) => { translated.push(source); throw new Error("invalid translation"); },
    finalize: async (value) => finalized.push(value.segments.filter((segment) => segment.status === "done" && segment.selected !== false).length)
  };
  const failed = await runServerBatch(run.batchId, options);
  assert.equal(failed.runState, "needs_attention");
  assert.deepEqual(finalized, [2], "失败段不应让已有译文的收尾被跳过");
  const completed = await runServerBatch(run.batchId, {
    ...options, translateSegment: async ({ source }) => { translated.push(source); return { translation: "丙", issues: [] }; }
  });
  assert.equal(completed.runState, "completed");
  assert.deepEqual(translated, ["c", "c"], "成功段和 QA 未完成段都不能被重翻");
  assert.deepEqual(finalized, [2, 3], "补齐失败段后要重新生成收尾结果");
});

test("QA 重试只处理未完成 QA，保存修订并保留成功段与翻译失败段", async () => {
  const { retryServerBatchQa } = await import("../src/batch-runner.mjs");
  assert.equal(typeof retryServerBatchQa, "function");
  const run = fixture();
  const untouched = structuredClone([run.segments[0], run.segments[2], run.segments[3]]);
  const requests = [];
  const progress = [];
  await retryServerBatchQa(run.batchId, {
    loadRun: async () => run, saveRun: async (value) => Object.assign(run, value),
    recheckSegment: async (body) => { requests.push(body); return { translation: "乙（修订）", qaScore: 95, issues: [], aiQa: { used: true, status: "passed", score: 95, fallbackReason: "" } }; },
    report: async (value) => progress.push(value)
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source, "b");
  assert.equal(requests[0].segmentId, run.segments[1].id, "重复原文须用句段 ID 取回对应语境");
  assert.equal(requests[0].translation, "乙");
  assert.equal(requests[0].aiQa, true);
  assert.equal(run.segments[1].translation, "乙（修订）");
  assert.equal(run.segments[1].result.qualityTier, "standard");
  assert.equal(run.segments[1].result.aiQa.fallbackReason, "");
  assert.deepEqual([run.segments[0], run.segments[2], run.segments[3]], untouched);
  assert.equal(progress.at(-1).completed, 1);
  assert.equal(progress.at(-1).failed, 0);
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
  assert.equal(waiting.qualityReport.status, "waiting");
  assert.match(waiting.qualityReport.message, /上次质量报告/u);
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

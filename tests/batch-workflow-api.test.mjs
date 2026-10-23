import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import vm from "node:vm";
import { retryServerBatchQa } from "../src/batch-runner.mjs";
import { buildBatchWorkflow, isIncompleteBatchQa, mergeBatchTaskRows, summarizeBatchSegments } from "../public/batch-status.js";
import { runTaskPool } from "../src/task-pool.mjs";
import { surveyPairs, normalizeSurveyTerms } from "../src/term-survey.mjs";
import { settleReadSections } from "../src/read-sections.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

const source = (await readFile(new URL("../server.mjs", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const stageCode = block("function startConsistencyCheck(", "/**\n * 翻译期术语普查")
  + block("function startTermSurvey(", "async function attachBatchWorkflowTask(")
  + block("async function attachBatchWorkflowTask(", "function startBatchWorker(")
  + block("function startBatchWorker(", "async function apiHandler(")
  + block("async function translateBatchSegment(", "/**\n * 审校回填");
const routeCode = block('  if (req.method === "POST" && /^\\/api\\/batch\\/run\\/[^/]+\\/retry-qa', '  if (req.method === "GET" && url.pathname.startsWith("/api/batch/run/"))')
  + block('  if (req.method === "GET" && url.pathname === "/api/tasks")', '  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/export"))');

test("术语普查在一致性修复后读取批次，不用旧快照覆盖报告和修订译文", async () => {
  let saved = { qualityReport: null, translation: "旧译文" };
  let finishQuality;
  const qualityDone = new Promise((resolve) => { finishQuality = resolve; });
  const finalize = vm.runInNewContext(`(${block("async function finalizeBatchWorkflow(", "function startBatchQaRetry(").trim()})`, {
    getSettings: () => ({ quality: { autoConsistencyCheck: true }, learning: { termSurveyEnabled: true } }),
    startConsistencyCheck: async () => { await Promise.resolve(); saved = { ...saved, translation: "统一后的译文", qualityReport: { generatedAt: "new" } }; finishQuality(); },
    startTermSurvey: async () => { const snapshot = structuredClone(saved); await qualityDone; saved = { ...snapshot, termSurvey: { generatedAt: "new" } }; },
    console: { error: () => {} }
  });
  await finalize("batch-test");
  assert.equal(saved.translation, "统一后的译文");
  assert.equal(saved.qualityReport?.generatedAt, "new");
  assert.equal(saved.termSurvey.generatedAt, "new");
});

test("术语普查部分模型失败时，失败片不计入成功覆盖", async () => {
  let run = { batchId: "survey-test", projectId: "project-test", filename: "story.txt", locale: "zh-CN", segments: [
    { id: "a", source: "甲", translation: "甲", selected: true }, { id: "b", source: "乙", translation: "乙", selected: true }
  ] };
  const survey = vm.runInNewContext(`(${block("async function runTermSurvey(", "/** 起一个术语普查后台任务").trim()})`, {
    getBatchRun: async () => structuredClone(run), saveBatchRun: async (value) => { run = value; },
    surveyPairs, normalizeSurveyTerms, runTaskPool, CONSISTENCY_CHECK_CONCURRENCY: 2,
    splitConsistencyChunks: () => [{ index: 1, ids: ["a"] }, { index: 2, ids: ["b"] }],
    getProjectAssets: async () => ({ assets: { terms: [] } }), getProviderConfig: () => ({ model: "test" }), taskProgressReporter: () => () => {},
    surveyTermsWithModel: async ({ part }) => { if (part.index === 2) throw new Error("503"); return { terms: [] }; }
  });
  const outcome = await survey("survey-test");
  assert.equal(outcome.coverage.analyzedPairs, 1);
  assert.equal(outcome.coverage.totalSegments, 2);
  assert.equal(outcome.coverage.failedChunks, 1);
  assert.equal(run.runnerOptions.termSurvey.warning, "503");
});

test("批次详情不会把同原文另一句段的失败 QA 覆盖到已成功句段", async () => {
  const segments = [{ id: "ok", source: "same source", translation: "已确认译文", selected: true, status: "done", result: { qaScore: 97, aiQa: { score: 97, status: "passed", used: true, fallbackReason: "" } } }];
  let result;
  const handler = vm.runInNewContext(`(async (req, res, url) => { ${block('  if (req.method === "GET" && url.pathname.startsWith("/api/batch/run/"))', '  if (req.method === "POST" && url.pathname === "/api/style-guides/import")')} })`, {
    getBatchRun: async () => ({ batchId: "batch-test", projectId: "project-test", locale: "zh-CN", segments }),
    getProjectAssets: async () => ({ assets: { terms: [] } }),
    getQaRuns: async () => [{ source: "same source", finalTranslation: "另一句段译文", score: null, status: "review", fallbackReason: "terminated" }],
    assertActiveLocale: () => {}, json: (_res, _status, body) => { result = body; },
    loadBatchWorkflow: async (run) => buildBatchWorkflow(run), buildTermSurveyView: () => null, CONTEXT_BRIEF_MIN_SEGMENTS: 20, contextAnalysisTasks: new Map()
  });
  await handler({ method: "GET" }, {}, new URL("http://localhost/api/batch/run/batch-test?projectId=project-test"));
  assert.equal(result.segments[0].result.aiQa.fallbackReason, "");
  assert.equal(result.segments[0].result.qaScore, 97);
  assert.equal(result.workflow.summary.qaIncomplete, 0);
});

test("没有在执行的收尾不会误显示为持续排队，旧任务也有明确手动入口提示", async () => {
  const load = vm.runInNewContext(`(${block("async function loadBatchWorkflow(", "async function finalizeBatchWorkflow(").trim()})`, {
    getSettings: () => ({ quality: {}, learning: {} }), buildBatchWorkflow, getBackgroundTask: async () => null,
    batchWorkers: new Map(), batchQaWorkers: new Map(), consistencyCheckTasks: new Map(), termSurveyTasks: new Map()
  });
  const workflow = await load({ batchId: "old-batch", runState: "completed", segments: [{ id: "s1", selected: true, status: "done", translation: "译文" }] });
  assert.equal(workflow.qualityReport.status, "not_started");
  assert.equal(workflow.termSurvey.status, "not_started");
  assert.match(workflow.qualityReport.message, /尚未执行，可手动运行/u);
});

for (const reviewInFlight of [false, true]) {
test(`QA 重试沿用译文、合并重复请求并自动收尾${reviewInFlight ? "，不被风格复盘挡住" : ""}`, { timeout: 15000 }, async () => {
  let run = { batchId: "api-batch", projectId: "project-test", locale: "zh-CN", filename: "story.mqxliff", runState: "needs_attention", runnerOptions: {},
    segments: [
      { id: "ok", source: "a", translation: "甲", status: "done", selected: true, result: { qaScore: 97, aiQa: { used: true, status: "passed" } } },
      { id: "qa", source: "b", translation: "乙", status: "done", selected: true, result: { qualityTier: "standard", aiQa: { fallbackReason: "terminated" } } },
      { id: "error", source: "c", status: "error", selected: true, error: "translation failed" }
    ] };
  if (reviewInFlight) {
    run.runState = "completed";
    run.segments[2] = { ...run.segments[2], status: "done", translation: "丙", error: "", result: { qaScore: 97, aiQa: { used: true, status: "passed" } } };
  }
  const untouched = structuredClone([run.segments[0], run.segments[2]]);
  const tasks = new Map([
    ["translation-old", { id: "translation-old", type: "batch_translation", status: "failed", payload: { batchId: run.batchId }, progress: { total: 3 } }],
    ["translation-new", { id: "translation-new", type: "batch_translation", status: "completed", payload: { batchId: run.batchId }, progress: { total: 3 } }]
  ]);
  const requests = [];
  let releaseQa;
  const qaGate = new Promise((resolve) => { releaseQa = resolve; });
  let releaseReview;
  let signalReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  const reviewStarted = new Promise((resolve) => { signalReview = resolve; });
  const controls = new Map();
  const readJsonBody = async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); };
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); return true; };
  const context = vm.createContext({
    withRuntimeCall,
    batchWorkers: new Map(), batchQaWorkers: new Map(), batchQaStarts: new Map(), batchWorkflowWrites: new Map(), consistencyCheckTasks: new Map(), termSurveyTasks: new Map(),
    getBatchRun: async () => structuredClone(run), saveBatchRun: async (value) => { run = structuredClone(value); run.runnerOptions.batchSummary = summarizeBatchSegments(run.segments); },
    getBackgroundTask: async (id) => tasks.get(id),
    createBackgroundTask: async (input) => { const task = { ...input, id: `task-${tasks.size}`, status: "in_progress", createdAt: new Date().toISOString() }; tasks.set(task.id, task); return task; },
    updateBackgroundTaskProgress: async (id, update) => tasks.set(id, { ...tasks.get(id), ...update, updatedAt: new Date().toISOString() }),
    beginBackgroundRun: (id) => { const control = { cancelRequested: false }; controls.set(id, control); return control; }, endBackgroundRun: (id) => controls.delete(id),
    retryServerBatchQa, buildBatchWorkflow, isIncompleteBatchQa, mergeBatchTaskRows,
    runServerBatch: async (_id, options) => { await options.finalize(run); await options.review(run); return run; },
    runEvolutionReview: async () => { signalReview(); await reviewGate; }, getProject: async () => ({ settings: {} }), classify: async () => ({ contentType: "general" }),
    workbenchSessionMonitor: null, setInterval: () => ({ unref: () => {} }), clearInterval: () => {},
    getSettings: () => ({ quality: { autoConsistencyCheck: true }, learning: { termSurveyEnabled: true } }),
    runConsistencyCheck: async () => {
      run.qualityReport = { report: { generatedAt: new Date().toISOString(), coverage: { percent: 100 } }, findings: [] };
      return { ...run.qualityReport, repair: { changed: [] }, failures: [] };
    },
    runTermSurvey: async () => { run.runnerOptions.termSurvey = { generatedAt: new Date().toISOString(), terms: [], warning: "" }; return { terms: [], failures: [] }; },
    listBatchRuns: async () => { const summary = summarizeBatchSegments(run.segments); return [{ ...run, segments: undefined, totalSegments: summary.total, completedSegments: summary.completed, failedSegments: summary.failed, qaPending: summary.qaIncomplete, status: summary.failed ? "needs_attention" : "completed" }]; },
    listQaTasks: async () => [], listBackgroundTasks: async () => [...tasks.values()], assertActiveLocale: (value) => value, ACTIVE_LOCALES: ["zh-CN"],
    settleReadSections,
    readJsonBody, json, fetch, console, runtimeOptions: () => ({})
  });
  vm.runInContext(stageCode, context);
  const handler = vm.runInContext(`(async (req, res, url) => { ${routeCode} })`, context);
  const server = createServer(async (req, res) => {
    if (req.url === "/api/qa") {
      const body = await readJsonBody(req);
      requests.push(body);
      await qaGate;
      return json(res, 200, { translation: "乙", qaScore: 97, issues: [], aiQa: { score: 97, used: true, status: "passed", fallbackReason: "" } });
    }
    try { await handler(req, res, new URL(req.url, "http://localhost")); }
    catch (error) { json(res, 500, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.PORT = server.address().port;
  const base = `http://127.0.0.1:${context.PORT}`;
  const post = () => fetch(`${base}/api/batch/run/api-batch/retry-qa`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-test" }) }).then((res) => res.json());
  try {
    if (reviewInFlight) { context.startBatchWorker(run.batchId); await reviewStarted; }
    const [first, duplicate] = await Promise.all([post(), post()]);
    assert.ok(first.backgroundTaskId);
    assert.equal(first.backgroundTaskId, duplicate.backgroundTaskId);
    assert.equal([first, duplicate].find((result) => !result.alreadyRunning).waiting, false);
    assert.equal([...tasks.values()].filter((task) => task.type === "batch_qa_retry").length, 1);
    const pending = await fetch(`${base}/api/batch/run/api-batch/status?projectId=project-test`).then((res) => res.json());
    assert.equal(pending.workflow.qaRetryBusy, true);
    assert.equal(pending.workflow.summary.qaIncomplete, 1);
    const execution = context.batchQaWorkers.get(run.batchId).promise;
    releaseQa();
    await execution;
    if (reviewInFlight) assert.equal(context.batchWorkers.has(run.batchId), true, "QA 重试应完成，而风格复盘仍可独立继续");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].source, "b");
    assert.equal(requests[0].translation, "乙");
    assert.equal(requests[0].aiQa, true);
    assert.deepEqual([run.segments[0], run.segments[2]], untouched);
    assert.ok(run.runnerOptions.workflowTasks.qualityReport);
    assert.ok(run.runnerOptions.workflowTasks.termSurvey, "两个阶段的任务号都必须完整保存");
    assert.equal(controls.size, 0);
    const status = await fetch(`${base}/api/batch/run/api-batch/status?projectId=project-test`).then((res) => res.json());
    assert.equal(status.workflow.summary.qaIncomplete, 0);
    assert.equal(status.workflow.summary.failed, reviewInFlight ? 0 : 1);
    assert.equal(status.workflow.qualityReport.status, "completed");
    assert.equal(status.workflow.termSurvey.status, "completed");
    assert.ok(status.qualityReportAt && status.termSurveyAt);
    const list = await fetch(`${base}/api/tasks?projectId=project-test`).then((res) => res.json());
    assert.equal(list.length, 1, "翻译记录、QA 重试和两个收尾阶段都合并进一条批次");
    assert.equal(list[0].workflow.summary.qaIncomplete, 0);
    assert.equal(list.reduce((sum, task) => sum + task.totalSegments, 0), 3);
  } finally {
    releaseQa();
    releaseReview();
    await context.batchQaWorkers.get(run.batchId)?.promise;
    await context.batchWorkers.get(run.batchId)?.promise;
    await new Promise((resolve) => server.close(resolve));
    tasks.clear(); controls.clear();
    assert.equal(tasks.size + controls.size, 0, "临时任务和运行引用必须清零");
  }
});
}

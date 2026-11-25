import test from "node:test";
import assert from "node:assert/strict";
import { runServerBatch } from "../src/batch-runner.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun, getBatchRun } from "../src/store.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { translationRetryReason } from "../src/translation-output.mjs";

test("targeted translation retry preserves completed, unstarted and unchecked segments", async () => {
  const run = { batchId: "retry", projectId: "p", filename: "story.txt", locale: "zh-CN", contentType: "dialogue", runnerOptions: {}, segments: [
    { id: "ok", source: "甲", translation: "正常译文", status: "done", selected: true, result: { qaScore: 98 } },
    { id: "retry", source: "乙", translation: "旧问题译文", status: "pending", selected: true },
    { id: "unstarted", source: "丙", selected: true },
    { id: "unchecked", source: "丁", selected: false }
  ] };
  const untouched = structuredClone([run.segments[0], ...run.segments.slice(2)]), calls = [];
  const result = await runServerBatch(run.batchId, {
    segmentIds: ["retry"], loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }),
    translateSegment: async (input) => { calls.push(input); return { translation: "重试成功" }; },
    finalize: () => assert.fail("a scoped retry must not repair other segments"), review: () => assert.fail("scoped retry must not run batch learning")
  });
  assert.deepEqual(calls.map((item) => item.segmentId), ["retry"]);
  assert.equal(calls[0].previousSource, "甲"); assert.equal(calls[0].nextSource, "丙");
  assert.equal(result.segments[1].translation, "重试成功");
  assert.deepEqual([run.segments[0], ...run.segments.slice(2)], untouched);
  assert.equal(result.runState, "paused", "the unstarted remainder stays paused");
});

test("retry API finds legacy contamination, rejects invalid targets and locks concurrent mutations", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-translation-retry-")), cwd = join(directory, "workspace");
  await mkdir(cwd); await writeFile(join(cwd, "source.txt"), "設定を保存します。");
  const { fs, close } = await workspaceFs();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  const calls = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (_messages, options) => {
    calls.push(options); entered(); await gate;
    return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : "保存设置。" };
  } });
  const context = { cwd, fs, human: true, modelRoute: { provider: "selected", model: "new-model", reasoningEffort: "max" } };
  try {
    const state = await workbench.workspace({ action: "bind", name: "定向重试" }, context);
    const projectId = state.project.id;
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    const path = `/api/batch/run/${prepared.batchId}`, run = await workbench.invoke({ path }, context);
    const base = run.segments[0];
    const segments = [
      { ...base, id: "ok", status: "done", translation: "正常译文", result: { qaScore: 98 } },
      { ...base, id: "bad", status: "done", translation: "**非译文说明：未能查阅风格指南原件", result: { aiQa: { fallbackReason: "truncated" } } },
      { ...base, id: "error", status: "error", error: "输出被截断" },
      { ...base, id: "pending", status: "pending", translation: "" },
      { ...base, id: "human", status: "done", translation: "人工确认译文", accepted: true }
    ];
    await saveBatchRun({ ...run, segments, runState: "paused", runnerOptions: { ...run.runnerOptions, qualityTier: "quick", reflect: false } });
    const before = await getBatchRun(run.batchId);
    const retry = (extra = {}) => workbench.invoke({ path: `${path}/retry-translation`, method: "POST", body: { projectId, ...extra } }, context);
    for (const segmentIds of [[], ["missing"], ["human"], "bad"]) await assert.rejects(retry({ segmentIds }), { statusCode: 400 });
    await assert.rejects(retry({ projectId: "wrong" }), /项目不匹配/);
    const outcomes = await Promise.allSettled([retry(), retry()]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((item) => item.status === "fulfilled").value.count, 2);
    await started;
    await assert.rejects(retry(), { statusCode: 409 });
    await assert.rejects(workbench.invoke({ path: "/api/batch/run", method: "POST", body: { batchId: run.batchId, segments } }, context), { statusCode: 409 });
    release();
    let latest;
    for (let i = 0; i < 250; i++) { latest = await workbench.invoke({ path }, context); if (!latest.workflow.writeBusy) break; await setTimeout(20); }
    assert.equal(latest.workflow.writeBusy, false);
    assert.equal(latest.runState, "paused", "补完重试段后，仍未开始的剩余段让批次停在可继续状态");
    assert.equal(latest.segments[1].result.stages.proofreading.status, "completed", "翻译重试应连同校对一起完成");
    assert.equal(latest.segments[1].translation, "保存设置。"); assert.equal(latest.segments[2].translation, "保存设置。");
    assert.equal(latest.segments[1].retryTranslationReason, "");
    const saved = await getBatchRun(run.batchId);
    assert.deepEqual([saved.segments[0], ...saved.segments.slice(3)], [before.segments[0], ...before.segments.slice(3)]);
    assert.ok(calls.every((call) => call.route.model === "new-model" && call.route.reasoningEffort === "max"));
    assert.equal((await retry()).count, 0);
    const single = await retry({ segmentIds: ["ok"] }); assert.equal(single.count, 1);
  } finally { release(); await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

test("retry detection protects human finals and excludes unstarted text", () => {
  assert.equal(translationRetryReason({ status: "pending" }), "");
  assert.match(translationRetryReason({ status: "pending", translation: "非译文说明：旧失败结果" }), /非译文说明/);
  assert.equal(translationRetryReason({ status: "done", translation: "原文件查阅失败", accepted: true }), "");
  assert.match(translationRetryReason({ status: "done", translation: "**非译文说明：工具失败" }), /非译文说明/);
});

test("重试翻译走完整流程，整批补齐后自动进入一致性收尾", async () => {
  const complete = { translation: { status: "completed" }, draftQa: { status: "completed" }, proofreading: { status: "completed" }, localQa: { status: "optional" } };
  const run = { batchId: "retry-complete", projectId: "p", filename: "story.txt", locale: "zh-CN", contentType: "dialogue", runnerOptions: {}, segments: [
    { id: "ok", source: "甲", translation: "正常译文", status: "done", selected: true, result: { qaScore: 98, stages: complete } },
    { id: "bad", source: "乙", status: "error", selected: true, error: "输出被截断" }
  ] };
  const calls = [];
  let finalized = 0, reviewed = 0;
  const result = await runServerBatch(run.batchId, {
    segmentIds: ["bad"], loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }),
    translateSegment: async (input) => { calls.push(input); return { translation: "重试成功", stages: complete }; },
    finalize: async () => { finalized += 1; }, review: async () => { reviewed += 1; }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflowStage, undefined, "重试不能再只跑翻译阶段");
  assert.equal(result.runState, "completed");
  assert.equal(finalized, 1, "整批补齐后应自动收尾");
  assert.equal(reviewed, 0, "重试不跑批次风格学习");
});

test("重试翻译完成后自动开始一致性检查", { timeout: 40000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-retry-finish-")), cwd = join(directory, "workspace");
  await mkdir(cwd); await writeFile(join(cwd, "source.txt"), "設定を保存します。");
  const { fs, close } = await workspaceFs();
  const labels = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (_messages, options) => {
    labels.push(options.requestLabel);
    if (/一致性|QA/.test(options.requestLabel)) return { content: "[]" };
    return { content: options.requestLabel === "翻译" ? "保存设置。" : "保存设置。" };
  } });
  const context = { cwd, fs, human: true, modelRoute: { provider: "selected", model: "new-model" } };
  try {
    const state = await workbench.workspace({ action: "bind", name: "重试后收尾" }, context);
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    const path = `/api/batch/run/${prepared.batchId}`, run = await workbench.invoke({ path }, context);
    await saveBatchRun({ ...run, runState: "needs_attention", segments: [{ ...run.segments[0], id: "only", status: "error", error: "输出被截断", translation: "" }] });
    const retry = await workbench.invoke({ path: `${path}/retry-translation`, method: "POST", body: { projectId: state.project.id } }, context);
    assert.equal(retry.count, 1);
    // 任务中心会把后台子任务并进批次行，直接看模型调用标签更可靠：一致性检查必须自动发起。
    for (let i = 0; i < 120 && !labels.includes("一致性检查"); i += 1) await setTimeout(200);
    assert.equal(labels.includes("一致性检查"), true, "重试补齐整批后应自动启动一致性检查");
    // 等一致性任务收尾，避免关闭工作台时还在跑。
    for (let i = 0; i < 50; i += 1) {
      const latest = await workbench.invoke({ path }, context);
      if (["completed", "needs_attention", "not_run"].includes(latest.workflow?.qualityReport?.status)) break;
      await setTimeout(200);
    }
  } finally {
    await workbench.close(); await close();
    await rm(directory, { recursive: true, force: true });
  }
});

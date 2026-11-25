import test from "node:test";
import assert from "node:assert/strict";
import { createLearningAutomation } from "../src/learning-automation.mjs";
import { selectSkillHoldout } from "../src/learning-engine.mjs";

const scope = { locale: "zh-CN", project: "automation", contentType: "general", domain: "general" };
const accepted = (id) => ({ ...scope, id, source: `原文${id}`, finalTranslation: `终稿${id}`, status: "completed", humanDecision: { accepted: true } });

test("相同原文的另一条轨迹不能冒充独立样本，同源留出样本只计一次", () => {
  const rows = [accepted("train"), { ...accepted("copy"), source: "原文train" }, accepted("valid"), { ...accepted("repeat"), source: "原文valid" }];
  assert.deepEqual(selectSkillHoldout(rows, { scope, trainingEvidenceIds: ["train"] }).map((item) => item.id), ["valid"]);
  assert.deepEqual(selectSkillHoldout(rows.slice(1), { scope, trainingSources: ["原文train"] }).map((item) => item.id), ["valid"]);
});

function fixture() {
  const champion = { id: "v1", status: "champion", metadata: {} };
  const candidate = { id: "v2", parentId: "v1", status: "challenger", evidenceIds: ["training"] };
  const state = { champion, candidates: [candidate], trajectories: [accepted("training")], jobs: [] };
  let evaluations = 0, proposals = 0, gates = 0;
  const deps = {
    load: async () => state,
    save: async (_champion, value) => { champion.metadata.learningAutomation = value; },
    propose: async () => { proposals += 1; return { proposed: false, reason: "等待人工终稿" }; },
    evaluate: async (skill) => { evaluations += 1; const job = { jobId: "job-" + evaluations, challengerId: skill.id, championId: champion.id, status: "queued", progress: { failed: 0 } }; state.jobs.push(job); return { jobId: job.jobId }; },
    revise: async (_scope, _champion, previous, job, round) => {
      const next = { ...candidate, id: "revised-" + round, metadata: { evaluationRevision: { championId: champion.id, round, previousId: previous.id, jobId: job.jobId } } };
      state.candidates.unshift(next); return next;
    },
    gate: async () => { gates += 1; return { status: "ready", message: "等待确认启用" }; }
  };
  return { state, deps, counts: () => ({ evaluations, proposals, gates }) };
}

test("新增终稿补齐独立样本后自动评测；重复事件与恢复不重复运行", async () => {
  const f = fixture(), runner = createLearningAutomation({ deps: f.deps });
  await runner.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.status, "waiting");
  assert.equal(f.state.champion.metadata.learningAutomation.missingSamples, 20);
  f.state.trajectories.push(...Array.from({ length: 20 }, (_, i) => accepted(`holdout-${i}`)));
  await Promise.all([runner.trigger(scope), runner.trigger({ ...scope, contentType: "ui" })]);
  assert.equal(f.counts().evaluations, 1);
  const restored = createLearningAutomation({ deps: f.deps });
  await restored.trigger(scope);
  assert.equal(f.counts().evaluations, 1);
  assert.equal(f.state.champion.metadata.learningAutomation.status, "evaluating");
  await runner.stop(); await restored.stop();
});

test("失败自动生成修订稿并复评，第三次不通过等待手动继续，门禁通过才待确认", async () => {
  const f = fixture(), runner = createLearningAutomation({ deps: f.deps });
  const failed = { status: "completed", progress: { failed: 0 }, result: { report: { status: "reject", promotable: false, conclusion: "术语回退" } } };
  f.state.trajectories.push(...Array.from({ length: 20 }, (_, i) => accepted("holdout-" + i)));
  f.state.jobs.push({ jobId: "done", challengerId: "v2", championId: "v1", ...failed });
  await runner.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.revisionRound, 1);
  assert.equal(f.state.jobs.at(-1).challengerId, "revised-1");
  Object.assign(f.state.jobs.at(-1), failed);
  await runner.trigger(scope); await runner.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.revisionRound, 2);
  assert.equal(f.state.jobs.at(-1).challengerId, "revised-2");
  Object.assign(f.state.jobs.at(-1), failed);
  await runner.stop();
  const restored = createLearningAutomation({ deps: f.deps });
  await restored.trigger(scope); await restored.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.canContinue, true);
  assert.equal(f.counts().evaluations, 2);
  assert.equal(f.counts().gates, 0);
  await restored.trigger(scope, { continueJobId: f.state.jobs.at(-1).jobId });
  assert.equal(f.state.jobs.at(-1).challengerId, "revised-3");
  Object.assign(f.state.jobs.at(-1), { ...failed, result: { report: { promotable: true } } });
  await restored.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.status, "ready");
  assert.equal(f.state.champion.id, "v1");
  assert.equal(f.state.candidates[0].status, "challenger");
  await restored.stop();
});

test("评测执行失败不会用于改写策略；修订失败重复触发不重复花费", async () => {
  const f = fixture(), runner = createLearningAutomation({ deps: f.deps });
  const job = { jobId: "fail", challengerId: "v2", championId: "v1", status: "completed", progress: { failed: 1 }, result: { report: { status: "reject", promotable: false } } };
  f.state.jobs.push(job);
  let attempts = 0;
  f.deps.revise = async () => { attempts++; throw new Error("修订服务暂时不可用"); };
  await runner.trigger(scope); assert.equal(attempts, 0);
  job.progress.failed = 0;
  await runner.trigger(scope); await runner.trigger(scope);
  assert.equal(attempts, 1);
  assert.match(f.state.champion.metadata.learningAutomation.message, /修订服务/);
  assert.equal(f.state.champion.metadata.learningAutomation.canContinue, true);
  await runner.stop();
});

test("中断任务由后台续跑，不生成第二条评测；关闭后不接受新工作", async () => {
  const f = fixture(); let resumed = 0;
  f.state.jobs.push({ jobId: "interrupted", challengerId: "v2", championId: "v1", status: "interrupted", progress: { failed: 0 } });
  f.deps.resume = async () => { resumed += 1; f.state.jobs[0].status = "queued"; };
  const runner = createLearningAutomation({ deps: f.deps });
  await runner.trigger(scope);
  assert.equal(resumed, 1);
  assert.equal(f.counts().evaluations, 0);
  await runner.stop();
  await runner.trigger(scope);
  assert.equal(resumed, 1);
});

test("同一项目的大量逐条终稿事件合并检查，不积压重复读取", async () => {
  const f = fixture(); let loads = 0;
  const load = f.deps.load;
  f.deps.load = async () => { loads += 1; return load(); };
  const runner = createLearningAutomation({ deps: f.deps });
  await Promise.all(Array.from({ length: 100 }, () => runner.trigger(scope)));
  assert.equal(loads, 1);
  await runner.stop();
});

test("未完成和不稳定的评测不触发策略修订，重复点击只提交一次", async () => {
  const f = fixture();
  const job = { jobId: "old", challengerId: "v2", championId: "v1", status: "completed", progress: { failed: 0 }, result: { report: {} } };
  f.state.jobs.push(job);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  f.deps.revise = async () => { calls++; entered.resolve(); await release.promise; throw new Error("模拟修订中断"); };
  const runner = createLearningAutomation({ deps: f.deps });
  try {
    for (const status of ["insufficient", "unstable"]) {
      job.result.report = { status, promotable: false };
      await runner.trigger(scope);
      assert.equal(calls, 0);
    }
    job.result.report.status = "reject";
    const first = runner.trigger(scope, { continueJobId: job.jobId });
    await entered.promise;
    const second = runner.trigger(scope, { continueJobId: job.jobId });
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  } finally { release.resolve(); await runner.stop(); }
});

test("门禁失败按复盘自动改版复评，达到轮次上限后暂停并允许手动继续", async () => {
  const champion = { id: "v1", status: "champion", metadata: {}, strategy: { prompting: { additionalRules: ["保留术语"] } } };
  const candidate = { id: "v2", parentId: "v1", status: "challenger", evidenceIds: ["training"] };
  const state = { champion, candidates: [candidate], trajectories: [accepted("training"), ...Array.from({ length: 20 }, (_, i) => accepted(`holdout-${i}`))], jobs: [] };
  let evaluations = 0, revisions = 0, gates = 0;
  const deps = {
    load: async () => state,
    save: async (_champion, value) => { champion.metadata.learningAutomation = value; },
    propose: async () => ({ proposed: false }),
    evaluate: async (skill) => { evaluations += 1; const job = { jobId: "job-" + evaluations, challengerId: skill.id, championId: "v1", status: "queued", progress: { failed: 0 } }; state.jobs.push(job); return { jobId: job.jobId }; },
    revise: async () => { throw new Error("门禁失败不应走评测修订分支"); },
    gateRevisionLimit: () => 2,
    gate: async () => { gates += 1; return { status: "blocked", message: "Gold 术语准确率不足", revisable: true, runId: "run-" + gates,
      assets: { goldSetVersions: ["gold#v1"], regressionSuiteVersions: ["regression#v1"], goldSampleCount: 3, regressionCaseCount: 1, syncedAt: "2026-11-25T00:00:00.000Z" } }; },
    reviseForGate: async (_scope, _champion, previous) => { revisions += 1; const next = { ...previous, id: "gate-" + revisions, parentId: "v1", evidenceIds: ["training"] }; state.candidates.unshift(next); return next; },
    resume: async () => undefined
  };
  const runner = createLearningAutomation({ deps });
  const settle = () => { const job = state.jobs.at(-1); Object.assign(job, { status: "completed", progress: { failed: 0 }, result: { report: { promotable: true } } }); };

  state.jobs.push({ jobId: "job-0", challengerId: "v2", championId: "v1", status: "completed", progress: { failed: 0 }, result: { report: { promotable: true } } });
  await runner.trigger(scope);
  assert.equal(revisions, 1, "门禁失败后应按复盘生成修订稿");
  assert.equal(state.jobs.at(-1).challengerId, "gate-1");
  assert.equal(champion.metadata.learningAutomation.status, "evaluating");
  assert.equal(champion.metadata.learningAutomation.assets.goldSampleCount, 3);
  assert.ok(champion.metadata.learningAutomation.history.some((entry) => entry.status === "revising"));

  settle();
  await runner.trigger(scope);
  assert.equal(revisions, 2, "第二次仍失败应继续修订");
  assert.equal(champion.metadata.learningAutomation.gateRound, 2);

  settle();
  await runner.trigger(scope);
  assert.equal(revisions, 2, "达到上限后不再自动修订");
  assert.equal(champion.metadata.learningAutomation.status, "blocked");
  assert.equal(champion.metadata.learningAutomation.canContinue, true);
  assert.equal(champion.metadata.learningAutomation.continueMode, "gate");
  assert.match(champion.metadata.learningAutomation.message, /门禁连续 2 轮未通过/u);
  await runner.stop();
});

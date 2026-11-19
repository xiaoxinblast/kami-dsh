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

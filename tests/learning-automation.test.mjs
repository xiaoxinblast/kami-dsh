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
    evaluate: async () => { evaluations += 1; const job = { jobId: "job", challengerId: candidate.id, championId: champion.id, status: "queued", progress: { failed: 0 } }; state.jobs.push(job); return { jobId: job.jobId }; },
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

test("质量失败停止推进，通过评测和门禁后只进入待确认", async () => {
  const f = fixture(), runner = createLearningAutomation({ deps: f.deps });
  f.state.jobs.push({ jobId: "done", challengerId: "v2", championId: "v1", status: "completed", progress: { failed: 0 }, result: { report: { promotable: false, conclusion: "术语回退" } } });
  await runner.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.status, "blocked");
  assert.equal(f.counts().gates, 0);
  f.state.jobs[0].result.report = { promotable: true };
  await runner.trigger(scope);
  assert.equal(f.state.champion.metadata.learningAutomation.status, "ready");
  assert.equal(f.state.champion.id, "v1");
  assert.equal(f.state.candidates[0].status, "challenger");
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

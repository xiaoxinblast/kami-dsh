import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvaluationJobRunner } from "../src/evaluation-jobs.mjs";
import { validateCandidatePromotionState } from "../src/learning-engine.mjs";
import { runtimeOptions, withRuntimeCall } from "../src/runtime-context.mjs";

const scope = { locale: "zh-CN", project: "recovery", contentType: "general", domain: "general" };
async function setup(t, fail = false) {
  const directory = await mkdtemp(join(tmpdir(), "kami-auto-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const champion = { ...scope, id: "v1", status: "champion" }, challenger = { ...scope, id: "v2", parentId: "v1", status: "challenger" };
  const trajectories = ["a", "b"].map((id) => ({ id, source: id, finalTranslation: id, humanDecision: { accepted: true } }));
  const calls = [], routes = [];
  const options = {
    jobsDirectory: directory, automaticRetryLimit: 1,
    createSnapshot: async () => ({ fingerprint: "frozen" }),
    benchmark: async (skill, row) => {
      calls.push(`${skill.id}:${row.id}`); routes.push(runtimeOptions().modelRoute);
      if (fail && row.id === "b") throw Object.assign(new Error("模型暂时不可用"), { code: "temporary" });
      return { caseId: row.id, scope, qaScore: skill.id === "v2" ? 99 : 90, hardErrorCount: 0, requiredTermTotal: 1, requiredTermHits: 1, humanEditDistance: skill.id === "v2" ? 0 : 0.2, humanAccepted: true, cost: 0, latencyMs: 1 };
    },
    deps: {
      getSkill: async (id) => id === "v1" ? champion : challenger,
      getCurrentChampion: async () => champion,
      validatePromotionState: validateCandidatePromotionState,
      saveEvaluation: async () => ({ id: "evaluation" }), updateSkillMetrics: async () => {},
      buildUiReport: (result) => ({ promotable: result.promotable, status: result.status, conclusion: result.reportZh })
    }
  };
  return { options, directory, champion, challenger, trajectories, calls, routes };
}
async function finish(runner, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = runner.get(id);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("评测没有结束");
}

test("后台仅自动补跑一次失败样本，成功样本不重跑", async (t) => {
  const f = await setup(t, true), runner = createEvaluationJobRunner(f.options);
  const job = await runner.create({ scope, ...f });
  const done = await finish(runner, job.jobId);
  await runner.stop();
  assert.equal(done.status, "completed", done.error);
  assert.equal(f.calls.filter((item) => item.endsWith(":b")).length, 2);
  assert.equal(f.calls.filter((item) => item === "v1:a").length, 1);
  assert.equal(done.automaticRetryCount, 1);
  assert.equal(done.progress.failed, 1);
  assert.equal(done.result.report.promotable, false);
});

test("新进程式恢复使用检查点的模型选择，只补齐未完成样本；过期候选不调用模型", async (t) => {
  const f = await setup(t), runner = createEvaluationJobRunner(f.options);
  const route = { provider: "saved-provider", model: "saved-model" };
  const job = await withRuntimeCall({ modelRoute: route }, () => runner.create({ scope, ...f }));
  await finish(runner, job.jobId); await runner.stop();
  const path = join(f.directory, `${job.jobId}.json`), checkpoint = JSON.parse(await readFile(path, "utf8"));
  checkpoint.status = "running"; delete checkpoint.caseSamples.b; checkpoint.result = null;
  await writeFile(path, JSON.stringify(checkpoint)); f.calls.length = 0; f.routes.length = 0;
  const restored = createEvaluationJobRunner(f.options);
  await restored.initialize(); await restored.recover();
  const done = await finish(restored, job.jobId); await restored.stop();
  assert.equal(done.progress.completed, 2);
  assert.deepEqual(f.calls, ["v1:b", "v2:b"]);
  assert.ok(f.routes.every((item) => item?.provider === route.provider && item?.model === route.model));
  checkpoint.status = "running"; f.challenger.status = "rejected";
  await writeFile(path, JSON.stringify(checkpoint)); f.calls.length = 0;
  const invalid = createEvaluationJobRunner(f.options);
  await invalid.initialize(); await invalid.recover();
  assert.equal((await finish(invalid, job.jobId)).status, "failed");
  await invalid.stop(); assert.equal(f.calls.length, 0);
});

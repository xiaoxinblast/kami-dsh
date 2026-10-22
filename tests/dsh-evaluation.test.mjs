import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvaluationJobRunner } from "../src/evaluation-jobs.mjs";
import { runtimeOptions, withRuntimeCall } from "../src/runtime-context.mjs";

test("stopping the embedded evaluator drains writes and leaves queued jobs resumable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-evaluator-"));
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const routes = [];
  const notifications = [];
  const runner = createEvaluationJobRunner({
    jobsDirectory: directory,
    benchmark: async () => { throw new Error("unexpected model call"); },
    onChanged: async (job) => { await new Promise((resolve) => setImmediate(resolve)); notifications.push(job.status); },
    deps: {
      getSkill: async (id) => ({ id }),
      getCurrentChampion: async () => { routes.push(runtimeOptions().modelRoute.model); entered(); await gate; return { id: "champion" }; },
      validatePromotionState: () => ({ valid: false, reasons: ["stale pair"] }),
      saveEvaluation: async () => {}, updateSkillMetrics: async () => {}, buildUiReport: () => ({})
    }
  });
  const input = { scope: { locale: "zh-CN", contentType: "ui", domain: "game", project: "isolated" }, champion: { id: "champion" }, challenger: { id: "candidate" }, trajectories: [] };
  try {
    const first = await withRuntimeCall({ modelRoute: { model: "first-model" } }, () => runner.create(input));
    await started;
    const second = await withRuntimeCall({ modelRoute: { model: "second-model" } }, () => runner.create(input));
    const stopping = runner.stop();
    release();
    await stopping;
    assert.deepEqual(routes, ["first-model"]);
    assert.equal(runner.get(first.jobId).status, "failed");
    assert.equal(runner.get(second.jobId).status, "interrupted");
    assert.equal(notifications.at(-1), "interrupted");
    await assert.rejects(runner.resume(second.jobId), /停止/);
  } finally { release(); await runner.stop(); await rm(directory, { recursive: true, force: true }); }
});

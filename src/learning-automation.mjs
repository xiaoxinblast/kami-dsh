import { createHash } from "node:crypto";
import { learningScopeKey, selectSkillHoldout, DEFAULT_MIN_EVALUATION_SAMPLES } from "./learning-engine.mjs";
import { withRuntimeCall } from "./runtime-context.mjs";

/** One serialized workflow per project; durable state lives with its champion. */
export function createLearningAutomation({ deps } = {}) {
  const pending = new Map();
  let stopped = false;

  async function advance(scope, context) {
    let data = await deps.load(scope);
    if (!data.champion) return;
    const previous = data.champion.metadata?.learningAutomation || {};
    const modelRoute = context.modelRoute || previous.modelRoute;
    const state = { ...previous, scope, canContinue: false, ...(modelRoute ? { modelRoute } : {}) };
    const save = async (status, message, extra = {}) => {
      Object.assign(state, extra, { status, message, updatedAt: new Date().toISOString() });
      await deps.save(data.champion, state);
    };
    await withRuntimeCall({ modelRoute, workspaceSnapshot: null }, async () => {
      try {
        let candidate = data.candidates.find((item) => item.parentId === data.champion.id);
        if (!candidate) {
          await save("proposing", "正在检查人工终稿并准备候选", { candidateId: "", missingSamples: 0 });
          const result = await deps.propose(scope);
          data = await deps.load(scope);
          candidate = data.candidates.find((item) => item.parentId === data.champion.id);
          if (!candidate) return save(result.lastError ? "blocked" : "waiting", result.reason || "等待人工终稿");
        }
        state.candidateId = candidate.id;
        const lineage = candidate.metadata?.evaluationRevision;
        const round = lineage?.championId === data.champion.id ? lineage.round : 0;
        state.revisionRound = round;
        const job = data.jobs.filter((item) => item.challengerId === candidate.id && item.championId === data.champion.id).at(-1);
        if (job && ["queued", "running", "interrupted"].includes(job.status)) {
          if (job.status === "interrupted") await deps.resume(job.jobId);
          return save("evaluating", "正在后台评测，完成后自动检查门禁", { jobId: job.jobId, missingSamples: 0 });
        }
        if (job?.status === "failed" || job?.progress?.failed) {
          return save("blocked", job.error || job.result?.report?.conclusion || "评测执行失败，自动重试已结束，请检查失败原因", { jobId: job.jobId });
        }
        if (job?.status === "completed") {
          const report = job.result?.report;
          if (report?.promotable) {
            const gate = await deps.gate(scope, candidate);
            return save(gate.status, gate.message, { jobId: job.jobId, missingSamples: 0 });
          }
          if (report?.status !== "reject") return save("blocked", report?.conclusion || "没有完整评测结果，无法修订候选", { jobId: job.jobId });
          const failures = (report.gates || []).filter((item) => item.passed === false).map((item) => item.label).filter(Boolean);
          const reason = failures.join("、") || report.conclusion || "评测未通过";
          const manual = context.continueJobId === job.jobId;
          if (!manual && state.revisionAttemptJobId === job.jobId) return save("blocked", previous.status === "blocked" ? previous.message : "上次生成修订稿时中断，可手动继续修订", { jobId: job.jobId, canContinue: true });
          if (!manual && round >= 2) return save("blocked", `已自动修订 2 版，最新候选仍未通过：${reason}。可手动继续修订。`, { jobId: job.jobId, canContinue: true });
          await save("revising", `正在分析第 ${candidate.version || 1} 版的退步项，生成第 ${round + 1} 份修订稿：${reason}`, { jobId: job.jobId, revisionAttemptJobId: job.jobId });
          try {
            candidate = await deps.revise(scope, data.champion, candidate, job, round + 1);
          } catch (error) {
            return save("blocked", `候选修订暂停：${error.message}`, { canContinue: true });
          }
          Object.assign(state, { candidateId: candidate.id, revisionRound: round + 1, jobId: "", evaluationFingerprint: "" });
        }
        const samples = selectSkillHoldout(data.trajectories, { scope, candidate, limit: 60 });
        const missingSamples = Math.max(0, DEFAULT_MIN_EVALUATION_SAMPLES - samples.length);
        if (missingSamples) return save("waiting", `还需 ${missingSamples} 条未参与本候选学习的人工终稿，补齐后自动评测`, { sampleCount: samples.length, missingSamples, jobId: "" });
        const fingerprint = createHash("sha256").update(JSON.stringify([candidate.id, data.champion.id, samples.map((item) => [item.id, item.source, item.humanDecision?.finalTranslation || item.finalTranslation])])).digest("hex");
        if (state.evaluationFingerprint === fingerprint && state.jobId) return;
        await save("evaluating", "独立样本已补齐，正在提交评测", { sampleCount: samples.length, missingSamples: 0 });
        const result = await deps.evaluate(candidate, scope);
        await save("evaluating", "正在后台评测，完成后自动检查门禁", { jobId: result.jobId, evaluationFingerprint: fingerprint });
      } catch (error) {
        await save("blocked", `自动学习暂停：${error.message}`);
      }
    });
  }

  return {
    trigger(scope, context = {}) {
      if (stopped) return Promise.resolve();
      const key = learningScopeKey(scope);
      const queued = pending.get(key);
      if (queued) {
        if (context.continueJobId && queued.manualJobId === context.continueJobId) return queued.promise;
        if (context.continueJobId) queued.manualJobId = context.continueJobId;
        Object.assign(queued, { scope, context: { ...queued.context, ...context }, dirty: true });
        return queued.promise;
      }
      const entry = { scope, context: { ...context }, dirty: true, manualJobId: context.continueJobId };
      entry.promise = Promise.resolve().then(async () => {
        while (!stopped && entry.dirty) {
          entry.dirty = false;
          const current = { ...entry.context };
          delete entry.context.continueJobId;
          await advance(entry.scope, current);
        }
      }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
      pending.set(key, entry);
      return entry.promise;
    },
    async stop() {
      stopped = true;
      await Promise.allSettled([...pending.values()].map((entry) => entry.promise));
    }
  };
}

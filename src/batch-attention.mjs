import { isIncompleteBatchStage, isIncompleteBatchQa } from "../public/batch-status.js";
import { translationRetryReason } from "./translation-output.mjs";

// Read either a full run at the end of work or its compact file-list projection.
export function batchAttention(run) {
  const options = run.runnerOptions || {};
  if (options.cancelled || !["needs_attention", "paused", "completed"].includes(run.runState)) return null;
  if (run.runState === "completed" && !options.qaRetryFailed) return null;
  const summary = options.batchSummary || {};
  const segments = run.segments?.filter((segment) => segment.selected !== false && !segment.accepted);
  const failed = segments?.filter(translationRetryReason);
  const unfinished = segments?.filter((s) => s.status !== "done" || !s.translation?.trim()).length ?? Math.max(0, (run.totalSegments || 0) - (run.completedSegments || 0));
  const action = (verb, label, count, reason) => ({ verb, label, count, reason: String(reason || "").slice(0, 220) });
  if ((run.runState === "paused" && !options.qaRetryFailed) || options.translationError) {
    if (!options.interruptionReason && !options.translationError) return null;
    return action("resume", "继续翻译", unfinished, options.interruptionReason || options.translationError);
  }
  const errors = failed?.length ?? run.failedSegments;
  if (errors) return action("retry-translation", "重试失败译段", errors, failed?.length ? translationRetryReason(failed[0]) : options.attentionReason || "翻译失败");
  const proof = segments?.filter((s) => isIncompleteBatchStage(s, "proofreading"));
  const proofCount = proof?.length ?? summary.proofreadIncomplete;
  if (proofCount) return action("retry-proofreading", "重试校对", proofCount, proof?.[0]?.result?.stages?.proofreading?.error || proof?.[0]?.result?.stages?.draftQa?.error || options.attentionReason || "模型校对未完成");
  const qa = segments?.filter(isIncompleteBatchQa);
  const qaCount = qa?.length ?? summary.qaIncomplete;
  if (qaCount && (run.runState === "needs_attention" || options.qaRetryFailed)) return action("retry-qa", "重试未完成 QA", qaCount, qa?.[0]?.result?.stages?.localQa?.error || qa?.[0]?.result?.aiQa?.fallbackReason || options.attentionReason || "质量检查未完成");
  return null;
}

// Workers call this once per stopped attempt, after saving the terminal state.
// Polling and reopening a workbench only read batchAttention().
export function notifyBatchAttention(run, notify, attention = batchAttention(run)) {
  if (attention && notify) {
    Promise.resolve().then(() => notify({ batchId: run.batchId, filename: run.filename, ...attention }))
      .catch((error) => console.warn(`[Kami] Windows 通知未送达：${error.message}`));
  }
}

// 文件列表只有批次摘要。按执行时间忽略上次翻译留下的提示，优先处理前置阶段。
export function pendingFollowupAttention(run) {
  const options = run.runnerOptions || {};
  if (options.cancelled || !["completed", "needs_attention"].includes(run.runState)) return null;
  for (const stage of ["qualityReport", "termSurvey"]) {
    const entry = options.followupAttention?.[stage];
    if (!entry || entry.taskId !== options.workflowTasks?.[stage] || entry.at < (options.translationCompletedAt || "")) continue;
    if (stage === "termSurvey" && options.reviewFinal?.at) continue;
    if (stage === "qualityReport" && /^\d+ 段一致性修订后的 QA 未完成，可批量重试$/u.test(entry.action.reason)
      && options.qaCompletedAt >= entry.at && !options.batchSummary?.qaIncomplete) continue;
    return entry.action;
  }
  return null;
}

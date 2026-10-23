export function isIncompleteBatchQa(segment) {
  return segment.selected !== false && segment.status === "done" && Boolean(String(segment.translation || "").trim())
    && Boolean(segment.result?.aiQa?.fallbackReason);
}

export function summarizeBatchSegments(segments = []) {
  const selected = segments.filter((segment) => segment.selected !== false);
  const done = selected.filter((segment) => segment.status === "done" && String(segment.translation || "").trim());
  const failed = selected.filter((segment) => segment.status === "error").length;
  return {
    total: selected.length, completed: done.length, failed, pending: selected.length - done.length - failed,
    qaIncomplete: done.filter(isIncompleteBatchQa).length,
    qaReason: done.find(isIncompleteBatchQa)?.result?.aiQa?.fallbackReason || "",
    qaChecked: done.filter((segment) => segment.result?.aiQa?.used && !isIncompleteBatchQa(segment)).length,
    ruleOnly: done.filter((segment) => segment.result?.aiQa?.status === "deterministic_only").length
  };
}

export function buildBatchWorkflow(run, { qualityTask = null, termTask = null, qaTask = null, autoConsistencyCheck = true, termSurveyEnabled = true } = {}) {
  const summary = run.segments ? summarizeBatchSegments(run.segments) : run.runnerOptions?.batchSummary || {
    total: Number(run.totalSegments) || 0, completed: Number(run.completedSegments) || 0,
    failed: Number(run.failedSegments) || 0, qaIncomplete: 0
  };
  const running = ["queued", "running"].includes(run.runState);
  const paused = run.runState === "paused";
  const ended = ["completed", "needs_attention"].includes(run.runState);
  const changedAt = Math.max(Date.parse(run.runnerOptions?.translationCompletedAt || "") || 0, Date.parse(run.runnerOptions?.qaCompletedAt || "") || 0);
  const taskStage = (task) => {
    if (!task) return null;
    const warning = task.payload?.warning || "";
    const status = task.status === "in_progress" ? task.progress?.phase === "queued" ? "waiting" : "in_progress"
      : ["failed", "needs_attention", "abandoned"].includes(task.status) || warning ? "needs_attention" : "completed";
    return { status, message: [task.progress?.message, warning].filter(Boolean).join(" · "), percent: task.progress?.percent || 0 };
  };
  const followup = (task, saved, enabled, label) => {
    const latestTask = task && (task.status === "in_progress" || !changedAt || (!task.updatedAt && !task.createdAt)
      || (Date.parse(task.updatedAt || task.createdAt || "") || 0) >= changedAt) ? task : null;
    const stage = taskStage(latestTask);
    if (stage) return stage;
    const fresh = saved && (!changedAt || (Date.parse(saved.generatedAt || "") || 0) >= changedAt);
    if (fresh) return { status: saved.warning ? "needs_attention" : "completed", message: saved.warning || `${label}已生成`, percent: 100 };
    if (!enabled) return { status: "disabled", message: `自动${label}已关闭，可手动运行` };
    if (ended && !summary.completed) return { status: "blocked", message: "没有成功译文，需先重试失败句段" };
    if (paused) return { status: "not_started", message: "批次已暂停或中断，继续翻译后自动执行" };
    if (running || ended) return { status: "waiting", message: `${running ? "等待本轮翻译结束" : "等待启动"}${saved ? `；下方为上次${label}` : ""}` };
    return { status: "not_started", message: "尚未开始，翻译结束后自动执行" };
  };
  const qualityReport = followup(qualityTask, run.qualityReport ? { ...run.qualityReport.report, warning: run.qualityReport.warning } : null, autoConsistencyCheck, "质量报告");
  const termSurvey = followup(termTask, run.runnerOptions?.termSurvey, termSurveyEnabled, "术语普查");
  if (ended && termSurvey.status === "waiting" && ["waiting", "in_progress"].includes(qualityReport.status)) termSurvey.message = "等待质量报告 / 一致性修复结束后开始";
  const translation = {
    finished: ended,
    status: running ? "in_progress" : paused ? "paused" : ended ? summary.failed || summary.pending || run.runnerOptions?.translationError ? "needs_attention" : "completed" : "not_started",
    message: `${running ? "正在翻译" : paused ? "已暂停 / 中断" : ended ? "本轮翻译已结束" : "等待翻译"}：${summary.completed} / ${summary.total} 段${summary.failed ? ` · ${summary.failed} 段失败` : ""}${ended && summary.pending ? ` · ${summary.pending} 段未执行` : ""}${run.runnerOptions?.translationError ? ` · 执行异常：${run.runnerOptions.translationError}` : ""}`
  };
  const reportPending = batchQualityReportPending(run, { qualityReport });
  // 质量报告（含 AI 终审）没跑完之前，这一批不算完成：任务中心/翻译页都显示"正在生成质量报告"，导出也挡着。
  const overall = reportPending
    ? { status: "in_progress", message: `翻译已结束，正在生成质量报告：${qualityReport.message || "处理中"}` }
    : { status: translation.status, message: translation.message };
  return {
    batchId: run.batchId || "",
    summary,
    translation,
    overall,
    aiQa: qaTask?.status === "in_progress" ? taskStage(qaTask) : {
      status: summary.qaIncomplete ? "needs_attention" : summary.completed ? "completed" : "not_started",
      message: summary.qaIncomplete ? `${summary.qaIncomplete} 段 AIQA 未完成，可仅重试 QA${summary.qaReason ? `：${summary.qaReason}` : ""}${qaTask && taskStage(qaTask)?.status === "needs_attention" ? ` · ${taskStage(qaTask).message}` : ""}`
        : `${summary.qaChecked || 0} 段 AIQA 已检查${summary.ruleOnly ? ` · ${summary.ruleOnly} 段使用规则检查` : ""}`
    },
    qualityReport,
    termSurvey: termSurvey
  };
}

/**
 * 这一轮翻译是否还在等质量报告（含 AI 终审）。
 * 老批次没有报告任务、也没有新的 translationCompletedAt，不能因此永远挡住导出。
 */
export function batchQualityReportPending(run, workflow) {
  const stage = workflow?.qualityReport;
  if (!stage) return false;
  if (run?.runState && !["completed", "needs_attention"].includes(run.runState)) return false;
  if (stage.status === "in_progress") return true;
  if (stage.status !== "waiting") return false;
  if (run?.runnerOptions?.workflowTasks?.qualityReport) return true;
  const completedAt = Date.parse(String(run?.runnerOptions?.translationCompletedAt || ""));
  return Number.isFinite(completedAt) && Date.now() - completedAt < 2 * 60_000;
}

export function mergeBatchTaskRows(batches, backgroundTasks) {
  const ids = new Set(batches.map((batch) => batch.batchId));
  const childTypes = new Set(["batch_translation", "batch_qa_retry", "consistency_check", "term_survey"]);
  return [...batches, ...backgroundTasks.filter((task) => !childTypes.has(task.taskType || task.type) || !ids.has(task.payload?.batchId))];
}

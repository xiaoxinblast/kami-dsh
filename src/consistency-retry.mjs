import { isIncompleteBatchQa } from "../public/batch-status.js";

export function retryableConsistencyRepair(item) {
  return item.retryable === true || /^(?:AI )?定向修订失败：|^校验未通过：/u.test(item.reason || "");
}

// 同一处初修失败后，终审可能已成功改稿或决定保留；只留下仍待处理的失败。
export function remainingConsistencySkips(repair) {
  const skipped = repair.skipped || [];
  const resolved = new Set((repair.changed || []).map(item => JSON.stringify([item.findingIndex, item.segmentId])));
  for (const item of skipped) {
    if (item.reason?.startsWith("AI 判断保留：")) for (const id of item.ids || []) resolved.add(JSON.stringify([item.findingIndex, id]));
  }
  return skipped.flatMap(item => {
    if (!retryableConsistencyRepair(item) || !item.ids?.length) return [item];
    const ids = item.ids.filter(id => !resolved.has(JSON.stringify([item.findingIndex, id])));
    return ids.length ? [ids.length === item.ids.length ? item : { ...item, ids }] : [];
  });
}

export function consistencyRetryWork(run) {
  const report = run.qualityReport || {}, repair = report.repair || {};
  const repairItems = remainingConsistencySkips(repair).filter(item => retryableConsistencyRepair(item)
    && item.ids?.length && report.findings?.[item.findingIndex]);
  const changed = new Set((repair.changed || []).map(change => change.segmentId));
  const qaIds = run.segments.filter(segment => changed.has(segment.id) && !segment.accepted && isIncompleteBatchQa(segment)).map(s => s.id);
  const checking = repair.failedChunks || [], verifying = repair.verification?.failedChunks || [];
  return { checking, verifying, repairItems, qaIds, count: checking.length + verifying.length + repairItems.length + qaIds.length };
}

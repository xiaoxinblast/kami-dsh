/**
 * 删除 AI 质检意见。
 *
 * 误报会一直挂在报告里、并持续拉低分数，所以允许本机操作员逐条删除；
 * 删除以指纹定位（不是数组下标），避免意见顺序变化后误删另一条。
 * 远端访客没有删除入口——分享页删除后这里只剩本机校验。
 */

import { createHash } from "node:crypto";
import { calculateAutoQaScores, summarizeIssues } from "./auto-qa.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);

/** 只有本机打开的报告允许删意见。 */
export function canDeleteQaIssues(req) {
  const remote = String(req?.socket?.remoteAddress || "").trim();
  if (remote) return LOOPBACK_HOSTS.has(remote) || remote.startsWith("127.") || remote.startsWith("::ffff:127.");
  const host = String(req?.headers?.host || "").split(":")[0].trim().toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

function text(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/** 指纹只取与"这条意见是什么"有关的字段，和它在数组里的位置无关。 */
export function issueFingerprint(issue = {}, segmentIndex = null) {
  const parts = [
    segmentIndex == null ? "" : String(segmentIndex),
    text(issue.dimension),
    text(issue.severity),
    text(issue.category || issue.type),
    text(issue.message),
    text(issue.sourceSpan),
    text(issue.targetSpan || issue.span)
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** 报告里的意见分两处：逐段 segments[].issues 与文档级 alignmentIssues。 */
export function collectQaIssues(report = {}) {
  const collected = [];
  const segments = Array.isArray(report.segments) ? report.segments : [];
  segments.forEach((segment, index) => {
    const segmentIndex = Number.isInteger(segment?.index) ? segment.index : index;
    for (const issue of Array.isArray(segment?.issues) ? segment.issues : []) {
      collected.push({ segmentIndex, issue, fingerprint: issueFingerprint(issue, segmentIndex) });
    }
  });
  for (const issue of Array.isArray(report.alignmentIssues) ? report.alignmentIssues : []) {
    collected.push({ segmentIndex: null, issue, fingerprint: issueFingerprint(issue, null) });
  }
  return collected;
}

/**
 * 删除一条意见并就地重算评分。返回新的 report 与统计，输入对象不被修改。
 */
export function deleteQaIssue({ report = {}, task = {}, fingerprint = "", at = new Date().toISOString(), actor = "本机" } = {}) {
  const target = String(fingerprint || "");
  if (!target) throw Object.assign(new Error("缺少意见指纹"), { statusCode: 400 });
  if (!collectQaIssues(report).some((entry) => entry.fingerprint === target)) {
    throw Object.assign(new Error("未找到要删除的意见，可能已被删除或报告已更新"), { statusCode: 404 });
  }
  const segments = (Array.isArray(report.segments) ? report.segments : []).map((segment, index) => {
    const segmentIndex = Number.isInteger(segment?.index) ? segment.index : index;
    const issues = Array.isArray(segment?.issues) ? segment.issues : [];
    const kept = issues.filter((issue) => issueFingerprint(issue, segmentIndex) !== target);
    return kept.length === issues.length ? segment : { ...segment, issues: kept };
  });
  const alignmentIssues = (Array.isArray(report.alignmentIssues) ? report.alignmentIssues : [])
    .filter((issue) => issueFingerprint(issue, null) !== target);
  const allIssues = [
    ...segments.flatMap((segment) => (Array.isArray(segment?.issues) ? segment.issues : [])),
    ...alignmentIssues
  ];
  const scores = calculateAutoQaScores(allIssues, { segmentCount: Math.max(1, segments.length), incomplete: Boolean(report.fallbackReason || segments.some((segment) => segment.fallbackReason || segment.aiQaFallbackReason)) });
  const summary = summarizeIssues(allIssues);
  const deletedIssues = Array.isArray(report.deletedIssues) ? [...report.deletedIssues] : [];
  deletedIssues.push({ fingerprint: target, at, actor });
  const nextReport = { ...report, segments, alignmentIssues, scores, summary, deletedIssues };
  return {
    report: nextReport,
    scores,
    summary,
    deletedIssues,
    task: {
      ...task,
      overallScore: scores.overall,
      dimensionScores: scores.dimensions,
      summary,
      report: nextReport
    }
  };
}

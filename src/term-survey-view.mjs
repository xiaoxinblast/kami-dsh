/**
 * 术语普查的界面数据：把"模型建议 / 机器稿实际用的 / 人工终稿 / 术语库现在登记的 / 回填处理结果"
 * 拼成一条条能直接看的记录。
 *
 * 纯函数：批次记录、段落、项目术语库都由调用方取好传进来，便于单测与离线复算。
 * 回填处理结果（review）来自回填时写回的 runnerOptions.termSurvey.review；没回填过就是 null。
 */

import { normalizeSource } from "./text.mjs";

const MAX_SAMPLES = 2;
const MAX_TEXT = 140;

function text(value) {
  return String(value ?? "").trim();
}

function clip(value, limit = MAX_TEXT) {
  const trimmed = text(value).replace(/\s+/gu, " ");
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 归一化包含：源词出现在原文里、建议译法出现在译文里，都用同一口径判断。 */
function contains(haystack, needle) {
  const target = normalizeSource(needle);
  if (!target) return false;
  return normalizeSource(haystack).includes(target);
}

function machineTextOf(segment) {
  // 回填过的段落：当前译文是人工终稿，机器稿基准记在 humanReview.previousTranslation。
  return segment?.accepted === true
    ? text(segment?.result?.humanReview?.previousTranslation)
    : text(segment?.translation);
}

function libraryIndex(termAssets = []) {
  const index = new Map();
  for (const asset of Array.isArray(termAssets) ? termAssets : []) {
    const key = normalizeSource(asset?.source);
    const target = text(asset?.target);
    if (!key || !target) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ target, status: text(asset?.status), source: text(asset?.source) });
  }
  return index;
}

/** 同一个源词可能有多条版本：优先已批准的那条，其次第一条。 */
function pickLibraryEntry(entries = []) {
  if (!entries.length) return null;
  return entries.find((entry) => entry.status === "approved") || entries[0];
}

export function buildTermSurveyView({ survey = null, segments = [], termAssets = [] } = {}) {
  const surveyed = Array.isArray(survey?.terms) ? survey.terms : [];
  const review = survey?.review && typeof survey.review === "object" ? survey.review : null;
  const reviewBySource = new Map();
  for (const item of Array.isArray(review?.terms) ? review.terms : []) {
    const key = normalizeSource(item?.source);
    if (key) reviewBySource.set(key, item);
  }
  const libraries = libraryIndex(termAssets);
  const selectable = (Array.isArray(segments) ? segments : []).filter((segment) => segment?.selected !== false);
  const terms = surveyed.map((item) => {
    const source = text(item?.source);
    const suggestedTarget = text(item?.suggestedTarget);
    const key = normalizeSource(source);
    const matched = selectable.filter((segment) => contains(segment.source, source));
    let adopted = 0;
    let reviewedSegments = 0;
    let humanKept = 0;
    for (const segment of matched) {
      if (contains(machineTextOf(segment), suggestedTarget)) adopted += 1;
      if (segment.accepted === true) {
        reviewedSegments += 1;
        if (contains(segment.translation, suggestedTarget)) humanKept += 1;
      }
    }
    const samples = matched.slice(0, MAX_SAMPLES).map((segment) => ({
      id: String(segment.id || ""),
      machine: clip(machineTextOf(segment)),
      human: segment.accepted === true ? clip(segment.translation) : "",
      machineAdopted: contains(machineTextOf(segment), suggestedTarget)
    }));
    const library = pickLibraryEntry(libraries.get(key) || []);
    const outcome = reviewBySource.get(key) || null;
    return {
      source,
      suggestedTarget,
      markId: text(item.markId),
      initialTarget: text(item.initialTarget || item.suggestedTarget),
      tm: item.tm || null,
      confidence: Number(item?.confidence) || 0,
      reason: clip(item?.reason, 160),
      machine: { matched: matched.length, adopted, samples },
      human: { reviewed: reviewedSegments > 0, segments: reviewedSegments, kept: reviewedSegments ? humanKept : null },
      library: library ? { found: true, target: library.target, status: library.status } : { found: false, target: "", status: "" },
      outcome: outcome
        ? { action: text(outcome.action), target: text(outcome.target), reason: clip(outcome.reason, 160), libraryName: text(review?.stats?.libraryName) }
        : null
    };
  });
  const stats = {
    total: terms.length,
    adopted: terms.filter((item) => item.machine.adopted > 0).length,
    missingInMachine: terms.filter((item) => item.machine.matched > 0 && item.machine.adopted === 0).length,
    unlocated: terms.filter((item) => item.machine.matched === 0).length,
    inLibrary: terms.filter((item) => item.library.found).length,
    reviewed: terms.filter((item) => item.human.reviewed).length,
    autoWritten: terms.filter((item) => item.outcome?.action === "auto_written").length,
    pendingReview: terms.filter((item) => item.outcome?.action === "pending_review").length,
    skipped: terms.filter((item) => item.outcome?.action === "skipped").length
  };
  return {
    version: Number(survey?.version) || 1,
    generatedAt: text(survey?.generatedAt),
    model: text(survey?.model),
    coverage: survey?.coverage || null,
    warning: text(survey?.warning),
    repair: survey?.repair || null,
    review: review ? { at: text(review.at), stats: review.stats || null } : null,
    stats,
    terms
  };
}

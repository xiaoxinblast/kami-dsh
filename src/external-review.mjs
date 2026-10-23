import { normalizeSource } from "./text.mjs";
import { normalizedEditDistance } from "./learning-engine.mjs";

function text(value) {
  return String(value || "").trim();
}

function same(left, right) {
  return Boolean(text(left) && text(right) && normalizeSource(left) === normalizeSource(right));
}

function candidateIdentity(candidate = {}) {
  return {
    entryId: text(candidate.entryId),
    sheet: text(candidate.sheet || candidate.context?.sheet),
    row: Number(candidate.sourceRow || candidate.rowNumber || candidate.context?.row) || 0,
    previousSource: text(candidate.previousSource),
    nextSource: text(candidate.nextSource)
  };
}

function trajectoryIdentity(trajectory = {}) {
  const refs = trajectory.assetRefs && typeof trajectory.assetRefs === "object" ? trajectory.assetRefs : {};
  const neighbor = trajectory.contextPack?.neighborContext || {};
  return {
    entryId: text(refs.entryId),
    sheet: text(refs.sheet || neighbor.sheet),
    row: Number(refs.sourceRow || neighbor.row) || 0,
    previousSource: text(refs.previousSource || neighbor.previous),
    nextSource: text(refs.nextSource || neighbor.next)
  };
}

function identityScore(candidate, trajectory) {
  const left = candidateIdentity(candidate);
  const right = trajectoryIdentity(trajectory);
  if (left.entryId && right.entryId && left.entryId !== right.entryId) return -1;
  let score = 0;
  const reasons = [];
  if (left.entryId && left.entryId === right.entryId) {
    score += 1000;
    reasons.push("entry_id");
  }
  if (left.sheet && right.sheet && left.sheet === right.sheet && left.row && left.row === right.row) {
    score += 300;
    reasons.push("sheet_row");
  } else if (left.row && left.row === right.row) {
    score += 80;
    reasons.push("row");
  }
  if (same(left.previousSource, right.previousSource)) {
    score += 60;
    reasons.push("previous");
  }
  if (same(left.nextSource, right.nextSource)) {
    score += 60;
    reasons.push("next");
  }
  return { score, method: reasons.join("+") || "source_only" };
}

/**
 * 将外部人工审校后的双语条目接回工作台原轨迹。
 *
 * 源文只负责建立候选集合；重复源文必须再由条目 ID、行号或上下文唯一消歧。
 * 返回值只给出确定链接，调用方不得把 ambiguous 当作可接受的自动匹配。
 */
export function linkExternalReviewTrajectories(candidates = [], trajectories = []) {
  const sourceGroups = new Map();
  for (const [index, candidate] of (Array.isArray(candidates) ? candidates : []).entries()) {
    const sourceKey = normalizeSource(candidate?.source);
    if (!sourceKey || !text(candidate?.target)) continue;
    const group = sourceGroups.get(sourceKey) || { candidates: [], trajectories: [] };
    group.candidates.push({ index, candidate });
    sourceGroups.set(sourceKey, group);
  }
  for (const trajectory of Array.isArray(trajectories) ? trajectories : []) {
    const sourceKey = normalizeSource(trajectory?.source);
    if (!sourceKey || !sourceGroups.has(sourceKey) || !text(trajectory?.initialTranslation) || !["completed", "review"].includes(trajectory?.status)) continue;
    sourceGroups.get(sourceKey).trajectories.push(trajectory);
  }

  const links = [];
  const acceptedLinks = [];
  const unmatched = [];
  const ambiguous = [];
  const alreadyAccepted = [];
  for (const group of sourceGroups.values()) {
    if (!group.trajectories.length) {
      unmatched.push(...group.candidates.map(({ index }) => index));
      continue;
    }
    if (group.candidates.length === 1 && group.trajectories.length === 1) {
      const [{ index }] = group.candidates;
      const [trajectory] = group.trajectories;
      if (trajectory.humanDecision?.accepted === true) {
        alreadyAccepted.push(index);
        acceptedLinks.push({ candidateIndex: index, trajectory, method: "unique_source", score: 1 });
      }
      else links.push({ candidateIndex: index, trajectory, method: "unique_source", score: 1 });
      continue;
    }

    const proposals = [];
    for (const { index, candidate } of group.candidates) {
      const ranked = group.trajectories.map((trajectory) => ({ trajectory, ...identityScore(candidate, trajectory) }))
        .filter((item) => item.score >= 0)
        .sort((left, right) => right.score - left.score);
      if (!ranked.length || ranked[0].score <= 0 || ranked[1]?.score === ranked[0].score) {
        ambiguous.push(index);
        continue;
      }
      proposals.push({ candidateIndex: index, ...ranked[0] });
    }
    proposals.sort((left, right) => right.score - left.score);
    const claimed = new Set();
    for (const proposal of proposals) {
      if (claimed.has(proposal.trajectory.id)) {
        ambiguous.push(proposal.candidateIndex);
        continue;
      }
      claimed.add(proposal.trajectory.id);
      if (proposal.trajectory.humanDecision?.accepted === true) {
        alreadyAccepted.push(proposal.candidateIndex);
        acceptedLinks.push(proposal);
      }
      else links.push(proposal);
    }
  }
  return {
    links,
    // 已经人工采纳过的轨迹：不算新链接（不重复记事件），但调用方仍要能定位它们，
    // 才能在再次回填终稿有变化时更新学习语料，而不是只更新 TM。
    acceptedLinks,
    unmatched: [...new Set(unmatched)],
    ambiguous: [...new Set(ambiguous)],
    alreadyAccepted: [...new Set(alreadyAccepted)]
  };
}

/**
 * 把"审校回填"文件里的双语条目定位到同一条批次的段落。
 *
 * 定位顺序（越稳的越先）：
 *   1. memoQ 条目 ID（x-mmq-context，导出→审校→导入全程保留）；
 *   2. 段落 unit id（同一文件内稳定）；
 *   3. 原文唯一匹配；同一原文在批次里出现多次且没有 ID 可依据时算"有歧义"，不猜。
 *
 * 返回 { matches, unmatched, ambiguous, unchanged }：
 *   matches 里带 pairIndex/segmentIndex/method，调用方据此覆盖译文；
 *   unchanged 表示这条译文和回填前一样（仍然算匹配，只是内容没变化）。
 */
export function matchReviewPairsToSegments(segments = [], pairs = []) {
  const list = Array.isArray(segments) ? segments : [];
  const byEntryKey = new Map();
  const byEntryId = new Map();
  const bySource = new Map();
  list.forEach((segment, index) => {
    const entryKey = text(segment?.entryKey || segment?.locator?.entryKey);
    if (entryKey) byEntryKey.set(entryKey, [...(byEntryKey.get(entryKey) || []), index]);
    const entryId = text(segment?.locator?.unitId || segment?.locator?.entryId || segment?.context?.entryId);
    if (entryId) byEntryId.set(entryId, [...(byEntryId.get(entryId) || []), index]);
    const sourceKey = normalizeSource(segment?.source);
    if (sourceKey) bySource.set(sourceKey, [...(bySource.get(sourceKey) || []), index]);
  });

  const matches = [];
  const unmatched = [];
  const ambiguous = [];
  const proposed = [];
  (Array.isArray(pairs) ? pairs : []).forEach((pair, pairIndex) => {
    const source = text(pair?.source);
    const target = text(pair?.target);
    if (!source || !target) return;
    const entryKey = text(pair?.entryKey);
    const entryId = text(pair?.entryId);
    const sourceKey = normalizeSource(source);

    let candidates = [];
    let method = "";
    if (entryKey && byEntryKey.has(entryKey)) {
      candidates = byEntryKey.get(entryKey);
      method = "entry_key";
    } else if (entryId && byEntryId.has(entryId)) {
      candidates = byEntryId.get(entryId);
      method = "entry_id";
    } else {
      candidates = bySource.get(sourceKey) || [];
      method = "unique_source";
    }
    const matching = candidates.filter((index) => normalizeSource(list[index]?.source) === sourceKey);
    if (!matching.length) {
      unmatched.push({ pairIndex, source, reason: candidates.length ? "条目 ID 命中但原文不同，请检查终稿与原批次" : "该原文不在这个批次里" });
      return;
    }
    if (matching.length > 1) {
      ambiguous.push({ pairIndex, source, reason: `同一条原文在这个批次里出现 ${matching.length} 次，缺少唯一条目身份` });
      return;
    }
    const [index] = matching;
    const previous = text(list[index]?.translation);
    proposed.push({ pairIndex, segmentIndex: index, method, previousTranslation: previous, changed: previous !== target });
  });
  const claims = new Map();
  for (const match of proposed) claims.set(match.segmentIndex, (claims.get(match.segmentIndex) || 0) + 1);
  for (const match of proposed) {
    if (claims.get(match.segmentIndex) > 1) {
      ambiguous.push({ pairIndex: match.pairIndex, source: text(pairs[match.pairIndex]?.source), reason: "终稿中多条记录指向同一译段，请检查重复条目" });
    } else matches.push(match);
  }
  const unchanged = matches.filter((match) => !match.changed).map((match) => match.pairIndex);
  return { matches, unmatched, ambiguous, unchanged };
}

export function externalReviewTrajectoryPatch({ trajectory, target, sourceFile = "", sourceRow = null, matchMethod = "" } = {}) {
  const finalTranslation = text(target);
  const previousDecision = trajectory?.humanDecision && typeof trajectory.humanDecision === "object" ? trajectory.humanDecision : {};
  // 机器稿基准：首次回填时人工改的是当时的 finalTranslation（机器终稿）；再次回填时
  // finalTranslation 已经变成上一版人工终稿，必须沿用首次记下的基准，否则"编辑距离"
  // 会从"机器稿 → 人工终稿"悄悄变成"两版人工终稿之差"，归因结论跟着漂。
  const machineTranslation = text(previousDecision.machineTranslation)
    || text(trajectory?.finalTranslation || trajectory?.initialTranslation);
  const previousFinalTranslation = previousDecision.accepted === true ? text(previousDecision.finalTranslation) : "";
  if (!trajectory?.id || !finalTranslation || !machineTranslation) throw new Error("外部审校轨迹缺少机器稿或人工终稿");
  const decidedAt = new Date().toISOString();
  const humanDecision = {
    accepted: true,
    finalTranslation,
    machineTranslation,
    editDistance: normalizedEditDistance(machineTranslation, finalTranslation),
    decidedAt,
    source: "external-review-import",
    sourceFile: text(sourceFile),
    sourceRow: Number(sourceRow) || null,
    matchMethod: text(matchMethod),
    ...(previousFinalTranslation ? { previousFinalTranslation } : {})
  };
  return {
    finalTranslation,
    humanDecision,
    status: "completed",
    events: [...(Array.isArray(trajectory.events) ? trajectory.events : []), {
      type: "external_human_review_imported",
      at: decidedAt,
      sourceFile: humanDecision.sourceFile,
      sourceRow: humanDecision.sourceRow,
      editDistance: humanDecision.editDistance,
      matchMethod: humanDecision.matchMethod,
      ...(previousFinalTranslation ? { previousFinalTranslation } : {})
    }]
  };
}

/**
 * 一致性修复裁决：模型只负责指出漂移、给出候选写法与一套"打算怎么统一"的方案，
 * 统一成哪个写法由这里按证据定案——术语库批准术语 > 主 TM / 参考 TM 的人工译例 >
 * 本文件内多数（≥2:1）。没有任何依据时只报告，不猜。
 *
 * 两条路径：
 *   ① 短语级（finding.terms 给了原词）：按原词查术语库/TM，替换命中段落里的其它写法；
 *   ② 整句级（规则发现的"同原文不同译文"）：按整句原文查 TM，或按文件内多数定案。
 * 纯函数：不读 store、不调模型，证据由调用方收集好传进来，便于单测与离线复算。
 */

import { digitSequence, extractProtectedTokens, normalizeSource } from "./text.mjs";

/** 依据的界面标签：报告与任务中心都用这份，避免两处各写一套中文。 */
export const REPAIR_EVIDENCE_LABELS = Object.freeze({
  term: "术语库",
  tm_master: "主 TM 人工条",
  tm_reference: "参考 TM 人工条",
  file_majority: "文件内多数",
  paired_scheme: "配对方案",
  ai_judgement: "AI 终审"
});

export const REPAIR_SKIP_REASONS = Object.freeze({
  human_reviewed: "这批段落已经有人工回填，只报告不改稿",
  report_only: "术语允许按语境判断，只报告不自动统一",
  no_evidence: "依据不足（库里没有登记译法，文件里也没有多数写法）",
  conflict: "证据互相冲突（同一原文有多个权威译法）",
  limit: "超出单批自动统一上限",
  unsafe: "改法不安全（保护标记或长度变化过大）",
  no_variant: "没找到可替换的写法，留给人工处理"
});

const MAX_TEXT = 200;
const MAX_CLIP = 400;
const MAX_VARIANTS = 6;

function text(value) {
  return String(value ?? "").trim();
}

function clip(value, limit = MAX_TEXT) {
  const trimmed = text(value).replace(/\s+/gu, " ");
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 候选写法去重（按归一化），保留原始写法用于替换。 */
function normalizeVariants(values = []) {
  const seen = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const variant = text(value);
    if (!variant) continue;
    const key = normalizeSource(variant);
    if (!key || seen.has(key)) continue;
    seen.set(key, variant);
    if (seen.size >= MAX_VARIANTS) break;
  }
  return [...seen.values()];
}

function uniqueTargets(entries = []) {
  const seen = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const target = text(entry?.target);
    if (!target) continue;
    const key = normalizeSource(target);
    if (!key || seen.has(key)) continue;
    seen.set(key, { target, source: text(entry?.source) });
  }
  return [...seen.values()];
}

/**
 * 段落 → 同一原文的译法分布。分组用 normalizeSource（大小写/全半角统一），
 * 但保留原始写法用于替换与展示。
 */
export function summarizeSourceGroups(segments = []) {
  const groups = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || segment.selected === false) continue;
    const translation = text(segment.translation);
    if (!translation) continue;
    const key = normalizeSource(segment.source);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { key, source: text(segment.source), variants: new Map(), segmentIds: [], humanReviewed: 0 });
    }
    const group = groups.get(key);
    const variantKey = normalizeSource(translation);
    if (!group.variants.has(variantKey)) group.variants.set(variantKey, { target: translation, count: 0, ids: [] });
    const variant = group.variants.get(variantKey);
    variant.count += 1;
    variant.ids.push(String(segment.id || ""));
    group.segmentIds.push(String(segment.id || ""));
    if (segment.accepted === true) group.humanReviewed += 1;
  }
  return groups;
}

/** 多数判定：至少 2 条，且领先第二名一倍以上，否则算"没有多数"。 */
export function pickMajority(counts = []) {
  const list = (Array.isArray(counts) ? counts : [])
    .filter((item) => item && text(item.target) && Number(item.count) > 0)
    .sort((left, right) => Number(right.count) - Number(left.count));
  if (list.length < 2) return null;
  const [first, second] = list;
  if (Number(first.count) < 2) return null;
  if (Number(first.count) < Number(second.count) * 2) return null;
  return { target: text(first.target), count: Number(first.count), runnerUp: Number(second.count), total: list.reduce((sum, item) => sum + Number(item.count), 0) };
}

/**
 * 权威译法：术语库批准术语 > 主 TM 人工条 > 参考 TM 人工条。
 * 同一档里出现多个不同译法时判冲突，返回 null（宁可只报告也不猜）。
 */
export function resolveAuthorityTarget({ termTargets = [], tmEntries = [] } = {}) {
  const terms = uniqueTargets(termTargets);
  if (terms.length > 1) return null;
  if (terms.length === 1) {
    return {
      target: terms[0].target,
      evidence: { kind: "term", ref: `${clip(terms[0].source, 60)} → ${clip(terms[0].target, 60)}` }
    };
  }
  const human = (Array.isArray(tmEntries) ? tmEntries : []).filter((entry) => text(entry?.qualityStatus) === "human_approved");
  for (const [role, kind] of [["master", "tm_master"], ["reference", "tm_reference"]]) {
    const scoped = human.filter((entry) => text(entry?.libraryRole) === role);
    const targets = uniqueTargets(scoped);
    if (targets.length > 1) return null;
    if (targets.length === 1) {
      return {
        target: targets[0].target,
        evidence: { kind, ref: `${clip(targets[0].source, 60)} → ${clip(targets[0].target, 60)}` }
      };
    }
  }
  return null;
}

/** 模型给的方案：source → target 列表，转成按归一化原文索引的表。 */
function schemeFromFinding(finding = {}) {
  const scheme = new Map();
  for (const item of Array.isArray(finding?.unify) ? finding.unify : []) {
    const key = normalizeSource(item?.source);
    const target = text(item?.target);
    if (!key || !target) continue;
    scheme.set(key, target);
  }
  return scheme;
}

function citedSegments(finding = {}, segments = []) {
  const byId = new Map((Array.isArray(segments) ? segments : []).map((segment) => [String(segment.id || ""), segment]));
  const list = [];
  for (const id of new Set((Array.isArray(finding?.ids) ? finding.ids : []).map(String))) {
    const segment = byId.get(id);
    if (segment) list.push(segment);
  }
  return list;
}

/** 一个原词的候选写法在该 finding 的段落里各出现多少次（整句级用得到）。 */
function countVariantSegments(segments = [], variants = []) {
  return variants.map((variant) => ({
    target: variant,
    count: segments.filter((segment) => text(segment.translation).includes(variant)).length
  }));
}

/** 整句级路径：按 finding 点到的原文分组，组内写法分布 + 原文级 TM 证据。 */
function groupScopes(finding = {}, segments = [], groups = new Map()) {
  const scopes = [];
  const seen = new Set();
  for (const segment of citedSegments(finding, segments)) {
    const key = normalizeSource(segment.source);
    const group = groups.get(key);
    if (!key || !group || seen.has(key)) continue;
    seen.add(key);
    scopes.push({ source: group.source, variants: [...group.variants.values()].map((variant) => variant.target) });
  }
  return scopes;
}

function applyPairingRule(scopes, decisions, scheme) {
  if (scopes.length !== 2 || scheme.size !== 2) return;
  const decided = scopes.filter((scope) => decisions.has(normalizeSource(scope.source)));
  const pending = scopes.filter((scope) => !decisions.has(normalizeSource(scope.source)));
  if (decided.length !== 1 || pending.length !== 1) return;
  const anchor = decided[0];
  const partner = pending[0];
  const anchorDecision = decisions.get(normalizeSource(anchor.source));
  const paired = partner.variants.length === 2 ? partner.variants : [];
  if (!paired.length) return;
  const schemeAnchor = scheme.get(normalizeSource(anchor.source));
  const schemePartner = scheme.get(normalizeSource(partner.source));
  const anchorMatchesScheme = schemeAnchor && normalizeSource(schemeAnchor) === normalizeSource(anchorDecision.target);
  const candidate = anchorMatchesScheme
    ? schemePartner
    : paired.find((value) => normalizeSource(value) !== normalizeSource(schemePartner));
  if (!candidate || !paired.some((value) => normalizeSource(value) === normalizeSource(candidate))) return;
  decisions.set(normalizeSource(partner.source), {
    source: partner.source,
    variants: partner.variants,
    target: candidate,
    evidence: { kind: "paired_scheme", ref: `与「${clip(anchorDecision.target, 40)}」配对的写法` }
  });
}

/**
 * 一条 finding 的统一方案。termTargetsFor / tmEntriesFor 由调用方按原文查好，
 * 返回 targets（已定案）与 unresolved（依据不足，只报告）。
 */
export function resolveFindingTargets(finding = {}, { segments = [], groups = new Map(), termTargetsFor = () => [], tmEntriesFor = () => [] } = {}) {
  const cited = citedSegments(finding, segments);
  const modelTerms = (Array.isArray(finding?.terms) ? finding.terms : [])
    .map((item) => ({ source: text(item?.source), variants: normalizeVariants(item?.variants) }))
    .filter((item) => item.source);
  // 模型给了原词就按原词定案（同一个词的两种写法可能出现在不同原文里）；否则按整句原文分组。
  const scopes = modelTerms.length ? modelTerms : groupScopes(finding, segments, groups);
  const scheme = schemeFromFinding(finding);
  const decisions = new Map();
  const unresolved = [];
  for (const scope of scopes) {
    const key = normalizeSource(scope.source);
    if (!key) continue;
    const exactTermTargets = modelTerms.length
      ? termTargetsFor(scope.source)
      // 整句级：只有"原文本身就是这个术语"时登记译法才能当整句译文，否则会把半句目标译法塞进整句。
      : termTargetsFor(scope.source).filter((target) => normalizeSource(target.source) === key);
    const authority = resolveAuthorityTarget({ termTargets: exactTermTargets, tmEntries: tmEntriesFor(scope.source) });
    // 术语库是在整句里命中某个词时，它的目标译法只是译文的一部分——
    // 只有"原文本身就是该术语"或"目标译法本来就是候选写法之一"才敢直接拿来替换。
    const termMatchExactSource = exactTermTargets.some((item) => normalizeSource(item.source) === key);
    const usableAuthority = authority && (authority.evidence.kind !== "term"
      || termMatchExactSource
      || scope.variants.some((variant) => normalizeSource(variant) === normalizeSource(authority.target)))
      ? authority
      : null;
    const majority = pickMajority(countVariantSegments(cited, scope.variants));
    if (usableAuthority) {
      decisions.set(key, { source: scope.source, variants: scope.variants, target: usableAuthority.target, evidence: usableAuthority.evidence });
    } else if (majority) {
      decisions.set(key, {
        source: scope.source,
        variants: scope.variants,
        target: majority.target,
        evidence: { kind: "file_majority", ref: `${majority.count} / ${majority.total} 条已经用这个写法` }
      });
    } else {
      unresolved.push({ key, source: scope.source, reason: scope.variants.length < 2 ? "已经统一" : REPAIR_SKIP_REASONS.no_evidence });
    }
  }
  // 配对方案：两个原词各有两种写法、其中一套含权威值时，整组一起统一。
  applyPairingRule(scopes, decisions, scheme);
  const targets = [...decisions.values()].map((decision) => {
    const schemeTarget = scheme.get(normalizeSource(decision.source));
    return {
      source: decision.source,
      variants: decision.variants,
      target: decision.target,
      evidence: decision.evidence,
      overrodeModel: Boolean(schemeTarget && normalizeSource(schemeTarget) !== normalizeSource(decision.target))
    };
  });
  return {
    targets,
    unresolved: unresolved.filter((item) => !decisions.has(item.key))
  };
}

/**
 * 确定性替换：只有能证明"替换特定写法不会破坏别的东西"时才返回 ok。
 * 返回 ok=false 的段落交给定向修订，仍然不行就留给人工。
 */
export function applyDeterministicReplacement({ translation = "", from = "", to = "", protectedTokens = [] } = {}) {
  const before = String(translation ?? "");
  const variant = text(from);
  const target = text(to);
  if (!before || !variant || !target) return { ok: false, reason: "缺少待替换写法或统一译法" };
  if (normalizeSource(variant) === normalizeSource(target)) return { ok: false, reason: "两个写法本来就相同" };
  if (!before.includes(variant)) return { ok: false, reason: REPAIR_SKIP_REASONS.no_variant };
  const after = before.split(variant).join(target);
  if (after === before) return { ok: false, reason: REPAIR_SKIP_REASONS.no_variant };
  const kept = (Array.isArray(protectedTokens) ? protectedTokens : []).filter((token) => before.includes(token));
  if (kept.some((token) => !after.includes(token))) return { ok: false, reason: REPAIR_SKIP_REASONS.unsafe };
  if (digitSequence(before) !== digitSequence(after)) return { ok: false, reason: REPAIR_SKIP_REASONS.unsafe };
  if (Math.abs(after.length - before.length) > Math.max(6, Math.floor(before.length * 0.3))) {
    return { ok: false, reason: REPAIR_SKIP_REASONS.unsafe };
  }
  if (!before.includes(variant + variant) && after.includes(target + target)) {
    return { ok: false, reason: REPAIR_SKIP_REASONS.unsafe };
  }
  return { ok: true, value: after };
}

/**
 * 修复计划：按 finding 逐条定案，产出"哪些段落改成什么、哪些只报告"。
 * 不改文案本身，改由调用方执行（并保留校验与回退的机会）。
 */
export function planConsistencyRepairs({
  findings = [],
  segments = [],
  groups = summarizeSourceGroups(segments),
  termTargetsFor = () => [],
  tmEntriesFor = () => [],
  maxSegments = 20,
  hasHumanReview = false
} = {}) {
  const limit = Number.isFinite(Number(maxSegments)) ? Math.max(0, Math.trunc(Number(maxSegments))) : 20;
  if (hasHumanReview) {
    return { blocked: { reason: REPAIR_SKIP_REASONS.human_reviewed }, actions: [], skipped: [], changedSegmentIds: [] };
  }
  const actions = [];
  const skipped = [];
  // 一次核对里同一段落只按一条结论统一（先到先得）。同一段同时命中两条不同结论时，
  // 剩下的那条由复核再报出来，而不是在这里互相覆盖。
  const assigned = new Map();
  for (const [index, finding] of (Array.isArray(findings) ? findings : []).entries()) {
    if (finding?.source === "rule" && finding?.type === "term_usage_gap") {
      skipped.push({ findingIndex: index, type: finding.type, ids: (finding.ids || []).map(String), reason: REPAIR_SKIP_REASONS.report_only });
      continue;
    }
    const { targets, unresolved } = resolveFindingTargets(finding, { segments, groups, termTargetsFor, tmEntriesFor });
    if (!targets.length) {
      skipped.push({
        findingIndex: index,
        type: finding.type,
        ids: (finding.ids || []).map(String),
        reason: unresolved[0]?.reason || REPAIR_SKIP_REASONS.no_evidence
      });
      continue;
    }
    const cited = citedSegments(finding, segments);
    const pending = new Map();
    const skippedIds = [];
    for (const decision of targets) {
      const discarded = (decision.variants || []).filter((variant) => normalizeSource(variant) !== normalizeSource(decision.target));
      for (const segment of cited) {
        const id = String(segment.id || "");
        if (segment.accepted === true) continue;
        if (assigned.has(id)) continue;
        const translation = String(segment.translation || "");
        const variant = discarded.find((value) => translation.includes(value));
        if (!variant) continue;
        if (limit && assigned.size >= limit) {
          skippedIds.push({ id, reason: REPAIR_SKIP_REASONS.limit });
          continue;
        }
        const replaced = applyDeterministicReplacement({
          translation,
          from: variant,
          to: decision.target,
          protectedTokens: extractProtectedTokens(segment.source)
        });
        assigned.set(id, decision.target);
        pending.set(id, {
          segmentId: id,
          before: String(segment.translation || ""),
          after: replaced.ok ? replaced.value : "",
          method: replaced.ok ? "replace" : "revise",
          reason: replaced.ok ? "" : replaced.reason,
          source: decision.source,
          target: decision.target,
          evidence: decision.evidence || null,
          overrodeModel: decision.overrodeModel === true
        });
      }
    }
    const changes = [...pending.values()];
    if (!changes.length) {
      skipped.push({
        findingIndex: index,
        type: finding.type,
        ids: (finding.ids || []).map(String),
        reason: skippedIds.length ? REPAIR_SKIP_REASONS.limit : (unresolved[0]?.reason || REPAIR_SKIP_REASONS.no_variant)
      });
      continue;
    }
    const primary = targets[0];
    actions.push({
      findingIndex: index,
      type: finding?.type || "",
      detail: clip(finding?.detail, MAX_CLIP),
      source: primary.source,
      target: primary.target,
      evidence: primary.evidence,
      overrodeModel: targets.some((target) => target.overrodeModel),
      targets,
      changes,
      skippedIds,
      overflow: skippedIds.length > 0
    });
  }
  const changedSegmentIds = actions.flatMap((action) => action.changes.map((change) => change.segmentId));
  return { blocked: null, actions, skipped, changedSegmentIds };
}

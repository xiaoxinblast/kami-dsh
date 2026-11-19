import { EVALUATION_POLICY_VERSION } from "./evaluation-policy.mjs";
/**
 * Shared challenger proposal used by both the manual "生成候选技能" button and
 * the automatic proposer. Keeps the two paths on identical logic: trajectory
 * selection, model proposal, patch merge and persistence.
 */

import { collectTrainingEvidenceIds, learningSourceKey, mergeTranslationSkillPatch } from "./learning-engine.mjs";
import { getProviderConfig, proposeSkillPatchFromGateReview, proposeTranslationSkillWithModel } from "./provider.mjs";
import { getTranslationSkill, listTranslationSkills, saveTranslationSkill } from "./store.mjs";
import { sanitizeStrategyPatch } from "./strategy-patch.mjs";
import { isDeepStrictEqual } from "node:util";

/**
 * 能作为候选技能依据的轨迹：**必须是人工采纳过的终稿**。
 *
 * 机器稿（批次刚翻完、还没回填审校）虽然也算"完成轨迹"，但它没经过人工校对，
 * 拿它当改进依据等于把还没确认的写法学进策略；评测留出集本来就只认人工终稿
 * （selectSkillHoldout），这里与它保持一致。人工采纳会重写 date_updated，
 * 所以回填过的轨迹天然排在前面。
 */
export function selectProposalTrajectories(trajectories = [], limit = 40, reserveHoldout = true) {
  const seen = new Set();
  const usable = trajectories
    .filter((item) => ["completed", "review"].includes(item.status)
      && item.humanDecision?.accepted === true
      && String(item.humanDecision?.finalTranslation || item.finalTranslation || "").trim())
    .filter((item) => {
      const key = learningSourceKey(item.source) || `id:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // 优先留下 20 条独立评测材料；少量人工终稿仍可手动生成候选，后续补齐评测。
  return usable.slice(0, reserveHoldout ? Math.min(limit, Math.max(Math.min(10, usable.length), usable.length - 20)) : limit);
}

// Keep the rule order stable. A revision can insert, remove or replace one rule.
function isSingleRuleChange(before, after) {
  if (!Array.isArray(after) || Math.abs(before.length - after.length) > 1) return false;
  if (before.length === after.length) return before.filter((rule, index) => rule !== after[index]).length === 1;
  const [longer, shorter] = before.length > after.length ? [before, after] : [after, before];
  const offset = shorter.findIndex((rule, index) => rule !== longer[index]);
  return offset < 0 || shorter.slice(offset).every((rule, index) => rule === longer[offset + index + 1]);
}

/**
 * Propose and persist a challenger for one exact scope. Throws the same 409 as
 * the manual endpoint when no usable trajectory exists.
 */
export async function proposeChallengerSkill({ scope, champion, trajectories = [], revision, loadSelected, resolveLayouts, promptVersion = "kami-translation-v1" }) {
  const previous = revision?.candidate;
  const historicalIds = new Set(previous?.evidenceIds || []);
  const training = previous ? trajectories.filter((item) => historicalIds.has(item.id)) : trajectories;
  const selected = selectProposalTrajectories(training, 40, !previous);
  const usable = loadSelected ? await loadSelected(selected) : selected;
  if (!usable.length) {
    const error = new Error("当前范围还没有人工采纳的终稿：先回填审校结果或在质检里人工采纳，机器稿不能作为生成候选技能的依据");
    error.statusCode = 409;
    throw error;
  }
  const trainingEvidenceIds = previous ? previous.evidenceIds || [] : collectTrainingEvidenceIds(usable);
  const trainingSources = previous
    ? [...new Set([...(previous.metadata?.trainingSources || []), ...training.map((item) => item.source).filter(Boolean)])]
    : usable.map((item) => item.source).filter(Boolean);
  const evaluationFeedback = previous && {
    failedVersion: previous.version, failedStrategy: previous.strategy,
    ...(revision.report.structure ? { structureByRound: revision.report.structure } : {}),
    failedGates: (revision.report.gates || []).filter((gate) => gate.passed === false).map(({ id, label, detail }) => ({ id, label, detail })),
    // Older line-count metrics used strict source parity. Only the recomputed summary can diagnose those samples.
    metrics: (revision.report.metrics || []).filter(metric => revision.report.reproducibility?.policyVersion === EVALUATION_POLICY_VERSION || !["firstLineBreakErrors", "finalLineBreakErrors"].includes(metric.key)).map(({ key, champion, candidate, delta }) => ({ key, champion, candidate, delta }))
  };
  const layouts = resolveLayouts ? await resolveLayouts(scope, usable) : {};
  const examples = usable.map(item => layouts[item.id] ? { ...item, lineLayout: layouts[item.id] } : item);
  const proposed = await proposeTranslationSkillWithModel({ ...scope, champion: { id: champion.id, name: champion.name, version: champion.version, strategy: champion.strategy }, trajectories: examples, evaluationFeedback });
  // 模型返回的策略补丁是不可信输入：白名单校验、数值夹紧、长度截断与注入特征拦截。
  const sanitized = sanitizeStrategyPatch(proposed.strategyPatch);
  if (!Object.keys(sanitized.patch).length) {
    const error = new Error("模型返回的策略补丁未通过白名单校验，已拒绝生成候选");
    error.statusCode = 409;
    throw error;
  }
  if (previous) {
    const rules = sanitized.patch.prompting?.additionalRules;
    const existing = champion.strategy?.prompting?.additionalRules || champion.strategy?.additionalRules || [];
    if (sanitized.warnings.length || Object.keys(sanitized.patch).length !== 1 || Object.keys(sanitized.patch.prompting || {}).length !== 1
      || !isSingleRuleChange(existing, rules) || new Set(rules).size !== rules.length) {
      throw new Error("策略修订须基于生效版本，只增删或修改一条规则，并保留其他规则的顺序");
    }
  }
  const engineChampion = {
    id: champion.id,
    version: champion.version,
    status: champion.status,
    scope,
    name: champion.name,
    description: champion.description,
    strategy: champion.strategy || {},
    metadata: previous ? {} : champion.metadata || {}
  };
  const sanitizationMetadata = sanitized.warnings.length
    ? { sanitization: { warnings: sanitized.warnings, sanitizedAt: new Date().toISOString() } }
    : {};
  const lineage = previous?.metadata?.evaluationRevision;
  const lastRevision = lineage?.championId === champion.id ? lineage : null;
  const evaluationRevision = previous && {
    championId: champion.id,
    previousId: previous.id,
    previousVersion: previous.version,
    jobId: revision.jobId,
    round: revision.round,
    excludedCaseIds: [...new Set([...(lastRevision?.excludedCaseIds || []), ...revision.holdout.map(item => item.id)])],
    excludedSources: [...new Set([...(lastRevision?.excludedSources || []), ...revision.holdout.map(item => item.source)])]
  };
  const merged = mergeTranslationSkillPatch(engineChampion, {
    name: proposed.name,
    description: proposed.reason,
    changeReason: proposed.reason,
    strategy: sanitized.patch,
    metadata: { generatedBy: getProviderConfig().model, trainingSources, ...(evaluationRevision ? { evaluationRevision } : {}), ...sanitizationMetadata }
  });
  if (previous) {
    if (isDeepStrictEqual(merged.strategy, previous.strategy)) throw new Error("修订稿与失败候选的策略相同，已跳过重复评测");
    const [currentChampion, siblings] = await Promise.all([getTranslationSkill(champion.id), listTranslationSkills({ ...scope, limit: 500 })]);
    const currentCandidate = siblings.find(item => item.parentId === champion.id && ["draft", "challenger"].includes(item.status));
    if (siblings.some(item => item.metadata?.evaluationRevision?.championId === champion.id && isDeepStrictEqual(merged.strategy, item.strategy))) {
      throw new Error("这份修订策略已经生成过，已跳过重复评测");
    }
    if (currentChampion?.status !== "champion" || currentCandidate?.id !== previous.id) throw new Error("生效版本或候选已更换，请查看当前学习进度");
  }
  return saveTranslationSkill({
    ...scope,
    name: merged.name,
    description: merged.description,
    changeReason: merged.changeReason,
    version: merged.version,
    parentId: champion.id,
    status: "challenger",
    strategy: merged.strategy,
    metadata: merged.metadata,
    // Every trajectory sent to the proposal model is training evidence. Keep
    // the complete set so none of it can later leak into the holdout pool.
    evidenceIds: trainingEvidenceIds,
    promptVersion,
    metrics: {}
  });
}

/**
 * 门禁失败复盘驱动的候选技能：输入是复盘报告 + 失败案例（含人工终稿），
 * 输出走与轨迹提炼**完全相同**的净化、合并与落库路径，只是证据换成了失败案例。
 *
 * 证据口径：喂给模型的失败案例对应哪些轨迹，就登记哪些轨迹 id，
 * 这样它们之后同样不会回流进留出集。
 */
export async function proposeChallengerFromGateReview({ scope, champion, review = {}, cases = [], evidenceIds = [], runId = "", promptVersion = "kami-translation-v1" }) {
  if (!Array.isArray(cases) || !cases.length) {
    const error = new Error("这次门禁没有失败样本，没有可用于改写的依据");
    error.statusCode = 409;
    throw error;
  }
  const proposed = await proposeSkillPatchFromGateReview({
    ...scope,
    champion,
    review,
    cases
  });
  // 模型返回的策略补丁是不可信输入：白名单校验、数值夹紧、长度截断与注入特征拦截。
  const sanitized = sanitizeStrategyPatch(proposed.strategyPatch);
  if (!Object.keys(sanitized.patch).length) {
    const error = new Error("模型返回的策略补丁未通过白名单校验，已拒绝生成候选");
    error.statusCode = 409;
    throw error;
  }
  const engineChampion = {
    id: champion.id,
    version: champion.version,
    status: champion.status,
    scope,
    name: champion.name,
    description: champion.description,
    strategy: champion.strategy || {},
    metadata: champion.metadata || {}
  };
  const sanitizationMetadata = sanitized.warnings.length
    ? { sanitization: { warnings: sanitized.warnings, sanitizedAt: new Date().toISOString() } }
    : {};
  const merged = mergeTranslationSkillPatch(engineChampion, {
    name: proposed.name,
    description: proposed.reason,
    changeReason: proposed.reason,
    strategy: sanitized.patch,
    metadata: {
      generatedBy: getProviderConfig().model,
      gateReview: { runId: String(runId || ""), patterns: (review?.patterns || []).map((pattern) => pattern.label).slice(0, 20) },
      ...sanitizationMetadata
    }
  });
  return saveTranslationSkill({
    ...scope,
    name: merged.name,
    description: merged.description,
    changeReason: merged.changeReason,
    version: merged.version,
    parentId: champion.id,
    status: "challenger",
    strategy: merged.strategy,
    metadata: merged.metadata,
    evidenceIds: [...new Set((Array.isArray(evidenceIds) ? evidenceIds : []).map(String).filter(Boolean))].slice(0, 100),
    promptVersion,
    metrics: {}
  });
}

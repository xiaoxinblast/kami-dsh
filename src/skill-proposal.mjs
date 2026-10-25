/**
 * Shared challenger proposal used by both the manual "生成候选技能" button and
 * the automatic proposer. Keeps the two paths on identical logic: trajectory
 * selection, model proposal, patch merge and persistence.
 */

import { collectTrainingEvidenceIds, learningSourceKey, mergeTranslationSkillPatch } from "./learning-engine.mjs";
import { getProviderConfig, proposeSkillPatchFromGateReview, proposeTranslationSkillWithModel } from "./provider.mjs";
import { saveTranslationSkill } from "./store.mjs";
import { sanitizeStrategyPatch } from "./strategy-patch.mjs";

/**
 * 能作为候选技能依据的轨迹：**必须是人工采纳过的终稿**。
 *
 * 机器稿（批次刚翻完、还没回填审校）虽然也算"完成轨迹"，但它没经过人工校对，
 * 拿它当改进依据等于把还没确认的写法学进策略；评测留出集本来就只认人工终稿
 * （selectSkillHoldout），这里与它保持一致。人工采纳会重写 date_updated，
 * 所以回填过的轨迹天然排在前面。
 */
export function selectProposalTrajectories(trajectories = [], limit = 40) {
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
  return usable.slice(0, Math.min(limit, Math.max(Math.min(10, usable.length), usable.length - 20)));
}

/**
 * Propose and persist a challenger for one exact scope. Throws the same 409 as
 * the manual endpoint when no usable trajectory exists.
 */
export async function proposeChallengerSkill({ scope, champion, trajectories = [], promptVersion = "kami-translation-v1" }) {
  const usable = selectProposalTrajectories(trajectories);
  if (!usable.length) {
    const error = new Error("当前范围还没有人工采纳的终稿：先回填审校结果或在质检里人工采纳，机器稿不能作为生成候选技能的依据");
    error.statusCode = 409;
    throw error;
  }
  const trainingEvidenceIds = collectTrainingEvidenceIds(usable);
  const proposed = await proposeTranslationSkillWithModel({ ...scope, champion, trajectories: usable });
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
    metadata: { generatedBy: getProviderConfig().model, trainingSources: usable.map((item) => item.source).filter(Boolean), ...sanitizationMetadata }
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

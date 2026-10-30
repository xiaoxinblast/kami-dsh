/**
 * Workbench tuning parameters.
 *
 * These knobs used to live as constants in source files or as environment
 * variables with no UI: the style distillation threshold, the QA pass score,
 * the Auto QA dimension weights, the per-locale title brackets. Changing any of
 * them meant editing code and restarting, which in practice meant nobody
 * changed them and the defaults silently became policy.
 *
 * Everything here is validated the same way model-proposed strategy patches are
 * (`strategy-patch.mjs`): unknown keys dropped, values clamped to a documented
 * range, no way to persist a combination that puts the pipeline in an invalid
 * state. A settings panel that can brick retrieval or disable a safety gate is
 * worse than no panel.
 *
 * Deliberately NOT exposed, because changing them breaks a guarantee rather
 * than tuning behaviour:
 *   - clean-room isolation similarity (loosening it re-admits gold leakage into
 *     evaluations, which is the defect the whole benchmark exists to prevent)
 *   - local embedding dimensions (invalidates every vector already stored)
 *   - sentence alignment costs (internal to the DP aligner, not a policy)
 *   - upload/segment hard caps (protect the process, not a preference)
 *   - store mode and Directus credentials (startup-time, and secrets)
 *
 * Pure module: no store, provider or clock dependency.
 */

import { LOCALES } from "./config.mjs";

/** 每项都写明区间与含义，界面直接用这份定义渲染，避免说明和校验各写一遍。 */
export const SETTING_SPECS = Object.freeze({
  "quality.qaPassScore": { min: 60, max: 100, step: 1, default: 90, label: "AIQA 通过分", hint: "低于此分自动进入最小修订重审" },
  "quality.maxRevisionAttempts": { min: 0, max: 4, step: 1, default: 2, label: "最大修订轮数", hint: "0 表示不自动修订，只报告问题" },
  "quality.weightBasic": { min: 0, max: 100, step: 5, default: 20, label: "Auto QA 基本检查权重", hint: "三项权重之和必须为 100" },
  "quality.weightFidelity": { min: 0, max: 100, step: 5, default: 50, label: "Auto QA 语义忠实性权重", hint: "着重检查项，建议保持最高" },
  "quality.weightNuance": { min: 0, max: 100, step: 5, default: 30, label: "Auto QA nuance 权重", hint: "语气、敬语级别与风格一致性" },
  "quality.penaltyCritical": { min: 10, max: 100, step: 5, default: 35, label: "critical 扣分", hint: "事实层面的丢失或捏造" },
  "quality.penaltyMajor": { min: 1, max: 50, step: 1, default: 12, label: "major 扣分", hint: "语义范围有出入但信息点仍在" },
  "quality.penaltyMinor": { min: 1, max: 20, step: 1, default: 3, label: "minor 扣分", hint: "措辞偏好" },
  "reference.enabled": { type: "boolean", default: true, label: "翻译与质检按需查询参考资料", hint: "模型在需要时通过工具查询角色设定、剧本等资料；关掉则完全不查，资料不会进入提示词" },
  "reference.maxResults": { min: 1, max: 10, step: 1, default: 4, label: "参考资料：每次返回片段数", hint: "一次查询最多返回几段资料" },
  "reference.maxCalls": { min: 1, max: 10, step: 1, default: 3, label: "参考资料：每次翻译最多查询次数", hint: "达到上限后模型必须按已有信息继续" },
  "reference.maxRounds": { min: 1, max: 4, step: 1, default: 2, label: "参考资料：工具调用轮数", hint: "模型可以连续几轮边查边写" },
  "reference.maxCharsPerCall": { min: 500, max: 6000, step: 100, default: 2400, label: "参考资料：单次返回字符上限", hint: "一次工具结果最多注入多少字符" },
  "reference.maxCharsTotal": { min: 1000, max: 20000, step: 500, default: 6000, label: "参考资料：单条句段总字符上限", hint: "一条句段所有查询合计最多注入多少字符" },
  "quality.autoConsistencyCheck": { type: "boolean", default: true, label: "批次结束后自动一致性核对", hint: "整批翻完自动跑跨条目一致性核对与质量报告；关掉可省额度，批次页仍可手动运行" },
  "quality.consistencyAutoRepair": { type: "boolean", default: true, label: "一致性核对后自动统一译法", hint: "有证据的漂移（术语库登记译法、主/参考 TM 人工译例、文件内多数）自动统一；没有依据、或批次已有人工回填时只报告不改" },
  "quality.consistencyRepairMaxSegments": { min: 0, max: 200, step: 5, default: 20, label: "单批自动统一段落上限", hint: "一次自动统一最多改几段，超出部分只列入报告；0 表示不限" },

  "retrieval.translationMemoryLimit": { min: 1, max: 20, step: 1, default: 5, label: "参考译例条数", hint: "每次翻译注入的相似译例上限" },
  "retrieval.candidatePoolSize": { min: 0, max: 5000, step: 100, default: 1000, label: "TM 候选池大小", hint: "先用字符 n-gram 从整库粗筛出多少条候选再做精排：越大越接近全量检索、越慢；0 表示不粗筛（整库打分，8 万条时每段要十几秒）" },
  "retrieval.qaCaseLimit": { min: 1, max: 20, step: 1, default: 3, label: "QA 反例条数", hint: "注入的历史问题译文上限" },
  "retrieval.previousSegments": { min: 0, max: 6, step: 1, default: 2, label: "上文段数", hint: "批次翻译携带的前置上下文" },
  "retrieval.nextSegments": { min: 0, max: 4, step: 1, default: 1, label: "下文段数", hint: "批次翻译携带的后续上下文" },

  "learning.styleDistillThreshold": { min: 3, max: 100, step: 1, default: 8, label: "风格蒸馏阈值", hint: "同作用域证据攒够多少条才蒸馏风格草稿" },
  "learning.styleDistillGrowthWindow": { min: 1, max: 100, step: 1, default: 8, label: "风格蒸馏增长窗口", hint: "上次蒸馏后需再新增多少条，防止草稿泛滥" },
  "learning.translatorProfileThreshold": { min: 3, max: 100, step: 1, default: 3, label: "译者画像阈值", hint: "人工采纳证据攒够多少条才蒸馏画像" },
  "learning.autoProposeThreshold": { min: 3, max: 200, step: 1, default: 10, label: "自动提议候选阈值", hint: "人工终稿达到多少条自动生成候选版本" },
  "learning.autoProposeGrowthWindow": { min: 1, max: 200, step: 1, default: 10, label: "自动提议增长窗口", hint: "上次提议后需再新增多少条" },
  "learning.styleEvaluationMinSamples": { min: 5, max: 200, step: 1, default: 12, label: "风格评测最小样本", hint: "留出集不足这么多条时拒绝开始评测" },
  "learning.skillEvaluationMinSamples": { min: 5, max: 200, step: 1, default: 20, label: "技能评测最小样本", hint: "少于此数的评测结论不允许晋升" },
  "learning.distillPositiveSamples": { min: 10, max: 200, step: 5, default: 50, label: "蒸馏取样：正例条数", hint: "每轮喂给模型的双语证据上限；50 条约 3k 字符，200 条约 13k，上限不是上下文而是注意力稀释" },
  "learning.distillNegativeSamples": { min: 0, max: 60, step: 5, default: 15, label: "蒸馏取样：反例条数", hint: "同事否决但尚未改写的译文上限" },
  "learning.ruleStaleRounds": { min: 2, max: 20, step: 1, default: 4, label: "规则退休轮数", hint: "连续多少轮蒸馏没被证据确认才退休。设小了退回滚动重写，设大了过时规则赖着不走" },

  "learning.conflictScanIntervalMinutes": { min: 0, max: 1440, step: 15, default: 0, label: "规则冲突定时扫描（分钟）", hint: "0 表示只在蒸馏沉淀后扫描，不定时。每次扫描最多送 12 对规则给模型" },

  "learning.regressionEditDistance": { min: 0, max: 1, step: 0.05, default: 0.2, label: "审校改动入回归集阈值", hint: "外部审校把机器稿改动到多大的归一化编辑距离才登记为历史失败案例；纯标点与措辞润色低于阈值不入集" },
  "learning.gateRegressionCaseLimit": { min: 0, max: 200, step: 10, default: 50, label: "门禁单次回归案例上限", hint: "每次门禁按改动幅度从大到小最多跑几条回归案例（每条一次模型调用）；0 表示不限" },
  "learning.gateRegressionPassRate": { min: 0.5, max: 1, step: 0.05, default: 1, label: "回归通过率门槛", hint: "低于此比例直接阻断发版；默认 100%，即历史失败一条都不许复发" },
  "learning.autoGateEnabled": { type: "boolean", default: true, label: "回填后自动重建回归集并跑门禁", hint: "审校回填完成后自动把改动并入回归集，并对最新候选执行一次门禁；关掉则只在面板手动触发" },
  "learning.gateDedupeSources": { type: "boolean", default: true, label: "门禁按原文去重", hint: "同一条原文只翻一次、同时按 Gold 与回归两套规则判定；关掉则回到逐条执行（更贵，结论口径不变）" },
  "learning.termSurveyEnabled": { type: "boolean", default: true, label: "批次翻完后做术语普查", hint: "查找翻译期标记术语在主 TM 和参考 TM 中的译法；主 TM 优先，同级冲突或无匹配则待定，人工终稿确认后才入正式库" },
  "learning.workingTermsEnabled": { type: "boolean", default: true, label: "翻译时自动学习本文件工作术语", hint: "每翻完一段，让快模型从原文/实际译文里抽取需要在本文件统一的新术语；只作用于当前文件，主术语库优先，不写正式术语表。关掉可省每段一次模型调用" },

  "learning.termAutoWriteReviewedTerms": { type: "boolean", default: true, label: "审校确认的术语自动入库", hint: "关联人工终稿后核对标记术语；保留的译法或经高置信对齐核实的改译可入库，已有术语冲突及证据不足转待核对" },
});

/** 作品名括号是风格约定而非语言对错，按语种单独配置。空串表示该语种不做约定检查。 */
export const TITLE_BRACKET_CHOICES = Object.freeze(["", "《》", "「」", "『』", "〈〉", "«»"]);

const TITLE_BRACKET_DEFAULTS = Object.freeze({
  "zh-CN": "《》",
  "ja-JP": "『』",
  "ko-KR": "《》",
  "zh-Hant-TW": "《》",
  "fr-FR": "«»",
  "th-TH": ""
});

function pathValue(target, path) {
  return path.split(".").reduce((carry, key) => (carry == null ? undefined : carry[key]), target);
}

function assignPath(target, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((carry, key) => {
    if (!carry[key] || typeof carry[key] !== "object") carry[key] = {};
    return carry[key];
  }, target);
  parent[last] = value;
}

export function defaultSettings() {
  const settings = {};
  for (const [path, spec] of Object.entries(SETTING_SPECS)) assignPath(settings, path, spec.default);
  settings.orthography = { titleBrackets: { ...TITLE_BRACKET_DEFAULTS } };
  return settings;
}

function clampNumber(value, spec) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number)) return { value: spec.default, note: "数值无效，已回落默认值" };
  const stepped = spec.step >= 1 ? Math.round(number) : number;
  const clamped = Math.min(spec.max, Math.max(spec.min, stepped));
  return clamped === stepped ? { value: clamped } : { value: clamped, note: `超出 ${spec.min}~${spec.max}，已夹紧到 ${clamped}` };
}

function clampBoolean(value, spec) {
  if (typeof value === "boolean") return { value };
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(text)) return { value: true };
  if (["false", "0", "off", "no"].includes(text)) return { value: false };
  return { value: spec.default, note: "不是布尔值，已回落默认" };
}

/**
 * Normalize an arbitrary settings object into a valid one.
 *
 * Returns the sanitized settings plus a per-field list of what was corrected,
 * so the panel can tell the user "this was clamped" instead of silently
 * changing what they typed.
 */
export function sanitizeSettings(input = {}) {
  const settings = defaultSettings();
  const notes = [];

  for (const [path, spec] of Object.entries(SETTING_SPECS)) {
    const raw = pathValue(input, path);
    if (raw === undefined || raw === null || raw === "") continue;
    const { value, note } = spec.type === "boolean" ? clampBoolean(raw, spec) : clampNumber(raw, spec);
    assignPath(settings, path, value);
    if (note) notes.push({ path, label: spec.label, note });
  }

  // Auto QA 综合分是三维加权平均，权重不归一就等于悄悄改变了满分刻度。
  const weights = ["quality.weightBasic", "quality.weightFidelity", "quality.weightNuance"];
  const total = weights.reduce((sum, path) => sum + pathValue(settings, path), 0);
  if (total !== 100) {
    for (const path of weights) assignPath(settings, path, SETTING_SPECS[path].default);
    notes.push({ path: "quality.weights", label: "Auto QA 三维权重", note: `三项之和为 ${total}，必须等于 100，已整组回落默认 20/50/30` });
  }

  // 增长窗口大于阈值会让第二次蒸馏永远等不到，属于把功能配死。
  for (const [thresholdPath, windowPath, label] of [
    ["learning.styleDistillThreshold", "learning.styleDistillGrowthWindow", "风格蒸馏"],
    ["learning.autoProposeThreshold", "learning.autoProposeGrowthWindow", "自动提议"]
  ]) {
    const threshold = pathValue(settings, thresholdPath);
    const window = pathValue(settings, windowPath);
    if (window > threshold) {
      assignPath(settings, windowPath, threshold);
      notes.push({ path: windowPath, label: `${label}增长窗口`, note: `不应大于阈值 ${threshold}，已收敛到阈值` });
    }
  }

  const brackets = { ...TITLE_BRACKET_DEFAULTS };
  const requested = input?.orthography?.titleBrackets;
  if (requested && typeof requested === "object") {
    for (const locale of Object.keys(LOCALES)) {
      const value = String(requested[locale] ?? "").trim();
      if (!TITLE_BRACKET_CHOICES.includes(value)) {
        if (requested[locale] !== undefined) {
          notes.push({ path: `orthography.titleBrackets.${locale}`, label: `${locale} 作品名括号`, note: "不是受支持的括号对，已回落默认" });
        }
        continue;
      }
      brackets[locale] = value;
    }
  }
  settings.orthography = { titleBrackets: brackets };

  return { settings, notes };
}

/** 界面渲染用：按分组吐出规格，避免前端再抄一份字段表。 */
export function settingGroups() {
  const groups = new Map();
  for (const [path, spec] of Object.entries(SETTING_SPECS)) {
    const [group] = path.split(".");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ path, ...spec });
  }
  return [...groups.entries()].map(([group, fields]) => ({ group, fields }));
}

import { COMMITMENT_PATTERN, assessTranslationRisk } from "./translation-routing.mjs";

/**
 * 质量档：把"生成路线"这种实现细节换成一个用户只需要理解一次的成本/质量旋钮。
 *
 * 逐段判定。判定只依赖可核对的内容信号（长度、事实锚点、必须原样保留的标记、
 * 承诺与法务措辞、术语冲突），不再依赖"这段是什么语体"这种猜出来的结论——
 * 语体只作为其中一路输入；短文本仍需区分 UI / 名称与对白 / 叙述。
 */
export const QUALITY_TIERS = Object.freeze({
  fast: {
    label: "快速",
    description: "单次生成 + 确定性检查，适合低风险短标签、按钮、道具名。"
  },
  standard: {
    label: "标准",
    description: "初译 + 模型质检，最多一轮修订。默认档。"
  },
  strict: {
    label: "严苛",
    description: "初译 + 加强模型质检，有问题才定向修订，最多两轮；事实与标记仍执行硬校验。"
  }
});

export const QUALITY_TIER_VALUES = Object.freeze(["auto", ...Object.keys(QUALITY_TIERS)]);

/** 旧版六条生成路线 → 质量档。历史批次与旧前端仍会传 route，必须继续认。 */
export const LEGACY_ROUTE_TO_TIER = Object.freeze({
  direct: "fast",
  reflective: "standard",
  fact_guarded: "strict",
  transcreation: "strict",
  multi_candidate: "strict",
  mt_post_edit: "strict"
});

export function normalizeQualityTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  if (tier === "auto") return "auto";
  return Object.hasOwn(QUALITY_TIERS, tier) ? tier : "";
}

/** 显式质量档优先；否则认旧路线参数，让老前端与历史请求继续可用。 */
export function resolveManualTier({ qualityTier = "", route = "" } = {}) {
  const explicit = normalizeQualityTier(qualityTier);
  if (explicit) return explicit;
  const legacy = LEGACY_ROUTE_TO_TIER[String(route || "").trim().toLowerCase()];
  return legacy || "auto";
}

export { COMMITMENT_PATTERN };

const CREATIVE_PURPOSES = new Set(["marketing", "social"]);
const FACTUAL_PURPOSES = new Set(["rules", "announcement"]);
const FACT_PURPOSES = FACTUAL_PURPOSES;
const FAST_PURPOSES = new Set(["ui", "item_name"]);

/** 事实锚点、时间或数字：公告与规则只有带上它们才需要抬到严苛档。 */
const FACT_LIKE_PATTERN = /\d|月|日|時|分|円|％|%|ポイント|pt\b/iu;

const FAST_MAX_CHARS = 80;

/**
 * 逐段信号。返回的每一项都要能在界面上原样解释给用户，禁止黑箱打分。
 */
export function assessSegmentSignals({ source = "", purpose = "general", factCount = 0, protectedTokens = [], termConflicts = 0, metadata = [] } = {}) {
  const text = String(source || "");
  const length = [...text].length;
  const constraintCount = (Array.isArray(metadata) ? metadata : [])
    .filter((item) => item?.role === "constraint" && String(item?.value || "").trim()).length;
  const constraintMetadata = constraintCount > 0;
  return {
    length,
    purpose,
    factCount: Number(factCount) || 0,
    protectedTokenCount: Array.isArray(protectedTokens) ? protectedTokens.length : 0,
    termConflicts: Number(termConflicts) || 0,
    commitment: COMMITMENT_PATTERN.test(text),
    factualPurpose: FACT_PURPOSES.has(purpose) && FACT_LIKE_PATTERN.test(text),
    constraintMetadata,
    constraintCount
  };
}

/**
 * 自动判档。规则是显式表，改一条就要改一处，避免"分数加起来刚好越线"的玄学。
 * 只向上升级：调用方拿到档位后只允许把它抬高，不允许悄悄降下来。
 */
export function selectQualityTier({ source = "", purpose = "general", risk = null, factCount = 0, protectedTokens = [], termConflicts = 0, metadata = [], manualTier = "auto" } = {}) {
  const manual = normalizeQualityTier(manualTier);
  const signals = assessSegmentSignals({ source, purpose, factCount, protectedTokens, termConflicts, metadata });
  const resolvedRisk = risk || assessTranslationRisk({
    source,
    contentType: purpose,
    facts: { count: signals.factCount },
    metadata,
    protectedTokens
  });
  if (manual && manual !== "auto") {
    return { tier: manual, reason: "手动指定", signals, risk: resolvedRisk, manual: true };
  }
  const strictReasons = [];
  if (signals.commitment) strictReasons.push("含承诺或法务措辞");
  if (signals.termConflicts >= 2) strictReasons.push(`${signals.termConflicts} 个术语存在多种登记译法`);
  if (signals.constraintCount >= 2) strictReasons.push(`${signals.constraintCount} 项交付约束需要联合检查`);
  if (signals.factualPurpose && signals.factCount >= 2) strictReasons.push("公告或规则类内容含多项事实锚点");
  if (strictReasons.length) {
    return { tier: "strict", reason: strictReasons.join("；"), signals, risk: resolvedRisk, manual: false };
  }
  const fastEligible = signals.length > 0 && signals.length <= FAST_MAX_CHARS
    && FAST_PURPOSES.has(purpose)
    && !signals.factCount
    && !signals.termConflicts
    && signals.protectedTokenCount <= 2
    && !signals.commitment
    && !signals.constraintMetadata
    && !CREATIVE_PURPOSES.has(purpose)
    && !FACTUAL_PURPOSES.has(purpose)
    && purpose !== "store";
  if (fastEligible) {
    return { tier: "fast", reason: `低风险短标签或名称（${signals.length} 字），由规则检查保护格式`, signals, risk: resolvedRisk, manual: false };
  }
  return { tier: "standard", reason: "常规句段，走标准流程", signals, risk: resolvedRisk, manual: false };
}

/**
 * 质量档 → 执行计划。返回的 route 仍是 provider.translateWithRoute 认识的形状，
 * 所以执行层不需要为档位再写一套分支。
 */
export function planQualityTier({ tier = "standard", purpose = "general", provider = {}, risk = null, manualRoute = "" } = {}) {
  const resolved = Object.hasOwn(QUALITY_TIERS, tier) ? tier : "standard";
  const mainModel = String(provider.model || "").trim();
  const fastModel = String(provider.fastModel || "").trim();
  const qualityModel = String(provider.qualityModel || "").trim();
  if (resolved === "fast") {
    return {
      tier: resolved,
      tierLabel: QUALITY_TIERS.fast.label,
      route: "direct",
      candidateCount: 1,
      modelRole: fastModel ? "fast" : "main",
      model: fastModel || mainModel,
      modelFallback: !fastModel,
      reflect: false,
      modelQa: false,
      maxRevisions: 0,
      upgradeTier: "standard"
    };
  }
  if (resolved === "strict") {
    // 默认只生成一份译文，统一由后续模型质检收口；旧调用者明确指定时
    // 仍支持多候选或机器初译 + 后编辑，不因启用严苛档自动叠加。
    const route = ["transcreation", "multi_candidate", "mt_post_edit"].includes(manualRoute) ? manualRoute : "fact_guarded";
    return {
      tier: resolved,
      tierLabel: QUALITY_TIERS.strict.label,
      route,
      candidateCount: ["transcreation", "multi_candidate"].includes(route) ? 3 : 1,
      modelRole: qualityModel ? "quality" : "main",
      model: qualityModel || mainModel,
      modelFallback: !qualityModel,
      reflect: false,
      modelQa: true,
      maxRevisions: 2,
      upgradeTier: ""
    };
  }
  return {
    tier: "standard",
    tierLabel: QUALITY_TIERS.standard.label,
    route: "reflective",
    candidateCount: 1,
    modelRole: "main",
    model: mainModel,
    reflect: false,
    modelQa: true,
    maxRevisions: 1,
    upgradeTier: "strict"
  };
}

/** 界面上说明"严苛档现在到底强在哪"：没配高质量模型时必须说实话。 */
export function describeTierStrength({ tier, provider = {} } = {}) {
  if (tier !== "strict") return "";
  const qualityModel = String(provider.qualityModel || "").trim();
  return qualityModel
    ? `严苛档使用高质量模型「${qualityModel}」加强质检，发现问题才修订。`
    : "严苛档使用当前模型加强质检，发现问题才修订（未启用更强模型）。";
}

/**
 * 一份文件实际各用了多少段哪一档。
 *
 * 质量档是逐段判定的，文件行只写"自动"看不出实际发生了什么；
 * `unrecorded` 是较早版本翻译、结果里还没落档位字段的段落——如实报出来，不猜。
 */
export function summarizeQualityTiers(segments = []) {
  const counts = { fast: 0, standard: 0, strict: 0, unrecorded: 0 };
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || segment.selected === false) continue;
    const tier = String(segment?.result?.qualityTier || "");
    if (Object.hasOwn(counts, tier)) counts[tier] += 1;
    else counts.unrecorded += 1;
  }
  return counts;
}

/** 档位分布的展示文案：只列非零项；一条都没记录时说清楚原因。 */
export function describeQualityTiers(tiers = {}) {
  const parts = [["fast", "快速"], ["standard", "标准"], ["strict", "严苛"]]
    .map(([key, label]) => [Number(tiers?.[key]) || 0, label])
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${label} ${count}`);
  const unrecorded = Number(tiers?.unrecorded) || 0;
  if (unrecorded) parts.push(parts.length ? `未记录 ${unrecorded}` : "未记录（旧版本翻译）");
  return parts.join(" · ");
}

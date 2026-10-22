import { MODEL_THINKING_ROLES, loadProviderConfig, normalizeProviderProtocol, saveProviderConfig } from "./provider-store.mjs";
import { runtimeOptions } from "./runtime-context.mjs";
import { ACTIVE_LOCALES, CONTENT_TYPES, LOCALES } from "./config.mjs";
import { glossCoverage, isGlossDumpLiteral, validateGlossTokens } from "./auto-qa.mjs";
import { contextBriefMessages, parseContextBriefPart } from "./context-brief.mjs";
import { consistencyMessages, parseConsistencyFindings } from "./consistency-check.mjs";
import { parseTermAlign, parseTermSurvey, termAlignMessages, termSurveyMessages } from "./term-survey.mjs";
import { gateReviewMessages, parseGateReview } from "./gate-review.mjs";
import { parseModelJsonObject } from "./text.mjs";

const loadedProvider = runtimeOptions().embedded ? { config: {}, persistence: { mode: "dsh", persisted: false } } : loadProviderConfig();
let persistence = loadedProvider.persistence;
const THINKING_VALUES = new Set(["enabled", "disabled"]);
const EFFORT_VALUES = new Set(["low", "high", "max"]);
/** 上游明确拒绝思考参数后不再重复尝试，避免每次调用都先失败一次。 */
let thinkingUnsupported = false;
/** 上游不认 tools 时记住，后续调用直接按无工具模式发，避免每次先撞一次 400。 */
let toolsUnsupported = false;

const baseRuntimeConfig = {
  baseUrl: process.env.LLM_BASE_URL || loadedProvider.config.baseUrl || "http://localhost:11434/v1",
  apiKey: process.env.LLM_API_KEY || loadedProvider.config.apiKey || "",
  model: process.env.LLM_MODEL || loadedProvider.config.model || "qwen3:14b",
  fastModel: process.env.LLM_FAST_MODEL || loadedProvider.config.fastModel || "",
  qualityModel: process.env.LLM_QUALITY_MODEL || loadedProvider.config.qualityModel || "",
  mtModel: process.env.LLM_MT_MODEL || loadedProvider.config.mtModel || "",
  embeddingModel: process.env.LLM_EMBEDDING_MODEL || loadedProvider.config.embeddingModel || "",
  embeddingBaseUrl: process.env.LLM_EMBEDDING_BASE_URL || loadedProvider.config.embeddingBaseUrl || "",
  embeddingApiKey: process.env.LLM_EMBEDDING_API_KEY || loadedProvider.config.embeddingApiKey || "",
  inputPricePerMTok: process.env.LLM_INPUT_PRICE_PER_MTOK ?? loadedProvider.config.inputPricePerMTok ?? "",
  outputPricePerMTok: process.env.LLM_OUTPUT_PRICE_PER_MTOK ?? loadedProvider.config.outputPricePerMTok ?? "",
  protocol: normalizeProviderProtocol(process.env.LLM_PROTOCOL || loadedProvider.config.protocol)
};
for (const role of MODEL_THINKING_ROLES) {
  baseRuntimeConfig[`${role}Thinking`] = loadedProvider.config[`${role}Thinking`] || "";
  baseRuntimeConfig[`${role}Effort`] = loadedProvider.config[`${role}Effort`] || "";
}

function normalizeThinking(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return THINKING_VALUES.has(text) ? text : "enabled";
}

function normalizeEffort(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return EFFORT_VALUES.has(text) ? text : "high";
}

/** 取某个模型角色的思考设置；缺省等价于上游默认（开思考、强度高）。 */
function roleThinking(source, role) {
  return { thinking: normalizeThinking(source?.[`${role}Thinking`]), effort: normalizeEffort(source?.[`${role}Effort`]) };
}

/** 主模型角色的思考设置同时作为所有未指定角色的默认值。 */
function withMainThinking(config) {
  const main = roleThinking(config, "main");
  return { ...config, thinking: main.thinking, reasoningEffort: main.thinking === "enabled" ? main.effort : "" };
}

/**
 * 组装某个模型角色的调用配置（模型 + 思考设置）。
 * 专用模型留空会复用主模型，但思考设置仍按该角色的配置走：需要"快而不思考"的角色照样能关掉思考。
 */
function configForRole(role, model = "") {
  const key = ["fast", "quality", "mt"].includes(String(role || "")) ? String(role) : "main";
  const settings = roleThinking(runtimeConfig, key);
  return {
    ...runtimeConfig,
    model: model || runtimeConfig.model,
    thinking: settings.thinking,
    reasoningEffort: settings.thinking === "enabled" ? settings.effort : ""
  };
}

/**
 * DeepSeek 官方 API：thinking.type 控制思考开关，reasoning_effort 取 low/high/max。
 * 关闭思考只发 thinking.type=disabled；开启时用强度值（上游默认就是高）。
 */
function thinkingParams(thinking, effort) {
  if (thinking === "disabled") return { thinking: { type: "disabled" } };
  return effort ? { reasoning_effort: effort } : {};
}

let runtimeConfig = withMainThinking(baseRuntimeConfig);

/**
 * 从模型回复里取第一个**完整**的 JSON 对象。
 *
 * 旧写法 `content.match(/\{[\s\S]*\}/)` 是贪婪匹配：模型先给一段示例对象、
 * 再给正式结果时会从第一个 `{` 一路吃到最后一个 `}`，拼出非法 JSON；
 * 输出被 max_tokens 截断时又因为缺少收尾 `}` 直接匹配不到，只能报"未返回 JSON 对象"，
 * 完全看不出是被截断还是模型根本没给 JSON。这里改成按括号配对的扫描（跳过字符串内的括号），
 * 并在拿不到完整对象时让调用方带上原始片段与原因。
 */
export function extractJsonObject(text) {
  const raw = String(text || "").replace(/```(?:json)?/giu, "");
  const start = raw.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") { inString = true; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return "";
}

/** 解析失败时给界面/日志看的诊断：开头片段 + 是否像被截断。 */
export function describeJsonFailure(content, label = "模型返回") {
  const text = String(content || "");
  const snippet = text.replace(/\s+/gu, " ").slice(0, 160);
  if (!text.trim()) return `${label}为空`;
  if (!text.includes("{")) return `${label}没有 JSON 对象（${text.length} 字）：${snippet}`;
  if (!text.trimEnd().endsWith("}")) return `${label}的 JSON 没有收尾（${text.length} 字，疑似被 max_tokens 截断）：${snippet}`;
  return `${label}不是合法 JSON（${text.length} 字）：${snippet}`;
}

export function getProviderConfig() {
  if (runtimeOptions().embedded) return { ...runtimeConfig, model: runtimeOptions().modelRoute?.model || "DSH 会话模型", baseUrl: "", apiKey: undefined, apiKeyConfigured: true, embeddingApiKey: undefined, persistence: { mode: "dsh", persisted: true } };
  return {
    ...runtimeConfig,
    apiKeyConfigured: Boolean(runtimeConfig.apiKey),
    apiKey: undefined,
    embeddingApiKeyConfigured: Boolean(runtimeConfig.embeddingApiKey),
    embeddingApiKey: undefined,
    persistence
  };
}

export function updateProviderConfig(input = {}) {
  const submittedApiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const submittedEmbeddingApiKey = typeof input.embeddingApiKey === "string" ? input.embeddingApiKey.trim() : "";
  const nextConfig = {
    baseUrl: String(input.baseUrl || runtimeConfig.baseUrl).replace(/\/$/, ""),
    apiKey: input.clearApiKey === true ? "" : (submittedApiKey || runtimeConfig.apiKey),
    model: String(input.model || runtimeConfig.model),
    fastModel: Object.hasOwn(input, "fastModel") ? String(input.fastModel || "").trim() : runtimeConfig.fastModel,
    qualityModel: Object.hasOwn(input, "qualityModel") ? String(input.qualityModel || "").trim() : runtimeConfig.qualityModel,
    mtModel: Object.hasOwn(input, "mtModel") ? String(input.mtModel || "").trim() : runtimeConfig.mtModel,
    embeddingModel: Object.hasOwn(input, "embeddingModel") ? String(input.embeddingModel || "").trim() : runtimeConfig.embeddingModel,
    embeddingBaseUrl: Object.hasOwn(input, "embeddingBaseUrl") ? String(input.embeddingBaseUrl || "").replace(/\/$/, "") : runtimeConfig.embeddingBaseUrl,
    embeddingApiKey: input.clearEmbeddingApiKey === true ? "" : (submittedEmbeddingApiKey || runtimeConfig.embeddingApiKey),
    protocol: normalizeProviderProtocol(Object.hasOwn(input, "protocol") ? input.protocol : runtimeConfig.protocol),
    inputPricePerMTok: Object.hasOwn(input, "inputPricePerMTok") ? String(input.inputPricePerMTok ?? "").trim() : runtimeConfig.inputPricePerMTok,
    outputPricePerMTok: Object.hasOwn(input, "outputPricePerMTok") ? String(input.outputPricePerMTok ?? "").trim() : runtimeConfig.outputPricePerMTok
  };
  for (const role of MODEL_THINKING_ROLES) {
    nextConfig[`${role}Thinking`] = normalizeThinking(Object.hasOwn(input, `${role}Thinking`) ? input[`${role}Thinking`] : runtimeConfig[`${role}Thinking`]);
    nextConfig[`${role}Effort`] = normalizeEffort(Object.hasOwn(input, `${role}Effort`) ? input[`${role}Effort`] : runtimeConfig[`${role}Effort`]);
  }
  // 换了服务商就重新试一次思考参数：上一个上游不支持不代表这一个也不支持。
  thinkingUnsupported = false;
  toolsUnsupported = false;
  if (input.persist !== false) persistence = saveProviderConfig(nextConfig);
  runtimeConfig = withMainThinking(nextConfig);
  return getProviderConfig();
}

function finitePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

/** True when both input and output prices are configured, so real cost gating can engage. */
export function costPricingConfigured(config = runtimeConfig) {
  return finitePrice(config.inputPricePerMTok) !== null && finitePrice(config.outputPricePerMTok) !== null;
}

/**
 * Estimate USD cost from normalized usage and per-million-token prices.
 * Returns null when usage or pricing is unavailable — cost is then "unmeasured",
 * never faked as zero.
 */
export function estimateUsageCost(usage, config = runtimeConfig) {
  const inputPrice = finitePrice(config.inputPricePerMTok);
  const outputPrice = finitePrice(config.outputPricePerMTok);
  const promptTokens = Number(usage?.promptTokens);
  const completionTokens = Number(usage?.completionTokens);
  if (inputPrice === null || outputPrice === null) return null;
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || promptTokens < 0 || completionTokens < 0) return null;
  return (promptTokens / 1_000_000) * inputPrice + (completionTokens / 1_000_000) * outputPrice;
}

/** Accumulator for per-operation usage collection across several model calls. */
export function createUsageCollector() {
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  return {
    onUsage: (usage) => {
      if (!usage) return;
      const prompt = Number(usage.promptTokens);
      const completion = Number(usage.completionTokens);
      if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return;
      promptTokens += prompt;
      completionTokens += completion;
      calls += 1;
    },
    snapshot() {
      return calls ? { promptTokens, completionTokens, calls } : null;
    }
  };
}

function formatNeighborContext(context = {}) {
  if (!context) return "无";
  if (typeof context === "string") return context || "无";
  const lines = [];
  if (context.document) lines.push(`文档：${context.document}`);
  if (context.entryKey) lines.push(`条目：${context.entryKey}（仅用于理解上下文，不得翻译进结果）`);
  if (context.sheet) lines.push(`工作表：${context.sheet}${context.row ? ` · 第 ${context.row} 行` : ""}${context.sourceColumn ? ` · 正文列：${context.sourceColumn}` : ""}`);
  if (context.segmentIndex && context.segmentCount) lines.push(`位置：第 ${context.segmentIndex} / ${context.segmentCount} 段`);
  if (context.previous) lines.push(`上文：${context.previous}`);
  if (context.next) lines.push(`下文：${context.next}`);
  if (Array.isArray(context.metadata) && context.metadata.length) {
    lines.push("该行补充信息与约束（只用于理解和执行要求，不得作为正文翻译）：");
    for (const item of context.metadata) lines.push(`- [${item.role === "constraint" ? "约束" : "上下文"}] ${item.label}：${item.value}`);
  }
  if (Array.isArray(context.referenceTranslations) && context.referenceTranslations.length) {
    lines.push("该行已有参考译文（仅供语义参考，不得直接当作当前目标语言答案）：");
    for (const item of context.referenceTranslations) lines.push(`- ${item.label}：${item.value}`);
  }
  if (context.note) lines.push(`补充：${context.note}`);
  return lines.join("\n") || "无";
}

/**
 * 人工风格指南按原文结构下发。
 *
 * 之前它整份被 JSON.stringify 塞进提示词：8058 字的指南在每条句段的每次调用里
 * 都变成一大串带 \n 转义的转义串，既浪费 token 又让模型难以按小节定位。这里改成
 * 原样保留换行的文本块，仍然放在稳定前缀的最前面。
 */
function formatStyleGuide(profile) {
  if (!profile) return "";
  const instruction = String(profile.instruction || "").trim();
  const examples = Array.isArray(profile.examples) ? profile.examples : [];
  const blocks = [];
  if (instruction) blocks.push(instruction);
  if (examples.length) {
    blocks.push("正反例：");
    for (const item of examples) {
      if (item && typeof item === "object") {
        const source = String(item.source || "").trim();
        const target = String(item.target || "").trim();
        const note = String(item.note || item.reason || "").trim();
        blocks.push(source || target ? `· ${source}${target ? ` → ${target}` : ""}${note ? `（${note}）` : ""}` : `· ${JSON.stringify(item)}`);
      } else {
        blocks.push(`· ${String(item)}`);
      }
    }
  }
  return blocks.join("\n");
}

function formatStyleRules(rules = [], limit = 30) {
  return (Array.isArray(rules) ? rules : []).slice(0, limit)
    .map((rule) => (typeof rule === "string" ? rule : String(rule?.rule || "").trim()))
    .filter(Boolean);
}

function formatDocumentBrief(brief) {
  if (!brief) return "";
  const lines = [];
  const document = brief.document || {};
  lines.push(`文件用途：${document.purpose || "general"}${document.tone ? `（整体语气：${document.tone}）` : ""}`);
  if (document.summary) lines.push(`文件概述：${document.summary}`);
  if (brief.section) {
    lines.push(`本段所属区间：第 ${brief.section.from}–${brief.section.to} 条 · 用途 ${brief.section.purpose}${brief.section.tone ? ` · 语气 ${brief.section.tone}` : ""}`);
  }
  for (const note of brief.notes || []) lines.push(`注意：${note.text}`);
  for (const ref of brief.crossRefs || []) lines.push(`跨条目一致：${ref.note}（涉及 ${ref.ids.join("、")}）`);
  return lines.join("\n");
}

/**
 * 按用途裁剪 Context Pack。
 *
 * 初译、审校、修订、自检、术语裁决需要的字段并不相同：审校不需要翻译技能与
 * 本地化示范，裁决只需要术语与事实。之前四处都把完整 pack 原样送给模型，
 * 既重复付费也让重点被淹没。
 */
export function projectContextPack(contextPack = {}, purpose = "translate") {
  const core = {
    source: contextPack.source,
    sourceLanguage: contextPack.sourceLanguage,
    targetLocale: contextPack.targetLocale,
    targetLanguage: contextPack.targetLanguage,
    contentType: contextPack.contentType,
    contentTypeLabel: contextPack.contentTypeLabel,
    contentTags: contextPack.contentTags,
    domain: contextPack.domain,
    register: contextPack.register,
    entryId: contextPack.entryId,
    entryKey: contextPack.entryKey,
    documentBrief: contextPack.documentBrief || null,
    styleProfile: contextPack.styleProfile ? {
      id: contextPack.styleProfile.id,
      name: contextPack.styleProfile.name,
      version: contextPack.styleProfile.version,
      instruction: contextPack.styleProfile.instruction,
      contentTypeDirective: contextPack.styleProfile.contentTypeDirective,
      registerPolicy: contextPack.styleProfile.registerPolicy,
      rules: formatStyleRules(contextPack.styleProfile.generationRules),
      reviewRubric: contextPack.styleProfile.reviewRubric
    } : null,
    userProfile: contextPack.userProfile ? {
      name: contextPack.userProfile.name,
      version: contextPack.userProfile.version,
      instruction: contextPack.userProfile.instruction,
      examples: contextPack.userProfile.examples
    } : null,
    requiredTerms: contextPack.requiredTerms || [],
    preferredTerms: contextPack.preferredTerms || [],
    workingTerms: contextPack.workingTerms || [],
    patternReferences: contextPack.patternReferences || [],
    protectedTokens: contextPack.protectedTokens || [],
    factSchema: contextPack.factSchema || null,
    translationReferences: contextPack.translationReferences || [],
    qaGuidance: contextPack.qaGuidance || [],
    batchReferences: contextPack.batchReferences || [],
    batchVerse: contextPack.batchVerse || null,
    batchGroupEntries: contextPack.batchGroupEntries || [],
    rhymeLike: contextPack.rhymeLike === true,
    neighborContext: contextPack.neighborContext || null,
    localeInstruction: contextPack.localeInstruction,
    punctuation: contextPack.punctuation
  };
  if (purpose === "translate") {
    return { ...core, translationSkill: contextPack.translationSkill || null };
  }
  if (purpose === "adjudicate") {
    // 术语裁决只需要"哪条术语候选 + 当前句义与事实"，不需要译例与技能。
    return {
      source: core.source,
      targetLanguage: core.targetLanguage,
      contentTypeLabel: core.contentTypeLabel,
      documentBrief: core.documentBrief,
      requiredTerms: core.requiredTerms,
      preferredTerms: core.preferredTerms,
      protectedTokens: core.protectedTokens,
      factSchema: core.factSchema,
      neighborContext: core.neighborContext,
      styleProfile: core.styleProfile ? { name: core.styleProfile.name, instruction: core.styleProfile.instruction } : null
    };
  }
  if (purpose === "reflect") {
    // 自检只看内容与硬约束，不重复下发示例与技能。
    return {
      ...core,
      styleProfile: core.styleProfile ? { ...core.styleProfile, rules: [] } : null,
      userProfile: core.userProfile ? { name: core.userProfile.name, version: core.userProfile.version, instruction: core.userProfile.instruction, examples: [] } : null,
      translationSkill: null
    };
  }
  return { ...core, translationSkill: null };
}

/** 把投影后的 pack 渲染成结构化文本：稳定信息在前，逐段变量在后。 */
export function contextPackText(contextPack = {}, purpose = "review") {
  const pack = projectContextPack(contextPack, purpose);
  const lines = [];
  lines.push(`目标语言：${pack.targetLanguage || pack.targetLocale || ""}`);
  lines.push(`内容用途：${pack.contentTypeLabel || pack.contentType || "general"}｜语体要求：${pack.register || ""}`);
  if (pack.styleProfile?.contentTypeDirective) lines.push(`本语体写作口径：${pack.styleProfile.contentTypeDirective}`);
  if (pack.styleProfile) {
    lines.push(`项目风格规范：${pack.styleProfile.name || ""} v${pack.styleProfile.version || 1}`);
    for (const rule of pack.styleProfile.rules || []) lines.push(`· ${rule}`);
  }
  const guide = formatStyleGuide(pack.userProfile);
  if (guide) lines.push(`人工风格指南（优先级最高，与其它风格规则冲突时以它为准）：\n${guide}`);
  const briefText = formatDocumentBrief(pack.documentBrief);
  if (briefText) lines.push(`文件语境：\n${briefText}`);
  if (pack.requiredTerms?.length) lines.push(`强制术语（必须逐字采用）：${JSON.stringify(pack.requiredTerms)}`);
  if (pack.preferredTerms?.length) lines.push(`参考术语（结合句义判断，不得仅凭字面强制替换）：${JSON.stringify(pack.preferredTerms)}`);
  if (pack.workingTerms?.length) lines.push(`本文件工作术语（优先级低于主术语库；同一文件内统一采用，不得逐段更换译法）：${JSON.stringify(pack.workingTerms)}`);
  if (pack.patternReferences?.length) lines.push(`同句式参考（固定部分沿用参考译法，只替换当前原文的变量部分）：${JSON.stringify(pack.patternReferences)}`);
  if (pack.protectedTokens?.length) lines.push(`必须原样保留：${JSON.stringify(pack.protectedTokens)}`);
  if (pack.factSchema?.facts?.length || pack.factSchema?.limits?.length) lines.push(`事实锚点：${JSON.stringify(pack.factSchema)}`);
  if (pack.translationReferences?.length) lines.push(`历史译例：${JSON.stringify(pack.translationReferences)}`);
  if (pack.qaGuidance?.length) lines.push(`历史 AIQA 反例：${JSON.stringify(pack.qaGuidance)}`);
  if (pack.batchReferences?.length) lines.push(`本批已定稿译文（保持一致）：${JSON.stringify(pack.batchReferences)}`);
  const neighbor = formatNeighborContext(pack.neighborContext || {});
  if (neighbor && neighbor !== "无") lines.push(`文档上下文（仅用于理解，不得翻译进结果）：\n${neighbor}`);
  lines.push(`当前原文：\n${pack.source}`);
  return lines.join("\n");
}

export function packPrompt(contextPack) {
  const pack = projectContextPack(contextPack, "translate");
  const translationSkill = pack.translationSkill;
  const rhymeHint = contextPack.rhymeLike
    ? "⚠️ 本条原文带有顺口溜/韵文结构（短句对仗 + 长句收尾，可能押韵）：必须用目标语言自然重现节奏与押韵，可以调整语序、换用拟态词、谚语与地道说法，严禁机械逐字重复原文的字数结构。\n"
    : "";
  const batchVerseHint = contextPack.batchVerse?.active
    ? `⚠️ 本批为排比韵文：所有行共用「${contextPack.batchVerse.shape}」句式（短句 + 长句）。每一行都必须使用同一句式、节奏、语体与韵脚风格；如果本批已有定稿译文，后续各行必须严格仿照其句式与用词。\n`
    : "";
  const batchReferenceHint = contextPack.batchReferences?.length
    ? `本批已定稿译文（必须保持句式与风格完全一致，可参考其用词与语气）：${JSON.stringify(contextPack.batchReferences)}\n`
    : "";
  const batchGroupHint = contextPack.batchGroupEntries?.length
    ? `当前文件条目联译组（仅用于理解同组上下文；输出仍然只能是当前原文对应的译文）：${JSON.stringify(contextPack.batchGroupEntries)}\n`
    : "";
  const localeExamples = LOCALES[contextPack.targetLocale]?.localizationExamples || [];
  const exampleHint = localeExamples.length
    ? `本地化示范（左：原文 → 直译，右：合格的地道译法。请达到右侧的水平）：\n${localeExamples.map((item) => `· ${item.source} → ${item.literal} ✗ / ${item.idiomatic} ✓（${item.note}）`).join("\n")}\n`
    : "";
  const termsSummary = (terms = []) => terms
    .map((term) => `· ${term.source} → ${term.target}${term.note ? `（${term.note}）` : ""}${term.matchMode ? ` [${term.matchMode}]` : ""}`)
    .join("\n");
  const conflictedTerms = (pack.preferredTerms || []).filter((term) => term.conflict === true);
  const stable = [
    `你是资深游戏本地化写手。你的任务不是逐字翻译，而是把${pack.sourceLanguage}文案用 ${pack.targetLanguage} 玩家最自然的方式重新表达：先读懂这句话在游戏场景里的意图、情绪与角色，再用目标语言母语者会用的说法写出来。只改变表达方式，不改变信息。`,
    `硬规则（任何其它说明与它冲突时以硬规则为准）：\n1. 不得使用其他目标语言的表达。\n2. 信息保真：数字、日期、名称、占位符、强制术语和事实必须完整保留；除此之外，语序、句式、用词、修辞都可以自由改写为地道说法——换一种地道表达不等于漏译或增译。\n3. 强制术语必须逐字采用指定目标译法。\n4. 上下文与语境档案只用于消歧和保持一致，不得把上文、下文或说明文字混入译文。\n5. 数字与日期：数值必须等价，格式按目标语言习惯改写；不得为了保留字面而在译文里额外塞入原样数字。\n6. 拒绝翻译腔：成语、习语、重复、语气词、客套话一律换成目标语言中语义与语气对等的自然说法；译文读起来必须像目标语言原生文案，而不是日语的逐字影子。\n7. 原文含押韵、对仗、重复或口号结构时，必须在目标语言中重现节奏与韵律，允许换用地道表达；语气要与原句一致（如闲散自嘲不得译成命令口吻）。\n8. 只翻译“当前原文”，只输出译文，不解释。`
  ];
  const guide = formatStyleGuide(pack.userProfile);
  if (guide) stable.push(`人工风格指南（版本 ${pack.userProfile?.version || "无"}，跨语体全局；优先级最高，与下面任何风格规则冲突时以它为准）：\n${guide}`);
  if (pack.styleProfile) {
    const rules = formatStyleRules(pack.styleProfile.rules);
    stable.push(`项目风格规范：${pack.styleProfile.name || ""} · 版本 ${pack.styleProfile.version || 1}${pack.styleProfile.instruction ? `\n规范说明：${pack.styleProfile.instruction}` : ""}${rules.length ? `\n规范要点：\n${rules.map((rule) => `· ${rule}`).join("\n")}` : ""}`);
  }
  if (exampleHint) stable.push(exampleHint.trim());
  stable.push(`目标语言要求：${pack.localeInstruction}${pack.punctuation ? `\n标点约定：${pack.punctuation}` : ""}`);
  stable.push(`本条用途：${pack.contentTypeLabel}｜语体要求：${pack.register}｜领域：${pack.domain}${pack.styleProfile?.contentTypeDirective ? `\n本语体写作口径：${pack.styleProfile.contentTypeDirective}` : ""}${pack.styleProfile?.registerPolicy ? `\n语域上限（写完会用同一口径判定，超出会被标记）：${JSON.stringify(pack.styleProfile.registerPolicy)}——promotional 推销感、casual 口语网感、generic 套话平淡，数值越低表示该倾向越不被允许。` : ""}`);
  if (translationSkill) {
    stable.push(`翻译技能：${translationSkill.name} · v${translationSkill.version} · ${translationSkill.instruction || "沿用当前稳定流程"}${(translationSkill.additionalRules || []).length ? `\n技能增量规则：${JSON.stringify(translationSkill.additionalRules)}` : ""}`);
  }
  const variable = [];
  const briefText = formatDocumentBrief(pack.documentBrief);
  const neighborText = formatNeighborContext(pack.neighborContext);
  if (briefText) variable.push(`文件语境（来自整份文件的语境分析）：\n${briefText}`);
  if (neighborText && neighborText !== "无") variable.push(`文档上下文（仅用于理解，不得翻译进结果）：\n${neighborText}`);
  if (pack.requiredTerms?.length) variable.push(`强制术语（必须逐字采用）：\n${termsSummary(pack.requiredTerms)}`);
  if (pack.preferredTerms?.length) {
    variable.push(`参考术语（结合完整句义、上下文与用途判断是否采用；exact 只表示字符串精确命中，不表示当前词义必然相同，禁止仅凭字面命中强制替换）：\n${termsSummary(pack.preferredTerms)}`);
  }
  if (conflictedTerms.length) {
    variable.push(`⚠️ 以下原文在术语库里存在多个登记译法，本次译文只能采用其中一个，不得在同一条里混用，也不得自行造第三种译法：\n${conflictedTerms.map((term) => `· ${term.source}：${term.target}`).join("\n")}`);
  }
  if (pack.workingTerms?.length) {
    variable.push(`本文件工作术语（优先级低于主术语库；同一文件内统一采用，除非当前句义明确不适用）：\n${termsSummary(pack.workingTerms)}`);
  }
  if (pack.patternReferences?.length) {
    variable.push(`同句式参考（这些句子共用同一固定框架；固定部分必须沿用参考译法，只替换当前原文的变量内容，变量不得照抄）：\n${pack.patternReferences.map((item) => `· ${item.source} → ${item.target}`).join("\n")}`);
  }
  if (pack.protectedTokens?.length) variable.push(`必须原样保留（URL、占位符、标签、带单位的数值）：${JSON.stringify(pack.protectedTokens)}`);
  if (pack.factSchema) variable.push(`结构化事实锚点（translation 范围必须在译文中保持等价；task 范围只作为交付约束，不得翻译进正文）：${JSON.stringify(pack.factSchema)}`);
  if (pack.translationReferences?.length) variable.push(`历史译例（同语言、相似度与人工可信度排序；标有 contextualFallback 或用途不同的译例只用于稳定术语与基础表达，不得覆盖当前用途要求）：${JSON.stringify(pack.translationReferences)}`);
  if (pack.qaGuidance?.length) variable.push(`历史 AIQA 反例与修订：${JSON.stringify(pack.qaGuidance)}`);
  if (batchVerseHint) variable.push(batchVerseHint.trim());
  if (batchReferenceHint) variable.push(batchReferenceHint.trim());
  if (batchGroupHint) variable.push(batchGroupHint.trim());
  if (rhymeHint) variable.push(rhymeHint.trim());
  return `${[...stable, ...variable].join("\n\n")}\n\n当前原文：\n${pack.source}`;
}

/**
 * Fetch with full-lifecycle timeout safety.
 *
 * AbortSignal.timeout covers the ENTIRE request, including body reads. A
 * timeout can therefore fire while reading the response body — outside the
 * initial fetch() call — and must be converted to a labeled error here,
 * otherwise a raw DOMException escapes to the user as "The operation was
 * aborted due to timeout". Optional retries only apply to timeouts.
 */
export async function fetchWithTimeout(url, init = {}, { timeoutMs = 30_000, label = "请求", retries = 0, retryDelayMs = 300 } = {}) {
  const attempts = Math.max(1, Math.trunc(retries) + 1);
  const timeoutText = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
  const timeoutMessage = `${label}请求超时（${timeoutText}）`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.name !== "AbortError") throw error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new Error(timeoutMessage);
    }
    let text = null;
    try {
      text = response.status === 204 ? null : await response.text();
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.name !== "AbortError") throw error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new Error(timeoutMessage);
    }
    return { response, text };
  }
  throw new Error(timeoutMessage);
}

/**
 * 出口协议：同一个工作台要能挂三种形态的模型服务。
 *
 * - openai：OpenAI 兼容的 /chat/completions（本地 Ollama、DeepSeek、各类网关）
 * - responses：OpenAI Responses API（/responses，input 数组 + output 数组）
 * - anthropic：Anthropic Messages（/messages，content 块 + tool_use / tool_result）
 *
 * 内部消息一律保持 OpenAI chat 的形态（system/user/assistant/tool + tool_calls +
 * image_url 内容块），发请求前按协议渲染、收到响应后归一化成同一份
 * { content, toolCalls }。上层（翻译、QA、参考资料识图）不用关心用的是哪一家。
 */
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic 的 max_tokens 是必填项：调用方没指定时用它兜底。 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4_096;

function protocolEndpoint(protocol, baseUrl) {
  if (protocol === "responses") return `${baseUrl}/responses`;
  if (protocol === "anthropic") return `${baseUrl}/messages`;
  return `${baseUrl}/chat/completions`;
}

/**
 * Anthropic 官方文档现在以 `Authorization: Bearer` 为准，`x-api-key` 仍然支持；
 * 第三方网关两种都见过，所以两个都带（值相同，不会互相冲突）。
 */
function protocolHeaders(protocol, apiKey) {
  if (protocol !== "anthropic") {
    return { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  }
  return {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(apiKey ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` } : {})
  };
}

/** 消息内容统一按"内容块数组"处理：纯文本也能当成长度为 1 的块数组。 */
function contentBlocks(content) {
  if (Array.isArray(content)) return content;
  const text = String(content ?? "");
  return text ? [{ type: "text", text }] : [];
}

function blocksText(content) {
  return contentBlocks(content)
    .map((block) => (block?.type === "image_url" ? "" : String(block?.text ?? "")))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** data URL → { mediaType, data }；Anthropic 的图片块要把 MIME 与数据分开传。 */
function splitImageDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.+)$/su.exec(String(url || ""));
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function parseArgumentsJson(text) {
  try {
    const parsed = JSON.parse(String(text || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Anthropic 不接受连续同角色消息，把相邻的同角色内容块合并成一条。 */
function pushAnthropicMessage(list, role, blocks) {
  if (!blocks.length) return;
  const last = list[list.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else list.push({ role, content: blocks });
}

function responsesInput(messages) {
  const instructions = [];
  const input = [];
  for (const message of messages) {
    const role = String(message?.role || "user");
    if (role === "system" || role === "developer") {
      const text = String(message?.content ?? "").trim();
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({ type: "function_call_output", call_id: String(message?.tool_call_id || ""), output: String(message?.content ?? "") });
      continue;
    }
    if (role === "assistant") {
      // 工具调用要用 function_call 输入项回灌，否则模型看不到自己上一轮请求过什么。
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        input.push({
          type: "function_call",
          call_id: String(call?.id || call?.function?.name || ""),
          name: String(call?.function?.name || ""),
          arguments: String(call?.function?.arguments ?? "{}")
        });
      }
      const text = blocksText(message?.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      continue;
    }
    input.push({
      type: "message",
      role: "user",
      content: contentBlocks(message?.content).map((block) => (block?.type === "image_url"
        ? {
          type: "input_image",
          image_url: String(block?.image_url?.url || ""),
          ...(block?.image_url?.detail ? { detail: block.image_url.detail } : {})
        }
        : { type: "input_text", text: String(block?.text ?? "") }))
    });
  }
  return { instructions: instructions.join("\n\n"), input };
}

function anthropicConversation(messages) {
  const system = [];
  const list = [];
  for (const message of messages) {
    const role = String(message?.role || "user");
    if (role === "system" || role === "developer") {
      const text = String(message?.content ?? "").trim();
      if (text) system.push(text);
      continue;
    }
    if (role === "tool") {
      pushAnthropicMessage(list, "user", [{ type: "tool_result", tool_use_id: String(message?.tool_call_id || ""), content: String(message?.content ?? "") }]);
      continue;
    }
    if (role === "assistant") {
      const blocks = [];
      const text = blocksText(message?.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        blocks.push({
          type: "tool_use",
          id: String(call?.id || call?.function?.name || ""),
          name: String(call?.function?.name || ""),
          input: parseArgumentsJson(call?.function?.arguments)
        });
      }
      pushAnthropicMessage(list, "assistant", blocks);
      continue;
    }
    pushAnthropicMessage(list, "user", contentBlocks(message?.content).map((block) => {
      if (block?.type !== "image_url") return { type: "text", text: String(block?.text ?? "") };
      const image = splitImageDataUrl(block?.image_url?.url);
      // 只支持 base64 data URL：Anthropic 的 url 图片源要服务端自己去取，工作台不代下。
      return image
        ? { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }
        : { type: "text", text: `（这张图片无法内联，已跳过：${String(block?.image_url?.url || "").slice(0, 60)}）` };
    }));
  }
  return { system: system.join("\n\n"), messages: list };
}

function protocolTools(protocol, tools) {
  if (protocol === "responses") {
    return tools.map((tool) => ({
      type: "function",
      name: String(tool?.function?.name || tool?.name || ""),
      description: String(tool?.function?.description || tool?.description || ""),
      parameters: tool?.function?.parameters || tool?.parameters || { type: "object", properties: {} }
    }));
  }
  if (protocol === "anthropic") {
    return tools.map((tool) => ({
      name: String(tool?.function?.name || tool?.name || ""),
      description: String(tool?.function?.description || tool?.description || ""),
      input_schema: tool?.function?.parameters || tool?.parameters || { type: "object", properties: {} }
    }));
  }
  return tools;
}

/**
 * 思考参数各家形态不同：OpenAI 兼容走 thinking.type / reasoning_effort，
 * Responses 走 reasoning.effort，Anthropic 的 extended thinking 要额外给预算，这里不发。
 */
function thinkingParamsFor(protocol, thinking, effort) {
  if (protocol === "anthropic") return {};
  if (protocol === "responses") return thinking === "disabled" || !effort ? {} : { reasoning: { effort } };
  return thinkingParams(thinking, effort);
}

function chatRequestBody(protocol, { messages, model, temperature, seed, maxTokens, responseFormat, tools, thinkingBody }) {
  if (protocol === "responses") {
    const { instructions, input } = responsesInput(messages);
    return {
      model,
      input,
      ...(instructions ? { instructions } : {}),
      temperature,
      ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
      ...(responseFormat ? { text: { format: { type: "json_object" } } } : {}),
      ...(tools.length ? { tools: protocolTools("responses", tools), tool_choice: "auto" } : {}),
      ...thinkingBody
    };
  }
  if (protocol === "anthropic") {
    const { system, messages: conversation } = anthropicConversation(messages);
    return {
      model,
      max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: conversation,
      ...(system ? { system } : {}),
      temperature,
      ...(tools.length ? { tools: protocolTools("anthropic", tools), tool_choice: { type: "auto" } } : {}),
      ...thinkingBody
    };
  }
  return {
    model,
    messages,
    temperature,
    ...(seed === undefined ? {} : { seed }),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    ...thinkingBody
  };
}

/** 把三家响应归一化成 { content, toolCalls, finishReason, usage }。 */
function normalizeChatResponse(protocol, payload) {
  if (protocol === "responses") {
    const texts = [];
    const toolCalls = [];
    for (const item of Array.isArray(payload?.output) ? payload.output : []) {
      if (item?.type === "function_call") {
        toolCalls.push({ id: item.call_id || item.id || item.name, type: "function", function: { name: item.name, arguments: item.arguments } });
        continue;
      }
      for (const block of Array.isArray(item?.content) ? item.content : []) {
        if (block?.type === "output_text") texts.push(String(block.text || ""));
        else if (block?.type === "refusal") texts.push(String(block.refusal || ""));
      }
    }
    const truncated = payload?.status === "incomplete" || payload?.incomplete_details?.reason === "max_output_tokens";
    return {
      content: texts.join("").trim(),
      toolCalls,
      finishReason: truncated ? "length" : "stop",
      usage: payload?.usage ? { promptTokens: Number(payload.usage.input_tokens) || 0, completionTokens: Number(payload.usage.output_tokens) || 0 } : null
    };
  }
  if (protocol === "anthropic") {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    return {
      content: blocks.filter((block) => block?.type === "text").map((block) => String(block.text || "")).join("").trim(),
      toolCalls: blocks.filter((block) => block?.type === "tool_use").map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      })),
      finishReason: payload?.stop_reason === "max_tokens" ? "length" : "stop",
      usage: payload?.usage ? { promptTokens: Number(payload.usage.input_tokens) || 0, completionTokens: Number(payload.usage.output_tokens) || 0 } : null
    };
  }
  const message = payload?.choices?.[0]?.message || {};
  let content = String(message.content || "").trim();
  // 推理模型在“结论为空”的简单场景可能把最终 JSON 留在推理轨迹里：取轨迹尾部最后一个 JSON 片段
  if (!content && typeof message.reasoning_content === "string") {
    const candidates = [...(message.reasoning_content.match(/\[[\s\S]*\]/g) || []), ...(message.reasoning_content.match(/\{[\s\S]*\}/g) || [])];
    const tail = candidates[candidates.length - 1];
    if (tail) content = tail.trim();
  }
  return {
    content,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.filter((call) => call?.function?.name) : [],
    finishReason: payload?.choices?.[0]?.finish_reason || "stop",
    usage: payload?.usage
      ? { promptTokens: Number(payload.usage.prompt_tokens) || 0, completionTokens: Number(payload.usage.completion_tokens) || 0 }
      : (Number.isFinite(payload?.prompt_eval_count) || Number.isFinite(payload?.eval_count))
        ? { promptTokens: Number(payload?.prompt_eval_count) || 0, completionTokens: Number(payload?.eval_count) || 0 }
        : null
  };
}

async function chat(messages, config = runtimeConfig, options = {}) {
  const normalizedOptions = typeof options === "number" ? { temperature: options } : options;
  const runtime = runtimeOptions();
  if (runtime.modelAdapter) {
    const result = await runtime.modelAdapter(messages, { ...normalizedOptions, route: runtime.modelRoute, signal: runtime.signal });
    if (result.usage) normalizedOptions.onUsage?.(result.usage);
    return normalizedOptions.returnMessage ? { content: result.content, toolCalls: result.toolCalls || [] } : result.content;
  }
  const protocol = normalizeProviderProtocol(config.protocol);
  const temperature = normalizedOptions.temperature ?? 0.25;
  const timeoutMs = normalizedOptions.timeoutMs ?? 60_000;
  const requestLabel = normalizedOptions.requestLabel || "模型";
  let maxTokens = normalizedOptions.maxTokens;
  // seed 只有 OpenAI 兼容端点认；Responses 与 Anthropic 都没有这个参数，发了就是 400。
  let seed = protocol === "openai" && Number.isInteger(normalizedOptions.seed) ? normalizedOptions.seed : undefined;
  let seedFallbackUsed = false;
  const tools = Array.isArray(normalizedOptions.tools) ? normalizedOptions.tools : [];
  // 思考设置：显式传参（例如探针固定 low）优先于模型角色配置。
  let thinkingBody = thinkingUnsupported
    ? {}
    : thinkingParamsFor(
      protocol,
      String(normalizedOptions.thinking ?? config.thinking ?? "").trim(),
      String(normalizedOptions.reasoningEffort ?? config.reasoningEffort ?? "").trim()
    );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { response, text } = await fetchWithTimeout(protocolEndpoint(protocol, config.baseUrl), {
      method: "POST",
      headers: protocolHeaders(protocol, config.apiKey),
      body: JSON.stringify(chatRequestBody(protocol, {
        messages,
        model: config.model,
        temperature,
        seed,
        maxTokens,
        responseFormat: normalizedOptions.responseFormat,
        tools: toolsUnsupported ? [] : tools,
        thinkingBody
      }))
    }, { timeoutMs, label: requestLabel, retries: 1 });
    if (!response.ok) {
      // Several OpenAI-compatible gateways do not expose `seed`. Keep the
      // evaluation usable, but surface the downgrade to the caller instead of
      // silently claiming deterministic sampling.
      if (seed !== undefined && !seedFallbackUsed && response.status === 400
        && /seed/i.test(text || "") && /unknown|unsupported|extra_forbidden|not permitted|not allowed/i.test(text || "")) {
        seed = undefined;
        seedFallbackUsed = true;
        normalizedOptions.onSeedUnsupported?.(`${requestLabel} 上游不支持固定 seed`);
        continue;
      }
      // 不是每个上游都认 thinking / reasoning_effort / reasoning：拒绝就退回默认思考模式，
      // 并记住这家上游不支持，避免后续每次调用都先撞一次 400。
      if (Object.keys(thinkingBody).length && response.status === 400
        && /reasoning|thinking/i.test(text || "") && /unknown|unsupported|extra_forbidden|not permitted|not allowed|invalid/i.test(text || "")) {
        thinkingUnsupported = true;
        thinkingBody = {};
        normalizedOptions.onThinkingUnsupported?.(`${requestLabel} 上游不支持思考设置，已按默认思考模式重试`);
        continue;
      }
      // 不是每个 OpenAI 兼容端点都认 tools：拒绝就退回无工具模式（参考资料改为不查），
      // 但翻译本身必须继续，不能因为一个可选能力把整批任务打断。
      if (!toolsUnsupported && tools.length && response.status === 400
        && /tool/i.test(text || "") && /unknown|unsupported|extra_forbidden|not permitted|not allowed|invalid/i.test(text || "")) {
        toolsUnsupported = true;
        normalizedOptions.onToolsUnsupported?.(`${requestLabel} 上游不支持工具调用，已按无工具模式重试`);
        continue;
      }
      throw new Error(`模型请求失败 (${response.status})：${(text || "").slice(0, 500)}`);
    }
    const payload = JSON.parse(text || "{}");
    const normalized = normalizeChatResponse(protocol, payload);
    if (typeof normalizedOptions.onUsage === "function" && normalized.usage) normalizedOptions.onUsage(normalized.usage);
    // 推理预算耗尽导致输出被截断：加大预算重试一次，避免把"思考超长"误判成"没有结论"。
    // JSON 模式下的截断输出必然是残缺的（拿不到收尾括号），即使有内容也要重试。
    if (normalized.finishReason === "length" && attempt < 2 && (!normalized.content || normalizedOptions.responseFormat)) {
      maxTokens = maxTokens ? Math.min(8000, Math.ceil(maxTokens * 2)) : 4000;
      continue;
    }
    if (normalizedOptions.returnMessage === true) return { content: normalized.content, toolCalls: normalized.toolCalls };
    return normalized.content;
  }
  if (normalizedOptions.returnMessage === true) return { content: "", toolCalls: [] };
  return "";
}

/**
 * 带工具的多轮对话：模型请求工具就执行、把结果回灌，直到它给出最终文本或到达轮次上限。
 * usage 由 chat 逐轮回调，调用方自行累加。
 */
export async function chatWithTools(messages, config = runtimeConfig, {
  tools = [],
  executeTool,
  maxRounds = 2,
  onActivity = null,
  onToolsUnsupported = null,
  ...options
} = {}) {
  if (typeof executeTool !== "function" || !tools.length) {
    return { content: await chat(messages, config, options), toolResults: [] };
  }
  const conversation = [...messages];
  const toolResults = [];
  let content = "";
  const lastRound = Math.max(0, maxRounds);
  let exhausted = false;
  for (let round = 0; round <= lastRound; round += 1) {
    const message = await chat(conversation, config, { ...options, tools, tool_choice: "auto", returnMessage: true, onToolsUnsupported });
    const calls = message.toolCalls || [];
    if (!calls.length) {
      content = message.content || "";
      break;
    }
    conversation.push({ role: "assistant", content: message.content || "", tool_calls: calls });
    for (const call of calls) {
      const result = await executeTool({ name: call.function.name, arguments: call.function.arguments });
      toolResults.push(result);
      conversation.push({ role: "tool", tool_call_id: call.id || call.function.name, content: String(result?.text || "") });
      onActivity?.({ tool: call.function.name, refs: result?.refs?.length ?? 0 });
    }
    content = message.content || content;
    // 轮次用尽时最后一轮仍在要工具：把这件事报给调用方。
    // 以前这种情况只会返回空 content，调用方分不清"模型给了空译文"和"根本没答"。
    if (round === lastRound) exhausted = true;
  }
  return { content, toolResults, exhausted };
}

export function isEmbeddingConfigured() {
  return Boolean(runtimeConfig.embeddingModel);
}

function embeddingRequestProfile(model, configuredUrl) {
  const baseUrl = String(configuredUrl || "").replace(/\/+$/, "");
  const hasCompleteEndpoint = /\/embeddings(?:\/multimodal)?$/i.test(baseUrl);
  const multimodal = /\/embeddings\/multimodal$/i.test(baseUrl) || /^doubao-embedding-vision(?:-|$)/i.test(model);
  return {
    endpoint: hasCompleteEndpoint ? baseUrl : `${baseUrl}${multimodal ? "/embeddings/multimodal" : "/embeddings"}`,
    multimodal
  };
}

export async function embed(text, { model: modelOverride, timeoutMs = 30_000 } = {}) {
  const model = modelOverride || runtimeConfig.embeddingModel;
  if (!model) throw new Error("未配置 embedding 模型，向量检索保持禁用");
  const baseUrl = runtimeConfig.embeddingBaseUrl || runtimeConfig.baseUrl;
  const apiKey = runtimeConfig.embeddingApiKey || runtimeConfig.apiKey;
  const source = String(text).slice(0, 16_000);
  const profile = embeddingRequestProfile(model, baseUrl);
  const requestBody = profile.multimodal
    ? { model, input: [{ type: "text", text: source }], encoding_format: "float", dimensions: 1024 }
    : { model, input: source };
  const { response, text: responseText } = await fetchWithTimeout(profile.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(requestBody)
  }, { timeoutMs, label: "embedding" });
  if (!response.ok) {
    throw new Error(`embedding 请求失败 (${response.status})：${(responseText || "").slice(0, 500)}`);
  }
  const payload = JSON.parse(responseText || "{}");
  let vector = payload.data?.[0]?.embedding ?? payload.data?.embedding ?? payload.embedding;
  if (!Array.isArray(vector) || !vector.length || !vector.every((value) => Number.isFinite(value))) {
    throw new Error("embedding 响应缺少有效向量");
  }
  vector = vector.map(Number);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error("embedding 返回零向量");
  return { vector: vector.map((value) => value / norm), model, dimensions: vector.length };
}

export async function reviewTermCandidatesWithModel(locale, candidates) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactCandidates = candidates.slice(0, 160).map((candidate, index) => ({
    index,
    candidateKey: candidate.candidateKey || "",
    sheet: candidate.sheet || "",
    sheetMode: candidate.sheetMode || "mixed",
    rowNumber: candidate.rowNumber || null,
    assetType: candidate.assetType,
    source: candidate.source,
    target: candidate.target,
    note: candidate.note || "",
    contentTypeHint: candidate.contentType || "general",
    domainHint: candidate.domain || "general",
    ruleScore: candidate.score,
    ruleReasons: candidate.reasons
  }));
  const content = await chat([
    {
      role: "system",
      content: `你是游戏本地化资产清洗员。用户只负责上传文件，你必须逐条完成资产归类，不要求用户设置任何参数。审核日语到${language}的候选对照。每一个输入 index 都必须且只能返回一次 decision，不能遗漏。

rowKind 只能为 term 或 memory。sheetMode=dialogue 时整行必须保持 memory；不得因为译文长短将同一句日语改成 term。term 是独立词条中的专名、系统名、功能名、道具名、角色名、地点名、技能名；memory 是语义对齐的台词、句子、UI 文本或完整文案。memory 的 contentType 必须从 ${Object.keys(CONTENT_TYPES).join(", ")} 中选择；term 的主分类继承所在行或来源文件的用途，不得把 general 当作跨分类通配。domain 只能为 game、marketing、community、general。

对 keep=true 且 rowKind=memory 的完整句段，同时检查句内术语，放入 nestedTerms，不得用 nestedTerms 替换父 memory。nestedTerms.category 只能是 proper_name、character_name、place_name、item_name、skill_name、system_name、organization_name、species_name、currency_name、lore_concept、fixed_ui_label。必须是专名、官方命名或能稳定复用的固定标签；严禁抽取代词、动词/形容词短语、普通搭配、礼貌套话、一次性修辞和整分句。nestedTerms.source 必须逐字存在于 source，target 必须逐字存在于 target；不得补译、改写或猜测目标词。句内提取项统一作为参考候选，不判断强制级别。

排除数字、网址、DDL、字符限制、位置说明、语种要求、错列、元数据和明显误译。不要改写父 source 或 target。输出严格 JSON：{"decisions":[{"index":0,"keep":true,"confidence":0.95,"rowKind":"memory","contentType":"dialogue","domain":"game","reason":"完整对白且语义对齐","nestedTerms":[{"source":"プレミアムパス","target":"高级通行证","category":"fixed_ui_label","confidence":0.98,"reason":"固定 UI 名称"}]}]}`
    },
    { role: "user", content: JSON.stringify(compactCandidates) }
  ], runtimeConfig, {
    temperature: 0,
    timeoutMs: 90_000,
    maxTokens: 8_000,
    requestLabel: "术语与译例清洗",
    responseFormat: { type: "json_object" }
  });
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语清洗模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.decisions)) throw new Error("术语清洗模型返回格式无效");
  const validIndexes = new Set();
  const duplicateIndexes = [];
  for (const decision of payload.decisions) {
    const index = Number(decision?.index);
    if (!Number.isInteger(index) || index < 0 || index >= compactCandidates.length) continue;
    if (validIndexes.has(index)) duplicateIndexes.push(index);
    validIndexes.add(index);
  }
  const missing = compactCandidates.map((_, index) => index).filter((index) => !validIndexes.has(index));
  if (missing.length || duplicateIndexes.length) {
    throw new Error(`术语清洗模型返回不完整：已覆盖 ${validIndexes.size}/${compactCandidates.length} 条${missing.length ? `，缺少 index ${missing.slice(0, 12).join(",")}` : ""}${duplicateIndexes.length ? `，重复 index ${duplicateIndexes.slice(0, 12).join(",")}` : ""}`);
  }
  return payload.decisions;
}

export async function analyzeTermTableStructureWithModel(snapshot, requestedLocale) {
  const allowedLocales = requestedLocale ? [requestedLocale] : ACTIVE_LOCALES;
  const compactSnapshot = {
    requestedLocale: requestedLocale || "auto",
    allowedLocales,
    sheets: snapshot.sheets.map((sheet) => ({
      sheet: sheet.sheet,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      rows: sheet.rows.slice(0, 45)
    }))
  };
  const content = await chat([
    {
      role: "system",
      content: `你是日语到简体中文的游戏本地化术语表结构分析器。源语言固定为日语，允许的目标语言 locale 只有 ${allowedLocales.join(", ")}。你只判断表格结构，绝对不能翻译、改写或补全单元格。

表格可能完全没有表头，也可能前几行是标题、说明或元数据。请根据整列的文字脚本、成对行关系、长度和内容分布，找出一列日语源文以及简体中文目标列。纯汉字日文必须结合对应行语义与整列分布判断，不能因为缺少假名或表头就拒绝。

不要把位置、描述、DDL、字符限制、语种要求、序号或日期列当成日中对照。headerRow 只有确实存在列名行时才填写，否则必须为 null。还要只根据工作表名称、表头和日语源列整体分布判断 sheetMode：dialogue=对白/字幕/剧情句段为主，glossary=独立命名词条为主，mixed=两类明显混合。目标语言译文长度不得影响 sheetMode。

如果表里另有一列写的是给译者的注释、备注、说明或用法提示（例如"不译""仅用于 UI""正式名""已废弃"），把它标为 noteColumn；没有这样的列时 noteColumn 必须为 null。禁止把位置、DDL、字符限制、语种要求、序号或日期列当成注释列。输出严格 JSON，不要 Markdown：{"sheets":[{"sheet":"原工作表名","headerRow":null,"sourceColumn":1,"targetColumns":{"zh-CN":2},"noteColumn":3,"sheetMode":"dialogue","confidence":0.9,"reason":"简短依据"}]}`
    },
    { role: "user", content: JSON.stringify(compactSnapshot) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语表结构分析模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.sheets)) throw new Error("术语表结构分析模型返回格式无效");
  return payload;
}

export async function distillStyleProfileWithModel({ locale, contentType, domain, projectLevel = false, examples, counterExamples = [], previousProfile = null, existingRules = [] }) {
  const language = LOCALE_NAMES[locale] || locale;
  const active = (existingRules || []).filter((rule) => rule.status !== "retired");
  // 项目级规范要覆盖对白、公告、UI 等混排内容：不注明适用场景的规则会被当成全局要求，
  // 于是"对白该口语"会污染公告，反之亦然。这里强制每条规则自带适用条件。
  const scopeInstruction = projectLevel
    ? `证据来自同一项目的混合内容（对白、公告、UI、道具、活动规则等混在一起）。项目级规范必须能同时服务这些场景，因此：\n`
      + `· 新规则与改写的规则都要在句首写明适用场景，例如"对白中：…""公告与活动规则：…""UI 与系统提示：…""全场景：…"；\n`
      + `· 只在某一种场景成立的现象，绝不能写成不带场景的全局规则；\n`
      + `· 确实跨场景成立的（术语一致、标点、格式、翻译腔、称谓统一）才写"全场景：…"。\n`
    : "";
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化风格资产编辑。你的产出不是重写整份规范，而是对**已有规则集**提出增量操作——规则是跨轮累积的，历史规则不会因为你这轮没提到就被删掉。\n`
        + scopeInstruction
        + `对每条已有规则，如果本批证据仍然支持它就 keep，措辞需要修正就 update，本批证据明确与它冲突才 retire（必须写明冲突在哪）。本批出现了已有规则未覆盖的稳定现象，才 add。\n`
        + `不要为了凑数而 add：只在同一现象至少出现两次时才立规则。也不要把一次性的偶然译法写成通用规则。\n\n`
        + `证据分三类，信息量不同：\n`
        + `1. change="revised"：machineDraft 是机器初稿，target 是人工改写后的定稿。**两者的差异就是这个团队的风格偏好本身**，请读出人改了什么（语气/长度/称谓/句式/标点/用词）并归纳成规则；machineDraft 一律视为不合格写法。\n`
        + `2. change="confirmed"：人工原样采纳，说明该写法已达标，但不携带改动信息。\n`
        + `3. change="imported"：外部导入的既有对照，没有经过本项目审校，权重最低。\n`
        + `counterExamples 是同事明确否决但尚未给出改写的译文，只能当反例。\n\n`
        + `规则要具体到可执行：写"句尾用敬体ます形，不用だ・である"，不要写"注意语气"。category 从 语气/句式/称谓/句尾/标点/长度/用词/格式 中选。\n`
        + `输出严格 JSON：{"operations":[{"op":"keep","id":"r-xxx"},{"op":"update","id":"r-xxx","rule":"修正后的规则","reason":"为何修正"},{"op":"add","category":"语气","rule":"新规则","reason":"依据"},{"op":"retire","id":"r-xxx","reason":"与本批哪条证据冲突"}],"summary":"本轮变化摘要"}`
    },
    {
      role: "user",
      content: JSON.stringify({
        locale, contentType, domain,
        scope: projectLevel ? "project" : "content-type",
        existingRules: active.map((rule) => ({ id: rule.id, category: rule.category, rule: rule.rule, evidenceCount: rule.evidenceCount, rounds: rule.rounds })),
        // 尚未结构化的历史规范：首次按规则蒸馏时让模型把它转成 add 操作。
        legacyInstruction: active.length ? undefined : (previousProfile?.instruction || undefined),
        examples: examples.slice(0, 200),
        counterExamples: (counterExamples || []).slice(0, 40)
      })
    }
  ], runtimeConfig, { temperature: 0.2, timeoutMs: 120_000, maxTokens: 4_000, requestLabel: "风格规则蒸馏", responseFormat: { type: "json_object" } });
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("风格精炼模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.operations)) throw new Error("风格精炼模型未返回 operations 数组");
  return {
    name: String(payload.name || `${language} ${contentType} 风格`),
    operations: payload.operations,
    summary: String(payload.summary || "")
  };
}

export async function distillBatchStyleLearningWithModel({ batchId, filename, locale, contentType, domain, examples = [] }) {
  const language = LOCALE_NAMES[locale] || locale;
  const evidence = examples.slice(0, 40).map((item) => ({
    source: String(item?.source || "").trim(),
    target: String(item?.target || "").trim(),
    rowNumber: Number(item?.rowNumber || item?.sourceRow) || null
  })).filter((item) => item.source && item.target);
  if (!evidence.length) throw new Error("批次风格学习缺少有效日中对照证据");
  const messages = [
    {
      role: "system",
      content: `你是${language}游戏本地化风格观察员。请只根据当前这一批已对齐双语句段，说明 AI 从本批“观察到了什么”。这不是已批准的正式风格规范：少量证据只能描述倾向，不能夸大为固定规则。单条证据也可以输出观察，但 caveat 必须明确证据不足，任何 confidence 不得高于 0.65。请归纳语气、句式与节奏、称谓、句尾、标点、信息顺序和长度倾向，并给出可读例子及适用边界。examples 只能逐字引用输入中的真实 source/target，不得改写。输出严格 JSON：{"summary":"本批学习摘要","rules":[{"category":"语气|句式|称谓|句尾|标点|长度|其他","observation":"从证据观察到的现象","guidance":"可供后续审核的建议","confidence":0.8}],"examples":[{"type":"positive","source":"原文","target":"译文","reason":"为何能代表本批风格"}],"caveat":"适用边界","confidence":0.8}`
    },
    { role: "user", content: JSON.stringify({ batchId, filename, locale, contentType, domain, examples: evidence }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0, timeoutMs: 90_000, maxTokens: 3200, requestLabel: "本批风格浓缩", responseFormat: { type: "json_object" } });
  let payload;
  let formatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const extracted = extractJsonObject(content);
      if (!extracted) throw new Error(describeJsonFailure(content));
      const parsed = JSON.parse(extracted);
      if (!parsed.summary || !Array.isArray(parsed.rules) || !Array.isArray(parsed.examples)) throw new Error(`缺少 summary、rules 或 examples：${describeJsonFailure(content)}`);
      payload = parsed;
      break;
    } catch (error) {
      formatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4_000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请重新输出一个更紧凑的 JSON 对象：最多 6 条 rules、3 条 examples；所有字符串使用合法 JSON 转义；不要 Markdown、代码围栏、注释或尾随逗号。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 75_000, maxTokens: 3_200, requestLabel: "本批风格浓缩格式重试", responseFormat: { type: "json_object" } });
    }
  }
  if (!payload) throw new Error(`本批风格浓缩模型返回格式无效：${formatError || "未知格式错误"}`);
  const confidenceCap = evidence.length === 1 ? 0.65 : 1;
  const evidenceKeys = new Set(evidence.map((item) => `${item.source}\u0000${item.target}`));
  const defaultCaveat = evidence.length === 1
    ? "当前只有一条对齐证据，只能作为本批次观察，尚不能形成正式风格规范。"
    : "当前结论仅代表本批次证据，需结合后续批次与人工审核后再决定是否纳入正式风格规范。";
  return {
    summary: String(payload.summary).trim(),
    rules: payload.rules.slice(0, 12).map((rule) => ({
      category: String(rule.category || "其他").trim(),
      observation: String(rule.observation || "").trim(),
      guidance: String(rule.guidance || "").trim(),
      confidence: Number(Math.min(confidenceCap, Math.max(0, Math.min(1, Number(rule.confidence) || 0))).toFixed(2))
    })).filter((rule) => rule.observation && rule.guidance),
    examples: payload.examples.slice(0, 8).map((item) => ({
      ...(item?.type ? { type: String(item.type) } : {}),
      source: String(item?.source || "").trim(),
      target: String(item?.target || "").trim(),
      reason: String(item?.reason || "支持本批次风格观察").trim()
    })).filter((item) => evidenceKeys.has(`${item.source}\u0000${item.target}`)),
    caveat: String(payload.caveat || defaultCaveat).trim() || defaultCaveat,
    confidence: Number(Math.min(confidenceCap, Math.max(0, Math.min(1, Number(payload.confidence) || 0))).toFixed(2))
  };
}

export async function distillUserProfileWithModel({ locale, examples }) {
  const language = LOCALE_NAMES[locale] || locale;
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化译者画像编辑。请只根据人工采纳的日语与简体中文对照证据，提炼该团队/译者对${language}的全局翻译偏好。只提炼跨语体稳定的习惯：称谓、句尾语气、长度倾向、标点习惯、数字与格式处理、禁用表达，并提供简短正反例。不得把某个语体的临时风格当成全局偏好。
`
        + `带 change="revised" 的证据里，machineDraft 是机器初稿、target 是人工定稿，**反复出现的同类改动才是这位译者的稳定习惯**；只在某一条里出现一次的改动不要写成规则。change="confirmed" 表示原样采纳，只说明达标。
`
        + `输出严格 JSON：{"name":"名称","instructions":"详实规则","examples":[{"type":"positive|negative","source":"原文","target":"译文或反例","reason":"原因"}]}`
    },
    { role: "user", content: JSON.stringify({ locale, examples: examples.slice(0, 30) }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("译者画像模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!payload.instructions || !Array.isArray(payload.examples)) throw new Error("译者画像模型返回格式无效");
  return { name: String(payload.name || `${language} 译者画像`), instruction: String(payload.instructions), examples: payload.examples.slice(0, 8) };
}

export async function reviewEvolutionWithModel({ locale, contentType, domain, qaRuns = [], evidence = [], previousProfile = null }) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactRuns = qaRuns.slice(0, 20).map((run) => ({
    source: run.source,
    initialTranslation: run.initialTranslation,
    finalTranslation: run.finalTranslation,
    score: run.score,
    status: run.status,
    iterations: run.iterations,
    issues: (run.issues || []).slice(0, 6)
  }));
  const compactEvidence = evidence.slice(0, 20).map((item) => ({ source: item.source, target: item.target, provenance: item.provenance }));
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化演进复盘员。复盘最近的翻译轨迹与人工采纳证据，判断：(1) 是否存在反复出现的同类风格/术语问题（trend）；(2) 现有风格规范是否需要增量补充（stylePatch，只输出补充规则，不要重写全文）；(3) 人工采纳证据与现有规范是否有冲突。没有发现就不输出对应字段。输出严格 JSON：{"stylePatch":null|{"instructions":"增量规则","examples":[{"type":"positive|negative","source":"原文","target":"译文或反例","reason":"原因"}]},"trend":[{"category":"风格|术语|准确性|格式","observation":"简短说明","count":3}],"reason":"复盘结论"}`
    },
    { role: "user", content: JSON.stringify({ locale, contentType, domain, previousProfile, qaRuns: compactRuns, evidence: compactEvidence }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("演进复盘模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  return {
    stylePatch: payload.stylePatch && payload.stylePatch.instructions ? { instruction: String(payload.stylePatch.instructions), examples: Array.isArray(payload.stylePatch.examples) ? payload.stylePatch.examples.slice(0, 8) : [] } : null,
    trend: Array.isArray(payload.trend) ? payload.trend.slice(0, 8).map((item) => ({ category: String(item.category || "其他"), observation: String(item.observation || ""), count: Number(item.count) || 1 })) : [],
    reason: String(payload.reason || "")
  };
}

export async function proposeTranslationSkillWithModel({ locale, contentType, domain, project = "default", champion, trajectories = [] }) {
  const compact = trajectories.slice(0, 40).map((item) => ({
    id: item.id,
    source: item.source,
    initialTranslation: item.initialTranslation,
    finalTranslation: item.finalTranslation,
    qaBefore: item.qaBefore,
    qaAfter: item.qaAfter,
    humanDecision: item.humanDecision,
    error: item.error || ""
  }));
  if (!compact.length) throw new Error("尚无可用于生成候选技能的翻译轨迹");
  const messages = [
    {
      role: "system",
      content: `你是本地化翻译流程改进员。你要根据同一目标语言、语体、领域和项目的真实执行轨迹，只提出一份保守、可评测的“候选翻译技能补丁”。不得更改目标语言或把其他语种规则混入；不得发明轨迹中不存在的问题；术语译法仍由术语库负责，不要把个别术语硬编码进技能。重点分析反复出现的准确性、语体、上下文、检索和 QA 修订模式。输出严格 JSON：{"name":"候选技能名","reason":"为什么提出该补丁","strategyPatch":{"prompting":{"additionalInstruction":"整体执行指导","additionalRules":["可执行规则"]},"retrieval":{"translationMemory":{"limit":5},"qaCases":{"limit":3}},"qa":{"minimumScore":90,"maximumRevisionAttempts":2},"context":{"includePreviousSegments":2,"includeNextSegments":1}},"evidenceIds":["轨迹ID"]}`
    },
    { role: "user", content: JSON.stringify({ locale, contentType, domain, project, champion, trajectories: compact }) }
  ];
  // 思考 + JSON 都要花输出预算：2200 对推理模型偏紧，一旦截断就拿不到收尾括号。
  // 思考 + JSON 都要花输出预算：2200 对推理模型偏紧，实测会退化成"把提示词里的示例原样抄回来"。
  let content = await chat(messages, runtimeConfig, { temperature: 0.1, timeoutMs: 90_000, maxTokens: 4_000, requestLabel: "翻译技能复盘", responseFormat: { type: "json_object" } });
  let payload;
  let formatError = "";
  const validIds = new Set(compact.map((item) => item.id));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const extracted = extractJsonObject(content);
      if (!extracted) throw new Error(describeJsonFailure(content));
      const parsed = JSON.parse(extracted);
      if (!parsed.strategyPatch || typeof parsed.strategyPatch !== "object") throw new Error(`缺少 strategyPatch：${describeJsonFailure(content)}`);
      const cited = (Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds : []).map(String).filter((id) => validIds.has(id));
      // 输出预算紧张时模型会把提示词里的示例 JSON 原样抄回来（name="候选技能名"、evidenceIds=[]）。
      // 没有引用任何一条真实轨迹的补丁等于凭空提案，不能入库：按格式失败走同一套重试。
      if (!cited.length) throw new Error("补丁没有引用任何一条真实轨迹（疑似把提示词里的示例抄了回来）");
      payload = { ...parsed, evidenceIds: cited };
      break;
    } catch (error) {
      formatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4_000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，必须包含 name、reason、strategyPatch、evidenceIds；不要 Markdown、代码围栏、思考过程、注释或尾随逗号。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 75_000, maxTokens: 3_000, requestLabel: "翻译技能复盘格式重试", responseFormat: { type: "json_object" } });
    }
  }
  if (!payload) throw new Error(`翻译技能复盘模型返回格式无效：${formatError || "未知格式错误"}`);
  return {
    name: String(payload.name || `${LOCALE_NAMES[locale] || locale} ${contentType} 候选技能`).slice(0, 120),
    reason: String(payload.reason || "根据近期翻译轨迹提出的增量改进").slice(0, 2_000),
    strategyPatch: payload.strategyPatch,
    evidenceIds: [...new Set(payload.evidenceIds)].slice(0, 100)
  };
}

/**
 * 门禁复盘驱动的技能改写：输入是复盘报告 + 失败案例（含人工终稿），
 * 输出与「生成候选技能」完全同形状的策略补丁，之后走同一条净化与评测链路。
 */
export async function proposeSkillPatchFromGateReview({ locale, contentType = "general", domain = "general", project = "default", champion = null, review = {}, cases = [] }) {
  const compact = (Array.isArray(cases) ? cases : []).slice(0, 40).map((item) => ({
    caseId: item.caseId,
    kind: item.kind,
    source: String(item.source || "").slice(0, 300),
    candidateTranslation: String(item.candidateTranslation || "").slice(0, 300),
    expectedTranslation: String(item.expectedTranslation || "").slice(0, 300),
    reason: String(item.reason || "").slice(0, 200)
  }));
  if (!compact.length) throw new Error("这次门禁没有失败样本，没有可用于改写的依据");
  const patterns = (Array.isArray(review?.patterns) ? review.patterns : []).map((pattern) => ({
    id: pattern.id, label: pattern.label, kind: pattern.kind, caseIds: pattern.caseIds,
    reason: pattern.reason, suggestion: pattern.suggestion, proposedRule: pattern.proposedRule
  }));
  const messages = [
    {
      role: "system",
      content: `你是本地化翻译流程改进员。这次给你的不是普通轨迹，而是一次**发版门禁的失败复盘**：候选技能在这些固定样本上仍然犯错，被人工终稿否决。你要据此提出一份保守、可评测的“候选翻译技能补丁”。不得更改目标语言，不得把个别术语硬编码进技能（术语由术语库负责），不得发明复盘里没有依据的规则。优先把复盘里的 proposedRule 变成可执行、可判定的规则。输出严格 JSON：{"name":"候选技能名","reason":"为什么提出该补丁","strategyPatch":{"prompting":{"additionalInstruction":"整体执行指导","additionalRules":["可执行规则"]},"retrieval":{"translationMemory":{"limit":5},"qaCases":{"limit":3}},"qa":{"minimumScore":90,"maximumRevisionAttempts":2},"context":{"includePreviousSegments":2,"includeNextSegments":1}},"evidenceIds":["失败案例的 caseId"]}`
    },
    { role: "user", content: JSON.stringify({ locale, contentType, domain, project, champion, review: { summary: review?.summary || "", patterns }, failures: compact }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0.1, timeoutMs: 90_000, maxTokens: 4_000, requestLabel: "门禁复盘改写技能", responseFormat: { type: "json_object" } });
  let payload = null;
  let formatError = "";
  const validCaseIds = new Set(compact.map((item) => String(item.caseId)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const extracted = extractJsonObject(content);
      if (!extracted) throw new Error(describeJsonFailure(content));
      const parsed = JSON.parse(extracted);
      if (!parsed.strategyPatch || typeof parsed.strategyPatch !== "object") throw new Error(`缺少 strategyPatch：${describeJsonFailure(content)}`);
      const cited = (Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds : []).map(String).filter((id) => validCaseIds.has(id));
      // 没有引用任何一条真实失败案例的补丁等于凭空提案，按格式失败处理。
      if (!cited.length) throw new Error("补丁没有引用任何一条失败案例（疑似把提示词里的示例抄了回来）");
      payload = { ...parsed, evidenceIds: cited };
      break;
    } catch (error) {
      formatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: String(content || "").slice(0, 4_000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，必须包含 name、reason、strategyPatch、evidenceIds；不要 Markdown、代码围栏、思考过程、注释或尾随逗号。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 75_000, maxTokens: 3_000, requestLabel: "门禁复盘改写技能格式重试", responseFormat: { type: "json_object" } });
    }
  }
  if (!payload) throw new Error(`门禁复盘改写技能模型返回格式无效：${formatError || "未知格式错误"}`);
  return {
    name: String(payload.name || `${LOCALE_NAMES[locale] || locale} ${contentType} 门禁复盘候选技能`).slice(0, 120),
    reason: String(payload.reason || "根据门禁失败复盘提出的增量改进").slice(0, 2_000),
    strategyPatch: payload.strategyPatch,
    caseIds: [...new Set(payload.evidenceIds)].slice(0, 100)
  };
}

export async function evaluateTranslationWithModel({ contextPack, translation, references = [], machineDrafts = [], qaCases = [], onUsage = null, temperature = 0.1, seed = undefined, onSeedUnsupported = null }) {
  const messages = [
    {
      role: "system",
      content: `你是独立于翻译器的亚洲语言本地化 QA 审校员。按照 MQM 思路逐项检查六个一级维度：Accuracy、Fluency、Terminology、Style、Locale、Platform。category 必须以小写一级维度开头，可细分为 accuracy_omission、accuracy_addition、accuracy_mistranslation、fluency_grammar、fluency_naturalness、terminology_required、terminology_forbidden、style_register、style_brand、locale_convention、platform_constraint、platform_placeholder。contextPack.styleProfile.reviewRubric 是评审标准，不是生成提示。contextPack.preferredTerms 中 matchMode 为 exact 只代表字面精确命中；你必须根据原文句义和上下文判断该条正式术语在此处是否适用，不能仅因译文未采用登记译法就报错。approvedReferences 是人工批准的译例，只有同语种、同语体且语义相关时才引用，且仍不能盲从。machineDrafts 是本系统自己此前产出的机器译文，只能用于发现同一文档内自相矛盾，绝不能当作正确与否的依据，也不得以"与 machineDrafts 不一致"为由报告问题。不要直接给总分，只报告可定位的问题。严重度只能是 critical、major、minor。message、suggestion 和其他解释性字段必须全部使用简体中文，禁止用目标语言解释问题；sourceSpan、targetSpan 必须逐字保留原文或译文中的证据片段。特别注意：只有语义确实丢失或凭空添加事实才算漏译/增译；调整语序、换用同义地道表达、重写修辞都不是问题。发现译文逐字直译、翻译腔、不像目标语言原生文案时，记 major（category 用 fluency_naturalness）。原文含押韵、对仗、重复或口号结构时，译文必须用目标语言自然重现节奏与韵律；机械逐字重复、把闲散语气译成命令口吻、韵律完全丢失都应记 major。若输入里的 contextPack 携带 batchVerse 或 batchReferences（同批排比韵文），必须检查当前译文与本批已定稿译文的句式、节奏与用词风格是否一致，明显不一致记 major。没有问题返回空数组。输出严格 JSON：{"issues":[{"severity":"major","category":"accuracy_omission","sourceSpan":"原文片段","targetSpan":"译文片段","message":"简体中文问题原因","suggestion":"简体中文可执行修订意见","evidenceMemoryId":"可选ID","confidence":0.9}]}`
    },
    {
      role: "user",
      content: [
        contextPackText(contextPack, "review"),
        `待审译文：\n${translation}`,
        `人工批准译例（只有同语种、同用途且语义相关时才可引用，且不能盲从）：${JSON.stringify(references.slice(0, 5))}`,
        `本系统此前的机器译文（只能用于发现同一文档内自相矛盾，不得当作正确与否的依据）：${JSON.stringify(machineDrafts.slice(0, 3))}`,
        `历史反例：${JSON.stringify(qaCases.slice(0, 3))}`
      ].join("\n\n")
    }
  ];
  let content = await chat(messages, runtimeConfig, { temperature, seed, onSeedUnsupported, timeoutMs: 75_000, maxTokens: 1800, requestLabel: "AIQA", responseFormat: { type: "json_object" }, onUsage });
  let payload;
  let lastFormatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      payload = parseAiQaResponse(content);
      break;
    } catch (error) {
      lastFormatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，根字段必须是 issues 数组，不要 Markdown、解释或代码围栏。" }
      ], runtimeConfig, { temperature: 0, seed, onSeedUnsupported, timeoutMs: 45_000, maxTokens: 1800, requestLabel: "AIQA 格式重试", responseFormat: { type: "json_object" }, onUsage });
    }
  }
  if (!payload) {
    const lineContent = await chat([
      {
        role: "system",
        content: "你是本地化 QA。不要输出 JSON。若没有问题只输出 PASS；若有问题，每个问题单独一行，严格使用：ISSUE|critical/major/minor|英文类别代码|原文片段|译文片段|简体中文问题原因|简体中文修订建议。问题原因和修订建议禁止使用目标语言。不得输出其他内容。"
      },
      {
        role: "user",
        content: [
          contextPackText(contextPack, "review"),
          `待审译文：\n${translation}`,
          `人工批准译例：${JSON.stringify(references.slice(0, 3))}`,
          `历史反例：${JSON.stringify(qaCases.slice(0, 2))}`
        ].join("\n\n")
      }
    ], runtimeConfig, { temperature: 0, seed, onSeedUnsupported, timeoutMs: 60_000, maxTokens: 1600, requestLabel: "AIQA 行式降级", onUsage });
    try {
      payload = { issues: parseAiQaLineResponse(lineContent) };
    } catch (error) {
      throw new Error(`AIQA 返回无法解析（JSON：${lastFormatError || "未知"}；行式：${error.message}）`);
    }
  }
  return payload.issues.slice(0, 30).map((issue) => ({
    severity: ["critical", "major", "minor"].includes(issue.severity) ? issue.severity : "major",
    category: String(issue.category || "other"),
    sourceSpan: String(issue.sourceSpan || ""),
    targetSpan: String(issue.targetSpan || ""),
    message: String(issue.message || "未说明问题"),
    suggestion: String(issue.suggestion || ""),
    evidenceMemoryId: String(issue.evidenceMemoryId || ""),
    confidence: Math.max(0, Math.min(1, Number(issue.confidence) || 0.5)),
    source: "aiqa"
  }));
}

/**
 * Auto QA 三层模型审校：basic 基本检查、fidelity 语义忠实性（着重）、nuance 细微一致性。
 * 单次调用返回带 dimension 的问题列表；解析失败走行式降级，最终失败抛错由调用方记录。
 */
export async function evaluateAutoQaWithModel({ source, translation, locale, contentType = "general", domain = "general", styleProfile = null, references = [], machineDrafts = [], qaCases = [], evidence = [], onUsage = null, toolRunner = null }) {
  const evidencePayload = {
    source, translation, locale, contentType, domain,
    multiSentence: String(source).includes("\n"),
    styleProfile: styleProfile ? { name: styleProfile.name, version: styleProfile.version, instruction: styleProfile.instruction, reviewRubric: styleProfile.reviewRubric || null, examples: styleProfile.examples } : null,
    // approvedReferences 是唯一可以充当"标准"的一档；machineDrafts 只是本系统
    // 自己此前的输出，拿它当依据会让一次错误在下一次评审里变成规范。
    approvedReferences: references.slice(0, 5),
    machineDrafts: machineDrafts.slice(0, 3),
    qaCases: qaCases.slice(0, 3),
    evidence: evidence.slice(0, 6)
  };
  const messages = [
    {
      role: "system",
      content: `你是独立于译者的亚洲语言本地化 Auto QA 审校员，对一条已完成译文做三层审查，语义忠实性是最高优先级。只报告可定位的问题，不要给总分：

1) basic 基本检查：目标语言拼写错误、语法错误、数字/日期/符号与原文不符、专名与品牌名在句内前后不一致。
2) fidelity 语义忠实性（着重检查项）：只检查**信息点**是否守住。信息点指可以被独立核实的内容：事实陈述、数字、日期、时间、金额、名称与专名、平台与渠道、条件与限制、因果或先后关系、否定与转折、承诺强度。判定方法固定为两步：先从原文列出信息点，再逐个检查该信息点能否从译文中还原；只有还原不出、被改变、或译文凭空多出一个原文没有的信息点，才是 fidelity 问题，且必须在 message 里指名是哪一个信息点。必须同时给出原文片段 sourceSpan 与译文片段 targetSpan 作为证据。
以下一律**不是** fidelity 问题，不得记为漏译、增译或语义偏差（属于合格本地化，至多在 nuance 记 minor）：
· 日语主语、助词、敬体语尾和省略成分按简体中文自然语法改写或吸收
· 程度与强调表达换成简体中文等价强度的说法，不机械逐词对应
· 日语中重复的专名、代词和冗余限定按中文可读性显化、代词化或省略
· 句子拆分、合并、语序调整、主被动转换，以及疑问句按简体中文习惯改写
· 语气词、拟声词、客套与自嘲换成简体中文等价口吻
· 日语四字熟语、对仗、夸张修辞换成简体中文等效表达
severity：critical 只用于事实层面的丢失或捏造——整句未译、数字/日期/名称/平台错误、条件或否定被改变、承诺强度被改变。信息点仍在但语义范围有出入记 major；措辞偏好记 minor。
特别重要：若原文包含多个句子（用换行分隔），必须逐句核对译文是否覆盖每一句的信息，任何一句未译出都要记 critical omission，不得因为其他句子译出了就认为完整。
3) nuance 细微一致性：敬语级别、语气词、正式度、句式节奏是否与提供的风格规范、approvedReferences（人工批准的译例）、历史风格证据一致。有证据时优先对照证据判断；没有证据时按目标语言自然习惯判断。细微差异记 minor，明显违反记 major。
输入中的 machineDrafts 是本系统此前自己产出的机器译文，**只能用于判断同一文档内前后是否自相矛盾，绝不能当作正确与否的依据**；不得以"与 machineDrafts 不一致"为由报告任何问题，也不得把 machineDrafts 里的用词、术语或标点当成规范。

输出语言要求：category 使用简短英文代码；message、suggestion 和所有解释性字段必须全部使用简体中文，禁止用目标语言解释问题；sourceSpan、targetSpan 只用于逐字引用原文或译文证据，可以保留对应语言。

severity 只能是 critical、major、minor；dimension 只能是 basic、fidelity、nuance。没有问题必须返回 {"issues":[]}；禁止输出空白、纯文本说明或 Markdown。输出严格 JSON：{"issues":[{"dimension":"fidelity","severity":"critical","category":"omission","sourceSpan":"原文片段","targetSpan":"译文片段","message":"简体中文问题原因","suggestion":"简体中文可执行修订意见","confidence":0.9}]}`
    },
    { role: "user", content: JSON.stringify(evidencePayload) }
  ];
  const qaOptions = { temperature: 0.1, timeoutMs: 75_000, maxTokens: 1800, requestLabel: "Auto QA", responseFormat: { type: "json_object" }, onUsage };
  // 质检也可以按需查资料（核对角色名、设定、剧情一致性），但只给一轮工具调用。
  let content = toolRunner?.tools?.length
    ? (await chatWithTools(messages, runtimeConfig, {
      ...qaOptions,
      tools: toolRunner.tools,
      maxRounds: 1,
      executeTool: toolRunner.execute,
      onActivity: toolRunner.onActivity
    })).content
    : await chat(messages, runtimeConfig, qaOptions);
  let payload;
  let lastFormatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      payload = parseAiQaResponse(content);
      break;
    } catch (error) {
      lastFormatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4_000) || "(空白)" },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，根字段必须是 issues 数组；若没有问题输出 {\"issues\":[]}。不要输出空白、Markdown、解释或代码围栏。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 45_000, maxTokens: 1800, requestLabel: "Auto QA 格式重试", responseFormat: { type: "json_object" }, onUsage });
    }
  }
  if (!payload) {
    // 针对“返回空白”的抢救：明确要求必须产出 JSON
    content = await chat([
      ...messages,
      { role: "assistant", content: content.slice(0, 200) || "(空白)" },
      { role: "user", content: "你上一次的回复是空白。必须输出一个 JSON 对象；若没有问题，输出 {\"issues\":[]}。禁止输出空白。" }
    ], runtimeConfig, { temperature: 0, timeoutMs: 45_000, maxTokens: 1200, requestLabel: "Auto QA 空白抢救", responseFormat: { type: "json_object" }, onUsage });
    if (!String(content).trim()) {
      // 推理模型在“无问题”场景下可能只返回空白：空白按无问题处理
      payload = { issues: [] };
    } else {
      try {
        payload = parseAiQaResponse(content);
      } catch (error) {
        lastFormatError = error.message;
      }
    }
  }
  if (!payload) {
    const lineContent = await chat([
      {
        role: "system",
        content: "你是本地化 Auto QA。不要输出 JSON。若没有问题必须只输出 PASS 这一行；若有问题，每个问题单独一行，严格使用：ISSUE|dimension|critical/major/minor|英文类别代码|原文片段|译文片段|简体中文问题原因|简体中文修订建议。dimension 只能是 basic、fidelity、nuance；问题原因和修订建议禁止使用目标语言。禁止输出空白或任何其他内容。"
      },
      { role: "user", content: JSON.stringify({ source, translation, locale, contentType, domain, references: references.slice(0, 3), qaCases: qaCases.slice(0, 2), evidence: evidence.slice(0, 4) }) }
    ], runtimeConfig, { temperature: 0, timeoutMs: 60_000, maxTokens: 1600, requestLabel: "Auto QA 行式降级", onUsage });
    if (!String(lineContent).trim()) {
      payload = { issues: [] };
    } else {
      try {
        payload = { issues: parseAutoQaLineResponse(lineContent) };
      } catch (error) {
        throw new Error(`Auto QA 返回无法解析（JSON：${lastFormatError || "未知"}；行式：${error.message}）`);
      }
    }
  }
  return payload.issues.slice(0, 40).map((issue) => ({
    dimension: ["basic", "fidelity", "nuance"].includes(issue.dimension)
      ? issue.dimension
      : String(issue.category || "").startsWith("basic") ? "basic" : String(issue.category || "").startsWith("nuance") ? "nuance" : "fidelity",
    severity: ["critical", "major", "minor"].includes(issue.severity) ? issue.severity : "major",
    category: String(issue.category || "other"),
    sourceSpan: String(issue.sourceSpan || ""),
    targetSpan: String(issue.targetSpan || ""),
    message: String(issue.message || "未说明问题"),
    suggestion: String(issue.suggestion || ""),
    confidence: Math.max(0, Math.min(1, Number(issue.confidence) || 0.5)),
    source: "autoqa"
  }));
}

export function parseAutoQaLineResponse(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("模型返回空内容");
  if (noIssueResponse(trimmed)) return [];
  const issues = trimmed.split(/\r?\n/u).map((line) => line.trim().replace(/^[-*•\d.)、\s]+/u, "")).filter((line) => /^ISSUE\s*[|｜]/iu.test(line)).map((line) => {
    const [, dimension = "fidelity", severity = "major", category = "other", sourceSpan = "", targetSpan = "", message = "", suggestion = ""] = line.split(/[|｜]/u).map((item) => item.trim());
    return { dimension, severity, category, sourceSpan, targetSpan, message, suggestion, confidence: 0.8 };
  }).filter((issue) => issue.message);
  if (issues.length) return issues;
  return [{
    dimension: "fidelity",
    severity: "major",
    category: "unstructured_review",
    sourceSpan: "",
    targetSpan: "",
    message: trimmed.slice(0, 800),
    suggestion: "根据该审校意见进行修订",
    confidence: 0.65
  }];
}

/**
 * 校验模型返回的对齐方案：每个原文索引与译文索引必须恰好出现一次。
 * 返回规范化的 { pairs, unmatchedSource, unmatchedTranslation }，无效则返回 null。
 */
export function validateAlignmentPlan(plan, sourceCount, translationCount) {
  const n = Number(sourceCount) || 0;
  const m = Number(translationCount) || 0;
  if (!plan || typeof plan !== "object") return null;
  const pairs = Array.isArray(plan.pairs) ? plan.pairs : [];
  const unmatchedSource = Array.isArray(plan.unmatchedSource) ? plan.unmatchedSource : [];
  const unmatchedTranslation = Array.isArray(plan.unmatchedTranslation) ? plan.unmatchedTranslation : [];
  const seenSource = new Set();
  const seenTranslation = new Set();
  const cleanPairs = [];
  for (const pair of pairs) {
    const sourceIndices = Array.isArray(pair?.sourceIndices) ? pair.sourceIndices.map(Number) : [];
    const translationIndices = Array.isArray(pair?.translationIndices) ? pair.translationIndices.map(Number) : [];
    if (!sourceIndices.length || !translationIndices.length) return null;
    for (const index of [...sourceIndices, ...translationIndices]) {
      if (!Number.isInteger(index)) return null;
    }
    if (sourceIndices.some((index) => index < 0 || index >= n)) return null;
    if (translationIndices.some((index) => index < 0 || index >= m)) return null;
    for (const index of sourceIndices) {
      if (seenSource.has(index)) return null;
      seenSource.add(index);
    }
    for (const index of translationIndices) {
      if (seenTranslation.has(index)) return null;
      seenTranslation.add(index);
    }
    cleanPairs.push({ sourceIndices: [...new Set(sourceIndices)].sort((a, b) => a - b), translationIndices: [...new Set(translationIndices)].sort((a, b) => a - b) });
  }
  for (const index of unmatchedSource.map(Number)) {
    if (!Number.isInteger(index) || index < 0 || index >= n || seenSource.has(index)) return null;
    seenSource.add(index);
  }
  for (const index of unmatchedTranslation.map(Number)) {
    if (!Number.isInteger(index) || index < 0 || index >= m || seenTranslation.has(index)) return null;
    seenTranslation.add(index);
  }
  if (seenSource.size !== n || seenTranslation.size !== m) return null;
  cleanPairs.sort((a, b) => Math.min(...a.sourceIndices) - Math.min(...b.sourceIndices));
  return {
    pairs: cleanPairs,
    unmatchedSource: unmatchedSource.map(Number).sort((a, b) => a - b),
    unmatchedTranslation: unmatchedTranslation.map(Number).sort((a, b) => a - b)
  };
}

/**
 * 用模型做逐句对齐（Embedding 不可用时的回退方案），返回与 alignSegmentPairs 相同的结构。
 * 失败或结果无效时返回 null，由调用方继续降级到按位置配对。
 */
export async function alignSegmentsWithModel({ sourceSegments, translationSegments, locale, onUsage = null }) {
  const messages = [
    {
      role: "system",
      content: "你是双语逐句对齐助手。原文已按句拆成 sourceSegments，译文已按句拆成 translationSegments（数组元素带 index 与 text）。请把表达相同内容的片段配对：一个原文片段可对应多个连续译文片段（译文拆句），多个连续原文片段也可对应一个译文片段（合并）；在原文中没有对应内容的译文片段记入 unmatchedTranslation（疑似增译），在译文中没有对应内容的原文片段记入 unmatchedSource（疑似漏译）。只有译文确实包含该原文片段的信息时才配对；严禁为了覆盖全部索引而把内容缺失的句子强行合并进相邻配对。示例：原文 3 句（A：游戏介绍 / B：研发中并发布CG / C：实机演示公开），译文 2 句（a：游戏介绍 / b：实机演示公开）时，正确输出是 pairs=[[A↔a],[C↔b]]、unmatchedSource=[B]、unmatchedTranslation=[]，而不是把 A+B 合并到 a。每个索引必须恰好出现一次。只输出严格 JSON：{\"pairs\":[{\"sourceIndices\":[0],\"translationIndices\":[0]}],\"unmatchedSource\":[],\"unmatchedTranslation\":[]}。禁止空白、解释或 Markdown。"
    },
    {
      role: "user",
      content: JSON.stringify({
        locale,
        sourceSegments: sourceSegments.map((text, index) => ({ index, text })),
        translationSegments: translationSegments.map((text, index) => ({ index, text }))
      })
    }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0, timeoutMs: 75_000, maxTokens: 1600, requestLabel: "Auto QA 句对齐", responseFormat: { type: "json_object" }, onUsage });
  let plan = null;
  for (let attempt = 0; attempt < 3 && !plan; attempt += 1) {
    try {
      const match = String(content).match(/\{[\s\S]*\}/);
      if (!match) throw new Error("未返回 JSON 对象");
      plan = validateAlignmentPlan(JSON.parse(match[0]), sourceSegments.length, translationSegments.length);
      if (!plan) throw new Error("对齐方案索引无效");
    } catch (error) {
      if (attempt === 2) return null;
      content = await chat([
        ...messages,
        { role: "assistant", content: String(content || "").slice(0, 2_000) || "(空白)" },
        { role: "user", content: "上一个回答无效或无法解析。请重新输出一个完整 JSON 对象：pairs / unmatchedSource / unmatchedTranslation 三处必须恰好覆盖全部索引，禁止空白。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 45_000, maxTokens: 1600, requestLabel: "Auto QA 句对齐重试", responseFormat: { type: "json_object" }, onUsage });
    }
  }
  return plan;
}

/**
 * 语言正确性专项审查：只看译文本身，不对比原文、不评价翻译质量。
 * 检查拼写、语法、标点与空格，输出归入 basic 维度。
 */
export async function evaluateGrammarWithModel({ translation, locale, contentType = "general", onUsage = null }) {
  const language = LOCALE_NAMES[locale] || locale;
  const grammarChecklist = locale === "zh-CN"
    ? "错别字、成分搭配、语序、虚词、量词、指代、时态表达、中文标点和不当空格"
    : "拼写/错字、语法错误（助词、时态、敬语一致、语序）、标点错误、空格错误";
  const messages = [
    {
      role: "system",
      content: `你是${language}母语级语言审校员。只检查译文本身的语言正确性，不对比原文、不评价翻译质量、不讨论用词偏好。逐项检查：${grammarChecklist}。每一条给出错误片段 span、原因 message、可执行修改建议 suggestion。span 必须逐字引用${language}译文；category 使用 grammar、spelling、punctuation、orthography、spacing 中的英文代码；message 和 suggestion 必须全部使用简体中文，禁止用${language}解释问题。severity 只能是 critical、major、minor：句子完全无法理解或根本不是${language}才记 critical，明确语法/拼写错误记 major，其他不自然处记 minor。没有问题必须返回 {"issues":[]}；禁止输出空白、纯文本说明或 Markdown。输出严格 JSON：{"issues":[{"severity":"major","category":"grammar","span":"目标语言错误片段","message":"简体中文问题原因","suggestion":"简体中文修改建议","confidence":0.9}]}`
    },
    { role: "user", content: JSON.stringify({ translation, locale, contentType }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0.05, timeoutMs: 60_000, maxTokens: 1400, requestLabel: "Auto QA 语法专项", responseFormat: { type: "json_object" }, onUsage });
  let payload;
  let lastFormatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      payload = parseAiQaResponse(content);
      break;
    } catch (error) {
      lastFormatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 3_000) || "(空白)" },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，根字段必须是 issues 数组；若没有问题输出 {\"issues\":[]}。禁止空白。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 45_000, maxTokens: 1400, requestLabel: "Auto QA 语法专项重试", responseFormat: { type: "json_object" }, onUsage });
    }
  }
  if (!payload) {
    const lineContent = await chat([
      {
        role: "system",
        content: `你是${language}语言审校。不要输出 JSON。若没有问题必须只输出 PASS 这一行；若有问题，每个问题单独一行，严格使用：ISSUE|critical/major/minor|英文类别代码|${language}错误片段|简体中文问题原因|简体中文修改建议。问题原因和修改建议禁止使用${language}。禁止输出空白或其他内容。`
      },
      { role: "user", content: JSON.stringify({ translation, locale, contentType }) }
    ], runtimeConfig, { temperature: 0, timeoutMs: 45_000, maxTokens: 1200, requestLabel: "Auto QA 语法行式降级", onUsage });
    if (!String(lineContent).trim()) {
      payload = { issues: [] };
    } else {
      try {
        payload = { issues: parseGrammarLineResponse(lineContent) };
      } catch (error) {
        throw new Error(`语法专项返回无法解析（JSON：${lastFormatError || "未知"}；行式：${error.message}）`);
      }
    }
  }
  return payload.issues.slice(0, 20).map((issue) => ({
    dimension: "basic",
    severity: ["critical", "major", "minor"].includes(issue.severity) ? issue.severity : "major",
    category: ["grammar", "spelling", "punctuation", "orthography", "spacing"].includes(issue.category) ? issue.category : "grammar",
    sourceSpan: "",
    targetSpan: String(issue.span || issue.targetSpan || ""),
    message: String(issue.message || "未说明问题"),
    suggestion: String(issue.suggestion || ""),
    confidence: Math.max(0, Math.min(1, Number(issue.confidence) || 0.5)),
    source: "grammar"
  }));
}

export function parseGrammarLineResponse(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("模型返回空内容");
  if (noIssueResponse(trimmed)) return [];
  const issues = trimmed.split(/\r?\n/u).map((line) => line.trim().replace(/^[-*•\d.)、\s]+/u, "")).filter((line) => /^ISSUE\s*[|｜]/iu.test(line)).map((line) => {
    const [, severity = "major", category = "grammar", span = "", message = "", suggestion = ""] = line.split(/[|｜]/u).map((item) => item.trim());
    return { severity, category, span, message, suggestion, confidence: 0.8 };
  }).filter((issue) => issue.message);
  if (issues.length) return issues;
  return [{
    severity: "major",
    category: "grammar",
    span: "",
    message: trimmed.slice(0, 800),
    suggestion: "根据该语言审校意见修订",
    confidence: 0.65
  }];
}

/**
 * 用一个极小请求验证模型服务、鉴权和余额，避免每个分享段落重复撞同一故障。
 *
 * `config` 用于「模型设置 → 测试连接」：面板里刚改、还没保存的地址/密钥也要能试，
 * 所以允许显式覆盖 baseUrl / apiKey / model；不传就测当前生效配置。
 */
export async function probeModelAvailability({ timeoutMs = 20_000, onUsage = null, config = null } = {}) {
  const target = config ? withMainThinking({ ...runtimeConfig, ...config }) : runtimeConfig;
  const content = await chat([
    { role: "system", content: "这是服务可用性检查。不要解释，只回复 OK。" },
    { role: "user", content: "ping" }
  ], target, {
    temperature: 0,
    timeoutMs: Math.max(5_000, Math.min(60_000, Number(timeoutMs) || 20_000)),
    // 推理模型可能先消耗少量 reasoning token；8 token 会偶发在输出 OK 前耗尽。
    // chat() 遇到 length 还会将此预算翻倍重试一次。
    maxTokens: 64,
    requestLabel: "分享拆解可用性探针",
    reasoningEffort: "low",
    onUsage
  });
  if (!String(content || "").trim()) throw new Error("模型可用性探针返回空白");
  return true;
}

/**
 * 语素拆解 + 直译：帮助不懂目标语言的中文读者理解译文。
 * 词块 surface 必须完整覆盖译文（由调用方用 validateGlossTokens 校验的版本在这里直接校验），
 * 失败返回 null，由调用方降级为“无拆解”。
 */
/**
 * 扫描页识图：把 PDF 渲染出的页面图片交给模型逐字转录。
 * 只做转录，不做翻译——参考资料要保持原文，检索与引用都以原文为准。
 */
export async function extractTextFromImageWithModel({ base64, mediaType = "image/png", onUsage = null, detail = "low", timeoutMs = 120_000 } = {}) {
  const content = String(base64 || "").trim();
  if (!content) return "";
  return await chat([
    { role: "system", content: "你是资料转录助手。逐字转录图片中的全部文字，保留标题、段落与编号；只输出转录结果，不要解释、不要翻译、不要总结。" },
    {
      role: "user",
      content: [
        { type: "text", text: "转录这一页的全部文字。" },
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${content}`, detail } }
      ]
    }
  ], configForRole("main"), { temperature: 0, timeoutMs, requestLabel: "资料识图", onUsage });
}

export async function glossTranslationWithModel({ translation, locale, onUsage = null }) {
  const language = LOCALE_NAMES[locale] || locale;
  const messages = [
    {
      role: "system",
      content: `你是${language}语言学教师。把译文逐词/逐语素拆解，帮助不懂${language}的中文读者理解：tokens 数组必须按译文顺序列出每个词块；surface 尽量取自译文里原样出现的连续片段（全部 surface 按顺序拼接并去掉空白后应尽量等于译文本身）；pos 是简短词性/语法标签（如 助词/动词/名词/形容词/敬语/助动词）；gloss 是该词块的中文对译；literal 必须是一句连贯的中文字面直译——把每个词块的意思按原文语序连成通顺度尚可的一句话，助词、语尾等语法成分融进句子里（例如把「主格助词」直接体现为句子里的主语关系，把「宾语助词」体现为「把/被」等结构），禁止用空格把词块释义拼成一串，禁止在 literal 里出现「助词」「语尾」「宾格」「主格」等标签字样；note 可选，一句话说明关键语法点。按常见教材切分即可，不要纠结语言学争议、不要长篇推演、不要思考过程，直接输出。只输出严格 JSON：{"tokens":[{"surface":"新しい","pos":"形容词","gloss":"新的"}],"literal":"新的通行证登场了（敬体）","note":"が 是主格助词"}，禁止空白或 Markdown。`
    },
    { role: "user", content: JSON.stringify({ translation, locale }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0.05, timeoutMs: 120_000, maxTokens: 3200, requestLabel: "Auto QA 语素拆解", responseFormat: { type: "json_object" }, reasoningEffort: "low", onUsage });
  let result = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const match = String(content || "").match(/\{[\s\S]*\}/);
      if (!match) throw new Error("未返回 JSON 对象");
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.tokens) || !parsed.tokens.length) throw new Error("tokens 为空");
      const coverage = glossCoverage({ translation, tokens: parsed.tokens });
      let literal = String(parsed.literal || "").slice(0, 500);
      let literalNote = "";
      if (isGlossDumpLiteral(literal)) {
        if (attempt === 0) throw new Error("literal 为词块释义拼接");
        literal = "";
        literalNote = "字面直译未通过连贯性检查，已隐藏；请参考上方逐词拆解。";
      }
      const noteParts = [String(parsed.note || "").slice(0, 300), literalNote].filter(Boolean);
      result = {
        tokens: parsed.tokens.slice(0, 80).map((token) => ({
          surface: String(token.surface || "").slice(0, 60),
          pos: String(token.pos || "").slice(0, 30),
          gloss: String(token.gloss || "").slice(0, 80)
        })),
        literal,
        note: noteParts.join(" "),
        // 近似拆解：词块未能严格覆盖译文时标记，前端显示“仅供参考”
        approximate: coverage < 1
      };
      break;
    } catch {
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: String(content || "").slice(0, 3_000) || "(空白)" },
        { role: "user", content: "上一个回答无效。请直接重新输出 JSON：tokens 的 surface 尽量取自译文原文，按顺序拼接（去空白）后尽量等于译文；literal 必须是连贯的中文句子（把助词、语尾融入句中，如「新的通行证登场了（敬体）」，或「黑色神话钟馗的15分钟游戏内演示影像被公开了」），严禁用空格拼接词块释义，严禁出现「助词/语尾/宾格/主格」等标签字样。不要思考过程，直接输出。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 90_000, maxTokens: 3200, requestLabel: "Auto QA 语素拆解重试", responseFormat: { type: "json_object" }, reasoningEffort: "low", onUsage });
    }
  }
  return result;
}

function noIssueResponse(content) {
  const trimmed = String(content || "").trim();
  if (/^(?:PASS|OK|无问题|問題なし|問題ありません)[。.!！\s]*$/iu.test(trimmed)) return true;
  return trimmed.length <= 240 && /(?:未发现|没有发现|不存在).{0,12}(?:明显|实质性|需要修订的)?问题|无需(?:进行)?修改|符合(?:全部)?要求|問題は(?:見つかり|あり)ません/iu.test(trimmed);
}

export function parseAiQaResponse(content) {
  const trimmed = String(content || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (!trimmed) throw new Error("模型返回空内容");
  if (noIssueResponse(trimmed)) return { issues: [] };
  const candidates = [trimmed];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return { issues: parsed };
      if (Array.isArray(parsed?.issues)) return parsed;
    } catch {}
  }
  throw new Error("缺少有效 issues JSON");
}

export function parseAiQaLineResponse(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("模型返回空内容");
  if (noIssueResponse(trimmed)) return [];
  const issues = trimmed.split(/\r?\n/u).map((line) => line.trim().replace(/^[-*•\d.)、\s]+/u, "")).filter((line) => /^ISSUE\s*[|｜]/iu.test(line)).map((line) => {
    const [, severity = "major", category = "other", sourceSpan = "", targetSpan = "", message = "", suggestion = ""] = line.split(/[|｜]/u).map((item) => item.trim());
    return { severity, category, sourceSpan, targetSpan, message, suggestion, confidence: 0.8 };
  }).filter((issue) => issue.message);
  if (issues.length) return issues;
  return [{
    severity: "major",
    category: "unstructured_review",
    sourceSpan: "",
    targetSpan: "",
    message: trimmed.slice(0, 800),
    suggestion: "根据该审校意见进行修订，并再次执行 QA。",
    confidence: 0.65
  }];
}

export async function reviseTranslationWithQa({ contextPack, translation, issues, references = [], qaCases = [], onUsage = null }) {
  return chat([
    { role: "system", content: "你是最终修订译者。只修复 QA 明确指出的问题，保留正确内容、数字、格式、占位符、术语的语境判断结果、明确硬约束和原有信息边界；若问题涉及表达不地道，就用更地道的说法改写，不要退回逐字直译；若原文或文件语境显示韵律结构，修订必须同时重现节奏与押韵。只输出完整修订译文，不要解释。" },
    {
      role: "user",
      content: [
        contextPackText(contextPack, "revise"),
        `当前译文：\n${translation}`,
        `必须修复的问题：${JSON.stringify(issues)}`,
        `人工批准译例：${JSON.stringify(references.slice(0, 5))}`,
        `历史反例：${JSON.stringify(qaCases.slice(0, 3))}`
      ].join("\n\n")
    }
  ], runtimeConfig, { temperature: 0.15, timeoutMs: 75_000, requestLabel: "AIQA 修订", onUsage });
}

export async function adjudicatePotentialTermsWithModel({ contextPack, translation, issues, onUsage = null }) {
  const candidates = issues.slice(0, 12).map((issue) => ({
    matchedSource: issue.matchedSource || "",
    officialSource: issue.sourceTerm || "",
    officialTarget: issue.targetTerm || "",
    currentTranslation: translation
  }));
  const content = await chat([
    {
      role: "system",
      content: "你是游戏本地化术语裁决译者。逐项判断当前原文中的疑似表达是否与术语库正式源词表示同一概念。若是，必须在完整译文中自然地采用 officialTarget；若不是，不得强行替换。保留全部事实、格式、数字和其他正确内容。reason 必须使用简体中文，便于中文项目成员审核。输出严格 JSON：{\"translation\":\"裁决后的完整译文\",\"decisions\":[{\"officialSource\":\"正式源词\",\"matchedSource\":\"当前表达\",\"officialTarget\":\"正式译法\",\"decision\":\"apply|not_applicable\",\"reason\":\"简体中文简短理由\"}]}"
    },
    {
      role: "user",
      content: [
        contextPackText(contextPack, "adjudicate"),
        `当前译文：\n${translation}`,
        `待裁决术语：${JSON.stringify(candidates)}`
      ].join("\n\n")
    }
  ], runtimeConfig, { temperature: 0.05, timeoutMs: 75_000, maxTokens: 1800, requestLabel: "术语自动裁决", responseFormat: { type: "json_object" }, onUsage });
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("术语裁决模型未返回 JSON");
  const payload = JSON.parse(content.slice(start, end + 1));
  if (!String(payload.translation || "").trim() || !Array.isArray(payload.decisions)) throw new Error("术语裁决模型返回格式无效");
  return {
    translation: String(payload.translation).trim(),
    decisions: payload.decisions.slice(0, candidates.length).map((decision) => ({
      officialSource: String(decision.officialSource || ""),
      matchedSource: String(decision.matchedSource || ""),
      officialTarget: String(decision.officialTarget || ""),
      decision: decision.decision === "not_applicable" ? "not_applicable" : "apply",
      reason: String(decision.reason || "模型未补充理由")
    }))
  };
}

export async function analyzeSpreadsheetStructureWithModel(snapshot, ruleAnalysis, locale) {
  const compactSnapshot = {
    targetLocale: locale,
    sheets: snapshot.sheets.map((sheet) => ({
      sheet: sheet.sheet,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      columns: sheet.columns.map((column) => ({
        column: column.column,
        letter: column.letter,
        nonEmpty: column.nonEmpty,
        averageLength: column.averageLength,
        japaneseCharacters: column.japaneseCharacters,
        latinCharacters: column.latinCharacters,
        constraintCells: column.constraintCells,
        sentenceCells: column.sentenceCells,
        samples: column.samples.slice(0, 8)
      })),
      rows: sheet.rows.slice(0, 35)
    })),
    ruleSuggestion: ruleAnalysis.sheets
  };
  const content = await chat([
    {
      role: "system",
      content: `你是日语到简体中文的本地化项目 Excel 表格结构分析器。源语言固定为日语，目标语言是 ${locale}。你的任务只识别结构，不翻译、不改写任何单元格。

请结合表头、列内样本、文字脚本、文本长度、行列分布和规则建议，为每张表识别表头行及每列角色。即使没有表头也必须根据数据分布推断，不能要求用户添加表头。

columns 必须覆盖表里每一个有内容的列，包括表头单元格为空、或被合并表头盖住的列：这类列没有表头可依据，只能按它下面的数据判断角色，绝对不能漏掉不返回。

列角色只能是：
- source_text：真正需要翻译的日语正文、标题、按钮或文案。
- context：位置、渠道、场景、用途、备注等只用于理解的补充信息。
- constraint：DDL、字符限制、语种要求、平台规范等翻译约束。
- existing_translation：简体中文的已有译文/参考译文，不作为日语正文重复翻译。
- ignore：序号、空辅助列或无关数据。

特别注意：含日文不代表需要翻译。诸如“海外SNS”“80文字以内”“8月3日”“日中”“ゲーム内言語”等通常是 context 或 constraint。正文往往是连续文案列，但短标题、按钮也可能是正文，需要结合整列分布判断。一张表允许多个 source_text 列。

输出严格 JSON，不要 Markdown：{"sheets":[{"sheet":"原工作表名","headerRow":1或null,"confidence":0到1,"reason":"简短依据","columns":[{"column":1,"label":"位置","role":"context","confidence":0.95,"reason":"简短依据"}]}]}`
    },
    { role: "user", content: JSON.stringify(compactSnapshot) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("表格结构分析模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.sheets)) throw new Error("表格结构分析模型返回格式无效");
  return payload;
}

export async function alignTermSuggestionsWithModel(locale, translation, candidates) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactCandidates = candidates.map((candidate, index) => ({
    index,
    sourceTerm: candidate.sourceTerm,
    matchedSource: candidate.matchedSource,
    officialTarget: candidate.replacement,
    sourceMatchMode: candidate.matchMode,
    sourceMatchScore: candidate.matchScore
  }));
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化术语对齐器。候选中文只是疑似匹配，不一定真是同一术语。请在译文中寻找它当前对应的一个完整、连续、原样子串；只有语义确实对应且置信度至少0.65才返回。不得改写译文，不得返回不存在于译文中的文字。输出严格 JSON：{"suggestions":[{"index":0,"currentText":"译文原样子串","confidence":0.8,"reason":"简短依据"}]}`
    },
    { role: "user", content: JSON.stringify({ translation, candidates: compactCandidates }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语对齐模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.suggestions)) throw new Error("术语对齐模型返回格式无效");
  return payload.suggestions;
}

const LOCALE_NAMES = Object.freeze({
  "zh-CN": "简体中文",
  "ja-JP": "日语",
  "ko-KR": "韩语",
  "zh-Hant-TW": "台湾繁体中文",
  "fr-FR": "法语",
  "th-TH": "泰语"
});

/**
 * Adjudicate deterministically-shortlisted rule pairs.
 *
 * The shortlist is deliberately liberal (same aspect = candidate), so most
 * pairs handed here are NOT conflicts — two rules can both talk about 句尾
 * while covering different situations. The prompt therefore pushes hard toward
 * "not a conflict" and demands the incompatible situation be named, otherwise
 * the model will happily manufacture contradictions to look useful.
 */
export async function adjudicateRuleConflictsWithModel({ locale, contentType, domain, candidates = [] }) {
  const language = LOCALE_NAMES[locale] || locale;
  if (!candidates.length) return [];
  const content = await chat([
    {
      role: "system",
      content: `你是${language}本地化风格规范的一致性审查员。给你若干"规则对"，判断每一对是否**真的互相矛盾**。
`
        + `矛盾的定义很窄：存在一个具体场景，同时遵守两条规则是不可能的。必须能指出那个场景。
`
        + `以下都**不是**矛盾，一律判 conflict=false：
`
        + `· 两条规则适用于不同场景（一条讲旁白、一条讲角色对白；一条讲标题、一条讲正文）
`
        + `· 一条是另一条的细化或例外（"统一敬体"与"战斗吼叫用常体"是总则与例外，不是矛盾）
`
        + `· 两条谈同一方面但要求的东西不同且可同时满足
`
        + `· 措辞相似但约束对象不同
`
        + `只有确实无法同时遵守时才 conflict=true，并在 situation 里写清那个具体场景。宁可漏判也不要凑数。
`
        + `输出严格 JSON：{"verdicts":[{"index":0,"conflict":true,"situation":"具体到哪种句子会两难","recommendation":"建议保留哪一条、另一条应如何改写或退休"}]}`
    },
    {
      role: "user",
      content: JSON.stringify({
        locale, contentType, domain,
        pairs: candidates.map((candidate, index) => ({
          index,
          aspects: candidate.aspects,
          a: { origin: candidate.left.originLabel, rule: candidate.left.rule, evidenceCount: candidate.left.evidenceCount },
          b: { origin: candidate.right.originLabel, rule: candidate.right.rule, evidenceCount: candidate.right.evidenceCount }
        }))
      })
    }
  ], runtimeConfig, { temperature: 0, timeoutMs: 90_000, maxTokens: 2_500, requestLabel: "规则冲突审查", responseFormat: { type: "json_object" } });
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("规则冲突审查模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.verdicts)) throw new Error("规则冲突审查模型未返回 verdicts 数组");
  return payload.verdicts
    .filter((verdict) => Number.isInteger(Number(verdict?.index)) && candidates[Number(verdict.index)])
    .map((verdict) => ({
      index: Number(verdict.index),
      conflict: verdict.conflict === true,
      situation: String(verdict.situation || "").slice(0, 400),
      recommendation: String(verdict.recommendation || "").slice(0, 400)
    }));
}

export async function classifyWithModel(text, { descriptor = "", location = "" } = {}) {
  const content = await chat([
    {
      role: "system",
      content: "你是日语到简体中文游戏本地化项目的内容分类器，输入正文是日语。只能从 verse, narrative, codex, dialogue, ui, tutorial, rules, item_name, item_description, store, announcement, marketing, social, general 中选择一个 contentType。诗词/韵文、故事叙事、图鉴设定、角色台词和商店说明必须彼此隔离；general 只用于确实无法确认用途的文本，不能充当通配类别。输入是 JSON，其中 text 是正文；如果带有\"用途\"或\"位置\"字段，那是需求表自己声明的文案用途，应当优先于从正文推测。输出严格 JSON：{\"contentType\":\"...\",\"confidence\":0到1,\"evidence\":[\"简短依据\"]}。"
    },
    { role: "user", content: JSON.stringify({ text: String(text).slice(0, 8000), 用途: descriptor || undefined, 位置: location || undefined }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("语体分类模型未返回 JSON");
  return { ...JSON.parse(match[0]), source: "model" };
}

/**
 * 让模型用一两句话描述一份参考资料是干什么的、包含什么。
 *
 * 用途：资料多起来以后，模型每次都从头检索既慢又费 token。先扫一遍生成描述，
 * 翻译时先看"文件名 + 描述"就能判断该读哪几份，再决定是否读全文。
 */
export async function describeReferenceWithModel({ name = "", kind = "", text = "", onUsage = null } = {}) {
  const excerpt = String(text || "").trim().slice(0, 6_000);
  if (!excerpt) throw new Error("这份资料没有可读正文，无法生成描述");
  const content = await chat([
    {
      role: "system",
      content: "你是本地化资料管理员。用一两句简体中文（总长不超过 60 字）说明这份资料是做什么用的、大致包含哪些内容，供翻译时判断要不要读它。只输出描述本身：不要前缀、不要引号、不要分点、不要解释。"
    },
    { role: "user", content: `资料名：${name || "（未命名）"}\n资料类型：${kind || "其他"}\n正文节选：\n${excerpt}` }
  ], configForRole("main"), { temperature: 0.1, timeoutMs: 60_000, maxTokens: 200, requestLabel: "资料描述", onUsage });
  const description = String(content || "").trim().split(/\r?\n/u)[0].replace(/^["“]|["”]$/gu, "").trim().slice(0, 120);
  if (!description) throw new Error("模型没有返回资料描述");
  return description;
}

/** 语境分析：通读一整片条目，产出用途区间、跨条目关联与格式注意点。 */
export async function analyzeDocumentContextWithModel({ filename = "", format = "", locale = "zh-CN", declaredPurpose = "", entries = [], part = null, onUsage = null } = {}) {
  const messages = contextBriefMessages({ filename, format, locale, declaredPurpose, entries, part });
  const content = await chat(messages, configForRole("main"), {
    temperature: 0.2, timeoutMs: 120_000, maxTokens: 3_000, requestLabel: "语境分析", responseFormat: { type: "json_object" }, onUsage
  });
  try {
    return parseContextBriefPart(content, { entries });
  } catch (error) {
    // 模型偶发返回非 JSON：只重试一次格式，不重试内容判断。
    const retry = await chat([
      ...messages,
      { role: "assistant", content: String(content || "").slice(0, 4_000) || "(空白)" },
      { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，字段为 documentType、sections、crossRefs、notes；不要 Markdown、解释或代码围栏。" }
    ], configForRole("main"), {
      temperature: 0, timeoutMs: 60_000, maxTokens: 3_000, requestLabel: "语境分析格式重试", responseFormat: { type: "json_object" }, onUsage
    });
    try {
      return parseContextBriefPart(retry, { entries });
    } catch {
      throw new Error(`语境分析模型返回格式无效：${error.message}`);
    }
  }
}

/**
 * 交付前一致性核对：只报跨条目的漂移，不重复逐条 QA。
 * evidence 是风格指南 / 术语库命中 / 主参考 TM 译例；toolRunner 给模型按需查参考资料的机会。
 */
export async function checkBatchConsistencyWithModel({ filename = "", locale = "zh-CN", purpose = "general", pairs = [], part = null, evidence = null, toolRunner = null, onUsage = null } = {}) {
  const messages = consistencyMessages({ filename, locale, purpose, pairs, part, evidence });
  const requestOptions = {
    temperature: 0.1, timeoutMs: 120_000, maxTokens: 2_000, requestLabel: "一致性检查", responseFormat: { type: "json_object" }, onUsage
  };
  // 参考资料按需查询：与翻译阶段共用同一套工具与预算，查不到就按已有证据判断。
  const content = toolRunner?.tools?.length
    ? (await chatWithTools(messages, configForRole("main"), {
      ...requestOptions,
      tools: toolRunner.tools,
      maxRounds: Number(toolRunner.maxRounds) || 2,
      executeTool: toolRunner.execute,
      onActivity: toolRunner.onActivity
    })).content
    : await chat(messages, configForRole("main"), requestOptions);
  const validIds = pairs.map((pair) => String(pair.id));
  try {
    return parseConsistencyFindings(content, { validIds });
  } catch (error) {
    const retry = await chat([
      ...messages,
      { role: "assistant", content: String(content || "").slice(0, 4_000) || "(空白)" },
      { role: "user", content: '上一个回答不是可解析的严格 JSON。请只重新输出 {"findings":[]} 这种形状的紧凑 JSON，不要 Markdown 或解释。' }
    ], configForRole("main"), {
      temperature: 0, timeoutMs: 60_000, maxTokens: 2_000, requestLabel: "一致性检查格式重试", responseFormat: { type: "json_object" }, onUsage
    });
    try {
      return parseConsistencyFindings(retry, { validIds });
    } catch {
      throw new Error(`一致性检查模型返回格式无效：${error.message}`);
    }
  }
}

/**
 * 术语普查：批次翻完后找出"像术语但库里多半没有"的说法。
 * 只产出候选与依据，是否入库由回填时的人工终稿决定（见 src/term-survey.mjs）。
 */
export async function surveyTermsWithModel({ filename = "", locale = "zh-CN", purpose = "general", pairs = [], part = null, existingTerms = [], onUsage = null } = {}) {
  const messages = termSurveyMessages({ filename, locale, purpose, pairs, part });
  const content = await chat(messages, configForRole("main"), {
    temperature: 0.1, timeoutMs: 120_000, maxTokens: 2_000, requestLabel: "术语普查", responseFormat: { type: "json_object" }, onUsage
  });
  try {
    return parseTermSurvey(content, { existingTerms });
  } catch (error) {
    const retry = await chat([
      ...messages,
      { role: "assistant", content: String(content || "").slice(0, 4_000) || "(空白)" },
      { role: "user", content: '上一个回答不是可解析的严格 JSON。请只重新输出 {"terms":[]} 这种形状的紧凑 JSON，不要 Markdown 或解释。' }
    ], configForRole("main"), {
      temperature: 0, timeoutMs: 60_000, maxTokens: 2_000, requestLabel: "术语普查格式重试", responseFormat: { type: "json_object" }, onUsage
    });
    try {
      return parseTermSurvey(retry, { existingTerms });
    } catch {
      throw new Error(`术语普查模型返回格式无效：${error.message}`);
    }
  }
}

/**
 * 边翻译边学习：从"本段原文 + 本段实际译文"里抽取需要在全文统一的新术语。
 *
 * 不做术语猜测：source/target 必须由调用方再校验为原文/译文逐字子串；模型只负责
 * 指出"这里有个词值得统一，以及本次实际用了什么译法"。失败返回空数组，不拖垮翻译。
 */
export async function learnWorkingTermsWithModel({ source = "", translation = "", existingTerms = [], workingTerms = [], filename = "", locale = "zh-CN", purpose = "general", onUsage = null } = {}) {
  if (!String(source || "").trim() || !String(translation || "").trim()) return [];
  const known = (Array.isArray(existingTerms) ? existingTerms : []).slice(0, 80).map((term) => ({
    source: String(term?.source || "").trim(),
    target: String(term?.target || "").trim(),
    aliases: Array.isArray(term?.aliases) ? term.aliases.slice(0, 5) : []
  })).filter((term) => term.source);
  const learned = (Array.isArray(workingTerms) ? workingTerms : []).slice(0, 40).map((term) => ({
    source: String(term?.source || "").trim(), target: String(term?.target || "").trim()
  })).filter((term) => term.source);
  const messages = [
    {
      role: "system",
      content: [
        "你在做日语到简体中文的翻译期术语学习。只报告这一对原文/译文里需要在同一文件内保持统一的新术语、专名、商品名、技能名或固定说法。",
        "source 必须是原文里的逐字子串；target 必须是本次译文里的逐字子串。不要改写、不要补全、不要输出句子。",
        "主术语库已有的源词不要重复报告（见 existingTerms）；工作术语表已有的也不要重复（见 workingTerms）。",
        "只报告有把握的；每段最多 5 条。没有就返回空数组。",
        `只输出严格 JSON：{"terms":[{"source":"","target":"","confidence":0.9,"reason":"为什么值得统一"}]}。目标语言：${locale}。`
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        filename: filename || "",
        purpose: purpose || "general",
        source: String(source),
        translation: String(translation),
        existingTerms: known,
        workingTerms: learned
      })
    }
  ];
  try {
    const content = await chat(messages, configForRole("fast", runtimeConfig.fastModel || runtimeConfig.mtModel || runtimeConfig.model), {
      temperature: 0.1,
      timeoutMs: 45_000,
      maxTokens: 800,
      requestLabel: "工作术语学习",
      responseFormat: { type: "json_object" },
      onUsage
    });
    const parsed = parseModelJsonObject(content);
    return Array.isArray(parsed?.terms) ? parsed.terms : [];
  } catch (error) {
    console.warn(`[Kami] 本段工作术语学习失败，已跳过：${error.message}`);
    return [];
  }
}

/** 人工终稿改动了 AI 建议时，让模型在终稿里找出该说法的实际写法（逐字校验在解析里做）。 */
export async function resolveSurveyTargetsWithModel({ locale = "zh-CN", scope = {}, items = [], onUsage = null } = {}) {
  const messages = termAlignMessages({ locale, scope, items });
  const content = await chat(messages, configForRole("main"), {
    temperature: 0.1, timeoutMs: 120_000, maxTokens: 2_000, requestLabel: "术语对齐", responseFormat: { type: "json_object" }, onUsage
  });
  try {
    return parseTermAlign(content, { items });
  } catch (error) {
    const retry = await chat([
      ...messages,
      { role: "assistant", content: String(content || "").slice(0, 4_000) || "(空白)" },
      { role: "user", content: '上一个回答不是可解析的严格 JSON。请只重新输出 {"matches":[]} 这种形状的紧凑 JSON，不要 Markdown 或解释。' }
    ], configForRole("main"), {
      temperature: 0, timeoutMs: 60_000, maxTokens: 2_000, requestLabel: "术语对齐格式重试", responseFormat: { type: "json_object" }, onUsage
    });
    try {
      return parseTermAlign(retry, { items });
    } catch {
      throw new Error(`术语对齐模型返回格式无效：${error.message}`);
    }
  }
}

/** 门禁失败复盘：把复发的失败按根因归类，给出术语建议或体例规则。 */
export async function reviewGateFailuresWithModel({ locale = "zh-CN", scope = {}, cases = [], part = null, onUsage = null } = {}) {
  const messages = gateReviewMessages({ locale, scope, cases, part });
  const content = await chat(messages, configForRole("main"), {
    temperature: 0.1, timeoutMs: 120_000, maxTokens: 3_000, requestLabel: "门禁复盘", responseFormat: { type: "json_object" }, onUsage
  });
  try {
    return parseGateReview(content);
  } catch (error) {
    const retry = await chat([
      ...messages,
      { role: "assistant", content: String(content || "").slice(0, 4_000) || "(空白)" },
      { role: "user", content: '上一个回答不是可解析的严格 JSON。请只重新输出 {"summary":"","patterns":[]} 这种形状的紧凑 JSON，不要 Markdown 或解释。' }
    ], configForRole("main"), {
      temperature: 0, timeoutMs: 60_000, maxTokens: 3_000, requestLabel: "门禁复盘格式重试", responseFormat: { type: "json_object" }, onUsage
    });
    try {
      return parseGateReview(retry);
    } catch {
      throw new Error(`门禁复盘模型返回格式无效：${error.message}`);
    }
  }
}

export async function translateWithReflection(contextPack, { reflect = true, onUsage = null, temperature = undefined, seed = undefined, onSeedUnsupported = null, model = "", modelRole = "main", toolRunner = null } = {}) {
  const rhymeLike = contextPack?.rhymeLike === true;
  const batchVerse = contextPack?.batchVerse?.active === true;
  const callConfig = configForRole(modelRole, model);
  // 温度：普通文本 0.6 给地道表达留空间，韵文/批排比 0.85 给节奏与韵脚再创作。
  const translationTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : (rhymeLike || batchVerse ? 0.85 : 0.6);
  const initialMessages = [{ role: "user", content: packPrompt(contextPack) }];
  const initialOptions = { timeoutMs: 75_000, requestLabel: "翻译", temperature: translationTemperature, seed, onSeedUnsupported, onUsage };
  // 参考资料按需查询：只挂在初译这一步，自检与修订不重复查询，避免成本失控。
  const firstPass = toolRunner?.tools?.length
    ? await chatWithTools(initialMessages, callConfig, {
      ...initialOptions,
      tools: toolRunner.tools,
      maxRounds: Number(toolRunner.maxRounds) || 2,
      executeTool: toolRunner.execute,
      onActivity: toolRunner.onActivity
    })
    : { content: await chat(initialMessages, callConfig, initialOptions), exhausted: false };
  let initial = String(firstPass.content || "").trim();
  if (!initial) {
    // 模型把轮次全花在查参考资料上（或直接吐了空白）时，以前这个空串会被当成译文：
    // 评测把它记成"候选漏译、质量 30 分"，生产批次把它记成"这一段翻好了"。
    // 这里补一轮不带工具的直译，明确告诉它不要再查资料、直接给译文。
    const reason = firstPass.exhausted ? "上一轮把工具轮次用完了还没给译文" : "上一轮返回了空白";
    initial = String(await chat([
      { role: "system", content: "你是日语到简体中文的本地化译者。不要再调用任何工具、不要输出解释或推理过程，直接给出一行最终译文。" },
      { role: "user", content: `${packPrompt(contextPack)}\n\n补充要求（${reason}）：请只输出这一条的简体中文译文本身。` }
    ], callConfig, { ...initialOptions, requestLabel: "翻译（空译文重试）", tools: undefined })).trim();
  }
  if (!initial) {
    const error = new Error("模型没有返回译文（连续两次都是空白输出）");
    error.code = "empty_translation";
    throw error;
  }
  if (!reflect && !rhymeLike) return { initial, translation: initial, reflection: "" };
  if (rhymeLike) {
    // 韵文本地化专用通道：初译只作参考，要求模型以目标语言玩家视角再创作，
    // 而不是修补字对字直译。
    const localized = await chat([
      { role: "system", content: "你是游戏文案韵文本地化师。把日语顺口溜/韵文改写为自然、节奏鲜明的简体中文短句：保留原意与情绪（自嘲、洒脱、吆喝等），重现节奏、叠词与韵脚，允许换用中文惯用句和谚语；严禁机械逐字直译，严禁把闲散语气译成命令口吻。只输出一行最终译文，不解释。\n\n改写示范（达到这个质量才算合格）：\n原文：とことこ歩いて、ぶらぶら遊んで、銭のためなら馬にも牛にも。\n译文：走走走，游游游，甘为铜钱做马牛。" },
      { role: "user", content: `原文：${contextPack.source}\n参考技巧：日语叠词、拟态词和反复句可改写为中文叠词、四字结构或顺口句；尾韵可用同韵脚或节奏呼应。不要参考任何现成译文，直接从原文创作。` }
    ], callConfig, { temperature: translationTemperature, seed, onSeedUnsupported, timeoutMs: 75_000, requestLabel: "韵文本地化", onUsage });
    return { initial, translation: requireNonEmptyTranslation(localized, initial, "韵文本地化"), reflection: "rhyme-localized" };
  }
  const reflection = await chat([
    { role: "system", content: "你是严格的双语本地化审校。只指出漏译、误译、术语、事实、语体、翻译腔和韵律/重复结构丢失问题（原文押韵、对仗或口号式重复时，译文须自然重现节奏与语气）；若上下文带有同批已定稿译文，还要检查句式与风格是否保持一致；没有问题则回答 PASS。" },
    { role: "user", content: `${contextPackText(contextPack, "reflect")}\n\n初译：\n${initial}` }
  ], callConfig, { temperature: 0.35, timeoutMs: 60_000, requestLabel: "翻译自检", onUsage });
  if (/^PASS[。.!]?$/i.test(reflection)) return { initial, translation: initial, reflection };
  const revised = await chat([
    { role: "system", content: "你是最终修订译者。根据审校意见做最小必要修改，严格保留事实、格式、术语的语境判断结果和明确硬约束。只输出最终译文。" },
    { role: "user", content: `${contextPackText(contextPack, "reflect")}\n\n初译：${initial}\n\n审校意见：${reflection}` }
  ], callConfig, { temperature: 0.15, timeoutMs: 75_000, requestLabel: "翻译修订", onUsage });
  return { initial, translation: requireNonEmptyTranslation(revised, initial, "翻译修订"), reflection };
}

/**
 * 修订/再创作返回空白时退回初译（初译已经校验过非空）。
 * 两边都空就抛带 code 的错误，让上层把它当"这一组没跑成"，而不是当译文。
 */
function requireNonEmptyTranslation(value, fallback, label) {
  const text = String(value || "").trim();
  if (text) return value;
  const initial = String(fallback || "").trim();
  if (initial) return fallback;
  const error = new Error(`${label}没有返回译文（连续两次都是空白输出）`);
  error.code = "empty_translation";
  throw error;
}

function uniqueCandidateTexts(items = []) {
  const seen = new Set();
  return items.map((item) => String(item || "").trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

async function chooseTranslationCandidate(contextPack, candidates, config, onUsage) {
  if (candidates.length < 2) return { index: 0, reason: "只有一个有效候选" };
  try {
    const content = await chat([
      { role: "system", content: "你是资深日语到简体中文本地化主编。按原意忠实、事实完整、术语在当前语境中的适用性、明确硬约束、简体中文自然度、当前语体和品牌风格选择最佳候选。不得改写候选。输出严格 JSON：{\"index\":0,\"reason\":\"简短理由\"}。index 从 0 开始。" },
      { role: "user", content: JSON.stringify({ source: contextPack.source, locale: contextPack.targetLocale, contentType: contextPack.contentType, facts: contextPack.factSchema || null, candidates }) }
    ], config, { temperature: 0, timeoutMs: 60_000, requestLabel: "候选择优", onUsage });
    const match = content.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const index = Number(parsed.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) throw new Error("候选编号无效");
    return { index, reason: String(parsed.reason || "模型综合择优") };
  } catch (error) {
    return { index: 0, reason: `候选择优降级为首项：${error.message}`, fallbackReason: error.message };
  }
}

/**
 * 执行由服务端风险路由器选定的翻译路线。routePlan 由服务端生成，浏览器
 * 只能请求策略名称，不能把任意模型或密钥注入模型调用。
 */
export async function translateWithRoute(contextPack, { routePlan = null, reflect = true, onUsage = null, toolRunner = null } = {}) {
  const plan = routePlan || { route: "reflective", candidateCount: 1, model: runtimeConfig.model, modelRole: "main" };
  const selectedModel = String(plan.model || runtimeConfig.model);
  const selectedConfig = configForRole(plan.modelRole, selectedModel);

  if (plan.route === "mt_post_edit") {
    const draftModel = runtimeConfig.mtModel || runtimeConfig.fastModel || runtimeConfig.model;
    const draft = await chat([{ role: "user", content: packPrompt(contextPack) }], configForRole("mt", draftModel), {
      temperature: 0.25, timeoutMs: 75_000, requestLabel: "机器初译", onUsage
    });
    const finalModel = runtimeConfig.qualityModel || runtimeConfig.model;
    const translation = await chat([
      { role: "system", content: "你是目标语言母语本地化编辑。把机器初译改成可发布译文；按结构化术语、翻译记忆、风格规则和事实锚点做最小必要后编辑。不得漏译、增译或改变数字、日期、平台、地区、URL、占位符和承诺强度。只输出最终译文。" },
      { role: "user", content: `${packPrompt(contextPack)}\n\n机器初译：\n${draft}` }
    ], configForRole("quality", finalModel), {
      temperature: 0.15, timeoutMs: 75_000, requestLabel: "LLM 后编辑", onUsage
    });
    return {
      initial: draft,
      translation,
      reflection: "mt-post-edited",
      candidates: [{ index: 0, translation, recommended: true, reason: "后编辑终稿" }],
      routeExecution: { route: plan.route, draftModel, finalModel }
    };
  }

  if (["transcreation", "multi_candidate"].includes(plan.route)) {
    const count = Math.min(3, Math.max(2, Number(plan.candidateCount) || 3));
    const directions = [
      "平衡忠实度与母语自然度，作为稳妥可发布版本。",
      "在不改变事实、正确判断术语语境适用性的前提下，提高简体中文感染力与节奏。",
      "优先目标平台和受众的自然表达，避免翻译腔与过度营销。"
    ];
    const generated = await Promise.all(directions.slice(0, count).map((direction, index) => chat([
      { role: "user", content: `${packPrompt(contextPack)}\n\n候选方向 ${index + 1}：${direction}\n只输出这一版完整译文。` }
    ], selectedConfig, {
      temperature: index === 0 ? 0.55 : 0.78,
      timeoutMs: 75_000,
      requestLabel: `候选 ${index + 1}`,
      onUsage
    })));
    const candidates = uniqueCandidateTexts(generated);
    const selectionModel = runtimeConfig.qualityModel || selectedModel;
    const selection = await chooseTranslationCandidate(contextPack, candidates, configForRole("quality", selectionModel), onUsage);
    const translation = candidates[selection.index] || candidates[0] || "";
    return {
      initial: candidates[0] || "",
      translation,
      reflection: `candidate-selection: ${selection.reason}`,
      candidates: candidates.map((text, index) => ({ index, translation: text, recommended: index === selection.index, reason: index === selection.index ? selection.reason : directions[index] })),
      routeExecution: { route: plan.route, model: selectedModel, selectionModel, selectionFallback: selection.fallbackReason || "" }
    };
  }

  const forceReflection = plan.route === "fact_guarded" ? true : (plan.route === "direct" ? false : reflect);
  const result = await translateWithReflection(contextPack, { reflect: forceReflection, onUsage, model: selectedModel, modelRole: plan.modelRole, toolRunner });
  return {
    ...result,
    candidates: [{ index: 0, translation: result.translation, recommended: true, reason: plan.label || "系统推荐" }],
    routeExecution: { route: plan.route, model: selectedModel }
  };
}

/**
 * 翻译期术语普查：批次翻完后让模型指出"这里有些词像术语，但库里没有"。
 *
 * 普查只回答"哪个词像术语、建议怎么译"，**译法最终由人工终稿决定**：
 * 回填时用终稿文本核对，逐字保留的才可能自动入库，其余一律进待审核。
 * 这样模型猜错也不会污染项目术语库。
 */

import { normalizeSource, parseModelJsonObject } from "./text.mjs";
import { textContainsTerm } from "./asset-governance.mjs";

/** 术语形态上限：超过这个长度的"术语"多半是整句，不该进术语库。 */
export const TERM_SURVEY_MAX_SOURCE_LENGTH = 40;
export const TERM_SURVEY_MAX_TARGET_LENGTH = 60;
const DEFAULT_MAXIMUM_TERMS = 200;

function text(value) {
  return String(value ?? "").trim();
}

function finiteConfidence(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

/** 模型返回的候选：只保留字段完整、长度像术语、彼此不重复的条目。 */
export function normalizeSurveyTerms(list = [], { maximum = DEFAULT_MAXIMUM_TERMS, existingTerms = [] } = {}) {
  const seen = new Set();
  const known = new Set((Array.isArray(existingTerms) ? existingTerms : []).map((term) => normalizeSource(term?.source)));
  const output = [];
  for (const item of Array.isArray(list) ? list : []) {
    const source = text(item?.source ?? item?.sourceTerm);
    const suggestedTarget = text(item?.suggestedTarget ?? item?.target);
    if (!source || !suggestedTarget) continue;
    if ([...source].length > TERM_SURVEY_MAX_SOURCE_LENGTH) continue;
    if ([...suggestedTarget].length > TERM_SURVEY_MAX_TARGET_LENGTH) continue;
    const key = normalizeSource(source);
    if (!key || seen.has(key)) continue;
    if (known.has(key)) continue; // 库里已经有这个源词：不用再当新术语提出来
    seen.add(key);
    output.push({
      source,
      suggestedTarget,
      reason: text(item?.reason).slice(0, 200),
      confidence: finiteConfidence(item?.confidence, 0.6)
    });
    if (output.length >= maximum) break;
  }
  return output;
}

/** 普查用的句段对：只取已翻好、已选中的条目。 */
export function surveyPairs(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment.selected !== false && text(segment.source) && text(segment.translation))
    .map((segment) => ({ id: String(segment.id || ""), source: text(segment.source), translation: text(segment.translation) }));
}

/**
 * 回填后用人工终稿核对普查结果。
 *
 * - `confirmed`：AI 建议译法在人工终稿里逐字出现 → 可以走自动入库（还要过 decideTermWrite）。
 * - `unresolved`：人工改掉了建议译法 → 需要再由模型在终稿里找对应译法，找不到就只做待审。
 * - `noEvidence`：回填的段落里没出现这个源词 → 丢弃，不凭空造术语。
 */
export function alignSurveyToHumanFinal({ terms = [], pairs = [] } = {}) {
  const confirmed = [];
  const unresolved = [];
  const noEvidence = [];
  const reviewed = (Array.isArray(pairs) ? pairs : []).map((pair) => ({
    id: text(pair?.id),
    source: text(pair?.source),
    machineTranslation: text(pair?.machineTranslation),
    humanFinal: text(pair?.humanFinal)
  })).filter((pair) => pair.source && pair.humanFinal);

  for (const term of Array.isArray(terms) ? terms : []) {
    const source = text(term?.source);
    const suggestedTarget = text(term?.suggestedTarget);
    if (!source || !suggestedTarget) continue;
    const hits = reviewed.filter((pair) => textContainsTerm(pair.source, source));
    if (!hits.length) {
      noEvidence.push({ source, suggestedTarget });
      continue;
    }
    const verbatim = hits.find((hit) => textContainsTerm(hit.humanFinal, suggestedTarget));
    if (verbatim && hits.every((hit) => textContainsTerm(hit.humanFinal, suggestedTarget))) {
      confirmed.push({
        source,
        target: suggestedTarget,
        confidence: finiteConfidence(term?.confidence, 0.9),
        reason: text(term?.reason),
        verbatim: true,
        segmentId: verbatim.id,
        segmentSource: verbatim.source,
        humanFinal: verbatim.humanFinal
      });
      continue;
    }
    unresolved.push({
      source,
      suggestedTarget,
      confidence: finiteConfidence(term?.confidence, 0.5),
      reason: text(term?.reason),
      verbatim: false,
      segmentId: hits[0].id,
      segmentSource: hits[0].source,
      machineTranslation: hits[0].machineTranslation,
      humanFinal: hits[0].humanFinal,
      examples: hits.map((hit) => ({ segmentSource: hit.source, humanFinal: hit.humanFinal }))
    });
  }
  return { confirmed, unresolved, noEvidence };
}

/**
 * 入库分流：库里没有该源词、终稿译法已核实且形态合规时允许自动写入。
 * 人工改过的译法还需高置信对齐；其余进待审核，并给出可见的中文原因。
 */
export function decideTermWrite(candidate = {}, { existingTerms = [], autoWriteEnabled = true } = {}) {
  const source = text(candidate.source);
  const target = text(candidate.target);
  const proposalAction = text(candidate.proposalAction) || "create_term";
  if (!source || !target) return { auto: false, reason: "源词或译法为空" };
  if (!autoWriteEnabled) return { auto: false, reason: "自动入库已关闭" };
  if (candidate.verbatim !== true && !(candidate.humanFinalVerified === true && Number(candidate.confidence) >= 0.9)) return { auto: false, reason: "终稿对应译法尚未核实或对齐置信度不足" };
  if (proposalAction !== "create_term") {
    const label = { add_alias: "库里已有相同译法，只需补别名", resolve_conflict: "与库里已有译法冲突", add_usage_evidence: "库里已有相同条目" }[proposalAction] || proposalAction;
    return { auto: false, reason: label };
  }
  if ([...source].length > TERM_SURVEY_MAX_SOURCE_LENGTH || [...target].length > TERM_SURVEY_MAX_TARGET_LENGTH) {
    return { auto: false, reason: "超出术语形态长度上限" };
  }
  const blocked = (Array.isArray(existingTerms) ? existingTerms : [])
    .some((term) => (Array.isArray(term?.forbidden) ? term.forbidden : []).some((phrase) => textContainsTerm(source, phrase) || textContainsTerm(target, phrase)));
  if (blocked) return { auto: false, reason: "撞上库里标注的禁用译法" };
  return { auto: true, reason: "译法已由人工终稿证据确认" };
}

/** 待审候选的展示原因：把模型依据和入库判定合并成一句话。 */
export function pendingReason(candidate = {}, decision = {}) {
  const parts = [text(decision.reason)].filter(Boolean);
  const evidence = text(candidate.reason);
  if (evidence) parts.push(`模型依据：${evidence}`);
  return parts.join("；").slice(0, 200);
}

/**
 * 术语普查的提示词。刻意只问"哪个词句像术语、建议怎么译、依据是什么"：
 * 是否入库由人工终稿决定，模型不需要（也不允许）替项目定术语。
 */
export function termSurveyMessages({ filename = "", locale = "zh-CN", purpose = "general", pairs = [], part = null } = {}) {
  const partLine = part ? `这是整份文件的第 ${part.index + 1} / ${part.total} 片，id 沿用文件里的条目 id。\n` : "";
  const system = [
    "你在为一个日语到简体中文的本地化项目做术语普查：找出**应该作为项目术语管理、但很可能还没登记的专有说法**。",
    "只收这几类：作品/角色/地名/组织/道具/技能等专名，固定 UI 用词与按钮文案，必须原文照抄不译的字符串（如英文品牌名、代码、全大写标识），以及全篇反复出现的固定称呼。",
    "不要收普通词汇、敬语、语气词、整句对白、纯数字或单个汉字；不要把同一说法拆成多条。",
    "suggestedTarget 给出当前机器译文里的对应写法（如果该说法在译文里就是原文照抄，则与 source 相同）。",
    "confidence 用 0-1 表示你有多确信这是术语；reason 用简体中文一句话说明判断依据。",
    "找不到就返回空数组，宁缺毋滥。",
    '只输出严格 JSON：{"terms":[{"source":"崩兆の片","suggestedTarget":"崩兆之隅","reason":"地名，全篇固定称呼","confidence":0.9}]}',
    "整个回答只能是一个 JSON 对象：禁止 Markdown、解释或代码围栏。"
  ].join("\n");
  const user = [
    `文件名：${filename || "未命名"}`,
    `目标语言：${locale}`,
    `文件整体用途：${purpose}`,
    partLine,
    "条目对照（原文 → 机器译文）：",
    JSON.stringify(pairs.map((pair) => ({ id: pair.id, source: String(pair.source || "").slice(0, 400), translation: String(pair.translation || "").slice(0, 400) })))
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export function parseTermSurvey(content, { existingTerms = [] } = {}) {
  let payload;
  try {
    payload = parseModelJsonObject(content);
  } catch (error) {
    throw new Error(`术语普查模型未返回 JSON（${error.message}）`);
  }
  return { terms: normalizeSurveyTerms(payload?.terms, { existingTerms }) };
}

/**
 * 人工终稿改动了 AI 建议时，再由模型在终稿里找对应译法。
 * 返回的译法**必须在终稿里逐字存在**才会被留下——模型不能凭印象发明术语。
 */
export function termAlignMessages({ locale = "zh-CN", scope = {}, items = [] } = {}) {
  const system = [
    "你在把一批“疑似术语”对齐到**人工终稿**：终稿是唯一权威，你的工作只是指出终稿里实际采用的写法。",
    "对每一条，如果人工终稿里确实出现了该说法的对应译法，found 填 true 并把 target 写成终稿里的**原文片段**（逐字复制，不要改写）。",
    "如果终稿里没有对应写法（例如整句被改写、该说法被删掉、或它其实不是术语），found 填 false 并且不要编造 target。",
    "preserveSource 只在终稿里就是原文照抄时填 true。reason 用简体中文一句话说明依据。",
    '只输出严格 JSON：{"matches":[{"source":"崩兆の片","found":true,"target":"崩兆之隅","preserveSource":false,"confidence":0.95,"reason":"终稿里写作「崩兆之隅」"}]}',
    "examples 是该源词在终稿中的多处用例，必须全部核对。译法不一致或语义对应不确定时不要给高置信结论。confidence 为 0 到 1。",
    "整个回答只能是一个 JSON 对象：禁止 Markdown、解释或代码围栏。"
  ].join("\n");
  const user = [
    `目标语言：${locale}`,
    `作用域：语体 ${scope.contentType || "general"} · 领域 ${scope.domain || "general"}`,
    "待对齐条目：",
    JSON.stringify(items.map((item) => ({
      source: item.source,
      suggestedTarget: item.suggestedTarget,
      segmentSource: String(item.segmentSource || ""),
      humanFinal: String(item.humanFinal || ""),
      examples: item.examples || []
    })))
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export function parseTermAlign(content, { items = [] } = {}) {
  let payload;
  try {
    payload = parseModelJsonObject(content);
  } catch (error) {
    throw new Error(`术语对齐模型未返回 JSON（${error.message}）`);
  }
  const bySource = new Map((Array.isArray(items) ? items : []).map((item) => [normalizeSource(item.source), item]));
  const matches = [];
  for (const item of Array.isArray(payload?.matches) ? payload.matches : []) {
    const source = text(item?.source);
    const original = bySource.get(normalizeSource(source));
    if (!original) continue;
    const target = text(item?.target);
    const preserveSource = item?.preserveSource === true;
    if (item?.found === false || !target) continue;
    // 逐字校验：模型给的说法必须在人工终稿里真实存在，否则丢弃（宁可漏，不可错）。
    const effectiveTarget = preserveSource ? source : target;
    if (!textContainsTerm(original.segmentSource, original.source) || !textContainsTerm(original.humanFinal, effectiveTarget)) continue;
    if ((original.examples || []).some((example) => !textContainsTerm(example.humanFinal, effectiveTarget))) continue;
    matches.push({
      source: original.source,
      target: effectiveTarget,
      preserveSource,
      confidence: finiteConfidence(item?.confidence, 0.7),
      reason: text(item?.reason).slice(0, 200),
      verbatim: false,
      humanFinalVerified: true,
      segmentId: original.segmentId || "",
      segmentSource: original.segmentSource || "",
      humanFinal: original.humanFinal || ""
    });
  }
  const targets = new Map();
  for (const match of matches) {
    const key = normalizeSource(match.source);
    if (!targets.has(key)) targets.set(key, new Set());
    targets.get(key).add(match.target);
  }
  const seen = new Set();
  return { matches: matches.filter((match) => {
    const key = normalizeSource(match.source);
    if (targets.get(key).size > 1 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
}

/**
 * 人工终稿改掉了 AI 建议、又没能（或没敢）让模型定出新译法时，**不能丢**：
 * 转成一条待审核候选，把人需要核对的证据一并写进去。
 * 译法先放 AI 原建议，审核页可以直接改；因为不是逐字确认，永远不会自动入库。
 */
export function pendingCandidateFromUnresolved(input = {}, { locale, contentType = "general", domain = "general", project = "default", batchId = "", filename = "" } = {}) {
  const source = text(input.source);
  const target = text(input.suggestedTarget) || source;
  if (!source || !target || !locale) return null;
  const sourceKey = normalizeSource(source);
  const targetKey = normalizeSource(target);
  return {
    candidateKey: `${locale}\u0000${sourceKey}\u0000${targetKey}`,
    assetType: "term",
    assetTier: "candidate",
    status: "pending",
    approvalStatus: "pending",
    requiresHumanApproval: true,
    proposalAction: "needs_review",
    source,
    target,
    locale,
    aliases: [],
    forbidden: [],
    domains: [domain || "general"],
    contentTypes: [contentType || "general"],
    projects: [project || "default"],
    channels: [],
    platforms: [],
    regions: [],
    enforcement: "preferred",
    caseSensitive: false,
    preserveOriginal: false,
    version: 1,
    confidence: finiteConfidence(input.confidence, 0.5),
    provenance: "term-survey:needs-review",
    batchId: text(batchId),
    taskId: "",
    sourceFile: text(filename),
    sourceRow: null,
    originTermId: "",
    evidence: {
      type: "human_final_differs",
      reason: "人工终稿改动了 AI 建议的译法，需要在入库前确认",
      sourceExcerpt: text(input.segmentSource).slice(0, 200),
      targetExcerpt: text(input.humanFinal).slice(0, 200)
    },
    selected: true,
    decision: "review",
    candidateRole: "needs_review",
    candidateOrigin: "term-survey:needs-review",
    reasons: ["人工终稿改动了 AI 建议的译法，请核对终稿里的实际写法后入库"]
  };
}

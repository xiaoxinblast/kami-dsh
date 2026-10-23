import { extractProtectedTokens, normalizeSource, parseModelJsonObject, similarity } from "./text.mjs";

/**
 * 批次级闭环：逐段 QA 看不见跨段问题——同一句话和同一个专名在不同段落里被译成
 * 两种说法，逐段看每一段都是"合格"的。这里在整批翻完之后做一次全文核对，
 * 并把可量化的部分用确定性规则先算一遍（同原文不同译文、术语登记译法未被采用），
 * 再把语义类漂移交给模型，最后合并成一份待核对清单。
 */
export const CONSISTENCY_CHUNK_MAX_CHARS = 8_000;
export const CONSISTENCY_FINDING_TYPES = Object.freeze([
  "duplicate_source",
  "term_usage_gap",
  "term_drift",
  "name_drift",
  "voice_drift",
  "style_conflict",
  "pattern_drift",
  "format_risk"
]);

const MAX_FINDINGS_PER_CHUNK = 40;
const MAX_TEXT = 300;

/** 核对提示词里的证据上限：够模型判断即可，避免一次把术语库和 TM 全灌进去。 */
export const CONSISTENCY_EVIDENCE_LIMITS = Object.freeze({ terms: 40, tm: 30, styleRules: 12 });

function clip(value, limit = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 分片按字符数：一次核对要能看完整段对照，不能只送半边。 */
export function splitConsistencyChunks(pairs = [], { maxChars = CONSISTENCY_CHUNK_MAX_CHARS } = {}) {
  const chunks = [];
  let current = null;
  pairs.forEach((pair) => {
    const size = String(pair.source || "").length + String(pair.translation || "").length + 32;
    if (!current) current = { ids: [], chars: 0 };
    const overflow = current.ids.length && current.chars + size > maxChars;
    if (overflow) {
      chunks.push(current);
      current = { ids: [], chars: 0 };
    }
    current.ids.push(String(pair.id));
    current.chars += size;
  });
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => ({ index, ids: chunk.ids, chars: chunk.chars }));
}

function evidenceLines(evidence = null) {
  const style = evidence?.style || null;
  const styleText = style
    ? [
      `风格规范：${clip(style.name, 80) || "未命名"}${style.version ? ` · 版本 ${style.version}` : ""}`,
      style.instruction ? `规范说明：${clip(style.instruction, 600)}` : "",
      (Array.isArray(style.rules) ? style.rules : []).slice(0, CONSISTENCY_EVIDENCE_LIMITS.styleRules).length
        ? `规范要点：\n${(style.rules || []).slice(0, CONSISTENCY_EVIDENCE_LIMITS.styleRules).map((rule) => `· ${clip(rule, 140)}`).join("\n")}`
        : "",
      style.registerPolicy ? `语域上限：${JSON.stringify(style.registerPolicy)}` : ""
    ].filter(Boolean).join("\n")
    : "";
  const terms = (Array.isArray(evidence?.terms) ? evidence.terms : []).slice(0, CONSISTENCY_EVIDENCE_LIMITS.terms);
  const termsText = terms.length
    ? terms.map((item) => `· ${clip(item.source, 80)} → ${clip(item.target, 80)}${item.mode ? ` [${clip(item.mode, 20)}]` : ""}`).join("\n")
    : "";
  const tm = (Array.isArray(evidence?.tm) ? evidence.tm : []).slice(0, CONSISTENCY_EVIDENCE_LIMITS.tm);
  const tmText = tm.length
    ? tm.map((item) => `· ${clip(item.source, 90)} → ${clip(item.target, 90)}${item.authority ? `［${clip(item.authority, 30)}］` : ""}`).join("\n")
    : "";
  return [
    styleText ? `风格指南（项目生效版本，判断语体/口吻漂移时以它为准）：\n${styleText}` : "",
    termsText ? `登记术语（项目术语库里命中本片原文的条目，术语写法以它为准）：\n${termsText}` : "",
    tmText ? `翻译记忆（按权威排序：主 TM/参考 TM 的人工译例优先；工作 TM 的机器译例只作参考，不得当作权威）：\n${tmText}` : ""
  ].filter(Boolean);
}

export function consistencyMessages({ filename = "", locale = "zh-CN", purpose = "general", pairs = [], part = null, evidence = null } = {}) {
  const partLine = part ? `这是整份文件的第 ${part.index + 1} / ${part.total} 片，id 沿用文件里的条目 id。\n` : "";
  const system = [
    "你是日语到简体中文本地化项目的交付前一致性审核员。你只看**跨条目的不一致**，不重复逐条 QA 已经查过的问题。",
    "只报这两类：① 同一角色、同一专名、同一术语或同一固定说法在不同条目里出现了不一致的译法；② 同一角色的口吻、敬语级别在不同条目里明显漂移。",
    "同一固定句式只替换关键词时，固定部分的译法漂移也要报 pattern_drift：terms/unify 只填需要统一的固定说法，不要要求整句一致。",
    "不要报单条问题（漏译、错译、标点、术语未采用），也不要给主观润色建议。没有发现就返回空数组。",
    "判断前先看证据：登记术语与人工批准的翻译记忆是权威，按它判定该统一成哪个写法；工作 TM 的机器译例只能参考。",
    "证据不足时不要自己发明统一译法：把 suggestion 写成「依据缺失，需人工决定：……」，unify 留空数组。",
    `type 只能是：${CONSISTENCY_FINDING_TYPES.join(" / ")}。`,
    "ids 必须逐字引用输入里的条目 id，至少两个；detail 与 suggestion 用简体中文。",
    "terms 填这条 finding 涉及的原词与它在文件里出现过的写法；unify 填你建议的统一方案（每个原词一个 target，写法和 variant 逐字一致）；evidence 填你依据的条目。",
    '只输出严格 JSON：{"findings":[{"type":"term_drift","ids":["seg-3","seg-88"],"detail":"同一个专名在两条里译法不同","suggestion":"统一为其中一种并复核术语库","terms":[{"source":"無効","variants":["禁用","关闭"]}],"unify":[{"source":"無効","target":"禁用"}],"evidence":[{"kind":"term","ref":"無効 → 禁用"}]}]}',
    "整个回答只能是一个 JSON 对象：禁止拆成多段、禁止 Markdown、解释或代码围栏。"
  ].join("\n");
  const evidenceText = evidenceLines(evidence);
  const user = [
    `文件名：${filename || "未命名"}`,
    `目标语言：${locale}`,
    `文件整体用途：${purpose}`,
    partLine,
    ...evidenceText,
    "条目对照：",
    JSON.stringify(pairs.map((pair) => ({ id: pair.id, source: clip(pair.source, 400), translation: clip(pair.translation, 400) })))
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

function extractJsonObject(content) {
  try {
    return parseModelJsonObject(content);
  } catch (error) {
    throw new Error(`一致性检查模型未返回 JSON（${error.message}）`);
  }
}

const MAX_FINDING_TERMS = 8;
const MAX_FINDING_VARIANTS = 6;
const MAX_FINDING_UNIFY = 8;
const MAX_FINDING_EVIDENCE = 8;

/** 模型给的"涉及哪些原词、出现过哪些写法"：字段残缺时按空数组处理，不因此丢整条 finding。 */
function parseFindingTerms(list = []) {
  const terms = [];
  for (const item of Array.isArray(list) ? list : []) {
    const source = clip(item?.source, 120);
    if (!source) continue;
    const variants = [...new Set((Array.isArray(item?.variants) ? item.variants : [])
      .map((value) => clip(value, 120)).filter(Boolean))].slice(0, MAX_FINDING_VARIANTS);
    terms.push({ source, variants });
    if (terms.length >= MAX_FINDING_TERMS) break;
  }
  return terms;
}

/** 模型建议的统一方案：只保留 source/target 都非空的项，统一值是否成立由裁决层复核。 */
function parseFindingUnify(list = []) {
  const unify = [];
  for (const item of Array.isArray(list) ? list : []) {
    const source = clip(item?.source, 120);
    const target = clip(item?.target, 120);
    if (!source || !target) continue;
    unify.push({ source, target });
    if (unify.length >= MAX_FINDING_UNIFY) break;
  }
  return unify;
}

function parseFindingEvidence(list = []) {
  const evidence = [];
  for (const item of Array.isArray(list) ? list : []) {
    const ref = clip(item?.ref, 160);
    const kind = clip(item?.kind, 32);
    const note = clip(item?.note, 160);
    if (!ref && !kind) continue;
    evidence.push({ kind, ref, note });
    if (evidence.length >= MAX_FINDING_EVIDENCE) break;
  }
  return evidence;
}

/** 解析一片结论；引用了本片之外条目 id 的发现整条丢弃，宁可少报也不误报。 */
export function parseConsistencyFindings(content, { validIds = [] } = {}) {
  const payload = extractJsonObject(content);
  const allowed = new Set((Array.isArray(validIds) ? validIds : []).map(String));
  const findings = [];
  const dropped = [];
  for (const item of Array.isArray(payload.findings) ? payload.findings : []) {
    const ids = [...new Set((Array.isArray(item?.ids) ? item.ids : []).map(String).filter((id) => allowed.has(id)))];
    const detail = clip(item?.detail);
    if (!detail || ids.length < 2) {
      dropped.push({ reason: "缺少有效条目引用", value: item });
      continue;
    }
    const type = CONSISTENCY_FINDING_TYPES.includes(String(item?.type)) ? String(item.type) : "term_drift";
    findings.push({
      type,
      ids,
      detail,
      suggestion: clip(item?.suggestion),
      source: "model",
      terms: parseFindingTerms(item?.terms),
      unify: parseFindingUnify(item?.unify),
      evidence: parseFindingEvidence(item?.evidence)
    });
    if (findings.length >= MAX_FINDINGS_PER_CHUNK) break;
  }
  return { findings, dropped };
}

export function mergeConsistencyFindings(parts = []) {
  const merged = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    for (const finding of part.findings || []) {
      if (merged.some((item) => item.type === finding.type && item.detail === finding.detail)) continue;
      merged.push(finding);
    }
  }
  return merged;
}


/** 译文侧的变量遮罩：术语译法、数字、URL、拉丁标识不该把同句式误报成漂移。 */
function targetPattern(text, terms = []) {
  const targets = [...new Set((Array.isArray(terms) ? terms : [])
    .map((term) => String(term?.target || "").trim())
    .filter(Boolean))].sort((left, right) => [...right].length - [...left].length);
  let value = String(text ?? "");
  for (const target of targets) {
    if (target && value.includes(target)) value = value.split(target).join("⟦术⟧");
  }
  return normalizeSource(value
    .replace(/https?:\/\/\S+/giu, "⟦链⟧")
    .replace(/[A-Za-z][A-Za-z0-9_.-]*/gu, "⟦英⟧")
    .replace(/\d+(?:[.,]\d+)*/gu, "⟦数⟧")
    .replace(/\s+/gu, " ")
    .trim());
}

/**
 * 确定性部分：不花模型额度就能证明的不一致。
 *  ① 同一原文在同一文件里出现多次却给了不同译文；
 *  ② 术语库已登记译法在同一文件里有的段落采用、有的没有（术语允许语境判断，
 *     所以这里报"待确认"，不判错）。
 */
export function deterministicConsistencyFindings(segments = [], { terms = [] } = {}) {
  const findings = [];
  const bySource = new Map();
  segments.forEach((segment) => {
    const translation = String(segment.translation || "").trim();
    if (!translation || segment.selected === false) return;
    const key = normalizeSource(segment.source);
    if (!key) return;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(segment);
  });
  for (const [, list] of bySource) {
    if (list.length < 2) continue;
    const variants = new Map();
    for (const segment of list) variants.set(String(segment.translation || "").trim(), segment);
    if (variants.size < 2) continue;
    findings.push({
      type: "duplicate_source",
      ids: list.map((segment) => String(segment.id)),
      detail: `同一原文出现 ${list.length} 次，却有 ${variants.size} 种不同译文：${[...variants.keys()].map((value) => clip(value, 60)).join(" / ")}`,
      suggestion: "确认这几处是否应保持一致，或原文本身一字多义需要区分。",
      source: "rule",
      // 同一原文的两种写法：统一成哪个由裁决层按术语库 / 人工 TM / 文件内多数定案。
      terms: [{ source: String(list[0].source || "").trim(), variants: [...variants.keys()].slice(0, 6) }],
      unify: [],
      evidence: []
    });
  }
  // 同骨架、不同原文：固定句式只换了关键词，固定部分却漂了。
  // 只报事实；统一方案交给模型 finding 的 unify（有证据才自动替换）。
  const byPattern = new Map();
  for (const segment of segments) {
    const translation = String(segment.translation || "").trim();
    const patternKey = String(segment.result?.patternKey || "").trim();
    if (!translation || segment.selected === false || !patternKey) continue;
    if (!byPattern.has(patternKey)) byPattern.set(patternKey, []);
    byPattern.get(patternKey).push(segment);
  }
  for (const [, list] of byPattern) {
    if (list.length < 2) continue;
    if (new Set(list.map((segment) => normalizeSource(segment.source))).size < 2) continue;
    const variants = new Map();
    for (const segment of list) variants.set(String(segment.translation || "").trim(), segment);
    if (variants.size < 2) continue;
    const patterns = [...variants.keys()].map((value) => targetPattern(value, terms));
    if (patterns.every((value) => value === patterns[0]) || Math.min(...patterns.map((value) => similarity(value, patterns[0]))) >= 0.8) continue;
    findings.push({
      type: "pattern_drift",
      ids: list.map((segment) => String(segment.id)).slice(0, 12),
      detail: `同一固定句式出现 ${list.length} 次、换了关键词，却有 ${variants.size} 种不同译法：${[...variants.keys()].map((value) => clip(value, 60)).join(" / ")}`,
      suggestion: "确认固定部分应统一成哪种写法；只改固定说法，变量部分保持当前译法。",
      source: "rule",
      terms: [],
      unify: [],
      evidence: []
    });
  }
  const termUsage = new Map();
  for (const segment of segments) {
    const translation = String(segment.translation || "").trim();
    if (!translation || segment.selected === false) continue;
    for (const match of Array.isArray(segment.result?.matches) ? segment.result.matches : []) {
      const expected = String(match?.expectedTarget || match?.term?.target || "").trim();
      if (!expected || match?.mode !== "exact") continue;
      const key = `${match.term?.source || match.matchPhrase || ""}\u0000${expected}`;
      if (!termUsage.has(key)) termUsage.set(key, { expected, hits: [], misses: [] });
      const bucket = termUsage.get(key);
      if (normalizeSource(translation).includes(normalizeSource(expected))) bucket.hits.push(segment);
      else bucket.misses.push(segment);
    }
  }
  for (const [key, bucket] of termUsage) {
    if (!bucket.hits.length || !bucket.misses.length) continue;
    const [source] = key.split("\u0000");
    findings.push({
      type: "term_usage_gap",
      ids: [...bucket.hits, ...bucket.misses].map((segment) => String(segment.id)).slice(0, 12),
      detail: `术语「${source}」的登记译法「${bucket.expected}」在 ${bucket.hits.length} 条里采用、在 ${bucket.misses.length} 条里未采用`,
      suggestion: "逐条确认未采用的地方是语境判断，还是漏用；确认后统一。",
      source: "rule",
      // 术语允许按语境判断，所以这条只补充依据、不自动替换（裁决层按 report_only 处理）。
      terms: [{ source, variants: [bucket.expected] }],
      unify: [],
      evidence: [{ kind: "term", ref: `${source} → ${bucket.expected}`, note: "术语库登记译法" }]
    });
  }
  return findings;
}

function isFactIssue(issue) {
  const type = String(issue?.type || "");
  return type.startsWith("fact_") || type === "length_limit_exceeded" || type === "number_drift";
}

/**
 * 批次质量报告：全部指标来自批次记录本身（可复算、可追溯），不额外调模型。
 */
export function buildQualityReport({ segments = [], brief = null, findings = [], provider = {}, styleProfile = null, batchId = "", filename = "", locale = "" } = {}) {
  const selected = segments.filter((segment) => segment.selected !== false);
  const done = selected.filter((segment) => segment.translation);
  const failed = selected.filter((segment) => segment.status === "error");
  const tiers = { fast: 0, standard: 0, strict: 0, unknown: 0 };
  const purposes = new Map();
  let modelQa = 0;
  let upgrades = 0;
  let review = 0;
  let protectedTotal = 0;
  let protectedKept = 0;
  let termExpected = 0;
  let termHit = 0;
  let fuzzyExpected = 0;
  let fuzzyHit = 0;
  let forbiddenHits = 0;
  let factIssueCount = 0;
  let factIssueSegments = 0;
  const scores = [];
  const reviewReasons = new Map();
  for (const segment of selected) {
    const result = segment.result || {};
    const tier = String(result.qualityTier || "");
    tiers[Object.hasOwn(tiers, tier) ? tier : "unknown"] += 1;
    const purpose = String(result.segmentPurpose || "general");
    purposes.set(purpose, (purposes.get(purpose) || 0) + 1);
    if (result.qualityUpgradeFrom) upgrades += 1;
    // 快速档不跑模型质检，qaScore 是 null：不能因为 Number(null) === 0 就把它当成
    // "0 分段落"——那会让平均分与覆盖率同时失真（真实发生过）。
    const hasScore = result.qaScore !== null && result.qaScore !== undefined && result.qaScore !== ""
      && Number.isFinite(Number(result.qaScore));
    if (hasScore && !result.aiQa?.fallbackReason) {
      scores.push(Number(result.qaScore));
      modelQa += 1;
    }
    const issues = Array.isArray(result.issues) ? result.issues : [];
    if (issues.some((issue) => issue?.type === "forbidden_term")) forbiddenHits += 1;
    const factIssues = issues.filter(isFactIssue);
    if (factIssues.length) {
      factIssueCount += factIssues.length;
      factIssueSegments += 1;
    }
    const translation = String(segment.translation || "");
    const tokens = extractProtectedTokens(segment.source);
    if (tokens.length) {
      protectedTotal += tokens.length;
      protectedKept += tokens.filter((token) => translation.includes(token)).length;
    }
    // 采用率只算精确命中：模糊/智能命中只是提示，把它们算进"应采用的登记译法"会把
    // 「语境判断未采用」误报成漏用，报告里就会出现 50% 这种吓人又不准的数字。
    for (const match of Array.isArray(result.matches) ? result.matches : []) {
      const expected = String(match?.expectedTarget || match?.term?.target || "").trim();
      if (!expected) continue;
      const hit = normalizeSource(translation).includes(normalizeSource(expected));
      if (match?.mode === "exact") {
        termExpected += 1;
        if (hit) termHit += 1;
      } else {
        fuzzyExpected += 1;
        if (hit) fuzzyHit += 1;
      }
    }
    const reasons = [];
    if (segment.status === "error") reasons.push("翻译失败");
    if (result.aiQa?.fallbackReason) reasons.push("AIQA 未完成");
    if (hasScore && Number(result.qaScore) < 90) reasons.push("质量分低于 90");
    if (issues.some((issue) => ["error", "critical"].includes(String(issue?.severity)))) reasons.push("存在阻断级问题");
    if (reasons.length) {
      review += 1;
      for (const reason of reasons) reviewReasons.set(reason, (reviewReasons.get(reason) || 0) + 1);
    }
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const average = sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null;
  const byType = new Map();
  for (const finding of findings) byType.set(finding.type, (byType.get(finding.type) || 0) + 1);
  return {
    version: 1,
    batchId,
    filename,
    locale,
    generatedAt: new Date().toISOString(),
    totals: { selected: selected.length, translated: done.length, failed: failed.length },
    tiers,
    upgrades,
    purposes: [...purposes.entries()].map(([purpose, count]) => ({ purpose, count })).sort((a, b) => b.count - a.count),
    coverage: {
      modelQa,
      qaIncomplete: done.filter((segment) => segment.result?.aiQa?.fallbackReason).length,
      deterministicOnly: Math.max(0, done.length - modelQa),
      percent: done.length ? Math.round((modelQa / done.length) * 100) : 0
    },
    scores: {
      average,
      distribution: {
        ">=95": sorted.filter((value) => value >= 95).length,
        "90-94": sorted.filter((value) => value >= 90 && value < 95).length,
        "<90": sorted.filter((value) => value < 90).length,
        unscored: Math.max(0, done.length - sorted.length)
      }
    },
    terms: {
      expectedUses: termExpected,
      applied: termHit,
      adoptionRate: termExpected ? Math.round((termHit / termExpected) * 100) : null,
      fuzzyExpected,
      fuzzyApplied: fuzzyHit,
      basis: "recorded-matches"
    },
    facts: { issueCount: factIssueCount, segments: factIssueSegments },
    protectedTokens: { total: protectedTotal, preserved: protectedKept },
    forbiddenTermSegments: forbiddenHits,
    humanReview: { suggested: review, reasons: [...reviewReasons.entries()].map(([reason, count]) => ({ reason, count })) },
    consistency: { findings: findings.length, byType: [...byType.entries()].map(([type, count]) => ({ type, count })) },
    contextBrief: brief ? {
      status: brief.status || "ready",
      documentPurpose: brief.documentType?.purpose || "general",
      sections: (brief.sections || []).length,
      coverage: brief.coverage || null
    } : null,
    model: String(provider.model || ""),
    styleProfile: styleProfile ? { id: styleProfile.id || "", name: styleProfile.name || "", version: styleProfile.version || 1 } : null
  };
}

/**
 * 待核对项的 AI 终审：规则/模型已经报出、但没有证据可自动统一的条目，
 * 交给模型逐条判断"要不要改、改成什么"（只允许短语级替换，不重写整段）。
 */
export function adjudicationMessages({ filename = "", locale = "zh-CN", purpose = "general", findings = [], segments = [] } = {}) {
  const byId = new Map((Array.isArray(segments) ? segments : []).map((segment) => [String(segment.id || ""), segment]));
  const items = (Array.isArray(findings) ? findings : []).map((finding, index) => ({
    index,
    type: finding?.type || "",
    detail: clip(finding?.detail, 300),
    suggestion: clip(finding?.suggestion, 200),
    ids: (finding?.ids || []).map(String),
    segments: (finding?.ids || []).map((id) => {
      const segment = byId.get(String(id));
      return segment ? { id: String(id), source: clip(segment.source, 200), translation: clip(segment.translation, 200) } : null;
    }).filter(Boolean).slice(0, 8)
  }));
  return [
    {
      role: "system",
      content: [
        "你是本地化项目的终审编辑。输入是一批「跨条目不一致」问题：规则或模型已经发现，但没有术语库/主 TM/文件内多数等证据可自动统一。",
        "请逐条判断：改不改？改成什么？",
        "只允许做短语级替换（from 必须是某段译文里真实出现的连续子串，target 是统一后的写法）；不要重写整段，不要改占位符、数字、URL、格式标记。",
        "拿不准就 keep。保留人工已经采纳的段落不动。",
        '只输出紧凑 JSON：{"decisions":[{"index":0,"verdict":"unify","from":"旧写法","target":"新写法","ids":["段落id"],"reason":"一句话依据"},{"index":1,"verdict":"keep","reason":"为什么不用改"}]}。',
        "ids 省略或为空表示这条 finding 的全部段落；verdict 只能是 unify 或 keep。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `文件：${clip(filename, 120) || "(未命名)"}｜语言：${locale}｜内容类型：${purpose}`,
        `待裁决的 ${items.length} 条：`,
        JSON.stringify({ decisions: [] , findings: items })
      ].join("\n")
    }
  ];
}

/** 解析 AI 裁决；只接受本批 finding 序号和本批段落 id，避免模型改到别处。 */
export function parseAdjudicationDecisions(content, { validIndexes = [], validIds = [] } = {}) {
  const payload = extractJsonObject(content);
  const allowedIndexes = new Set((Array.isArray(validIndexes) ? validIndexes : []).map(Number));
  const allowedIds = new Set((Array.isArray(validIds) ? validIds : []).map(String));
  const decisions = [];
  for (const item of Array.isArray(payload.decisions) ? payload.decisions : []) {
    const index = Number(item?.index);
    if (!allowedIndexes.has(index)) continue;
    const verdict = item?.verdict === "unify" ? "unify" : "keep";
    const from = clip(item?.from, 120);
    const target = clip(item?.target, 120);
    if (verdict === "unify" && (!from || !target)) {
      decisions.push({ index, verdict: "keep", from: "", target: "", ids: [], reason: "模型没有给出可执行的替换写法" });
      continue;
    }
    const ids = [...new Set((Array.isArray(item?.ids) ? item.ids : []).map(String).filter((id) => allowedIds.has(id)))];
    decisions.push({
      index,
      verdict,
      from: verdict === "unify" ? from : "",
      target: verdict === "unify" ? target : "",
      ids,
      reason: clip(item?.reason, 240)
    });
  }
  return decisions;
}

import { CONTENT_TYPES, LOCALES } from "./config.mjs";
import { punctuationGuidance } from "./orthography.mjs";
import { detectRhymeLike, extractProtectedTokens, normalizeSource } from "./text.mjs";
import { normalizeBatchReferences } from "./batch-verse.mjs";
import { contentTypeDirective, registerPolicyFor } from "./register-classifier.mjs";

function normalizeNeighborContext(neighborContext) {
  if (typeof neighborContext === "string") return { previous: "", next: "", note: neighborContext };
  const normalizeItems = (items) => Array.isArray(items) ? items.slice(0, 20).map((item) => ({
    label: String(item?.label || "补充信息"),
    value: String(item?.value || ""),
    role: String(item?.role || "context")
  })).filter((item) => item.value) : [];
  return {
    previous: String(neighborContext?.previous || ""),
    next: String(neighborContext?.next || ""),
    note: String(neighborContext?.note || ""),
    document: String(neighborContext?.document || ""),
    sheet: String(neighborContext?.sheet || ""),
    row: Number(neighborContext?.row) || undefined,
    sourceColumn: String(neighborContext?.sourceColumn || ""),
    metadata: normalizeItems(neighborContext?.metadata),
    referenceTranslations: normalizeItems(neighborContext?.referenceTranslations),
    segmentIndex: Number(neighborContext?.segmentIndex) || undefined,
    segmentCount: Number(neighborContext?.segmentCount) || undefined
  };
}

export function buildContextPack({ source, locale, classification, matches, domain = "general", neighborContext = "", styleProfile = null, translationSkill = null, qaGuidance = [], userProfile = null, translationReferences = [], batchVerse = null, batchReferences = [], patternReferences = [], batchGroupEntries = [], factSchema = null, titleOverrides = null, entryId = "", entryKey = "", documentBrief = null }) {
  // 字符串精确命中只能证明字面相同，不能证明当前句子使用的是术语义。
  // 仅“保留原文”属于可确定执行的硬约束；普通正式术语交给翻译器结合上下文判断。
  // 工作术语单独分层：主术语库优先，工作术语只解决"本文件内保持一致"。
  const working = matches.filter((item) => item.term?.working === true);
  const required = matches.filter((item) => !item.term?.working && item.mode === "exact" && !item.scopeMismatch && (item.preserveOriginal ?? item.term?.preserveOriginal));
  const preferred = matches.filter((item) => !item.term?.working && !required.includes(item));
  // 同一个原文登记了多个译法时，必须让模型知道"只能选一个"：否则它会在同一句里
  // 混用两种译法，或者自己造第三种。
  const targetsBySource = new Map();
  for (const item of matches) {
    const key = normalizeSource(item.term?.source || item.matchPhrase || "");
    if (!key) continue;
    if (!targetsBySource.has(key)) targetsBySource.set(key, new Set());
    targetsBySource.get(key).add(String(item.term?.target || "").trim());
  }
  const conflictedSources = new Set([...targetsBySource.entries()].filter(([, targets]) => [...targets].filter(Boolean).length > 1).map(([key]) => key));
  const defaultRegister = CONTENT_TYPES[classification.contentType].register;
  return {
    sourceLanguage: "Japanese",
    targetLocale: locale,
    // 当前段落的条目身份：用于提示词消歧，以及 CAT 匹配时判断"是不是同一条目"。
    entryId: String(entryId || ""),
    entryKey: String(entryKey || ""),
    targetLanguage: LOCALES[locale].language,
    domain,
    contentType: classification.contentType,
    contentTypeLabel: CONTENT_TYPES[classification.contentType].label,
    contentTags: Array.isArray(classification.contentTags) ? classification.contentTags.slice(0, 8) : [],
    register: defaultRegister,
    // 文件级语境分析的切片：本段用途、所属区间、跨条目一致性与格式注意点。
    documentBrief: documentBrief || null,
    translationReferences: Array.isArray(translationReferences) ? translationReferences.slice(0, 5).map((item) => ({
      source: item.source,
      target: item.target,
      similarity: Number(item.similarity) || 0,
      matchEvidence: item.matchEvidence || (item.catMatchRate ? `CAT ${item.catMatchRate}%` : "语义/模糊匹配"),
      catMatchRate: item.catMatchRate || null,
      catMatchKind: item.catMatchKind || "",
      qualityStatus: item.qualityStatus || "",
      libraryName: item.libraryName || "",
      libraryRole: item.libraryRole || "",
      libraryPriority: Number.isFinite(Number(item.libraryPriority)) ? Number(item.libraryPriority) : null,
      entryId: item.entryId || "",
      // 条目身份键与来源文件：确认模型的参考译例确实来自这条记录（memoQ 的 x-mmq-context）。
      entryKey: item.entryKey || "",
      contentType: item.contentType || "general",
      contentTags: Array.isArray(item.contentTags) ? item.contentTags.slice(0, 8) : [],
      provenance: item.provenance || "",
      sourceFile: item.sourceFile || "",
      sourceRow: item.sourceRow || null,
      previousSource: item.previousSource || "",
      nextSource: item.nextSource || ""
    })) : [],
    userProfile: userProfile ? {
      id: String(userProfile.id || ""),
      name: String(userProfile.name || "译者画像"),
      instruction: String(userProfile.instruction || ""),
      version: Number(userProfile.version) || 1,
      examples: Array.isArray(userProfile.examples) ? userProfile.examples.slice(0, 4) : []
    } : null,
    styleProfile: {
      id: String(styleProfile?.id || "content-type-default"),
      name: String(styleProfile?.name || CONTENT_TYPES[classification.contentType].label),
      source: String(styleProfile?.source || "content-type"),
      instruction: String(styleProfile?.instruction || defaultRegister),
      generationRules: Array.isArray(styleProfile?.rules) ? styleProfile.rules.slice(0, 30) : [],
      // 语体写作指令与语域容忍度来自同一张表：生成按它写，事后按它判。
      contentTypeDirective: contentTypeDirective(classification.contentType),
      registerPolicy: registerPolicyFor(classification.contentType, styleProfile?.reviewRubric?.registerPolicy || null),
      reviewRubric: styleProfile?.reviewRubric || {
        accuracy: "不得漏译、增译、误译或改变事实与承诺强度",
        fluency: "目标语言应自然、通顺且没有翻译腔",
        terminology: "正式术语须结合当前句义判断；禁用译法与保留原文规则必须执行",
        style: "遵守当前语体、品牌语气和正反例",
        locale: "符合目标地区书写、日期、标点及文化习惯",
        platform: "平台名、字符限制、占位符和渠道规则必须正确"
      },
      version: Number(styleProfile?.version) || 1,
      examples: Array.isArray(styleProfile?.examples) ? styleProfile.examples.slice(0, 8) : []
    },
    translationSkill: translationSkill ? {
      id: String(translationSkill.id || ""),
      name: String(translationSkill.name || "翻译技能"),
      version: Number(translationSkill.version) || 1,
      promptVersion: String(translationSkill.promptVersion || ""),
      instruction: String(translationSkill.strategy?.prompting?.additionalInstruction || translationSkill.strategy?.instruction || ""),
      additionalRules: Array.isArray(translationSkill.strategy?.prompting?.additionalRules || translationSkill.strategy?.additionalRules)
        ? (translationSkill.strategy.prompting?.additionalRules || translationSkill.strategy.additionalRules).slice(0, 12).map(String)
        : [],
      strategy: translationSkill.strategy || {}
    } : null,
    localeInstruction: LOCALES[locale].defaultInstruction,
    punctuation: punctuationGuidance(locale, titleOverrides),
    // 注释为空时不下发这个键：提示词里塞满 `"note": ""` 只是噪音。
    requiredTerms: required.map(({ term, expectedTarget, libraryName, libraryPriority }) => ({
      source: term.source,
      target: expectedTarget || term.source,
      preserveOriginal: true,
      ...(String(term.note || "").trim() ? { note: term.note } : {}),
      libraryName: libraryName || term.libraryName || "",
      libraryPriority: libraryPriority ?? term.libraryPriority ?? null
    })),
    preferredTerms: preferred.map(({ term, mode, matchPhrase, score, scopeMismatch }) => ({
      source: term.source,
      matchedSource: matchPhrase,
      target: term.target,
      matchMode: mode,
      confidence: Number(score.toFixed(2)),
      libraryName: term.libraryName || "",
      libraryPriority: Number.isFinite(Number(term.libraryPriority)) ? Number(term.libraryPriority) : null,
      forbidden: term.forbidden || [],
      ...(conflictedSources.has(normalizeSource(term.source || matchPhrase || "")) ? { conflict: true } : {}),
      note: scopeMismatch
        ? `该术语不属于当前主分类，仅作跨场景参考，不得强制采用。${term.note || ""}`
        : (mode === "exact"
          ? `原文精确命中，但仍须结合当前句义判断是否采用登记译法，不得仅凭字符串强制替换。${term.note || ""}`
          : `疑似术语，仅供参考，不得未经判断强制替换。${term.note || ""}`)
    })),
    protectedTokens: extractProtectedTokens(source),
    factSchema: factSchema ? {
      version: String(factSchema.version || "1.0"),
      facts: Array.isArray(factSchema.facts) ? factSchema.facts.slice(0, 80) : [],
      limits: Array.isArray(factSchema.limits) ? factSchema.limits.slice(0, 20) : [],
      summary: factSchema.summary || {}
    } : null,
    rhymeLike: detectRhymeLike(source),
    batchVerse: batchVerse?.active ? { active: true, shape: String(batchVerse.shape || ""), matchingCount: Math.max(0, Number(batchVerse.matchingCount) || 0) } : null,
    batchReferences: normalizeBatchReferences(batchReferences),
    workingTerms: working.map(({ term, mode, matchPhrase, score }) => ({
      source: term.source,
      matchedSource: matchPhrase,
      target: term.target,
      matchMode: mode,
      confidence: Number(score.toFixed(2)),
      enforcement: term.enforcement === "required" ? "required" : "preferred",
      working: true
    })),
    patternReferences: Array.isArray(patternReferences) ? patternReferences.slice(0, 3).map((item) => ({
      segmentId: String(item?.segmentId || ""),
      source: String(item?.source || ""),
      target: String(item?.target || ""),
      accepted: item?.accepted === true,
      similarity: Number(item?.similarity) || 0
    })).filter((item) => item.source && item.target) : [],
    batchGroupEntries: Array.isArray(batchGroupEntries) ? batchGroupEntries.slice(0, 50).map((item) => ({
      id: String(item?.id || ""), source: String(item?.source || ""), context: item?.context || null
    })).filter((item) => item.id && item.source) : [],
    qaGuidance: Array.isArray(qaGuidance) ? qaGuidance.slice(0, 3).map((item) => ({
      id: item.id,
      source: item.source,
      rejectedTranslation: item.rejectedTranslation,
      correctedTranslation: item.correctedTranslation,
      issues: item.issues,
      similarity: item.similarity
    })) : [],
    neighborContext: normalizeNeighborContext(neighborContext),
    source
  };
}

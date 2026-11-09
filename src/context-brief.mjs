import { CONTENT_TYPES } from "./config.mjs";
import { parseModelJsonObject } from "./text.mjs";

/**
 * 文件级语境分析（语境档案）。
 *
 * 逐句猜用途本来就不可靠：同一份文件里系统说明、成就条目、剧情对白混在一起，
 * 单句给的信号太弱。这里改成翻译前通读整份文件一次，让模型按条目区间标出用途、
 * 语气、跨区域关联和格式注意点；逐段翻译时只继承结论，不再重新猜。
 *
 * 本模块只做纯计算：分片、提示词、解析校验、合并、取用。模型调用放在 provider。
 */
export const CONTEXT_BRIEF_VERSION = 1;
export const CONTEXT_BRIEF_CHUNK_MAX_SEGMENTS = 100;
export const CONTEXT_BRIEF_CHUNK_MAX_CHARS = 40_000;
/** 太短的文件没有"上下文"可言，直接按单句判定，省一次调用。 */
export const CONTEXT_BRIEF_MIN_SEGMENTS = 6;
export const CONTEXT_BRIEF_PURPOSES = Object.freeze(Object.keys(CONTENT_TYPES));

const MAX_SECTIONS_PER_CHUNK = 60;
const MAX_NOTES = 40;
const MAX_CROSS_REFS = 40;
const MAX_TEXT = 300;
const ENTRY_TEXT_LIMIT = 600;

export function isContextBriefPurpose(value) {
  return CONTENT_TYPES[String(value || "")] !== undefined;
}

export function contextPurposeLabel(purpose) {
  return CONTENT_TYPES[String(purpose || "")]?.label || CONTENT_TYPES.general.label;
}

function clip(value, limit = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 语境分析的最小输入：只送会改变判断的信息，长条目截断，避免把提示词撑爆。
 *
 * 条目编号一律用"在整批里的第几条"（1 起），**不用 segment.index**：批次文档里的
 * index 本身就是 1 起，再用它 +1 会让整份档案错位一格，每段继承到上一段的用途。
 */
export function contextBriefEntries(segments = [], indices = null) {
  const allowed = indices ? new Set(indices) : null;
  return segments.map((segment, position) => {
    if (allowed && !allowed.has(position)) return null;
    const locator = segment.locator || {};
    const metadata = Array.isArray(segment.context?.metadata) ? segment.context.metadata : [];
    return {
      i: position + 1,
      id: String(segment.id || `seg-${position + 1}`),
      text: clip(segment.source, ENTRY_TEXT_LIMIT),
      sheet: String(locator.sheet || segment.context?.sheet || ""),
      row: Number(locator.row || segment.context?.row) || undefined,
      hint: clip(metadata.map((item) => `${item.label}：${item.value}`).join("｜"), 120) || undefined
    };
  }).filter(Boolean);
}

/**
 * 分片：条数与字符数双阈值。只有确实超出单份语境容量时才分片，
 * 合并阶段再把分片结论拼回一份全局档案。
 */
export function splitContextChunks(segments = [], { maxSegments = CONTEXT_BRIEF_CHUNK_MAX_SEGMENTS, maxChars = CONTEXT_BRIEF_CHUNK_MAX_CHARS } = {}) {
  const chunks = [];
  let current = null;
  segments.forEach((segment, position) => {
    const size = String(segment.source || "").length + 32;
    if (!current) current = { indices: [], chars: 0 };
    const overflow = current.indices.length >= maxSegments || (current.indices.length && current.chars + size > maxChars);
    if (overflow) {
      chunks.push(current);
      current = { indices: [], chars: 0 };
    }
    current.indices.push(position);
    current.chars += size;
  });
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => ({ index, indices: chunk.indices, chars: chunk.chars }));
}

/** 语境分析提示词：要求严格 JSON，并明确"只报会改变译法的信息"。 */
export function contextBriefMessages({ filename = "", format = "", locale = "zh-CN", declaredPurpose = "", entries = [], part = null } = {}) {
  const purposes = CONTEXT_BRIEF_PURPOSES.join(" / ");
  const partLine = part ? `这是整份文件的第 ${part.index + 1} / ${part.total} 片，条目编号保持全文编号，不要重新编号。\n` : "";
  const system = [
    "你是日语到简体中文本地化项目的语境分析员。通读给定的文件条目，只输出会改变译法的结论，不要复述原文。",
    `用途标签只能从这个清单里选：${purposes}。拿不准就用 general。`,
    "sections 用条目编号 from/to 表示连续区间，必须覆盖你确实读懂的条目；相邻且用途相同的条目合并成一段，不要一条一句。",
    "notes 只写可执行的注意事项：必须原样保留的标签与占位符、换行与格式风险、重复内容、角色语气。不要写主观评价。",
    "crossRefs 只写跨区域必须一致的地方（同一角色、同一说法、同一专名在不同区间出现）。",
    '只输出严格 JSON：{"documentType":{"purpose":"general","audience":"","tone":"","summary":""},"sections":[{"from":1,"to":40,"purpose":"dialogue","tone":"","note":""}],"crossRefs":[{"ids":["seg-1","seg-88"],"note":""}],"notes":[{"text":"","ids":[]}]}',
    "整个回答只能是一个 JSON 对象：禁止拆成多段、禁止 Markdown、解释或代码围栏。没有内容的数组留空数组。"
  ].join("\n");
  const user = [
    `文件名：${filename || "未命名"}`,
    format ? `文件格式：${format}` : "",
    `目标语言：${locale}`,
    declaredPurpose ? `导入时声明的整体用途：${declaredPurpose}（与你的判断冲突时以通读结论为准，并在 notes 里说明）` : "",
    partLine,
    "文件条目（i 是条目编号，全文连续）：",
    JSON.stringify(entries)
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
    throw new Error(`语境分析模型未返回 JSON（${error.message}）`);
  }
}

/**
 * 解析并校验一片的结论。模型偶尔会把条目编号写成自己重排的序号，或者给不存在的
 * 条目编号；这些一律按"落在本片范围内"收拢，落在范围外的整段丢弃，绝不猜测。
 */
export function parseContextBriefPart(content, { entries = [] } = {}) {
  const payload = extractJsonObject(content);
  const validEntries = entries.filter((entry) => Number.isFinite(Number(entry?.i)));
  if (!validEntries.length) throw new Error("语境分析缺少有效条目");
  const minIndex = Math.min(...validEntries.map((entry) => Number(entry.i)));
  const maxIndex = Math.max(...validEntries.map((entry) => Number(entry.i)));
  const idByIndex = new Map(validEntries.map((entry) => [Number(entry.i), String(entry.id)]));
  const validIds = new Set(idByIndex.values());
  const dropped = [];
  const documentType = payload.documentType && typeof payload.documentType === "object" ? payload.documentType : {};
  const sections = [];
  for (const section of Array.isArray(payload.sections) ? payload.sections : []) {
    const from = Math.max(minIndex, Math.trunc(Number(section?.from)));
    const to = Math.min(maxIndex, Math.trunc(Number(section?.to)));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      dropped.push({ kind: "section", reason: "区间无效", value: section });
      continue;
    }
    const purpose = isContextBriefPurpose(section?.purpose) ? String(section.purpose) : "general";
    if (purpose === "general" && section?.purpose && !isContextBriefPurpose(section.purpose)) {
      dropped.push({ kind: "purpose", reason: `未知用途 ${section.purpose}`, value: section?.purpose });
    }
    sections.push({
      from,
      to,
      purpose,
      tone: clip(section?.tone, 80),
      note: clip(section?.note)
    });
    if (sections.length >= MAX_SECTIONS_PER_CHUNK) break;
  }
  if (!sections.length) {
    sections.push({ from: minIndex, to: maxIndex, purpose: "general", tone: "", note: "语境分析未给出可用区间" });
  }
  const crossRefs = [];
  for (const item of Array.isArray(payload.crossRefs) ? payload.crossRefs : []) {
    const note = clip(item?.note);
    const ids = (Array.isArray(item?.ids) ? item.ids : []).map(String).filter((id) => validIds.has(id));
    if (!note || !ids.length) {
      dropped.push({ kind: "crossRef", reason: "缺少有效条目引用", value: item });
      continue;
    }
    crossRefs.push({ ids: [...new Set(ids)].slice(0, 20), note });
    if (crossRefs.length >= MAX_CROSS_REFS) break;
  }
  const notes = [];
  for (const item of Array.isArray(payload.notes) ? payload.notes : []) {
    const text = clip(item?.text);
    if (!text) continue;
    notes.push({ text, ids: (Array.isArray(item?.ids) ? item.ids : []).map(String).filter((id) => validIds.has(id)).slice(0, 20) });
    if (notes.length >= MAX_NOTES) break;
  }
  return {
    part: {
      minIndex,
      maxIndex,
      entryCount: validEntries.length,
      documentType: {
        purpose: isContextBriefPurpose(documentType.purpose) ? String(documentType.purpose) : "general",
        audience: clip(documentType.audience, 120),
        tone: clip(documentType.tone, 160),
        summary: clip(documentType.summary, 400)
      },
      sections,
      crossRefs,
      notes
    },
    dropped
  };
}

/**
 * 合并各片结论。区间重叠时保留覆盖条目更多的一段（同大小保留先出现的），
 * 这样分片边界上的重复描述不会互相打架。
 */
export function mergeContextBrief(parts = [], { filename = "", total = 0, model = "", generatedAt = "" } = {}) {
  const usable = (Array.isArray(parts) ? parts : []).filter((part) => Number(part?.entryCount) > 0);
  if (!usable.length) {
    return {
      version: CONTEXT_BRIEF_VERSION,
      filename,
      model,
      generatedAt: generatedAt || new Date().toISOString(),
      status: "failed",
      documentType: { purpose: "general", audience: "", tone: "", summary: "" },
      sections: [],
      crossRefs: [],
      notes: [],
      coverage: { analyzed: 0, total, covered: 0, percent: 0 }
    };
  }
  const ranked = [...usable].sort((a, b) => b.entryCount - a.entryCount);
  const purposeCount = new Map();
  for (const part of usable) {
    const purpose = part.documentType?.purpose || "general";
    purposeCount.set(purpose, (purposeCount.get(purpose) || 0) + part.entryCount);
  }
  const documentPurpose = [...purposeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "general";
  const sections = [];
  for (const part of usable) sections.push(...part.sections);
  // 先放大区间，再让小区间只补它的"未覆盖部分"。直接丢掉小的一段会在文件开头
  // 留下空洞（分片重叠时很常见），覆盖率也会莫名其妙地掉下来。
  sections.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const kept = [];
  for (const section of sections) {
    let pieces = [{ ...section }];
    for (const existing of kept) {
      pieces = pieces.flatMap((piece) => {
        if (piece.to < existing.from || piece.from > existing.to) return [piece];
        const remainders = [];
        if (piece.from < existing.from) remainders.push({ ...piece, to: existing.from - 1 });
        if (piece.to > existing.to) remainders.push({ ...piece, from: existing.to + 1 });
        return remainders;
      });
      if (!pieces.length) break;
    }
    kept.push(...pieces);
  }
  kept.sort((a, b) => a.from - b.from);
  const coveredIndices = new Set();
  for (const section of kept) for (let index = section.from; index <= section.to; index += 1) coveredIndices.add(index);
  const notes = [];
  for (const part of usable) {
    for (const note of part.notes) {
      if (notes.some((item) => item.text === note.text)) continue;
      notes.push(note);
    }
  }
  const crossRefs = [];
  for (const part of usable) {
    for (const ref of part.crossRefs) {
      if (crossRefs.some((item) => item.note === ref.note)) continue;
      crossRefs.push(ref);
    }
  }
  return {
    version: CONTEXT_BRIEF_VERSION,
    filename,
    model,
    generatedAt: generatedAt || new Date().toISOString(),
    status: "ready",
    documentType: {
      purpose: documentPurpose,
      audience: ranked[0].documentType?.audience || "",
      tone: ranked[0].documentType?.tone || "",
      summary: ranked[0].documentType?.summary || ""
    },
    sections: kept.slice(0, 400),
    crossRefs: crossRefs.slice(0, MAX_CROSS_REFS),
    notes: notes.slice(0, MAX_NOTES),
    coverage: {
      analyzed: usable.reduce((sum, part) => sum + part.entryCount, 0),
      total,
      covered: coveredIndices.size,
      percent: total ? Math.round((coveredIndices.size / total) * 100) : 0
    }
  };
}

/**
 * 区间 → 段落的一次性索引。逐段翻译时会被调用几千次，绝不能每段重建一遍。
 * 缓存挂在档案对象上，档案被替换（重跑分析）时自然失效。
 */
const SECTION_INDEX_CACHE = new WeakMap();

function sectionIndex(brief) {
  if (!brief || typeof brief !== "object") return new Map();
  const cached = SECTION_INDEX_CACHE.get(brief);
  if (cached) return cached;
  const map = new Map();
  for (const section of brief.sections || []) {
    for (let index = section.from; index <= section.to; index += 1) {
      if (!map.has(index)) map.set(index, section);
    }
  }
  SECTION_INDEX_CACHE.set(brief, map);
  return map;
}

/** 某一段继承到的用途：档案里没有就给回落值，绝不猜。 */
export function purposeForIndex(brief, index, fallback = "general") {
  const oneBased = Number(index) + 1;
  return sectionIndex(brief).get(oneBased)?.purpose || fallback;
}

/** 逐段要注入提示词的语境切片。段落之间共享的内容不重复下发。 */
export function contextBriefSlice(brief, index, segmentId = "") {
  if (!brief || brief.status !== "ready") return null;
  const oneBased = Number(index) + 1;
  const section = sectionIndex(brief).get(oneBased) || null;
  const id = String(segmentId || "");
  const areaNotes = (brief.notes || []).filter((note) => !note.ids?.length || (id && note.ids.includes(id)));
  const crossRefs = (brief.crossRefs || []).filter((ref) => id && ref.ids.includes(id));
  return {
    document: {
      purpose: brief.documentType?.purpose || "general",
      audience: brief.documentType?.audience || "",
      tone: brief.documentType?.tone || "",
      summary: brief.documentType?.summary || ""
    },
    section: section ? { purpose: section.purpose, tone: section.tone, note: section.note, from: section.from, to: section.to } : null,
    notes: (section?.note ? [{ text: section.note, ids: [] }, ...areaNotes] : areaNotes).slice(0, 6),
    crossRefs: crossRefs.slice(0, 4)
  };
}

export function summarizeContextBrief(brief) {
  if (!brief) return null;
  return {
    status: brief.status || "ready",
    version: brief.version || CONTEXT_BRIEF_VERSION,
    documentPurpose: brief.documentType?.purpose || "general",
    documentPurposeLabel: contextPurposeLabel(brief.documentType?.purpose || "general"),
    summary: brief.documentType?.summary || "",
    audience: brief.documentType?.audience || "",
    tone: brief.documentType?.tone || "",
    sections: (brief.sections || []).length,
    notes: (brief.notes || []).length,
    crossRefs: (brief.crossRefs || []).length,
    coverage: brief.coverage || { analyzed: 0, total: 0, covered: 0, percent: 0 },
    model: brief.model || "",
    generatedAt: brief.generatedAt || ""
  };
}

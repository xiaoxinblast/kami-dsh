import { normalizeSource, similarity } from "./text.mjs";

/**
 * 文件内句式骨架：把数字、占位符、已知术语/专名、引号内容遮掉，
 * 让"获得 3 个金币"和"获得 10 个钻石"落到同一个固定框架上。
 *
 * 只做保守遮罩：不按词性切词，也不把普通片假名整段遮掉，避免把不相干的
 * 句子误判成同一句式。需要遮的专名由主术语库 + 工作术语表提供。
 */

export const PATTERN_SIMILARITY_THRESHOLD = 0.86;
export const PATTERN_MAX_REFERENCES = 3;
const MAX_PATTERN_LENGTH = 400;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function maskTermSources(text, terms = []) {
  const sources = [...new Set((Array.isArray(terms) ? terms : [])
    .flatMap((term) => [term?.source, ...(Array.isArray(term?.aliases) ? term.aliases : [])])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort((left, right) => [...right].length - [...left].length);
  let masked = text;
  for (const source of sources) {
    if (!source || !masked.includes(source)) continue;
    masked = masked.replace(new RegExp(escapeRegExp(source), "gu"), "⟦术⟧");
  }
  return masked;
}

/**
 * 变量遮罩顺序：先术语（最长优先），再引号/标签/URL/数字，
 * 最后是连续拉丁标识。遮罩后仍保留助词、标点和句末结构。
 */
export function buildPatternKey(source, { terms = [] } = {}) {
  let text = String(source ?? "").trim();
  if (!text) return "";
  text = maskTermSources(text, terms);
  text = text
    .replace(/https?:\/\/\S+/giu, "⟦链⟧")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "⟦链⟧")
    .replace(/<[^>]*>/gu, "⟦占⟧")
    .replace(/\{[^}]*\}/gu, "⟦占⟧")
    .replace(/\[[^\]]*\]/gu, "⟦占⟧")
    .replace(/「[^」]*」/gu, "⟦引⟧")
    .replace(/『[^』]*』/gu, "⟦引⟧")
    .replace(/"[^"]*"/gu, "⟦引⟧")
    .replace(/“[^”]*”/gu, "⟦引⟧")
    .replace(/\d+(?:[.,]\d+)*/gu, "⟦数⟧")
    .replace(/[A-Za-z][A-Za-z0-9_.-]*/gu, "⟦英⟧")
    .replace(/\s+/gu, " ")
    .trim();
  const key = normalizeSource(text);
  return key.length >= 4 && key.length <= MAX_PATTERN_LENGTH ? key : "";
}

export function patternSimilarity(left, right) {
  const a = buildPatternKey(left);
  const b = buildPatternKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return similarity(a, b);
}

/**
 * 从当前文件已翻段落里选同句式参考。
 *
 * 优先精确骨架；不足时做相似度兜底（只看最近 400 条，避免大文件 O(n²)）。
 * 返回 source→target 及人工采纳状态；句式相似不代表译文已确认，变量仍需按当前原文翻译。
 */
export function selectPatternReferences({ source, terms = [], previous = [], limit = PATTERN_MAX_REFERENCES, threshold = PATTERN_SIMILARITY_THRESHOLD } = {}) {
  const key = buildPatternKey(source, { terms });
  if (!key) return [];
  const candidates = (Array.isArray(previous) ? previous : [])
    .filter((item) => String(item?.target || "").trim())
    .slice(-400);
  const exact = candidates.filter((item) => (item.patternKey ? item.patternKey === key : buildPatternKey(item.source, { terms }) === key));
  const selected = exact.length
    ? exact
    : candidates
      .map((item) => ({ item, score: patternSimilarity(source, item.source) }))
      .filter((entry) => entry.score >= threshold)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item);
  return selected.slice(-Math.max(0, Number(limit) || PATTERN_MAX_REFERENCES)).map((item) => ({
    segmentId: String(item.segmentId || item.id || ""),
    source: String(item.source || "").trim(),
    target: String(item.target || "").trim(),
    accepted: item.accepted === true,
    similarity: item.patternKey === key ? 1 : Number(patternSimilarity(source, item.source).toFixed(3))
  }));
}

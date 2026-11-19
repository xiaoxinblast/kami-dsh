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
export const PATTERN_HISTORY_LIMIT = 400;
const MAX_PATTERN_LENGTH = 400;
const words = new Intl.Segmenter("ja", { granularity: "word" });

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

// 分词仅用于匹配。忽略编辑器的内联标记，保留模型输入中的原文和标记。
export function patternClauses(source) {
  const text = buildPatternKey(String(source ?? "").replace(/<[^<>]+>|\uFFFC/gu, ""));
  return (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]+/gu) || [])
    .filter(part => part.length >= 4)
    .map(part => Array.from(words.segment(part), item => item.segment));
}

function sharedEnding(left, right) {
  let n = 0;
  while (n < Math.min(left.length, right.length) && left.at(-1 - n) === right.at(-1 - n)) n++;
  if (n < 2) return "";
  const phrase = left.slice(-n).join("");
  return phrase.length >= 4 && /\p{Script=Han}/u.test(phrase) && /\p{Script=Hiragana}/u.test(phrase) ? phrase : "";
}

// 两处有实词的分句末尾按同一顺序出现，才把部分重合判为句式证据。
// earlier[j] 仅含此前左右两边都已走过的分句，同一个长片段不能重复计数。
function sharedFixedPhrases(left, right) {
  let earlier = Array(right.length + 1).fill("");
  let best = [], length = 0;
  for (const clause of left) {
    const next = [...earlier];
    for (let j = 0; j < right.length; j++) {
      const phrase = sharedEnding(clause, right[j]);
      const first = earlier[j];
      if (phrase && first && first !== phrase && first.length + phrase.length > length) {
        best = [first, phrase];
        length = first.length + phrase.length;
      }
      if (next[j].length > next[j + 1].length) next[j + 1] = next[j];
      if (phrase.length > next[j + 1].length) next[j + 1] = phrase;
    }
    earlier = next;
  }
  return length >= 10 ? best : [];
}

function patternMatches(source, terms, candidates, limit, threshold) {
  const key = buildPatternKey(source, { terms });
  if (!/[\p{L}]/u.test(key.replace(/⟦[^⟧]*⟧/gu, ""))) return [];
  const keyed = candidates.map(item => ({ item, key: item.patternKey || buildPatternKey(item.source, { terms }) }));
  const exact = keyed.filter(candidate => candidate.key === key);
  if (exact.length) return exact.slice(-limit).map(({ item }) => ({ item, score: 1 }));
  const clauses = patternClauses(source);
  return keyed.filter(candidate => candidate.key).map(({ item, key: other }) => {
    const score = similarity(key, other);
    const fixedPhrases = sharedFixedPhrases(clauses, item.clauses || patternClauses(item.source));
    return { item, score, fixedPhrases };
  }).filter(match => match.score >= threshold || match.fixedPhrases.length)
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

// 一组译稿同时生成时没有历史译文。每条只关联一个在同一请求里的最相近条目。
export function groupPatternLinks(entries) {
  const previous = [], links = [];
  const terms = entries.flatMap(({ contextPack: pack }) => [...(pack.requiredTerms || []), ...(pack.preferredTerms || []), ...(pack.workingTerms || [])]);
  for (const { id, contextPack: { source } } of entries) {
    const [match] = patternMatches(source, terms, previous, 1, PATTERN_SIMILARITY_THRESHOLD);
    if (match) links.push({ ids: [match.item.id, id], fixedPhrases: match.fixedPhrases || [] });
    previous.push({ id, source, patternKey: buildPatternKey(source, { terms }), clauses: patternClauses(source) });
  }
  return links;
}

/**
 * 从当前文件已翻段落里选同句式参考。
 *
 * 优先精确骨架；不足时做相似度兜底（只看最近 400 条，避免大文件 O(n²)）。
 * 返回 source→target 及人工采纳状态；句式相似不代表译文已确认，变量仍需按当前原文翻译。
 */
export function selectPatternReferences({ source, terms = [], previous = [], limit = PATTERN_MAX_REFERENCES, threshold = PATTERN_SIMILARITY_THRESHOLD } = {}) {
  const candidates = (Array.isArray(previous) ? previous : [])
    .filter((item) => String(item?.target || "").trim())
    .slice(-PATTERN_HISTORY_LIMIT);
  if (!candidates.length || limit <= 0) return [];
  return patternMatches(source, terms, candidates, limit, threshold).map(({ item, score, fixedPhrases }) => ({
    segmentId: String(item.segmentId || item.id || ""),
    source: String(item.source || "").trim(),
    target: String(item.target || "").trim(),
    accepted: item.accepted === true,
    ...(fixedPhrases?.length ? { fixedPhrases } : {}),
    similarity: Number(score.toFixed(3))
  }));
}

/**
 * 参考资料检索索引。
 *
 * 按项目缓存片段（词面预筛 + 向量余弦重排），写入后由调用方 invalidate。
 * 参考资料不参与每次翻译的提示词注入，只有模型主动调用工具时才会走到这里。
 */

import { embedSource } from "./embedding.mjs";
import { normalizeSource } from "./text.mjs";

/**
 * 缓存 10 分钟：参考资料增删/重扫都会显式 invalidate，TTL 只兜底"绕过工作台直接改
 * Directus"的情况。原来的 60 秒会让长批次在每轮引用间隔超过一分钟时，重新拉取项目
 * 全部分片（实测 5 页、约 35MB），把 Directus 拖到 20 秒以上。
 */
const DEFAULT_TTL_MS = 10 * 60_000;
const VECTOR_WEIGHT = 0.6;
const LEXICAL_WEIGHT = 0.4;
const MIN_VECTOR_SCORE = 0.25;

function bigrams(text) {
  const normalized = normalizeSource(text).replace(/\s+/gu, "");
  const characters = [...normalized];
  if (characters.length <= 1) return characters.length ? [characters[0]] : [];
  const grams = new Set();
  for (let index = 0; index < characters.length - 1; index += 1) grams.add(`${characters[index]}${characters[index + 1]}`);
  return [...grams];
}

/** 词面相关度：查询串的二元组在片段里的覆盖率，命中整串再加一点分。 */
export function lexicalScore(query, text) {
  const grams = bigrams(query);
  const haystack = normalizeSource(text).replace(/\s+/gu, "");
  if (!grams.length || !haystack) return 0;
  let hits = 0;
  for (const gram of grams) if (haystack.includes(gram)) hits += 1;
  const coverage = hits / grams.length;
  const exact = haystack.includes(normalizeSource(query).replace(/\s+/gu, "")) ? 0.15 : 0;
  return Math.min(1, coverage + exact);
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * @param loader (projectId) => Promise<chunk[]> 片段形状：
 *   { id, documentId, documentName, documentStatus, libraryId, libraryEnabled, ordinal,
 *     heading, page, origin, text, risk, allowed, embedding }
 */
export function createReferenceIndex({ loader, ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), cacheKey = (id) => id } = {}) {
  if (typeof loader !== "function") throw new TypeError("reference index 需要 loader");
  const cache = new Map();
  let version = 0;

  async function itemsFor(projectId) {
    const key = cacheKey(projectId);
    const entry = cache.get(key);
    if (entry && entry.version === version && now() - entry.at < ttlMs) return entry.items;
    const items = (await loader(projectId)) || [];
    cache.set(key, { at: now(), version, items });
    return items;
  }

  return {
    invalidate(projectId = "") {
      version += 1;
      if (projectId) cache.delete(String(projectId));
      else cache.clear();
    },
    /**
     * 当前项目可用的参考资料清单（按文件聚合）。
     * 给"AI 自己挑文件读"用：模型先看有哪些文件，再按名字读正文。
     */
    async documents({ projectId = "" } = {}) {
      const items = await itemsFor(String(projectId));
      const byId = new Map();
      for (const entry of items) {
        if (!entry?.documentId) continue;
        if (entry.documentStatus === "disabled" || entry.documentStatus === "failed") continue;
        if (entry.libraryEnabled === false) continue;
        const document = byId.get(entry.documentId) || {
          id: entry.documentId,
          name: entry.documentName || "未命名资料",
          description: String(entry.documentDescription || "").trim(),
          chunks: 0,
          characters: 0
        };
        document.chunks += 1;
        document.characters += [...String(entry.text || "")].length;
        byId.set(entry.documentId, document);
      }
      return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
    /** 某份资料的全部片段，按片段顺序排列（读到的是完整正文）。 */
    async chunksOf({ projectId = "", documentId = "" } = {}) {
      const items = await itemsFor(String(projectId));
      return items
        .filter((entry) => String(entry?.documentId || "") === String(documentId))
        .sort((left, right) => (Number(left.ordinal) || 0) - (Number(right.ordinal) || 0));
    },
    async search({ projectId = "", query = "", documentName = "", limit = 4, includeRisk = false, onlyChunkIds = null } = {}) {
      const text = String(query || "").trim();
      if (!text) return [];
      const items = await itemsFor(String(projectId));
      let queryVector = null;
      try {
        queryVector = (await embedSource(text))?.vector ?? null;
      } catch {
        queryVector = null;
      }
      const keyword = String(documentName || "").trim().toLowerCase();
      const scored = [];
      for (const item of items) {
        if (!item?.text) continue;
        if (item.documentStatus === "disabled" || item.documentStatus === "failed") continue;
        if (item.libraryEnabled === false) continue;
        if (item.risk === true && item.allowed !== true && !includeRisk) continue;
        // 评测隔离：只允许考试允许的片段进入检索。
        if (onlyChunkIds && !onlyChunkIds.has(String(item.id))) continue;
        if (keyword && !String(item.documentName || "").toLowerCase().includes(keyword)) continue;
        const lexical = lexicalScore(text, item.text);
        const vector = queryVector ? cosineSimilarity(queryVector, item.embedding) : null;
        const score = vector == null ? lexical : vector * VECTOR_WEIGHT + lexical * LEXICAL_WEIGHT;
        if (vector == null && lexical <= 0) continue;
        if (vector != null && vector < MIN_VECTOR_SCORE && lexical <= 0) continue;
        scored.push({ ...item, score, lexicalScore: lexical, vectorScore: vector });
      }
      scored.sort((a, b) => b.score - a.score);
      const picked = [];
      const seen = new Set();
      for (const item of scored) {
        const fingerprint = normalizeSource(item.text).slice(0, 80);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        picked.push(item);
        if (picked.length >= Math.max(1, Math.min(10, Number(limit) || 4))) break;
      }
      return picked;
    }
  };
}

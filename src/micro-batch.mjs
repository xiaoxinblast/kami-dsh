import { extractProtectedTokens, parseModelJsonObject } from "./text.mjs";
import { translationOutputIssue } from "./translation-output.mjs";

export function microBatchSegments(segments, start, purposeFor, { maxSegments = 6, maxChars = 800 } = {}) {
  const first = segments[start];
  if (!first) return [];
  const purpose = purposeFor(first, start);
  const boundary = item => JSON.stringify([item.locator?.type || "", item.locator?.sheet || item.context?.sheet || ""]);
  const group = [];
  let chars = 0;
  for (let index = start; index < Math.min(segments.length, start + maxSegments); index += 1) {
    const item = segments[index];
    if (!item || ["done", "error"].includes(item.status) || item.selected === false || item.accepted === true
      || !String(item.source || "").trim()
      || boundary(item) !== boundary(first) || purposeFor(item, index) !== purpose) break;
    chars += [...item.source].length;
    if (chars > maxChars) break;
    group.push(item);
  }
  return group.length ? group : [first];
}

function formatTokens(text) {
  const value = String(text || "");
  return extractProtectedTokens(value).filter(token => /^(?:https?:|[<{%])/u.test(token))
    .flatMap(token => Array(value.split(token).length - 1).fill(token)).sort();
}

export function parseMicroBatchTranslations(content, entries, { partial = false } = {}) {
  const rows = parseModelJsonObject(content).translations;
  const invalid = () => Object.assign(new Error("小批译文的 ID、条数、译文正文或受保护标记不完整，将退回逐段翻译"), { code: "invalid_micro_batch" });
  if (!Array.isArray(rows) || (!partial && rows.length !== entries.length)) throw invalid();
  const expected = new Map(entries.map(entry => [entry.id, entry]));
  const results = new Map();
  const seen = new Set();
  const layout = text => String(text).match(/<[^<>]+>|\\r\\n|\\n|\r\n|[\r\n]/gu)?.map(token => token === "\r\n" ? "\n" : token).join("\0") || "";
  // Only flag a copied address with an explicit match in another source and its output.
  const addresses = new Map();
  for (const row of rows) {
    const source = expected.get(row?.id)?.source.match(/^([\p{Script=Han}]{2,8})[、，,]/u)?.[1];
    const target = typeof row?.translation === "string" && row.translation.trim().match(/^([\p{Script=Han}]{2,10})[、，,]/u)?.[1];
    if (source && target && (target.includes(source) || expected.get(row.id).terms?.some(term => term.source === source && term.target === target))) addresses.set(target, source);
  }
  for (const row of rows) {
    const entry = expected.get(row?.id);
    if (!entry) throw invalid();
    const duplicate = seen.has(row.id);
    seen.add(row.id);
    const address = typeof row.translation === "string" && row.translation.trim().match(/^([\p{Script=Han}]{2,10})[、，,]/u)?.[1];
    if (duplicate || typeof row.translation !== "string"
      || translationOutputIssue(row.translation)
      || (addresses.has(address) && !entry.source.includes(addresses.get(address)))
      || layout(entry.source) !== layout(row.translation.trim())
      || JSON.stringify(formatTokens(entry.source)) !== JSON.stringify(formatTokens(row.translation))) {
      if (!partial) throw invalid();
      results.delete(row.id);
      continue;
    }
    results.set(row.id, { id: row.id, source: entry.source, translation: row.translation.trim() });
  }
  if (!results.size) throw invalid();
  return entries.filter(entry => results.has(entry.id)).map(entry => results.get(entry.id));
}

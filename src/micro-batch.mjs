import { extractProtectedTokens, parseModelJsonObject } from "./text.mjs";
import { translationOutputIssue } from "./translation-output.mjs";

export function microBatchSegments(segments, start, purposeFor) {
  const first = segments[start];
  if (!first) return [];
  const purpose = purposeFor(first, start);
  if (!["dialogue", "ui", "item_name", "general"].includes(purpose)) return [first];
  const boundary = item => JSON.stringify([item.locator?.type || "", item.locator?.sheet || item.context?.sheet || ""]);
  const group = [];
  for (let index = start; index < Math.min(segments.length, start + 4); index += 1) {
    const item = segments[index];
    if (!item || item.status === "done" || item.selected === false || item.accepted === true
      || !String(item.source || "").trim() || [...item.source].length > 120
      || boundary(item) !== boundary(first) || purposeFor(item, index) !== purpose) break;
    group.push(item);
  }
  return group.length ? group : [first];
}

function formatTokens(text) {
  const value = String(text || "");
  return extractProtectedTokens(value).filter(token => /^(?:https?:|[<{%])/u.test(token))
    .flatMap(token => Array(value.split(token).length - 1).fill(token)).sort();
}

export function parseMicroBatchTranslations(content, entries) {
  const rows = parseModelJsonObject(content).translations;
  const invalid = () => Object.assign(new Error("小批译文的 ID、条数、译文正文或受保护标记不完整，将退回逐段翻译"), { code: "invalid_micro_batch" });
  if (!Array.isArray(rows) || rows.length !== entries.length) throw invalid();
  const expected = new Map(entries.map(entry => [entry.id, entry]));
  const results = new Map();
  for (const row of rows) {
    const entry = expected.get(row?.id);
    if (!entry || results.has(row.id) || typeof row.translation !== "string"
      || translationOutputIssue(row.translation)
      || JSON.stringify(formatTokens(entry.source)) !== JSON.stringify(formatTokens(row.translation))) throw invalid();
    results.set(row.id, { id: row.id, source: entry.source, translation: row.translation.trim() });
  }
  return entries.map(entry => results.get(entry.id));
}

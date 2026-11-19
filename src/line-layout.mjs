import { createHash } from "node:crypto";
import { normalizeQaQuantities } from "./chinese-numbers.mjs";

const inlineTag = /<tag\s+[^<>]*?\/>/gu;
const hardBreak = /\r\n|[\r\n]|<br\s*\/?>/iu;
const scopeNames = new Map(Object.entries({ "对白": "dialogue", "对话": "dialogue", "台词": "dialogue", "UI": "ui", "界面": "ui", "通用": "all", "全部": "all" }));
const layoutCue = /换行|換行|折行|断行|斷行|排版|段数|行宽|行寬|１行|换列|每行|单行|行数|行數|字数|字數|字符|全角|半角|改行|文字数|行まで|行以内|行以內|行限制|[一二三四五六七八九十百两]+\s*行|[0-9０-９]+\s*行|line|characters?\s*(?:limit|per)|\b(?:cols?|columns?|rows?|cpl)\b|行長|行幅|글자|줄|строк|wrap/iu;

export function hasSourceBreak(source, markers = []) {
  return hardBreak.test(source || "") || markers.some(marker => source?.includes(marker));
}

// Only take the fast path for a complete, unambiguous list of literal rules.
// Headings, examples, tables, exceptions and other counting units require their context.
function flatRules(file, contentType) {
  const lines = file.text.trim().split(/\r?\n/u).filter(line => line.trim());
  if (!layoutCue.test(file.text)) return [];
  const rules = [];
  for (const line of lines) {
    let text = normalizeQaQuantities(line.trim().normalize("NFKC")).replace(/[。.]$/u, "");
    const named = text.match(/^(对白|对话|台词|UI|界面|通用|全部)\s*:\s*/iu);
    if (named) text = text.slice(named[0].length);
    const values = {};
    for (const part of text.split(/[,，、;；]/u)) {
      const chars = part.trim().match(/^(?:每行|每1行|每一行|单行)\s*(?:最多|至多|不超过|上限为?)?\s*(\d+)\s*(?:个字符|字符|字)(?:以内|以下)?$/u);
      const rows = part.trim().match(/^(?:每条|每段|总共|合计)?\s*(?:最多|至多|不超过|限)\s*(\d+)\s*行$/u);
      if ((!chars && !rows) || !(Number((chars || rows)[1]) > 0) || !Number.isSafeInteger(Number((chars || rows)[1]))) return null;
      const key = chars ? "maxChars" : "maxLines";
      if (values[key] !== undefined) return null;
      values[key] = Number((chars || rows)[1]);
    }
    const scope = named ? scopeNames.get(named[1].toUpperCase()) : "all";
    if (scope === "all" || scope === contentType) rules.push({ ...values, source: file.path, quote: line.trim(), counting: "characters" });
  }
  return rules;
}

export async function resolveLineLayout({ pack, scopeId = "", markers = [], guides = [], files = [], cache, previous, readText, inspect, verifyVersions, includeUnbroken = false }) {
  if (!includeUnbroken && !hasSourceBreak(pack.source, markers)) return null;
  const n = pack.neighborContext || {};
  const entryNote = String(n.note || "").split("相邻原文（只用于消歧）：")[0].trim();
  const note = layoutCue.test(entryNote) ? entryNote : "";
  const context = { locale: pack.targetLocale, type: pack.contentType, tags: [...(pack.contentTags || [])].sort(), document: n.document || "", sheet: n.sheet || "",
    section: pack.documentBrief?.section?.note || "", note, column: n.sourceColumn || "", selectors: (n.metadata || []).filter(r => r.role !== "constraint" && /类型|类别|文本种类|窗口|版式|控件|用途|text.?type|category|layout/iu.test(r.label)).map(({ label, value }) => ({ label, value })), constraints: (n.metadata || []).filter(row => row.role === "constraint").map(({ label, value }) => ({ label, value })) };
  const sources = [...guides.map(g => ({ purpose: "style-guide", ...g })), ...context.constraints.map(({ label, value }) => ({ purpose: "constraint", path: "条目约束 · " + label, text: /每行|每一行|行数/u.test(label) ? label + " " + value : value }))];
  if (note) sources.push({ path: "条目注释", text: note, purpose: "constraint" });
  const key = createHash("sha256").update(JSON.stringify([1, scopeId, context, sources, files.map(f => [f.path, f.version, f.size, f.purpose])])).digest("hex");
  const wrap = rules => ({ key, markers, rules });
  if (previous?.key === key && Array.isArray(previous.rules)) return wrap(previous.rules);
  const lookup = async () => {
    const all = [...sources];
    for (const file of files) all.push({ ...file, text: await readText(file) });
    const simple = all.map(file => typeof file.text === "string" ? flatRules(file, context.type) : null);
    const complex = all.filter((_, i) => simple[i] === null);
    const rules = simple.filter(Boolean).flat();
    if (complex.length) rules.push(...await inspect(complex, context));
    // A manual guide or explicit entry constraint overrides reference material for that dimension.
    const primary = new Set(all.filter(f => f.purpose !== "reference").map(f => f.path));
    for (const name of ["maxChars", "maxLines"]) {
      if (!rules.some(rule => primary.has(rule.source) && rule[name])) continue;
      for (const rule of rules) if (!primary.has(rule.source)) delete rule[name];
    }
    for (const name of ["maxChars", "maxLines", "counting"]) {
      const applicable = rules.filter(rule => rule[name] != null && (name !== "counting" || rule.maxChars));
      if (new Set(applicable.map(rule => rule[name])).size > 1) throw new Error("换行规则冲突，请核对适用范围：" + applicable.map(r => r.source + "「" + r.quote + "」").join("、"));
    }
    if (files.length) await verifyVersions?.();
    return rules.filter(rule => rule.maxChars || rule.maxLines);
  };
  if (!cache) return wrap(await lookup());
  let promise = cache.get(key);
  if (!promise) {
    promise = lookup();
    cache.set(key, promise);
    promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  }
  return wrap(await promise);
}

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
export function checkLineLayout(translation, layout) {
  if (!layout && !hasSourceBreak(translation)) return [];
  layout ??= { markers: [], rules: [] };
  let visible = String(translation || "");
  for (const marker of layout.markers) visible = visible.replaceAll(marker, "\n");
  const lines = visible.replace(inlineTag, "").split(/\r\n|[\r\n]|<br\s*\/?>/iu);
  const errors = [];
  const issue = (type, message) => errors.push({ type: "line_layout_" + type, severity: "error", category: "constraint", message });
  const width = layout.rules.find(r => r.maxChars), height = layout.rules.find(r => r.maxLines);
  if (height && (lines.length > height.maxLines || layout.markers.length + 1 > height.maxLines)) {
    const fixed = layout.markers.length + 1 > height.maxLines ? "；原文的固定换行标记至少需要 " + (layout.markers.length + 1) + " 行，请核对原件" : "";
    issue("lines", "译文共 " + lines.length + " 行，规定最多 " + height.maxLines + " 行（" + height.source + "）" + fixed);
  }
  for (const [i, line] of lines.entries()) {
    if (i && /^\s*[，。,.．、]/u.test(line)) issue("punctuation", "第 " + (i + 1) + " 行以「" + line.trimStart()[0] + "」开头，请将标点留在上一行并调整断句。");
    if (width) {
      const counted = width.counting === "nonspace" ? line.replace(/\s/gu, "") : line;
      const length = [...graphemes.segment(counted)].length;
      if (length > width.maxChars) issue("length", "第 " + (i + 1) + " 行有 " + length + " 字，超过每行 " + width.maxChars + " 字的上限（" + width.source + "）。");
    }
  }
  const actualMarkers = String(translation).match(inlineTag) || [];
  if (layout.markers.some(marker => actualMarkers.filter(t => t === marker).length !== 1)
    || actualMarkers.filter(t => layout.markers.includes(t)).join("") !== layout.markers.join("")) {
    issue("marker", "原文的固定换行标记必须按原顺序原样保留，每个标记自身代表一次换行。");
  }
  return errors;
}

export function layoutHint(layout, fromEntry = "") {
  if (!layout) return "";
  const details = layout.rules.map(r => [r.maxChars && "每行最多 " + r.maxChars + " 字" + (r.counting === "nonspace" ? "（不计空白）" : ""),
    r.maxLines && "最多 " + r.maxLines + " 行", r.quote && "原文「" + r.quote + "」", r.source].filter(Boolean).join("，"));
  return [fromEntry ? "字数和行数规定同条目 " + fromEntry : "已核对本类文本的换行规定：" + (details.join("；") || "资料未规定数字上限"), layout.markers.length ? "本条固定换行标记：" + layout.markers.join("、") : ""].filter(Boolean).join("\n");
}

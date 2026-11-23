import { createHash } from "node:crypto";
import { chineseQaLocale, normalizeQaQuantities } from "./chinese-numbers.mjs";

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
const contentGrapheme = /[\s\p{P}\p{S}]/u;
const hanCharacter = /\p{Script=Han}/u;
const sentenceEnd = /[。！？!?…]$/u;
const evidenceEnd = /[。！？!?…：:]$/u;
const anyPause = /[，。、；：！？!?,.;:…]$/u;
const listMarker = /^\s*(?:[-*•·–—]|\d+[.、)）])\s*/u;
const labelLine = /[：:]\s*$/u;
const contentStart = /^[^\s\p{P}\p{S}]/u;
const lineStartPunctuation = new Set([...'、，。：；！？．,.;:!?', ...'」』”’）］｝】〕》〉)]}']);
const lineEndPunctuation = new Set([...'（［｛【〔《〈「『“‘([{']);
const suffixParticles = new Set(["的", "地", "得", "之"]);
// 这些常用词以虚词收尾，断在它们后面是正常词界，不能当成悬空的虚词。
const wordTails = ["目的", "是的", "真的", "有的", "别的", "似的", "标的", "土地", "大地", "场地", "当地", "基地",
  "草地", "园地", "心地", "质地", "目的地", "产地", "工地", "营地", "阵地", "领地", "属地", "特地", "猛地",
  "获得", "取得", "觉得", "记得", "懂得", "值得", "难得", "显得", "使得", "舍得", "赢得", "心得", "总之", "反之", "换言之"];
const percentMarks = new Set([..."%‰°℃℉％"]);
const currencyMarks = new Set([..."¥$€£₩₽₹"]);
const measureWords = new Set([..."个只件条张本页章节名人次天年月日元块米克升度岁层楼间套台部辆架艘颗粒片盒包瓶罐袋组对双批份项种类款期届场局盘轮波阵股笔桶杯碗碟把支根枝棵株朵束串堆排行列段篇首曲幅版集季吨公"]);

function visibleLines(translation, markers = []) {
  let visible = String(translation || "");
  for (const marker of markers) visible = visible.replaceAll(marker, "\n");
  return visible.replace(inlineTag, "").split(/\r\n|[\r\n]|<br\s*\/?>/iu);
}

function contentLength(line) {
  let count = 0;
  for (const { segment } of graphemes.segment(String(line || ""))) {
    if (!contentGrapheme.test(segment)) count += 1;
  }
  return count;
}

function lastCharacter(line) {
  const chars = [...String(line || "").trimEnd()];
  return chars.length ? chars[chars.length - 1] : "";
}

function firstCharacter(line) {
  const chars = [...String(line || "").trimStart()];
  return chars.length ? chars[0] : "";
}

function textBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

// 一段连续文本被硬折行的证据：至少三行、有足够长的行，且存在不在句末的长行。
function isWrappedBlock(lines) {
  if (lines.length < 3) return false;
  const lengths = lines.map(contentLength);
  const longest = Math.max(...lengths);
  if (longest < 10 || lengths.filter(length => length >= 8).length < 2) return false;
  return lines.slice(0, -1).some((line, index) => lengths[index] >= 8 && !evidenceEnd.test(line.trimEnd()));
}

export function checkLineLayout(translation, layout) {
  if (!layout && !hasSourceBreak(translation)) return [];
  layout ??= { markers: [], rules: [] };
  const lines = visibleLines(translation, layout.markers);
  const errors = [];
  const issue = (type, message) => errors.push({ type: "line_layout_" + type, severity: "error", category: "constraint", message });
  const width = layout.rules.find(r => r.maxChars), height = layout.rules.find(r => r.maxLines);
  if (height && (lines.length > height.maxLines || layout.markers.length + 1 > height.maxLines)) {
    const fixed = layout.markers.length + 1 > height.maxLines ? "；原文的固定换行标记至少需要 " + (layout.markers.length + 1) + " 行，请核对原件" : "";
    issue("lines", "译文共 " + lines.length + " 行，规定最多 " + height.maxLines + " 行（" + height.source + "）" + fixed);
  }
  for (const [i, line] of lines.entries()) {
    const first = firstCharacter(line);
    const previousLast = i ? lastCharacter(lines[i - 1]) : "";
    if (i && lineStartPunctuation.has(first)) {
      // ASCII 标点只在上一行以汉字收尾时判定，避免把版本号、URL 和数字列表的换行当成标点断行。
      const ascii = /^[\x00-\x7F]$/u.test(first);
      if (!(ascii && /[A-Za-z0-9]/u.test(previousLast))) {
        issue("punctuation", "第 " + (i + 1) + " 行以「" + first + "」开头，请将标点留在上一行并调整断句。");
      }
    }
    const last = lastCharacter(line);
    if (lineEndPunctuation.has(last)) {
      issue("punctuation", "第 " + (i + 1) + " 行以「" + last + "」结尾，开括号或开引号不能留在行尾。");
    }
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

function tokenSplitIssues(lines, issue) {
  for (let i = 0; i < lines.length - 1; i += 1) {
    const left = lines[i].trimEnd();
    const right = lines[i + 1].trimStart();
    if (!left || !right) continue;
    const leftRun = left.match(/[A-Za-z0-9]+$/u)?.[0] || "";
    const rightRun = right.match(/^[A-Za-z0-9]+/u)?.[0] || "";
    const rightFirst = firstCharacter(right);
    const last = lastCharacter(left);
    let token = "";
    if (leftRun && rightRun) {
      const pureList = /^[A-Za-z0-9]{1,3}$/u.test(left.trim()) && /^[A-Za-z0-9]{1,3}$/u.test(right.trim());
      if (!pureList && (leftRun + rightRun).length >= 2) token = leftRun + rightRun;
    }
    if (!token && /\d$/u.test(left) && percentMarks.has(rightFirst)) token = left.match(/\d+$/u)?.[0] + rightFirst;
    if (!token && currencyMarks.has(last) && /^\d/u.test(right)) token = last + right.match(/^\d+/u)?.[0];
    if (!token && /\d$/u.test(left) && measureWords.has(rightFirst)) {
      const number = left.match(/\d+$/u)?.[0] || "";
      // 整行只有数字时更像是编号列表，不当成数量拆分。
      if (number && !/^\d+$/u.test(left.trim())) token = number + rightFirst;
    }
    if (!token && last === "…" && rightFirst === "…") token = "……";
    if (!token && last === "—" && rightFirst === "—") token = "——";
    if (!token) continue;
    issue("token", `第 ${i + 1} 行与第 ${i + 2} 行把「${token}」拆开了，数字、英文标识和单位应保持完整。`, `把「${token}」放在同一行，或调整断点。`);
  }
}

function lineCountIssue({ source, lines, markers, issue }) {
  if (!String(source || "").trim()) return;
  const sourceLines = visibleLines(source, markers).filter(line => line.trim()).length;
  const translationLines = lines.filter(line => line.trim()).length;
  if (!sourceLines || sourceLines === translationLines) return;
  issue("count", `原文 ${sourceLines} 行，译文 ${translationLines} 行；如版式不要求逐行对应可忽略。`, "", "info");
}

function semanticBreakIssues(block, issue, covered) {
  for (let i = 0; i < block.length - 1; i += 1) {
    const current = block[i].trimEnd();
    const next = block[i + 1].trimStart();
    if (contentLength(current) < 3 || !next) continue;
    const last = lastCharacter(current);
    if (!suffixParticles.has(last)) continue;
    if (wordTails.some(word => current.endsWith(word))) continue;
    if (!contentStart.test(next) || listMarker.test(next)) continue;
    const nextFirst = firstCharacter(next);
    issue("semantic",
      `第 ${i + 1} 行以「${last}」结尾、第 ${i + 2} 行从「${nextFirst}」开始，断点落在一个完整的语义单元中间；建议合并两行或调整断点。`,
      `合并第 ${i + 1}、${i + 2} 行，或在「${last}」之前断行。`);
    covered.add(i);
    covered.add(i + 1);
  }
}

function shortLineIssues(block, issue, covered) {
  const nonLast = block.slice(0, -1);
  // 所有非末行都带停顿标点时更像韵文、列表或逐句对白，不做短行判定。
  if (nonLast.length && nonLast.every(line => anyPause.test(line.trimEnd()))) return;
  const repeated = new Map();
  for (const line of block) {
    const key = line.trim();
    repeated.set(key, (repeated.get(key) || 0) + 1);
  }
  for (let i = 0; i < block.length; i += 1) {
    if (covered.has(i)) continue;
    const line = block[i];
    const trimmed = line.trim();
    if (!trimmed || listMarker.test(line) || labelLine.test(line) || !hanCharacter.test(line)) continue;
    const length = contentLength(line);
    if (length > 2) continue;
    if ((repeated.get(trimmed) || 0) > 1) continue;
    // 末行两个字只有在上一行没说完时才算悬空；「谢谢。」这类正常短结尾不报。
    if (i === block.length - 1 && length === 2 && sentenceEnd.test(block[i - 1].trimEnd())) continue;
    issue("short_line",
      `第 ${i + 1} 行只有「${trimmed}」，在一段连续文本里单独成行；建议并入上一行或下一行。`,
      `把第 ${i + 1} 行并入相邻行，或调整前面的断点。`);
  }
}

export function checkLineSemantics(translation, { source = "", locale = "", contentType = "general", markers = [] } = {}) {
  const text = String(translation || "");
  if (!hasSourceBreak(text, markers)) return [];
  const lines = visibleLines(text, markers);
  const issues = [];
  const issue = (type, message, suggestion = "", severity = "warning") => issues.push({
    type: "line_layout_" + type, severity, category: "layout", message, ...(suggestion ? { suggestion } : {})
  });
  tokenSplitIssues(lines, issue);
  lineCountIssue({ source, lines, markers, issue });
  const chinese = chineseQaLocale(locale) || (!locale && hanCharacter.test(text));
  if (!chinese || contentType === "verse") return issues;
  for (const block of textBlocks(lines)) {
    if (!isWrappedBlock(block)) continue;
    const covered = new Set();
    semanticBreakIssues(block, issue, covered);
    shortLineIssues(block, issue, covered);
  }
  return issues;
}

export function layoutHint(layout, fromEntry = "") {
  if (!layout) return "";
  const details = layout.rules.map(r => [r.maxChars && "每行最多 " + r.maxChars + " 字" + (r.counting === "nonspace" ? "（不计空白）" : ""),
    r.maxLines && "最多 " + r.maxLines + " 行", r.quote && "原文「" + r.quote + "」", r.source].filter(Boolean).join("，"));
  return [fromEntry ? "字数和行数规定同条目 " + fromEntry : "已核对本类文本的换行规定：" + (details.join("；") || "资料未规定数字上限"), layout.markers.length ? "本条固定换行标记：" + layout.markers.join("、") : ""].filter(Boolean).join("\n");
}

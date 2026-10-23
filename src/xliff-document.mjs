import { SaxesParser } from "saxes";

const INLINE_SINGLE_NAMES = new Set(["ph", "x", "bx", "ex", "bpt", "ept", "it"]);
const MARKER_RE = /<tag\s+([^<>]*?)\/>/gu;

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function localName(name = "") {
  const value = String(name || "");
  return value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function encodeXml(value) {
  return String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function decodeXmlBuffer(buffer) {
  const value = Buffer.from(buffer || []);
  if (value.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return value.subarray(3).toString("utf8");
  if (value.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return value.subarray(2).toString("utf16le");
  if (value.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.from(value.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    return swapped.toString("utf16le");
  }
  return value.toString("utf8");
}

function normalizeOutputEncoding(xml) {
  if (!/^\s*<\?xml\b/iu.test(xml)) return xml;
  return xml.replace(/(<\?xml\s+[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/iu, '$1"UTF-8"');
}

function tagEnd(xml, start) {
  let quote = "";
  for (let index = start + 1; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') quote = char;
    else if (char === ">") return index + 1;
  }
  fail("XLIFF XML 标签未闭合");
}

function scanTags(xml) {
  const tags = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) fail("XLIFF XML 注释未闭合");
      tags.push({ kind: "special", start, end: end + 3 });
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) fail("XLIFF XML CDATA 未闭合");
      tags.push({ kind: "cdata", start, end: end + 3 });
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) fail("XLIFF XML 处理指令未闭合");
      tags.push({ kind: "special", start, end: end + 2 });
      cursor = end + 2;
      continue;
    }
    if (/^<!doctype\b/iu.test(xml.slice(start))) fail("XLIFF 不接受包含 DOCTYPE 的文件");
    if (xml.startsWith("<!", start)) {
      const end = tagEnd(xml, start);
      tags.push({ kind: "special", start, end });
      cursor = end;
      continue;
    }
    const end = tagEnd(xml, start);
    const raw = xml.slice(start, end);
    const match = raw.match(/^<\s*(\/?)\s*([A-Za-z_][\w.:-]*)/u);
    if (!match) fail("XLIFF XML 含无效标签");
    const closing = Boolean(match[1]);
    const selfClosing = !closing && /\/\s*>$/u.test(raw);
    tags.push({ kind: closing ? "close" : selfClosing ? "self" : "open", name: match[2], start, end, raw });
    cursor = end;
  }
  return tags;
}

function validateXml(xml) {
  if (/<!doctype\b/iu.test(xml)) fail("XLIFF 不接受包含 DOCTYPE 的文件");
  let parserError = null;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.onerror = (error) => {
      parserError ||= error;
      parser.resume();
    };
    parser.write(xml).close();
  } catch (error) {
    parserError ||= error;
  }
  if (parserError) fail(`XLIFF XML 无法解析：${parserError.message}`);
}

function buildElementTree(xml) {
  validateXml(xml);
  const tags = scanTags(xml);
  const nodes = [];
  const stack = [];
  for (const tag of tags) {
    if (tag.kind === "special" || tag.kind === "cdata") continue;
    if (tag.kind === "open" || tag.kind === "self") {
      const parent = stack.at(-1) || null;
      const node = {
        name: tag.name,
        local: localName(tag.name),
        openStart: tag.start,
        openEnd: tag.end,
        closeStart: tag.kind === "self" ? tag.end : null,
        closeEnd: tag.kind === "self" ? tag.end : null,
        selfClosing: tag.kind === "self",
        parent,
        children: []
      };
      if (parent) parent.children.push(node);
      nodes.push(node);
      if (tag.kind === "open") stack.push(node);
      continue;
    }
    const node = stack.pop();
    if (!node || node.name !== tag.name) fail("XLIFF XML 标签层级不匹配");
    node.closeStart = tag.start;
    node.closeEnd = tag.end;
  }
  if (stack.length) fail("XLIFF XML 标签未闭合");
  return nodes;
}

function rawOpen(xml, node) {
  return xml.slice(node.openStart, node.openEnd);
}

function rawNode(xml, node) {
  return xml.slice(node.openStart, node.closeEnd);
}

function rawInner(xml, node) {
  return xml.slice(node.openEnd, node.closeStart);
}

function attributes(xml, node) {
  const values = [];
  const raw = rawOpen(xml, node);
  for (const match of raw.matchAll(/\s([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/gu)) {
    values.push({ name: match[1], value: decodeXml(match[3]) });
  }
  return values;
}

function attributeValue(values, name) {
  return values.find((item) => item.name === name)?.value || "";
}

function descendants(node) {
  const result = [];
  const visit = (current) => {
    for (const child of current.children) {
      result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

function textContent(xml, node) {
  const tags = scanTags(rawInner(xml, node));
  let cursor = 0;
  const inner = rawInner(xml, node);
  let value = "";
  for (const tag of tags) {
    value += decodeXml(inner.slice(cursor, tag.start));
    if (tag.kind === "cdata") value += inner.slice(tag.start + 9, tag.end - 3);
    cursor = tag.end;
  }
  value += decodeXml(inner.slice(cursor));
  return value.trim();
}

function marker(id, type, description) {
  return `<tag id='${id}' type='${type}' desc='${String(description).replace(/&/gu, "&amp;").replace(/'/gu, "&apos;")}'/>`;
}

function mixedText(xml, node) {
  const innerStart = node.openEnd;
  const inner = rawInner(xml, node);
  const tokens = scanTags(inner).filter((tag) => tag.kind !== "special" && tag.kind !== "cdata");
  const nodes = descendants(node);
  const nodeByOpen = new Map(nodes.map((item) => [item.openStart - innerStart, item]));
  const nodeByClose = new Map(nodes.filter((item) => !item.selfClosing).map((item) => [item.closeStart - innerStart, item]));
  const tagMap = new Map();
  const tagIds = [];
  const paired = new Map();
  let cursor = 0;
  let sequence = 0;
  let value = "";

  const addText = (end) => {
    if (end > cursor) value += decodeXml(inner.slice(cursor, end));
  };
  for (const token of tokens) {
    if (token.start < cursor) continue;
    addText(token.start);
    const current = token.kind === "close" ? nodeByClose.get(token.start) : nodeByOpen.get(token.start);
    if (!current) {
      cursor = token.end;
      continue;
    }
    const name = current.local;
    if (token.kind === "close") {
      const openingId = paired.get(current.openStart);
      const id = `${openingId}:close`;
      tagMap.set(id, token.raw);
      tagIds.push(id);
      value += marker(id, "inline-close", `${name}结束`);
      cursor = token.end;
      continue;
    }
    if (token.kind === "self" || INLINE_SINGLE_NAMES.has(name)) {
      const id = `tag-${++sequence}`;
      tagMap.set(id, rawNode(xml, current));
      tagIds.push(id);
      value += marker(id, "inline", name);
      cursor = current.closeEnd - innerStart;
      continue;
    }
    const id = `tag-${++sequence}`;
    paired.set(current.openStart, id);
    tagMap.set(id, rawOpen(xml, current));
    tagIds.push(id);
    value += marker(id, "inline-open", `${name}开始`);
    cursor = token.end;
  }
  addText(inner.length);
  return { text: value, tagMap, tagIds };
}

function markerId(rawAttributes) {
  const match = String(rawAttributes || "").match(/\bid\s*=\s*(["'])([^"']+)\1/iu);
  return match ? decodeXml(match[2]) : "";
}

function markerIds(value) {
  const ids = [];
  for (const match of String(value || "").matchAll(MARKER_RE)) {
    const id = markerId(match[1]);
    if (!id) fail("XLIFF 内联标签标记缺少 id");
    ids.push(id);
  }
  return ids;
}

function restoreMixedText(value, tagMap, expectedIds) {
  const expected = expectedIds || [];
  const actual = markerIds(value);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail("内联标签被删除、增添或调整了顺序；请恢复原有标签后再导出");
  }
  let cursor = 0;
  let result = "";
  for (const match of String(value || "").matchAll(MARKER_RE)) {
    result += encodeXml(String(value).slice(cursor, match.index));
    const id = markerId(match[1]);
    const raw = tagMap.get(id);
    if (!raw) fail(`XLIFF 内联标签 id=${id} 不存在于原文`);
    result += raw;
    cursor = match.index + match[0].length;
  }
  return result + encodeXml(String(value || "").slice(cursor));
}

function mqPrefix(xml, root) {
  for (const attribute of attributes(xml, root)) {
    if (attribute.name.startsWith("xmlns:") && /mqxliff/iu.test(attribute.value)) return attribute.name.slice("xmlns:".length);
  }
  return "";
}

function parseXliffXml(xml, format) {
  const nodes = buildElementTree(xml);
  const root = nodes.find((node) => !node.parent);
  if (!root || root.local !== "xliff") fail("文件不是 XLIFF 1.2 文档");
  const memoQPrefix = format === "mqxliff" ? mqPrefix(xml, root) : "";
  const units = nodes.filter((node) => node.local === "trans-unit").map((node, index) => {
    const attrs = attributes(xml, node);
    const source = node.children.find((child) => child.local === "source");
    if (!source) fail(`第 ${index + 1} 个 trans-unit 缺少 source`);
    const target = node.children.find((child) => child.local === "target") || null;
    const contextNodes = descendants(node).filter((child) => child.local === "context").map((child) => ({
      type: (attributeValue(attributes(xml, child), "context-type") || "").toLowerCase(),
      value: textContent(xml, child)
    }));
    const contexts = contextNodes.map((item) => item.value).filter(Boolean);
    // memoQ 把"这一条的稳定 ID"写在 x-mmq-context 里（如 CARD2_QST_13_0300_0500_00_vns），
    // trans-unit 的 id 只是文件内序号（每个文件都从 1 开始），不能当条目身份用。
    const memoQContext = contextNodes.find((item) => item.type === "x-mmq-context")?.value || "";
    const otherContexts = contextNodes.filter((item) => item.type !== "x-mmq-context").map((item) => item.value).filter(Boolean);
    const notes = descendants(node).filter((child) => child.local === "note").map((child) => textContent(xml, child)).filter(Boolean);
    const sourceMixed = mixedText(xml, source);
    const targetMixed = target ? mixedText(xml, target) : { text: "" };
    const unitId = attributeValue(attrs, "id") || String(index + 1);
    const locked = attributeValue(attrs, "translate") === "no"
      || (format === "mqxliff" && memoQPrefix && attributeValue(attrs, `${memoQPrefix}:locked`) === "locked");
    return {
      index: index + 1,
      id: unitId,
      node,
      source,
      target,
      sourceText: sourceMixed.text,
      targetText: targetMixed.text,
      sourceTagMap: sourceMixed.tagMap,
      sourceTagIds: sourceMixed.tagIds,
      locked,
      context: contexts.join(" | "),
      memoQContext,
      otherContexts,
      note: notes.join(" | ")
    };
  });
  return { xml, format, root, memoQPrefix, units };
}

function updateMqStatus(openTag, prefix) {
  if (!prefix) return openTag;
  const name = `${prefix}:status`;
  const pattern = new RegExp(`(\\s${escapeRegExp(name)}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, "u");
  if (pattern.test(openTag)) return openTag.replace(pattern, `$1"Pretranslated"`);
  return openTag.replace(/\/?>$/u, (ending) => ` ${name}="Pretranslated"${ending}`);
}

function targetName(source) {
  const prefix = source.name.includes(":") ? `${source.name.slice(0, source.name.lastIndexOf(":") + 1)}` : "";
  return `${prefix}target`;
}

function renderTarget(xml, unit, content) {
  if (unit.target) {
    const opening = rawOpen(xml, unit.target).replace(/\/\s*>$/u, ">");
    const closing = unit.target.selfClosing ? `</${unit.target.name}>` : xml.slice(unit.target.closeStart, unit.target.closeEnd);
    return { start: unit.target.openStart, end: unit.target.closeEnd, value: `${opening}${content}${closing}` };
  }
  const name = targetName(unit.source);
  return { start: unit.source.closeEnd, end: unit.source.closeEnd, value: `<${name} xml:space="preserve">${content}</${name}>` };
}

function applyReplacements(xml, replacements) {
  let output = xml;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

export function prepareXliffDocument(buffer, filename) {
  const extension = String(filename || "").toLowerCase().endsWith(".mqxliff") ? "mqxliff" : "xliff";
  const parsed = parseXliffXml(decodeXmlBuffer(buffer), extension);
  const segments = [];
  let skippedLocked = 0;
  let skippedExisting = 0;
  for (const unit of parsed.units) {
    if (!unit.sourceText.trim()) continue;
    if (unit.locked) {
      skippedLocked += 1;
      continue;
    }
    if (unit.targetText.trim()) {
      skippedExisting += 1;
      continue;
    }
    const id = `seg-${segments.length + 1}`;
    segments.push({
      id,
      index: segments.length + 1,
      source: unit.sourceText,
      locator: { type: "xliff-unit", unitIndex: unit.index, unitId: unit.id },
      // 条目身份：memoQ 写在 x-mmq-context 里的稳定 ID，用于提示词消歧与写入 TM 时按 ID 匹配。
      entryKey: unit.memoQContext || "",
      context: {
        // 注释与条目 ID 拆开：ID 单独成字段后不再重复塞进 note（其它 context 保持原有顺序）。
        note: [...(unit.otherContexts || []), unit.note].filter(Boolean).join(" | "),
        previous: parsed.units[unit.index - 2]?.sourceText || "",
        next: parsed.units[unit.index]?.sourceText || ""
      },
      selected: true
    });
  }
  return {
    format: extension,
    segments,
    structure: { xliff: { skippedLocked, skippedExisting } }
  };
}

/** Read existing bilingual XLIFF/MQXLIFF pairs for manual TM import. */
export function extractXliffPairs(buffer, filename, { includeEmptyTargets = false } = {}) {
  const extension = String(filename || "").toLowerCase().endsWith(".mqxliff") ? "mqxliff" : "xliff";
  const parsed = parseXliffXml(decodeXmlBuffer(buffer), extension);
  return parsed.units
    .filter((unit) => unit.sourceText.trim() && (includeEmptyTargets || unit.targetText.trim()))
    .map((unit) => ({
      entryId: unit.id,
      entryKey: unit.memoQContext || "",
      source: unit.sourceText,
      target: unit.targetText,
      previousSource: parsed.units[unit.index - 2]?.sourceText || "",
      nextSource: parsed.units[unit.index]?.sourceText || "",
      context: [unit.context, unit.note].filter(Boolean).join(" | "),
      locked: unit.locked
    }));
}

export function exportXliffDocument({ filename, base64, segments = [] } = {}) {
  const extension = String(filename || "").toLowerCase().endsWith(".mqxliff") ? "mqxliff" : "xliff";
  if (!base64) fail("导出 XLIFF 需要重新选择原始文件");
  const parsed = parseXliffXml(decodeXmlBuffer(Buffer.from(String(base64).replace(/^data:[^;]+;base64,/u, ""), "base64")), extension);
  const replacements = [];
  const expectedTargets = new Map();
  for (const segment of segments) {
    if (segment?.selected === false) continue;
    const unitIndex = Number(segment?.locator?.unitIndex);
    const unit = parsed.units[unitIndex - 1];
    if (!unit || unit.id !== String(segment?.locator?.unitId || "")) fail("XLIFF 翻译单元与原始文件不匹配，请重新载入该文件");
    if (unit.locked || unit.targetText.trim()) fail(`XLIFF 单元 ${unit.id} 不允许覆盖`);
    const translation = String(segment?.translation || "").trim() || String(segment?.source || "");
    const content = restoreMixedText(translation, unit.sourceTagMap, unit.sourceTagIds);
    replacements.push(renderTarget(parsed.xml, unit, content));
    if (extension === "mqxliff") replacements.push({
      start: unit.node.openStart,
      end: unit.node.openEnd,
      value: updateMqStatus(rawOpen(parsed.xml, unit.node), parsed.memoQPrefix)
    });
    expectedTargets.set(unit.index, translation);
  }
  const output = normalizeOutputEncoding(applyReplacements(parsed.xml, replacements));
  const verified = parseXliffXml(output, extension);
  for (const [index, expected] of expectedTargets) {
    const actual = verified.units[index - 1];
    if (!actual || actual.targetText !== expected) fail(`XLIFF 单元 ${index} 写后校验失败`);
  }
  return Buffer.from(output, "utf8");
}

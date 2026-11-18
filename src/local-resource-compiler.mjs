import { extname } from "node:path";
import ExcelJS from "exceljs";
import { SaxesParser } from "saxes";
import { csvValues, parseCsvDocument } from "./csv-document.mjs";
import { extractXliffPairs } from "./xliff-document.mjs";

const tables = [".xlsx", ".csv", ".tsv"];
const guides = [".txt", ".md"];
const memories = [".tmx", ".xliff", ".xlf", ".mqxliff"];
const columns = {
  source: /^(?:日语|日文|日本語|原文|日[语文]原文|源文|ja(?:-jp)?|jp|japanese|source(?: text| term)?)$/iu,
  target: /^(?:中文|简中|简体中文|中文译文|译文|訳文|zh-(?:cn|hans)|chinese(?: simplified)?|simplified chinese|translation|target(?: text| term)?)$/iu,
  note: /^(?:备注|注释|備考|注記|notes?|comments?)$/iu,
  context: /^(?:上下文|语境|文脈|context)$/iu,
  file: /^(?:文件|来源文件|来源|出典|source file|file)$/iu,
  entryId: /^(?:条目编号|句段编号|id|entry id|segment id)$/iu
};

export function unsupportedResource(purpose, path) {
  const ext = extname(path).toLowerCase();
  const supported = purpose === "style-guide" ? guides : purpose === "tm" ? [...tables, ...memories] : tables;
  return supported.includes(ext) ? "" : `本地规则无法解析${ext ? ` ${ext} ` : "无扩展名"}文件的${purpose === "style-guide" ? "正文与排版" : "双语结构"}。`;
}

function decode(bytes, xml = false) {
  let encoding = "utf-8";
  if (xml && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  if (xml && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error(`文件无法按 ${encoding.toUpperCase()} 完整解码。`); }
  if (text.includes("\0")) throw new Error("文本含空字符，无法确认编码。");
  const declared = xml && text.match(/^\s*<\?xml\s[^?]*?encoding\s*=\s*["']([^"']+)/iu)?.[1].toLowerCase();
  if (declared && declared !== encoding && !(declared === "utf-16" && encoding.startsWith("utf-16"))) throw new Error(`XML 声明的编码为 ${declared}，需要核对原件。`);
  return text;
}

function readTable(rows, sheet, entries) {
  let header;
  for (const [rowNumber, values] of rows) {
    if (!values.some((text) => text.trim())) continue;
    const location = `${sheet ? `工作表“${sheet}”` : ""}第 ${rowNumber} 行`;
    if (!header) {
      header = values.map((text) => Object.keys(columns).find((key) => columns[key].test(text.trim().replaceAll("_", "-"))));
      for (const [key, label] of [["source", "原文"], ["target", "译文"]]) {
        const names = values.filter((_, column) => header[column] === key);
        if (!names.length) throw new Error(`${location}找不到明确的${label}列。`);
        if (names.length > 1) throw new Error(`${location}有 ${names.length} 个${label}列（${names.map((name) => `“${name}”`).join("、")}），无法确定该用哪一列。`);
      }
      for (let i = 0; i < values.length; i++) {
        if (values[i].trim() && (!header[i] || header.indexOf(header[i]) !== i)) throw new Error(`${location}的“${values[i]}”列用途不明确。`);
      }
      continue;
    }
    const entry = { rowNumber, ...(sheet ? { sheet } : {}) };
    for (let i = 0; i < values.length; i++) {
      if (!values[i].trim()) continue;
      if (!header[i]) throw new Error(`${location}第 ${i + 1} 列有内容但没有对应表头。`);
      entry[header[i]] = values[i];
    }
    if (!entry.source || !entry.target) throw new Error(`${location}缺少原文或译文。`);
    entries.push(entry);
  }
}

function* worksheetRows(sheet) {
  const last = sheet.rowCount;
  for (let rowNumber = 1; rowNumber <= last; rowNumber++) {
    const row = sheet.findRow(rowNumber);
    if (!row?.hasValues) continue;
    if (row.hidden) throw new Error(`工作表“${sheet.name}”第 ${rowNumber} 行已隐藏，需要核对适用范围。`);
    const values = [];
    row.eachCell((cell, column) => {
      if (sheet.getColumn(column).hidden || cell.isMerged || cell.note || cell.font?.strike || !["string", "number"].includes(typeof cell.value)
          || (typeof cell.value === "number" && cell.numFmt && cell.numFmt !== "General")) throw new Error(`工作表“${sheet.name}”的 ${cell.address} 含需核对的内容或格式。`);
      values[column - 1] = String(cell.value);
    });
    yield [rowNumber, Array.from(values, (value) => value ?? "")];
  }
}

async function workbookEntries(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const entries = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.getImages().length || sheet.getBackgroundImageId() !== undefined || sheet.conditionalFormattings?.length || (sheet.state !== "visible" && sheet.actualRowCount)) throw new Error(`工作表“${sheet.name}”含图片、条件格式或隐藏内容，需要核对适用范围。`);
    const start = entries.length;
    readTable(worksheetRows(sheet), sheet.name, entries);
    if (sheet.actualRowCount && entries.length === start) throw new Error(`工作表“${sheet.name}”没有可核对的双语条目。`);
  }
  return entries;
}

function tmxEntries(text) {
  const entries = [], stack = [];
  const parser = new SaxesParser();
  let unit, language, field, value, type, sawBody = false;
  parser.on("doctype", () => { throw new Error("TMX 含外部或自定义文档声明，需要核对原件。"); });
  parser.on("opentag", ({ name, attributes }) => {
    const parent = stack.at(-1);
    stack.push(name);
    if (!parent && name !== "tmx") throw new Error("未找到 TMX 根元素。");
    if (field) throw new Error(`TMX 的 ${field} 含内联标签 ${name}，需要核对标签。`);
    if (name === "header" && parent === "tmx") {
      if (attributes.srclang && !/^(?:ja(?:-jp)?|\*all\*)$/iu.test(attributes.srclang)) throw new Error("TMX 标注的源语言与日语不符。");
    } else if (stack[1] === "header") return;
    else if (name === "body" && parent === "tmx") sawBody = true;
    else if (name === "tu" && parent === "body") {
      if (attributes.srclang && !/^ja(?:-jp)?$/iu.test(attributes.srclang)) throw new Error("TMX 条目标注的源语言与日语不符。");
      unit = { entryId: attributes.tuid || "", segments: new Map(), notes: [], context: [] };
    }
    else if (name === "tuv" && parent === "tu") {
      language = String(attributes["xml:lang"] || attributes.lang || "").toLowerCase();
      if (!language) throw new Error("TMX 的 tuv 缺少语言标记。");
      if (unit.segments.has(language)) throw new Error(`TMX 条目有重复的 ${language} 译文。`);
    } else if ((name === "seg" && parent === "tuv") || (["prop", "note"].includes(name) && ["tu", "tuv"].includes(parent))) {
      field = name; value = ""; type = attributes.type || "";
    } else if (parent) throw new Error(`TMX 含未识别的结构 ${parent}/${name}。`);
  });
  const content = (text) => { if (field) value += text; else if (text.trim() && stack[1] !== "header") throw new Error("TMX 含未归入句段或备注的文本。"); };
  parser.on("text", content);
  parser.on("cdata", content);
  parser.on("closetag", ({ name }) => {
    stack.pop();
    if (field === name) {
      if (name === "seg") {
        if (unit.segments.has(language) || !value.trim()) throw new Error(`TMX 条目有重复或空的 ${language} 句段。`);
        unit.segments.set(language, value);
      } else if (name === "note") unit.notes.push(value);
      else unit.context.push(type ? `${type}: ${value}` : value);
      field = null;
    } else if (name === "tuv" && unit && !unit.segments.has(language)) throw new Error(`TMX 的 ${language} 语言项缺少句段。`);
    else if (name === "tu" && unit) {
      const variants = [...unit.segments];
      const source = variants.filter(([lang]) => /^ja(?:-jp)?$/u.test(lang));
      const target = variants.filter(([lang]) => /^zh-(?:cn|sg|hans(?:-(?:cn|sg))?)$/u.test(lang));
      if (variants.length !== 2 || source.length !== 1 || target.length !== 1) throw new Error(`TMX 第 ${entries.length + 1} 条需要核对语言，只能本地编译唯一的日语和简中句对。`);
      entries.push({ source: source[0][1], target: target[0][1], entryId: unit.entryId, rowNumber: entries.length + 1, context: unit.context.join("\n"), note: unit.notes.join("\n") });
      unit = null;
    }
  });
  parser.write(text).close();
  if (!sawBody) throw new Error("TMX 缺少 body。");
  return entries;
}

export async function localResourceInput(purpose, path, bytes) {
  const ext = extname(path).toLowerCase();
  if (purpose === "style-guide") {
    const text = decode(bytes);
    if (!text.trim()) throw new Error("指南正文为空。");
    if (/!\[|\]\([^)]*\)|^\s*\[[^\]]+\]:|<(?:img|svg|object|embed|iframe|picture|style|span|font)\b|<[a-z][^>]*\s(?:style|src|href)\s*=/imu.test(text)) throw new Error("指南含图片、链接或富文本格式，需要核对完整规则。");
    return { format: "kami-guide-v1", complete: true, style_guide: text };
  }
  if (ext === ".xlsx") return { entries: await workbookEntries(bytes) };
  if (memories.includes(ext)) {
    const text = decode(bytes, true);
    return { entries: ext === ".tmx" ? tmxEntries(text) : extractXliffPairs(Buffer.from(text), path, { verifyLibrary: true }) };
  }
  const document = parseCsvDocument(decode(bytes), { delimiter: ext === ".tsv" ? "\t" : "," });
  for (const [index, row] of document.rows.entries()) {
    if (row.cells.some(({ raw }) => raw.includes('"') && !/^"(?:[^"]|"")*"$/u.test(raw))) throw new Error(`第 ${index + 1} 行的引号不成对，需要核对字段边界。`);
  }
  const rows = csvValues(document);
  const entries = [];
  readTable(rows.map((values, i) => [i + 1, values]), "", entries);
  return { entries };
}

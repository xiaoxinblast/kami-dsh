import { extname, basename } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { csvValues, parseCsvDocument, replaceCsvCells } from "./csv-document.mjs";
import { applyColumnMapping, buildSpreadsheetSnapshot, describeSpreadsheetAnalysis, inferSpreadsheetStructure, mergeSpreadsheetAnalysis } from "./spreadsheet-structure.mjs";
import { exportXliffDocument, prepareXliffDocument } from "./xliff-document.mjs";
import { runtimeOptions } from "./runtime-context.mjs";

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".docx", ".xlsx", ".csv", ".xliff", ".mqxliff"]);
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SEGMENTS = 2_000;

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function decodeBase64(value) {
  const compact = String(value || "").replace(/^data:[^;]+;base64,/, "");
  if (!compact) fail("文件内容为空");
  const buffer = Buffer.from(compact, "base64");
  if (!buffer.length) fail("文件内容无法读取");
  if (!runtimeOptions().embedded && buffer.length > MAX_FILE_BYTES) fail(`文件超过 ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB 限制`, 413);
  return buffer;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function encodeXml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function segmentLongText(value, segmentationMode = "sentence") {
  const text = String(value || "").trim();
  if (!text) return [];
  if (["paragraph", "unit"].includes(segmentationMode)) return [text];
  return [...new Intl.Segmenter("zh", { granularity: "sentence" }).segment(text)].map((item) => item.segment.trim()).filter(Boolean);
}

function segmentBoundary(segment) {
  const locator = segment?.locator || {};
  const context = segment?.context || {};
  return [locator.type || "", locator.sheet || context.sheet || ""].join("\u0000");
}

/** Split a parent file task without splitting a structural region first. */
export function splitBatchSubBatches(segments = [], { maxEntries = 100, maxChars = 8_000 } = {}) {
  const entryLimit = Math.max(1, Number(maxEntries) || 100);
  const charLimit = Math.max(1, Number(maxChars) || 8_000);
  const batches = [];
  let current = [];
  let chars = 0;
  let boundary = "";
  const flush = () => {
    if (!current.length) return;
    batches.push({ index: batches.length + 1, segmentIds: current.map((segment) => segment.id), entries: current.length, characters: chars });
    current = [];
    chars = 0;
    boundary = "";
  };
  for (const segment of Array.isArray(segments) ? segments : []) {
    const nextBoundary = segmentBoundary(segment);
    const length = Array.from(String(segment.source || "")).length;
    if (current.length && (current.length >= entryLimit || chars + length > charLimit || (boundary && nextBoundary !== boundary && current.length >= entryLimit / 2))) flush();
    current.push(segment);
    chars += length;
    boundary ||= nextBoundary;
  }
  flush();
  return batches;
}

export function splitTranslationGroups(segments = [], { maxEntries = 10, maxChars = 1_500 } = {}) {
  return splitBatchSubBatches(segments, { maxEntries, maxChars }).map((batch) => ({ ...batch, ids: batch.segmentIds }));
}

function createCollector(segmentationMode) {
  const segments = [];
  const add = (source, locator, context = {}) => {
    const split = segmentLongText(source, segmentationMode);
    const ids = split.map((text) => {
      if (!runtimeOptions().embedded && segments.length >= MAX_SEGMENTS) fail(`分段超过 ${MAX_SEGMENTS} 段，请拆分文件后重试`, 413);
      const id = `seg-${segments.length + 1}`;
      segments.push({ id, index: segments.length + 1, source: text, locator, context, selected: true });
      return id;
    });
    return ids;
  };
  return { segments, add };
}

function preparePlainText(text, filename, segmentationMode) {
  const collector = createCollector(segmentationMode);
  const pieces = [];
  for (const token of String(text || "").replace(/^\uFEFF/, "").split(/(\r?\n+)/)) {
    if (!token) continue;
    if (/^\r?\n/.test(token) || !token.trim()) {
      pieces.push({ type: "text", value: token });
      continue;
    }
    const leading = token.match(/^\s*/)?.[0] || "";
    const trailing = token.match(/\s*$/)?.[0] || "";
    if (leading) pieces.push({ type: "text", value: leading });
    for (const id of collector.add(token.trim(), { type: "text" })) pieces.push({ type: "segment", id });
    if (trailing) pieces.push({ type: "text", value: trailing });
  }
  return { format: extname(filename).toLowerCase() === ".md" ? "markdown" : "text", segments: collector.segments, structure: { pieces } };
}

async function prepareDocx(buffer, segmentationMode) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) fail("DOCX 缺少 word/document.xml，文件可能已损坏");
  const xml = await entry.async("string");
  const collector = createCollector(segmentationMode);
  const paragraphs = [];
  let paragraphIndex = 0;
  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const paragraphXml = match[0];
    const source = [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => decodeXml(item[1])).join("").trim();
    if (source) {
      const segmentIds = collector.add(source, { type: "docx-paragraph", paragraphIndex });
      paragraphs.push({ paragraphIndex, segmentIds });
    }
    paragraphIndex += 1;
  }
  return { format: "docx", segments: collector.segments, structure: { paragraphs } };
}

function excelCellText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value.richText)) return value.richText.map((item) => item.text).join("").trim();
  if (value.result != null) return String(value.result).trim();
  if (value.text != null) return String(value.text).trim();
  return String(cell.text || "").trim();
}

async function prepareSpreadsheet(workbook, segmentationMode, analyzeSpreadsheet, format = "xlsx", columnMapping = null) {
  const snapshot = buildSpreadsheetSnapshot(workbook, excelCellText);
  const ruleAnalysis = inferSpreadsheetStructure(snapshot, { allowSingleColumnHeader: format === "csv" });
  let analysis = ruleAnalysis;
  let fallbackReason = "";
  if (analyzeSpreadsheet) {
    try {
      const modelAnalysis = await analyzeSpreadsheet(snapshot, ruleAnalysis);
      analysis = mergeSpreadsheetAnalysis(snapshot, ruleAnalysis, modelAnalysis);
      fallbackReason = analysis.usedModel ? "" : analysis.fallbackReason || "AI 未返回有效识别结果";
    } catch (error) {
      fallbackReason = error.message;
      analysis = { ...ruleAnalysis, fallbackReason };
    }
  }
  // 上传弹窗里的人工列映射优先：用户既已逐列确认，就不再让自动识别覆盖它。
  analysis = applyColumnMapping(analysis, columnMapping);
  const collector = createCollector(segmentationMode);
  const cells = [];
  // 导出用：这张表有没有真正的"译文列"，没有的话要把译文写到末尾新增的一列，
  // 而不是覆盖原文（原位覆盖会让用户拿不到原文，是不可逆的破坏）。
  const translationColumns = {};
  workbook.eachSheet((worksheet) => {
    const sheetAnalysis = analysis.sheets.find((sheet) => sheet.sheet === worksheet.name);
    if (!sheetAnalysis) return;
    const roles = new Map(sheetAnalysis.columns.map((column) => [column.column, column]));
    const sourceColumns = sheetAnalysis.columns.filter((column) => column.role === "source_text").map((column) => column.column);
    // 写回列：优先用"译文列"（translation_output，memoQ 的 target 语义）；
    // 没有这样的列就写回原文列本身（原位覆盖），与旧行为一致。
    const outputColumns = sheetAnalysis.columns.filter((column) => column.role === "translation_output").map((column) => column.column);
    translationColumns[worksheet.name] = {
      hasTranslationColumn: outputColumns.length > 0,
      appendColumn: outputColumns[0] || Math.max(worksheet.columnCount || 0, ...sheetAnalysis.columns.map((column) => Number(column.column) || 0)) + 1,
      headerRow: Number(sheetAnalysis.headerRow) || 1,
      // 无表头的表格不能往第一行写"译文"列头，那会顶掉一条正文。
      hasHeader: Boolean(sheetAnalysis.headerRow)
    };
    worksheet.eachRow((row) => {
      if (sheetAnalysis.headerRow && row.number === sheetAnalysis.headerRow) return;
      const metadata = [];
      let entryId = "";
      const references = [];
      for (const column of sheetAnalysis.columns) {
        if (column.role === "source_text" || column.role === "ignore") continue;
        const value = excelCellText(row.getCell(column.column));
        if (!value) continue;
        const item = { label: column.label || `${column.letter}列`, value, role: column.role };
        if (column.role === "existing_translation") references.push(item);
        else if (column.role === "entry_id") entryId = value;
        else metadata.push(item);
      }
      for (const columnNumber of sourceColumns) {
        const cell = row.getCell(columnNumber);
        const source = excelCellText(cell);
        if (!source) continue;
        const column = roles.get(columnNumber);
        const context = {
          sheet: worksheet.name,
          row: row.number,
          sourceColumn: column?.label || `第 ${columnNumber} 列`,
          metadata,
          referenceTranslations: references,
          entryId
        };
        const locator = { type: `${format}-cell`, sheet: worksheet.name, address: cell.address, row: row.number, column: columnNumber, entryId };
        const segmentIds = collector.add(source, locator, context);
        const targetColumn = outputColumns[0] || columnNumber;
        const targetAddress = row.getCell(targetColumn).address;
        locator.targetColumn = targetColumn;
        locator.targetAddress = targetAddress;
        cells.push({ sheet: worksheet.name, address: cell.address, row: row.number, column: columnNumber, targetAddress, targetColumn, segmentIds });
      }
    });
  });
  return {
    format,
    segments: collector.segments,
    structure: { cells, translationColumns },
    spreadsheetAnalysis: {
      source: analysis.usedModel ? "model" : "rules",
      usedModel: Boolean(analysis.usedModel),
      fallbackReason,
      sheets: describeSpreadsheetAnalysis(analysis)
    }
  };
}

async function prepareXlsx(buffer, segmentationMode, analyzeSpreadsheet, columnMapping = null) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return prepareSpreadsheet(workbook, segmentationMode, analyzeSpreadsheet, "xlsx", columnMapping);
}

async function prepareCsv(buffer, segmentationMode, analyzeSpreadsheet, columnMapping = null) {
  const document = parseCsvDocument(buffer.toString("utf8"));
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("CSV");
  for (const row of csvValues(document)) worksheet.addRow(row);
  const prepared = await prepareSpreadsheet(workbook, segmentationMode, analyzeSpreadsheet, "csv", columnMapping);
  return {
    ...prepared,
    structure: {
      ...prepared.structure,
      csv: { delimiter: document.delimiter, bom: document.bom, rows: document.rows.length }
    }
  };
}

/**
 * 上传待译表格时给"列含义"弹窗用：返回每个工作表识别到的列、建议角色与样例值，
 * 用户可以在弹窗里逐列改角色、决定首行是不是表头，确认后再走 prepareBatchDocument。
 * 只分析结构，不生成段落、不调用翻译。
 */
export async function describeBatchColumns(input = {}, options = {}) {
  const filename = String(input.filename || "").trim();
  const extension = extname(filename).toLowerCase();
  if (![".xlsx", ".csv"].includes(extension)) fail("只有 .xlsx / .csv 表格需要确认列含义", 400);
  const buffer = extension === ".csv"
    ? (input.text !== undefined ? Buffer.from(String(input.text), "utf8") : decodeBase64(input.base64))
    : decodeBase64(input.base64);
  const workbook = new ExcelJS.Workbook();
  if (extension === ".csv") {
    const document = parseCsvDocument(buffer.toString("utf8"));
    const worksheet = workbook.addWorksheet("CSV");
    for (const row of csvValues(document)) worksheet.addRow(row);
  } else {
    await workbook.xlsx.load(buffer);
  }
  const snapshot = buildSpreadsheetSnapshot(workbook, excelCellText);
  const ruleAnalysis = inferSpreadsheetStructure(snapshot, { allowSingleColumnHeader: extension === ".csv" });
  let analysis = ruleAnalysis;
  let fallbackReason = "";
  if (options.analyzeSpreadsheet) {
    try {
      const modelAnalysis = await options.analyzeSpreadsheet(snapshot, ruleAnalysis);
      analysis = mergeSpreadsheetAnalysis(snapshot, ruleAnalysis, modelAnalysis);
      fallbackReason = analysis.usedModel ? "" : analysis.fallbackReason || "AI 未返回有效识别结果";
    } catch (error) {
      fallbackReason = error.message;
      analysis = { ...ruleAnalysis, fallbackReason };
    }
  }
  return {
    filename,
    format: extension.slice(1),
    structureSource: analysis.usedModel ? "model" : "rules",
    fallbackReason,
    sheets: analysis.sheets.map((sheet) => {
      const snapshotSheet = snapshot.sheets.find((item) => item.sheet === sheet.sheet);
      const headerCells = new Map((snapshotSheet?.rows.find((row) => row.row === sheet.headerRow)?.cells || []).map((cell) => [cell.column, cell.text]));
      return {
        sheet: sheet.sheet,
        headerRow: sheet.headerRow,
        rowCount: snapshotSheet?.rowCount || 0,
        reason: sheet.reason,
        columns: sheet.columns.map((column) => {
          const samples = (snapshotSheet?.columns.find((item) => item.column === column.column)?.samples || [])
            .filter((sample) => !sheet.headerRow || sample.row !== sheet.headerRow)
            .map((sample) => String(sample.text || "").slice(0, 80))
            .filter(Boolean)
            .slice(0, 3);
          const header = sheet.headerRow ? (headerCells.get(column.column) || "") : "";
          return {
            column: column.column,
            letter: column.letter,
            label: column.label,
            header,
            // 表头为空但下面有内容的列：提示用户"这列没有表头，是按内容推断的"。
            headerEmpty: Boolean(sheet.headerRow) && !header.trim(),
            role: column.role,
            confidence: column.confidence,
            reason: column.reason,
            samples
          };
        })
      };
    })
  };
}

export async function prepareBatchDocument(input = {}, options = {}) {
  const filename = String(input.filename || (input.text ? "粘贴长文.txt" : "")).trim();
  const extension = extname(filename).toLowerCase();
  if (!filename || !SUPPORTED_EXTENSIONS.has(extension)) fail("仅支持 .txt、.md、.docx、.xlsx、.csv、.xliff、.mqxliff 文件");
  const structured = [".xlsx", ".csv", ".xliff", ".mqxliff"].includes(extension);
  let segmentationMode = ["paragraph", "unit", "group"].includes(input.segmentationMode) ? input.segmentationMode : "sentence";
  if (structured && !["unit", "group"].includes(segmentationMode)) segmentationMode = "unit";
  const collectorMode = structured ? "unit" : segmentationMode;
  const bytes = () => {
    if (!input.buffer) return decodeBase64(input.base64);
    const buffer = Buffer.from(input.buffer);
    if (!buffer.length) fail("文件内容为空");
    if (!runtimeOptions().embedded && buffer.length > MAX_FILE_BYTES) fail(`文件超过 ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB 限制`, 413);
    return buffer;
  };
  let prepared;
  if (extension === ".txt" || extension === ".md") {
    const text = input.text !== undefined ? String(input.text) : bytes().toString("utf8");
    prepared = preparePlainText(text, filename, collectorMode);
  } else if (extension === ".docx") prepared = await prepareDocx(bytes(), collectorMode);
  else if (extension === ".csv") {
    const buffer = input.text !== undefined ? Buffer.from(String(input.text), "utf8") : bytes();
    prepared = await prepareCsv(buffer, collectorMode, options.analyzeSpreadsheet, options.columnMapping || null);
  } else if (extension === ".xliff" || extension === ".mqxliff") prepared = prepareXliffDocument(bytes(), filename);
  else prepared = await prepareXlsx(bytes(), collectorMode, options.analyzeSpreadsheet, options.columnMapping || null);
  if (!prepared.segments.length) fail("没有找到可翻译的日语内容");
  return {
    filename,
    segmentationMode,
    ...prepared,
    subBatches: splitBatchSubBatches(prepared.segments, options.batch || {}),
    statistics: {
      segments: prepared.segments.length,
      characters: prepared.segments.reduce((sum, segment) => sum + Array.from(segment.source).length, 0)
    }
  };
}

function translationMap(segments = []) {
  return new Map(segments.map((segment) => [segment.id, segment.selected === false ? segment.source : (String(segment.translation || "").trim() || segment.source)]));
}

function translatedGroup(ids, translations) {
  return ids.map((id) => translations.get(id) || "").join("");
}

function outputName(filename, locale, extension = extname(filename)) {
  const stem = basename(filename, extname(filename));
  return `${stem}.${String(locale || "translated").replace(/[^a-zA-Z0-9-]/g, "-")}${extension}`;
}

/** 生成"仅译文"的 DOCX：一段一行译文，不带原文、不带原排版。 */
async function buildTranslationOnlyDocx(paragraphs = []) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder("_rels").file(".rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 单列译文表：给 xliff/mqxliff 这类"没有纯译文文件形态"的源用。 */
function buildTranslationWorkbook(lines) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("译文");
  worksheet.columns = [{ header: "译文", key: "translation", width: 80 }];
  lines.forEach((line) => worksheet.addRow({ translation: line }));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  return workbook;
}

/** xlsx 双语表：文本文档（txt/md/docx）没有列可填，就按段落给原文 + 译文。 */
function buildBilingualWorkbook(segments = []) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("双语对照");
  worksheet.columns = [
    { header: "序号", key: "index", width: 8 },
    { header: "原文", key: "source", width: 58 },
    { header: "译文", key: "translation", width: 58 }
  ];
  segments.filter((segment) => segment.selected !== false).forEach((segment, index) => {
    worksheet.addRow({ index: index + 1, source: segment.source || "", translation: segment.translation || "" });
  });
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF123E31" } };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: "top", wrapText: true };
    if (rowNumber > 1) row.height = 36;
  });
  return workbook;
}

/**
 * 表格的双语写回：有译文列就填那一列，没有就在末尾新增一列"译文"。
 *
 * `translationColumns` 是解析阶段记下来的（哪张表有没有译文列、追加列是第几列），
 * 导出时按它决定目标单元格——绝不覆盖原文列。
 */
async function exportSpreadsheetWithTranslationColumn(input, translations) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(decodeBase64(input.base64));
  const plan = input.structure?.translationColumns || {};
  const appliedSheets = new Set();
  for (const item of input.structure?.cells || []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    if (!worksheet) continue;
    const sheetPlan = plan[item.sheet] || {};
    const target = sheetPlan.hasTranslationColumn
      ? (item.targetAddress || item.address)
      : `${columnNumberToLetters(sheetPlan.appendColumn || item.column || 1)}${Number(item.row) || 1}`;
    worksheet.getCell(target).value = translatedGroup(item.segmentIds, translations);
    if (!appliedSheets.has(item.sheet) && sheetPlan.hasTranslationColumn !== true && sheetPlan.hasHeader === true) {
      // 追加列的列头写"译文"，用户打开就能看出这一列是系统加的。
      const headerCell = worksheet.getCell(`${columnNumberToLetters(sheetPlan.appendColumn || 1)}${Number(sheetPlan.headerRow) || 1}`);
      if (!excelCellText(headerCell)) headerCell.value = "译文";
      appliedSheets.add(item.sheet);
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** csv 同规则：目标列 = 译文列，没有就追加到最后一列之后。 */
function exportCsvWithTranslationColumn(input, translations) {
  const original = input.text !== undefined ? String(input.text) : decodeBase64(input.base64).toString("utf8");
  const document = parseCsvDocument(original, { delimiter: input.structure?.csv?.delimiter });
  const plan = input.structure?.translationColumns || {};
  const sheetPlan = plan[Object.keys(plan)[0] || ""] || {};
  const replacements = [];
  if (sheetPlan.hasTranslationColumn !== true && sheetPlan.hasHeader === true) {
    // 追加列也要有列头，否则用户打开只看到一列没有名字的译文。
    replacements.push({ row: Number(sheetPlan.headerRow) || 1, column: Number(sheetPlan.appendColumn) || 1, value: "译文" });
  }
  for (const item of input.structure?.cells || []) replacements.push({
    row: Number(item.row),
    column: Number(sheetPlan.hasTranslationColumn ? (item.targetColumn || item.column) : (sheetPlan.appendColumn || item.column)),
    value: translatedGroup(item.segmentIds, translations)
  });
  return replaceCsvCells(
    document,
    replacements.filter((item) => Number.isInteger(item.row) && item.row > 0 && Number.isInteger(item.column) && item.column > 0),
    { allowAppend: sheetPlan.hasTranslationColumn !== true }
  );
}

/** 1 → A、27 → AA。 */
function columnNumberToLetters(value) {
  let number = Math.max(1, Math.trunc(Number(value) || 1));
  let letters = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return letters;
}

export async function exportBatchDocument(input = {}) {
  const requested = String(input.format || "");
  /**
   * 三种交付语义（用户定的）：
   * - bilingual：原文 + 译文放同一份里。表格有译文列就填那一列、没有就在末尾新增"译文"列；
   *   mqxliff/xliff 填 target；文本文档（txt/md/docx）没有"列"的概念，给 xlsx 双语表。
   * - translation：只要译文。docx 给纯译文文档、xlsx/csv 给单列译文、txt/md 给纯译文；
   *   mqxliff/xliff 是双语容器、抽不出"纯译文文件"，统一转成 xlsx 单列译文表。
   * - in-place：老行为（写回原文件里的对应位置），翻译界面里的「写回原文件」还用它。
   */
  const kind = requested === "translation" ? "translation"
    : requested === "bilingual" ? "bilingual"
      : input.mode === "translation-only" ? "translation"
        : requested === "task-xlsx" ? "task-xlsx"
          : "in-place";
  const format = kind === "task-xlsx" ? "task-xlsx" : requested === "translation" || requested === "bilingual" ? String(input.sourceFormat || "") : requested;
  const sourceFormat = String(input.sourceFormat || requested || "");
  const translations = translationMap(input.segments);
  if (!translations.size) fail("没有可导出的分段");
  const orderedSegments = (input.segments || []).filter((segment) => segment.selected !== false && String(segment.translation || "").trim());
  const translationLines = orderedSegments.map((segment) => String(segment.translation || "").trim());
  let buffer;
  let mimeType;
  let extension;

  const effectiveFormat = ["translation", "bilingual"].includes(kind) ? sourceFormat : format;
  const needsSource = ["docx", "xlsx", "csv", "xliff", "mqxliff"].includes(effectiveFormat);
  /** 双语交付能"填回原文件"的格式：表格填列、xliff 填 target；其余文本文档给 xlsx 双语表。 */
  const bilingualWritesBack = ["xlsx", "csv", "xliff", "mqxliff"].includes(effectiveFormat);
  if (kind === "in-place" && ["docx", "xlsx", "xliff", "mqxliff"].includes(effectiveFormat) && !input.base64) {
    fail("写回原文件需要原始文件，请重新选择该文件；只想拿译文可以选「仅译文」导出");
  }
  if (kind === "in-place" && effectiveFormat === "csv" && input.text === undefined && !input.base64) {
    fail("写回原文件需要原始文件，请重新选择该文件；只想拿译文可以选「仅译文」导出");
  }

  if (kind === "translation") {
    // 仅译文：适合交给下游直接使用的纯译文文件。
    if (effectiveFormat === "docx") {
      buffer = await buildTranslationOnlyDocx(translationLines);
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      extension = ".docx";
    } else if (["xlsx", "xliff", "mqxliff"].includes(effectiveFormat)) {
      // xliff / mqxliff 没有"纯译文文件"这种形态：统一给一份单列译文表，跟其它"仅译文"一致。
      const workbook = buildTranslationWorkbook(translationLines);
      buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      extension = ".xlsx";
    } else if (effectiveFormat === "csv") {
      const escapeCell = (value) => `"${String(value ?? "").replace(/"/gu, '""')}"`;
      buffer = Buffer.from([["译文"], ...translationLines.map((line) => [line])].map((row) => row.map(escapeCell).join(",")).join("\r\n"), "utf8");
      mimeType = "text/csv; charset=utf-8";
      extension = ".csv";
    } else if (effectiveFormat === "markdown" || effectiveFormat === "text") {
      buffer = Buffer.from(translationLines.join("\n"), "utf8");
      mimeType = effectiveFormat === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
      extension = effectiveFormat === "markdown" ? ".md" : ".txt";
    } else {
      fail("这个格式不支持仅译文导出");
    }
  } else if (kind === "bilingual" && !bilingualWritesBack) {
    // 文本文档没有"列"可填：给一份 xlsx 双语表（序号 / 原文 / 译文）。
    const workbook = buildBilingualWorkbook(input.segments || []);
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = ".xlsx";
  } else if (kind === "bilingual" && effectiveFormat === "xlsx") {
    buffer = await exportSpreadsheetWithTranslationColumn(input, translations);
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = ".xlsx";
  } else if (kind === "bilingual" && effectiveFormat === "csv") {
    buffer = Buffer.from(exportCsvWithTranslationColumn(input, translations), "utf8");
    mimeType = "text/csv; charset=utf-8";
    extension = ".csv";
  } else if (kind === "bilingual" && (effectiveFormat === "xliff" || effectiveFormat === "mqxliff")) {
    buffer = exportXliffDocument({ ...input, format: effectiveFormat });
    mimeType = "application/xliff+xml; charset=utf-8";
    extension = effectiveFormat === "mqxliff" ? ".mqxliff" : ".xliff";
  } else if (format === "task-xlsx") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("翻译任务");
    worksheet.columns = [
      { header: "序号", key: "index", width: 9 },
      { header: "日语原文", key: "source", width: 54 },
      { header: "译文", key: "translation", width: 54 },
      { header: "状态", key: "status", width: 14 },
      { header: "AIQA 分数", key: "score", width: 13 },
      { header: "QA 意见", key: "issues", width: 58 },
      { header: "人工决定", key: "decisions", width: 34 }
    ];
    (input.segments || []).filter((segment) => segment.selected !== false).forEach((segment, index) => {
      const result = segment.result || {};
      worksheet.addRow({
        index: index + 1,
        source: segment.source || "",
        translation: segment.translation || "",
        status: segment.status === "done" ? "已翻译" : segment.status === "error" ? "失败" : "待处理",
        score: Number.isFinite(result.qaScore) ? result.qaScore : "",
        issues: (result.issues || []).map((issue) => issue.message || issue.suggestion || issue.type).filter(Boolean).join("\n"),
        decisions: (result.aiQa?.humanDecisions || []).map((item) => `${item.decision === "approved_as_is" ? "批准当前译文" : "要求 AI 修订"}：${item.issue?.message || item.reason || ""}`).join("\n")
      });
    });
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF123E31" } };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: "top", wrapText: true };
      if (rowNumber > 1) row.height = 42;
    });
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = ".xlsx";
  } else if (format === "text" || format === "markdown") {
    const content = (input.structure?.pieces || []).map((piece) => piece.type === "segment" ? (translations.get(piece.id) || "") : String(piece.value || "")).join("");
    buffer = Buffer.from(content, "utf8");
    mimeType = format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
    extension = format === "markdown" ? ".md" : ".txt";
  } else if (format === "docx") {
    const zip = await JSZip.loadAsync(decodeBase64(input.base64));
    const entry = zip.file("word/document.xml");
    if (!entry) fail("DOCX 缺少 word/document.xml");
    const replacements = new Map((input.structure?.paragraphs || []).map((item) => [item.paragraphIndex, translatedGroup(item.segmentIds, translations)]));
    let paragraphIndex = 0;
    const xml = (await entry.async("string")).replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
      const replacement = replacements.get(paragraphIndex++);
      if (replacement === undefined) return paragraph;
      let used = false;
      return paragraph.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, attributes = "") => {
        const content = used ? "" : encodeXml(replacement);
        used = true;
        return `<w:t${attributes}>${content}</w:t>`;
      });
    });
    zip.file("word/document.xml", xml);
    buffer = await zip.generateAsync({ type: "nodebuffer" });
    mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    extension = ".docx";
  } else if (format === "xliff" || format === "mqxliff") {
    buffer = exportXliffDocument(input);
    mimeType = "application/xliff+xml; charset=utf-8";
    extension = format === "mqxliff" ? ".mqxliff" : ".xliff";
  } else if (format === "xlsx") {
    // 写回原文件同样不覆盖原文：有译文列写译文列，没有就在末尾加一列。
    buffer = await exportSpreadsheetWithTranslationColumn(input, translations);
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = ".xlsx";
  } else if (format === "csv") {
    buffer = Buffer.from(exportCsvWithTranslationColumn(input, translations), "utf8");
    mimeType = "text/csv; charset=utf-8";
    extension = ".csv";
  } else fail("不支持的导出格式");

  return {
    filename: outputName(input.filename || `translated${extension}`, input.locale, extension),
    extension,
    mimeType,
    base64: buffer.toString("base64"),
    bytes: buffer.length
  };
}

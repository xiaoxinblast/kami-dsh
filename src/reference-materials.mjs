/**
 * 参考资料：文件解析、分块与风险扫描。
 *
 * 参考资料和术语/TM 不同——它们不随每次翻译注入提示词，只在模型主动查询时
 * 才作为工具结果返回片段。因此这里只负责把上传文件变成可检索的片段，
 * 不做任何审批与权重计算。
 */

import { extname, basename } from "node:path";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { csvValues, parseCsvDocument } from "./csv-document.mjs";
import { hasInjectionSignature } from "./style-rules.mjs";

export const REFERENCE_KINDS = Object.freeze({
  character: "角色设定",
  script: "剧本",
  synopsis: "故事梗概",
  setting: "设定资料",
  other: "其他"
});

/** 模型认得的位图格式 → MIME。EMF/WMF/SVG 这类矢量图模型读不了，不入列。 */
const IMAGE_MEDIA_TYPES = new Map(Object.entries({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp"
}));

export const REFERENCE_FORMATS = Object.freeze([".txt", ".md", ".docx", ".xlsx", ".csv", ".pdf", ".pptx", ...[...IMAGE_MEDIA_TYPES.keys()].map((extension) => `.${extension}`)]);

/**
 * 参考资料的单文件上限。
 *
 * 只放宽这一个入口：待译文件、TM / 术语导入仍按 32MB（那些链路是"逐条入表"，
 * 几百 MB 的表格本来也不该整份走一遍）。上传走原始字节流式落盘，浏览器不拼 base64。
 */
export const MAX_REFERENCE_FILE_BYTES = 200 * 1024 * 1024;
/** 低于这个字符数的 PDF 页面按扫描页处理，交给模型看图。 */
const SCANNED_PAGE_MIN_CHARS = 20;
/**
 * 识图张数超过这个值就先让用户确认：一份 300 页扫描件就是 300 次视觉调用，
 * 不打招呼直接跑，用户只会看到"导入卡住了 + 账单"。
 */
export const REFERENCE_VISION_CONFIRM_THRESHOLD = 20;
/** 估算用：一次视觉调用的平均耗时（秒）。 */
const VISION_SECONDS_PER_CALL = 4;
/**
 * zip 类文档解压后的总字节护栏（docx / pptx）。
 *
 * JSZip 会把整包读进内存再解压，解压后几百 MB 的包能吃掉几 GB 堆。宁可在解析前
 * 明确拒绝并提示拆分，也不要让工作台被 OOM 掉（实测过一次就是"连不上工作台"）。
 */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 800 * 1024 * 1024;
/** xlsx 的工作表 XML 总量护栏：ExcelJS 会把整本工作簿建成对象树，比 zip 更吃内存。 */
export const MAX_XLSX_XML_BYTES = 80 * 1024 * 1024;
/** 小于这个边长的一律当图标、项目符号，不送去识图。 */
const MIN_VISION_IMAGE_PIXELS = 64;
/** 图片转录出来的文字单独成段，并标出来源，避免被当成正文原话。 */
const IMAGE_TEXT_MARKER = "〔图片文字〕";
export const CHUNK_TARGET_CHARS = 600;
export const CHUNK_OVERLAP_CHARS = 80;
export const MAX_CHUNKS_PER_DOCUMENT = 2_000;

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeBase64(base64) {
  return Buffer.from(String(base64 || "").replace(/^data:[^;]+;base64,/u, ""), "base64");
}

function mediaTypeOf(name) {
  return IMAGE_MEDIA_TYPES.get(extname(String(name || "")).replace(/^\./u, "").toLowerCase()) || "";
}

/** 一份资料共用的识图预算与统计：用在导入报告里说明读了几张、跳了几张。 */
/**
 * 识图统计：`used` 是全部视觉调用（扫描页 + 内嵌图片 + 独立图片），
 * `embedded` 只计文档内嵌图片（报告里"几张内嵌图片识图"不能把扫描页也算进来）。
 *
 * `skippedByUser` 是用户选了「只读文字」时跳过的张数——不设张数上限是全量识图的
 * 前提，但用户明确说不要识图时，得如实记下来，而不是假装这份资料只有文字。
 */
function visionBudget() {
  return { used: 0, embedded: 0, skipped: 0, skippedByUser: 0, pending: 0, seen: new Set() };
}

async function imageSize(buffer) {
  try {
    const { loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(buffer);
    return { width: Number(image.width) || 0, height: Number(image.height) || 0 };
  } catch {
    return null;
  }
}

/** 从 zip 里读一批图片条目（docx 的 word/media、pptx 的 ppt/media 都是这个形态）。 */
async function archiveImages(archive, names) {
  const images = [];
  for (const name of names) {
    const file = archive.file(name);
    if (!file) continue;
    images.push({ key: name, name, mediaType: mediaTypeOf(name), buffer: await file.async("nodebuffer") });
  }
  return images;
}

/**
 * 文档里的内嵌图片：逐张交给模型识图，返回可直接拼进正文的文字。
 *
 * 图标级小图、模型认不了的矢量图、超出限额的图都跳过并计数，最后写进导入报告——
 * 静默丢掉才是问题，跳过多少张必须能看见。
 */
async function transcribeImages({ images = [], page = null, label = "文档里的图片", onScannedPage = null, budget, vision = true }) {
  const parts = [];
  let index = 0;
  for (const image of images) {
    if (budget.seen.has(image.key)) continue;
    budget.seen.add(image.key);
    index += 1;
    // 用户选了「只读文字」：图片一律不送模型，但要计数（报告里说明白了，才不会以为是解析漏了）。
    if (vision !== true) {
      budget.skippedByUser += 1;
      continue;
    }
    const size = await imageSize(image.buffer);
    if (!size || size.width < MIN_VISION_IMAGE_PIXELS || size.height < MIN_VISION_IMAGE_PIXELS) {
      budget.skipped += 1;
      continue;
    }
    if (typeof onScannedPage !== "function") {
      budget.pending += 1;
      continue;
    }
    budget.used += 1;
    budget.embedded += 1;
    const base64 = image.buffer.toString("base64");
    const text = normalizeText(await onScannedPage({
      page,
      label: `${label} #${index}`,
      mediaType: image.mediaType || "image/png",
      render: async () => base64
    }));
    if (text) parts.push(`${IMAGE_TEXT_MARKER}\n${text}`);
  }
  return parts.join("\n\n");
}

function joinPageText(text, imageText) {
  return [normalizeText(text), imageText].filter(Boolean).join("\n\n");
}

/**
 * 上传后的预扫：只统计页数与图片张数，一次模型调用都不发。
 *
 * 用途是"导入前先告诉用户这份资料要识多少张图"。所以这里刻意不做像素级过滤
 * （那要逐张解码，等于先跑一遍导入），数出来的是**上限**，实际识图张数会略少。
 */
export async function planReferenceExtraction({ filename, base64 = "", buffer: rawBuffer = null, path = "" } = {}) {
  const safeName = basename(String(filename || "").trim());
  const format = referenceFormatOf(safeName);
  const buffer = await readReferenceBytes({ base64, buffer: rawBuffer, path });
  if (buffer.length > MAX_REFERENCE_FILE_BYTES) {
    throw Object.assign(new Error(`单个参考资料不能超过 ${Math.round(MAX_REFERENCE_FILE_BYTES / 1024 / 1024)}MB`), { statusCode: 400 });
  }
  const plan = { bytes: buffer.length, pages: 1, images: 0, textPages: 1, scannedPages: 0 };
  if (IMAGE_MEDIA_TYPES.has(format)) {
    plan.images = 1;
    plan.textPages = 0;
    plan.scannedPages = 1;
  } else if (format === "pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true }).promise;
    plan.pages = document.numPages;
    plan.textPages = 0;
    plan.scannedPages = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      let text = "";
      try {
        const content = await page.getTextContent();
        text = normalizeText(content.items.map((item) => String(item.str || "")).join(" "));
      } catch { text = ""; }
      let imageOps = 0;
      try {
        const ops = await page.getOperatorList();
        imageOps = ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject).length;
      } catch { imageOps = 0; }
      plan.images += imageOps;
      if ([...text].length >= SCANNED_PAGE_MIN_CHARS) plan.textPages += 1;
      else plan.scannedPages += 1;
    }
  } else if (format === "pptx") {
    const archive = await JSZip.loadAsync(buffer);
    await assertArchiveFitsMemory(archive, "pptx");
    const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    plan.pages = slides.length;
    for (const slide of slides) {
      const relsName = slide.replace(/slides\/(slide\d+\.xml)$/u, "slides/_rels/$1.rels");
      const rels = archive.file(relsName);
      if (!rels) continue;
      const xml = await rels.async("string");
      plan.images += [...xml.matchAll(/Target="([^"]+)"/gu)].filter((match) => mediaTypeOf(match[1])).length;
    }
  } else if (format === "docx") {
    const archive = await JSZip.loadAsync(buffer);
    await assertArchiveFitsMemory(archive, "docx");
    plan.images = Object.keys(archive.files).filter((name) => name.startsWith("word/media/") && mediaTypeOf(name)).length;
  } else if (format === "xlsx") {
    const archive = await JSZip.loadAsync(buffer);
    await assertArchiveFitsMemory(archive, "xlsx");
    plan.pages = Object.keys(archive.files).filter((name) => /^xl\/worksheets\/.*\.xml$/u.test(name)).length || 1;
    plan.images = Object.keys(archive.files).filter((name) => name.startsWith("xl/media/") && mediaTypeOf(name)).length;
  }
  // 扫描页整页识图 + 内嵌/独立图片逐张识图，合起来就是视觉调用的上限。
  plan.estimatedVisionCalls = plan.scannedPages + plan.images;
  plan.estimatedSeconds = plan.estimatedVisionCalls * VISION_SECONDS_PER_CALL;
  // 小于 64px 的图标与矢量图解析时会跳过，数量上只能给个上限（"最多 N 次"）。
  plan.estimatedVisionCallsMax = plan.estimatedVisionCalls;
  return plan;
}

async function docxPages(buffer, { onScannedPage = null, budget = visionBudget(), vision = true } = {}) {
  const archive = await JSZip.loadAsync(buffer);
  await assertArchiveFitsMemory(archive, "docx");
  const documentFile = archive.file("word/document.xml");
  if (!documentFile) throw Object.assign(new Error("DOCX 中缺少正文内容"), { statusCode: 422 });
  const xml = await documentFile.async("string");
  const text = decodeXml(xml
    .replace(/<w:tab\b[^>]*\/>/gu, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gu, "\n")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<[^>]+>/gu, ""));
  // 插图、表格截图这类内容只在图片里，正文抽不到，所以内嵌图片一律送去识图。
  const images = await archiveImages(archive, Object.keys(archive.files).filter((name) => name.startsWith("word/media/") && mediaTypeOf(name)).sort());
  const imageText = await transcribeImages({ images, label: "文档里的图片", onScannedPage, budget, vision });
  return [{ page: null, text: joinPageText(text, imageText), origin: "text" }];
}

async function spreadsheetPages(buffer, { onScannedPage = null, budget = visionBudget(), vision = true } = {}) {
  await assertArchiveFitsMemory(await JSZip.loadAsync(buffer), "xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const pages = [];
  for (const worksheet of workbook.worksheets) {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let index = 1; index <= worksheet.columnCount; index += 1) {
        cells.push(spreadsheetCellText(row.getCell(index)));
      }
      const line = cells.join("\t").trimEnd();
      if (line.trim()) rows.push(line);
    });
    const images = [];
    for (const placed of worksheet.getImages?.() || []) {
      const media = workbook.getImage(placed.imageId);
      if (!media?.buffer) continue;
      images.push({
        key: `sheet:${worksheet.name}:${placed.imageId}:${placed.range?.tl?.nativeRow ?? ""}:${placed.range?.tl?.nativeCol ?? ""}`,
        name: media.name || "",
        mediaType: mediaTypeOf(media.extension || media.name || ""),
        buffer: Buffer.isBuffer(media.buffer) ? media.buffer : Buffer.from(media.buffer)
      });
    }
    // 贴图（产品截图、界面标注）里的信息正文完全没有，所以有图就识图。
    const imageText = await transcribeImages({ images, page: worksheet.name || null, label: `工作表「${worksheet.name || "Sheet"}」里的图片`, onScannedPage, budget, vision });
    const text = normalizeText(joinPageText(rows.join("\n"), imageText));
    if (text) pages.push({ page: worksheet.name || null, text, origin: "text" });
  }
  return pages;
}

/**
 * 单元格文本：不能直接用 ExcelJS 的 `cell.text`。
 *
 * 合并区域的从属单元格拿到的是 MergeValue，它的 `toString()` 会对 master 的值调用
 * `.toString()`；master 本身是空值时就是 `null.toString()` —— 实测上传
 * END3_CorelTrain_SCENARIO_ORDER.xlsx 时整份参考资料导入直接失败，报的就是
 * "Cannot read properties of null (reading 'toString')"。
 * 这里自己取原始值再格式化：数字 / 日期 / 富文本 / 公式结果 / 超链接各按需要拼。
 */
function spreadsheetCellText(cell) {
  const raw = cell?.value ?? null;
  // MergeValue 的内部形态：指向 master，取它的值即可（绝不调用 toString）。
  const value = raw && typeof raw === "object" && "_master" in raw ? raw.value : raw;
  return plainCellText(value).trim();
}

function plainCellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part) => String(part?.text ?? "")).join("");
  if (Array.isArray(value)) return value.map(plainCellText).join(" ");
  if (value.error) return String(value.error);
  if (Object.hasOwn(value, "result")) return plainCellText(value.result);
  // 超链接单元格是 { text, hyperlink }。
  if (Object.hasOwn(value, "text")) return plainCellText(value.text);
  if (Object.hasOwn(value, "hyperlink")) return String(value.hyperlink);
  return "";
}

/**
 * ppt/slides/_rels/slide1.xml.rels 里的 Target 相对 ppt/slides 解析，得到这一页引用的图片路径。
 */
function resolveZipPath(baseDirectory, target) {
  const stack = [];
  for (const part of `${baseDirectory}/${String(target || "").replace(/^\/+/u, "")}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

async function pptxSlideImages(archive, slideName, budget) {
  const relsName = slideName.replace(/slides\/(slide\d+\.xml)$/u, "slides/_rels/$1.rels");
  const relsFile = archive.file(relsName);
  if (!relsFile) return [];
  const xml = await relsFile.async("string");
  const names = [];
  for (const match of xml.matchAll(/Target="([^"]+)"/gu)) {
    const path = resolveZipPath("ppt/slides", match[1]);
    if (!mediaTypeOf(path) || budget.seen.has(path)) continue;
    names.push(path);
  }
  return archiveImages(archive, names);
}

/**
 * PPTX：每张幻灯片算一页，取 <a:t> 里的文字（形状、表格、备注文本框都在这套标签里）。
 * 幻灯片里的图片（截图、示意图）再交给模型识图，拼在该页正文后面。
 */
async function pptxPages(buffer, { onScannedPage = null, budget = visionBudget(), vision = true } = {}) {
  const archive = await JSZip.loadAsync(buffer);
  await assertArchiveFitsMemory(archive, "pptx");
  const slides = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => Number(left.match(/(\d+)/u)[1]) - Number(right.match(/(\d+)/u)[1]));
  if (!slides.length) throw Object.assign(new Error("PPTX 中找不到幻灯片"), { statusCode: 422 });
  const pages = [];
  for (const [index, name] of slides.entries()) {
    const xml = await archive.file(name).async("string");
    const text = normalizeText(decodeXml(xml
      .replace(/<a:br\b[^>]*\/>/gu, "\n")
      .replace(/<\/a:p>/gu, "\n")
      .replace(/<[^>]+>/gu, "")));
    const images = await pptxSlideImages(archive, name, budget);
    const imageText = await transcribeImages({ images, page: index + 1, label: `第 ${index + 1} 张幻灯片里的图片`, onScannedPage, budget, vision });
    const pageText = joinPageText(text, imageText);
    if (pageText) pages.push({ page: index + 1, text: pageText, origin: "text" });
  }
  return pages;
}

function csvPages(buffer) {
  const document = parseCsvDocument(buffer.toString("utf8"));
  const text = normalizeText(csvValues(document).map((row) => (Array.isArray(row) ? row.join("\t") : String(row ?? ""))).join("\n"));
  return text ? [{ page: null, text, origin: "text" }] : [];
}

/**
 * PDF 页面里画的图片对象（XObject）转成 PNG。
 *
 * pdfjs 给的是解码后的位图：kind 1 是 1bpp 灰度（位打包）、2 是 RGB、3 是 RGBA。
 * 认不出的形态返回 null，由调用方跳过——宁可不读，也不要拼出一张花屏图给模型。
 */
async function pngFromPdfImageObject(image) {
  const width = Number(image?.width) || 0;
  const height = Number(image?.height) || 0;
  const data = image?.data;
  if (!width || !height || !data) return null;
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const target = context.createImageData(width, height);
  const pixels = target.data;
  if (image.kind === 3) {
    pixels.set(data.subarray(0, width * height * 4));
  } else if (image.kind === 2) {
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 4] = data[index * 3];
      pixels[index * 4 + 1] = data[index * 3 + 1];
      pixels[index * 4 + 2] = data[index * 3 + 2];
      pixels[index * 4 + 3] = 255;
    }
  } else if (image.kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const value = bit ? 0 : 255;
        const offset = (y * width + x) * 4;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 255;
      }
    }
  } else {
    return null;
  }
  context.putImageData(target, 0, 0);
  return canvas.toBuffer("image/png");
}

/** 这一页画了哪些图片。扫描页整页渲染，有文字层的页面就按图片对象逐张取。 */
async function pdfPageImages(page) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const ops = await page.getOperatorList();
  const inline = [];
  const names = [];
  for (const [index, fn] of ops.fnArray.entries()) {
    const argument = ops.argsArray[index]?.[0];
    if (fn === pdfjs.OPS.paintInlineImageXObject && argument?.data) inline.push(argument);
    else if (fn === pdfjs.OPS.paintImageXObject && typeof argument === "string") names.push(argument);
  }
  const images = [];
  for (const [index, image] of inline.entries()) {
    const buffer = await pngFromPdfImageObject(image);
    if (buffer) images.push({ key: `inline:${page.pageNumber}:${index}`, name: `inline-${index}`, mediaType: "image/png", buffer });
  }
  for (const name of [...new Set(names)]) {
    // 图片对象已经跟着 getOperatorList 解码完，回调会立刻返回；万一没就绪也不能卡住导入。
    const object = await Promise.race([
      new Promise((resolve) => page.objs.get(name, resolve)),
      new Promise((resolve) => setTimeout(() => resolve(null), 5_000))
    ]);
    const buffer = await pngFromPdfImageObject(object);
    if (buffer) images.push({ key: `pdf:${page.pageNumber}:${name}`, name, mediaType: "image/png", buffer });
  }
  return images;
}

/**
 * PDF：先取文字层；抽不到文字的页面渲染成图片，交给调用方用模型识图。
 * `onScannedPage` 缺省时这类页面会被标记为需要识图但不阻塞其余页面。
 */
async function pdfPages(buffer, { onScannedPage = null, budget = visionBudget(), vision = true } = {}) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    let text = "";
    try {
      const content = await page.getTextContent();
      text = normalizeText(content.items.map((item) => String(item.str || "")).join(" "));
    } catch {
      text = "";
    }
    if ([...text].length >= SCANNED_PAGE_MIN_CHARS) {
      // 有文字层不等于没有图：正文旁边的截图、示意图只在图片里，也要读。
      let imageText = "";
      try {
        const images = await pdfPageImages(page);
        imageText = await transcribeImages({ images, page: pageNumber, label: `第 ${pageNumber} 页里的图片`, onScannedPage, budget, vision });
      } catch {
        imageText = "";
      }
      pages.push({ page: pageNumber, text: joinPageText(text, imageText), origin: "text" });
      continue;
    }
    // 没有识图能力（或用户选了只读文字）时标记成待识图，但不能让整份资料导入失败。
    if (typeof onScannedPage !== "function" || vision !== true) {
      if (typeof onScannedPage === "function") budget.skippedByUser += 1;
      else budget.pending += 1;
      pages.push({ page: pageNumber, text, origin: "text", needsVision: true });
      continue;
    }
    budget.used += 1;
    const recognized = normalizeText(await onScannedPage({
      page: pageNumber,
      label: `第 ${pageNumber} 页`,
      mediaType: "image/png",
      render: () => renderPdfPage(page)
    }));
    pages.push({ page: pageNumber, text: recognized, origin: "vision", needsVision: recognized === "" });
  }
  return pages;
}

/** 把一页 PDF 渲染成 PNG（base64），交给模型识图。 */
async function renderPdfPage(page) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, viewport }).promise;
  return canvas.toBuffer("image/png").toString("base64");
}

/**
 * 图片资料：单张图片就是一份资料，整张交给模型识图转录。
 * 用户自己传的图不做"图标太小"过滤——那是给文档内嵌装饰图用的。
 */
async function imagePages(buffer, mediaType, { onScannedPage = null, budget = visionBudget(), vision = true } = {}) {
  if (typeof onScannedPage !== "function" || vision !== true) {
    if (typeof onScannedPage === "function") budget.skippedByUser += 1;
    else budget.pending += 1;
    return [{ page: null, text: "", origin: "text", needsVision: true }];
  }
  budget.used += 1;
  const base64 = buffer.toString("base64");
  const text = normalizeText(await onScannedPage({ page: null, label: "这张图片", mediaType, render: async () => base64 }));
  return [{ page: null, text, origin: "vision", needsVision: text === "" }];
}

/**
 * 读文件内容：优先用调用方已经拿到的 Buffer，其次从磁盘读（大文件上传后落在 uploads/ 下），
 * 最后才是 base64（脚本与老接口）。
 */
async function readReferenceBytes({ base64 = "", buffer = null, path = "" } = {}) {
  if (buffer) return buffer;
  if (path) return await readFile(path);
  return decodeBase64(base64);
}

/** zip 条目的解压后大小（JSZip 从中央目录里读到的，不需要真的解压）。 */
function uncompressedSizeOf(entry) {
  return Number(entry?._data?.uncompressedSize) || 0;
}

/**
 * 解析前的内存护栏：docx/pptx 看整包解压后总量，xlsx 单独看工作表 XML 总量
 * （ExcelJS 会把整本工作簿建成对象树，比 zip 更吃内存）。
 */
async function assertArchiveFitsMemory(archive, format) {
  if (format === "xlsx") {
    const sheetBytes = Object.keys(archive.files)
      .filter((name) => /^xl\/worksheets\/.*\.xml$/u.test(name))
      .reduce((total, name) => total + uncompressedSizeOf(archive.file(name)), 0);
    if (sheetBytes > MAX_XLSX_XML_BYTES) {
      throw Object.assign(new Error(`这份表格解压后工作表约 ${Math.round(sheetBytes / 1024 / 1024)}MB，超过 ${Math.round(MAX_XLSX_XML_BYTES / 1024 / 1024)}MB 的解析上限；请拆分成多个文件再上传`), { statusCode: 413 });
    }
    return;
  }
  const totalBytes = Object.keys(archive.files).reduce((total, name) => total + uncompressedSizeOf(archive.file(name)), 0);
  if (totalBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw Object.assign(new Error(`这份文档解压后约 ${Math.round(totalBytes / 1024 / 1024)}MB，超过 ${Math.round(MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024)}MB 的解析上限；请拆分后再上传`), { statusCode: 413 });
  }
}

export function referenceFormatOf(filename) {
  const extension = extname(basename(String(filename || "").trim())).toLowerCase();
  if (!REFERENCE_FORMATS.includes(extension)) {
    throw Object.assign(new Error(`参考资料仅支持 ${REFERENCE_FORMATS.join("、")}`), { statusCode: 400 });
  }
  return extension.replace(/^\./u, "");
}

/**
 * 解析上传的参考资料。返回按"页/工作表"分组的分段文本；PDF 的扫描页由
 * `onScannedPage` 决定怎么识图，文档内嵌图片同理，测试里可以注入桩函数。
 */
export async function extractReferenceFile({ filename, base64 = "", buffer: rawBuffer = null, path = "", vision = true, onScannedPage = null } = {}) {
  const safeName = basename(String(filename || "").trim());
  const format = referenceFormatOf(safeName);
  // 原始字节 / 磁盘路径入口（浏览器直传的大文件）不用再过一遍 base64。
  const buffer = await readReferenceBytes({ base64, buffer: rawBuffer, path });
  if (!buffer.length) throw Object.assign(new Error("文件内容为空"), { statusCode: 400 });
  if (buffer.length > MAX_REFERENCE_FILE_BYTES) {
    throw Object.assign(new Error(`单个参考资料不能超过 ${Math.round(MAX_REFERENCE_FILE_BYTES / 1024 / 1024)}MB`), { statusCode: 400 });
  }
  const budget = visionBudget();
  let pages;
  if (format === "docx") pages = await docxPages(buffer, { onScannedPage, budget, vision });
  else if (format === "xlsx") pages = await spreadsheetPages(buffer, { onScannedPage, budget, vision });
  else if (format === "pptx") pages = await pptxPages(buffer, { onScannedPage, budget, vision });
  else if (format === "csv") pages = await csvPages(buffer);
  else if (format === "pdf") pages = await pdfPages(buffer, { onScannedPage, budget, vision });
  else if (IMAGE_MEDIA_TYPES.has(format)) pages = await imagePages(buffer, IMAGE_MEDIA_TYPES.get(format), { onScannedPage, budget, vision });
  else pages = [{ page: null, text: normalizeText(buffer.toString("utf8")), origin: "text" }];
  pages = pages.filter((page) => page && (String(page.text || "").trim() || page.needsVision));
  return {
    name: safeName.replace(/\.[^.]+$/u, ""),
    format,
    bytes: buffer.length,
    pages,
    characters: pages.reduce((total, page) => total + [...String(page.text || "")].length, 0),
    recognizedPages: pages.filter((page) => page.origin === "vision").length,
    pendingPages: pages.filter((page) => page.needsVision === true).length,
    // 识图统计：读了几张、跳了几张（太小/矢量图）、用户选择不读几张，都要能看见。
    visionImages: budget.embedded,
    skippedImages: budget.skipped,
    pendingImages: budget.pending,
    visionSkippedByUser: budget.skippedByUser
  };
}

const HEADING_PATTERN = /^(?:#{1,6}\s+.+|第[0-9一二三四五六七八九十百]+[章节幕场][^\n]{0,30}|[【\[].{1,40}[】\]])$/u;

function isHeading(line) {
  const text = String(line || "").trim();
  if (!text || [...text].length > 40) return false;
  return HEADING_PATTERN.test(text);
}

/**
 * 按标题与段落切块。长段落按目标字数硬切，块之间保留一段重叠，
 * 避免答案正好落在切口上。
 */
export function chunkReferencePages(pages = [], { targetChars = CHUNK_TARGET_CHARS, overlapChars = CHUNK_OVERLAP_CHARS, maxChunks = MAX_CHUNKS_PER_DOCUMENT } = {}) {
  const chunks = [];
  let heading = "";
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageLabel = page?.page == null ? "" : String(page.page);
    const blocks = String(page?.text || "").split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length && isHeading(lines[0])) heading = lines[0].replace(/^#+\s*/u, "").trim();
      const body = (lines.length && isHeading(lines[0]) ? lines.slice(1) : lines).join("\n").trim();
      if (!body) continue;
      const pieces = [...body].length <= targetChars
        ? [body]
        : spliceLongText(body, targetChars, overlapChars);
      for (const piece of pieces) {
        if (!piece.trim()) continue;
        if (chunks.length >= maxChunks) return chunks;
        chunks.push({
          ordinal: chunks.length,
          heading,
          text: piece.trim(),
          page: pageLabel,
          origin: page?.origin === "vision" ? "vision" : "text"
        });
      }
    }
  }
  return chunks;
}

function spliceLongText(text, targetChars, overlapChars) {
  const characters = [...text];
  const pieces = [];
  const step = Math.max(1, targetChars - overlapChars);
  for (let start = 0; start < characters.length; start += step) {
    const piece = characters.slice(start, start + targetChars).join("").trim();
    if (piece) pieces.push(piece);
    if (start + targetChars >= characters.length) break;
  }
  return pieces;
}

/** 参考资料同样是不可信输入：命中注入特征就默认不参与检索。 */
export function scanReferenceRisk(text) {
  return hasInjectionSignature(text);
}

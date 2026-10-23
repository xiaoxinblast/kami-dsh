import { extname, basename } from "node:path";
import JSZip from "jszip";
import { runtimeOptions } from "./runtime-context.mjs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_GUIDE_CHARACTERS = 50_000;

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

function normalizeGuideText(value) {
  return String(value || "")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

async function docxText(buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const document = archive.file("word/document.xml");
  if (!document) throw Object.assign(new Error("DOCX 中缺少正文内容"), { statusCode: 422 });
  const xml = await document.async("string");
  return decodeXml(xml
    .replace(/<w:tab\b[^>]*\/>/gu, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gu, "\n")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<[^>]+>/gu, ""));
}

export async function extractStyleGuideFile({ filename, base64, buffer: bytes } = {}) {
  const safeFilename = basename(String(filename || "").trim());
  const extension = extname(safeFilename).toLowerCase();
  if (![".txt", ".md", ".docx"].includes(extension)) {
    throw Object.assign(new Error("风格指南仅支持 .txt、.md、.docx"), { statusCode: 400 });
  }
  const encoded = String(base64 || "").replace(/^data:[^;]+;base64,/u, "");
  const buffer = bytes ? Buffer.from(bytes) : Buffer.from(encoded, "base64");
  if (!buffer.length) throw Object.assign(new Error("风格指南文件为空"), { statusCode: 400 });
  if (!runtimeOptions().embedded && buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error("风格指南不能超过 5MB"), { statusCode: 413 });
  const text = normalizeGuideText(extension === ".docx" ? await docxText(buffer) : buffer.toString("utf8"));
  if (!text) throw Object.assign(new Error("风格指南没有可读取的正文"), { statusCode: 422 });
  if (!runtimeOptions().embedded && [...text].length > MAX_GUIDE_CHARACTERS) throw Object.assign(new Error(`风格指南正文不能超过 ${MAX_GUIDE_CHARACTERS} 字`), { statusCode: 413 });
  return {
    filename: safeFilename,
    name: safeFilename.slice(0, -extension.length) || "导入风格指南",
    text,
    characters: [...text].length
  };
}

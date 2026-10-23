import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/**
 * 批次的原文件存档。
 *
 * 上传待译文件时把它按批次存到 data/uploads/<batchId><ext>，批次记录里只存相对路径。
 * 这样"导出写回"随时可用（刷新页面、换一台机器打开任务中心都不需要重新选原文件），
 * 也避免把 32MB 的 base64 塞进 Directus 的文本字段。
 */
export const ORIGINAL_UPLOAD_DIRECTORY = "uploads";
const ALLOWED_EXTENSIONS = new Set([".docx", ".xlsx", ".csv", ".xliff", ".mqxliff", ".txt", ".md"]);
const MAX_BYTES = 32 * 1024 * 1024;
const isArchivedPath = (path) => /^(?:uploads\/|runtime\/workspace-snapshots\/)/u.test(path) && !path.includes("..") && !path.includes("\\");

function safeExtension(filename) {
  const extension = extname(String(filename || "")).toLowerCase();
  return ALLOWED_EXTENSIONS.has(extension) ? extension : "";
}

/** 相对路径（存在批次 runnerOptions.originalFile 里）。 */
export function originalRelativePath(batchId, filename) {
  const id = String(batchId || "").trim();
  if (!id) throw new Error("缺少批次 ID，无法保存原文件");
  return `${ORIGINAL_UPLOAD_DIRECTORY}/${id}${safeExtension(filename)}`;
}

export async function saveBatchOriginal({ dataRoot, batchId, filename, buffer }) {
  if (!dataRoot) throw new Error("缺少数据目录，无法保存原文件");
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!bytes.length) throw new Error("原文件内容为空");
  if (bytes.length > MAX_BYTES) throw new Error(`原文件超过 ${Math.round(MAX_BYTES / (1024 * 1024))}MB`);
  const relative = originalRelativePath(batchId, filename);
  const absolute = join(dataRoot, relative);
  await mkdir(join(dataRoot, ORIGINAL_UPLOAD_DIRECTORY), { recursive: true });
  await writeFile(absolute, bytes);
  return { relative, bytes: bytes.length };
}

export async function readBatchOriginal({ dataRoot, relativePath }) {
  const relative = String(relativePath || "").trim();
  if (!dataRoot || !relative) return null;
  // 只允许读 uploads/ 下的存档，避免被路径穿越读到别的文件。
  if (!isArchivedPath(relative)) return null;
  try {
    const absolute = join(dataRoot, relative);
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    return await readFile(absolute);
  } catch {
    return null;
  }
}

export async function deleteBatchOriginal({ dataRoot, relativePath }) {
  const relative = String(relativePath || "").trim();
  if (!dataRoot || !isArchivedPath(relative)) return false;
  try {
    await unlink(join(dataRoot, relative));
    return true;
  } catch {
    return false;
  }
}

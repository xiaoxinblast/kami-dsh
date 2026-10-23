/**
 * 参考资料上下文：索引、预算与工具运行器的共用装配。
 *
 * 生产翻译、Auto QA 与技能评测都走这里，避免"评测时的检索和生产不一样"。
 * 索引按项目缓存；评测传入 onlyChunkIds 时只允许考试允许的片段进入检索。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createReferenceIndex } from "./reference-index.mjs";
import { createReferenceToolRunner } from "./reference-tools.mjs";
import { taskResources } from "./workspace-resources.mjs";
import { DATA_ROOT, getResourceLibraries, listReferenceChunks, listReferenceChunksForProject, listReferenceDocuments } from "./store.mjs";

/** 与技能策略模板保持一致的出厂值。 */
export const REFERENCE_FACTORY_DEFAULTS = Object.freeze({
  enabled: true,
  limit: 4,
  maxResults: 4,
  maxCalls: 3,
  maxRounds: 2,
  maxCharsPerCall: 2_400,
  maxCharsTotal: 6_000
});

/** 组装检索索引：只加载启用资料库里的可用资料。 */
export function createProjectReferenceIndex() {
  return createReferenceIndex({
    cacheKey: (projectId) => `${projectId}\0${taskResources(projectId)?.workspace || ""}\0${(taskResources(projectId)?.resources || []).filter((item) => item.purpose === "reference").map((item) => `${item.path}:${item.hash}`).join("\0")}`,
    loader: async (projectId) => {
      const { items: documents } = await listReferenceDocuments({ projectId, limit: 200 });
      const libraries = await getResourceLibraries(projectId).catch(() => []);
      const fingerprint = referenceDocumentsFingerprint(documents, libraries);
      const snapshotPath = referenceSnapshotPath(projectId);
      const cached = await readReferenceSnapshot(snapshotPath, fingerprint).catch(() => null);
      if (cached) return [...cached, ...(taskResources(projectId)?.referenceChunks || [])];
      const documentById = new Map(documents.map((document) => [document.id, document]));
      const libraryEnabled = new Map(libraries.map((library) => [library.id, library.enabled !== false]));
      const chunks = await listReferenceChunksForProject(projectId, { limit: 5_000 });
      const items = chunks.map((chunk) => {
        const document = documentById.get(chunk.documentId);
        return {
          id: chunk.id,
          documentId: chunk.documentId,
          documentName: document?.name || "",
          documentStatus: document?.status || "ready",
          // 资料描述（AI 扫描生成的"这份文件是干嘛的"）：模型先看它决定读不读全文。
          documentDescription: document?.ingestReport?.description || "",
          libraryId: document?.libraryId || "",
          libraryEnabled: document?.libraryId ? libraryEnabled.get(document.libraryId) !== false : true,
          ordinal: chunk.ordinal,
          heading: chunk.heading,
          page: chunk.page,
          origin: chunk.origin,
          text: chunk.text,
          risk: chunk.risk,
          allowed: chunk.allowed,
          embedding: chunk.embedding
        };
      });
      // 失败不影响本次检索：下次重启最多再走一遍 Directus。
      await writeReferenceSnapshot(snapshotPath, fingerprint, items).catch(() => {});
      return [...items, ...(taskResources(projectId)?.referenceChunks || [])];
    }
  });
}

/**
 * 参考资料索引的磁盘快照。
 *
 * 5 页 × 1,000 条 × 带 embedding 的冷加载很重；进程重启后只要资料文档和库开关
 * 没变，就可以直接读磁盘。指纹含文档 id/updatedAt/chunkCount 与库 enabled，
 * 资料上传/删除会改变指纹；TTL 兜底绕过工作台直接改库的情况。
 */
export const REFERENCE_SNAPSHOT_TTL_MS = 10 * 60_000;

export function referenceDocumentsFingerprint(documents = [], libraries = []) {
  const documentPart = (Array.isArray(documents) ? documents : [])
    .map((document) => [document.id || "", document.updatedAt || "", document.chunkCount || 0])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const libraryPart = (Array.isArray(libraries) ? libraries : [])
    .map((library) => [library.id || "", library.enabled !== false])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return createHash("sha256").update(JSON.stringify([documentPart, libraryPart])).digest("hex");
}

export function referenceSnapshotPath(projectId) {
  const safe = String(projectId || "global").replace(/[^a-zA-Z0-9_-]/gu, "_");
  return join(DATA_ROOT, "runtime", "reference-index", `${safe}.json`);
}

export async function readReferenceSnapshot(path, fingerprint, { now = Date.now(), ttlMs = REFERENCE_SNAPSHOT_TTL_MS } = {}) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (parsed?.fingerprint !== fingerprint) return null;
  if (!Array.isArray(parsed.items)) return null;
  if (!Number.isFinite(parsed.at) || now - parsed.at >= ttlMs) return null;
  return parsed.items;
}

export async function writeReferenceSnapshot(path, fingerprint, items) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ fingerprint, at: Date.now(), items }), "utf8");
  await rename(temporary, path);
}

/** 参数设置给预算，技能里的值偏离出厂值时以技能为准。 */
export function referenceBudgetFrom(settings = {}, skill = null) {
  const factory = REFERENCE_FACTORY_DEFAULTS;
  const budget = {
    enabled: settings.enabled !== false,
    maxResults: Number(settings.maxResults) || factory.maxResults,
    maxCalls: Number(settings.maxCalls) || factory.maxCalls,
    maxRounds: Number(settings.maxRounds) || factory.maxRounds,
    maxCharsPerCall: Number(settings.maxCharsPerCall) || factory.maxCharsPerCall,
    maxCharsTotal: Number(settings.maxCharsTotal) || factory.maxCharsTotal
  };
  const fromSkill = skill?.strategy?.retrieval?.referenceMaterials;
  if (fromSkill && (fromSkill.enabled !== factory.enabled || Number(fromSkill.limit) !== factory.limit)) {
    budget.enabled = fromSkill.enabled !== false;
    const limit = Number(fromSkill.limit);
    if (Number.isFinite(limit) && limit > 0) budget.maxResults = Math.min(10, Math.max(1, Math.trunc(limit)));
  }
  return budget;
}

/**
 * @param onlyChunkIds 评测隔离用：只允许这些片段参与检索（null 表示不限制）
 */
export function buildReferenceToolRunner({ index, projectId = "", settings = {}, skill = null, onActivity = null, onlyChunkIds = null } = {}) {
  const budget = referenceBudgetFrom(settings, skill);
  if (!projectId || !budget.enabled) return null;
  const runner = createReferenceToolRunner({
    index,
    listChunks: async (documentId) => documentId.startsWith("workspace:")
      ? (taskResources(projectId)?.referenceChunks || []).filter((chunk) => chunk.documentId === documentId)
      : (await listReferenceChunks({ documentId, limit: 200 })).items,
    budget,
    onActivity
  });
  return {
    tools: runner.tools,
    maxRounds: budget.maxRounds,
    execute: (call) => runner.execute({ ...call, projectId, onlyChunkIds }),
    refs: () => runner.refs
  };
}

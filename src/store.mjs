import { summarizeBatchSegments } from "../public/batch-status.js";
import { runtimeOptions } from "./runtime-context.mjs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertLocale, LOCALES } from "./config.mjs";
import { embedSource, embeddingModelName } from "./embedding.mjs";
import { createDefaultProjectSettings, sanitizeProjectSettings } from "./project-config.mjs";
import { memoryMatchAttempts, normalizeMemoryText, styleEvidenceMatch } from "./translation-memory.mjs";
import { DEFAULT_CANDIDATE_POOL, buildMemoryIndex, removeMemoryRow, selectMemoryCandidates, upsertMemoryRow } from "./memory-index.mjs";
import { EVIDENCE_PAGE_SIZE, EVIDENCE_SCAN_BUDGET, collectEvidencePages, stratifyEvidenceSample } from "./evidence-sample.mjs";
import { scopeFallbackChain, scopeRankOf } from "./scope-fallback.mjs";
import { summarizeQualityTiers } from "./quality-tier.mjs";
import {
  deleteDirectusAsset,
  deleteDirectusLibraryEntries,
  deleteDirectusMemory,
  countDirectusStyleEvidenceByScope,
  countDirectusStyleEvidence,
  getDirectusAsset,
  getDirectusAssets,
  getDirectusAssetStats,
  getDirectusLibraryStats,
  getDirectusStyleLearningRun,
  listDirectusLibraryFiles,
  listDirectusLibraryEntries,
  updateDirectusMemory,
  getDirectusMetadata,
  getDirectusMemories,
  countDirectusMemories,
  getDirectusQaCases,
  findDirectusQaCase,
  getDirectusStyleProfile,
  getDirectusProjectStyleProfile,
  getDirectusStyleEvidence,
  listDirectusStyleEvidencePage,
  countDirectusStyleEvidenceByFile,
  listDirectusStyleEvidenceFiles,
  getDirectusQaRuns,
  getDirectusUserProfile,
  saveDirectusUserProfile,
  listDirectusStyleProfiles,
  activateDirectusStyleProfile,
  rejectDirectusStyleProfile,
  listDirectusPendingQaCases,
  disposeDirectusQaCase,
  initializeDirectusStore,
  completeDirectusImport,
  rebuildDirectusEmbeddings,
  demoteDirectusMemories,
  approveDirectusQaCase,
  saveDirectusBatchRun,
  getDirectusBatchRun,
  listDirectusBatchRuns,
  saveDirectusQaTask,
  getDirectusQaTask,
  listDirectusQaTasks,
  deleteDirectusQaTask,
  saveDirectusBackgroundTask,
  getDirectusBackgroundTask,
  listDirectusBackgroundTasks,
  deleteDirectusBackgroundTask,
  saveDirectusMemory,
  saveDirectusMemories,
  listDirectusMemoryIndexRows,
  getDirectusMemoriesByIds,
  saveDirectusQaCase,
  saveDirectusQaRun,
  saveDirectusAsset,
  saveDirectusCorpus,
  saveDirectusImportPreview,
  saveDirectusTmImportAudit,
  getDirectusImportPreview,
  persistDirectusImportCleaning,
  deleteDirectusBatchRun,
  saveDirectusStyleEvidence,
  loadDirectusStyleEvidenceIndex,
  saveDirectusStyleEvidences,
  saveDirectusStyleProfileEvaluation,
  updateDirectusStyleProfileRules,
  findDirectusStyleProfile,
  saveDirectusStyleLearningRun,
  getDirectusStyleLearningRuns,
  saveDirectusStyleProfile,
  saveDirectusLearningTrajectory,
  listDirectusLearningTrajectories,
  countDirectusLearningTrajectoriesByScope,
  countDirectusLearningTrajectoriesByFile,
  getDirectusLearningTrajectory,
  updateDirectusLearningTrajectory,
  saveDirectusTranslationSkill,
  listDirectusTranslationSkills,
  getDirectusTranslationSkill,
  updateDirectusTranslationSkill,
  activateDirectusTranslationSkill,
  rollbackDirectusTranslationSkill,
  saveDirectusSkillEvaluation,
  listDirectusSkillEvaluations,
  saveDirectusReferenceDocument,
  getDirectusReferenceDocument,
  listDirectusReferenceDocuments,
  updateDirectusReferenceDocument,
  deleteDirectusReferenceDocument,
  saveDirectusReferenceFolder,
  getDirectusReferenceFolder,
  listDirectusReferenceFolders,
  deleteDirectusReferenceFolder,
  replaceDirectusReferenceChunks,
  listDirectusReferenceChunks,
  listDirectusReferenceChunksForProject,
  updateDirectusReferenceChunk,
  getDirectusSkillEvaluation,
  updateDirectusSkillEvaluation,
  saveDirectusQualityAsset,
  listDirectusQualityAssets,
  getDirectusQualityAsset,
  updateDirectusQualityAsset,
  saveDirectusQualityRun,
  listDirectusQualityRuns,
  updateDirectusQualityRun,
  saveDirectusTrainingRun,
  listDirectusTrainingRuns,
  getDirectusTrainingRun
  ,getDirectusProjects
  ,getDirectusProject
  ,saveDirectusProject
  ,archiveDirectusProject
  ,purgeDirectusProject
  ,getDirectusResourceLibraries
  ,saveDirectusResourceLibrary
  ,deleteDirectusResourceLibrary
  ,deleteDirectusTranslationSkill
  ,deleteDirectusStyleProfile
  ,deleteDirectusUserProfile
  ,saveDirectusAssets
} from "./directus-store.mjs";

const ROOT = runtimeOptions().dataDirectory || process.env.KAMI_DATA_DIR || fileURLToPath(new URL("../data", import.meta.url));

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const jsonFileLocks = new Map();

async function withJsonFileLock(path, operation) {
  const previous = jsonFileLocks.get(path) || Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  jsonFileLocks.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (jsonFileLocks.get(path) === tail) jsonFileLocks.delete(path);
  }
}

function assetPath(locale) {
  assertLocale(locale);
  return join(ROOT, "assets", `${locale}.json`);
}

async function initializeJsonStore() {
  await mkdir(join(ROOT, "assets"), { recursive: true });
  await mkdir(join(ROOT, "corpora"), { recursive: true });
  await mkdir(join(ROOT, "memories"), { recursive: true });
  await mkdir(join(ROOT, "styles"), { recursive: true });
  await mkdir(join(ROOT, "qa"), { recursive: true });
  await mkdir(join(ROOT, "batches"), { recursive: true });
  await mkdir(join(ROOT, "learning"), { recursive: true });
  await mkdir(join(ROOT, "projects"), { recursive: true });
  for (const locale of Object.keys(LOCALES)) {
    const path = assetPath(locale);
    const current = await readJson(path, null);
    if (!current) {
      await writeJsonAtomic(path, { locale, revision: 1, terms: [], memories: [], styleExamples: [] });
    }
  }
}

function projectPath(id) {
  return join(ROOT, "projects", `${String(id)}.json`);
}

function resourceLibraryPath(projectId) {
  return join(ROOT, "projects", `${String(projectId)}-libraries.json`);
}

async function getJsonProjects({ status = "active", limit = 100 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "projects")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const records = [];
  for (const file of files.filter((name) => name.endsWith(".json") && !name.endsWith("-libraries.json"))) {
    const item = await readJson(join(ROOT, "projects", file), null);
    if (item && (!status || item.status === status)) records.push(item);
  }
  return records.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, Math.max(1, Number(limit) || 100));
}

async function getJsonProject(id) {
  return readJson(projectPath(id), null);
}

async function saveJsonProject(input = {}) {
  const id = String(input.id || randomUUID());
  const existing = await getJsonProject(id);
  const name = String(input.name || existing?.name || "").trim();
  if (!name) throw new Error("项目名称不能为空");
  const now = new Date().toISOString();
  const project = {
    id,
    name,
    description: String(input.description ?? existing?.description ?? "").trim(),
    status: String(input.status ?? existing?.status ?? "active"),
    settings: sanitizeProjectSettings(input.settings ?? existing?.settings ?? createDefaultProjectSettings()),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await writeJsonAtomic(projectPath(id), project);
  return project;
}

async function archiveJsonProject(id) {
  const existing = await getJsonProject(id);
  if (!existing) return null;
  return saveJsonProject({ ...existing, status: "archived" });
}

async function listJsonFiles(directory) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

function belongsToProject(value, projectId) {
  if (!value || typeof value !== "object") return false;
  return [value.projectId, value.project_id, value.project].some((item) => String(item || "") === String(projectId));
}

async function purgeJsonProject(id) {
  const project = await getJsonProject(id);
  if (!project) return null;
  let total = 0;
  for (const directory of ["assets", "memories", "styles", "qa", "batches", "qa-tasks", "background-tasks", "corpora", "learning", "references"]) {
    for (const file of await listJsonFiles(join(ROOT, directory))) {
      let data;
      try { data = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
      if (Array.isArray(data)) {
        const next = data.filter((item) => !belongsToProject(item, id));
        if (next.length !== data.length) {
          await writeJsonAtomic(file, next);
          total += data.length - next.length;
        }
        continue;
      }
      if (!data || typeof data !== "object") continue;
      if (belongsToProject(data, id)) {
        await rm(file, { force: true });
        total += 1;
        continue;
      }
      let removed = 0;
      for (const key of Object.keys(data)) {
        if (!Array.isArray(data[key])) continue;
        const next = data[key].filter((item) => !belongsToProject(item, id));
        removed += data[key].length - next.length;
        data[key] = next;
      }
      if (removed) {
        data.revision = (Number(data.revision) || 0) + 1;
        await writeJsonAtomic(file, data);
        total += removed;
      }
    }
  }
  await rm(projectPath(id), { force: true });
  await rm(resourceLibraryPath(id), { force: true });
  return { project, total };
}

async function getJsonResourceLibraries(projectId, { kind = "", limit = 500 } = {}) {
  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) return [];
  const items = await readJson(resourceLibraryPath(normalizedProjectId), []);
  return items.filter((item) => item.projectId === normalizedProjectId && (!kind || item.kind === kind))
    .sort((a, b) => Number(a.priority) - Number(b.priority) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(0, Math.max(1, Number(limit) || 500));
}

async function saveJsonResourceLibrary(input = {}) {
  const projectId = String(input.projectId || "").trim();
  const name = String(input.name || "").trim();
  if (!projectId || !name) throw new Error("资源库必须绑定项目并填写名称");
  const path = resourceLibraryPath(projectId);
  const items = await readJson(path, []);
  const id = String(input.id || randomUUID());
  const existing = items.find((item) => item.id === id);
  const now = new Date().toISOString();
  const kind = ["term_base", "translation_memory"].includes(input.kind) ? input.kind : "term_base";
  const role = kind === "translation_memory" && ["master", "working", "reference"].includes(input.role) ? input.role : "reference";
  const record = {
    id,
    projectId,
    name,
    kind,
    role,
    enabled: input.enabled !== false,
    priority: Math.max(1, Math.min(9999, Number(input.priority) || 100)),
    description: String(input.description || "").trim(),
    entryCount: Math.max(0, Number(input.entryCount) || 0),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (record.kind === "translation_memory" && record.enabled && ["master", "working"].includes(record.role)) {
    const duplicate = items.find((item) => item.id !== id && item.kind === record.kind && item.role === record.role && item.enabled !== false);
    if (duplicate) {
      throw new Error(record.role === "master" ? "一个项目只能启用一个主 TM" : "一个项目只能启用一个工作 TM");
    }
  }
  if (existing) items[items.indexOf(existing)] = record;
  else items.unshift(record);
  await writeJsonAtomic(path, items);
  return record;
}

async function deleteJsonResourceLibrary(projectId, libraryId) {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedLibraryId = String(libraryId || "").trim();
  if (!normalizedProjectId || !normalizedLibraryId) return false;
  const path = resourceLibraryPath(normalizedProjectId);
  const items = await readJson(path, []);
  const target = items.find((item) => item.id === normalizedLibraryId);
  if (!target) return false;
  if (target.role === "master" || target.role === "working") throw new Error("主 TM 和工作 TM 不能删除，请先停用或改为参考 TM");
  const next = items.filter((item) => item.id !== normalizedLibraryId);
  await writeJsonAtomic(path, next);
  return true;
}

async function getJsonMemories(locale, options = {}) {
  assertLocale(locale);
  const items = await readJson(join(ROOT, "memories", `${locale}.json`), []);
  const projectId = String(options.projectId || "").trim();
  const matched = items.filter((item) =>
    (!projectId || item.projectId === projectId)
    && (!String(options.search || "").trim() || [item.source, item.target].some((value) => String(value || "").toLowerCase().includes(String(options.search).trim().toLowerCase())))
  ).map((item) => (options.scopeFallback
    ? { ...item, scopeRank: scopeRankOf(item, { contentType: options.contentType || "general", domain: options.domain || "general" }) }
    : item));
  // 与 Directus 实现保持同一口径：最新在前，支持 offset/limit 分页（limit<=0 表示全量）。
  const sorted = [...matched].sort((left, right) => String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || "")));
  const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0);
  const limit = Number(options.limit) > 0 ? Math.min(1_000, Number(options.limit)) : sorted.length;
  return offset || limit < sorted.length ? sorted.slice(offset, offset + limit) : sorted;
}

/** 候选索引用的精简行（JSON 存储）：与 Directus 版同一口径。 */
async function listJsonMemoryIndexRows(locale, { projectId = "" } = {}) {
  assertLocale(locale);
  const items = await readJson(join(ROOT, "memories", `${locale}.json`), []);
  const wanted = String(projectId || "").trim();
  return items
    .filter((item) => !wanted || String(item.projectId || "").trim() === wanted)
    .map((item) => ({
      id: item.id,
      source: item.source || "",
      libraryId: item.libraryId || "",
      qualityStatus: item.qualityStatus || "provisional",
      projectId: item.projectId || ""
    }));
}

/** 按 id 取回候选行（JSON 存储）。 */
async function getJsonMemoriesByIds(locale, ids = [], options = {}) {
  assertLocale(locale);
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean));
  if (!wanted.size) return [];
  const items = await readJson(join(ROOT, "memories", `${locale}.json`), []);
  return items
    .filter((item) => wanted.has(String(item.id || "")))
    .map((item) => (options.scopeFallback
      ? { ...item, scopeRank: scopeRankOf(item, { contentType: options.contentType || "general", domain: options.domain || "general" }) }
      : item));
}

async function countJsonMemories(locale, options = {}) {
  return (await getJsonMemories(locale, { ...options, offset: 0, limit: 0 })).length;
}

async function saveJsonMemory(locale, input) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const items = await readJson(path, []);
  const source = String(input.source || "").trim();
  const target = String(input.target || "").trim();
  const embedding = input.embedding ?? await embedSource(source);
  const projectId = String(input.projectId || "").trim();
  const scoped = items.filter((item) => String(item.projectId || "").trim() === projectId);
  let existing = null;
  for (const attempt of memoryMatchAttempts({ ...input, source, target })) {
    existing = attempt.kind === "entry"
      // 同 ID 还要同原文（按归一化判等）：memoQ 的 context ID 会在多个文件之间重复。
      ? scoped.find((item) => String(item.entryKey || "").trim() === attempt.entryKey
        && normalizeMemoryText(item.source) === normalizeMemoryText(attempt.source))
      : scoped.find((item) => normalizeMemoryText(item.source) === normalizeMemoryText(attempt.source)
        && normalizeMemoryText(item.target) === normalizeMemoryText(attempt.target));
    if (existing) break;
  }
  const item = { id: existing?.id || randomUUID(), ...existing, ...input, locale, source, target, ...(embedding ? { embedding } : {}), updatedAt: new Date().toISOString(), createdAt: existing?.createdAt || new Date().toISOString() };
  if (existing) items[items.indexOf(existing)] = item;
  else items.unshift(item);
  await writeJsonAtomic(path, items);
  return item;
}

/**
 * 批量写入翻译记忆（JSON 存储）。逐条写要反复读整份文件再整份写回，
 * 一次导入几万条时是平方级开销；这里只在开头读一次、结尾写一次。
 */
async function saveJsonMemories(locale, inputs = []) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const results = new Array(inputs.length).fill(null);
  if (!inputs.length) return results;
  const items = await readJson(path, []);
  const sourceOf = (value) => normalizeMemoryText(value);
  const findExisting = (input, source, target) => {
    const projectId = String(input.projectId || "").trim();
    const scoped = items.filter((item) => String(item.projectId || "").trim() === projectId);
    for (const attempt of memoryMatchAttempts({ ...input, source, target })) {
      const hit = attempt.kind === "entry"
        ? scoped.find((item) => String(item.entryKey || "").trim() === attempt.entryKey
          && sourceOf(item.source) === sourceOf(attempt.source))
        : scoped.find((item) => sourceOf(item.source) === sourceOf(attempt.source)
          && sourceOf(item.target) === sourceOf(attempt.target));
      if (hit) return hit;
    }
    return null;
  };
  for (const [index, input] of inputs.entries()) {
    const source = String(input.source || "").trim();
    const target = String(input.target || "").trim();
    if (!source || !target) {
      results[index] = { error: "翻译记忆的日语原文和简体中文译文不能为空" };
      continue;
    }
    const embedding = input.embedding ?? await embedSource(source);
    const existing = findExisting(input, source, target);
    const item = {
      id: existing?.id || randomUUID(),
      ...existing,
      ...input,
      locale,
      source,
      target,
      ...(embedding ? { embedding } : {}),
      updatedAt: new Date().toISOString(),
      createdAt: existing?.createdAt || new Date().toISOString()
    };
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    results[index] = { id: item.id, locale, source, target, qualityStatus: item.qualityStatus, qaScore: Number(item.qaScore) || 0 };
  }
  await writeJsonAtomic(path, items);
  return results;
}

async function getJsonStyleProfile(locale, contentType, domain = "general", { projectId = "", scopeFallback = false } = {}) {
  const profiles = await readJson(join(ROOT, "styles", `${assertLocale(locale)}.json`), []);
  if (scopeFallback) {
    // 与 Directus 实现同一套降级链：按链位挑第一份命中的规范。
    const scoped = profiles.filter((item) => item.status === "active" && String(item.projectId || "") === String(projectId || "")).sort((a, b) => b.version - a.version);
    for (const entry of scopeFallbackChain(contentType, domain)) {
      const hit = scoped.find((item) => (item.contentType || "general") === entry.contentType && (item.domain || "general") === entry.domain);
      if (hit) return { ...hit, scopeRank: entry.rank };
    }
    return null;
  }
  const candidates = profiles.filter((item) => item.status === "active" && item.contentType === contentType && String(item.projectId || "") === String(projectId || "")).sort((a, b) => b.version - a.version);
  return candidates.find((item) => item.domain === domain) || candidates.find((item) => item.domain === "general") || candidates[0] || null;
}

/** JSON 存储下的风格证据来源文件统计（与 Directus 口径一致：按来源文件计数）。 */
async function countJsonStyleEvidenceByFile(locale, { projectId = "" } = {}) {
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  const counts = new Map();
  for (const item of items) {
    if (item.locale !== assertLocale(locale)) continue;
    if (projectId && item.projectId !== projectId) continue;
    const name = String(item.sourceFile || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

/** JSON 存储下按证据 id 取来源文件。 */
async function listJsonStyleEvidenceFiles(locale, { ids = [] } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean));
  if (!wanted.size) return [];
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale) && wanted.has(String(item.id || "")))
    .map((item) => ({ id: String(item.id || ""), sourceFile: String(item.sourceFile || "").trim() }));
}

export async function countStyleEvidenceFiles(locale, options) {
  return usesDirectus() ? countDirectusStyleEvidenceByFile(locale, options) : countJsonStyleEvidenceByFile(locale, options);
}

export async function listStyleEvidenceFiles(locale, options) {
  return usesDirectus() ? listDirectusStyleEvidenceFiles(locale, options) : listJsonStyleEvidenceFiles(locale, options);
}

async function getJsonStyleEvidence(locale, options = {}) {
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale)
      && (options.exactScope
        ? (!options.contentType || item.contentType === options.contentType) && (!options.domain || item.domain === options.domain)
        : (!options.contentType || options.contentType === "general" || item.contentType === options.contentType || item.contentType === "general")
          && (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general"))
      && (!options.batchId || item.batchId === options.batchId)
      && (!options.projectId || item.projectId === options.projectId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, options.limit || 1_000);
}

async function getJsonQaRuns(locale, options = {}) {
  const items = await readJson(join(ROOT, "qa", "runs.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale)
      && (!options.projectId || item.projectId === options.projectId)
      && (!options.batchId || item.batchId === options.batchId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, options.limit || 100);
}

async function getJsonUserProfile(locale, { projectId = "" } = {}) {
  const profiles = await readJson(join(ROOT, "styles", "profiles.json"), []);
  const scope = String(projectId || "");
  return profiles.filter((item) => item.locale === assertLocale(locale) && String(item.projectId || "") === scope && item.status === "active").sort((a, b) => b.version - a.version)[0] || null;
}

async function saveJsonUserProfile(input) {
  const path = join(ROOT, "styles", "profiles.json");
  const profiles = await readJson(path, []);
  const projectId = String(input.projectId || input.project || "");
  const previous = profiles.filter((item) => item.locale === input.locale && String(item.projectId || "") === projectId).sort((a, b) => b.version - a.version)[0];
  if (previous && input.status !== "draft") previous.status = "inactive";
  const profile = { id: randomUUID(), ...input, projectId, version: (previous?.version || 0) + 1, status: input.status || "active", updatedAt: new Date().toISOString() };
  profiles.unshift(profile);
  await writeJsonAtomic(path, profiles);
  return profile;
}

/** 删除人工导入的风格指南（styles/profiles.json 里的一整篇文档）。 */
async function deleteJsonUserProfile(id) {
  const path = join(ROOT, "styles", "profiles.json");
  const profiles = await readJson(path, []);
  const next = profiles.filter((item) => item.id !== String(id));
  if (next.length === profiles.length) return false;
  await writeJsonAtomic(path, next);
  return true;
}

/** 删除自动蒸馏出的风格规范版本；生效版本由路由层拦住。 */
async function deleteJsonStyleProfile(id) {
  const located = await locateJsonStyleProfile(id);
  if (!located || located.kind === "user_profile") return false;
  const next = located.profiles.filter((item) => item.id !== String(id));
  if (next.length === located.profiles.length) return false;
  await writeJsonAtomic(located.path, next);
  return true;
}

async function saveJsonStyleEvidence(input) {
  const path = join(ROOT, "styles", "evidence.json");
  const items = await readJson(path, []);
  const source = String(input.source || "").trim();
  const match = styleEvidenceMatch({ entryKey: input.entryKey, locale: input.locale, projectId: input.projectId });
  const existing = match
    ? items.find((item) => String(item.entryKey || "").trim() === match.entryKey
      && String(item.locale || "") === match.locale
      && String(item.projectId || "").trim() === match.projectId)
    // 没有条目 ID 时退回"原文 + 译文 + 同项目"去重，避免同一份表格重复导入堆出重复证据。
    : items.find((item) => !String(item.entryKey || "").trim()
      && String(item.locale || "") === String(input.locale || "")
      && String(item.projectId || "").trim() === String(input.projectId || "").trim()
      && normalizeMemoryText(item.source) === normalizeMemoryText(source)
      && normalizeMemoryText(item.target) === normalizeMemoryText(input.target));
  const item = {
    id: existing?.id || randomUUID(),
    ...input,
    projectId: String(input.projectId || ""),
    machineTranslation: String(input.machineTranslation || "").trim(),
    polarity: input.polarity === "negative" ? "negative" : "positive",
    note: String(input.note || "").trim(),
    createdAt: new Date().toISOString()
  };
  if (existing) items[items.indexOf(existing)] = item;
  else items.push(item);
  await writeJsonAtomic(path, items);
  return item;
}

/** JSON 存储下的风格证据判重索引：与 Directus 版同口径（条目 ID 优先，其次原文+译文）。 */
async function loadJsonStyleEvidenceIndex(locale, { projectId = "" } = {}) {
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  const pairs = new Map();
  const entryKeys = new Map();
  const wanted = assertLocale(locale);
  const wantedProject = String(projectId || "").trim();
  for (const item of items) {
    if (String(item.locale || "") !== wanted) continue;
    if (String(item.projectId || "").trim() !== wantedProject) continue;
    const entryKey = String(item.entryKey || "").trim();
    if (entryKey) entryKeys.set(entryKey, item.id);
    else pairs.set(`${normalizeMemoryText(item.source)}\u0000${normalizeMemoryText(item.target)}`, item.id);
  }
  return { pairs, entryKeys };
}

/** 批量写入风格证据（JSON 存储）：一次读、一次写，判重口径与单条完全一致。 */
async function saveJsonStyleEvidences(inputs = [], { index = null } = {}) {
  const path = join(ROOT, "styles", "evidence.json");
  const results = new Array(inputs.length).fill(null);
  if (!inputs.length) return results;
  const items = await readJson(path, []);
  const pairs = index?.pairs || new Map();
  const entryKeys = index?.entryKeys || new Map();
  const byId = new Map(items.map((item) => [item.id, item]));
  const fallbackFind = (input, source, target) => {
    const entryKey = String(input.entryKey || "").trim();
    if (entryKey) {
      return items.find((item) => String(item.entryKey || "").trim() === entryKey
        && String(item.locale || "") === String(input.locale || "")
        && String(item.projectId || "").trim() === String(input.projectId || "").trim()) || null;
    }
    return items.find((item) => !String(item.entryKey || "").trim()
      && String(item.locale || "") === String(input.locale || "")
      && String(item.projectId || "").trim() === String(input.projectId || "").trim()
      && normalizeMemoryText(item.source) === normalizeMemoryText(source)
      && normalizeMemoryText(item.target) === normalizeMemoryText(target)) || null;
  };
  for (const [position, input] of inputs.entries()) {
    const locale = assertLocale(input.locale);
    const source = String(input.source || "").trim();
    const target = String(input.target || "").trim();
    if (!source || !target) {
      results[position] = { error: "风格证据缺少原文或译文" };
      continue;
    }
    const entryKey = String(input.entryKey || "").trim();
    const pairKey = `${normalizeMemoryText(source)}\u0000${normalizeMemoryText(target)}`;
    const existingId = entryKey ? entryKeys.get(entryKey) : pairs.get(pairKey);
    const existing = existingId ? byId.get(existingId) || fallbackFind(input, source, target) : fallbackFind(input, source, target);
    const item = {
      id: existing?.id || randomUUID(),
      ...existing,
      ...input,
      projectId: String(input.projectId || ""),
      machineTranslation: String(input.machineTranslation || "").trim(),
      polarity: input.polarity === "negative" ? "negative" : "positive",
      note: String(input.note || "").trim(),
      createdAt: existing?.createdAt || new Date().toISOString()
    };
    if (existing) items[items.indexOf(existing)] = item;
    else items.push(item);
    byId.set(item.id, item);
    if (entryKey) entryKeys.set(entryKey, item.id);
    else pairs.set(pairKey, item.id);
    results[position] = { id: item.id, source, target };
  }
  await writeJsonAtomic(path, items);
  return results;
}

async function saveJsonStyleProfile(input) {
  const path = join(ROOT, "styles", `${assertLocale(input.locale)}.json`);
  const profiles = await readJson(path, []);
  const projectId = String(input.projectId || input.project || "");
  // 版本号按「项目 + 语言」递增：风格资产是项目级的，语体与领域只是标签，
  // 按标签分别计数会让同项目的两份规范共用版本号，"最新 active"就没了确定含义。
  const previous = profiles.filter((item) => String(item.projectId || "") === projectId).sort((a, b) => (b.version || 0) - (a.version || 0))[0];
  if (previous && input.status !== "draft") previous.status = "inactive";
  const profile = { id: randomUUID(), ...input, projectId, source: "style-library", version: (previous?.version || 0) + 1, parentId: previous?.id || null, status: input.status || "active", updatedAt: new Date().toISOString() };
  profiles.unshift(profile);
  await writeJsonAtomic(path, profiles);
  return profile;
}

async function saveJsonStyleLearningRun(input) {
  const path = join(ROOT, "styles", "learning-runs.json");
  const items = await readJson(path, []);
  const existing = input.id ? items.find((item) => item.id === input.id) : null;
  const run = {
    id: existing?.id || randomUUID(),
    ...existing,
    projectId: String(input.projectId ?? input.project ?? existing?.projectId ?? ""),
    batchId: String(input.batchId || existing?.batchId || ""),
    filename: String(input.filename || existing?.filename || ""),
    locale: assertLocale(input.locale || existing?.locale),
    contentType: input.contentType || existing?.contentType || "general",
    domain: input.domain || existing?.domain || "general",
    evidenceCount: Number(input.evidenceCount ?? existing?.evidenceCount) || 0,
    summary: String(input.summary ?? existing?.summary ?? ""),
    rules: input.rules || existing?.rules || [],
    examples: input.examples || existing?.examples || [],
    caveat: String(input.caveat ?? existing?.caveat ?? ""),
    confidence: input.confidence == null ? (existing?.confidence ?? null) : Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    status: input.status || existing?.status || "observed",
    promotedProfileId: input.promotedProfileId ?? existing?.promotedProfileId ?? "",
    generatedBy: input.generatedBy || existing?.generatedBy || "",
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  if (existing) items[items.indexOf(existing)] = run;
  else items.unshift(run);
  await writeJsonAtomic(path, items);
  return run;
}

async function getJsonStyleLearningRuns(locale, options = {}) {
  const items = await readJson(join(ROOT, "styles", "learning-runs.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale)
      && (!options.batchId || item.batchId === options.batchId)
      && (!options.projectId || item.projectId === options.projectId)
      && (!options.status || item.status === options.status))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.min(500, Math.max(1, Number(options.limit) || 100)));
}

async function getJsonStyleLearningRun(id) {
  const items = await readJson(join(ROOT, "styles", "learning-runs.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function countJsonStyleEvidenceByScope(locale, { projectId = "" } = {}) {
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  const stats = new Map();
  for (const item of items) {
    if (item.locale !== assertLocale(locale)) continue;
    if (projectId && String(item.projectId || "") !== String(projectId)) continue;
    const contentType = item.contentType || "general";
    const domain = item.domain || "general";
    const key = `${contentType}\u0000${domain}`;
    const bucket = stats.get(key) || { contentType, domain, total: 0, byProvenance: {} };
    bucket.total += 1;
    const provenance = item.provenance || "other";
    bucket.byProvenance[provenance] = (bucket.byProvenance[provenance] || 0) + 1;
    stats.set(key, bucket);
  }
  return stats;
}

/**
 * 项目级证据计数：风格资产改成"每项目 + 语言一份"之后，闸门与面板都用这份总数，
 * 不再按语体×领域分池（语体只留作分布展示）。
 */
async function countJsonStyleEvidence(locale, { projectId = "" } = {}) {
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  const byProvenance = {};
  const byContentType = new Map();
  let total = 0;
  for (const item of items) {
    if (item.locale !== assertLocale(locale)) continue;
    if (projectId && String(item.projectId || "") !== String(projectId)) continue;
    total += 1;
    const provenance = item.provenance || "other";
    byProvenance[provenance] = (byProvenance[provenance] || 0) + 1;
    const contentType = item.contentType || "general";
    byContentType.set(contentType, (byContentType.get(contentType) || 0) + 1);
  }
  return {
    total,
    byProvenance,
    byContentType: [...byContentType.entries()].map(([contentType, count]) => ({ contentType, count })).sort((a, b) => b.count - a.count)
  };
}

/** 项目级规范：同项目 + 同语言最新 active 的那一份（不再按作用域挑）。 */
async function getJsonProjectStyleProfile(locale, { projectId = "" } = {}) {
  const profiles = await readJson(join(ROOT, "styles", `${assertLocale(locale)}.json`), []);
  const active = profiles
    .filter((item) => item.status === "active" && String(item.projectId || "") === String(projectId || ""))
    .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return active[0] || null;
}

async function locateJsonStyleProfile(id) {
  for (const locale of Object.keys(LOCALES)) {
    const path = join(ROOT, "styles", `${locale}.json`);
    const profiles = await readJson(path, []);
    const target = profiles.find((item) => item.id === id);
    if (target) return { path, profiles, target };
  }
  const profilePath = join(ROOT, "styles", "profiles.json");
  const profileList = await readJson(profilePath, []);
  const profile = profileList.find((item) => item.id === id);
  if (profile) return { path: profilePath, profiles: profileList, target: profile, kind: "user_profile" };
  return null;
}

async function listJsonStyleProfiles(locale, status, scope = null) {
  assertLocale(locale);
  const styleProfiles = await readJson(join(ROOT, "styles", `${locale}.json`), []);
  const userProfiles = await readJson(join(ROOT, "styles", "profiles.json"), []);
  const pick = (items) => items.filter((item) => !status || item.status === status).sort((a, b) => b.version - a.version);
  // 风格规范是项目级的：语体/领域不再筛掉任何一份规范，只按项目收窄。
  const inScope = (items) => items.filter((item) => !scope?.projectId || String(item.projectId || "") === String(scope.projectId));
  return {
    styleProfiles: pick(inScope(styleProfiles)),
    userProfiles: pick(userProfiles.filter((item) => item.locale === locale && (!scope?.projectId || String(item.projectId || "") === String(scope.projectId))))
  };
}

async function activateJsonStyleProfile(id) {
  const located = await locateJsonStyleProfile(id);
  if (!located) return null;
  if (located.kind === "user_profile") {
    for (const item of located.profiles) {
      if (item.id === id) item.status = "active";
      else if (item.locale === located.target.locale && String(item.projectId || "") === String(located.target.projectId || "") && item.status === "active") item.status = "inactive";
    }
    located.target.status = "active";
    await writeJsonAtomic(located.path, located.profiles);
    return located.target;
  }
  for (const item of located.profiles) {
    if (item.id === id) item.status = "active";
    // 风格资产是项目级的：激活一个版本时，同项目 + 同语言的其它 active 一律退役，
    // 否则历史作用域规范会继续参与取值，等于同时存在两份"当前规范"。
    else if (item.status === "active" && String(item.projectId || "") === String(located.target.projectId || "")) item.status = "inactive";
  }
  located.target.status = "active";
  await writeJsonAtomic(located.path, located.profiles);
  return located.target;
}

async function updateJsonStyleProfileRules(id, { rules, instruction }) {
  const located = await locateJsonStyleProfile(id);
  if (!located) return null;
  located.target.rules = rules;
  located.target.instruction = instruction;
  await writeJsonAtomic(located.path, located.profiles);
  return { id, rules, instruction };
}

async function saveJsonStyleProfileEvaluation(id, evaluation) {
  const located = await locateJsonStyleProfile(id);
  if (!located) return null;
  located.target.evaluation = evaluation;
  await writeJsonAtomic(located.path, located.profiles);
  return located.target;
}

async function rejectJsonStyleProfile(id) {
  const located = await locateJsonStyleProfile(id);
  if (!located || located.target.status === "active") return null;
  for (const item of located.profiles) if (item.id === id) item.status = "inactive";
  located.target.status = "inactive";
  await writeJsonAtomic(located.path, located.profiles);
  return located.target;
}

async function appendJsonQa(kind, input) {
  const path = join(ROOT, "qa", `${kind}.json`);
  const items = await readJson(path, []);
  const item = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
  items.unshift(item);
  await writeJsonAtomic(path, items);
  return item;
}

async function getJsonQaCases(locale, options = {}) {
  const items = await readJson(join(ROOT, "qa", "cases.json"), []);
  return items.filter((item) =>
    item.locale === assertLocale(locale)
    && item.status === "human_approved"
    && (!options.projectId || item.projectId === options.projectId)
  ).map((item) => (options.scopeFallback
    ? { ...item, scopeRank: scopeRankOf(item, { contentType: options.contentType || "general", domain: options.domain || "general" }) }
    : item));
}

/** 按 ID 取一条 QA 案例，不过滤状态：采纳后要立刻用它派生回归案例。 */
async function findJsonQaCase(id) {
  if (!id) return null;
  const items = await readJson(join(ROOT, "qa", "cases.json"), []);
  return items.find((item) => String(item.id) === String(id)) || null;
}

async function getJsonAssets(locale, options = {}) {
  const path = assetPath(locale);
  const data = await readJson(path, { locale, revision: 1, terms: [], memories: [], styleExamples: [] });
  if (!options.projectId) return data;
  const projectId = String(options.projectId).trim();
  return { ...data, terms: data.terms.filter((item) => item.projectId === projectId) };
}

async function getJsonAsset(locale, id) {
  const data = await getJsonAssets(locale);
  return (data.terms || []).find((item) => item.id === String(id)) || null;
}

/** 术语库 / 记忆库页的条目列表（JSON 存储）：与 Directus 实现同一套过滤与分页口径。 */
async function listJsonLibraryEntries({ locale, kind = "term", projectId = "", libraryId = "", sourceFile = "", search = "", limit = 100, offset = 0 } = {}) {
  assertLocale(locale);
  const needle = String(search || "").trim().toLocaleLowerCase();
  const matches = (item) => (!needle || [item.source, item.target, ...(kind === "tm" ? [item.entryKey, item.sourceFile] : item.aliases || [])]
    .some((value) => String(value || "").toLocaleLowerCase().includes(needle)));
  const rows = kind === "tm"
    ? (await readJson(join(ROOT, "memories", `${locale}.json`), [])).map((item) => ({ ...item, locale }))
    : (await getJsonAssets(locale)).terms;
  const filtered = rows
    .filter((item) => (!projectId || String(item.projectId || "") === String(projectId)))
    .filter((item) => (!libraryId || String(item.libraryId || "") === String(libraryId)))
    .filter((item) => (!sourceFile || (sourceFile === "__none__" ? !String(item.sourceFile || "").trim() : String(item.sourceFile || "") === sourceFile)))
    .filter(matches)
    .sort((left, right) => String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || "")));
  const start = Math.max(0, Math.trunc(Number(offset)) || 0);
  const size = Number(limit) <= 0 ? filtered.length : Math.max(1, Math.trunc(Number(limit)) || 100);
  return { total: filtered.length, items: filtered.slice(start, start + size) };
}

async function getJsonLibraryStats(locale, projectId = "") {
  const [terms, memories] = await Promise.all([
    getJsonAssets(locale).then((data) => data.terms || []),
    readJson(join(ROOT, "memories", `${assertLocale(locale)}.json`), [])
  ]);
  const stats = new Map();
  const collect = (rows, kind) => {
    const filesByLibrary = new Map();
    for (const row of rows) {
      const libraryId = String(row.libraryId || "");
      if (!libraryId || (projectId && String(row.projectId || "") !== String(projectId))) continue;
      const bucket = stats.get(libraryId) || { entryCount: 0, termCount: 0, memoryCount: 0, lastEntryAt: "", fileCount: 0, latestFile: "" };
      bucket.entryCount += 1;
      if (kind === "term") bucket.termCount += 1;
      else {
        bucket.memoryCount += 1;
        const file = String(row.sourceFile || "").trim();
        if (file) {
          const files = filesByLibrary.get(libraryId) || new Set();
          files.add(file);
          filesByLibrary.set(libraryId, files);
          bucket.fileCount = files.size;
          const stamp = String(row.createdAt || row.updatedAt || "");
          if (stamp >= (bucket.latestFileAt || "")) {
            bucket.latestFileAt = stamp;
            bucket.latestFile = file;
          }
        }
      }
      const stamp = String(row.createdAt || row.updatedAt || "");
      if (stamp > bucket.lastEntryAt) bucket.lastEntryAt = stamp;
      stats.set(libraryId, bucket);
    }
  };
  collect(terms, "term");
  collect(memories, "tm");
  return stats;
}

async function listJsonLibraryFiles({ locale, projectId = "", libraryId = "" } = {}) {
  assertLocale(locale);
  const rows = await readJson(join(ROOT, "memories", `${locale}.json`), []);
  const groups = new Map();
  for (const row of rows) {
    if (projectId && String(row.projectId || "") !== String(projectId)) continue;
    if (libraryId && String(row.libraryId || "") !== String(libraryId)) continue;
    const sourceFile = String(row.sourceFile || "").trim();
    const key = sourceFile || "__none__";
    const group = groups.get(key) || { sourceFile, entryCount: 0, batchCount: 0, lastEntryAt: "", batchId: "", batches: new Set() };
    group.entryCount += 1;
    if (row.batchId) group.batches.add(String(row.batchId));
    const stamp = String(row.createdAt || row.updatedAt || "");
    if (stamp >= group.lastEntryAt) {
      group.lastEntryAt = stamp;
      if (row.batchId) group.batchId = String(row.batchId);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ batches, ...group }) => ({ ...group, batchCount: batches ? batches.size : group.batchCount }))
    .sort((left, right) => String(right.lastEntryAt).localeCompare(String(left.lastEntryAt)));
}

async function updateJsonMemory(locale, id, patch = {}) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const items = await readJson(path, []);
  const index = items.findIndex((item) => item.id === String(id));
  if (index < 0) return null;
  const next = { ...items[index] };
  if (patch.source !== undefined) {
    const source = String(patch.source || "").trim();
    if (!source) {
      const error = new Error("日语原文不能为空");
      error.statusCode = 400;
      throw error;
    }
    next.source = source;
  }
  if (patch.target !== undefined) {
    const target = String(patch.target || "").trim();
    if (!target) {
      const error = new Error("简体中文译文不能为空");
      error.statusCode = 400;
      throw error;
    }
    next.target = target;
  }
  if (patch.entryKey !== undefined) next.entryKey = String(patch.entryKey || "").trim();
  if (patch.qualityStatus !== undefined && ["human_approved", "machine_verified", "provisional"].includes(patch.qualityStatus)) next.qualityStatus = patch.qualityStatus;
  next.updatedAt = new Date().toISOString();
  items[index] = next;
  await writeJsonAtomic(path, items);
  return next;
}

async function deleteJsonMemory(locale, id) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const items = await readJson(path, []);
  const next = items.filter((item) => item.id !== String(id));
  if (next.length === items.length) return false;
  await writeJsonAtomic(path, next);
  return true;
}

async function deleteJsonLibraryEntries(locale, kind, ids = []) {
  assertLocale(locale);
  const wanted = new Set(ids.map((id) => String(id)));
  if (!wanted.size) return 0;
  if (kind === "tm") {
    const path = join(ROOT, "memories", `${locale}.json`);
    const items = await readJson(path, []);
    const next = items.filter((item) => !wanted.has(String(item.id)));
    await writeJsonAtomic(path, next);
    return items.length - next.length;
  }
  const data = await getJsonAssets(locale);
  const next = (data.terms || []).filter((item) => !wanted.has(String(item.id)));
  const removed = (data.terms || []).length - next.length;
  await writeJsonAtomic(assetPath(locale), { ...data, revision: (data.revision || 0) + 1, terms: next });
  return removed;
}

async function saveJsonAsset(locale, input) {
  assertLocale(locale);
  const data = await getJsonAssets(locale);
  const now = new Date().toISOString();
  const term = {
    id: input.id || randomUUID(),
    source: String(input.source || "").trim(),
    aliases: [...new Set((input.aliases || []).map((item) => String(item).trim()).filter(Boolean))],
    target: String(input.target || "").trim(),
    forbidden: [...new Set((input.forbidden || []).map((item) => String(item).trim()).filter(Boolean))],
    domains: [...new Set((input.domains || ["general"]).filter(Boolean))],
    contentTypes: [...new Set((input.contentTypes || ["general"]).filter(Boolean))],
    contentTags: [...new Set((input.contentTags || []).filter(Boolean))],
    projectId: String(input.projectId || ""),
    libraryId: String(input.libraryId || ""),
    enforcement: input.enforcement || "preferred",
    note: String(input.note || "").trim(),
    status: input.status || "approved",
    provenance: input.provenance || "manual",
    createdAt: input.createdAt || now,
    updatedAt: now
  };
  if (!term.source || !term.target) {
    const error = new Error("术语原文和目标译法不能为空");
    error.statusCode = 400;
    throw error;
  }
  const index = data.terms.findIndex((item) => item.id === term.id);
  if (index >= 0) data.terms[index] = term;
  else data.terms.unshift(term);
  data.revision = (data.revision || 0) + 1;
  await writeJsonAtomic(assetPath(locale), data);
  return term;
}

async function deleteJsonAsset(locale, id) {
  const data = await getJsonAssets(locale);
  const before = data.terms.length;
  data.terms = data.terms.filter((item) => item.id !== id);
  if (before === data.terms.length) return false;
  data.revision = (data.revision || 0) + 1;
  await writeJsonAtomic(assetPath(locale), data);
  return true;
}

async function saveJsonCorpus(input) {
  const id = input.id || randomUUID();
  const document = {
    id,
    projectId: String(input.projectId || ""),
    name: String(input.name || "未命名语料").trim(),
    sourceLanguage: "ja-JP",
    domain: input.domain || "general",
    contentType: input.contentType || "general",
    text: String(input.text || ""),
    segments: input.segments || [],
    candidates: input.candidates || [],
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(join(ROOT, "corpora", `${id}.json`), document);
  return document;
}

async function demoteJsonMemories(locale, source, exceptId, { projectId = "" } = {}) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const items = await readJson(path, []);
  let demoted = 0;
  for (const item of items) {
    if (item.source !== source || item.id === exceptId || item.qualityStatus === "rejected" || (projectId && item.projectId !== projectId)) continue;
    item.qualityStatus = item.qualityStatus === "human_approved" ? "machine_verified" : "rejected";
    demoted += 1;
  }
  if (demoted) await writeJsonAtomic(path, items);
  return demoted;
}

async function approveJsonQaCase(id) {
  const path = join(ROOT, "qa", "cases.json");
  const items = await readJson(path, []);
  const item = items.find((entry) => entry.id === id);
  if (!item) return false;
  item.status = "human_approved";
  await writeJsonAtomic(path, items);
  return true;
}

async function listJsonPendingQaCases(locale, { projectId = "" } = {}) {
  const items = await readJson(join(ROOT, "qa", "cases.json"), []);
  return items.filter((item) => item.locale === assertLocale(locale) && (!projectId || item.projectId === projectId) && item.status === "review").slice(0, 20);
}

async function disposeJsonQaCase(id) {
  const path = join(ROOT, "qa", "cases.json");
  const items = await readJson(path, []);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  items.splice(index, 1);
  await writeJsonAtomic(path, items);
  return true;
}

function normalizeBatchSegments(segments = []) {
  return segments.slice(0, 2_000).map((segment) => ({
    id: String(segment.id || ""),
    source: String(segment.source || ""),
    translation: String(segment.translation || ""),
    status: String(segment.status || "pending"),
    selected: segment.selected !== false,
    accepted: Boolean(segment.accepted),
    locator: segment.locator || null,
    context: segment.context || null
  })).filter((segment) => segment.id && segment.source);
}

async function saveJsonBatchRun(input) {
  const batchId = String(input.batchId || randomUUID());
  const existing = await readJson(join(ROOT, "batches", `${batchId}.json`), null);
  await writeJsonAtomic(join(ROOT, "batches", `${batchId}.json`), {
    batchId,
    filename: String(input.filename || ""),
    projectId: String(input.projectId || ""),
    locale: assertLocale(input.locale),
    contentType: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    format: String(input.format || ""),
    segmentationMode: String(input.segmentationMode || "sentence"),
    structure: input.structure ?? null,
    subBatches: input.subBatches ?? existing?.subBatches ?? [],
    runnerOptions: { ...(input.runnerOptions ?? existing?.runnerOptions ?? {}), batchSummary: summarizeBatchSegments(input.segments || []) },
    contextBrief: input.contextBrief ?? existing?.contextBrief ?? null,
    qualityReport: input.qualityReport ?? existing?.qualityReport ?? null,
    runState: String(input.runState || existing?.runState || "ready"),
    segments: (input.segments || []).slice(0, 2_000),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return { batchId };
}

async function getJsonBatchRun(batchId) {
  return readJson(join(ROOT, "batches", `${String(batchId)}.json`), null);
}

async function deleteJsonBatchRun(batchId) {
  try {
    await rm(join(ROOT, "batches", `${String(batchId)}.json`));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function listJsonBatchRuns({ locale = "", status = "", search = "", projectId = "", limit = 200 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "batches")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const runs = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(join(ROOT, "batches", file), null)))).filter(Boolean);
  return runs.map((run) => {
    const selected = (run.segments || []).filter((segment) => segment.selected !== false);
    const completedSegments = selected.filter((segment) => segment.status === "done" && segment.translation).length;
    const failedSegments = selected.filter((segment) => segment.status === "error").length;
    const qaPending = selected.filter((segment) => Boolean(segment.result?.aiQa?.fallbackReason) || (Number.isFinite(segment.result?.qaScore) && segment.result.qaScore < 90) || (segment.result?.issues || []).length > 0).length;
    const status = run.runState === "ready" ? "ready" : run.runState === "paused" ? "paused" : failedSegments ? "needs_attention" : completedSegments < selected.length ? "in_progress" : qaPending ? "review" : "completed";
    return {
      batchId: run.batchId, projectId: run.projectId || "", filename: run.filename || "未命名任务", locale: run.locale,
      contentType: run.contentType || "general", domain: run.domain || "general", format: run.format || "",
      segmentationMode: run.segmentationMode || "sentence", status, runState: run.runState || "ready",
      runnerOptions: run.runnerOptions || {},
      // 文件列表要看"语境分析到哪一步"：只带状态与区间数，不带整份 brief。
      contextBrief: run.contextBrief ? { status: run.contextBrief.status || "", sections: (run.contextBrief.sections || []).length } : null,
      totalSegments: selected.length, completedSegments, failedSegments, qaPending,
      qaIncomplete: summarizeBatchSegments(selected).qaIncomplete,
      qualityTiers: summarizeQualityTiers(selected),
      createdAt: run.createdAt || run.updatedAt, updatedAt: run.updatedAt
    };
  }).filter((item) => (!locale || item.locale === locale) && (!projectId || item.projectId === projectId) && (!status || item.status === status) && (!search || item.filename.toLowerCase().includes(String(search).toLowerCase()))).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit);
}

async function saveJsonQaTask(input) {
  const id = String(input.id || randomUUID());
  const existing = await readJson(join(ROOT, "qa-tasks", `${id}.json`), null);
  const now = new Date().toISOString();
  const item = {
    id,
    projectId: String(input.projectId || existing?.projectId || ""),
    title: String(input.title || String(input.sourceText || "").slice(0, 40) || "未命名质检"),
    locale: assertLocale(input.locale),
    contentType: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    sourceText: String(input.sourceText || ""),
    translationText: String(input.translationText || ""),
    segmentCounts: input.segmentCounts ?? { source: 0, translation: 0 },
    overallScore: input.overallScore ?? null,
    dimensionScores: input.dimensionScores ?? null,
    summary: input.summary ?? null,
    alignmentNote: String(input.alignmentNote || ""),
    model: String(input.model || ""),
    report: input.report ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await writeJsonAtomic(join(ROOT, "qa-tasks", `${id}.json`), item);
  return item;
}

async function getJsonQaTask(id) {
  return readJson(join(ROOT, "qa-tasks", `${String(id)}.json`), null);
}

async function listJsonQaTasks({ locale = "", projectId = "", status = "", search = "", limit = 200 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "qa-tasks")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tasks = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(join(ROOT, "qa-tasks", file), null)))).filter(Boolean);
  return tasks.map((task) => ({
    id: task.id,
    projectId: task.projectId || "",
    type: "autoqa",
    title: task.title || "未命名质检",
    locale: task.locale,
    contentType: task.contentType || "general",
    domain: task.domain || "general",
    status: Number.isFinite(task.overallScore) ? (task.overallScore >= 90 ? "completed" : "review") : "completed",
    overallScore: Number.isFinite(task.overallScore) ? task.overallScore : null,
    totalSegments: Number(task.segmentCounts?.source) || 0,
    completedSegments: 0,
    failedSegments: 0,
    qaPending: task.summary ? Object.values(task.summary).reduce((sum, item) => sum + (Number(item?.total) || 0), 0) : 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  })).filter((item) => (!locale || item.locale === locale) && (!projectId || item.projectId === projectId) && (!status || item.status === status) && (!search || item.title.toLowerCase().includes(String(search).toLowerCase()))).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit);
}

async function deleteJsonQaTask(id) {
  try {
    await rm(join(ROOT, "qa-tasks", `${String(id)}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function saveJsonBackgroundTask(input) {
  const id = String(input.id || randomUUID());
  const existing = await readJson(join(ROOT, "background-tasks", `${id}.json`), null);
  const now = new Date().toISOString();
  const item = {
    id,
    projectId: String(input.projectId || existing?.projectId || ""),
    type: String(input.type || "term_import"),
    title: String(input.title || "后台任务"),
    locale: input.locale || "",
    status: String(input.status || existing?.status || "in_progress"),
    progress: input.progress ?? existing?.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
    payload: input.payload ?? existing?.payload ?? {},
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await writeJsonAtomic(join(ROOT, "background-tasks", `${id}.json`), item);
  return item;
}

async function getJsonBackgroundTask(id) {
  return readJson(join(ROOT, "background-tasks", `${String(id)}.json`), null);
}

async function listJsonBackgroundTasks({ locale = "", projectId = "", status = "", search = "", limit = 200 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "background-tasks")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tasks = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(join(ROOT, "background-tasks", file), null)))).filter(Boolean);
  return tasks
    .filter((task) => (!locale || task.locale === locale) && (!projectId || task.projectId === projectId) && (!status || task.status === status) && (!search || task.title.toLowerCase().includes(String(search).toLowerCase())))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, limit);
}

async function deleteJsonBackgroundTask(id) {
  const path = join(ROOT, "background-tasks", `${String(id)}.json`);
  const existing = await readJson(path, null);
  if (!existing) return false;
  await rm(path, { force: true });
  return true;
}

async function rebuildJsonEmbeddings(locale, currentModel, { forceLocal = false } = {}) {  const stats = { memories: 0, qaCases: 0, evidence: 0, errors: [] };  const targets = [
    { path: join(ROOT, "memories", `${assertLocale(locale)}.json`), kind: "memories" },
    { path: join(ROOT, "qa", "cases.json"), kind: "qaCases", filter: (item) => item.locale === locale }
    // 风格证据不再维护向量：见 directus-store.mjs 里 directusStyleEvidenceBody 的注释。
  ];
  for (const target of targets) {
    const items = await readJson(target.path, []);
    const scoped = target.filter ? items.map((item) => ({ item, index: items.indexOf(item) })).filter(({ item }) => target.filter(item)) : items.map((item) => ({ item, index: items.indexOf(item) }));
    for (const { item, index } of scoped) {
      if (!item.source) continue;
      if (item.embedding?.vector?.length && item.embedding?.model === currentModel) continue;
      const embedding = await embedSource(item.source, { forceLocal });
      if (!embedding) {
        stats.errors.push(`${target.kind}: ${item.source.slice(0, 30)}`);
        break;
      }
      items[index] = { ...item, embedding };
      stats[target.kind] += 1;
    }
    await writeJsonAtomic(target.path, items);
  }
  return stats;
}

async function saveJsonImportPreview(input) {
  const batchId = randomUUID();
  const candidates = input.candidates.map((candidate) => ({ ...candidate, candidateId: randomUUID() }));
  await writeJsonAtomic(join(ROOT, "imports", `${batchId}.json`), {
    ...input,
    batchId,
    candidates,
    status: "reviewing",
    createdAt: new Date().toISOString()
  });
  return { batchId, candidates };
}

/**
 * JSON 存储版的"替换上一批"：同项目 + 同文件名的旧 TM 审计文件直接删掉。
 * 与 Directus 版同一口径（只认 fileType === "tm-audit" 的批次）。
 */
async function replaceJsonTmImportAudit({ projectId = "", filename = "", keepBatchId = "" } = {}) {
  if (!projectId || !filename) return { batches: 0 };
  const dir = join(ROOT, "imports");
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return { batches: 0 };
  }
  let batches = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const existing = await readJson(path, null);
    if (!existing) continue;
    // 与 Directus 版同一口径：新批次看标记，历史批次看"没有 fileMode"。
    const isTmAudit = existing.fileType === "tm-audit" || (!existing.fileMode && existing.status === "completed");
    if (!isTmAudit) continue;
    if (String(existing.batchId || "") === String(keepBatchId || "")) continue;
    if (String(existing.projectId || "") !== projectId || String(existing.filename || "") !== filename) continue;
    await rm(path, { force: true });
    batches += 1;
  }
  return { batches };
}

/**
 * TM 导入成功后的审计（JSON 存储）：与 Directus 版同一份字段口径——
 * 批次状态直接写 completed，候选行只留审计必需的 14 列，且写终态。
 */
async function saveJsonTmImportAudit({ batchId, filename = "人工 TM 导入", fileType = "tm", projectId = "", requestedLocale = "zh-CN", summary = {}, candidates = [], decisions = [] } = {}) {
  if (!batchId) throw new Error("TM 导入审计缺少批次号");
  const rows = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const decision = decisions[index] || {};
    const accepted = decision.status === "accepted";
    return {
      candidateId: randomUUID(),
      projectId,
      source: candidate?.source || "",
      target: candidate?.target || "",
      locale: candidate?.locale || requestedLocale,
      assetType: candidate?.assetType || "memory",
      contentType: candidate?.contentType || "general",
      domain: candidate?.domain || "general",
      note: String(candidate?.note || "").slice(0, 500),
      batchId,
      sourceFile: candidate?.sourceFile || filename,
      rowNumber: Number(candidate?.rowNumber ?? candidate?.sourceRow) || index + 1,
      decision: accepted ? (candidate?.decision || "ready") : (decision.decision || candidate?.decision || "excluded"),
      status: accepted ? "accepted" : "rejected"
    };
  });
  // 重复导入同一个文件时替换上一批（口径与 Directus 版一致）。
  await replaceJsonTmImportAudit({ projectId, filename, keepBatchId: batchId }).catch(() => ({}));
  await writeJsonAtomic(join(ROOT, "imports", `${batchId}.json`), {
    batchId,
    filename,
    fileType: "tm-audit",
    sourceFileType: fileType,
    projectId,
    requestedLocale,
    candidates: rows,
    status: "completed",
    summary,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  return { batchId, candidates: rows.length };
}

async function getJsonImportPreview(batchId) {
  return readJson(join(ROOT, "imports", `${String(batchId)}.json`), null);
}

async function completeJsonImport(batchId, decisions, summary) {
  const path = join(ROOT, "imports", `${batchId}.json`);
  const batch = await readJson(path, null);
  if (!batch) return;
  batch.status = "completed";
  batch.decisions = decisions;
  batch.summary = summary;
  batch.completedAt = new Date().toISOString();
  await writeJsonAtomic(path, batch);
}

const LEARNING_TRAJECTORY_STATUSES = new Set(["running", "completed", "review", "failed"]);
const TRANSLATION_SKILL_STATUSES = new Set(["champion", "challenger", "draft", "inactive", "rejected"]);
const SKILL_EVALUATION_DECISIONS = new Set(["pending", "promote", "reject", "needs_review"]);

function learningPath(filename) {
  return join(ROOT, "learning", filename);
}

function cleanScope(input, fallback = {}) {
  return {
    locale: assertLocale(input.locale ?? fallback.locale),
    contentType: String(input.contentType ?? fallback.contentType ?? "general").trim() || "general",
    domain: String(input.domain ?? fallback.domain ?? "general").trim() || "general",
    project: String(input.project ?? fallback.project ?? "default").trim() || "default"
  };
}

function matchesLearningScope(item, filters = {}) {
  // 语体与领域只作参考：学习资产按「语言 × 项目」取，历史数据里它们的值只用于展示与排序。
  return (!filters.locale || item.locale === assertLocale(filters.locale))
    && (!filters.project || item.project === filters.project);
}

function normalizedLimit(value, fallback = 100) {
  return Math.min(1_000, Math.max(1, Number(value) || fallback));
}

function assertChoice(value, allowed, label) {
  if (!allowed.has(value)) {
    const error = new Error(`Unsupported ${label}: ${value}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function jsonObject(value, fallback = {}) {
  return value && typeof value === "object" ? structuredClone(value) : structuredClone(fallback);
}

function sameLearningScope(left, right) {
  return left.locale === right.locale
    && left.contentType === right.contentType
    && left.domain === right.domain
    && left.project === right.project;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function assertImmutableLearningIdentity(existing, input, fields) {
  for (const field of fields) {
    if (Object.hasOwn(input, field) && input[field] != null && String(input[field]) !== String(existing[field] ?? "")) {
      throw conflict(`${field} is immutable after creation`);
    }
  }
}

async function saveJsonLearningTrajectory(input) {
  const path = learningPath("trajectories.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = input.id ? items.find((item) => item.id === input.id) : null;
    if (!existing && input._mustExist) return null;
    if (existing) assertImmutableLearningIdentity(existing, input, ["locale", "contentType", "domain", "project", "batchId", "segmentId", "source"]);
    const now = new Date().toISOString();
    const scope = cleanScope(input, existing || {});
    const status = assertChoice(input.status ?? existing?.status ?? "running", LEARNING_TRAJECTORY_STATUSES, "learning trajectory status");
    const item = {
      id: existing?.id || input.id || randomUUID(),
      ...scope,
      batchId: String(input.batchId ?? existing?.batchId ?? ""),
      segmentId: String(input.segmentId ?? existing?.segmentId ?? ""),
      source: String(input.source ?? existing?.source ?? ""),
      initialTranslation: String(input.initialTranslation ?? existing?.initialTranslation ?? ""),
      finalTranslation: String(input.finalTranslation ?? existing?.finalTranslation ?? ""),
      contextPack: jsonObject(input.contextPack ?? existing?.contextPack),
      assetRefs: jsonObject(input.assetRefs ?? existing?.assetRefs, []),
      termDecisions: jsonObject(input.termDecisions ?? existing?.termDecisions, []),
      qaBefore: jsonObject(input.qaBefore ?? existing?.qaBefore),
      qaAfter: jsonObject(input.qaAfter ?? existing?.qaAfter),
      humanDecision: jsonObject(input.humanDecision ?? existing?.humanDecision),
      events: jsonObject(input.events ?? existing?.events, []),
      model: String(input.model ?? existing?.model ?? ""),
      promptVersion: String(input.promptVersion ?? existing?.promptVersion ?? ""),
      status,
      error: String(input.error ?? existing?.error ?? ""),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (!item.source) {
      const error = new Error("Learning trajectory source cannot be empty");
      error.statusCode = 400;
      throw error;
    }
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    await writeJsonAtomic(path, items);
    return item;
  });
}

async function listJsonLearningTrajectories(filters = {}) {
  const items = await readJson(learningPath("trajectories.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.batchId || item.batchId === filters.batchId)
    && (!filters.status || item.status === filters.status))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit));
}

/** JSON 存储下的同口径聚合：completed / review 且有最终译文，按语体 × 领域计数并带上来源文件。 */
async function countJsonLearningTrajectoriesByScope({ locale, project = "" } = {}) {
  const items = await readJson(learningPath("trajectories.json"), []);
  const counts = new Map();
  for (const item of items) {
    if (locale && item.locale !== locale) continue;
    if (project && (item.project || "default") !== project) continue;
    if (!["completed", "review"].includes(String(item.status || ""))) continue;
    if (!String(item.finalTranslation || "").trim()) continue;
    const contentType = item.contentType || "general";
    const domain = item.domain || "general";
    const key = `${contentType}\u0000${domain}`;
    const entry = counts.get(key) || { contentType, domain, count: 0, files: [] };
    entry.count += 1;
    const file = String(item.assetRefs?.sourceFile || "").trim();
    if (file) {
      const existing = entry.files.find((row) => row.name === file);
      if (existing) existing.count += 1;
      else entry.files.push({ name: file, count: 1 });
    }
    counts.set(key, entry);
  }
  return [...counts.values()].filter((item) => item.count > 0);
}

async function getJsonLearningTrajectory(id) {
  const items = await readJson(learningPath("trajectories.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

/**
 * 记忆库文件层用：每个来源文件各有多少条学习轨迹、其中多少条已经有人工终稿。
 * 这里不做 status 过滤——文件层要回答的是"这个文件有没有被学习过"，
 * 而不是"够不够格拿去蒸馏"。人工终稿的来源只有一种：人工接受或外部审校回填，
 * 两者都会把 human_decision.accepted 置为 true。
 */
async function countJsonLearningTrajectoriesByFile({ locale, project = "" } = {}) {
  const items = await readJson(learningPath("trajectories.json"), []);
  const counts = new Map();
  for (const item of items) {
    if (locale && item.locale !== locale) continue;
    if (project && (item.project || "default") !== project) continue;
    const sourceFile = String(item.assetRefs?.sourceFile || item.assetRefs?.source_file || "").trim();
    if (!sourceFile) continue;
    const entry = counts.get(sourceFile) || { sourceFile, count: 0, humanReviewed: 0 };
    entry.count += 1;
    if (item.humanDecision?.accepted === true) entry.humanReviewed += 1;
    counts.set(sourceFile, entry);
  }
  return [...counts.values()];
}

async function updateJsonLearningTrajectory(id, patch) {
  return saveJsonLearningTrajectory({ ...patch, id: String(id), _mustExist: true });
}

const QUALITY_ASSET_KINDS = new Set(["gold_set", "regression_candidate", "regression_suite"]);
const QUALITY_GATE_DECISIONS = new Set(["pass", "block", "insufficient"]);

function qualityAssetRecord(input, existing = null) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  const scope = cleanScope(input.scope || payload.scope || input, existing || {});
  const items = Array.isArray(payload.samples) ? payload.samples : Array.isArray(payload.cases) ? payload.cases : [];
  const now = new Date().toISOString();
  return {
    // 行 id 由存储层自己生成；资产的语义 id（series#v2）留在 payload 里，
    // 两者混用会让"同一版本"和"同一行"这两件事互相污染。
    id: existing?.id || input.id || randomUUID(),
    kind: assertChoice(String(input.kind ?? payload.kind ?? existing?.kind ?? ""), QUALITY_ASSET_KINDS, "quality asset kind"),
    ...scope,
    name: String(payload.name ?? input.name ?? existing?.name ?? ""),
    description: String(payload.description ?? input.description ?? existing?.description ?? ""),
    seriesId: String(payload.seriesId ?? input.seriesId ?? existing?.seriesId ?? payload.id ?? ""),
    version: Number(payload.version ?? input.version ?? existing?.version ?? 1),
    parentVersionId: String(payload.parentVersionId ?? input.parentVersionId ?? existing?.parentVersionId ?? ""),
    status: String(input.status ?? payload.status ?? existing?.status ?? "draft"),
    enabled: Boolean(input.enabled ?? payload.enabled ?? existing?.enabled ?? false),
    itemCount: items.length,
    sourceQaCaseId: String(payload.sourceQaCaseId ?? input.sourceQaCaseId ?? existing?.sourceQaCaseId ?? ""),
    fingerprint: String(payload.fingerprint ?? input.fingerprint ?? existing?.fingerprint ?? ""),
    payload: jsonObject(payload),
    approval: jsonObject(input.approval ?? payload.approval ?? existing?.approval, null),
    changeNote: String(payload.changeNote ?? input.changeNote ?? existing?.changeNote ?? ""),
    createdBy: String(payload.createdBy ?? input.createdBy ?? existing?.createdBy ?? ""),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

async function saveJsonQualityAsset(input) {
  const path = learningPath("quality-assets.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const id = String(input.id ?? "");
    const existing = id ? items.find((item) => item.id === id) : null;
    const record = qualityAssetRecord(input, existing);
    if (existing) items[items.indexOf(existing)] = record;
    else items.unshift(record);
    await writeJsonAtomic(path, items);
    return record;
  });
}

async function listJsonQualityAssets(filters = {}) {
  const items = await readJson(learningPath("quality-assets.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.kind || item.kind === filters.kind)
    && (!filters.status || item.status === filters.status)
    && (!filters.seriesId || item.seriesId === filters.seriesId)
    && (!filters.sourceQaCaseId || item.sourceQaCaseId === filters.sourceQaCaseId)
    && (filters.enabled === undefined || Boolean(item.enabled) === Boolean(filters.enabled)))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit, 200));
}

async function getJsonQualityAsset(id) {
  const items = await readJson(learningPath("quality-assets.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function updateJsonQualityAsset(id, patch = {}) {
  const path = learningPath("quality-assets.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = items.find((item) => item.id === String(id));
    if (!existing) return null;
    const record = {
      ...existing,
      ...(patch.status === undefined ? {} : { status: String(patch.status) }),
      ...(patch.enabled === undefined ? {} : { enabled: Boolean(patch.enabled) }),
      ...(patch.approval === undefined ? {} : { approval: jsonObject(patch.approval, null) }),
      ...(patch.changeNote === undefined ? {} : { changeNote: String(patch.changeNote) }),
      ...(patch.payload === undefined ? {} : { payload: jsonObject(patch.payload) }),
      updatedAt: new Date().toISOString()
    };
    items[items.indexOf(existing)] = record;
    await writeJsonAtomic(path, items);
    return record;
  });
}

async function saveJsonQualityRun(input) {
  const path = learningPath("quality-runs.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const record = {
      id: input.id || randomUUID(),
      ...cleanScope(input.scope || input, {}),
      skillId: String(input.skillId ?? ""),
      skillVersion: String(input.skillVersion ?? ""),
      decision: assertChoice(String(input.decision ?? "insufficient"), QUALITY_GATE_DECISIONS, "quality gate decision"),
      regressionTotal: Number(input.regressionTotal) || 0,
      regressionPassed: Number(input.regressionPassed) || 0,
      regressionPassRate: Number.isFinite(Number(input.regressionPassRate)) ? Number(input.regressionPassRate) : null,
      goldTotal: Number(input.goldTotal) || 0,
      goldTermAccuracy: Number.isFinite(Number(input.goldTermAccuracy)) ? Number(input.goldTermAccuracy) : null,
      goldFactAccuracy: Number.isFinite(Number(input.goldFactAccuracy)) ? Number(input.goldFactAccuracy) : null,
      assetVersions: jsonObject(input.assetVersions, {}),
      metrics: jsonObject(input.metrics, {}),
      report: jsonObject(input.report, {}),
      blocking: jsonObject(input.blocking, []),
      triggeredBy: String(input.triggeredBy ?? ""),
      createdAt: new Date().toISOString()
    };
    items.unshift(record);
    await writeJsonAtomic(path, items);
    return record;
  });
}

async function saveJsonTrainingRun(input) {
  const path = learningPath("training-runs.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const id = String(input.id || "");
    const existing = id ? items.find((item) => item.id === id) : null;
    const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
    const now = new Date().toISOString();
    const record = {
      id: existing?.id || id || randomUUID(),
      ...cleanScope(input.scope || payload.scope || input, existing || {}),
      name: String(payload.name || existing?.name || ""),
      method: String(payload.recipe?.method || existing?.method || "sft"),
      status: String(payload.status || existing?.status || "draft"),
      baseModel: String(payload.recipe?.baseModel || ""),
      teacherModel: String(payload.recipe?.teacherModel || ""),
      artifactModelId: String(payload.artifact?.modelId || ""),
      externalJobId: String(payload.externalJobId || ""),
      totalRecords: Number(payload.totalRecords) || 0,
      runFingerprint: String(payload.fingerprint || ""),
      payload: jsonObject(payload),
      error: String(payload.error || ""),
      createdBy: String(payload.createdBy || ""),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) items[items.indexOf(existing)] = record;
    else items.unshift(record);
    await writeJsonAtomic(path, items);
    return record;
  });
}

async function listJsonTrainingRuns(filters = {}) {
  const items = await readJson(learningPath("training-runs.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.status || item.status === filters.status)
    && (!filters.method || item.method === filters.method))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit, 50));
}

async function getJsonTrainingRun(id) {
  const items = await readJson(learningPath("training-runs.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function listJsonQualityRuns(filters = {}) {
  const items = await readJson(learningPath("quality-runs.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.skillId || item.skillId === filters.skillId)
    && (!filters.decision || item.decision === filters.decision))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit, 50));
}

function activateJsonSkillInItems(items, target, { rollback = false } = {}) {
  if (target.status === "rejected") throw conflict("Rejected translation skill cannot be activated");
  const scope = cleanScope(target);
  const current = items.filter((item) => item.id !== target.id && item.status === "champion" && matchesLearningScope(item, scope));
  if (current.length) {
    const isChildOfCurrent = current.some((item) => target.parentId === item.id);
    const isRollbackTarget = rollback && current.some((item) => item.parentId === target.id);
    if (!isChildOfCurrent && !isRollbackTarget) throw conflict("Translation skill was not evaluated against the current champion");
  }
  const now = new Date().toISOString();
  for (const item of current) {
    item.status = "inactive";
    item.updatedAt = now;
  }
  target.status = "champion";
  target.updatedAt = now;
  return target;
}

async function saveJsonTranslationSkill(input) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = input.id ? items.find((item) => item.id === input.id) : null;
    if (!existing && input._mustExist) return null;
    if (existing) {
      assertImmutableLearningIdentity(existing, input, ["locale", "contentType", "domain", "project", "version", "parentId"]);
      if (existing.status === "champion" && Object.hasOwn(input, "status") && input.status !== "champion") {
        throw conflict("The current champion must be replaced or rolled back, not directly deactivated");
      }
      if (existing.status === "rejected" && Object.hasOwn(input, "status") && input.status !== "rejected") {
        throw conflict("Rejected translation skill cannot be reactivated through update");
      }
    }
    const scope = cleanScope(input, existing || {});
    const scoped = items.filter((item) => matchesLearningScope(item, scope));
    const previous = scoped.sort((a, b) => Number(b.version) - Number(a.version))[0] || null;
    const status = assertChoice(input.status ?? existing?.status ?? "draft", TRANSLATION_SKILL_STATUSES, "translation skill status");
    // 版本号只由存储层分配：调用方给的"建议版本"可能已经过时——例如候选被拒绝后
    // 仍按「生效版本 + 1」提交，就会撞上那个还留着的旧版本号，手动重新生成候选直接 409
    // （实测 "Translation skill version 2 already exists in this scope"）。
    // 取「建议版本」与「下一个空闲版本」的较大者，既尊重显式指定，又不会撞号。
    const version = existing?.version || Math.max(1, Number(input.version) || 0, (Number(previous?.version) || 0) + 1);
    if (!existing && scoped.some((item) => Number(item.version) === version)) throw conflict(`Translation skill version ${version} already exists in this scope`);
    const now = new Date().toISOString();
    const item = {
      id: existing?.id || input.id || randomUUID(),
      ...scope,
      name: String(input.name ?? existing?.name ?? `${scope.locale} ${scope.contentType} translation skill`).trim(),
      description: String(input.description ?? existing?.description ?? ""),
      changeReason: String(input.changeReason ?? existing?.changeReason ?? ""),
      version,
      parentId: input.parentId === null ? null : String(input.parentId ?? existing?.parentId ?? previous?.id ?? "") || null,
      status,
      strategy: jsonObject(input.strategy ?? existing?.strategy),
      evidenceIds: jsonObject(input.evidenceIds ?? existing?.evidenceIds, []),
      promptVersion: String(input.promptVersion ?? existing?.promptVersion ?? ""),
      metrics: jsonObject(input.metrics ?? existing?.metrics),
      metadata: jsonObject(input.metadata ?? existing?.metadata),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (item.parentId) {
      const parent = items.find((entry) => entry.id === item.parentId);
      if (!parent || !sameLearningScope(parent, item)) throw conflict("Translation skill parent must exist in the same scope");
    }
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    if (status === "champion") activateJsonSkillInItems(items, item);
    await writeJsonAtomic(path, items);
    return item;
  });
}

async function listJsonTranslationSkills(filters = {}) {
  const items = await readJson(learningPath("skills.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.status || item.status === filters.status))
    .sort((a, b) => Number(b.version) - Number(a.version) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, normalizedLimit(filters.limit));
}

async function getJsonTranslationSkill(id) {
  const items = await readJson(learningPath("skills.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

/** 删除一个技能版本（候选 / 被拒绝 / 旧版本）。生效版本由路由层拦住，不在这里判断。 */
async function deleteJsonTranslationSkill(id) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const next = items.filter((item) => item.id !== String(id));
    if (next.length === items.length) return false;
    await writeJsonAtomic(path, next);
    return true;
  });
}

async function updateJsonTranslationSkill(id, patch) {
  return saveJsonTranslationSkill({ ...patch, id: String(id), _mustExist: true });
}

async function activateJsonTranslationSkill(id) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const skill = items.find((item) => item.id === String(id));
    if (!skill) return null;
    activateJsonSkillInItems(items, skill);
    await writeJsonAtomic(path, items);
    return skill;
  });
}

async function rollbackJsonTranslationSkill(id) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const current = items.find((item) => item.id === String(id));
    if (!current) return null;
    if (current.status !== "champion") throw conflict("Only the current champion translation skill can be rolled back");
    const scope = cleanScope(current);
    const parent = (current.parentId && items.find((item) => item.id === current.parentId && item.status !== "rejected" && matchesLearningScope(item, scope)))
      || items.filter((item) => item.id !== current.id && item.status !== "rejected" && Number(item.version) < Number(current.version) && matchesLearningScope(item, scope)).sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (!parent) throw conflict("No previous translation skill version is available for rollback");
    activateJsonSkillInItems(items, parent, { rollback: true });
    await writeJsonAtomic(path, items);
    return { rolledBack: current, champion: parent };
  });
}

async function saveJsonSkillEvaluation(input) {
  const path = learningPath("evaluations.json");
  const skillsPath = learningPath("skills.json");
  return withJsonFileLock(skillsPath, () => withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = input.id ? items.find((item) => item.id === input.id) : null;
    if (!existing && input._mustExist) return null;
    if (existing) assertImmutableLearningIdentity(existing, input, ["locale", "contentType", "domain", "project", "championSkillId", "challengerSkillId"]);
    const now = new Date().toISOString();
    const scope = cleanScope(input, existing || {});
    const decision = assertChoice(input.decision ?? existing?.decision ?? "pending", SKILL_EVALUATION_DECISIONS, "skill evaluation decision");
    const item = {
      id: existing?.id || input.id || randomUUID(),
      ...scope,
      championSkillId: String(input.championSkillId ?? existing?.championSkillId ?? ""),
      challengerSkillId: String(input.challengerSkillId ?? existing?.challengerSkillId ?? ""),
      sampleCount: Math.max(0, Number(input.sampleCount ?? existing?.sampleCount) || 0),
      championMetrics: jsonObject(input.championMetrics ?? existing?.championMetrics),
      challengerMetrics: jsonObject(input.challengerMetrics ?? existing?.challengerMetrics),
      metricDeltas: jsonObject(input.metricDeltas ?? existing?.metricDeltas),
      decision,
      report: jsonObject(input.report ?? existing?.report),
      evaluator: String(input.evaluator ?? existing?.evaluator ?? ""),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (!item.championSkillId || !item.challengerSkillId || item.championSkillId === item.challengerSkillId) {
      const error = new Error("Skill evaluation requires distinct championSkillId and challengerSkillId");
      error.statusCode = 400;
      throw error;
    }
    if (!existing || decision === "promote") {
      const skills = await readJson(skillsPath, []);
      const champion = skills.find((skill) => skill.id === item.championSkillId);
      const challenger = skills.find((skill) => skill.id === item.challengerSkillId);
      if (!champion || champion.status !== "champion" || !sameLearningScope(champion, item)) throw conflict("Skill evaluation champion is not the current champion in this scope");
      if (!challenger || !["challenger", "draft"].includes(challenger.status) || !sameLearningScope(challenger, item)) throw conflict("Skill evaluation challenger is not an active candidate in this scope");
    }
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    await writeJsonAtomic(path, items);
    return item;
  }));
}

async function listJsonSkillEvaluations(filters = {}) {
  const items = await readJson(learningPath("evaluations.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.decision || item.decision === filters.decision)
    && (!filters.championSkillId || item.championSkillId === filters.championSkillId)
    && (!filters.challengerSkillId || item.challengerSkillId === filters.challengerSkillId))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit));
}

async function getJsonSkillEvaluation(id) {
  const items = await readJson(learningPath("evaluations.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function updateJsonSkillEvaluation(id, patch) {
  return saveJsonSkillEvaluation({ ...patch, id: String(id), _mustExist: true });
}

export const DATA_ROOT = ROOT;

export async function getProjects(options = {}) {
  return usesDirectus() ? getDirectusProjects(options) : getJsonProjects(options);
}

export async function getProject(id) {
  return usesDirectus() ? getDirectusProject(id) : getJsonProject(id);
}

export async function saveProject(input = {}) {
  return usesDirectus() ? saveDirectusProject(input) : saveJsonProject(input);
}

export async function deleteProject(id) {
  return usesDirectus() ? archiveDirectusProject(id) : archiveJsonProject(id);
}

export async function purgeProject(id) {
  const purged = await (usesDirectus() ? purgeDirectusProject(id) : purgeJsonProject(id));
  invalidateMemoryIndexes();
  return purged;
}

export async function getResourceLibraries(projectId, options = {}) {
  return usesDirectus() ? getDirectusResourceLibraries(projectId, options) : getJsonResourceLibraries(projectId, options);
}

export async function saveResourceLibrary(input = {}) {
  return usesDirectus() ? saveDirectusResourceLibrary(input) : saveJsonResourceLibrary(input);
}

export async function deleteResourceLibrary(projectId, libraryId) {
  return usesDirectus()
    ? deleteDirectusResourceLibrary(projectId, libraryId)
    : deleteJsonResourceLibrary(projectId, libraryId);
}

function usesDirectus() {
  return Boolean(runtimeOptions().store) || process.env.KAMI_STORE === "directus";
}

/**
 * Directus 是唯一的生产存储，连不上就直接启动失败。
 *
 * 这里曾经会静默回退到本地 JSON。代价比看起来大得多：回退后 1966 条风格证据、
 * 600+ 条翻译记忆、7 份风格规范全部不可见，模型在零参考的情况下继续翻译，
 * 同时新写入落到 data/ 形成数据分叉——界面横幅并不足以让人及时发现。
 * 当前工作台只探测日语→简体中文所需的两张表；历史语言表只用于已有记录的兼容读取，
 * 不会阻断当前工作台启动。宁可起不来，也不要带着当前资产残缺的状态运行。
 *
 * JSON 存储仍然保留，但只服务于单元测试（不设置 KAMI_STORE 时启用）。
 */
export async function initializeStore() {
  if (!usesDirectus()) return initializeJsonStore();
  try {
    await initializeDirectusStore();
  } catch (error) {
    throw new Error([
      `Directus 资产后台不可用：${error.message}`,
      "本工作台的术语、翻译记忆、风格规范与学习轨迹全部存放在 Directus，缺少它无法提供有意义的翻译质量，因此不再回退到本地 JSON。",
      "请依次检查：",
      "  1. Docker Desktop 是否已启动",
      "  2. npm run directus:up 是否已执行且容器处于 healthy",
      "  3. 新增目标语言后是否执行过 npm run directus:provision（缺少某个语种的表会让整体探针失败）",
      "  4. directus/.env 中的 DIRECTUS_URL 与 Service Token 是否正确"
    ].join("\n"));
  }
}

export async function getAssets(locale, options = {}) {
  return usesDirectus() ? getDirectusAssets(locale, options) : getJsonAssets(locale, options);
}

/**
 * 术语库写入代际：术语/别名/状态变化后 +1。
 * 上层用它判断「项目资产缓存」是否过期，避免每次 QA/翻译都重拉 5,800+ 条术语。
 */
let assetGeneration = 0;

export function getAssetGenerationToken() {
  return assetGeneration;
}

function bumpAssetGeneration() {
  assetGeneration += 1;
}

export async function getAssetStats(locale) {
  if (usesDirectus()) return getDirectusAssetStats(locale);
  const assets = await getJsonAssets(locale);
  return { locale, revision: assets.revision, termCount: assets.terms.length };
}

export async function saveAsset(locale, input) {
  try {
    return await (usesDirectus() ? saveDirectusAsset(locale, input) : saveJsonAsset(locale, input));
  } finally {
    bumpAssetGeneration();
  }
}

/** 批量写入术语：导入几千条时逐条写会把整批拖到分钟级。 */
export async function saveAssets(locale, inputs = []) {
  try {
    if (usesDirectus()) return await saveDirectusAssets(locale, inputs);
    const saved = [];
    for (const input of inputs) saved.push(await saveJsonAsset(locale, input));
    return saved;
  } finally {
    bumpAssetGeneration();
  }
}

export async function deleteAsset(locale, id) {
  try {
    return await (usesDirectus() ? deleteDirectusAsset(locale, id) : deleteJsonAsset(locale, id));
  } finally {
    bumpAssetGeneration();
  }
}

/** 单条术语：编辑前要先读回现有行，避免整条覆盖丢掉 library_id 等归属信息。 */
export async function getAsset(locale, id) {
  return usesDirectus() ? getDirectusAsset(locale, id) : getJsonAsset(locale, id);
}

/** 术语库 / 记忆库页：按库过滤 + 搜索 + 分页的条目列表（limit<=0 取全量，供导出用）。 */
export async function listLibraryEntries(options) {
  return usesDirectus() ? listDirectusLibraryEntries(options) : listJsonLibraryEntries(options);
}

/** 库列表的实时条目数与最新条目时间，按 library_id 聚合。 */
export async function getLibraryStats(locale, projectId) {
  return usesDirectus() ? getDirectusLibraryStats(locale, projectId) : getJsonLibraryStats(locale, projectId);
}

/** TM 库下的来源文件清单（库 → 文件 → 条目 的中间层）。 */
export async function listLibraryFiles(options) {
  return usesDirectus() ? listDirectusLibraryFiles(options) : listJsonLibraryFiles(options);
}

/** 批量删除库内条目（删库时二选一里的"连条目一起删"）。 */
export async function deleteLibraryEntries(locale, kind, ids) {
  const removed = await (usesDirectus() ? deleteDirectusLibraryEntries(locale, kind, ids) : deleteJsonLibraryEntries(locale, kind, ids));
  // 删库里的 TM 行同样会改变检索结果：索引必须跟着失效。
  invalidateMemoryIndexes();
  if (kind === "term") bumpAssetGeneration();
  return removed;
}

export async function saveCorpus(input) {
  return usesDirectus() ? saveDirectusCorpus(input) : saveJsonCorpus(input);
}

export async function saveImportPreview(input, options) {
  return usesDirectus() ? saveDirectusImportPreview(input, options) : saveJsonImportPreview(input);
}

export async function getImportPreview(batchId) {
  return usesDirectus() ? getDirectusImportPreview(batchId) : getJsonImportPreview(batchId);
}

/** TM 导入成功后的审计写入（失败路径不调用，因此库里不会留半截候选）。 */
export async function saveTmImportAudit(input = {}) {
  return usesDirectus() ? saveDirectusTmImportAudit(input) : saveJsonTmImportAudit(input);
}

/**
 * 把 AI 清洗结论写回候选行，续跑时据此跳过已经判定过的条目。
 * JSON 存储实现没有这一层队列，直接返回 0（续跑会按老路子重新判定）。
 */
export async function persistImportCleaning(batchId, payload) {
  return usesDirectus() ? persistDirectusImportCleaning(batchId, payload) : 0;
}

export async function completeImport(batchId, decisions, summary) {
  return usesDirectus() ? completeDirectusImport(batchId, decisions, summary) : completeJsonImport(batchId, decisions, summary);
}

export async function getMemories(locale, options) {
  return usesDirectus() ? getDirectusMemories(locale, options) : getJsonMemories(locale, options);
}

/**
 * 记忆候选索引缓存：键是「语言 + 项目」。
 *
 * 索引只留 id / 原文 / 库归属，不含向量——实测 8.3 万行建索引 0.9 秒、几十 MB 级。
 * 单条写入/删除只增量更新已加载的缓存；只有批量导入、删库、清理项目这类影响面大的
 * 操作才整体失效，下次检索重建一次。
 */
const memoryIndexCache = new Map();
/** 首次加载中的 `{ generation, promise }`：同一代的并发检索只拉一次 22MB。 */
const memoryIndexLoads = new Map();
let memoryIndexGeneration = 0;
let memoryIndexBuilds = 0;

/** 诊断用：候选索引缓存规模与全量重建次数（测试与性能排查使用，不参与业务逻辑）。 */
export function getMemoryIndexDiagnostics() {
  return { entries: memoryIndexCache.size, builds: memoryIndexBuilds, generation: memoryIndexGeneration };
}

/** 记忆写入后调用：索引整体失效，下次检索按需重建。 */
export function invalidateMemoryIndexes() {
  memoryIndexGeneration += 1;
  memoryIndexCache.clear();
}

function memoryIndexRow(memory) {
  return {
    id: String(memory?.id || ""),
    source: String(memory?.source || ""),
    libraryId: String(memory?.libraryId || ""),
    qualityStatus: memory?.qualityStatus || "provisional",
    projectId: String(memory?.projectId || "")
  };
}

/**
 * 单条写入后只更新对应「语言 + 项目」的已加载索引；没有缓存就不用动（下次检索直接读新数据）。
 *
 * `memory.projectId` 缺失时（部分 update 返回体）按 id 找到已有缓存行并沿用它的项目，
 * 避免把项目归属写成空串。
 */
function applyMemoryIndexUpsert(locale, memory, projectIdHint = "") {
  const id = String(memory?.id || "");
  if (!id) return;
  memoryIndexGeneration += 1;
  const explicitProject = memory?.projectId !== undefined;
  const projectId = explicitProject ? String(memory.projectId || "") : String(projectIdHint || "");
  const row = memoryIndexRow(memory);
  for (const entry of memoryIndexCache.values()) {
    if (entry.locale !== locale) continue;
    if (explicitProject) {
      if (entry.projectId !== projectId) continue;
    } else if (!entry.index.slotById.has(id)) {
      continue;
    }
    const slot = entry.index.slotById.get(id);
    const existing = slot === undefined ? null : entry.index.rows[slot];
    upsertMemoryRow(entry.index, {
      ...row,
      projectId: explicitProject ? projectId : String(existing?.projectId || entry.projectId || "")
    });
  }
}

/** 单条删除后从该语言的所有已加载缓存里移除（id 全局唯一，不用先查项目）。 */
function applyMemoryIndexRemoval(locale, id) {
  memoryIndexGeneration += 1;
  for (const entry of memoryIndexCache.values()) {
    if (entry.locale !== locale) continue;
    removeMemoryRow(entry.index, id);
  }
}

/**
 * 检索用候选：先用字符 n-gram 倒排收窄到 top-K，再按 id 取回完整行（含向量）。
 * 打分公式与门槛完全不变，本函数只决定"候选从哪来"。
 *
 * limit <= 0 时退回原来的整库取法，作为应急开关（8 万条时每段要十几秒）。
 */
export async function getMemoryCandidates(locale, { projectId = "", source = "", limit = DEFAULT_CANDIDATE_POOL, scopeFallback = false, contentType = "general", domain = "general", libraryIds = null } = {}) {
  const pool = Number(limit);
  if (!String(source || "").trim() || !Number.isFinite(pool) || pool <= 0) {
    return getMemories(locale, { projectId, limit: pool > 0 ? pool : -1, scopeFallback, contentType, domain });
  }
  const key = `${locale}\u0000${String(projectId || "")}`;
  let entry = memoryIndexCache.get(key);
  if (!entry) {
    const generation = memoryIndexGeneration;
    let pending = memoryIndexLoads.get(key);
    // 只有同一代的加载才能共用：读取期间若有写入，后来者必须重新拉，不能吃到旧快照。
    if (!pending || pending.generation !== generation) {
      // 这一枪读到的只是快照，可以用于本次检索；若期间有写入，不写回缓存，
      // 否则会把写入后的新行丢掉。
      const promise = (async () => {
        const rows = await (usesDirectus()
          ? listDirectusMemoryIndexRows(locale, { projectId })
          : listJsonMemoryIndexRows(locale, { projectId }));
        memoryIndexBuilds += 1;
        const loaded = { locale, projectId: String(projectId || ""), index: buildMemoryIndex(rows) };
        if (memoryIndexGeneration === generation) memoryIndexCache.set(key, loaded);
        return loaded;
      })();
      pending = { generation, promise };
      memoryIndexLoads.set(key, pending);
      const clear = () => {
        if (memoryIndexLoads.get(key) === pending) memoryIndexLoads.delete(key);
      };
      promise.then(clear, clear);
    }
    entry = await pending.promise;
  }
  const candidates = selectMemoryCandidates(entry.index, source, { limit: pool, libraryIds });
  const ids = candidates.map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];
  const rows = await (usesDirectus()
    ? getDirectusMemoriesByIds(locale, ids, { contentType, domain, scopeFallback })
    : getJsonMemoriesByIds(locale, ids, { contentType, domain, scopeFallback }));
  // 输入顺序与整库路径保持一致（最新在前）：排序函数对完全同分的条目按输入顺序打破平局，
  // 顺序一致，重复行之间的取舍才不会因为换了检索路径而变。
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || "")));
}

export async function countMemories(locale, options) {
  return usesDirectus() ? countDirectusMemories(locale, options) : countJsonMemories(locale, options);
}

export async function saveMemory(locale, input) {
  const saved = await (usesDirectus() ? saveDirectusMemory(locale, input) : saveJsonMemory(locale, input));
  applyMemoryIndexUpsert(locale, saved, input?.projectId || "");
  return saved;
}

/** 批量写翻译记忆：导入大表时用，单条写入语义不变。 */
export async function saveMemories(locale, inputs = [], options = {}) {
  const saved = await (usesDirectus() ? saveDirectusMemories(locale, inputs, options) : saveJsonMemories(locale, inputs));
  invalidateMemoryIndexes();
  return saved;
}

export async function updateMemory(locale, id, patch) {
  const saved = await (usesDirectus() ? updateDirectusMemory(locale, id, patch) : updateJsonMemory(locale, id, patch));
  if (saved) applyMemoryIndexUpsert(locale, saved);
  return saved;
}

export async function deleteMemory(locale, id) {
  const removed = await (usesDirectus() ? deleteDirectusMemory(locale, id) : deleteJsonMemory(locale, id));
  if (removed) applyMemoryIndexRemoval(locale, id);
  return removed;
}

export async function getStyleProfile(locale, contentType, domain, options = {}) {
  return usesDirectus() ? getDirectusStyleProfile(locale, contentType, domain, options) : getJsonStyleProfile(locale, contentType, domain, options);
}

export async function getStyleEvidence(locale, options) {
  return usesDirectus() ? getDirectusStyleEvidence(locale, options) : getJsonStyleEvidence(locale, options);
}

/**
 * 分层取样读证据：先扫一个有界窗口（默认最近 5000 条），再按
 * provenance → 语体 → 来源文件分层取 limit 条。见 src/evidence-sample.mjs。
 *
 * 为什么不是 `getStyleEvidence(..., { limit })`：那条路是"最新优先"，
 * 一次 7 万行的导入就能把窗口占满，蒸馏与提示词只会看到这一批。
 */
export async function sampleStyleEvidence(locale, options = {}) {
  const {
    limit = 1_000,
    scanBudget = EVIDENCE_SCAN_BUDGET,
    pageSize = EVIDENCE_PAGE_SIZE,
    perFileCap,
    positiveOnly = false,
    ...filters
  } = options;
  const rows = usesDirectus()
    ? await collectEvidencePages({
      scanBudget,
      pageSize,
      fetchPage: (offset, size) => listDirectusStyleEvidencePage(locale, { ...filters, limit: size, offset })
    })
    : await getJsonStyleEvidence(locale, { ...filters, limit: Math.max(1, Math.trunc(Number(scanBudget)) || EVIDENCE_SCAN_BUDGET) });
  return stratifyEvidenceSample(rows, { limit, perFileCap, positiveOnly });
}

export async function getQaRuns(locale, options) {
  return usesDirectus() ? getDirectusQaRuns(locale, options) : getJsonQaRuns(locale, options);
}

export async function getUserProfile(locale, options = {}) {
  return usesDirectus() ? getDirectusUserProfile(locale, options) : getJsonUserProfile(locale, options);
}

export async function saveUserProfile(input) {
  return usesDirectus() ? saveDirectusUserProfile(input) : saveJsonUserProfile(input);
}

export async function saveStyleEvidence(input) {
  return usesDirectus() ? saveDirectusStyleEvidence(input) : saveJsonStyleEvidence(input);
}

/** 批量写风格证据 + 判重索引：大表导入时避免逐条拉全项目证据（旧实现是 O(n²)）。 */
export async function loadStyleEvidenceIndex(locale, options = {}) {
  return usesDirectus() ? loadDirectusStyleEvidenceIndex(locale, options) : loadJsonStyleEvidenceIndex(locale, options);
}

export async function saveStyleEvidences(inputs = [], options = {}) {
  return usesDirectus() ? saveDirectusStyleEvidences(inputs, options) : saveJsonStyleEvidences(inputs, options);
}

export async function saveStyleProfile(input) {
  return usesDirectus() ? saveDirectusStyleProfile(input) : saveJsonStyleProfile(input);
}

export async function saveStyleLearningRun(input) {
  return usesDirectus() ? saveDirectusStyleLearningRun(input) : saveJsonStyleLearningRun(input);
}

export async function getStyleLearningRuns(locale, options) {
  return usesDirectus() ? getDirectusStyleLearningRuns(locale, options) : getJsonStyleLearningRuns(locale, options);
}

export async function getStyleLearningRun(id) {
  return usesDirectus() ? getDirectusStyleLearningRun(id) : getJsonStyleLearningRun(id);
}

/** 风格证据的真实条数（按语体 × 领域 × 来源聚合），用于证据池显示。 */
export async function countStyleEvidenceByScope(locale, options) {
  return usesDirectus() ? countDirectusStyleEvidenceByScope(locale, options) : countJsonStyleEvidenceByScope(locale, options);
}

export async function countStyleEvidence(locale, options) {
  return usesDirectus() ? countDirectusStyleEvidence(locale, options) : countJsonStyleEvidence(locale, options);
}

export async function getProjectStyleProfile(locale, options) {
  return usesDirectus() ? getDirectusProjectStyleProfile(locale, options) : getJsonProjectStyleProfile(locale, options);
}

export async function saveQaRun(input) {
  return usesDirectus() ? saveDirectusQaRun(input) : appendJsonQa("runs", input);
}

export async function saveQaCase(input) {
  if (usesDirectus()) return saveDirectusQaCase(input);
  const embedding = input.embedding ?? await embedSource(input.source);
  return appendJsonQa("cases", { ...input, ...(embedding ? { embedding } : {}) });
}

export async function rebuildEmbeddings(locale, options = {}) {
  const model = embeddingModelName();
  if (!model) {
    const error = new Error("未配置 embedding 模型，无法重建向量索引");
    error.statusCode = 400;
    throw error;
  }
  return usesDirectus() ? rebuildDirectusEmbeddings(locale, options) : rebuildJsonEmbeddings(locale, model, options);
}

export async function demoteMemories(locale, source, exceptId, options = {}) {
  const result = await (usesDirectus() ? demoteDirectusMemories(locale, source, exceptId, options) : demoteJsonMemories(locale, source, exceptId, options));
  invalidateMemoryIndexes();
  return result;
}

export async function approveQaCase(id) {
  return usesDirectus() ? approveDirectusQaCase(id) : approveJsonQaCase(id);
}

export async function saveBatchRun(input) {
  return usesDirectus() ? saveDirectusBatchRun(input) : saveJsonBatchRun(input);
}

export async function getBatchRun(batchId) {
  return usesDirectus() ? getDirectusBatchRun(batchId) : getJsonBatchRun(batchId);
}

export async function deleteBatchRun(batchId) {
  return usesDirectus() ? deleteDirectusBatchRun(batchId) : deleteJsonBatchRun(batchId);
}

export async function listBatchRuns(options) {
  return usesDirectus() ? listDirectusBatchRuns(options) : listJsonBatchRuns(options);
}

export async function saveQaTask(input) {
  return usesDirectus() ? saveDirectusQaTask(input) : saveJsonQaTask(input);
}

export async function getQaTask(id) {
  return usesDirectus() ? getDirectusQaTask(id) : getJsonQaTask(id);
}

export async function listQaTasks(options) {
  return usesDirectus() ? listDirectusQaTasks(options) : listJsonQaTasks(options);
}

export async function deleteQaTask(id) {
  return usesDirectus() ? deleteDirectusQaTask(id) : deleteJsonQaTask(id);
}

export async function saveBackgroundTask(input) {
  return usesDirectus() ? saveDirectusBackgroundTask(input) : saveJsonBackgroundTask(input);
}

export async function getBackgroundTask(id) {
  return usesDirectus() ? getDirectusBackgroundTask(id) : getJsonBackgroundTask(id);
}

export async function listBackgroundTasks(options) {
  return usesDirectus() ? listDirectusBackgroundTasks(options) : listJsonBackgroundTasks(options);
}

export async function deleteBackgroundTask(id) {
  return usesDirectus() ? deleteDirectusBackgroundTask(id) : deleteJsonBackgroundTask(id);
}

/** `scope` narrows styleProfiles by contentType/domain and userProfiles by projectId. */
export async function listStyleProfiles(locale, status, scope = null) {
  return usesDirectus() ? listDirectusStyleProfiles(locale, status, scope) : listJsonStyleProfiles(locale, status, scope);
}

export async function listPendingQaCases(locale, options = {}) {
  return usesDirectus() ? listDirectusPendingQaCases(locale, options) : listJsonPendingQaCases(locale, options);
}

export async function disposeQaCase(id) {
  return usesDirectus() ? disposeDirectusQaCase(id) : disposeJsonQaCase(id);
}

/** Look up one style profile or translator profile by id, across every locale. */
export async function findStyleProfile(id) {
  if (usesDirectus()) return findDirectusStyleProfile(id);
  const located = await locateJsonStyleProfile(id);
  // kind 让调用方能区分风格规范与译者画像：两者只有前者参与配对评测。
  return located ? { ...located.target, kind: located.kind || "style" } : null;
}

/** Attach (or clear, with null) the paired-benchmark conclusion for a style draft. */
/** 就地改写某份风格规范的规则集（不新建版本），供人工处置规则冲突使用。 */
export async function updateStyleProfileRules(id, patch) {
  return usesDirectus() ? updateDirectusStyleProfileRules(id, patch) : updateJsonStyleProfileRules(id, patch);
}

/** 删除一个技能版本（生效版本由调用方拦住）。 */
export async function deleteTranslationSkill(id) {
  return usesDirectus() ? deleteDirectusTranslationSkill(id) : deleteJsonTranslationSkill(id);
}

/** 删除一个自动蒸馏出的风格规范版本（生效版本由调用方拦住）。 */
export async function deleteStyleProfile(id) {
  return usesDirectus() ? deleteDirectusStyleProfile(id) : deleteJsonStyleProfile(id);
}

/** 删除人工导入的风格指南（整篇文档）。 */
export async function deleteUserProfile(id) {
  return usesDirectus() ? deleteDirectusUserProfile(id) : deleteJsonUserProfile(id);
}

export async function saveStyleProfileEvaluation(id, evaluation) {
  return usesDirectus() ? saveDirectusStyleProfileEvaluation(id, evaluation) : saveJsonStyleProfileEvaluation(id, evaluation);
}

export async function activateStyleProfile(id) {
  return usesDirectus() ? activateDirectusStyleProfile(id) : activateJsonStyleProfile(id);
}

export async function rejectStyleProfile(id) {
  return usesDirectus() ? rejectDirectusStyleProfile(id) : rejectJsonStyleProfile(id);
}

export async function getQaCases(locale, options) {
  return usesDirectus() ? getDirectusQaCases(locale, options) : getJsonQaCases(locale, options);
}

export async function findQaCase(id) {
  return usesDirectus() ? findDirectusQaCase(id) : findJsonQaCase(id);
}

export async function saveLearningTrajectory(input) {
  return usesDirectus() ? saveDirectusLearningTrajectory(input) : saveJsonLearningTrajectory(input);
}

export async function listLearningTrajectories(filters) {
  return usesDirectus() ? listDirectusLearningTrajectories(filters) : listJsonLearningTrajectories(filters);
}

export async function countLearningTrajectoriesByScope(filters) {
  return usesDirectus() ? countDirectusLearningTrajectoriesByScope(filters) : countJsonLearningTrajectoriesByScope(filters);
}

/** 记忆库文件层：每个来源文件的学习轨迹条数与其中的人工终稿条数。 */
export async function countLearningTrajectoriesByFile(filters) {
  return usesDirectus() ? countDirectusLearningTrajectoriesByFile(filters) : countJsonLearningTrajectoriesByFile(filters);
}

export async function getLearningTrajectory(id) {
  return usesDirectus() ? getDirectusLearningTrajectory(id) : getJsonLearningTrajectory(id);
}

export async function updateLearningTrajectory(id, patch) {
  return usesDirectus() ? updateDirectusLearningTrajectory(id, patch) : updateJsonLearningTrajectory(id, patch);
}

export async function saveQualityAsset(input) {
  return usesDirectus() ? saveDirectusQualityAsset(input) : saveJsonQualityAsset(input);
}

export async function listQualityAssets(filters) {
  return usesDirectus() ? listDirectusQualityAssets(filters) : listJsonQualityAssets(filters);
}

export async function getQualityAsset(id) {
  return usesDirectus() ? getDirectusQualityAsset(id) : getJsonQualityAsset(id);
}

export async function updateQualityAsset(id, patch) {
  return usesDirectus() ? updateDirectusQualityAsset(id, patch) : updateJsonQualityAsset(id, patch);
}

export async function saveQualityRun(input) {
  return usesDirectus() ? saveDirectusQualityRun(input) : saveJsonQualityRun(input);
}

export async function listQualityRuns(filters) {
  return usesDirectus() ? listDirectusQualityRuns(filters) : listJsonQualityRuns(filters);
}

export async function updateQualityRun(id, patch) {
  return usesDirectus() ? updateDirectusQualityRun(id, patch) : updateJsonQualityRun(id, patch);
}

export async function saveTrainingRun(input) {
  return usesDirectus() ? saveDirectusTrainingRun(input) : saveJsonTrainingRun(input);
}

export async function listTrainingRuns(filters) {
  return usesDirectus() ? listDirectusTrainingRuns(filters) : listJsonTrainingRuns(filters);
}

export async function getTrainingRun(id) {
  return usesDirectus() ? getDirectusTrainingRun(id) : getJsonTrainingRun(id);
}

export async function saveTranslationSkill(input) {
  return usesDirectus() ? saveDirectusTranslationSkill(input) : saveJsonTranslationSkill(input);
}

export async function listTranslationSkills(filters) {
  return usesDirectus() ? listDirectusTranslationSkills(filters) : listJsonTranslationSkills(filters);
}

export async function getTranslationSkill(id) {
  return usesDirectus() ? getDirectusTranslationSkill(id) : getJsonTranslationSkill(id);
}

export async function updateTranslationSkill(id, patch) {
  return usesDirectus() ? updateDirectusTranslationSkill(id, patch) : updateJsonTranslationSkill(id, patch);
}

export async function activateTranslationSkill(id) {
  return usesDirectus() ? activateDirectusTranslationSkill(id) : activateJsonTranslationSkill(id);
}

export async function rollbackTranslationSkill(id) {
  return usesDirectus() ? rollbackDirectusTranslationSkill(id) : rollbackJsonTranslationSkill(id);
}

export async function saveSkillEvaluation(input) {
  return usesDirectus() ? saveDirectusSkillEvaluation(input) : saveJsonSkillEvaluation(input);
}

export async function listSkillEvaluations(filters) {
  return usesDirectus() ? listDirectusSkillEvaluations(filters) : listJsonSkillEvaluations(filters);
}

export async function getSkillEvaluation(id) {
  return usesDirectus() ? getDirectusSkillEvaluation(id) : getJsonSkillEvaluation(id);
}

export async function updateSkillEvaluation(id, patch) {
  return usesDirectus() ? updateDirectusSkillEvaluation(id, patch) : updateJsonSkillEvaluation(id, patch);
}

// ---------------------------------------------------------------------------
// 参考资料：文档 + 片段。参考资料不参与每次翻译的提示词注入，只在模型主动
// 查询时按片段返回，因此存储层只需要提供"按项目取全部片段"给检索索引使用。
// ---------------------------------------------------------------------------

const REFERENCE_KIND_VALUES = new Set(["character", "script", "synopsis", "setting", "other"]);
const REFERENCE_STATUS_VALUES = new Set(["indexing", "ready", "failed", "disabled"]);

function referenceDocumentRecord(input = {}, existing = null) {
  const now = new Date().toISOString();
  return {
    id: String(input.id ?? existing?.id ?? randomUUID()),
    projectId: String(input.projectId ?? existing?.projectId ?? "").trim(),
    libraryId: String(input.libraryId ?? existing?.libraryId ?? "").trim(),
    folderId: String(input.folderId ?? existing?.folderId ?? "").trim(),
    name: String(input.name ?? existing?.name ?? "未命名资料").trim().slice(0, 200) || "未命名资料",
    kind: REFERENCE_KIND_VALUES.has(input.kind) ? input.kind : (existing?.kind || "other"),
    contentType: String(input.contentType ?? existing?.contentType ?? "").trim(),
    domain: String(input.domain ?? existing?.domain ?? "").trim(),
    sourceFile: String(input.sourceFile ?? existing?.sourceFile ?? "").trim().slice(0, 200),
    sourceFormat: String(input.sourceFormat ?? existing?.sourceFormat ?? "").trim(),
    characters: Math.max(0, Math.trunc(Number(input.characters ?? existing?.characters) || 0)),
    chunkCount: Math.max(0, Math.trunc(Number(input.chunkCount ?? existing?.chunkCount) || 0)),
    status: REFERENCE_STATUS_VALUES.has(input.status) ? input.status : (existing?.status || "indexing"),
    error: String(input.error ?? existing?.error ?? "").slice(0, 1_000),
    ingestReport: input.ingestReport ?? existing?.ingestReport ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function referenceFolderRecord(input = {}, existing = null) {
  const now = new Date().toISOString();
  return {
    id: String(input.id ?? existing?.id ?? randomUUID()),
    projectId: String(input.projectId ?? existing?.projectId ?? "").trim(),
    parentId: String(input.parentId ?? existing?.parentId ?? "").trim(),
    name: String(input.name ?? existing?.name ?? "新建文件夹").trim().slice(0, 200) || "新建文件夹",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function referenceChunkRecord(input = {}, documentId, projectId, ordinal) {
  const text = String(input.text ?? "").trim();
  return {
    id: String(input.id ?? randomUUID()),
    documentId: String(input.documentId ?? documentId),
    projectId: String(input.projectId ?? projectId ?? ""),
    ordinal: Number.isInteger(input.ordinal) ? input.ordinal : ordinal,
    heading: String(input.heading ?? "").slice(0, 200),
    page: String(input.page ?? "").slice(0, 40),
    origin: input.origin === "vision" ? "vision" : "text",
    text,
    characters: Math.max(0, Math.trunc(Number(input.characters) || [...text].length)),
    risk: input.risk === true,
    allowed: input.allowed === true,
    embedding: input.embedding ?? null,
    createdAt: input.createdAt || new Date().toISOString()
  };
}

async function saveJsonReferenceFolder(input = {}) {
  const path = join(ROOT, "references", "folders.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const id = String(input.id ?? "");
    const existing = id ? items.find((item) => item.id === id) : null;
    const record = referenceFolderRecord(input, existing);
    if (existing) items[items.indexOf(existing)] = record;
    else items.unshift(record);
    await writeJsonAtomic(path, items);
    return record;
  });
}

/**
 * 只更新运行记录的附加内容（目前只有复盘报告）。
 * 结论、计数与资产版本是留档的一部分，改它们等于篡改门禁结论，这里一律不碰。
 */
async function updateJsonQualityRun(id, patch = {}) {
  const path = learningPath("quality-runs.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const index = items.findIndex((item) => String(item.id) === String(id));
    if (index < 0) return null;
    const current = items[index];
    items[index] = {
      ...current,
      report: { ...jsonObject(current.report, {}), ...jsonObject(patch.report, {}) }
    };
    await writeJsonAtomic(path, items);
    return items[index];
  });
}

async function getJsonReferenceFolder(id) {
  const items = await readJson(join(ROOT, "references", "folders.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function listJsonReferenceFolders({ projectId = "", limit = 5_000 } = {}) {
  const items = await readJson(join(ROOT, "references", "folders.json"), []);
  const filtered = items
    .filter((item) => !projectId || item.projectId === String(projectId))
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "zh-CN", { numeric: true })
      || String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
  return Number(limit) > 0 ? filtered.slice(0, Number(limit)) : filtered;
}

async function deleteJsonReferenceFolder(id) {
  const folderId = String(id);
  const path = join(ROOT, "references", "folders.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const next = items.filter((item) => item.id !== folderId);
    if (next.length === items.length) return false;
    await writeJsonAtomic(path, next);
    return true;
  });
}

async function saveJsonReferenceDocument(input) {
  const path = join(ROOT, "references", "documents.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const id = String(input.id ?? "");
    const existing = id ? items.find((item) => item.id === id) : null;
    const record = referenceDocumentRecord(input, existing);
    if (existing) items[items.indexOf(existing)] = record;
    else items.unshift(record);
    await writeJsonAtomic(path, items);
    return record;
  });
}

async function getJsonReferenceDocument(id) {
  const items = await readJson(join(ROOT, "references", "documents.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function listJsonReferenceDocuments({
  projectId = "",
  libraryId = "",
  folderId = "",
  folderIds = null,
  status = "",
  search = "",
  offset = 0,
  limit = 50
} = {}) {
  const items = await readJson(join(ROOT, "references", "documents.json"), []);
  const keyword = String(search || "").trim().toLowerCase();
  const folderSet = Array.isArray(folderIds) ? new Set(folderIds.map(String)) : null;
  const filtered = items
    .filter((item) => (!projectId || item.projectId === projectId)
      && (!libraryId || item.libraryId === libraryId)
      && (!folderSet ? (!folderId || item.folderId === String(folderId)) : folderSet.has(String(item.folderId || "")))
      && (!status || item.status === status)
      && (!keyword || String(item.name || "").toLowerCase().includes(keyword) || String(item.sourceFile || "").toLowerCase().includes(keyword)))
    .sort((a, b) => String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || "")));
  const start = Math.max(0, Number(offset) || 0);
  const take = Number(limit) > 0 ? Math.min(1_000, Number(limit)) : filtered.length;
  return { total: filtered.length, items: filtered.slice(start, start + take) };
}

async function updateJsonReferenceDocument(id, patch = {}) {
  const path = join(ROOT, "references", "documents.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const index = items.findIndex((item) => item.id === String(id));
    if (index < 0) return null;
    const record = referenceDocumentRecord({ ...patch, id: items[index].id }, items[index]);
    items[index] = record;
    await writeJsonAtomic(path, items);
    return record;
  });
}

async function deleteJsonReferenceDocument(id) {
  const documentId = String(id);
  const path = join(ROOT, "references", "documents.json");
  const removed = await withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const next = items.filter((item) => item.id !== documentId);
    if (next.length === items.length) return false;
    await writeJsonAtomic(path, next);
    return true;
  });
  if (!removed) return false;
  await replaceJsonReferenceChunks(documentId, { chunks: [] });
  return true;
}

async function replaceJsonReferenceChunks(documentId, { projectId = "", chunks = [] } = {}) {
  const path = join(ROOT, "references", "chunks.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const kept = items.filter((item) => item.documentId !== String(documentId));
    const created = (Array.isArray(chunks) ? chunks : []).map((chunk, index) => referenceChunkRecord(chunk, documentId, projectId, index));
    await writeJsonAtomic(path, [...kept, ...created]);
    return created.length;
  });
}

async function listJsonReferenceChunks({ documentId = "", projectId = "", offset = 0, limit = 200 } = {}) {
  const items = await readJson(join(ROOT, "references", "chunks.json"), []);
  const filtered = items
    .filter((item) => (!documentId || item.documentId === String(documentId)) && (!projectId || item.projectId === projectId))
    .sort((a, b) => (a.documentId === b.documentId ? a.ordinal - b.ordinal : String(a.documentId).localeCompare(String(b.documentId))));
  return { total: filtered.length, items: filtered.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit)) };
}

async function listJsonReferenceChunksForProject(projectId, { limit = 5_000 } = {}) {
  const items = await readJson(join(ROOT, "references", "chunks.json"), []);
  return items.filter((item) => item.projectId === String(projectId)).slice(0, Math.max(1, limit));
}

async function updateJsonReferenceChunk(id, patch = {}) {
  const path = join(ROOT, "references", "chunks.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const index = items.findIndex((item) => item.id === String(id));
    if (index < 0) return null;
    const updated = { ...items[index], ...patch, id: items[index].id };
    items[index] = updated;
    await writeJsonAtomic(path, items);
    return updated;
  });
}

export async function saveReferenceDocument(input) {
  return usesDirectus() ? saveDirectusReferenceDocument(input) : saveJsonReferenceDocument(input);
}

export async function saveReferenceFolder(input) {
  return usesDirectus() ? saveDirectusReferenceFolder(input) : saveJsonReferenceFolder(input);
}

export async function getReferenceFolder(id) {
  return usesDirectus() ? getDirectusReferenceFolder(id) : getJsonReferenceFolder(id);
}

export async function listReferenceFolders(options) {
  return usesDirectus() ? listDirectusReferenceFolders(options) : listJsonReferenceFolders(options);
}

export async function deleteReferenceFolder(id) {
  return usesDirectus() ? deleteDirectusReferenceFolder(id) : deleteJsonReferenceFolder(id);
}

export async function getReferenceDocument(id) {
  return usesDirectus() ? getDirectusReferenceDocument(id) : getJsonReferenceDocument(id);
}

export async function listReferenceDocuments(options) {
  return usesDirectus() ? listDirectusReferenceDocuments(options) : listJsonReferenceDocuments(options);
}

export async function updateReferenceDocument(id, patch) {
  return usesDirectus() ? updateDirectusReferenceDocument(id, patch) : updateJsonReferenceDocument(id, patch);
}

export async function deleteReferenceDocument(id) {
  return usesDirectus() ? deleteDirectusReferenceDocument(id) : deleteJsonReferenceDocument(id);
}

export async function replaceReferenceChunks(documentId, input) {
  return usesDirectus() ? replaceDirectusReferenceChunks(documentId, input) : replaceJsonReferenceChunks(documentId, input);
}

export async function listReferenceChunks(options) {
  return usesDirectus() ? listDirectusReferenceChunks(options) : listJsonReferenceChunks(options);
}

export async function listReferenceChunksForProject(projectId, options) {
  return usesDirectus() ? listDirectusReferenceChunksForProject(projectId, options) : listJsonReferenceChunksForProject(projectId, options);
}

export async function updateReferenceChunk(id, patch) {
  return usesDirectus() ? updateDirectusReferenceChunk(id, patch) : updateJsonReferenceChunk(id, patch);
}

export function getStoreMetadata() {
  return usesDirectus()
    ? getDirectusMetadata()
    : { type: "json", label: "Local JSON", url: null, adminUrl: null, collections: null };
}

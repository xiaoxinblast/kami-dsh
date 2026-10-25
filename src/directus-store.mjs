import { summarizeBatchSegments } from "../public/batch-status.js";
import { runtimeOptions } from "./runtime-context.mjs";
import { createHash, randomUUID } from "node:crypto";
import { ACTIVE_LOCALES, assertLocale } from "./config.mjs";
import { embedSource, embeddingModelName } from "./embedding.mjs";
import { fetchWithTimeout } from "./provider.mjs";
import { sanitizeProjectSettings } from "./project-config.mjs";
import { memoryMatchAttempts, memorySourceHash, normalizeMemoryText, styleEvidenceMatch } from "./translation-memory.mjs";
import { scopeFallbackChain, scopeRankOf } from "./scope-fallback.mjs";
import { summarizeQualityTiers } from "./quality-tier.mjs";

/** 按降级链挑第一份命中的风格规范（同语体同领域 → … → 通用×通用）。 */
function pickProfileByScope(items = [], { contentType = "general", domain = "general" } = {}) {
  for (const entry of scopeFallbackChain(contentType, domain)) {
    const hit = items.find((item) => (item.content_type || "general") === entry.contentType && (item.domain || "general") === entry.domain);
    if (hit) return { ...hit, scopeRank: entry.rank };
  }
  return null;
}

export const LOCALE_COLLECTIONS = Object.freeze({
  "zh-CN": "terms_zh_cn",
  "ja-JP": "terms_ja_jp",
  "ko-KR": "terms_ko_kr",
  "zh-Hant-TW": "terms_zh_hant_tw",
  "fr-FR": "terms_fr_fr",
  "th-TH": "terms_th_th"
});

export const MEMORY_COLLECTIONS = Object.freeze({
  "zh-CN": "translation_memory_zh_cn",
  "ja-JP": "translation_memory_ja_jp",
  "ko-KR": "translation_memory_ko_kr",
  "zh-Hant-TW": "translation_memory_zh_hant_tw",
  "fr-FR": "translation_memory_fr_fr",
  "th-TH": "translation_memory_th_th"
});

export const PROJECT_COLLECTION = "localization_projects";
export const RESOURCE_LIBRARY_COLLECTION = "project_resource_libraries";

// Directus is configured for 128 MB on localhost. There is no arbitrary item
// count limit; the 64 MB fallback only protects a single HTTP request if the
// spreadsheet upload ceiling is raised in the future.
const DIRECTUS_WRITE_CHUNK_BYTES = 64 * 1024 * 1024;
const DIRECTUS_WRITE_CHUNK_ITEMS = Number.POSITIVE_INFINITY;
const DIRECTUS_BULK_WRITE_TIMEOUT_MS = 120_000;

export function chunkDirectusRecords(records, {
  maxBytes = DIRECTUS_WRITE_CHUNK_BYTES,
  maxItems = DIRECTUS_WRITE_CHUNK_ITEMS
} = {}) {
  const chunks = [];
  let chunk = [];
  let chunkBytes = 2;

  for (const record of records || []) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const separatorBytes = chunk.length ? 1 : 0;
    if (chunk.length && (chunk.length >= maxItems || chunkBytes + separatorBytes + recordBytes > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(record);
    chunkBytes += (chunk.length > 1 ? 1 : 0) + recordBytes;
  }

  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function config() {
  const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
  const token = process.env.DIRECTUS_TOKEN;
  if (!token) throw new Error("KAMI_STORE=directus requires DIRECTUS_TOKEN");
  return { baseUrl, token };
}

/** 只读请求遇到连接层失败时的尝试次数（写请求永远只发一次，避免重复写入）。 */
const DIRECTUS_READ_ATTEMPTS = 3;
/**
 * 核心读接口的超时。默认 10 秒在 Directus 冷缓存/大查询时会直接 500；
 * 任务中心、批次详情、术语库这些页面级读取给 30 秒，失败时还有上层降级兜底。
 * 单条/批量写入仍用各自更宽松的显式超时，不跟这个值。
 */
const DIRECTUS_READ_TIMEOUT_MS = 30_000;

async function request(path, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  if (runtimeOptions().store) return runtimeOptions().store.request(path, { method, body });
  const { baseUrl, token } = config();
  // 报错信息会被写进任务记录并显示在界面上：去掉查询串、截断长度，
  // 否则一条 431 里那几 KB 的过滤条件会把任务行撑爆。
  const plainPath = String(path).split("?")[0].slice(0, 80);
  const idempotent = method === "GET" || method === "HEAD";
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { response, text } = await fetchWithTimeout(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }, {
        timeoutMs,
        label: "Directus",
        // 只读请求连超时也补一次：Directus 偶发 stall（例如评测任务跑满时）不该直接变成 500。
        // 写请求绝不重试——超时可能只是响应慢，重试就会重复写入。
        ...(idempotent ? { retries: 1, retryDelayMs: 250 } : {})
      });
      let payload = null;
      if (response.status !== 204 && text) {
        try { payload = JSON.parse(text); } catch { payload = null; }
      }
      if (!response.ok) {
        const details = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
        const error = new Error(`Directus ${method} ${plainPath} 失败（${response.status}${details ? ` ${details.slice(0, 120)}` : ""}）`);
        error.statusCode = response.status >= 500 ? 503 : response.status;
        throw error;
      }
      return payload?.data ?? payload;
    } catch (error) {
      // 工作台到 Directus 的连接会偶发被对端掐断（复用中的 keep-alive 连接受限、
      // Directus 重启、容器抖动），undici 报的是 TypeError: fetch failed。
      // 这类抖动不该把只读接口变成 500：重试两次。写请求与业务错误一律直接抛出。
      const connectionFailure = error?.name === "TypeError";
      // Directus 压力保护（503 Under pressure）只是"太忙"，读请求退避重试不会多写；
      // 否则一次瞬时压力就会把正在跑的长任务（批次翻译/进度保存）判死。
      const busy = isDirectusBusy(error);
      if (!idempotent || (!connectionFailure && !busy) || attempt >= DIRECTUS_READ_ATTEMPTS) {
        // 日志里只写一句 fetch failed 没法定位，把 undici 的 cause 带出来。
        if (connectionFailure && error.cause) {
          error.message = `Directus ${method} ${plainPath} 连接失败（${error.cause.code || error.cause.message || "unknown"}）`;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, busy ? 600 * attempt : 120 * attempt));
    }
  }
}

/**
 * Directus 压力保护（503 `Service "api" is unavailable. Under pressure.`）是"我很忙"：
 * 请求在进库之前就被挡回来了，重试不会写入两次。大表导入要发几百个 POST，
 * 一次 503 就把整批 8 万条判死刑实在不值，所以这里对 503 退避重试。
 * 其它错误（400/500/连接断开）照旧一次就抛：那些可能已经写进去了。
 */
const BULK_WRITE_BUSY_RETRIES = 3;

function isDirectusBusy(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  return Number(error?.status) === 503 || /Under pressure|Service "api" is unavailable/u.test(text);
}

async function createItemsInChunks(path, records, { onProgress, maxItems } = {}) {
  const saved = [];
  for (const chunk of chunkDirectusRecords(records, maxItems ? { maxItems } : undefined)) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await request(path, { method: "POST", body: chunk, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
        saved.push(...(Array.isArray(result) ? result : [result]));
        onProgress?.({ completed: saved.length, total: records.length });
        break;
      } catch (error) {
        if (!isDirectusBusy(error) || attempt > BULK_WRITE_BUSY_RETRIES) {
          error.createdItems = saved;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
      }
    }
  }
  return saved;
}

async function updateItemsInChunks(path, records) {
  for (const chunk of chunkDirectusRecords(records, { maxItems: BULK_INSERT_CHUNK_ITEMS })) {
    await request(path, { method: "PATCH", body: chunk, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
  }
}

/**
 * 按主键批量删除。Directus 支持 `DELETE /items/:collection` + body `{"keys":[...]}`（一次 204），
 * 比"逐条 DELETE"快两个数量级——替换上一批 7 万行审计时，逐条删要几分钟。
 */
async function deleteItemsByKeys(collection, keys, { chunkSize = 5_000 } = {}) {
  const ids = (Array.isArray(keys) ? keys : []).map((key) => String(key || "")).filter(Boolean);
  if (!ids.length) return 0;
  for (const chunk of chunkList(ids, chunkSize)) {
    await request(`/items/${collection}`, { method: "DELETE", body: { keys: chunk }, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
  }
  return ids.length;
}

async function candidateIdsForBatch(batchId) {
  const params = new URLSearchParams({
    limit: "-1",
    fields: "id",
    filter: JSON.stringify({ batch_id: { _eq: batchId } })
  });
  const items = await request(`/items/term_candidates?${params}`);
  return items.map((item) => item.id).filter(Boolean);
}

function collectionFor(locale) {
  assertLocale(locale);
  return LOCALE_COLLECTIONS[locale];
}

function memoryCollectionFor(locale) {
  assertLocale(locale);
  return MEMORY_COLLECTIONS[locale];
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function toTerm(item) {
  return {
    id: item.id,
    source: item.source,
    aliases: arrayValue(item.aliases),
    target: item.target,
    forbidden: arrayValue(item.forbidden),
    domains: arrayValue(item.domains),
    contentTypes: arrayValue(item.content_types),
    contentTags: arrayValue(item.content_tags),
    enforcement: item.enforcement || "preferred",
    note: item.note || "",
    status: item.status || "observed",
    provenance: item.provenance || "directus",
    assetTier: item.asset_tier || (item.status === "approved" ? "formal" : "candidate"),
    caseSensitive: Boolean(item.case_sensitive),
    preserveOriginal: Boolean(item.preserve_original),
    version: Number(item.version) || 1,
    versionGroupId: item.version_group_id || "",
    lifecycleStatus: item.lifecycle_status || "active",
    validFrom: item.valid_from || null,
    validTo: item.valid_to || null,
    projects: arrayValue(item.projects),
    channels: arrayValue(item.channels),
    platforms: arrayValue(item.platforms),
    regions: arrayValue(item.regions),
    projectId: item.project_id || "",
    libraryId: item.library_id || "",
    supersededBy: item.superseded_by || "",
    createdAt: item.date_created,
    updatedAt: item.date_updated
  };
}

function toDirectusTerm(input) {
  return {
    ...(input.id ? { id: input.id } : {}),
    source: String(input.source || "").trim(),
    aliases: [...new Set((input.aliases || []).map((item) => String(item).trim()).filter(Boolean))],
    target: String(input.target || "").trim(),
    forbidden: [...new Set((input.forbidden || []).map((item) => String(item).trim()).filter(Boolean))],
    domains: [...new Set((input.domains || ["general"]).filter(Boolean))],
    content_types: [...new Set((input.contentTypes || ["general"]).filter(Boolean))],
    content_tags: [...new Set((input.contentTags || []).filter(Boolean))],
    enforcement: input.enforcement || "preferred",
    note: String(input.note || "").trim(),
    status: input.status || "approved",
    provenance: input.provenance || "kami-workbench",
    asset_tier: input.assetTier || (input.status === "approved" || !input.status ? "formal" : "candidate"),
    case_sensitive: Boolean(input.caseSensitive),
    preserve_original: Boolean(input.preserveOriginal),
    version: Math.max(1, Number(input.version) || 1),
    version_group_id: input.versionGroupId || "",
    lifecycle_status: input.lifecycleStatus || "active",
    valid_from: input.validFrom || null,
    valid_to: input.validTo || null,
    projects: input.projects || [],
    channels: input.channels || [],
    platforms: input.platforms || [],
    regions: input.regions || [],
    project_id: input.projectId || "",
    library_id: input.libraryId || "",
    superseded_by: input.supersededBy || ""
  };
}

/**
 * Directus 对"条目不存在"和"无权访问"一律返回 403 FORBIDDEN，从不返回 404
 * ——这是它刻意的设计，避免用 404/403 的差别泄露某个 id 是否存在。
 *
 * 代码里十处"取不到就当没有"的判断原本只认 404，于是全部失效。最直接的后果是
 * 激活译者画像：先查 style_profiles 拿到 403，本该回退去查 user_profiles，
 * 却把 403 当成真错误抛给了用户。
 *
 * 把两者一并视为"没有这条"。代价是真正的权限配置错误也会被当成不存在，因此
 * 服务账号的权限由 provision 统一保证，出问题时看 provision 输出而不是这里。
 */
function isMissingItem(error) {
  return [403, 404].includes(Number(error?.statusCode));
}

export async function initializeDirectusStore() {
  if (runtimeOptions().store) return;
  const health = await fetch(`${config().baseUrl}/server/ping`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`Directus health check failed (${health.status})`);
  await Promise.all([
    PROJECT_COLLECTION,
    RESOURCE_LIBRARY_COLLECTION,
    ...ACTIVE_LOCALES.map((locale) => LOCALE_COLLECTIONS[locale]),
    ...ACTIVE_LOCALES.map((locale) => MEMORY_COLLECTIONS[locale]),
    "style_learning_runs",
    "learning_trajectories",
    "translation_skills",
    "skill_evaluations"
  ].map((collection) => request(`/items/${collection}?limit=1&fields=id`)));
}

/**
 * 记忆库列表与计数共用的 Directus 过滤条件。
 *
 * contentType / domain 传 "general"（默认）表示不按语体/领域收窄，语义与读取后的 JS 过滤一致；
 * search 同时匹配日语原文与简体中文译文。
 */
/**
 * 记忆检索的过滤条件。语体与领域**不再参与过滤**（只作参考与排序加权），
 * 因此这里只按项目收窄；调用方传来的 contentType/domain 仅用于计算 scopeRank。
 */
function applyMemoryFilters(params, { projectId = "", search = "" } = {}) {
  let group = 0;
  const nextGroup = () => `filter[_and][${group++}]`;
  if (projectId) params.set(`${nextGroup()}[project_id][_eq]`, String(projectId));
  if (search) {
    const base = nextGroup();
    params.set(`${base}[_or][0][source][_icontains]`, String(search));
    params.set(`${base}[_or][1][target][_icontains]`, String(search));
  }
  return params;
}

/** 记忆行的字段清单：列表、按 id 取回两条路径共用，避免字段口径漂移。 */
const DIRECTUS_MEMORY_FIELDS = "id,source,target,domain,content_type,content_tags,channel,style_profile_id,quality_status,qa_score,provenance,source_file,batch_id,source_row,entry_id,entry_key,previous_source,next_source,embedding,asset_tier,version,version_group_id,lifecycle_status,valid_from,valid_to,project,project_id,library_id,campaign,platform,region,audience,superseded_by,date_created,date_updated";

/** Directus 行 → 内部记忆对象。 */
function mapDirectusMemory(item, { contentType = "general", domain = "general", scopeFallback = false } = {}) {
  return {
    // 降级链上的档位：0 同语体同领域 … 3 通用×通用，排序时由它决定加成。
    ...(scopeFallback ? { scopeRank: scopeRankOf({ contentType: item.content_type, domain: item.domain }, { contentType, domain }) } : {}),
    id: item.id,
    source: item.source,
    target: item.target,
    entryId: item.entry_id || "",
    entryKey: item.entry_key || "",
    previousSource: item.previous_source || "",
    nextSource: item.next_source || "",
    domain: item.domain || "general",
    contentType: item.content_type || "general",
    contentTags: arrayValue(item.content_tags),
    channel: item.channel || "",
    styleProfileId: item.style_profile_id || "",
    qualityStatus: item.quality_status || "provisional",
    qaScore: Number(item.qa_score) || 0,
    provenance: item.provenance || "directus",
    assetTier: item.asset_tier || (item.quality_status === "human_approved" ? "formal" : item.quality_status === "machine_verified" ? "working" : "candidate"),
    version: Number(item.version) || 1,
    versionGroupId: item.version_group_id || "",
    lifecycleStatus: item.lifecycle_status || "active",
    validFrom: item.valid_from || null,
    validTo: item.valid_to || null,
    project: item.project || "",
    projectId: item.project_id || item.project || "",
    libraryId: item.library_id || "",
    campaign: item.campaign || "",
    platform: item.platform || "",
    region: item.region || "",
    audience: item.audience || "",
    supersededBy: item.superseded_by || "",
    sourceFile: item.source_file || "",
    batchId: item.batch_id || "",
    sourceRow: item.source_row || null,
    embedding: item.embedding || null,
    createdAt: item.date_created,
    updatedAt: item.date_updated
  };
}

export async function getDirectusMemories(locale, { contentType = "general", domain = "general", limit = 500, offset = 0, search = "", exactContentType = false, scopeFallback = false, projectId = "" } = {}) {
  const collection = memoryCollectionFor(locale);
  const directusLimit = Number(limit) <= 0 ? "-1" : String(Math.min(1000, limit));
  // 按 date_created 排序，不用 date_updated：date_updated 允许为空，而 Postgres 的 DESC
  // 把 NULL 排在最前面，会把真正最新的记忆挤出列表。
  const params = new URLSearchParams({ limit: directusLimit, sort: "-date_created", fields: DIRECTUS_MEMORY_FIELDS });
  const start = Math.max(0, Math.trunc(Number(offset)) || 0);
  if (start > 0) params.set("offset", String(start));
  applyMemoryFilters(params, { projectId, contentType, domain, exactContentType, scopeFallback, search });
  // 语体/领域不再过滤：同项目内所有记忆都进入候选池，是否同范围只影响排序加成。
  const items = await request(`/items/${collection}?${params}`);
  return items.map((item) => mapDirectusMemory(item, { contentType, domain, scopeFallback }));
}

/**
 * 候选索引用的精简行：只要 id / 原文 / 库归属。
 * 不取 embedding（每行 2KB，8 万条就是 160MB+），索引里只留选候选需要的东西。
 */
export async function listDirectusMemoryIndexRows(locale, { projectId = "" } = {}) {
  const collection = memoryCollectionFor(locale);
  // 固定按 id 排序：候选同分也按 id 打破平局，增量索引与全量重建必须给出同一批候选。
  const params = new URLSearchParams({ limit: "-1", sort: "id", fields: "id,source,library_id,quality_status,project_id" });
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  else params.set("filter[project_id][_empty]", "true");
  const items = await request(`/items/${collection}?${params}`, { timeoutMs: 120_000 });
  return items.map((item) => ({
    id: item.id,
    source: item.source || "",
    libraryId: item.library_id || "",
    qualityStatus: item.quality_status || "provisional",
    projectId: item.project_id || ""
  }));
}

/**
 * 按 id 取回候选行（含向量）：候选池只有几百条，比整库传输小两个数量级。
 *
 * 每批 200 个 id：1000 条候选只要 5 次往返，而 40 条一批要 25 次——
 * 真机上后者是这段的主要耗时（每次 20–40ms）。id 是 UUID，200 个约 7.4KB URL，Directus 能收。
 */
export async function getDirectusMemoriesByIds(locale, ids = [], { contentType = "general", domain = "general", scopeFallback = false, chunkSize = 200 } = {}) {
  const collection = memoryCollectionFor(locale);
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))];
  if (!unique.length) return [];
  const items = [];
  for (const chunk of chunkList(unique, chunkSize)) {
    const params = new URLSearchParams({
      limit: "-1",
      fields: DIRECTUS_MEMORY_FIELDS,
      filter: JSON.stringify({ id: { _in: chunk } })
    });
    items.push(...await request(`/items/${collection}?${params}`));
  }
  return items.map((item) => mapDirectusMemory(item, { contentType, domain, scopeFallback }));
}

/**
 * 记忆库总数：列表页要显示"已显示 N / 共 M 条"，这里走 aggregate 只取计数，不拉数据。
 * 过滤条件与 getDirectusMemories 共用，保证列表长度和总数口径一致。
 */
export async function countDirectusMemories(locale, options = {}) {
  const collection = memoryCollectionFor(locale);
  const params = applyMemoryFilters(new URLSearchParams(), options);
  params.set("aggregate[count]", "id");
  const rows = await request(`/items/${collection}?${params}`);
  const value = rows?.[0]?.count?.id ?? rows?.[0]?.count ?? 0;
  return Number(value) || 0;
}

/**
 * 一条翻译记忆的写入体。单条写入与批量写入共用同一份口径，
 * 避免"批量导入时少写一个字段"这类只有大批量才暴露的偏差。
 */
function directusMemoryBody(input, { source, target, embedding }) {
  return {
    source,
    target,
    entry_id: String(input.entryId || ""),
    // 条目身份：memoQ 的 x-mmq-context 等稳定 ID，用于"改稿重导覆盖原行"。
    entry_key: String(input.entryKey || ""),
    // 原文哈希：按"原文 + 译文"去重时用它查询，长度恒定，不受句段长短影响。
    source_hash: memorySourceHash(source),
    previous_source: String(input.previousSource || ""),
    next_source: String(input.nextSource || ""),
    domain: input.domain || "general",
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    channel: input.channel || "",
    style_profile_id: input.styleProfileId || "",
    quality_status: input.qualityStatus || "provisional",
    qa_score: Number(input.qaScore) || null,
    provenance: input.provenance || "kami-workbench",
    source_file: input.sourceFile || "",
    batch_id: input.batchId || "",
    source_row: Number(input.sourceRow) || null,
    asset_tier: input.assetTier || (input.qualityStatus === "human_approved" ? "formal" : input.qualityStatus === "machine_verified" ? "working" : "candidate"),
    version: Math.max(1, Number(input.version) || 1),
    version_group_id: input.versionGroupId || "",
    lifecycle_status: input.lifecycleStatus || "active",
    valid_from: input.validFrom || null,
    valid_to: input.validTo || null,
    project: input.project || "",
    project_id: input.projectId || "",
    library_id: input.libraryId || "",
    campaign: input.campaign || "",
    platform: input.platform || "",
    region: input.region || "",
    audience: input.audience || "",
    superseded_by: input.supersededBy || "",
    ...(embedding ? { embedding } : {})
  };
}

export async function saveDirectusMemory(locale, input) {
  const collection = memoryCollectionFor(locale);
  const source = String(input.source || "").trim();
  const target = String(input.target || "").trim();
  if (!source || !target) throw new Error("翻译记忆的日语原文和简体中文译文不能为空");
  const embedding = input.embedding ?? await embedSource(source);
  const scope = (params) => {
    if (input.projectId) params.set("filter[project_id][_eq]", String(input.projectId));
    else params.set("filter[project_id][_empty]", "true");
    if (input.libraryId) params.set("filter[library_id][_eq]", String(input.libraryId));
    return params;
  };
  // 先按条目 ID（memoQ x-mmq-context）找，命中就覆盖原行；再退回 (原文, 译文) 去重。
  // 原文用哈希查：整句塞进查询串会撞 Directus 的 431。
  let existing = [];
  for (const attempt of memoryMatchAttempts({ source, target, entryKey: input.entryKey })) {
    if (attempt.kind === "entry") {
      // 同 ID 还要同原文：memoQ 的 context ID 会在多个文件之间重复，只看 ID 会覆盖错别的文件。
      const entryParams = scope(new URLSearchParams({ limit: "50", fields: "id,quality_status,qa_score,source" }));
      entryParams.set("filter[entry_key][_eq]", attempt.entryKey);
      const rows = await request(`/items/${collection}?${entryParams}`);
      const matched = rows.find((item) => normalizeMemoryText(item.source) === normalizeMemoryText(attempt.source));
      existing = matched ? [matched] : [];
    } else {
      const pairParams = scope(new URLSearchParams({ limit: "50", fields: "id,quality_status,qa_score,source,target" }));
      // 原文归一化后可能是空串（整段只有 MQXLIFF 内联标签占位符，例如
      // `<tag id='tag-1' type='inline' desc='ph'/>`）。空串不能进 `_eq`：Directus 直接回
      // 400 "You can't filter for an empty string"，这条候选就会整条被跳过。
      // 空哈希改用它推荐的 `_empty`，去重口径不变。
      const sourceHash = memorySourceHash(attempt.source);
      if (sourceHash) pairParams.set("filter[source_hash][_eq]", sourceHash);
      else pairParams.set("filter[source_hash][_empty]", "true");
      const candidates = await request(`/items/${collection}?${pairParams}`);
      const matched = candidates.find((item) => normalizeMemoryText(item.source) === normalizeMemoryText(attempt.source)
        && normalizeMemoryText(item.target) === normalizeMemoryText(attempt.target));
      existing = matched ? [matched] : [];
    }
    if (existing[0]) break;
  }
  const body = directusMemoryBody(input, { source, target, embedding });
  const saved = existing[0]
    ? await request(`/items/${collection}/${existing[0].id}`, { method: "PATCH", body })
    : await request(`/items/${collection}`, { method: "POST", body });
  // 单条写入的返回值要够增量索引使用：项目/库归属缺失的话，写入后无法定位是哪条
  // 缓存的哪一行，只能退回整库重建（8 万行 22MB）。这里与 updateDirectusMemory 保持同一口径。
  return { ...toMemoryEntry(saved), locale };
}

/** 批量写入的分块大小，以及 `_in` 查重列表的长度上限（太长会把 URL 撑爆）。 */
const MEMORY_BULK_WRITE_ITEMS = 200;
const DIRECTUS_IN_QUERY_ITEMS = 40;

function chunkList(items = [], size = 1) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * 批量写入翻译记忆。
 *
 * 逐条"查重 + 写入"在一次导入里就是 2×N 次往返：8 万条要跑几十分钟。
 * 这里把两条查重路径（entry_key 精确、source_hash 原文哈希）合并成批量查询，
 * 命中的行仍然逐条 PATCH（覆盖语义与单条写入完全一致），其余走批量 POST。
 * 同一批里重复的键只写一行，后面的结果指向同一行——等同于单条实现里
 * "第二条查到刚写进去的那条并覆盖"的最终状态。
 *
 * 返回与入参等长的数组：成功是 `{ id, ... }`，失败是 `{ error }`，
 * 单条失败不会连累整批（调用方按行记账）。
 */
/** 命中已有行且这些字段全部一致时视为"重复未变"，不再 PATCH：重复导入否则会逐条更新几万次。 */
const MEMORY_MATCH_FIELDS = "id,source,target,entry_key,source_hash,entry_id,previous_source,next_source,domain,content_type,content_tags,quality_status,qa_score,provenance,source_file,source_row,asset_tier,project_id,library_id";
const MEMORY_COMPARE_KEYS = ["target", "entry_id", "entry_key", "source_hash", "previous_source", "next_source", "domain", "content_type", "content_tags", "quality_status", "qa_score", "provenance", "source_file", "source_row", "asset_tier", "project_id", "library_id"];

function sameMemoryField(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left || []) === JSON.stringify(right || []);
  if (left === null || left === undefined || left === "") return right === null || right === undefined || right === "";
  if (right === null || right === undefined || right === "") return false;
  return String(left) === String(right);
}

function memoryRowUnchanged(row, body) {
  return MEMORY_COMPARE_KEYS.every((key) => sameMemoryField(row?.[key], body?.[key]));
}

export async function saveDirectusMemories(locale, inputs = [], { onProgress } = {}) {
  const collection = memoryCollectionFor(locale);
  const results = new Array(inputs.length).fill(null);
  if (!inputs.length) return results;
  const scope = (params, input) => {
    if (input.projectId) params.set("filter[project_id][_eq]", String(input.projectId));
    else params.set("filter[project_id][_empty]", "true");
    if (input.libraryId) params.set("filter[library_id][_eq]", String(input.libraryId));
    return params;
  };
  const prepared = [];
  for (const [index, input] of inputs.entries()) {
    const source = String(input.source || "").trim();
    const target = String(input.target || "").trim();
    if (!source || !target) {
      results[index] = { error: "翻译记忆的日语原文和简体中文译文不能为空" };
      continue;
    }
    const embedding = input.embedding ?? await embedSource(source);
    prepared.push({
      index,
      input,
      source,
      target,
      embedding,
      hash: memorySourceHash(source),
      entryKey: String(input.entryKey || "").trim()
    });
  }
  const keyed = prepared.filter((item) => item.entryKey);
  const hashed = prepared.filter((item) => !item.entryKey && item.hash);
  const emptyHashed = prepared.filter((item) => !item.entryKey && !item.hash);
  const existingByEntryKey = new Map();
  for (const group of chunkList(keyed, DIRECTUS_IN_QUERY_ITEMS)) {
    const params = scope(new URLSearchParams({ limit: "-1", fields: MEMORY_MATCH_FIELDS }), group[0].input);
    params.set("filter[entry_key][_in]", [...new Set(group.map((item) => item.entryKey))].join(","));
    const rows = await request(`/items/${collection}?${params}`);
    for (const row of rows) existingByEntryKey.set(`${String(row.entry_key || "")}\u0000${normalizeMemoryText(row.source)}`, row);
  }
  const existingByPair = new Map();
  for (const group of chunkList(hashed, DIRECTUS_IN_QUERY_ITEMS)) {
    const params = scope(new URLSearchParams({ limit: "-1", fields: MEMORY_MATCH_FIELDS }), group[0].input);
    params.set("filter[source_hash][_in]", [...new Set(group.map((item) => item.hash))].join(","));
    const rows = await request(`/items/${collection}?${params}`);
    for (const row of rows) existingByPair.set(`${String(row.source_hash || "")}\u0000${normalizeMemoryText(row.source)}\u0000${normalizeMemoryText(row.target)}`, row);
  }
  // 空哈希（整段只有内联标签占位符）不能进 `_in`：Directus 会报 400/431，改用 `_empty`。
  if (emptyHashed.length) {
    const params = scope(new URLSearchParams({ limit: "-1", fields: MEMORY_MATCH_FIELDS }), emptyHashed[0].input);
    params.set("filter[source_hash][_empty]", "true");
    const rows = await request(`/items/${collection}?${params}`);
    for (const row of rows) existingByPair.set(`\u0000${normalizeMemoryText(row.source)}\u0000${normalizeMemoryText(row.target)}`, row);
  }
  const creates = [];
  const updates = [];
  const linkedTo = new Map();
  const claimed = new Map();
  for (const item of prepared) {
    const key = item.entryKey
      ? `k:${item.entryKey}\u0000${normalizeMemoryText(item.source)}`
      : `p:${item.hash || ""}\u0000${normalizeMemoryText(item.source)}\u0000${normalizeMemoryText(item.target)}`;
    const body = directusMemoryBody(item.input, item);
    const existingRow = item.entryKey
      ? existingByEntryKey.get(`${item.entryKey}\u0000${normalizeMemoryText(item.source)}`)
      : existingByPair.get(`${item.hash || ""}\u0000${normalizeMemoryText(item.source)}\u0000${normalizeMemoryText(item.target)}`);
    if (existingRow) {
      if (memoryRowUnchanged(existingRow, body)) {
        results[item.index] = { id: existingRow.id, locale, source: item.source, target: item.target, qualityStatus: existingRow.quality_status, qaScore: Number(existingRow.qa_score) || 0, unchanged: true };
        continue;
      }
      updates.push({ index: item.index, id: existingRow.id, body, item });
      continue;
    }
    const first = claimed.get(key);
    if (first !== undefined) {
      linkedTo.set(item.index, first);
      continue;
    }
    claimed.set(key, item.index);
    creates.push({ index: item.index, body, item });
  }
  if (creates.length) {
    const saved = await createItemsInChunks(`/items/${collection}`, creates.map((entry) => entry.body), {
      maxItems: BULK_INSERT_CHUNK_ITEMS,
      onProgress: (update) => onProgress?.({ ...update, total: inputs.length })
    });
    creates.forEach((entry, position) => {
      const row = saved[position];
      results[entry.index] = row
        ? { id: row.id, locale, source: entry.item.source, target: entry.item.target, qualityStatus: row.quality_status, qaScore: Number(row.qa_score) || 0 }
        : { error: "批量写入没有返回这一条" };
    });
  }
  if (updates.length) {
    // 只有内容确实变了的行才更新；一次性批量 PATCH，避免几万条串行请求。
    await updateItemsInChunks(`/items/${collection}`, updates.map((entry) => ({ id: entry.id, ...entry.body })));
    for (const entry of updates) {
      results[entry.index] = { id: entry.id, locale, source: entry.item.source, target: entry.item.target, qualityStatus: entry.body.quality_status, qaScore: Number(entry.body.qa_score) || 0 };
    }
  }
  for (const [index, sourceIndex] of linkedTo.entries()) {
    results[index] = results[sourceIndex] ? { ...results[sourceIndex] } : { error: "同一批里的重复条目没有写成功" };
  }
  return results;
}

/**
 * 按 id 编辑一条记忆：只改传来的人可编辑字段，不动归属（library_id）、批次与时间戳。
 * 原文变了必须重算 source_hash，否则后续"按原文去重/覆盖"会失效。
 */
export async function updateDirectusMemory(locale, id, patch = {}) {
  const collection = memoryCollectionFor(locale);
  const body = {};
  if (patch.source !== undefined) {
    const source = String(patch.source || "").trim();
    if (!source) {
      const error = new Error("日语原文不能为空");
      error.statusCode = 400;
      throw error;
    }
    body.source = source;
    body.source_hash = memorySourceHash(source);
  }
  if (patch.target !== undefined) {
    const target = String(patch.target || "").trim();
    if (!target) {
      const error = new Error("简体中文译文不能为空");
      error.statusCode = 400;
      throw error;
    }
    body.target = target;
  }
  if (patch.entryKey !== undefined) body.entry_key = String(patch.entryKey || "").trim();
  if (patch.qualityStatus !== undefined && ["human_approved", "machine_verified", "provisional"].includes(patch.qualityStatus)) {
    body.quality_status = patch.qualityStatus;
  }
  if (!Object.keys(body).length) {
    const error = new Error("没有需要更新的字段");
    error.statusCode = 400;
    throw error;
  }
  try {
    const saved = await request(`/items/${collection}/${encodeURIComponent(String(id))}`, { method: "PATCH", body });
    return toMemoryEntry(saved);
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function deleteDirectusMemory(locale, id) {
  const collection = memoryCollectionFor(locale);
  try {
    await request(`/items/${collection}/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

function mapStyleProfileRow(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    projectId: profile.project_id || "",
    name: profile.name,
    source: "style-library",
    locale: profile.target_locale,
    contentType: profile.content_type,
    contentTags: arrayValue(profile.content_tags),
    domain: profile.domain || "general",
    instruction: profile.instructions,
    reviewRubric: profile.review_rubric || null,
    rules: arrayValue(profile.rules),
    examples: arrayValue(profile.examples),
    version: Number(profile.version) || 1,
    parentId: profile.parent_id || null,
    evidenceCount: Number(profile.evidence_count) || 0,
    evidenceIds: arrayValue(profile.evidence_ids),
    generatedBy: profile.generated_by || "",
    sourceBatchId: profile.source_batch_id || "",
    learningRunId: profile.learning_run_id || "",
    status: profile.status,
    scopeRank: Number.isInteger(profile.scopeRank) ? profile.scopeRank : 0,
    updatedAt: profile.date_updated || null
  };
}

export async function getDirectusStyleProfile(locale, contentType, domain = "general", { projectId = "", scopeFallback = false } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,project_id,name,target_locale,content_type,content_tags,domain,instructions,review_rubric,examples,rules,version,parent_id,evidence_count,evidence_ids,generated_by,source_batch_id,learning_run_id,status,date_updated" });
  params.set("filter[target_locale][_eq]", locale);
  if (scopeFallback) {
    // 统一降级链：同语体与通用语体一起取回来，再按链位挑第一份 —— 通用规范因此对所有语体生效。
    const types = [...new Set([contentType || "general", "general"])];
    if (types.length > 1 || types[0] !== "general") params.set("filter[content_type][_in]", types.join(","));
    const domains = [...new Set([domain || "general", "general"])];
    if (domains.length > 1 || domains[0] !== "general") params.set("filter[domain][_in]", domains.join(","));
  } else {
    params.set("filter[content_type][_eq]", contentType || "general");
  }
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  else params.set("filter[project_id][_empty]", "true");
  params.set("filter[status][_eq]", "active");
  const items = await request(`/items/style_profiles?${params}`);
  const profile = scopeFallback ? pickProfileByScope(items, { contentType, domain }) : (items.find((item) => item.domain === domain) || items.find((item) => item.domain === "general") || items[0]);
  return mapStyleProfileRow(profile);
}

/**
 * 风格证据的写入体：单条与批量共用，字段口径只有一份。
 *
 * 不再写 `embedding`：证据池的读法是"作用域 + 分层取样"（见 src/evidence-sample.mjs），
 * 全仓库没有任何地方按向量检索证据；每条 2KB 的向量纯属导入负担。列还在，
 * 历史行也保留，将来真要做语义取样时用 /api/embedding/rebuild 回填即可。
 */
function directusStyleEvidenceBody(input, { locale, source, target }) {
  return {
    project_id: input.projectId || "",
    target_locale: locale,
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    domain: input.domain || "general",
    source,
    target,
    entry_key: String(input.entryKey || ""),
    source_file: input.sourceFile || "",
    source_row: Number(input.sourceRow) || null,
    batch_id: input.batchId || "",
    status: input.status || "accepted",
    provenance: input.provenance || "",
    machine_translation: String(input.machineTranslation || "").trim(),
    polarity: input.polarity === "negative" ? "negative" : "positive",
    note: String(input.note || "").trim()
  };
}

export async function saveDirectusStyleEvidence(input) {
  const locale = assertLocale(input.locale);
  const body = directusStyleEvidenceBody(input, {
    locale,
    source: String(input.source || "").trim(),
    target: String(input.target || "").trim()
  });
  // 同条目 ID + 同项目 + 同语言只留最新：命中就 PATCH 那一条。
  // 语体与领域不再参与判重（风格资产是项目级的），改判用途只会更新标签，不会新增一条。
  const match = styleEvidenceMatch({ entryKey: input.entryKey, locale, projectId: body.project_id });
  let existingId = "";
  if (match) {
    const params = new URLSearchParams({ limit: "1", sort: "-date_created", fields: "id" });
    params.set("filter[target_locale][_eq]", match.locale);
    params.set("filter[entry_key][_eq]", match.entryKey);
    if (match.projectId) params.set("filter[project_id][_eq]", match.projectId);
    else params.set("filter[project_id][_empty]", "true");
    const found = await request(`/items/style_evidence?${params}`);
    existingId = found[0]?.id || "";
  }
  if (!existingId && !match) {
    // 没有条目 ID 的来源（普通双语表格）过去只能纯新增：同一份文件导两次就多一份证据，
    // 学习时等于同一句被加权两次。这里退回"原文 + 译文 + 同项目"去重，只留最新一条。
    const params = new URLSearchParams({ limit: "-1", sort: "-date_created", fields: "id,source,target" });
    params.set("filter[target_locale][_eq]", locale);
    params.set("filter[entry_key][_empty]", "true");
    if (body.project_id) params.set("filter[project_id][_eq]", body.project_id);
    else params.set("filter[project_id][_empty]", "true");
    const sourceKey = normalizeMemoryText(body.source);
    const targetKey = normalizeMemoryText(body.target);
    const rows = await request(`/items/style_evidence?${params}`);
    const hit = rows.find((item) => normalizeMemoryText(item.source) === sourceKey && normalizeMemoryText(item.target) === targetKey);
    existingId = hit?.id || "";
  }
  const saved = existingId
    ? await request(`/items/style_evidence/${existingId}`, { method: "PATCH", body })
    : await request("/items/style_evidence", { method: "POST", body });
  return { id: saved.id, ...input };
}

/**
 * 风格证据的判重索引（原文+译文 → id、条目 ID → id）。
 *
 * 老实现每写一条证据就 `limit=-1` 拉一次全项目证据：导入 8 万条时这是 O(n²)
 * 的行传输（实测 9,791 条就用了 283 秒，且越到后面越慢）。导入开始时建一次索引，
 * 之后在内存里维护，行为不变（同一条目 ID 覆盖、无 ID 时按"原文+译文"去重）。
 */
export async function loadDirectusStyleEvidenceIndex(locale, { projectId = "" } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "-1", fields: "id,source,target,entry_key" });
  params.set("filter[target_locale][_eq]", locale);
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  else params.set("filter[project_id][_empty]", "true");
  const rows = await request(`/items/style_evidence?${params}`, { timeoutMs: 60_000 });
  const pairs = new Map();
  const entryKeys = new Map();
  for (const row of rows) {
    const entryKey = String(row.entry_key || "").trim();
    if (entryKey) entryKeys.set(entryKey, row.id);
    else pairs.set(`${normalizeMemoryText(row.source)}\u0000${normalizeMemoryText(row.target)}`, row.id);
  }
  return { pairs, entryKeys };
}

/**
 * 批量写入风格证据：与单条写入同一套判重口径，但一次写一批。
 * `index` 由 loadDirectusStyleEvidenceIndex 建好并在多次调用之间复用，
 * 写进去的新行会立刻记进索引，后续批次不会重复创建。
 */
export async function saveDirectusStyleEvidences(inputs = [], { index = null, onProgress } = {}) {
  const results = new Array(inputs.length).fill(null);
  if (!inputs.length) return results;
  const pairs = index?.pairs || new Map();
  const entryKeys = index?.entryKeys || new Map();
  const creates = [];
  const updates = [];
  const linkedTo = new Map();
  const claimed = new Map();
  for (const [position, input] of inputs.entries()) {
    const locale = assertLocale(input.locale);
    const source = String(input.source || "").trim();
    const target = String(input.target || "").trim();
    if (!source || !target) {
      results[position] = { error: "风格证据缺少原文或译文" };
      continue;
    }
    const body = directusStyleEvidenceBody(input, { locale, source, target });
    const entryKey = String(input.entryKey || "").trim();
    const pairKey = `${normalizeMemoryText(source)}\u0000${normalizeMemoryText(target)}`;
    const key = entryKey ? `k:${entryKey}` : `p:${pairKey}`;
    const existingId = entryKey ? entryKeys.get(entryKey) : pairs.get(pairKey);
    if (existingId) {
      // 证据是派生数据：同一对照再次导入时不必更新，跳过可省掉几万次 PATCH。
      results[position] = { id: existingId, source, target, unchanged: true };
      continue;
    }
    const first = claimed.get(key);
    if (first !== undefined) {
      linkedTo.set(position, first);
      continue;
    }
    claimed.set(key, position);
    creates.push({ position, body, entryKey, pairKey });
  }
  if (creates.length) {
    // 分块写入：7 万条证据一次请求会在真机上撞 120 秒超时（整批失败）。
    const saved = await createItemsInChunks("/items/style_evidence", creates.map((entry) => entry.body), {
      maxItems: BULK_INSERT_CHUNK_ITEMS,
      onProgress: (update) => onProgress?.({ ...update, total: inputs.length })
    });
    creates.forEach((entry, position) => {
      const row = saved[position];
      if (!row?.id) {
        results[entry.position] = { error: "批量写入风格证据没有返回这一条" };
        return;
      }
      results[entry.position] = { id: row.id, source: entry.body.source, target: entry.body.target };
      if (entry.entryKey) entryKeys.set(entry.entryKey, row.id);
      else pairs.set(entry.pairKey, row.id);
    });
  }
  for (const [position, sourcePosition] of linkedTo.entries()) {
    results[position] = results[sourcePosition] ? { ...results[sourcePosition] } : { error: "同一批里的重复证据没有写成功" };
  }
  return results;
}

/**
 * 证据分页读取：分层取样要按页扫一个有界窗口（见 src/evidence-sample.mjs），
 * 不能一次把 8 万条拉回内存。
 */
export async function listDirectusStyleEvidencePage(locale, options = {}) {
  assertLocale(locale);
  const limit = Math.max(1, Math.min(1_000, Number(options.limit) || 1_000));
  const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0);
  const params = new URLSearchParams({ limit: String(limit), sort: "-date_created", fields: "id,project_id,target_locale,content_type,content_tags,domain,source,target,entry_key,machine_translation,polarity,note,source_file,source_row,batch_id,status,provenance,embedding,date_created" });
  if (offset > 0) params.set("offset", String(offset));
  params.set("filter[target_locale][_eq]", locale);
  if (options.projectId) params.set("filter[project_id][_eq]", String(options.projectId));
  if (options.contentType) params.set("filter[content_type][_eq]", options.contentType);
  if (options.exactScope && options.domain) params.set("filter[domain][_eq]", options.domain);
  if (options.batchId) params.set("filter[batch_id][_eq]", options.batchId);
  const items = await request(`/items/style_evidence?${params}`);
  return items
    .filter((item) => options.exactScope
      ? (!options.contentType || item.content_type === options.contentType) && (!options.domain || item.domain === options.domain)
      : (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general"))
    .map((item) => ({
      id: item.id, projectId: item.project_id || "", locale: item.target_locale, contentType: item.content_type || "general", contentTags: arrayValue(item.content_tags), domain: item.domain || "general",
      source: item.source, target: item.target, sourceFile: item.source_file || "", sourceRow: Number(item.source_row) || null,
      entryKey: item.entry_key || "",
      machineTranslation: item.machine_translation || "",
      polarity: item.polarity === "negative" ? "negative" : "positive",
      note: item.note || "",
      batchId: item.batch_id || "",
      status: item.status || "accepted", provenance: item.provenance || "",
      embedding: item.embedding || null, createdAt: item.date_created
    }));
}

export async function getDirectusStyleEvidence(locale, options = {}) {
  return listDirectusStyleEvidencePage(locale, options);
}

/**
 * 项目风格证据的来源文件清单：每个文件贡献了多少条证据。
 * 风格规范是项目级的，界面要能回答"这套规则是从哪些文件学来的"。
 */
export async function countDirectusStyleEvidenceByFile(locale, { projectId = "" } = {}) {
  const params = new URLSearchParams({ "aggregate[count]": "*" });
  params.append("groupBy[]", "source_file");
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const rows = await request(`/items/style_evidence?${params}`);
  return (rows || [])
    .map((row) => ({ name: String(row.source_file || "").trim(), count: Number(row.count) || 0 }))
    .filter((item) => item.name && item.count > 0)
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

/**
 * 指定证据 id 各自的来源文件：某个蒸馏版本用过的取样来自哪些文件。
 * 只查 id + source_file 两列，返回 { id, sourceFile }[]，由调用方聚合展示。
 */
export async function listDirectusStyleEvidenceFiles(locale, { ids = [] } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))].slice(0, 1_000);
  if (!wanted.length) return [];
  const params = new URLSearchParams({ limit: "-1", fields: "id,source_file" });
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  params.set("filter[id][_in]", wanted.join(","));
  const rows = await request(`/items/style_evidence?${params}`);
  return (rows || []).map((row) => ({ id: String(row.id || ""), sourceFile: String(row.source_file || "").trim() }));
}

export async function getDirectusQaRuns(locale, options = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: String(Math.min(500, options.limit || 100)), sort: "-date_created", fields: "id,project_id,target_locale,content_type,domain,source,initial_translation,final_translation,score,status,iterations,issues,term_decisions,human_decisions,references,style_profile_id,model,fallback_reason,batch_id,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  // 语体/领域只作参考：QA 记录按项目取，不再按这两个维度过滤。
  if (options.projectId) params.set("filter[project_id][_eq]", String(options.projectId));
  if (options.batchId) params.set("filter[batch_id][_eq]", options.batchId);
  const items = await request(`/items/qa_runs?${params}`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
  return items
    .map((item) => ({
      id: item.id, projectId: item.project_id || "", locale: item.target_locale, contentType: item.content_type || "general", domain: item.domain || "general",
      source: item.source, initialTranslation: item.initial_translation, finalTranslation: item.final_translation,
      score: item.score == null ? null : Number(item.score), status: item.status || "review", iterations: Number(item.iterations) || 0,
      issues: arrayValue(item.issues), termDecisions: arrayValue(item.term_decisions), humanDecisions: arrayValue(item.human_decisions), references: arrayValue(item.references), styleProfileId: item.style_profile_id || "",
      model: item.model || "", fallbackReason: item.fallback_reason || "", batchId: item.batch_id || "", createdAt: item.date_created
    }));
}

export async function getDirectusUserProfile(locale, { projectId = "" } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,project_id,name,target_locale,instructions,examples,version,parent_id,evidence_count,status,date_updated" });
  params.set("filter[target_locale][_eq]", locale);
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  else params.set("filter[project_id][_empty]", "true");
  params.set("filter[status][_eq]", "active");
  const items = await request(`/items/user_profiles?${params}`);
  const profile = items[0];
  if (!profile) return null;
  return {
    id: profile.id, projectId: profile.project_id || "", name: profile.name, locale: profile.target_locale, instruction: profile.instructions,
    examples: arrayValue(profile.examples), version: Number(profile.version) || 1,
    evidenceCount: Number(profile.evidence_count) || 0, updatedAt: profile.date_updated
  };
}

export async function saveDirectusUserProfile(input) {
  const locale = assertLocale(input.locale);
  const projectId = String(input.projectId || input.project || "");
  const params = new URLSearchParams({ limit: "1", sort: "-version,-date_updated", fields: "id,version,status" });
  params.set("filter[target_locale][_eq]", locale);
  if (projectId) params.set("filter[project_id][_eq]", projectId);
  else params.set("filter[project_id][_empty]", "true");
  const existing = await request(`/items/user_profiles?${params}`);
  const previous = existing[0];
  const saved = await request("/items/user_profiles", { method: "POST", body: {
    name: input.name || `${locale} 译者画像`,
    project_id: projectId,
    target_locale: locale,
    instructions: input.instruction,
    review_rubric: input.reviewRubric || null,
    examples: input.examples || [],
    version: (Number(previous?.version) || 0) + 1,
    parent_id: previous?.id || null,
    evidence_count: Number(input.evidenceCount) || 0,
    status: input.status || "active"
  } });
  if (previous?.id && saved.status === "active") await request(`/items/user_profiles/${previous.id}`, { method: "PATCH", body: { status: "inactive" } });
  return { id: saved.id, projectId, name: saved.name, locale, instruction: saved.instructions, examples: saved.examples || [], version: saved.version };
}

export async function saveDirectusStyleProfile(input) {
  const locale = assertLocale(input.locale);
  const projectId = String(input.projectId || input.project || "");
  const params = new URLSearchParams({ limit: "1", sort: "-version,-date_updated", fields: "id,version,status" });
  params.set("filter[target_locale][_eq]", locale);
  // 版本号按「项目 + 语言」递增：风格资产是项目级的，语体与领域只是标签，
  // 按标签分别计数会让同项目的两份规范共用版本号，"最新 active"就没了确定含义。
  if (projectId) params.set("filter[project_id][_eq]", projectId);
  else params.set("filter[project_id][_empty]", "true");
  const existing = await request(`/items/style_profiles?${params}`);
  const previous = existing[0];
  const saved = await request("/items/style_profiles", { method: "POST", body: {
    project_id: projectId,
    name: input.name,
    target_locale: locale,
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    domain: input.domain || "general",
    instructions: input.instruction,
    examples: input.examples || [],
    rules: input.rules || [],
    version: (Number(previous?.version) || 0) + 1,
    parent_id: previous?.id || null,
    evidence_count: Number(input.evidenceCount) || 0,
    evidence_ids: input.evidenceIds || [],
    generated_by: input.generatedBy || "",
    source_batch_id: input.sourceBatchId || "",
    learning_run_id: input.learningRunId || "",
    status: input.status || "active"
  } });
  if (previous?.id && saved.status === "active") await request(`/items/style_profiles/${previous.id}`, { method: "PATCH", body: { status: "inactive" } });
  // evidenceCount 要一起回：它是下一轮"增长窗口"的基线，JSON 存储本来就返回整条记录。
  return { id: saved.id, projectId, name: saved.name, source: "style-library", instruction: saved.instructions, reviewRubric: saved.review_rubric || null, examples: saved.examples || [], rules: arrayValue(saved.rules), version: saved.version, evidenceCount: Number(saved.evidence_count) || 0, locale, contentType: saved.content_type, contentTags: arrayValue(saved.content_tags), domain: saved.domain, sourceBatchId: saved.source_batch_id || "", learningRunId: saved.learning_run_id || "", status: saved.status };
}

function mapStyleLearningRun(item) {
  return {
    id: item.id,
    projectId: item.project_id || "",
    batchId: item.batch_id || "",
    filename: item.filename || "",
    locale: item.target_locale,
    contentType: item.content_type || "general",
    contentTags: arrayValue(item.content_tags),
    domain: item.domain || "general",
    evidenceCount: Number(item.evidence_count) || 0,
    summary: item.summary || "",
    rules: arrayValue(item.rules),
    examples: arrayValue(item.examples),
    caveat: item.caveat || "",
    confidence: item.confidence == null ? null : Number(item.confidence),
    status: item.status || "draft",
    promotedProfileId: item.promoted_profile_id || "",
    generatedBy: item.generated_by || "",
    createdAt: item.date_created || null
  };
}

export async function saveDirectusStyleLearningRun(input) {
  const body = input.id ? {} : {
    project_id: input.projectId || input.project || "",
    batch_id: String(input.batchId || ""),
    filename: String(input.filename || ""),
    target_locale: assertLocale(input.locale),
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    domain: input.domain || "general",
    evidence_count: Number(input.evidenceCount) || 0,
    summary: String(input.summary || ""),
    rules: input.rules || [],
    examples: input.examples || [],
    caveat: String(input.caveat || ""),
    confidence: input.confidence == null ? null : Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    status: input.status || "observed",
    promoted_profile_id: input.promotedProfileId || "",
    generated_by: input.generatedBy || ""
  };
  if (input.id) {
    const fields = {
      projectId: ["project_id", (value) => String(value || "")],
      batchId: ["batch_id", (value) => String(value || "")],
      filename: ["filename", (value) => String(value || "")],
      locale: ["target_locale", (value) => assertLocale(value)],
      contentType: ["content_type", (value) => value || "general"],
      contentTags: ["content_tags", (value) => value || []],
      domain: ["domain", (value) => value || "general"],
      evidenceCount: ["evidence_count", (value) => Number(value) || 0],
      summary: ["summary", (value) => String(value || "")],
      rules: ["rules", (value) => value || []],
      examples: ["examples", (value) => value || []],
      caveat: ["caveat", (value) => String(value || "")],
      confidence: ["confidence", (value) => value == null ? null : Math.max(0, Math.min(1, Number(value) || 0))],
      status: ["status", (value) => value || "observed"],
      promotedProfileId: ["promoted_profile_id", (value) => value || ""],
      generatedBy: ["generated_by", (value) => value || ""]
    };
    for (const [inputField, [directusField, normalize]] of Object.entries(fields)) {
      if (Object.hasOwn(input, inputField)) body[directusField] = normalize(input[inputField]);
    }
  }
  const saved = input.id
    ? await request(`/items/style_learning_runs/${encodeURIComponent(input.id)}`, { method: "PATCH", body })
    : await request("/items/style_learning_runs", { method: "POST", body });
  return mapStyleLearningRun(saved);
}

export async function getDirectusStyleLearningRuns(locale, options = {}) {
  const params = new URLSearchParams({
    limit: String(Math.min(500, Math.max(1, Number(options.limit) || 100))),
    sort: "-date_created",
    fields: "id,project_id,batch_id,filename,target_locale,content_type,content_tags,domain,evidence_count,summary,rules,examples,caveat,confidence,status,promoted_profile_id,generated_by,date_created"
  });
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (options.projectId) params.set("filter[project_id][_eq]", String(options.projectId));
  if (options.batchId) params.set("filter[batch_id][_eq]", options.batchId);
  if (options.status) params.set("filter[status][_eq]", options.status);
  return (await request(`/items/style_learning_runs?${params}`)).map(mapStyleLearningRun);
}

/** 单条本批学习记录（重跑模型浓缩时要先把原记录的批次与作用域读回来）。 */
export async function getDirectusStyleLearningRun(id) {
  try {
    const item = await request(`/items/style_learning_runs/${encodeURIComponent(String(id))}?fields=id,project_id,batch_id,filename,target_locale,content_type,content_tags,domain,evidence_count,summary,rules,examples,caveat,confidence,status,promoted_profile_id,generated_by,date_created`);
    return mapStyleLearningRun(item);
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

/**
 * 风格证据的真实条数：按「语体 × 领域 × 来源」一次聚合。
 * 页面过去拿 limit=1000 的列表长度当总数，8134 条会被显示成 1000。
 */
export async function countDirectusStyleEvidenceByScope(locale, { projectId = "" } = {}) {
  const params = new URLSearchParams({ "aggregate[count]": "*" });
  params.append("groupBy[]", "content_type");
  params.append("groupBy[]", "domain");
  params.append("groupBy[]", "provenance");
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const rows = await request(`/items/style_evidence?${params}`, { timeoutMs: 60_000 });
  const stats = new Map();
  for (const row of rows || []) {
    const contentType = row.content_type || "general";
    const domain = row.domain || "general";
    const key = `${contentType}\u0000${domain}`;
    const bucket = stats.get(key) || { contentType, domain, total: 0, byProvenance: {} };
    const count = Number(row.count) || 0;
    bucket.total += count;
    const provenance = row.provenance || "other";
    bucket.byProvenance[provenance] = (bucket.byProvenance[provenance] || 0) + count;
    stats.set(key, bucket);
  }
  return stats;
}

/** 项目级证据计数：闸门与风格页面板共用，不再按语体×领域分池。 */
export async function countDirectusStyleEvidence(locale, { projectId = "" } = {}) {
  const params = new URLSearchParams({ "aggregate[count]": "*" });
  params.append("groupBy[]", "content_type");
  params.append("groupBy[]", "provenance");
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const rows = await request(`/items/style_evidence?${params}`, { timeoutMs: 60_000 });
  const byProvenance = {};
  const byContentType = new Map();
  let total = 0;
  for (const row of rows || []) {
    const count = Number(row.count) || 0;
    total += count;
    const provenance = row.provenance || "other";
    byProvenance[provenance] = (byProvenance[provenance] || 0) + count;
    const contentType = row.content_type || "general";
    byContentType.set(contentType, (byContentType.get(contentType) || 0) + count);
  }
  return {
    total,
    byProvenance,
    byContentType: [...byContentType.entries()].map(([contentType, count]) => ({ contentType, count })).sort((a, b) => b.count - a.count)
  };
}

/**
 * 项目级规范：同项目 + 同语言最新 active 的那一份。
 *
 * 不再按作用域挑：风格资产已经改成"每项目 + 语言一份"，历史作用域规范（如果有）
 * 只会在被激活时自动退役同项目其它 active，取值永远只看最新那一条。
 */
export async function getDirectusProjectStyleProfile(locale, { projectId = "" } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({
    limit: "1",
    sort: "-version,-date_updated",
    fields: "id,project_id,name,target_locale,content_type,content_tags,domain,instructions,review_rubric,examples,rules,version,parent_id,evidence_count,evidence_ids,generated_by,source_batch_id,learning_run_id,status,date_updated"
  });
  params.set("filter[target_locale][_eq]", locale);
  params.set("filter[status][_eq]", "active");
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  else params.set("filter[project_id][_empty]", "true");
  const items = await request(`/items/style_profiles?${params}`);
  return mapStyleProfileRow(items?.[0]);
}

export async function saveDirectusQaRun(input) {
  return request("/items/qa_runs", { method: "POST", body: {
    project_id: input.projectId || "",
    target_locale: assertLocale(input.locale), content_type: input.contentType || "general", domain: input.domain || "general",
    source: input.source, initial_translation: input.initialTranslation, final_translation: input.finalTranslation,
    score: input.score, status: input.status, iterations: input.iterations || 0, issues: input.issues || [], term_decisions: input.termDecisions || [], human_decisions: input.humanDecisions || [], references: input.references || [],
    style_profile_id: input.styleProfileId || "", model: input.model || "", batch_id: input.batchId || "", fallback_reason: input.fallbackReason || ""
  } });
}

export async function saveDirectusQaCase(input) {
  const embedding = input.embedding ?? await embedSource(input.source);
  return request("/items/qa_cases", { method: "POST", body: {
    project_id: input.projectId || "", project: input.projectId || input.project || "",
    target_locale: assertLocale(input.locale), content_type: input.contentType || "general", domain: input.domain || "general",
    source: input.source, rejected_translation: input.rejectedTranslation, corrected_translation: input.correctedTranslation || "",
    issues: input.issues || [], score_before: input.scoreBefore, score_after: input.scoreAfter, status: input.status || "review",
    ...(embedding ? { embedding } : {})
  } });
}

export async function getDirectusQaCases(locale, { contentType = "general", domain = "general", projectId = "", limit = 200, scopeFallback = false } = {}) {  assertLocale(locale);
  const directusLimit = Number(limit) <= 0 ? "-1" : String(Math.min(500, limit));
  const params = new URLSearchParams({ limit: directusLimit, sort: "-date_created", fields: "id,project_id,target_locale,content_type,domain,source,rejected_translation,corrected_translation,issues,score_before,score_after,status,embedding,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  // 语体/领域只影响 scopeRank 加成，不再过滤：同项目内所有已批准反例都参与排序。
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const items = await request(`/items/qa_cases?${params}`);
  return items.filter((item) => item.status === "human_approved").map((item) => ({
    ...(scopeFallback ? { scopeRank: scopeRankOf({ contentType: item.content_type, domain: item.domain }, { contentType, domain }) } : {}),
    id: item.id, projectId: item.project_id || "", locale: item.target_locale, contentType: item.content_type, domain: item.domain || "general", source: item.source,
    rejectedTranslation: item.rejected_translation, correctedTranslation: item.corrected_translation, issues: arrayValue(item.issues),
    scoreBefore: Number(item.score_before) || 0, scoreAfter: Number(item.score_after) || 0, status: item.status, embedding: item.embedding || null, createdAt: item.date_created
  }));
}

/**
 * 按 ID 取一条 QA 案例（不过滤状态）：采纳动作要在同一条案例上立刻派生回归案例，
 * 而列表接口只返回 human_approved，拿不到刚采纳的原始状态与所属作用域。
 */
export async function findDirectusQaCase(id) {
  if (!id) return null;
  try {
    const item = await request(`/items/qa_cases/${encodeURIComponent(String(id))}?fields=id,project_id,target_locale,content_type,domain,source,rejected_translation,corrected_translation,issues,score_before,score_after,status,date_created`);
    if (!item?.id) return null;
    return {
      id: item.id, projectId: item.project_id || "", project: item.project_id || "", locale: item.target_locale,
      contentType: item.content_type || "general", domain: item.domain || "general", source: item.source,
      rejectedTranslation: item.rejected_translation, correctedTranslation: item.corrected_translation,
      issues: arrayValue(item.issues),
      scoreBefore: Number(item.score_before) || 0, scoreAfter: Number(item.score_after) || 0,
      status: item.status, createdAt: item.date_created
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function getDirectusAssets(locale, { projectId = "" } = {}) {
  const collection = collectionFor(locale);
  const fields = "id,source,aliases,target,forbidden,domains,content_types,content_tags,enforcement,note,status,provenance,asset_tier,case_sensitive,preserve_original,version,version_group_id,lifecycle_status,valid_from,valid_to,projects,project_id,library_id,channels,platforms,regions,superseded_by,date_created,date_updated";
  const params = new URLSearchParams({ limit: "-1", sort: "-date_updated", fields });
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const items = await request(`/items/${collection}?${params}`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
  const latest = items.map((item) => item.date_updated || item.date_created).filter(Boolean).sort().at(-1);
  return {
    locale,
    revision: latest ? Date.parse(latest) : 1,
    terms: items.map(toTerm),
    memories: [],
    styleExamples: []
  };
}

export async function getDirectusAssetStats(locale) {
  const collection = collectionFor(locale);
  const result = await request(`/items/${collection}?aggregate[count]=*`);
  return { locale, termCount: Number(result?.[0]?.count ?? 0), revision: Date.now() };
}

const TERM_ENTRY_FIELDS = "id,source,aliases,target,forbidden,domains,content_types,content_tags,enforcement,note,status,provenance,project_id,library_id,date_created,date_updated";
const MEMORY_ENTRY_FIELDS = "id,source,target,entry_id,entry_key,domain,content_type,content_tags,quality_status,qa_score,provenance,source_file,batch_id,source_row,project_id,library_id,campaign,platform,region,audience,date_created,date_updated";

/**
 * 别名在 Directus 里是 json 列，`_icontains` 直接报 INVALID_QUERY，所以库内搜索要
 * 先在内存里按别名找出命中的 id，再并进同一条查询的 `_or` 里。索引按"集合 + 项目"
 * 缓存一分钟：导入几千条后 60 秒内刷新一次，够新也不会每敲一个字就全量拉一次。
 */
const ALIAS_INDEX_TTL_MS = 60_000;
const aliasIndexCache = new Map();

function aliasIndexKey(locale, projectId) {
  return `${collectionFor(locale)}\u0000${projectId || ""}`;
}

async function aliasMatchIds(locale, projectId, needle) {
  const query = String(needle || "").trim().toLocaleLowerCase();
  if (!query) return [];
  const key = aliasIndexKey(locale, projectId);
  let cached = aliasIndexCache.get(key);
  if (!cached || Date.now() - cached.at > ALIAS_INDEX_TTL_MS) {
    const params = new URLSearchParams({ limit: "-1", fields: "id,aliases" });
    if (projectId) params.set("filter[project_id][_eq]", String(projectId));
    const rows = await request(`/items/${collectionFor(locale)}?${params}`);
    const entries = rows
      .map((row) => ({ id: row.id, text: arrayValue(row.aliases).join("\u0000").toLocaleLowerCase() }))
      .filter((entry) => entry.text);
    cached = { at: Date.now(), entries };
    aliasIndexCache.set(key, cached);
  }
  return cached.entries.filter((entry) => entry.text.includes(query)).map((entry) => entry.id).slice(0, 200);
}

function applyLibraryEntryFilters(params, { projectId = "", libraryId = "", sourceFile = "", search = "", aliasIds = [] } = {}) {
  let group = 0;
  const nextGroup = () => `filter[_and][${group++}]`;
  if (projectId) params.set(`${nextGroup()}[project_id][_eq]`, String(projectId));
  if (libraryId) params.set(`${nextGroup()}[library_id][_eq]`, String(libraryId));
  // 工作 TM 按文件隔离后要能只看某个文件的行；"未标注来源"用 _empty 取空文件名。
  if (sourceFile === "__none__") params.set(`${nextGroup()}[source_file][_empty]`, "true");
  else if (sourceFile) params.set(`${nextGroup()}[source_file][_eq]`, String(sourceFile));
  if (search) {
    const base = nextGroup();
    params.set(`${base}[_or][0][source][_icontains]`, String(search));
    params.set(`${base}[_or][1][target][_icontains]`, String(search));
    // 文件名也参与搜索：几千条工作 TM 草稿里"只想看这个文件"是最常见的诉求。
    params.set(`${base}[_or][2][source_file][_icontains]`, String(search));
    if (aliasIds.length) params.set(`${base}[_or][3][id][_in]`, aliasIds.join(","));
  }
  return params;
}

/** 术语库 / 记忆库页的条目列表：按库过滤 + 搜索 + 分页（limit<=0 取全量，供导出用）。 */
export async function listDirectusLibraryEntries({ locale, kind = "term", projectId = "", libraryId = "", sourceFile = "", search = "", limit = 100, offset = 0 } = {}) {
  assertLocale(locale);
  const terms = kind !== "tm";
  const collection = terms ? collectionFor(locale) : memoryCollectionFor(locale);
  const fields = terms ? TERM_ENTRY_FIELDS : MEMORY_ENTRY_FIELDS;
  const aliasIds = terms && search ? await aliasMatchIds(locale, projectId, search) : [];
  const filters = { projectId, libraryId, sourceFile: terms ? "" : sourceFile, search, aliasIds };
  const countParams = applyLibraryEntryFilters(new URLSearchParams({ "aggregate[count]": "*" }), filters);
  const countResult = await request(`/items/${collection}?${countParams}`);
  const total = Number(countResult?.[0]?.count ?? 0);
  const params = applyLibraryEntryFilters(new URLSearchParams({ sort: "-date_created", fields }), filters);
  const directusLimit = Number(limit) <= 0 ? "-1" : String(Math.min(1000, Number(limit) || 100));
  params.set("limit", directusLimit);
  params.set("offset", String(Math.max(0, Math.trunc(Number(offset)) || 0)));
  const rows = await request(`/items/${collection}?${params}`, { timeoutMs: 60_000 });
  return { total, items: rows.map((row) => (terms ? toTerm(row) : toMemoryEntry(row))) };
}

function toMemoryEntry(item) {
  return {
    id: item.id,
    source: item.source,
    target: item.target,
    entryId: item.entry_id || "",
    entryKey: item.entry_key || "",
    domain: item.domain || "general",
    contentType: item.content_type || "general",
    qualityStatus: item.quality_status || "provisional",
    qaScore: Number(item.qa_score) || 0,
    provenance: item.provenance || "directus",
    sourceFile: item.source_file || "",
    sourceRow: Number(item.source_row) || null,
    batchId: item.batch_id || "",
    projectId: item.project_id || "",
    libraryId: item.library_id || "",
    createdAt: item.date_created,
    updatedAt: item.date_updated
  };
}

/** 库列表要的实时条目数 / 最新条目时间：一次 groupBy 聚合拿全项目的库分组。 */
export async function getDirectusLibraryStats(locale, projectId = "") {
  assertLocale(locale);
  const read = async (collection, withFiles = false) => {
    const params = new URLSearchParams({ "aggregate[count]": "*", "aggregate[max]": "date_created" });
    params.append("groupBy[]", "library_id");
    // TM 一起按来源文件分组：库列表要显示"这个工作 TM 里有多少个文件"。
    if (withFiles) params.append("groupBy[]", "source_file");
    if (projectId) params.set("filter[project_id][_eq]", String(projectId));
    const rows = await request(`/items/${collection}?${params}`);
    return rows;
  };
  const stats = new Map();
  const [termRows, memoryRows] = await Promise.all([read(collectionFor(locale)), read(memoryCollectionFor(locale), true)]);
  for (const [kind, rows] of [["term", termRows], ["tm", memoryRows]]) {
    for (const row of rows || []) {
      const libraryId = row.library_id == null ? "" : String(row.library_id);
      if (!libraryId) continue;
      const bucket = stats.get(libraryId) || { entryCount: 0, termCount: 0, memoryCount: 0, lastEntryAt: "", fileCount: 0, latestFile: "" };
      const count = Number(row.count) || 0;
      bucket.entryCount += count;
      if (kind === "term") bucket.termCount += count;
      else {
        bucket.memoryCount += count;
        // 每个分组就是"库 × 来源文件"：组数即文件数，时间最新的那个当作最近文件。
        if (row.source_file) {
          bucket.fileCount += 1;
          const stamp = row.max?.date_created || "";
          if (stamp >= (bucket.latestFileAt || "")) {
            bucket.latestFileAt = stamp;
            bucket.latestFile = String(row.source_file);
          }
        }
      }
      const stamp = row.max?.date_created || "";
      if (stamp && stamp > bucket.lastEntryAt) bucket.lastEntryAt = stamp;
      stats.set(libraryId, bucket);
    }
  }
  return stats;
}

/**
 * 工作 TM / 主 TM 下的"来源文件"清单：库页面第三层用。
 * 按 source_file + batch_id 分组，合并成"每个文件多少条、几个批次、最近什么时候"。
 */
export async function listDirectusLibraryFiles({ locale, projectId = "", libraryId = "" } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ "aggregate[count]": "*", "aggregate[max]": "date_created" });
  params.append("groupBy[]", "source_file");
  params.append("groupBy[]", "batch_id");
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  if (libraryId) params.set("filter[library_id][_eq]", String(libraryId));
  const rows = await request(`/items/${memoryCollectionFor(locale)}?${params}`, { timeoutMs: 60_000 });
  const groups = new Map();
  for (const row of rows || []) {
    const sourceFile = row.source_file == null ? "" : String(row.source_file);
    const key = sourceFile || "__none__";
    const group = groups.get(key) || { sourceFile, entryCount: 0, batchCount: 0, lastEntryAt: "", batchId: "" };
    group.entryCount += Number(row.count) || 0;
    if (row.batch_id) group.batchCount += 1;
    const stamp = row.max?.date_created || "";
    if (stamp >= group.lastEntryAt) {
      group.lastEntryAt = stamp;
      if (row.batch_id) group.batchId = String(row.batch_id);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => String(right.lastEntryAt).localeCompare(String(left.lastEntryAt)));
}

/**
 * 批量删除条目（"删库并删除库内条目"用）。Directus 支持 DELETE /items/<collection>
 * 带 id 数组；分批 200 条，避免一个请求体过大。
 */
export async function deleteDirectusLibraryEntries(locale, kind, ids = []) {
  assertLocale(locale);
  const collection = kind === "tm" ? memoryCollectionFor(locale) : collectionFor(locale);
  let deleted = 0;
  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    if (!chunk.length) continue;
    await request(`/items/${collection}`, { method: "DELETE", body: chunk, timeoutMs: 60_000 });
    deleted += chunk.length;
  }
  return deleted;
}

/** 单条术语：编辑要基于现有行合并，不能整条覆盖（否则会丢 library_id 等归属）。 */
export async function getDirectusAsset(locale, id) {
  const collection = collectionFor(locale);
  try {
    const item = await request(`/items/${collection}/${encodeURIComponent(String(id))}?fields=${TERM_ENTRY_FIELDS},domains,content_tags,asset_tier,case_sensitive,preserve_original,version,version_group_id,lifecycle_status,valid_from,valid_to,projects,channels,platforms,regions,superseded_by`);
    return toTerm(item);
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function saveDirectusAsset(locale, input) {
  const collection = collectionFor(locale);
  const item = toDirectusTerm(input);
  if (!item.source || !item.target) {
    const error = new Error("术语原文和目标译法不能为空");
    error.statusCode = 400;
    throw error;
  }
  const saved = input.id
    ? await request(`/items/${collection}/${encodeURIComponent(input.id)}`, { method: "PATCH", body: item })
    : await request(`/items/${collection}`, { method: "POST", body: item });
  return toTerm(saved);
}

/**
 * 批量写入术语。
 *
 * 导入几千条术语时逐条 POST 会把整批拖到分钟级（每条都要一次往返 + 一次
 * Directus 校验），所以按字节/条数分块写入。中途失败时抛出的错误上带着
 * 已写入的条目，调用方可以据此报"部分写入"。
 */
export async function saveDirectusAssets(locale, inputs = []) {
  const collection = collectionFor(locale);
  const records = [];
  for (const input of inputs) {
    const item = toDirectusTerm(input);
    if (!item.source || !item.target) {
      const error = new Error("术语原文和目标译法不能为空");
      error.statusCode = 400;
      throw error;
    }
    records.push(item);
  }
  if (!records.length) return [];
  const saved = await createItemsInChunks(`/items/${collection}`, records, { maxItems: BULK_INSERT_CHUNK_ITEMS });
  return saved.map(toTerm);
}

export async function deleteDirectusAsset(locale, id) {
  const collection = collectionFor(locale);
  await request(`/items/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

export async function saveDirectusCorpus(input) {
  const id = input.id || randomUUID();
  const document = {
    id,
    project_id: input.projectId || "",
    name: String(input.name || "未命名语料").trim(),
    source_language: "ja-JP",
    domain: input.domain || "general",
    content_type: input.contentType || "general",
    text: String(input.text || ""),
    segments: input.segments || [],
    candidates: input.candidates || []
  };
  const saved = await request("/items/corpus_documents", { method: "POST", body: document });
  return {
    id: saved.id,
    projectId: saved.project_id || "",
    name: saved.name,
    sourceLanguage: saved.source_language,
    domain: saved.domain,
    contentType: saved.content_type,
    text: saved.text,
    segments: saved.segments || [],
    candidates: saved.candidates || [],
    createdAt: saved.date_created
  };
}

/** 候选 → term_candidates 行：写审核队列与写回 AI 清洗结论共用同一套字段映射。 */
function importCandidateRecord(candidate, { batchId, projectId = "", filename = "", aiUsed = false } = {}) {
  // PostgreSQL 的文本列不接受 0x00，而候选键按约定用 NUL 当分隔符（`语种\0源词\0译法`）。
  // 在写库边界把 NUL 换成可见的单位分隔符：内存里的键照旧，库里不会再 500。
  return withoutNullBytes({
    project_id: projectId,
    source: candidate.source,
    target: candidate.target,
    note: candidate.note || "",
    sheet_mode: candidate.sheetMode || "",
    target_locale: candidate.locale,
    asset_type: candidate.assetType || "term",
    content_type: candidate.contentType || "general",
    content_tags: candidate.contentTags || [],
    domain: candidate.domain || "general",
    enforcement: candidate.enforcement || "preferred",
    classification_confidence: Number(candidate.contentTypeConfidence) || Number(candidate.score) || null,
    classification_source: candidate.contentTypeSource || (aiUsed ? "ai" : "rules"),
    candidate_key: candidate.candidateKey || "",
    candidate_role: candidate.candidateRole || "full_pair",
    parent_candidate_key: candidate.parentCandidateKey || "",
    parent_row_number: Number(candidate.parentRowNumber) || null,
    parent_candidate_keys: candidate.parentCandidateKeys || (candidate.parentCandidateKey ? [candidate.parentCandidateKey] : []),
    parent_evidence: candidate.parentEvidence || [],
    candidate_origin: candidate.candidateOrigin || candidate.extractionSource || "table-pair",
    term_category: candidate.termCategory || "",
    extraction_confidence: candidate.extractionConfidence == null ? null : Number(candidate.extractionConfidence),
    source_span: candidate.sourceSpan || null,
    target_span: candidate.targetSpan || null,
    frequency: candidate.occurrences || 1,
    score: candidate.score,
    batch_id: batchId,
    source_file: filename,
    row_number: candidate.rowNumber,
    decision: candidate.decision,
    reason: (candidate.reasons || []).join("；"),
    status: "pending"
  });
}

function withoutNullBytes(value) {
  if (typeof value === "string") return value.replace(/\u0000/gu, "\u241f");
  if (Array.isArray(value)) return value.map(withoutNullBytes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutNullBytes(item)]));
  }
  return value;
}

export async function saveDirectusImportPreview(input, { onProgress } = {}) {
  const batch = await request("/items/term_import_batches", {
    method: "POST",
    body: {
      filename: input.filename,
      file_type: input.fileType,
      source_language: "ja-JP",
      project_id: input.projectId || "",
      requested_locale: input.requestedLocale,
      row_count: input.statistics?.rowsScanned || 0,
      candidate_count: input.candidates.length,
      status: "reviewing",
      ai_used: Boolean(input.ai?.used),
      summary: {
        ...(input.statistics || {}),
        fileMode: input.fileMode || "mixed",
        ai: input.ai || null,
        sheets: input.sheets || []
      }
    }
  });
  const records = input.candidates.map((candidate) => importCandidateRecord(candidate, {
    batchId: batch.id,
    projectId: input.projectId || "",
    filename: input.filename,
    aiUsed: Boolean(input.ai?.used)
  }));
  let saved = [];
  try {
    // 入库前先写审核队列：几千条候选会在这一步花掉最多时间，必须能把进度报出去。
    saved = records.length
      ? await createItemsInChunks("/items/term_candidates", records, {
        maxItems: BULK_INSERT_CHUNK_ITEMS,
        onProgress: (update) => onProgress?.({ phase: "queueing", message: `正在写入审核队列：${update.completed} / ${update.total}`, ...update })
      })
      : [];
    if (saved.length !== records.length) throw new Error(`Directus candidate write was incomplete (${saved.length}/${records.length})`);
  } catch (error) {
    const knownIds = [...saved, ...(error.createdItems || [])].map((item) => item?.id).filter(Boolean);
    const persistedIds = await candidateIdsForBatch(batch.id).catch(() => []);
    const savedIds = [...new Set([...knownIds, ...persistedIds])];
    if (savedIds.length) {
      await updateItemsInChunks("/items/term_candidates", savedIds.map((id) => ({
        id,
        status: "rejected",
        decision: "excluded"
      }))).catch(() => {});
    }
    await request(`/items/term_import_batches/${encodeURIComponent(batch.id)}`, {
      method: "PATCH",
      body: { status: "cancelled", summary: { ...(input.statistics || {}), partialCandidates: savedIds.length, error: error.message } }
    }).catch(() => {});
    throw error;
  }
  return {
    batchId: batch.id,
    candidates: input.candidates.map((candidate, index) => ({ ...candidate, candidateId: saved[index]?.id }))
  };
}

/**
 * 批量插入的分块大小：一次 2,000 条。
 *
 * 之前只按 64MB 切块，等于"整批一次请求"：7 万条证据在真机上直接撞 120 秒超时，
 * 整批风格证据 100% 失败（任务摘要里会写"风格证据写入失败：Directus请求超时"）。
 * 分块之后单请求可控，失败也只影响一块。
 */
const BULK_INSERT_CHUNK_ITEMS = 2_000;
/**
 * TM 审计批次的 file_type 标记。表里只有这一种批次是我们自己的导入历史，
 * "替换上一批"只认这个标记，绝不会误删资产导入（术语审核队列）的批次。
 */
const TM_AUDIT_FILE_TYPE = "tm-audit";

/**
 * 同一项目 + 同一文件名重新导入时，把**上一次的审计批次连同候选行删掉**，只留最新一批。
 *
 * 记忆与风格证据本身是"命中即覆盖"，不会翻倍；这里处理的是 `term_import_batches` /
 * `term_candidates` 的历史堆积（重复导入 7 万行文件就是再堆 7 万行）。
 * 删失败只记警告：审计是历史记录，不能因为清理失败就把导入判失败。
 */
export async function replacePreviousTmImportAudit({ projectId = "", filename = "", keepBatchId = "" } = {}) {
  if (!projectId || !filename) return { batches: 0, candidates: 0 };
  const params = new URLSearchParams({
    limit: "-1",
    fields: "id,file_type,status,summary",
    filter: JSON.stringify({
      project_id: { _eq: projectId },
      filename: { _eq: filename },
      status: { _eq: "completed" }
    })
  });
  const rows = await request(`/items/term_import_batches?${params}`);
  const stale = rows
    // 新批次带固定标记；历史批次（队列后置之前的 TM 导入）没有 file_type 标记，
    // 用"没有 fileMode"来认——资产导入的 summary 一律带 fileMode，绝不会被误删。
    .filter((row) => String(row.file_type || "") === TM_AUDIT_FILE_TYPE || !(row.summary || {}).fileMode)
    .map((row) => String(row.id || ""))
    .filter((id) => id && id !== keepBatchId);
  if (!stale.length) return { batches: 0, candidates: 0 };
  let removedCandidates = 0;
  for (const chunk of chunkList(stale, 5)) {
    const filter = encodeURIComponent(JSON.stringify({ batch_id: { _in: chunk } }));
    const candidates = await request(`/items/term_candidates?limit=-1&fields=id&filter=${filter}`);
    const ids = candidates.map((row) => row.id).filter(Boolean);
    if (ids.length) removedCandidates += await deleteItemsByKeys("term_candidates", ids);
  }
  await deleteItemsByKeys("term_import_batches", stale);
  return { batches: stale.length, candidates: removedCandidates };
}

/**
 * TM 导入成功后的审计：批次行 + 精简候选行（直接写终态）。
 *
 * 队列不再充当"导入前先落盘的中转队列"——失败时库里一行都不写（老的先写队列
 * 方式会让每次失败都留下几万条 pending 垃圾）；"继续导入"改读本地预检缓存。
 * 候选行只留审计必需字段：原来 30 多列里有一半对 TM 候选恒为空值/默认值。
 */
export async function saveDirectusTmImportAudit({
  batchId,
  filename = "人工 TM 导入",
  fileType = "tm",
  projectId = "",
  requestedLocale = "zh-CN",
  summary = {},
  candidates = [],
  decisions = []
} = {}) {
  if (!batchId) throw new Error("TM 导入审计缺少批次号");
  const records = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const decision = decisions[index] || {};
    const accepted = decision.status === "accepted";
    return withoutNullBytes({
      project_id: projectId,
      source: candidate?.source || "",
      target: candidate?.target || "",
      target_locale: candidate?.locale || requestedLocale,
      asset_type: candidate?.assetType || "memory",
      content_type: candidate?.contentType || "general",
      domain: candidate?.domain || "general",
      note: String(candidate?.note || "").slice(0, 500),
      batch_id: batchId,
      source_file: candidate?.sourceFile || filename,
      row_number: Number(candidate?.rowNumber ?? candidate?.sourceRow) || index + 1,
      decision: accepted ? (candidate?.decision || "ready") : (decision.decision || candidate?.decision || "excluded"),
      status: accepted ? "accepted" : "rejected",
      reason: accepted ? "" : String(decision.reason || "").slice(0, 200)
    });
  });
  const batchBody = {
    filename,
    // 固定标记（真实来源类型记进 summary.sourceFileType）：同项目 + 同文件名重新导入时，
    // 只替换上一次的 TM 审计批次，不会碰到资产导入的审核批次。
    file_type: TM_AUDIT_FILE_TYPE,
    source_language: "ja-JP",
    project_id: projectId,
    requested_locale: requestedLocale,
    row_count: records.length,
    candidate_count: records.length,
    status: "completed",
    ai_used: Boolean(summary?.ai?.used),
    summary: { ...summary, sourceFileType: fileType }
  };
  try {
    const replaced = await replacePreviousTmImportAudit({ projectId, filename, keepBatchId: batchId });
    if (replaced.batches) {
      console.log(`[Kami] 重复导入同一文件：已替换上一批审计（批次 ${replaced.batches} 个、候选 ${replaced.candidates} 行）`);
    }
  } catch (error) {
    console.warn(`[Kami] 替换上一批审计失败（不影响本次导入）：${error.message}`);
  }
  try {
    // 指定主键让任务载荷、记忆行与审计批次共用同一个批次号。
    await request("/items/term_import_batches", { method: "POST", body: { id: batchId, ...batchBody } });
  } catch (error) {
    // Directus 若拒绝客户端主键，就退回服务端生成：审计仍然落地，只是批次号不再是预生成的那个。
    console.warn(`[Kami] TM 导入批次行改用服务端主键：${error.message}`);
    await request("/items/term_import_batches", { method: "POST", body: batchBody });
  }
  if (records.length) {
    await createItemsInChunks("/items/term_candidates", records, { maxItems: BULK_INSERT_CHUNK_ITEMS });
  }
  return { batchId, candidates: records.length };
}

/**
 * 把 AI 清洗结论写回候选行，供续跑时跳过已经判定过的条目、省掉重复的模型调用。
 * 已存在的候选按 id 更新；句内术语这类这一轮才产生的候选作为新行写进同一个批次。
 * 用 classification_source = "ai-cleaned" 作为"已判定"的标记（该列本来就只记来源，不参与业务判断）。
 */
export async function persistDirectusImportCleaning(batchId, { projectId = "", filename = "", candidates = [] } = {}) {
  const existing = candidates.filter((candidate) => candidate.candidateId);
  const created = candidates.filter((candidate) => !candidate.candidateId);
  if (existing.length) {
    await updateItemsInChunks("/items/term_candidates", existing.map((candidate) => ({
      id: candidate.candidateId,
      decision: candidate.decision || "review",
      reason: (candidate.reasons || []).join("；"),
      asset_type: candidate.assetType || "term",
      content_type: candidate.contentType || "general",
      domain: candidate.domain || "general",
      classification_source: "ai-cleaned"
    })));
  }
  if (created.length) {
    await createItemsInChunks("/items/term_candidates", created.map((candidate) => importCandidateRecord(
      { ...candidate, contentTypeSource: "ai-cleaned" },
      { batchId, projectId, filename, aiUsed: true }
    )), { maxItems: BULK_INSERT_CHUNK_ITEMS });
  }
  return existing.length + created.length;
}

export async function getDirectusImportPreview(batchId) {
  let batch;
  try {
    batch = await request(`/items/term_import_batches/${encodeURIComponent(String(batchId))}?fields=id,filename,file_type,project_id,requested_locale,row_count,candidate_count,status,ai_used,summary,date_created`);
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }

  const params = new URLSearchParams({
    limit: "-1",
    sort: "row_number,target_locale",
    fields: [
      "id", "source", "target", "target_locale", "asset_type", "content_type", "content_tags", "domain", "enforcement",
      "classification_confidence", "classification_source", "candidate_key", "candidate_role", "parent_candidate_key",
      "parent_row_number", "parent_candidate_keys", "parent_evidence", "candidate_origin", "term_category",
      "extraction_confidence", "source_span", "target_span", "frequency", "score", "source_file", "row_number",
      "decision", "reason", "status", "note", "sheet_mode"
    ].join(","),
    filter: JSON.stringify({ batch_id: { _eq: batch.id } })
  });
  const records = await request(`/items/term_candidates?${params}`, { timeoutMs: 30_000 });
  const summary = batch.summary && typeof batch.summary === "object" ? batch.summary : {};
  const { fileMode = "mixed", ai: savedAi = null, sheets = [], ...statistics } = summary;
  const candidates = records.map((item) => ({
    candidateId: item.id,
    source: item.source || "",
    target: item.target || "",
    note: item.note || "",
    sheetMode: item.sheet_mode || "",
    locale: item.target_locale || "",
    assetType: item.asset_type || "term",
    contentType: item.content_type || "general",
    contentTags: arrayValue(item.content_tags),
    domain: item.domain || "general",
    enforcement: item.enforcement || "preferred",
    contentTypeConfidence: Number(item.classification_confidence) || Number(item.score) || 0,
    contentTypeSource: item.classification_source || "rules",
    candidateKey: item.candidate_key || "",
    candidateRole: item.candidate_role || "full_pair",
    parentCandidateKey: item.parent_candidate_key || "",
    parentRowNumber: Number(item.parent_row_number) || null,
    parentCandidateKeys: arrayValue(item.parent_candidate_keys),
    parentEvidence: arrayValue(item.parent_evidence),
    candidateOrigin: item.candidate_origin || "table-pair",
    termCategory: item.term_category || "",
    extractionConfidence: item.extraction_confidence == null ? null : Number(item.extraction_confidence),
    sourceSpan: item.source_span || null,
    targetSpan: item.target_span || null,
    occurrences: Number(item.frequency) || 1,
    score: Number(item.score) || 0,
    rowNumber: Number(item.row_number) || null,
    decision: item.decision || "review",
    reasons: String(item.reason || "").split("；").map((reason) => reason.trim()).filter(Boolean),
    nested: item.candidate_origin === "nested-term" || Boolean(item.parent_candidate_key),
    status: item.status || "pending"
  }));

  return {
    batchId: batch.id,
    filename: batch.filename || "术语导入表格",
    fileType: batch.file_type || "xlsx",
    requestedLocale: batch.requested_locale || "",
    projectId: batch.project_id || "",
    fileMode,
    sheets: Array.isArray(sheets) ? sheets : [],
    statistics: { ...statistics, rowsScanned: Number(statistics.rowsScanned) || Number(batch.row_count) || 0 },
    ai: savedAi || { requested: Boolean(batch.ai_used), used: Boolean(batch.ai_used), reviewed: 0, total: candidates.length },
    candidates,
    status: batch.status || "reviewing",
    createdAt: batch.date_created || null
  };
}

export async function completeDirectusImport(batchId, decisions, summary) {
  const updates = decisions.filter((item) => item.candidateId).map((item) => ({
    id: item.candidateId,
    status: item.status,
    decision: item.decision || (item.status === "accepted" ? "ready" : "excluded")
  }));
  if (updates.length) await updateItemsInChunks("/items/term_candidates", updates);
  await request(`/items/term_import_batches/${encodeURIComponent(batchId)}`, {
    method: "PATCH",
    body: { status: "completed", summary }
  });
}

export async function rebuildDirectusEmbeddings(locale, { forceLocal = false } = {}) {
  assertLocale(locale);
  const model = embeddingModelName();
  if (!model) {
    const error = new Error("未配置 embedding 模型，无法重建向量索引");
    error.statusCode = 400;
    throw error;
  }
  const stats = { memories: 0, qaCases: 0, evidence: 0 };
  const collection = memoryCollectionFor(locale);
  const memoryItems = await request(`/items/${collection}?limit=-1&fields=id,source,embedding`);
  for (const item of memoryItems) {
    if (item.embedding?.vector?.length && item.embedding?.model === model) continue;
    const embedding = await embedSource(item.source, { forceLocal });
    if (!embedding) {
      const error = new Error("embedding 服务不可用，重建中断");
      error.statusCode = 503;
      throw error;
    }
    await request(`/items/${collection}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { embedding } });
    stats.memories += 1;
  }
  // 风格证据不再维护向量（证据池按作用域 + 分层取样读取，不做向量检索）。
  for (const [collectionName, key] of [["qa_cases", "qaCases"]]) {
    const params = new URLSearchParams({ limit: "-1", fields: "id,source,embedding" });
    params.set("filter[target_locale][_eq]", locale);
    const items = await request(`/items/${collectionName}?${params}`);
    for (const item of items) {
      if (item.embedding?.vector?.length && item.embedding?.model === model) continue;
      const embedding = await embedSource(item.source, { forceLocal });
      if (!embedding) {
        const error = new Error("embedding 服务不可用，重建中断");
        error.statusCode = 503;
        throw error;
      }
      await request(`/items/${collectionName}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { embedding } });
      stats[key] += 1;
    }
  }
  return stats;
}

export async function demoteDirectusMemories(locale, source, exceptId, { projectId = "" } = {}) {
  const collection = memoryCollectionFor(locale);
  const params = new URLSearchParams({ limit: "-1", fields: "id,quality_status" });
  // 同样用哈希查：采纳长句译文时，整句原文塞进查询串会报 431。
  // 归一化后为空串的原文照旧走 `_empty`，否则这条查询本身就是 400。
  const sourceHash = memorySourceHash(source);
  if (sourceHash) params.set("filter[source_hash][_eq]", sourceHash);
  else params.set("filter[source_hash][_empty]", "true");
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const items = await request(`/items/${collection}?${params}`);
  const updates = items
    .filter((item) => item.id !== exceptId && item.quality_status !== "rejected")
    .map((item) => ({ id: item.id, quality_status: item.quality_status === "human_approved" ? "machine_verified" : "rejected" }));
  if (updates.length) await request(`/items/${collection}`, { method: "PATCH", body: updates });
  return updates.length;
}

export async function approveDirectusQaCase(id) {
  const saved = await request(`/items/qa_cases/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "human_approved" } });
  return Boolean(saved?.id);
}

function batchMetrics(segments = [], runState = "") {
  const selected = segments.filter((segment) => segment.selected !== false);
  const completedSegments = selected.filter((segment) => segment.status === "done" && segment.translation).length;
  const failedSegments = selected.filter((segment) => segment.status === "error").length;
  const qaPending = selected.filter((segment) => {
    const result = segment.result || {};
    // 人工已经确认过的段落不再算"待处理"：采纳（含审校回填覆盖）本身就是对 QA 意见的处理结论。
    if (segment.accepted === true) return false;
    return Boolean(result.aiQa?.fallbackReason) || (Number.isFinite(result.qaScore) && result.qaScore < 90) || (result.issues || []).length > 0;
  }).length;
  return {
    totalSegments: selected.length, completedSegments, failedSegments, qaPending,
    // 自动档是逐段判定的：文件行要能直接看到实际档位分布，而不是只写"自动"。
    qualityTiers: summarizeQualityTiers(selected),
    status: runState === "ready" ? "ready" : runState === "paused" ? "paused" : failedSegments ? "needs_attention" : completedSegments < selected.length ? "in_progress" : qaPending ? "review" : "completed"
  };
}

export async function saveDirectusBatchRun(input) {
  const id = String(input.batchId || randomUUID());
  const runState = String(input.runState || "");
  const metrics = batchMetrics(input.segments || [], runState);
  const body = {
    filename: String(input.filename || ""),
    project_id: input.projectId || "",
    target_locale: assertLocale(input.locale),
    content_type: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    format: String(input.format || ""),
    segmentation_mode: String(input.segmentationMode || "sentence"),
    structure: input.structure ?? null,
    segments: input.segments || [],
    ...(Object.hasOwn(input, "subBatches") ? { sub_batches: input.subBatches || [] } : {}),
    // 档位分布跟着 runner_options 一起落库：文件列表只查聚合列、不取 segments，
    // 放在这里才能让"自动档实际用了哪几档"直接显示在列表上。
    ...(Object.hasOwn(input, "runnerOptions")
      ? { runner_options: { ...(input.runnerOptions || {}), qualityTierSummary: metrics.qualityTiers, batchSummary: summarizeBatchSegments(input.segments || []) } }
      : {}),
    // 语境档案与质量报告是整份文件级结论：批次记录本身就带，刷新页面不用重算。
    ...(Object.hasOwn(input, "contextBrief") ? { context_brief: input.contextBrief ?? null } : {}),
    ...(Object.hasOwn(input, "qualityReport") ? { quality_report: input.qualityReport ?? null } : {}),
    ...(runState ? { run_state: runState } : {}),
    task_status: metrics.status,
    total_segments: metrics.totalSegments,
    completed_segments: metrics.completedSegments,
    failed_segments: metrics.failedSegments,
    qa_pending: metrics.qaPending
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[id][_eq]", id);
  const existing = await request(`/items/batch_runs?${params}`);
  if (existing[0]?.id) await request(`/items/batch_runs/${encodeURIComponent(id)}`, { method: "PATCH", body });
  else await request("/items/batch_runs", { method: "POST", body: { ...body, id } });
  return { batchId: id };
}

export async function getDirectusBatchRun(batchId) {
  try {
    const item = await request(`/items/batch_runs/${encodeURIComponent(String(batchId))}?fields=id,filename,project_id,target_locale,content_type,domain,format,segmentation_mode,structure,segments,sub_batches,runner_options,context_brief,quality_report,run_state,date_updated`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
    return {
      batchId: item.id,
      filename: item.filename || "",
      projectId: item.project_id || "",
      locale: item.target_locale || "",
      contentType: item.content_type || "general",
      domain: item.domain || "general",
      format: item.format || "",
      segmentationMode: item.segmentation_mode || "sentence",
      structure: item.structure ?? null,
      segments: arrayValue(item.segments),
      subBatches: arrayValue(item.sub_batches),
      runnerOptions: item.runner_options || {},
      contextBrief: item.context_brief ?? null,
      qualityReport: item.quality_report ?? null,
      runState: item.run_state || "ready",
      // 档位分布：详情页有 segments 就现算，没有就用落库时的汇总。
      qualityTiers: arrayValue(item.segments).length ? summarizeQualityTiers(arrayValue(item.segments)) : (item.runner_options?.qualityTierSummary || null),
      updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

/** 删除一条批次运行记录（任务中心"完整删除"用）。 */
export async function deleteDirectusBatchRun(batchId) {
  try {
    await request(`/items/batch_runs/${encodeURIComponent(String(batchId))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

function summarizeBatchRun(item) {
  const fallbackMetrics = item.segments ? batchMetrics(arrayValue(item.segments), item.run_state || "") : null;
  const totalSegments = item.total_segments == null ? fallbackMetrics?.totalSegments || 0 : Number(item.total_segments);
  const completedSegments = item.completed_segments == null ? fallbackMetrics?.completedSegments || 0 : Number(item.completed_segments);
  const failedSegments = item.failed_segments == null ? fallbackMetrics?.failedSegments || 0 : Number(item.failed_segments);
  const qaPending = item.qa_pending == null ? fallbackMetrics?.qaPending || 0 : Number(item.qa_pending);
  const status = item.task_status || fallbackMetrics?.status || "ready";
  return {
    batchId: item.id, filename: item.filename || "未命名任务", projectId: item.project_id || "", locale: item.target_locale || "",
    contentType: item.content_type || "general", domain: item.domain || "general", format: item.format || "",
    segmentationMode: item.segmentation_mode || "sentence", status, runState: item.run_state || "ready",
    runnerOptions: item.runner_options || {},
    // 文件列表要显示"语境分析到哪一步了"：这里只带状态与区间数，不带整份 brief。
    contextBrief: item.context_brief
      ? { status: item.context_brief.status || "", sections: (item.context_brief.sections || []).length }
      : null,
    totalSegments, completedSegments, failedSegments, qaPending,
    qaIncomplete: Number(item.runner_options?.batchSummary?.qaIncomplete) || 0,
    qualityTiers: directusJson(item.runner_options, {})?.qualityTierSummary || null,
    createdAt: item.date_created || null, updatedAt: item.date_updated || item.date_created || null
  };
}

export async function listDirectusBatchRuns({ locale = "", status = "", search = "", projectId = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 200))), sort: "-date_updated,-date_created", fields: "id,filename,project_id,target_locale,content_type,domain,format,segmentation_mode,run_state,task_status,runner_options,context_brief,total_segments,completed_segments,failed_segments,qa_pending,date_created,date_updated" });
  if (locale) params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  if (search) params.set("filter[filename][_icontains]", String(search).slice(0, 120));
  const items = await request(`/items/batch_runs?${params}`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
  // 老批次只读补算 QA 执行失败数，不把低分或 QA 建议误当成“未完成”。
  for (const item of items.filter((entry) => entry.qa_pending > 0 && !entry.runner_options?.batchSummary)) {
    const legacy = await request(`/items/batch_runs/${encodeURIComponent(item.id)}?fields=segments`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
    item.runner_options = { ...(item.runner_options || {}), batchSummary: summarizeBatchSegments(arrayValue(legacy.segments)) };
  }
  for (const item of items.filter((entry) => entry.total_segments == null)) {
    const legacy = await request(`/items/batch_runs/${encodeURIComponent(item.id)}?fields=segments`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
    const metrics = batchMetrics(arrayValue(legacy.segments), item.run_state || "");
    Object.assign(item, { task_status: metrics.status, total_segments: metrics.totalSegments, completed_segments: metrics.completedSegments, failed_segments: metrics.failedSegments, qa_pending: metrics.qaPending });
    await request(`/items/batch_runs/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { task_status: metrics.status, total_segments: metrics.totalSegments, completed_segments: metrics.completedSegments, failed_segments: metrics.failedSegments, qa_pending: metrics.qaPending } });
  }
  const summaries = items.map(summarizeBatchRun);
  return status ? summaries.filter((item) => item.status === status) : summaries;
}

export async function saveDirectusQaTask(input) {
  const id = String(input.id || randomUUID());
  const body = {
    project_id: input.projectId || "",
    title: String(input.title || String(input.sourceText || "").slice(0, 40) || "未命名质检"),
    target_locale: assertLocale(input.locale),
    content_type: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    source_text: String(input.sourceText || ""),
    translation_text: String(input.translationText || ""),
    source_count: Number(input.segmentCounts?.source) || 0,
    translation_count: Number(input.segmentCounts?.translation) || 0,
    overall_score: input.overallScore ?? null,
    dimension_scores: input.dimensionScores ?? null,
    summary: input.summary ?? null,
    alignment_note: String(input.alignmentNote || ""),
    model: String(input.model || ""),
    report: input.report ?? null
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[id][_eq]", id);
  const existing = await request(`/items/qa_tasks?${params}`);
  if (existing[0]?.id) await request(`/items/qa_tasks/${encodeURIComponent(id)}`, { method: "PATCH", body });
  else await request("/items/qa_tasks", { method: "POST", body: { ...body, id } });
  return { id, projectId: body.project_id || "", ...body };
}

export async function getDirectusQaTask(id) {
  try {
    const item = await request(`/items/qa_tasks/${encodeURIComponent(String(id))}?fields=id,project_id,title,target_locale,content_type,domain,source_text,translation_text,source_count,translation_count,overall_score,dimension_scores,summary,alignment_note,model,report,date_created,date_updated`);
    return {
      id: item.id, projectId: item.project_id || "", title: item.title || "", locale: item.target_locale, contentType: item.content_type || "general", domain: item.domain || "general",
      sourceText: item.source_text || "", translationText: item.translation_text || "",
      segmentCounts: { source: Number(item.source_count) || 0, translation: Number(item.translation_count) || 0 },
      overallScore: item.overall_score ?? null, dimensionScores: item.dimension_scores ?? null,
      summary: item.summary ?? null, alignmentNote: item.alignment_note || "", model: item.model || "",
      report: item.report ?? null, createdAt: item.date_created || null, updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function listDirectusQaTasks({ locale = "", projectId = "", status = "", search = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 200))), sort: "-date_updated,-date_created", fields: "id,project_id,title,target_locale,content_type,domain,source_count,overall_score,summary,date_created,date_updated" });
  if (locale) params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  if (search) params.set("filter[title][_icontains]", String(search).slice(0, 120));
  const items = await request(`/items/qa_tasks?${params}`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
  const summaries = items.map((item) => ({
    id: item.id, projectId: item.project_id || "", type: "autoqa", title: item.title || "未命名质检", locale: item.target_locale || "",
    contentType: item.content_type || "general", domain: item.domain || "general",
    status: Number.isFinite(item.overall_score) ? (item.overall_score >= 90 ? "completed" : "review") : "needs_attention",
    overallScore: Number.isFinite(item.overall_score) ? item.overall_score : null,
    totalSegments: Number(item.source_count) || 0, completedSegments: 0, failedSegments: 0,
    qaPending: Object.values(item.summary || {}).reduce((sum, entry) => sum + (Number(entry?.total) || 0), 0),
    createdAt: item.date_created || null, updatedAt: item.date_updated || item.date_created || null
  }));
  return status ? summaries.filter((item) => item.status === status) : summaries;
}

export async function deleteDirectusQaTask(id) {
  try {
    await request(`/items/qa_tasks/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

export async function saveDirectusBackgroundTask(input) {
  const id = String(input.id || randomUUID());
  const body = {
    project_id: input.projectId || "",
    task_type: String(input.type || "term_import"),
    title: String(input.title || "后台任务"),
    target_locale: input.locale ? assertLocale(input.locale) : null,
    status: String(input.status || "in_progress"),
    progress: input.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
    payload: input.payload ?? {}
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[id][_eq]", id);
  const existing = await request(`/items/background_tasks?${params}`);
  if (existing[0]?.id) await request(`/items/background_tasks/${encodeURIComponent(id)}`, { method: "PATCH", body });
  else await request("/items/background_tasks", { method: "POST", body: { ...body, id } });
  return { id, projectId: body.project_id || "", ...body };
}

export async function getDirectusBackgroundTask(id) {
  try {
    const item = await request(`/items/background_tasks/${encodeURIComponent(String(id))}?fields=id,project_id,task_type,title,target_locale,status,progress,payload,date_created,date_updated`);
    return {
      id: item.id, projectId: item.project_id || "", type: item.task_type || "term_import", title: item.title || "",
      locale: item.target_locale || "", status: item.status || "in_progress",
      progress: item.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
      payload: item.payload ?? {},
      createdAt: item.date_created || null, updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function listDirectusBackgroundTasks({ locale = "", projectId = "", status = "", search = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 200))), sort: "-date_updated,-date_created", fields: "id,project_id,task_type,title,target_locale,status,progress,payload,date_created,date_updated" });
  if (locale) params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  if (search) params.set("filter[title][_icontains]", String(search).slice(0, 120));
  const items = await request(`/items/background_tasks?${params}`, { timeoutMs: DIRECTUS_READ_TIMEOUT_MS });
  const tasks = items.map((item) => ({
    id: item.id, projectId: item.project_id || "", type: item.task_type || "term_import", title: item.title || "",
    locale: item.target_locale || "", status: item.status || "in_progress",
    progress: item.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
    payload: item.payload ?? {},
    createdAt: item.date_created || null, updatedAt: item.date_updated || null
  }));
  return status ? tasks.filter((item) => item.status === status) : tasks;
}

export async function deleteDirectusBackgroundTask(id) {
  try {
    await request(`/items/background_tasks/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

export async function findDirectusStyleProfile(id) {
  const fields = "id,project_id,name,target_locale,content_type,domain,instructions,review_rubric,examples,rules,version,parent_id,evidence_count,generated_by,source_batch_id,learning_run_id,evaluation,status,date_updated";
  const shape = (item, kind) => ({
    id: item.id, projectId: item.project_id || "", name: item.name, locale: item.target_locale,
    contentType: item.content_type || "", domain: item.domain || "general",
    instruction: item.instructions, reviewRubric: item.review_rubric || null, examples: arrayValue(item.examples), rules: arrayValue(item.rules),
    version: Number(item.version) || 1, parentId: item.parent_id || null,
    evidenceCount: Number(item.evidence_count) || 0, evaluation: item.evaluation || null,
    status: item.status, kind, updatedAt: item.date_updated
  });
  try {
    const item = await request(`/items/style_profiles/${encodeURIComponent(id)}?fields=${fields}`);
    if (item) return shape(item, "style");
  } catch { /* 不是风格规范就继续找译者画像 */ }
  try {
    const item = await request(`/items/user_profiles/${encodeURIComponent(id)}?fields=id,project_id,name,target_locale,instructions,examples,version,parent_id,evidence_count,status,date_updated`);
    if (item) return shape(item, "user_profile");
  } catch { /* 两张表都没有就是不存在 */ }
  return null;
}

/**
 * Patch the rules of an existing style profile in place.
 *
 * Distillation always writes a NEW version row; retiring one conflicting rule
 * must not, or every approved conflict resolution would spawn a version that
 * then needs its own evaluation and activation before the contradiction
 * actually leaves the prompt.
 */
export async function updateDirectusStyleProfileRules(id, { rules, instruction }) {
  const saved = await request(`/items/style_profiles/${encodeURIComponent(id)}`, {
    method: "PATCH", body: { rules, instructions: instruction }
  });
  return saved ? { id: saved.id, rules: arrayValue(saved.rules), instruction: saved.instructions } : null;
}

export async function saveDirectusStyleProfileEvaluation(id, evaluation) {
  const saved = await request(`/items/style_profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { evaluation } });
  return saved ? { id: saved.id, evaluation: saved.evaluation ?? evaluation } : null;
}

export async function listDirectusStyleProfiles(locale, status, scope = null) {
  assertLocale(locale);
  // evidence_ids 要一起取：界面要按它回溯"这一版规则取样自哪些文件"。
  const styleParams = new URLSearchParams({ limit: "50", sort: "-version,-date_updated", fields: "id,project_id,name,target_locale,content_type,content_tags,domain,instructions,review_rubric,examples,rules,version,parent_id,evidence_count,evidence_ids,generated_by,source_batch_id,learning_run_id,evaluation,status,date_updated" });
  styleParams.set("filter[target_locale][_eq]", locale);
  if (status) styleParams.set("filter[status][_eq]", status);
  if (scope?.projectId) styleParams.set("filter[project_id][_eq]", String(scope.projectId));
  if (scope?.contentType) {
    // Without this the shared 50-row page is sorted by version across all
    // scopes, so a young scope's draft can fall off the end and the distill
    // gate would mistake it for "no draft pending".
    styleParams.set("filter[content_type][_eq]", scope.contentType);
    styleParams.set("filter[domain][_eq]", scope.domain || "general");
  }
  const styleProfiles = await request(`/items/style_profiles?${styleParams}`);
  const profileParams = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,project_id,name,target_locale,instructions,examples,version,parent_id,evidence_count,status,date_updated" });
  profileParams.set("filter[target_locale][_eq]", locale);
  if (scope?.projectId) profileParams.set("filter[project_id][_eq]", String(scope.projectId));
  if (status) profileParams.set("filter[status][_eq]", status);
  const userProfiles = await request(`/items/user_profiles?${profileParams}`);
  return {
    styleProfiles: styleProfiles.map((item) => ({
      id: item.id, projectId: item.project_id || "", name: item.name, locale: item.target_locale, contentType: item.content_type, contentTags: arrayValue(item.content_tags), domain: item.domain || "general",
      instruction: item.instructions, reviewRubric: item.review_rubric || null, examples: arrayValue(item.examples), rules: arrayValue(item.rules), version: Number(item.version) || 1,
      parentId: item.parent_id || null, evidenceCount: Number(item.evidence_count) || 0,
      // 取证 id 一并返回：界面要按它回溯"这一版规则取样自哪些文件"。
      evidenceIds: arrayValue(item.evidence_ids),
      sourceBatchId: item.source_batch_id || "", learningRunId: item.learning_run_id || "",
      evaluation: item.evaluation || null,
      status: item.status, updatedAt: item.date_updated
    })),
    userProfiles: userProfiles.map((item) => ({
      id: item.id, projectId: item.project_id || "", name: item.name, locale: item.target_locale, instruction: item.instructions, examples: arrayValue(item.examples), rules: arrayValue(item.rules),
      version: Number(item.version) || 1, parentId: item.parent_id || null, evidenceCount: Number(item.evidence_count) || 0, status: item.status, updatedAt: item.date_updated
    }))
  };
}

export async function activateDirectusStyleProfile(id) {
  let target;
  try {
    target = await request(`/items/style_profiles/${encodeURIComponent(id)}?fields=id,project_id,target_locale,content_type,domain,status`);
  } catch (error) {
    if (isMissingItem(error)) {
      target = await request(`/items/user_profiles/${encodeURIComponent(id)}?fields=id,project_id,target_locale,status`);
      const deactivateParams = new URLSearchParams({ limit: "-1", fields: "id,status" });
      deactivateParams.set("filter[target_locale][_eq]", target.target_locale);
      if (target.project_id) deactivateParams.set("filter[project_id][_eq]", target.project_id);
      else deactivateParams.set("filter[project_id][_empty]", "true");
      deactivateParams.set("filter[status][_eq]", "active");
      const deactivate = await request(`/items/user_profiles?${deactivateParams}`);
      if (deactivate.length) await request("/items/user_profiles", { method: "PATCH", body: deactivate.map((item) => ({ id: item.id, status: "inactive" })) });
      const saved = await request(`/items/user_profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "active" } });
      return { id: saved.id, kind: "user_profile", status: "active" };
    }
    throw error;
  }
  const params = new URLSearchParams({ limit: "-1", fields: "id,status,domain" });
  params.set("filter[target_locale][_eq]", target.target_locale);
  if (target.project_id) params.set("filter[project_id][_eq]", target.project_id);
  else params.set("filter[project_id][_empty]", "true");
  params.set("filter[status][_eq]", "active");
  // 风格资产是项目级的：激活一个版本时，同项目 + 同语言的其它 active 一律退役。
  // 仍然按 content_type/domain 过滤会让历史作用域规范继续 active，等于同时存在两份"当前规范"。
  const activeOthers = await request(`/items/style_profiles?${params}`);
  const updates = activeOthers.filter((item) => item.id !== id).map((item) => ({ id: item.id, status: "inactive" }));
  if (updates.length) await request("/items/style_profiles", { method: "PATCH", body: updates });
  const saved = await request(`/items/style_profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "active" } });
  return { id: saved.id, kind: "style_profile", status: "active" };
}

export async function rejectDirectusStyleProfile(id) {
  for (const collection of ["style_profiles", "user_profiles"]) {
    try {
      const saved = await request(`/items/${collection}/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "inactive" } });
      return { id: saved.id, kind: collection === "style_profiles" ? "style_profile" : "user_profile", status: "inactive" };
    } catch (error) {
      // Directus deliberately returns 403 for a missing id as well as for an
      // inaccessible one. An id from user_profiles therefore gets 403 on the
      // first style_profiles probe and must continue to the second collection.
      if (!isMissingItem(error)) throw error;
    }
  }
  const error = new Error("未找到该风格规范");
  error.statusCode = 404;
  throw error;
}

export async function listDirectusPendingQaCases(locale, { projectId = "" } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-date_created", fields: "id,project_id,target_locale,content_type,domain,source,rejected_translation,corrected_translation,issues,score_before,score_after,status,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  params.set("filter[status][_eq]", "review");
  const items = await request(`/items/qa_cases?${params}`);
  return items.map((item) => ({
    id: item.id, projectId: item.project_id || "", locale: item.target_locale, contentType: item.content_type, domain: item.domain || "general", source: item.source,
    rejectedTranslation: item.rejected_translation, correctedTranslation: item.corrected_translation, issues: arrayValue(item.issues),
    scoreBefore: Number(item.score_before) || 0, scoreAfter: Number(item.score_after) || 0, status: item.status, createdAt: item.date_created
  }));
}

export async function disposeDirectusQaCase(id) {
  await request(`/items/qa_cases/${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

const LEARNING_TRAJECTORY_STATUSES = new Set(["running", "completed", "review", "failed"]);
const TRANSLATION_SKILL_STATUSES = new Set(["champion", "challenger", "draft", "inactive", "rejected"]);
const SKILL_EVALUATION_DECISIONS = new Set(["pending", "promote", "reject", "needs_review"]);

function assertLearningChoice(value, allowed, label) {
  if (!allowed.has(value)) {
    const error = new Error(`Unsupported ${label}: ${value}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function directusJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return structuredClone(fallback);
}

function directusLearningScope(input, fallback = {}) {
  return {
    locale: assertLocale(input.locale ?? fallback.locale),
    contentType: String(input.contentType ?? fallback.contentType ?? "general").trim() || "general",
    domain: String(input.domain ?? fallback.domain ?? "general").trim() || "general",
    project: String(input.project ?? fallback.project ?? "default").trim() || "default"
  };
}

function sameDirectusLearningScope(left, right) {
  return left.locale === right.locale
    && left.project === right.project;
}

function translationSkillScopeKey(scope) {
  const normalized = directusLearningScope(scope);
  return createHash("sha256")
    // 语体/领域只作参考：生效版本的唯一性按「语言 × 项目」结算，一个项目只能有一个 champion。
    .update([normalized.locale, normalized.project].join("\u0000"))
    .digest("hex");
}

function translationSkillVersionKey(scope, version) {
  return createHash("sha256")
    .update(`${translationSkillScopeKey(scope)}\u0000${Math.max(1, Number(version) || 1)}`)
    .digest("hex");
}

function directusConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function assertDirectusImmutable(existing, patch, fields) {
  for (const field of fields) {
    if (Object.hasOwn(patch, field) && patch[field] != null && String(patch[field]) !== String(existing[field] ?? "")) {
      throw directusConflict(`${field} is immutable after creation`);
    }
  }
}

function addLearningScopeFilters(params, filters = {}) {
  if (filters.locale) params.set("filter[target_locale][_eq]", assertLocale(filters.locale));
  // 语体与领域降级为标签：学习资产（轨迹/技能/评测/Gold/门禁/训练）只按「语言 × 项目」结算。
  if (filters.project) params.set("filter[project][_eq]", filters.project);
  return params;
}

function directusListLimit(value, fallback = 100) {
  return String(Math.min(1_000, Math.max(1, Number(value) || fallback)));
}

function mapLearningTrajectory(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    batchId: item.batch_id || "",
    segmentId: item.segment_id || "",
    source: item.source || "",
    initialTranslation: item.initial_translation || "",
    finalTranslation: item.final_translation || "",
    contextPack: directusJson(item.context_pack),
    assetRefs: directusJson(item.asset_refs, []),
    termDecisions: directusJson(item.term_decisions, []),
    qaBefore: directusJson(item.qa_before),
    qaAfter: directusJson(item.qa_after),
    humanDecision: directusJson(item.human_decision),
    events: directusJson(item.events, []),
    model: item.model || "",
    promptVersion: item.prompt_version || "",
    status: item.status || "running",
    error: item.error || "",
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function learningTrajectoryBody(input, fallback = {}) {
  const scope = directusLearningScope(input, fallback);
  const status = assertLearningChoice(input.status ?? fallback.status ?? "running", LEARNING_TRAJECTORY_STATUSES, "learning trajectory status");
  const source = String(input.source ?? fallback.source ?? "");
  if (!source) {
    const error = new Error("Learning trajectory source cannot be empty");
    error.statusCode = 400;
    throw error;
  }
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    batch_id: String(input.batchId ?? fallback.batchId ?? ""),
    segment_id: String(input.segmentId ?? fallback.segmentId ?? ""),
    source,
    initial_translation: String(input.initialTranslation ?? fallback.initialTranslation ?? ""),
    final_translation: String(input.finalTranslation ?? fallback.finalTranslation ?? ""),
    context_pack: directusJson(input.contextPack ?? fallback.contextPack),
    asset_refs: directusJson(input.assetRefs ?? fallback.assetRefs, []),
    term_decisions: directusJson(input.termDecisions ?? fallback.termDecisions, []),
    qa_before: directusJson(input.qaBefore ?? fallback.qaBefore),
    qa_after: directusJson(input.qaAfter ?? fallback.qaAfter),
    human_decision: directusJson(input.humanDecision ?? fallback.humanDecision),
    events: directusJson(input.events ?? fallback.events, []),
    model: String(input.model ?? fallback.model ?? ""),
    prompt_version: String(input.promptVersion ?? fallback.promptVersion ?? ""),
    status,
    error: String(input.error ?? fallback.error ?? "")
  };
}

function learningTrajectoryPatch(patch) {
  const body = {};
  const assign = (key, field, normalize = (value) => value) => {
    if (Object.hasOwn(patch, key)) body[field] = normalize(patch[key]);
  };
  assign("initialTranslation", "initial_translation", (value) => String(value ?? ""));
  assign("finalTranslation", "final_translation", (value) => String(value ?? ""));
  assign("contextPack", "context_pack", (value) => directusJson(value));
  assign("assetRefs", "asset_refs", (value) => directusJson(value, []));
  assign("termDecisions", "term_decisions", (value) => directusJson(value, []));
  assign("qaBefore", "qa_before", (value) => directusJson(value));
  assign("qaAfter", "qa_after", (value) => directusJson(value));
  assign("humanDecision", "human_decision", (value) => directusJson(value));
  assign("events", "events", (value) => directusJson(value, []));
  assign("model", "model", (value) => String(value ?? ""));
  assign("promptVersion", "prompt_version", (value) => String(value ?? ""));
  assign("status", "status", (value) => assertLearningChoice(value, LEARNING_TRAJECTORY_STATUSES, "learning trajectory status"));
  assign("error", "error", (value) => String(value ?? ""));
  return body;
}

export async function saveDirectusLearningTrajectory(input) {
  if (input.id) {
    const existing = await getDirectusLearningTrajectory(input.id);
    if (existing) return updateDirectusLearningTrajectory(input.id, input);
  }
  const body = learningTrajectoryBody(input);
  const saved = await request("/items/learning_trajectories", { method: "POST", body: { ...(input.id ? { id: input.id } : {}), ...body } });
  return mapLearningTrajectory(saved);
}

export async function listDirectusLearningTrajectories(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: directusListLimit(filters.limit), sort: "-date_updated,-date_created", fields: "*" }), filters);
  if (filters.batchId) params.set("filter[batch_id][_eq]", filters.batchId);
  if (filters.status) params.set("filter[status][_eq]", filters.status);
  return (await request(`/items/learning_trajectories?${params}`)).map(mapLearningTrajectory);
}

/**
 * 项目里每个「语体 × 领域」各有多少条可直接学习的轨迹，以及它们来自哪些文件。
 *
 * 学习中心一次只看一个作用域，而语体/领域是逐段判定的：用户刚导入完语料，
 * 打开的是默认作用域（待分类文本 × 通用），真实轨迹却都在别的领域里。
 * 这里只做聚合（口径与「当前范围有效轨迹」一致：completed / review 且有最终译文），
 * 用来常驻显示"每个范围各有多少条、来自哪个文件"，不拉明细。
 * 条数走 groupBy（精确、便宜）；来源文件按轨迹自己的 asset_refs.source_file 归组，
 * 没有就退回它所属批次的原文件名（批次可能已被删，所以不能只靠 batch_runs）。
 */
export async function countDirectusLearningTrajectoriesByScope({ locale, project = "" } = {}) {
  const scoped = (params) => {
    params.set("filter[target_locale][_eq]", assertLocale(locale));
    if (project) params.set("filter[project][_eq]", String(project));
    params.set("filter[status][_in]", "completed,review");
    params.set("filter[final_translation][_nempty]", "true");
    return params;
  };
  const countParams = scoped(new URLSearchParams({ "aggregate[count]": "id" }));
  countParams.append("groupBy[]", "content_type");
  countParams.append("groupBy[]", "domain");
  // 文件要读每条轨迹的 asset_refs（JSON 字段没法 groupBy），所以单独扫一遍；
  // 上限 2000 条：条数仍由上面的聚合保证精确，文件列表在最坏情况下可能不完整。
  const fileParams = scoped(new URLSearchParams({ limit: "2000", fields: "content_type,domain,batch_id,asset_refs" }));
  const [countRows, fileRows, batchRows] = await Promise.all([
    request(`/items/learning_trajectories?${countParams}`),
    request(`/items/learning_trajectories?${fileParams}`).catch(() => []),
    project
      ? request(`/items/batch_runs?limit=-1&fields=id,filename&filter%5Bproject_id%5D%5B_eq%5D=${encodeURIComponent(String(project))}`).catch(() => [])
      : Promise.resolve([])
  ]);
  const fileNameByBatch = new Map((batchRows || []).map((row) => [String(row.id || ""), String(row.filename || "")]));
  const filesByScope = new Map();
  for (const row of fileRows || []) {
    // asset_refs 里存的是应用侧的驼峰键（sourceFile）；snake_case 兜底兼容历史数据。
    const file = String(row.asset_refs?.sourceFile || row.asset_refs?.source_file || fileNameByBatch.get(String(row.batch_id || "")) || "").trim();
    if (!file) continue;
    const contentType = row.content_type || "general";
    const domain = row.domain || "general";
    const key = `${contentType}\u0000${domain}`;
    const bucket = filesByScope.get(key) || new Map();
    bucket.set(file, (bucket.get(file) || 0) + 1);
    filesByScope.set(key, bucket);
  }
  return (countRows || [])
    .map((row) => {
      const contentType = row.content_type || "general";
      const domain = row.domain || "general";
      const bucket = filesByScope.get(`${contentType}\u0000${domain}`) || new Map();
      return {
        contentType,
        domain,
        count: Number(row.count?.id ?? row.count) || 0,
        files: [...bucket.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      };
    })
    .filter((item) => item.count > 0);
}

export async function getDirectusLearningTrajectory(id) {
  try {
    return mapLearningTrajectory(await request(`/items/learning_trajectories/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

/**
 * 记忆库文件层用：每个来源文件各有多少条学习轨迹、其中多少条已经有人工终稿。
 *
 * 来源文件存在 asset_refs 里（JSON 字段没法 groupBy，也没有独立的列），所以只能扫一遍
 * 明细；limit 给 2000 与学习中心的范围聚合保持一致。批次的 asset_refs 缺失时退回批次
 * 文件名（批次可能已被删，所以只作为兜底）。status 这里故意不过滤：文件层要回答的是
 * "这个文件有没有被学习过"，而不是"够不够格拿去蒸馏"。
 */
export async function countDirectusLearningTrajectoriesByFile({ locale, project = "" } = {}) {
  const params = new URLSearchParams({ limit: "2000", fields: "asset_refs,batch_id,human_decision" });
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (project) params.set("filter[project][_eq]", String(project));
  const rows = await request(`/items/learning_trajectories?${params}`).catch(() => []);
  const batchIds = [...new Set((rows || []).map((row) => String(row.batch_id || "")).filter(Boolean))];
  const fileNameByBatch = new Map();
  for (let index = 0; index < batchIds.length; index += 50) {
    const chunk = batchIds.slice(index, index + 50);
    const batchParams = new URLSearchParams({ limit: "-1", fields: "id,filename" });
    batchParams.set("filter[id][_in]", chunk.join(","));
    const batchRows = await request(`/items/batch_runs?${batchParams}`).catch(() => []);
    for (const row of batchRows || []) fileNameByBatch.set(String(row.id || ""), String(row.filename || ""));
  }
  const counts = new Map();
  for (const row of rows || []) {
    const assetRefs = directusJson(row.asset_refs, []);
    const sourceFile = String(assetRefs?.sourceFile || assetRefs?.source_file || fileNameByBatch.get(String(row.batch_id || "")) || "").trim();
    if (!sourceFile) continue;
    const entry = counts.get(sourceFile) || { sourceFile, count: 0, humanReviewed: 0 };
    entry.count += 1;
    if (directusJson(row.human_decision, {})?.accepted === true) entry.humanReviewed += 1;
    counts.set(sourceFile, entry);
  }
  return [...counts.values()];
}

export async function updateDirectusLearningTrajectory(id, patch) {
  const existing = await getDirectusLearningTrajectory(id);
  if (!existing) return null;
  assertDirectusImmutable(existing, patch, ["locale", "contentType", "domain", "project", "batchId", "segmentId", "source"]);
  const body = learningTrajectoryPatch(patch);
  if (!Object.keys(body).length) return existing;
  const saved = await request(`/items/learning_trajectories/${encodeURIComponent(String(id))}`, { method: "PATCH", body });
  return mapLearningTrajectory(saved);
}

function mapTranslationSkill(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    name: item.name || "",
    description: item.description || "",
    changeReason: item.change_reason || "",
    version: Number(item.version) || 1,
    parentId: item.parent_id || null,
    status: item.status || "draft",
    strategy: directusJson(item.strategy),
    evidenceIds: directusJson(item.evidence_ids, []),
    promptVersion: item.prompt_version || "",
    metrics: directusJson(item.metrics),
    metadata: directusJson(item.metadata),
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function translationSkillBody(input, fallback = {}) {
  const scope = directusLearningScope(input, fallback);
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    name: String(input.name ?? fallback.name ?? `${scope.locale} ${scope.contentType} translation skill`).trim(),
    description: String(input.description ?? fallback.description ?? ""),
    change_reason: String(input.changeReason ?? fallback.changeReason ?? ""),
    version: Math.max(1, Number(input.version ?? fallback.version) || 1),
    parent_id: input.parentId === null ? null : String(input.parentId ?? fallback.parentId ?? "") || null,
    status: assertLearningChoice(input.status ?? fallback.status ?? "draft", TRANSLATION_SKILL_STATUSES, "translation skill status"),
    strategy: directusJson(input.strategy ?? fallback.strategy),
    evidence_ids: directusJson(input.evidenceIds ?? fallback.evidenceIds, []),
    prompt_version: String(input.promptVersion ?? fallback.promptVersion ?? ""),
    metrics: directusJson(input.metrics ?? fallback.metrics),
    metadata: directusJson(input.metadata ?? fallback.metadata),
    version_scope_key: translationSkillVersionKey(scope, input.version ?? fallback.version),
    champion_scope_key: input.status === "champion" ? translationSkillScopeKey(scope) : null
  };
}

function translationSkillPatch(patch) {
  const body = {};
  const assign = (key, field, normalize = (value) => value) => {
    if (Object.hasOwn(patch, key)) body[field] = normalize(patch[key]);
  };
  assign("name", "name", (value) => String(value ?? "").trim());
  assign("description", "description", (value) => String(value ?? ""));
  assign("changeReason", "change_reason", (value) => String(value ?? ""));
  assign("strategy", "strategy", (value) => directusJson(value));
  assign("evidenceIds", "evidence_ids", (value) => directusJson(value, []));
  assign("promptVersion", "prompt_version", (value) => String(value ?? ""));
  assign("metrics", "metrics", (value) => directusJson(value));
  assign("metadata", "metadata", (value) => directusJson(value));
  assign("status", "status", (value) => assertLearningChoice(value, TRANSLATION_SKILL_STATUSES, "translation skill status"));
  return body;
}

async function latestDirectusTranslationSkill(scope) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: "1", sort: "-version,-date_updated", fields: "*" }), scope);
  return mapTranslationSkill((await request(`/items/translation_skills?${params}`))[0]);
}

export async function saveDirectusTranslationSkill(input) {
  if (input.id) {
    const existing = await getDirectusTranslationSkill(input.id);
    if (existing) return updateDirectusTranslationSkill(input.id, input);
  }
  const scope = directusLearningScope(input);
  const previous = await latestDirectusTranslationSkill(scope);
  // 版本号不能照抄调用方的建议值：被拒绝的旧候选会占着它的版本号，
  // 于是"重新生成候选"会撞号并直接 409。取「建议版本」与「下一个空闲版本」的较大者。
  const version = Math.max(1, Number(input.version) || 0, (Number(previous?.version) || 0) + 1);
  const versionParams = addLearningScopeFilters(new URLSearchParams({ limit: "1", fields: "id" }), scope);
  versionParams.set("filter[version][_eq]", String(version));
  if ((await request(`/items/translation_skills?${versionParams}`))[0]) throw directusConflict(`Translation skill version ${version} already exists in this scope`);
  const parentId = input.parentId === null ? null : input.parentId || previous?.id || null;
  if (parentId) {
    const parent = await getDirectusTranslationSkill(parentId);
    if (!parent || !sameDirectusLearningScope(parent, scope)) throw directusConflict("Translation skill parent must exist in the same scope");
  }
  const requestedStatus = assertLearningChoice(input.status || "draft", TRANSLATION_SKILL_STATUSES, "translation skill status");
  const body = translationSkillBody({
    ...input,
    ...scope,
    version,
    parentId,
    status: requestedStatus === "champion" ? "draft" : requestedStatus
  });
  const saved = mapTranslationSkill(await request("/items/translation_skills", { method: "POST", body: { ...(input.id ? { id: input.id } : {}), ...body } }));
  return requestedStatus === "champion" ? activateDirectusTranslationSkill(saved.id) : saved;
}

export async function listDirectusTranslationSkills(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: directusListLimit(filters.limit), sort: "-version,-date_updated", fields: "*" }), filters);
  if (filters.status) params.set("filter[status][_eq]", filters.status);
  return (await request(`/items/translation_skills?${params}`)).map(mapTranslationSkill);
}

export async function getDirectusTranslationSkill(id) {
  try {
    return mapTranslationSkill(await request(`/items/translation_skills/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function updateDirectusTranslationSkill(id, patch) {
  const existing = await getDirectusTranslationSkill(id);
  if (!existing) return null;
  assertDirectusImmutable(existing, patch, ["locale", "contentType", "domain", "project", "version", "parentId"]);
  const requestedStatus = Object.hasOwn(patch, "status") ? assertLearningChoice(patch.status, TRANSLATION_SKILL_STATUSES, "translation skill status") : null;
  if (existing.status === "champion" && requestedStatus && requestedStatus !== "champion") {
    throw directusConflict("The current champion must be replaced or rolled back, not directly deactivated");
  }
  if (existing.status === "rejected" && requestedStatus && requestedStatus !== "rejected") {
    throw directusConflict("Rejected translation skill cannot be reactivated through update");
  }
  const body = translationSkillPatch(patch);
  if (requestedStatus === "champion") delete body.status;
  else if (requestedStatus) body.champion_scope_key = null;
  let saved = existing;
  if (Object.keys(body).length) saved = mapTranslationSkill(await request(`/items/translation_skills/${encodeURIComponent(String(id))}`, { method: "PATCH", body }));
  return requestedStatus === "champion" ? activateDirectusTranslationSkill(saved.id) : saved;
}

export async function activateDirectusTranslationSkill(id, { rollback = false } = {}) {
  const target = await getDirectusTranslationSkill(id);
  if (!target) return null;
  if (target.status === "rejected") throw directusConflict("Rejected translation skill cannot be activated");
  const params = addLearningScopeFilters(new URLSearchParams({ limit: "-1", sort: "-version,-date_updated", fields: "id,target_locale,content_type,domain,project,parent_id,version,status" }), target);
  params.set("filter[status][_eq]", "champion");
  const current = (await request(`/items/translation_skills?${params}`)).map(mapTranslationSkill);
  const otherChampions = current.filter((item) => item.id !== target.id);
  if (otherChampions.length && target.status !== "champion") {
    const isChildOfCurrent = otherChampions.some((item) => target.parentId === item.id);
    const isRollbackTarget = rollback && otherChampions.some((item) => item.parentId === target.id);
    if (!isChildOfCurrent && !isRollbackTarget) throw directusConflict("Translation skill was not evaluated against the current champion");
  }
  const updates = [
    ...otherChampions.map((item) => ({ id: item.id, status: "inactive", champion_scope_key: null })),
    { id: target.id, status: "champion", champion_scope_key: translationSkillScopeKey(target) }
  ];
  try {
    await request("/items/translation_skills", { method: "PATCH", body: updates, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
  } catch (error) {
    if (/champion_scope_key|unique|duplicate/i.test(error.message)) error.statusCode = 409;
    throw error;
  }
  return getDirectusTranslationSkill(target.id);
}

export async function rollbackDirectusTranslationSkill(id) {
  const current = await getDirectusTranslationSkill(id);
  if (!current) return null;
  if (current.status !== "champion") {
    const error = new Error("Only the current champion translation skill can be rolled back");
    error.statusCode = 409;
    throw error;
  }
  let parent = current.parentId ? await getDirectusTranslationSkill(current.parentId) : null;
  if (parent && (parent.status === "rejected" || parent.locale !== current.locale || parent.contentType !== current.contentType || parent.domain !== current.domain || parent.project !== current.project)) parent = null;
  if (!parent) {
    const candidates = await listDirectusTranslationSkills({ locale: current.locale, contentType: current.contentType, domain: current.domain, project: current.project, limit: 1_000 });
    parent = candidates.filter((item) => item.id !== current.id && item.status !== "rejected" && item.version < current.version).sort((a, b) => b.version - a.version)[0] || null;
  }
  if (!parent) {
    const error = new Error("No previous translation skill version is available for rollback");
    error.statusCode = 409;
    throw error;
  }
  const champion = await activateDirectusTranslationSkill(parent.id, { rollback: true });
  return { rolledBack: await getDirectusTranslationSkill(current.id), champion };
}

function mapSkillEvaluation(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    championSkillId: item.champion_skill_id || "",
    challengerSkillId: item.challenger_skill_id || "",
    sampleCount: Number(item.sample_count) || 0,
    championMetrics: directusJson(item.champion_metrics),
    challengerMetrics: directusJson(item.challenger_metrics),
    metricDeltas: directusJson(item.metric_deltas),
    decision: item.decision || "pending",
    report: directusJson(item.report),
    evaluator: item.evaluator || "",
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function skillEvaluationBody(input, fallback = {}) {
  const scope = directusLearningScope(input, fallback);
  const championSkillId = String(input.championSkillId ?? fallback.championSkillId ?? "");
  const challengerSkillId = String(input.challengerSkillId ?? fallback.challengerSkillId ?? "");
  if (!championSkillId || !challengerSkillId || championSkillId === challengerSkillId) {
    const error = new Error("Skill evaluation requires distinct championSkillId and challengerSkillId");
    error.statusCode = 400;
    throw error;
  }
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    champion_skill_id: championSkillId,
    challenger_skill_id: challengerSkillId,
    sample_count: Math.max(0, Number(input.sampleCount ?? fallback.sampleCount) || 0),
    champion_metrics: directusJson(input.championMetrics ?? fallback.championMetrics),
    challenger_metrics: directusJson(input.challengerMetrics ?? fallback.challengerMetrics),
    metric_deltas: directusJson(input.metricDeltas ?? fallback.metricDeltas),
    decision: assertLearningChoice(input.decision ?? fallback.decision ?? "pending", SKILL_EVALUATION_DECISIONS, "skill evaluation decision"),
    report: directusJson(input.report ?? fallback.report),
    evaluator: String(input.evaluator ?? fallback.evaluator ?? "")
  };
}

function mapSkillEvaluationBody(body) {
  return {
    locale: body.target_locale,
    contentType: body.content_type,
    domain: body.domain,
    project: body.project,
    championSkillId: body.champion_skill_id,
    challengerSkillId: body.challenger_skill_id,
    decision: body.decision
  };
}

async function validateDirectusSkillEvaluation(input) {
  const [champion, challenger] = await Promise.all([
    getDirectusTranslationSkill(input.championSkillId),
    getDirectusTranslationSkill(input.challengerSkillId)
  ]);
  if (!champion || champion.status !== "champion" || !sameDirectusLearningScope(champion, input)) {
    throw directusConflict("Skill evaluation champion is not the current champion in this scope");
  }
  if (!challenger || !["challenger", "draft"].includes(challenger.status) || !sameDirectusLearningScope(challenger, input)) {
    throw directusConflict("Skill evaluation challenger is not an active candidate in this scope");
  }
}

function skillEvaluationPatch(patch) {
  const body = {};
  const assign = (key, field, normalize = (value) => value) => {
    if (Object.hasOwn(patch, key)) body[field] = normalize(patch[key]);
  };
  assign("sampleCount", "sample_count", (value) => Math.max(0, Number(value) || 0));
  assign("championMetrics", "champion_metrics", (value) => directusJson(value));
  assign("challengerMetrics", "challenger_metrics", (value) => directusJson(value));
  assign("metricDeltas", "metric_deltas", (value) => directusJson(value));
  assign("decision", "decision", (value) => assertLearningChoice(value, SKILL_EVALUATION_DECISIONS, "skill evaluation decision"));
  assign("report", "report", (value) => directusJson(value));
  assign("evaluator", "evaluator", (value) => String(value ?? ""));
  return body;
}

export async function saveDirectusSkillEvaluation(input) {
  if (input.id) {
    const existing = await getDirectusSkillEvaluation(input.id);
    if (existing) return updateDirectusSkillEvaluation(input.id, input);
  }
  const body = skillEvaluationBody(input);
  await validateDirectusSkillEvaluation(mapSkillEvaluationBody(body));
  return mapSkillEvaluation(await request("/items/skill_evaluations", { method: "POST", body: { ...(input.id ? { id: input.id } : {}), ...body } }));
}

export async function listDirectusSkillEvaluations(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: directusListLimit(filters.limit), sort: "-date_updated,-date_created", fields: "*" }), filters);
  if (filters.decision) params.set("filter[decision][_eq]", filters.decision);
  if (filters.championSkillId) params.set("filter[champion_skill_id][_eq]", filters.championSkillId);
  if (filters.challengerSkillId) params.set("filter[challenger_skill_id][_eq]", filters.challengerSkillId);
  return (await request(`/items/skill_evaluations?${params}`)).map(mapSkillEvaluation);
}

export async function getDirectusSkillEvaluation(id) {
  try {
    return mapSkillEvaluation(await request(`/items/skill_evaluations/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function updateDirectusSkillEvaluation(id, patch) {
  const existing = await getDirectusSkillEvaluation(id);
  if (!existing) return null;
  assertDirectusImmutable(existing, patch, ["locale", "contentType", "domain", "project", "championSkillId", "challengerSkillId"]);
  const body = skillEvaluationPatch(patch);
  if (body.decision === "promote") await validateDirectusSkillEvaluation({ ...existing, decision: body.decision });
  if (!Object.keys(body).length) return existing;
  return mapSkillEvaluation(await request(`/items/skill_evaluations/${encodeURIComponent(String(id))}`, { method: "PATCH", body }));
}

const QUALITY_ASSET_KINDS = new Set(["gold_set", "regression_candidate", "regression_suite"]);
const QUALITY_GATE_DECISIONS = new Set(["pass", "block", "insufficient"]);

function mapQualityAsset(item) {
  if (!item) return null;
  return {
    id: item.id,
    kind: item.kind || "",
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    name: item.name || "",
    description: item.description || "",
    seriesId: item.series_id || "",
    version: Number(item.version) || 1,
    parentVersionId: item.parent_version_id || "",
    status: item.status || "draft",
    enabled: Boolean(item.enabled),
    itemCount: Number(item.item_count) || 0,
    sourceQaCaseId: item.source_qa_case_id || "",
    fingerprint: item.fingerprint || "",
    payload: directusJson(item.payload),
    approval: directusJson(item.approval, null),
    changeNote: item.change_note || "",
    createdBy: item.created_by || "",
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

/**
 * The normalized record from gold-regression.mjs is stored verbatim in
 * `payload`; the columns are projections used only for admin browsing and
 * filtering. Nothing reads a quality asset back out of the columns.
 */
function qualityAssetBody(input) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  const scope = directusLearningScope(input.scope || payload.scope || input, {});
  const kind = assertLearningChoice(String(input.kind ?? payload.kind ?? ""), QUALITY_ASSET_KINDS, "quality asset kind");
  const items = Array.isArray(payload.samples) ? payload.samples : Array.isArray(payload.cases) ? payload.cases : [];
  return {
    kind,
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    name: String(payload.name ?? input.name ?? "").trim(),
    description: String(payload.description ?? input.description ?? ""),
    series_id: String(payload.seriesId ?? input.seriesId ?? payload.id ?? ""),
    version: Number(payload.version ?? input.version ?? 1),
    parent_version_id: String(payload.parentVersionId ?? input.parentVersionId ?? ""),
    status: String(payload.status ?? input.status ?? "draft"),
    enabled: Boolean(payload.enabled ?? input.enabled ?? false),
    item_count: items.length,
    source_qa_case_id: String(payload.sourceQaCaseId ?? input.sourceQaCaseId ?? ""),
    fingerprint: String(payload.fingerprint ?? input.fingerprint ?? ""),
    payload,
    approval: payload.approval ?? input.approval ?? null,
    change_note: String(payload.changeNote ?? input.changeNote ?? ""),
    created_by: String(payload.createdBy ?? input.createdBy ?? "")
  };
}

/**
 * The row id is Directus's own UUID. The asset's semantic id (`series#v2`)
 * stays inside the payload, because a version-scoped string is not a valid
 * primary key here and Directus rejects one as a permission error.
 */
export async function saveDirectusQualityAsset(input) {
  const body = qualityAssetBody(input);
  const id = String(input.id ?? "");
  if (id) {
    const existing = await getDirectusQualityAsset(id);
    if (existing) return mapQualityAsset(await request(`/items/quality_assets/${encodeURIComponent(id)}`, { method: "PATCH", body }));
  }
  return mapQualityAsset(await request("/items/quality_assets", { method: "POST", body }));
}

export async function listDirectusQualityAssets(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({
    limit: directusListLimit(filters.limit, 200),
    sort: "-date_created",
    fields: "*"
  }), filters);
  if (filters.kind) params.set("filter[kind][_eq]", assertLearningChoice(String(filters.kind), QUALITY_ASSET_KINDS, "quality asset kind"));
  if (filters.status) params.set("filter[status][_eq]", String(filters.status));
  if (filters.seriesId) params.set("filter[series_id][_eq]", String(filters.seriesId));
  if (filters.sourceQaCaseId) params.set("filter[source_qa_case_id][_eq]", String(filters.sourceQaCaseId));
  if (filters.enabled !== undefined) params.set("filter[enabled][_eq]", filters.enabled ? "true" : "false");
  return (await request(`/items/quality_assets?${params}`)).map(mapQualityAsset);
}

export async function getDirectusQualityAsset(id) {
  try {
    return mapQualityAsset(await request(`/items/quality_assets/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

/**
 * Only lifecycle columns are patchable. Changing the content of a fixed asset
 * requires a new version, which is what keeps a gate result reproducible.
 */
export async function updateDirectusQualityAsset(id, patch = {}) {
  const existing = await getDirectusQualityAsset(id);
  if (!existing) return null;
  const body = {};
  if (patch.status !== undefined) body.status = String(patch.status);
  if (patch.enabled !== undefined) body.enabled = Boolean(patch.enabled);
  if (patch.approval !== undefined) body.approval = patch.approval;
  if (patch.changeNote !== undefined) body.change_note = String(patch.changeNote);
  if (patch.payload !== undefined) body.payload = patch.payload;
  if (!Object.keys(body).length) return existing;
  return mapQualityAsset(await request(`/items/quality_assets/${encodeURIComponent(String(id))}`, { method: "PATCH", body }));
}

function mapQualityRun(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    skillId: item.skill_id || "",
    skillVersion: item.skill_version || "",
    decision: item.decision || "insufficient",
    regressionTotal: Number(item.regression_total) || 0,
    regressionPassed: Number(item.regression_passed) || 0,
    regressionPassRate: item.regression_pass_rate === null || item.regression_pass_rate === undefined ? null : Number(item.regression_pass_rate),
    goldTotal: Number(item.gold_total) || 0,
    goldTermAccuracy: item.gold_term_accuracy === null || item.gold_term_accuracy === undefined ? null : Number(item.gold_term_accuracy),
    goldFactAccuracy: item.gold_fact_accuracy === null || item.gold_fact_accuracy === undefined ? null : Number(item.gold_fact_accuracy),
    assetVersions: directusJson(item.asset_versions, {}),
    metrics: directusJson(item.metrics, {}),
    report: directusJson(item.report, {}),
    blocking: directusJson(item.blocking, []),
    triggeredBy: item.triggered_by || "",
    createdAt: item.date_created || null
  };
}

/**
 * 可空指标：这类字段"没测出来"和"测出来是 0"是两件事。`Number(null)` 是 0，
 * 直接用它做判断会把"本批 Gold 样本没有术语约束、指标不可测"写成 0.0%，
 * 界面上看起来就像术语全错。null / 空串 / 非数值一律存 null。
 */
export function nullableMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 门禁运行记录的请求体；抽成纯函数便于直接断言真正发出去的字段。 */
export function qualityRunBody(input = {}) {
  const scope = directusLearningScope(input.scope || input, {});
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    skill_id: String(input.skillId ?? ""),
    skill_version: String(input.skillVersion ?? ""),
    decision: assertLearningChoice(String(input.decision ?? "insufficient"), QUALITY_GATE_DECISIONS, "quality gate decision"),
    regression_total: Number(input.regressionTotal) || 0,
    regression_passed: Number(input.regressionPassed) || 0,
    regression_pass_rate: nullableMetric(input.regressionPassRate),
    gold_total: Number(input.goldTotal) || 0,
    gold_term_accuracy: nullableMetric(input.goldTermAccuracy),
    gold_fact_accuracy: nullableMetric(input.goldFactAccuracy),
    asset_versions: input.assetVersions ?? {},
    metrics: input.metrics ?? {},
    report: input.report ?? {},
    blocking: input.blocking ?? [],
    triggered_by: String(input.triggeredBy ?? "")
  };
}

export async function saveDirectusQualityRun(input) {
  const body = qualityRunBody(input);
  return mapQualityRun(await request("/items/quality_runs", { method: "POST", body }));
}

export async function listDirectusQualityRuns(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({
    limit: directusListLimit(filters.limit, 50),
    sort: "-date_created",
    fields: "*"
  }), filters);
  if (filters.skillId) params.set("filter[skill_id][_eq]", String(filters.skillId));
  if (filters.decision) params.set("filter[decision][_eq]", String(filters.decision));
  return (await request(`/items/quality_runs?${params}`)).map(mapQualityRun);
}

/**
 * 只更新运行记录的附加内容（复盘报告）。结论、计数与资产版本属于门禁留档，
 * 不允许在这里被改写——那等于事后篡改结论。
 */
export async function updateDirectusQualityRun(id, patch = {}) {
  const current = await request(`/items/quality_runs/${encodeURIComponent(String(id))}?fields=id,report`).catch((error) => {
    if (isMissingItem(error)) return null;
    throw error;
  });
  if (!current?.id) return null;
  const report = { ...(directusJson(current.report, {}) || {}), ...(patch.report || {}) };
  return mapQualityRun(await request(`/items/quality_runs/${encodeURIComponent(String(id))}`, { method: "PATCH", body: { report } }));
}

function mapTrainingRun(item) {
  if (!item) return null;
  const payload = directusJson(item.payload);
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    name: item.name || "",
    method: item.method || "sft",
    status: item.status || "draft",
    baseModel: item.base_model || "",
    teacherModel: item.teacher_model || "",
    artifactModelId: item.artifact_model_id || "",
    externalJobId: item.external_job_id || "",
    totalRecords: Number(item.total_records) || 0,
    runFingerprint: item.run_fingerprint || "",
    payload,
    error: item.error || "",
    createdBy: item.created_by || "",
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function trainingRunBody(input) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  const scope = directusLearningScope(input.scope || payload.scope || input, {});
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    name: String(payload.name || ""),
    method: String(payload.recipe?.method || "sft"),
    status: String(payload.status || "draft"),
    base_model: String(payload.recipe?.baseModel || ""),
    teacher_model: String(payload.recipe?.teacherModel || ""),
    artifact_model_id: String(payload.artifact?.modelId || ""),
    external_job_id: String(payload.externalJobId || ""),
    total_records: Number(payload.totalRecords) || 0,
    run_fingerprint: String(payload.fingerprint || ""),
    payload,
    error: String(payload.error || ""),
    created_by: String(payload.createdBy || "")
  };
}

export async function saveDirectusTrainingRun(input) {
  const body = trainingRunBody(input);
  const id = String(input.id || "");
  if (id) {
    const existing = await getDirectusTrainingRun(id);
    if (existing) return mapTrainingRun(await request(`/items/training_runs/${encodeURIComponent(id)}`, { method: "PATCH", body }));
  }
  return mapTrainingRun(await request("/items/training_runs", { method: "POST", body }));
}

export async function listDirectusTrainingRuns(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({
    limit: directusListLimit(filters.limit, 50),
    sort: "-date_created",
    fields: "*"
  }), filters);
  if (filters.status) params.set("filter[status][_eq]", String(filters.status));
  if (filters.method) params.set("filter[method][_eq]", String(filters.method));
  return (await request(`/items/training_runs?${params}`)).map(mapTrainingRun);
}

export async function getDirectusTrainingRun(id) {
  try {
    return mapTrainingRun(await request(`/items/training_runs/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export function getDirectusMetadata() {
  if (runtimeOptions().store) return { type: "sqlite", label: "本地 SQLite", directory: runtimeOptions().dataDirectory };
  const { baseUrl } = config();
  return {
    type: "directus",
    label: "Directus + PostgreSQL",
    url: baseUrl,
    adminUrl: `${baseUrl}/admin/content/terms_zh_cn`,
    collections: Object.fromEntries(ACTIVE_LOCALES.map((locale) => [locale, LOCALE_COLLECTIONS[locale]]))
  };
}

function mapProject(item = {}) {
  return {
    id: String(item.id || ""),
    name: String(item.name || ""),
    description: String(item.description || ""),
    status: String(item.status || "active"),
    settings: sanitizeProjectSettings(item.settings || {}),
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || null
  };
}

function mapResourceLibrary(item = {}) {
  return {
    id: String(item.id || ""),
    projectId: String(item.project_id || ""),
    name: String(item.name || ""),
    kind: String(item.kind || "term_base"),
    role: String(item.role || "reference"),
    enabled: item.enabled !== false,
    priority: Number(item.priority) || 100,
    description: String(item.description || ""),
    entryCount: Number(item.entry_count) || 0,
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || null
  };
}

export async function getDirectusProjects({ status = "active", limit = 100 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 100))), sort: "-date_updated,-date_created", fields: "id,name,description,status,settings,date_created,date_updated" });
  if (status) params.set("filter[status][_eq]", status);
  return (await request(`/items/${PROJECT_COLLECTION}?${params}`)).map(mapProject);
}

export async function getDirectusProject(id) {
  try {
    return mapProject(await request(`/items/${PROJECT_COLLECTION}/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function saveDirectusProject(input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("项目名称不能为空");
  const body = {
    name,
    description: String(input.description || "").trim(),
    status: String(input.status || "active"),
    settings: sanitizeProjectSettings(input.settings || {})
  };
  const saved = input.id
    ? await request(`/items/${PROJECT_COLLECTION}/${encodeURIComponent(String(input.id))}`, { method: "PATCH", body })
    : await request(`/items/${PROJECT_COLLECTION}`, { method: "POST", body: { id: randomUUID(), ...body } });
  return mapProject(saved);
}

export async function archiveDirectusProject(id) {
  const project = await getDirectusProject(id);
  if (!project) return null;
  const saved = await request(`/items/${PROJECT_COLLECTION}/${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    body: { status: "archived" }
  });
  return mapProject(saved);
}

const PROJECT_PURGE_TARGETS = new Map([
  ["project_resource_libraries", "project_id"],
  ["terms_zh_cn", "project_id"],
  ["corpus_documents", "project_id"],
  ["term_import_batches", "project_id"],
  ["term_candidates", "project_id"],
  ["batch_runs", "project_id"],
  ["user_profiles", "project_id"],
  ["style_profiles", "project_id"],
  ["style_evidence", "project_id"],
  ["style_learning_runs", "project_id"],
  ["qa_runs", "project_id"],
  ["qa_cases", "_or"],
  ["qa_tasks", "project_id"],
  ["background_tasks", "project_id"],
  ["reference_documents", "project_id"],
  ["reference_chunks", "project_id"],
  ["reference_folders", "project_id"],
  ["learning_trajectories", "project"],
  ["translation_skills", "project"],
  ["skill_evaluations", "project"],
  ["quality_assets", "project"],
  ["quality_runs", "project"],
  ["training_runs", "project"]
]);
for (const collection of new Set(Object.values(MEMORY_COLLECTIONS))) {
  PROJECT_PURGE_TARGETS.set(collection, collection === "translation_memory_zh_cn" ? "_or" : "project");
}

function projectScopeFilter(field, projectId) {
  if (field === "_or") return { _or: [{ project_id: { _eq: projectId } }, { project: { _eq: projectId } }] };
  return { [field]: { _eq: projectId } };
}

async function deleteDirectusItemsByFilter(collection, filter) {
  const params = new URLSearchParams({ limit: "-1", fields: "id", filter: JSON.stringify(filter) });
  const items = await request(`/items/${collection}?${params}`);
  const ids = items.map((item) => item.id).filter(Boolean);
  for (let index = 0; index < ids.length; index += 10) {
    await Promise.all(ids.slice(index, index + 10).map((id) => request(`/items/${collection}/${encodeURIComponent(String(id))}`, { method: "DELETE" })));
  }
  return ids.length;
}

export async function purgeDirectusProject(id) {
  const project = await getDirectusProject(id);
  if (!project) return null;
  const deleted = {};
  let total = 0;
  for (const [collection, field] of PROJECT_PURGE_TARGETS) {
    const count = await deleteDirectusItemsByFilter(collection, projectScopeFilter(field, id));
    if (!count) continue;
    deleted[collection] = count;
    total += count;
  }
  await request(`/items/${PROJECT_COLLECTION}/${encodeURIComponent(String(id))}`, { method: "DELETE" });
  return { project, deleted, total };
}

export async function getDirectusResourceLibraries(projectId, { kind = "", limit = 500 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(1000, Math.max(1, Number(limit) || 500))), sort: "priority,date_created", fields: "id,project_id,name,kind,role,enabled,priority,description,entry_count,date_created,date_updated" });
  params.set("filter[project_id][_eq]", String(projectId));
  if (kind) params.set("filter[kind][_eq]", String(kind));
  return (await request(`/items/${RESOURCE_LIBRARY_COLLECTION}?${params}`)).map(mapResourceLibrary);
}

export async function saveDirectusResourceLibrary(input = {}) {
  const projectId = String(input.projectId || "").trim();
  const name = String(input.name || "").trim();
  if (!projectId || !name) throw new Error("资源库必须绑定项目并填写名称");
  const kind = ["term_base", "translation_memory"].includes(input.kind) ? input.kind : "term_base";
  const role = kind === "translation_memory" && ["master", "working", "reference"].includes(input.role) ? input.role : kind === "translation_memory" ? "reference" : "reference";
  if (kind === "translation_memory" && input.enabled !== false && ["master", "working"].includes(role)) {
    const existingLibraries = await getDirectusResourceLibraries(projectId, { kind: "translation_memory", limit: 500 });
    const duplicate = existingLibraries.find((library) => library.id !== String(input.id || "") && library.enabled !== false && library.role === role);
    if (duplicate) throw new Error(role === "master" ? "一个项目只能启用一个主 TM" : "一个项目只能启用一个工作 TM");
  }
  const body = {
    project_id: projectId,
    name,
    kind,
    role,
    enabled: input.enabled !== false,
    priority: Math.max(1, Math.min(9999, Number(input.priority) || 100)),
    description: String(input.description || "").trim(),
    entry_count: Math.max(0, Number(input.entryCount) || 0)
  };
  const saved = input.id
    ? await request(`/items/${RESOURCE_LIBRARY_COLLECTION}/${encodeURIComponent(String(input.id))}`, { method: "PATCH", body })
    : await request(`/items/${RESOURCE_LIBRARY_COLLECTION}`, { method: "POST", body: { id: randomUUID(), ...body } });
  return mapResourceLibrary(saved);
}

export async function deleteDirectusResourceLibrary(projectId, libraryId) {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedLibraryId = String(libraryId || "").trim();
  if (!normalizedProjectId || !normalizedLibraryId) return false;
  const libraries = await getDirectusResourceLibraries(normalizedProjectId, { limit: 500 });
  const target = libraries.find((library) => library.id === normalizedLibraryId);
  if (!target) return false;
  if (target.role === "master" || target.role === "working") throw new Error("主 TM 和工作 TM 不能删除，请先停用或改为参考 TM");
  await request(`/items/${RESOURCE_LIBRARY_COLLECTION}/${encodeURIComponent(normalizedLibraryId)}`, { method: "DELETE" });
  return true;
}

/**
 * 删掉一个技能版本（候选 / 被拒绝 / 旧版本）。
 * 生效版本由路由层拦住——删掉它等于让生产翻译失去当前策略。
 */
export async function deleteDirectusTranslationSkill(id) {
  try {
    await request(`/items/translation_skills/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

/** 删掉一个自动蒸馏出的风格规范版本（生效版本同样由路由层拦住）。 */
export async function deleteDirectusStyleProfile(id) {
  try {
    await request(`/items/style_profiles/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

/** 删掉人工导入的风格指南（user_profiles 里的一整篇文档）。 */
export async function deleteDirectusUserProfile(id) {
  try {
    await request(`/items/user_profiles/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 参考资料：文档与片段。片段整篇替换，检索索引按项目整体加载。
// ---------------------------------------------------------------------------

const REFERENCE_DOCUMENT_COLLECTION = "reference_documents";
const REFERENCE_CHUNK_COLLECTION = "reference_chunks";
const REFERENCE_FOLDER_COLLECTION = "reference_folders";
const REFERENCE_KIND_VALUES = ["character", "script", "synopsis", "setting", "other"];
const REFERENCE_STATUS_VALUES = ["indexing", "ready", "failed", "disabled"];

function mapReferenceFolder(item = {}) {
  return {
    id: item.id,
    projectId: item.project_id || "",
    parentId: item.parent_id || "",
    name: item.name || "",
    createdAt: item.date_created || "",
    updatedAt: item.date_updated || item.date_created || ""
  };
}

function mapReferenceDocument(item = {}) {
  return {
    id: item.id,
    projectId: item.project_id || "",
    libraryId: item.library_id || "",
    folderId: item.folder_id || "",
    name: item.name || "",
    kind: item.kind || "other",
    contentType: item.content_type || "",
    domain: item.domain || "",
    sourceFile: item.source_file || "",
    sourceFormat: item.source_format || "",
    characters: Number(item.characters) || 0,
    chunkCount: Number(item.chunk_count) || 0,
    status: item.status || "ready",
    error: item.error || "",
    ingestReport: item.ingest_report ?? null,
    createdAt: item.date_created || "",
    updatedAt: item.date_updated || item.date_created || ""
  };
}

function mapReferenceChunk(item = {}) {
  return {
    id: item.id,
    documentId: item.document_id || "",
    projectId: item.project_id || "",
    ordinal: Number(item.ordinal) || 0,
    heading: item.heading || "",
    page: item.page || "",
    origin: item.origin === "vision" ? "vision" : "text",
    text: item.text || "",
    characters: Number(item.characters) || 0,
    risk: item.risk === true,
    allowed: item.allowed === true,
    embedding: item.embedding ?? null,
    createdAt: item.date_created || ""
  };
}

export async function saveDirectusReferenceFolder(input = {}) {
  const body = {
    project_id: String(input.projectId || "").trim(),
    parent_id: String(input.parentId || "").trim(),
    name: String(input.name || "新建文件夹").trim().slice(0, 200)
  };
  const id = String(input.id || "").trim();
  const saved = id
    ? await request(`/items/${REFERENCE_FOLDER_COLLECTION}/${encodeURIComponent(id)}`, { method: "PATCH", body })
    : await request(`/items/${REFERENCE_FOLDER_COLLECTION}`, { method: "POST", body: { id: randomUUID(), ...body } });
  return mapReferenceFolder(saved);
}

export async function getDirectusReferenceFolder(id) {
  try {
    return mapReferenceFolder(await request(`/items/${REFERENCE_FOLDER_COLLECTION}/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function listDirectusReferenceFolders({ projectId = "", limit = 5_000 } = {}) {
  const params = new URLSearchParams({
    limit: String(Number(limit) > 0 ? Math.min(5_000, Number(limit)) : -1),
    fields: "*",
    sort: "name,date_created"
  });
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const items = await request(`/items/${REFERENCE_FOLDER_COLLECTION}?${params}`);
  return (items || []).map(mapReferenceFolder);
}

export async function deleteDirectusReferenceFolder(id) {
  try {
    await request(`/items/${REFERENCE_FOLDER_COLLECTION}/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

export async function saveDirectusReferenceDocument(input = {}) {
  const body = {
    project_id: String(input.projectId || "").trim(),
    library_id: String(input.libraryId || "").trim(),
    folder_id: String(input.folderId || "").trim(),
    name: String(input.name || "未命名资料").trim().slice(0, 200),
    kind: REFERENCE_KIND_VALUES.includes(input.kind) ? input.kind : "other",
    content_type: String(input.contentType || "").trim(),
    domain: String(input.domain || "").trim(),
    source_file: String(input.sourceFile || "").trim().slice(0, 200),
    source_format: String(input.sourceFormat || "").trim(),
    characters: Math.max(0, Math.trunc(Number(input.characters) || 0)),
    chunk_count: Math.max(0, Math.trunc(Number(input.chunkCount) || 0)),
    status: REFERENCE_STATUS_VALUES.includes(input.status) ? input.status : "indexing",
    error: String(input.error || "").slice(0, 1_000),
    ingest_report: input.ingestReport ?? null
  };
  const id = String(input.id || "").trim();
  const saved = id
    ? await request(`/items/${REFERENCE_DOCUMENT_COLLECTION}/${encodeURIComponent(id)}`, { method: "PATCH", body })
    : await request(`/items/${REFERENCE_DOCUMENT_COLLECTION}`, { method: "POST", body: { id: randomUUID(), ...body } });
  return mapReferenceDocument(saved);
}

export async function getDirectusReferenceDocument(id) {
  try {
    return mapReferenceDocument(await request(`/items/${REFERENCE_DOCUMENT_COLLECTION}/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

function referenceDocumentQuery({
  projectId = "",
  libraryId = "",
  folderId = "",
  folderIds = null,
  status = "",
  search = ""
} = {}) {
  const filter = {};
  if (projectId) filter.project_id = { _eq: String(projectId) };
  if (libraryId) filter.library_id = { _eq: String(libraryId) };
  if (status) filter.status = { _eq: String(status) };
  const clauses = [];
  if (Array.isArray(folderIds)) {
    const values = folderIds.map(String);
    if (values.includes("")) {
      const nonEmpty = values.filter(Boolean);
      const alternatives = [];
      if (nonEmpty.length) alternatives.push({ folder_id: { _in: nonEmpty } });
      alternatives.push({ folder_id: { _empty: true } });
      clauses.push({ _or: alternatives });
    } else {
      filter.folder_id = values.length === 1 ? { _eq: values[0] } : { _in: values };
    }
  }
  else if (folderId) filter.folder_id = { _eq: String(folderId) };
  if (search) {
    clauses.push({ _or: [
      { name: { _icontains: String(search) } },
      { source_file: { _icontains: String(search) } }
    ] });
  }
  if (clauses.length === 1) Object.assign(filter, clauses[0]);
  else if (clauses.length > 1) filter._and = clauses;
  return Object.keys(filter).length ? JSON.stringify(filter) : "";
}

export async function listDirectusReferenceDocuments({
  projectId = "",
  libraryId = "",
  folderId = "",
  folderIds = null,
  status = "",
  search = "",
  offset = 0,
  limit = 50
} = {}) {
  const filter = referenceDocumentQuery({ projectId, libraryId, folderId, folderIds, status, search });
  const params = new URLSearchParams({ fields: "*", limit: "200", sort: "-date_created" });
  const countParams = new URLSearchParams();
  if (filter) {
    params.set("filter", filter);
    countParams.set("filter", filter);
  }
  const requested = Number(limit);
  params.set("limit", String(requested > 0 ? Math.min(1_000, requested) : -1));
  params.set("offset", String(Math.max(0, Number(offset) || 0)));
  countParams.set("aggregate[count]", "*");
  const [items, counted] = await Promise.all([
    request(`/items/${REFERENCE_DOCUMENT_COLLECTION}?${params}`),
    request(`/items/${REFERENCE_DOCUMENT_COLLECTION}?${countParams}`)
  ]);
  return { total: Number(counted?.[0]?.count) || 0, items: (items || []).map(mapReferenceDocument) };
}

export async function updateDirectusReferenceDocument(id, patch = {}) {
  const current = await getDirectusReferenceDocument(id);
  if (!current) return null;
  return saveDirectusReferenceDocument({ ...current, ...patch, id });
}

async function deleteDirectusChunksOfDocument(documentId) {
  // Directus 的集合级 DELETE 只认 ?keys= 或 ?query=，不接受 filter。
  // 大资料会有几千个片段，所以分批取 ID 再删，直到清空。
  const filter = `filter[document_id][_eq]=${encodeURIComponent(String(documentId))}`;
  for (let round = 0; round < 50; round += 1) {
    let items = [];
    try {
      items = await request(`/items/${REFERENCE_CHUNK_COLLECTION}?${filter}&fields=id&limit=500`);
    } catch (error) {
      if (isMissingItem(error)) return;
      throw error;
    }
    const keys = (items || []).map((item) => item.id).filter(Boolean);
    if (!keys.length) return;
    // Directus 11 的集合级删除只认请求体里的 keys；写在查询串上会被判成"没给 keys"。
    await request(`/items/${REFERENCE_CHUNK_COLLECTION}`, { method: "DELETE", body: { keys } });
  }
}

export async function deleteDirectusReferenceDocument(id) {
  const documentId = String(id);
  await deleteDirectusChunksOfDocument(documentId);
  try {
    await request(`/items/${REFERENCE_DOCUMENT_COLLECTION}/${encodeURIComponent(documentId)}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

export async function replaceDirectusReferenceChunks(documentId, { projectId = "", chunks = [] } = {}) {
  const id = String(documentId);
  await deleteDirectusChunksOfDocument(id);
  const records = (Array.isArray(chunks) ? chunks : []).map((chunk, index) => ({
    id: randomUUID(),
    document_id: id,
    project_id: String(chunk.projectId || projectId || ""),
    ordinal: Number.isInteger(chunk.ordinal) ? chunk.ordinal : index,
    heading: String(chunk.heading || "").slice(0, 200),
    page: String(chunk.page || "").slice(0, 40),
    origin: chunk.origin === "vision" ? "vision" : "text",
    text: String(chunk.text || ""),
    characters: Math.max(0, Math.trunc(Number(chunk.characters) || [...String(chunk.text || "")].length)),
    risk: chunk.risk === true,
    allowed: chunk.allowed === true,
    embedding: chunk.embedding ?? null
  }));
  if (!records.length) return 0;
  await createItemsInChunks(`/items/${REFERENCE_CHUNK_COLLECTION}`, records);
  return records.length;
}

export async function listDirectusReferenceChunks({ documentId = "", projectId = "", offset = 0, limit = 200 } = {}) {
  const params = new URLSearchParams();
  if (documentId) params.set("filter[document_id][_eq]", String(documentId));
  if (projectId) params.set("filter[project_id][_eq]", String(projectId));
  const [items, counted] = await Promise.all([
    request(`/items/${REFERENCE_CHUNK_COLLECTION}?${params}&fields=*&limit=${Math.min(200, Math.max(1, Number(limit) || 200))}&offset=${Math.max(0, Number(offset) || 0)}&sort=document_id,ordinal`),
    request(`/items/${REFERENCE_CHUNK_COLLECTION}?${params}&aggregate[count]=*`)
  ]);
  return { total: Number(counted?.[0]?.count) || 0, items: (items || []).map(mapReferenceChunk) };
}

export async function listDirectusReferenceChunksForProject(projectId, { limit = 5_000 } = {}) {
  const pageSize = 1_000;
  const cap = Math.max(1, Number(limit) || 5_000);
  const items = [];
  let offset = 0;
  while (items.length < cap) {
    const page = await request(`/items/${REFERENCE_CHUNK_COLLECTION}?filter[project_id][_eq]=${encodeURIComponent(String(projectId))}&fields=*&limit=${pageSize}&offset=${offset}&sort=document_id,ordinal`);
    if (!page?.length) break;
    items.push(...page.map(mapReferenceChunk));
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return items.slice(0, cap);
}

export async function updateDirectusReferenceChunk(id, patch = {}) {
  const body = {};
  if (patch.allowed !== undefined) body.allowed = patch.allowed === true;
  if (patch.risk !== undefined) body.risk = patch.risk === true;
  if (patch.heading !== undefined) body.heading = String(patch.heading).slice(0, 200);
  if (!Object.keys(body).length) return null;
  const saved = await request(`/items/${REFERENCE_CHUNK_COLLECTION}/${encodeURIComponent(String(id))}`, { method: "PATCH", body });
  return mapReferenceChunk(saved);
}

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeOptions } from "./runtime-context.mjs";
import { getSettings } from "./settings-store.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LOG_DIRECTORY = runtimeOptions().dataDirectory ? join(runtimeOptions().dataDirectory, "runtime", "logs") : process.env.KAMI_LOG_DIRECTORY || join(PROJECT_ROOT, "data", "runtime", "logs");
export const LOG_FILE = join(LOG_DIRECTORY, "kami.log");
const ROTATED_LOG_FILE = `${LOG_FILE}.1`;
/** 单个日志文件的上限：超过就轮转成 .1，避免工作台长开把磁盘写满。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 内存里保留的条数：界面默认只看最近这些，文件里留着完整的。 */
const BUFFER_LIMIT = 2_000;
const MESSAGE_LIMIT = 2_000;
/** 启动时把上一次运行的最后若干行读回缓冲区，重启后仍能看到刚才的报错。 */
const PREVIOUS_RUN_TAIL = 300;

/**
 * 模型思考正文单独落一个文件：一次调用的思考 0.5–4KB，一个批次就能有 1–5MB，
 * 塞进 5MB 的 kami.log 会把真正要看的报错挤掉。主日志只留一条可检索的索引。
 */
export const THINKING_FILE = join(LOG_DIRECTORY, "kami-thinking.jsonl");
export const THINKING_MAX_BYTES = 32 * 1024 * 1024;
/** 界面默认展示的思考条数；正文按 id 现取，不常驻内存。 */
const THINKING_METADATA_LIMIT = 500;

/** 四级日志：debug < info < warn < error。 */
export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const LEVEL_NAMES = Object.keys(LOG_LEVELS);

function normalizeLevel(value, fallback = "info") {
  const text = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, text) ? text : fallback;
}

let minimumLevel = normalizeLevel(process.env.KAMI_LOG_LEVEL || "info");
const buffer = [];
const thinkingMetadata = [];
let consoleInstalled = false;

export function getLogLevel() {
  return minimumLevel;
}

/** 日志里不留密钥：Bearer token 打码。 */
function maskSecrets(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gu, "Bearer ***")
    .replace(/"?(api[_-]?key|authorization)"?\s*[:=]\s*"?[A-Za-z0-9._-]{12,}"?/giu, "$1=***");
}

/** 普通日志消息：打码后再截断到 2000 字。 */
function scrub(text) {
  return maskSecrets(text).slice(0, MESSAGE_LIMIT);
}

function describe(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fileBytes() {
  try {
    return existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
  } catch {
    return 0;
  }
}

function rotateIfNeeded() {
  try {
    if (!existsSync(LOG_FILE) || statSync(LOG_FILE).size <= MAX_FILE_BYTES) return;
    if (existsSync(ROTATED_LOG_FILE)) rmSync(ROTATED_LOG_FILE);
    renameSync(LOG_FILE, ROTATED_LOG_FILE);
  } catch {
    // 轮转失败不该影响业务：继续往原文件追加即可。
  }
}

function appendLine(line) {
  try {
    mkdirSync(LOG_DIRECTORY, { recursive: true });
    rotateIfNeeded();
    appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // 写盘失败（权限、磁盘满）只丢日志，不影响工作台本身。
  }
}

/** 不经过等级过滤的写入：思考索引不受「记录等级」影响，它有自己的开关。 */
function writeEntry(entry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  appendLine(JSON.stringify(entry));
  return entry;
}

/**
 * 写一条日志。低于当前等级的直接丢弃，所以"详细等级"既影响显示也影响记录量。
 */
export function writeLog(level, message, detail) {
  const name = normalizeLevel(level, "info");
  if (LOG_LEVELS[name] < LOG_LEVELS[minimumLevel]) return null;
  const entry = { ts: new Date().toISOString(), level: name, message: scrub(message) };
  if (detail !== undefined && detail !== null && detail !== "") entry.detail = scrub(describe(detail));
  return writeEntry(entry);
}

export const logDebug = (message, detail) => writeLog("debug", message, detail);
export const logInfo = (message, detail) => writeLog("info", message, detail);
export const logWarn = (message, detail) => writeLog("warn", message, detail);
export const logError = (message, detail) => writeLog("error", message, detail);

/** 按"至少这个等级 + 关键词 + 时间点"过滤；返回最新在前。 */
export function listLogs({ level = "", search = "", limit = 300, since = "" } = {}) {
  const floor = level ? LOG_LEVELS[normalizeLevel(level)] : 0;
  const keyword = String(search || "").trim().toLowerCase();
  const after = String(since || "").trim();
  const rows = buffer.filter((entry) => LOG_LEVELS[entry.level] >= floor
    && (!after || entry.ts > after)
    && (!keyword || `${entry.level} ${entry.message} ${entry.detail || ""}`.toLowerCase().includes(keyword)));
  const size = Math.min(2_000, Math.max(1, Number(limit) || 300));
  return rows.slice(-size).reverse();
}

function thinkingFiles() {
  const files = [];
  if (existsSync(THINKING_FILE)) files.push(THINKING_FILE);
  for (let index = 1; index <= 99; index += 1) {
    const path = `${THINKING_FILE}.${index}`;
    if (!existsSync(path)) break;
    files.push(path);
  }
  return files;
}

function thinkingBytes(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

/** 超过单文件上限就轮转成 .1/.2…，并按保留总量删掉最旧的。 */
function rotateThinkingIfNeeded(keepBytes) {
  try {
    // 保留总量小于单文件上限时，按保留总量轮转，免得分片还没写入就被整份删掉。
    const rotateAbove = Math.max(1, Math.min(THINKING_MAX_BYTES, keepBytes));
    if (!existsSync(THINKING_FILE) || statSync(THINKING_FILE).size <= rotateAbove) return;
    const limit = Math.max(1, Math.ceil(keepBytes / rotateAbove));
    for (let index = 99; index >= limit; index -= 1) {
      const path = `${THINKING_FILE}.${index}`;
      if (existsSync(path)) rmSync(path);
    }
    for (let index = Math.min(limit, 99) - 1; index >= 1; index -= 1) {
      const from = `${THINKING_FILE}.${index}`;
      const to = `${THINKING_FILE}.${index + 1}`;
      if (existsSync(from)) { if (existsSync(to)) rmSync(to); renameSync(from, to); }
    }
    const first = `${THINKING_FILE}.1`;
    if (existsSync(first)) rmSync(first);
    renameSync(THINKING_FILE, first);
  } catch {
    // 轮转失败不该影响业务。
  }
}

/** 删掉超出保留总量的最旧文件。 */
function pruneThinking(keepBytes) {
  try {
    const files = thinkingFiles();
    let total = files.reduce((sum, path) => sum + thinkingBytes(path), 0);
    // 至少保留当前文件：设置再小也不该把「刚写的这条」删掉。
    for (let index = files.length - 1; index >= 1 && total > keepBytes; index -= 1) {
      const size = thinkingBytes(files[index]);
      rmSync(files[index], { force: true });
      total -= size;
    }
  } catch {
    // 清理失败只意味着多占点磁盘。
  }
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  const kept = text.slice(0, low);
  return { text: kept, truncated: true, bytes: Buffer.byteLength(kept, "utf8") };
}

function rememberThinking(meta) {
  thinkingMetadata.push(meta);
  if (thinkingMetadata.length > THINKING_METADATA_LIMIT) thinkingMetadata.splice(0, thinkingMetadata.length - THINKING_METADATA_LIMIT);
}

/**
 * 记录一次模型调用的思考正文。
 *
 * 只写本地文件：不发额外请求，也不进入后续提示词，因此不增加 token 消耗。
 * 开关、单条上限和保留总量都在「设置 → 日志」里。
 */
export function logThinking({ label = "模型调用", model = "", effort = "", text = "", status = "ok", context = {} } = {}) {
  const body = maskSecrets(String(text ?? "").trim());
  if (!body) return null;
  let config = null;
  try { config = getSettings().logs || {}; } catch { config = {}; }
  if (config.thinking === false) return null;
  const limitKB = Math.max(1, Math.min(256, Number(config.thinkingMaxKB) || 32));
  const keepBytes = Math.max(8, Math.min(2048, Number(config.thinkingKeepMB) || 128)) * 1024 * 1024;
  const clipped = truncateUtf8(body, limitKB * 1024);
  const ts = new Date().toISOString();
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const meta = { id, ts, label, model, effort, status, chars: clipped.text.length, bytes: clipped.bytes, truncated: clipped.truncated, context };
  try {
    mkdirSync(LOG_DIRECTORY, { recursive: true });
    rotateThinkingIfNeeded(keepBytes);
    appendFileSync(THINKING_FILE, `${JSON.stringify({ ...meta, text: clipped.text })}\n`, "utf8");
    pruneThinking(keepBytes);
  } catch {
    // 写盘失败只丢正文，索引照写，界面能看到"有这条记录但读不到正文"。
  }
  rememberThinking(meta);
  const entry = { ts, level: "info", kind: "thinking", message: `模型思考 · ${label}` };
  entry.detail = scrub(JSON.stringify({ id, label, model, effort, chars: meta.chars, bytes: meta.bytes, truncated: meta.truncated, status, ...context }));
  return writeEntry(entry);
}

/** 最近的思考元数据；带关键词时扫正文（最新两个文件），命中就返回摘录。 */
export function listThinking({ search = "", limit = 100, since = "" } = {}) {
  const size = Math.min(500, Math.max(1, Number(limit) || 100));
  const keyword = String(search || "").trim().toLowerCase();
  const after = String(since || "").trim();
  const matches = (meta) => !after || meta.ts > after;
  if (!keyword) return thinkingMetadata.filter(matches).slice(-size).reverse().map(({ text, ...meta }) => meta);
  const rows = [];
  for (const path of thinkingFiles().slice(0, 2)) {
    let lines = [];
    try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { continue; }
    for (let index = lines.length - 1; index >= 0 && rows.length < size; index -= 1) {
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      if (!record?.ts || !matches(record)) continue;
      if (!`${record.label} ${record.model} ${record.text}`.toLowerCase().includes(keyword)) continue;
      const at = record.text.toLowerCase().indexOf(keyword);
      const from = Math.max(0, at - 60);
      rows.push({ id: record.id, ts: record.ts, label: record.label, model: record.model, effort: record.effort, status: record.status, chars: record.chars, bytes: record.bytes, truncated: record.truncated, context: record.context, snippet: record.text.slice(from, from + 220) });
    }
    if (rows.length >= size) break;
  }
  return rows;
}

/** 按 id 取思考全文；文件轮转后仍按目录里的文件从新到旧找。 */
export function readThinking(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  for (const path of thinkingFiles()) {
    let lines = [];
    try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { continue; }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes(key)) continue;
      try {
        const record = JSON.parse(lines[index]);
        if (record?.id === key) return record;
      } catch {
        // 半行跳过。
      }
    }
  }
  return null;
}

export function clearThinking() {
  thinkingMetadata.length = 0;
  for (const path of thinkingFiles()) {
    try {
      rmSync(path, { force: true });
    } catch {
      // 删不掉只是清不干净。
    }
  }
  return getThinkingStats();
}

export function getThinkingStats() {
  const files = thinkingFiles();
  const totalBytes = files.reduce((sum, path) => sum + thinkingBytes(path), 0);
  return {
    file: THINKING_FILE,
    files: files.map((path) => ({ path, bytes: thinkingBytes(path) })),
    totalBytes,
    buffered: thinkingMetadata.length,
    bufferLimit: THINKING_METADATA_LIMIT,
    maxFileBytes: THINKING_MAX_BYTES
  };
}

export function getLogSettings() {
  return {
    level: minimumLevel,
    levels: LEVEL_NAMES,
    buffered: buffer.length,
    bufferLimit: BUFFER_LIMIT,
    file: LOG_FILE,
    fileBytes: fileBytes(),
    rotated: existsSync(ROTATED_LOG_FILE),
    thinking: getThinkingStats()
  };
}

export function setLogLevel(level) {
  minimumLevel = normalizeLevel(level, minimumLevel);
  logInfo(`日志等级已切换为 ${minimumLevel}`);
  return getLogSettings();
}

export function clearLogs() {
  buffer.length = 0;
  for (const path of [LOG_FILE, ROTATED_LOG_FILE]) {
    try {
      if (existsSync(path)) rmSync(path);
    } catch {
      // 删不掉只是清不干净，继续。
    }
  }
  return getLogSettings();
}

export function readLogFile() {
  try {
    return existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
  } catch {
    return "";
  }
}

/** 启动时把上一次运行的最后几行放回缓冲区（标记 previous，界面据此区分）。 */
export function loadPreviousRunLogs() {
  try {
    const lines = readLogFile().split("\n").filter(Boolean).slice(-PREVIOUS_RUN_TAIL);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry?.ts || !entry?.level) continue;
        buffer.push({ ts: entry.ts, level: normalizeLevel(entry.level), message: scrub(entry.message), ...(entry.detail ? { detail: scrub(entry.detail) } : {}), ...(entry.kind ? { kind: entry.kind } : {}), previous: true });
      } catch {
        // 半行/损坏的行跳过即可。
      }
    }
    if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  } catch {
    // 读不到就当没有历史日志。
  }
  // 思考正文不占启动时间，只把最近几百条元数据读回来，重启后仍能翻看。
  try {
    const lines = readFileSync(THINKING_FILE, "utf8").split("\n").filter(Boolean).slice(-THINKING_METADATA_LIMIT);
    for (const line of lines) {
      try {
        const { text, ...meta } = JSON.parse(line);
        if (meta?.id) rememberThinking(meta);
      } catch {
        // 损坏的行跳过。
      }
    }
  } catch {
    // 没有思考文件很正常。
  }
}

/**
 * 把 console.* 也接进日志：仓库里大量 console.error/warn 不用改就都能在界面查到，
 * 这正是"报错闪一下就没了"的根源。
 */
export function installConsoleCapture() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  for (const [method, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"], ["debug", "debug"]]) {
    const original = console[method]?.bind(console);
    if (!original) continue;
    console[method] = (...args) => {
      try {
        writeLog(level, args.map((arg) => describe(arg)).join(" "));
      } catch {
        // 日志自身的异常不能影响原来的输出。
      }
      original(...args);
    };
  }
}

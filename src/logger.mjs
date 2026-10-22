import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeOptions } from "./runtime-context.mjs";

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

/** 四级日志：debug < info < warn < error。 */
export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const LEVEL_NAMES = Object.keys(LOG_LEVELS);

function normalizeLevel(value, fallback = "info") {
  const text = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, text) ? text : fallback;
}

let minimumLevel = normalizeLevel(process.env.KAMI_LOG_LEVEL || "info");
const buffer = [];
let consoleInstalled = false;

export function getLogLevel() {
  return minimumLevel;
}

/** 日志里不留密钥：Bearer token 打码，超长内容截断。 */
function scrub(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gu, "Bearer ***")
    .replace(/"?(api[_-]?key|authorization)"?\s*[:=]\s*"?[A-Za-z0-9._-]{12,}"?/giu, "$1=***")
    .slice(0, MESSAGE_LIMIT);
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

/**
 * 写一条日志。低于当前等级的直接丢弃，所以"详细等级"既影响显示也影响记录量。
 */
export function writeLog(level, message, detail) {
  const name = normalizeLevel(level, "info");
  if (LOG_LEVELS[name] < LOG_LEVELS[minimumLevel]) return null;
  const entry = { ts: new Date().toISOString(), level: name, message: scrub(message) };
  if (detail !== undefined && detail !== null && detail !== "") entry.detail = scrub(describe(detail));
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  appendLine(JSON.stringify(entry));
  return entry;
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

export function getLogSettings() {
  return {
    level: minimumLevel,
    levels: LEVEL_NAMES,
    buffered: buffer.length,
    bufferLimit: BUFFER_LIMIT,
    file: LOG_FILE,
    fileBytes: fileBytes(),
    rotated: existsSync(ROTATED_LOG_FILE)
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
        buffer.push({ ts: entry.ts, level: normalizeLevel(entry.level), message: scrub(entry.message), ...(entry.detail ? { detail: scrub(entry.detail) } : {}), previous: true });
      } catch {
        // 半行/损坏的行跳过即可。
      }
    }
    if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  } catch {
    // 读不到就当没有历史日志。
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

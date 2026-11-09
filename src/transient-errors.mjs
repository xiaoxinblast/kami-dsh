/**
 * 连接层的瞬时失败：网络抖动、模型服务 502/503、socket 被掐断。
 * 这类错误重试一次通常就好了；内容层的错误（空译文、JSON 格式、术语校验失败）
 * 重试没有任何意义，只会多花钱，必须区分开。
 */

const TRANSIENT_PATTERNS = [
  /fetch failed/iu,
  /socket hang up/iu,
  /network error/iu,
  /DeepSeek Messages transport failed/iu,
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_/iu,
  /返回 (?:500|502|503|504)/u,
  /服务暂时不可用|Service Unavailable/u
];

/** 我们自己的库（Directus）报错不在这里重试：判定在数据层，交给界面层做友好重试。 */
const DATABASE_PATTERNS = [/Directus /u, /postgres/iu];

function errorText(error) {
  if (!error) return "";
  const parts = [error.message, error.code, error.cause?.code, error.cause?.message]
    .map((value) => (value === undefined || value === null ? "" : String(value)));
  return parts.filter(Boolean).join(" | ");
}

export function isTransientConnectionError(error) {
  const text = errorText(error);
  if (!text) return false;
  if (DATABASE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 只对瞬时连接错误重试：先失败一次、判定可重试、等一会儿再试一次；
 * 第二次还失败就把错误抛给调用方，由它决定怎么记录。
 */
export async function retryTransient(fn, {
  attempts = 2,
  delayMs = 2_000,
  sleep = defaultSleep,
  isTransient = isTransientConnectionError,
  onRetry = null
} = {}) {
  if (typeof fn !== "function") throw new TypeError("retryTransient 需要一个函数");
  const total = Math.max(1, Number(attempts) || 1);
  let lastError = null;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < total && isTransient(error);
      if (!canRetry) break;
      if (typeof onRetry === "function") {
        try { onRetry(error, attempt); } catch { /* 回调失败不影响重试 */ }
      }
      await sleep(Number(delayMs) || 0);
    }
  }
  throw lastError;
}

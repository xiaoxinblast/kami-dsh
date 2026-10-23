import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 术语匹配 worker 池（当前单 worker，够把事件循环让出来）。
 *
 * 调用方 `await pool.match(text, assets, options)`；资产按对象身份生成 token，
 * worker 只第一次收到整份术语库。worker 启动失败/超时/退出时 Promise 会 reject，
 * 调用方自行回退同步 matchTerms，保证不影响出译文。
 */
export function createMatcherPool({ workerUrl = new URL("./matcher-worker.mjs", import.meta.url), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();
  const sentAssets = new Set();
  const assetTokens = new WeakMap();
  let tokenSequence = 0;

  const tokenFor = (assets) => {
    if (!assets || typeof assets !== "object") return "none";
    let token = assetTokens.get(assets);
    if (!token) {
      token = `assets-${++tokenSequence}`;
      assetTokens.set(assets, token);
    }
    return token;
  };

  // 单 worker 串行执行：并发请求先排队，超时从"真的开始执行"算起。
  // 以前的实现每个请求入队就开始计时，worker 慢时后面的请求会先超时，
  // 触发同步回退把主线程堵死。
  let queue = [];
  let active = null;
  let dispatchNext = () => {};

  const failAll = (error) => {
    const entries = [...pending.values()];
    pending.clear();
    sentAssets.clear();
    worker = null;
    active = null;
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    const queued = queue;
    queue = [];
    for (const job of queued) job.reject(error);
  };

  const ensureWorker = () => {
    if (worker) return worker;
    worker = new Worker(workerUrl);
    // 不阻止进程退出；需要时 close() 会 terminate。
    worker.unref?.();
    worker.on("message", (message) => {
      const entry = pending.get(message?.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      active = null;
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.matches);
      dispatchNext();
    });
    worker.on("error", (error) => failAll(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => failAll(new Error(`matcher worker exited (${code})`)));
    return worker;
  };

  dispatchNext = () => {
    if (active || !queue.length) return;
    const job = queue.shift();
    active = job;
    job.timer = setTimeout(() => {
      // 这一条确实执行超时：重建 worker，避免后续请求永远排在坏进程后面。
      const stuck = worker;
      worker = null;
      sentAssets.clear();
      active = null;
      pending.delete(job.id);
      stuck?.terminate?.().catch?.(() => {});
      job.reject(new Error("matcher worker timeout"));
      dispatchNext();
    }, timeoutMs);
    pending.set(job.id, { resolve: job.resolve, reject: job.reject, timer: job.timer });
    try {
      const message = { type: "match", id: job.id, text: job.text, options: job.options, assetsToken: job.assetsToken };
      if (!sentAssets.has(job.assetsToken)) {
        message.assets = job.assets;
        sentAssets.add(job.assetsToken);
      }
      ensureWorker().postMessage(message);
    } catch (error) {
      pending.delete(job.id);
      clearTimeout(job.timer);
      active = null;
      job.reject(error);
      dispatchNext();
    }
  };

  return {
    match(text, assets, options = {}) {
      return new Promise((resolve, reject) => {
        const job = { id: ++nextId, text, assets, options, assetsToken: tokenFor(assets), resolve, reject, timer: null };
        queue.push(job);
        dispatchNext();
      });
    },
    async close() {
      const current = worker;
      worker = null;
      sentAssets.clear();
      const error = new Error("matcher worker closed");
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      const queued = queue;
      queue = [];
      active = null;
      for (const job of queued) job.reject(error);
      await current?.terminate().catch(() => {});
    }
  };
}

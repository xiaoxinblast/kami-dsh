/**
 * 参考资料预扫 worker：pdf.js / JSZip 的解析放到独立线程，主线程继续响应 /api/health。
 * 主线程负责超时并 terminate 这个 worker（见 planReferenceExtractionIsolated）。
 */
import { parentPort, workerData } from "node:worker_threads";
import { planReferenceExtraction } from "./reference-materials.mjs";

try {
  const plan = await planReferenceExtraction({
    filename: workerData?.filename || "",
    path: workerData?.path || ""
  });
  parentPort?.postMessage({ ok: true, plan });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: String(error?.message || error) });
}

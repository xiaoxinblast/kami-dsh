import { createHash } from "node:crypto";

export function reviewDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function consistencyResultCache(run, scope) {
  // Keep untouched slots for failed-only retries. A changed chunk must match a new digest before reuse.
  const previous = run.qualityReport?.chunkResults || {};
  const records = { ...previous };
  const positions = new Map(run.segments.map((s,i) => [String(s.id), i]));
  const context = run.segments.map(s => [s.id, s.source, s.translation, s.context, s.locator, s.entryKey, s.result?.segmentPurpose]);
  const shared = reviewDigest([1, run.batchId, run.projectId, run.filename, run.locale, run.contentType, run.domain, run.contextBrief, scope]);
  const routes = new Map();
  return { records, model(selection, load) {
    const id = JSON.stringify(selection);
    if (!routes.has(id)) routes.set(id, Promise.resolve().then(load));
    return routes.get(id);
  }, key(slot, pairs, inputs) {
    const indices = pairs.map(pair => positions.get(String(pair.id)));
    if (indices.some(i => i == null)) return null;
    return reviewDigest([shared, slot, context.slice(Math.max(0, Math.min(...indices) - 8), Math.max(...indices) + 5), inputs]);
  } };
}

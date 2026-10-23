import { runtimeOptions } from "./runtime-context.mjs";
import { normalizeSource } from "./text.mjs";
import { buildMemoryIndex, selectMemoryCandidates } from "./memory-index.mjs";

const memoryIndexes = new WeakMap();

export function taskResources(projectId = "") {
  const snapshot = runtimeOptions().workspaceSnapshot;
  return snapshot && snapshot.projectId === projectId ? snapshot : null;
}

export function mergeWorkspaceTerms(assets, snapshot) {
  if (!snapshot?.terms?.length) return assets;
  // Existing approved library entries retain precedence, including their aliases.
  const keys = new Set((assets.terms || []).flatMap((term) => [term.source, ...(term.aliases || [])]).map(normalizeSource));
  const terms = snapshot.terms.filter((term) => !keys.has(normalizeSource(term.source)));
  return { ...assets, terms: [...(assets.terms || []), ...terms] };
}

export function mergeWorkspaceMemories(memories, snapshot, { source = "", limit = 1000 } = {}) {
  if (!snapshot?.memories?.length) return memories;
  let candidates = snapshot.memories;
  if (source && limit > 0) {
    let cached = memoryIndexes.get(snapshot);
    if (!cached) {
      cached = { index: buildMemoryIndex(candidates), byId: new Map(candidates.map((item) => [item.id, item])) };
      memoryIndexes.set(snapshot, cached);
    }
    candidates = selectMemoryCandidates(cached.index, source, { limit }).map((item) => cached.byId.get(item.id));
  }
  const keys = new Set(memories.filter((item) => item.libraryRole === "master" || item.qualityStatus === "human_approved").map((item) => normalizeSource(item.source)));
  return [...memories, ...candidates.filter((item) => !keys.has(normalizeSource(item.source)))];
}

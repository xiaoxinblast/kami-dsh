import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const indexes = new WeakMap();
const unique = (values) => [...new Set(values.filter(Boolean))];

function withOrigins(entry, origins) {
  const sourceFiles = unique(origins.map((item) => item.path));
  return { ...entry, origins, sourceFiles, sourceFile: sourceFiles[0] || entry.sourceFile, file: origins[0]?.file || entry.file,
    note: unique(origins.map((item) => item.note)).join("\n"), aliases: unique(origins.flatMap((item) => item.aliases || [])) };
}

export function mergeLibraryEntries(entries, purpose, scope = "") {
  const merged = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([scope || entry.linkedLibraryId || entry.libraryId || "", entry.source, entry.target, entry.domain || "", entry.contentType || "", entry.enforcement || "", entry.preserveOriginal || false,
      ...(purpose === "tm" ? [entry.context || "", entry.entryKey || "", entry.entryId || ""] : [])]);
    let value = merged.get(key);
    if (!value) { value = { entry, origins: new Map() }; merged.set(key, value); }
    for (const origin of entry.origins || []) value.origins.set(JSON.stringify(origin), origin);
  }
  return [...merged.values()].map(({ entry, origins }) => withOrigins(entry, [...origins.values()]));
}

function resourceIndex(record) {
  if (indexes.has(record)) return indexes.get(record);
  const index = { sources: new Map(record.sources.map((source) => [source.path, source])), guides: new Map((record.guides || []).flatMap((guide) => guide.origins.map((origin) => [origin.path, guide]))) };
  indexes.set(record, index);
  return index;
}

export function librarySource(record, source) {
  const metadata = record && resourceIndex(record).sources.get(source.path);
  return metadata?.hash === source.hash ? metadata : null;
}

function candidateIndex(record, index) {
  if (index.candidates) return index.candidates;
  index.candidates = new Map();
  for (const candidate of record.candidates || []) {
    const grouped = new Map();
    for (const origin of candidate.origins) {
      if (!grouped.has(origin.path)) grouped.set(origin.path, []);
      grouped.get(origin.path).push(origin);
    }
    for (const [path, origins] of grouped) {
      if (!index.candidates.has(path)) index.candidates.set(path, []);
      index.candidates.get(path).push({ ...candidate, origins });
    }
  }
  return index.candidates;
}

export function libraryResource(record, source) {
  if (!record) return null;
  const index = resourceIndex(record), metadata = librarySource(record, source);
  if (!metadata) return null;
  if (record.purpose === "style-guide") {
    const text = index.guides.get(source.path)?.text || "";
    return { text, characters: [...text].length, skippedCount: metadata.skippedCount || 0 };
  }
  const candidates = (candidateIndex(record, index).get(source.path) || []).map((entry) => withOrigins(entry, entry.origins));
  return { candidates, skippedCount: metadata.skippedCount || 0 };
}

export function createResourceLibraryCompiler(dataDirectory) {
  const writes = new Map();
  const identity = (group) => JSON.stringify([group.workspace, group.projectId, group.purpose, group.libraryId || ""]);
  const path = (group) => join(dataDirectory, "runtime", "compiled-resources", `${createHash("sha256").update(identity(group)).digest("hex")}.json`);
  async function read(group, memo) {
    const file = path(group);
    if (memo?.has(file)) return memo.get(file);
    const pending = (async () => {
      let record;
      try { record = JSON.parse(await readFile(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (record.version !== 2 || identity(record) !== identity(group)) throw new Error("库编译文件的项目或库归属不匹配");
      return record;
    })();
    memo?.set(file, pending);
    return pending;
  }
  async function update(group, updates, { seed = async () => [] } = {}) {
    const file = path(group), previous = writes.get(file) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const saved = await read(group), replaced = new Set(updates.map((item) => item.source.path));
      const changes = saved ? updates : [...(await seed()).filter((item) => !replaced.has(item.source.path)), ...updates];
      const changed = new Set(changes.map((item) => item.source.path));
      const sources = new Map((saved?.sources || []).map((source) => [source.path, source]));
      let candidates = (saved?.candidates || []).map((entry) => ({ ...entry,
        origins: entry.origins.filter((origin) => !changed.has(origin.path)) })).filter((entry) => entry.origins.length);
      const guides = new Map();
      for (const guide of saved?.guides || []) {
        const origins = guide.origins.filter((origin) => !changed.has(origin.path));
        if (origins.length) guides.set(guide.text, { text: guide.text, origins });
      }
      for (const { source, parsed } of changes) {
        sources.set(source.path, { path: source.path, hash: source.hash, candidateCount: parsed.candidates?.length || 0, characters: parsed.characters || [...(parsed.text || "")].length, skippedCount: parsed.skippedCount || 0 });
        if (group.purpose === "style-guide") {
          if (!guides.has(parsed.text)) guides.set(parsed.text, { text: parsed.text, origins: [] });
          guides.get(parsed.text).origins.push({ path: source.path, hash: source.hash });
        }
        else for (const entry of parsed.candidates) candidates.push({ ...entry, origins: [{ path: source.path, hash: source.hash,
          note: entry.note || "", aliases: entry.aliases || [], file: entry.file || source.path, ...(entry.rowNumber ? { rowNumber: entry.rowNumber } : {}) }] });
      }
      candidates = mergeLibraryEntries(candidates, group.purpose, group.libraryId);
      const record = { version: 2, workspace: group.workspace, projectId: group.projectId, purpose: group.purpose, libraryId: group.libraryId || "",
        sources: [...sources.values()], ...(group.purpose === "style-guide" ? { guides: [...guides.values()] } : { candidates }),
        duplicateCount: group.purpose === "style-guide" ? sources.size - guides.size : [...sources.values()].reduce((sum, source) => sum + source.candidateCount, 0) - candidates.length };
      const temporary = `${file}.${randomUUID()}.tmp`;
      await mkdir(dirname(file), { recursive: true });
      try { await writeFile(temporary, JSON.stringify(record)); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      return record;
    });
    writes.set(file, next);
    try { return await next; } finally { if (writes.get(file) === next) writes.delete(file); }
  }
  return { path, read, update };
}

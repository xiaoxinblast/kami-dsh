import { readFile, writeFile, mkdir, copyFile, stat, rename, rm } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/sqlite-store.mjs";

export const COLLECTIONS = [
  "localization_projects", "project_resource_libraries", "corpus_documents", "term_import_batches", "term_candidates",
  ...["zh_cn", "ja_jp", "ko_kr", "zh_hant_tw", "fr_fr", "th_th"].flatMap((locale) => [`terms_${locale}`, `translation_memory_${locale}`]),
  "reference_documents", "reference_chunks", "reference_folders", "batch_runs", "background_tasks", "qa_tasks", "qa_runs", "qa_cases",
  "style_profiles", "style_evidence", "style_learning_runs", "user_profiles", "learning_trajectories", "translation_skills", "skill_evaluations", "quality_assets", "quality_runs", "training_runs"
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export async function migrate({ baseUrl, token, dataDirectories, destination, fetcher = fetch, collections = COLLECTIONS, onProgress = console.log }) {
  if (!baseUrl || !token) throw new Error("Migration requires the legacy Directus URL and service token");
  await mkdir(destination, { recursive: true });
  const stagingPath = join(destination, "migration-stage.sqlite");
  const store = new SqliteStore(stagingPath);
  store.db.exec("DELETE FROM records");
  const report = { version: 1, source: new URL(baseUrl).origin, startedAt: new Date().toISOString(), collections: {}, files: [], missingFiles: [] };
  const fileReferences = new Set();
  const findFiles = (value) => {
    if (typeof value === "string" && /^uploads[\\/]/.test(value)) fileReferences.add(value.replaceAll("\\", "/"));
    else if (Array.isArray(value)) value.forEach(findFiles);
    else if (value && typeof value === "object") Object.values(value).forEach(findFiles);
  };
  async function readPage(collection, offset) {
    const url = new URL(`/items/${collection}`, baseUrl);
    url.search = new URLSearchParams({ sort: "id", offset, limit: 500, fields: "*" });
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Legacy collection ${collection} unavailable (${response.status})`);
    const value = await response.json();
    if (!Array.isArray(value.data)) throw new Error(`Invalid export page: ${collection}`);
    return value.data;
  }
  try {
    for (const collection of collections) {
      const hash = createHash("sha256");
      let count = 0;
      for (let offset = 0; ; offset += 500) {
        const rows = await readPage(collection, offset);
        store.import(collection, rows);
        for (const row of rows) { hash.update(digest(row)); findFiles(row); }
        count += rows.length;
        if (rows.length < 500) break;
      }
      report.collections[collection] = { count, sha256: hash.digest("hex") };
      onProgress(`${collection}: ${count}`);
    }
    // Re-read the source: changing rows or pages invalidate this migration rather than producing a mixed snapshot.
    for (const collection of collections) {
      const hash = createHash("sha256");
      let count = 0;
      for (let offset = 0; ; offset += 500) {
        const rows = await readPage(collection, offset);
        for (const row of rows) hash.update(digest(row));
        count += rows.length;
        if (rows.length < 500) break;
      }
      const expected = report.collections[collection];
      if (count !== expected.count || hash.digest("hex") !== expected.sha256) throw new Error(`Source changed during migration: ${collection}`);
    }
    const finalPath = join(destination, "kami.sqlite");
    let alreadyPresent = false;
    try {
      await stat(finalPath);
      const existing = new SqliteStore(finalPath);
      try {
        if (existing.db.prepare("SELECT count(*) AS count FROM records").get().count > 0) {
          const rows = (database) => database.prepare("SELECT collection,id,body FROM records ORDER BY collection,id").all().map((row) => ({ ...row, body: JSON.parse(row.body) }));
          if (digest(rows(existing.db)) !== digest(rows(store.db))) throw new Error("Destination contains different data; refusing to overwrite. Choose a new destination.");
          alreadyPresent = true;
        }
      } finally { existing.close(); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const reference of fileReferences) {
      const target = resolve(destination, reference);
      if (relative(destination, target).startsWith("..") || isAbsolute(relative(destination, target))) throw new Error(`Invalid referenced file: ${reference}`);
      const found = [];
      for (const directory of dataDirectories) {
        const path = resolve(directory, reference);
        if (relative(directory, path).startsWith("..")) throw new Error(`Invalid source path: ${reference}`);
        try { if ((await stat(path)).isFile()) found.push({ path, bytes: await readFile(path) }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!found.length) { report.missingFiles.push(reference); continue; }
      const hashes = found.map((file) => createHash("sha256").update(file.bytes).digest("hex"));
      if (new Set(hashes).size > 1) throw new Error(`Conflicting legacy files: ${reference}`);
      await mkdir(dirname(target), { recursive: true });
      try {
        const previousHash = createHash("sha256").update(await readFile(target)).digest("hex");
        if (previousHash !== hashes[0]) throw new Error(`Destination file differs: ${reference}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await copyFile(found[0].path, target);
      const copiedHash = createHash("sha256").update(await readFile(target)).digest("hex");
      if (copiedHash !== hashes[0]) throw new Error(`File verification failed: ${reference}`);
      report.files.push({ path: reference, sha256: copiedHash, bytes: found[0].bytes.length });
    }
    if (report.missingFiles.length) throw new Error(`${report.missingFiles.length} referenced files are missing; see migration-report.json`);
    const integrity = store.integrity();
    if (integrity.some((row) => row.integrity_check !== "ok")) throw new Error("SQLite integrity check failed");
    report.integrity = integrity;
    report.finishedAt = new Date().toISOString();
    report.status = "verified";
    if (!alreadyPresent) {
      await store.backup(join(destination, "migration-verified.sqlite"));
      await rename(join(destination, "migration-verified.sqlite"), finalPath);
    }
    return report;
  } catch (error) {
    report.status = "incomplete";
    report.error = error.message;
    throw error;
  } finally {
    store.close();
    if (report.status === "verified") await rm(stagingPath, { force: true });
    await writeFile(join(destination, "migration-report.json"), JSON.stringify(report, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const value = (key) => args[args.indexOf(key) + 1];
  const sourceEnv = args.includes("--source-env") ? value("--source-env") : null;
  if (sourceEnv) process.loadEnvFile(sourceEnv);
  const destination = resolve(args.includes("--destination") ? value("--destination") : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "kami-dsh", "desktop"));
  const dataDirectories = args.flatMap((arg, index) => arg === "--source-data" ? [resolve(args[index + 1])] : []);
  const report = await migrate({ baseUrl: process.env.DIRECTUS_URL, token: process.env.DIRECTUS_TOKEN, dataDirectories, destination });
  console.log(JSON.stringify({ status: report.status, destination, collections: Object.keys(report.collections).length, files: report.files.length }));
}

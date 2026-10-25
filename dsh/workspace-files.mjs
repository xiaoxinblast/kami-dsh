import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractStyleGuideFile } from "../src/style-guide-import.mjs";
import { extractTermPairs } from "../src/table-term-extractor.mjs";
import { extractXliffPairs } from "../src/xliff-document.mjs";
import { readBatchOriginal } from "../src/batch-originals.mjs";
import { matchReviewPairsToSegments } from "../src/external-review.mjs";
import { createResourceLibraryCompiler, libraryResource, librarySource, mergeLibraryEntries } from "../src/resource-library-compilation.mjs";

const CONFIG = ".kami/project.json";
const fields = { "style-guide": "styleGuides", terms: "terms", tm: "translationMemories", reference: "references" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

function relativePath(value) {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value) || /^[A-Za-z]:|^[/\\]/u.test(value) || value.includes("\0") || value.split(/[/\\]/u).includes("..")) throw new Error("请指定工作区内的相对路径，不能使用越界路径");
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function configValue(value) {
  if (value?.version !== 1 || typeof value.projectId !== "string" || !value.projectId.trim()) throw new Error("无效的 .kami/project.json：需要 version: 1 和 projectId");
  const config = { version: 1, projectId: value.projectId, outputDirectory: relativePath(value.outputDirectory || "outputs") };
  for (const field of Object.values(fields)) {
    if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error(`${field} 必须是相对路径数组`);
    config[field] = [...new Set((value[field] || []).map(relativePath))];
  }
  const linkedPaths = Object.fromEntries(Object.values(fields).map((field) => [field, new Set(config[field])]));
  if (value.libraryFiles !== undefined && !Array.isArray(value.libraryFiles)) throw new Error("libraryFiles 必须是本地文件关联数组");
  config.libraryFiles = (value.libraryFiles || []).map((item) => {
    if (!["terms", "tm"].includes(item?.purpose) || typeof item.libraryId !== "string" || !item.libraryId.trim()) throw new Error("本地文件关联需要用途与资源库 ID");
    return { path: relativePath(item.path), purpose: item.purpose, libraryId: item.libraryId };
  }).filter((item) => linkedPaths[fields[item.purpose]].has(item.path));
  return config;
}

function fileLibrary(libraries, purpose, libraryId) {
  const kind = purpose === "terms" ? "term_base" : "translation_memory";
  const candidates = libraries.filter((item) => item.kind === kind).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.id.localeCompare(b.id));
  const library = libraryId ? candidates.find((item) => item.id === libraryId)
    : candidates.find((item) => item.role === "reference") || candidates.find((item) => item.role === "working") || candidates[0];
  if (!library) throw new Error("资源库不存在，或库类型与文件用途不匹配");
  return library;
}

function resolveFileLibraries(config, libraries) {
  const links = new Map(config.libraryFiles.map((item) => [`${item.purpose}\0${item.path}`, item.libraryId])), choices = new Map();
  return ["terms", "tm"].flatMap((purpose) => config[fields[purpose]].map((path) => {
    const requested = links.get(`${purpose}\0${path}`), key = `${purpose}\0${requested || ""}`;
    if (!choices.has(key)) choices.set(key, fileLibrary(libraries, purpose, requested).id);
    return { path, purpose, libraryId: choices.get(key) };
  }));
}

function resourceObservations(value = []) {
  if (!Array.isArray(value)) throw new Error("resourceContext 必须是 Agent 查阅结果数组");
  for (const item of value) {
    if (!item || typeof item.path !== "string" || !/^[a-f\d]{64}$/u.test(item.hash || "") || (item.text !== undefined && typeof item.text !== "string")
      || (item.pairs !== undefined && (!Array.isArray(item.pairs) || item.pairs.some((pair) => typeof pair?.source !== "string" || typeof pair?.target !== "string")))) throw new Error("resourceContext 需要原文件 path、hash 和 text 或 pairs 查阅结果");
    relativePath(item.path);
  }
  return value;
}

function resourceMetadataPair(source, target) {
  const text = source.replace(/\s+/gu, " ").trim(), translation = target.replace(/\s+/gu, " ").trim();
  if (text === translation && /^DO NOT DELETE THIS ROW[.!]?\s+When moving columns\b/iu.test(text)) return true;
  return /^(?:source(?: text)?|japanese|日本語|日语(?:原文)?|日文(?:原文)?|原文|ja(?:[-_]jp)?|jp)$/iu.test(text)
    && /^(?:target(?: text)?|translation|chinese(?: simp(?:lified)?)?|简体中文|简中|中文|译文|zh[-_]cn|cn)$/iu.test(translation);
}

function compiledResource(purpose, value) {
  if (purpose === "style-guide") {
    const text = value.style_guide ?? value.text;
    if (typeof text !== "string" || !text.trim()) throw new Error("风格指南编译结果需要完整的 style_guide 正文");
    return { text: text.trim(), characters: [...text.trim()].length };
  }
  const rows = purpose === "terms" && Array.isArray(value.terms) ? value.terms.map((item) => ({ ...item, source: item.ja, target: item.zh })) : value.entries ?? value.pairs;
  if (!Array.isArray(rows)) throw new Error("术语编译需要 terms:[{ja,zh,note}]；TM 编译需要 entries:[{source,target,context,file}]");
  const candidates = [];
  for (const row of rows) {
    if (typeof row?.source !== "string" || typeof row?.target !== "string" || (row.note !== undefined && typeof row.note !== "string")) throw new Error("资源编译条目需要原文、译文和可选的文本备注");
    const source = row.source, target = row.target;
    if (!source.trim() || !target.trim() || resourceMetadataPair(source, target) || row.decision === "excluded") continue;
    candidates.push({ ...row, source, target });
  }
  if (!candidates.length) throw new Error("资源编译结果没有有效句对，请核查原文列、译文列和保护行");
  return { candidates, skippedCount: rows.length - candidates.length };
}

// DSH owns file resolution and byte reads. Node realpath is an additional local containment check;
// no alternate working directory is used when a DSH target is unavailable.
export async function workspaceRoot(context) {
  if (!context.cwd || !context.fs) throw new Error("需要当前 DSH 会话的工作目录和文件服务");
  const target = await context.fs.resolve(context.cwd, { signal: context.signal });
  const info = await context.fs.stat(target, context.signal);
  if (info?.type !== "directory") throw new Error("当前工作区目录不存在");
  const path = context.fs.processPath(target);
  if (!isAbsolute(path)) throw new Error("当前文件服务不支持本地工作区路径");
  return realpath(path);
}

async function checkedTarget(root, path, context) {
  const name = relativePath(path);
  const target = await context.fs.resolve(name, { cwd: root, signal: context.signal });
  const actual = await realpath(context.fs.processPath(target));
  if (!inside(root, actual)) throw new Error(`文件链接指向工作区外：${name}`);
  return { name, target, actual };
}

async function referenceSource(root, path, context) {
  const entry = await checkedTarget(root, path, context), info = await context.fs.stat(entry.target, context.signal);
  if (info?.type !== "file") throw new Error(`不是普通文件：${entry.name}`);
  return { path: entry.name, filename: basename(entry.name), size: info.size, version: info.version };
}

async function readSource(root, path, context, maxBytes, metadataOnly = false, cache) {
  const entry = await checkedTarget(root, path, context);
  const info = await context.fs.stat(entry.target, context.signal);
  if (info?.type !== "file") throw new Error(`不是普通文件：${entry.name}`);
  if (maxBytes !== undefined && info.size > maxBytes) throw new Error(`文件超过 ${maxBytes / 1024 / 1024} MB：${entry.name}`);
  const cached = metadataOnly && cache?.get(entry.actual);
  if (info.version !== undefined && cached?.version === info.version && cached.source.size === info.size) return { ...cached.source, path: entry.name, filename: basename(entry.name) };
  let bytes, digest;
  if (metadataOnly && typeof context.fs.readByteRange === "function") {
    const hasher = createHash("sha256");
    for (let offset = 0; offset < info.size; offset += 1024 * 1024) {
      const length = Math.min(1024 * 1024, info.size - offset);
      const chunk = await context.fs.readByteRange(entry.target, { offset, length }, context.signal);
      if (chunk.length !== length) throw new Error(`读取期间文件发生变化，请重试：${entry.name}`);
      hasher.update(chunk);
    }
    digest = hasher.digest("hex");
  } else bytes = Buffer.from(await context.fs.readBytes(entry.target, context.signal, maxBytes ?? info.size));
  const after = await context.fs.stat(entry.target, context.signal);
  if ((maxBytes !== undefined && bytes?.length > maxBytes) || after?.version !== info.version || await realpath(context.fs.processPath(entry.target)) !== entry.actual) throw new Error(`读取期间文件发生变化，请重试：${entry.name}`);
  const source = { path: entry.name, filename: basename(entry.name), hash: digest || hash(bytes), ...(metadataOnly ? {} : { bytes }), size: info.size };
  if (metadataOnly && info.version !== undefined) cache?.set(entry.actual, { version: info.version, source });
  return source;
}

async function writeTarget(root, path, context) {
  let target = await context.fs.resolve(relativePath(path), { cwd: root, signal: context.signal });
  if (typeof context.fs.checkedTarget === "function") target = await context.fs.checkedTarget(target, context.filePolicy);
  else if (context.filePolicy?.mode === "read-only") throw new Error("当前 DSH 会话为 read-only，不能写入工作区文件");
  if (!inside(root, resolve(context.fs.processPath(target)))) throw new Error("写入路径指向工作区外");
  return target;
}

async function safeParent(root, path) {
  const destination = resolve(root, relativePath(path));
  if (!inside(root, destination)) throw new Error("输出路径超出工作区");
  let ancestor = dirname(destination);
  while (true) {
    try { if (!inside(root, await realpath(ancestor))) throw new Error("输出目录链接指向工作区外"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(dirname(destination), { recursive: true });
  if (!inside(root, await realpath(dirname(destination)))) throw new Error("输出目录链接指向工作区外");
  return destination;
}

export function createWorkspaceFiles({ dataDirectory, invoke, review }) {
  const writes = new Map();
  const compiler = createResourceLibraryCompiler(dataDirectory);
  const catalogs = new WeakMap();
  const statusSources = new Map(), statusCoverage = new Map();
  function compilationCatalog(state) {
    if (catalogs.has(state)) return catalogs.get(state);
    const groups = new Map(), files = new Map(), libraries = new Map(state.libraries.map((library) => [library.id, library]));
    const links = new Map(state.config.libraryFiles.map((item) => [`${item.purpose}\0${item.path}`, item.libraryId])), defaults = new Map();
    const resolveLibrary = (purpose, id) => {
      if (purpose === "style-guide") return null;
      if (!id && !defaults.has(purpose)) defaults.set(purpose, fileLibrary(state.libraries, purpose));
      const library = id ? libraries.get(id) : defaults.get(purpose);
      if (!library || library.kind !== (purpose === "terms" ? "term_base" : "translation_memory")) throw new Error("资源库不存在，或库类型与文件用途不匹配");
      return library;
    };
    const get = (purpose, library) => {
      const key = `${purpose}\0${library?.id || ""}`;
      if (!groups.has(key)) groups.set(key, { workspace: state.workspace, projectId: state.config.projectId, purpose, libraryId: library?.id || "", libraryName: library?.name || "项目风格指南", paths: [] });
      return groups.get(key);
    };
    for (const purpose of ["terms", "tm", "style-guide"]) for (const path of state.config[fields[purpose]]) {
      const group = get(purpose, resolveLibrary(purpose, links.get(`${purpose}\0${path}`)));
      group.paths.push(path); files.set(`${purpose}\0${path}`, group);
    }
    const catalog = { files, get, resolveLibrary };
    catalogs.set(state, catalog);
    return catalog;
  }
  function compilationGroup(state, purpose, path, libraryId) {
    const catalog = compilationCatalog(state), existing = catalog.files.get(`${purpose}\0${path}`);
    const group = existing && (!libraryId || existing.libraryId === libraryId) ? existing : catalog.get(purpose, catalog.resolveLibrary(purpose, libraryId));
    return existing === group ? group : { ...group, paths: [...group.paths, path] };
  }
  async function legacyCompilations(group, context, updated) {
    const values = [];
    for (const path of group.paths) {
      if (updated.has(path)) continue;
      const folder = join(dataDirectory, "runtime", "compiled-resources", hash(`${group.workspace}\0${group.purpose}\0${path}`));
      try {
        await stat(folder);
        const source = await readSource(group.workspace, path, context, undefined, true);
        const value = JSON.parse(await readFile(join(folder, `${source.hash}.json`), "utf8"));
        if (value.version === 1 && value.purpose === group.purpose && value.source?.path === path && value.source?.hash === source.hash) values.push({ source, parsed: value.parsed });
      } catch (error) { if (!["ENOENT", "FS_NOT_FOUND"].includes(error.code)) throw error; }
    }
    return values;
  }
  async function libraryRecord(group, context, memo) {
    const file = compiler.path(group);
    if (memo?.has(file)) return memo.get(file);
    const pending = (async () => {
      const record = await compiler.read(group);
      if (record) return record;
      const seed = await legacyCompilations(group, context, new Set());
      return seed.length ? compiler.update(group, [], { seed: async () => seed }) : null;
    })();
    memo?.set(file, pending);
    return pending;
  }
  async function compilation(state, purpose, source, args, context, memo) {
    if (args.register === false && (args.compiledPath || args.resourceContext?.length)) throw new Error("仅核查文件信息时不能提交编译结果");
    const group = compilationGroup(state, purpose, source.path, args.libraryId);
    let inputs = [];
    if (args.compiledPath) {
      if (args.resourceContext?.length) throw new Error("compiledPath 与 resourceContext 二选一");
      const value = JSON.parse((await readSource(state.workspace, args.compiledPath, context)).bytes.toString("utf8"));
      inputs = value.resources ?? [{ ...value, path: value.source?.path, hash: value.source?.hash }];
      if (!Array.isArray(inputs) || !inputs.length) throw new Error("库更新文件需要非空的 resources 编译结果数组");
    } else inputs = resourceObservations(args.resourceContext);
    let record;
    if (inputs.length) {
      if (!inputs.some((item) => item?.path === source.path)) throw new Error("资源编译结果的来源路径与原文件不一致");
      const seen = new Set(), allowed = new Set(group.paths), updates = [];
      for (const input of inputs) {
        const path = relativePath(input.path);
        if (!allowed.has(path) || seen.has(path)) throw new Error("一次更新只能包含当前库内的文件，且来源路径不能重复");
        seen.add(path);
        const original = path === source.path ? source : await readSource(state.workspace, path, context, undefined, true);
        if (input.hash !== original.hash) throw new Error(`编译期间原文件版本发生变化，请重新查看并编译：${path}`);
        updates.push({ source: original, parsed: compiledResource(purpose, input) });
      }
      record = await compiler.update(group, updates, { seed: () => legacyCompilations(group, context, seen) });
    } else record = await libraryRecord(group, context, memo);
    const parsed = librarySource(record, source);
    return { status: parsed ? "ready" : "pending", format: purpose, libraryId: group.libraryId, libraryName: group.libraryName,
      compiledFile: compiler.path(group), librarySourceCount: group.paths.length, libraryItemCount: record?.candidates?.length || 0,
      duplicateCount: record?.duplicateCount || 0, ...(parsed ? { itemCount: parsed.candidateCount || 0, characters: parsed.characters || 0, skippedCount: parsed.skippedCount || 0 } : {}) };
  }
  async function compilationVersion(file) {
    try {
      const info = await stat(file, { bigint: true });
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  }
  async function compilationCoverage(group, context, memo) {
    const file = compiler.path(group);
    if (memo.has(file)) return memo.get(file);
    const pending = (async () => {
      const version = await compilationVersion(file), cached = statusCoverage.get(file);
      if (cached?.version === version) return cached.sources;
      const record = await libraryRecord(group, context);
      const sources = new Map((record?.sources || []).map((source) => [source.path, source.hash]));
      if (version === await compilationVersion(file)) statusCoverage.set(file, { version, sources });
      return sources;
    })();
    memo.set(file, pending);
    return pending;
  }
  async function compilationRequests(state, selection, context) {
    const catalog = compilationCatalog(state), enabled = new Set(state.libraries.filter((library) => library.enabled !== false).map((library) => library.id));
    if (selection === undefined) selection = Object.entries(fields).filter(([purpose]) => purpose !== "reference").flatMap(([purpose, field]) => state.config[field].filter((path) => {
      const group = catalog.files.get(`${purpose}\0${path}`);
      return !group.libraryId || enabled.has(group.libraryId);
    }).map((path) => ({ path, purpose })));
    if (!Array.isArray(selection)) throw new Error("selection 必须是所选资源数组");
    const groups = new Map(), seen = new Set(), memo = new Map(), failures = [];
    for (const item of selection) {
      if (!["terms", "tm", "style-guide"].includes(item?.purpose)) throw new Error("批量编译仅支持术语、TM 和风格指南");
      const path = relativePath(item.path), purpose = item.purpose, key = `${purpose}\0${path}`;
      if (!catalog.files.has(key)) throw new Error(`文件尚未关联：${path}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = compilationGroup(state, purpose, path);
      if (item.libraryId && item.libraryId !== group.libraryId) throw new Error(`文件所属库已变化，请刷新后重试：${path}`);
      const id = `${purpose}\0${group.libraryId}`;
      if (!groups.has(id)) groups.set(id, { purpose, libraryId: group.libraryId, libraryName: group.libraryName, compiledFile: compiler.path(group),
        updatePath: `.kami/compiled/${purpose}-${hash(`${state.config.projectId}\0${id}`).slice(0, 16)}.json`, files: [] });
      try {
        const source = await readSource(state.workspace, path, context, undefined, true, statusSources), coverage = await compilationCoverage(group, context, memo);
        groups.get(id).files.push({ path, hash: source.hash, status: coverage.get(path) === source.hash ? "ready" : "pending" });
      } catch (error) { failures.push({ path, purpose, error: error.message }); }
    }
    return { projectId: state.config.projectId, groups: [...groups.values()], failures };
  }
  async function readConfig(root, context) {
    const target = await context.fs.resolve(CONFIG, { cwd: root, signal: context.signal });
    if (!inside(root, resolve(context.fs.processPath(target)))) throw new Error("工作区配置链接指向工作区外");
    if (!await context.fs.stat(target, context.signal)) return null;
    return configValue(JSON.parse((await readSource(root, CONFIG, context, 64 * 1024)).bytes.toString("utf8")));
  }
  async function update(context, edit) {
    const root = await workspaceRoot(context);
    const previous = writes.get(root) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const config = await readConfig(root, context);
      const updated = configValue(await edit(config));
      await writeTarget(root, CONFIG, context);
      await safeParent(root, CONFIG);
      const target = await context.fs.resolve(CONFIG, { cwd: root, signal: context.signal });
      if (!inside(root, resolve(context.fs.processPath(target)))) throw new Error("工作区配置链接指向工作区外");
      const info = await context.fs.stat(target, context.signal);
      if (info) await checkedTarget(root, CONFIG, context);
      await context.fs.writeText(target, `${JSON.stringify(updated, null, 2)}\n`, info ? { kind: "replaceIfVersion", version: info.version } : { kind: "createIfAbsent" }, context.signal, context.filePolicy);
      return updated;
    });
    writes.set(root, next);
    try { return await next; } finally { if (writes.get(root) === next) writes.delete(root); }
  }
  async function status(context) {
    const root = await workspaceRoot(context);
    const config = await readConfig(root, context);
    const projects = (await invoke({ path: "/api/projects" }, context)).projects || [];
    const project = projects.find((item) => item.id === config?.projectId) || null;
    if (config && !project) throw new Error(`工作区绑定的 Kami 项目不存在：${config.projectId}`);
    const libraries = config ? (await invoke({ path: `/api/projects/${encodeURIComponent(config.projectId)}/libraries` }, context)).libraries || [] : [];
    return { workspace: root, config: config ? { ...config, libraryFiles: resolveFileLibraries(config, libraries) } : config, libraries, project, bound: Boolean(config), isKamiSession: context.isKamiSession === true, sessionId: context.sessionId || "" };
  }
  async function workspace(args = {}, context) {
    const action = args.action || "status";
    const compilations = [];
    if (action === "status") return status(context);
    if (action === "compilations") return compilationRequests(await bound(context, args.projectId), args.selection, context);
    if (action === "bind") {
      if (Boolean(args.projectId) === Boolean(args.name)) throw new Error("请明确指定已有 projectId 或新项目 name，二者选一");
      const root = await workspaceRoot(context);
      await writeTarget(root, CONFIG, context);
      const project = args.projectId ? (await invoke({ path: "/api/projects" }, context)).projects.find((item) => item.id === args.projectId)
        : (await invoke({ path: "/api/projects", method: "POST", body: { name: args.name } }, context)).project;
      if (!project) throw new Error("指定的 Kami 项目不存在");
      await update(context, (current) => ({ ...current, version: 1, projectId: project.id, libraryFiles: current?.projectId === project.id ? current.libraryFiles : [] }));
    } else if (action === "configure") {
      await update(context, async (current) => {
        if (!current) throw new Error("请先明确绑定或创建 Kami 项目");
        const allowed = Object.keys(args.resources || {}).every((key) => [...Object.values(fields), "outputDirectory", "libraryFiles"].includes(key));
        if (!allowed) throw new Error("未知的工作区资源字段");
        const next = configValue({ ...current, ...args.resources });
        const libraries = (await invoke({ path: `/api/projects/${encodeURIComponent(current.projectId)}/libraries` }, context)).libraries || [];
        const memo = new Map();
        const root = await workspaceRoot(context), state = { workspace: root, config: { ...next, libraryFiles: resolveFileLibraries(next, libraries) }, libraries };
        for (const [purpose, field] of Object.entries(fields)) {
          if (purpose === "reference" || !Object.hasOwn(args.resources || {}, field)) continue;
          if (next[field].length < current[field].length && next[field].every((path) => current[field].includes(path))) continue;
          for (const path of next[field]) {
            const source = await readSource(root, path, context, undefined, true);
            compilations.push({ path: source.path, hash: source.hash, purpose, compilation: await compilation(state, purpose, source, {}, context, memo) });
          }
        }
        return next;
      });
    } else throw new Error("未知的工作区操作");
    const state = await status(context);
    return action === "configure" ? { ...state, compilations } : state;
  }
  async function bound(context, projectId) {
    const state = await status(context);
    if (!state.config) throw new Error("请先通过 kami_workspace 明确绑定或创建 Kami 项目");
    if (projectId && projectId !== state.config.projectId) throw new Error("指定项目与当前工作区绑定不一致");
    return state;
  }
  async function parseResource(state, purpose, path, context, resourceContext = [], libraryId, memo) {
    if (!fields[purpose]) throw new Error("未知的文件用途");
    const root = state.workspace;
    const observation = resourceContext.find((item) => relativePath(item.path) === relativePath(path));
    let source = await readSource(root, path, context, undefined, true);
    if (observation) {
      if (observation.hash !== source.hash) throw new Error(`Agent 查阅后原文件版本发生变化，请重新查看：${source.path}`);
      const text = String(observation.text || "").trim();
      const candidates = ["terms", "tm"].includes(purpose) ? compiledResource(purpose, observation).candidates : [];
      if (["terms", "tm"].includes(purpose) ? !candidates.length : !text) throw new Error(`Agent 尚未提供此资源的查阅结果：${source.path}`);
      return { path: source.path, filename: source.filename, purpose, hash: source.hash, size: source.size, reader: "agent",
        parsed: { text, candidates, characters: text.length } };
    }
    if (purpose !== "reference") {
      const parsed = libraryResource(await libraryRecord(compilationGroup(state, purpose, path, libraryId), context, memo), source);
      if (parsed) return { path: source.path, filename: source.filename, purpose, hash: source.hash, size: source.size, reader: "agent", parsed };
    }
    if (!source.bytes) {
      const originalHash = source.hash;
      source = await readSource(root, path, context);
      if (source.hash !== originalHash) throw new Error(`读取期间原文件版本发生变化，请重试：${source.path}`);
    }
    const cachePath = join(dataDirectory, "runtime", "workspace-resources", hash(`${root}\0${purpose}\0${source.path}`), `${source.hash}.json`);
    let parsed;
    try { parsed = JSON.parse(await readFile(cachePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!parsed) {
      if (purpose === "style-guide") parsed = await extractStyleGuideFile({ filename: source.filename, buffer: source.bytes });
      else if (/\.(?:mqxliff|xliff)$/iu.test(source.filename)) parsed = { candidates: extractXliffPairs(source.bytes, source.filename) };
      else {
        parsed = await extractTermPairs({ filename: source.filename, buffer: source.bytes, locale: "zh-CN" });
        if (parsed.statistics.truncated) throw new Error(`表格超出解析行数上限：${source.path}`);
      }
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(parsed));
    }
    return { path: source.path, filename: source.filename, purpose, hash: source.hash, size: source.size, parsed };
  }
  async function snapshot(state, resources, context, resourceContext = []) {
    if (!resources || Array.isArray(resources) || typeof resources !== "object" || !Object.keys(resources).every((key) => [...Object.values(fields), "outputDirectory"].includes(key))) throw new Error("未知的任务资源字段");
    resourceObservations(resourceContext);
    const config = configValue({ ...state.config, ...resources });
    const result = { id: randomUUID(), workspace: state.workspace, projectId: config.projectId, createdAt: new Date().toISOString(), outputDirectory: config.outputDirectory, resources: [], terms: [], memories: [], referenceChunks: [], guide: null,
      ...(config.references.length ? { referenceMode: "agent-native" } : {}) };
    const guides = [];
    const guideTexts = new Set();
    const compiled = new Map();
    const libraries = (await invoke({ path: `/api/projects/${encodeURIComponent(config.projectId)}/libraries` }, context)).libraries || [];
    const compilationState = { ...state, config, libraries };
    const libraryById = new Map(libraries.map((library) => [library.id, library]));
    for (const [purpose, field] of Object.entries(fields)) {
      for (const path of config[field]) {
        if (purpose === "reference") {
          const source = await referenceSource(state.workspace, path, context);
          result.resources.push({ ...source, purpose, reader: "agent-native" });
          continue;
        }
        const library = ["terms", "tm"].includes(purpose) ? libraryById.get(compilationGroup(compilationState, purpose, path).libraryId) : null;
        if (library?.enabled === false) continue;
        const resource = await parseResource(compilationState, purpose, path, context, resourceContext, library?.id, compiled);
        const { parsed, ...metadata } = resource;
        result.resources.push({ ...metadata, ...(library ? { libraryId: library.id, libraryName: library.name, libraryPriority: library.priority } : {}) });
        if (purpose === "style-guide") {
          if (!guideTexts.has(parsed.text)) { guideTexts.add(parsed.text); guides.push(`【${path}】\n${parsed.text}`); }
        }
        else {
          const libraryId = `workspace:${hash(`${purpose}\0${path}`)}`;
          const items = parsed.candidates.filter((item) => item.source && item.target && item.decision !== "excluded" && !resourceMetadataPair(item.source, item.target)).map((item, index) => ({ ...item, origins: item.origins || [{ path, hash: resource.hash, note: item.note || "", aliases: item.aliases || [], ...(item.rowNumber ? { rowNumber: item.rowNumber } : {}) }], id: `${libraryId}:${index}`, locale: "zh-CN", projectId: config.projectId, libraryId, linkedLibraryId: library?.id, libraryName: library?.name || path, libraryRole: "reference", libraryPriority: library?.priority || 1, libraryEnabled: true, status: "approved", qualityStatus: purpose === "tm" ? "machine_verified" : "human_approved", assetTier: purpose === "tm" ? "working" : "formal", workspaceResource: true, taskId: result.id, sourceFile: path, contentType: item.contentType || "general", domain: item.domain || "general" }));
          for (const item of items) result[purpose === "terms" ? "terms" : "memories"].push(item);
        }
      }
    }
    result.terms = mergeLibraryEntries(result.terms, "terms");
    result.memories = mergeLibraryEntries(result.memories, "tm");
    if (guides.length) result.guide = { id: `workspace:${result.id}`, name: "工作区风格指南", instruction: guides.join("\n\n"), projectId: config.projectId, status: "active" };
    return result;
  }
  async function importFile(args, context) {
    if (args.purpose === "review-final") return linkReview(args, context);
    const state = await bound(context, args.projectId);
    const purpose = args.purpose || "translation";
    // Older callers may supply an absolute in-workspace translation path.
    const path = isAbsolute(args.path || "") ? relative(state.workspace, await realpath(args.path)) : args.path;
    if (purpose !== "translation") {
      if (!fields[purpose]) throw new Error("未知的文件用途");
      const savedLink = state.config.libraryFiles.find((item) => item.purpose === purpose && item.path === relativePath(path));
      const library = ["terms", "tm"].includes(purpose) ? fileLibrary(state.libraries, purpose, args.libraryId || savedLink?.libraryId) : null;
      if (args.libraryId && !library) throw new Error("此文件用途不使用术语或 TM 资源库");
      const source = purpose === "reference" ? await referenceSource(state.workspace, path, context) : await readSource(state.workspace, path, context, undefined, true);
      const resource = { ...source, purpose, ...(library ? { libraryId: library.id, libraryName: library.name } : {}) };
      if (purpose !== "reference") resource.compilation = await compilation(state, purpose, source, args, context);
      if (args.register !== false) await update(context, (config) => ({ ...config, [fields[purpose]]: [...new Set([...config[fields[purpose]], resource.path])],
        libraryFiles: [...config.libraryFiles.filter((item) => item.purpose !== purpose || item.path !== resource.path), ...(library ? [{ path: resource.path, purpose, libraryId: library.id }] : [])] }));
      return { ...resource, registered: args.register !== false, readMode: "agent", taskScoped: true };
    }
    const source = await readSource(state.workspace, path, context);
    const resources = await snapshot(state, args.resources || {}, context, args.resourceContext);
    const originalFile = `runtime/workspace-snapshots/${resources.id}/${source.filename}`;
    await mkdir(dirname(join(dataDirectory, originalFile)), { recursive: true });
    await writeFile(join(dataDirectory, originalFile), source.bytes, { flag: "wx" });
    resources.source = { path: source.path, filename: source.filename, hash: source.hash, size: source.size };
    return invoke({ method: "POST", path: "/api/batch/prepare", body: { filename: args.filename || source.filename, projectId: state.config.projectId, locale: "zh-CN", useAiStructure: args.useAiStructure, columnMapping: args.columnMapping } }, { ...context, fileInput: source.bytes, workspaceSnapshot: resources, originalFile });
  }
  async function saveExport(value, filename, context, outputPath) {
    if (!value?.base64) throw new Error("Export did not return a file");
    const state = await bound(context);
    const path = relativePath(outputPath || join(state.config.outputDirectory, basename(filename || value.filename || "translation.bin")));
    context.signal?.throwIfAborted();
    const target = await writeTarget(state.workspace, path, context);
    const destination = await safeParent(state.workspace, path);
    // The DSH FS currently exposes text-only writes; binary export uses exclusive creation
    // after resolving the destination through the same DSH service and checking containment.
    if (resolve(context.fs.processPath(target)) !== destination) throw new Error("输出文件服务路径不匹配");
    const file = await open(destination, "wx").catch((error) => {
      if (error.code === "EEXIST") error.message = `输出文件已存在，请更换导出路径：${path}`;
      throw error;
    });
    try { await file.writeFile(Buffer.from(value.base64, "base64")); } finally { await file.close(); }
    return { path: destination, relativePath: path, filename: basename(path), bytes: (await stat(destination)).size };
  }
  async function linkReview(args, context) {
    if (!context.human) throw new Error("请在工作台关联人工审校完成版，机器草稿不能自行确认为人工终稿");
    const state = await bound(context, args.projectId);
    if (!args.batchId) throw new Error("关联人工终稿需要原翻译批次 ID");
    const response = await invoke({ path: `/api/batch/run/${encodeURIComponent(args.batchId)}?projectId=${encodeURIComponent(state.config.projectId)}` }, context);
    const run = response.run || response;
    if (run.runnerOptions?.workspaceSnapshot?.workspace !== state.workspace) throw new Error("原批次属于另一个工作区，不能关联此终稿");
    if (["running", "queued"].includes(run.runState) || run.workflow?.writeBusy) throw new Error("当前翻译或 QA 尚未结束，请稍后关联人工终稿");
    if (!/\.(mqxliff|xliff)$/iu.test(args.path || "") || !["mqxliff", "xliff"].includes(run.format)) throw new Error("人工终稿需要与原批次对应的 MQXLIFF / XLIFF 双语文件");
    const library = fileLibrary(state.libraries, "tm", args.libraryId || state.libraries.find((item) => item.kind === "translation_memory" && item.role === "master")?.id);
    if (library.enabled === false || library.role === "working") throw new Error("请选择已启用的主 TM 或参考 TM 保存人工终稿");
    await writeTarget(state.workspace, CONFIG, context);
    const source = await readSource(state.workspace, args.path, context);
    const { bytes, ...file } = source;
    const previous = run.runnerOptions?.reviewFinal;
    let report;
    if (previous?.hash === file.hash && previous.path === file.path && previous.libraryId === library.id && previous.complete) {
      report = { ...previous.report, alreadyLinked: true };
    } else {
      const original = await readBatchOriginal({ dataRoot: dataDirectory, relativePath: run.runnerOptions?.originalFile });
      if (!original) throw new Error("原批次的原文件快照不可用，无法核验人工终稿");
      const originals = extractXliffPairs(original, run.filename, { includeEmptyTargets: true }).map((pair) => ({ ...pair, locator: { unitId: pair.entryId } }));
      const pairs = extractXliffPairs(bytes, file.filename);
      if (!pairs.length) throw new Error("终稿中没有原文与译文均非空的双语条目");
      const validated = matchReviewPairsToSegments(originals, pairs);
      const validPairs = validated.matches.map((match) => pairs[match.pairIndex]);
      const completed = run.segments.filter((segment) => segment.status === "done" && segment.translation?.trim());
      if (!matchReviewPairsToSegments(completed, validPairs).matches.length) throw new Error("人工终稿未匹配本批已完成译段，请检查原文与原批次");
      report = await review({ run, pairs: validPairs, memoryPairs: validPairs, projectId: state.config.projectId, filename: file.path, libraryId: library.id,
        reviewFile: { ...file, libraryId: library.id }, rejected: { unmatched: validated.unmatched, ambiguous: validated.ambiguous } }, { ...context, workspaceSnapshot: run.runnerOptions.workspaceSnapshot });
    }
    await update(context, (config) => {
      if (config.projectId !== state.config.projectId) throw new Error("工作区项目已切换，请重新关联人工终稿");
      return { ...config, translationMemories: [...new Set([...config.translationMemories, file.path])],
        libraryFiles: [...config.libraryFiles.filter((item) => item.purpose !== "tm" || item.path !== file.path), { path: file.path, purpose: "tm", libraryId: library.id }] };
    });
    return { ...report, file: { ...file, libraryId: library.id } };
  }
  return { workspace, bound, snapshot, importFile, saveExport, linkReview };
}

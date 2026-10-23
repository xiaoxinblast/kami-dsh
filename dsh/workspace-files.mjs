import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractStyleGuideFile } from "../src/style-guide-import.mjs";
import { extractTermPairs } from "../src/table-term-extractor.mjs";
import { extractXliffPairs } from "../src/xliff-document.mjs";
import { chunkReferencePages, extractReferenceFile, MAX_REFERENCE_FILE_BYTES, scanReferenceRisk } from "../src/reference-materials.mjs";

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
  return config;
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

async function readSource(root, path, context, maxBytes = 20 * 1024 * 1024) {
  const entry = await checkedTarget(root, path, context);
  const info = await context.fs.stat(entry.target, context.signal);
  if (info?.type !== "file") throw new Error(`不是普通文件：${entry.name}`);
  if (info.size > maxBytes) throw new Error(`文件超过 ${maxBytes / 1024 / 1024} MB：${entry.name}`);
  const bytes = Buffer.from(await context.fs.readBytes(entry.target, context.signal, maxBytes));
  const after = await context.fs.stat(entry.target, context.signal);
  if (bytes.length > maxBytes || after?.version !== info.version || await realpath(context.fs.processPath(entry.target)) !== entry.actual) throw new Error(`读取期间文件发生变化，请重试：${entry.name}`);
  return { path: entry.name, filename: basename(entry.name), hash: hash(bytes), bytes, size: bytes.length };
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

export function createWorkspaceFiles({ dataDirectory, invoke }) {
  const writes = new Map();
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
    return { workspace: root, config, project, bound: Boolean(config), isKamiSession: context.isKamiSession === true, sessionId: context.sessionId || "" };
  }
  async function workspace(args = {}, context) {
    const action = args.action || "status";
    if (action === "status") return status(context);
    if (action === "bind") {
      if (Boolean(args.projectId) === Boolean(args.name)) throw new Error("请明确指定已有 projectId 或新项目 name，二者选一");
      const root = await workspaceRoot(context);
      await writeTarget(root, CONFIG, context);
      const project = args.projectId ? (await invoke({ path: "/api/projects" }, context)).projects.find((item) => item.id === args.projectId)
        : (await invoke({ path: "/api/projects", method: "POST", body: { name: args.name } }, context)).project;
      if (!project) throw new Error("指定的 Kami 项目不存在");
      await update(context, (current) => ({ ...current, version: 1, projectId: project.id }));
    } else if (action === "configure") {
      await update(context, (current) => {
        if (!current) throw new Error("请先明确绑定或创建 Kami 项目");
        const allowed = Object.keys(args.resources || {}).every((key) => [...Object.values(fields), "outputDirectory"].includes(key));
        if (!allowed) throw new Error("未知的工作区资源字段");
        return { ...current, ...args.resources };
      });
    } else throw new Error("未知的工作区操作");
    return status(context);
  }
  async function bound(context, projectId) {
    const state = await status(context);
    if (!state.config) throw new Error("请先通过 kami_workspace 明确绑定或创建 Kami 项目");
    if (projectId && projectId !== state.config.projectId) throw new Error("指定项目与当前工作区绑定不一致");
    return state;
  }
  async function parseResource(root, purpose, path, context) {
    if (!fields[purpose]) throw new Error("未知的文件用途");
    const source = await readSource(root, path, context, purpose === "style-guide" ? 5 * 1024 * 1024 : purpose === "reference" ? MAX_REFERENCE_FILE_BYTES : 20 * 1024 * 1024);
    const cachePath = join(dataDirectory, "runtime", "workspace-resources", hash(`${root}\0${purpose}\0${source.path}`), `${source.hash}.json`);
    let parsed;
    try { parsed = JSON.parse(await readFile(cachePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!parsed) {
      if (purpose === "style-guide") parsed = await extractStyleGuideFile({ filename: source.filename, buffer: source.bytes });
      else if (purpose === "reference") {
        const extracted = await extractReferenceFile({ filename: source.filename, buffer: source.bytes, vision: true });
        if (extracted.pendingPages) throw new Error(`参考资料有 ${extracted.pendingPages} 页未完成识别：${source.path}`);
        parsed = { chunks: chunkReferencePages(extracted.pages), characters: extracted.characters };
      } else if (/\.(?:mqxliff|xliff)$/iu.test(source.filename)) parsed = { candidates: extractXliffPairs(source.bytes, source.filename) };
      else {
        parsed = await extractTermPairs({ filename: source.filename, buffer: source.bytes, locale: "zh-CN" });
        if (parsed.statistics.truncated) throw new Error(`表格超出解析行数上限：${source.path}`);
      }
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(parsed));
    }
    return { path: source.path, filename: source.filename, purpose, hash: source.hash, size: source.size, parsed };
  }
  async function snapshot(state, resources, context) {
    const config = configValue({ ...state.config, ...resources });
    const result = { id: randomUUID(), workspace: state.workspace, projectId: config.projectId, createdAt: new Date().toISOString(), outputDirectory: config.outputDirectory, resources: [], terms: [], memories: [], referenceChunks: [], guide: null };
    const guides = [];
    for (const [purpose, field] of Object.entries(fields)) {
      for (const path of config[field]) {
        const resource = await parseResource(state.workspace, purpose, path, context);
        const { parsed, ...metadata } = resource;
        result.resources.push(metadata);
        if (purpose === "style-guide") guides.push(`【${path}】\n${parsed.text}`);
        else if (purpose === "reference") {
          const documentId = `workspace:${hash(`${path}\0${resource.hash}`)}`;
          result.referenceChunks.push(...parsed.chunks.map((chunk, ordinal) => ({ ...chunk, id: `${documentId}:${ordinal}`, documentId, documentName: path, documentStatus: "ready", ordinal, libraryEnabled: true, risk: scanReferenceRisk(chunk.text), allowed: !scanReferenceRisk(chunk.text) })));
        } else {
          const libraryId = `workspace:${hash(path)}`;
          const items = parsed.candidates.filter((item) => item.source && item.target && item.decision !== "excluded").map((item, index) => ({ ...item, id: `${libraryId}:${index}`, locale: "zh-CN", projectId: config.projectId, libraryId, libraryName: path, libraryRole: "reference", libraryPriority: 1, libraryEnabled: true, status: "approved", qualityStatus: purpose === "tm" ? "machine_verified" : "human_approved", assetTier: purpose === "tm" ? "working" : "formal", workspaceResource: true, taskId: result.id, sourceFile: path, contentType: "general", domain: "general" }));
          result[purpose === "terms" ? "terms" : "memories"].push(...items);
        }
      }
    }
    if (guides.length) result.guide = { id: `workspace:${result.id}`, name: "工作区风格指南", instruction: guides.join("\n\n"), projectId: config.projectId, status: "active" };
    return result;
  }
  async function importFile(args, context) {
    const state = await bound(context, args.projectId);
    const purpose = args.purpose || "translation";
    // Older callers may supply an absolute in-workspace translation path.
    const path = isAbsolute(args.path || "") ? relative(state.workspace, await realpath(args.path)) : args.path;
    if (purpose !== "translation") {
      const resource = await parseResource(state.workspace, purpose, path, context);
      if (args.register !== false) await update(context, (config) => ({ ...config, [fields[purpose]]: [...new Set([...config[fields[purpose]], resource.path])] }));
      const { parsed, ...metadata } = resource;
      return { ...metadata, registered: args.register !== false, characters: parsed.characters || 0, count: parsed.candidates?.length || parsed.chunks?.length || 0, preview: parsed.text || (parsed.candidates || parsed.chunks || []).slice(0, 5), taskScoped: true };
    }
    const source = await readSource(state.workspace, path, context);
    const resources = await snapshot(state, args.resources || {}, context);
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
    const file = await open(destination, "wx");
    try { await file.writeFile(Buffer.from(value.base64, "base64")); } finally { await file.close(); }
    return { path: destination, relativePath: path, filename: basename(path), bytes: (await stat(destination)).size };
  }
  return { workspace, bound, snapshot, importFile, saveExport };
}

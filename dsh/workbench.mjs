import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { createWorkspaceFiles, workspaceRoot } from "./workspace-files.mjs";
import { configureRuntime, runtimeOptions, withRuntimeCall } from "../src/runtime-context.mjs";
import { SqliteStore } from "../src/sqlite-store.mjs";

const HUMAN_ACTION = /\/feedback\/accept$|\/term-import\/commit$|\/assets-import\/commit$|\/(?:activate|rollback|approve|accept|apply)$|\/qa\/resolve$/;

export function assertOperation({ method = "GET", path }, human = false) {
  if (!/^(GET|POST|PATCH|DELETE)$/.test(method)) throw new Error("Unsupported operation method");
  const url = new URL(path, "http://local.invalid");
  if (url.origin !== "http://local.invalid" || !url.pathname.startsWith("/api/") || path.includes("..")) throw new Error("Only workbench operations are allowed");
  if (/^\/api\/(?:provider|logs|workbench-session)/.test(url.pathname) && method !== "GET") throw new Error("Use DSH to configure models and runtime");
  if (!human && method !== "GET" && (HUMAN_ACTION.test(url.pathname) || method === "DELETE")) throw new Error("This operation requires a human action in the workbench");
  if (!human && method !== "GET" && !/^\/api\/(?:projects$|batch\/(?:prepare|run|export)(?:\/|$)|auto-qa$|translate$|classify$|match$|(?:term|tm|assets)-import\/preview$|style-profiles\/distill$|learning\/(?:skills\/generate|skills\/[^/]+\/evaluate|conflict-scan)$)/.test(url.pathname)) throw new Error("This operation requires a human action in the workbench");
  return url;
}

export async function createWorkbench({ dataDirectory, modelAdapter }) {
  const store = new SqliteStore(join(dataDirectory, "kami.sqlite"));
  configureRuntime({ embedded: true, dataDirectory, store, modelAdapter, dispatch: (operation) => invoke(operation, { ...runtimeOptions(), human: true }) });
  let application;
  try { application = await import("../server.mjs"); }
  catch (error) { store.close(); throw error; }
  let closed = false;
  const files = createWorkspaceFiles({ dataDirectory, invoke });
  async function invoke(operation, context = {}) {
    if (closed) throw new Error("Workbench is stopped");
    const method = operation.method || "GET";
    const url = assertOperation({ ...operation, method }, context.human);
    context.signal?.throwIfAborted();
    const body = { ...operation.body };
    const batchId = body.batchId || /^\/api\/(?:batch\/run|qa\/batch|tasks)\/([^/]+)/u.exec(url.pathname)?.[1];
    const savedRun = batchId ? await withRuntimeCall({ workspaceSnapshot: null }, () => application.getBatchRunForWorkspace(batchId)) : null;
    if (batchId && !savedRun && url.pathname === "/api/auto-qa") throw Object.assign(new Error("未找到这条翻译批次"), { statusCode: 404 });
    if (savedRun?.runnerOptions?.workspaceSnapshot) {
      const snapshot = savedRun.runnerOptions.workspaceSnapshot;
      if (context.cwd && await workspaceRoot(context) !== snapshot.workspace) throw new Error("该任务属于另一个工作区，请切换回原工作区");
      if (body.projectId && body.projectId !== savedRun.projectId) throw new Error("任务与项目不匹配");
      context = { ...context, workspaceSnapshot: snapshot };
      if (body.runnerOptions) body.runnerOptions = { ...body.runnerOptions, workspaceSnapshot: snapshot, originalFile: savedRun.runnerOptions.originalFile, originalBytes: savedRun.runnerOptions.originalBytes };
      if (url.pathname === "/api/batch/export") Object.assign(body, { ...savedRun, ...body, segments: body.segments || savedRun.segments, structure: savedRun.structure });
      delete body.base64;
    }
    if (!context.workspaceSnapshot && context.cwd && context.fs && method === "POST" && /^\/api\/(?:translate|auto-qa)$/u.test(url.pathname)) {
      const state = await files.bound(context, body.projectId);
      context = { ...context, workspaceSnapshot: await withRuntimeCall(context, () => files.snapshot(state, body.resources || {}, context, body.resourceContext)) };
    }
    const projectId = body.projectId || url.searchParams.get("projectId");
    if (projectId && /^\/api\/(?:learning|quality)(?:\/|$)/u.test(url.pathname)) {
      const project = body.project || url.searchParams.get("project");
      if (project && project !== projectId) throw new Error("Conflicting project scope");
      if (method === "GET") url.searchParams.set("project", projectId);
      else body.project = projectId;
    }
    const bytes = operation.base64 ? Buffer.from(operation.base64, "base64") : Buffer.from(JSON.stringify(body));
    const request = Readable.from([bytes]);
    request.method = method;
    request.url = url.pathname + url.search;
    request.headers = { host: "local.invalid", "content-type": operation.base64 ? "application/octet-stream" : "application/json", ...operation.headers };
    const response = new EventEmitter();
    const chunks = [];
    let status = 200;
    let headers = {};
    response.writeHead = (code, values = {}) => { status = code; headers = values; return response; };
    response.setHeader = (key, value) => { headers[key.toLowerCase()] = value; };
    response.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
    response.end = (chunk) => { if (chunk) chunks.push(Buffer.from(chunk)); response.writableEnded = true; response.emit("finish"); };
    response.destroy = () => response.emit("close");
    const currentWorkspace = context.cwd && context.fs ? await workspaceRoot(context) : undefined;
    return withRuntimeCall({ modelRoute: context.modelRoute, signal: context.signal, workspaceSnapshot: context.workspaceSnapshot, fileInput: context.fileInput, originalFile: context.originalFile, workspaceRoot: currentWorkspace }, async () => {
      try {
        const handled = await application.apiHandler(request, response, url);
        if (handled === false) throw Object.assign(new Error("Workbench operation not found"), { statusCode: 404 });
      } catch (error) { status = error.statusCode || 500; chunks.length = 0; chunks.push(Buffer.from(JSON.stringify({ error: error.message }))); }
      const buffer = Buffer.concat(chunks);
      const json = String(headers["content-type"] || "").includes("json") || /^[\s]*[\[{]/.test(buffer.toString("utf8", 0, 20));
      let value = json ? JSON.parse(buffer.toString() || "null") : { base64: buffer.toString("base64"), contentType: headers["content-type"], disposition: headers["content-disposition"] };
      if (status >= 400) throw Object.assign(new Error(value?.error || `Operation failed (${status})`), { statusCode: status });
      // Parsed resource bodies remain in the Host/database; callers receive provenance only.
      if (value && typeof value === "object") value = JSON.parse(JSON.stringify(value, (key, item) => key === "workspaceSnapshot" && item ? { id: item.id, workspace: item.workspace, projectId: item.projectId, source: item.source, resources: item.resources, createdAt: item.createdAt, outputDirectory: item.outputDirectory } : item));
      return value;
    });
  };
  return {
    store, invoke,
    workspace: files.workspace,
    importFile: (args, context) => withRuntimeCall(context, () => files.importFile(args, context)),
    async perform(operation, context) {
      if (operation.expectedWorkspace && await workspaceRoot(context) !== operation.expectedWorkspace) throw new Error("工作区已切换，请刷新页面后重试");
      if (operation.expectedWorkspace && operation.path?.startsWith("/api/") && operation.action !== "file") {
        const projectId = operation.body?.projectId || new URL(operation.path, "http://local.invalid").searchParams.get("projectId");
        if (projectId) await files.bound(context, projectId);
      }
      if (operation.action === "backup") return this.backup();
      if (operation.action === "workspace") return files.workspace({ ...operation, action: operation.actionType || "status" }, context);
      if (operation.action === "file") return this.importFile(operation, context);
      if (operation.action === "export") {
        const value = await invoke({ path: "/api/batch/export", method: "POST", body: operation }, context);
        return files.saveExport(value, value.filename, context, operation.outputPath);
      }
      return invoke(operation, context);
    },
    async backup() {
      const directory = join(dataDirectory, "backups");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `kami-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
      await store.backup(path);
      return { path };
    },
    async saveExport(value, filename = value.filename || "translation.bin", context, outputPath) {
      if (context?.cwd) return files.saveExport(value, filename, context, outputPath);
      if (!value?.base64) throw new Error("Export did not return a file");
      const directory = join(dataDirectory, "exports");
      await mkdir(directory, { recursive: true });
      const path = join(directory, filename.replace(/[^\p{L}\p{N}_.-]/gu, "_"));
      await writeFile(path, Buffer.from(value.base64, "base64"));
      return { path };
    },
    async close() {
      if (closed) return;
      closed = true;
      await application.disposeEmbeddedWorkbench();
      store.close();
    }
  };
}

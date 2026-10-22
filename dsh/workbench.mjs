import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { join, resolve, isAbsolute, relative } from "node:path";
import { readFile, writeFile, mkdir, realpath, stat } from "node:fs/promises";
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
  async function invoke(operation, context = {}) {
    if (closed) throw new Error("Workbench is stopped");
    const method = operation.method || "GET";
    const url = assertOperation({ ...operation, method }, context.human);
    context.signal?.throwIfAborted();
    const body = { ...operation.body };
    const projectId = body.projectId || url.searchParams.get("projectId");
    if (projectId && url.pathname.startsWith("/api/learning")) {
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
    return withRuntimeCall({ modelRoute: context.modelRoute, signal: context.signal }, async () => {
      try {
        const handled = await application.apiHandler(request, response, url);
        if (handled === false) throw Object.assign(new Error("Workbench operation not found"), { statusCode: 404 });
      } catch (error) { status = error.statusCode || 500; chunks.length = 0; chunks.push(Buffer.from(JSON.stringify({ error: error.message }))); }
      const buffer = Buffer.concat(chunks);
      const json = String(headers["content-type"] || "").includes("json") || /^[\s]*[\[{]/.test(buffer.toString("utf8", 0, 20));
      const value = json ? JSON.parse(buffer.toString() || "null") : { base64: buffer.toString("base64"), contentType: headers["content-type"], disposition: headers["content-disposition"] };
      if (status >= 400) throw Object.assign(new Error(value?.error || `Operation failed (${status})`), { statusCode: status });
      return value;
    });
  };
  return {
    store, invoke,
    async importFile({ filename, path, projectId }, context) {
      if (!context.cwd) throw new Error("File must be inside the current workspace");
      const workspace = await realpath(context.cwd);
      const absolute = await realpath(resolve(workspace, path));
      if (!workspace || relative(workspace, absolute).startsWith("..") || isAbsolute(relative(workspace, absolute))) throw new Error("File must be inside the current workspace");
      if ((await stat(absolute)).size > 20 * 1024 * 1024) throw new Error("File exceeds 20 MB");
      const bytes = await readFile(absolute);
      if (bytes.length > 20 * 1024 * 1024) throw new Error("File exceeds 20 MB");
      return invoke({ method: "POST", path: "/api/batch/prepare", body: { filename: filename || absolute.split(/[\\/]/).at(-1), base64: bytes.toString("base64"), projectId, locale: "zh-CN" } }, context);
    },
    async backup() {
      const directory = join(dataDirectory, "backups");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `kami-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
      await store.backup(path);
      return { path };
    },
    async saveExport(value, filename = value.filename || "translation.bin") {
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

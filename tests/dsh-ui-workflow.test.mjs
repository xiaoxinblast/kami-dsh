import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("UI controller uses Host paths, waits for a paused worker, preserves edits and exports without overwriting", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-ui-workflow-"));
  const cwd = join(directory, "工作区"), dataDirectory = join(directory, "data");
  const { fs, close } = await workspaceFs();
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const modelCalls = [];
  const workbench = await createWorkbench({ dataDirectory, modelAdapter: async (_messages, options) => {
    modelCalls.push(options.requestLabel);
    if (modelCalls.length === 1) { entered(); await gate; }
    return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : "保存设置。" };
  } });
  const context = { human: true, cwd, fs, isKamiSession: true, signal: new AbortController().signal };
  const call = (operation) => workbench.perform(operation, context);
  try {
    await mkdir(cwd);
    await writeFile(join(cwd, "原文.txt"), "設定を保存します。\n設定を開きます。");
    await writeFile(join(cwd, "指南.md"), "保持简洁。");
    const state = await call({ action: "workspace", actionType: "bind", name: "界面回归" });
    const projectId = state.config.projectId;
    await call({ action: "file", path: "指南.md", purpose: "style-guide" });
    const factories = new Map();
    vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
      window: { __ModuleLoader__: { load: ({ id, chunk, factory }) => factories.set(chunk ? `${id}/${chunk}` : id, factory) } }, URLSearchParams, Date, Map, Set, Number, Error, Promise
    });
    const { WorkbenchModel, editingLocked, qaLabel } = factories.get("kami-dsh/client.workbench-state.js")();
    const model = new WorkbenchModel({ sessionId: "kami", call: async (session, operation) => { assert.equal(session, "kami"); return call(operation); } });
    await model.refresh();
    const prepared = await model.request({ action: "file", path: "原文.txt", purpose: "translation", resources: { styleGuides: ["指南.md"] } });
    await model.refresh(); await model.select(prepared.batchId);
    const batchId = prepared.batchId;
    const originalHash = model.view.run.runnerOptions.workspaceSnapshot.source.hash;
    await model.invoke(`/api/batch/run/${batchId}/start`, "POST", model.body());
    await started;
    const pause = await model.invoke(`/api/batch/run/${batchId}/pause`, "POST", model.body());
    assert.equal(pause.waitingForCurrentSegment, true);
    await model.loadRun();
    assert.equal(model.view.run.workflow.writeBusy, true);
    assert.equal(editingLocked(model.view.run), true);
    assert.equal(model.edit(model.view.run.segments[0].id, "不应写入"), false);
    await assert.rejects(model.invoke("/api/batch/run", "POST", model.body({ batchId, segments: model.view.run.segments })), /尚未结束/);
    release();
    const deadline = Date.now() + 5000;
    do { await new Promise((resolve) => setTimeout(resolve, 15)); await model.loadRun(); } while (model.view.run.workflow.writeBusy && Date.now() < deadline);
    assert.equal(model.view.run.workflow.writeBusy, false);
    const segment = model.view.run.segments[0];
    model.edit(segment.id, "保存设置。人工终稿。");
    await model.refresh();
    assert.equal(model.displayRun().segments[0].translation, "保存设置。人工终稿。");
    assert.equal((await model.save()).ok, true);
    assert.equal(model.view.run.runnerOptions.workspaceSnapshot.source.hash, originalHash);
    assert.equal(qaLabel(model.view.run.segments[0]), "尚未执行 QA", "editing must invalidate the previous QA claim");
    const exported = await model.request({ action: "export", batchId, projectId, mode: "writeback", outputPath: "outputs/终稿.txt" });
    assert.match(await readFile(exported.path, "utf8"), /人工终稿/);
    await assert.rejects(model.request({ action: "export", batchId, projectId, mode: "writeback", outputPath: "outputs/终稿.txt" }), /EEXIST|已存在/);
    assert.equal(await readFile(join(cwd, "原文.txt"), "utf8"), "設定を保存します。\n設定を開きます。");
    const assets = await model.invoke(model.path("/api/library-entries", { kind: "term" }));
    assert.equal(assets.total, 0, "workspace references must not become canonical assets");
  } finally {
    release(); await workbench.close(); await close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-ui-workflow-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("folded-sheet icon bytes and Client artwork stay aligned", async () => {
  const [svg, client] = await Promise.all([readFile(new URL("../dsh/icon.svg", import.meta.url), "utf8"), readFile(new URL("../dsh/client.js", import.meta.url), "utf8")]);
  const { SaxesParser } = await import("saxes");
  const parser = new SaxesParser({ xmlns: true });
  const paths = [];
  parser.on("opentag", (node) => { if (node.local === "path") paths.push(node.attributes.d.value); });
  parser.write(svg).close();
  assert.equal(paths.length, 5);
  for (const path of paths) assert.ok(client.includes(path));
  assert.ok(Buffer.byteLength(svg) < 256 * 1024);
});

test("real DSH Client loader loads and invalidates both the entry and its owned state chunk", { skip: !process.env.DSH_TEST_CLIENT_MODULE }, async () => {
  let sdk;
  const context = vm.createContext({ window: { __ModuleLoader__: { load: ({ factory }) => { sdk = factory(); } } } });
  vm.runInContext(await readFile(new URL(process.env.DSH_TEST_CLIENT_MODULE), "utf8"), context);
  const target = { mode: "queue", pendingQueue: [] };
  const loader = new sdk.ClientModuleSystem({ manifest: { rev: "test", modules: [], plugins: [] }, staticModules: { react: {} }, registrationTarget: target, bootstrapModule: { id: "bootstrap", exports: {} } });
  context.window.__ModuleLoader__ = target;
  const client = await readFile(new URL("../dsh/client.js", import.meta.url), "utf8");
  vm.runInContext(client, context);
  assert.equal(typeof (await loader.import("kami-dsh")).apply, "function");
  const first = await loader.import("kami-dsh/client.workbench-state.js");
  assert.equal(typeof first.WorkbenchModel, "function");
  loader.invalidate("kami-dsh");
  assert.equal(loader.factories.has("kami-dsh/client.workbench-state.js"), false, "updating the entry must clear its state chunk too");
  vm.runInContext(client, context);
  assert.notEqual((await loader.import("kami-dsh/client.workbench-state.js")).WorkbenchModel, first.WorkbenchModel);
  assert.equal(typeof (await loader.import("kami-dsh")).apply, "function");
});

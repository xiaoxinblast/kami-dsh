import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("DSH page requests use a direct Remote instead of recording slash commands", async () => {
  let plugin, props, descriptor;
  const calls = [], prompts = [];
  const remote = {
    session: { async prompt(args) { prompts.push(args); return { ok: true, value: {} }; } },
    async $mount(contribution) { descriptor = contribution.descriptors[0]; return () => {}; },
    kamiUi: { async invoke(...args) { calls.push(args); return { ok: true, value: { projects: [] } }; } },
    commands: { execute() { assert.fail("Page reads must not append command events"); } }
  };
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: (module) => { plugin = module.factory(() => ({})); } } }, crypto: { randomUUID: () => "request-id" }
  });
  await plugin.apply({
    inject(_keys, callback) { return callback(this); },
    remote, effect: (callback) => callback(), locale: { register() {} },
    slots: { inject: (_name, callback) => callback(), register: (options) => { if (options.name === "main") props = options.inject(); } }
  });
  assert.deepEqual(await props.call("working-session", { path: "/api/projects" }), { projects: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "working-session");
  assert.equal(calls[0][1].path, "/api/projects");
  assert.equal(descriptor.namespace, "kamiUi");
  assert.equal(descriptor.parameters[0].wire, "agentId");
  remote.kamiUi.invoke = async () => ({ ok: false, error: { message: "Request failed" } });
  await assert.rejects(props.call("working-session", { path: "/api/projects" }), /Request failed/);
  remote.kamiUi.invoke = async () => ({ ok: true, value: { isKamiSession: false, workspace: "project" } });
  await assert.rejects(props.prompt("working-session", "翻译任务", "project"), /不匹配/);
  remote.kamiUi.invoke = async () => ({ ok: true, value: { isKamiSession: true, workspace: "other" } });
  await assert.rejects(props.prompt("working-session", "翻译任务", "project"), /不匹配/);
  assert.equal(prompts.length, 0, "must not send to unrelated working sessions");
  remote.kamiUi.invoke = async () => ({ ok: true, value: { isKamiSession: true, workspace: "project" } });
  await props.prompt("kami-session", "翻译任务", "project");
  assert.equal(prompts[0].sessionId, "kami-session");
});

test("installed DSH Client and Host keep workbench reads and human imports out of the associated session log", { skip: !process.env.DSH_TEST_LLM_MODULE, timeout: 10000 }, async () => {
  const sdk = process.env.DSH_TEST_LLM_MODULE;
  const [{ Context }, { default: Registry }, { default: Gateway }, clientGateway, bridge] = await Promise.all([
    import(new URL("../../cordis/lib/index.js", sdk)),
    import(new URL("../../dsh-typert-registry/lib/index.js", sdk)),
    import(new URL("../../dsh-api-gateway/lib/index.js", sdk)),
    import(new URL("../../dsh-api-gateway/lib/client.node.js", sdk)),
    readFile(new URL("../dsh/ui-bridge.mjs", import.meta.url), "utf8").then((source) => import(`data:text/javascript,${encodeURIComponent(source.replace('"@deepseek-ai/dsh-typert-protocol"', JSON.stringify(new URL("../../dsh-typert-protocol/lib/index.js", sdk).href)))}`))
  ]);
  const directory = await mkdtemp(join(tmpdir(), "kami-dsh-ui-"));
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data") });
  const { fs, close } = await workspaceFs();
  const root = new Context();
  const events = [], contexts = [];
  const agent = { status: "running", session: { header: { cwd: directory }, append: (...args) => events.push(args) } };
  const peer = { principal: { kind: "owner" }, signal: new AbortController().signal };
  root.reflect.provide("remoteAccess", { decide: () => ({ kind: "deny", reason: "test" }) });
  root.reflect.provide("connection", { interactions: "none", rpc: {
    open() { assert.fail("Unary calls do not need a stream"); },
    call: (_prefix, endpoint, payload, signal) => root.get("typertGateway").dispatchRpc(endpoint, payload, signal, peer)
  } });
  root.plugin(Registry, {});
  root.plugin(Gateway, {});
  root.plugin(clientGateway, {});
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  root.plugin({ inject: ["typert"], apply(ctx) {
    try {
      ctx.reflect.provide("kamiWorkbench", { ready: Promise.resolve(workbench), contextFor: (receiver, signal, human) => {
        assert.equal(receiver, agent);
        const context = { human, signal, cwd: receiver.session.header.cwd, fs, modelRoute: { model: "associated-model" } };
        contexts.push(context);
        return context;
      } });
      ctx.typert.lookups.register("agent", { parameter: "agent", wire: "agentId", resource: "session", hostTypeSymbol: "@deepseek-ai/dsh-agent#Agent", wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId", resolve: (id) => id === "working-session" ? agent : undefined });
      ctx.plugin(bridge.KamiUiService);
      ctx.typert.register(bridge.TYPERT);
    } catch (error) { rejectReady(error); }
  } });
  root.plugin({ inject: ["typertGateway", "kamiUi", "remote"], async apply(ctx) {
    try {
      assert.ok(ctx.get("kamiUi"), "Kami UI Service must be available before Gateway invocation");
      let plugin, props;
      vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
        window: { __ModuleLoader__: { load: (module) => { plugin = module.factory(() => ({})); } } }
      });
      await plugin.apply({
        inject(keys, callback) { return ctx.inject(keys, (child) => callback({ ...this, remote: child.remote })); },
        remote: ctx.remote, effect: (callback) => ctx.effect(callback), locale: { register() {} },
        slots: { inject: (_name, callback) => callback(), register: (options) => { if (options.name === "main") props = options.inject(); } }
      });
      const invoke = (operation, agentId = "working-session") => props.call(agentId, operation);
      const project = (await invoke({ method: "POST", path: "/api/projects", body: { name: "隔离验收项目" } })).project;
      for (let i = 0; i < 12; i++) assert.equal((await invoke({ path: "/api/projects" })).projects[0].id, project.id);
      const imported = await invoke({ method: "POST", path: "/api/style-guides/import", body: { projectId: project.id, filename: "界面验收.md", base64: Buffer.from("译文保持简洁。").toString("base64") } });
      assert.equal(imported.profile.projectId, project.id);
      const profiles = await invoke({ path: `/api/style-profiles?projectId=${project.id}&locale=zh-CN` });
      assert.equal(profiles.userProfiles.find((profile) => profile.id === imported.profile.id).status, "active");
      const state = await invoke({ action: "workspace", actionType: "bind", projectId: project.id });
      assert.equal(state.project.id, project.id);
      await mkdir(join(directory, "rules"));
      await writeFile(join(directory, "rules/style.md"), "工作区指南保持完整，不启用项目旧指南版本。");
      const resource = await invoke({ action: "file", path: "rules/style.md", purpose: "style-guide", expectedWorkspace: state.workspace });
      assert.equal(resource.taskScoped, true);
      assert.match(resource.preview, /工作区指南保持完整/);
      assert.equal(resource.base64, undefined);
      const after = await invoke({ path: `/api/style-profiles?projectId=${project.id}&locale=zh-CN` });
      assert.equal(after.userProfiles.length, 1, "file reference must not create a project profile");
      const other = join(directory, "other");
      await mkdir(other);
      agent.session.header.cwd = other;
      assert.equal((await invoke({ action: "workspace" })).bound, false);
      await assert.rejects(invoke({ action: "file", path: "rules/style.md", purpose: "style-guide", expectedWorkspace: state.workspace }), /已切换/);
      assert.ok(contexts.every((context) => context.human && context.modelRoute.model === "associated-model"));
      assert.equal(events.length, 0, "UI reads and uploads must not write command/run or command/done");
      assert.equal(agent.status, "running");
      await assert.rejects(invoke({ path: "/api/projects" }, "missing-session"), /lookup|resolve|found/);
      await assert.rejects(invoke({ path: "https://example.com/api/projects" }), /workbench operations/);
      resolveReady();
    } catch (error) { rejectReady(error); }
  } });
  try { await ready; } finally { await root.fiber.dispose(); await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

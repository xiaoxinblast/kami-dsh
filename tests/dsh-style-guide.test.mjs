import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

async function mountClient(call) {
  const hooks = [], effects = [];
  let cursor = 0, dirty = true, component, tree, plugin, pending = 0;
  const React = {
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value) => { if (!Object.is(hooks[index], value)) { hooks[index] = value; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!hooks[index] || dependencies.some((value, i) => !Object.is(value, hooks[index][i]))) effects.push(callback);
      hooks[index] = dependencies;
    }
  };
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: (module) => { plugin = module.factory(() => React); } } },
    URLSearchParams, setInterval: () => 1, clearInterval() {}
  });
  await plugin.apply({
    inject(_keys, callback) { return callback(this); },
    effect: (callback) => callback(), locale: { register() {} }, remote: { async $mount() { return () => {}; } },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_name, callback) => callback(), register: (options, value) => { if (options.name === "sidebar.right.pane.tab") component = value; } }
  });
  const props = { sessionId: "session", useTabInfo: () => ({ tab: { visible: true } }), call: async (...args) => { pending++; try { return await call(...args); } finally { pending--; } }, useSessions: (select) => select({ byId: { session: { projectionValues: { agentPreset: "kami-translator" } } } }) };
  const nodes = (node) => node && typeof node === "object" ? [node, ...node.children.flatMap(nodes)] : [];
  const text = (node) => node && typeof node === "object" ? node.children.map(text).join("") : typeof node === "string" ? node : "";
  return {
    async flush() {
      for (let round = 0; round < 300; round++) {
        if (dirty) { dirty = false; cursor = 0; tree = component(props); if (typeof tree?.type === "function") tree = tree.type(tree.props); }
        for (const callback of effects.splice(0)) callback();
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (!dirty && !effects.length && !pending) return;
      }
      throw new Error("Client did not settle");
    },
    find(type, match) {
      const found = nodes(tree).find((node) => node.type === type && (typeof match === "function" ? match(node) : text(node) === match));
      assert.ok(found, `Missing ${type}: ${match}`);
      return found;
    },
    nodes: () => nodes(tree),
    text: () => text(tree)
  };
}

test("workspace guide UI uses paths, preserves legacy guides, and renders every tab without browser upload APIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-dsh-guide-"));
  const workspace = join(directory, "workspace");
  const { fs, close } = await workspaceFs();
  const calls = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data") });
  const context = { human: true, cwd: workspace, fs, isKamiSession: true };
  try {
    await mkdir(join(workspace, "rules"), { recursive: true });
    await writeFile(join(workspace, "rules/style.md"), "工作区指南：译文保持简洁。末尾校验。");
    const state = await workbench.workspace({ action: "bind", name: "界面验收" }, context);
    const projectId = state.project.id;
    await workbench.invoke({ method: "POST", path: "/api/style-guides/import", body: { projectId, filename: "旧指南.txt", base64: Buffer.from("旧版规则。").toString("base64") } }, context);
    const client = await mountClient(async (_session, operation) => { calls.push(operation); return workbench.perform(operation, context); });
    await client.flush();
    assert.match(client.text(), /已绑定：界面验收/);
    assert.equal(client.find("button", "发送给翻译 agent").props.disabled, false);
    client.find("button", "风格指南").props.onClick();
    await client.flush();
    assert.match(client.text(), /旧版规则/);
    assert.equal(client.nodes().filter((node) => node.type === "input" && node.props.type === "file").length, 0);
    const input = client.find("input", (node) => node.props["aria-label"] === "工作区风格指南路径");
    input.props.onChange({ target: { value: "rules/style.md" } });
    await client.flush();
    assert.equal(calls.some((operation) => operation.action === "file"), false, "typing a path must not read or associate it");
    await client.find("button", "预览并关联").props.onClick();
    await client.flush();
    const file = calls.find((operation) => operation.action === "file");
    assert.equal(file.path, "rules/style.md"); assert.equal(file.purpose, "style-guide");
    assert.equal(file.base64, undefined);
    assert.match(client.text(), /工作区指南：译文保持简洁。末尾校验/);
    const profiles = await workbench.invoke({ path: `/api/style-profiles?projectId=${projectId}&locale=zh-CN` }, context);
    assert.equal(profiles.userProfiles.length, 1);
    assert.equal(profiles.userProfiles[0].status, "active", "workspace guide does not rewrite legacy project profile");
    await client.find("button", "解除关联").props.onClick();
    await client.flush();
    assert.equal((await workbench.workspace({}, context)).config.styleGuides.length, 0);
    assert.match(await readFile(join(workspace, "rules/style.md"), "utf8"), /末尾校验/);
    for (const tab of ["翻译", "资产", "审校", "参考资料", "学习", "任务", "设置"]) { client.find("button", tab).props.onClick(); await client.flush(); }
    assert.equal(calls.some((operation) => operation.base64 || operation.body?.base64), false);
  } finally { await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

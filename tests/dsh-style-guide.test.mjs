import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createWorkbench } from "../dsh/workbench.mjs";
import { SqliteStore } from "../src/sqlite-store.mjs";

async function mountClient(call) {
  const hooks = [], effects = [];
  let cursor = 0, dirty = true, component, tree, plugin;
  const React = {
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value) => { if (!Object.is(hooks[index], value)) { hooks[index] = value; dirty = true; } }];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!hooks[index] || dependencies.some((value, i) => !Object.is(value, hooks[index][i]))) effects.push(callback);
      hooks[index] = dependencies;
    }
  };
  class FileReader {
    readAsDataURL(file) { this.result = `data:text/plain;base64,${Buffer.from(file.text).toString("base64")}`; this.onload(); }
  }
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: (module) => { plugin = module.factory(() => React); } } },
    FileReader, URLSearchParams
  });
  await plugin.apply({
    effect: (callback) => callback(), locale: { register() {} }, remote: { async $mount() { return () => {}; } },
    slots: { inject: (_name, callback) => callback(), register: (options, value) => { if (options.name === "main") component = value; } }
  });
  const props = { call, useSessions: (select) => select({ byId: { session: { id: "session", retainedBy: { mainView: 1 } } } }) };
  const nodes = (node) => node && typeof node === "object" ? [node, ...node.children.flatMap(nodes)] : [];
  const text = (node) => node && typeof node === "object" ? node.children.map(text).join("") : typeof node === "string" ? node : "";
  return {
    async flush() {
      for (let round = 0; round < 20; round++) {
        if (dirty) { dirty = false; cursor = 0; tree = component(props); }
        for (const callback of effects.splice(0)) callback();
        await new Promise((resolve) => setImmediate(resolve));
        if (!dirty && !effects.length) return;
      }
      throw new Error("Client did not settle");
    },
    find(type, match) {
      const found = nodes(tree).find((node) => node.type === type && (typeof match === "function" ? match(node) : text(node) === match));
      assert.ok(found, `Missing ${type}: ${match}`);
      return found;
    },
    text: () => text(tree)
  };
}

test("DSH style-guide upload requires confirmation, stays project-scoped and reaches translation prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-dsh-guide-"));
  const messages = [], calls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (input, options) => {
    messages.push(JSON.stringify(input));
    return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : "保存更改。" };
  } });
  const context = { human: true };
  let projectId, profileId;
  try {
    const created = await workbench.invoke({ method: "POST", path: "/api/projects", body: { name: "风格指南验收" } }, context);
    projectId = created.project.id;
    const other = await workbench.invoke({ method: "POST", path: "/api/projects", body: { name: "其他项目" } }, context);
    const body = { projectId, locale: "zh-CN", filename: "旧指南.txt", base64: Buffer.from("旧版规则。").toString("base64") };
    await assert.rejects(workbench.invoke({ method: "POST", path: "/api/style-guides/import", body }), /human/);
    await workbench.invoke({ method: "POST", path: "/api/style-guides/import", body }, context);
    const client = await mountClient(async (_session, operation) => { calls.push(operation); return workbench.invoke(operation, context); });
    await client.flush();
    client.find("select", (node) => node.props["aria-label"] === "请选择项目").props.onChange({ target: { value: projectId } });
    await client.flush();
    client.find("button", "风格指南").props.onClick();
    await client.flush();
    assert.equal(client.find("button", "导入并立即启用").props.disabled, true);
    const fileInput = () => client.find("input", (node) => node.props.type === "file");
    assert.equal(fileInput().props.accept, ".txt,.md,.docx");
    const selectFile = (file) => fileInput().props.onChange({ target: { files: [file], value: file.name } });
    await selectFile({ name: "过大指南.txt", size: 5 * 1024 * 1024 + 1, text: "规则" });
    await client.flush();
    assert.match(client.text(), /5 MB/);
    assert.equal(client.find("button", "导入并立即启用").props.disabled, true);
    await selectFile({ name: "错误格式.pdf", size: 4, text: "规则" });
    await client.flush();
    assert.match(client.text(), /仅支持/);
    const guide = `# 人工验收指南\n${"译文保持简洁。\n".repeat(220)}末尾校验：使用中文弯引号。`;
    const file = { name: "新指南.md", size: Buffer.byteLength(guide), text: guide };
    await selectFile(file);
    await client.flush();
    assert.equal(calls.filter((operation) => operation.method === "POST").length, 0, "选择文件不能立即启用指南");
    assert.equal(client.find("button", "导入并立即启用").props.disabled, false);
    await client.find("button", "导入并立即启用").props.onClick();
    await client.flush();
    const upload = calls.find((operation) => operation.path === "/api/style-guides/import");
    assert.equal(upload.body.projectId, projectId);
    assert.equal(Buffer.from(upload.body.base64, "base64").toString(), guide);
    assert.match(client.text(), /已启用/);
    assert.match(client.text(), /末尾校验：使用中文弯引号。/);
    const profiles = await workbench.invoke({ path: `/api/style-profiles?projectId=${projectId}&locale=zh-CN` }, context);
    assert.equal(profiles.userProfiles.find((item) => item.name === "风格指南 · 旧指南").status, "inactive");
    const current = profiles.userProfiles.find((item) => item.name === "风格指南 · 新指南");
    profileId = current.id;
    assert.equal(current.status, "active");
    await workbench.invoke({ method: "POST", path: "/api/translate", body: { projectId, locale: "zh-CN", source: "変更を保存します。", contentType: "ui", domain: "game", qualityTier: "fast" } }, context);
    assert.ok(messages.some((message) => message.includes("末尾校验：使用中文弯引号。")), "真实翻译提示必须包含人工指南");
    await selectFile({ ...file, name: "待导入.md" });
    await client.flush();
    client.find("select", (node) => node.props["aria-label"] === "请选择项目").props.onChange({ target: { value: other.project.id } });
    await client.flush();
    assert.equal(client.find("button", "导入并立即启用").props.disabled, true);
    assert.doesNotMatch(client.text(), /待导入\.md|末尾校验/);
    const untouched = await workbench.invoke({ path: `/api/style-profiles?projectId=${other.project.id}&locale=zh-CN` }, context);
    assert.equal(untouched.userProfiles.length, 0);
    await workbench.close();
    const reopened = new SqliteStore(join(directory, "kami.sqlite"));
    try {
      const profile = await reopened.request(`/items/user_profiles/${profileId}`);
      assert.equal(profile.project_id, projectId);
      assert.equal(profile.status, "active");
      assert.equal(reopened.integrity()[0].integrity_check, "ok");
    } finally { reopened.close(); }
  } finally { await workbench.close(); await rm(directory, { recursive: true, force: true }); }
});

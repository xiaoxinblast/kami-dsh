import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("workspace guide controller previews and links paths without changing legacy guides or sending browser file bytes", async () => {
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
    const modules = new Map();
    const source = await readFile(new URL("../dsh/client.js", import.meta.url), "utf8");
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load: ({ id, chunk, factory }) => modules.set(chunk ? `${id}/${chunk}` : id, factory) } }, URLSearchParams
    });
    const { WorkbenchModel } = modules.get("kami-dsh/client.workbench-state.js")();
    const model = new WorkbenchModel({ sessionId: "session", call: async (_session, operation) => { calls.push(operation); return workbench.perform(operation, context); } });
    await model.refresh();
    assert.equal(model.workspace.project.name, "界面验收");
    assert.doesNotMatch(source, /FileReader|type:\s*["']file["']|agentInstruction/);
    await model.loadSection("preview", (token) => model.request({ action: "file", path: "rules/style.md", purpose: "style-guide", register: false }, token));
    assert.match(model.view.sections.preview.preview, /工作区指南：译文保持简洁。末尾校验/);
    assert.equal((await workbench.workspace({}, context)).config.styleGuides.length, 0, "preview must not link the file");
    await model.perform("link", async (token) => {
      await model.request({ action: "file", path: "rules/style.md", purpose: "style-guide" }, token);
      await model.refresh();
    });
    assert.deepEqual([...model.workspace.config.styleGuides], ["rules/style.md"]);
    const profiles = await model.invoke(model.path("/api/style-profiles"));
    assert.equal(profiles.userProfiles.length, 1);
    assert.equal(profiles.userProfiles[0].status, "active", "workspace guide does not rewrite legacy project profile");
    assert.equal(profiles.userProfiles[0].instruction, "旧版规则。");
    await model.perform("unlink", async (token) => {
      await model.request({ action: "workspace", actionType: "configure", resources: { styleGuides: [] } }, token);
      await model.refresh();
    });
    assert.equal(model.workspace.config.styleGuides.length, 0);
    assert.match(await readFile(join(workspace, "rules/style.md"), "utf8"), /末尾校验/);
    assert.equal(calls.some((operation) => operation.base64 || operation.body?.base64), false);
  } finally {
    await workbench.close(); await close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-dsh-guide-")));
    await rm(directory, { recursive: true, force: true });
  }
});

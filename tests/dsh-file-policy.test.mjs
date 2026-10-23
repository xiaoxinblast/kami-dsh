import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceFiles } from "../dsh/workspace-files.mjs";

test("real DSH sandbox uses the session file policy for config and binary export, and honors read-only", { skip: !process.env.DSH_TEST_LLM_MODULE }, async () => {
  const sdk = process.env.DSH_TEST_LLM_MODULE;
  const [{ Context }, { default: SandboxPolicy }, { default: SandboxedFileSystem }] = await Promise.all([
    import(new URL("../../cordis/lib/index.js", sdk)),
    import(new URL("../../dsh-sandbox-policy/lib/index.js", sdk)),
    import(new URL("../../dsh-fs-sandbox/lib/index.js", sdk))
  ]);
  // Outside the OS temp tree, which the real DSH sandbox always permits for workspace writes.
  const cache = fileURLToPath(new URL("../.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "file-policy-"));
  const workspace = join(directory, "workspace"), fallback = join(directory, "deployment-root");
  await mkdir(workspace); await mkdir(fallback);
  const ctx = new Context();
  ctx.reflect.provide("sessionProjections", { register() {}, stateOf: (session) => session.mode || null });
  const policy = new SandboxPolicy(ctx, { mode: "workspace-write", workspaceRoot: fallback });
  const fs = new SandboxedFileSystem(ctx, { cwd: fallback, diffBasisMaxBytes: 1024 * 1024 });
  const context = { cwd: workspace, fs, signal: new AbortController().signal };
  const project = { id: "test-project", name: "test" };
  let creates = 0;
  const files = createWorkspaceFiles({ dataDirectory: directory, invoke: async (operation) => {
    if (operation.method === "POST") { creates++; return { project }; }
    return { projects: [project] };
  } });
  try {
    await assert.rejects(files.workspace({ action: "bind", projectId: project.id }, context), /workspace-write/);
    await assert.rejects(access(join(workspace, ".kami")), /ENOENT/, "denied writes must not create parent folders");
    const session = { id: "test-session", header: { cwd: workspace } };
    const allowed = { ...context, filePolicy: policy.resolve({ session }) };
    const bound = await files.workspace({ action: "bind", projectId: project.id }, allowed);
    assert.equal(bound.project.id, project.id);
    assert.equal(JSON.parse(await readFile(join(workspace, ".kami/project.json"), "utf8")).projectId, project.id);
    const readonly = { ...context, filePolicy: policy.resolve({ session: { ...session, mode: "read-only" } }) };
    await assert.rejects(files.workspace({ action: "bind", name: "must-not-create" }, readonly), /read-only/);
    assert.equal(creates, 0);
    await assert.rejects(files.workspace({ action: "configure", resources: { outputDirectory: "blocked" } }, readonly), /read-only/);
    await assert.rejects(files.saveExport({ base64: "eA==", filename: "x.bin" }, "x.bin", readonly, "blocked/x.bin"), /read-only/);
    await assert.rejects(access(join(workspace, "blocked")), /ENOENT/);
    await assert.rejects(files.saveExport({ base64: "eA==", filename: "x.bin" }, "x.bin", context), /workspace-write/);
    const exported = await files.saveExport({ base64: "AAEC/w==", filename: "x.bin" }, "x.bin", allowed);
    assert.deepEqual([...await readFile(exported.path)], [0, 1, 2, 255]);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

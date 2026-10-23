import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("Host context follows workingDirectory and the composed preset rather than the session header", { skip: !process.env.DSH_TEST_LLM_MODULE }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-session-context-"));
  const { fs, close } = await workspaceFs();
  const sdk = process.env.DSH_TEST_LLM_MODULE;
  const entry = new URL("../dsh/index.mjs", import.meta.url);
  let source = await readFile(entry, "utf8");
  source = source.replace(/from "(\.[^"]+)"/gu, (_, path) => `from ${JSON.stringify(new URL(path, entry).href)}`)
    .replace('"@deepseek-ai/dsh-home-paths"', JSON.stringify(`data:text/javascript,${encodeURIComponent(`export const resolveDshHome = () => ${JSON.stringify(directory)};`)}`))
    .replace('"@deepseek-ai/dsh-llm"', JSON.stringify(sdk));
  // ui-bridge imports the real Host SDK through an absolute test module URL.
  const bridge = await readFile(new URL("../dsh/ui-bridge.mjs", import.meta.url), "utf8");
  source = source.replace(JSON.stringify(new URL("../dsh/ui-bridge.mjs", import.meta.url).href), JSON.stringify(`data:text/javascript,${encodeURIComponent(bridge.replace('"@deepseek-ai/dsh-typert-protocol"', JSON.stringify(new URL("../../dsh-typert-protocol/lib/index.js", sdk).href)))}`));
  const host = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const first = join(directory, "first"), second = join(directory, "second");
  await mkdir(first); await mkdir(second);
  let cwd = first, preset = "standard", service;
  const cleanups = [];
  const ctx = {
    fs, llm: {}, sessionProjections: { stateOf: () => null }, agentDefaultModel: { currentSelection: () => ({ provider: "test", model: "test" }) }, workingDirectory: { get: () => cwd }, agentPresets: { composedPreset: () => preset },
    reflect: { provide(_name, value) { service = value; } }, commands: { register: () => () => {} },
    plugin() {}, typert: { register() {} }, effect(callback) { const cleanup = callback(); if (typeof cleanup === "function") cleanups.push(cleanup); }
  };
  try {
    await host.apply(ctx);
    const agent = { ctx: {}, session: { header: { id: "session", cwd: first }, requestHeader: () => null } };
    const initial = service.contextFor(agent);
    assert.equal(initial.cwd, first); assert.equal(initial.isKamiSession, false);
    const workbench = await service.ready;
    await workbench.workspace({ action: "bind", name: "first-only" }, initial);
    cwd = second; preset = "kami-translator";
    const next = service.contextFor(agent);
    assert.equal(next.cwd, second); assert.equal(next.isKamiSession, true);
    assert.equal(agent.session.header.cwd, first);
    assert.equal((await workbench.workspace({}, next)).bound, false);
    cwd = join(directory, "missing");
    await assert.rejects(workbench.workspace({}, service.contextFor(agent)), /不存在|FS_NOT_FOUND/);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await close(); await rm(directory, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { boot, getDshRuntimeVersion, evaluatePluginCompatibility, prepareProfileEntries } from "@deepseek-ai/dsh-app-boot";
import { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import { AgentModel, modelSelectionProjectionDefinition } from "@deepseek-ai/dsh-agent";
import { inRange } from "./contracts.mjs";

class SyntheticCredentials extends CredentialProvider { async resolve() { return undefined; } }
const packageRoot = resolve(process.env.DSH_SMOKE_PACKAGE), out = resolve(process.env.DSH_SMOKE_OUT);
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const runtime = getDshRuntimeVersion(), expected = process.env.DSH_EXPECTED_VERSION;
const report = { plugin: `${pkg.name}@${pkg.version}`, runtime, node: process.version, range: pkg.engines.dsh, archiveSha256: process.env.DSH_SMOKE_ARCHIVE_SHA256, revision: process.env.GITHUB_SHA ?? "local", modelCalls: 0, dailyProfileLoaded: false };
let ctx;
try {
  assert.equal(runtime, expected);
  assert.ok(inRange(runtime, pkg.engines.dsh));
  assert.equal(evaluatePluginCompatibility(pkg), undefined);
  const { engines, ...peerOnly } = pkg;
  for (const version of ["0.2.2-rc.2", "0.2.2-rc.3", "0.2.2-rc.4", "0.2.2"]) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, version), undefined);
    assert.equal(evaluatePluginCompatibility(peerOnly, {}, version), undefined);
  }
  for (const version of ["0.2.2-rc.1", "0.2.3-0", "0.2.3-rc.1", "0.2.3", "0.3.0"]) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, version)?.exempted, false);
    assert.equal(evaluatePluginCompatibility(peerOnly, {}, version)?.exempted, false);
  }
  const require = createRequire(pathToFileURL(join(packageRoot, "package.json")));
  report.peers = Object.fromEntries(Object.entries(pkg.peerDependencies).filter(([name]) => name.startsWith("@deepseek-ai/dsh-")).map(([name, range]) => {
    const version = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
    assert.equal(version, expected, `${name}: npm must not silently select another runtime`);
    assert.ok(inRange(version, range), `${name}: peer range`);
    return [name, version];
  }));
  const home = mkdtempSync(join(out, "home-")), config = join(home, "cordis.json"), workspace = join(home, "synthetic-project"), errors = [];
  process.env.DSH_HOME = home;
  process.env.DSH_AGENTS_HOME = join(home, "agents");
  process.env.KAMI_DATA_DIR = join(home, "data");
  process.env.KAMI_PROVIDER_DIRECTORY = join(home, "provider");
  mkdirSync(workspace);
  mkdirSync(process.env.KAMI_PROVIDER_DIRECTORY);
  writeFileSync(join(process.env.KAMI_PROVIDER_DIRECTORY, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
  writeFileSync(config, "[]\n");
  const source = "星屑結晶を使います。\n設定を保存します。";
  writeFileSync(join(workspace, "source.txt"), source);
  const entry = { id: "packed-kami", name: pathToFileURL(join(packageRoot, "dsh/index.mjs")).href };
  const preset = { id: "packed-kami-tools", name: pathToFileURL(join(packageRoot, "dsh/agent.mjs")).href };
  const core = [
    ["dsh-system-prompt", {}], ["dsh-tools", {}], ["dsh-typert-registry", {}], ["dsh-llm", {}],
    ["dsh-session", {}], ["dsh-session-projection", {}], ["dsh-commands", {}], ["dsh-attachment", {}],
    ["dsh-fs-sandbox", { cwd: workspace, diffBasisMaxBytes: 1048576 }],
    ["dsh-working-directory", { defaultDirectory: workspace }],
    ["dsh-sandbox-policy", { mode: "workspace-write", workspaceRoot: workspace }],
    ["dsh-agent-default-model", { provider: "offline", model: "not-registered" }],
    ["dsh-agent", {}], ["dsh-agent-preset-registry", { default: "kami-translator" }]
  ].map(([name, config]) => ({ id: name, name: `@deepseek-ai/${name}`, config }));
  const start = () => boot("kami-compatibility", config, [{ insert: [...core, entry, preset] }], async host => {
    host.provide("profileContext", { name: "compatibility", dir: home });
    assert.equal(prepareProfileEntries(host, [entry], pathToFileURL(config).href)[0].disabled, undefined);
    host.logger.exporter({ levels: { default: 2 }, export: message => {
      if (message.type === "warn" || message.type === "error") errors.push(message.args.map(String).join(" "));
    } });
    await host.plugin(SyntheticCredentials);
  });
  ctx = await start();
  assert.deepEqual(ctx.llm.listProviders(), [], "No model adapters may be registered in this smoke");
  assert.ok(ctx.kamiWorkbench, "the installed package must actually activate through the official Loader");
  assert.ok(await ctx.kamiWorkbench.ready);
  assert.equal(ctx.typert.local.get("kamiUi/invoke").id, "kami-dsh#kamiUi/invoke");
  assert.deepEqual(ctx.tools.definitions().filter(t => t.name.startsWith("kami_")).map(t => t.name).sort(), ["kami_file_import", "kami_help", "kami_workbench", "kami_workspace"]);
  const carrier = async host => {
    const session = host.sessions.create("synthetic-kami", { meta: { cwd: workspace } });
    const handle = await host.sessionProjections.register(modelSelectionProjectionDefinition);
    return { session, ctx: host, model: new AgentModel(() => handle.stateOf(session), session, host.agentDefaultModel.currentSelection()) };
  };
  const agent = await carrier(ctx);
  const state = await ctx.kamiUi.invoke(agent, { action: "workspace", actionType: "bind", name: "Synthetic CI project" });
  const projectId = state.project.id;
  const imported = await ctx.kamiUi.invoke(agent, { action: "file", path: "source.txt" });
  assert.ok(imported.batchId);
  assert.ok(imported.segments.length > 0);
  assert.ok(imported.segments.every(segment => source.includes(segment.source)));
  const run = await ctx.kamiUi.invoke(agent, { path: `/api/batch/run/${imported.batchId}?projectId=${projectId}` });
  assert.equal(run.batchId, imported.batchId);
  assert.equal(readFileSync(join(workspace, "source.txt"), "utf8"), source);
  const { default: JSZip } = await import(pathToFileURL(require.resolve("jszip")));
  const doc = new JSZip();
  doc.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  doc.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成の文書です。</w:t></w:r></w:p></w:body></w:document>');
  const docBytes = await doc.generateAsync({ type: "nodebuffer" });
  writeFileSync(join(workspace, "synthetic.docx"), docBytes);
  const office = await ctx.kamiUi.invoke(agent, { action: "file", path: "synthetic.docx" });
  assert.ok(office.batchId);
  assert.ok(office.segments.some(segment => segment.source.includes("合成の文書です。")));
  assert.deepEqual(readFileSync(join(workspace, "synthetic.docx")), docBytes);
  let browserModule;
  runInNewContext(readFileSync(join(packageRoot, "dsh/client.js"), "utf8"), { window: { __ModuleLoader__: { load: value => { browserModule = value; } } } });
  assert.equal(browserModule.id, pkg.name);
  assert.equal(typeof browserModule.factory, "function");
  await ctx.fiber.dispose(); ctx = await start();
  const reopened = await ctx.kamiUi.invoke(await carrier(ctx), { action: "workspace" });
  assert.equal(reopened.project.id, projectId);
  assert.equal(existsSync(join(home, "compatibility.json")), false);
  assert.equal(readFileSync(process.env.DSH_KERNEL_NETWORK_LOG, "utf8"), "");
  assert.deepEqual(errors, []);
  Object.assign(report, { status: "passed", boundedGate: true, activation: true, fourTools: true, remote: true, textImport: true, docxImport: true, batches: 2, originalsUnchanged: true, restartPersistence: true, browserEntry: true, externalAttempts: 0 });
} catch (error) { Object.assign(report, { status: "failed", error: error.stack }); throw error; }
finally {
  await ctx?.fiber.dispose();
  writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

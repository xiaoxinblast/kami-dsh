import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "kami-resource-compile-")), cwd = join(directory, "workspace"), dataDirectory = join(directory, "data");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs(), messages = [];
  const modelAdapter = async (input, options) => {
    messages.push(JSON.stringify(input));
    return { content: options.requestLabel?.startsWith("Auto QA") ? '{"issues":[]}' : "装备星刃。" };
  };
  let workbench = await createWorkbench({ dataDirectory, modelAdapter });
  const context = { cwd, fs, human: true, signal: new AbortController().signal };
  try {
    const state = await workbench.workspace({ action: "bind", name: "资源编译验收" }, context);
    const compile = async (path, purpose, content) => {
      const linked = await workbench.importFile({ path, purpose }, context);
      const compiledPath = `.kami/compiled/${purpose}.json`;
      await mkdir(join(cwd, ".kami/compiled"), { recursive: true });
      await writeFile(join(cwd, compiledPath), JSON.stringify({ source: { path: linked.path, hash: linked.hash }, ...content }));
      return workbench.importFile({ path, purpose, compiledPath }, context);
    };
    await run({ cwd, context, state, messages, compile, get workbench() { return workbench; }, restart: async () => {
      await workbench.close();
      workbench = await createWorkbench({ dataDirectory, modelAdapter });
    } });
  } finally {
    await workbench.close(); await close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-resource-compile-")));
    await rm(directory, { recursive: true, force: true });
  }
}

test("linking requests agent compilation and accepts native compilation files without a source layout template", async () => fixture(async ({ cwd, workbench, context, compile, state, messages }) => {
  const originals = { "terms.custom": "第三列是词名：星の剣；第七列是译名：星刃_术语探针；说明：装备名称。", "tm.custom": "旧译：星の剣を装備します。 → TM_句对探针。", "style.custom": "译文保持简洁。风格末尾探针_8137。" };
  for (const [path, text] of Object.entries(originals)) await writeFile(join(cwd, path), text);
  const pending = await workbench.importFile({ path: "terms.custom", purpose: "terms" }, context);
  assert.equal(pending.compilation.status, "pending");
  const terms = await compile("terms.custom", "terms", { terms: [{ ja: "星の剣", zh: "星刃_术语探针", note: "装备名称_备注探针" }] });
  const tm = await compile("tm.custom", "tm", { entries: [{ source: "星の剣を装備します。", target: "TM_句对探针。", context: "装备界面", file: "历史工作表" }] });
  const guide = await compile("style.custom", "style-guide", { style_guide: originals["style.custom"] });
  assert.equal(terms.compilation.status, "ready");
  assert.equal(terms.compilation.itemCount, 1);
  assert.equal(tm.compilation.itemCount, 1);
  assert.equal(guide.compilation.characters, [...originals["style.custom"]].length);
  await writeFile(join(cwd, "source.txt"), "星の剣を装備します。");
  const prepared = await workbench.importFile({ path: "source.txt" }, context);
  const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
  assert.equal(snapshot.terms[0].target, "星刃_术语探针");
  assert.equal(snapshot.terms[0].note, "装备名称_备注探针");
  assert.equal(snapshot.memories[0].target, "TM_句对探针。");
  assert.equal(snapshot.memories[0].context, "装备界面");
  assert.match(snapshot.guide.instruction, /风格末尾探针_8137/);
  assert.ok(snapshot.resources.every((resource) => resource.reader === "agent"));
  for (const kind of ["term", "tm"]) assert.equal((await workbench.invoke({ path: `/api/library-entries?projectId=${state.project.id}&locale=zh-CN&kind=${kind}` }, context)).total, 0);
  await workbench.invoke({ path: "/api/translate", method: "POST", body: { batchId: prepared.batchId, projectId: state.project.id, locale: "zh-CN", source: "星の剣を装備します。", qualityTier: "fast", reflect: false } }, context);
  for (const probe of ["星刃_术语探针", "装备名称_备注探针", "TM_句对探针", "风格末尾探针_8137"]) assert.ok(messages.some((message) => message.includes(probe)), `${probe} must reach the translation model`);
  for (const [path, text] of Object.entries(originals)) assert.equal(await readFile(join(cwd, path), "utf8"), text);
}));

test("compiled resources survive restart, invalidate by source hash, and leave older batches frozen", async () => fixture(async (env) => {
  const { cwd, context, compile } = env;
  await writeFile(join(cwd, "guide.custom"), "源文件第一版");
  await compile("guide.custom", "style-guide", { style_guide: "编译风格第一版" });
  await writeFile(join(cwd, "source.txt"), "星の剣を装備します。");
  const first = await env.workbench.importFile({ path: "source.txt" }, context);
  await env.restart();
  assert.equal((await env.workbench.importFile({ path: "guide.custom", purpose: "style-guide" }, context)).compilation.status, "ready");
  const second = await env.workbench.importFile({ path: "source.txt" }, context);
  assert.match((await env.workbench.store.request(`/items/batch_runs/${second.batchId}`)).runner_options.workspaceSnapshot.guide.instruction, /编译风格第一版/);
  await writeFile(join(cwd, "guide.custom"), "源文件第二版");
  assert.equal((await env.workbench.importFile({ path: "guide.custom", purpose: "style-guide" }, context)).compilation.status, "pending");
  await assert.rejects(env.workbench.importFile({ path: "guide.custom", purpose: "style-guide", compiledPath: ".kami/compiled/style-guide.json" }, context), /版本|哈希|hash/);
  await compile("guide.custom", "style-guide", { style_guide: "编译风格第二版" });
  const latest = await env.workbench.importFile({ path: "source.txt" }, context);
  assert.match((await env.workbench.store.request(`/items/batch_runs/${latest.batchId}`)).runner_options.workspaceSnapshot.guide.instruction, /编译风格第二版/);
  assert.match((await env.workbench.store.request(`/items/batch_runs/${first.batchId}`)).runner_options.workspaceSnapshot.guide.instruction, /编译风格第一版/);
}));

test("both cached compilation and task pairs reject memoQ metadata while preserving normal identical text", async () => fixture(async ({ cwd, workbench, context, compile }) => {
  const protection = "DO NOT DELETE THIS ROW. When moving columns, make sure you move this row as well.";
  await writeFile(join(cwd, "tm.custom"), `${protection}\nAlpha\n設定を開きます。`);
  const entries = [{ source: protection, target: protection }, { source: "Japanese", target: "Chinese Simplified" }, { source: "", target: "空原文" }, { source: "Alpha", target: "Alpha" }, { source: "設定を開きます。", target: "打开设置。" }];
  const compiled = await compile("tm.custom", "tm", { entries });
  assert.equal(compiled.compilation.itemCount, 2);
  assert.equal(compiled.compilation.skippedCount, 3);
  await writeFile(join(cwd, "source.txt"), "設定を開きます。");
  for (const resourceContext of [undefined, [{ path: "tm.custom", hash: compiled.hash, pairs: entries }]]) {
    const prepared = await workbench.importFile({ path: "source.txt", resourceContext }, context);
    const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
    assert.deepEqual(snapshot.memories.map((item) => item.source), ["Alpha", "設定を開きます。"]);
  }
}));

test("inline agent compilation is persisted and invalid compilation never reports ready", async () => fixture(async ({ cwd, workbench, context }) => {
  await writeFile(join(cwd, "guide.custom"), "正式规则");
  const linked = await workbench.importFile({ path: "guide.custom", purpose: "style-guide" }, context);
  const compiled = await workbench.importFile({ path: "guide.custom", purpose: "style-guide", resourceContext: [{ path: linked.path, hash: linked.hash, text: "Agent 编译的正式规则" }] }, context);
  assert.equal(compiled.compilation.status, "ready");
  assert.equal((await workbench.importFile({ path: "guide.custom", purpose: "style-guide" }, context)).compilation.status, "ready");
  await assert.rejects(workbench.importFile({ path: "guide.custom", purpose: "style-guide", resourceContext: [{ path: linked.path, hash: linked.hash, text: "" }] }, context), /正文|编译|查阅/);
  await assert.rejects(workbench.importFile({ path: "guide.custom", purpose: "style-guide", compiledPath: "../outside.json" }, context), /路径|越界/);
  await writeFile(join(cwd, "broken.json"), JSON.stringify({ source: { path: "other.custom", hash: linked.hash }, style_guide: "错误来源" }));
  await assert.rejects(workbench.importFile({ path: "guide.custom", purpose: "style-guide", compiledPath: "broken.json" }, context), /来源|路径/);
}));

test("bulk configuration reports compilation work without requiring fixed input formats", async () => fixture(async ({ cwd, workbench, context, compile }) => {
  await writeFile(join(cwd, "terms.custom"), "不固定排版的术语资料");
  await writeFile(join(cwd, "guide.custom"), "不固定排版的风格指南");
  const state = await workbench.workspace({ action: "configure", resources: { terms: ["terms.custom"], styleGuides: ["guide.custom"] } }, context);
  assert.equal(state.compilations.length, 2);
  assert.ok(state.compilations.every((item) => item.compilation.status === "pending"));
  await compile("guide.custom", "style-guide", { style_guide: "编译完成的规则" });
  const next = await workbench.workspace({ action: "configure", resources: { styleGuides: ["guide.custom"] } }, context);
  assert.equal(next.compilations[0].compilation.status, "ready");
}));

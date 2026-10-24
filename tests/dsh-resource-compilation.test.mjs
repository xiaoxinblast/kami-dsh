import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    await run({ cwd, dataDirectory, context, state, messages, compile, get workbench() { return workbench; }, restart: async () => {
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
  await writeFile(join(cwd, "empty.json"), JSON.stringify({ resources: [] }));
  await assert.rejects(workbench.importFile({ path: "guide.custom", purpose: "style-guide", compiledPath: "empty.json" }, context), /非空/);
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

test("multi-file updates share one library file and snapshots merge only current source contributions", async () => fixture(async ({ cwd, dataDirectory, workbench, context }) => {
  for (const path of ["a.custom", "b.custom"]) await writeFile(join(cwd, path), path);
  await workbench.workspace({ action: "configure", resources: { translationMemories: ["a.custom", "b.custom"] } }, context);
  const plan = await workbench.workspace({ action: "compilations" }, context);
  assert.equal(plan.groups.length, 1); assert.equal(plan.groups[0].files.length, 2);
  const group = plan.groups[0], compiledPath = ".kami/compiled/library.json";
  await mkdir(join(cwd, ".kami/compiled"), { recursive: true });
  await writeFile(join(cwd, compiledPath), JSON.stringify({ resources: group.files.map((source, index) => ({ path: source.path, hash: source.hash,
    entries: [{ source: "設定を開きます。", target: "打开设置。", note: `来源${index}` }, { source: `別の文章${index}`, target: `其他句子${index}` }] })) }));
  const merged = await workbench.importFile({ path: "a.custom", purpose: "tm", libraryId: group.libraryId, compiledPath }, context);
  assert.equal(merged.compilation.libraryItemCount, 3); assert.equal(merged.compilation.duplicateCount, 1);
  assert.equal(merged.compilation.compiledFile, group.compiledFile);
  assert.equal((await readdir(join(dataDirectory, "runtime/compiled-resources"))).length, 1);
  await writeFile(join(cwd, "source.txt"), "設定を開きます。");
  const first = await workbench.importFile({ path: "source.txt" }, context);
  const snapshot = (await workbench.store.request(`/items/batch_runs/${first.batchId}`)).runner_options.workspaceSnapshot;
  assert.equal(snapshot.memories.length, 3);
  assert.equal(snapshot.memories.find((item) => item.source === "設定を開きます。").note, "来源0\n来源1");
  await writeFile(join(cwd, "a.custom"), "a 更新");
  const pending = await workbench.workspace({ action: "compilations", selection: [{ path: "a.custom", purpose: "tm" }] }, context);
  assert.equal(pending.groups[0].files.length, 1); assert.equal(pending.groups[0].files[0].status, "pending");
  const source = pending.groups[0].files[0];
  await workbench.importFile({ path: source.path, purpose: "tm", resourceContext: [{ path: source.path, hash: source.hash, pairs: [{ source: "更新", target: "新内容" }] }] }, context);
  const ready = await workbench.workspace({ action: "compilations" }, context);
  assert.ok(ready.groups[0].files.every((item) => item.status === "ready"));
  const next = await workbench.importFile({ path: "source.txt" }, context);
  const latest = (await workbench.store.request(`/items/batch_runs/${next.batchId}`)).runner_options.workspaceSnapshot;
  assert.ok(latest.memories.some((item) => item.target === "新内容"));
  assert.ok(latest.memories.some((item) => item.target === "其他句子1"));
  assert.ok(!latest.memories.some((item) => item.target === "其他句子0"));
  assert.equal(latest.memories.find((item) => item.source === "設定を開きます。").note, "来源1");
  assert.equal(snapshot.memories.find((item) => item.source === "設定を開きます。").note, "来源0\n来源1");
}));

test("library deduplication preserves TM identities, term applicability and duplicate row origins", async () => fixture(async ({ cwd, workbench, context, compile }) => {
  await writeFile(join(cwd, "tm.custom"), "相同句对的不同条目");
  const pair = { source: "設定", target: "设置" };
  const tm = await compile("tm.custom", "tm", { entries: [{ ...pair, entryId: "a", rowNumber: 1 }, { ...pair, entryId: "b", rowNumber: 2 }, { ...pair, entryId: "a", rowNumber: 3 }] });
  assert.equal(tm.compilation.libraryItemCount, 2);
  assert.equal(tm.compilation.duplicateCount, 1);
  await writeFile(join(cwd, "terms.custom"), "适用范围与约束不同的术语");
  const term = { ja: pair.source, zh: pair.target, domain: "game", contentType: "ui", enforcement: "preferred" };
  const terms = await compile("terms.custom", "terms", { terms: [term, { ...term, domain: "marketing" }, { ...term, contentType: "dialogue" }, { ...term, enforcement: "mandatory" }, { ...term, preserveOriginal: true }] });
  assert.equal(terms.compilation.libraryItemCount, 5);
  await writeFile(join(cwd, "source.txt"), "設定");
  const prepared = await workbench.importFile({ path: "source.txt" }, context);
  const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
  assert.equal(snapshot.memories.length, 2);
  assert.deepEqual(snapshot.memories.find((item) => item.entryId === "a").origins.map((origin) => origin.rowNumber), [1, 3]);
  assert.equal(snapshot.terms.length, 5);
  assert.ok(snapshot.terms.some((item) => item.domain === "marketing"));
  assert.ok(snapshot.terms.some((item) => item.contentType === "dialogue"));
}));

test("badge status refresh reuses unchanged source hashes and observes compiled updates and source changes", async () => fixture(async ({ cwd, workbench, context, compile }) => {
  await writeFile(join(cwd, "tm.custom"), "源文件第一版");
  await workbench.importFile({ path: "tm.custom", purpose: "tm" }, context);
  const original = context.fs.readByteRange.bind(context.fs);
  let reads = 0;
  context.fs.readByteRange = async (...args) => { if (context.fs.processPath(args[0]).endsWith("tm.custom")) reads++; return original(...args); };
  const status = async () => (await workbench.workspace({ action: "compilations" }, context)).groups[0].files[0].status;
  assert.equal(await status(), "pending");
  const initial = reads;
  assert.ok(initial > 0);
  assert.equal(await status(), "pending"); assert.equal(reads, initial, "unchanged large files must not be rehashed on every badge refresh");
  await compile("tm.custom", "tm", { entries: [{ source: "設定", target: "设置" }] });
  const compiled = reads;
  assert.equal(await status(), "ready"); assert.equal(reads, compiled, "saving the library invalidates coverage without rereading the unchanged original");
  await writeFile(join(cwd, "tm.custom"), "源文件第二版，内容发生变化");
  assert.equal(await status(), "pending"); assert.ok(reads > compiled);
  await rm(join(cwd, "tm.custom"));
  const missing = await workbench.workspace({ action: "compilations" }, context);
  assert.equal(missing.groups[0].files.length, 0);
  assert.equal(missing.failures[0].path, "tm.custom");
}));

test("first library update migrates unchanged per-file caches without recompiling unselected originals", async () => fixture(async ({ cwd, dataDirectory, workbench, context, compile }) => {
  for (const path of ["a.custom", "b.custom"]) await writeFile(join(cwd, path), path);
  await workbench.workspace({ action: "configure", resources: { translationMemories: ["a.custom", "b.custom"] } }, context);
  const source = await workbench.importFile({ path: "b.custom", purpose: "tm", register: false }, context);
  const root = (await workbench.workspace({}, context)).workspace;
  const digest = createHash("sha256").update(`${root}\0tm\0b.custom`).digest("hex");
  const folder = join(dataDirectory, "runtime/compiled-resources", digest);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${source.hash}.json`), JSON.stringify({ version: 1, purpose: "tm", source: { path: source.path, hash: source.hash }, parsed: { candidates: [{ source: "旧资料", target: "保留旧编译" }] } }));
  const plan = await workbench.workspace({ action: "compilations" }, context);
  assert.equal(plan.groups[0].files.find((item) => item.path === "a.custom").status, "pending");
  assert.equal(plan.groups[0].files.find((item) => item.path === "b.custom").status, "ready", "valid older compilation must not be sent to the agent again");
  const result = await compile("a.custom", "tm", { entries: [{ source: "新资料", target: "新增编译" }] });
  assert.equal(result.compilation.libraryItemCount, 2);
  const record = JSON.parse(await readFile(result.compilation.compiledFile, "utf8"));
  assert.equal(record.sources.length, 2);
  assert.ok(record.candidates.some((item) => item.target === "保留旧编译"));
}));

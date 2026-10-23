import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { rankTranslationMemories } from "../src/translation-memory.mjs";

test("equal file TM matches use library priority without gaining canonical authority", () => {
  const pair = { source: "設定を開きます。", qualityStatus: "machine_verified", assetTier: "working", batchId: "batch", projectId: "project", libraryRole: "reference", libraryEnabled: true, workspaceResource: true, contentType: "general", domain: "general" };
  const memories = [{ ...pair, id: "low", target: "低优先级译文", libraryPriority: 7 }, { ...pair, id: "high", target: "高优先级译文", libraryPriority: 2 }];
  const ranked = rankTranslationMemories(pair.source, memories, { limit: 5, projectId: "project", batchId: "batch", retrievalPurpose: "working_consistency" });
  assert.deepEqual(ranked.map((item) => item.id), ["high", "low"]);
  assert.ok(ranked.every((item) => item.qualityStatus === "machine_verified"));
});

test("linked library files retain priority, respect enablement, and reach translation beside project TM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-linked-libraries-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs(), messages = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (input, options) => {
    messages.push(JSON.stringify(input));
    return { content: options.requestLabel?.startsWith("Auto QA") ? '{"issues":[]}' : "打开设置。" };
  } });
  const context = { cwd, fs, human: true, signal: new AbortController().signal };
  try {
    const state = await workbench.workspace({ action: "bind", name: "linked files" }, context), projectId = state.project.id;
    const path = `/api/projects/${projectId}/libraries`;
    const library = (await workbench.invoke({ path, method: "POST", body: { kind: "translation_memory", role: "reference", name: "本地参考记忆", priority: 7 } }, context)).library;
    await writeFile(join(cwd, "tm.csv"), "日语,简体中文\n設定を開きます。,本地记忆唯一探针_7149\n");
    await writeFile(join(cwd, "source.txt"), "設定を開きます。");
    await workbench.importFile({ purpose: "tm", path: "tm.csv", libraryId: library.id }, context);
    const configured = await workbench.workspace({}, context);
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
    await workbench.invoke({ path: "/api/translate", method: "POST", body: { batchId: prepared.batchId, projectId, locale: "zh-CN", source: "設定を開きます。", qualityTier: "fast", reflect: false } }, context);
    assert.ok(messages.some((message) => message.includes("本地记忆唯一探针_7149")), "file TM must reach the model while default project TM libraries are enabled");
    assert.equal(configured.config.libraryFiles.find((item) => item.path === "tm.csv").libraryId, library.id);
    assert.equal(snapshot.memories[0].libraryPriority, 7);
    assert.equal(snapshot.memories[0].qualityStatus, "machine_verified");
    const qa = await workbench.invoke({ path: "/api/auto-qa", method: "POST", body: { batchId: prepared.batchId, projectId, locale: "zh-CN", source: "設定を開きます。", translation: "打开设置。" } }, context);
    assert.ok(!(qa.references || []).some((item) => item.qualityStatus === "machine_verified"), "file TM must not gain human authority in QA");
    await workbench.invoke({ path: `${path}/${library.id}`, method: "PATCH", body: { priority: 2 } }, context);
    const next = await workbench.importFile({ path: "source.txt" }, context);
    assert.equal((await workbench.store.request(`/items/batch_runs/${next.batchId}`)).runner_options.workspaceSnapshot.memories[0].libraryPriority, 2);
    assert.equal(snapshot.memories[0].libraryPriority, 7, "existing batch keeps its file-library snapshot");
    await workbench.invoke({ path: `${path}/${library.id}`, method: "PATCH", body: { enabled: false } }, context);
    const disabled = await workbench.importFile({ path: "source.txt" }, context);
    assert.equal((await workbench.store.request(`/items/batch_runs/${disabled.batchId}`)).runner_options.workspaceSnapshot.memories.length, 0);
    const termLibrary = configured.libraries.find((item) => item.kind === "term_base");
    await assert.rejects(workbench.importFile({ purpose: "tm", path: "tm.csv", libraryId: termLibrary.id }, context), /库.*用途|类型/);
    await assert.rejects(workbench.workspace({ action: "configure", resources: { libraryFiles: [{ path: "tm.csv", purpose: "tm", libraryId: "other-project" }] } }, context), /资源库|库.*不存在/);
    await workbench.workspace({ action: "configure", resources: { translationMemories: [] } }, context);
    assert.equal((await workbench.workspace({}, context)).config.libraryFiles.length, 0);
    assert.match(await readFile(join(cwd, "tm.csv"), "utf8"), /本地记忆唯一探针_7149/);
  } finally { await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy local file associations resolve to existing libraries without importing rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-legacy-links-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs();
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data") });
  const context = { cwd, fs, human: true };
  try {
    const state = await workbench.workspace({ action: "bind", name: "legacy links" }, context);
    await writeFile(join(cwd, "old.csv"), "日语,简体中文\n設定,设置\n");
    await workbench.workspace({ action: "configure", resources: { terms: ["old.csv"] } }, context);
    const resolved = await workbench.workspace({}, context);
    assert.equal(resolved.config.libraryFiles[0].libraryId, resolved.libraries.find((item) => item.kind === "term_base").id);
    const entries = await workbench.invoke({ path: `/api/library-entries?projectId=${state.project.id}&locale=zh-CN&kind=term` }, context);
    assert.equal(entries.total, 0);
  } finally { await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

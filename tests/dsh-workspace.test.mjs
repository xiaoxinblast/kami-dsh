import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import JSZip from "jszip";
import { createWorkbench } from "../dsh/workbench.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { mergeWorkspaceMemories, mergeWorkspaceTerms } from "../src/workspace-resources.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("workspace files are explicit, contained, snapshotted, restartable and never auto-imported as canonical assets", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kami-workspace-"));
  const data = join(directory, "data"), first = join(directory, "项目甲"), second = join(directory, "项目乙");
  const { fs, close } = await workspaceFs();
  const messages = [];
  const modelAdapter = async (input, options) => { messages.push(JSON.stringify(input)); return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : options.requestLabel?.startsWith("Auto QA") ? '{"issues":[]}' : "保存设置。" }; };
  let workbench = await createWorkbench({ dataDirectory: data, modelAdapter });
  const context = { cwd: first, fs, human: true, isKamiSession: true, signal: new AbortController().signal };
  const other = { ...context, cwd: second };
  let projectId, batchId, snapshot;
  const readRun = async (id = batchId, ctx = context) => { const value = await workbench.invoke({ path: `/api/batch/run/${id}?projectId=${projectId}` }, ctx); return value.run || value; };
  const rawSnapshot = async (id = batchId) => (await workbench.store.request(`/items/batch_runs/${id}`)).runner_options.workspaceSnapshot;
  try {
    for (const root of [first, second]) await mkdir(join(root, "rules"), { recursive: true });
    await mkdir(join(first, "source"));
    await writeFile(join(first, "rules/指南.md"), "指南版本甲：译文使用简体中文，按钮用「保存」。");
    await writeFile(join(first, "source/对白.txt"), "設定を保存します。");
    await writeFile(join(first, "glossary.csv"), "日语,简体中文\n設定,设置\n");
    await writeFile(join(first, "tm.csv"), "日语,简体中文\n設定を保存します。,保存设置。\n");
    await writeFile(join(first, "reference.md"), "# 世界设定\n\n公主名为莉娜，来自北国。");

    await t.test("first use requires an explicit binding and persists relative resource paths", async () => {
      assert.equal((await workbench.workspace({}, context)).bound, false);
      await assert.rejects(workbench.importFile({ path: "source/对白.txt" }, context), /绑定/);
      const state = await workbench.workspace({ action: "bind", name: "明确创建的项目" }, context);
      projectId = state.project.id;
      assert.equal(state.config.projectId, projectId);
      assert.equal(state.config.outputDirectory, "outputs");
      await assert.rejects(workbench.workspace({ action: "bind", projectId, name: "双重指定" }, context), /二者选一/);
      for (const [purpose, path] of [["style-guide", "rules/指南.md"], ["terms", "glossary.csv"], ["tm", "tm.csv"], ["reference", "reference.md"]]) {
        const value = await workbench.importFile({ purpose, path }, context);
        assert.equal(value.registered, true); assert.match(value.hash, /^[a-f\d]{64}$/);
      }
      const config = JSON.parse(await readFile(join(first, ".kami/project.json"), "utf8"));
      assert.deepEqual(config.styleGuides, ["rules/指南.md"]);
      assert.deepEqual(config.terms, ["glossary.csv"]);
      assert.equal((await workbench.invoke({ path: `/api/style-profiles?projectId=${projectId}&locale=zh-CN` }, context)).userProfiles.length, 0);
    });
    await t.test("rejects traversal, missing files, directories, invalid formats, size and links outside workspace", async () => {
      for (const path of ["../outside.txt", "rules/../../outside.txt", join(directory, "outside.txt")]) await assert.rejects(workbench.importFile({ path }, context), /路径|ENOENT/);
      await assert.rejects(workbench.importFile({ path: "missing.txt" }, context), /ENOENT|FS_NOT_FOUND/);
      await assert.rejects(workbench.importFile({ path: "rules" }, context), /普通文件/);
      await writeFile(join(first, "invalid.exe"), "no");
      await assert.rejects(workbench.importFile({ path: "invalid.exe", purpose: "style-guide" }, context), /仅支持/);
      await writeFile(join(first, "large.md"), Buffer.alloc(5 * 1024 * 1024 + 1));
      await assert.rejects(workbench.importFile({ path: "large.md", purpose: "style-guide" }, context), /5 MB/);
      await writeFile(join(second, "outside.md"), "外部文件");
      await symlink(second, join(first, "external"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(workbench.importFile({ path: "external/outside.md", purpose: "style-guide" }, context), /工作区外/);
      await assert.rejects(workbench.saveExport({ base64: "eA==", filename: "out.txt" }, "out.txt", context, "external/out.txt"), /工作区外/);
      await assert.rejects(workbench.workspace({ action: "configure", resources: { styleGuides: ["../rules.md"] } }, context), /相对路径/);
    });
    await t.test("creation freezes original bytes and parsed resources without creating uploaded assets", async () => {
      const prepared = await workbench.importFile({ path: "source/对白.txt", projectId }, context);
      batchId = prepared.batchId;
      snapshot = await rawSnapshot();
      assert.equal(snapshot.source.path, "source/对白.txt");
      assert.match(snapshot.guide.instruction, /指南版本甲/);
      assert.equal(snapshot.terms[0].target, "设置");
      assert.equal(snapshot.memories[0].qualityStatus, "machine_verified");
      assert.equal(snapshot.referenceChunks[0].documentName, "reference.md");
      const run = await readRun();
      assert.match(run.runnerOptions.originalFile, /^runtime\/workspace-snapshots\//);
      assert.equal(run.runnerOptions.workspaceSnapshot.terms, undefined, "parsed resources stay on Host");
      assert.equal((await readdir(data)).includes("uploads"), false);
      const entries = await workbench.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=term&locale=zh-CN` }, context);
      assert.equal(entries.total, 0);
      const memories = await workbench.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=tm&locale=zh-CN` }, context);
      assert.equal(memories.total, 0);
    });
    await t.test("later tasks read new files while paused/reopened tasks keep old resources and native-format originals", async () => {
      await writeFile(join(first, "rules/指南.md"), "指南版本乙：新的风格要求。");
      await writeFile(join(first, "source/对白.txt"), "変更を保存します。");
      const next = await workbench.importFile({ path: "source/对白.txt" }, context);
      const nextSnapshot = await rawSnapshot(next.batchId);
      assert.notEqual(snapshot.source.hash, nextSnapshot.source.hash);
      assert.match(nextSnapshot.guide.instruction, /指南版本乙/);
      assert.equal(snapshot.resources.find((item) => item.purpose === "reference").hash, nextSnapshot.resources.find((item) => item.purpose === "reference").hash);
      const run = await readRun();
      await workbench.invoke({ path: "/api/batch/run", method: "POST", body: { ...run, runState: "paused" } }, context);
      await workbench.close();
      workbench = await createWorkbench({ dataDirectory: data, modelAdapter });
      assert.match((await rawSnapshot()).guide.instruction, /指南版本甲/);
      await workbench.invoke({ path: `/api/batch/run/${batchId}/start`, method: "POST", body: { projectId } }, context);
      let current;
      const deadline = Date.now() + 12000;
      do { await new Promise((done) => setTimeout(done, 25)); current = await readRun(); } while (["running", "queued"].includes(current.runState) && Date.now() < deadline);
      assert.equal(current.segments[0].status, "done", current.segments[0].error);
      assert.equal(current.segments[0].source, "設定を保存します。");
      assert.ok(messages.some((text) => text.includes("指南版本甲")), "resumed translation consumes pinned guide");
      const qa = await workbench.invoke({ path: "/api/auto-qa", method: "POST", body: { batchId, projectId, locale: "zh-CN", source: current.segments[0].source, translation: current.segments[0].translation } }, context);
      assert.match(qa.styleProfile.instruction, /指南版本甲/);
      assert.doesNotMatch(qa.styleProfile.instruction, /指南版本乙/);
      await assert.rejects(workbench.invoke({ path: "/api/auto-qa", method: "POST", body: { batchId: "missing-batch", projectId, locale: "zh-CN", source: "設定", translation: "设置" } }, context), /未找到.*批次/);
      const exported = await workbench.perform({ action: "export", batchId, projectId, mode: "writeback" }, context);
      assert.match(relative((await workbench.workspace({}, context)).workspace, exported.path), /^outputs[\\/]/);
      assert.equal(await readFile(exported.path, "utf8"), "保存设置。");
      await assert.rejects(workbench.perform({ action: "export", batchId, projectId, mode: "writeback" }, context), /EEXIST/);
      await assert.rejects(workbench.perform({ action: "export", batchId, projectId, mode: "writeback", outputPath: "source/对白.txt" }, context), /EEXIST/);
      assert.equal(await readFile(join(first, "source/对白.txt"), "utf8"), "変更を保存します。");
    });
    await t.test("sessions switching directories are isolated even when bound to the same project", async () => {
      assert.equal((await workbench.workspace({}, other)).bound, false);
      await workbench.workspace({ action: "bind", projectId }, other);
      await assert.rejects(readRun(batchId, other), /另一个工作区/);
      await assert.rejects(workbench.invoke({ path: `/api/qa/batch/${batchId}?projectId=${projectId}` }, other), /另一个工作区/);
      await assert.rejects(workbench.perform({ action: "file", path: "source/对白.txt", expectedWorkspace: first }, other), /已切换/);
      const files = await workbench.invoke({ path: `/api/batch/files?projectId=${projectId}` }, other);
      assert.equal(files.files.some((item) => item.batchId === batchId), false);
      assert.equal((await workbench.workspace({}, context)).config.styleGuides.length, 1);
      assert.equal((await workbench.workspace({}, other)).config.styleGuides.length, 0);
    });
    await t.test("reference index keys follow reference hashes, keeping other snapshots isolated", async () => {
      const { createProjectReferenceIndex } = await import("../src/reference-context.mjs");
      const index = createProjectReferenceIndex();
      assert.equal((await withRuntimeCall({ workspaceSnapshot: snapshot }, () => index.documents({ projectId })))[0].name, "reference.md");
      await writeFile(join(first, "reference.md"), "# 世界设定\n\n女王名为艾玛。");
      const next = await workbench.importFile({ path: "source/对白.txt" }, context);
      const nextSnapshot = await rawSnapshot(next.batchId);
      const oldChunks = await withRuntimeCall({ workspaceSnapshot: snapshot }, () => index.chunksOf({ projectId, documentId: snapshot.referenceChunks[0].documentId }));
      const newChunks = await withRuntimeCall({ workspaceSnapshot: nextSnapshot }, () => index.chunksOf({ projectId, documentId: nextSnapshot.referenceChunks[0].documentId }));
      assert.match(oldChunks[0].text, /莉娜/); assert.match(newChunks[0].text, /艾玛/);
      await workbench.workspace({ action: "configure", resources: { references: [] } }, context);
      assert.match(await readFile(join(first, "reference.md"), "utf8"), /艾玛/);
    });
    await t.test("DOCX writeback uses the immutable original and preserves formatting", async () => {
      const zip = new JSZip();
      zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>設定を保存します。</w:t></w:r></w:p></w:body></w:document>');
      await writeFile(join(first, "source/dialogue.docx"), await zip.generateAsync({ type: "nodebuffer" }));
      const prepared = await workbench.importFile({ path: "source/dialogue.docx" }, context);
      const run = await readRun(prepared.batchId);
      run.segments.forEach((segment) => { segment.translation = "保存设置。"; segment.status = "done"; });
      await workbench.invoke({ path: "/api/batch/run", method: "POST", body: run }, context);
      await writeFile(join(first, "source/dialogue.docx"), "source replaced after task start");
      const output = await workbench.perform({ action: "export", batchId: run.batchId, projectId, mode: "writeback", outputPath: "outputs/格式.docx" }, context);
      const exported = await JSZip.loadAsync(await readFile(output.path));
      assert.match(await exported.file("word/document.xml").async("string"), /<w:b\/>.*保存设置。/);
    });
  } finally { await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

test("task resources cannot replace existing canonical terms or approved/master TM", () => {
  const assets = { terms: [{ source: "設定", target: "主库设置", aliases: ["設定項目"] }] };
  const snapshot = { terms: [{ source: "設定", target: "不应覆盖" }, { source: "保存", target: "保存" }], memories: [{ source: "設定", target: "任务 TM" }] };
  assert.deepEqual(mergeWorkspaceTerms(assets, snapshot).terms.map((term) => term.target), ["主库设置", "保存"]);
  assert.equal(mergeWorkspaceMemories([{ source: "設定", target: "主库", libraryRole: "master" }], snapshot).length, 1);
});

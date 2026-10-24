import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("local resources use original files and agent observations without upload limits or conversion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-local-files-"));
  const cwd = join(directory, "workspace");
  const { fs, close } = await workspaceFs();
  await mkdir(cwd);
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async () => ({ content: "译文" }) });
  let fullResourceReads = 0, referenceRanges = 0;
  const observedFs = new Proxy(fs, { get(target, key) {
    if (key === "readBytes") return (...args) => { if (target.processPath(args[0]).endsWith("原始资料.bin")) fullResourceReads++; return target.readBytes(...args); };
    if (key === "readByteRange") return (...args) => { if (target.processPath(args[0]).endsWith("原始资料.bin")) referenceRanges++; return target.readByteRange(...args); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const context = { cwd, fs: observedFs, human: true, signal: new AbortController().signal };
  try {
    await workbench.workspace({ action: "bind", name: "local files" }, context);
    const large = await open(join(cwd, "原始资料.bin"), "w");
    try { await large.truncate(33 * 1024 * 1024); } finally { await large.close(); }
    fullResourceReads = 0;
    const linked = await workbench.importFile({ path: "原始资料.bin", purpose: "reference" }, context);
    assert.equal(fullResourceReads, 0, "association must not buffer the original");
    assert.equal(referenceRanges, 0, "reference association must not scan bytes for a content hash");
    assert.equal(linked.size, 33 * 1024 * 1024);
    assert.equal(linked.readMode, "agent");
    assert.equal(linked.registered, true);
    await writeFile(join(cwd, "source.txt"), "設定を保存します。");
    const linkedOnly = await workbench.importFile({ path: "source.txt", resourceContext: [{ path: linked.path, hash: "a".repeat(64), text: "不得预置到参考正文" }] }, context);
    const linkedSnapshot = (await workbench.store.request(`/items/batch_runs/${linkedOnly.batchId}`)).runner_options.workspaceSnapshot;
    assert.equal(linkedSnapshot.referenceMode, "agent-native");
    assert.equal(linkedSnapshot.referenceChunks.length, 0);
    assert.equal(linkedSnapshot.resources[0].path, linked.path);
    assert.equal(linkedSnapshot.resources[0].reader, "agent-native");
    assert.equal(fullResourceReads, 0, "batch creation must not buffer or parse linked reference originals");
    await workbench.importFile({ path: "source.txt" }, context);
    assert.equal(fullResourceReads, 0, "reference parsing must not return when agent observations are omitted");
    assert.equal(referenceRanges, 0, "batch creation must keep reference originals unread");
    await assert.rejects(readFile(join(directory, "data/runtime/workspace-resources")), /ENOENT/);
    await writeFile(join(cwd, "风格.pdf"), "native file tool reads this original");
    const guide = await workbench.importFile({ path: "风格.pdf", purpose: "style-guide" }, context);
    assert.equal(guide.readMode, "agent");
    await workbench.workspace({ action: "configure", resources: { references: [] } }, context);
    await writeFile(join(cwd, "source.txt"), "設定を保存します。");
    await assert.rejects(workbench.importFile({ path: "source.txt", resources: { projectId: "other" } }, context), /字段/);
    await assert.rejects(workbench.importFile({ path: "source.txt", resourceContext: [{ path: guide.path, hash: guide.hash, text: 42 }] }, context), /resourceContext/);
    const prepared = await workbench.importFile({ path: "source.txt", resourceContext: [{ path: guide.path, hash: guide.hash, text: "本任务由 Agent 查阅原始 PDF：按钮使用保存。" }] }, context);
    const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
    assert.match(snapshot.guide.instruction, /按钮使用保存/);
    assert.equal(snapshot.resources[0].reader, "agent");
    const qa = await workbench.invoke({ path: "/api/auto-qa", method: "POST", body: { projectId: snapshot.projectId, locale: "zh-CN", source: "設定を保存します。", translation: "保存设置。", resourceContext: [{ path: guide.path, hash: guide.hash, text: "独立审校同样查阅原始 PDF，按钮使用保存。" }] } }, context);
    assert.match(qa.styleProfile.instruction, /独立审校同样查阅原始 PDF/);
    await writeFile(join(cwd, "风格.pdf"), "changed original");
    await assert.rejects(workbench.importFile({ path: "source.txt", resourceContext: [{ path: guide.path, hash: guide.hash, text: "stale" }] }, context), /变化|版本/);
    assert.equal(await readFile(join(cwd, "风格.pdf"), "utf8"), "changed original");
  } finally {
    await workbench.close(); await close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local batches accept files above the server upload cap and more than 2000 segments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-local-batch-"));
  const { fs, close } = await workspaceFs();
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async () => ({ content: "译文" }) });
  const context = { cwd: directory, fs, human: true, signal: new AbortController().signal };
  try {
    await workbench.workspace({ action: "bind", name: "large local batch" }, context);
    const bytes = Buffer.from("設定。" + " ".repeat(33 * 1024 * 1024));
    await writeFile(join(directory, "large.txt"), bytes);
    const large = await workbench.importFile({ path: "large.txt" }, context);
    const snapshot = (await workbench.store.request(`/items/batch_runs/${large.batchId}`)).runner_options.workspaceSnapshot;
    assert.equal(snapshot.source.hash, createHash("sha256").update(bytes).digest("hex"));
    const direct = await workbench.invoke({ path: "/api/batch/prepare", method: "POST", body: { projectId: snapshot.projectId, locale: "zh-CN", filename: "native-large.txt", text: bytes.toString("utf8") + " ".repeat(16 * 1024 * 1024) } }, context);
    assert.equal(direct.segments.length, 1, "local in-process operations must not inherit the HTTP request-body cap");
    await writeFile(join(directory, "many.txt"), Array.from({ length: 2101 }, (_, index) => `文章${index}。`).join("\n"));
    const many = await workbench.importFile({ path: "many.txt" }, context);
    assert.equal(many.segments.length, 2101);
  } finally {
    await workbench.close(); await close();
    await rm(directory, { recursive: true, force: true });
  }
});

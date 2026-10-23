import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function modelModule() {
  const modules = new Map();
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: ({ id, chunk, factory }) => modules.set(chunk ? `${id}/${chunk}` : id, factory) } },
    URLSearchParams, Date, Map, Set, Error, Number, Promise
  });
  assert.ok(modules.has("kami-dsh/client.workbench-state.js"), "the workbench must supply its state controller");
  return modules.get("kami-dsh/client.workbench-state.js")();
}

function fixture(WorkbenchModel) {
  let root = "D:/工作区甲", active = "ready";
  const runs = {
    old: { batchId: "old", filename: "旧任务.txt", runState: "completed", segments: [{ id: "s", source: "保存", translation: "旧译文", status: "done" }], workflow: { writeBusy: false } },
    next: { batchId: "next", filename: "新任务.txt", runState: "ready", segments: [], workflow: { writeBusy: false } }
  };
  const calls = [];
  const call = async (session, operation) => {
    calls.push({ session, ...operation });
    if (operation.action === "workspace") return { workspace: root, isKamiSession: true, config: { projectId: "p", styleGuides: [] }, project: { id: "p", name: "项目" } };
    if (operation.path === "/api/projects") return { projects: [{ id: "p", name: "项目" }] };
    if (operation.path.startsWith("/api/batch/files")) return { files: [{ batchId: "old", runState: "completed", updatedAt: "2026-10-20" }, { batchId: "next", runState: active, updatedAt: "2026-10-21" }] };
    if (operation.path.startsWith("/api/tasks")) return [{ id: "background", type: "background", status: "needs_attention" }];
    if (operation.path.startsWith("/api/batch/run/")) return structuredClone(runs[operation.path.split("/")[4].split("?")[0]]);
    if (operation.path === "/api/batch/run") {
      runs[operation.body.batchId] = { ...runs[operation.body.batchId], ...structuredClone(operation.body) };
      return runs[operation.body.batchId];
    }
    return {};
  };
  const model = new WorkbenchModel({ sessionId: "kami-session", call });
  return { model, runs, calls, switchRoot: () => { root = root === "D:/工作区甲" ? "D:/工作区乙" : "D:/工作区甲"; }, activate: () => { active = "running"; } };
}

test("task selection prefers active batches and preserves a manual selection", async () => {
  const { chooseBatch } = await modelModule();
  const files = [{ batchId: "new", updatedAt: "2026-10-23", runState: "completed" }, { batchId: "running", updatedAt: "2026-10-21", runState: "running" }];
  assert.equal(chooseBatch(files), "running");
  assert.equal(chooseBatch(files, "new", true), "new");
  assert.equal(chooseBatch(files.slice(0, 1)), "new");
});

test("same-name batches have distinct visible labels and a switch shows one draft notice", async () => {
  const { WorkbenchModel, batchLabel } = await modelModule();
  assert.notEqual(batchLabel({ filename: "dialogue.docx", batchId: "batch-01" }, "已完成"), batchLabel({ filename: "dialogue.docx", batchId: "batch-02" }, "已完成"));
  const f = fixture(WorkbenchModel);
  await f.model.refresh(); await f.model.select("old");
  assert.equal(f.model.draftNotice(), "");
  f.model.edit("s", "验收草稿");
  assert.equal(f.model.draftNotice(), "draft");
  await f.model.select("next");
  assert.equal(f.model.draftNotice(), "switch");
  f.model.cancelSelection();
  assert.equal(f.model.draftNotice(), "draft");
});

test("QA labels never turn null scores or deterministic checks into model QA success", async () => {
  const { qaLabel, editingLocked, reportScore } = await modelModule();
  assert.equal(qaLabel({ result: { qaScore: null } }), "尚未执行 QA");
  assert.equal(qaLabel({ result: { aiQa: { status: "deterministic_only", score: null } } }), "规则检查");
  assert.equal(qaLabel({ result: { aiQa: { used: true, score: 93 } } }), "模型 QA · 93");
  assert.equal(qaLabel({ result: { aiQa: { score: 100, fallbackReason: "timeout" } } }), "QA 未完成");
  assert.equal(qaLabel({ accepted: true, result: { humanReview: { source: "external-review-import" }, aiQa: { used: false } } }), "memoQ 人工终稿");
  assert.equal(editingLocked({ runState: "paused", workflow: { writeBusy: true } }), true, "pause must wait for the active segment to settle");
  assert.equal(editingLocked({ runState: "completed", workflow: { qaRetryBusy: true } }), true);
  assert.equal(reportScore({ sourceKind: "batch", scores: { overall: 100 }, segments: [{ qaScore: null, aiQaStatus: "deterministic_only" }] }), null);
  assert.equal(reportScore({ sourceKind: "batch", scores: { overall: 100 }, segments: [{ qaScore: null, aiQaStatus: "" }] }), null);
  assert.equal(reportScore({ scores: { overall: 100 }, segments: [{ fallbackReason: "timeout" }] }), null);
});

test("QA stage follows current segment results and a manual check stays visibly active", async () => {
  const { qaSummary } = await modelModule();
  const segment = (aiQa) => ({ status: "done", translation: "译文", result: { aiQa } });
  const run = { segments: [segment({ used: true, score: 99 }), segment({ used: true, score: 100 })], workflow: { aiQa: { status: "completed", message: "0 段 AIQA 已检查" } } };
  assert.deepEqual(JSON.parse(JSON.stringify(qaSummary(run))), { model: 2, rules: 0, human: 0, incomplete: 0, busy: false, label: "已完成" });
  assert.equal(qaSummary(run, true).label, "正在处理");
  assert.equal(qaSummary(run, true).busy, true);
  run.segments[0].result.aiQa = { status: "not_run", used: false, score: null };
  assert.equal(qaSummary(run).label, "QA 未完成");
  assert.equal(qaSummary(run).incomplete, 1);
  run.segments[1].result.aiQa = { used: true, score: 100, fallbackReason: "timeout" };
  assert.equal(qaSummary(run).label, "QA 未完成");
  run.segments = [segment({ status: "deterministic_only", used: false, score: null })];
  assert.equal(qaSummary(run).label, "规则检查");
  run.segments = [segment({ status: "not_run", used: false, score: null })];
  assert.equal(qaSummary(run).label, "尚未执行 QA");
});

test("manual QA survives reopening and never attaches to a translation changed during the check", async () => {
  const { WorkbenchModel, qaLabel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh(); await f.model.select("old");
  const report = { segments: [{ source: "保存", translation: "旧译文", scores: { overall: 93 }, issues: [{ severity: "minor", message: "术语不一致" }] }] };
  await f.model.saveQaResults(report);
  const reopened = new WorkbenchModel({ sessionId: "reopened", call: f.model.call });
  await reopened.refresh(); await reopened.select("old");
  assert.equal(qaLabel(reopened.displayRun().segments[0]), "模型 QA · 93");
  assert.equal(reopened.displayRun().segments[0].result.issues[0].message, "术语不一致");
  assert.notEqual(reopened.displayRun().segments[0].accepted, true, "QA must not approve a translation");
  f.runs.old.segments[0] = { ...f.runs.old.segments[0], translation: "另一会话的新译文", result: null };
  await f.model.saveQaResults(report);
  assert.equal(f.runs.old.segments[0].translation, "另一会话的新译文");
  assert.equal(f.runs.old.segments[0].result, null, "a stale report must not check a different target");
  f.runs.old.workflow.writeBusy = true;
  await assert.rejects(f.model.saveQaResults(report), /尚未结束/);
});

test("polling discovers agent-created batches without switching a manually reviewed task", async () => {
  const { WorkbenchModel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh();
  assert.equal(f.model.view.selectedId, "next");
  await f.model.select("old");
  f.activate();
  await f.model.refresh();
  assert.equal(f.model.view.selectedId, "old");
  assert.equal(f.model.view.files.find((file) => file.batchId === "next").runState, "running");
  assert.equal(f.model.view.tasks[0].status, "needs_attention");
});

test("drafts survive refresh and external workspace switches; switching batches requires a decision", async () => {
  const { WorkbenchModel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh();
  await f.model.select("old");
  f.model.edit("s", "人工草稿");
  f.runs.old.segments[0].translation = "服务器新版";
  await f.model.refresh();
  assert.equal(f.model.displayRun().segments[0].translation, "人工草稿");
  await f.model.select("next");
  assert.equal(f.model.view.selectedId, "old");
  assert.equal(f.model.view.pendingSelection, "next");
  f.model.cancelSelection();
  f.switchRoot(); await f.model.refresh();
  assert.equal(f.model.dirty(), false);
  f.switchRoot(); await f.model.refresh();
  assert.equal(f.model.displayRun().segments[0].translation, "人工草稿");
  const result = await f.model.save();
  assert.equal(result.ok, true);
  assert.equal(f.runs.old.segments[0].translation, "人工草稿");
  assert.equal(f.model.dirty(), false);
  const save = f.calls.find((call) => call.path === "/api/batch/run");
  assert.equal(save.expectedWorkspace, "D:/工作区甲");
  assert.equal(save.body.runState, undefined, "saving must not overwrite runner state from a stale view");
});

test("hidden views drop in-flight reads, keep drafts, and stop requesting data", async () => {
  const { WorkbenchModel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh(); await f.model.select("old");
  f.model.edit("s", "保留草稿");
  let release;
  const before = f.model.call;
  f.model.call = async (...args) => {
    if (args[1].path?.startsWith("/api/batch/run/old")) return new Promise((resolve) => { release = resolve; });
    return before(...args);
  };
  const read = f.model.loadRun();
  await new Promise((resolve) => setImmediate(resolve));
  f.model.setVisible(false);
  release({ batchId: "old", segments: [{ id: "s", translation: "过期结果" }] });
  await read;
  const count = f.calls.length;
  await f.model.refresh();
  assert.equal(f.calls.length, count);
  assert.equal(f.model.displayRun().segments[0].translation, "保留草稿");
});

test("a late response cannot update another workspace and local action failures stay local", async () => {
  const { WorkbenchModel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh();
  let release;
  const stale = f.model.perform("preview", () => new Promise((resolve) => { release = resolve; }));
  f.switchRoot(); await f.model.refresh();
  release("old preview");
  await stale;
  assert.equal(f.model.view.operations.preview, undefined);
  await f.model.perform("export", async () => { throw new Error("EEXIST"); });
  assert.equal(f.model.view.operations.export.error, "EEXIST");
  assert.equal(f.model.view.operations.save, undefined);
  assert.equal(f.model.connected, true);
});

test("new batches produce a notice while a reviewed batch stays pinned", async () => {
  const { WorkbenchModel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh(); await f.model.select("old");
  const before = f.model.call;
  f.model.call = async (...args) => {
    const value = await before(...args);
    if (args[1].path?.startsWith("/api/batch/files")) value.files.push({ batchId: "agent-created", runState: "running", updatedAt: "2026-10-23" });
    return value;
  };
  await f.model.refresh();
  assert.equal(f.model.view.selectedId, "old");
  assert.deepEqual([...f.model.view.newBatches], ["agent-created"]);
});

test("a server-side worker start preserves an unsaved draft and fails only its save operation", async () => {
  const { WorkbenchModel } = await modelModule();
  const f = fixture(WorkbenchModel);
  await f.model.refresh(); await f.model.select("old");
  f.model.edit("s", "保留这个终稿");
  f.runs.old.workflow.writeBusy = true;
  assert.equal((await f.model.save()).ok, false);
  assert.equal(f.model.dirty(), true);
  assert.match(f.model.view.operations.save.error, /尚未结束/);
  assert.equal(f.calls.some((call) => call.path === "/api/batch/run"), false);
});

test("two session controllers and out-of-order resource previews stay isolated", async () => {
  const { WorkbenchModel } = await modelModule();
  const a = fixture(WorkbenchModel), b = fixture(WorkbenchModel);
  await a.model.refresh(); await b.model.refresh();
  await a.model.select("old"); a.model.edit("s", "会话甲草稿");
  assert.equal(b.model.dirty(), false);
  let release;
  const first = a.model.loadSection("preview", () => new Promise((resolve) => { release = resolve; }));
  await a.model.loadSection("preview", async () => ({ path: "new.md", preview: "最新预览" }));
  release({ path: "old.md", preview: "过期预览" }); await first;
  assert.equal(a.model.view.sections.preview.path, "new.md");
  assert.equal(b.model.view.sections.preview, undefined);
  b.model.setVisible(false);
  const count = b.calls.length; await b.model.refresh();
  assert.equal(b.calls.length, count);
});

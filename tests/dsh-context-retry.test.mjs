import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveBatchRun } from "../src/store.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("context retries persist failures, reuse active work and use the newly selected model without changing translations", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-context-retry-")), cwd = join(directory, "workspace");
  await mkdir(cwd); await writeFile(join(cwd, "source.txt"), "設定");
  const { fs, close } = await workspaceFs();
  let mode = "failed", release;
  let gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    calls.push(options.route); await gate;
    const entries = JSON.parse(messages.find((message) => message.role === "user").content.split("\n").at(-1));
    if (mode === "failed" || mode === "partial" && entries[0].i > 100) throw new Error("语境请求失败探针");
    return { content: JSON.stringify({ documentType: { purpose: "ui", summary: "设置菜单" }, sections: [{ from: entries[0].i, to: entries.at(-1).i, purpose: "ui" }], notes: [], crossRefs: [] }) };
  } });
  const context = { cwd, fs, human: true, modelRoute: { provider: "before", model: "old", reasoningEffort: "high" } };
  try {
    await workbench.workspace({ action: "bind", name: "语境重试" }, context);
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    const path = `/api/batch/run/${prepared.batchId}`;
    const run = await workbench.invoke({ path }, context);
    const segments = Array.from({ length: 101 }, (_, i) => ({ ...run.segments[0], id: `s${i + 1}`, index: i + 1, translation: "保留现有译文", status: "done" }));
    await saveBatchRun({ ...run, segments });
    const invoke = (method = "GET") => workbench.invoke({ path: `${path}/context-brief`, method }, context);
    const settled = async () => {
      for (let i = 0; i < 200; i++) { const value = await invoke(); if (!value.pending) return value; await setTimeout(10); }
      throw new Error("context analysis did not settle");
    };
    assert.equal((await invoke("POST")).pending, true);
    assert.equal((await invoke("POST")).alreadyRunning, true);
    release();
    const failed = await settled();
    assert.equal(failed.brief.status, "failed"); assert.match(failed.brief.warning, /语境请求失败探针/);
    assert.equal(calls.length, 2);
    context.modelRoute = { provider: "after", model: "new", reasoningEffort: "low" };
    gate = Promise.resolve(); mode = "partial";
    await invoke("POST");
    const partial = await settled();
    assert.equal(partial.brief.coverage.covered, 100); assert.match(partial.brief.warning, /1 片分析失败/);
    const tasks = await workbench.store.request("/items/background_tasks");
    assert.equal(tasks.filter((task) => task.type === "context_analysis").every((task) => task.status === "failed"), true, "partial coverage must not be recorded as successful completion");
    mode = "ready"; await invoke("POST");
    const ready = await settled();
    assert.equal(ready.brief.status, "ready"); assert.equal(ready.brief.coverage.covered, 101); assert.ok(!ready.brief.warning);
    assert.ok(calls.slice(2).every((route) => route.model === "new" && route.reasoningEffort === "low"));
    assert.deepEqual((await workbench.invoke({ path }, context)).segments.map((segment) => segment.translation), segments.map((segment) => segment.translation));
  } finally { release(); await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

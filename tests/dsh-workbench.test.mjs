import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbench } from "../dsh/workbench.mjs";
import { SqliteStore } from "../src/sqlite-store.mjs";

test("embedded workbench translates and exports a file without HTTP and survives DB reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-dsh-test-"));
  const modelCalls = [];
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async (_messages, options) => { modelCalls.push(options); return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : "保存设置。" }; } });
  try {
    const context = { human: true };
    const created = await workbench.invoke({ method: "POST", path: "/api/projects", body: { name: "隔离验证" } }, context);
    const projectId = created.project.id;
    assert.equal(created.libraries.length, 3);
    const prepared = await workbench.invoke({ method: "POST", path: "/api/batch/prepare", body: { projectId, filename: "test.txt", text: "設定を保存します。", locale: "zh-CN" } }, context);
    assert.equal(prepared.segments.length, 1);
    const run = await workbench.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${projectId}` }, context);
    let value = run.run || run;
    assert.equal(value.projectId, projectId);
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => { throw new Error("Legacy HTTP callback was used"); };
      await workbench.invoke({ method: "POST", path: `/api/batch/run/${prepared.batchId}/start`, body: { projectId } }, { ...context, modelRoute: { provider: "dsh-test", model: "isolated-model" } });
      const deadline = Date.now() + 5_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 20));
        value = await workbench.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${projectId}` }, context);
        value = value.run || value;
      } while (["running", "queued"].includes(value.runState) && Date.now() < deadline);
      assert.equal(value.segments[0].status, "done", value.segments[0].error);
      assert.equal(value.segments[0].translation, "保存设置。");
      assert.ok(modelCalls.length > 0);
      assert.ok(modelCalls.every((call) => call.route.model === "isolated-model"));
    } finally { globalThis.fetch = previousFetch; }
    const segments = value.segments.map((segment) => ({ ...segment, translation: "保存设置。", status: "done" }));
    await workbench.invoke({ method: "POST", path: "/api/batch/run", body: { ...value, segments } }, context);
    const exported = await workbench.invoke({ method: "POST", path: "/api/batch/export", body: { ...value, segments, mode: "writeback", locale: "zh-CN" } }, context);
    assert.equal(Buffer.from(exported.base64, "base64").toString(), "保存设置。");
    const assets = await workbench.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=term&locale=zh-CN` }, context);
    assert.equal(assets.total, 0);
    await assert.rejects(workbench.invoke({ method: "POST", path: "/api/feedback/accept", body: {} }), /human/);
    assert.equal(workbench.store.integrity()[0].integrity_check, "ok");
    const backup = await workbench.backup();
    assert.ok(backup.path.endsWith(".sqlite"));
    const saved = await workbench.saveExport(exported);
    assert.ok(saved.path.includes("exports"));
    await assert.rejects(workbench.invoke({ path: `/api/learning?projectId=${projectId}&project=another` }, context), /Conflicting project/);
    await workbench.close();
    const reopened = new SqliteStore(join(directory, "kami.sqlite"));
    try { assert.equal(reopened.integrity()[0].integrity_check, "ok"); assert.equal((await reopened.request(`/items/localization_projects/${projectId}`)).id, projectId); }
    finally { reopened.close(); }
  } finally {
    await workbench.close();
    await rm(directory, { recursive: true, force: true });
  }
});

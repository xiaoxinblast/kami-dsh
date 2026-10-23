import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveMemories } from "../src/store.mjs";

test("library file pages and quality-gate requests stay in the selected project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-library-nav-"));
  const workbench = await createWorkbench({ dataDirectory: directory });
  const context = { human: true };
  try {
    const created = await workbench.invoke({ method: "POST", path: "/api/projects", body: { name: "navigation" } }, context);
    const projectId = created.project.id, libraryId = created.libraries.find((item) => item.role === "master").id;
    await saveMemories("zh-CN", Array.from({ length: 25 }, (_, index) => ({ source: `原文${index}`, target: `译文${index}`, sourceFile: `file-${String(index).padStart(2, "0")}.docx`, projectId, libraryId, qualityStatus: "human_approved", contentType: "general", domain: "general" })));
    const query = new URLSearchParams({ projectId, libraryId, locale: "zh-CN", limit: "20", offset: "20" });
    const files = await workbench.invoke({ path: `/api/library-files?${query}` }, context);
    assert.equal(files.total, 25); assert.equal(files.files.length, 5);
    query.set("search", "file-0"); query.set("offset", "0");
    const search = await workbench.invoke({ path: `/api/library-files?${query}` }, context);
    assert.equal(search.total, 10); assert.equal(search.files.length, 10);
    const entries = await workbench.invoke({ path: `/api/library-entries?${new URLSearchParams({ projectId, libraryId, locale: "zh-CN", kind: "tm", sourceFile: search.files[0].sourceFile })}` }, context);
    assert.equal(entries.total, 1);
    const assets = await workbench.invoke({ path: `/api/quality/assets?projectId=${projectId}&locale=zh-CN` }, context);
    assert.equal(assets.scope.project, projectId);
    const learning = await workbench.invoke({ path: `/api/learning?projectId=${projectId}&locale=zh-CN&contentType=general&domain=general` }, context);
    assert.equal(learning.champion.status, "champion");
    await assert.rejects(workbench.invoke({ path: `/api/quality/gate?projectId=${projectId}&project=other&locale=zh-CN` }, context), /Conflicting project/);
  } finally {
    await workbench.close(); await rm(directory, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function stateModule() {
  const modules = new Map();
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), { window: { __ModuleLoader__: { load: ({ chunk, factory }) => modules.set(chunk, factory) } }, URLSearchParams });
  return modules.get("client.workbench-state.js")();
}

test("asset library links and priority changes remain scoped to their purpose", async () => {
  const { linkedPaths, resourceSelection, libraryPriorityChanges } = await stateModule();
  const libraries = [{ id: "main", priority: 1, enabled: true }, { id: "ref", priority: 3, enabled: false }, { id: "last", priority: 8, enabled: true }];
  const config = { terms: ["shared.csv"], translationMemories: ["shared.csv", "other.csv"], references: ["story.pdf"], libraryFiles: [{ path: "shared.csv", purpose: "terms", libraryId: "main" }, { path: "shared.csv", purpose: "tm", libraryId: "ref" }, { path: "other.csv", purpose: "tm", libraryId: "last" }] };
  assert.deepEqual(Array.from(linkedPaths(config, "terms", "main")), ["shared.csv"]);
  assert.deepEqual(Array.from(linkedPaths(config, "tm", "ref")), ["shared.csv"]);
  assert.deepEqual(Array.from(resourceSelection(config, libraries).translationMemories), ["other.csv"]);
  const changes = libraryPriorityChanges(libraries, "last", -1);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ id: "main", priority: 1 }, { id: "last", priority: 2 }, { id: "ref", priority: 3 }]);
  assert.equal(libraryPriorityChanges(libraries, "main", -1).length, 0);
  assert.equal(libraries[2].priority, 8, "computing a move must not mutate the current catalog");
});

test("5000 review segments stay paged, searchable and selectable without opening every editor", async () => {
  const { reviewPage } = await stateModule();
  const segments = Array.from({ length: 5000 }, (_, index) => ({ id: `s${index}`, source: `原文${index}`, translation: index === 4201 ? "查找目标" : "译文", result: index === 4201 ? { issues: [{ message: "核对" }] } : {} }));
  const page = reviewPage(segments, { offset: 4200, selectedId: "s4201" });
  assert.equal(page.total, 5000); assert.equal(page.items.length, 20);
  assert.equal(page.selected.segment.id, "s4201"); assert.equal(page.selected.number, 4202);
  const search = reviewPage(segments, { query: "查找目标", offset: 9000 });
  assert.equal(search.total, 1); assert.equal(search.offset, 0); assert.equal(search.selected.segment.id, "s4201");
  assert.equal(reviewPage(segments, { filter: "issues" }).total, 1);
  assert.equal(reviewPage(segments, { query: "不存在" }).selected, undefined);
  segments[4201].draft = true;
  assert.equal(reviewPage(segments, { query: "已经修改的筛选词", selectedId: "s4201" }).selected.segment.id, "s4201", "editing a search match must not remove the active draft from the editor");
});

test("linked local resources browse directories and search across nested files", async () => {
  const { resourcePage } = await stateModule();
  const paths = ["root.pdf", "rules/style.docx", "rules/nested/game.pdf", "rules/terms.xlsx"];
  const root = resourcePage(paths, {});
  assert.equal(root.items.length, 2);
  assert.equal(root.items.find((item) => item.folder).count, 3);
  assert.equal(resourcePage(paths, { folder: "rules/" }).total, 3);
  const searched = resourcePage(paths, { query: "game" });
  assert.equal(searched.items[0].path, "rules/nested/game.pdf");
});

test("promotion requires a matching evaluation and a current gate for the selected candidate", async () => {
  const { promotionReady } = await stateModule();
  const evaluation = { challengerSkillId: "chosen", decision: "promote", report: { promotable: true } };
  const gate = { latestRun: { skillId: "chosen", decision: "pass" }, assets: { coverage: { valid: true } } };
  assert.equal(promotionReady(evaluation, gate, "chosen"), true);
  assert.equal(promotionReady(evaluation, gate, "other"), false);
  assert.equal(promotionReady(evaluation, { ...gate, assets: { coverage: { valid: false } } }, "chosen"), false);
  assert.equal(promotionReady({ ...evaluation, decision: "needs_review" }, gate, "chosen"), false);
});

test("file reading and review requests use the current session with separate operation feedback", async () => {
  const { WorkbenchModel } = await stateModule();
  const calls = [];
  const model = new WorkbenchModel({ sessionId: "current", call: async () => ({}), prompt: async (...args) => calls.push(args) });
  model.view.workspace = "D:/fixture";
  assert.equal((await model.ask("查看原文件", "read-reference")).ok, true);
  assert.equal((await model.ask("审校译文", "review-text")).ok, true);
  assert.deepEqual(calls, [["current", "查看原文件", "D:/fixture"], ["current", "审校译文", "D:/fixture"]]);
  assert.equal(model.view.operations["read-reference"].pending, false);
  assert.equal(model.view.operations["review-text"].pending, false);
  assert.equal(model.view.operations["agent-read"], undefined);
});

test("resource compilation requests let the current agent understand originals and save reusable results", async () => {
  const { WorkbenchModel } = await stateModule(), calls = [];
  const model = new WorkbenchModel({ sessionId: "current", call: async () => ({ groups: [{ purpose: "style-guide", updatePath: ".kami/compiled/style.json", files: [{ path: "rules/guide.docx", hash: "a".repeat(64), status: "pending" }] }], failures: [] }), prompt: async (...args) => calls.push(args) });
  model.view.workspace = "D:/fixture";
  const result = await model.compileResource({ path: "rules/guide.docx", purpose: "style-guide", hash: "a".repeat(64) });
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], "current"); assert.equal(calls[0][2], "D:/fixture");
  for (const text of ["rules/guide.docx", "理解原文件", "固定模板", "compiledPath", "compilation.status=ready", "例外和正反例"]) assert.ok(calls[0][1].includes(text));
  assert.equal(model.view.operations["agent-compile:style-guide:rules/guide.docx"].pending, false);
});

test("batch compilation submits one agent task, skips unchanged files, and keeps library updates together", async () => {
  const { WorkbenchModel } = await stateModule(), prompts = [], calls = [];
  const model = new WorkbenchModel({ sessionId: "current", call: async (_session, operation) => {
    calls.push(operation);
    return { groups: [{ purpose: "tm", libraryId: "memory", libraryName: "项目 TM", updatePath: ".kami/compiled/memory.json", files: [
      { path: "old.xlsx", hash: "a".repeat(64), status: "ready" }, { path: "new.xlsx", hash: "b".repeat(64), status: "pending" }
    ] }, { purpose: "style-guide", libraryId: "", updatePath: ".kami/compiled/style.json", files: [{ path: "style.docx", hash: "c".repeat(64), status: "pending" }] }], failures: [] };
  }, prompt: async (...args) => prompts.push(args) });
  model.view.workspace = "D:/fixture";
  const selection = [{ path: "new.xlsx", purpose: "tm", libraryId: "memory" }, { path: "style.docx", purpose: "style-guide" }];
  assert.equal((await model.compileResources(selection, "compile-selected")).ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].actionType, "compilations");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].selection)), selection);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0][1].includes("new.xlsx")); assert.ok(prompts[0][1].includes("style.docx"));
  assert.ok(!prompts[0][1].includes("old.xlsx"));
  assert.ok(prompts[0][1].includes("保留未选中")); assert.ok(prompts[0][1].includes("每个库"));
  assert.equal(model.view.operations["compile-selected"].compilation.queued, 2);
  assert.equal(model.view.operations["compile-selected"].compilation.skipped, 1);
});

test("batch compilation never queues work after its workspace changes", async () => {
  const { WorkbenchModel } = await stateModule();
  let release, prompts = 0;
  const model = new WorkbenchModel({ sessionId: "current", call: () => new Promise((resolve) => { release = resolve; }), prompt: async () => { prompts++; } });
  model.view.workspace = "D:/first";
  const pending = model.compileResources(undefined, "compile-all");
  model.epoch++;
  release({ groups: [], failures: [] });
  assert.equal((await pending).ok, false); assert.equal(prompts, 0);
});

test("default learning labels show the project name while preserving user-named candidates", async () => {
  const { skillLabel } = await stateModule();
  assert.equal(skillLabel({ name: "zh-CN · general · project-id", locale: "zh-CN", version: 2 }, "项目甲", "project-id"), "项目甲 · v2");
  assert.equal(skillLabel({ name: "人名与称呼修订", locale: "zh-CN", version: 3 }, "项目甲", "project-id"), "人名与称呼修订");
});

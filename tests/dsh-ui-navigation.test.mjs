import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function stateModule() {
  const modules = new Map();
  vm.runInNewContext(await readFile(new URL("../dsh/client.js", import.meta.url), "utf8"), { window: { __ModuleLoader__: { load: ({ chunk, factory }) => modules.set(chunk, factory) } }, URLSearchParams });
  return modules.get("client.workbench-state.js")();
}

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

test("default learning labels show the project name while preserving user-named candidates", async () => {
  const { skillLabel } = await stateModule();
  assert.equal(skillLabel({ name: "zh-CN · general · project-id", locale: "zh-CN", version: 2 }, "项目甲", "project-id"), "项目甲 · v2");
  assert.equal(skillLabel({ name: "人名与称呼修订", locale: "zh-CN", version: 3 }, "项目甲", "project-id"), "人名与称呼修订");
});

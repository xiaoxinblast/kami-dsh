import test from "node:test";
import assert from "node:assert/strict";

import { groupTaskEntries, taskEntryStatus } from "../public/task-groups.js";

function task(id, overrides = {}) {
  return {
    id,
    type: "background",
    taskType: "reference_ingest",
    status: "needs_attention",
    projectId: "p1",
    title: `任务 ${id}`,
    createdAt: "2026-10-23T09:35:40.000Z",
    updatedAt: "2026-10-23T09:45:00.000Z",
    payload: {},
    ...overrides
  };
}

test("同类型、同一批上传的后台任务聚合成一个组", () => {
  const tasks = [
    task("a", { createdAt: "2026-10-23T09:35:40.000Z" }),
    task("b", { createdAt: "2026-10-23T09:35:41.000Z" }),
    task("c", { createdAt: "2026-10-23T09:35:42.000Z" })
  ];
  const entries = groupTaskEntries(tasks, { labelFor: () => "参考资料导入" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "group");
  assert.equal(entries[0].title, "参考资料导入 · 3 个文件");
  assert.deepEqual(entries[0].tasks.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(entries[0].summary.attention, 3);
});

test("间隔超过窗口的上传拆成两组；单条不聚合", () => {
  const tasks = [
    task("old", { createdAt: "2026-10-23T09:00:00.000Z" }),
    task("new1", { createdAt: "2026-10-23T10:00:00.000Z" }),
    task("new2", { createdAt: "2026-10-23T10:00:01.000Z" })
  ];
  const entries = groupTaskEntries(tasks);
  const groups = entries.filter((entry) => entry.kind === "group");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tasks.map((item) => item.id), ["new1", "new2"]);
  assert.ok(entries.some((entry) => entry.id === "old"), "单条任务保持平铺");
});

test("显式 groupId 跨时间也合成一组；组状态按最需要处理的状态显示", () => {
  const tasks = [
    task("a", { status: "completed", payload: { groupId: "g1" }, createdAt: "2026-10-23T09:00:00.000Z" }),
    task("b", { status: "in_progress", payload: { groupId: "g1" }, createdAt: "2026-10-23T11:00:00.000Z" })
  ];
  const entries = groupTaskEntries(tasks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "group:g1");
  assert.equal(taskEntryStatus(entries[0]), "in_progress");
});

test("批次与质检任务不参与后台任务分组", () => {
  const tasks = [
    { id: "batch1", type: "batch", status: "completed", createdAt: "2026-10-23T09:00:00.000Z" },
    { id: "qa1", type: "autoqa", status: "completed", createdAt: "2026-10-23T09:00:00.000Z" }
  ];
  const entries = groupTaskEntries(tasks);
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ["batch1", "qa1"]);
});

test("聚合组按最近更新时间排前", () => {
  const tasks = [
    task("old", { createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:30:00.000Z" }),
    task("n1", { createdAt: "2026-10-23T09:00:00.000Z", updatedAt: "2026-10-23T09:30:00.000Z" }),
    task("n2", { createdAt: "2026-10-23T09:00:01.000Z", updatedAt: "2026-10-23T09:40:00.000Z" })
  ];
  const entries = groupTaskEntries(tasks);
  assert.equal(entries[0].kind, "group");
  assert.equal(entries[0].tasks.at(-1).id, "n2");
});

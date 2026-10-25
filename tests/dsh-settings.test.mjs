import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { runQa } from "../src/qa.mjs";

test("project QA switches persist across Host restart, affect checks and stay project scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-settings-")), context = { human: true };
  let workbench = await createWorkbench({ dataDirectory: directory });
  try {
    const first = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "规则项目" } }, context);
    const second = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "其他项目" } }, context);
    const path = `/api/projects/${first.project.id}`;
    const project = await workbench.invoke({ path }, context);
    const input = { source: "10個保存します。", translation: "保存20个。", locale: "zh-CN" };
    assert.ok(runQa({ ...input, projectSettings: project.settings }).some((issue) => issue.type === "number_drift"));
    project.settings.tm.catMinFuzzy = 77;
    project.settings.qa.rules.number_parity = { enabled: false, severity: "info" };
    project.settings.qa.rules.non_break_tag_structure = { enabled: false, severity: "info" };
    await workbench.invoke({ path, method: "PATCH", body: { settings: project.settings } }, context);
    await workbench.close();
    workbench = await createWorkbench({ dataDirectory: directory });
    const saved = await workbench.invoke({ path }, context);
    assert.deepEqual(saved.settings.qa.rules.number_parity, { enabled: false, severity: "info" });
    assert.deepEqual(saved.settings.qa.rules.non_break_tag_structure, { enabled: true, severity: "error" });
    assert.equal(saved.settings.tm.catMinFuzzy, 77);
    assert.ok(!runQa({ ...input, projectSettings: saved.settings }).some((issue) => issue.type === "number_drift"));
    const untouched = await workbench.invoke({ path: `/api/projects/${second.project.id}` }, context);
    assert.equal(untouched.settings.qa.rules.number_parity.enabled, true);
    saved.settings.qa.rules.number_parity.enabled = true;
    const enabled = await workbench.invoke({ path, method: "PATCH", body: { settings: saved.settings } }, context);
    assert.equal(runQa({ ...input, projectSettings: enabled.settings }).find((issue) => issue.type === "number_drift").severity, "info");
  } finally {
    await workbench.close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-settings-")));
    await rm(directory, { recursive: true, force: true });
  }
});

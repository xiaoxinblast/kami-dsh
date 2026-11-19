import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { runtimeOptions } from "../src/runtime-context.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("新机器稿超过一千条后仍从全部人工终稿生成策略、排除训练原文并评测", async () => {
  const root = await mkdtemp(join(tmpdir(), "kami-older-human-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs();
  const calls = [];
  const wb = await createWorkbench({ dataDirectory: join(root, "data"), modelAdapter: async (messages, options) => {
    calls.push(options.requestLabel);
    assert.equal(options.requestLabel, "翻译技能复盘");
    const items = JSON.parse(messages.at(-1).content).trajectories;
    assert.equal(items.length, 10);
    assert.ok(items.every(row => row.initialTranslation === "初译" && row.qaAfter.score === 96));
    return { content: JSON.stringify({
      name: "候选", reason: "人工修改", strategyPatch: { prompting: { additionalRules: ["保留句末语气"] } },
      evidenceIds: items.map(row => row.id)
    }) };
  } });
  const context = { cwd, fs, human: true };
  try {
    const { project } = await wb.workspace({ action: "bind", name: "旧终稿" }, context);
    const scope = { locale: "zh-CN", projectId: project.id, contentType: "general", domain: "general" };
    const base = { project: project.id, target_locale: "zh-CN", content_type: "ui", domain: "game", status: "completed", final_translation: "终稿" };
    const human = { ...base, initial_translation: "初译", human_decision: { accepted: true, finalTranslation: "终稿" },
      qa_after: { score: 96 }, date_updated: "2025-01-01" };
    await runtimeOptions().store.request("/items/learning_trajectories", { method: "POST", body: [
      ...Array.from({ length: 25 }, (_, n) => ({ ...human, id: "human-" + n, source: "例文" + n, batch_id: "original-batch",
        asset_refs: { sourceFile: "old-reviewed.mqxliff" }, human_decision: { ...human.human_decision, machineTranslation: "旧版机器稿" } })),
      { ...human, id: "dup", source: "例文０" },
      { ...human, id: "foreign", project: "foreign", source: "其他项目" },
      ...Array.from({ length: 1020 }, (_, n) => ({ ...base, id: "machine-" + n, source: "未审" + n, date_updated: "2026-01-01" }))
    ] });
    const evidence = query => wb.invoke({ path: "/api/learning/evidence?" + new URLSearchParams({ ...scope, batchId: "original-batch", ...query }) }, context);
    const older = await evidence({ kind: "accepted", file: "old-reviewed.mqxliff", search: "旧版机器稿" });
    const last = await evidence({ offset: 20 });
    assert.deepEqual([older.total, older.items.length, older.hasMore, last.items.length, last.hasMore], [25, 20, true, 5, false]);
    assert.equal(new Set([...older.items, ...last.items].map(row => row.id)).size, 25);
    assert.equal(older.items[0].qaAfter.score, 96, "当前页显示完整轨迹归因证据");
    assert.equal((await evidence({ batchId: "", search: "其他项目" })).total, 0);
    assert.equal((await evidence({ skillId: "unknown-skill" })).total, 0);
    const post = path => wb.invoke({ path, method: "POST", body: scope }, context);
    const { skill } = await post("/api/learning/skills/generate");
    assert.equal(skill.evidenceIds.length, 10);
    const { evaluation } = await post(`/api/learning/skills/${skill.id}/evaluate`);
    assert.equal(evaluation.sampleCount, 15);
    assert.deepEqual(calls, ["翻译技能复盘"]);
  } finally {
    await wb.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

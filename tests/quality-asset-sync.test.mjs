import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { saveLearningTrajectory } from "../src/store.mjs";

test("自动并入新人工终稿时新建 Gold 版本，旧版退役且内容保持稳定", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-asset-sync-"));
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async () => ({ content: "" }) });
  // server.mjs 在 embedded 模式启动后才会通过存储校验，所以在 createWorkbench 之后再取模块。
  const { syncQualityAssets } = await import("../server.mjs");
  const context = { human: true };
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "资产同步" } }, context);
    const scope = { locale: "zh-CN", project: project.id, contentType: "general", domain: "general" };
    const accepted = (id, source) => saveLearningTrajectory({ ...scope, id, source, initialTranslation: `机器${id}`, finalTranslation: `终稿${id}`,
      status: "completed", humanDecision: { accepted: true, finalTranslation: `终稿${id}` }, assetRefs: { sourceFile: `资料/${id}.md` } });
    const activeAssets = () => workbench.invoke({ path: `/api/quality/assets?locale=zh-CN&projectId=${encodeURIComponent(project.id)}&contentType=general&domain=general` }, context);

    for (const id of ["a", "b", "c"]) await accepted(id, `原文-${id}`);
    const first = await syncQualityAssets(scope, { reason: "test" });
    assert.equal(first.gold.changed, true);
    assert.equal(first.gold.version, 1);
    assert.equal(first.gold.samples, 3);
    let rows = await activeAssets();
    assert.equal(rows.active.goldSampleCount, 3);
    assert.deepEqual(rows.active.goldSetVersions, [`gold:zh-CN:general:general:${project.id}@v1`]);

    await accepted("d", "原文-d");
    const second = await syncQualityAssets(scope, { reason: "test" });
    assert.equal(second.gold.changed, true);
    assert.equal(second.gold.version, 2);
    assert.equal(second.gold.samples, 4);
    rows = await activeAssets();
    assert.deepEqual(rows.active.goldSetVersions, [`gold:zh-CN:general:general:${project.id}@v2`]);
    const goldSets = [...rows.goldSets].sort((left, right) => Number(left.version) - Number(right.version));
    assert.equal(goldSets.filter((item) => item.enabled).length, 1, "同一族只允许一个当前基准");
    assert.equal(goldSets.at(-1).payload.samples.length, 4);
    assert.equal(goldSets.at(-1).payload.samples.filter((item) => item.source === "原文-a").length, 1, "同原文不重复收录");

    const third = await syncQualityAssets(scope, { reason: "test" });
    assert.equal(third.gold.changed, false);
    assert.equal(third.gold.version, 2);
  } finally {
    await workbench.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("手动运行门禁前也会先同步 Gold Set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-asset-manual-gate-"));
  const workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: async () => ({ content: "译文" }) });
  // server.mjs 在 embedded 模式启动后才会通过存储校验，所以在 createWorkbench 之后再取模块。
  await import("../server.mjs");
  const context = { human: true };
  try {
    const { project } = await workbench.invoke({ path: "/api/projects", method: "POST", body: { name: "手动门禁同步" } }, context);
    const scope = { locale: "zh-CN", project: project.id, contentType: "general", domain: "general" };
    for (const id of ["a", "b", "c"]) await saveLearningTrajectory({ ...scope, id, source: `原文-${id}`, initialTranslation: `机器${id}`, finalTranslation: `终稿${id}`,
      status: "completed", humanDecision: { accepted: true, finalTranslation: `终稿${id}` }, assetRefs: { sourceFile: `资料/${id}.md` } });
    // 没有先调用 syncQualityAssets：门禁入口必须自己同步。
    const started = await workbench.invoke({ path: "/api/quality/runs", method: "POST", body: { locale: "zh-CN", project: project.id, contentType: "general", domain: "general" } }, context);
    assert.ok(started.backgroundTaskId, "应进入后台门禁任务");
    assert.equal(started.total, 3, "门禁应读取刚同步的 Gold 样本");
    const rows = await workbench.invoke({ path: `/api/quality/assets?locale=zh-CN&projectId=${encodeURIComponent(project.id)}&contentType=general&domain=general` }, context);
    assert.equal(rows.active.goldSampleCount, 3);
    assert.deepEqual(rows.active.goldSetVersions, [`gold:zh-CN:general:general:${project.id}@v1`]);
  } finally {
    await workbench.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { saveAsset } from "../src/store.mjs";

const xml = (targets = ["", "", "保存。"]) => `<?xml version="1.0" encoding="UTF-8"?><xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:mq="MQXliff" version="1.2"><file original="story"><body>${["星屑結晶を使います。", "帰還します。", "保存します。"].map((source, index) => `<trans-unit id="${index + 1}"><source>${source}</source><target>${targets[index]}</target><context-group><context context-type="x-mmq-context">STORY_${index + 1}</context></context-group></trans-unit>`).join("")}</body></file></xliff>`;

test("关联人工 MQXLIFF 终稿同步完整 TM、原批次学习差异及人工修改后的术语，重复关联幂等", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-reviewed-final-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs();
  const calls = [];
  let entered, release, pendingReview;
  const alignmentStarted = new Promise((resolve) => { entered = resolve; });
  const alignmentGate = new Promise((resolve) => { release = resolve; });
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    calls.push(options.requestLabel);
    if (options.requestLabel === "术语对齐") {
      entered(); await alignmentGate;
      return { content: JSON.stringify({ matches: [{ source: "星屑結晶", found: true, target: "星屑晶石", confidence: 0.99 }, { source: "帰還", found: true, target: "返回", confidence: 0.99 }] }) };
    }
    if (options.requestLabel === "AIQA") return { content: '{"issues":[]}' };
    return { content: JSON.stringify(messages).includes("星屑結晶") ? "使用星尘结晶。" : "返航。" };
  } });
  const context = { cwd, fs, human: true };
  try {
    const state = await workbench.workspace({ action: "bind", name: "memoQ reviewed cycle" }, context), projectId = state.project.id;
    const master = state.libraries.find((library) => library.role === "master"), term = state.libraries.find((library) => library.kind === "term_base");
    await writeFile(join(cwd, "source.mqxliff"), xml());
    const prepared = await workbench.importFile({ path: "source.mqxliff" }, context);
    const segments = [];
    for (const segment of prepared.segments) {
      const result = await workbench.invoke({ path: "/api/translate", method: "POST", body: { projectId, batchId: prepared.batchId, segmentId: segment.id, locale: "zh-CN", source: segment.source, entryId: segment.locator.unitId, entryKey: segment.entryKey, qualityTier: "fast", segmentPurpose: "general", useModelClassification: false } }, context);
      segments.push({ ...segment, translation: result.translation, result, status: "done" });
    }
    await saveAsset("zh-CN", { source: "帰還", target: "返航", status: "approved", projectId, libraryId: term.id });
    await workbench.invoke({ path: "/api/batch/run", method: "POST", body: { batchId: prepared.batchId, projectId, segments, runState: "completed", runnerOptions: { termSurvey: { terms: [{ source: "星屑結晶", suggestedTarget: "星尘结晶" }, { source: "帰還", suggestedTarget: "返航" }] } } } }, context);
    const exported = await workbench.perform({ action: "export", batchId: prepared.batchId, projectId, mode: "writeback", outputPath: "outputs/ai.mqxliff" }, context);
    assert.match(await readFile(exported.path, "utf8"), /<target>使用星尘结晶。<\/target>/u);
    const final = xml(["使用星屑晶石。", "返回。", "保存。"]);
    await writeFile(join(cwd, "reviewed.mqxliff"), final);
    const operation = { action: "review-final", batchId: prepared.batchId, projectId, path: "reviewed.mqxliff", libraryId: master.id };
    await assert.rejects(workbench.perform(operation, { ...context, human: false }), /人工|human/);
    pendingReview = workbench.perform(operation, context);
    await alignmentStarted;
    const busy = await workbench.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${projectId}` }, context);
    assert.equal(busy.workflow.reviewFinalBusy, true);
    for (const action of ["start", "retry-qa"]) await assert.rejects(workbench.invoke({ path: `/api/batch/run/${prepared.batchId}/${action}`, method: "POST", body: { projectId } }, context), /终稿正在关联/);
    await assert.rejects(workbench.perform({ action: "export", batchId: prepared.batchId, projectId }, context), /终稿正在关联/);
    await assert.rejects(workbench.invoke({ path: "/api/batch/run", method: "POST", body: { batchId: prepared.batchId, projectId, segments } }, context), /终稿正在关联/);
    release();
    const report = await pendingReview;
    assert.equal(report.matched, 2);
    assert.equal(report.memoriesWritten, 3, "包含原先已有译文、未参与 AI 翻译的条目");
    assert.equal(report.trajectoriesLinked, 2);
    assert.equal(report.termSurvey.autoWritten, 1, "人工纠正的明确新术语也自动写入");
    assert.equal(report.termSurvey.pendingReview, 1, "已有术语冲突保留为待处理");
    const tm = await workbench.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=tm&libraryId=${master.id}` }, context);
    assert.equal(tm.total, 3);
    assert.ok(tm.items.every((item) => item.qualityStatus === "human_approved"));
    const sources = await workbench.invoke({ path: `/api/library-files?projectId=${projectId}&libraryId=${master.id}` }, context);
    assert.equal(sources.files[0].batch.batchId, prepared.batchId, "终稿改名后仍能定位原批次");
    assert.equal(sources.files[0].learning.humanReviewed, 2, "终稿来源页显示实际关联的学习轨迹");
    const terms = await workbench.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=term` }, context);
    assert.ok(terms.items.some((item) => item.source === "星屑結晶" && item.target === "星屑晶石"));
    assert.ok(terms.items.some((item) => item.source === "帰還" && item.target === "返航"));
    const trajectories = await workbench.store.request("/items/learning_trajectories?limit=-1");
    assert.ok(trajectories.every((item) => item.human_decision.accepted === true));
    const first = trajectories.find((item) => item.source.includes("星屑結晶"));
    assert.equal(first.human_decision.machineTranslation, "使用星尘结晶。");
    assert.equal(first.final_translation, "使用星屑晶石。");
    const callCount = calls.length;
    const again = await workbench.perform(operation, context);
    assert.equal(again.alreadyLinked, true);
    assert.equal(calls.length, callCount, "同版本不重复术语对齐或学习任务");
    assert.equal((await workbench.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=tm&libraryId=${master.id}` }, context)).total, 3);
    await writeFile(join(cwd, "reviewed.mqxliff"), xml(["请使用星屑晶石。", "返回。", "保存。"]));
    const next = await workbench.perform(operation, context);
    assert.equal(next.trajectoriesUpdated, 1);
    assert.notEqual(next.file.hash, report.file.hash);
    const revised = (await workbench.store.request("/items/learning_trajectories?limit=-1")).find((item) => item.id === first.id);
    assert.equal(revised.human_decision.machineTranslation, "使用星尘结晶。");
    assert.equal(revised.human_decision.previousFinalTranslation, "使用星屑晶石。");
    const linked = await workbench.workspace({}, context);
    assert.ok(linked.config.translationMemories.includes("reviewed.mqxliff"));
    assert.equal(linked.config.libraryFiles.find((item) => item.path === "reviewed.mqxliff").libraryId, master.id);
    assert.equal(await readFile(join(cwd, "source.mqxliff"), "utf8"), xml());
    await assert.rejects(workbench.perform({ ...operation, path: "../outside.mqxliff" }, context), /工作区|越界/);
    await writeFile(join(cwd, "wrong.mqxliff"), xml(["使用星屑晶石。", "返回。", "保存。"]).replaceAll("星屑結晶を使います。", "別の原文です。").replaceAll("帰還します。", "別の文書です。"));
    await assert.rejects(workbench.perform({ ...operation, path: "wrong.mqxliff" }, context), /原文|原批次|匹配/);
    await assert.rejects(workbench.perform({ ...operation, projectId: "other-project" }, context), /项目/);
    await writeFile(join(cwd, "large-reviewed.mqxliff"), xml(["请使用星屑晶石。", "返回。", "保存。"]) + " ".repeat(33 * 1024 * 1024));
    const large = await workbench.perform({ ...operation, path: "large-reviewed.mqxliff" }, context);
    assert.ok(large.file.size > 32 * 1024 * 1024, "本地终稿不继承服务器上传大小限制");
  } finally { release(); await pendingReview?.catch(() => {}); await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

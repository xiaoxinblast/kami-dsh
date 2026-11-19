import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { getBatchRun, saveAsset, saveBatchRun, saveLearningTrajectory } from "../src/store.mjs";

const xml = (targets = ["", "", "保存。"]) => `<?xml version="1.0" encoding="UTF-8"?><xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:mq="MQXliff" version="1.2"><file original="story"><body>${["星屑結晶を使います。", "帰還します。", "保存します。"].map((source, index) => `<trans-unit id="${index + 1}"><source>${source}</source><target>${targets[index]}</target><context-group><context context-type="x-mmq-context">STORY_${index + 1}</context></context-group></trans-unit>`).join("")}</body></file></xliff>`;

test("相同原文缺少身份时保留歧义，修正终稿后只接回本批轨迹及属于本项目的旧记录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-ambiguous-final-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs();
  const wb = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async () => ({ content: "{}" }) });
  const context = { cwd, fs, human: true };
  const document = rows => `<xliff version="1.2"><file original="same"><body>${rows.map(([id,source,target]) => `<trans-unit id="${id}"><source>${source}</source><target>${target}</target></trans-unit>`).join("")}</body></file></xliff>`;
  const source = [["one", "了解。", ""], ["two", "了解。", ""], ["end", "終了。", ""]];
  try {
    const state = await wb.workspace({ action: "bind", name: "歧义与修正" }, context), projectId = state.project.id;
    await writeFile(join(cwd, "old.mqxliff"), document(source));
    const imported = await wb.importFile({ path: "old.mqxliff" }, context);
    const run = await getBatchRun(imported.batchId);
    const segments = run.segments.map((s,i) => ({ ...s, status: "done", translation: "机器稿" + i }));
    await saveBatchRun({ ...run, runState: "completed", segments });
    for (const [i, seg] of segments.entries()) await saveLearningTrajectory({ project: i === 0 ? "default" : projectId, locale: "zh-CN", source: seg.source,
      initialTranslation: seg.translation, finalTranslation: seg.translation, batchId: run.batchId, segmentId: seg.id, assetRefs: { entryId: seg.locator.unitId }, status: "completed" });
    const foreign = await saveLearningTrajectory({ project: "default", locale: "zh-CN", batchId: "foreign-batch", source: "終了。",
      initialTranslation: "其他项目机器稿", finalTranslation: "其他项目机器稿", status: "completed" });
    const op = { action: "review-final", projectId, batchId: run.batchId, path: "final.mqxliff", libraryId: state.libraries.find(l=>l.role==="master").id };
    await writeFile(join(cwd, op.path), document([["lost", "了解。", "无法唯一定位"], ["end", "終了。", "结束。"], ["new", "別物。", "其他。"]]));
    const partial = await wb.perform(op, context);
    assert.deepEqual([partial.memoriesWritten, partial.trajectoriesLinked, partial.rejected.ambiguous.length, partial.rejected.unmatched.length], [1,1,1,1]);
    assert.match(partial.rejected.ambiguous[0].reason, /出现 2 次/);
    assert.equal((await getBatchRun(run.batchId)).runnerOptions.reviewFinal.complete, false, "待用户修正的终稿不能显示全部关联成功");
    assert.equal(partial.total, 3);
    const same = await wb.perform(op, context);
    assert.equal(same.alreadyLinked, true);
    assert.deepEqual(same.rejected, partial.rejected);
    assert.equal((await getBatchRun(run.batchId)).runnerOptions.reviewFinal.version, 1);
    await writeFile(join(cwd, op.path), document([["lost", "了解。", "无法唯一定位"]]));
    await assert.rejects(wb.perform(op, context), /了解。.*出现 2 次/);
    await writeFile(join(cwd, op.path), document([["two", "了解。", "明白。"], ["one", "了解。", "知道了。"], ["end", "終了。", "结束。"]]));
    const complete = await wb.perform(op, context);
    assert.deepEqual([complete.memoriesWritten,complete.trajectoriesLinked,complete.trajectoryAlreadyAccepted], [3,2,1]);
    assert.equal((await getBatchRun(run.batchId)).runnerOptions.reviewFinal.complete, true);
    assert.deepEqual((await getBatchRun(run.batchId)).segments.map(s=>s.translation), ["知道了。","明白。","结束。"]);
    const accepted = await wb.invoke({ path: "/api/learning/evidence?" + new URLSearchParams({ locale: "zh-CN", project: projectId, batchId: run.batchId, kind: "accepted" }) }, context);
    assert.equal(accepted.total, 3, "原批归属已确认的旧轨迹也能用于该项目学习");
    const legacy = await wb.store.request("/items/learning_trajectories/"+foreign.id);
    assert.equal(legacy.human_decision?.accepted, undefined);
  } finally { await wb.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

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
    if (options.requestLabel === "翻译技能复盘") {
      const input = JSON.parse(messages.at(-1).content);
      return { content: JSON.stringify({ name: "终稿学习候选", reason: "依据人工修改", strategyPatch: { prompting: { additionalRules: ["保持动词简洁"] } }, evidenceIds: input.trajectories.map((item) => item.id) }) };
    }
    if (options.requestLabel === "术语对齐") {
      entered(); await alignmentGate;
      return { content: JSON.stringify({ matches: [{ source: "星屑結晶", found: true, target: "星屑晶石", confidence: 0.99 }, { source: "帰還", found: true, target: "返回", confidence: 0.99 }] }) };
    }
    if (options.requestLabel === "AIQA") return { content: '{"issues":[]}' };
    const current = messages.map(message => message.content).join("\n").split("当前原文：\n").at(-1);
    return { content: current.startsWith("星屑結晶を使います。") ? "使用星尘结晶。" : "返航。" };
  } });
  const context = { cwd, fs, human: true };
  try {
    const state = await workbench.workspace({ action: "bind", name: "memoQ reviewed cycle" }, context), projectId = state.project.id;
    const master = state.libraries.find((library) => library.role === "master"), term = state.libraries.find((library) => library.kind === "term_base");
    await writeFile(join(cwd, "source.mqxliff"), xml());
    const prepared = await workbench.importFile({ path: "source.mqxliff" }, context);
    const segments = [];
    for (const segment of prepared.segments) {
      const result = await workbench.invoke({ path: "/api/translate", method: "POST", body: { projectId, batchId: prepared.batchId, segmentId: segment.id, locale: "zh-CN", contentType: "ui", domain: "game", source: segment.source, entryId: segment.locator.unitId, entryKey: segment.entryKey, qualityTier: "fast", segmentPurpose: "general", useModelClassification: false } }, context);
      segments.push({ ...segment, translation: result.translation, result, status: "done" });
    }
    await saveAsset("zh-CN", { source: "帰還", target: "返航", status: "approved", projectId, libraryId: term.id });
    await workbench.invoke({ path: "/api/batch/run", method: "POST", body: { batchId: prepared.batchId, projectId, segments, runState: "completed", runnerOptions: { termSurvey: { terms: [{ source: "星屑結晶", suggestedTarget: "星尘结晶" }, { source: "帰還", suggestedTarget: "返航" }] } } } }, context);
    const exported = await workbench.perform({ action: "export", batchId: prepared.batchId, projectId, mode: "writeback", outputPath: "outputs/ai.mqxliff" }, context);
    assert.match(await readFile(exported.path, "utf8"), /<target>使用星尘结晶。<\/target>/u);
    const distractor = { project: projectId, target_locale: "zh-CN", batch_id: "other-batch", status: "completed",
      initial_translation: "其他批次机器稿", final_translation: "其他批次机器稿", date_updated: "2099-01-01" };
    await workbench.store.request("/items/learning_trajectories", { method: "POST", body: Array.from({ length: 1005 }, (_, i) =>
      ({ ...distractor, id: "later-" + i, source: i === 0 ? "帰還します。" : "他の記録" + i })) });
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
    const trajectories = await workbench.store.request("/items/learning_trajectories?" + new URLSearchParams({ limit: "-1", "filter[batch_id][_eq]": prepared.batchId }));
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
    const scope = { projectId, locale: "zh-CN", contentType: "general", domain: "general" };
    const overview = await workbench.invoke({ path: `/api/learning?${new URLSearchParams(scope)}` }, context);
    assert.ok(overview.champion, "the project champion remains visible when historical labels differ");
    assert.equal(overview.champions.length, 1);
    const evidence = await workbench.invoke({ path: `/api/learning/evidence?${new URLSearchParams({ ...scope, batchId: prepared.batchId, search: "星尘结晶" })}` }, context);
    assert.equal(evidence.total, 1, "machine wording remains searchable after human edits");
    assert.equal(evidence.items[0].humanDecision.machineTranslation, "使用星尘结晶。");
    assert.equal(evidence.items[0].finalTranslation, "请使用星屑晶石。");
    const foreignBatch = await workbench.invoke({ path: `/api/learning/evidence?${new URLSearchParams({ ...scope, batchId: "other-batch", kind: "accepted" })}` }, context);
    assert.equal(foreignBatch.total, 0);
    const { skill } = await workbench.invoke({ path: "/api/learning/skills/generate", method: "POST", body: scope }, context);
    assert.equal(skill.parentId, overview.champion.id);
    assert.equal(skill.status, "challenger");
    assert.equal(skill.evidenceIds.length, 2);
    const { evaluation } = await workbench.invoke({ path: `/api/learning/skills/${encodeURIComponent(skill.id)}/evaluate`, method: "POST", body: scope }, context);
    assert.equal(evaluation.sampleCount, 0, "training evidence cannot leak into the holdout");
    assert.equal(evaluation.decision, "needs_review");
    assert.match(evaluation.report.conclusion, /至少需要 20 条/);
    await assert.rejects(workbench.invoke({ path: `/api/learning/skills/${encodeURIComponent(skill.id)}/activate`, method: "POST", body: scope }, context), /评测|通过|晋升/);
    const after = await workbench.invoke({ path: `/api/learning?${new URLSearchParams(scope)}` }, context);
    assert.equal(after.champion.id, overview.champion.id);
    assert.equal(after.evaluations[0].challengerSkillId, skill.id);
    const holdoutIds = [];
    for (const label of ["赤", "青", "白", "黒", "黄", "緑", "紫", "銀", "金", "橙", "春", "夏", "秋", "冬", "東", "西", "南", "北", "空", "海"]) {
      const row = await saveLearningTrajectory({ locale: "zh-CN", project: projectId, contentType: "ui", domain: "game", batchId: "independent-review", source: `${label}の場所から帰還します。`, initialTranslation: "返航。", finalTranslation: "返航。", status: "completed", humanDecision: { accepted: true, finalTranslation: "返航。", machineTranslation: "返航。" } });
      holdoutIds.push(row.id);
    }
    const job = await workbench.invoke({ path: `/api/learning/skills/${encodeURIComponent(skill.id)}/evaluate`, method: "POST", body: scope }, context);
    assert.ok(job.jobId, "20 independent human finals start a real background evaluation job");
    let finished;
    const deadline = Date.now() + 15000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = (await workbench.invoke({ path: `/api/learning/evaluation-jobs/${job.jobId}` }, context)).job;
    } while (!["completed", "failed"].includes(finished.status) && Date.now() < deadline);
    assert.equal(finished.status, "completed");
    const evaluated = await workbench.invoke({ path: `/api/learning?${new URLSearchParams(scope)}` }, context);
    assert.equal(evaluated.evaluations[0].sampleCount, 20);
    assert.equal(evaluated.evaluations[0].report.benchmark.completedPairs, 20);
    assert.equal(evaluated.evaluations[0].report.benchmark.failedPairs, 0);
    assert.ok(skill.evidenceIds.every((id) => !holdoutIds.includes(id)));
    assert.equal(evaluated.champion.id, overview.champion.id, "evaluation never activates a candidate automatically");
  } finally { release(); await pendingReview?.catch(() => {}); await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

test("旧版批次缺少冻结资源快照时仍可关联人工终稿，跨工作区快照仍被拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-legacy-reviewed-final-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs();
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async () => ({ content: "{}" }) });
  const context = { cwd, fs, human: true };
  try {
    const state = await workbench.workspace({ action: "bind", name: "legacy reviewed final" }, context);
    const projectId = state.project.id, master = state.libraries.find((library) => library.role === "master");
    await writeFile(join(cwd, "source.mqxliff"), xml());
    const prepared = await workbench.importFile({ path: "source.mqxliff" }, context);
    const segments = prepared.segments.map((segment) => ({ ...segment, translation: "返航。", status: "done", result: { translation: "返航。" } }));
    await workbench.invoke({ path: "/api/batch/run", method: "POST", body: { batchId: prepared.batchId, projectId, segments, runState: "completed" } }, context);
    const operation = { action: "review-final", batchId: prepared.batchId, projectId, path: "reviewed.mqxliff", libraryId: master.id };
    // 有快照但属于别的工作区：仍然拒绝。
    const snapshot = await getBatchRun(prepared.batchId);
    await saveBatchRun({ ...snapshot, runnerOptions: { ...snapshot.runnerOptions, workspaceSnapshot: { ...snapshot.runnerOptions.workspaceSnapshot, workspace: "/another/workspace" } } });
    await writeFile(join(cwd, "reviewed.mqxliff"), xml(["使用星屑晶石。", "返回。", "保存。"]));
    await assert.rejects(workbench.perform(operation, context), /工作区/);
    // 旧版批次没有快照：原文件与项目已能定位来源，允许关联。
    const legacy = await getBatchRun(prepared.batchId), runnerOptions = { ...legacy.runnerOptions };
    delete runnerOptions.workspaceSnapshot;
    await saveBatchRun({ ...legacy, runnerOptions });
    const report = await workbench.perform(operation, context);
    assert.equal(report.matched, 2);
    assert.equal(report.memoriesWritten, 3, "含未参与 AI 翻译、已有译文的条目");
    const linked = await getBatchRun(prepared.batchId);
    assert.equal(linked.runnerOptions.reviewFinal.path, "reviewed.mqxliff");
    assert.equal(linked.runnerOptions.reviewFinal.complete, true);
  } finally { await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

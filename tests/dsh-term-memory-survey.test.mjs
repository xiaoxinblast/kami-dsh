import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { getBatchRun, saveBatchRun, saveMemory, saveResourceLibrary } from "../src/store.mjs";

test("翻译标记查主参考 TM、整份统一、待定及人工终稿入库形成同一链路", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-term-memory-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs(), calls = [];
  const wb = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    calls.push(options.requestLabel);
    if (options.requestLabel === "术语 TM 对齐") return { content: JSON.stringify({ matches: JSON.parse(messages.at(-1).content).map((item) => ({ id: item.id, target: "星晶", confidence: 0.99 })) }) };
    if (options.requestLabel === "术语对齐") return { content: '{"matches":[{"source":"星屑結晶","found":true,"target":"星光晶","confidence":0.99}]}' };
    throw new Error(`Unexpected model request: ${options.requestLabel}`);
  } });
  const context = { cwd, fs, human: true };
  const sources = ["星屑結晶を使う。", "星屑結晶を得る。", "月の鍵を使う。", "未知護符を使う。", "双子石を使う。"];
  const xml = (targets = []) => `<xliff version="1.2"><file original="terms"><body>${sources.map((source, i) => `<trans-unit id="${i + 1}"><source>${source}</source><target>${targets[i] || ""}</target></trans-unit>`).join("")}</body></file></xliff>`;
  try {
    const state = await wb.workspace({ action: "bind", name: "术语 TM 闭环" }, context), projectId = state.project.id;
    const master = state.libraries.find((library) => library.role === "master"), working = state.libraries.find((library) => library.role === "working");
    const reference = await saveResourceLibrary({ projectId, kind: "translation_memory", role: "reference", name: "参考译例", enabled: true });
    for (const [library, source, target] of [[reference, "星屑結晶", "参考星石"], [master, "双子石", "双晶"], [master, "双子石", "双石"], [working, "未知護符", "错误工作稿"]]) {
      await saveMemory("zh-CN", { source, target, projectId, project: projectId, libraryId: library.id, qualityStatus: library === working ? "machine_verified" : "human_approved" });
    }
    await writeFile(join(cwd, "master.csv"), "日语,简体中文\n星屑結晶を使う。,使用星晶。\n");
    await writeFile(join(cwd, "reference.csv"), "日语,简体中文\n月の鍵,月钥\n");
    await wb.importFile({ purpose: "tm", path: "master.csv", libraryId: master.id }, context);
    await wb.importFile({ purpose: "tm", path: "reference.csv", libraryId: reference.id }, context);
    await writeFile(join(cwd, "source.mqxliff"), xml());
    const prepared = await wb.importFile({ path: "source.mqxliff" }, context), batchId = prepared.batchId;
    const run = await getBatchRun(batchId);
    assert.equal(run.runnerOptions.workspaceSnapshot.memories.length, 2);
    const translations = ["使用星尘结晶。", "获得星尘结晶。", "使用月之钥匙。", "使用未知护符。", "使用双子石。"];
    const marks = [["星屑結晶", "星尘结晶"], ["月の鍵", "月之钥匙"], ["未知護符", "未知护符"], ["双子石", "双子石"]].map(([source, target], i) => ({ id: `mark-${i}`, source, target, status: "active", confidence: 0.9 }));
    await saveBatchRun({ ...run, runState: "completed", segments: run.segments.map((segment, i) => ({ ...segment, status: "done", translation: translations[i] })), runnerOptions: { ...run.runnerOptions, workingGlossary: { revision: 1, terms: marks, conflicts: [] } } });
    const invokeSurvey = () => wb.invoke({ path: `/api/batch/run/${batchId}/term-survey?projectId=${projectId}`, method: "POST", body: { projectId } }, context);
    await invokeSurvey();
    let surveyed;
    for (let i = 0; i < 200; i++) {
      surveyed = await wb.invoke({ path: `/api/batch/run/${batchId}?projectId=${projectId}` }, context);
      if (surveyed.termSurvey?.generatedAt && !surveyed.workflow.writeBusy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(surveyed.segments.map((item) => item.translation), ["使用星晶。", "获得星晶。", "使用月钥。", "使用未知护符。", "使用双子石。"]);
    assert.deepEqual(surveyed.termSurvey.terms.map((item) => item.tm.status), ["matched", "matched", "not_found", "conflict"]);
    assert.equal(surveyed.termSurvey.terms[0].tm.evidence[0].libraryId, master.id);
    assert.equal(surveyed.termSurvey.terms[0].tm.evidence[0].sourceFile, "master.csv");
    assert.equal(surveyed.termSurvey.terms[0].initialTarget, "星尘结晶");
    assert.ok(!calls.includes("术语普查"), "不再独立重新猜词");
    const libraryTerms = () => wb.invoke({ path: `/api/library-entries?projectId=${projectId}&kind=term` }, context);
    assert.equal((await libraryTerms()).total, 0, "TM 命中不直接写正式术语库");
    const final = ["使用星光晶。", "获得星光晶。", "使用月钥。", "使用未知护符。", "使用双子石。"];
    await writeFile(join(cwd, "reviewed.mqxliff"), xml(final));
    const operation = { action: "review-final", batchId, projectId, path: "reviewed.mqxliff", libraryId: master.id };
    const reviewed = await wb.perform(operation, context);
    assert.equal(reviewed.termSurvey.autoWritten, 4);
    assert.ok((await libraryTerms()).items.some((item) => item.source === "星屑結晶" && item.target === "星光晶"));
    const repeated = await wb.perform(operation, context);
    assert.equal(repeated.alreadyLinked, true);
    await invokeSurvey();
    const after = await wb.invoke({ path: `/api/batch/run/${batchId}?projectId=${projectId}` }, context);
    assert.deepEqual(after.segments.map((item) => item.translation), final, "普查不能覆写人工终稿");
    assert.equal(after.termSurvey.review.stats.autoWritten, 4, "重跑保留终稿处理记录");
  } finally { await wb.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

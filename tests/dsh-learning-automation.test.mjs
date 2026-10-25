import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { saveBatchRun, saveLearningTrajectory } from "../src/store.mjs";

const xml = (count = 0) => `<xliff version="1.2"><file original="automation"><body>${Array.from({ length: 30 }, (_, i) => `<trans-unit id="${i}"><source>${String.fromCodePoint(0x4e00 + i)}の場所に戻ります。</source><target>${i < count ? "返回。" : ""}</target></trans-unit>`).join("")}</body></file></xliff>`;
async function until(read, predicate) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    const value = await read(); last = value; if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`自动学习状态未达到预期：${JSON.stringify({ automation: last?.automation, candidates: last?.candidates?.length, accepted: last?.trajectories?.filter((item) => item.humanDecision?.accepted).length })}`);
}

test("终稿关联自动产生候选，独立样本补齐后自动评测与门禁，不自动启用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-auto-loop-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs(); let proposals = 0;
  const wb = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (_messages, options) => {
    if (options.requestLabel === "翻译技能复盘") {
      proposals += 1;
      return { content: JSON.stringify({ name: "自动候选", reason: "人工终稿", strategyPatch: { prompting: { additionalRules: ["保持动词简洁"] } }, evidenceIds: JSON.parse(_messages.at(-1).content).trajectories.map((item) => item.id) }) };
    }
    if (options.requestLabel === "AIQA") return { content: '{"issues":[]}' };
    return { content: JSON.stringify(_messages).includes("保持动词简洁") ? "返回。" : "返航。" };
  } });
  const context = { cwd, fs, human: true, modelRoute: { provider: "fixture", model: "fixture-model" } };
  try {
    const state = await wb.workspace({ action: "bind", name: "自动学习验收" }, context), projectId = state.project.id;
    await writeFile(join(cwd, "source.mqxliff"), xml());
    const prepared = await wb.importFile({ path: "source.mqxliff" }, context);
    const run = await wb.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${projectId}` }, context);
    await saveBatchRun({ ...run, runState: "completed", segments: run.segments.map((segment) => ({ ...segment, status: "done", translation: "返航。" })) });
    for (const segment of run.segments) await saveLearningTrajectory({ locale: "zh-CN", project: projectId, contentType: "general", domain: "general", batchId: run.batchId, segmentId: segment.id, source: segment.source, initialTranslation: "返航。", finalTranslation: "返航。", status: "completed", assetRefs: { entryId: segment.locator.unitId, entryKey: segment.entryKey } });
    const overview = () => wb.invoke({ path: `/api/learning?locale=zh-CN&projectId=${projectId}&contentType=general&domain=general` }, context);
    const operation = { action: "review-final", batchId: run.batchId, projectId, path: "final.mqxliff", libraryId: state.libraries.find((item) => item.role === "master").id };
    await writeFile(join(cwd, "final.mqxliff"), xml(10));
    const linked = await wb.perform(operation, context);
    assert.equal(linked.trajectoriesLinked, 10, JSON.stringify(linked));
    const waiting = await until(overview, (value) => value.candidates.length === 1 && value.automation?.status === "waiting");
    assert.equal(waiting.automation.missingSamples, 20);
    assert.equal(proposals, 1);
    const again = await wb.perform(operation, context);
    assert.equal(again.alreadyLinked, true);
    await writeFile(join(cwd, "final.mqxliff"), xml(30));
    await wb.perform(operation, context);
    const finished = await until(overview, (value) => value.evaluations.length > 0 && ["blocked", "ready"].includes(value.automation?.status));
    assert.equal(finished.evaluations[0].sampleCount, 20);
    assert.equal(finished.evaluations[0].report.benchmark.failedPairs, 0);
    assert.equal(finished.automation.status, "ready", JSON.stringify(finished.automation));
    const gate = await wb.invoke({ path: `/api/quality/gate?locale=zh-CN&projectId=${projectId}&skillId=${finished.candidates[0].id}` }, context);
    assert.equal(gate.status, "pass");
    assert.equal(proposals, 1);
    assert.equal(finished.champion.id, waiting.champion.id);
    const jobs = await wb.invoke({ path: `/api/learning/evaluation-jobs?locale=zh-CN&project=${projectId}` }, context);
    assert.equal(jobs.jobs.length, 1);
    await wb.perform(operation, context);
    assert.equal((await wb.invoke({ path: `/api/learning/evaluation-jobs?locale=zh-CN&project=${projectId}` }, context)).jobs.length, 1);
    await wb.invoke({ path: `/api/learning/skills/${finished.candidates[0].id}/activate`, method: "POST", body: { locale: "zh-CN", projectId } }, context);
    const activated = await overview();
    assert.equal(activated.champion.id, finished.candidates[0].id);
    assert.equal(activated.champion.metadata.autoPropose.lastAcceptedCount, 30, "晋升后从当前证据数开始计算下一轮增长，不能循环学习同一批材料");
    assert.equal(activated.automation.candidateId, "");
  } finally { await wb.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

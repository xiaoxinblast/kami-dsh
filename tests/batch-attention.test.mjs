import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkbench } from "../dsh/workbench.mjs";
import { batchAttention } from "../src/batch-attention.mjs";
import { getBatchRun, saveBackgroundTask, saveBatchRun } from "../src/store.mjs";

test("局部一致性故障显示原因，只重试失败分片，轮询与恢复均不重复通知", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-followup-attention-"));
  const notices = [], calls = [];
  let fail = true;
  const wb = await createWorkbench({ dataDirectory: directory, notifyAttention: value => notices.push(value), modelAdapter: async (messages, options) => {
    assert.equal(options.requestLabel, "一致性检查");
    const index = Number(messages.map(m => m.content).join("\n").match(/第 (\d+) \/ 2 片/u)?.[1]);
    calls.push(index);
    if (index === 2 && fail) throw Error("模拟分片失败");
    return { content: '{"findings":[]}' };
  } });
  const invoke = (method, path, body) => wb.invoke({ method, path, body }, { human: true, modelRoute: { provider: "test", model: "fixture" } });
  try {
    const { project } = await invoke("POST", "/api/projects", { name: "后置恢复" });
    const projectId = project.id;
    const { batchId } = await invoke("POST", "/api/batch/prepare", { projectId, filename: "case.txt", text: "北\n南", locale: "zh-CN" });
    const run = await getBatchRun(batchId);
    const segments = ["北", "南"].map((s, i) => ({ id: String(i + 1), source: s.repeat(4200), translation: s + "方", status: "done" }));
    await saveBatchRun({ ...run, runState: "completed", segments });
    const path = "/api/batch/run/" + batchId;
    const list = async () => (await invoke("GET", "/api/batch/files?projectId=" + projectId)).files[0];
    const check = async failedOnly => {
      await invoke("POST", path + "/consistency-check", { projectId, failedOnly });
      for (let i = 0; i < 200; i++) {
        const result = await invoke("GET", path + "?projectId=" + projectId);
        if (!result.workflow.writeBusy) return result;
        await delay(25);
      }
      assert.fail("一致性任务未结束");
    };
    const first = await check(false);
    assert.equal(first.workflow.overall.status, "needs_attention");
    assert.equal(first.workflow.qualityReport.message.split("模拟分片失败").length, 2);
    const attention = (await list()).attention;
    assert.deepEqual([attention.verb, attention.count, attention.failedOnly], ["consistency-check", 1, true]);
    assert.equal(notices.length, 1);
    assert.deepEqual((await list()).attention, attention);
    assert.equal(notices.length, 1);
    fail = false;
    calls.length = 0;
    assert.equal((await check(true)).workflow.overall.status, "completed");
    assert.deepEqual(calls, [2]);
    assert.equal((await list()).attention, null);
    assert.equal(notices.length, 1);
  } finally { await wb.close(); await rm(directory, { recursive: true, force: true }); }
});

test("attention names the required action, suppresses human pauses and ignores optional QA", () => {
  const segment = { selected: true, status: "done", translation: "保存", result: { stages: { translation: { status: "completed" }, proofreading: { status: "failed", error: "模型输出截断" }, localQa: { status: "optional" } } } };
  const run = { runState: "needs_attention", segments: [segment] };
  assert.deepEqual(batchAttention(run), { verb: "retry-proofreading", label: "重试校对", count: 1, reason: "模型输出截断" });
  for (const runState of ["running", "queued", "paused", "completed"]) assert.equal(batchAttention({ ...run, runState }), null);
  assert.equal(batchAttention({ ...run, runnerOptions: { cancelled: true } }), null);
  segment.result.stages.proofreading.status = "completed";
  assert.equal(batchAttention(run), null);
  const legacy = { runState: "needs_attention", failedSegments: 3, totalSegments: 10, completedSegments: 7 };
  assert.equal(batchAttention(legacy).count, 3);
  assert.equal(batchAttention({ ...legacy, runState: "paused", runnerOptions: { interruptionReason: "进程中断" } }).verb, "resume");
});

test("background stops notify once per attempt without UI, polling is silent, successful retry clears the banner and restart recovers once", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-attention-"));
  const sent = [];
  let fail = true;
  const workbench = await createWorkbench({ dataDirectory: directory, notifyAttention: (value) => sent.push(value), modelAdapter: async (_messages, options) => {
    if (fail && options.requestLabel === "翻译") throw new Error("模拟模型输出截断");
    return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : "保存。" };
  } });
  const invoke = (method, path, body) => workbench.invoke({ method, path, body }, { human: true, modelRoute: { provider: "test", model: "fixture" } });
  try {
    const { project } = await invoke("POST", "/api/projects", { name: "批次提醒" });
    const projectId = project.id;
    const batch = await invoke("POST", "/api/batch/prepare", { projectId, filename: "通知测试.txt", text: "保存します。", locale: "zh-CN" });
    const list = async () => (await invoke("GET", `/api/batch/files?projectId=${projectId}`)).files.find((f) => f.batchId === batch.batchId);
    const run = async (command) => invoke("POST", `/api/batch/run/${batch.batchId}/${command}`, { projectId });
    const waitFor = async (check) => {
      const until = Date.now() + 6500;
      while (Date.now() < until) { if (await check()) return; await delay(25); }
      assert.fail(JSON.stringify({ file: await list(), details: (await invoke("GET", `/api/batch/run/${batch.batchId}?projectId=${projectId}`)).segments?.[0]?.result?.stages, sent }));
    };
    await run("start");
    await waitFor(() => sent.length > 0);
    const first = await list();
    assert.equal(first.attention.verb, "retry-translation");
    assert.equal(first.attention.count, 1); assert.equal(sent[0].count, 1);
    await list(); await list();
    assert.equal(sent.length, 1);
    await run("retry-translation");
    await waitFor(() => sent.length === 2);
    fail = false;
    await run("retry-translation");
    await waitFor(async () => (await list()).attention?.verb === "retry-proofreading");
    assert.equal(sent.length, 3);
    await run("retry-proofreading");
    await waitFor(async () => (await list()).runState === "completed");
    assert.equal((await list()).attention, null); assert.equal(sent.length, 3);
    await workbench.store.request(`/items/batch_runs/${batch.batchId}`, { method: "PATCH", body: { run_state: "running", segments: [{ id: "1", source: "保存", translation: "", status: "running" }] } });
    for (const [type, stage] of [["consistency_check", "qualityReport"], ["term_survey", "termSurvey"]]) {
      const run = await saveBatchRun({ projectId, filename: type + ".txt", locale: "zh-CN", runState: "completed", segments: [{ id: "1", source: "北", translation: "北方", status: "done" }] });
      const task = await saveBackgroundTask({ type, status: "in_progress", projectId, title: type, payload: { batchId: run.batchId } });
      await saveBatchRun({ ...await getBatchRun(run.batchId), runnerOptions: { workflowTasks: { [stage]: task.id } } });
    }
    await workbench.close();
    const reboot = async () => {
      const code = `import {createWorkbench} from './dsh/workbench.mjs';const sent=[];const w=await createWorkbench({dataDirectory:process.env.KAMI_ATTENTION_FIXTURE,notifyAttention:n=>sent.push(n)});const list=await w.invoke({path:'/api/batch/files?projectId='+process.env.KAMI_ATTENTION_PROJECT},{human:true});await w.close();console.log(JSON.stringify({sent,actions:list.files.map(f=>f.attention?.verb).sort()}));`;
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, KAMI_ATTENTION_FIXTURE: directory, KAMI_ATTENTION_PROJECT: projectId }, windowsHide: true });
      return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
    };
    const interrupted = await reboot();
    assert.deepEqual(interrupted.actions, ["consistency-check", "resume", "term-survey"]);
    assert.equal(interrupted.sent.length, 3);
    assert.equal((await reboot()).sent.length, 0);
  } finally {
    await workbench.close();
    assert.equal(dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

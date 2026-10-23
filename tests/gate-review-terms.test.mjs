import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const server = await read("server.mjs");
const app = await read("public/app.js");
const settings = await read("src/settings.mjs");
const store = await read("src/store.mjs");
const directusStore = await read("src/directus-store.mjs");

/**
 * 门禁失败复盘 + 术语普查入库的接线：端点、设置项、任务类型与留档边界。
 * 这些是"用户点得到、也能追得到"的部分，必须逐条锁住。
 */
test("三个新端点：复盘、术语候选、据此生成候选技能", () => {
  assert.match(server, /\/\^\\\/api\\\/quality\\\/runs\\\/\[\^\/\]\+\\\/review\$\/u/u);
  assert.match(server, /\/\^\\\/api\\\/quality\\\/runs\\\/\[\^\/\]\+\\\/terms\$\/u/u);
  assert.match(server, /url\.pathname === "\/api\/learning\/skills\/from-gate-review"/u);
  assert.match(server, /await updateQualityRun\(id, \{ report: \{ review \} \}\);/u);
  assert.match(server, /const skill = await proposeChallengerFromGateReview\(\{/u);
});

test("运行记录只允许追加复盘报告，不许改结论与计数", () => {
  assert.match(store, /export async function updateQualityRun\(id, patch\)/u);
  assert.match(store, /report: \{ \.\.\.jsonObject\(current\.report, \{\}\), \.\.\.jsonObject\(patch\.report, \{\}\) \}/u);
  assert.match(directusStore, /const report = \{ \.\.\.\(directusJson\(current\.report, \{\}\) \|\| \{\}\), \.\.\.\(patch\.report \|\| \{\}\) \};/u);
  // 只 PATCH report：结论、通过率、资产版本都不在请求体里。
  assert.match(directusStore, /\{ method: "PATCH", body: \{ report \} \}/u);
});

test("术语普查挂在批次收尾，且与一致性核对开关解耦", async () => {
  const start = server.indexOf("async function finalizeBatchWorkflow(");
  const end = server.indexOf("function startBatchQaRetry(", start);
  for (const enabled of [true, false]) {
    const calls = [];
    const finalize = vm.runInNewContext(`(${server.slice(start, end).trim()})`, {
      getSettings: () => ({ quality: { autoConsistencyCheck: enabled }, learning: { termSurveyEnabled: true } }),
      startConsistencyCheck: async (id) => { calls.push(`report:${id}`); throw new Error("report failed"); },
      startTermSurvey: async (id) => calls.push(`survey:${id}`), console: { error: () => {} }
    });
    await finalize("batch-test");
    assert.deepEqual(calls, enabled ? ["report:batch-test", "survey:batch-test"] : ["survey:batch-test"]);
  }
  assert.match(server, /type: "term_survey",/u);
  assert.match(server, /runnerOptions: \{[\s\S]{0,120}termSurvey: \{/u);
  assert.match(app, /term_survey: "术语普查"/u);
});

test("回填时用人工终稿确认术语，并按策略分流入库", () => {
  assert.match(server, /async function applyTermSurveyToReview\(\{ run, projectId, filename, applied, scope \}\)/u);
  assert.match(server, /alignSurveyToHumanFinal\(\{ terms: surveyed, pairs \}\)/u);
  assert.match(server, /async function persistTermCandidateInputs\(\{ locale, projectId, contentType = "general", domain = "general", batchId = "", filename = "", inputs = \[\], presetPending = \[\], sourceLabel = "术语候选" \}\)/u);
  assert.match(server, /const decision = decideTermWrite\(\n\s*\{ source: candidate\.source, target: candidate\.target, proposalAction: candidate\.proposalAction, verbatim: input\.verbatim === true, humanFinalVerified: input\.humanFinalVerified === true, confidence: input\.confidence \},/u);
  assert.match(server, /termSurvey,/u, "回填响应要带回术语普查统计");
});

test("新增三个设置项，全部默认开启", () => {
  for (const key of ["learning.gateDedupeSources", "learning.termSurveyEnabled", "learning.termAutoWriteReviewedTerms"]) {
    const pattern = new RegExp(`"${key.replace(/\./gu, "\\.")}": \\{ type: "boolean", default: true`, "u");
    assert.match(settings, pattern, `${key} 默认开`);
  }
});

test("复盘面板可按模式给动作，术语类与体例类分开", () => {
  assert.match(app, /data-gate-review="summarize"/u);
  assert.match(app, /data-gate-review="terms" data-run-id=/u);
  assert.match(app, /data-gate-review="skill" data-run-id=/u);
  assert.match(app, /const isTerminology = pattern\.kind === "terminology" && \(pattern\.termSuggestions \|\| \[\]\)\.length;/u);
  assert.match(app, /GATE_REVIEW_KIND_LABELS/u);
});

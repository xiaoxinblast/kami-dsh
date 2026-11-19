import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { runFollowupGroups } from "../src/followup-batch.mjs";
import { runtimeOptions } from "../src/runtime-context.mjs";
import { createHash } from "node:crypto";
import { runTaskPool } from "../src/task-pool.mjs";
import { consistencyRetryWork, remainingConsistencySkips, retryableConsistencyRepair } from "../src/consistency-retry.mjs";
import { contextBriefEntries, mergeContextBrief } from "../src/context-brief.mjs";
import { normalizeSource, digitSequence, extractProtectedTokens } from "../src/text.mjs";
import { surveyTermApplies, verifiedSurveyMemory } from "../src/term-memory-survey.mjs";
import { applyDeterministicReplacement } from "../src/consistency-repair.mjs";
import { textContainsTerm } from "../src/asset-governance.mjs";
import { surveyPairs } from "../src/term-survey.mjs";

const code = (await readFile(new URL("../server.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
function install(context, name, next) {
  const start = code.indexOf("async function " + name + "(");
  const end = code.indexOf(next, start + 1);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(code.slice(start, end), context);
}
function store(run, overrides) {
  return vm.createContext({
    runFollowupGroups, runtimeOptions, getBatchRun: async () => structuredClone(run),
    saveBatchRun: async value => Object.assign(run, structuredClone(value)),
    getProviderConfig: () => ({ model: "fixture" }), getProjectAssets: async () => ({ assets: {} }),
    taskProgressReporter: () => () => {}, runTaskPool, CONSISTENCY_CHECK_CONCURRENCY: 2, ...overrides
  });
}

test("旧报告中的初修失败若已终审保留或已改稿，就不重复提交", () => {
  const run = { segments: [], qualityReport: { findings: [{ ids: ["a", "b", "c"] }], repair: {
    skipped: [{ findingIndex: 0, ids: ["a", "b", "c"], reason: "定向修订失败：timeout" },
      { findingIndex: 0, ids: ["a"], reason: "AI 判断保留：符合原意" }],
    changed: [{ findingIndex: 0, segmentId: "b" }] } } };
  const work = consistencyRetryWork(run);
  assert.equal(work.count, 1);
  assert.deepEqual(work.repairItems[0].ids, ["c"]);
});

test("语境两片只补失败一片，原文变化后拒绝复用，成功分片结论保留", async () => {
  const run = { filename: "story", segments: [{ id: "a", source: "甲" }, { id: "b", source: "乙" }] };
  const calls = [];
  let fail = true;
  const ctx = store(run, { createHash, contextBriefEntries, mergeContextBrief, CONTENT_TYPES: {}, CONTEXT_ANALYSIS_CONCURRENCY: 1,
    splitContextChunks: () => [{ index: 0, indices: [0] }, { index: 1, indices: [1] }],
    analyzeDocumentContextWithModel: async ({ entries, part }) => {
      const entry = entries[0]; calls.push(entry.id); assert.equal(part.total, 2);
      if (entry.id === "b" && fail) throw new Error("timeout");
      return { part: { entryCount: 1, sections: [{ from: entry.i, to: entry.i, purpose: entry.text }], notes: [], crossRefs: [] } };
    }
  });
  install(ctx, "runContextAnalysis", "function startContextAnalysis(");
  await ctx.runContextAnalysis("run");
  assert.deepEqual(run.contextBrief.retryParts.failed, [1]);
  fail = false;
  run.segments[0].source = "丙";
  await assert.rejects(ctx.runContextAnalysis("run", { failedOnly: true }), /原文或分片已变化/);
  run.segments[0].source = "甲";
  await ctx.runContextAnalysis("run", { failedOnly: true });
  assert.deepEqual(calls, ["a", "b", "b"]);
  assert.deepEqual(run.contextBrief.sections.map(item => item.purpose), ["甲", "乙"]);
  assert.equal(run.contextBrief.retryParts, undefined);
});

test("一致性初查、改后复核只补各自失败分片，修订只传失败段，保留其他复核结论", async () => {
  const segments = ["a", "b", "c"].map(id => ({ id, source: id, translation: id, status: "done" }));
  const chunks = segments.map(({ id }, index) => ({ index, ids: [id] }));
  const keep = { findingIndex: 0, ids: ["a"], reason: "AI 判断保留：符合原文" };
  const run = { segments, qualityReport: { findings: [{ ids: ["a", "b"] }], repair: {
    changed: [], skipped: [keep, { findingIndex: 0, ids: ["b"], reason: "定向修订失败：timeout" }],
    failedChunks: [chunks[1]], verification: { remaining: [{ ids: ["a"], detail: "保留记录" }], failedChunks: [chunks[2]], failures: ["timeout"] } } } };
  const calls = [], repairIds = [];
  const ctx = store(run, { consistencyRetryWork, retryableConsistencyRepair, remainingConsistencySkips, getProjectStyleProfile: async () => null,
    consistencyTermEvidence: () => [], consistencyTmEvidence: async () => [], splitConsistencyChunks: () => chunks,
    consistencyChunkEvidence: () => ({}), buildReferenceToolRunner: () => undefined, mergeConsistencyFindings: items => items.flat(),
    checkBatchConsistencyWithModel: async ({ pairs, part }) => { assert.equal(part.total, 3); calls.push(pairs.map(p => p.id).join(",")); return []; },
    applyConsistencyRepairs: async ({ segments, findings, allowed }) => { repairIds.push(...findings.flatMap(f => f.ids)); assert.ok(!allowed(0, "a")); return { segments, repair: { skipped: [], changed: [] } }; },
    adjudicateRemainingFindings: async ({ segments }) => ({ segments }), annotateConsistencyFindings: list => list, buildQualityReport: () => ({})
  });
  install(ctx, "recheckConsistencyChunks", "async function applyConsistencyRepairs(");
  install(ctx, "runConsistencyCheck", "function startConsistencyCheck(");
  await ctx.runConsistencyCheck("run", { failedOnly: true });
  assert.deepEqual(calls, ["b", "c"]); assert.deepEqual(repairIds, ["b"]);
  assert.deepEqual(run.qualityReport.repair.verification.remaining, [{ ids: ["a"], detail: "保留记录" }]);
  assert.deepEqual(run.qualityReport.repair.skipped, [keep]);
  assert.equal(consistencyRetryWork(run).count, 0);
});

test("术语只查询超时词，只修订失败的词和段，保留同段其他已确认译法", async () => {
  const memory = (source, target) => ({ status: "matched", target, role: "master", evidence: [{ role: "master", source, target, translation: target }] });
  const terms = [
    { source: "敵", initialTarget: "对手", suggestedTarget: "敌人", tm: memory("敵", "敌人") },
    { source: "民", initialTarget: "市民", suggestedTarget: "市民", tm: { status: "failed" } },
    { source: "町", suggestedTarget: "小镇", tm: { status: "not_found" } }
  ];
  const oldChange = { source: "敵", segmentId: "a", before: "对手", after: "敌人" };
  const run = { segments: [{ id: "a", source: "敵", translation: "敌人" }, { id: "b", source: "敵と民", translation: "对手和市民" }, { id: "keep", source: "敵", translation: "强敌" }], runnerOptions: {
    workingGlossary: { terms: [{ source: "町", target: "手工标注" }] },
    termSurvey: { terms, repair: { verifiedMemoryOnly: true, changed: [oldChange], skipped: [{ source: "敵", segmentId: "b", before: "对手和市民", reason: "余额不足" }] } }
  } };
  const lookups = [], qa = [], sync = [];
  const ctx = store(run, { surveyPairs, normalizeSource, getResourceLibraries: async () => [], resolveTermMemoryWithModel: () => {},
    termSurveyMemoryEntries: async (_run, sources) => { lookups.push(...sources); return new Map(); }, resolveTermMemory: async ({ term }) => memory(term.source, "百姓"),
    surveyTermApplies, verifiedSurveyMemory, applyDeterministicReplacement, textContainsTerm, digitSequence, extractProtectedTokens,
    translateBatchSegment: async body => { qa.push(body.translation); return { translation: body.translation, aiQa: { used: true, status: "passed" } }; },
    matchTerms: () => [], consistencySegmentIssues: () => [], syncConsistencyRepairRecords: async args => { assert.equal(args.existingOnly, true); sync.push(...args.changes.map(c => c.segmentId)); }
  });
  install(ctx, "runTermSurvey", "async function termSurveyMemoryEntries(");
  install(ctx, "repairSurveyTerms", "function startTermSurvey(");
  await ctx.runTermSurvey("run", { failedOnly: true });
  assert.deepEqual(lookups, ["民"]); assert.deepEqual(qa, ["敌人和百姓"]); assert.deepEqual(sync, ["b"]);
  assert.deepEqual(run.segments.map(s => s.translation), ["敌人", "敌人和百姓", "强敌"]);
  assert.deepEqual(run.runnerOptions.termSurvey.repair.changed[0], oldChange);
  assert.deepEqual(run.runnerOptions.termSurvey.repair.skipped, []);
  assert.equal(run.runnerOptions.termSurvey.coverage.checkedTerms, 3);
  assert.equal(run.runnerOptions.workingGlossary.terms[0].target, "手工标注");
  await ctx.runTermSurvey("run", { failedOnly: true });
  assert.deepEqual(lookups, ["民"]); assert.equal(qa.length, 1);
});

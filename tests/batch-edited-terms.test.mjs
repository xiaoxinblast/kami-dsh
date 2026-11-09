import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { verifiedSurveyMemory } from "../src/term-memory-survey.mjs";

const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const start = source.indexOf('  if (req.method === "POST" && url.pathname === "/api/batch/run")');
const end = source.indexOf('  if (req.method === "GET" && url.pathname === "/api/batch/files")', start);

test("saving an edited translation removes only its unverified machine-learned term candidates", async () => {
  const learned = (id, sourceSegmentId, extra = {}) => ({ id, source: "結晶", target: "晶石", origin: "segment-learn", sourceSegmentId, ...extra });
  const existing = { batchId: "edited", runnerOptions: { qualityTier: "standard", workingGlossary: { revision: 3, terms: [
    learned("stale", "s1"), learned("other", "s2"), learned("manual", "s1", { origin: "manual" }),
    learned("verified", "s1", { tm: { status: "matched", role: "reference", target: "晶石", evidence: [{ role: "reference", source: "結晶を使う", target: "晶石", translation: "使用晶石" }] } })
  ] } }, segments: [{ id: "s1", translation: "旧译文" }, { id: "s2", translation: "未改译文" }] };
  let body = { batchId: "edited", segments: [{ id: "s1", translation: "纠正译文" }, { id: "s2", translation: "未改译文" }] }, saved;
  const handler = vm.runInNewContext(`(async (req, res, url) => { ${source.slice(start, end)} })`, {
    readJsonBody: async () => body, reviewFinalLocks: new Map(), getBatchRun: async () => structuredClone(existing),
    loadBatchWorkflow: async () => ({ writeBusy: false }), verifiedSurveyMemory,
    saveBatchRun: async value => { saved = value; return value; }, assertActiveLocale: value => value,
    json: (_res, status, value) => ({ status, value })
  });
  await handler({ method: "POST" }, {}, { pathname: "/api/batch/run" });
  assert.deepEqual(Array.from(saved.runnerOptions.workingGlossary.terms, term => term.id), ["other", "manual", "verified"]);
  assert.equal(saved.runnerOptions.workingGlossary.revision, 4);
  assert.equal(saved.runnerOptions.qualityTier, "standard");
  assert.equal(saved.segments[0].translation, "纠正译文");
  body = { batchId: "edited", segments: structuredClone(existing.segments) };
  await handler({ method: "POST" }, {}, { pathname: "/api/batch/run" });
  assert.equal(saved.runnerOptions.workingGlossary.terms.length, 4, "unchanged saves and QA-only updates must retain candidates");
  assert.equal(saved.runnerOptions.workingGlossary.revision, 3);
});

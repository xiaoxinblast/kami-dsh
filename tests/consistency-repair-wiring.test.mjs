import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const server = await read("server.mjs");
const app = await read("public/app.js");
const index = await read("public/index.html");
const settings = await read("src/settings.mjs");
const consistencyCheck = await read("src/consistency-check.mjs");
const provider = await read("src/provider.mjs");

/**
 * 一致性核对接证据 + 自动统一的接线：证据来源、裁决入口、修复落库与面板。
 * 这些是"用户看得见、也追得到"的部分，逐条锁住，避免以后被顺手改回去。
 */
test("核对阶段先查证据：风格指南 + 术语库 + 主参考工作 TM", () => {
  assert.match(server, /function consistencyTermEvidence\(run, segments, assets\)/u);
  assert.match(server, /async function consistencyTmEvidence\(\{ locale, projectId, contentType, domain, sources = \[\] \}\)/u);
  assert.match(server, /function tmEvidenceRank\(entry = \{\}\)/u);
  assert.match(server, /"主 TM 人工条", "参考 TM 人工条", "人工译例", "主 TM 机器条", "工作 TM 机器条", "TM 机器条"/u);
  assert.match(server, /evidence: consistencyChunkEvidence\(\{ style, termEvidence, tmEvidence, pairs: chunkPairs \}\)/u);
  assert.match(server, /chunkResults, followupOnly: true/u, "一致性检查仅使用已有证据与风格指南");
  assert.match(provider, /evidence = null, toolRunner = null/u);
  const checker = provider.slice(provider.indexOf("export async function checkBatchConsistencyWithModel"), provider.indexOf("export async function adjudicateConsistencyFindingsWithModel"));
  assert.doesNotMatch(checker, /chatWithTools\(/u);
  assert.match(consistencyCheck, /export const CONSISTENCY_EVIDENCE_LIMITS/u);
  assert.match(consistencyCheck, /登记术语（项目术语库里命中本片原文的条目，术语写法以它为准）/u);
  assert.match(consistencyCheck, /证据不足时不要自己发明统一译法/u);
});

test("自动统一按证据定案：术语库 > 主 TM > 参考 TM > 文件内多数", () => {
  assert.match(server, /const plan = planConsistencyRepairs\(\{/u);
  assert.match(server, /termTargetsFor: \(source\) => matchTerms\(source \|\| "", assets,/u);
  assert.match(server, /tmEntriesFor: \(source\) => tmEvidence\.get\(normalizeSource\(source\)\)/u);
  assert.match(server, /maxSegments: getSettings\(\)\.quality\?\.consistencyRepairMaxSegments \?\? 20/u);
  assert.match(server, /if \(segments\.some\(\(segment\) => segment\.accepted === true\)\) \{/u, "人工回填过就只报告");
  assert.match(server, /report\(\{ phase: "repairing"/u);
  assert.match(server, /report\(\{ phase: "verifying"/u);
});

test("修复后同步工作 TM 与学习轨迹，不改人工条", () => {
  assert.match(server, /async function syncConsistencyRepairRecords\(\{ run, changes, segments, existingOnly = false \}\)/u);
  assert.match(server, /String\(row\.qualityStatus \|\| ""\) !== "human_approved"/u, "只清机器条，不碰人工条");
  assert.match(server, /provenance: "consistency-repair",/u);
  assert.match(server, /type: "consistency_repaired",/u);
  assert.match(server, /const repaired = await applyConsistencyRepairs\(\{ run, segments, findings: work, assets, taskId, allowed \}\)/u);
});

test("报告带回每条的处理结果：已统一 / 部分 / 只报告", () => {
  assert.match(server, /function annotateConsistencyFindings\(findings, repair, verification\)/u);
  assert.match(server, /const findings = annotateConsistencyFindings\(merged, repaired\.repair, verification\)/u);
  assert.match(server, /repair: repairSummary/u);
  assert.match(server, /已按证据自动统一/u);
  assert.match(app, /function renderBatchRepair\(payload\)/u);
  assert.match(app, /function findingRepairNote\(finding = \{\}\)/u);
  assert.match(app, /REPAIR_EVIDENCE_LABELS/u);
  assert.match(index, /id="batchReportRepair"/u);
});

test("术语采用率只看精确命中，模糊命中单列", () => {
  assert.match(consistencyCheck, /if \(match\?\.mode === "exact"\) \{/u);
  assert.match(consistencyCheck, /fuzzyExpected,/u);
  assert.match(app, /模糊命中 \$\{report\.terms\?\.fuzzyApplied \|\| 0\} \/ \$\{report\.terms\?\.fuzzyExpected \|\| 0\}/u);
});

test("两个新设置项：自动统一默认开、单批上限默认 20", () => {
  assert.match(settings, /"quality\.consistencyAutoRepair": \{ type: "boolean", default: true/u);
  assert.match(settings, /"quality\.consistencyRepairMaxSegments": \{ min: 0, max: 200, step: 5, default: 20/u);
  assert.match(server, /getSettings\(\)\.quality\?\.consistencyAutoRepair === false/u);
});

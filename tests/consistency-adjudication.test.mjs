import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { adjudicationMessages, parseAdjudicationDecisions } from "../src/consistency-check.mjs";
import { REPAIR_EVIDENCE_LABELS } from "../src/consistency-repair.mjs";

const findings = [
  {
    type: "duplicate_source", ids: ["s1", "s2"], detail: "同一原文出现 2 次，却有 2 种译文",
    suggestion: "确认是否统一", terms: [], unify: [], evidence: [], source: "rule"
  },
  {
    type: "term_usage_gap", ids: ["s3", "s4"], detail: "术语「パス」有的地方用、有的地方没用",
    suggestion: "逐条确认", terms: [{ source: "パス", variants: ["路径", "帕斯"] }], unify: [], evidence: [], source: "rule"
  }
];
const segments = [
  { id: "s1", source: "パスを開く", translation: "打开路径" },
  { id: "s2", source: "パスを開く", translation: "打开帕斯" },
  { id: "s3", source: "パス", translation: "路径" },
  { id: "s4", source: "パス", translation: "帕斯" }
];

test("AI 终审提示词带上问题与段落译文，并要求严格 JSON", () => {
  const messages = adjudicationMessages({ filename: "test.mqxliff", locale: "zh-CN", purpose: "ui", findings, segments });
  const text = messages.map((message) => message.content).join("\n");
  assert.match(text, /跨条目不一致/u);
  assert.match(text, /打开路径/u, "要把待裁决段落译文交给模型");
  assert.match(text, /"decisions"/u);
  assert.match(text, /verdict/u);
});

test("AI 终审解析只接受本批序号和本批段落 id", () => {
  const content = JSON.stringify({
    decisions: [
      { index: 0, verdict: "unify", from: "打开帕斯", target: "打开路径", ids: ["s2", "other"], reason: "统一为多数写法" },
      { index: 1, verdict: "keep", reason: "语境不同，保留" },
      { index: 9, verdict: "unify", from: "x", target: "y", reason: "越界" },
      { index: 0, verdict: "unify", ids: ["s1"], reason: "缺 from/target" }
    ]
  });
  const decisions = parseAdjudicationDecisions(content, { validIndexes: [0, 1], validIds: ["s1", "s2", "s3", "s4"] });
  assert.equal(decisions.length, 3);
  assert.deepEqual(decisions[0], { index: 0, verdict: "unify", from: "打开帕斯", target: "打开路径", ids: ["s2"], reason: "统一为多数写法" });
  assert.equal(decisions[1].verdict, "keep");
  assert.ok(!decisions.some((decision) => decision.index === 9), "越界序号要丢弃");
  assert.equal(decisions[2].verdict, "keep", "缺 from/target 的 unify 降级为 keep");
});

test("AI 终审接入一致性核对，并在报告里用「AI 终审」标注依据", async () => {
  const [server, provider, app, repair] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/provider.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/consistency-repair.mjs", import.meta.url), "utf8")
  ]);
  assert.ok(server.includes("adjudicateRemainingFindings"));
  assert.ok(server.includes("adjudicateConsistencyFindingsWithModel"));
  assert.ok(provider.includes("adjudicateConsistencyFindingsWithModel"));
  assert.ok(app.includes('ai_judgement: "AI 终审"'));
  assert.equal(REPAIR_EVIDENCE_LABELS.ai_judgement, "AI 终审");
  assert.ok(repair.includes('ai_judgement: "AI 终审"'));
});

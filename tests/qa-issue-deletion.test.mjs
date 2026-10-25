import test from "node:test";
import assert from "node:assert/strict";
import { canDeleteQaIssues, collectQaIssues, deleteQaIssue, issueFingerprint } from "../src/qa-issue-deletion.mjs";

function report() {
  return {
    segments: [
      {
        index: 0,
        source: "原文一",
        translation: "译文一",
        issues: [
          { dimension: "basic", severity: "major", category: "grammar", message: "语法错误" },
          { dimension: "nuance", severity: "minor", category: "tone", message: "语气偏硬" }
        ]
      },
      { index: 1, source: "原文二", translation: "译文二", issues: [] }
    ],
    alignmentIssues: [{ dimension: "fidelity", severity: "critical", category: "omission", message: "整句漏译" }],
    scores: { overall: 40, dimensions: {} }
  };
}

function jestLikeIssue() {
  return {
    dimension: "fidelity",
    severity: "critical",
    category: "omission",
    message: "  整句 漏译 ",
    sourceSpan: "原文",
    targetSpan: "译文"
  };
}

test("指纹与意见位置无关，同样的意见在任何顺序下指纹相同", () => {
  const issue = { dimension: "basic", severity: "major", category: "grammar", message: "语法错误" };
  assert.equal(issueFingerprint(issue, 0), issueFingerprint({ ...issue }, 0));
  assert.notEqual(issueFingerprint(issue, 0), issueFingerprint(issue, 1));
  assert.notEqual(issueFingerprint(issue, 0), issueFingerprint({ ...issue, message: "别的错误" }, 0));
});

test("只有本机请求允许删除意见", () => {
  assert.equal(canDeleteQaIssues({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(canDeleteQaIssues({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(canDeleteQaIssues({ socket: { remoteAddress: "192.168.1.20" }, headers: { host: "192.168.1.5:4173" } }), false);
});

test("删除一条意见后重算评分，其他意见保持不变", () => {
  const before = report();
  const target = issueFingerprint(before.segments[0].issues[0], 0);
  const { report: next, task } = deleteQaIssue({ report: before, task: { id: "qa-1", overallScore: 40 }, fingerprint: target, at: "2026-09-24T00:00:00.000Z" });
  assert.equal(next.segments[0].issues.length, 1);
  assert.equal(next.segments[0].issues[0].message, "语气偏硬");
  assert.equal(next.alignmentIssues.length, 1, "文档级意见不受影响");
  assert.equal(next.deletedIssues.length, 1);
  assert.equal(next.deletedIssues[0].fingerprint, target);
  assert.equal(task.overallScore, next.scores.overall);
  assert.equal(task.summary.basic.total + task.summary.fidelity.total + task.summary.nuance.total, 2);
  assert.notEqual(next.scores.overall, before.scores.overall);
  assert.equal(before.segments[0].issues.length, 2, "原报告对象不被修改");
});

test("删除意见不能把未完成的模型检查变成有分数的报告", () => {
  const before = { ...report(), fallbackReason: "语法专项失败" };
  const next = deleteQaIssue({ report: before, fingerprint: collectQaIssues(before)[0].fingerprint });
  assert.equal(next.scores.overall, null);
  assert.equal(next.task.overallScore, null);
  assert.equal(next.report.fallbackReason, before.fallbackReason);
});

test("前端 WebCrypto 指纹与后端指纹算法一致——否则界面上的删除按钮会 404", async () => {
  // 这段逻辑与 public/app.js 的 autoQaIssueFingerprint 逐字对应：
  // 字段顺序、空白折叠、\u0000 分隔、hex 后截断 32 位。
  const issue = jestLikeIssue();
  const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const parts = [
    "3",
    clean(issue.dimension),
    clean(issue.severity),
    clean(issue.category || issue.type),
    clean(issue.message),
    clean(issue.sourceSpan),
    clean(issue.targetSpan || issue.span)
  ];
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  const browserFingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  assert.equal(browserFingerprint, issueFingerprint(issue, 3));
});

test("重复删除给出 404，而不是删掉另一条", () => {
  const before = report();
  const target = issueFingerprint(before.alignmentIssues[0], null);
  const { report: next } = deleteQaIssue({ report: before, fingerprint: target });
  assert.equal(next.alignmentIssues.length, 0);
  assert.throws(() => deleteQaIssue({ report: next, fingerprint: target }), /未找到要删除的意见/u);
  assert.equal(collectQaIssues(next).length, 2);
});

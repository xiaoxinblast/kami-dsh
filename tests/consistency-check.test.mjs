import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityReport,
  consistencyMessages,
  deterministicConsistencyFindings,
  mergeConsistencyFindings,
  parseConsistencyFindings,
  splitConsistencyChunks
} from "../src/consistency-check.mjs";

test("一致性核对按字符数分片", () => {
  const pairs = [
    { id: "seg-1", source: "あ".repeat(60), translation: "啊".repeat(60) },
    { id: "seg-2", source: "い".repeat(60), translation: "咦".repeat(60) },
    { id: "seg-3", source: "う".repeat(60), translation: "呜".repeat(60) }
  ];
  const chunks = splitConsistencyChunks(pairs, { maxChars: 100 });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.ids), [["seg-1"], ["seg-2"], ["seg-3"]]);
  const single = splitConsistencyChunks(pairs, { maxChars: 10_000 });
  assert.deepEqual(single.map((chunk) => chunk.ids), [["seg-1", "seg-2", "seg-3"]]);
});

test("解析一致性发现：引用不存在的条目 id 整条丢弃", () => {
  const content = JSON.stringify({
    findings: [
      { type: "term_drift", ids: ["seg-1", "seg-2"], detail: "同一个词两种译法", suggestion: "统一" },
      { type: "voice_drift", ids: ["seg-1", "seg-9"], detail: "引用越界", suggestion: "" },
      { type: "不存在的类型", ids: ["seg-2", "seg-3"], detail: "类型回落", suggestion: "" }
    ]
  });
  const { findings, dropped } = parseConsistencyFindings(content, { validIds: ["seg-1", "seg-2", "seg-3"] });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].type, "term_drift");
  assert.equal(findings[1].type, "term_drift", "未知类型按最保守的术语漂移处理");
  assert.equal(dropped.length, 1);
  assert.throws(() => parseConsistencyFindings("不是 JSON", { validIds: [] }), /未返回 JSON/u);
});

test("合并发现时按类型与说明去重", () => {
  const merged = mergeConsistencyFindings([
    { findings: [{ type: "term_drift", ids: ["seg-1", "seg-2"], detail: "A" }] },
    { findings: [{ type: "term_drift", ids: ["seg-1", "seg-2"], detail: "A" }, { type: "name_drift", ids: ["seg-3", "seg-4"], detail: "B" }] }
  ]);
  assert.equal(merged.length, 2);
});

test("确定性发现：同原文不同译文与术语登记译法未采用", () => {
  const term = { mode: "exact", expectedTarget: "高级通行证", term: { source: "プレミアムパス", target: "高级通行证" } };
  const findings = deterministicConsistencyFindings([
    { id: "seg-1", source: "プレミアムパスを買う", translation: "购买高级通行证", result: { matches: [term] } },
    { id: "seg-2", source: "プレミアムパスを買う", translation: "购买高级月卡", result: { matches: [term] } },
    { id: "seg-3", source: "別の文", translation: "另一句", result: { matches: [] } }
  ]);
  const types = findings.map((finding) => finding.type).sort();
  assert.deepEqual(types, ["duplicate_source", "term_usage_gap"]);
  const gap = findings.find((finding) => finding.type === "term_usage_gap");
  assert.match(gap.detail, /高级通行证/u);
  assert.equal(gap.source, "rule");
});

test("批次质量报告：档位分布、质检覆盖率、术语采用率与人工复核原因", () => {
  const report = buildQualityReport({
    batchId: "batch-1",
    filename: "sample.xlsx",
    locale: "zh-CN",
    provider: { model: "deepseek-flash" },
    styleProfile: { id: "style-1", name: "简体中文 general 风格", version: 3 },
    brief: { status: "ready", documentType: { purpose: "ui" }, sections: [1, 2], coverage: { covered: 2, total: 3, percent: 67 } },
    findings: [{ type: "term_drift" }],
    segments: [
      {
        id: "seg-1", source: "確認する", translation: "确认", status: "done",
        result: {
          qualityTier: "fast", segmentPurpose: "ui", matches: [{ mode: "exact", expectedTarget: "确认", term: { target: "确认" } }],
          issues: []
        }
      },
      {
        id: "seg-2", source: "8月20日に終了します", translation: "将于8月20日结束", status: "done",
        result: {
          qualityTier: "strict", segmentPurpose: "announcement", qaScore: 86,
          qualityUpgradeFrom: "standard",
          matches: [
            { mode: "exact", expectedTarget: "结束", term: { target: "结束" } },
            { mode: "fuzzy", expectedTarget: "结束时刻", term: { target: "结束时刻" } }
          ],
          issues: [{ type: "fact_date", severity: "error" }, { severity: "warning", type: "basic_tone" }]
        }
      },
      { id: "seg-3", source: "読込", translation: "", status: "error", result: { qualityTier: "standard", segmentPurpose: "ui" } }
    ]
  });
  assert.deepEqual(report.tiers, { fast: 1, standard: 1, strict: 1, unknown: 0 });
  assert.equal(report.upgrades, 1);
  assert.equal(report.coverage.modelQa, 1, "只有跑过模型质检的段落计入覆盖率");
  assert.equal(report.coverage.percent, 50);
  assert.equal(report.terms.expectedUses, 2);
  assert.equal(report.terms.applied, 2);
  assert.equal(report.terms.adoptionRate, 100);
  assert.equal(report.terms.fuzzyExpected, 1, "模糊命中不计入采用率");
  assert.equal(report.terms.fuzzyApplied, 0);
  assert.equal(report.facts.issueCount, 1);
  assert.equal(report.humanReview.suggested, 2);
  assert.ok(report.humanReview.reasons.some((item) => item.reason === "翻译失败"));
  assert.equal(report.consistency.byType[0].type, "term_drift");
  assert.equal(report.contextBrief.sections, 2);
  assert.equal(report.styleProfile.version, 3);
  assert.equal(report.purposes[0].purpose, "ui");
});

test("没有分数的快速档段落不计入平均分与质检覆盖率", () => {
  const report = buildQualityReport({
    segments: [
      { id: "seg-1", source: "設定", translation: "设置", status: "done", result: { qualityTier: "fast", qaScore: null, issues: [] } },
      { id: "seg-2", source: "確認", translation: "确认", status: "done", result: { qualityTier: "fast", issues: [] } },
      { id: "seg-3", source: "保存する", translation: "保存", status: "done", result: { qualityTier: "standard", qaScore: 96, issues: [] } }
    ]
  });
  assert.deepEqual(report.tiers, { fast: 2, standard: 1, strict: 0, unknown: 0 });
  assert.equal(report.coverage.modelQa, 1, "只有真跑过模型质检的段落才算覆盖率");
  assert.equal(report.coverage.percent, 33);
  assert.equal(report.scores.average, 96, "空分数不能被当成 0 分拉低平均");
  assert.equal(report.scores.distribution.unscored, 2);
  assert.equal(report.humanReview.suggested, 0, "快速档没有分数不等于待人工复核");
});

test("已修订未复检计入 QA 执行覆盖率，最终空分数不进入平均分", () => {
  const report = buildQualityReport({ segments: [
    { source: "設定", translation: "设置", status: "done", result: { qaScore: null, aiQa: { used: true, status: "revised" }, issues: [] } },
    { source: "保存", translation: "保存", status: "done", result: { qaScore: 96, aiQa: { used: true, status: "passed" }, issues: [] } }
  ] });
  assert.equal(report.coverage.modelQa, 2);
  assert.equal(report.coverage.percent, 100);
  assert.equal(report.coverage.qaIncomplete, 0);
  assert.equal(report.coverage.deterministicOnly, 0);
  assert.equal(report.scores.average, 96);
  assert.equal(report.scores.distribution.unscored, 1);
});

test("保护标记按原文重算，译文丢失即计入未保留", () => {
  const report = buildQualityReport({
    segments: [
      { id: "seg-1", source: "URLは https://example.com です", translation: "网址是 https://example.com", status: "done", result: { issues: [] } },
      { id: "seg-2", source: "URLは https://example.org です", translation: "网址在这里", status: "done", result: { issues: [] } }
    ]
  });
  assert.equal(report.protectedTokens.total, 2);
  assert.equal(report.protectedTokens.preserved, 1);
});

test("一致性提示词带上风格指南、登记术语与 TM 译例", () => {
  const messages = consistencyMessages({
    filename: "sample.mqxliff",
    locale: "zh-CN",
    purpose: "ui",
    pairs: [{ id: "seg-1", source: "無効", translation: "关闭" }],
    evidence: {
      style: { name: "UI 风格", version: 3, instruction: "按钮用两字动词", rules: ["不要用「请」"], registerPolicy: { promotional: 0.2 } },
      terms: [{ source: "ナビマップ", target: "导览地图", mode: "exact" }],
      tm: [{ source: "無効", target: "禁用", authority: "主 TM 人工条" }]
    }
  });
  const system = messages.find((message) => message.role === "system").content;
  const user = messages.find((message) => message.role === "user").content;
  assert.match(system, /依据缺失/u, "证据不足时要求写明依据缺失，而不是自己发明统一值");
  assert.match(system, /"unify"/u);
  assert.match(user, /风格指南/u);
  assert.match(user, /按钮用两字动词/u);
  assert.match(user, /ナビマップ → 导览地图/u);
  assert.match(user, /主 TM 人工条/u);
});

test("解析一致性发现：保留 terms / unify / evidence 并裁掉残缺项", () => {
  const content = JSON.stringify({
    findings: [{
      type: "term_drift",
      ids: ["seg-1", "seg-2"],
      detail: "同一术语两种译法",
      suggestion: "统一为禁用",
      terms: [{ source: "無効", variants: ["禁用", "关闭", ""] }, { variants: ["没有源词"] }],
      unify: [{ source: "無効", target: "禁用" }, { source: "無効" }],
      evidence: [{ kind: "tm_master", ref: "無効 → 禁用" }, { note: "" }]
    }]
  });
  const { findings } = parseConsistencyFindings(content, { validIds: ["seg-1", "seg-2"] });
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].terms, [{ source: "無効", variants: ["禁用", "关闭"] }]);
  assert.deepEqual(findings[0].unify, [{ source: "無効", target: "禁用" }]);
  assert.equal(findings[0].evidence.length, 1);
  assert.equal(findings[0].evidence[0].kind, "tm_master");
});

test("同骨架不同原文、译文不同 → pattern_drift", () => {
  const findings = deterministicConsistencyFindings([
    { id: "seg-1", source: "プレミアムパスを買うと3個の宝箱", translation: "购买高级通行证可获得 3 个宝箱", result: { patternKey: "⟦术⟧を買うと⟦数⟧個の宝箱" } },
    { id: "seg-2", source: "プレミアムパスを買うと10個の宝箱", translation: "买高级通行证能拿到 10 个宝箱", result: { patternKey: "⟦术⟧を買うと⟦数⟧個の宝箱" } }
  ]);
  const pattern = findings.find((finding) => finding.type === "pattern_drift");
  assert.ok(pattern);
  assert.deepEqual(pattern.ids, ["seg-1", "seg-2"]);
  assert.match(pattern.detail, /同一固定句式/u);
});

test("同骨架译文只差数字变量时不误报 pattern_drift", () => {
  const findings = deterministicConsistencyFindings([
    { id: "seg-1", source: "宝箱3個", translation: "获得 3 个宝箱", result: { patternKey: "宝箱⟦数⟧個" } },
    { id: "seg-2", source: "宝箱10個", translation: "获得 10 个宝箱", result: { patternKey: "宝箱⟦数⟧個" } }
  ]);
  assert.equal(findings.some((finding) => finding.type === "pattern_drift"), false);
});

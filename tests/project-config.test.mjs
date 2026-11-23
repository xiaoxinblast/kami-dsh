import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultProjectSettings, projectQaRule, projectRuleIdForIssue, projectRuleMetadata, sanitizeProjectSettings } from "../src/project-config.mjs";

test("项目默认 TM 与批处理设置可被读取", () => {
  const settings = createDefaultProjectSettings();
  assert.equal(settings.tm.catMinFuzzy, 60);
  assert.equal(settings.tm.llmMinRelevance, 60);
  assert.equal(settings.tm.contextAnchorCount, 5);
  assert.equal(settings.batch.subBatchMaxEntries, 100);
  assert.equal(settings.batch.groupMaxEntries, 10);
  assert.equal(settings.batch.structuredMode, "unit");
  assert.equal(settings.qa.rules.term_potential.enabled, false);
  assert.equal(settings.qa.rules.register.enabled, false);
});

test("旧项目迁移后默认关闭近似术语，迁移后的项目仍可手动启用", () => {
  const migrated = sanitizeProjectSettings({ version: 1, qa: { rules: { term_potential: { enabled: true, severity: "warning" } } } });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.qa.rules.term_potential.enabled, false);
  const explicit = sanitizeProjectSettings({ version: 3, qa: { rules: { term_potential: { enabled: true, severity: "info" } } } });
  assert.deepEqual(explicit.qa.rules.term_potential, { enabled: true, severity: "info" });
});

test("旧项目迁移后默认关闭语域词表提示，v3 项目仍可手动启用", () => {
  const migrated = sanitizeProjectSettings({ version: 2, qa: { rules: { register: { enabled: true, severity: "warning" } } } });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.qa.rules.register.enabled, false);
  const explicit = sanitizeProjectSettings({ version: 3, qa: { rules: { register: { enabled: true, severity: "info" } } } });
  assert.deepEqual(explicit.qa.rules.register, { enabled: true, severity: "info" });
});

test("项目设置会夹紧范围并保留合法规则严重度", () => {
  const settings = sanitizeProjectSettings({
    tm: { catMinFuzzy: 1, llmMinRelevance: 101, contextAnchorCount: 99 },
    batch: { subBatchMaxEntries: 2, groupMaxChars: 999999, structuredMode: "unknown" },
    qa: { rules: { whitespace: { enabled: false, severity: "info" } } }
  });
  assert.equal(settings.tm.catMinFuzzy, 50);
  assert.equal(settings.tm.llmMinRelevance, 100);
  assert.equal(settings.tm.contextAnchorCount, 10);
  assert.equal(settings.batch.subBatchMaxEntries, 10);
  assert.equal(settings.batch.groupMaxChars, 12000);
  assert.equal(settings.batch.structuredMode, "unit");
  assert.deepEqual(settings.qa.rules.whitespace, { enabled: false, severity: "info" });
});

test("结构强制规则不能被关闭或降级", () => {
  const settings = sanitizeProjectSettings({ qa: { rules: { non_break_tag_structure: { enabled: false, severity: "info" } } } });
  assert.deepEqual(settings.qa.rules.non_break_tag_structure, { enabled: true, severity: "error" });
  assert.equal(projectQaRule("document_integrity", settings).fixed, true);
  assert.ok(projectRuleMetadata().some((rule) => rule.id === "newline_semantics"));
});

test("项目设置里的 QA 说明与实际检查边界一致", () => {
  const rules = new Map(projectRuleMetadata().map((rule) => [rule.id, rule]));
  assert.match(rules.get("register").description, /本地词表/);
  assert.match(rules.get("orthography").description, /日式「」/);
  assert.match(rules.get("term_consistency").description, /结合当前句义判断/);
  assert.match(rules.get("term_potential").description, /模型判断/);
  assert.match(rules.get("newline_semantics").description, /虚词/);
  assert.match(rules.get("newline_suspicious_break").description, /数字/);
  assert.equal(projectRuleIdForIssue({ type: "aiqa_terminology_required" }), "term_consistency");
});

test("换行检查按语义、可疑断行和数量分别归属，结构检查不受开关控制", () => {
  assert.equal(projectRuleIdForIssue({ type: "line_layout_punctuation" }), "");
  assert.equal(projectRuleIdForIssue({ type: "line_layout_marker" }), "");
  assert.equal(projectRuleIdForIssue({ type: "line_layout_semantic" }), "newline_semantics");
  assert.equal(projectRuleIdForIssue({ type: "line_layout_short_line" }), "newline_semantics");
  assert.equal(projectRuleIdForIssue({ type: "line_layout_token" }), "newline_suspicious_break");
  assert.equal(projectRuleIdForIssue({ type: "line_layout_count" }), "newline_count");
  assert.equal(createDefaultProjectSettings().qa.rules.newline_count.severity, "info");
});

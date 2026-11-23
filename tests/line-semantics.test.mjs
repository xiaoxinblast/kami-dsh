import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeProjectSettings } from "../src/project-config.mjs";
import { runQa } from "../src/qa.mjs";

const source = "隠密部隊マスに配置するための\nアビリティをセットしていません。\nセットするためにアビリティ画面を\n開きますか?";
const translation = "尚未设置用于部署到秘密部队格局的\n技能。\n是否\n打开技能界面进行设置?";

function qa(value, options = {}) {
  return runQa({ source: "x", translation: value, locale: "zh-CN", contentType: "dialogue", ...options });
}

function types(value, options) {
  return qa(value, options).map(issue => issue.type);
}

test("长段硬折行会报行尾虚词和单独成行的短词，且不阻断", () => {
  const issues = qa(translation, { source });
  const semantic = issues.filter(issue => issue.type === "line_layout_semantic");
  const short = issues.filter(issue => issue.type === "line_layout_short_line");
  assert.equal(semantic.length, 1);
  assert.match(semantic[0].message, /第 1 行.*「的」.*第 2 行/u);
  assert.equal(short.length, 1);
  assert.match(short[0].message, /第 3 行.*「是否」/u);
  assert.ok(issues.every(issue => issue.severity === "warning"));
});

test("正常对白、列表、韵文式长短行和句末短句不误报", () => {
  for (const value of [
    "你好。\n再见。",
    "我们讨论了预算、排期和人员安排，\n大家各自表态，\n然后散会。",
    "今天天气非常好，我们决定\n一起出去玩一整天。\n谢谢。",
    "我们讨论了预算、排期和人员安排，\n大家各自表态，\n1. 第一项",
    "这是一句很长很长很长很长的诗，\n短句。\n又一句很长很长很长很长的诗，\n短句。",
    "我们终于到达了目的地\n休息一下。",
    "v1.2\n.3",
    "1\n2\n3"
  ]) {
    assert.deepEqual(types(value), [], value);
  }
});

test("末行两个字只有在上一行没说完时才判为悬空短行", () => {
  assert.deepEqual(types("今天天气非常好，我们决定\n一起出去玩一整天，\n技能。"), ["line_layout_short_line"]);
  assert.deepEqual(types("今天天气非常好，我们决定\n一起出去玩一整天。\n技能。"), []);
});

test("数字、英文标识、货币和省略号被拆开时提示可疑断行", () => {
  assert.ok(types("请安装 Windows\n11 系统后重试。").includes("line_layout_token"));
  assert.ok(types("价格是 ¥\n100。").includes("line_layout_token"));
  assert.ok(types("他停顿了很久……\n……然后离开了。").includes("line_layout_token"));
  assert.ok(types("第3\n名玩家进入房间。").includes("line_layout_token"));
});

test("韵文和日文目标不做中文语义与短行检查", () => {
  assert.deepEqual(types(translation, { contentType: "verse" }), []);
  assert.deepEqual(types(translation, { locale: "ja-JP" }), []);
});

test("换行语义开关只影响语义与短行，不影响行首标点禁则", () => {
  const off = sanitizeProjectSettings({ version: 3, qa: { rules: { newline_semantics: { enabled: false } } } });
  assert.deepEqual(types(translation, { projectSettings: off }), []);
  assert.deepEqual(types("甲\n，乙", { projectSettings: off }), ["line_layout_punctuation"]);
  const punctuationOff = sanitizeProjectSettings({ version: 3, qa: { rules: { punctuation_balance: { enabled: false } } } });
  assert.deepEqual(types("甲\n，乙", { projectSettings: punctuationOff }), ["line_layout_punctuation"]);
});

test("可疑断行开关只影响 token 检查", () => {
  const off = sanitizeProjectSettings({ version: 3, qa: { rules: { newline_suspicious_break: { enabled: false } } } });
  assert.deepEqual(types("请安装 Windows\n11 系统后重试。", { projectSettings: off }), []);
  assert.deepEqual(types("甲\n，乙", { projectSettings: off }), ["line_layout_punctuation"]);
});

test("换行数量默认关闭，开启后按原文与译文行数提示", () => {
  assert.ok(!types("甲\n乙", { source: "甲\n乙\n丙" }).includes("line_layout_count"));
  const on = sanitizeProjectSettings({ version: 3, qa: { rules: { newline_count: { enabled: true, severity: "info" } } } });
  const issues = qa("甲\n乙", { source: "甲\n乙\n丙", projectSettings: on });
  const count = issues.find(issue => issue.type === "line_layout_count");
  assert.equal(count?.severity, "info");
  assert.match(count.message, /原文 3 行，译文 2 行/u);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BRIEF_CHUNK_MAX_CHARS,
  CONTEXT_BRIEF_CHUNK_MAX_SEGMENTS,
  CONTEXT_BRIEF_MIN_SEGMENTS,
  contextBriefEntries,
  contextBriefSlice,
  mergeContextBrief,
  parseContextBriefPart,
  purposeForIndex,
  splitContextChunks,
  summarizeContextBrief
} from "../src/context-brief.mjs";

function segments(count, text = "セーブデータを読み込みます。") {
  return Array.from({ length: count }, (_, index) => ({ id: `seg-${index + 1}`, index, source: text }));
}

test("分片按条数与字符数双阈值，只有超出容量才分片", () => {
  const many = splitContextChunks(segments(700));
  assert.equal(many.length, 7, "700 条按 100 条一片切成 7 片");
  assert.equal(many[0].indices.length, CONTEXT_BRIEF_CHUNK_MAX_SEGMENTS);
  assert.equal(many[6].indices.length, 100);

  const single = splitContextChunks(segments(40));
  assert.equal(single.length, 1, "普通文件只启动一片");

  const longText = Array.from({ length: 3 }, (_, index) => ({ id: `seg-${index + 1}`, index, source: "あ".repeat(CONTEXT_BRIEF_CHUNK_MAX_CHARS) }));
  const longChunks = splitContextChunks(longText);
  assert.equal(longChunks.length, 3, "单条超长时自己占一片");
  assert.equal(CONTEXT_BRIEF_MIN_SEGMENTS, 6, "≤5 条的文件跳过语境分析");
});

const entries = [
  { i: 1, id: "seg-1", text: "セーブ" },
  { i: 2, id: "seg-2", text: "ロード" },
  { i: 3, id: "seg-3", text: "返回标题" }
];

test("单条语境结论漏写 to 时只覆盖 from 指定的这一条", () => {
  const parsed = parseContextBriefPart(JSON.stringify({ sections: [{ from: 1, to: 1, purpose: "dialogue" }, { from: 2, purpose: "ui", note: "保持倒计时阈值" }, { from: 3, to: 3, purpose: "dialogue" }] }), { entries });
  assert.deepEqual(parsed.part.sections[1], { from: 2, to: 2, purpose: "ui", tone: "", note: "保持倒计时阈值" });
  assert.equal(mergeContextBrief([parsed.part], { total: 3 }).coverage.covered, 3);
  const incomplete = mergeContextBrief([{ ...parsed.part, sections: [{ from: 1, to: 1699, purpose: "dialogue" }] }], { total: 1700 });
  assert.equal(incomplete.coverage.percent, 99, "缺一条时不能四舍五入显示 100%");
});

test("解析语境分析结果：区间收拢到本片，未知用途回落通用", () => {
  const content = JSON.stringify({
    documentType: { purpose: "ui", audience: "玩家", tone: "中性", summary: "系统菜单文案" },
    sections: [
      { from: 1, to: 2, purpose: "ui", tone: "简洁", note: "控件名称保持短语" },
      { from: 2, to: 9, purpose: "不存在的用途", tone: "", note: "" }
    ],
    crossRefs: [{ ids: ["seg-1", "seg-999"], note: "存档与读档用词要成对" }],
    notes: [{ text: "保留 <br> 标签", ids: ["seg-3"] }]
  });
  const { part, dropped } = parseContextBriefPart(content, { entries });
  assert.equal(part.entryCount, 3);
  assert.deepEqual(part.sections[0], { from: 1, to: 2, purpose: "ui", tone: "简洁", note: "控件名称保持短语" });
  assert.equal(part.sections[1].purpose, "general", "未知用途回落通用");
  assert.equal(part.sections[1].to, 3, "区间上界收拢到本片最后一条");
  assert.deepEqual(part.crossRefs, [{ ids: ["seg-1"], note: "存档与读档用词要成对" }], "不存在的条目 id 被剔除");
  assert.deepEqual(part.notes, [{ text: "保留 <br> 标签", ids: ["seg-3"] }]);
  assert.ok(dropped.some((item) => item.kind === "purpose"));
});

test("条目编号按数组位置，不被批次文档里的 1 起 index 顶偏", () => {
  const batchSegments = [
    { id: "seg-1", index: 1, source: "セーブ" },
    { id: "seg-2", index: 2, source: "ロード" }
  ];
  const projected = contextBriefEntries(batchSegments);
  assert.deepEqual(projected.map((entry) => entry.i), [1, 2], "编号必须是 1、2，而不是 2、3");
  const { part } = parseContextBriefPart(JSON.stringify({
    documentType: { purpose: "ui" },
    sections: [{ from: 1, to: 1, purpose: "ui" }, { from: 2, to: 2, purpose: "dialogue" }]
  }), { entries: projected });
  const brief = mergeContextBrief([part], { filename: "x.txt", total: 2 });
  assert.equal(purposeForIndex(brief, 0), "ui");
  assert.equal(purposeForIndex(brief, 1), "dialogue", "第 2 段必须拿到第 2 个区间的用途");
});

test("模型返回非 JSON 时明确报错，不猜内容", () => {
  assert.throws(() => parseContextBriefPart("这是一段说明文字", { entries }), /未返回 JSON/u);
});

test("模型输出两个对象或带说明文字时，取第一个完整 JSON 对象", () => {
  const messy = '分析如下：\n{"documentType":{"purpose":"ui"},"sections":[{"from":1,"to":3,"purpose":"ui"}]}\n另外补充：{"notes":[]}';
  const { part } = parseContextBriefPart(messy, { entries });
  assert.equal(part.sections[0].purpose, "ui");
  assert.equal(part.documentType.purpose, "ui");

  const fenced = "```json\n{\"sections\":[{\"from\":1,\"to\":2,\"purpose\":\"dialogue\"}]}\n```";
  const fencedPart = parseContextBriefPart(fenced, { entries }).part;
  assert.equal(fencedPart.sections[0].purpose, "dialogue");
});

test("合并分片：重叠区间保留覆盖更多的一段，并算覆盖率", () => {
  const first = {
    minIndex: 1, maxIndex: 30, entryCount: 30,
    documentType: { purpose: "ui", audience: "", tone: "", summary: "" },
    sections: [{ from: 1, to: 30, purpose: "ui", tone: "", note: "" }],
    crossRefs: [], notes: [{ text: "统一控件名", ids: [] }]
  };
  const second = {
    minIndex: 20, maxIndex: 60, entryCount: 41,
    documentType: { purpose: "dialogue", audience: "", tone: "口语", summary: "" },
    sections: [{ from: 20, to: 60, purpose: "dialogue", tone: "", note: "" }],
    crossRefs: [], notes: [{ text: "统一控件名", ids: [] }, { text: "角色口吻保持", ids: [] }]
  };
  const brief = mergeContextBrief([first, second], { filename: "ui.xlsx", total: 60, model: "test-model" });
  assert.equal(brief.status, "ready");
  assert.deepEqual(
    brief.sections.map((section) => [section.from, section.to, section.purpose]),
    [[1, 19, "ui"], [20, 60, "dialogue"]],
    "重叠部分归覆盖更多的一段，剩下的部分补回来，不留空洞"
  );
  assert.equal(brief.coverage.covered, 60);
  assert.equal(brief.coverage.percent, 100);
  assert.equal(brief.notes.length, 2, "重复注意点去重");
  const summary = summarizeContextBrief(brief);
  assert.equal(summary.documentPurpose, "dialogue", "整体用途按条目数加权");
  assert.equal(summary.sections, 2);
});

test("整份分析失败时回落通用，并标记失败", () => {
  const brief = mergeContextBrief([], { filename: "x.txt", total: 12 });
  assert.equal(brief.status, "failed");
  assert.deepEqual(brief.sections, []);
  assert.equal(purposeForIndex(brief, 0), "general");
});

test("逐段取用：用途按区间继承，注意点与跨条目关联按条目过滤", () => {
  const { part } = parseContextBriefPart(JSON.stringify({
    documentType: { purpose: "ui", audience: "", tone: "", summary: "" },
    sections: [{ from: 1, to: 2, purpose: "ui", tone: "简洁", note: "按钮用短语" }],
    crossRefs: [{ ids: ["seg-1", "seg-3"], note: "读档与存档成对" }],
    notes: [{ text: "只影响第三条", ids: ["seg-3"] }]
  }), { entries });
  const brief = mergeContextBrief([part], { filename: "ui.xlsx", total: 3 });
  assert.equal(purposeForIndex(brief, 0), "ui");
  assert.equal(purposeForIndex(brief, 1), "ui");
  const hit = contextBriefSlice(brief, 0, "seg-1");
  assert.equal(hit.section.purpose, "ui");
  assert.deepEqual(hit.notes.map((note) => note.text), ["按钮用短语"]);
  assert.deepEqual(hit.crossRefs.map((ref) => ref.note), ["读档与存档成对"]);
  const miss = contextBriefSlice(brief, 2, "seg-3");
  assert.equal(miss.section, null, "未覆盖的段落没有区间结论");
  assert.equal(purposeForIndex(brief, 2), "general", "未覆盖时回落到通用用途");
  assert.deepEqual(miss.notes.map((note) => note.text), ["只影响第三条"]);
  assert.equal(contextBriefSlice({ status: "failed" }, 0, "seg-1"), null);
});

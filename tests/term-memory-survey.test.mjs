import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { textContainsTerm } from "../src/asset-governance.mjs";
import { digitSequence, extractProtectedTokens, normalizeSource } from "../src/text.mjs";
import { applyDeterministicReplacement } from "../src/consistency-repair.mjs";
import { markedSurveyTerms, resolveTermMemory, parseTermMemoryAlignment } from "../src/term-memory-survey.mjs";

const term = { source: "星屑結晶", suggestedTarget: "星尘结晶" };
const entry = (id, role, target, source = term.source) => ({ id, libraryRole: role, libraryName: role, source, target });

test("普查只延续翻译期标记，排除正式词及别名，不截断标记清单", () => {
  const marks = Array.from({ length: 205 }, (_, i) => ({ source: `用語${i}`, target: `术语${i}`, id: `mark-${i}` }));
  const terms = markedSurveyTerms({ terms: [...marks, { source: "略称", target: "简称" }, { source: "削除", target: "删除", status: "rejected" }] }, [{ source: "正式名称", aliases: ["略称"] }]);
  assert.equal(terms.length, 205);
  assert.equal(terms[0].markId, "mark-0");
  assert.equal(terms[0].initialTarget, "术语0");
});

test("主 TM 优先，同级多译法待定，工作 TM 不参与", async () => {
  const resolve = (entries) => resolveTermMemory({ term, entries, align: async () => { throw new Error("exact entries need no model"); } });
  const master = await resolve([entry("r", "reference", "星屑晶石"), entry("m", "master", "星晶"), entry("w", "working", "错误")]);
  assert.equal(master.status, "matched");
  assert.equal(master.target, "星晶");
  assert.equal(master.role, "master");
  const conflict = await resolve([entry("m1", "master", "星晶"), entry("m2", "master", "星石"), entry("r", "reference", "星晶")]);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.target, "");
  assert.equal(conflict.evidence.length, 2);
  assert.equal((await resolve([entry("w", "working", "错误")])).status, "not_found");
});

test("整句 TM 按证据 ID 对齐术语片段，禁止拿整句或编造译法填词条", async () => {
  const rows = [entry("a", "reference", "使用星屑晶石。", "星屑結晶を使います。"), entry("b", "reference", "获得星屑晶石。", "星屑結晶を入手します。")];
  const result = await resolveTermMemory({ term, entries: rows, align: async (items) => parseTermMemoryAlignment(JSON.stringify({ matches: items.map((item) => ({ id: item.id, target: "星屑晶石", confidence: 0.96 })) }), { items }) });
  assert.equal(result.target, "星屑晶石");
  assert.equal(result.evidence[0].entryId, "a");
  const items = [{ id: "a", source: term.source, sourceText: rows[0].source, targetText: rows[0].target }];
  assert.deepEqual(parseTermMemoryAlignment('{"matches":[{"id":"a","target":"凭空译法","confidence":1}]}', { items }), []);
  assert.deepEqual(parseTermMemoryAlignment('{"matches":[{"id":"a","target":"星屑晶石","confidence":0.7}]}', { items }), []);
  assert.equal(parseTermMemoryAlignment('{"matches":[{"id":0,"target":"星屑晶石","confidence":0.99}]}', { items: [{ ...items[0], id: "0" }] }).length, 1);
  const ambiguous = await resolveTermMemory({ term, entries: rows, align: async () => [] });
  assert.equal(ambiguous.status, "unresolved");
  assert.equal(ambiguous.target, "");
});

test("不完整对齐及多处冲突不能用参考库掩盖主库歧义", async () => {
  const rows = [entry("m", "master", "使用星晶。", "星屑結晶を使う。"), entry("r", "reference", "星屑晶石")];
  assert.equal((await resolveTermMemory({ term, entries: rows, align: async () => [] })).status, "unresolved");
  const same = [entry("a", "reference", "使用星晶。", "星屑結晶を使う。"), entry("b", "reference", "获得星石。", "星屑結晶を得る。")];
  const result = await resolveTermMemory({ term, entries: same, align: async (items) => items.map((item, i) => ({ id: item.id, target: i ? "星石" : "星晶", confidence: 1 })) });
  assert.equal(result.status, "conflict");
});

test("TM 检索翻页到末尾，并遵守关联文件的库角色、启停和项目范围", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function termSurveyMemoryEntries("), end = source.indexOf("async function repairSurveyTerms(", start);
  const offsets = [], libraries = [{ id: "m", role: "master" }, { id: "r", role: "reference" }, { id: "off", role: "reference", enabled: false }, { id: "w", role: "working" }];
  const query = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    textContainsTerm, taskResources: () => ({ projectId: "p", memories: [{ source: term.source, target: "主库文件译法", libraryId: "workspace:file", linkedLibraryId: "m", libraryRole: "reference" }, { source: term.source, target: "停用", linkedLibraryId: "off" }] }),
    getMemories: async (_locale, options) => {
      assert.equal(options.projectId, "p"); offsets.push(options.offset);
      return options.offset === 0 ? Array.from({ length: 200 }, (_, i) => ({ id: String(i), libraryId: "w", source: term.source, target: "机器" })) : [{ id: "last", libraryId: "r", source: term.source, target: "最后一页" }];
    }
  });
  const found = await query({ locale: "zh-CN", projectId: "p" }, term.source, libraries);
  assert.deepEqual(offsets, [0, 200]);
  assert.equal(found.length, 2);
  assert.equal(found[1].libraryRole, "master");
  assert.equal(found[1].libraryId, "m");
});

test("统一文件译法保护人工终稿、标记和数字，失败仍保留原译文", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function repairSurveyTerms("), end = source.indexOf("/** 起一个术语普查后台任务", start);
  const repair = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    textContainsTerm, normalizeSource, digitSequence, extractProtectedTokens, applyDeterministicReplacement,
    matchTerms: () => [], consistencySegmentIssues: () => [], syncConsistencyRepairRecords: async () => {},
    reviseSegmentForConsistency: async () => "得到星晶。"
  });
  const segments = [
    { id: "protected", source: "星屑結晶<ph id='1'/>10", translation: "得到物品<ph id='1'/>10" },
    { id: "human", source: term.source, translation: "人工决定的译法", accepted: true },
    { id: "safe", source: term.source, translation: "使用星尘结晶。" }
  ];
  const result = await repair({ segments }, [{ ...term, initialTarget: term.suggestedTarget, tm: { status: "matched", target: "星晶" } }], {});
  assert.equal(result.segments[0].translation, segments[0].translation);
  assert.equal(result.segments[1].translation, segments[1].translation);
  assert.equal(result.segments[2].translation, "使用星晶。");
  assert.equal(result.repair.changed.length, 1);
  assert.match(result.repair.skipped[0].reason, /保护标记或数字/);
});

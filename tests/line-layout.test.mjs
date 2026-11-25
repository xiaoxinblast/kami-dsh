import test from "node:test";
import assert from "node:assert/strict";
import { extractFactSchema, checkFactSchema } from "../src/fact-schema.mjs";
import { prepareXliffDocument } from "../src/xliff-document.mjs";
import { inspectLayoutRules } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { checkLineLayout, resolveLineLayout } from "../src/line-layout.mjs";

const br = "<tag id='tag-1' type='inline' desc='ph'/>";
const tag = "<tag id='tag-2' type='inline' desc='ph'/>";
const pack = { source: "朝だ。\n帰ろう。", targetLocale: "zh-CN", contentType: "dialogue", neighborContext: {} };
const guide = { path: "排版.md", text: "对白：每行最多 6 字，最多 2 行。\nUI：每行最多 3 字，最多 1 行。" };

test("解析真实 memoQ 换行并区分普通占位符", () => {
  const xml = '<xliff version="1.2"><file><body><trans-unit id="a"><source>朝です。<ph id="4">&lt;mq:ch val="&#10;" /&gt;</ph>帰る。<ph id="5">{name}</ph></source></trans-unit></body></file></xliff>';
  const [s] = prepareXliffDocument(Buffer.from(xml), "a.mqxliff").segments;
  assert.deepEqual(s.locator.lineBreakMarkers, [br]);
});

test("布局约束逐行检查，句号逗号不能移到下一行，保护标签不计入字数", async () => {
  const layout = await resolveLineLayout({ pack, guides: [guide] });
  assert.deepEqual(checkLineLayout("天亮了。\n该回家了。", layout), []);
  const bad = checkLineLayout("天亮了\n，真的该回家了。", layout);
  assert.deepEqual(bad.map(i => i.type).sort(), ["line_layout_length", "line_layout_punctuation"]);
  assert.ok(bad.every(i => i.message.includes("第 2 行")));
  assert.ok(bad.find(i => i.type === "line_layout_length").message.includes(guide.path));
  const encoded = await resolveLineLayout({ pack: { ...pack, source: "朝" + br + "帰" + tag }, markers: [br], guides: [guide] });
  assert.deepEqual(checkLineLayout("天亮了。" + br + tag + "该回家了。", encoded), []);
  assert.ok(checkLineLayout("天亮了" + br + tag + "。该回家了", encoded).some(i => i.type === "line_layout_punctuation"));
  const schema = extractFactSchema({ source: pack.source, constraints: [{ label: "字数", value: "每行最多 6 字，最多 2 行" }] });
  assert.deepEqual(checkFactSchema({ schema, translation: "天亮了。\n该回家了。", locale: "zh-CN" }), []);
});

test("并发、校对和已保存结果按作用域复用；文件换版、文本类型和条目约束隔离", async () => {
  const cache = new Map();
  let reads = 0, lookups = 0;
  const run = (p, version = "v1", extra = {}) => resolveLineLayout({ pack: p, cache, files: [{path: "设计表.xlsx", version}],
    readText: async () => { reads++; return null; }, inspect: async (_, context) => {
      lookups++; assert.ok(context.type);
      return [{ maxChars: context.type === "ui" ? 3 : 6, source: "设计表.xlsx", quote: "每行最多六字", counting: "characters" }];
    }, ...extra });
  const same = await Promise.all([pack, { ...pack, source: "また\n会おう。", neighborContext: { note: "由另一位配音员录制。" } }, pack].map(p => run(p)));
  assert.equal(same[0].key, same[1].key);
  await run(pack);
  await run(pack, "v1", { cache: new Map(), previous: same[0] });
  assert.deepEqual([reads, lookups], [1, 1]);
  assert.equal((await run({ ...pack, contentType: "ui" })).rules[0].maxChars, 3);
  await run(pack, "v2");
  await run({ ...pack, neighborContext: { metadata: [{ role: "constraint", label: "排版", value: "最多 2 行" }] } });
  assert.deepEqual([reads, lookups], [4, 4]);
  assert.equal(await run({ ...pack, source: "普通" + tag }), null);
  assert.deepEqual([reads, lookups], [4, 4]);
});

test("明确的空结果可复用，查阅失败和读取期间换版可重试", async () => {
  const cache = new Map();
  const options = { pack, cache, files: [{ path: "规范.pdf", version: "1" }], readText: async () => null };
  await assert.rejects(resolveLineLayout({ ...options, inspect: async () => { throw Error("读取失败"); } }), /读取失败/u);
  await assert.rejects(resolveLineLayout({ ...options, inspect: async () => [], verifyVersions: () => { throw Error("查阅期间已换版"); } }), /已换版/u);
  const empty = await resolveLineLayout({ ...options, inspect: async () => [] });
  const again = await resolveLineLayout({ ...options, inspect: () => assert.fail("重复查阅") });
  assert.deepEqual(again, empty);
  assert.deepEqual(checkLineLayout("这行没有资料规定的数字上限。\n这行也是。", empty), []);
  assert.equal(checkLineLayout("早上好\n.我们走", empty)[0].type, "line_layout_punctuation");
});

test("固定占位符与规格冲突给出来源、最少行数；独立总字数限制继续生效", async () => {
  const layout = await resolveLineLayout({ pack: { ...pack, source: "甲" + br + "乙", contentType: "ui" }, guides: [guide], markers: [br] });
  const conflict = checkLineLayout("甲" + br + "乙", layout);
  assert.match(conflict[0].message, /最多 1 行.*排版.md.*至少需要 2 行/u);
  assert.ok(checkLineLayout("甲乙", layout).some(i => i.type === "line_layout_marker"));
  const schema = extractFactSchema({ source: pack.source, constraints: [{ label: "长度", value: "每行最多 6 字，全文最多 8 字" }] });
  assert.deepEqual(checkFactSchema({ schema, translation: "甲乙丙丁戊己庚辛壬", locale: "zh-CN" }).map(i => i.type), ["length_limit_exceeded"]);
});

test("人工指南优先于参考资料的同一项限制，互补的行数仍有效；同级矛盾保留出处", async () => {
  const options = { pack, guides: [{ path: "人工规范", text: "每行最多 8 字。" }], files: [{ path: "参考表", purpose: "reference", version: "v1" }],
    readText: () => "每行最多 6 字，最多 2 行。" };
  const layout = await resolveLineLayout(options);
  assert.deepEqual(checkLineLayout("甲乙丙丁戊己庚\n丁戊己", layout), []);
  assert.match(checkLineLayout("甲\n乙\n丙", layout)[0].message, /最多 2 行（参考表）/u);
  await assert.rejects(resolveLineLayout({ ...options, guides: [...options.guides, { path: "第二指南", text: "每行最多 7 字。" }] }), /冲突.*人工规范.*第二指南/u);
});

test("复杂原件核对需要实际的工具证据，拒绝未读来源、无依据的数字和错引", async () => {
  const file = { path: "规格表.xlsx", purpose: "reference", text: null };
  const quote = "对白每行最多十二字。";
  const reply = patch => JSON.stringify({ rules: [{ source: file.path, quote, maxChars: 12, counting: "characters", ...patch }], unresolved: "" });
  const runner = { tools: [{ type: "function", function: { name: "read", parameters: {} } }], maxRounds: 2, execute: async () => ({ refs: [{ path: file.path }], text: quote }) };
  const inspect = (modelAdapter, input = file) => withRuntimeCall({ modelAdapter }, () => inspectLayoutRules([input], { type: "dialogue" }, runner));
  const good = await inspect(async messages => messages.some(m => m.role === "tool") ? { content: reply({}) } : { toolCalls: [{ id: "one", function: { name: "read", arguments: "{}" } }] });
  assert.equal(good[0].maxChars, 12);
  await assert.rejects(inspect(async () => ({ content: reply({}) })), /尚未查证.*规格表.xlsx/u);
  await assert.rejects(inspect(async () => ({ content: reply({ maxChars: 20 }) }), { ...file, text: quote }), /缺少可核实/u);
  await assert.rejects(inspect(async () => ({ content: reply({ quote: "每行十二字。" }) }), { ...file, text: quote }), /缺少可核实/u);
});

test("资料没有换行字数上限时按不设上限处理，不中断翻译", async () => {
  const file = { path: "设定集.md", purpose: "reference", text: "本作对白共 120 句，排版按 UI 实际情况处理。\n横向每行最多 20 字，字数口径待确认。" };
  const model = payload => async () => ({ content: JSON.stringify(payload) });
  const inspect = (adapter, input = file, runner = null) => withRuntimeCall({ modelAdapter: adapter }, () => inspectLayoutRules([input], { type: "dialogue" }, runner));
  // 资料没规定数字上限：模型如实返回空规则并说明原因，照常翻译。
  assert.deepEqual(await inspect(model({ rules: [], unresolved: "资料未规定每行字数上限" })), []);
  assert.deepEqual(await inspect(model({ rules: [], unresolved: "" })), []);
  // 原件没有可直接读取的正文，模型判断没有适用上限时，不必先调用读取工具。
  const runner = { tools: [{ type: "function", function: { name: "read", parameters: {} } }], maxRounds: 2, execute: async () => ({ refs: [{ path: "规格表.xlsx" }], text: "" }) };
  assert.deepEqual(await inspect(model({ rules: [], unresolved: "资料未规定换行字数" }), { path: "规格表.xlsx", purpose: "reference", text: null }, runner), []);
  // 已核实原文和数字的上限照常生效；口径说明只记日志，不推翻已核实的数字。
  assert.deepEqual(await inspect(model({ rules: [{ source: file.path, quote: "横向每行最多 20 字", maxChars: 20, counting: "characters" }], unresolved: "字数口径未明确" })),
    [{ source: file.path, quote: "横向每行最多 20 字", maxChars: 20, counting: "characters" }]);
});

test("元数据注释可提供数字上限；只有换行的译文也检查行首标点", async () => {
  const layout = await resolveLineLayout({ pack: { ...pack, neighborContext: { note: "每行最多十二字，最多两行。" } } });
  assert.equal(layout.rules[0].source, "条目注释");
  assert.equal(layout.rules[0].maxChars, 12);
  assert.equal(layout.rules[0].maxLines, 2);
  assert.deepEqual(checkLineLayout("快走\n，别回头", null).map(i => i.type), ["line_layout_punctuation"]);
});

test("行首行尾禁则覆盖点号、闭合符号和行尾开括号", () => {
  for (const text of ["甲\n？乙", "甲\n：乙", "甲\n；乙", "甲\n）乙", "甲\n」乙", "甲\n》乙", "甲\n．乙"]) {
    assert.deepEqual(checkLineLayout(text, null).map(i => i.type), ["line_layout_punctuation"], text);
  }
  assert.deepEqual(checkLineLayout("甲（\n乙）", null).map(i => i.type), ["line_layout_punctuation"]);
  assert.deepEqual(checkLineLayout("甲「\n乙」", null).map(i => i.type), ["line_layout_punctuation"]);
});

test("ASCII 标点只在上一行以汉字收尾时才判为行首禁则", () => {
  assert.deepEqual(checkLineLayout("早上好\n.我们走", null).map(i => i.type), ["line_layout_punctuation"]);
  assert.deepEqual(checkLineLayout("v1.2\n.3", null), []);
  assert.deepEqual(checkLineLayout("1\n.5", null), []);
});

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 空译文兜底。
 *
 * 实测事故：评测里模型先查参考资料，工具轮次用尽还没给译文，`chatWithTools`
 * 返回空字符串，链路把它当成"这段的译文"——评测记成候选漏译（质量 30 分、
 * 硬错误 +1、编辑距离 100%），生产批次记成"这一段翻好了"。4~5 组这样的空样本
 * 就足以把整条候选判死。现在：先补一轮不带工具的直译；仍为空就抛带 code 的错误，
 * 让上层把它当"这一组没跑成"（评测可只重试失败样本，生产可重试该段）。
 */
const requests = [];
let replies = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(init.body) });
  const reply = replies.length > 1 ? replies.shift() : replies[0];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(reply)
  };
};

const { translateWithReflection } = await import("../src/provider.mjs");

const contextPack = {
  source: "星葬の玉座",
  targetLocale: "zh-CN",
  targetLanguage: "简体中文",
  sourceLanguage: "日语",
  contentType: "item_name",
  contentTypeLabel: "道具名",
  register: "中性",
  localeInstruction: "自然的简体中文。"
};

const textReply = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const toolReply = (name) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 5, completion_tokens: 1 }
});

test("第一轮空白时补一轮不带工具的直译，结果不再被当成空译文", async () => {
  replies = [textReply(""), textReply("星葬王座")];
  requests.length = 0;
  const result = await translateWithReflection(contextPack, { reflect: false, temperature: 0 });
  assert.equal(result.translation, "星葬王座");
  assert.equal(requests.length, 2, "空白之后要补一轮");
  assert.equal(requests[1].body.messages[0].content.includes("不要再调用任何工具"), true, "重试要明确禁止再查资料");
  assert.equal(requests[1].body.tools, undefined, "重试不带工具，避免又跑到轮次上限");
});

test("工具轮次用尽且没有正文时，补一轮直译并带上原因说明", async () => {
  // 工具轮次上限 2 → 最多 3 次模型调用；三次都在要工具，正文一直是空的。
  replies = [toolReply("search_references"), toolReply("search_references"), toolReply("search_references"), textReply("星葬王座")];
  requests.length = 0;
  const toolRunner = {
    tools: [{ type: "function", function: { name: "search_references", description: "", parameters: { type: "object" } } }],
    maxRounds: 2,
    execute: async () => ({ text: "（没有命中）", refs: [] })
  };
  const result = await translateWithReflection(contextPack, { reflect: false, temperature: 0, toolRunner });
  assert.equal(result.translation, "星葬王座");
  assert.equal(requests.length, 4, "3 轮工具 + 1 轮兜底直译");
  assert.match(requests.at(-1).body.messages[1].content, /工具轮次用完/u);
});

test("连续两次都空白时明确报错，code=empty_translation", async () => {
  replies = [textReply(""), textReply("   ")];
  requests.length = 0;
  await assert.rejects(
    () => translateWithReflection(contextPack, { reflect: false, temperature: 0 }),
    (error) => {
      assert.equal(error.code, "empty_translation");
      assert.match(error.message, /模型没有返回译文/u);
      return true;
    }
  );
});

test("修订环节返回空白时退回初译，不会把空串交出去", async () => {
  replies = [textReply("星葬王座"), textReply("术语没问题，但句式可以更短。"), textReply("")];
  requests.length = 0;
  const result = await translateWithReflection(contextPack, { reflect: true, temperature: 0 });
  assert.equal(result.translation, "星葬王座", "修订空白时用初译兜底");
});

test("含非译文说明的返回必须重试，连续污染则报错而不保存", async () => {
  const contaminated = "星葬王座\n\n---\n\n**非译文说明（不属于正文）：** 未能查阅风格指南原件。";
  replies = [textReply(contaminated), textReply("星葬王座")];
  requests.length = 0;
  assert.equal((await translateWithReflection(contextPack, { reflect: false })).translation, "星葬王座");
  assert.equal(requests.length, 2);
  replies = [textReply(contaminated), textReply(contaminated)];
  await assert.rejects(translateWithReflection(contextPack, { reflect: false }), { code: "invalid_translation" });
});

test("工具轮次耗尽时查阅说明不是最终译文", async () => {
  const call = toolReply("read"); call.choices[0].message.content = "我先查阅参考资料。";
  replies = [call, call, textReply("星葬王座")]; requests.length = 0;
  const result = await translateWithReflection(contextPack, { reflect: false, toolRunner: {
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    maxRounds: 1, execute: async () => ({ text: "规则", refs: [] })
  } });
  assert.equal(result.translation, "星葬王座"); assert.equal(requests.length, 3);
});

test("修订不能用非译文说明覆盖合格初译，原文本身的说明文字可以翻译", async () => {
  replies = [textReply("星葬王座"), textReply("调整措辞"), textReply("星葬王座\n\n**非译文说明：** 未能查阅指南")];
  assert.equal((await translateWithReflection(contextPack, { reflect: true })).translation, "星葬王座");
  replies = [textReply("请先阅读翻译说明。")];
  assert.equal((await translateWithReflection(contextPack, { reflect: false })).translation, "请先阅读翻译说明。");
});

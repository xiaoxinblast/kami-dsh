import test from "node:test";
import assert from "node:assert/strict";
import { translateMicroBatchWithModel } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

const entries = ["a", "b"].map(id => ({ id, contextPack: { source: `台詞${id}`, sourceLanguage: "日语", targetLanguage: "简体中文", targetLocale: "zh-CN", contentType: "dialogue", userProfile: { instruction: "必须读取 guide.docx" } } }));

test("小批共享指南但仍执行真实查阅门禁，工具输出不充当译文", async () => {
  const calls = [], trace = { events: [] };
  let read = false;
  const tools = [{ type: "function", function: { name: "read", parameters: {} } }];
  const toolRunner = {
    tools, maxRounds: 2,
    assertReady: () => { if (!read) throw Object.assign(new Error("guide unread"), { code: "style_guide_unread" }); },
    execute: async () => { read = true; return { text: "完整指南", nativeContent: [{ type: "text", text: "完整指南" }] }; }
  };
  const modelAdapter = async (messages, options) => {
    calls.push({ messages, options });
    if (calls.length === 1) return { content: '{"translations":[]}' };
    if (calls.length === 2) return { toolCalls: [{ id: "read-1", function: { name: "read", arguments: "{}" } }] };
    return { content: JSON.stringify({ translations: entries.map(entry => ({ id: entry.id, translation: `译文${entry.id}` })) }) };
  };
  const result = await withRuntimeCall({ modelAdapter, modelRoute: { provider: "test", model: "same-model", reasoningEffort: "high" }, performanceTrace: trace }, () => translateMicroBatchWithModel(entries, { toolRunner }));
  assert.equal(result.length, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].messages[1].content.split("必须读取 guide.docx").length - 1, 1);
  assert.ok(calls.every(call => call.options.route.model === "same-model" && call.options.route.reasoningEffort === "high"));
  assert.equal(trace.events.filter(event => event.stage === "referenceTool").length, 1);
});

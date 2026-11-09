import test from "node:test";
import assert from "node:assert/strict";
import { translateMicroBatchWithModel } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

const entries = ["a", "b"].map(id => ({ id, contextPack: { source: `台詞${id}`, sourceLanguage: "日语", targetLanguage: "简体中文", targetLocale: "zh-CN", contentType: "dialogue", userProfile: { instruction: "必须读取 guide.docx" } } }));

test("未确认工作术语在小批提示中只能作为参考", async () => {
  let prompt;
  const values = entries.map(entry => ({ ...entry, contextPack: { ...entry.contextPack, workingTerms: [{ source: "より", target: "关系" }] } }));
  await withRuntimeCall({ modelAdapter: async messages => {
    prompt = messages.map(message => message.content).join("\n");
    return { content: JSON.stringify({ translations: values.map(entry => ({ id: entry.id, translation: `译文${entry.id}` })) }) };
  }, modelRoute: { provider: "test", model: "same-model" } }, () => translateMicroBatchWithModel(values));
  assert.match(prompt, /仅供语境参考/u);
  assert.match(prompt, /不得强制套用/u);
  assert.doesNotMatch(prompt, /同一文件内统一采用/u);
});

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

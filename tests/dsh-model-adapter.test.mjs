import test from "node:test";
import assert from "node:assert/strict";
import { createModelAdapter, sessionModelRoute } from "../dsh/model-adapter.mjs";

test("new sessions use the DSH default model and pending selections override previous requests", () => {
  let pending;
  let header;
  const ctx = { sessionProjections: { stateOf: () => ({ pending }) }, agentDefaultModel: { currentSelection: () => ({ provider: "configured", model: "default" }) } };
  const agent = { session: { requestHeader: () => header } };
  assert.equal(sessionModelRoute(ctx, agent).model, "default");
  header = { config: { provider: "configured", model: "previous" } };
  assert.equal(sessionModelRoute(ctx, agent).model, "previous");
  pending = { provider: "configured", model: "selected" };
  assert.equal(sessionModelRoute(ctx, agent).model, "selected");
});

let llm;
try { llm = await import("@deepseek-ai/dsh-llm"); } catch {
  if (process.env.DSH_TEST_LLM_MODULE) llm = await import(process.env.DSH_TEST_LLM_MODULE);
}

test("installed DSH protocol preserves prepared routes, tools and usage and reports failures", { skip: !llm }, async () => {
  const requests = [];
  const configurations = [];
  let chunks = [
    { type: "tool-call-delta", index: 0, id: "ref", name: "reference_search", argumentsDelta: '{"query":"設定"}' },
    { type: "usage", usage: { inputTokens: 30, outputTokens: 12 } },
    { type: "finish", reason: { kind: "tool-calls" } }
  ];
  const admitted = [];
  const ctx = { attachments: { async admitPromptContent(content) {
    admitted.push(content);
    return content.map((part) => part.type === "image" ? { type: "image", attachment: { attachmentId: "sha256:test-image" } } : part);
  } }, llm: {
    async prepareCall(config) {
      configurations.push(config);
      return { config: { ...config, maxTokens: 2000 }, async *stream(request) { requests.push(request); for (const chunk of chunks) yield chunk; } };
    }
  } };
  const adapter = createModelAdapter(ctx, llm);
  const route = { provider: "existing-dsh-provider", model: "selected-model", reasoningEffort: "high" };
  const result = await adapter([
    { role: "system", content: "Translate" },
    { role: "assistant", content: "", tool_calls: [{ id: "previous", function: { name: "reference_search", arguments: '{"query":"UI"}' } }] },
    { role: "tool", tool_call_id: "previous", content: "reference evidence" },
    { role: "user", content: "設定" }
  ], { route, temperature: 0.1, tools: [{ function: { name: "reference_search", description: "Read references", parameters: { type: "object", properties: { query: { type: "string" } } } } }] });
  assert.equal(result.toolCalls[0].function.arguments, '{"query":"設定"}');
  assert.equal(result.usage.promptTokens, 30);
  assert.equal(requests[0].model, route.model);
  assert.equal(requests[0].maxTokens, 2000);
  assert.equal(configurations[0].temperature, 0.1);
  assert.equal(requests[0].messages[1].content[0].arguments, '{"query":"UI"}');
  assert.equal(requests[0].messages[2].toolCallId, "previous");
  await adapter([{ role: "user", content: [{ type: "text", text: "OCR" }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] }], { route });
  assert.deepEqual(admitted.at(-1)[1], { type: "image", mediaType: "image/png", data: "aW1hZ2U=" });
  assert.equal(requests.at(-1).messages[0].content[1].attachment.attachmentId, "sha256:test-image");
  const nativeContent = [{ type: "text", text: "原生读取结果" }, { type: "image", attachment: { attachmentId: "sha256:native-image" } }];
  await adapter([{ role: "tool", tool_call_id: "native-read", content: "fallback text", nativeContent }], { route });
  assert.deepEqual(requests.at(-1).messages[0].content, nativeContent, "already admitted native image blocks must not be discarded or readmitted");
  chunks = [{ type: "finish", reason: { kind: "error", failure: { message: "model unavailable" } } }];
  await assert.rejects(adapter([{ role: "user", content: "x" }], { route }), /model unavailable/);
  chunks = [{ type: "text-delta", index: 0, text: "partial" }, { type: "finish", reason: { kind: "max-tokens" } }];
  await assert.rejects(adapter([{ role: "user", content: "x" }], { route }), /截断/);
});

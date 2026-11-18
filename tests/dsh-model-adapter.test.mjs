import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelAdapter, sessionModelRoute } from "../dsh/model-adapter.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { invalidateSettingsCache, saveSettings } from "../src/settings-store.mjs";
import { summarizeModelUsage } from "../src/performance.mjs";

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

test("new Agent model API supplies the session route without registry-level projection reads", () => {
  let current = { provider: "session", model: "current", reasoningEffort: "high" };
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: "default", model: "global" }) }
  };
  const agent = { model: { current: () => current } };
  assert.deepEqual(sessionModelRoute(ctx, agent), current);
  current = undefined;
  assert.deepEqual(sessionModelRoute(ctx, agent), { provider: "default", model: "global" });
});

let llm;
try { llm = await import("@deepseek-ai/dsh-llm"); } catch {
  if (process.env.DSH_TEST_LLM_MODULE) llm = await import(process.env.DSH_TEST_LLM_MODULE);
}

const testLlm = llm || { BlockAssembler: class {
  finish = {}; usage; content = [];
  push(chunk) {
    if (chunk.type === "finish") this.finish = chunk.reason;
    if (chunk.type === "usage") this.usage = chunk.usage;
    if (chunk.type === "text-delta") this.content.push({ type: "text", text: chunk.text });
  }
  blocks() { return this.content; }
} };

async function budgetFixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "kami-model-budget-"));
  try { return await withRuntimeCall({ dataDirectory: directory }, async () => { invalidateSettingsCache(); await callback(); }); }
  finally { invalidateSettingsCache(); await rm(directory, { recursive: true, force: true }); }
}

function budgetAdapter(responses, { defaultMaxTokens = 32000, prepare = (config) => config } = {}) {
  const requests = [];
  const adapter = createModelAdapter({ llm: { async prepareCall(input) {
    const config = prepare({ ...input, maxTokens: input.maxTokens ?? defaultMaxTokens });
    return { config, async *stream(request) {
      requests.push(request);
      const response = responses[Math.min(requests.length - 1, responses.length - 1)];
      request.signal.throwIfAborted();
      yield { type: "text-delta", index: 0, text: response.content || "" };
      if (response.error) throw response.error;
      if (response.usage) yield { type: "usage", usage: response.usage };
      yield { type: "finish", reason: { kind: response.kind || "stop", ...(response.failure ? { failure: response.failure } : {}) } };
    } };
  } } }, testLlm);
  return { adapter, requests };
}
const budgetMessages = [{ role: "user", content: "检查译文" }];
const budgetRoute = { provider: "test", model: "selected-model", reasoningEffort: "high" };

test("每次截断重试独立计量，缓存读写按 SDK 互斥字段计入总输入，缺报保持未知", () => budgetFixture(async () => {
  saveSettings({ model: { maxTokens: 4000, retryMaxTokens: 6000 } });
  const trace = { events: [] };
  const { adapter } = budgetAdapter([
    { kind: "max-tokens", usage: { inputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 2, outputTokens: 5 } },
    { content: "complete", usage: { inputTokens: 12, outputTokens: 3 } }
  ]);
  await withRuntimeCall({ performanceTrace: trace }, () => adapter(budgetMessages, { route: budgetRoute }));
  assert.deepEqual(trace.events.map(e => e.usage), [
    { inputTokens: 62, outputTokens: 5, cacheHitTokens: 50, cacheMissTokens: 12 },
    { inputTokens: 12, outputTokens: 3, cacheHitTokens: null, cacheMissTokens: null }
  ]);
  assert.deepEqual(summarizeModelUsage(trace.events), { calls: 2, inputTokens: 74, outputTokens: 8, cacheHitTokens: null, cacheMissTokens: null });
}));

test("performance records the actual prepared model and effort without prompt text", () => budgetFixture(async () => {
  const trace = { events: [] };
  const { adapter } = budgetAdapter([{ content: "complete" }], { prepare: config => ({ ...config, model: "actual-model", reasoningEffort: "max" }) });
  await withRuntimeCall({ performanceTrace: trace, performancePhase: "qa" }, () => adapter(budgetMessages, { route: budgetRoute, requestLabel: "AIQA" }));
  assert.equal(trace.events.length, 1);
  assert.equal(trace.events[0].model, "actual-model");
  assert.equal(trace.events[0].reasoningEffort, "max");
  assert.equal(trace.events[0].parent, "qa");
  assert.ok(trace.events[0].durationMs >= 0);
  assert.equal(JSON.stringify(trace).includes("检查译文"), false);
}));

test("DSH budgets inherit the session/provider instead of legacy QA and context constants", () => budgetFixture(async () => {
  const { adapter, requests } = budgetAdapter([{ content: "complete" }]);
  await adapter(budgetMessages, { route: { ...budgetRoute, maxTokens: 64000 }, maxTokens: 1800 });
  await adapter(budgetMessages, { route: budgetRoute, maxTokens: 256000 });
  assert.deepEqual(requests.map((request) => request.maxTokens), [64000, 32000]);
}));

test("saved budgets apply immediately to the actual stream and survive settings reload", () => budgetFixture(async () => {
  const { adapter, requests } = budgetAdapter([{ content: "complete" }]);
  for (const maxTokens of [12000, 24000]) {
    saveSettings({ model: { maxTokens } });
    invalidateSettingsCache();
    await adapter(budgetMessages, { route: { ...budgetRoute, maxTokens: 64000 }, maxTokens: 1800 });
    assert.equal((await adapter.describe(budgetRoute)).maxTokens, maxTokens);
  }
  assert.deepEqual(requests.map((request) => request.maxTokens), [12000, 24000]);
  assert.equal(requests[1].reasoningEffort, "high");
}));

test("truncation retries once with a bounded larger budget and accounts for both attempts", () => budgetFixture(async () => {
  saveSettings({ model: { maxTokens: 4000, retryMaxTokens: 6000 } });
  const { adapter, requests } = budgetAdapter([
    { kind: "max-tokens", content: "partial", usage: { inputTokens: 10, outputTokens: 4000 } },
    { content: "complete", usage: { inputTokens: 10, outputTokens: 5000 } }
  ]);
  const result = await adapter(budgetMessages, { route: budgetRoute, maxTokens: 1800 });
  assert.equal(result.content, "complete");
  assert.deepEqual(requests.map((request) => request.maxTokens), [4000, 6000]);
  assert.equal(result.usage.promptTokens, 20);
  assert.equal(result.usage.completionTokens, 9000);
}));

test("persistent truncation reports stage, actual budget and usage, never partial success", () => budgetFixture(async () => {
  saveSettings({ model: { maxTokens: 4000, retryMaxTokens: 10000 } });
  const { adapter, requests } = budgetAdapter([{ kind: "max-tokens", content: "partial", usage: { inputTokens: 10, outputTokens: 4000 } }]);
  await assert.rejects(adapter(budgetMessages, { route: budgetRoute, requestLabel: "语境分析" }), (error) => {
    assert.equal(error.code, "KAMI_MODEL_TRUNCATED");
    assert.match(error.message, /语境分析.*8000.*设置.*模型/);
    assert.equal(error.details.attempts, 2);
    assert.equal(error.details.usage.completionTokens, 8000);
    return true;
  });
  assert.equal(requests.length, 2);
}));

test("disabled retry and unchanged provider caps do not repeat the same request", () => budgetFixture(async () => {
  for (const retryMaxTokens of [0, 16000]) {
    saveSettings({ model: { maxTokens: 4000, retryMaxTokens } });
    const { adapter, requests } = budgetAdapter([{ kind: "max-tokens" }], { prepare: (config) => ({ ...config, maxTokens: 4000 }) });
    await assert.rejects(adapter(budgetMessages, { route: budgetRoute }), /截断/);
    assert.equal(requests.length, 1);
  }
}));

test("transport failures retry only the failed call, discard partial output and stop after three retries", () => budgetFixture(async () => {
  const failure = { message: "DeepSeek Messages transport failed", code: "TRANSPORT" };
  const thrown = Object.assign(new Error(failure.message), { code: failure.code });
  const broken = { kind: "error", content: "partial", failure };
  const { adapter, requests } = budgetAdapter([broken, { error: thrown }, { content: "成功" }]);
  assert.equal((await adapter(budgetMessages, { route: budgetRoute })).content, "成功");
  assert.equal(requests.length, 3);
  const exhausted = budgetAdapter([broken]);
  await assert.rejects(exhausted.adapter(budgetMessages, { route: budgetRoute }), /自动重试 3 次.*transport failed/);
  assert.equal(exhausted.requests.length, 4);
  const other = budgetAdapter([{ kind: "error", failure: { code: "AUTH", message: "auth failed" } }]);
  await assert.rejects(other.adapter(budgetMessages, { route: budgetRoute }), /auth failed/);
  assert.equal(other.requests.length, 1);
}));

test("cancelling during transport backoff dispatches no more requests", () => budgetFixture(async () => {
  const controller = new AbortController();
  const { adapter, requests } = budgetAdapter([{ error: Object.assign(new Error("transport failed"), { code: "TRANSPORT" }) }]);
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(adapter(budgetMessages, { route: budgetRoute, signal: controller.signal }), { name: "AbortError" });
    assert.equal(requests.length, 1);
  } finally { clearTimeout(timer); }
}));

test("cancelled calls do not dispatch or retry", () => budgetFixture(async () => {
  const { adapter, requests } = budgetAdapter([{ kind: "max-tokens" }]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter(budgetMessages, { route: budgetRoute, signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests.length, 0);
}));

test("in-flight timeouts and cancellation are distinguished from truncation and never retried", () => budgetFixture(async () => {
  for (const cancel of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    const adapter = createModelAdapter({ llm: { async prepareCall(config) {
      return { config, async *stream() {
        calls += 1;
        if (cancel) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield { type: "finish", reason: { kind: "aborted" } };
      } };
    } } }, testLlm);
    await assert.rejects(adapter(budgetMessages, { route: budgetRoute, requestLabel: "语境分析", signal: controller.signal, timeoutMs: cancel ? 1000 : 5 }), cancel ? /语境分析已取消/ : /语境分析.*调用超时/);
    assert.equal(calls, 1);
  }
}));

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

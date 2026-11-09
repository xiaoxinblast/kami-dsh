import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelAdapter } from "../dsh/model-adapter.mjs";
import { createWorkbench } from "../dsh/workbench.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { invalidateSettingsCache } from "../src/settings-store.mjs";

test("saved settings reach real DSH DeepSeek HTTP requests for context analysis and QA", { skip: !process.env.DSH_TEST_DEEPSEEK_MODULE, timeout: 15000 }, async () => {
  const sdk = process.env.DSH_TEST_DEEPSEEK_MODULE;
  const [{ Context }, llm, { DeepSeekAdapter, resolveAdapterOptions }] = await Promise.all([
    import(new URL("../../cordis/lib/index.js", sdk)),
    import(new URL("../../dsh-llm/lib/index.js", sdk)),
    import(sdk)
  ]);
  const directory = await mkdtemp(join(tmpdir(), "kami-model-wire-")), requests = [];
  let truncateNext = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const truncated = truncateNext; truncateNext = false;
    const context = JSON.stringify(body.system).includes("语境分析员");
    const text = truncated ? "partial" : JSON.stringify(context ? { documentType: { purpose: "ui" }, sections: [{ from: 1, to: 1, purpose: "ui" }], crossRefs: [], notes: [] } : { issues: [] });
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: truncated ? "max_tokens" : "end_turn" }, usage: { output_tokens: truncated ? body.max_tokens : 30 } },
      { type: "message_stop" }
    ];
    res.setHeader("content-type", "text/event-stream");
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ctx = new Context(), runtime = new llm.default(ctx);
  const options = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, maxTokens: 32000 });
  const unregister = runtime.registerAdapter(["local-test"], new DeepSeekAdapter({
    options: () => options, resolveAuth: async () => ({ headers: {} }), resolveUserId: () => "test-user", resolveFiles: () => ({}),
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} })
  }));
  let workbench;
  const context = { human: true, modelRoute: { provider: "local-test", model: "deepseek-flash", reasoningEffort: "high" } };
  try {
    workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: createModelAdapter({ llm: runtime }, llm) });
    const { analyzeDocumentContextWithModel, evaluateTranslationWithModel } = await import("../src/provider.mjs");
    const settings = await workbench.invoke({ path: "/api/settings" }, context);
    for (const maxTokens of [12000, 24000]) {
      await workbench.invoke({ path: "/api/settings", method: "POST", body: { ...settings.settings, model: { maxTokens, retryMaxTokens: 64000 } } }, context);
      assert.equal((await workbench.perform({ action: "model" }, context)).maxTokens, maxTokens);
      const brief = await withRuntimeCall({ modelRoute: context.modelRoute }, () => analyzeDocumentContextWithModel({ entries: [{ i: 1, id: "s1", text: "設定" }] }));
      assert.equal(brief.part.entryCount, 1);
      await withRuntimeCall({ modelRoute: context.modelRoute }, () => evaluateTranslationWithModel({ contextPack: { source: "設定", targetLocale: "zh-CN" }, translation: "设置" }));
      assert.deepEqual(requests.slice(-2).map((request) => request.max_tokens), [maxTokens, maxTokens]);
    }
    await workbench.close();
    invalidateSettingsCache();
    workbench = await createWorkbench({ dataDirectory: directory, modelAdapter: createModelAdapter({ llm: runtime }, llm) });
    assert.equal((await workbench.invoke({ path: "/api/settings" }, context)).settings.model.maxTokens, 24000);
    truncateNext = true;
    await withRuntimeCall({ modelRoute: context.modelRoute }, () => analyzeDocumentContextWithModel({ entries: [{ i: 1, id: "s1", text: "設定" }] }));
    assert.deepEqual(requests.slice(-2).map((request) => request.max_tokens), [24000, 48000]);
    assert.ok(requests.every((request) => request.model === "deepseek-flash" && request.output_config.effort === "high"));
    context.modelRoute = { provider: "local-test", model: "deepseek-v4-pro", reasoningEffort: "max" };
    await withRuntimeCall({ modelRoute: context.modelRoute }, () => analyzeDocumentContextWithModel({ entries: [{ i: 1, id: "s1", text: "設定" }] }));
    assert.equal(requests.at(-1).model, "deepseek-v4-pro");
    assert.equal(requests.at(-1).output_config.effort, "max");
    assert.equal(requests.at(-1).max_tokens, 24000);
  } finally {
    await workbench?.close(); unregister(); await ctx.fiber.dispose();
    await new Promise((resolve) => server.close(resolve));
    invalidateSettingsCache();
    await rm(directory, { recursive: true, force: true });
  }
});

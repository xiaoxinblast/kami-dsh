import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * DSH 适配层：思考块（reasoning-delta）要交给调用方落日志，失败/中断时保留已流出的部分。
 * 只搬运 SDK 已经产出的块，不额外发请求，也不进入后续上下文。
 */
const directory = await mkdtemp(join(tmpdir(), "kami-adapter-reasoning-"));
process.env.KAMI_PROVIDER_DIRECTORY = directory;

const { createModelAdapter } = await import("../dsh/model-adapter.mjs");
const { withRuntimeCall } = await import("../src/runtime-context.mjs");
const { invalidateSettingsCache } = await import("../src/settings-store.mjs");

test.after(async () => { invalidateSettingsCache(); await rm(directory, { recursive: true, force: true }); });

const fakeLlm = {
  BlockAssembler: class {
    constructor() { this.parts = []; this.finish = { kind: "stop" }; this.usage = null; }
    push(chunk) {
      if (chunk.type === "reasoning-delta") {
        const last = this.parts.at(-1);
        if (last?.type === "reasoning") last.text += chunk.text;
        else this.parts.push({ type: "reasoning", text: chunk.text });
      }
      if (chunk.type === "text-delta") this.parts.push({ type: "text", text: chunk.text });
      if (chunk.type === "usage") this.usage = chunk.usage;
      if (chunk.type === "finish") this.finish = chunk.reason;
    }
    blocks() { return this.parts; }
  }
};

const route = { provider: "test", model: "selected-model", reasoningEffort: "high" };
const messages = [{ role: "user", content: "翻译这一段" }];

function adapterWith(chunks) {
  const adapter = createModelAdapter({
    llm: {
      prepareCall: async (config) => ({
        config,
        async *stream() {
          for (const chunk of chunks) {
            if (chunk instanceof Error) throw chunk;
            yield chunk;
          }
        }
      })
    }
  }, fakeLlm);
  return adapter;
}

test("适配层把 reasoning 块交给 onReasoning 并随结果返回", async () => {
  const seen = [];
  const adapter = adapterWith([
    { type: "reasoning-delta", index: 0, text: "先看敬语，" },
    { type: "reasoning-delta", index: 0, text: "再定中文语气。" },
    { type: "text-delta", index: 1, text: "欢迎光临" },
    { type: "finish", reason: { kind: "stop" } }
  ]);
  const result = await withRuntimeCall({}, () => adapter(messages, { route, onReasoning: (text, meta) => seen.push({ text, meta }) }));
  assert.equal(result.reasoning, "先看敬语，再定中文语气。");
  assert.equal(result.content, "欢迎光临");
  assert.deepEqual(seen.map((item) => item.text), ["先看敬语，再定中文语气。"]);
  assert.equal(seen[0].meta.status, "ok");
});

test("流中断时保留已经流出的思考，并标记失败", async () => {
  const seen = [];
  const adapter = adapterWith([
    { type: "reasoning-delta", index: 0, text: "半截思考" },
    new Error("连接中断")
  ]);
  await assert.rejects(() => withRuntimeCall({}, () => adapter(messages, { route, onReasoning: (text, meta) => seen.push({ text, meta }) })));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "半截思考");
  assert.equal(seen[0].meta.status, "failed");
});

import test from "node:test";
import assert from "node:assert/strict";
import { checkBatchConsistencyWithModel } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

test("consistency format repair allows a response taking longer than one minute", async () => {
  let calls = 0;
  const findings = [{ ids: ["s1", "s2"], type: "term_drift", detail: "同一名称出现两种译法", suggestion: "核对名称" }];
  await withRuntimeCall({ modelAdapter: async (_messages, options) => {
    if (++calls === 1) return { content: "本轮返回了说明而非JSON" };
    // Simulate a valid 90-second repair without waiting in the test.
    if (options.timeoutMs < 90_000) throw new Error("format repair timed out before its valid response");
    return { content: JSON.stringify({ findings }) };
  } }, async () => {
    const result = await checkBatchConsistencyWithModel({ pairs: [{ id: "s1", source: "A", translation: "甲" }, { id: "s2", source: "A", translation: "乙" }] });
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].ids, ["s1", "s2"]);
  });
  assert.equal(calls, 2);
});

test("invalid consistency repair still fails instead of publishing an empty successful report", async () => {
  let calls = 0;
  await withRuntimeCall({ modelAdapter: async () => { calls++; return { content: "仍然不是JSON" }; } }, async () => {
    await assert.rejects(checkBatchConsistencyWithModel({ pairs: [{ id: "s1", source: "A", translation: "甲" }] }), /一致性检查模型返回格式无效/);
  });
  assert.equal(calls, 2);
});

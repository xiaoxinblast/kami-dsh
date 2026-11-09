import test from "node:test";
import assert from "node:assert/strict";
import { microBatchSegments, parseMicroBatchTranslations } from "../src/micro-batch.mjs";
import { measureStage } from "../src/performance.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

const segments = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, source: `短い台詞${index}`, status: "pending", locator: { sheet: "台詞" } }));

test("小批只包含最多四条连续短句，已完成、人工接受、边界和长句均截断分组", () => {
  const select = (items) => microBatchSegments(items, 0, () => "dialogue");
  assert.deepEqual(select(segments).map(s => s.id), ["s0", "s1", "s2", "s3"]);
  for (const patch of [{ status: "done" }, { accepted: true }, { selected: false }, { source: "長".repeat(121) }, { locator: { sheet: "别处" } }]) {
    assert.deepEqual(select(segments.map((s, i) => i === 2 ? { ...s, ...patch } : s)).map(s => s.id), ["s0", "s1"]);
  }
  assert.equal(microBatchSegments(segments, 0, (_, i) => i > 0 ? "rules" : "dialogue").length, 1);
  assert.equal(microBatchSegments(segments, 0, () => "marketing").length, 1);
});

test("小批严格校验 ID 一一对应，拒绝重复、未知、缺失、说明污染和标签丢失", () => {
  const entries = [{ id: "a", source: "<b>開始</b>" }, { id: "b", source: "終了" }];
  const valid = [{ id: "b", translation: "结束" }, { id: "a", translation: "<b>开始</b>" }];
  assert.deepEqual(parseMicroBatchTranslations(JSON.stringify({ translations: valid }), entries).map(x => x.id), ["a", "b"]);
  for (const list of [valid.slice(0, 1), [...valid, valid[0]], [valid[0], { ...valid[1], id: "unknown" }], [valid[0], { ...valid[1], translation: "开始" }], [valid[0], { ...valid[1], translation: "<b>开始</b>\n非译文说明：未能查阅风格指南原件。" }]]) {
    assert.throws(() => parseMicroBatchTranslations(JSON.stringify({ translations: list }), entries));
  }
  assert.throws(() => parseMicroBatchTranslations('{"translations":[]}', entries));
  assert.throws(() => parseMicroBatchTranslations('broken', entries));
});

test("分阶段计时在失败时也记录耗时，互相并发的请求不串记录", async () => {
  const first = { events: [] }, second = { events: [] };
  await Promise.all([
    withRuntimeCall({ performanceTrace: first }, async () => {
      await assert.rejects(measureStage("qa", async () => { throw new Error("test failure"); }));
    }),
    withRuntimeCall({ performanceTrace: second }, () => measureStage("translation", async () => 42))
  ]);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].stage, "qa");
  assert.equal(first.events[0].status, "failed");
  assert.ok(first.events[0].durationMs >= 0);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].status, "completed");
});

import test from "node:test";
import assert from "node:assert/strict";
import { microBatchSegments, parseMicroBatchTranslations } from "../src/micro-batch.mjs";
import { measureStage } from "../src/performance.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

const segments = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, source: `短い台詞${index}`, status: "pending", locator: { sheet: "台詞" } }));

test("按句段数和原文字数先到的上限分组，遇到已处理句段、工作表或用途变化即停止", () => {
  const select = (items) => microBatchSegments(items, 0, () => "dialogue", { maxSegments: 4, maxChars: 120 });
  assert.deepEqual(select(segments).map(s => s.id), ["s0", "s1", "s2", "s3"]);
  for (const patch of [{ status: "done" }, { accepted: true }, { selected: false }, { source: "長".repeat(121) }, { locator: { sheet: "别处" } }]) {
    assert.deepEqual(select(segments.map((s, i) => i === 2 ? { ...s, ...patch } : s)).map(s => s.id), ["s0", "s1"]);
  }
  assert.equal(microBatchSegments(segments, 0, (_, i) => i > 0 ? "rules" : "dialogue").length, 1);
  assert.equal(microBatchSegments(segments, 0, () => "marketing").length, 6);
  const units = ["🌟日", "🌟", "本", "日本語"].map(source => ({ source }));
  assert.equal(microBatchSegments(units, 0, () => "dialogue", { maxChars: 3 }).length, 2);
  assert.equal(microBatchSegments(units, 3, () => "dialogue", { maxChars: 1 })[0].source, "日本語");
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

test("分组结果只回退串入邻句呼语或漏换行的那一段", () => {
  const entries = [{ id: "a", source: "鍵が見つかった。" }, { id: "b", source: "船長、こちらへ。", terms: [{ source: "船長", target: "船长" }] }, { id: "c", source: "今\n戻る。" }];
  const translations = [{ id: "a", translation: "船长，钥匙找到了。" }, { id: "b", translation: "船长，这边请。" }, { id: "c", translation: "这就回来。" }];
  assert.deepEqual(parseMicroBatchTranslations(JSON.stringify({ translations }), entries, { partial: true }).map(row => row.id), ["b"]);
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

import test from "node:test";
import assert from "node:assert/strict";

import { buildPatternKey, selectPatternReferences } from "../src/pattern-memory.mjs";

test("同固定框架、不同数字/术语/引号内容得到同一骨架", () => {
  const terms = [{ source: "プレミアムパス", target: "高级通行证" }];
  const a = buildPatternKey("プレミアムパスを購入すると、3個の宝箱を獲得します。", { terms });
  const b = buildPatternKey("プレミアムパスを購入すると、10個の宝箱を獲得します。", { terms });
  assert.equal(a, b);
  assert.match(a, /⟦术⟧/u);
  assert.match(a, /⟦数⟧/u);
  assert.notEqual(a, buildPatternKey("レベルが足りません。", { terms }));
});

test("同骨架优先选已有参考，最多 3 条，不带空译文", () => {
  const terms = [{ source: "プレミアムパス", target: "高级通行证" }];
  const previous = [
    { segmentId: "s1", source: "プレミアムパスを購入すると、3個の宝箱を獲得します。", target: "购买高级通行证可获得 3 个宝箱。", patternKey: "x" },
    { segmentId: "s2", source: "プレミアムパスを購入すると、10個の宝箱を獲得します。", target: "购买高级通行证可获得 10 个宝箱。" },
    { segmentId: "s3", source: "プレミアムパスを購入すると、20個の宝箱を獲得します。", target: "" },
    { segmentId: "s4", source: "プレミアムパスを購入すると、30個の宝箱を獲得します。", target: "购买高级通行证可获得 30 个宝箱。" }
  ];
  const refs = selectPatternReferences({ source: "プレミアムパスを購入すると、99個の宝箱を獲得します。", terms, previous });
  assert.deepEqual(refs.map((ref) => ref.segmentId), ["s2", "s4"]);
  assert.equal(refs[0].target, "购买高级通行证可获得 10 个宝箱。");
});

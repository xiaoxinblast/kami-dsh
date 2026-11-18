import test from "node:test";
import assert from "node:assert/strict";
import { runSegmentWorkflow } from "../src/segment-workflow.mjs";
import { jaZhGuidance } from "../src/ja-zh-guidance.mjs";

test("只检查初稿，将提示传给同一次校对，校对稿不自动复检", async () => {
  const calls = [];
  for (const id of [1, 2]) {
    const result = await runSegmentWorkflow({
      translate: async () => { calls.push(`${id}:翻译`); return { translation: "对事件进行研究。" }; },
      proofread: async (draft, hints) => { calls.push(`${id}:校对`); assert.equal(draft, "对事件进行研究。"); assert.deepEqual(hints, ["受保护内容缺失：{id}"]); return "研究这起事件。"; },
      check: async (draft) => { calls.push(`${id}:规则`); assert.equal(draft, "对事件进行研究。"); return [{ type: "protected_token", message: "受保护内容缺失：{id}" }, { type: "register_casual", message: "语气" }]; }
    });
    assert.equal(result.translation, "研究这起事件。");
    assert.equal(result.stages.draftQa.status, "completed");
    assert.equal(result.stages.localQa.status, "optional");
    assert.deepEqual(result.issues, []);
  }
  assert.deepEqual(calls, ["1:翻译", "1:规则", "1:校对", "2:翻译", "2:规则", "2:校对"]);
});

test("校对失败保留初译，不启动本地 QA；各阶段重试只执行该阶段", async () => {
  const failed = await runSegmentWorkflow({ translate: async () => ({ translation: "初译" }),
    proofread: async () => { throw new Error("校对不可用"); }, check: () => [] });
  assert.equal(failed.translation, "初译");
  assert.equal(failed.stages.proofreading.status, "failed");
  assert.equal(failed.stages.localQa.status, "pending");
  for (const stage of ["translation", "proofreading", "localQa"]) {
    const calls = [];
    const result = await runSegmentWorkflow({ stage, translation: "已有译文", stages: { proofreading: { status: "completed" }, localQa: { status: "completed" } },
      translate: async () => { calls.push("translation"); return { translation: "重译" }; },
      proofread: async () => { calls.push("proofreading"); return "校对稿"; },
      check: async () => { calls.push("localQa"); return [{ severity: "error", message: "占位符缺失" }]; }
    });
    assert.deepEqual(calls, stage === "proofreading" ? ["localQa", "proofreading"] : [stage]);
    if (stage !== "localQa") assert.equal(result.stages.localQa.status, stage === "proofreading" ? "optional" : "pending");
    else assert.equal(result.issues.length, 1, "完成检查不等于没有规则错误");
  }
});

test("日中十项规则限定语言对，保留不确定性且不默认为男性", () => {
  const text = jaZhGuidance({ sourceLanguage: "Japanese", targetLocale: "zh-CN" });
  assert.equal(text.split("\n").length, 11);
  assert.match(text, /不得改变事实确定性/);
  assert.match(text, /禁止默认用“他”/);
  assert.equal(jaZhGuidance({ sourceLanguage: "English", targetLocale: "zh-CN" }), "");
  assert.equal(jaZhGuidance({ sourceLanguage: "ja", targetLocale: "en-US" }), "");
});

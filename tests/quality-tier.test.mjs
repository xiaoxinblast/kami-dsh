import test from "node:test";
import assert from "node:assert/strict";
import {
  QUALITY_TIER_VALUES,
  assessSegmentSignals,
  describeTierStrength,
  planQualityTier,
  resolveManualTier,
  selectQualityTier
} from "../src/quality-tier.mjs";
import { assessTranslationRisk } from "../src/translation-routing.mjs";

test("质量档只暴露自动与三档", () => {
  assert.deepEqual([...QUALITY_TIER_VALUES], ["auto", "fast", "standard", "strict"]);
});

test("旧生成路线映射到质量档，显式档位优先", () => {
  assert.equal(resolveManualTier({ route: "direct" }), "fast");
  assert.equal(resolveManualTier({ route: "reflective" }), "standard");
  assert.equal(resolveManualTier({ route: "fact_guarded" }), "strict");
  assert.equal(resolveManualTier({ route: "multi_candidate" }), "strict");
  assert.equal(resolveManualTier({ route: "mt_post_edit" }), "strict");
  assert.equal(resolveManualTier({ qualityTier: "fast", route: "fact_guarded" }), "fast");
  assert.equal(resolveManualTier({ qualityTier: "没这个档" }), "auto");
});

test("逐段自动判档：短标签走快速，事实与承诺走严苛，其余标准", () => {
  assert.equal(selectQualityTier({ source: "確認", purpose: "ui" }).tier, "fast");
  assert.equal(selectQualityTier({ source: "ポーション", purpose: "item_name" }).tier, "fast");
  assert.equal(
    selectQualityTier({ source: "本キャンペーンは 8 月 20 日 10:00 に終了します。", purpose: "announcement", factCount: 2 }).tier,
    "strict"
  );
  assert.equal(selectQualityTier({ source: "ご利用規約に同意してください。", purpose: "general" }).tier, "strict");
  assert.equal(selectQualityTier({ source: "限时抢购，立刻购买！", purpose: "marketing" }).tier, "standard");
  assert.equal(selectQualityTier({ source: "この先は危険です。", purpose: "dialogue" }).tier, "standard");
  const long = selectQualityTier({ source: "説明".repeat(200), purpose: "narrative" });
  assert.equal(long.tier, "standard");
  assert.equal(selectQualityTier({ source: "HPは100、MPは50です。", purpose: "item_description", factCount: 2 }).tier, "standard");
  assert.equal(selectQualityTier({ source: "確認", purpose: "ui", termConflicts: 1 }).tier, "standard");
  assert.equal(selectQualityTier({ source: "確認", purpose: "ui", protectedTokens: ["{a}", "{b}", "{c}"] }).tier, "standard");
  assert.equal(selectQualityTier({ source: "確認", purpose: "ui", metadata: [{ role: "constraint", value: "8 字" }, { role: "constraint", value: "两行以内" }] }).tier, "strict");
  const manual = selectQualityTier({ source: "確認", purpose: "ui", manualTier: "strict" });
  assert.equal(manual.tier, "strict");
  assert.equal(manual.manual, true);
  assert.equal(manual.reason, "手动指定");
});

test("约束类元数据不接受快速档", () => {
  const signals = assessSegmentSignals({
    source: "確認",
    purpose: "ui",
    metadata: [{ label: "字数限制", value: "8 字", role: "constraint" }]
  });
  assert.equal(signals.constraintMetadata, true);
  assert.equal(selectQualityTier({
    source: "確認",
    purpose: "ui",
    metadata: [{ label: "字数限制", value: "8 字", role: "constraint" }]
  }).tier, "standard");
});

test("中日文强约束措辞都会抬高风险，日语不再漏判", () => {
  const chinese = assessTranslationRisk({ source: "本活动最终解释权归主办方所有。", contentType: "announcement" });
  assert.ok(chinese.reasons.some((reason) => reason.includes("强约束")));
  const japanese = assessTranslationRisk({ source: "必ず時間内にお手続きください。", contentType: "announcement" });
  assert.ok(japanese.reasons.some((reason) => reason.includes("强约束")), "日语的必ず必须命中强约束");
  const legal = assessTranslationRisk({ source: "規約に同意したものとみなします。", contentType: "announcement" });
  assert.ok(legal.reasons.some((reason) => reason.includes("强约束")));
});

test("质量档映射到执行计划：模型角色、候选数与修订轮次", () => {
  const fast = planQualityTier({ tier: "fast", provider: { model: "main", fastModel: "fast" } });
  assert.equal(fast.route, "direct");
  assert.equal(fast.modelRole, "fast");
  assert.equal(fast.model, "fast");
  assert.equal(fast.modelQa, false);
  assert.equal(fast.maxRevisions, 0);
  assert.equal(fast.upgradeTier, "standard");

  const standard = planQualityTier({ tier: "standard", provider: { model: "main" } });
  assert.equal(standard.route, "reflective");
  assert.equal(standard.modelQa, true);
  assert.equal(standard.maxRevisions, 1);
  assert.equal(standard.upgradeTier, "strict");

  const strict = planQualityTier({ tier: "strict", purpose: "announcement", provider: { model: "main" } });
  assert.equal(strict.route, "fact_guarded");
  assert.equal(strict.modelRole, "main");
  assert.equal(strict.modelFallback, true, "没配高质量模型时必须标注回落");
  assert.equal(strict.maxRevisions, 2);
  assert.equal(strict.reflect, false, "严苛档由统一 QA 审查，不重复反思");
  assert.match(describeTierStrength({ tier: "strict", provider: {} }), /未启用更强模型/u);

  const creative = planQualityTier({ tier: "strict", purpose: "marketing", provider: { model: "main" } });
  assert.equal(creative.route, "fact_guarded");
  assert.equal(creative.candidateCount, 1);

  const postEdit = planQualityTier({ tier: "strict", purpose: "announcement", provider: { model: "main", mtModel: "mt" } });
  assert.equal(postEdit.route, "fact_guarded");
  assert.equal(planQualityTier({ tier: "strict", manualRoute: "multi_candidate" }).route, "multi_candidate");
  assert.match(describeTierStrength({ tier: "strict", provider: { qualityModel: "quality" } }), /quality/u);
});

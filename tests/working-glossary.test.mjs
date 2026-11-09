import test from "node:test";
import assert from "node:assert/strict";

import { matchTerms } from "../src/matcher.mjs";
import { runQa } from "../src/qa.mjs";
import {
  emptyWorkingGlossary,
  formalTermKeys,
  mergeWorkingAssets,
  mergeWorkingTermsIntoGlossary,
  normalizeWorkingTerm,
  normalizeWorkingTerms
} from "../src/working-glossary.mjs";

const formalTerms = [{
  id: "t1", source: "ナビマップ", aliases: [], target: "导览地图",
  forbidden: [], status: "approved", assetTier: "formal", locale: "ja-JP"
}];

test("工作术语的近似命中不进入正式术语裁决", () => {
  const match = { mode: "fuzzy", matchPhrase: "チーム隊", term: { source: "チーム３", target: "小队3", working: true } };
  const projectSettings = { version: 3, qa: { rules: { term_potential: { enabled: true, severity: "warning" } } } };
  assert.equal(runQa({ source: "チーム隊だ", translation: "是小队", projectSettings, matches: [match] }).some(i => i.type === "potential_term"), false);
  assert.equal(runQa({ source: "チーム隊だ", translation: "是小队", projectSettings, matches: [{ ...match, term: { ...match.term, working: false } }] }).some(i => i.type === "potential_term"), true);
});

test("工作术语严格校验：原文/译文逐字子串，主术语库优先", () => {
  const formalKeys = formalTermKeys(formalTerms);
  assert.equal(normalizeWorkingTerm({ source: "プレミアムパス", target: "高级月票" }, { sourceText: "プレミアムパスを購入", targetText: "购买高级通行证", formalKeys }), null);
  const valid = normalizeWorkingTerm({ source: "プレミアムパス", target: "高级通行证" }, { sourceText: "プレミアムパスを購入", targetText: "购买高级通行证", formalKeys });
  assert.equal(valid?.target, "高级通行证");
  assert.equal(normalizeWorkingTerm({ source: "ナビマップ", target: "导航图" }, { sourceText: "ナビマップ", targetText: "导航图", formalKeys }), null);
});

test("首次出现的译法锁定，同源不同译法只记冲突", () => {
  let glossary = emptyWorkingGlossary({ batchId: "b1", filename: "a.mqxliff" });
  const first = normalizeWorkingTerms([{ source: "プレミアムパス", target: "高级通行证", confidence: 0.9 }], { formalKeys: formalTermKeys(formalTerms) });
  glossary = mergeWorkingTermsIntoGlossary(glossary, first, { sourceSegmentId: "seg-1" });
  const second = normalizeWorkingTerms([{ source: "プレミアムパス", target: "高级月票", confidence: 0.9 }], { formalKeys: formalTermKeys(formalTerms) });
  glossary = mergeWorkingTermsIntoGlossary(glossary, second, { sourceSegmentId: "seg-2" });
  assert.equal(glossary.terms.length, 1);
  assert.equal(glossary.terms[0].target, "高级通行证");
  assert.equal(glossary.conflicts.length, 1);
  assert.equal(glossary.revision, 1);
});

test("合并后的工作术语能被 matchTerms 命中，且主库同源词不会被工作术语覆盖", () => {
  const glossary = emptyWorkingGlossary({ batchId: "b1" });
  glossary.terms = normalizeWorkingTerms([
    { source: "プレミアムパス", target: "高级通行证" },
    { source: "ナビマップ", target: "导航图" }
  ], { formalKeys: formalTermKeys(formalTerms) });
  const assets = mergeWorkingAssets({ locale: "ja-JP", terms: formalTerms }, glossary, { batchId: "b1" });
  assert.equal(assets.terms.filter((term) => term.source === "ナビマップ").length, 1, "主库同源词必须保留且只有正式条目");
  const matches = matchTerms("プレミアムパスとナビマップ", assets, { contentType: "general", domain: "game" });
  assert.equal(matches.find((match) => match.term.source === "プレミアムパス")?.term.target, "高级通行证");
  assert.equal(matches.find((match) => match.term.source === "プレミアムパス")?.working, true);
  assert.equal(matches.find((match) => match.term.source === "ナビマップ")?.term.target, "导览地图");
});

test("工作术语不命中未登记的长单词内部，正式术语保留原匹配规则", () => {
  const assets = mergeWorkingAssets({ locale: "zh-CN", terms: [] }, { terms: [
    { source: "ミナ", target: "米娜", aliases: ["カイ"] },
    { source: "STAR", target: "星星" }
  ] });
  for (const exactOnly of [false, true]) {
    for (const source of ["ミナミへ進め", "カイザーだ", "START now", "ミナとミナミへ進め"]) {
      assert.deepEqual(matchTerms(source, assets, { exactOnly }), [], source);
    }
    for (const source of ["ミナ、進め", "カイは進め", "STAR now"]) {
      assert.equal(matchTerms(source, assets, { exactOnly }).length, 1, source);
    }
  }
  const formal = { locale: "zh-CN", terms: [{ ...assets.terms[0], working: false }] };
  assert.equal(matchTerms("ミナミへ進め", formal, { exactOnly: true }).length, 1);
});

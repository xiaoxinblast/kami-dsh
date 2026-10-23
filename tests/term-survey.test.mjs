import test from "node:test";
import assert from "node:assert/strict";
import { alignSurveyToHumanFinal, decideTermWrite, normalizeSurveyTerms, parseTermAlign, pendingCandidateFromUnresolved, pendingReason, surveyPairs } from "../src/term-survey.mjs";

/**
 * 翻译期术语普查 + 回填确认。核心安全边界：模型只负责"哪个词像术语"，
 * 译法必须由人工终稿确认；不满足条件的只能进待审核，不能自动写库。
 */
const existingTerms = [{ id: "term-1", source: "星葬の玉座", target: "星葬王座", forbidden: ["星葬宝座"] }];

test("普查结果只保留像术语的条目，并且跳过库里已有的源词", () => {
  const terms = normalizeSurveyTerms([
    { source: "崩兆の片", suggestedTarget: "崩兆之隅", reason: "地名", confidence: 0.92 },
    { source: "星葬の玉座", suggestedTarget: "星葬王座", reason: "已在库", confidence: 0.9 },
    { source: "崩兆の片", suggestedTarget: "崩兆碎片", reason: "重复", confidence: 0.5 },
    { source: "", suggestedTarget: "空" },
    { source: "あ".repeat(41), suggestedTarget: "过长源词", confidence: 0.9 }
  ], { existingTerms });
  assert.equal(terms.length, 1);
  assert.equal(terms[0].source, "崩兆の片");
  assert.equal(terms[0].suggestedTarget, "崩兆之隅");
});

test("回填时用人工终稿核对：逐字保留→confirmed，被改掉→unresolved，原文没出现→丢弃", () => {
  const pairs = [{
    id: "seg-1",
    source: "崩兆の片 へ向かう。PRIVACY & DATA を確認。",
    machineTranslation: "前往崩兆碎片。确认隐私与数据。",
    humanFinal: "前往崩兆之隅。确认 PRIVACY & DATA。"
  }];
  const aligned = alignSurveyToHumanFinal({
    terms: [
      { source: "崩兆の片", suggestedTarget: "崩兆碎片", confidence: 0.8 },
      { source: "PRIVACY & DATA", suggestedTarget: "PRIVACY & DATA", confidence: 0.95 },
      { source: "存在しない語", suggestedTarget: "不存在的词", confidence: 0.9 }
    ],
    pairs
  });
  assert.deepEqual(aligned.noEvidence.map((item) => item.source), ["存在しない語"]);
  assert.deepEqual(aligned.confirmed.map((item) => item.source), ["PRIVACY & DATA"]);
  assert.equal(aligned.confirmed[0].verbatim, true);
  assert.deepEqual(aligned.unresolved.map((item) => item.source), ["崩兆の片"]);
  assert.equal(aligned.unresolved[0].humanFinal, "前往崩兆之隅。确认 PRIVACY & DATA。");
  assert.equal(aligned.unresolved[0].verbatim, false);
});

test("只有“库里没有 + 终稿逐字保留 + 形态合规”才自动入库", () => {
  const base = { source: "崩兆の片", target: "崩兆之隅", proposalAction: "create_term", verbatim: true };
  assert.equal(decideTermWrite(base, { existingTerms }).auto, true);

  const inferred = decideTermWrite({ ...base, verbatim: false }, { existingTerms });
  assert.equal(inferred.auto, false);
  assert.match(inferred.reason, /尚未核实|置信度不足/u);

  const conflict = decideTermWrite({ ...base, proposalAction: "resolve_conflict" }, { existingTerms });
  assert.equal(conflict.auto, false);
  assert.match(conflict.reason, /冲突/u);

  const disabled = decideTermWrite(base, { existingTerms, autoWriteEnabled: false });
  assert.equal(disabled.auto, false);
  assert.match(disabled.reason, /自动入库已关闭/u);

  const blocked = decideTermWrite({ source: "星葬の玉座", target: "星葬宝座", proposalAction: "create_term", verbatim: true }, { existingTerms });
  assert.equal(blocked.auto, false);
  assert.match(blocked.reason, /禁用译法/u);

  const tooLong = decideTermWrite({ ...base, target: "很".repeat(61) }, { existingTerms });
  assert.equal(tooLong.auto, false);
  assert.match(tooLong.reason, /长度上限/u);
});

test("待审候选把入库判定与模型依据一起写清", () => {
  const reason = pendingReason({ reason: "地名，全篇一致" }, { reason: "人工终稿改动了 AI 建议的译法，需要人工确认" });
  assert.match(reason, /人工终稿改动了 AI 建议的译法/u);
  assert.match(reason, /模型依据：地名/u);
});

test("人工纠正译法可凭终稿证据入库，低置信、编造与多处冲突不能自动写入", () => {
  const original = { source: "星屑結晶", suggestedTarget: "星尘结晶", segmentSource: "星屑結晶を使います。", humanFinal: "使用星屑晶石。" };
  const parsed = parseTermAlign(JSON.stringify({ matches: [{ source: original.source, found: true, target: "星屑晶石", confidence: 0.99 }] }), { items: [original] });
  assert.equal(parsed.matches.length, 1);
  const candidate = parsed.matches[0];
  assert.equal(candidate.humanFinalVerified, true);
  assert.equal(decideTermWrite({ ...candidate, proposalAction: "create_term" }).auto, true);
  assert.equal(decideTermWrite({ ...candidate, confidence: 0.4 }).auto, false);
  assert.equal(parseTermAlign('{"matches":[{"source":"星屑結晶","found":true,"target":"凭空译法","confidence":1}]}', { items: [original] }).matches.length, 0);
  const conflict = parseTermAlign('{"matches":[{"source":"星屑結晶","found":true,"target":"星屑晶石","confidence":1},{"source":"星屑結晶","found":true,"target":"晶石","confidence":1}]}', { items: [original] });
  assert.equal(conflict.matches.length, 0);
  const mixed = alignSurveyToHumanFinal({ terms: [{ source: "星屑結晶", suggestedTarget: "星尘结晶" }], pairs: [{ source: original.segmentSource, humanFinal: original.humanFinal }, { source: original.segmentSource, humanFinal: "使用星尘结晶。" }] });
  assert.equal(mixed.confirmed.length, 0);
  assert.equal(mixed.unresolved.length, 1);
});

test("普查只取已选中且有译文的句段", () => {
  const pairs = surveyPairs([
    { id: "seg-1", source: "原文", translation: "译文", selected: true },
    { id: "seg-2", source: "原文2", translation: "", selected: true },
    { id: "seg-3", source: "原文3", translation: "译文3", selected: false }
  ]);
  assert.deepEqual(pairs, [{ id: "seg-1", source: "原文", translation: "译文" }]);
});

test("人工改掉译法又没解析出来时，转成待审核候选而不是丢弃", () => {
  const record = pendingCandidateFromUnresolved({
    source: "崩兆の片",
    suggestedTarget: "崩兆碎片",
    confidence: 0.7,
    segmentSource: "崩兆の片 へ向かう。",
    humanFinal: "前往崩兆之隅。"
  }, { locale: "zh-CN", contentType: "general", domain: "game", project: "p-1", batchId: "b-1", filename: "review.xlsx" });
  assert.equal(record.decision, "review");
  assert.equal(record.candidateOrigin, "term-survey:needs-review");
  assert.equal(record.target, "崩兆碎片", "先放 AI 原建议，审核页可以直接改");
  assert.match(record.reasons[0], /人工终稿改动了 AI 建议的译法/u);
  assert.equal(record.evidence.targetExcerpt, "前往崩兆之隅。", "证据要带上人工终稿片段，方便核对");
  assert.equal(record.locale, "zh-CN");
  assert.equal(pendingCandidateFromUnresolved({ source: "", suggestedTarget: "x" }, { locale: "zh-CN" }), null);
});

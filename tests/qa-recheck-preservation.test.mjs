import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const loopCode = source.slice(source.indexOf("async function runAiQaLoop("), source.indexOf("function importStatistics("));

for (const potentialTerm of [false, true]) {
  test(`QA 检查模式在低分及术语疑点下仍只评分原译：${potentialTerm}`, async () => {
    const evaluated = [], saved = [];
    const loop = vm.runInNewContext(`(${loopCode.trim()})`, {
      embedSource: async () => { throw new Error("已有译例时不应再次计算向量"); }, splitReferenceAuthority: () => ({ approved: [], machineDrafts: [] }),
      buildReferenceToolRunner: () => null,
      runQa: () => potentialTerm ? [{ type: "potential_term", severity: "warning", message: "待裁决" }] : [],
      getSettings: () => ({ orthography: {} }), checkFactSchema: () => [], extractFactSchema: () => ({}), applyProjectQaPolicy: value => value,
      calculateQaScore: () => 70, presentAiQaIssues: value => value,
      adjudicatePotentialTermsWithModel: async () => ({ translation: "术语改写稿", decisions: [] }),
      reviseTranslationWithQa: async () => "自动修订稿",
      evaluateTranslationWithModel: async ({ translation }) => { evaluated.push(translation); return [{ severity: "major", message: "待复核" }]; },
      getProviderConfig: () => ({ model: "test" }), saveQaRun: async value => saved.push(value), saveQaCase: async () => {}
    });
    const result = await loop({ contextPack: { source: "原文" }, initialTranslation: "已确认译文", matches: [], providedReferences: [], maxRevisions: 0 });
    assert.equal(result.translation, "已确认译文");
    assert.deepEqual(evaluated, ["已确认译文"]);
    assert.equal(result.iterations, 0);
    assert.equal(result.score, 70);
    assert.equal(result.status, "review");
    assert.equal(saved[0].finalTranslation, "已确认译文");
  });
}

test("独立 QA 接口禁用自动修订，初译自动修订仍保留默认预算", () => {
  const route = source.slice(source.indexOf('  if (req.method === "POST" && url.pathname === "/api/qa")'), source.indexOf("async function evaluateQaPairList("));
  assert.match(route, /runAiQaLoop\(\{[^;]+maxRevisions: 0/u);
  assert.match(loopCode, /maxRevisions = 2/u);
});

test("修订只做本地规则检查，保留阻断项和修订前案例，不生成最终模型分数", async () => {
  const evaluated = [], checked = [], cases = [];
  const loop = vm.runInNewContext(`(${loopCode.trim()})`, {
    splitReferenceAuthority: () => ({ approved: [], machineDrafts: [] }), buildReferenceToolRunner: () => null,
    runQa: ({ translation }) => { checked.push(translation); return translation === "修订稿" ? [{ type: "placeholder", severity: "error", message: "缺少占位符" }] : []; },
    getSettings: () => ({ orthography: {} }), checkFactSchema: () => [], extractFactSchema: () => ({}), applyProjectQaPolicy: value => value,
    calculateQaScore: () => 70, presentAiQaIssues: value => value,
    reviseTranslationWithQa: async () => "修订稿",
    evaluateTranslationWithModel: async ({ translation }) => { evaluated.push(translation); return [{ severity: "major", message: "初稿误译" }]; },
    getProviderConfig: () => ({ model: "test" }), saveQaRun: async () => {}, saveQaCase: async value => cases.push(value)
  });
  const result = await loop({ contextPack: { source: "原文" }, initialTranslation: "初稿", matches: [], providedReferences: [], maxRevisions: 2 });
  assert.deepEqual(evaluated, ["初稿"]);
  assert.deepEqual(checked, ["初稿", "修订稿"]);
  assert.equal(result.iterations, 1);
  assert.equal(result.score, null);
  assert.equal(result.status, "revised");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].type, "placeholder");
  assert.equal(result.memoryCandidate, null);
  assert.equal(cases[0].scoreBefore, 70);
  assert.equal(cases[0].scoreAfter, null);
  assert.equal(cases[0].issues[0].message, "初稿误译");
  assert.equal(cases[0].status, "review");
});

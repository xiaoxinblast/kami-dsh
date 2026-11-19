import test from "node:test";
import assert from "node:assert/strict";
import { extractXliffPairs } from "../src/xliff-document.mjs";
import { compareBenchmarkStructure, extraBreaksBesideMarker, visibleWording, summarizeStructure } from "../src/benchmark-structure.mjs";
import { benchmarkTranslationSkill } from "../src/skill-benchmark.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { createEvaluationJobRunner } from "../src/evaluation-jobs.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const br = "<tag id='tag-1' type='inline' desc='ph'/>";
const other = "<tag id='tag-2' type='inline' desc='ph'/>";
test("只把原始 XML 已证实的 ph 计为换行；可见措辞不计布局，保留数字和变量", () => {
  const xml = '<xliff version="1.2"><file><body><trans-unit id="7"><source>A<ph id="a">&lt;mq:ch val=&quot;&#10;&quot; /&gt;</ph>B<ph id="b">{user}</ph></source><target>译</target></trans-unit></body></file></xliff>';
  const [unit] = extractXliffPairs(Buffer.from(xml), "a.mqxliff", { includeLineBreakMarkers: true });
  assert.deepEqual(unit.lineBreakMarkers, [br]);
  const source = br + other + "\n\n";
  assert.deepEqual(compareBenchmarkStructure(source, other + "\n", [br]), { missingLineBreaks: 1, extraLineBreaks: 0, missingInline: 0, extraInline: 0 });
  assert.equal(compareBenchmarkStructure(source, br + br + "\n\n", [br]).extraLineBreaks, 1);
  assert.equal(visibleWording(br + "文字42{user}\r\n" + other), "文字42{user}");
  assert.equal(visibleWording("C:\\new\\note"), "C:\\new\\note");
  assert.equal(extraBreaksBesideMarker("甲"+br+"乙", "甲"+br+"\r\n乙", [br]), 1);
  assert.equal(extraBreaksBesideMarker("甲"+br+"乙", "甲\n"+br+"乙", [br]), 1);
  assert.equal(extraBreaksBesideMarker("甲"+br+"\n乙", "甲"+br+"\n乙\n丙", [br]), 0);
});

test("旧评测按轮离线还原结构失败，只给修订器统计，且不能混入新评分", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kami-legacy-layout-"));
  const id = "old", scope = { locale: "zh-CN", contentType: "dialogue", project: "p" };
  const good = { repetition: 0, translation: "隐藏的译文" + br }, bad = { repetition: 1, translation: "缺换行译文" };
  const checkpoint = { kind: "skill-evaluation", jobId: id, status: "completed", scope, requestedCaseIds: ["c", "other"], caseFailures: { other: "旧执行异常" },
    evaluationProfile: { policyVersion: "kami-evaluation-v2" }, benchmarkSnapshot: { scope }, caseTrajectories: { c: { id: "c", source: "保密原句" + br } },
    caseSamples: { c: { champion: [good], challenger: [good, bad] } }, result: { report: {} } };
  const filename = join(dir, id + ".json");
  await writeFile(filename, JSON.stringify(checkpoint));
  const unused = () => assert.fail("旧评测复盘不执行或保存新评测");
  const runner = createEvaluationJobRunner({ jobsDirectory: dir, benchmark: unused,
    deps: { getSkill: unused, getCurrentChampion: unused, validatePromotionState: unused, saveEvaluation: unused,
      updateSkillMetrics: unused, buildUiReport: unused, historicalLineBreaks: async () => ({ c: [br] }) } });
  try {
    await runner.initialize();
    const summary = await runner.structureFeedback(id);
    assert.deepEqual(summary.candidate.map((r) => r.first.missingLineBreaks), [0, 1]);
    assert.equal(summary.candidate[1].attemptedRepairs, 0);
    assert.doesNotMatch(JSON.stringify(summary), /保密原句|隐藏的译文|缺换行译文|tag-1/);
    await assert.rejects(runner.retryFailed(id), /评分口径/);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), checkpoint);
  } finally { await runner.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("同一冻结条件进入两版提示，漏标记仅修订一次，保留首稿与终稿计数并隔离留出答案", async () => {
  const scope = { locale: "zh-CN", contentType: "dialogue", domain: "game", project: "test" };
  const trajectory = { id: "one", source: "甲" + br + "乙", finalTranslation: "你好", neighborContext: { previous: "前一句", next: "後一句", note: "話者", referenceTranslations: [{ value: "不可泄漏的答案" }] } };
  const snapshot = { scope, assets: { locale: "zh-CN", terms: [] }, queryEmbeddings: { one: [] }, lineBreakMarkers: { one: [br] } };
  const messages = [];
  const modelAdapter = async (chat, options) => {
    messages.push(JSON.stringify(chat));
    if (options.requestLabel === "AIQA") return { content: '{"issues":[]}' };
    return { content: options.requestLabel === "AIQA 修订" ? "你" + br + "好" : "你好" };
  };
  for (const contentType of ["ui", "dialogue"]) {
    const sample = await withRuntimeCall({ embedded: true, modelAdapter }, () => benchmarkTranslationSkill({ ...scope, contentType, strategy: {} }, trajectory, { snapshot, repetition: 1 }));
    assert.deepEqual(sample.scope, scope);
    assert.equal(sample.humanEditDistance, 0);
    assert.equal(sample.structure.first.missingLineBreaks, 1);
    assert.equal(sample.structure.final.missingLineBreaks, 0);
    assert.equal(sample.structure.reference.missingLineBreaks, 1);
    assert.equal(sample.hardErrorCount, 0);
    const [round] = summarizeStructure([sample]);
    assert.equal(round.repetition, 2);
    assert.equal(round.repairedDraws, 1);
  }
  assert.equal(messages.length, 6);
  for (const message of messages) {
    assert.match(message, /剧情对白/);
    assert.match(message, /前一句/);
    assert.match(message, /後一句/);
    assert.match(message, /話者/);
    assert.doesNotMatch(message, /不可泄漏的答案/);
  }
});

test("一次定向修订仍漏换行时保留硬错误，即使中文措辞完全等于人工终稿", async () => {
  const scope = { locale: "zh-CN", contentType: "dialogue", domain: "game", project: "test" };
  const snapshot = { scope, assets: { locale: scope.locale, terms: [] }, queryEmbeddings: { one: [] }, lineBreakMarkers: { one: [br] } };
  let repairs = 0;
  const modelAdapter = async (_, options) => {
    if (options.requestLabel === "AIQA 修订") repairs++;
    return { content: options.requestLabel === "AIQA" ? '{"issues":[]}' : "你好" };
  };
  const sample = await withRuntimeCall({ embedded: true, modelAdapter }, () => benchmarkTranslationSkill({ ...scope, strategy: {} },
    { id: "one", source: "甲" + br + "乙", finalTranslation: "你好" }, { snapshot }));
  assert.equal(repairs, 1);
  assert.equal(sample.structure.final.missingLineBreaks, 1);
  assert.equal(sample.humanEditDistance, 0);
  assert.equal(sample.hardErrorCount, 1);
  assert.equal(sample.humanAccepted, false);
  assert.equal(summarizeStructure([sample])[0].repairedDraws, 0);
});

test("正常译文跳过结构修订，定向修订只接受保留措辞且换行位置有效的结果", async () => {
  const scope = { locale: "zh-CN", contentType: "dialogue", domain: "game", project: "fixture" };
  const trajectory = { id: "case", source: "朝だ。" + br + "帰ろう。", finalTranslation: "天亮了。" + br + "回去吧。" };
  const snapshot = { scope, assets: { locale: scope.locale, terms: [] }, queryEmbeddings: { case: [] }, lineBreakMarkers: { case: [br] } };
  const good = trajectory.finalTranslation, bad = visibleWording(good);
  for (const [draft, repair, accepted] of [
    [good, null, good], [bad, good, good], [bad, good.replace("回去", "出发"), bad],
    [bad, br + bad, bad], [bad, bad + br, bad], [bad, good.replace(br, br + "\n"), bad]
  ]) {
    const calls = [];
    const modelAdapter = async (messages, { requestLabel }) => {
      calls.push(requestLabel);
      if (requestLabel === "翻译") {
        assert.match(JSON.stringify(messages), /强制换行标记/);
        return { content: draft };
      }
      if (requestLabel === "AIQA 修订") return { content: repair };
      return { content: '{"issues":[]}' };
    };
    const sample = await withRuntimeCall({ embedded: true, modelAdapter }, () => benchmarkTranslationSkill(scope, trajectory, { snapshot }));
    assert.equal(sample.translation, accepted);
    assert.equal(sample.hardErrorCount, accepted === good ? 0 : 1);
    assert.deepEqual(calls, repair ? ["翻译", "AIQA 修订", "AIQA"] : ["翻译", "AIQA"]);
  }
  assert.equal(compareBenchmarkStructure(br + other, other + br).outOfOrder, 1);
  assert.equal(compareBenchmarkStructure("甲<br/>乙", "甲\n乙").missingLineBreaks, 1);
  assert.equal(compareBenchmarkStructure("甲" + br + "乙\n丙", "甲" + br + "\n乙丙", [br]).extraLineBreaks, 1);
});

test("普通折行在候选评测中可增可减，两侧不修订、不扣分；显式排版规格仍生效", async () => {
  const scope = { locale: "zh-CN", contentType: "dialogue", domain: "game", project: "fixture" };
  const lineLayout = { key: "layout", markers: [], rules: [{ maxChars: 8, maxLines: 2, source: "对白排版", counting: "characters" }] };
  for (const [source, draft, hardErrors] of [
    ["雨だ。\n傘を持って。\n行こう。", "下雨了，带上伞。\n走吧。", 0],
    ["雨だ。傘を持って。行こう。", "下雨了，带上伞。\r\n走吧。", 0],
    ["朝だ。\n" + other + "帰ろう。", "天亮" + other + "了。\n回家吧。", 0],
    ["雨だ。\n傘を持って。\n行こう。", "下雨了，\n带上伞。\n走吧。", 1],
    ["雨だ。\n傘を持って。\n行こう。", "下雨了，带上雨伞再走吧。", 1],
    ["雨だ。\n傘を持って。\n行こう。", "下雨了\n，走吧。", 1]
  ]) {
    const trajectory = { id: "reflow", source, finalTranslation: draft.replace(/[\r\n]+/gu, ""), lineLayout };
    const calls = [];
    const snapshot = { scope, assets: { locale: scope.locale, terms: [] }, queryEmbeddings: { reflow: [] } };
    const modelAdapter = async (messages, { requestLabel }) => {
      calls.push({ requestLabel, messages });
      return { content: requestLabel === "AIQA" ? '{"issues":[]}' : draft };
    };
    for (const variant of ["champion", "challenger"]) {
      calls.length = 0;
      const sample = await withRuntimeCall({ embedded: true, modelAdapter }, () => benchmarkTranslationSkill({ ...scope, id: variant }, trajectory, { snapshot }));
      assert.deepEqual(calls.map(c => c.requestLabel), hardErrors ? ["翻译", "AIQA 修订", "AIQA"] : ["翻译", "AIQA"]);
      assert.equal(sample.hardErrorCount, hardErrors);
      if (!hardErrors) {
        assert.equal(sample.humanEditDistance, 0);
        assert.equal(sample.qaScore, 100);
        assert.equal(sample.humanAccepted, true);
        assert.ok(Object.values(sample.structure.first).every(n => n === 0));
      }
      assert.ok(calls.every(c => /普通换行/u.test(JSON.stringify(c.messages))));
      assert.ok(calls.every(c => /每行最多 8 字/u.test(JSON.stringify(c.messages))));
    }
  }
});

test("旧版报告里已保存的普通换行错误不流入策略修订，原报告逐字保持", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-v3-reflow-"));
  const id = "archived", path = join(directory, id + ".json");
  const stats = { champion: [{ first: { missingLineBreaks: 1 } }], candidate: [{ first: { missingLineBreaks: 1 } }] };
  const sample = { translation: "下雨了。走吧。", initialTranslation: "下雨了。\n走吧。", repetition: 0 };
  const archived = JSON.stringify({ jobId: id, kind: "skill-evaluation", status: "completed", scope: { contentType: "dialogue" },
    evaluationProfile: { policyVersion: "kami-evaluation-v3" }, result: { report: { structure: stats, score: 73 } },
    requestedCaseIds: ["c"], caseTrajectories: { c: { id: "c", source: "雨だ。\n行こう。" } },
    caseSamples: { c: { champion: [sample], challenger: [sample] } }, caseFailures: {} });
  await writeFile(path, archived);
  const unused = () => assert.fail("读取旧报告不应运行评测");
  const runner = createEvaluationJobRunner({ jobsDirectory: directory, benchmark: unused, deps: { getSkill: unused, getCurrentChampion: unused,
    validatePromotionState: unused, saveEvaluation: unused, updateSkillMetrics: unused, buildUiReport: unused } });
  try {
    await runner.initialize();
    const feedback = await runner.structureFeedback(id);
    for (const side of ["champion", "candidate"]) {
      assert.equal(feedback[side][0].first.missingLineBreaks, 0);
      assert.equal(feedback[side][0].final.missingLineBreaks, 0);
    }
    assert.deepEqual(runner.get(id).result.report.structure, stats);
    assert.equal(await readFile(path, "utf8"), archived);
  } finally { await runner.stop(); await rm(directory, { recursive: true, force: true }); }
});

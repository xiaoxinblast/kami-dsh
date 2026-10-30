import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTermSurveyView } from "../src/term-survey-view.mjs";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

function segments() {
  return [
    {
      id: "seg-1", source: "スキルコアを解放した", translation: "解放了技能核心", accepted: true, selected: true,
      result: { humanReview: { previousTranslation: "解锁了技能核心" } }
    },
    { id: "seg-2", source: "スキルコアの説明", translation: "技能核心的说明", accepted: false, selected: true, result: {} },
    { id: "seg-3", source: "ヤマスキー絶壁へ", translation: "前往亚马斯基绝壁", accepted: false, selected: true, result: {} }
  ];
}

function survey() {
  return {
    version: 1,
    generatedAt: "2026-09-26T02:00:00.000Z",
    model: "mock-model",
    coverage: { analyzedPairs: 3, totalSegments: 3, chunks: 1 },
    terms: [
      { source: "スキルコア", suggestedTarget: "技能核心", reason: "系统固定用语", confidence: 0.9 },
      { source: "ヤマスキー絶壁", suggestedTarget: "亚马斯基绝壁", reason: "地名", confidence: 0.8 },
      { source: "存在しない語", suggestedTarget: "不存在的词", reason: "误报", confidence: 0.6 }
    ],
    review: {
      at: "2026-09-26T03:00:00.000Z",
      stats: { measured: true, libraryName: "术语库" },
      terms: [{ source: "スキルコア", target: "技能核心", action: "skipped", reason: "人工终稿里没有出现这个源词" }]
    }
  };
}

test("术语普查视图：机器稿实际用法、人工终稿、库里登记与处理结果各就各位", () => {
  const view = buildTermSurveyView({
    survey: survey(),
    segments: segments(),
    termAssets: [{ source: "ヤマスキー絶壁", target: "亚马斯基峭壁", status: "approved" }]
  });
  assert.equal(view.generatedAt, "2026-09-26T02:00:00.000Z");
  assert.equal(view.model, "mock-model");
  const bySource = new Map(view.terms.map((term) => [term.source, term]));

  // ① 回填过的段落：机器稿基准取回填前的译文，人工终稿单独列出来。
  const core = bySource.get("スキルコア");
  assert.equal(core.machine.matched, 2);
  assert.equal(core.machine.adopted, 2, "两句机器稿都用了建议译法");
  assert.equal(core.machine.samples[0].machine, "解锁了技能核心");
  assert.equal(core.machine.samples[0].human, "解放了技能核心");
  assert.equal(core.human.reviewed, true);
  assert.equal(core.human.kept, 1);
  assert.equal(core.library.found, false);
  assert.equal(core.outcome.action, "skipped");

  // ② 库里已有别的登记译法：要能看出冲突。
  const cliff = bySource.get("ヤマスキー絶壁");
  assert.equal(cliff.machine.adopted, 1);
  assert.equal(cliff.library.found, true);
  assert.equal(cliff.library.target, "亚马斯基峭壁");
  assert.equal(cliff.human.reviewed, false);
  assert.equal(cliff.outcome, null);

  // ③ 原文里根本没出现的建议词：不能假装核对过。
  const ghost = bySource.get("存在しない語");
  assert.equal(ghost.machine.matched, 0);
  assert.equal(ghost.machine.adopted, 0);
  assert.deepEqual(ghost.machine.samples, []);

  assert.deepEqual(view.stats, {
    total: 3, adopted: 2, missingInMachine: 0, unlocated: 1, inLibrary: 1,
    reviewed: 1, autoWritten: 0, pendingReview: 0, skipped: 1
  });
});

test("术语普查视图：人工终稿改掉建议译法时如实标出，自动入库单列", () => {
  const view = buildTermSurveyView({
    survey: {
      terms: [{ source: "ヤマスキー絶壁", suggestedTarget: "亚马斯基绝壁", reason: "地名", confidence: 0.8 }],
      review: {
        at: "2026-09-26T03:00:00.000Z",
        stats: { libraryName: "项目术语库" },
        terms: [{ source: "ヤマスキー絶壁", target: "亚马斯基峭壁", action: "auto_written", reason: "" }]
      }
    },
    segments: [{
      id: "seg-3", source: "ヤマスキー絶壁へ", translation: "前往亚马斯基峭壁", accepted: true, selected: true,
      result: { humanReview: { previousTranslation: "前往亚马斯基绝壁" } }
    }],
    termAssets: [{ source: "ヤマスキー絶壁", target: "亚马斯基峭壁", status: "approved" }]
  });
  const [term] = view.terms;
  assert.equal(term.machine.adopted, 1, "机器稿用的是建议译法");
  assert.equal(term.human.kept, 0, "人工终稿没有保留建议译法");
  assert.equal(term.outcome.action, "auto_written");
  assert.equal(term.outcome.libraryName, "项目术语库");
  assert.equal(view.stats.autoWritten, 1);
  assert.equal(view.stats.reviewed, 1);
});

test("术语普查接线：手动端点、逐条回填结果落库、界面按状态展示", async () => {
  const [server, script, html, styles] = await Promise.all([
    read("server.mjs"), read("public/app.js"), read("public/index.html"), read("public/styles.css")
  ]);
  // 手动重跑普查 + 批次读取时算好界面数据。
  assert.match(server, /\/\^\\\/api\\\/batch\\\/run\\\/\[\^\/\]\+\\\/term-survey\$\//u);
  assert.match(server, /startTermSurvey\(batchId\)\.catch\(\(error\) => console\.error\("\[Kami\] 术语普查任务异常"/u);
  assert.match(server, /termSurvey: buildTermSurveyView\(\{/u);
  // 回填时把逐条结果写回批次记录，否则界面只能看到汇总数字。
  assert.match(server, /runnerOptions: \{ \.\.\.\(latest\.runnerOptions \|\| \{\}\), termSurvey: \{ \.\.\.survey, terms: surveyed, review \} \}/u);
  assert.match(server, /stats\.items\.push\(\{\n\s+source: candidate\.source,/u);
  // 界面：五个分区标签 + 术语普查列表。
  assert.match(html, /data-batch-tab="terms"/u);
  assert.match(html, /id="batchTermSurveyList"/u);
  assert.doesNotMatch(html, /batchPasteText/u, "批次粘贴框已经删掉，长文本走文件上传或单句输入");
  assert.match(html, /单句或片段请用「单句输入」/u, "上传入口要写清长文本该走哪里");
  assert.match(html, /手动输入一句日语，即时得到译文；整份文件请到「文件列表」上传/u, "单句模式的提示不能再承诺自动跳批次");
  assert.match(script, /function renderBatchTermSurvey\(\)/u);
  assert.match(script, /async function runTermSurveyNow\(\)/u);
  assert.match(script, /const TERM_FILTERS = \[/u);
  assert.match(styles, /\.batch-tab\.active \{/u);
  assert.match(styles, /\.batch-term-card \{/u);
});

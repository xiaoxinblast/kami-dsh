import test from "node:test";
import assert from "node:assert/strict";
import { runServerBatch } from "../src/batch-runner.mjs";

function fixture() {
  return {
    batchId: "batch-1", projectId: "project-1", filename: "dialogue.xlsx", locale: "zh-CN", contentType: "general", domain: "game", segmentationMode: "unit",
    segments: [1, 2, 3].map((index) => ({ id: `seg-${index}`, source: `原文${index}`, selected: true, status: "pending", context: { row: index } }))
  };
}

test("小批初译仍逐段 QA 和保存，合并术语供下一组使用", async () => {
  const run = fixture();
  run.segments = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, source: `原文${i}`, status: "pending" }));
  const groups = [], singles = [], learned = [], snapshots = [];
  await runServerBatch(run.batchId, {
    loadRun: async () => run, saveRun: async value => snapshots.push(structuredClone(value)),
    loadProject: async () => ({ settings: {} }), classifyDocument: async () => "dialogue",
    translateGroup: async requests => {
      groups.push(requests);
      return requests.map(body => ({ id: body.segmentId, source: body.source, translation: `小批${body.source}` }));
    },
    translateSegment: async (body, { draft }) => {
      singles.push(body.segmentId);
      assert.ok(draft);
      return { translation: `${draft.translation}经QA`, aiQa: { used: true, score: 100 } };
    },
    learnTerms: () => assert.fail("小批不能逐段调用术语学习"),
    learnGroupTerms: async ({ segments }) => {
      learned.push(segments.map(s => s.id));
      assert.ok(segments.every(s => s.translation.endsWith("经QA")));
      return [{ source: "原文", target: "原文", sourceSegmentId: segments[0].id }];
    }
  });
  assert.deepEqual(groups.map(g => g.length), [4, 4]);
  assert.equal(groups[1][0].workingTerms.length, 1);
  assert.deepEqual(singles, run.segments.map(s => s.id));
  assert.deepEqual(learned.map(g => g.length), [4, 4]);
  assert.ok(snapshots.some(s => s.segments.filter(s => s.status === "done").length === 1));
  assert.ok(run.segments.every(s => s.result.aiQa.used));
});

test("小批输出失败后每段回到原流程，暂停时只保存已审完的句段", async () => {
  for (const fail of [true, false]) {
    const run = fixture(), calls = [], groups = [], learned = [];
    await runServerBatch(run.batchId, {
      loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }), classifyDocument: async () => "dialogue",
      translateGroup: async requests => {
        groups.push(requests);
        if (fail) throw new Error("invalid_micro_batch");
        return requests.map(body => ({ id: body.segmentId, source: body.source, translation: "小批初译" }));
      },
      translateSegment: async (body, { draft }) => { calls.push(body.segmentId); assert.equal(Boolean(draft), !fail); return { translation: "已审译文" }; },
      learnGroupTerms: async ({ segments }) => { learned.push(...segments.map(s => s.id)); return []; },
      shouldPause: () => !fail && calls.length === 1
    });
    assert.equal(groups.length, 1);
    assert.equal(calls.length, fail ? 3 : 1);
    assert.equal(run.runState, fail ? "completed" : "paused");
    if (!fail) {
      assert.deepEqual(learned, [run.segments[0].id]);
      assert.equal(run.segments[1].status, "pending");
      assert.equal(run.segments[1].translation, undefined);
    }
  }
});

test("小批中断保存已学到的术语，不用启动时的旧选项覆盖", async () => {
  const run = fixture();
  let completed = 0;
  await runServerBatch(run.batchId, {
    loadRun: async () => run, saveRun: async () => {}, loadProject: async () => ({ settings: {} }), classifyDocument: async () => "dialogue",
    translateGroup: async requests => requests.map(body => ({ id: body.segmentId, source: body.source, translation: "译文" })),
    translateSegment: async () => { completed += 1; return { translation: "译文" }; },
    learnGroupTerms: async ({ segments }) => [{ source: "原文", target: "译文", sourceSegmentId: segments[0].id }],
    shouldCancel: () => completed === 1
  });
  assert.equal(run.runnerOptions.cancelled, true);
  assert.equal(run.runnerOptions.workingGlossary.terms[0].sourceSegmentId, "seg-1");
  assert.equal(run.segments[1].status, "pending");
});

test("服务端按真实 subBatches 执行，每段结果落盘一次（不再逐段写两遍）", async () => {
  const run = fixture();
  const snapshots = [];
  const calls = [];
  const result = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async (value) => snapshots.push(structuredClone(value)),
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: { contextAnchorCount: 2 } } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async (body) => { calls.push(body); return { translation: `译文${calls.length}`, qaScore: 95, issues: [] }; }
  });
  assert.equal(result.runState, "completed");
  assert.deepEqual(result.subBatches.map((batch) => batch.entries), [2, 1]);
  assert.deepEqual(result.subBatches.map((batch) => batch.status), ["completed", "completed"]);
  assert.equal(calls.length, 3);
  // 落盘节流：初始 1 次 + 每段结果 1 次 + 收尾 1 次。旧行为是每段写两遍（running + 结果），
  // 78 段的批次会打出上百次大 JSON 写入，把 Directus 压出压力保护。
  assert.equal(snapshots.length, 5, "初始 + 三段结果 + 收尾");
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.segments.filter((segment) => segment.status === "done").length),
    [0, 1, 2, 3, 3],
    "每段完成都必须落盘，才能从断点继续"
  );
  assert.equal(
    snapshots.some((snapshot) => snapshot.segments.some((segment) => segment.status === "running")),
    false,
    "快速段落不再为「正在翻」多写一次整行"
  );
});

test("中断请求在当前段完成后停止，留下已中断标记且已完成段保留", async () => {
  const run = fixture();
  let translated = 0;
  const snapshots = [];
  const first = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async (value) => snapshots.push(structuredClone(value)),
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; },
    shouldCancel: () => translated >= 1
  });
  assert.equal(first.runState, "paused");
  assert.equal(first.runnerOptions.cancelled, true, "中断要留标记：界面据此显示「已中断」而不是「已暂停」");
  assert.equal(first.segments.filter((segment) => segment.status === "done").length, 1);
  assert.equal(translated, 1, "中断之后不能继续翻后面的段落");
  assert.equal(snapshots.at(-1).runState, "paused");
  assert.equal(snapshots.at(-1).runnerOptions.cancelled, true);

  // 继续：只翻没完成的段落，已完成的那段不重翻
  const resumed = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; }
  });
  assert.equal(resumed.runState, "completed");
  assert.equal(translated, 3, "续跑只补剩下两段");
});

test("暂停请求在当前段完成后停止，恢复时跳过已完成段", async () => {
  const run = fixture();
  let translated = 0;
  const first = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; },
    shouldPause: () => translated >= 1
  });
  assert.equal(first.runState, "paused");
  assert.equal(first.segments.filter((segment) => segment.status === "done").length, 1);

  const resumed = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; }
  });
  assert.equal(resumed.runState, "completed");
  assert.equal(translated, 3);
});

test("逐段学习工作术语并把同句式参考传给下一段", async () => {
  const run = {
    batchId: "batch-working", projectId: "project-1", filename: "dialogue.xlsx", locale: "zh-CN", contentType: "general", domain: "game", segmentationMode: "unit",
    segments: [
      { id: "seg-1", source: "プレミアムパスを購入すると、3個の宝箱を獲得します。", selected: true, status: "pending", context: {} },
      { id: "seg-2", source: "プレミアムパスを購入すると、10個の宝箱を獲得します。", selected: true, status: "pending", context: {} }
    ]
  };
  const calls = [];
  const learnedTerm = {
    id: "wt-premium", source: "プレミアムパス", target: "高级通行证", aliases: [],
    status: "active", enforcement: "preferred", confidence: 0.9, origin: "segment-learn",
    sourceSegmentId: "seg-1", createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z"
  };
  const result = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 10, subBatchMaxChars: 1000 }, tm: {} } }),
    classifyDocument: async () => "general",
    loadTermSources: async () => [{ source: "ナビマップ", target: "导览地图" }],
    learnTerms: async ({ segment }) => segment.id === "seg-1" ? [learnedTerm] : [],
    translateSegment: async (body) => {
      calls.push(body);
      return { translation: body.source.includes("3個") ? "购买高级通行证可获得 3 个宝箱。" : "购买高级通行证可获得 10 个宝箱。" };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].workingTerms.length, 1);
  assert.equal(calls[1].workingTerms[0].source, "プレミアムパス");
  assert.equal(calls[1].patternReferences.length, 1);
  assert.equal(calls[1].patternReferences[0].segmentId, "seg-1");
  assert.equal(result.segments[1].result.patternKey, result.segments[0].result.patternKey);
  assert.equal(result.runnerOptions.workingGlossary.terms.length, 1);
});

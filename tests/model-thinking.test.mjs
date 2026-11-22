import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 模型思考记录：所有模型调用都要能在日志里回看思考正文。
 *
 * 只落本地文件——不发请求、不改提示词、不进入后续上下文，所以不增加 token 消耗。
 * 开关、单次上限、保留总量在「设置 → 日志」。
 */
const directory = await mkdtemp(join(tmpdir(), "kami-thinking-"));
process.env.KAMI_LOG_DIRECTORY = directory;
process.env.KAMI_PROVIDER_DIRECTORY = directory;

const { THINKING_FILE, clearThinking, getThinkingStats, listLogs, listThinking, logThinking, readThinking } = await import("../src/logger.mjs");
const { invalidateSettingsCache, saveSettings } = await import("../src/settings-store.mjs");
const { recordModelThinking } = await import("../src/model-thinking.mjs");
const { withRuntimeCall } = await import("../src/runtime-context.mjs");

test.after(async () => { invalidateSettingsCache(); await rm(directory, { recursive: true, force: true }); });

const reset = () => { clearThinking(); saveSettings({ logs: { thinking: true, thinkingMaxKB: 32, thinkingKeepMB: 128 } }); };

test("思考正文落盘，主日志留一条可检索的索引", async () => {
  reset();
  const entry = logThinking({ label: "初译", model: "deepseek", effort: "high", text: "先判断敬语等级，再选中文语气。", context: { batchId: "b-1", segmentId: "s-2" } });
  assert.equal(entry.kind, "thinking");
  assert.match(entry.message, /模型思考 · 初译/u);
  assert.ok(existsSync(THINKING_FILE), "正文单独落文件");
  const meta = listThinking({})[0];
  assert.equal(meta.label, "初译");
  assert.equal(meta.context.batchId, "b-1");
  assert.equal(readThinking(meta.id).text, "先判断敬语等级，再选中文语气。");
  // 主日志里只有索引：能查到这条记录，但没有正文。
  const index = listLogs({ search: "模型思考" })[0];
  assert.equal(index.kind, "thinking");
  assert.doesNotMatch(index.detail, /先判断敬语/u);
});

test("搜索命中思考正文，返回带上下文的摘录", async () => {
  reset();
  logThinking({ label: "AIQA", text: "这里把「いただきます」译成「我开动了」更自然。" });
  const rows = listThinking({ search: "いただきます" });
  assert.equal(rows.length, 1);
  assert.match(rows[0].snippet, /いただきます/u);
});

test("单次上限会截断正文并标注", async () => {
  reset();
  saveSettings({ logs: { thinkingMaxKB: 1 } });
  logThinking({ label: "语境分析", text: "长".repeat(2000) });
  const meta = listThinking({})[0];
  assert.equal(meta.truncated, true);
  assert.ok(meta.bytes <= 1024, `截断后应不超过 1KB，实际 ${meta.bytes}`);
  assert.equal(readThinking(meta.id).truncated, true);
});

test("关闭开关后不再记录，已有记录仍可保留", async () => {
  reset();
  logThinking({ label: "初译", text: "第一条" });
  saveSettings({ logs: { thinking: false } });
  assert.equal(logThinking({ label: "初译", text: "第二条" }), null);
  assert.equal(listThinking({}).length, 1);
});

test("清空会删掉正文文件与元数据", async () => {
  reset();
  logThinking({ label: "初译", text: "待清理" });
  assert.ok(getThinkingStats().totalBytes > 0);
  const stats = clearThinking();
  assert.equal(stats.totalBytes, 0);
  assert.equal(listThinking({}).length, 0);
  assert.equal(existsSync(THINKING_FILE), false);
});

test("recordModelThinking 带上运行时的批次与句段，且失败调用也留记录", async () => {
  reset();
  await withRuntimeCall({ thinkingContext: { batchId: "b-9", segmentId: "s-3", stage: "translate" } }, () =>
    recordModelThinking({ label: "模型校对", model: "deepseek", text: "检查术语一致性。", status: "failed", attempt: 2 }));
  const meta = listThinking({})[0];
  assert.equal(meta.context.batchId, "b-9");
  assert.equal(meta.context.segmentId, "s-3");
  assert.equal(meta.context.stage, "translate");
  assert.equal(meta.status, "failed");
  assert.equal(meta.context.attempt, 2);
});

test("直连上游时 reasoning_content 会写进思考日志", async () => {
  reset();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues: [] }), reasoning_content: "先核对原文，再看译文是否漏译。" } }] })
  });
  const { updateProviderConfig, evaluateTranslationWithModel } = await import("../src/provider.mjs");
  updateProviderConfig({ persist: false, protocol: "openai", mainThinking: "enabled", mainEffort: "high" });
  await evaluateTranslationWithModel({
    contextPack: { source: "プレミアムパスを購入してください。", targetLocale: "zh-CN", targetLanguage: "简体中文", sourceLanguage: "日语", contentType: "general", contentTypeLabel: "通用内容", register: "中性", localeInstruction: "自然的简体中文。" },
    translation: "请购买高级通行证。"
  });
  const rows = listThinking({});
  assert.ok(rows.length >= 1, "至少记录一次调用");
  const text = readThinking(rows[0].id).text;
  assert.match(text, /先核对原文/u);
});

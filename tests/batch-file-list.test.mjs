import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function sources() {
  const [server, script, html, styles] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  return { server, script, html, styles };
}

test("翻译视图默认落文件列表，单句与当前文件各是一个标签", async () => {
  const { script, html } = await sources();
  assert.match(html, /data-translation-mode="files"[\s\S]{0,120}文件列表/u);
  assert.match(html, /data-translation-mode="single"[\s\S]{0,120}单句输入/u);
  assert.match(html, /id="fileListWorkspace"/u);
  assert.match(html, /id="batchBackToList"/u);
  assert.match(script, /translationMode: "files",/u, "默认落地必须是文件列表");
  assert.match(script, /state\.translationMode = \["batch", "single"\]\.includes\(mode\) \? mode : "files";/u);
  assert.match(script, /\$\("#fileListWorkspace"\)\.hidden = state\.translationMode !== "files";/u);
  assert.match(script, /if \(state\.translationMode === "files"\) loadBatchFiles\(\)/u);
  assert.match(script, /if \(state\.view === "workbench" && state\.translationMode === "files"\) \$\("#batchFile"\)\.click\(\);/u);
});

test("文件列表按文件聚合进度、语境分析、QA 与人工审校", async () => {
  const { server, script, html } = await sources();
  assert.match(server, /url\.pathname === "\/api\/batch\/files"/u);
  for (const field of ["totalSegments", "completedSegments", "failedSegments", "qaPending", "brief", "learning", "hasOriginal"]) {
    assert.match(server, new RegExp(`${field}:`, "u"), `聚合结果要有 ${field}`);
  }
  assert.match(server, /const briefStatus = contextAnalysisTasks\.has\(run\.batchId\)/u);
  assert.match(server, /humanReviewed: Number\(learning\?\.humanReviewed\) \|\| 0/u);
  // 批次列表层带上语境分析与 runnerOptions：一次查询就够，不用逐条取整个批次。
  assert.match(server, /countLearningTrajectoriesByFile\(\{ locale, project: projectId \}\)/u);
  assert.match(script, /async function loadBatchFiles\(\)/u);
  assert.match(script, /BRIEF_STATUS_META/u);
  assert.match(script, /人工审校 \$\{reviewed \? `\$\{reviewed\} 条` : "无"\}/u);
  assert.match(html, /id="batchFileList"/u);
  assert.match(html, /id="batchFileStatus"/u);
  assert.match(html, /id="batchFileSearch"/u);
});

test("文件行支持打开、三种导出与删除（只删文件与批次）", async () => {
  const { script, server } = await sources();
  assert.match(script, /data-batch-action="open"/u);
  assert.match(script, /data-batch-action="export"/u);
  assert.match(script, /data-batch-action="delete"/u);
  assert.match(script, /async function openBatchFile\(batchId, \{ silent = false \} = \{\}\)/u);
  assert.match(script, /async function exportBatchFile\(batchId, button\)/u);
  assert.match(script, /async function exportPreflightForBatch\(batchId, file\)/u);
  assert.match(script, /async function deleteBatchFileRow\(batchId, button\)/u);
  assert.match(script, /会删除：批次记录、原文件存档、导出文件。/u);
  assert.match(script, /保留：已写入主 TM \/ 术语库的条目，以及学习中心里由它产生的轨迹/u);
  // 三种导出：原文件直连下载、译文/双语走后台导出任务（mode）。
  assert.match(script, /downloadUrl: `\/api\/tasks\/\$\{encodeURIComponent\(batchId\)\}\/original\?projectId=/u);
  assert.match(script, /const mode = choice === "translation" \? "translation" : "bilingual";/u);
  assert.match(server, /url\.pathname\.endsWith\("\/original"\)/u);
  // 批次页的「写回原文件」也走这个后台端点：任务中心 therefore 永远看得到导出进度。
  assert.match(server, /const requestedMode = \["in-place", "translation-only", "translation", "bilingual"\]\.includes\(String\(body\.mode \|\| ""\)\)/u);
  assert.match(server, /const mode = requestedMode === "translation" \? "translation" : requestedMode;/u);
  assert.match(server, /format: requestedFormat \|\| \(mode === "translation" \? "translation" : "bilingual"\),/u);
  assert.match(server, /mode: mode === "in-place" \? "in-place" : mode === "translation-only" \? "translation-only" : "",/u);
});

test("三个导出入口都走后台任务，导出期间按钮立刻给反馈", async () => {
  const { script } = await sources();
  // 文件列表行内、任务中心行内、批次页顶部：全都调同一个后台端点。
  const calls = [...script.matchAll(/\/api\/tasks\/\$\{encodeURIComponent\([^)]*\)\}\/export/gu)].length;
  assert.equal(calls, 1, "三个入口必须共用同一个后台导出调用");
  assert.equal([...script.matchAll(/return exportBatchTask\(/gu)].length, 3);
  // 不再有同步导出调用（保留的服务端接口仅供外部调用）。
  assert.doesNotMatch(script, /api\("\/api\/batch\/export"/u);
  // 检查期间必须马上禁用按钮并改文案，否则用户会以为按钮坏了。
  assert.match(script, /"检查中…"/u);
  assert.match(script, /setButton\(button\?\.id === "tertiaryAction" \? "正在检查导出条件…" : "检查中…"\);/u);
  // 后台任务完成后统一走"另存为/浏览器下载"的交付逻辑。
  assert.match(script, /async function deliverExportedFile\(finished, taskId, \{ filename = "" \} = \{\}\)/u);
  assert.match(script, /await deliverExportedFile\(finished, started\.backgroundTaskId/u);
});

test("语境分析是硬门禁：没就绪按钮置灰，并且不用刷新就能解锁", async () => {
  const { script, server, html } = await sources();
  assert.match(server, /contextBriefPending, requiresBrief: contextBriefPending \}\);/u);
  assert.match(server, /requiresBrief: segments\.length >= CONTEXT_BRIEF_MIN_SEGMENTS,/u);
  assert.match(script, /const briefBlocked = Boolean\(state\.batchPreview\?\.requiresBrief\) && state\.batchBrief\?\.status !== "ready";/u);
  assert.match(script, /: briefBlocked \? \(state\.batchBriefPending \? "等待语境分析…" : "语境分析未就绪"\)/u);
  assert.match(script, /primary\.disabled = state\.batchRunning \? state\.batchPaused : briefBlocked \|\|/u);
  assert.match(script, /function startBatchBriefWatch\(batchId = state\.batchPreview\?\.batchId\)/u);
  assert.match(script, /\}, 3_000\);/u);
  assert.match(script, /if \(prepared\.contextBriefPending\) \{ await loadBatchBrief\(prepared\.batchId\); startBatchBriefWatch\(prepared\.batchId\); \}/u);
  assert.match(script, /await loadBatchBrief\(run\.batchId\);\n\s+startBatchBriefWatch\(run\.batchId\);/u);
  assert.match(html, /id="batchBriefPanel"/u);
  assert.match(html, /翻译前先通读全文做语境分析/u, "策略面板要说明语境分析是前置步骤");
});

test("任务中心按状态分三段渲染，原有动作一个不少", async () => {
  const { script, styles, html } = await sources();
  assert.match(script, /\{ id: "running", title: "进行中"/u);
  assert.match(script, /\{ id: "attention", title: "待处理"/u);
  assert.match(script, /\{ id: "done", title: "已完成"/u);
  assert.match(script, /class="task-group" data-task-group=/u);
  assert.match(script, /class="task-row task-card"/u);
  // 2026-10-23 任务中心改版：状态数字是可点击筛选按钮，筛选收进图标面板，同批任务可折叠。
  assert.match(html, /id="taskFilterToggle"/u);
  assert.match(html, /id="taskFilterPanel" hidden/u);
  assert.doesNotMatch(html, /id="taskStatus"/u, "旧的状态大下拉已被按钮替代");
  assert.match(script, /data-task-filter=/u);
  assert.match(script, /task-bundle-toggle/u);
  assert.match(script, /groupTaskEntries/u);
  assert.match(styles, /\.task-card\[data-task-status="needs_attention"\]/u);
  // 动作清单：批次 / 质检 / 后台任务 / 学习评测全在。
  for (const action of [
    "open-task", "export-task", "pause-task", "continue-task", "cancel-task", "delete-task", "jump-qa", "import-review",
    "open-qa-task", "delete-qa-task", "cancel-background", "delete-background", "download-export", "open-import-review",
    "continue-import", "open-batch", "open-learning"
  ]) {
    assert.match(script, new RegExp(`data-action="${action}"`, "u"), `任务中心少了动作 ${action}`);
  }
});

test("导出预检复用批次里保存的术语匹配，避免逐段重算", async () => {
  const { server, script } = await sources();
  assert.match(script, /body: JSON\.stringify\(\{\s*\.\.\.projectPayload\(\),\s*batchId,/u, "前端预检要带上 batchId");
  assert.match(server, /const savedRun = body\.batchId \? await getBatchRun/u);
  assert.match(server, /Array\.isArray\(saved\.result\?\.matches\)/u, "原文没改就复用保存的 matches");
  assert.match(server, /const matches = resolveSegmentMatches\(withMatches/u);
});

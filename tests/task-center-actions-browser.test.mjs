import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：任务中心要能直接控制任务本身——
 * 批次翻译有「暂停 / 继续翻译 / 中断」，导入类任务有「中断 / 继续导入」，
 * 中断过的任务状态显示成"已中断"而不是"失败/进行中"。
 */
test("任务中心提供暂停、继续、中断，并且点击打到对应接口", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const actions = [];
  let exportBody = null;
  const batch = (overrides) => ({
    id: "batch-1", type: "batch", batchId: "batch-1", filename: "dialogue.xlsx", projectId: "project-1",
    locale: "zh-CN", contentType: "general", domain: "game", format: "xlsx", status: "in_progress", runState: "running",
    runnerOptions: { route: "auto", reflect: true, originalFile: "uploads/batch-1.xlsx" }, totalSegments: 5, completedSegments: 2, failedSegments: 0, qaPending: 0,
    updatedAt: "2026-09-18T12:00:00Z", ...overrides
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 中断会先弹确认框：浏览器默认会自动关闭它，这里显式接受。
    page.on("dialog", (dialog) => dialog.accept());
    // 无头浏览器里系统的"另存为"无法交互，会一直挂着：这里走普通下载分支。
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // 删除类请求统一记账：断言"点了删除到底打了哪个接口"。
      if (request.method() === "DELETE") {
        actions.push(`DELETE ${url.pathname}${url.search}`);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, stopped: true }) });
      }
      if (url.pathname === "/api/tasks" && request.method() === "GET") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify([
            batch(),
            batch({ id: "batch-2", batchId: "batch-2", filename: "interrupted.xlsx", status: "needs_attention", runState: "paused", qaPending: 2, runnerOptions: { route: "auto", reflect: true, cancelled: true } }),
            {
              id: "task-1", type: "background", taskType: "asset_import", title: "导入 · terms.xlsx", locale: "zh-CN",
              status: "in_progress", contentType: "general", domain: "general", totalSegments: 100, completedSegments: 40,
              progress: { phase: "importing", message: "正在写入：40 / 100", percent: 40, completed: 40, total: 100 },
              payload: { batchId: "b-9", filename: "terms.xlsx" }, updatedAt: "2026-09-18T12:00:00Z"
            },
            {
              id: "task-2", type: "background", taskType: "asset_import", title: "导入 · old.xlsx", locale: "zh-CN",
              status: "needs_attention", contentType: "general", domain: "general", totalSegments: 100, completedSegments: 40,
              progress: { phase: "cancelled", message: "已中断：已写入 40 条，可在任务中心继续导入" },
              payload: { batchId: "b-9", filename: "old.xlsx", resumable: true }, updatedAt: "2026-09-18T12:00:00Z"
            },
            {
              id: "qa-1", type: "autoqa", title: "dialogue.xlsx 质检", locale: "zh-CN",
              status: "completed", contentType: "general", domain: "game", overallScore: 87,
              totalSegments: 12, completedSegments: 12, failedSegments: 0, qaPending: 3, updatedAt: "2026-09-18T12:00:00Z"
            },
            {
              id: "task-3", type: "background", taskType: "term_import", title: "导入 · Asia_batch18_review.mqxliff", locale: "zh-CN",
              status: "completed", contentType: "general", domain: "general", totalSegments: 67, completedSegments: 67,
              progress: { phase: "completed", message: "导入完成：术语 0 条、主 TM 64 条、跳过 3 条", percent: 100, completed: 67, total: 67 },
              payload: {
                batchId: "b-10", filename: "Asia_batch18_review.mqxliff",
                summary: {
                  imported: 64, terms: 0, memories: 64, styleProfiles: 1, skipped: 3,
                  skippedByReason: { "库内已有译法：巴尔": 3 },
                  trajectoriesLinked: 60, trajectoryAmbiguous: 2, trajectoryUnmatched: 2
                }
              },
              updatedAt: "2026-09-18T12:00:00Z"
            }
          ])
        });
      }
      if (url.pathname === "/api/batch/run/batch-2/import-review") {
        actions.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-2", filename: "interrupted.xlsx", total: 5, matched: 4, changed: 3, unchanged: 1,
            unmatched: 1, ambiguous: 0, memoriesWritten: 4, trajectoriesLinked: 3,
            trajectoriesUpdated: 1, trajectoryAlreadyAccepted: 12, trajectoryAcceptedUnchanged: 11,
            skippedUnits: { locked: 1, existing: 6 },
            trajectoryUnmatched: 1, trajectoryAmbiguous: 0, failures: [],
            details: { unmatched: [{ pairIndex: 4, source: "新材料です。", reason: "该原文不在这个批次里" }], ambiguous: [] }
          })
        });
      }
      if (url.pathname === "/api/batch/run/batch-1" && request.method() === "GET") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1", filename: "dialogue.xlsx", format: "xlsx", locale: "zh-CN", contentType: "general", domain: "game",
            runState: "running", runnerOptions: { route: "auto", reflect: true, originalFile: "uploads/batch-1.xlsx" },
            structure: { cells: [{ sheet: "S", address: "B2", row: 2, column: 2, segmentIds: ["seg-1"] }] },
            segments: [{ id: "seg-1", source: "メンテナンスは明日開始します。", translation: "维护明天开始。", selected: true, status: "done", locator: { type: "xlsx-cell", sheet: "S", address: "B2", row: 2, column: 2 } }]
          })
        });
      }
      if (url.pathname === "/api/batch/run/batch-2" && request.method() === "GET") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-2", filename: "interrupted.xlsx", format: "xlsx", locale: "zh-CN", contentType: "general", domain: "game",
            segmentationMode: "unit", runState: "paused", runnerOptions: { route: "auto", reflect: true },
            structure: { xliff: { skippedLocked: 1, skippedExisting: 6 } },
            segments: [
              { id: "seg-1", source: "メンテナンスは明日開始します。", translation: "维护明天开始。", selected: true, status: "done", result: { qaScore: 97, issues: [{ severity: "warning", category: "accuracy_omission", message: "未体现「变得能够…」的状态变化", suggestion: "…了。" }], aiQa: { status: "passed" } }, locator: { type: "xlsx-cell", sheet: "S", address: "B2", row: 2, column: 2, entryId: "ID-1" } },
              { id: "seg-2", source: "アップデートをダウンロードしています。", translation: "正在下载更新。", selected: true, status: "done", locator: { type: "xlsx-cell", sheet: "S", address: "B3", row: 3, column: 2, entryId: "ID-2" } }
            ]
          })
        });
      }
      if (url.pathname === "/api/batch/export/preflight") {
        actions.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            ok: false, total: 2,
            blocking: [
              { severity: "error", category: "platform_placeholder", segmentId: "seg-1", segmentIndex: 1, message: "占位符数量不一致", suggestion: "核对 <tag> 占位符" },
              { severity: "critical", category: "terminology_required", segmentId: "seg-2", segmentIndex: 2, message: "术语未按库内译法", suggestion: "使用「维护」" }
            ],
            warnings: []
          })
        });
      }
      // 批次页导出也走后台任务：任务中心能看到进度，完成后从导出目录取文件。
      if (url.pathname === "/api/tasks/batch-2/export" && request.method() === "POST") {
        actions.push(`${request.method()} ${url.pathname}`);
        exportBody = JSON.parse(request.postData() || "{}");
        return route.fulfill({
          status: 202, contentType: "application/json",
          body: JSON.stringify({ backgroundTaskId: "task-export-batch2", message: "导出已进入任务中心后台处理" })
        });
      }
      if (url.pathname === "/api/background-tasks/task-export-batch2") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            id: "task-export-batch2", taskType: "batch_export", status: "completed",
            progress: { phase: "completed", message: "导出完成", percent: 100, completed: 1, total: 1 },
            payload: { filename: "interrupted.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", downloadUrl: "/api/export-tasks/task-export-batch2/download" }
          })
        });
      }
      // 返回实际文件字节，错误响应必须作为失败呈现。
      if (url.pathname === "/api/export-tasks/task-export-batch2/download") {
        return route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from("test export bytes") });
      }
      // 任务中心的导出按钮同样走后台任务（与翻译界面同一个端点）。
      if (url.pathname === "/api/tasks/batch-1/export" && request.method() === "POST") {
        actions.push(`${request.method()} ${url.pathname}`);
        exportBody = JSON.parse(request.postData() || "{}");
        return route.fulfill({
          status: 202, contentType: "application/json",
          body: JSON.stringify({ backgroundTaskId: "task-export-batch1", message: "导出已进入任务中心后台处理" })
        });
      }
      if (url.pathname === "/api/background-tasks/task-export-batch1") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            id: "task-export-batch1", taskType: "batch_export", status: "completed",
            progress: { phase: "completed", message: "导出完成", percent: 100, completed: 1, total: 1 },
            payload: { filename: "dialogue.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", downloadUrl: "/api/export-tasks/task-export-batch1/download" }
          })
        });
      }
      if (url.pathname === "/api/export-tasks/task-export-batch1/download") {
        return route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from("test export bytes") });
      }
      if (url.pathname.startsWith("/api/batch/run/") || url.pathname.includes("/cancel")) {
        actions.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, cancelling: true }) });
      }
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "任务中心" }).click();
    await page.waitForSelector("#taskList .task-row");
    // 同一批资产导入会折叠成一组：先展开再逐条操作。
    const bundleToggle = page.locator("#taskList [data-task-bundle-toggle]").first();
    if (await bundleToggle.count()) {
      await bundleToggle.click();
      await page.waitForSelector("#taskList .task-bundle-body:not([hidden]) .task-row");
    }

    // 正在跑的批次：暂停 + 中断
    const runningRow = page.locator('#taskList .task-row[data-task-id="batch-1"]');
    assert.match(await runningRow.textContent(), /进行中/u);
    await runningRow.locator('[data-action="pause-task"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskList .task-row[data-task-id="batch-1"] [data-action="pause-task"]').length >= 0);
    assert.ok(actions.includes("POST /api/batch/run/batch-1/pause"), `暂停应打到 pause 接口：${actions.join(" | ")}`);
    await page.locator('#taskList .task-row[data-task-id="batch-1"] [data-action="cancel-task"]').click();
    assert.ok(actions.includes("POST /api/batch/run/batch-1/cancel"), `中断应打到 cancel 接口：${actions.join(" | ")}`);

    // 中断过的批次：显示已中断 + 继续翻译
    const interruptedRow = page.locator('#taskList .task-row[data-task-id="batch-2"]');
    assert.match(await interruptedRow.textContent(), /已中断/u);
    assert.equal(await interruptedRow.locator('[data-action="continue-task"]').count(), 1, "中断的批次要给「继续翻译」");
    await interruptedRow.locator('[data-action="continue-task"]').click();
    assert.ok(actions.includes("POST /api/batch/run/batch-2/start"), `继续应打到 start 接口：${actions.join(" | ")}`);

    // 导入类任务：进行中给「中断」，中断过的给「继续导入」
    const runningImport = page.locator('#taskList .task-row[data-task-id="task-1"]');
    assert.equal(await runningImport.locator('[data-action="cancel-background"]').count(), 1);
    await runningImport.locator('[data-action="cancel-background"]').click();
    assert.ok(actions.includes("POST /api/background-tasks/task-1/cancel"), `导入中断应打到后台任务 cancel 接口：${actions.join(" | ")}`);

    const stoppedImport = page.locator('#taskList .task-row[data-task-id="task-2"]');
    assert.match(await stoppedImport.textContent(), /已中断/u);
    assert.equal(await stoppedImport.locator('[data-action="continue-import"]').count(), 1, "中断的导入要给「继续导入」");

    // 导入完成的任务行要显示审校稿接回了多少条学习轨迹，不能只报术语/译例/跳过
    const finishedImport = page.locator('#taskList .task-row[data-task-id="task-3"] .task-qa strong');
    assert.match(await finishedImport.textContent(), /接回轨迹 60 条（歧义 2 \/ 未匹配 2）/u);
    assert.match(await finishedImport.textContent(), /库内已有译法：巴尔 3/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-trajectory-count.png`, animations: "disabled" });
    }

    // 审校回填：批次行给出入口，上传审校后的文件后弹报告（匹配/未匹配逐条列出）
    assert.equal(await interruptedRow.locator('[data-action="import-review"]').count(), 1, "完成过段落的批次要给「导入审校结果」");
    await interruptedRow.locator('[data-action="import-review"]').click();
    await page.locator("#reviewImportFile").setInputFiles({ name: "reviewed.mqxliff", mimeType: "application/xml", buffer: Buffer.from("<xliff/>") });
    await page.waitForSelector("#reviewImportDialog[open]");
    await page.waitForFunction(() => /已回填/.test(document.querySelector("#reviewImportSummary")?.textContent || ""));
    const summary = await page.locator("#reviewImportSummary").textContent();
    assert.match(summary, /已回填 4 \/ 5 条/u);
    assert.match(summary, /写入主 TM 4 条/u);
    assert.match(summary, /接回学习轨迹 3 条/u);
    // 已采纳的轨迹不算"新接回"：数字要分开报，否则"接回 0 条"看起来像失败
    assert.match(summary, /更新已采纳轨迹 1 条/u);
    assert.match(summary, /此前已采纳、内容相同跳过 11 条/u);
    assert.match(await page.locator("#reviewImportDetails").textContent(), /未匹配 1 条/u);
    assert.match(await page.locator("#reviewImportDetails").textContent(), /该原文不在这个批次里/u);
    assert.match(await page.locator("#reviewImportDetails").textContent(), /本批解析时已跳过：锁定 1 \/ 已有译文 6/u, "要说明这些是解析时跳过的句段");
    assert.ok(actions.includes("POST /api/batch/run/batch-2/import-review"), `回填要打到 import-review 接口：${actions.join(" | ")}`);
    await page.locator('#reviewImportDialog .icon-button[data-close="reviewImportDialog"]').click();

    // 导出：先选导出方式（历史任务没有原文件时不能静默换成自定义格式），再走 QA 门禁
    await page.locator('#taskList .task-row[data-task-id="batch-2"] [data-action="open-task"]').click();
    await page.waitForFunction(() => document.querySelector("#batchPreviewMeta") !== null || true);
    await page.waitForSelector("#tertiaryAction:not([hidden])");
    // 段数说明：XLIFF 里被跳过的锁定/已有译文句段要写清楚，否则用户以为漏翻了
    assert.match(await page.locator("#batchSourceMeta").textContent(), /2 段 · 跳过 7（锁定 1、已有译文 6） · 历史任务/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-skip-summary.png`, animations: "disabled" });
    }
    await page.locator("#tertiaryAction").click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    assert.match(await page.locator("#exportOptionsTitle").textContent(), /没有原文件/u, "缺原文件时要明确告知，而不是悄悄导成任务 Excel");
    assert.equal(await page.locator('[data-export-option="pick-source"]').count(), 1);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/export-options-dialog.png`, animations: "disabled" });
    }
    await page.locator('[data-export-option="translation"]').click();
    await page.waitForSelector("#exportDialog[open]");
    assert.match(await page.locator("#exportDialogTitle").textContent(), /导出被 QA 门禁挡住/u);
    assert.match(await page.locator("#exportDialogSummary").textContent(), /规则层的硬问题/u);
    assert.match(await page.locator("#exportDialogDetails").textContent(), /占位符/u);
    assert.equal(await page.locator("#exportDialogForce").isHidden(), false);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/export-gate-dialog.png`, animations: "disabled" });
    }
    await page.locator("#exportDialogForce").click();
    try {
      await page.waitForFunction(() => /导出完成/.test(document.querySelector("#exportDialogTitle")?.textContent || ""), null, { timeout: 45_000 });
    } catch (error) {
      throw new Error(`${error.message}；toast：${await page.locator("#toast").textContent()}；页面异常：${errors.join(" | ") || "无"}`);
    }
    assert.ok(actions.some((item) => item.includes("/api/tasks/batch-2/export")), `强制导出要打到导出接口：${actions.join(" | ")}`);
    assert.equal(exportBody?.mode, "translation", "选择的导出方式要带到接口");
    assert.equal(exportBody?.sourceFormat, "xlsx", "原格式要带上，导出才知道写回什么结构");
    assert.match(await page.locator("#exportDialogSummary").textContent(), /仅译文/u);
    await page.locator('#exportDialog .icon-button[data-close="exportDialog"]').click();

    // 任务中心的「导出」和翻译界面是同一套选择；批次里存过原文件时直接写回，不再问用户
    await page.locator('.nav-item[data-view="tasks"]').click();
    await page.waitForSelector('#taskList .task-row[data-task-id="batch-1"]');
    await page.locator('#taskList .task-row[data-task-id="batch-1"] [data-action="export-task"]').click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    assert.match(await page.locator("#exportOptionsSummary").textContent(), /原文件已随批次存档/u);
    assert.equal(await page.locator('[data-export-option="bilingual"]').count(), 1, "有存档就直接给「写回原文件」");
    assert.equal(await page.locator('[data-export-option="pick-source"]').count(), 0, "不该再要求用户重新选原文件");
    await page.locator('[data-export-option="bilingual"]').click();
    await page.waitForSelector("#exportDialog[open]");
    assert.match(await page.locator("#exportDialogTitle").textContent(), /导出被 QA 门禁挡住/u);
    await page.locator("#exportDialogForce").click();
    try {
      await page.waitForFunction(() => /导出完成/.test(document.querySelector("#exportDialogTitle")?.textContent || ""), null, { timeout: 45_000 });
    } catch (error) {
      throw new Error(`${error.message}；toast：${await page.locator("#toast").textContent()}；页面异常：${errors.join(" | ") || "无"}`);
    }
    assert.equal(exportBody?.mode, "bilingual", "写回模式要传到接口");
    assert.equal(exportBody?.projectId, "project-1", "带上项目号，服务端据此校验批次归属");
    assert.equal(exportBody?.base64, undefined, "有存档时不用前端再传原文件");
    await page.locator('#exportDialog .icon-button[data-close="exportDialog"]').click();

    // 没有存档的老批次：任务中心也要给「选择原文件并写回」，与翻译界面一致
    await page.locator('#taskList .task-row[data-task-id="batch-2"] [data-action="export-task"]').click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    assert.match(await page.locator("#exportOptionsSummary").textContent(), /没有原文件存档/u);
    assert.equal(await page.locator('[data-export-option="pick-source"]').count(), 1, "老批次要能补选原文件");
    assert.equal(await page.locator('[data-export-option="bilingual"]').count(), 0);
    await page.locator('#exportOptionsDialog .icon-button[data-close="exportOptionsDialog"]').click();

    // 待处理定位：任务中心那行「N 条待处理」可点，打开批次并跳到第一条
    const jumpButton = page.locator('#taskList .task-row[data-task-id="batch-2"] [data-action="jump-qa"]');
    assert.equal(await jumpButton.count(), 1, "有待处理时那个计数要是可点的");
    await jumpButton.click();
    await page.waitForSelector("#view-workbench.active");
    await page.waitForFunction(() => Boolean(document.querySelector(".batch-segment.is-highlighted")), null, { timeout: 45_000 });
    assert.match(await page.locator("#batchQaFilter").textContent(), /建议确认 1/u, "分段队列要有 QA 筛选 chips");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-qa-filter.png`, animations: "disabled" });
    }
    await page.locator('#batchQaChips .qa-filter-chip[data-batch-filter="suggest"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#batchSegments .batch-segment").length === 1);
    assert.match(await page.locator("#batchSegments .batch-segment").textContent(), /未体现/u);
    await page.locator("#batchJumpNext").click();
    await page.waitForFunction(() => Boolean(document.querySelector("#batchSegments .batch-segment.is-highlighted")));
    await page.locator('#batchQaChips .qa-filter-chip[data-batch-filter=""]').click();
    await page.waitForFunction(() => document.querySelectorAll("#batchSegments .batch-segment").length === 2);

    // 译文质检也出现在任务中心：能回放报告，也能删除，不是"做完就找不到"
    await page.locator('.nav-item[data-view="tasks"]').click();
    await page.waitForSelector('#taskList .task-row[data-task-id="qa-1"]');
    const qaRow = page.locator('#taskList .task-row[data-task-id="qa-1"]');
    assert.match(await qaRow.textContent(), /dialogue\.xlsx 质检/u);
    assert.equal(await qaRow.locator('[data-action="open-qa-task"]').count(), 1, "质检任务要能打开报告");
    await qaRow.locator('[data-action="delete-qa-task"]').click();
    await page.waitForFunction(() => /已删除质检任务/.test(document.querySelector("#toast")?.textContent || ""));
    assert.ok(actions.includes("DELETE /api/qa-tasks/qa-1"), `质检任务删除要打到 qa-tasks 接口：${actions.join(" | ")}`);

    // 删除翻译任务：先问清楚是「停止并删除」还是「仅删除记录」
    await page.locator('#taskList .task-row[data-task-id="batch-1"] [data-action="delete-task"]').click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    assert.equal(await page.locator("#exportOptionsKicker").textContent(), "DELETE TASK");
    assert.match(await page.locator("#exportOptionsSummary").textContent(), /正在后台翻译/u);
    assert.equal(await page.locator('[data-export-option="stop"]').count(), 1, "在跑的批次要能「停止并删除」");
    assert.equal(await page.locator('[data-export-option="record"]').count(), 1, "也要能只删记录");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/delete-task-dialog.png`, animations: "disabled" });
    }
    await page.locator('[data-export-option="stop"]').click();
    await page.waitForFunction(() => /已停止并删除/.test(document.querySelector("#toast")?.textContent || ""));
    assert.ok(actions.includes("DELETE /api/tasks/batch-1?stop=1"), `停止并删除要打到批次删除接口：${actions.join(" | ")}`);

    // 导入类后台任务：选「停止并删除」时要先请求中断，再删记录
    const cancelBefore = actions.filter((item) => item === "POST /api/background-tasks/task-1/cancel").length;
    await page.locator('#taskList .task-row[data-task-id="task-1"] [data-action="delete-background"]').click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    await page.locator('[data-export-option="stop"]').click();
    await page.waitForFunction(() => /已删除后台任务/.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 45_000 });
    assert.equal(actions.filter((item) => item === "POST /api/background-tasks/task-1/cancel").length, cancelBefore + 1, "停止并删除要先打中断接口");
    assert.ok(actions.includes("DELETE /api/background-tasks/task-1"), `删除要打到后台任务接口：${actions.join(" | ")}`);

    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-actions.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

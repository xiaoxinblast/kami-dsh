import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：点「导出译文」不能让人以为按钮坏了。
 *
 * 导出前要遍历全批并查整库 TM，大文件上要几十秒。以前这段没有任何反馈，
 * 按钮要等检查完才变灰，用户等半天只看到最后弹出一个窗口。
 * 现在：按钮立刻变「检查中…」→「导出中…」，生成文件走后台任务，任务中心可追溯。
 */
test("导出立即给反馈，并且走后台任务（任务中心可见）", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  const exportCalls = [];
  const preflightCalls = [];
  const segments = Array.from({ length: 6 }, (_, index) => ({
    id: `seg-${index + 1}`, index: index + 1, source: `原文${index + 1}`, translation: `译文${index + 1}`,
    selected: true, status: "done", result: { qualityTier: "standard", qaScore: 97 }, locator: { type: "text-segment" }
  }));

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      let status = 200;
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/tasks") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/batch/files") payload = {
        total: 1,
        files: [{
          batchId: "batch-1", filename: "Asia_batch18_new.xlsx_zho-CN.mqxliff", format: "mqxliff", runState: "completed", status: "review",
          totalSegments: 6, completedSegments: 6, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 1 },
          qualityTiers: { fast: 0, standard: 6, strict: 0, unrecorded: 0 },
          learning: { count: 0, humanReviewed: 0 }, hasOriginal: true, originalBytes: 2048, updatedAt: "2026-09-26T09:00:00.000Z"
        }]
      };
      else if (url.pathname === "/api/batch/run/batch-1") payload = {
        batchId: "batch-1", filename: "Asia_batch18_new.xlsx_zho-CN.mqxliff", locale: "zh-CN", contentType: "general", domain: "game",
        format: "mqxliff", segmentationMode: "unit", runState: "completed", projectId: "project-1",
        runnerOptions: { originalFile: "uploads/batch-1.mqxliff" }, requiresBrief: false, contextBriefPending: false,
        contextBrief: { status: "ready", sections: [{ from: 1, to: 6, purpose: "general" }] }, segments
      };
      else if (url.pathname === "/api/batch/run/batch-1/context-brief") payload = { batchId: "batch-1", pending: false, brief: { status: "ready", sections: [{ from: 1, to: 6, purpose: "general" }] } };
      else if (url.pathname === "/api/batch/export/preflight") {
        preflightCalls.push(route.request().postData() || "");
        // 故意慢一点：这段以前就是"点了没反应"的窗口期。
        await new Promise((resolve) => setTimeout(resolve, 600));
        payload = { ok: true, blocking: [], warnings: [], total: 0 };
      }
      else if (url.pathname === "/api/tasks/batch-1/export") {
        exportCalls.push(JSON.parse(route.request().postData() || "{}"));
        status = 202;
        payload = { backgroundTaskId: "task-export-1", message: "导出已进入任务中心后台处理" };
      }
      else if (url.pathname === "/api/background-tasks/task-export-1") payload = {
        id: "task-export-1", taskType: "batch_export", status: "completed",
        progress: { phase: "completed", message: "导出完成", percent: 100, completed: 1, total: 1 },
        payload: { filename: "Asia_batch18_new.xlsx_zho-CN.mqxliff", downloadUrl: "/api/export-tasks/task-export-1/download" }
      };
      // 返回文件字节，确认下载成功后才显示完成。
      else if (url.pathname === "/api/export-tasks/task-export-1/download") return route.fulfill({ status: 200, contentType: "application/xliff+xml", body: "<xliff><target>译文</target></xliff>" });
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.waitForSelector("#batchFileList .batch-file-row");
    await page.locator('#batchFileList .batch-file-row[data-batch-file="batch-1"] [data-batch-action="open"]').click();
    await page.waitForSelector("#batchWorkspace:not([hidden])");
    await page.waitForFunction(() => document.querySelector("#tertiaryAction")?.textContent === "导出", null, { timeout: 15000 });

    const exportButton = page.locator("#tertiaryAction");
    await exportButton.click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    await page.locator('#exportOptionsDialog [data-export-option="bilingual"]').click();

    // 关键回归：检查期间按钮立刻显示"检查中…"，而不是一动不动。
    await page.waitForFunction(() => document.querySelector("#tertiaryAction")?.textContent === "正在检查导出条件…", null, { timeout: 3000 });
    assert.equal(await exportButton.isDisabled(), true, "检查期间要禁用，防止重复点");
    assert.equal(preflightCalls.length, 1);
    assert.equal(JSON.parse(preflightCalls[0]).batchId, "batch-1", "预检请求要带 batchId，服务端才能复用已保存的术语匹配");

    // 生成文件走后台任务；完成后弹窗说明落点，并指明任务中心可追溯。
    await page.waitForFunction(() => /导出完成|导出失败/.test(document.querySelector("#exportDialogTitle")?.textContent || ""), null, { timeout: 30000 });
    const dialogText = await page.locator("#exportDialog").innerText();
    assert.match(dialogText, /导出完成/u, `导出应成功：${dialogText}`);
    assert.doesNotMatch(dialogText, /导出失败/u);
    assert.match(dialogText, /任务中心可追溯/u);
    assert.equal(exportCalls.length, 1, "导出必须走后台任务端点");
    assert.equal(exportCalls[0].mode, "bilingual");
    assert.equal(exportCalls[0].sourceFormat, "mqxliff");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-export-feedback.png`, animations: "disabled" });
    }
    await page.locator("#exportDialog [data-close='exportDialog']").first().click();
    await page.waitForFunction(() => document.querySelector("#tertiaryAction")?.textContent === "导出");
    assert.equal(await exportButton.isDisabled(), false, "导出结束后按钮要恢复");
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { buildBatchWorkflow } from "../public/batch-status.js";

/**
 * 真机要求：质量报告（含 AI 终审）没跑完之前，这一批不能算"翻译完成"，也不能导出；
 * 翻译页与任务中心都要显示"正在生成质量报告"，报告完成后自动解锁。
 */
test("质量报告完成前显示生成中并锁住导出，完成后自动解锁", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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

  const run = {
    batchId: "batch-completion-1", projectId: "project-1", filename: "completion_zho-CN.mqxliff",
    locale: "zh-CN", contentType: "general", domain: "auto", format: "mqxliff", segmentationMode: "unit",
    structure: null, subBatches: [], runState: "completed",
    runnerOptions: { translationCompletedAt: new Date().toISOString(), workflowTasks: { qualityReport: "q1" } },
    contextBrief: { status: "ready", documentType: { purpose: "ui" }, sections: [], notes: [], crossRefs: [], coverage: { analyzed: 2, total: 2, covered: 2, percent: 100 } },
    segments: [
      { id: "c1", source: "原文1", translation: "译文1", status: "done", selected: true, accepted: false, result: { issues: [], matches: [], aiQa: { used: true, status: "passed" } } },
      { id: "c2", source: "原文2", translation: "译文2", status: "done", selected: true, accepted: false, result: { issues: [], matches: [], aiQa: { used: true, status: "passed" } } }
    ]
  };
  let qualityTask = { id: "q1", status: "in_progress", progress: { phase: "checking", message: "AI 终审待核对项：3 条", percent: 45, completed: 1, total: 5 } };
  const workflow = () => buildBatchWorkflow(run, { qualityTask });
  const taskRow = () => ({
    ...run, id: run.batchId, type: "batch", status: "in_progress", totalSegments: 2, completedSegments: 2,
    failedSegments: 0, qaPending: 0, workflow: workflow(), updatedAt: new Date().toISOString()
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "质量报告收口验证", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { projectId: "project-1", libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [], total: 0 };
      else if (["/api/feedback", "/api/feedback/pending", "/api/qa-cases/pending", "/api/notifications"].includes(path)) payload = [];
      else if (path === "/api/style-profiles") payload = { userProfiles: [], styleProfiles: [], learningRuns: [], evidencePools: [] };
      else if (path === "/api/tasks") payload = [taskRow()];
      else if (path === "/api/batch/files") payload = {
        total: 1,
        files: [{
          batchId: run.batchId, filename: run.filename, format: "mqxliff", runState: "completed", status: "completed",
          totalSegments: 2, completedSegments: 2, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 0 },
          qualityTiers: { fast: 0, standard: 2, strict: 0, unrecorded: 0 }, learning: { count: 2, humanReviewed: 0 },
          hasOriginal: true, originalBytes: 1024, updatedAt: new Date().toISOString()
        }]
      };
      else if (path === `/api/batch/run/${run.batchId}/context-brief`) payload = { batchId: run.batchId, pending: false, brief: run.contextBrief };
      else if (path === `/api/batch/run/${run.batchId}/status`) payload = { workflow: workflow(), qualityReportAt: run.qualityReport?.report?.generatedAt || "", termSurveyAt: "", qaCompletedAt: "" };
      else if (path === `/api/batch/run/${run.batchId}`) payload = { ...run, workflow: workflow(), termSurvey: null };
      else if (path === `/api/batch/run/${run.batchId}/consistency-check`) payload = { batchId: run.batchId, pending: false, report: null, findings: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.addInitScript(() => {
      localStorage.setItem("kami-batch-id", "batch-completion-1");
      localStorage.setItem("kami-project-id", "project-1");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);

    // 从文件列表打开已译完、但质量报告还在跑的批次。
    await page.waitForSelector(`#batchFileList .batch-file-row[data-batch-file="${run.batchId}"]`);
    await page.locator(`#batchFileList .batch-file-row[data-batch-file="${run.batchId}"] [data-batch-action="open"]`).click();
    await page.waitForSelector("#batchWorkflow", { state: "visible" });
    await page.waitForFunction(() => /正在生成质量报告/u.test(document.querySelector("#batchProgressText")?.textContent || ""), null, { timeout: 10000 });
    assert.equal(await page.locator("#tertiaryAction").isDisabled(), true, "质量报告没完成不能导出");
    assert.match(await page.locator("#tertiaryAction").getAttribute("title"), /完成后才能导出/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-completion-pending.png`, fullPage: true, animations: "disabled" });
    }

    // 任务中心同样不能显示"翻译完成"。
    await page.locator('.nav-item[data-view="tasks"]').click();
    await page.waitForSelector("#taskList .task-row");
    const row = page.locator("#taskList .task-row").first();
    assert.match(await row.locator(".task-status").textContent(), /生成质量报告/u);
    assert.equal(await row.locator('[data-action="export-task"]').isDisabled(), true, "任务中心导出同样要锁住");

    // 回到批次页，模拟质量报告完成，页面应自动解锁导出。
    await row.locator('[data-action="open-task"]').click();
    await page.waitForFunction(() => /正在生成质量报告/u.test(document.querySelector("#batchProgressText")?.textContent || ""), null, { timeout: 10000 });
    qualityTask = { id: "q1", status: "completed", progress: { phase: "completed", message: "质量报告已生成", percent: 100 } };
    run.qualityReport = { report: { generatedAt: new Date().toISOString(), totals: { selected: 2, translated: 2, failed: 0 }, coverage: { percent: 100 }, scores: { average: 97 } }, findings: [] };
    await page.waitForFunction(() => {
      const button = document.querySelector("#tertiaryAction");
      return button && !button.disabled && button.textContent === "导出";
    }, null, { timeout: 15000 });
    assert.doesNotMatch(await page.locator("#batchProgressText").textContent(), /正在生成质量报告/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-completion-gate.png`, fullPage: true, animations: "disabled" });
    }

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

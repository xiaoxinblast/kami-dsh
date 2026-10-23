import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { buildBatchWorkflow } from "../public/batch-status.js";

/**
 * 真机反馈：从文件列表打开一个正在翻译的批次时，「当前文件」页只在打开那一刻
 * 取一次进度，任务中心却一直在刷新，看起来就是这边更新慢。
 * 打开运行中批次必须启动轮询，并且轮询回来的 workflow 要立即渲染。
 */
test("当前文件页打开运行中批次时会持续刷新阶段进度", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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
    batchId: "batch-live-1", projectId: "project-1", filename: "live_progress_zho-CN.mqxliff",
    locale: "zh-CN", contentType: "general", domain: "auto", format: "mqxliff", segmentationMode: "unit",
    structure: null, subBatches: [], runnerOptions: {}, contextBrief: { status: "ready", documentType: { purpose: "ui" }, sections: [], notes: [], crossRefs: [], coverage: { analyzed: 3, total: 3, covered: 3, percent: 100 } },
    runState: "running",
    segments: [
      { id: "s1", source: "原文 1", translation: "译文 1", status: "done", selected: true, accepted: false, result: { issues: [], matches: [], aiQa: { used: true, status: "passed" } } },
      { id: "s2", source: "原文 2", translation: "译文 2", status: "done", selected: true, accepted: false, result: { issues: [], matches: [], aiQa: { used: true, status: "passed" } } },
      { id: "s3", source: "原文 3", translation: "", status: "pending", selected: true, accepted: false, result: null }
    ]
  };
  const workflow = () => buildBatchWorkflow(run);
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
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "进度刷新验证", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { projectId: "project-1", libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [], total: 0 };
      else if (["/api/feedback", "/api/feedback/pending", "/api/qa-cases/pending"].includes(path)) payload = [];
      else if (path === "/api/style-profiles") payload = { userProfiles: [], styleProfiles: [], learningRuns: [], evidencePools: [] };
      else if (path === "/api/tasks") payload = { tasks: [] };
      else if (path === "/api/batch/files") payload = {
        total: 1,
        files: [{
          batchId: run.batchId, filename: run.filename, format: "mqxliff", runState: "running", status: "in_progress",
          totalSegments: 3, completedSegments: 2, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 0 },
          qualityTiers: { fast: 0, standard: 2, strict: 0, unrecorded: 1 }, learning: { count: 2, humanReviewed: 0 },
          hasOriginal: true, originalBytes: 1024, updatedAt: "2026-10-23T10:00:00.000Z"
        }]
      };
      else if (path === `/api/batch/run/${run.batchId}/context-brief`) payload = { batchId: run.batchId, pending: false, brief: run.contextBrief };
      else if (path === `/api/batch/run/${run.batchId}/status`) payload = { workflow: workflow(), qualityReportAt: "", termSurveyAt: "", qaCompletedAt: "" };
      else if (path === `/api/batch/run/${run.batchId}`) payload = { ...run, workflow: workflow(), termSurvey: null };
      else if (path === `/api/batch/run/${run.batchId}/consistency-check`) payload = { batchId: run.batchId, pending: false, report: null, findings: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.addInitScript(() => {
      localStorage.setItem("kami-batch-id", "batch-live-1");
      localStorage.setItem("kami-project-id", "project-1");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(`#batchFileList .batch-file-row[data-batch-file="${run.batchId}"]`);
    await page.locator(`#batchFileList .batch-file-row[data-batch-file="${run.batchId}"] [data-batch-action="open"]`).click();
    await page.waitForSelector("#batchWorkflow", { state: "visible" });
    assert.match(await page.locator("#batchWorkflowSummary").textContent(), /正在翻译：2 \/ 3 段/);

    // 后台翻译继续推进：不刷新页面，这一页应当自己跟上。
    run.segments[2].translation = "译文 3";
    run.segments[2].status = "done";
    await page.waitForFunction(() => document.querySelector("#batchWorkflowSummary")?.textContent?.includes("3 / 3"), null, { timeout: 10000 });
    assert.match(await page.locator("#batchWorkflowSummary").textContent(), /正在翻译：3 \/ 3 段/);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-live-progress.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

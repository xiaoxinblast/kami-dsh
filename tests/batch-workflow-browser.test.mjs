import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { buildBatchWorkflow } from "../public/batch-status.js";

test("翻译与任务中心展示阶段进度、失败原因和 QA 批量重试，结果无需刷新即可回填", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.KAMI_BROWSER_EXECUTABLE });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const bytes = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = { batchId: "workflow-browser", projectId: "project-1", filename: "合并1_zho-CN.mqxliff", format: "mqxliff", locale: "zh-CN", contentType: "dialogue", domain: "game",
    runState: "needs_attention", runnerOptions: {}, contextBrief: { status: "ready", documentType: { purpose: "dialogue" }, sections: [] },
    segments: [
      { id: "ok", source: "こんにちは", translation: "你好", selected: true, status: "done", result: { qaScore: 97, aiQa: { used: true, status: "passed" } } },
      { id: "qa", source: "また明日", translation: "明天见", selected: true, status: "done", result: { aiQa: { used: false, fallbackReason: "terminated" } } },
      { id: "failed", source: "おやすみ", translation: "", selected: true, status: "error", error: "模型没有返回译文" }
    ] };
  let qualityTask = { status: "in_progress", progress: { phase: "checking", percent: 25, message: "正在核对跨条目一致性：1 / 4 片" } };
  let termTask = { status: "in_progress", progress: { phase: "surveying", percent: 60, message: "正在查找疑似术语：3 / 5 片" } };
  const calls = [];
  const workflow = () => buildBatchWorkflow(run, { qualityTask, termTask });
  const shot = async (page, name) => {
    if (!process.env.KAMI_UI_SCREENSHOTS) return;
    await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/${name}.png`, fullPage: true, animations: "disabled" });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = { locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS, provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } } };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "阶段状态验证", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", terms: [], revision: 0 };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (["/api/feedback", "/api/feedback/pending", "/api/qa-cases/pending"].includes(url.pathname)) payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/batch/files") payload = { files: [], total: 0 };
      else if (url.pathname === "/api/tasks") payload = [{ ...run, id: run.batchId, type: "batch", status: "needs_attention", totalSegments: 3, completedSegments: 2, failedSegments: 1, qaPending: run.segments[1].result.aiQa.fallbackReason ? 1 : 0, workflow: workflow() }];
      else if (url.pathname === `/api/batch/run/${run.batchId}`) payload = { ...run, workflow: workflow(), termSurvey: run.runnerOptions.termSurvey || null };
      else if (url.pathname === `/api/batch/run/${run.batchId}/context-brief`) payload = { brief: run.contextBrief, pending: false };
      else if (url.pathname === `/api/batch/run/${run.batchId}/retry-qa`) {
        calls.push(JSON.parse(route.request().postData()));
        run.segments[1].result = { qaScore: 97, aiQa: { used: true, status: "passed", fallbackReason: "" } };
        run.runnerOptions.qaCompletedAt = "2026-10-03T01:00:00Z";
        qualityTask = { status: "failed", progress: { message: "质量报告未完成：模型服务 503" } };
        termTask = { status: "completed", progress: { message: "术语普查已完成，没有发现需要新增的术语" } };
        run.runnerOptions.termSurvey = { generatedAt: "2026-10-03T02:00:00Z", terms: [], coverage: { analyzedPairs: 2, totalSegments: 3 } };
        payload = { backgroundTaskId: "qa-retry", total: 1 };
      } else if (url.pathname === `/api/batch/run/${run.batchId}/status`) payload = { workflow: workflow(), qualityReportAt: run.qualityReport?.report?.generatedAt || "", termSurveyAt: run.runnerOptions.termSurvey?.generatedAt || "", qaCompletedAt: run.runnerOptions.qaCompletedAt || "" };
      else if (url.pathname === `/api/batch/run/${run.batchId}/consistency-check`) {
        if (route.request().method() === "POST") {
          calls.push({ reportRetry: true });
          run.qualityReport = { report: { generatedAt: "2026-10-03T03:00:00Z", totals: { selected: 3, translated: 2, failed: 1 }, coverage: { percent: 100 }, scores: { average: 97 } }, findings: [] };
          qualityTask = { status: "completed", progress: { message: "质量报告已生成" } };
        }
        payload = run.qualityReport || { pending: true, report: null, findings: [] };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.nav-item[data-view="tasks"]').click();
    await page.waitForSelector("#taskList .task-row");
    const task = page.locator("#taskList .task-row");
    assert.equal(await task.count(), 1);
    assert.ok((await task.locator(".task-title > strong").boundingBox()).width > 100, "新增重试按钮不能挤掉任务文件名");
    assert.match(await task.textContent(), /生成质量报告/u);
    assert.match(await task.textContent(), /1 段失败/u);
    assert.match(await task.textContent(), /AIQA 未完成 1 段/u);
    assert.match(await task.textContent(), /1 \/ 4 片/u);
    assert.match(await task.textContent(), /3 \/ 5 片/u);
    assert.match(await task.locator('[data-action="continue-task"]').textContent(), /重试失败句段/u);
    assert.equal(await task.locator('[data-action="retry-qa-task"]').count(), 1);
    await shot(page, "task-workflow-progress");
    await task.locator('[data-action="open-task"]').click();
    await page.waitForSelector("#batchWorkflow:not([hidden])");
    assert.match(await page.locator("#primaryAction").textContent(), /重试失败句段（1）/u);
    assert.match(await page.locator("#batchProgressText").textContent(), /正在生成质量报告/u);
    assert.match(await page.locator("#batchWorkflowStages").textContent(), /1 \/ 4 片/u);
    assert.match(await page.locator("#batchWorkflowStages").textContent(), /3 \/ 5 片/u);
    await shot(page, "batch-workflow-progress");
    await page.locator("#batchRetryQa").click();
    await page.waitForFunction(() => document.querySelector("#batchRetryQa")?.hidden === true);
    assert.equal(calls[0].projectId, "project-1");
    assert.equal(calls[0].segmentIds, null, "一键 QA 重试应交给服务端筛选失败 QA");
    assert.match(await page.locator("#batchWorkflowStages").textContent(), /模型服务 503/u);
    await page.locator('[data-batch-tab="report"]').click();
    await page.waitForSelector("#batchReportPanel:not([hidden])");
    assert.match(await page.locator("#batchReportSummary").textContent(), /模型服务 503/u);
    assert.equal(await page.locator("#batchConsistencyRun").isEnabled(), true);
    await shot(page, "batch-workflow-report-failed");
    await page.locator("#batchConsistencyRun").click();
    await page.waitForFunction(() => /2 \/ 3 段已翻译/.test(document.querySelector("#batchReportSummary")?.textContent || ""));
    assert.ok(calls.some((call) => call.reportRetry));
    await page.locator('[data-batch-tab="terms"]').click();
    assert.match(await page.locator("#batchTermSurveyList").textContent(), /普查已完成，没有发现/u);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "batch-workflow-mobile");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

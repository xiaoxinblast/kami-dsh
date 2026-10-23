import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 任务中心改版：
 * - 状态数字变成可点击筛选按钮；
 * - 一次批量上传的同类型任务折叠成一组；
 * - 类型/语言/搜索收进「筛选」面板，不再用一个大白框常驻。
 */
test("任务中心：状态按钮可筛选、同批任务折叠、筛选面板可展开", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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

  const referenceTask = (id, status, index) => ({
    id, type: "background", taskType: "reference_ingest", title: `参考资料导入：file-${index}.pdf`,
    locale: "zh-CN", status, contentType: "general", domain: "general",
    createdAt: "2026-10-23T09:35:40.000Z", updatedAt: "2026-10-23T09:45:00.000Z",
    progress: { phase: "interrupted", message: "已中断", percent: 1 }, payload: { documentId: `doc-${index}` }
  });
  const batchTask = {
    batchId: "batch-1", id: "batch-1", type: "batch", filename: "done.mqxliff", locale: "zh-CN",
    contentType: "general", domain: "game", status: "completed", runState: "completed",
    totalSegments: 2, completedSegments: 2, failedSegments: 0, qaPending: 0, updatedAt: "2026-10-23T09:00:00.000Z",
    runnerOptions: {}, segments: [], workflow: null
  };
  const tasks = [
    referenceTask("ref-1", "needs_attention", 1),
    referenceTask("ref-2", "needs_attention", 2),
    referenceTask("ref-3", "needs_attention", 3),
    batchTask
  ];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "任务中心改版验证", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { projectId: "project-1", libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [], total: 0 };
      else if (["/api/feedback", "/api/feedback/pending", "/api/qa-cases/pending", "/api/notifications"].includes(path)) payload = [];
      else if (path === "/api/style-profiles") payload = { userProfiles: [], styleProfiles: [], learningRuns: [], evidencePools: [] };
      else if (path === "/api/tasks") payload = tasks;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "任务中心" }).click();
    await page.waitForSelector("#taskList .task-bundle");

    // ⓪ 默认收起筛选面板、任务组折叠，先截一张干净布局。
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-clean.png`, fullPage: true, animations: "disabled" });
    }

    // ① 状态数字是可点击按钮；点「待处理」只留待处理分组，已完成分组隐藏。
    const attentionChip = page.locator('#taskSummary [data-task-filter="attention"]');
    assert.equal(await attentionChip.evaluate((node) => node.tagName), "BUTTON");
    assert.equal(await page.locator('#taskSummary [data-task-filter="attention"] strong').textContent(), "1", "待处理按分组计数");
    assert.equal(await page.locator('#taskSummary [data-task-filter="done"] strong').textContent(), "1");
    await attentionChip.click();
    assert.equal(await attentionChip.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('#taskList [data-task-group="done"]').count(), 0, "筛选后已完成分组应隐藏");
    assert.equal(await page.locator('#taskList [data-task-group="attention"]').count(), 1);
    // 再点一次回到全部。
    await attentionChip.click();
    assert.equal(await attentionChip.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator('#taskList [data-task-group="done"]').count(), 1);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-filter-attention.png`, fullPage: true, animations: "disabled" });
    }

    // ② 同批 3 个参考资料任务折叠成一组，默认收起；展开后逐条列出。
    const bundle = page.locator("#taskList .task-bundle");
    assert.equal(await bundle.count(), 1);
    assert.match(await bundle.textContent(), /参考资料导入 · 3 个文件/u);
    assert.equal(await bundle.locator(".task-bundle-body").isVisible(), false);
    await bundle.locator(".task-bundle-head").click();
    assert.equal(await bundle.locator(".task-bundle-body").isVisible(), true);
    assert.equal(await bundle.locator(".task-row").count(), 3);

    // ③ 类型/语言/搜索在「筛选」面板里；默认收起，点图标才展开。
    const filterPanel = page.locator("#taskFilterPanel");
    assert.equal(await filterPanel.isVisible(), false);
    await page.locator("#taskFilterToggle").click();
    assert.equal(await filterPanel.isVisible(), true);
    assert.equal(await page.locator("#taskFilterPanel #taskType").count(), 1);
    assert.equal(await page.locator("#taskFilterPanel #taskSearch").count(), 1);
    assert.equal(await page.locator("#taskStatus").count(), 0, "旧的状态大下拉已被状态按钮替代");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-layout.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

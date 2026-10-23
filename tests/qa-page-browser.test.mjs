import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { waitForText } from "./fixtures/browser-wait.mjs";

/**
 * 真实浏览器回归：译文质检页（原 Auto QA）重构后要能
 *  ① 选已有批次并回放质检结果（不重新调模型）；
 *  ② 上传双语文件按原生句段质检；
 *  ③ 用筛选 chips + 跳到下一条定位待处理段落；④ 下载报告。
 */
test("译文质检：批次回放、文件质检、筛选与跳转", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const calls = [];
  const batchScores = { overall: 88, dimensions: { basic: 82, fidelity: 90, nuance: 92 } };
  const batchSummary = {
    basic: { total: 2, error: 1, major: 0, minor: 1 },
    fidelity: { total: 1, error: 0, major: 1, minor: 0 },
    nuance: { total: 0, error: 0, major: 0, minor: 0 }
  };
  const segments = [
    { index: 1, source: "メンテナンスは明日開始します。", translation: "维护明天开始。", qaScore: 97, issues: [], entryKey: "CARD_1_a", sourceRow: 2 },
    {
      index: 2, source: "クエスト　ヤマスキー絶壁：入口前", translation: "任务 亚马斯基绝壁：入口前", qaScore: 84,
      issues: [{ severity: "error", category: "platform_placeholder", message: "半角空格与源文全角空格不一致", suggestion: "任务：亚马斯基绝壁：入口前" }],
      entryKey: "CARD_1_b", sourceRow: 3
    },
    {
      index: 3, source: "ピコが空中を高速移動できるようになります。", translation: "哔可能够在空中高速移动。", qaScore: 97,
      issues: [{ severity: "warning", category: "accuracy_omission", message: "未体现「变得能够…」的状态变化", suggestion: "…高速移动了。" }],
      entryKey: "CARD_1_c", sourceRow: 4
    }
  ];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/qa/batch/batch-1") {
        calls.push(`GET ${url.pathname}`);
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            sourceKind: "batch", batchId: "batch-1", filename: "interrupted.xlsx", segmentCount: segments.length,
            segments, scores: batchScores, summary: batchSummary,
            alignmentNote: `直接回放这条批次翻译时的逐段检查结果（${segments.length} 段），没有重新调用模型。`
          })
        });
      }
      if (url.pathname === "/api/qa/file") {
        calls.push(`POST ${url.pathname}`);
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            sourceKind: "file", filename: "reviewed.mqxliff", segmentCount: 2,
            segments: [
              { index: 1, source: "アップデートをダウンロードしています。", translation: "正在下载更新。", qaScore: 100, issues: [] },
              { index: 2, source: "浄璃の架", translation: "净璃之架", qaScore: 97, issues: [{ severity: "warning", category: "style_register", message: "同批区域名不带「之」", suggestion: "净璃架" }] }
            ],
            scores: { overall: 96, dimensions: { basic: 96, fidelity: 96, nuance: 96 } },
            summary: { basic: { total: 1, error: 0, major: 0, minor: 1 }, fidelity: { total: 0 }, nuance: { total: 0 } },
            alignmentNote: "按文件原生句段检查（2 条），未做切句与对齐。"
          })
        });
      }
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/tasks") payload = [{
        id: "batch-1", type: "batch", batchId: "batch-1", filename: "interrupted.xlsx", projectId: "project-1",
        locale: "zh-CN", contentType: "general", domain: "game", status: "review", runState: "completed",
        totalSegments: 3, completedSegments: 3, failedSegments: 0, qaPending: 2, updatedAt: "2026-09-18T12:00:00Z"
      }];
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/logs") payload = { entries: [], settings: { level: "info" } };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");

    // 页签名与来源分区
    await page.getByRole("button", { name: "译文质检" }).click();
    await page.waitForSelector("#view-autoqa.active");
    assert.equal(await page.locator('#qaSourceTabs .qa-source-tab').count(), 3);
    // 批次下拉是切页之后异步拉的：等它真的出现再断言，别和接口抢时序。
    assert.match(await waitForText(page.locator("#qaBatchSelect"), /interrupted\.xlsx/u), /interrupted\.xlsx/u);
    assert.match(await page.locator('[data-qa-panel="file"]').textContent(), /单文件 ≤ 32MB/u);
    assert.equal(await page.locator("#primaryAction").textContent(), "查看质检结果", "顶部按钮要跟着来源走");

    // ① 批次回放
    await page.locator("#qaBatchLoad").click();
    await page.waitForSelector("#qaSegments .qa-segment");
    assert.ok(calls.includes("GET /api/qa/batch/batch-1"), `应回放批次结果：${calls.join(" | ")}`);
    assert.match(await page.locator("#qaAlignmentNote").textContent(), /没有重新调用模型/u);
    assert.equal(await page.locator("#qaSegments .qa-segment").count(), 3);
    assert.match(await page.locator("#qaSegments .qa-segment.attention").first().textContent(), /需要复核/u);
    assert.match(await page.locator("#qaFilters").textContent(), /全部 3/u);
    assert.match(await page.locator("#qaFilters").textContent(), /需要复核 1/u);

    // ③ 筛选 + 跳到下一条
    await page.locator('#qaFilters .qa-filter-chip[data-qa-filter="suggest"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#qaSegments .qa-segment").length === 1);
    assert.match(await page.locator("#qaSegments .qa-segment").textContent(), /accuracy_omission/u);
    await page.locator("#qaJumpNext").click();
    await page.waitForFunction(() => Boolean(document.querySelector("#qaSegments .qa-segment.is-highlighted")));
    await page.locator('#qaFilters .qa-filter-chip[data-qa-filter=""]').click();
    await page.waitForFunction(() => document.querySelectorAll("#qaSegments .qa-segment").length === 3);

    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/qa-batch.png`, fullPage: true, animations: "disabled" });
    }

    // ② 上传文件按原生句段质检
    await page.locator('#qaSourceTabs .qa-source-tab[data-qa-source="file"]').click();
    await page.waitForSelector('[data-qa-panel="file"]:not([hidden])');
    assert.equal(await page.locator("#primaryAction").textContent(), "开始质检");
    assert.equal(await page.locator("#primaryAction").isDisabled(), true, "没选文件时顶部按钮不可点");
    await page.locator("#qaFile").setInputFiles({ name: "reviewed.mqxliff", mimeType: "application/xml", buffer: Buffer.from("<xliff/>") });
    assert.equal(await page.locator("#qaFileRun").isDisabled(), false);
    await page.locator("#qaFileRun").click();
    await page.waitForFunction(() => document.querySelectorAll("#qaSegments .qa-segment").length === 2, null, { timeout: 45_000 });
    assert.ok(calls.includes("POST /api/qa/file"), `应走文件质检接口：${calls.join(" | ")}`);
    assert.match(await page.locator("#qaAlignmentNote").textContent(), /未做切句与对齐/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

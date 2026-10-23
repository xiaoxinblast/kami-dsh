import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：记忆库导入人工 TM 时，选中文件必须立刻看得见，
 * 并且直接开始预检——否则用户会以为"没导入"。网络失败也要给人话，不是 Failed to fetch。
 */
test("记忆库选择文件后显示清单并自动预检", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  let previewCalls = 0;
  let failPreview = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/tm-import/preview") {
        previewCalls += 1;
        if (failPreview) return route.abort("connectionrefused");
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1", filename: "a.xlsx 等 2 个文件",
            candidates: [
              { source: "用語", target: "术语", sourceFile: "a.xlsx", sourceRow: 2, selected: true }
            ],
            statistics: { rowsScanned: 2, pairedRows: 2 }
          })
        });
      }
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/projects/project-1/libraries") payload = {
        projectId: "project-1",
        libraries: [
          { id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 0 },
          { id: "tm-working", projectId: "project-1", name: "工作 TM", kind: "translation_memory", role: "working", enabled: true, priority: 2, entryCount: 0 },
          { id: "term-1", projectId: "project-1", name: "术语库", kind: "term_base", role: "reference", enabled: true, priority: 1, entryCount: 0 }
        ]
      };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "记忆库 TM" }).click();

    // 行内「导入」：目标库跟着这一行走，弹窗里要写清目标库。
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-working"]');
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-working"] [data-library-action="import"]').click();
    await page.waitForSelector("#memoryImportDialog[open]");
    assert.match(await page.locator("#memoryImportTarget").textContent(), /工作 TM/u);

    const xlsx = { name: "a.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") };
    const csv = { name: "b.csv", mimeType: "text/csv", buffer: Buffer.from("日语,简体中文\n用語,术语\n") };
    await page.locator("#memoryFile").setInputFiles([xlsx, csv]);

    await page.waitForSelector("#memoryImportFiles:visible");
    const listText = (await page.locator("#memoryImportFiles").textContent()).replace(/\s+/g, " ");
    assert.match(listText, /2 个文件/u);
    assert.match(listText, /a\.xlsx/u);
    assert.match(listText, /b\.csv/u);
    assert.equal(await page.locator("#memoryImportButton").textContent(), "预检 2 个文件");
    await page.waitForSelector("#memoryImportPreview:visible");
    // 逐文件预检：2 个文件就是 2 次请求，进度按文件推进。
    assert.equal(previewCalls, 2, "选中文件应当直接逐个预检，不需要再点按钮");
    assert.equal(await page.locator("#memoryImportPreviewBody tr").count(), 2);
    assert.match(await page.locator("#memoryImportNote").textContent(), /本地预检识别 2 条双语 TM（来自 2 \/ 2 个文件/u);
    assert.equal(await page.locator("#memoryImportFiles li.done").count(), 2);

    // 连接失败时给可操作的人话，而不是 Failed to fetch
    failPreview = true;
    await page.locator("#memoryFile").setInputFiles([xlsx]);
    await page.waitForTimeout(600);
    const note = await page.locator("#memoryImportNote").textContent();
    assert.match(note, /连不上工作台/u);
    assert.doesNotMatch(note, /Failed to fetch/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 回归：一个文件超过单文件上限，只能把那个文件标失败；
 * 同批其它文件必须照常预检（以前整批都被标成同一个"超过上限"，用户以为 10 个全废了）。
 */
test("人工 TM 预检只跳过超限文件，同一批的其它文件照常导入", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  const previewFiles = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/tm-import/preview") {
        const body = JSON.parse(request.postData() || "{}");
        const filename = body.files?.[0]?.filename || "unknown";
        previewFiles.push(filename);
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1", filename,
            candidates: [{ source: "用語", target: "术语", sourceFile: filename, sourceRow: 2, selected: true }],
            total: 1,
            statistics: { rowsScanned: 2, pairedRows: 1 }
          })
        });
      }
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/projects/project-1/libraries") payload = {
        projectId: "project-1",
        libraries: [
          { id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 0 }
        ]
      };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "记忆库 TM" }).click();
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-master"]');
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"] [data-library-action="import"]').click();
    await page.waitForSelector("#memoryImportDialog[open]");

    const oversize = { name: "big.mqxliff", mimeType: "application/octet-stream", buffer: Buffer.alloc(33 * 1024 * 1024) };
    const ok = { name: "small.mqxliff", mimeType: "application/octet-stream", buffer: Buffer.from("ok") };
    await page.locator("#memoryFile").setInputFiles([oversize, ok]);

    await page.waitForSelector("#memoryImportPreview:visible", { timeout: 60_000 });
    assert.deepEqual(previewFiles, ["small.mqxliff"], "超限文件不该发预检请求，其它文件照常发");
    assert.equal(await page.locator("#memoryImportFiles li.done").count(), 1);
    assert.equal(await page.locator("#memoryImportFiles li.failed").count(), 1);
    const listText = (await page.locator("#memoryImportFiles").textContent()).replace(/\s+/g, " ");
    assert.match(listText, /big\.mqxliff.*超过单文件 32MB 上限/u);
    const note = await page.locator("#memoryImportNote").textContent();
    assert.match(note, /来自 1 \/ 2 个文件/u);
    assert.match(note, /1 个文件未导入：big\.mqxliff/u);
    assert.equal(await page.locator("#memoryImportPreviewBody tr").count(), 1);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/memory-import-oversize.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

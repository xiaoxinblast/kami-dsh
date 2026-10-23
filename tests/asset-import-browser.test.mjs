import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：双语资产预检要逐文件进行，界面上必须看得见文件清单、
 * N/M 进度与每个文件的结果——只有一句"正在预检"用户无法判断是不是卡住了。
 */
test("双语资产预检显示文件清单与逐文件进度", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const previewBodies = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/assets-import/preview") {
        const body = JSON.parse(request.postData() || "{}");
        previewBodies.push(body);
        const file = body.files?.[0]?.filename || "unknown";
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1",
            files: [{ filename: file, type: "xlsx", entries: 2, anomalies: [], defaultPurpose: "term_cleaning", duplicates: { existing: 1, conflict: 1 } }],
            candidates: [
              { sourceFile: file, source: "用語", target: "术语", note: "原表注释", sheetMode: "glossary", locale: "zh-CN", selected: true },
              { sourceFile: file, source: "用語集", target: "术语表", note: "", sheetMode: "glossary", locale: "zh-CN", selected: true }
            ],
            duplicates: { existing: 1, conflict: 1 },
            statistics: { files: 1, entries: 2, anomalies: 0 }
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
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "双语资产导入" }).click();
    await page.waitForSelector("#termFile", { state: "attached" });

    const file = (name) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.locator("#termFile").setInputFiles([file("a.xlsx"), file("b.xlsx"), file("c.xlsx")]);

    await page.waitForSelector("#importFileList:visible");
    assert.equal(await page.locator("#importFileList li").count(), 3);
    assert.match(await page.locator(".import-file-head").textContent(), /3 个文件/u);
    await page.waitForSelector("#assetPreflightDialog[open]");
    assert.equal(previewBodies.length, 3, "应当逐个文件预检，而不是一次性提交整批");
    assert.deepEqual(previewBodies.map((body) => body.files[0].filename), ["a.xlsx", "b.xlsx", "c.xlsx"]);
    assert.equal(await page.locator("#importFileList li.done").count(), 3);
    assert.match(await page.locator(".import-file-head span").textContent(), /已预检 3 \/ 3/u);
    assert.match(await page.locator("#fileMeta").textContent(), /预检完成：3 \/ 3 个文件，共 6 条双语条目 · 已用时/u);
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /已识别 3 个文件、6 条双语条目/u);
    // 预检就要讲清库里已有什么：同对照会跳过、冲突不覆盖，别等导入完才发现被跳过。
    assert.equal(previewBodies[0].purpose, "term", "预检请求要带上本批类型");
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /库内已存在相同对照 3 条/u);
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /与库内译法冲突 3 条/u);
    const firstRow = page.locator("#assetPreflightBody tr").first();
    assert.match(await firstRow.textContent(), /库内已存在 1/u);
    assert.match(await firstRow.textContent(), /与库内译法冲突 1/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/asset-preflight-duplicates.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 回归：点确认后界面必须立刻变成进度状态（不是等一个长请求），
 * 并且明确告诉用户"可以关窗口，任务在后台继续"。
 */
test("确认导入后立刻显示进度，并提示可以关窗口后台继续", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  let taskStatus = "in_progress";
  let taskProgress = { phase: "queueing", message: "正在写入审核队列：200 / 400", percent: 4, completed: 200, total: 400 };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/assets-import/preview") {
        const file = JSON.parse(request.postData() || "{}").files?.[0]?.filename || "a.xlsx";
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1",
            files: [{ filename: file, type: "xlsx", entries: 1, anomalies: [], defaultPurpose: "term_cleaning" }],
            candidates: [{ sourceFile: file, source: "用語", target: "术语", note: "", sheetMode: "glossary", locale: "zh-CN", selected: true }],
            statistics: { files: 1, entries: 1, anomalies: 0 }
          })
        });
      }
      if (path === "/api/assets-import/commit") {
        // 模拟"提交要花一点时间"：界面不该在这段时间里只有一个灰按钮。
        await new Promise((resolve) => setTimeout(resolve, 800));
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "task-1", backgroundTaskId: "task-1", batchId: "batch-1", accepted: 1 }) });
      }
      if (path === "/api/background-tasks/task-1") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            id: "task-1", type: "asset_import", taskType: "asset_import", title: "导入 · a.xlsx", status: taskStatus,
            progress: taskStatus === "completed"
              ? { phase: "completed", message: "导入完成：术语 0 条、主 TM 1 条、跳过 0 条", percent: 100, completed: 1, total: 1 }
              : taskProgress,
            payload: taskStatus === "completed" ? { batchId: "batch-1", summary: { imported: 1, terms: 0, memories: 1, skipped: 0, skippedByReason: {} } } : {},
            updatedAt: new Date().toISOString()
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
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "双语资产导入" }).click();
    await page.locator("#termFile").setInputFiles({ name: "a.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.waitForSelector("#assetPreflightDialog[open]");

    await page.locator("#assetPreflightConfirm").click();
    await page.waitForTimeout(200);
    // 提交还没返回时就应该有进度状态，而不是只有一个灰按钮。
    assert.equal(await page.locator("#assetImportProgress").isVisible(), true);
    assert.match(await page.locator("#assetImportProgressText").textContent(), /正在创建后台导入任务/u);
    assert.equal(await page.locator("#assetPreflightConfirm").isDisabled(), true);
    await page.screenshot({ path: "C:/Users/xiaoxinblast/AppData/Local/Temp/shot-import-confirm.png" }).catch(() => {});

    // 任务创建后：进度来自后台任务，并能直接关窗
    await page.waitForSelector("#assetPreflightClose:visible", { timeout: 45_000 });
    await page.waitForFunction(() => document.querySelector("#assetImportProgressText")?.textContent?.includes("正在写入审核队列"), null, { timeout: 45_000 });
    assert.match(await page.locator("#assetImportProgressText").textContent(), /已用时/u);
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /关掉这个窗口/u);

    taskStatus = "completed";
    await page.waitForFunction(() => document.querySelector("#mappingNote")?.textContent?.includes("导入完成"), null, { timeout: 45_000 });
    assert.match(await page.locator("#mappingNote").textContent(), /术语 0 条、主 TM 1 条/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 回归：上一次提交会把"确认并继续"换成"关闭窗口，后台继续"、并收起候选表；
 * 下一轮预检必须把这些界面状态复位，否则第二次导入时用户根本找不到确认按钮
 * （表现就是"预检完成后没有确认导入"）。
 */
test("第二轮预检要恢复确认按钮与候选表", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const commitBodies = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/assets-import/preview") {
        const file = JSON.parse(request.postData() || "{}").files?.[0]?.filename || "a.xlsx";
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1",
            files: [{ filename: file, type: "xlsx", entries: 1, anomalies: [], defaultPurpose: "term_cleaning" }],
            candidates: [{ sourceFile: file, source: "用語", target: "术语", note: "", sheetMode: "glossary", locale: "zh-CN", selected: true }],
            statistics: { files: 1, entries: 1, anomalies: 0 }
          })
        });
      }
      if (path === "/api/assets-import/commit") {
        commitBodies.push(JSON.parse(request.postData() || "{}"));
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "task-1", backgroundTaskId: "task-1", batchId: "batch-1", accepted: 1 }) });
      }
      if (path === "/api/background-tasks/task-1") {
        // 一直停在跑的状态：本用例只关心下一轮预检的界面状态，不触发视图跳转。
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            id: "task-1", type: "asset_import", taskType: "asset_import", title: "导入 · a.xlsx", status: "in_progress",
            progress: { phase: "queueing", message: "正在写入审核队列：1 / 1", percent: 4, completed: 1, total: 1 },
            payload: {}, updatedAt: new Date().toISOString()
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
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");

    const file = (name) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    // 术语库页面的"导入术语文件"：提交成功后会把弹窗切成"关闭窗口，后台继续"。
    await page.locator("#termLibraryFile").setInputFiles([file("a.xlsx")]);
    await page.waitForSelector("#assetPreflightDialog[open]");
    assert.equal(await page.locator("#assetPreflightConfirm").isVisible(), true, "第一轮预检要能确认");
    await page.locator("#assetPreflightConfirm").click();
    await page.waitForSelector("#assetPreflightClose:visible", { timeout: 45_000 });
    assert.equal(commitBodies.length, 1, "确认后应当提交后台导入");
    assert.equal(await page.locator("#assetPreflightTableWrap").isVisible(), false, "提交后候选表收起");
    // 提交之后再改勾选，摘要也不能退回"确认后进入后台导入"。
    await page.locator("#assetPreflightAiCleaning").check({ force: true });
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /已提交后台导入/u);
    assert.doesNotMatch(await page.locator("#assetPreflightSummary").textContent(), /确认后进入后台导入/u);
    await page.locator("#assetPreflightClose").click();
    await page.waitForFunction(() => document.querySelector("#assetPreflightDialog")?.open === false);

    // 第二轮：另选一个文件重新预检，必须回到"可确认"的状态。
    await page.locator("#termLibraryFile").setInputFiles([file("b.xlsx")]);
    await page.waitForSelector("#assetPreflightDialog[open]");
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /已识别 1 个文件/u);
    assert.equal(await page.locator("#assetPreflightConfirm").isVisible(), true, "第二轮预检必须还能确认");
    assert.equal(await page.locator("#assetPreflightConfirm").isEnabled(), true, "确认按钮不能被留在禁用态");
    assert.equal(await page.locator("#assetPreflightConfirm").textContent(), "确认并继续", "确认按钮文案要复位");
    assert.equal(await page.locator("#assetPreflightClose").isVisible(), false, "未提交时不该出现后台继续按钮");
    assert.equal(await page.locator("#assetPreflightTableWrap").isVisible(), true, "候选表要跟着回来");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/asset-preflight-second-import.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

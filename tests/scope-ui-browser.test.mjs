import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：语体退居内部信号后的界面
 *   ① 翻译页只留「质量档」，不再有语体 / 领域下拉；
 *   ② 翻译结果说清"本段用途 / 质量档 / 本次参考"；
 *   ③ 证据池默认只给"全部证据"总进度，细分按作用域折起来。
 */
test("翻译页只留质量档，结果里能看到用途与本次命中的作用域", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const distillCalls = [];
    const errors = [];
    let revised = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/translate") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            locale: "zh-CN",
            classification: { contentType: "dialogue", contentTags: [], source: "rules", confidence: 0.93 },
            domainResolution: { domain: "game", source: "rules", relaxedRetrieval: false },
            matches: [],
            translation: "走吧。",
            issues: [],
            qaScore: revised ? null : 94,
            aiQa: { translation: "走吧。", score: revised ? null : 94, status: revised ? "revised" : "passed", issues: [], references: [], iterations: revised ? 1 : 0 },
            styleProfile: { id: "sp-general", name: "通用规范", contentType: "general", domain: "general" },
            qualityTier: "standard",
            qualityTierLabel: "标准",
            qualityTierSource: "auto",
            tierReason: "常规句段，走标准流程",
            tierStrength: "",
            routing: { tier: "standard", label: "标准档", description: "初译 + 模型质检，最多一轮修订。", risk: { tier: "medium", reasons: [] } },
            scopeUsage: {
              contentType: "dialogue",
              domain: "game",
              styleProfile: { name: "通用规范", contentType: "general", domain: "general", rank: 3 },
              memoryScopes: { exact: 2, partial: 0, general: 3 }
            }
          })
        });
      }
      if (url.pathname === "/api/classify") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ contentType: "dialogue", contentTags: [], source: "rules", confidence: 0.93, domainResolution: { domain: "game", source: "rules" } })
        });
      }
      if (url.pathname === "/api/match") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) });
      }
      if (url.pathname === "/api/style-profiles/distill") {
        distillCalls.push(JSON.parse(request.postData() || "{}"));
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            locale: "zh-CN", projectId: "project-1", evidenceCount: 8134, distilled: true, skipped: "", reason: "",
            profile: { id: "sp-v2", name: "简体中文 general 风格", version: 2, rules: 9 }
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
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { projectId: "project-1", libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [{ id: "revised-case", source: "行こう。", rejectedTranslation: "去吧。", correctedTranslation: "走吧。", scoreBefore: 88, scoreAfter: null }];
      else if (url.pathname === "/api/style-profiles") payload = {
        userProfiles: [], styleProfiles: [], learningRuns: [],
        evidencePools: [
          { contentType: "general", domain: "general", scopeLabel: "全项目", evidenceCount: 8134, threshold: 8, sampled: 1000, sources: { tableImport: 8134, humanAccept: 0, qaReview: 0, revised: 0, negative: 0, other: 0 }, byContentType: [{ contentType: "general", count: 8134 }] }
        ],
        evidenceByScope: [
          { contentType: "general", count: 8100 },
          { contentType: "dialogue", count: 34 }
        ]
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");

    // ① 翻译页：只剩质量档，语体 / 领域下拉已经删除
    // 默认落在文件列表：单句输入要显式切到「单句输入」标签。
    await page.getByRole("button", { name: "单句输入" }).click();
    await page.waitForSelector("#singleWorkspace:not([hidden])");
    assert.equal(await page.locator("#view-workbench #qualityTier").count(), 1);
    assert.equal(await page.locator("#view-workbench #contentType").count(), 0, "语体下拉必须消失");
    assert.equal(await page.locator("#view-workbench #domain").count(), 0, "领域下拉必须消失");
    assert.equal(await page.locator("#view-workbench #translationRoute").count(), 0, "生成路线下拉必须消失");

    // ② 翻译一句：结果里要说清本次命中的作用域
    await page.locator("#sourceText").fill("行こう。");
    await page.locator("#primaryAction").click();
    await page.waitForFunction(() => document.querySelector("#targetOutput")?.textContent?.includes("走吧"));
    // 预检与翻译结果都会写这一行，两次内容不同：等**翻译结果那一版**出现再断言，
    // 否则会读到预检留下的中间态（并行全量时更明显）。
    const expectedReference = /本次参考：项目规范「通用规范」 v1 · 译例 5 条（同作用域 2 \/ 通用 3）/u;
    await page.waitForFunction(() => /本次参考：项目规范「通用规范」 v1 · 译例 5 条（同作用域 2 \/ 通用 3）/.test(document.querySelector("#classificationPreview")?.textContent || ""), null, { timeout: 60_000 });
    const previewText = await page.locator("#classificationPreview").textContent();
    assert.match(previewText, /语体/u);
    assert.match(previewText, expectedReference, `结果要写清用的是哪一版项目规范：${previewText}`);
    const qaPanel = await page.locator("#qaList").textContent();
    assert.match(qaPanel, /本段用途与质量档/u, "结果要写清本段用途与质量档");
    assert.match(qaPanel, /标准档/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/scope-advanced-collapsed.png`, animations: "disabled" });
    }
    revised = true;
    await page.locator("#primaryAction").click();
    await page.waitForFunction(() => document.querySelector("#issueCount")?.textContent === "已修订 · 规则检查通过");
    assert.match(await page.locator("#qaList").textContent(), /未进行模型复检或重新评分/u);
    assert.doesNotMatch(await page.locator("#qaList").textContent(), /硬规则与检索式 AIQA 均通过/u);
    if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/qa-revised-single.png`, fullPage: true, animations: "disabled" });
    // ③ 译文质检页也不再有语体 / 领域下拉
    await page.locator('.nav-item[data-view="autoqa"]').click();
    assert.equal(await page.locator("#view-autoqa #autoQaContentType").count(), 0);
    assert.equal(await page.locator("#view-autoqa #autoQaDomain").count(), 0);

    // ④ 证据池：项目级只有一个池子，语体分布折起来
    await page.locator('.nav-item[data-view="styles"]').click();
    await page.waitForSelector(".style-pool.is-total");
    assert.match(await page.locator("#styleQaList").textContent(), /88 → 未复检/u);
    const poolText = await page.locator("#styleEvidencePools").textContent();
    assert.match(poolText, /全部证据（项目级）/u);
    assert.match(poolText, /8134 \/ 8/u, `总进度要合并显示：${poolText}`);
    assert.match(poolText, /项目规范证据池/u);
    assert.equal(await page.locator("#styleEvidencePools > .style-pool").count(), 2, "只有一个项目池 + 一个总进度，不再有按作用域拆开的池子");
    assert.match(poolText, /按语体查看证据分布（2 类）/u);
    assert.equal(await page.locator("#styleEvidencePools details.advanced-scope").evaluate((node) => node.open), false, "语体分布默认收起");

    // ⑤ 立即重新蒸馏：不用等下一次批次，点了就打蒸馏接口并刷新
    const distillButton = page.locator("#styleDistillNow");
    assert.equal(await distillButton.count(), 1, "证据池旁要有「立即重新蒸馏」");
    // 证据池每次重画都会换掉按钮节点，满载时一次点击可能落在旧节点上：允许重试一次。
    for (let attempt = 0; attempt < 2 && distillCalls.length === 0; attempt += 1) {
      await distillButton.click({ timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(() => /已重新蒸馏/.test(document.querySelector("#toast")?.textContent || ""));
    assert.equal(distillCalls.length, 1);
    assert.equal(distillCalls[0].locale, "zh-CN");
    assert.equal(distillCalls[0].projectId, "project-1");
    assert.match(await page.locator("#toast").textContent(), /已重新蒸馏项目规范 v2（9 条规则/u, "结果要说清蒸馏出的项目规范版本");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      // 风格页：项目级单池 + 语体分布折叠。
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/style-pool-project-level.png`, fullPage: true, animations: "disabled" });
    }
    // ⑥ 学习中心：项目级作用域栏，明确写出语体/领域由系统自动判定、只作参考
    await page.locator('.nav-item[data-view="learning"]').click();
    const scopeBar = await page.locator(".learning-scope-bar").textContent();
    assert.match(scopeBar, /翻译技能作用域/u);
    assert.match(scopeBar, /整个项目/u);
    assert.match(scopeBar, /语体与领域由系统自动判定、只作参考/u);
    // 界面上不再有任何语体/领域选择器。
    assert.equal(await page.locator("#learningContentType").count(), 0);
    assert.equal(await page.locator("#learningDomain").count(), 0);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/learning-skill-scope-bar.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

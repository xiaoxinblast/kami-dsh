import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { batchAttention } from "../src/batch-attention.mjs";
import { checkRoundedField } from "./helpers/rounded-field.mjs";
import { buildBatchWorkflow } from "../public/batch-status.js";

test("DSH exposes single, cross-page and all-failed retries at wide and narrow widths", { skip: !process.env.KAMI_BROWSER_TEST_MODULE || !process.env.KAMI_REACT_DIRECTORY, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const operations = [], segments = Array.from({ length: 25 }, (_, i) => ({ id: `s${i + 1}`, source: `設定を保存します。${i + 1}`, translation: i === 24 ? "" : `保存设置。${i + 1}`, selected: true,
    status: i === 24 ? "pending" : i === 0 ? "error" : "done", error: i === 0 ? "模型输出被截断" : "", retryTranslationReason: i === 0 ? "模型输出被截断" : "",
    accepted: i === 3, result: { aiQa: i === 1 || i === 20 ? { fallbackReason: "请求中断，QA 未完成" } : { used: true, score: 95 } } }));
  const run = { batchId: "retry-batch", projectId: "p", locale: "zh-CN", filename: "重试验收.mqxliff", runState: "needs_attention", segments, runnerOptions: {}, workflow: {} };
  for (const [index, status] of [[1, "completed"], [4, "pending"], [5, "completed"], [6, "completed"]]) {
    segments[index].result.stages = { translation: { status: "completed" }, proofreading: { status }, localQa: { status: [1, 6].includes(index) ? "completed" : "pending" } };
  }
  segments[7].result = { stages: { translation: { status: "completed" }, draftQa: { status: "completed", hintCount: 1 }, proofreading: { status: "completed" }, localQa: { status: "optional" } }, aiQa: { status: "proofread_only", used: true } };
  run.workflow = buildBatchWorkflow(run);
  let fail = false, held = false, release;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    :root{--dsw-alias-label-primary:#25312b;--dsw-alias-label-secondary:#58665e;--dsw-alias-label-tertiary:#7b877f;--dsw-alias-bg-layer-1:#f6f8f5;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#eaf0e9;--dsw-alias-border-l2:#d9e0d8;--dsw-alias-interactive-bg-hover:#edf2eb;--dsw-alias-brand-primary:#174d40;--dsw-alias-button-primary-fill:#174d40;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-state-error-primary:#b33e38}
    html,body,#root{margin:0;height:100%;font:13px/1.5 "Microsoft YaHei",sans-serif}
  </style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script type="module">
    const {React,ReactDOM}=window, factories=new Map(), modules=new Map();
    window.__ModuleLoader__={load:({id,chunk,factory})=>factories.set(chunk?id+'/'+chunk:id,factory)};
    await import('/client.js');
    const require=name=>name==='react'?React:modules.has(name)?modules.get(name):(modules.set(name,factories.get(name)(require)),modules.get(name));
    let Component, props;
    const remote={$mount:async()=>()=>{},kamiUi:{invoke:async(_session,operation)=>(await fetch('/invoke',{method:'POST',body:JSON.stringify(operation)})).json()},session:{prompt:async(payload)=>{window.testPrompt=payload;return {ok:true,value:{}}}}};
    const ctx={remote,effect:callback=>callback(),locale:{register(){}},sidebarRightTabs:{register:()=>()=>{}},inject(_keys,callback){return callback(this)},slots:{inject:(_name,callback)=>callback(),register:(options,component)=>{if(options.name==='sidebar.right.pane.tab'){Component=component;props=options.inject();}}}};
    await require('kami-dsh').apply(ctx);
    ReactDOM.createRoot(document.querySelector('#root')).render(React.createElement(Component,{...props,sessionId:'fixture',useSessions:select=>select({byId:{fixture:{projectionValues:{agentPreset:'kami-translator'}}}}),useTabInfo:()=>({tab:{visible:true}}),t:key=>key}));
  </script></html>`;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); return res.end(html); }
      if (["/react.js", "/react-dom.js", "/client.js"].includes(req.url)) {
        res.setHeader("content-type", "text/javascript");
        return res.end(await readFile(req.url === "/client.js" ? new URL("../dsh/client.js", import.meta.url) : join(process.env.KAMI_REACT_DIRECTORY, req.url === "/react.js" ? "react/umd/react.production.min.js" : "react-dom/umd/react-dom.production.min.js")));
      }
      if (req.url !== "/invoke") { res.writeHead(404); return res.end(); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const operation = JSON.parse(Buffer.concat(chunks).toString());
      let value = {};
      if (operation.action === "export") throw new Error("client api: kamiUi/invoke failed: Failed to fetch");
      if (operation.action === "workspace") value = { isKamiSession: true, workspace: "D:/retry", config: { projectId: "p" }, project: { id: "p", name: "重试验收" } };
      else if (operation.path === "/api/projects") value = { projects: [{ id: "p", name: "重试验收" }] };
      else if (operation.path?.startsWith("/api/batch/files")) value = { files: [{ ...run, attention: batchAttention(run) }] };
      else if (operation.path?.startsWith("/api/tasks")) value = [];
      else if (operation.method === "POST" && /\/retry-(translation|qa|proofreading)$/.test(operation.path)) {
        operations.push(operation);
        if (held) await new Promise((resolve) => { release = resolve; });
        if (fail) throw new Error("模拟重试提交失败");
        value = { count: operation.body.segmentIds?.length || 1 };
      } else if (operation.method === "POST" && /\/(?:consistency-check|term-survey|context-brief)$/.test(operation.path)) { operations.push(operation); value = { pending: true }; }
      else if (operation.path?.startsWith("/api/batch/run/")) value = run;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, value }));
    } catch (error) { res.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 1050 } }), errors = [];
    page.setDefaultTimeout(6000); page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "重试全部未完成 QA", exact: true }).waitFor();
    await page.getByRole("button", { name: "查看校对润色详情", exact: true }).waitFor();
    assert.deepEqual(await page.locator(".flow-row").first().locator(".flow-node > strong").allTextContents(), ["翻译", "逐段 QA", "校对润色"]);
    const mixed = page.getByRole("button", { name: "查看逐段 QA详情", exact: true });
    assert.match(await mixed.innerText(), /3\s*\/\s*25/);
    await mixed.getByText("初稿 QA 1 · 旧版校对后 QA 2", { exact: true }).waitFor();
    const banner = page.getByRole("region", { name: "任务等待手动处理" });
    await banner.getByText(/1 段待处理.*模型输出被截断/).waitFor();
    await banner.getByRole("button", { name: "重试失败译段", exact: true }).click();
    assert.match(operations.at(-1).path, /retry-translation$/);
    const primaryRow = page.locator(".button-row").filter({ has: page.getByRole("button", { name: "保存修改", exact: true }) }).first();
    const secondRow = primaryRow.locator("xpath=following-sibling::*[1]");
    const analysis = page.getByRole("region", { name: "翻译流程", exact: true }).getByRole("region", { name: "语境分析", exact: true });
    assert.equal(await analysis.getAttribute("data-status"), "not_started");
    await analysis.getByText("可选", { exact: true }).waitFor();
    assert.equal(await analysis.getByRole("button", { name: "开始语境分析", exact: true }).isEnabled(), true);
    for (const width of [960, 330]) {
      await page.setViewportSize({ width, height: 1500 });
      assert.equal(await page.locator(".kami").evaluate(element => element.scrollWidth > element.clientWidth), false);
      const row1 = await primaryRow.boundingBox(), row2 = await secondRow.boundingBox();
      assert.ok(row2.y - row1.y - row1.height >= 10, "two action rows need visible vertical separation");
      if (process.env.KAMI_UI_SCREENSHOTS) {
        await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
        await banner.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `attention-${width}.png`) });
        await secondRow.scrollIntoViewIfNeeded();
        const first = await primaryRow.boundingBox(), last = await secondRow.boundingBox();
        await page.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `translation-actions-${width}.png`), clip: { x: first.x - 4, y: first.y - 4, width: first.width + 8, height: last.y + last.height - first.y + 8 } });
      }

      if (process.env.KAMI_UI_SCREENSHOTS) {
        await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
        await page.locator(".workflow-graph").screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `workflow-graph-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 960, height: 1050 });
    await page.getByRole("button", { name: "查看翻译详情", exact: true }).click();
    await page.locator(".segment-row").nth(1).click();
    const modelRetry = page.getByRole("button", { name: "重试此句模型 QA", exact: true });
    if (process.env.KAMI_UI_SCREENSHOTS) await page.locator(".segment-editor").screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "model-qa-retry.png") });
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/invoke") && response.request().postData()?.includes("retry-qa")), modelRetry.click()]);
    assert.deepEqual(operations.filter(operation => operation.path.endsWith("/retry-qa")).at(-1)?.body.segmentIds, ["s2"]);
    await page.locator(".segment-row").nth(7).click();
    const editor = page.locator(".segment-editor textarea").last();
    await checkRoundedField(editor, "translation");
    const manual = page.getByRole("button", { name: "手动检查此句 QA", exact: true });
    assert.equal(await manual.isEnabled(), true);
    if (process.env.KAMI_UI_SCREENSHOTS) await page.locator(".segment-editor").screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "manual-qa.png") });
    await manual.click();
    await page.getByText("重试已提交，可在任务概览查看进度。", { exact: true }).last().waitFor();
    assert.deepEqual(operations.at(-1).body.segmentIds, ["s8"]);
    await page.setViewportSize({ width: 330, height: 1050 });
    await page.getByRole("button", { name: "返回译段列表", exact: true }).click();
    await page.setViewportSize({ width: 960, height: 1050 });
    const region = page.getByRole("region", { name: "句段重试", exact: true });
    assert.equal(await page.getByRole("checkbox", { name: "勾选句段 4", exact: true }).isDisabled(), true);
    await page.getByRole("checkbox", { name: "勾选句段 5", exact: true }).check();
    await region.getByRole("button", { name: "仅重试所选校对 (1)", exact: true }).click();
    await region.getByRole("button", { name: "仅重试所选校对 (0)", exact: true }).waitFor();
    assert.match(operations.at(-1).path, /retry-proofreading$/);
    assert.deepEqual(operations.at(-1).body.segmentIds, ["s5"]);
    await page.getByRole("checkbox", { name: "勾选句段 2", exact: true }).check();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByRole("checkbox", { name: "勾选句段 21", exact: true }).check();
    await region.getByRole("button", { name: "仅重试所选 QA (2)", exact: true }).click();
    await region.getByText("重试已提交，可在任务概览查看进度。", { exact: true }).last().waitFor();
    assert.deepEqual(operations.at(-1).body.segmentIds, ["s2", "s21"]);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await page.getByRole("checkbox", { name: "勾选句段 1", exact: true }).check();
    for (const width of [960, 330]) {
      await page.setViewportSize({ width, height: 1050 });
      assert.equal(await page.locator(".kami").evaluate((element) => element.scrollWidth > element.clientWidth), false);
      if (process.env.KAMI_UI_SCREENSHOTS) { await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true }); await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `translation-retry-${width}.png`) }); }
    }
    held = true; fail = true;
    await region.getByRole("button", { name: "批量重试翻译 (1)", exact: true }).click();
    assert.equal(await region.getByRole("button", { name: "批量重试翻译 (1)", exact: true }).isDisabled(), true);
    release(); held = false;
    await region.getByRole("alert").filter({ hasText: "模拟重试提交失败" }).waitFor();
    fail = false;
    await region.getByRole("button", { name: "批量重试翻译 (1)", exact: true }).click();
    await region.getByRole("button", { name: "批量重试翻译 (0)", exact: true }).waitFor();
    assert.deepEqual(operations.at(-1).body.segmentIds, ["s1"]);
    await region.getByRole("button", { name: "重试全部翻译失败 (1)", exact: true }).click();
    await region.getByRole("button", { name: "重试全部翻译失败 (1)", exact: true }).isEnabled();
    assert.equal(Object.hasOwn(operations.at(-1).body, "segmentIds"), false);
    await page.locator(".segment-row").first().click();
    await page.getByRole("button", { name: "重试此句翻译", exact: true }).click();
    await page.getByRole("button", { name: "重试此句翻译", exact: true }).isEnabled();
    assert.deepEqual(operations.at(-1).body.segmentIds, ["s1"]);
    await page.getByRole("textbox", { name: "译文 1", exact: true }).fill("保留未保存草稿");
    assert.equal(await page.getByRole("button", { name: "重试此句翻译", exact: true }).isDisabled(), true);
    if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "translation-retry-single-330.png") });
    run.segments = [segments[6], segments[7]];
    run.runState = "completed";
    run.runnerOptions.stageRetryOnly = true;
    run.workflow = buildBatchWorkflow(run);
    await page.reload();
    const completed = page.getByRole("button", { name: "查看逐段 QA详情", exact: true });
    await completed.getByText("已完成", { exact: true }).waitFor();
    assert.match(await completed.innerText(), /2\s*\/\s*2/);
    await completed.getByText("初稿 QA 1 · 旧版校对后 QA 1", { exact: true }).waitFor();
    assert.doesNotMatch(await completed.innerText(), /未记录/);
    for (const width of [960, 330]) {
      await page.setViewportSize({ width, height: 1050 });
      if (process.env.KAMI_UI_SCREENSHOTS) await page.locator(".flow-group").filter({ has: completed }).screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, 'completed-mixed-' + width + '.png') });
    }
    run.exportIssues = [{ segmentId: segments[6].id, index: 1, unitId: "540", reason: "内联标签数量错误（原文 1 个，译文 3 个）" }];
    run.qualityReport = { report: { generatedAt: "2026-11-19T08:20:00Z", coverage: { modelQa: 2, qaIncomplete: 0 }, facts: { issueCount: 0 }, humanReview: { suggested: 0 } }, findings: [], warning: "1 个一致性分片超时" };
    run.workflow.qualityReport = { status: "needs_attention", message: "一致性初查完成 2 / 3 片" };
    run.workflow.termSurvey = { status: "needs_attention", message: "术语查库完成 2 / 3 条" };
    run.consistencyRetryCount = 1;
    run.termSurvey = { generatedAt: new Date().toISOString(), terms: [{ source: "敵", suggestedTarget: "敌人", initialTarget: "敌方", tm: { status: "matched", role: "master", reason: "主 TM 已确认译法" } }, { source: "町", suggestedTarget: "小镇" }, { source: "民", suggestedTarget: "百姓", initialTarget: "市民", tm: { status: "failed", reason: "对齐超时" } }], warning: "1 条查询超时，1 处修订未完成", coverage: { failedTerms: 1, checkedTerms: 2, markedTerms: 3 }, repair: { verifiedMemoryOnly: true, skipped: [{ source: "敵", reason: "模型 QA 超时", segmentId: segments[6].id }] } };
    await page.reload();
    const panel = name => page.locator('[aria-label="当前任务分区"]').getByRole("button", { name, exact: true });
    await panel("工作区导出").click();
    const exportPanel = page.locator(".export-panel");
    assert.equal(await exportPanel.getByRole("button", { name: "导出文件" }).isDisabled(), true);
    await exportPanel.getByRole("button", { name: "让 Agent 修复" }).click();
    await page.waitForFunction(() => window.testPrompt?.content?.length);
    assert.match(await page.evaluate(() => window.testPrompt.content[0].text), /retry-batch\/export-repair/);
    async function preview(region, name) {
      for (const width of [960, 330]) {
        await page.setViewportSize({ width, height: 1050 });
        assert.equal(await page.locator(".kami").evaluate(element => element.scrollWidth > element.clientWidth), false);
        if (process.env.KAMI_UI_SCREENSHOTS) await region.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, name + "-" + width + ".png") });
      }
    }
    await preview(exportPanel, "export-repair");
    await exportPanel.getByRole("button", { name: "查看译段" }).click();
    await page.locator(".segment-editor").getByRole("textbox", { name: "译文 1" }).waitFor();
    await panel("质量与复查").click();
    for (const [tab, label, count, endpoint] of [["一致性复查", "仅重试一致性失败项", 1, "consistency-check"], ["术语普查", "仅重试术语失败项", 2, "term-survey"]]) {
      await page.locator('[aria-label="报告类型"]').getByRole("button", { name: tab, exact: true }).click();
      const retry = page.getByRole("button", { name: label + " (" + count + ")", exact: true });
      await preview(page.locator("section.card").filter({ has: retry }), endpoint);
      await Promise.all([page.waitForResponse(res => res.url().endsWith("/invoke") && res.request().postData()?.includes(endpoint)), retry.click()]);
      assert.equal(operations.at(-1).body.failedOnly, true);
      assert.equal(operations.at(-1).body.projectId, "p");
    }
    run.exportIssues = [];
    await page.reload();
    await panel("工作区导出").click();
    await exportPanel.getByRole("button", { name: "导出文件" }).click();
    await exportPanel.getByRole("alert").filter({ hasText: "Failed to fetch" }).waitFor();
    await exportPanel.getByRole("button", { name: "让 Agent 排查导出错误" }).click();
    await page.waitForFunction(() => window.testPrompt?.content[0]?.text.includes("Failed to fetch"));
    await preview(exportPanel, "export-error");
    run.contextBrief = { status: "failed", warning: "1 片分析超时", coverage: { covered: 1, total: 2 }, retryParts: { failed: [1] } };
    await page.reload();
    const brief = page.getByRole("region", { name: "语境分析", exact: true });
    const retryPart = brief.getByRole("button", { name: "仅重试失败分片 (1)", exact: true });
    await preview(brief, "context-retry");
    await Promise.all([page.waitForResponse(res => res.url().endsWith("/invoke") && res.request().postData()?.includes("context-brief")), retryPart.click()]);
    assert.equal(operations.at(-1).body.failedOnly, true);
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

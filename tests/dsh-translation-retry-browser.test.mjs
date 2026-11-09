import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

test("DSH exposes single, cross-page and all-failed retries at wide and narrow widths", { skip: !process.env.KAMI_BROWSER_TEST_MODULE || !process.env.KAMI_REACT_DIRECTORY, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const operations = [], segments = Array.from({ length: 25 }, (_, i) => ({ id: `s${i + 1}`, source: `設定を保存します。${i + 1}`, translation: i === 24 ? "" : `保存设置。${i + 1}`, selected: true,
    status: i === 24 ? "pending" : i === 0 ? "error" : "done", error: i === 0 ? "模型输出被截断" : "", retryTranslationReason: i === 0 ? "模型输出被截断" : "",
    accepted: i === 3, result: { aiQa: i === 1 || i === 20 ? { fallbackReason: "请求中断，QA 未完成" } : { used: true, score: 95 } } }));
  const run = { batchId: "retry-batch", projectId: "p", locale: "zh-CN", filename: "重试验收.mqxliff", runState: "paused", segments, runnerOptions: {}, workflow: {} };
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
    const remote={$mount:async()=>()=>{},kamiUi:{invoke:async(_session,operation)=>(await fetch('/invoke',{method:'POST',body:JSON.stringify(operation)})).json()},session:{prompt:async()=>({ok:true,value:{}})}};
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
      if (operation.action === "workspace") value = { workspace: "D:/retry", config: { projectId: "p" }, project: { id: "p", name: "重试验收" } };
      else if (operation.path === "/api/projects") value = { projects: [{ id: "p", name: "重试验收" }] };
      else if (operation.path?.startsWith("/api/batch/files")) value = { files: [run] };
      else if (operation.path?.startsWith("/api/tasks")) value = [];
      else if (operation.method === "POST" && /\/retry-(translation|qa)$/.test(operation.path)) {
        operations.push(operation);
        if (held) await new Promise((resolve) => { release = resolve; });
        if (fail) throw new Error("模拟重试提交失败");
        value = { count: operation.body.segmentIds?.length || 1 };
      } else if (operation.path?.startsWith("/api/batch/run/")) value = run;
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
    await page.getByRole("button", { name: "查看翻译详情", exact: true }).click();
    const region = page.getByRole("region", { name: "句段重试", exact: true });
    assert.equal(await page.getByRole("checkbox", { name: "勾选句段 4", exact: true }).isDisabled(), true);
    await page.getByRole("checkbox", { name: "勾选句段 2", exact: true }).check();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByRole("checkbox", { name: "勾选句段 21", exact: true }).check();
    await region.getByRole("button", { name: "仅重试所选 QA (2)", exact: true }).click();
    await region.getByText("重试已提交，可在任务概览查看进度。", { exact: true }).waitFor();
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
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

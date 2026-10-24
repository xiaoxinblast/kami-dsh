import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

test("linked resources automatically queue compilation and show pending/ready results in the DSH component", { skip: !process.env.KAMI_BROWSER_TEST_MODULE || !process.env.KAMI_REACT_DIRECTORY, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const directory = await mkdtemp(join(tmpdir(), "kami-compile-browser-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "terms.custom"), "无固定列布局：星の剣 → 星刃；备注：装备名称");
  await writeFile(join(cwd, "style.custom"), "完整保留指南规则、例外和正反例。");
  await writeFile(join(cwd, "reference.original"), "参考资料只关联，按需查阅。");
  const { fs, close } = await workspaceFs(), workbench = await createWorkbench({ dataDirectory: join(directory, "data") });
  const context = { cwd, fs, human: true, isKamiSession: true };
  const state = await workbench.workspace({ action: "bind", name: "资源编译界面验收" }, context);
  const termLibrary = state.libraries.find((item) => item.kind === "term_base");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    :root{--dsw-alias-label-primary:#25312b;--dsw-alias-label-secondary:#58665e;--dsw-alias-label-tertiary:#7b877f;--dsw-alias-bg-layer-1:#f6f8f5;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#eaf0e9;--dsw-alias-border-l2:#d9e0d8;--dsw-alias-interactive-bg-hover:#edf2eb;--dsw-alias-brand-primary:#174d40;--dsw-alias-state-error-primary:#b33e38}
    html,body,#root{margin:0;height:100%;font:13px/1.5 "Microsoft YaHei",sans-serif}
  </style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script type="module">
    const { React, ReactDOM } = window;
    const factories = new Map(), modules = new Map();
    window.__ModuleLoader__ = { load: ({id,chunk,factory}) => factories.set(chunk ? id + '/' + chunk : id,factory) };
    await import('/client.js');
    const require = name => name === 'react' ? React : modules.has(name) ? modules.get(name) : (modules.set(name,factories.get(name)(require)),modules.get(name));
    let Component, props;
    window.prompts = [];
    const remote = { $mount: async () => () => {}, kamiUi: { invoke: async (_session,operation) => {
      const response = await fetch('/invoke',{method:'POST',body:JSON.stringify(operation)}); return response.json();
    } }, session: { prompt: async args => { window.prompts.push(args); return {ok:true,value:{}}; } } };
    const ctx = { remote, effect: callback => callback(), locale: {register(){}}, sidebarRightTabs:{register:()=>()=>{}},
      inject(_keys,callback){return callback(this)}, slots:{inject:(_name,callback)=>callback(),register:(options,component)=>{
        if(options.name==='sidebar.right.pane.tab'){Component=component;props=options.inject();}
      }} };
    await require('kami-dsh').apply(ctx);
    ReactDOM.createRoot(document.querySelector('#root')).render(React.createElement(Component,{...props,sessionId:'fixture',
      useSessions:select=>select({byId:{fixture:{projectionValues:{agentPreset:'kami-translator'}}}}),useTabInfo:()=>({tab:{visible:true}}),t:key=>key}));
  </script></html>`;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); return res.end(html); }
      if (["/react.js", "/react-dom.js", "/client.js"].includes(req.url)) {
        res.setHeader("content-type", "text/javascript");
        return res.end(await readFile(req.url === "/client.js" ? new URL("../dsh/client.js", import.meta.url) : join(process.env.KAMI_REACT_DIRECTORY, req.url === "/react.js" ? "react/umd/react.production.min.js" : "react-dom/umd/react-dom.production.min.js")));
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/invoke") {
        const value = await workbench.perform(body, context);
        res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, value }));
      }
      if (req.url === "/complete") {
        const paths = body.paths || [body.path], resourceContext = [];
        for (const path of paths) {
          const linked = await workbench.importFile({ path, purpose: body.purpose, register: false }, context);
          resourceContext.push({ path: linked.path, hash: linked.hash, ...(body.purpose === "terms" ? { pairs: [{ source: "星の剣", target: "星刃", note: "装备名称" }] } : { text: "完整保留指南规则、例外和正反例。" }) });
        }
        await workbench.importFile({ path: paths[0], purpose: body.purpose, resourceContext }, context);
        return res.end("{}");
      }
      res.writeHead(404); res.end();
    } catch (error) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 960, height: 1000 } }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector(".kami"), null, { timeout: 5000 }).catch(() => { throw new Error(`DSH component render failed: ${errors.join("; ")}`); });
    await page.getByRole("button", { name: "资产", exact: true }).click();
    await page.locator(".library-row").filter({ hasText: termLibrary.name }).getByRole("button", { name: "打开", exact: true }).click();
    const link = async (path) => {
      const details = page.locator("details").filter({ has: page.locator("summary", { hasText: "关联工作区文件" }) });
      if (!await details.evaluate((element) => element.open)) await details.locator("summary").click();
      await details.locator("input").fill(path);
      await details.getByRole("button", { name: "关联文件", exact: true }).click();
      await page.getByText("待 Agent 编译", { exact: true }).waitFor();
    };
    const screenshot = async (name) => {
      if (!process.env.KAMI_UI_SCREENSHOTS) return;
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.locator(".preview").screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `${name}.png`), animations: "disabled" });
    };
    await link("terms.custom");
    const termsBadge = page.locator(".file-row").filter({ hasText: "terms.custom" }).locator(".compilation-badge");
    await termsBadge.getByText("待编译", { exact: true }).waitFor();
    await page.waitForFunction(() => window.prompts.length === 1);
    assert.match(await page.evaluate(() => window.prompts[0].content[0].text), /理解原文件/);
    await screenshot("compile-terms-pending");
    await page.evaluate(() => fetch("/complete", { method: "POST", body: JSON.stringify({ path: "terms.custom", purpose: "terms" }) }));
    await termsBadge.getByText("已完成编译", { exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新编译状态", exact: true }).click();
    await page.getByText("已编译，可用于翻译 · 1 条", { exact: true }).waitFor();
    await screenshot("compile-terms-ready");
    await page.getByRole("button", { name: "风格指南", exact: true }).click();
    await link("style.custom");
    await page.waitForFunction(() => window.prompts.length === 2);
    await page.evaluate(() => fetch("/complete", { method: "POST", body: JSON.stringify({ path: "style.custom", purpose: "style-guide" }) }));
    await page.getByRole("button", { name: "刷新编译状态", exact: true }).click();
    await page.getByText(/已编译，可用于翻译 · \d+ 字符/).waitFor();
    await page.setViewportSize({ width: 420, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot("compile-style-ready-narrow");
    const batchPaths = Array.from({ length: 25 }, (_, index) => `bulk-${String(index + 1).padStart(2, "0")}.custom`);
    const nested = ["已完成批次/EXP_Batch_8_ZH-HANS.xlsx_zho-CN.mqxliff", "已完成批次/另一个参考文件.custom"];
    await mkdir(join(cwd, "已完成批次"));
    for (const path of [...batchPaths, ...nested, "memory.custom", "disabled.custom", "style2.custom"]) await writeFile(join(cwd, path), `批量验收资料 ${path}`);
    const endpoint = `/api/projects/${state.project.id}/libraries`;
    const memory = (await workbench.invoke({ path: endpoint, method: "POST", body: { kind: "translation_memory", role: "reference", name: "批量记忆库" } }, context)).library;
    const disabled = (await workbench.invoke({ path: endpoint, method: "POST", body: { kind: "translation_memory", role: "reference", name: "停用库", enabled: false } }, context)).library;
    const configured = await workbench.workspace({}, context);
    await workbench.workspace({ action: "configure", resources: { terms: ["terms.custom", ...batchPaths, ...nested], translationMemories: ["memory.custom", "disabled.custom"], styleGuides: ["style.custom", "style2.custom"], libraryFiles: [...configured.config.libraryFiles,
      ...[...batchPaths, ...nested].map((path) => ({ path, purpose: "terms", libraryId: termLibrary.id })),
      { path: "memory.custom", purpose: "tm", libraryId: memory.id }, { path: "disabled.custom", purpose: "tm", libraryId: disabled.id }] } }, context);
    await page.setViewportSize({ width: 960, height: 1100 });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("button", { name: "术语库", exact: true }).click();
    await page.locator(".library-row").filter({ hasText: termLibrary.name }).getByRole("button", { name: "打开", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "搜索资源文件", exact: true });
    await search.fill("bulk-");
    await page.getByRole("button", { name: "全选筛选结果", exact: true }).click();
    await page.getByText("已选择 25 个文件", { exact: true }).waitFor();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: "选择 bulk-25.custom", exact: true }).isChecked(), true);
    const batchCard = page.locator("section.card").filter({ has: page.getByRole("button", { name: "编译选中", exact: true }) }).last();
    if (process.env.KAMI_UI_SCREENSHOTS) await batchCard.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "compile-selected-wide.png"), animations: "disabled" });
    await page.getByRole("button", { name: "编译选中", exact: true }).click();
    await page.waitForFunction(() => window.prompts.length === 3);
    const selectedPrompt = await page.evaluate(() => window.prompts[2].content[0].text);
    assert.ok(selectedPrompt.includes("bulk-25.custom")); assert.ok(!selectedPrompt.includes("memory.custom"));
    await page.evaluate((paths) => fetch("/complete", { method: "POST", body: JSON.stringify({ paths, purpose: "terms" }) }), batchPaths);
    await page.getByRole("button", { name: "编译选中", exact: true }).click();
    await page.getByText("所选资源均已编译，无需重复", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.prompts.length), 3);
    const record = JSON.parse(await readFile((await workbench.importFile({ path: "terms.custom", purpose: "terms", register: false }, context)).compilation.compiledFile, "utf8"));
    assert.equal(record.candidates.length, 1); assert.equal(record.sources.length, 26);
    await page.getByRole("button", { name: "清空选择", exact: true }).click();
    await search.fill("");
    await page.getByRole("checkbox", { name: "选择 已完成批次", exact: true }).check();
    await page.getByText("已选择 2 个文件", { exact: true }).waitFor();
    assert.equal(await page.getByText("所选资源均已编译，无需重复", { exact: true }).count(), 0);
    await search.fill("已完成批次");
    await page.setViewportSize({ width: 420, height: 1100 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.KAMI_UI_SCREENSHOTS) await batchCard.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "compile-selected-narrow.png"), animations: "disabled" });
    await page.getByRole("button", { name: "编译全部待编译", exact: true }).click();
    await page.waitForFunction(() => window.prompts.length === 4);
    const allPrompt = await page.evaluate(() => window.prompts[3].content[0].text);
    for (const path of [...nested, "memory.custom", "style2.custom"]) assert.ok(allPrompt.includes(path));
    assert.ok(!allPrompt.includes("disabled.custom")); assert.ok(!allPrompt.includes("bulk-25.custom"));
    await page.locator(".kami").evaluate((element) => { element.scrollTop = 0; });
    if (process.env.KAMI_UI_SCREENSHOTS) await page.locator("section.card").filter({ has: page.getByRole("button", { name: "编译全部待编译", exact: true }) }).screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "compile-all-narrow.png"), animations: "disabled" });
    await search.fill("");
    const folderRow = page.locator(".file-row").filter({ hasText: "已完成批次" });
    await folderRow.locator(".compilation-badge").getByText("有文件待编译 0/2", { exact: true }).waitFor();
    await page.evaluate((path) => fetch("/complete", { method: "POST", body: JSON.stringify({ path, purpose: "terms" }) }), nested[0]);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await folderRow.locator(".compilation-badge").getByText("有文件待编译 1/2", { exact: true }).waitFor();
    await page.setViewportSize({ width: 960, height: 1100 });
    if (process.env.KAMI_UI_SCREENSHOTS) await folderRow.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "compilation-badges-mixed-wide.png"), animations: "disabled" });
    await page.evaluate((path) => fetch("/complete", { method: "POST", body: JSON.stringify({ path, purpose: "terms" }) }), nested[1]);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await folderRow.locator(".compilation-badge").getByText("已完成编译 2/2", { exact: true }).waitFor();
    await page.setViewportSize({ width: 420, height: 1100 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.KAMI_UI_SCREENSHOTS) await folderRow.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "compilation-badges-folder-narrow.png"), animations: "disabled" });
    await writeFile(join(cwd, nested[0]), "已编译后发生变动的原文件");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await folderRow.locator(".compilation-badge").getByText("有文件待编译 1/2", { exact: true }).waitFor();
    await search.fill("已完成批次");
    await page.locator(".file-row").filter({ hasText: nested[0] }).locator(".compilation-badge").getByText("待编译", { exact: true }).waitFor();
    await page.locator(".file-row").filter({ hasText: nested[1] }).locator(".compilation-badge").getByText("已完成编译", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.KAMI_UI_SCREENSHOTS) await batchCard.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "compilation-badges-files-narrow.png"), animations: "disabled" });
    await rm(join(cwd, nested[1]));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.locator(".file-row").filter({ hasText: nested[1] }).locator('.compilation-badge[data-state="error"]').waitFor();
    await search.fill("");
    await folderRow.locator('.compilation-badge[data-state="error"]').waitFor();
    const beforeReference = await page.evaluate(() => window.prompts.length);
    await page.getByRole("button", { name: "参考资料", exact: true }).click();
    await page.getByText("参考资料只关联原件，翻译时由 Agent 按需直接查阅，不预解析或编译。", { exact: true }).waitFor();
    const referenceDetails = page.locator("details").filter({ has: page.locator("summary", { hasText: "关联工作区文件" }) });
    await referenceDetails.locator("input").fill("reference.original");
    await referenceDetails.getByRole("button", { name: "关联文件", exact: true }).click();
    await page.locator(".file-row").filter({ hasText: "reference.original" }).waitFor();
    assert.equal(await page.evaluate(() => window.prompts.length), beforeReference, "reference association must not queue compilation or reading");
    assert.equal(await page.locator(".compilation-badge").count(), 0);
    assert.equal(await page.getByRole("button", { name: "让 Agent 编译", exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.KAMI_UI_SCREENSHOTS) await page.locator("section.card").filter({ has: page.getByRole("searchbox", { name: "搜索资源文件", exact: true }) }).screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "reference-links-only-narrow.png"), animations: "disabled" });
    await page.getByRole("button", { name: "让 Agent 查看原文件", exact: true }).click();
    await page.waitForFunction((count) => window.prompts.length === count + 1, beforeReference);
    assert.match(await page.evaluate(() => window.prompts.at(-1).content[0].text), /reference.original/);
    await writeFile(join(cwd, "source.txt"), "設定を開きます。");
    await workbench.importFile({ path: "source.txt", resources: { terms: [], translationMemories: [], styleGuides: [] } }, context);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    const provenance = page.locator("details.snapshot");
    await provenance.locator("summary").click();
    await provenance.getByText("原文、术语、TM 和风格指南沿用此版本；参考资料按需读取当前原件。", { exact: true }).waitFor();
    const referenceRecord = provenance.locator(".snapshot-row").filter({ hasText: "reference.original" });
    assert.ok((await referenceRecord.locator("code").textContent()).length > 0);
    assert.equal((await referenceRecord.locator("code").textContent()).includes("SHA-256"), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.KAMI_UI_SCREENSHOTS) await provenance.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, "reference-task-record-narrow.png"), animations: "disabled" });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await workbench.close(); await close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-compile-browser-")));
    await rm(directory, { recursive: true, force: true });
  }
});

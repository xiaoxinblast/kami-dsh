import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { saveBatchRun, saveLearningTrajectory, saveTranslationSkill } from "../src/store.mjs";
import { createDefaultTranslationSkill } from "../src/learning-engine.mjs";

test("DSH reports open details and trajectories; settings retain drafts, padding and saved switches", { skip: !process.env.KAMI_BROWSER_TEST_MODULE || !process.env.KAMI_REACT_DIRECTORY, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const directory = await mkdtemp(join(tmpdir(), "kami-settings-browser-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const { fs, close } = await workspaceFs(), workbench = await createWorkbench({ dataDirectory: join(directory, "data") });
  const context = { cwd, fs, human: true, isKamiSession: true };
  const state = await workbench.workspace({ action: "bind", name: "设置界面验收" }, context);
  await writeFile(join(cwd, "source.txt"), "星の剣を装備します。");
  const prepared = await workbench.importFile({ path: "source.txt" }, context);
  const run = await workbench.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${state.project.id}` }, context);
  const segment = { ...run.segments[0], translation: "装备星之剑。", status: "done", result: { qaScore: 85, aiQa: { status: "review", used: true }, issues: [{ message: "请核对登记译法", suggestion: "使用星刃", severity: "major" }] } };
  await saveBatchRun({ ...run, runState: "completed", segments: [segment], runnerOptions: { ...run.runnerOptions, termSurvey: { generatedAt: new Date().toISOString(), terms: [{ source: "星の剣", suggestedTarget: "星刃", reason: "测试专名" }] } }, qualityReport: { report: { generatedAt: new Date().toISOString(), coverage: { modelQa: 1 }, facts: { issueCount: 1 }, humanReview: { suggested: 1 } }, findings: [{ detail: "同一名称需要核对", suggestion: "核对术语证据", ids: [segment.id] }] } });
  await saveLearningTrajectory({ locale: "zh-CN", contentType: "general", domain: "general", project: state.project.id, batchId: run.batchId, segmentId: segment.id, source: segment.source, initialTranslation: "装备星之剑。", finalTranslation: "装备星刃。", status: "completed", humanDecision: { accepted: true, machineTranslation: "装备星之剑。", finalTranslation: "装备星刃。" }, assetRefs: { sourceFile: "reviewed.mqxliff" } });
  const learningScope = { locale: "zh-CN", project: state.project.id, contentType: "general", domain: "general" };
  await saveTranslationSkill({ ...learningScope, ...createDefaultTranslationSkill({ scope: learningScope }), metadata: { learningAutomation: { status: "waiting", message: "还需 17 条未参与本候选学习的人工终稿，补齐后自动评测", missingSamples: 17 } } });
  let failQa = false, failSettings = false;
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
      if (req.url === "/invoke") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const operation = JSON.parse(Buffer.concat(chunks).toString());
        if (failQa && operation.method === "PATCH" && operation.body?.settings?.qa) throw new Error("模拟 QA 保存失败");
        if (failSettings && operation.path === "/api/settings" && operation.method === "GET") throw new Error("模拟参数加载失败");
        const value = await workbench.perform(operation, context);
        res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, value }));
      }
      res.writeHead(404); res.end();
    } catch (error) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 960, height: 1000 } }), errors = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "查看质量检查详情", exact: true }).click();
    await page.getByText("请核对登记译法", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看译段", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "译文 1", exact: true }).inputValue(), "装备星之剑。");
    await page.getByRole("button", { name: "查看上次报告", exact: true }).click();
    await page.getByRole("button", { name: "一致性复查", exact: true }).click();
    await page.getByText("同一名称需要核对", { exact: true }).waitFor();
    await page.getByRole("button", { name: "术语普查", exact: true }).click();
    await page.getByText("星の剣 → 星刃", { exact: true }).waitFor();
    await page.getByRole("button", { name: "学习", exact: true }).click();
    const automatic = page.getByRole("region", { name: "自动学习状态", exact: true });
    await automatic.getByText("等待样本", { exact: true }).waitFor();
    assert.match(await automatic.innerText(), /还需 17 条/);
    for (const width of [960, 330]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.locator("main").evaluate((element) => element.scrollWidth > element.clientWidth), false);
      if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `learning-automation-${width}.png`) });
    }
    await page.setViewportSize({ width: 960, height: 1000 });
    await page.getByText("学习轨迹与修改记录", { exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索学习证据", exact: true }).fill("reviewed.mqxliff");
    await page.getByText("装备星之剑。", { exact: true }).waitFor();
    await page.getByText("装备星刃。", { exact: true }).waitFor();
    await page.getByText("变更与依据", { exact: true }).click();
    await page.getByText(/人工反馈｜人工接受/).waitFor();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "QA 规则", exact: true }).click();
    const whitespace = page.getByRole("switch", { name: "空白格式", exact: true });
    assert.equal(await whitespace.isChecked(), true);
    await page.getByLabel("空白格式的严重度", { exact: true }).selectOption("info");
    await whitespace.uncheck();
    assert.equal(await page.getByLabel("非换行标签结构", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("非换行标签结构", { exact: true }).isChecked(), true);
    await page.getByRole("tab", { name: "质量参数", exact: true }).click();
    const field = page.getByRole("spinbutton").first(), original = await field.inputValue();
    await field.fill(String(Number(original) + 1));
    await page.getByRole("tab", { name: "QA 规则", exact: true }).click();
    assert.equal(await whitespace.isChecked(), false, "QA edits survive parameter tab changes");
    failQa = true;
    await page.getByRole("button", { name: "保存 QA 规则", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "模拟 QA 保存失败" }).waitFor();
    assert.equal(await whitespace.isChecked(), false, "failed saves retain the draft");
    failQa = false;
    await page.getByRole("button", { name: "保存 QA 规则", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已保存 QA 规则" }).waitFor();
    await page.getByRole("tab", { name: "质量参数", exact: true }).click();
    assert.equal(await field.inputValue(), String(Number(original) + 1), "saving QA does not reset parameter edits");
    await page.getByRole("button", { name: "保存参数", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "QA 规则", exact: true }).click();
    assert.equal(await whitespace.isChecked(), false, "QA switches survive a page reload");
    await whitespace.check();
    assert.equal(await page.getByLabel("空白格式的严重度", { exact: true }).inputValue(), "info");
    await page.getByRole("button", { name: "保存 QA 规则", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已保存 QA 规则" }).waitFor();
    const saved = await workbench.invoke({ path: `/api/projects/${state.project.id}` }, context);
    assert.deepEqual(saved.settings.qa.rules.whitespace, { enabled: true, severity: "info" });
    await page.getByRole("tab", { name: "常规与备份", exact: true }).click();
    await page.getByLabel("工作区输出目录", { exact: true }).fill("outputs/settings-test");
    await page.getByRole("tab", { name: "检索", exact: true }).click();
    await page.getByRole("tab", { name: "常规与备份", exact: true }).click();
    assert.equal(await page.getByLabel("工作区输出目录", { exact: true }).inputValue(), "outputs/settings-test");
    await page.getByRole("button", { name: "保存输出目录", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已保存输出目录" }).waitFor();
    assert.equal((await workbench.workspace({}, context)).config.outputDirectory, "outputs/settings-test");
    for (const width of [960, 330]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of ["常规与备份", "QA 规则", "质量参数", "参考资料", "检索", "学习与评测"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        assert.equal(await page.getByRole("tabpanel").count(), 1);
        assert.equal(await page.locator(".kami").evaluate((element) => element.scrollWidth > element.clientWidth), false, `${name} must fit ${width}px`);
        if (["质量参数", "学习与评测"].includes(name)) {
          const inset = await page.locator(".settings-fields").evaluate((element) => {
            const card = element.getBoundingClientRect(), field = element.querySelector(".setting-field").getBoundingClientRect();
            return { left: field.left - card.left, right: card.right - field.right };
          });
          assert.ok(inset.left >= 12 && inset.right >= 12, `${name} fields must have horizontal padding`);
        }
        if (process.env.KAMI_UI_SCREENSHOTS && ["常规与备份", "QA 规则", "学习与评测"].includes(name)) {
          await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `settings-${width}-${name === "QA 规则" ? "qa" : name === "学习与评测" ? "learning" : "general"}.png`) });
        }
      }
    }
    await page.getByRole("tab", { name: "QA 规则", exact: true }).press("Home");
    assert.equal(await page.getByRole("tab", { name: "常规与备份", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "常规与备份", exact: true }).press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "QA 规则", exact: true }).getAttribute("aria-selected"), "true");
    failSettings = true;
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const error = page.getByRole("alert").filter({ hasText: "模拟参数加载失败" });
    await error.waitFor();
    failSettings = false;
    await error.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByRole("tab", { name: "质量参数", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await workbench.close(); await close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-settings-browser-")));
    await rm(directory, { recursive: true, force: true });
  }
});

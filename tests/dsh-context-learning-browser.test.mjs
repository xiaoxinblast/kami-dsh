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
import { createModelAdapter } from "../dsh/model-adapter.mjs";

test("语境分析、失败句段跳转和学习来源信息都能在真实界面上看到", { skip: !process.env.KAMI_BROWSER_TEST_MODULE || !process.env.KAMI_REACT_DIRECTORY, timeout: 180000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const directory = await mkdtemp(join(tmpdir(), "kami-context-browser-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  const modelAdapter = createModelAdapter({ llm: { async prepareCall(config) {
    return { config, async *stream() { yield { type: "finish", reason: { kind: "stop" } }; } };
  } } }, { createSystemMessage: (text) => ({ role: "system", content: [{ type: "text", text }] }), BlockAssembler: class { finish = {}; push(chunk) { this.finish = chunk.reason; } blocks() { return []; } } });
  const { fs, close } = await workspaceFs(), workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter });
  const context = { cwd, fs, human: true, isKamiSession: true, modelRoute: { provider: "dsh-test", model: "selected-model" } };
  let browser, server;
  try {
    const state = await workbench.workspace({ action: "bind", name: "语境分析验收" }, context);
    await writeFile(join(cwd, "source.mqxliff"), '<?xml version="1.0" encoding="UTF-8"?><xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2"><file original="story"><body><trans-unit id="1"><source>星の剣を装備します。</source><target></target></trans-unit></body></file></xliff>');
    const prepared = await workbench.importFile({ path: "source.mqxliff" }, context);
    const base = await workbench.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${state.project.id}` }, context);
    const segments = [
      { ...base.segments[0], id: "seg-1", source: "星の剣を装備します。", translation: "装备星之剑。", status: "done", selected: true, result: { qaScore: 90, aiQa: { status: "passed", used: true, score: 90 } } },
      { ...base.segments[0], id: "seg-2", source: "ここで待っていてくれ。", translation: "在这里等我。", status: "done", selected: true, result: { qaScore: 88, aiQa: { status: "passed", used: true, score: 88 } } },
      { ...base.segments[0], id: "seg-3", source: "扉の先へ進もう。", translation: "", status: "error", selected: true, error: "换行规则未确认：参考资料没有规定该文本类型的字数上限", result: { stages: {} } }
    ];
    await saveBatchRun({ ...base, runState: "completed", segments, totalSegments: 3, completedSegments: 2, failedSegments: 1,
      contextBrief: {
        version: 3, status: "ready", model: "selected-model", generatedAt: "2026-11-25T08:00:00.000Z",
        documentType: { purpose: "dialogue", audience: "玩家", tone: "紧张、克制", summary: "序章里主角在遗迹入口与同伴分别，对白短促，需要保留道具名与占位符。" },
        sections: [
          { from: 1, to: 2, purpose: "dialogue", tone: "平静", note: "遗迹入口的寒暄，称呼必须与术语表一致。" },
          { from: 3, to: 3, purpose: "dialogue", tone: "紧张", note: "推进剧情前的最后一句，行尾不要断在助词上。" }
        ],
        notes: [{ text: "本段涉及武器名「星の剣」，统一译作「星之剑」。" }],
        crossRefs: [{ note: "第 3 段的「扉」与第 1 段的「星の剣」同属遗迹场景。", ids: ["seg-3"] }],
        coverage: { analyzed: 3, total: 3, covered: 3, percent: 100 }
      },
      workflow: { overall: { status: "completed", message: "译文已完成" } } });
    const batch = await workbench.invoke({ path: `/api/batch/run/${prepared.batchId}?projectId=${state.project.id}` }, context);
    const learningScope = { locale: "zh-CN", project: state.project.id, contentType: "general", domain: "general" };
    const trajectory = await saveLearningTrajectory({ ...learningScope, batchId: batch.batchId, segmentId: "seg-1", source: "星の剣を装備します。",
      initialTranslation: "装备星之剑。", finalTranslation: "装备星之剑。", status: "completed", humanDecision: { accepted: true, finalTranslation: "装备星之剑。" },
      assetRefs: { sourceFile: "参考资料/剧情设定.md" } });
    const champion = await saveTranslationSkill({ ...learningScope, ...createDefaultTranslationSkill({ scope: learningScope }),
      metadata: { learningAutomation: { status: "blocked", message: "门禁连续 2 轮未通过：Gold 术语准确率不足。可查看失败原因后手动继续。", gateRound: 2, gateRevisionLimit: 5,
        candidateId: "", canContinue: true, continueMode: "gate", updatedAt: "2026-11-25T08:30:00.000Z",
        assets: { goldSetVersions: ["gold#v2"], regressionSuiteVersions: ["regression#v3"], goldSampleCount: 6, regressionCaseCount: 4, syncedAt: "2026-11-25T08:29:00.000Z" },
        history: [{ at: "2026-11-25T08:20:00.000Z", status: "revising", message: "门禁未通过，正在按失败原因生成第 1 份修订稿" },
          { at: "2026-11-25T08:30:00.000Z", status: "blocked", message: "门禁连续 2 轮未通过：Gold 术语准确率不足" }] } } });
    const candidate = await saveTranslationSkill({ ...learningScope, name: "游戏对白策略 v2", version: 2, parentId: champion.id, status: "challenger",
      description: "补上占位符与称呼的核对规则", strategy: champion.strategy, evidenceIds: [trajectory.id], metadata: { trainingSources: ["星の剣を装備します。"] } });
    const styleFixture = { styleProfiles: [{ id: "style-1", name: "遗迹场景文风", version: 2, status: "draft", updatedAt: "2026-11-25T08:10:00.000Z",
      instruction: "短句优先，保留道具名。", parentId: null, evidenceFiles: [{ name: "风格/遗迹文风.docx", count: 4 }] }], evidencePools: [], learningRuns: [] };

    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      :root{--dsw-alias-label-primary:#25312b;--dsw-alias-label-secondary:#58665e;--dsw-alias-label-tertiary:#7b877f;--dsw-alias-bg-layer-1:#f6f8f5;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#eaf0e9;--dsw-alias-border-l2:#d9e0d8;--dsw-alias-interactive-bg-hover:#edf2eb;--dsw-alias-brand-primary:#174d40;--dsw-alias-button-primary-fill:#174d40;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-state-error-primary:#b33e38;--kami-tint:#eef5f0;--kami-accent:#174d40}
      html,body,#root{margin:0;height:100%;font:13px/1.5 "Microsoft YaHei",sans-serif}
    </style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script type="module">
      const {React,ReactDOM}=window, factories=new Map(), modules=new Map();
      window.__ModuleLoader__={load:({id,chunk,factory})=>factories.set(chunk?id+'/'+chunk:id,factory)};
      await import('/client.js');
      const require=name=>name==='react'?React:modules.has(name)?modules.get(name):(modules.set(name,factories.get(name)(require)),modules.get(name));
      let Component, props;
      const remote={$mount:async()=>()=>{},kamiUi:{invoke:async(_session,operation)=>(await fetch('/invoke',{method:'POST',body:JSON.stringify(operation)})).json()},session:{prompt:async()=>({ok:true,value:{}}),modelCatalog:async()=>({ok:true,value:{groups:[]}}),selectModel:async()=>({ok:true,value:{}})}};
      const ctx={remote,effect:callback=>callback(),locale:{register(){}},sidebarRightTabs:{register:()=>()=>{}},inject(_keys,callback){return callback(this)},slots:{inject:(_name,callback)=>callback(),register:(options,component)=>{if(options.name==='sidebar.right.pane.tab'){Component=component;props=options.inject();}}}};
      await require('kami-dsh').apply(ctx);
      ReactDOM.createRoot(document.querySelector('#root')).render(React.createElement(Component,{...props,sessionId:'fixture',useSessions:select=>select({byId:{fixture:{projectionValues:{agentPreset:'kami-translator'}}}}),useTabInfo:()=>({tab:{visible:true}}),t:key=>key}));
    </script></html>`;
    server = createServer(async (req, res) => {
      try {
        if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); return res.end(html); }
        if (["/react.js", "/react-dom.js", "/client.js"].includes(req.url)) {
          res.setHeader("content-type", "text/javascript");
          return res.end(await readFile(req.url === "/client.js" ? new URL("../dsh/client.js", import.meta.url) : join(process.env.KAMI_REACT_DIRECTORY, req.url === "/react.js" ? "react/umd/react.production.min.js" : "react-dom/umd/react-dom.production.min.js")));
        }
        if (req.url === "/invoke") {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const operation = JSON.parse(Buffer.concat(chunks).toString());
          if (operation.path?.startsWith("/api/style-profiles")) {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ ok: true, value: styleFixture }));
          }
          const value = await workbench.perform(operation, context);
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ ok: true, value }));
        }
        res.writeHead(404); res.end();
      } catch (error) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
      const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } }), errors = [];
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name) => { if (!process.env.KAMI_UI_SCREENSHOTS) return; await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.KAMI_UI_SCREENSHOTS, `${name}.png`), fullPage: true, animations: "disabled" }); };
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByText("1 段翻译失败", { exact: true }).waitFor();
      await shot("task-overview-failed-1280");
      const tabs = page.locator('[aria-label="当前任务分区"]');
      await tabs.getByRole("button", { name: "语境分析", exact: true }).click();
      await page.getByText("序章里主角在遗迹入口与同伴分别", { exact: false }).waitFor();
      await page.getByText("100%", { exact: true }).waitFor();
      assert.equal(await page.getByText("#1–#2", { exact: true }).count(), 1);
      assert.equal(await page.getByText("遗迹入口的寒暄，称呼必须与术语表一致。", { exact: true }).count(), 1);
      assert.equal(await page.getByText("本段涉及武器名「星の剣」，统一译作「星之剑」。", { exact: true }).count(), 1);
      await shot("context-analysis-1280");
      await page.getByRole("button", { name: "查看译段", exact: true }).first().click();
      await page.getByRole("textbox", { name: "译文 1", exact: true }).waitFor();
      assert.equal(await page.locator(".segment-editor").getByText("星の剣を装備します。", { exact: true }).count() >= 1, true);
      // 回到概览，通过失败数字一步跳到失败句段。
      await page.locator('[aria-label="当前任务分区"]').getByRole("button", { name: "任务概览", exact: true }).click();
      await page.locator(".metric-link").click();
      await page.getByRole("combobox", { name: "译段筛选", exact: true }).waitFor();
      assert.equal(await page.getByRole("combobox", { name: "译段筛选", exact: true }).inputValue(), "failed");
      await page.getByRole("textbox", { name: "译文 3", exact: true }).waitFor();
      await page.getByText("换行规则未确认：参考资料没有规定该文本类型的字数上限", { exact: true }).waitFor();
      await shot("failed-segment-jump-1280");
      await page.getByRole("button", { name: "学习", exact: true }).click();
      await page.getByText("自动学习", { exact: true }).waitFor();
      assert.equal(await page.getByText("门禁修订 2 / 5", { exact: true }).count(), 1);
      assert.equal(await page.getByText("Gold gold#v2", { exact: true }).count(), 1);
      await page.locator(".learning-steps").getByRole("button", { name: /门禁/u }).click();
      await page.getByText("Gold gold#v2", { exact: true }).waitFor();
      await page.locator(".learning-steps").getByRole("button", { name: /候选/u }).click();
      await page.getByText("游戏对白策略 v2", { exact: true }).first().waitFor();
      assert.equal(await page.getByText("剧情设定.md", { exact: true }).count() >= 1, true);
      assert.equal(await page.locator(".file-chip", { hasText: "剧情设定.md" }).first().getAttribute("title"), "参考资料/剧情设定.md");
      assert.equal(await page.getByText(/生成于 \d{1,2}\/\d{1,2}/u).count() >= 1, true);
      await shot("learning-sources-1280");
      await page.locator("summary").filter({ hasText: "风格规范" }).first().click();
      await page.getByText(/遗迹文风\.docx/u).waitFor();
      assert.equal(await page.getByText("遗迹场景文风", { exact: true }).count() >= 1, true);
      for (const width of [960, 390]) {
        await page.setViewportSize({ width, height: 1200 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `横向溢出 ${width}`);
      }
      await page.setViewportSize({ width: 390, height: 1200 });
      await shot("learning-sources-390");
      await page.locator(".main-nav").getByRole("button", { name: "任务", exact: true }).click();
      await page.locator('[aria-label="当前任务分区"]').getByRole("button", { name: "语境分析", exact: true }).click();
      await page.getByText("100%", { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 1200 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "语境页横向溢出 390");
      await shot("context-analysis-390");
      assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await workbench.close(); await close();
    assert.ok(directory.startsWith(join(tmpdir(), "kami-context-browser-")));
    await rm(directory, { recursive: true, force: true });
  }
});


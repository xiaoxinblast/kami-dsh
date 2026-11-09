import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { createWorkspaceReferenceTools } from "../dsh/reference-tools.mjs";
import { buildReferenceToolRunner } from "../src/reference-context.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { translateWithReflection } from "../src/provider.mjs";
import { workspaceStyleGuide } from "../src/workspace-resources.mjs";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "kami-native-reference-")), workspace = join(directory, "workspace"), other = join(directory, "other");
  await mkdir(workspace); await mkdir(other);
  const cwd = await realpath(workspace);
  const { fs, close } = await workspaceFs(), agent = { session: { header: { id: "native-reader" } } }, calls = [];
  let root = cwd, denied = false;
  const ctx = { fs, workingDirectory: { get: () => root }, tools: {
    schemas: () => ["read", "write", "kami_workbench", "send_message", "spawn_agent"].map((name) => ({ name, description: name, parameters: { type: "object", properties: { file_path: { type: "string" } } } })),
    async execute(exec) {
      calls.push(exec); assert.equal(exec.agent, agent); exec.signal.throwIfAborted();
      if (denied) return { isError: true, content: [{ type: "text", text: "native policy denied" }] };
      const path = resolve(root, exec.arguments.file_path);
      return { value: { path }, content: [{ type: "text", text: await readFile(path, "utf8") }] };
    }
  } };
  try { await run({ directory, cwd, other, fs, ctx, agent, calls, switchRoot: () => { root = other; }, deny: () => { denied = true; } }); }
  finally { await close(); assert.ok(directory.startsWith(join(tmpdir(), "kami-native-reference-"))); await rm(directory, { recursive: true, force: true }); }
}

test("style guides are read from current originals for translation and QA, even with reference retrieval disabled", async () => fixture(async ({ directory, cwd, fs, ctx, agent, calls }) => {
  const seen = new Set();
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    if (!["翻译", "Auto QA"].includes(options.requestLabel)) return { content: options.requestLabel?.startsWith("Auto QA") ? '{"issues":[]}' : "译文" };
    assert.match(JSON.stringify(messages), /人工指南优先|人工风格指南/);
    assert.ok(options.tools.some((tool) => tool.function.name === "list_style_guide_files"));
    if (!messages.some((message) => message.role === "tool")) return { content: "", toolCalls: [{ id: "guide-read", function: { name: "read", arguments: '{"file_path":"guide.custom"}' } }] };
    assert.match(JSON.stringify(messages), /live_style_probe/);
    assert.doesNotMatch(JSON.stringify(messages), /stale_style_probe|legacy_style_probe/);
    seen.add(options.requestLabel);
    return { content: options.requestLabel === "Auto QA" ? '{"issues":[]}' : "保存设置。" };
  } });
  const signal = new AbortController().signal;
  const context = { cwd, fs, human: true, signal, referenceTools: (options) => createWorkspaceReferenceTools(ctx, agent, options, signal) };
  try {
    const state = await workbench.workspace({ action: "bind", name: "原件风格指南" }, context);
    await writeFile(join(cwd, "guide.custom"), "stale_style_probe");
    await writeFile(join(cwd, "source.txt"), "設定を保存します。");
    await workbench.invoke({ method: "POST", path: "/api/style-guides/import", body: { projectId: state.project.id, filename: "legacy.txt", base64: Buffer.from("legacy_style_probe").toString("base64") } }, context);
    const linked = await workbench.importFile({ path: "guide.custom", purpose: "style-guide" }, context);
    assert.equal(linked.compilation, undefined); assert.equal(linked.hash, undefined); assert.ok(linked.version);
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
    assert.equal(snapshot.guide, null); assert.equal(snapshot.styleGuideMode, "agent-native"); assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /stale_style_probe/);
    assert.equal((await workbench.workspace({ action: "compilations" }, context)).groups.length, 0);
    await writeFile(join(cwd, "guide.custom"), "live_style_probe：按钮使用保存；例外和正反例均按本原件。");
    const translated = await workbench.invoke({ path: "/api/translate", method: "POST", body: { batchId: prepared.batchId, projectId: state.project.id, locale: "zh-CN", source: "設定を保存します。", qualityTier: "fast", reflect: false } }, context);
    assert.equal(translated.translation, "保存设置。");
    for (const batchId of [prepared.batchId, undefined]) {
      const qa = await workbench.invoke({ path: "/api/auto-qa", method: "POST", body: { batchId, projectId: state.project.id, locale: "zh-CN", source: "設定を保存します。", translation: "保存设置。" } }, context);
      assert.match(qa.styleProfile.instruction, /guide.custom/);
      assert.equal(qa.fallbackReason, "");
    }
    assert.deepEqual([...seen].sort(), ["Auto QA", "翻译"].sort()); assert.equal(calls.length, 3);
    withRuntimeCall({ embedded: true, workspaceSnapshot: snapshot, referenceTools: context.referenceTools }, () => {
      const runner = buildReferenceToolRunner({ projectId: state.project.id, settings: { enabled: false } });
      assert.ok(runner.tools.some((tool) => tool.function.name === "read"));
      assert.ok(runner.tools.some((tool) => tool.function.name === "list_style_guide_files"));
      assert.ok(!runner.tools.some((tool) => tool.function.name === "list_reference_files"));
    });
    await assert.rejects(readFile(join(directory, "data/runtime/workspace-resources")), /ENOENT/);
    await assert.rejects(readFile(join(directory, "data/runtime/compiled-resources")), /ENOENT/);
  } finally { await workbench.close(); }
}));

test("native guide tools preserve visual results, guide priority, and read failures without using old compiled text", async () => fixture(async ({ cwd, ctx, agent, deny }) => {
  const guides = [{ path: "guide.custom", purpose: "style-guide" }];
  await writeFile(join(cwd, "guide.custom"), "完整规则");
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: guides });
  assert.match((await tools.execute({ name: "list_style_guide_files" })).text, /翻译或审校前必须直接读取/);
  const read = await tools.execute({ name: "read", arguments: { file_path: "guide.custom" } });
  assert.doesNotThrow(() => tools.assertReady());
  assert.match(read.text, /人工规范，优先于/);
  assert.match(read.text, /完整规则/);
  const visual = { type: "image", data: "image-bytes", mimeType: "image/png" };
  const visualTools = createWorkspaceReferenceTools({ ...ctx, tools: {
    schemas: () => [{ name: "read_image", parameters: { type: "object", properties: {} } }],
    execute: async () => ({ value: { path: join(cwd, "guide.custom") }, content: [visual] })
  } }, agent, { workspace: cwd, styleGuides: guides });
  const image = await visualTools.execute({ name: "read_image", arguments: { file_path: "guide.custom" } });
  assert.deepEqual(image.nativeContent[1], visual);
  const failing = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: guides });
  deny();
  const result = await failing.execute({ name: "read", arguments: { file_path: "guide.custom" } });
  assert.equal(result.nativeIsError, true); assert.deepEqual(failing.refs(), []);
  assert.throws(() => failing.assertReady(), { code: "style_guide_unread" });
  assert.doesNotMatch(result.text, /完整规则/);
  withRuntimeCall({ workspaceSnapshot: { projectId: "p", guide: { instruction: "旧批次冻结规则" } } }, () => {
    assert.equal(workspaceStyleGuide("p").instruction, "旧批次冻结规则");
  });
}));

test("reference lookups use current session tools and original bytes without a compiled index", async () => fixture(async ({ cwd, ctx, agent, calls, switchRoot }) => {
  await writeFile(join(cwd, "setting.custom"), "原件初始内容");
  const references = [{ path: "setting.custom", hash: "a".repeat(64), purpose: "reference" }];
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, references }, new AbortController().signal);
  assert.deepEqual(tools.tools.map((tool) => tool.function.name), ["list_reference_files", "read"]);
  const listed = await tools.execute({ name: "list_reference_files" });
  assert.match(listed.text, /setting.custom/); assert.doesNotMatch(listed.text, /原件初始内容/); assert.equal(calls.length, 0);
  await writeFile(join(cwd, "setting.custom"), "读取时的当前原件");
  const read = await tools.execute({ name: "read", arguments: JSON.stringify({ file_path: "setting.custom" }) });
  assert.match(read.text, /读取时的当前原件/); assert.match(read.nativeContent[1].text, /读取时的当前原件/);
  assert.deepEqual(tools.refs(), [{ path: "setting.custom", tool: "read" }]);
  assert.match((await tools.execute({ name: "write", arguments: "{}" })).text, /不属于/); assert.equal(calls.length, 1);
  switchRoot();
  assert.match((await tools.execute({ name: "read", arguments: '{"file_path":"setting.custom"}' })).text, /工作区已切换/);
  assert.equal(calls.length, 1, "workspace switches must not read through the other session directory");
}));

test("listing a guide or loading its tools cannot stand in for reading it", async () => fixture(async ({ cwd, ctx, agent }) => {
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.docx" }] });
  await tools.execute({ name: "list_style_guide_files" });
  assert.throws(() => tools.assertReady(), { code: "style_guide_unread" });
  await withRuntimeCall({ modelAdapter: async () => ({ content: "译文\n\n**非译文说明：** 没有读取原件" }) }, async () => {
    await assert.rejects(translateWithReflection({ source: "原文" }, { reflect: false, toolRunner: tools }), { code: "style_guide_unread" });
  });
}));

test("native reference settings control actual rounds and cannot be re-enabled by a learned skill", async () => fixture(async ({ cwd, ctx, agent, calls }) => {
  await writeFile(join(cwd, "reference.md"), "原件规则");
  const workspaceSnapshot = { projectId: "p", workspace: cwd, referenceMode: "agent-native", resources: [{ purpose: "reference", path: "reference.md" }] };
  const referenceTools = (options) => createWorkspaceReferenceTools(ctx, agent, options);
  await withRuntimeCall({ workspaceSnapshot, referenceTools, modelAdapter: async (_messages, options) => options.requestLabel === "翻译"
    ? { content: "正在读取", toolCalls: [{ id: "read", function: { name: "read", arguments: '{"file_path":"reference.md"}' } }] }
    : { content: "合格译文" } }, async () => {
    assert.equal(buildReferenceToolRunner({ projectId: "p", settings: { enabled: false }, skill: { strategy: { retrieval: { referenceMaterials: { enabled: true, limit: 9 } } } } }), null);
    for (const rounds of [1, 3]) {
      calls.length = 0;
      const toolRunner = buildReferenceToolRunner({ projectId: "p", settings: { nativeMaxRounds: rounds } });
      const result = await translateWithReflection({ source: "原文" }, { reflect: false, toolRunner });
      assert.equal(result.translation, "合格译文"); assert.equal(calls.length, rounds);
    }
  });
}));

test("native read denials and cancellation cannot fall back to stored reference text", async () => fixture(async ({ cwd, ctx, agent, calls, deny }) => {
  await writeFile(join(cwd, "reference.md"), "不应绕过权限读取");
  const abort = new AbortController(), activities = [];
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, references: [{ path: "reference.md" }], onActivity: (event) => activities.push(event) }, abort.signal);
  deny();
  const result = await tools.execute({ name: "read", arguments: '{"file_path":"reference.md"}' });
  assert.match(result.text, /native policy denied/); assert.equal(tools.refs().length, 0); assert.equal(activities[0].isError, true);
  assert.doesNotMatch(result.text, /不应绕过权限读取/);
  abort.abort();
  await assert.rejects(tools.execute({ name: "read", arguments: '{}' }), /aborted/i);
  assert.equal(calls.length, 1);
  withRuntimeCall({ embedded: true, workspaceSnapshot: { projectId: "p", workspace: cwd, referenceMode: "agent-native", resources: [{ purpose: "reference", path: "reference.md" }] }, referenceTools: null }, () => {
    assert.throws(() => buildReferenceToolRunner({ projectId: "p", index: {} }), /原 DSH 会话/);
    assert.equal(buildReferenceToolRunner({ projectId: "p", index: {}, onlyChunkIds: new Set() }), null, "chunk-isolated evaluations cannot gain full-original access");
  });
}));

test("translation calls native tools on demand and receives the current original after batch creation", async () => fixture(async ({ directory, cwd, fs, ctx, agent, calls }) => {
  const seen = [];
  let exhaust = false, retried = false, reviews = 0;
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    if (options.requestLabel === "翻译（空译文重试）") {
      assert.match(JSON.stringify(messages), /reference_live_probe/);
      assert.ok(messages.some((message) => message.nativeContent));
      retried = true; return { content: "去见艾玛。" };
    }
    if (["翻译自检", "翻译修订"].includes(options.requestLabel)) {
      assert.match(JSON.stringify(messages), /reference_live_probe/); assert.ok(messages.some((message) => message.nativeContent));
      reviews++; return { content: options.requestLabel === "翻译自检" ? "保持已查证名称并微调措辞。" : "去见艾玛。" };
    }
    if (options.requestLabel !== "翻译") return { content: options.requestLabel === "工作术语学习" ? '{"terms":[]}' : "去见艾玛。" };
    seen.push(JSON.stringify(messages));
    if (exhaust) return { content: "", toolCalls: [{ id: `read-${seen.length}`, function: { name: "read", arguments: '{"file_path":"setting.custom"}' } }] };
    const results = messages.filter((message) => message.role === "tool");
    if (!results.length) return { content: "", toolCalls: [{ id: "list", function: { name: "list_reference_files", arguments: "{}" } }] };
    if (!results.some((message) => message.tool_call_id === "read")) return { content: "", toolCalls: [{ id: "read", function: { name: "read", arguments: '{"file_path":"setting.custom"}' } }] };
    assert.match(results.at(-1).content, /reference_live_probe/);
    assert.ok(results.at(-1).nativeContent, "native result blocks must survive the translation loop");
    return { content: "去见艾玛。" };
  } });
  const signal = new AbortController().signal;
  const context = { cwd, fs, human: true, signal, referenceTools: (options) => createWorkspaceReferenceTools(ctx, agent, options, signal) };
  try {
    const state = await workbench.workspace({ action: "bind", name: "按需原件查阅" }, context);
    await writeFile(join(cwd, "setting.custom"), "エマ：旧名");
    await workbench.importFile({ path: "setting.custom", purpose: "reference" }, context);
    await writeFile(join(cwd, "source.txt"), "エマに会う。");
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    assert.equal(calls.length, 0, "linking and preparing must not invoke any native reader");
    const snapshot = (await workbench.store.request(`/items/batch_runs/${prepared.batchId}`)).runner_options.workspaceSnapshot;
    assert.equal(snapshot.referenceChunks.length, 0); assert.equal(snapshot.referenceMode, "agent-native");
    await writeFile(join(cwd, "setting.custom"), "エマ：艾玛。reference_live_probe");
    const translated = await workbench.invoke({ path: "/api/translate", method: "POST", body: { batchId: prepared.batchId, projectId: state.project.id, locale: "zh-CN", source: "エマに会う。", qualityTier: "fast", reflect: false } }, context);
    assert.equal(translated.translation, "去见艾玛。");
    assert.equal(calls.length, 1); assert.equal(calls[0].name, "read");
    assert.ok(seen.some((message) => message.includes("reference_live_probe"))); assert.ok(!seen.some((message) => message.includes("旧名")));
    exhaust = true;
    await workbench.invoke({ path: "/api/translate", method: "POST", body: { batchId: prepared.batchId, projectId: state.project.id, locale: "zh-CN", source: "エマに会う。", qualityTier: "fast", reflect: false } }, context);
    assert.equal(retried, true, "finishing after the native read budget is exhausted must retain the evidence");
    exhaust = false;
    await withRuntimeCall({ workspaceSnapshot: snapshot }, () => translateWithReflection({ source: "エマに会う。", targetLocale: "zh-CN", targetLanguage: "简体中文", sourceLanguage: "日语" }, { reflect: true, toolRunner: createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, references: snapshot.resources }, signal) }));
    assert.equal(reviews, 2, "reflection and revision must retain the facts the agent actually read");
  } finally { await workbench.close(); }
}));

test("real DSH filesystem reads execute through the session registry and respect native guards", { skip: !process.env.DSH_TEST_LLM_MODULE }, async () => fixture(async ({ cwd, fs, agent }) => {
  const sdk = process.env.DSH_TEST_LLM_MODULE;
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, fileTools, { NativeToolExecutor }] = await Promise.all([
    import(new URL("../../cordis/lib/index.js", sdk)), import(new URL("../../dsh-system-prompt/lib/index.js", sdk)),
    import(new URL("../../dsh-tools/lib/index.js", sdk)), import(new URL("../../dsh-tool-fs/lib/index.js", sdk)), import(new URL("../../dsh-tool-executor-native/lib/index.js", sdk))
  ]);
  const root = new Context();
  root.reflect.provide("fs", fs);
  root.reflect.provide("workingDirectory", { get: () => cwd, ensure: async () => cwd });
  root.plugin(SystemPrompt, {}); root.plugin(ToolRuntime, {}); root.plugin(fileTools, { write: false, edit: false, readImage: false });
  await writeFile(join(cwd, "native.md"), "真实 DSH 原生读取探针");
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  root.plugin({ inject: ["tools"], async apply(ctx) {
    try {
      ctx.tools.setExecutor(new NativeToolExecutor(ctx));
      agent.model = { current: () => ({ provider: "test", model: "test" }) };
      const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, references: [{ path: "native.md" }] }, new AbortController().signal);
      assert.ok(tools.tools.some((tool) => tool.function.name === "read"));
      const read = await tools.execute({ name: "read", arguments: '{"file_path":"native.md"}' });
      assert.match(read.text, /真实 DSH 原生读取探针/);
      ctx.tools.guard((exec) => exec.name === "read" ? "native read blocked" : undefined);
      const blocked = await tools.execute({ name: "read", arguments: '{"file_path":"native.md"}' });
      assert.match(blocked.text, /native read blocked/); assert.doesNotMatch(blocked.text, /真实 DSH 原生读取探针/);
      resolveReady();
    } catch (error) { rejectReady(error); }
  } });
  try { await ready; } finally { await root.fiber.dispose(); }
}));

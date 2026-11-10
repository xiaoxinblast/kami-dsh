import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { createWorkspaceReferenceTools } from "../dsh/reference-tools.mjs";
import { buildReferenceToolRunner } from "../src/reference-context.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { checkBatchConsistencyWithModel, evaluateAutoQaWithModel, evaluateTranslationWithModel, reviseTranslationWithQa, translateWithReflection } from "../src/provider.mjs";
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

test("Office guide read failures suggest native document tools and failed shell reads cannot satisfy the guide", async (t) => fixture(async ({ cwd, ctx, agent }) => {
  let result = { isError: true, content: [{ type: "text", text: "cannot read: binary file" }] };
  ctx.tools.schemas = () => ["read", "bash", "pwsh"].map((name) => ({ name, parameters: {} }));
  ctx.tools.execute = async () => result;
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.docx" }] });
  t.after(() => tools.dispose());
  assert.match((await tools.execute({ name: "read", arguments: { file_path: "guide.docx" } })).text, /bash\/pwsh/);
  for (const value of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }, { exitCode: 0, stdout: { text: "partial", truncated: true } }]) {
    result = { value, content: [{ type: "text", text: "partial or failed read" }] };
    assert.equal((await tools.execute({ name: "bash", arguments: { command: "python read_original.py guide.docx" } })).nativeIsError, true);
    assert.throws(() => tools.assertReady(), { code: "style_guide_unread" });
  }
  result = { value: { exitCode: 0, stdout: { text: "完整规则", truncated: false } }, content: [{ type: "text", text: "完整规则" }] };
  await tools.execute({ name: "pwsh", arguments: { command: "python read_original.py guide.docx" } });
  assert.doesNotThrow(() => tools.assertReady());
}));

test("Windows Bash reference reads accept shell drive paths and dispatch a native temporary workdir", { skip: process.platform !== "win32" }, async (t) => fixture(async ({ cwd, ctx, agent }) => {
  const calls = [];
  ctx.tools.schemas = () => [{ name: "bash", parameters: {} }];
  ctx.tools.execute = async ({ arguments: args }) => {
    calls.push(args);
    return { value: { exitCode: 0, stdout: { text: "完整规则" } }, content: [{ type: "text", text: "完整规则" }] };
  };
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd });
  t.after(() => tools.dispose());
  const shellPath = cwd.replace(/\\/g, "/").replace(/^([a-z]):/i, "/$1");
  for (const workdir of [shellPath, `/mnt${shellPath}`, cwd, undefined]) await tools.execute({ name: "bash", arguments: { command: "pwd", ...(workdir ? { workdir } : {}) } });
  const scratch = calls[0].workdir;
  assert.notEqual(scratch, cwd);
  assert.match(scratch, /kami-reference-/);
  assert.deepEqual(calls.map((args) => args.workdir), [scratch, scratch, scratch, scratch]);
  ctx.tools.execute = async () => ({ isError: true, content: [{ type: "text", text: "spawn bash ENOENT" }] });
  assert.ok((await tools.execute({ name: "bash", arguments: { command: "pwd", workdir: shellPath } })).text.includes(scratch));
}));

test("native searches stay in the workspace while shell calls use a separate temporary directory", async (t) => fixture(async ({ cwd, directory, ctx, agent }) => {
  const calls = [], child = join(cwd, "资料");
  await mkdir(child);
  ctx.tools.schemas = () => ["glob", "grep", "bash", "pwsh"].map((name) => ({ name, description: name, parameters: {} }));
  ctx.tools.execute = async (call) => {
    calls.push(call);
    return { value: { exitCode: 0, stdout: { text: "查阅结果" } }, content: [{ type: "text", text: "查阅结果" }] };
  };
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd });
  t.after(() => tools.dispose());
  let scratch;
  for (const name of ["glob", "grep", "bash", "pwsh"]) {
    const key = ["glob", "grep"].includes(name) ? "path" : "workdir";
    const args = { command: `"${join(directory, "runtime", "python.exe")}" -c "print(1)"`, pattern: "*.docx" };
    await tools.execute({ name, arguments: args });
    if (key === "workdir") {
      scratch ||= calls.at(-1).arguments[key];
      assert.notEqual(scratch, cwd);
      assert.match(scratch, /kami-reference-/);
    }
    assert.equal(calls.at(-1).arguments[key], key === "path" ? cwd : scratch);
    assert.equal(Object.hasOwn(args, key), false, "normalization must not mutate the model call");
    await tools.execute({ name, arguments: { ...args, [key]: "资料" } });
    assert.equal(calls.at(-1).arguments[key], key === "path" ? child : scratch);
    assert.equal(calls.at(-1).arguments.command, args.command, "external runtime executables remain usable from the temporary directory");
  }
}));

test("native searches and shell workdirs reject outside paths and directory links before dispatch", async () => fixture(async ({ cwd, other, ctx, agent }) => {
  const calls = [];
  await symlink(other, join(cwd, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  ctx.tools.schemas = () => ["glob", "grep", "bash", "pwsh"].map((name) => ({ name, parameters: {} }));
  ctx.tools.execute = async (call) => { calls.push(call); return { content: [{ type: "text", text: "must not execute" }] }; };
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.docx" }] });
  for (const name of ["glob", "grep", "bash", "pwsh"]) for (const path of [other, "../other", "outside-link", "~"]) {
    const key = ["glob", "grep"].includes(name) ? "path" : "workdir";
    const result = await tools.execute({ name, arguments: { [key]: path, command: "pwd", pattern: "*.docx" } });
    assert.equal(result.nativeIsError, true);
    assert.ok(result.text.includes(cwd), "the correction must identify the actual workspace");
    assert.match(result.text, /工作区/);
  }
  assert.equal(calls.length, 0);
  assert.throws(() => tools.assertReady(), { code: "style_guide_unread" });
}));

test("native file reads anchor relative paths but retain explicit document-tool paths", async () => fixture(async ({ cwd, other, ctx, agent }) => {
  const calls = [];
  ctx.tools.schemas = () => ["read", "read_image"].map((name) => ({ name, parameters: {} }));
  ctx.tools.execute = async (call) => { calls.push(call); return { content: [{ type: "text", text: "document tool instructions" }] }; };
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd });
  for (const name of ["read", "read_image"]) {
    await tools.execute({ name, arguments: { file_path: "资料/guide.docx" } });
    assert.equal(calls.at(-1).arguments.file_path, resolve(cwd, "资料/guide.docx"));
    const skillPath = join(other, "document-tool", "SKILL.md");
    await tools.execute({ name, arguments: { file_path: skillPath } });
    assert.equal(calls.at(-1).arguments.file_path, skillPath);
  }
}));

test("the first native model call already has its workspace and absolute guide paths", async () => fixture(async ({ cwd, ctx, agent }) => {
  const resources = [{ purpose: "style-guide", path: "资料/风格指南.docx", version: "v1" }];
  withRuntimeCall({ workspaceSnapshot: { projectId: "p", workspace: cwd, styleGuideMode: "agent-native", resources } }, () => {
    const guide = workspaceStyleGuide("p");
    assert.ok(guide.instruction.includes(cwd));
    assert.ok(guide.instruction.includes(JSON.stringify(resolve(cwd, resources[0].path))));
  });
  ctx.tools.schemas = () => ["glob", "grep", "bash", "pwsh"].map((name) => ({ name, description: name, parameters: {} }));
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: resources });
  for (const name of ["glob", "grep", "bash", "pwsh"]) {
    const tool = tools.tools.find((item) => item.function.name === name);
    assert.ok(tool.function.description.includes(cwd));
  }
  assert.match(tools.tools.find((item) => item.function.name === "bash").function.description, /Bash.*PowerShell/);
}));

test("original lists use the optional skill service without an undeclared Cordis property access", async () => fixture(async ({ cwd, ctx, agent }) => {
  ctx.tools.schemas = () => [{ name: "skill", parameters: {} }];
  Object.defineProperty(ctx, "skills", { get() { throw new Error('cannot get property "skills" without inject'); } });
  let listed = 0;
  ctx.get = (name) => name === "skills" ? { list: async ({ cwd: root, scope }) => {
    assert.equal(root, cwd); assert.equal(scope, agent); listed++;
    return [{ name: "document-reader", description: "原件读取工具" }];
  } } : undefined;
  const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.docx" }] });
  const result = await tools.execute({ name: "list_style_guide_files" });
  assert.match(result.text, /absolutePath/);
  assert.match(result.text, /document-reader/);
  assert.equal(result.nativeIsError, undefined);
  assert.equal(listed, 1);
  ctx.get = () => undefined;
  const withoutSkills = await tools.execute({ name: "list_style_guide_files" });
  assert.match(withoutSkills.text, /absolutePath/);
  assert.equal(withoutSkills.nativeIsError, undefined);
}));

test("real Cordis can list guide paths and available skills without a skills injection", { skip: !process.env.DSH_TEST_LLM_MODULE }, async () => fixture(async ({ cwd, fs, agent }) => {
  const { Context } = await import(new URL("../../cordis/lib/index.js", process.env.DSH_TEST_LLM_MODULE));
  const root = new Context();
  root.reflect.provide("fs", fs);
  root.reflect.provide("workingDirectory", { get: () => cwd });
  root.reflect.provide("tools", { schemas: () => [{ name: "skill", parameters: {} }] });
  root.plugin({ apply(ctx) { ctx.reflect.provide("skills", { list: async () => [{ name: "document-reader", description: "原件读取工具" }] }); } });
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  root.plugin({ inject: ["fs", "workingDirectory", "tools"], async apply(ctx) {
    try {
      assert.throws(() => ctx.skills, /without inject/);
      const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.docx" }] });
      const result = await tools.execute({ name: "list_style_guide_files" });
      assert.equal(result.nativeIsError, undefined);
      assert.match(result.text, /absolutePath/); assert.match(result.text, /document-reader/);
      resolveReady();
    } catch (error) { rejectReady(error); }
  } });
  try { await ready; } finally { await root.fiber.dispose(); }
}));

test("style guides are read from current originals for translation and QA, even with reference retrieval disabled", async () => fixture(async ({ directory, cwd, fs, ctx, agent, calls }) => {
  const seen = new Set();
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    if (!["翻译", "Auto QA"].includes(options.requestLabel)) return { content: options.requestLabel?.startsWith("Auto QA") ? '{"issues":[]}' : "译文" };
    assert.match(JSON.stringify(messages), /人工指南优先|人工风格指南/);
    const guidePrompt = options.requestLabel === "Auto QA" ? JSON.parse(messages.find((message) => message.role === "user").content).styleProfile.instruction : messages.map((message) => String(message.content)).join("\n");
    assert.ok(guidePrompt.includes(cwd), "workspace must be present before listing tools are called");
    assert.ok(guidePrompt.includes(JSON.stringify(join(cwd, "guide.custom"))), "the model must receive the absolute original path");
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

test("segment QA shares actual original reads with revision without rechecking, while new QA reads current guides", async () => fixture(async ({ directory, cwd, fs, ctx, agent, calls, deny }) => {
  let guideText = "qa_guide_v1", mode = "repair";
  const labels = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    labels.push(options.requestLabel);
    if (!["翻译", "AIQA", "AIQA 修订"].includes(options.requestLabel)) return { content: '{"issues":[]}' };
    assert.ok(options.tools.some(tool => tool.function.name === "list_style_guide_files"));
    assert.ok(options.tools.some(tool => tool.function.name === "list_reference_files"));
    const evidence = messages.filter(message => message.role === "tool");
    if (!evidence.length) return { toolCalls: [{ id: "qa-guide", function: { name: "read", arguments: '{"file_path":"guide.custom"}' } }] };
    if (mode === "denied") return { content: '{"issues":[]}' };
    assert.ok(JSON.stringify(evidence).includes(guideText), "each new QA must see the current guide");
    assert.ok(evidence.some(message => message.nativeContent), "native evidence blocks survive reuse");
    if (options.requestLabel === "翻译") return { content: "存储设定。" };
    if (options.requestLabel === "AIQA 修订") {
      if (!JSON.stringify(evidence).includes("qa_reference_probe")) return { toolCalls: [{ id: "qa-reference", function: { name: "read", arguments: '{"file_path":"reference.custom"}' } }] };
      return { content: "保存设置。" };
    }
    const revised = messages.at(-1).content.includes("待审译文：\n保存设置。");
    if (mode === "repair" && revised) assert.match(JSON.stringify(evidence), /qa_reference_probe/);
    return { content: JSON.stringify({ issues: mode === "repair" && !revised ? [{ severity: "major", category: "fluency_naturalness", sourceSpan: "保存", targetSpan: "存储", message: "按指南采用自然按钮用语", suggestion: "使用保存设置", confidence: 1 }] : [] }) };
  } });
  const signal = new AbortController().signal;
  const context = { cwd, fs, human: true, signal, referenceTools: options => createWorkspaceReferenceTools(ctx, agent, options, signal) };
  try {
    const state = await workbench.workspace({ action: "bind", name: "逐段 QA 原件" }, context);
    await writeFile(join(cwd, "guide.custom"), guideText);
    await writeFile(join(cwd, "reference.custom"), "qa_reference_probe：保存设置。");
    await writeFile(join(cwd, "source.txt"), "設定を保存します。");
    await workbench.importFile({ path: "guide.custom", purpose: "style-guide" }, context);
    await workbench.importFile({ path: "reference.custom", purpose: "reference" }, context);
    const prepared = await workbench.importFile({ path: "source.txt" }, context);
    const body = { projectId: state.project.id, batchId: prepared.batchId, locale: "zh-CN", source: "設定を保存します。", segmentPurpose: "ui", qualityTier: "standard", useModelClassification: false };
    const result = await workbench.invoke({ path: "/api/translate", method: "POST", body }, context);
    assert.equal(result.translation, "保存设置。");
    assert.equal(result.aiQa.status, "revised");
    assert.equal(result.qaScore, null);
    assert.equal(result.aiQa.iterations, 1);
    assert.equal(calls.filter(call => call.arguments.file_path.endsWith("guide.custom")).length, 2, "初译与本段 QA 各读一次；修订复用本轮证据");
    assert.equal(calls.filter(call => call.arguments.file_path.endsWith("reference.custom")).length, 1, "修订仍能按需查阅新资料");
    assert.equal(labels.filter(label => label === "AIQA").length, 2, "QA 读指南、出结论，不做修订后复检");
    assert.equal(labels.filter(label => label === "AIQA 修订").length, 2, "修订查资料、输出修订稿");
    mode = "pass";
    for (const batchId of [prepared.batchId, undefined]) {
      guideText += "_updated";
      await writeFile(join(cwd, "guide.custom"), guideText);
      const qa = await workbench.invoke({ path: "/api/qa", method: "POST", body: { ...body, batchId, translation: "保存设置。", aiQa: true } }, context);
      assert.equal(qa.aiQa.status, "passed");
      assert.equal(qa.translation, "保存设置。");
      assert.equal(qa.aiQa.iterations, 0);
    }
    assert.equal(calls.filter(call => call.arguments.file_path.endsWith("guide.custom")).length, 4, "重试和独立 QA 均重新读取原件");
    const resolved = await workbench.invoke({ path: "/api/qa/resolve", method: "POST", body: { ...body, batchId: undefined, translation: "存储设定。", action: "revise", issueIndex: 0,
      issues: [{ severity: "error", category: "fluency_naturalness", message: "按指南修订", suggestion: "保存设置。" }] } }, context);
    assert.equal(resolved.translation, "保存设置。");
    assert.equal(resolved.aiQa.status, "passed");
    assert.equal(calls.filter(call => call.arguments.file_path.endsWith("guide.custom")).length, 5, "人工触发修订与后续 QA 共享本轮指南");
    mode = "denied"; deny();
    const failed = await workbench.invoke({ path: "/api/qa", method: "POST", body: { ...body, translation: "保存设置。", aiQa: true } }, context);
    assert.equal(failed.aiQa.status, "review");
    assert.equal(failed.aiQa.used, false);
    assert.match(failed.aiQa.fallbackReason, /尚未成功查阅/);
    assert.equal(failed.translation, "保存设置。");
  } finally { await workbench.close(); }
}));

test("segment QA format recovery and standalone revision retain original evidence and reject unread guides", async () => fixture(async ({ cwd, ctx, agent, calls }) => {
  await writeFile(join(cwd, "guide.custom"), "qa_format_guide_probe");
  for (const mode of ["qa", "line", "exhausted", "revision", "unread"]) {
    const toolRunner = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.custom" }], maxRounds: mode === "exhausted" ? 1 : 2 });
    await withRuntimeCall({ modelAdapter: async (messages, options) => {
      if (mode === "unread") return { content: "保存设置。" };
      if (!messages.some(message => message.role === "tool")) return { toolCalls: [{ id: "read-format-guide", function: { name: "read", arguments: '{"file_path":"guide.custom"}' } }] };
      assert.match(JSON.stringify(messages), /qa_format_guide_probe/);
      if (mode === "revision") return { content: "保存设置。" };
      if (mode === "exhausted") return { content: '{"issues":[]}' };
      if (mode === "line") return { content: options.requestLabel === "AIQA 行式降级" ? "PASS" : "invalid response" };
      return { content: options.requestLabel === "AIQA" ? "invalid response" : '{"issues":[]}' };
    } }, async () => {
      const args = { contextPack: { source: "設定を保存します。" }, translation: "保存设置。", issues: [], toolRunner };
      if (["qa", "line", "exhausted"].includes(mode)) assert.deepEqual(await evaluateTranslationWithModel(args), []);
      else if (mode === "revision") assert.equal(await reviseTranslationWithQa(args), "保存设置。");
      else await assert.rejects(reviseTranslationWithQa(args), { code: "style_guide_unread" });
    });
  }
  assert.equal(calls.length, 4, "格式修复和轮次收尾不重复读取指南，也不丢失证据");
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

for (const mode of ["translation", "qa", "consistency"]) {
test(`premature ${mode} answers must read the guide before they can complete`, async () => fixture(async ({ cwd, ctx, agent, calls }) => {
  await writeFile(join(cwd, "guide.custom"), "必须使用保存设置；保留句末标点。");
  const toolRunner = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.custom" }], maxRounds: 3 });
  let attempts = 0;
  await withRuntimeCall({ modelAdapter: async (messages) => {
    attempts++;
    if (attempts === 1) return { content: "未查阅时的草稿" };
    assert.doesNotMatch(JSON.stringify(messages), /未查阅时的草稿/);
    if (attempts === 2) {
      assert.match(messages.at(-1).content, /前置检查未通过/);
      return { toolCalls: [{ id: "read-guide", function: { name: "read", arguments: '{"file_path":"guide.custom"}' } }] };
    }
    assert.match(JSON.stringify(messages), /必须使用保存设置/);
    return { content: mode === "translation" ? "保存设置。" : mode === "qa" ? '{"issues":[]}' : '{"findings":[]}' };
  } }, async () => {
    if (mode === "translation") assert.equal((await translateWithReflection({ source: "設定を保存します。" }, { reflect: false, toolRunner })).translation, "保存设置。");
    else if (mode === "qa") assert.deepEqual(await evaluateAutoQaWithModel({ source: "設定を保存します。", translation: "保存设置。", locale: "zh-CN", toolRunner }), []);
    else assert.deepEqual(await checkBatchConsistencyWithModel({ pairs: [{ id: "s1", source: "設定を保存します。", translation: "保存设置。" }], toolRunner }), { findings: [], dropped: [] });
  });
  assert.equal(attempts, 3); assert.equal(calls.length, 1);
  assert.doesNotThrow(() => toolRunner.assertReady());
}));
}

test("guide correction stays within the configured round budget and cannot bypass a failed read", async () => fixture(async ({ cwd, ctx, agent, deny, calls }) => {
  deny();
  const toolRunner = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.custom" }], maxRounds: 3 });
  let attempts = 0;
  await withRuntimeCall({ modelAdapter: async () => {
    attempts++;
    return attempts === 1 ? { toolCalls: [{ id: "denied", function: { name: "read", arguments: '{"file_path":"guide.custom"}' } }] } : { content: "未经指南核对的结果" };
  } }, async () => {
    await assert.rejects(translateWithReflection({ source: "原文" }, { reflect: false, toolRunner }), { code: "style_guide_unread" });
  });
  assert.equal(attempts, 3); assert.equal(calls.length, 1); assert.deepEqual(toolRunner.refs(), []);
}));

test("original file lists provide the actual workspace and absolute Unicode paths", async () => fixture(async ({ cwd, ctx, agent, calls }) => {
  const path = "资料/风格指南.docx";
  for (const [key, name] of [["styleGuides", "list_style_guide_files"], ["references", "list_reference_files"]]) {
    const tools = createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, [key]: [{ path, version: "v1" }] });
    const listed = await tools.execute({ name });
    assert.ok(listed.text.includes(cwd));
    const file = listed.text.split("\n").find((line) => line.startsWith("{"));
    assert.deepEqual(JSON.parse(file), { path, absolutePath: resolve(cwd, path), version: "v1" });
    assert.equal(calls.length, 0, "listing paths must not read or cache the original");
    assert.deepEqual(tools.refs(), []);
  }
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

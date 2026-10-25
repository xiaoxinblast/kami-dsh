import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { evaluateAutoQaWithModel, evaluateGrammarWithModel } from "../src/provider.mjs";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

const input = { source: "星の剣を装備します。", translation: "装备星刃。", locale: "zh-CN" };
const pass = { content: '{"issues":[]}' };

test("empty responses never count as completed Auto QA or grammar QA", async () => {
  for (const evaluate of [evaluateAutoQaWithModel, evaluateGrammarWithModel]) {
    await withRuntimeCall({ modelAdapter: async () => ({ content: " " }) }, async () => {
      await assert.rejects(evaluate(input), /空|解析/);
    });
  }
});

test("an explicit no-issues response after a retry remains valid", async () => {
  for (const evaluate of [evaluateAutoQaWithModel, evaluateGrammarWithModel]) {
    let calls = 0;
    await withRuntimeCall({ modelAdapter: async () => ++calls === 1 ? { content: "" } : pass }, async () => {
      assert.deepEqual(await evaluate(input), []);
      assert.equal(calls, 2);
    });
  }
});

for (const repair of ["none", "text", "json", "line", "exhausted"]) {
  test(`Auto QA retains native reference evidence and terminology through ${repair}`, async () => {
    const seen = [], executed = [];
    const matches = [{ mode: "exact", term: { source: "星の剣", target: "星刃", note: "TERM_AUTHORITY", status: "reference", origin: "workspace" } }];
    await withRuntimeCall({ modelAdapter: async (messages, options) => {
      seen.push({ messages: structuredClone(messages), options });
      const count = messages.filter((message) => message.role === "tool").length;
      if (options.tools?.length && (count < 2 || repair === "exhausted")) return { content: '{"issues":[]}', toolCalls: [{ id: `call-${count}`, function: { name: count ? "read" : "list_reference_files", arguments: "{}" } }] };
      if (repair === "line" && options.responseFormat) return { content: "" };
      if (repair === "json" && options.tools?.length) return { content: "" };
      return options.responseFormat ? pass : { content: "PASS" };
    } }, async () => {
      const result = await evaluateAutoQaWithModel({ ...input, matches, toolRunner: {
        maxRounds: repair === "exhausted" ? 1 : 4,
        tools: ["list_reference_files", "read"].map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } })),
        async execute(call) {
          executed.push(call.name);
          return call.name === "read" ? { text: "REFERENCE_FACT", ...(repair === "text" ? {} : { nativeContent: [{ type: "text", text: "REFERENCE_FACT" }] }), refs: [] } : { text: "reference.md", refs: [] };
        }
      } });
      assert.deepEqual(result, []);
    });
    assert.deepEqual(executed.slice(0, 2), ["list_reference_files", "read"]);
    const final = seen.at(-1);
    assert.ok(JSON.stringify(final.messages).includes("TERM_AUTHORITY"), "matched terminology survives retries");
    assert.ok(final.messages.some((message) => message.role === "tool" && message.content === "REFERENCE_FACT"), "final reviewer receives the original read result");
    if (repair !== "text") assert.ok(final.messages.some((message) => message.nativeContent?.[0]?.text === "REFERENCE_FACT"), "native content remains available to the DSH adapter");
    if (!["none", "text"].includes(repair)) assert.equal(final.options.tools, undefined, "repair must finish without another tool loop");
  });
}

test("QA API passes workspace term evidence and persists incomplete scores for text and file checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-qa-context-")), cwd = join(directory, "workspace");
  await mkdir(cwd);
  let mode = "pass";
  const seen = [];
  const workbench = await createWorkbench({ dataDirectory: join(directory, "data"), modelAdapter: async (messages, options) => {
    seen.push({ messages: structuredClone(messages), options });
    return mode === "empty" || (mode === "grammar-fails" && options.requestLabel.includes("语法")) ? { content: "" } : pass;
  } });
  const { fs, close } = await workspaceFs(), context = { cwd, fs, human: true };
  try {
    const state = await workbench.workspace({ action: "bind", name: "QA evidence" }, context), projectId = state.project.id;
    await writeFile(join(cwd, "terms.md"), "星の剣 → 星刃。TERM_AUTHORITY");
    const linked = await workbench.importFile({ path: "terms.md", purpose: "terms" }, context);
    await workbench.importFile({ path: "terms.md", purpose: "terms", resourceContext: [{ path: linked.path, hash: linked.hash, pairs: [{ source: "星の剣", target: "星刃", note: "TERM_AUTHORITY" }] }] }, context);
    const check = () => workbench.invoke({ path: "/api/auto-qa", method: "POST", body: { ...input, projectId } }, context);
    assert.equal((await check()).scores.overall, 100);
    assert.ok(seen.some(({ messages, options }) => options.requestLabel === "Auto QA" && JSON.stringify(messages).includes("TERM_AUTHORITY")));
    for (mode of ["empty", "grammar-fails"]) {
      const result = await check();
      assert.equal(result.scores.overall, null);
      assert.ok(Object.values(result.scores.dimensions).every((score) => score === null));
      assert.match(result.fallbackReason, /失败/);
      assert.equal(result.segments[0].scores.overall, null);
      const saved = await workbench.invoke({ path: `/api/qa-tasks/${result.taskId}` }, context);
      assert.equal(saved.task.overallScore, null);
      const tasks = await workbench.invoke({ path: `/api/tasks?projectId=${projectId}` }, context);
      assert.equal(tasks.find((task) => task.id === result.taskId).status, "needs_attention");
    }
    mode = "empty";
    const file = await workbench.invoke({ path: "/api/qa/file", method: "POST", body: { projectId, locale: "zh-CN", filename: "test.mqxliff", deepCheck: true, base64: Buffer.from('<xliff version="1.2"><file><body><trans-unit id="1"><source>星の剣</source><target>星刃</target></trans-unit></body></file></xliff>').toString("base64") } }, context);
    assert.equal(file.scores.overall, null);
    assert.equal(file.segments[0].qaScore, null);
    assert.match(file.fallbackReason, /失败/);
  } finally { await workbench.close(); await close(); await rm(directory, { recursive: true, force: true }); }
});

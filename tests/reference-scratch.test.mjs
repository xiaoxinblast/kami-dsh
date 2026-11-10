import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorkspaceReferenceTools } from "../dsh/reference-tools.mjs";
import { chatWithTools, checkBatchConsistencyWithModel, evaluateAutoQaWithModel, translateMicroBatchWithModel, translateWithReflection } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";

const runFile = promisify(execFile);
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "kami-scratch-test-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const cwd = await realpath(workspace), calls = [];
  const { fs, close } = await workspaceFs();
  const controller = new AbortController(), agent = { session: {} };
  const ctx = { fs, workingDirectory: { get: () => cwd }, tools: {
    schemas: () => ["bash", "pwsh", "read"].map(name => ({ name, parameters: {} })),
    async execute({ name, arguments: args }) {
      calls.push({ name, args });
      if (name === "read") return { content: [{ type: "text", text: await readFile(args.file_path, "utf8") }] };
      // A real child process verifies relative writes follow the dispatched workdir.
      const { stdout } = await runFile(process.execPath, ["-e", args.command], { cwd: args.workdir });
      return { value: { exitCode: 0, stdout: { text: stdout } }, content: [{ type: "text", text: stdout }] };
    }
  } };
  await writeFile(join(cwd, "guide.txt"), "original rules");
  await writeFile(join(cwd, "read_guide.py"), "user-owned original");
  const command = `const fs = require('node:fs'); fs.writeFileSync('read_guide.py', 'temporary helper'); fs.writeFileSync('dump.txt', fs.readFileSync(${JSON.stringify(join(cwd, "guide.txt"))})); console.log('original rules');`;
  const create = () => createWorkspaceReferenceTools(ctx, agent, { workspace: cwd, styleGuides: [{ path: "guide.txt" }], maxRounds: 2 }, controller.signal);
  try { await run({ cwd, calls, ctx, controller, command, create }); }
  finally { await close(); assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
}

test("reference scripts use one owned temporary directory across tool calls, not the requested workspace", async () => fixture(async ({ cwd, calls, command, create }) => {
  const runner = create();
  try {
    await runner.execute({ name: "pwsh", arguments: { command, workdir: cwd } });
    const scratch = calls[0].args.workdir;
    assert.notEqual(scratch, cwd);
    assert.match(scratch, /kami-reference-/);
    assert.equal(dirname(scratch), join(cwd, ".kami", "tmp"), "scratch files must stay inside the workspace sandbox");
    assert.equal(await readFile(join(cwd, "read_guide.py"), "utf8"), "user-owned original");
    const read = await runner.execute({ name: "read", arguments: { file_path: join(scratch, "dump.txt") } });
    assert.match(read.text, /original rules/);
    await runner.execute({ name: "bash", arguments: { command: "console.log(require('node:fs').readFileSync('dump.txt', 'utf8'))", workdir: scratch } });
    assert.equal(calls.at(-1).args.workdir, scratch);
    assert.doesNotThrow(() => runner.assertReady());
    await runner.dispose();
    await assert.rejects(access(scratch), { code: "ENOENT" });
    await runner.execute({ name: "pwsh", arguments: { command } });
    assert.notEqual(calls.at(-1).args.workdir, scratch, "a reused runner must allocate a new owned directory");
  } finally { await runner.dispose?.(); }
}));

for (const outcome of ["success", "failure", "cancelled", "exhausted"]) {
  test(`reference temporary files are cleaned after ${outcome}`, async () => fixture(async ({ calls, controller, command, create }) => {
    const runner = create();
    const call = { id: "read-guide", function: { name: "pwsh", arguments: JSON.stringify({ command }) } };
    const task = withRuntimeCall({ modelAdapter: async messages => {
      if (!messages.some(m => m.role === "tool")) return { toolCalls: [call] };
      if (outcome === "failure") throw new Error("model failed after reading");
      if (outcome === "cancelled") { controller.abort(); controller.signal.throwIfAborted(); }
      return { content: "finished" };
    } }, () => chatWithTools([], undefined, { tools: runner.tools, executeTool: runner.execute, disposeTools: runner.dispose, maxRounds: outcome === "exhausted" ? 0 : 2 }));
    try {
      if (["failure", "cancelled"].includes(outcome)) await assert.rejects(task);
      else assert.equal((await task).exhausted, outcome === "exhausted");
      assert.ok(calls.length);
      await assert.rejects(access(calls[0].args.workdir), { code: "ENOENT" });
    } finally { await runner.dispose?.(); }
  }));
}

test("parallel readers have separate scratch directories and cleanup never follows links into originals", async () => fixture(async ({ cwd, calls, command, create }) => {
  const first = create(), second = create();
  try {
    await first.execute({ name: "pwsh", arguments: { command } });
    const one = calls.at(-1).args.workdir;
    await second.execute({ name: "bash", arguments: { command } });
    const two = calls.at(-1).args.workdir;
    assert.notEqual(one, two);
    await symlink(cwd, join(one, "linked-originals"), process.platform === "win32" ? "junction" : "dir");
    await first.dispose();
    assert.equal(await readFile(join(cwd, "guide.txt"), "utf8"), "original rules");
    assert.equal(await readFile(join(two, "dump.txt"), "utf8"), "original rules");
  } finally { await first.dispose?.(); await second.dispose?.(); }
}));

test("background reference commands are rejected before execution", async () => fixture(async ({ calls, command, create }) => {
  const runner = create();
  const result = await runner.execute({ name: "pwsh", arguments: { command, run_in_background: true } });
  assert.equal(result.nativeIsError, true);
  assert.match(result.text, /不允许后台命令/);
  assert.equal(calls.length, 0);
  await runner.dispose();
}));

test("cancellation inside the native executor still cleans its temporary files", async () => fixture(async ({ ctx, controller, command, create }) => {
  let scratch;
  ctx.tools.execute = async ({ arguments: args }) => {
    scratch = args.workdir;
    await writeFile(join(scratch, "partial.txt"), "partial result");
    controller.abort();
    controller.signal.throwIfAborted();
  };
  const runner = create();
  try {
    await assert.rejects(withRuntimeCall({ modelAdapter: async () => ({ toolCalls: [{ id: "cancel-read", function: { name: "pwsh", arguments: JSON.stringify({ command }) } }] }) },
      () => chatWithTools([], undefined, { tools: runner.tools, executeTool: runner.execute, disposeTools: runner.dispose })));
    await assert.rejects(access(scratch), { code: "ENOENT" });
  } finally { await runner.dispose(); }
}));

test("all native-reading model stages pass their cleanup callback to the tool conversation", async () => {
  const contextPack = { source: "保存", targetLocale: "zh-CN", targetLanguage: "简体中文" };
  const cases = [
    [runner => translateWithReflection(contextPack, { reflect: false, toolRunner: runner }), "保存"],
    [runner => evaluateAutoQaWithModel({ source: "保存", translation: "保存", locale: "zh-CN", toolRunner: runner }), '{"issues":[]}'],
    [runner => checkBatchConsistencyWithModel({ pairs: [{ id: "s1", source: "保存", translation: "保存" }], toolRunner: runner }), '{"findings":[]}'],
    [runner => translateMicroBatchWithModel([{ id: "s1", source: "保存", contextPack }], { routePlan: { modelRole: "main" }, toolRunner: runner }), '{"translations":[{"id":"s1","translation":"保存"}]}']
  ];
  for (const [run, content] of cases) {
    let disposed = 0;
    const runner = { tools: [{ type: "function", function: { name: "read", parameters: {} } }], execute: async () => ({ text: "rules" }), dispose: async () => { disposed++; } };
    await withRuntimeCall({ modelAdapter: async () => ({ content }) }, () => run(runner));
    assert.equal(disposed, 1);
  }
});

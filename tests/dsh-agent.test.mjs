import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Kami equips the active shell executor and skill tools for Office originals", { skip: !process.env.DSH_TEST_LLM_MODULE }, async () => {
  const sdk = process.env.DSH_TEST_LLM_MODULE;
  const { LocalBashExecutor } = await import(new URL("../../dsh-bash-local/lib/index.js", sdk));
  const source = (await readFile(new URL("../dsh/agent.mjs", import.meta.url), "utf8"))
    .replace(/"@deepseek-ai\/(dsh-[\w-]+)"/g, (_match, name) => JSON.stringify(new URL(`../../${name}/lib/index.js`, sdk).href));
  const agent = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  for (const bash of [true, false]) {
    const plugins = [];
    await agent.apply({
      get: () => true, shell: bash ? Object.create(LocalBashExecutor.prototype) : {},
      plugin: (plugin, config) => plugins.push({ plugin, config }),
      tools: { presentAs: () => () => {}, register: () => {} }, effect: (run) => run(), systemPrompt: { section: () => {} }
    });
    const expected = await import(new URL(`../../dsh-tool-${bash ? "bash" : "pwsh"}/lib/index.js`, sdk));
    assert.equal(plugins[0].plugin, expected, "use the configured executor, including custom Bash on Windows");
    assert.equal(plugins[0].config.enableRunInBackground, false);
    assert.equal(plugins[1].plugin, await import(new URL("../../dsh-skill-filesystem/lib/index.js", sdk)));
    assert.equal(plugins[2].plugin, await import(new URL("../../dsh-tool-skill/lib/index.js", sdk)));
  }
});

test("Kami preset keeps its tools visible to child sessions alongside inherited DSH tools", { skip: !process.env.DSH_TEST_LLM_MODULE, timeout: 5000 }, async () => {
  const sdk = process.env.DSH_TEST_LLM_MODULE;
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime, defineTool }, { createScope }] = await Promise.all([
    import(new URL("../../cordis/lib/index.js", sdk)),
    import(new URL("../../dsh-system-prompt/lib/index.js", sdk)),
    import(new URL("../../dsh-tools/lib/index.js", sdk)),
    import(new URL("../../dsh-scope/lib/index.js", sdk))
  ]);
  const root = new Context();
  root.plugin(SystemPrompt, {});
  root.plugin(ToolRuntime, {});
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  root.plugin({ inject: ["tools", "systemPrompt"], async apply(ctx) {
    const key = {};
    const scope = createScope(ctx, key);
    try {
      ctx.tools.register(defineTool({ name: "host_shell", description: "Host test capability", parameters: {}, output: { schema: { type: "json" }, render: () => [] }, execute: async () => ({}) }));
      const source = (await readFile(new URL("../dsh/agent.mjs", import.meta.url), "utf8"))
        .replace('"@deepseek-ai/dsh-tools"', JSON.stringify(new URL("../../dsh-tools/lib/index.js", sdk).href))
        .replace('"@deepseek-ai/dsh-tool-executor-native"', JSON.stringify(new URL("../../dsh-tool-executor-native/lib/index.js", sdk).href));
      const agent = await import(`data:text/javascript,${encodeURIComponent(source)}`);
      await agent.apply(scope.ctx);
      const assertNative = (scopeKey) => {
        if (typeof ctx.tools.modeFor === "function") assert.equal(ctx.tools.modeFor(scopeKey), "native");
        else assert.deepEqual(
          ctx.tools.selectExecutor(scopeKey).describe(ctx.tools.definitions(scopeKey)).schemas.map((tool) => tool.name).sort(),
          ["host_shell", "kami_file_import", "kami_help", "kami_workbench", "kami_workspace"]
        );
      };
      assert.deepEqual(ctx.tools.schemas(key).map((tool) => tool.name).sort(), ["host_shell", "kami_file_import", "kami_help", "kami_workbench", "kami_workspace"]);
      const sessionKey = {};
      const session = createScope(ctx, sessionKey, { parent: key });
      try {
        assert.deepEqual(ctx.tools.schemas(sessionKey).map((tool) => tool.name).sort(), ["host_shell", "kami_file_import", "kami_help", "kami_workbench", "kami_workspace"]);
        assertNative(sessionKey);
      } finally { await session.dispose(); }
      assert.deepEqual(ctx.tools.schemas().map((tool) => tool.name), ["host_shell"]);
      assertNative(key);
      await scope.dispose();
      assert.deepEqual(ctx.tools.schemas().map((tool) => tool.name), ["host_shell"]);
      resolveReady();
    } catch (error) { rejectReady(error); }
  } });
  try { await ready; } finally { await root.fiber.dispose(); }
});

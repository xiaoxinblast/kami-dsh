import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Kami preset hides inherited Host tools and keeps its own native tools", { skip: !process.env.DSH_TEST_LLM_MODULE, timeout: 5000 }, async () => {
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
        .replace('"@deepseek-ai/dsh-tools"', JSON.stringify(new URL("../../dsh-tools/lib/index.js", sdk).href));
      const agent = await import(`data:text/javascript,${encodeURIComponent(source)}`);
      agent.apply(scope.ctx);
      assert.deepEqual(ctx.tools.schemas(key).map((tool) => tool.name).sort(), ["kami_file_import", "kami_help", "kami_workbench"]);
      assert.deepEqual(ctx.tools.schemas().map((tool) => tool.name), ["host_shell"]);
      assert.equal(ctx.tools.modeFor(key), "native");
      await scope.dispose();
      assert.deepEqual(ctx.tools.schemas().map((tool) => tool.name), ["host_shell"]);
      resolveReady();
    } catch (error) { rejectReady(error); }
  } });
  try { await ready; } finally { await root.fiber.dispose(); }
});

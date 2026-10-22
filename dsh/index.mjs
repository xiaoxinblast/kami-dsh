import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import * as llm from "@deepseek-ai/dsh-llm";
import { createWorkbench } from "./workbench.mjs";
import { createModelAdapter, sessionModelRoute } from "./model-adapter.mjs";

export const inject = ["llm", "commands", "attachments", "sessionProjections", "agentDefaultModel"];

export async function apply(ctx) {
  const profile = process.env.DSH_PROFILE || "desktop";
  const dataDirectory = join(resolveDshHome(), "kami-dsh", profile);
  const abort = new AbortController();
  const ready = createWorkbench({ dataDirectory, modelAdapter: createModelAdapter(ctx, llm) });
  await ready;
  const contextFor = (agent, signal, human = false) => ({
    human,
    cwd: agent?.session?.header?.cwd || agent?.session?.cwd || agent?.session?.workingDirectory,
    modelRoute: sessionModelRoute(ctx, agent),
    signal: AbortSignal.any([abort.signal, signal || new AbortController().signal])
  });
  ctx.effect(() => ctx.reflect.provide("kamiWorkbench", { ready, contextFor }));
  ctx.effect(() => ctx.commands.register({
    name: "kami",
    description: "操作本地 Kami 翻译工作台",
    input: { hint: "工作台操作" },
    async handler({ agent, rawInput, signal }) {
      try {
        const operation = JSON.parse(rawInput.trim() || '{"path":"/api/projects"}');
        const workbench = await ready;
        const value = operation.action === "backup" ? await workbench.backup() : await workbench.invoke(operation, contextFor(agent, signal, true));
        return { kind: "success", text: JSON.stringify(value) };
      } catch (error) { return { kind: "error", text: error.message }; }
    }
  }));
  ctx.effect(() => async () => {
    abort.abort();
    await (await ready).close();
  });
}

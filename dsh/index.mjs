import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import * as llm from "@deepseek-ai/dsh-llm";
import { createWorkbench } from "./workbench.mjs";
import { createModelAdapter, sessionModelRoute } from "./model-adapter.mjs";
import { createWorkspaceReferenceTools } from "./reference-tools.mjs";
import { KamiUiService, TYPERT } from "./ui-bridge.mjs";

export const inject = ["llm", "commands", "attachments", "sessionProjections", "agentDefaultModel", "typert", "workingDirectory", "fs", "sandboxPolicy", "agentPresets", "tools"];

export async function apply(ctx) {
  const profile = process.env.DSH_PROFILE || "desktop";
  const dataDirectory = join(resolveDshHome(), "kami-dsh", profile);
  const abort = new AbortController();
  const ready = createWorkbench({ dataDirectory, modelAdapter: createModelAdapter(ctx, llm) });
  await ready;
  const contextFor = (agent, signal, human = false) => ({
    human,
    cwd: agent?.session ? ctx.workingDirectory.get(agent.session) : undefined,
    fs: ctx.fs,
    filePolicy: ctx.sandboxPolicy.resolve({ session: agent?.session }),
    sessionId: agent?.session?.header?.id,
    isKamiSession: Boolean(agent?.ctx && ctx.agentPresets.composedPreset(agent.ctx) === "kami-translator"),
    modelRoute: sessionModelRoute(ctx, agent),
    referenceTools: (options) => createWorkspaceReferenceTools(ctx, agent, options, AbortSignal.any([abort.signal, signal || new AbortController().signal])),
    signal: AbortSignal.any([abort.signal, signal || new AbortController().signal])
  });
  ctx.effect(() => ctx.reflect.provide("kamiWorkbench", { ready, contextFor }));
  ctx.plugin(KamiUiService);
  ctx.typert.register(TYPERT);
  ctx.effect(() => ctx.commands.register({
    name: "kami",
    description: "操作本地 Kami 翻译工作台",
    input: { hint: "工作台操作" },
    async handler({ agent, rawInput, signal }) {
      try {
        const operation = JSON.parse(rawInput.trim() || '{"path":"/api/projects"}');
        const workbench = await ready;
        const value = await workbench.perform(operation, contextFor(agent, signal, true));
        return { kind: "success", text: JSON.stringify(value) };
      } catch (error) { return { kind: "error", text: error.message }; }
    }
  }));
  ctx.effect(() => async () => {
    abort.abort();
    await (await ready).close();
  });
}

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const json = { mode: "src-json" };
export const descriptor = {
  id: "kami-dsh#kamiUi/invoke", service: "kamiUi", namespace: "kamiUi", method: "invoke",
  invocation: { kind: "direct" },
  parameters: [
    { name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: json },
    { name: "operation", wire: "operation", source: "json", codec: json }
  ],
  cancellation: { parameter: "signal" }, result: json
};

export const TYPERT = {
  package: "kami-dsh", face: "host", schemas: [], invocations: [descriptor],
  model: { services: [], events: [], objects: [] }
};

// Page operations share the workbench and session model route without appending chat commands.
export class KamiUiService extends TypertRemoteService {
  static inject = ["kamiWorkbench"];

  constructor(ctx) { super(ctx, "kamiUi"); }

  async invoke(agent, operation, signal) {
    const workbench = await this.ctx.kamiWorkbench.ready;
    if (operation.action === "backup") return workbench.backup();
    return workbench.invoke(operation, this.ctx.kamiWorkbench.contextFor(agent, signal, true));
  }
}

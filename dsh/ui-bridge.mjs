import { TypertRemoteService, isRemoteJsonValue } from "@deepseek-ai/dsh-typert-protocol";

const json = { mode: "strict", typeSymbol: "kami-dsh#Json", jsonSchema: {}, create: () => ({ parse(value) {
  if (!isRemoteJsonValue(value)) throw new TypeError("Kami operation must contain JSON values");
  return value;
} }) };
const sessionId = { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", jsonSchema: { type: "string" }, create: () => ({ parse(value) {
  if (typeof value !== "string" || !value) throw new TypeError("Kami session id must be a nonempty string");
  return value;
} }) };
export const descriptor = {
  id: "kami-dsh#kamiUi/invoke", service: "kamiUi", namespace: "kamiUi", method: "invoke",
  invocation: { kind: "direct" },
  parameters: [
    { name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: sessionId },
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

import { logThinking } from "./logger.mjs";
import { runtimeOptions } from "./runtime-context.mjs";

/**
 * 把一次模型调用的思考交给日志。
 *
 * 所有模型调用（初译、校对、AIQA、语境分析、术语/风格蒸馏、学习评测）都经过
 * `chat()`，这里统一补上批次/句段上下文，日志里就能按批次和阶段回查。
 *
 * 只抄已经返回的文本：不发额外请求、不改提示词、不进入后续上下文，因此不增加
 * token 消耗。记录与否、单条上限、保留总量都在「设置 → 日志」里。
 */
export function recordModelThinking({ label = "模型调用", model = "", effort = "", text = "", status = "ok", attempt = 1, extra = {} } = {}) {
  const { thinkingContext = {} } = runtimeOptions();
  const context = { ...(thinkingContext || {}), ...(extra || {}), attempt };
  return logThinking({ label, model, effort, text, status, context });
}

import { setTimeout as delay } from "node:timers/promises";
import { getSettings } from "../src/settings-store.mjs";
import { measureStage, tokenCounts } from "../src/performance.mjs";

export function sessionModelRoute(ctx, agent) {
  const selected = agent?.model?.current?.();
  if (selected?.provider && selected?.model) return selected;
  const pending = ctx.sessionProjections?.stateOf?.(agent?.session, "modelSelection")?.pending;
  return pending || agent?.session?.requestHeader?.()?.config || ctx.agentDefaultModel.currentSelection();
}

/** 把已经流出的思考交给调用方；半截流拿不到块时静默跳过。 */
function reportReasoning(options, assembler, attempt, status) {
  if (typeof options.onReasoning !== "function" || !assembler) return;
  try {
    const text = assembler.blocks().filter((block) => block.type === "reasoning").map((block) => block.text).join("");
    if (text) options.onReasoning(text, { status, attempt });
  } catch {
    // 未闭合的未知块会抛错：这种流本来也没有可用的思考。
  }
}

/** Convert the existing prompt protocol to DSH's provider-neutral message stream. */
export function createModelAdapter(ctx, llm) {
  const callConfig = (route) => {
    if (!route?.provider || !route?.model) throw new Error("请先在 DSH 中配置并选择可用模型");
    const maxTokens = getSettings().model.maxTokens;
    // DSH owns model defaults; legacy per-task budgets must not override user settings.
    return { ...route, ...(maxTokens > 0 ? { maxTokens } : {}) };
  };
  const adapter = async (messages, options = {}) => {
    const route = options.route;
    let config = callConfig(route);
    options.signal?.throwIfAborted();
    const blocks = async (content) => typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : ctx.attachments.admitPromptContent((content || []).map((block) => {
      if (block.type === "text") return block;
      const image = block.type === "image_url" && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(block.image_url?.url || "");
      if (image) return { type: "image", mediaType: image[1], data: image[2] };
      throw new Error("参考图片必须是 PNG、JPEG、WebP 或 GIF 的内嵌数据");
    }));
    const converted = await Promise.all(messages.map(async (message) => {
      if (message.role === "system") return llm.createSystemMessage(String(message.content || ""));
      if (message.role === "tool") return llm.createToolResultMessage({ callId: message.tool_call_id, content: message.nativeContent || await blocks(message.content), ...(message.nativeIsError ? { isError: true } : {}) });
      if (message.role === "assistant") return llm.createAssistantMessage({ content: [...await blocks(message.content), ...(message.tool_calls || []).map((call) => ({ type: "tool-call", id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" }))], source: route });
      return { role: "user", content: message.nativeContent || await blocks(message.content) };
    }));
    const tools = (options.tools || []).map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
    if (options.seed !== undefined) options.onSeedUnsupported?.("DSH 模型接口未提供固定 seed，本次评测不声明确定性采样");
    config = { ...config, ...(options.temperature === undefined ? {} : { temperature: options.temperature }) };
    const retryLimit = getSettings().model.retryMaxTokens, label = options.requestLabel || "模型调用";
    const retryDelays = [1000, 2000, 4000];
    let usage, truncated, transportRetries = 0;
    for (let attempt = 1; ; attempt += 1) {
      const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(options.timeoutMs || 120_000)]);
      signal.throwIfAborted();
      let prepared, assembler;
      try {
        prepared = await ctx.llm.prepareCall(config, signal);
        if (truncated && !(prepared.config.maxTokens > truncated.details.maxTokens)) break;
        assembler = new llm.BlockAssembler();
        await measureStage("model", async event => {
          try {
            for await (const chunk of prepared.stream({ ...prepared.config, messages: converted, ...(tools.length ? { tools } : {}), signal })) assembler.push(chunk);
            signal.throwIfAborted();
          } finally {
            if (event) {
              const u = assembler.usage;
              const input = u?.totalTokens != null && u.outputTokens != null ? u.totalTokens - u.outputTokens
                : u?.inputTokens != null ? u.inputTokens + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) : null;
              event.usage = tokenCounts(input, u?.outputTokens, u?.cacheReadTokens,
                u?.cacheReadTokens != null && input != null ? input - u.cacheReadTokens : null);
              if (["max-tokens", "error", "aborted"].includes(assembler.finish?.kind)) event.status = "failed";
            }
          }
        }, { requestLabel: label, provider: prepared.config.provider, model: prepared.config.model, reasoningEffort: prepared.config.reasoningEffort, maxTokens: prepared.config.maxTokens, attempt });
        if (assembler.finish.kind === "error" || assembler.finish.kind === "aborted") {
          const failure = assembler.finish.failure;
          throw Object.assign(new Error(`${label}：${failure?.message || "DSH 模型调用中断或失败"}`), { code: assembler.finish.kind === "aborted" ? "ABORTED" : failure?.code });
        }
      } catch (error) {
        if (signal.aborted) {
          reportReasoning(options, assembler, attempt, "failed");
          throw new Error(`${label}${options.signal?.aborted ? "已取消" : `超过 ${Math.round((options.timeoutMs || 120_000) / 1000)} 秒，调用超时`}（${prepared?.config.model || config.model}，输出上限 ${prepared?.config.maxTokens ?? "提供商默认"}）`, { cause: error });
        }
        const transportFailed = error?.code === "TRANSPORT" || (!error?.code && /(?:^|：)DeepSeek Messages transport failed$/u.test(error?.message));
        if (!transportFailed) {
          reportReasoning(options, assembler, attempt, "failed");
          throw error;
        }
        if (transportRetries === retryDelays.length) {
          reportReasoning(options, assembler, attempt, "failed");
          throw Object.assign(new Error(`${label}传输失败，已自动重试 ${transportRetries} 次：${error.message}`, { cause: error }), { code: "TRANSPORT", transportRetriesExhausted: true });
        }
        await delay(retryDelays[transportRetries++], undefined, { signal: options.signal });
        continue;
      } finally {
        if (assembler?.usage) {
          usage ??= {};
          for (const [key, value] of Object.entries(assembler.usage)) if (typeof value === "number") usage[key] = (usage[key] || 0) + value;
          usage.promptTokens = usage.totalTokens != null && usage.outputTokens != null ? usage.totalTokens - usage.outputTokens
            : usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
          usage.completionTokens = usage.outputTokens ?? usage.completionTokens;
        }
      }
      const maxTokens = prepared.config.maxTokens;
      if (assembler.finish.kind === "max-tokens") {
        reportReasoning(options, assembler, attempt, "truncated");
        const details = { requestLabel: label, provider: prepared.config.provider, model: prepared.config.model, reasoningEffort: prepared.config.reasoningEffort, maxTokens, attempts: attempt, usage };
        const canRetry = !truncated;
        truncated = Object.assign(new Error(`${label}：DSH 模型输出被截断（${details.model}，实际输出上限 ${maxTokens ?? "提供商默认"} token，已调用 ${details.attempts} 次，累计输出 ${usage?.completionTokens ?? "未知"} token）。请在 Kami「设置 → 模型」调整输出与重试上限。`), { code: "KAMI_MODEL_TRUNCATED", details });
        const nextMaxTokens = Math.min(retryLimit, maxTokens * 2);
        if (canRetry && Number.isSafeInteger(nextMaxTokens) && nextMaxTokens > maxTokens) { config = { ...prepared.config, maxTokens: nextMaxTokens }; continue; }
        break;
      }
      const result = assembler.blocks();
      const reasoning = result.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
      if (reasoning) options.onReasoning?.(reasoning, { status: "ok", attempt });
      return {
        content: result.filter((block) => block.type === "text").map((block) => block.text).join(""),
        toolCalls: result.filter((block) => block.type === "tool-call").map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments) } })),
        reasoning,
        usage
      };
    }
    if (usage) options.onUsage?.(usage);
    throw truncated;
  };
  adapter.describe = async (route, signal) => {
    const prepared = await ctx.llm.prepareCall(callConfig(route), signal);
    const { provider, model, reasoningEffort, maxTokens } = prepared.config;
    return { provider, model, reasoningEffort, maxTokens, source: getSettings().model.maxTokens > 0 ? "kami" : "dsh" };
  };
  return adapter;
}

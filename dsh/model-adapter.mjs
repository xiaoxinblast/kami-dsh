import { getSettings } from "../src/settings-store.mjs";

export function sessionModelRoute(ctx, agent) {
  const selected = agent?.model?.current?.();
  if (selected?.provider && selected?.model) return selected;
  const pending = ctx.sessionProjections?.stateOf?.(agent?.session, "modelSelection")?.pending;
  return pending || agent?.session?.requestHeader?.()?.config || ctx.agentDefaultModel.currentSelection();
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
      return { role: "user", content: await blocks(message.content) };
    }));
    const tools = (options.tools || []).map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
    if (options.seed !== undefined) options.onSeedUnsupported?.("DSH 模型接口未提供固定 seed，本次评测不声明确定性采样");
    config = { ...config, ...(options.temperature === undefined ? {} : { temperature: options.temperature }) };
    const retryLimit = getSettings().model.retryMaxTokens, label = options.requestLabel || "模型调用";
    let usage, truncated;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(options.timeoutMs || 120_000)]);
      signal.throwIfAborted();
      const prepared = await ctx.llm.prepareCall(config, signal);
      const maxTokens = prepared.config.maxTokens;
      if (truncated && !(maxTokens > truncated.details.maxTokens)) break;
      const assembler = new llm.BlockAssembler();
      try {
        for await (const chunk of prepared.stream({ ...prepared.config, messages: converted, ...(tools.length ? { tools } : {}), signal })) assembler.push(chunk);
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw new Error(`${label}${options.signal?.aborted ? "已取消" : `超过 ${Math.round((options.timeoutMs || 120_000) / 1000)} 秒，调用超时`}（${prepared.config.model}，输出上限 ${maxTokens ?? "提供商默认"}）`, { cause: error });
        throw error;
      }
      if (assembler.usage) {
        usage ??= {};
        for (const [key, value] of Object.entries(assembler.usage)) if (typeof value === "number") usage[key] = (usage[key] || 0) + value;
        usage.promptTokens = usage.inputTokens ?? usage.promptTokens;
        usage.completionTokens = usage.outputTokens ?? usage.completionTokens;
      }
      if (assembler.finish.kind === "max-tokens") {
        const details = { requestLabel: label, provider: prepared.config.provider, model: prepared.config.model, reasoningEffort: prepared.config.reasoningEffort, maxTokens, attempts: attempt + 1, usage };
        truncated = Object.assign(new Error(`${label}：DSH 模型输出被截断（${details.model}，实际输出上限 ${maxTokens ?? "提供商默认"} token，已调用 ${details.attempts} 次，累计输出 ${usage?.completionTokens ?? "未知"} token）。请在 Kami「设置 → 模型」调整输出与重试上限。`), { code: "KAMI_MODEL_TRUNCATED", details });
        const nextMaxTokens = Math.min(retryLimit, maxTokens * 2);
        if (attempt === 0 && Number.isSafeInteger(nextMaxTokens) && nextMaxTokens > maxTokens) { config = { ...prepared.config, maxTokens: nextMaxTokens }; continue; }
        break;
      }
      if (assembler.finish.kind === "error" || assembler.finish.kind === "aborted") throw new Error(`${label}：${assembler.finish.failure?.message || "DSH 模型调用中断或失败"}`);
      const result = assembler.blocks();
      return {
        content: result.filter((block) => block.type === "text").map((block) => block.text).join(""),
        toolCalls: result.filter((block) => block.type === "tool-call").map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments) } })),
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

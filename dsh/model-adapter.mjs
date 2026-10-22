export function sessionModelRoute(ctx, agent) {
  const pending = ctx.sessionProjections.stateOf(agent.session, "modelSelection")?.pending;
  return pending || agent.session.requestHeader()?.config || ctx.agentDefaultModel.currentSelection();
}

/** Convert the existing prompt protocol to DSH's provider-neutral message stream. */
export function createModelAdapter(ctx, llm) {
  return async (messages, options = {}) => {
    const route = options.route;
    if (!route?.provider || !route?.model) throw new Error("请先在 DSH 中配置并选择可用模型");
    const blocks = async (content) => typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : ctx.attachments.admitPromptContent((content || []).map((block) => {
      if (block.type === "text") return block;
      const image = block.type === "image_url" && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(block.image_url?.url || "");
      if (image) return { type: "image", mediaType: image[1], data: image[2] };
      throw new Error("参考图片必须是 PNG、JPEG、WebP 或 GIF 的内嵌数据");
    }));
    const converted = await Promise.all(messages.map(async (message) => {
      if (message.role === "system") return llm.createSystemMessage(String(message.content || ""));
      if (message.role === "tool") return llm.createToolResultMessage({ callId: message.tool_call_id, content: await blocks(message.content) });
      if (message.role === "assistant") return llm.createAssistantMessage({ content: [...await blocks(message.content), ...(message.tool_calls || []).map((call) => ({ type: "tool-call", id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" }))], source: route });
      return { role: "user", content: await blocks(message.content) };
    }));
    const assembler = new llm.BlockAssembler();
    const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(options.timeoutMs || 120_000)]);
    const tools = (options.tools || []).map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
    if (options.seed !== undefined) options.onSeedUnsupported?.("DSH 模型接口未提供固定 seed，本次评测不声明确定性采样");
    const prepared = await ctx.llm.prepareCall({ ...route, ...(options.temperature === undefined ? {} : { temperature: options.temperature }), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) }, signal);
    for await (const chunk of prepared.stream({ ...prepared.config, messages: converted, ...(tools.length ? { tools } : {}), signal })) assembler.push(chunk);
    const result = assembler.blocks();
    if (assembler.finish.kind === "max-tokens") throw new Error("DSH 模型输出被截断，请调整模型输出上限后重试");
    if (assembler.finish.kind === "error" || assembler.finish.kind === "aborted") throw new Error(assembler.finish.failure?.message || "DSH 模型调用中断或失败");
    return {
      content: result.filter((block) => block.type === "text").map((block) => block.text).join(""),
      toolCalls: result.filter((block) => block.type === "tool-call").map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments) } })),
      usage: assembler.usage ? { ...assembler.usage, promptTokens: assembler.usage.inputTokens ?? assembler.usage.promptTokens, completionTokens: assembler.usage.outputTokens ?? assembler.usage.completionTokens } : undefined
    };
  };
}

import { runtimeOptions, withRuntimeCall } from "./runtime-context.mjs";

/** 只记录阶段、耗时和调用配置；不保存提示词、译文或工具参数。 */
export async function measureStage(stage, callback, details = {}) {
  const { performanceTrace, performancePhase } = runtimeOptions();
  if (!performanceTrace) return callback();
  const started = Date.now();
  const event = { stage, ...(performancePhase ? { parent: performancePhase } : {}), ...details, startedAt: new Date(started).toISOString(), status: "completed" };
  try {
    const result = await withRuntimeCall({ performancePhase: stage }, callback);
    if (result?.nativeIsError === true || result?.isError === true || result?.fallbackReason) event.status = "failed";
    return result;
  } catch (error) {
    event.status = "failed";
    throw error;
  } finally {
    event.durationMs = Date.now() - started;
    performanceTrace.events.push(event);
  }
}

import { runtimeOptions, withRuntimeCall } from "./runtime-context.mjs";

// Null distinguishes an unreported counter from a measured zero.
export function tokenCounts(inputTokens, outputTokens, cacheHitTokens, cacheMissTokens) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  return { inputTokens: count(inputTokens), outputTokens: count(outputTokens), cacheHitTokens: count(cacheHitTokens), cacheMissTokens: count(cacheMissTokens) };
}

export function summarizeModelUsage(events) {
  const calls = events.filter(event => event.stage === "model");
  const totals = tokenCounts();
  for (const name of Object.keys(totals)) {
    if (calls.every(call => Number.isSafeInteger(call.usage?.[name]))) {
      totals[name] = calls.reduce((sum, call) => sum + call.usage[name], 0);
    }
  }
  return { calls: calls.length, ...totals };
}

export function includePriorModelCalls(current, previous) {
  if (!current || current === previous) return current || previous;
  const prior = previous?.events?.filter(event => event.stage === "model") || [];
  return prior.length ? { ...current, events: [...prior, ...current.events] } : current;
}

/** 只记录阶段、耗时、调用配置及用量。 */
export async function measureStage(stage, callback, details = {}) {
  const { performanceTrace, performancePhase } = runtimeOptions();
  if (!performanceTrace) return callback();
  const started = Date.now();
  const event = { stage, ...(performanceTrace.groupId ? { groupId: performanceTrace.groupId } : {}), ...(performancePhase ? { parent: performancePhase } : {}), ...details, startedAt: new Date(started).toISOString(), status: "completed" };
  try {
    const result = await withRuntimeCall({ performancePhase: stage }, () => callback(event));
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

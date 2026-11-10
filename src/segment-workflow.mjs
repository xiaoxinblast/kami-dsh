// 阶段重试只执行选中的阶段。后续结果标为待执行，不能沿用旧稿的检查结论。
export async function runSegmentWorkflow({ stage = "all", translation = "", stages = {}, translate, proofread, check }) {
  if (!["all", "translation", "proofreading", "localQa"].includes(stage)) throw new Error("未知译段阶段");
  const state = { ...stages };
  let draft = translation, issues = [], generated = null;
  const pending = () => ({ status: "pending" });
  if (stage === "all" || stage === "translation") {
    generated = await translate();
    translation = generated.translation;
    draft = translation;
    state.translation = { status: "completed" };
    state.proofreading = pending();
    state.localQa = pending();
  }
  if (stage === "all" || stage === "proofreading") {
    if (!String(translation).trim()) throw new Error("请先完成翻译");
    state.localQa = pending();
    try {
      translation = await proofread(translation);
      state.proofreading = { status: "completed" };
    } catch (error) {
      state.proofreading = { status: "failed", error: String(error.message || error) };
      return { translation, draft, stages: state, issues, generated };
    }
  }
  if (stage === "all" || stage === "localQa") {
    if (state.proofreading?.status !== "completed") throw new Error("请先完成模型校对");
    try {
      issues = await check(translation);
      state.localQa = { status: "completed" };
    } catch (error) {
      state.localQa = { status: "failed", error: String(error.message || error) };
    }
  }
  return { translation, draft, stages: state, issues, generated };
}

const actionable = new Set(["protected_token", "fact_url_missing", "fact_placeholder_missing", "preserved_term",
  "forbidden_term", "tm_exact_target_mismatch", "fact_number_missing", "fact_percentage_mismatch", "fact_date_missing",
  "fact_money_mismatch", "fact_platform_missing", "fact_region_missing", "length_limit_exceeded"]);

export function proofreadingHints(issues) {
  const exactTokens = new Set(issues.filter(issue => ["fact_url_missing", "fact_placeholder_missing"].includes(issue.type))
    .map(issue => issue.fact?.value).filter(Boolean));
  const hints = new Set(issues.filter(issue => (actionable.has(issue.type) || issue.type?.startsWith("line_layout_") || issue.type === "inline_tag_sequence") && issue.severity !== "info"
    && !(issue.type === "protected_token" && exactTokens.has(issue.token))).map(issue => issue.message));
  const drift = issues.find(issue => issue.type === "number_drift" && issue.severity !== "info");
  if (drift?.missingValues?.length && !issues.some(issue => issue.fact && ["number", "percentage", "money", "discount", "date"].includes(issue.fact.type))) {
    hints.add(`核对原文数值或出现次数：${[...new Set(drift.missingValues)].join("、")}`);
  }
  return [...hints];
}

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
    state.draftQa = pending();
    state.proofreading = pending();
    state.localQa = pending();
  }
  if (stage === "all" || stage === "proofreading") {
    if (!String(translation).trim()) throw new Error("请先完成翻译");
    state.localQa = pending();
    state.draftQa = pending();
    try {
      const hints = proofreadingHints(await check(translation, "draftQa"));
      state.draftQa = { status: "completed", hintCount: hints.length };
      translation = await proofread(translation, hints);
      state.proofreading = { status: "completed" };
      state.localQa = { status: "optional" };
    } catch (error) {
      if (state.draftQa.status === "pending") state.draftQa = { status: "failed", error: String(error.message || error) };
      state.proofreading = { status: "failed", error: String(error.message || error) };
      return { translation, draft, stages: state, issues, generated };
    }
  }
  if (stage === "localQa") {
    if (state.proofreading?.status !== "completed") throw new Error("请先完成模型校对");
    try {
      issues = await check(translation, "localQa");
      state.localQa = { status: "completed" };
    } catch (error) {
      state.localQa = { status: "failed", error: String(error.message || error) };
    }
  }
  return { translation, draft, stages: state, issues, generated };
}

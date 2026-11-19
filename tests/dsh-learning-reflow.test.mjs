import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { runtimeOptions } from "../src/runtime-context.mjs";

test("学习入口将同类换行规则冻结给两侧；人工合行可学习，历史轨迹也能读取项目排版限制", async () => {
  const root = await mkdtemp(join(tmpdir(), "kami-learning-reflow-"));
  const calls = [], inputs = [], proposals = [];
  const wb = await createWorkbench({ dataDirectory: root, modelAdapter: async (messages, { requestLabel }) => {
    calls.push(requestLabel);
    if (requestLabel === "翻译技能复盘") {
      const { trajectories: items, evaluationFeedback } = JSON.parse(messages.at(-1).content);
      proposals.push(evaluationFeedback);
      assert.ok(items.every(row => !row.layoutReview), "合并了普通换行的人工译文仍是有效范例");
      return { content: JSON.stringify({ name: "候选", reason: "人工终稿", strategyPatch: { prompting: { additionalRules: ["保留句末语气"] } }, evidenceIds: items.map(i => i.id) }) };
    }
    if (requestLabel === "翻译" || requestLabel === "AIQA") {
      inputs.push(JSON.stringify(messages));
      return { content: requestLabel === "翻译" ? "下雨了。\n走吧。" : '{"issues":[]}' };
    }
    throw new Error("意外的模型调用 " + requestLabel);
  } });
  const context = { human: true, modelRoute: { provider: "test", model: "fixture" } };
  const post = (path, body) => wb.invoke({ path, method: "POST", body }, context);
  try {
    const { project } = await post("/api/projects", { name: "评测折行" });
    const scope = { locale: "zh-CN", projectId: project.id, contentType: "general", domain: "general" };
    await post("/api/style-guides/import", { projectId: project.id, filename: "行宽.md", base64: Buffer.from("每行最多 8 字，最多 2 行。").toString("base64") });
    const rules = [{ maxChars: 8, maxLines: 2, source: "已核对表格", quote: "留出答案不得透传", counting: "characters" }];
    await runtimeOptions().store.request("/items/learning_trajectories", { method: "POST", body: Array.from({ length: 30 }, (_, i) => ({
      id: "example-" + i, project: project.id, target_locale: "zh-CN", content_type: "general", domain: "general",
      status: "completed", source: String.fromCodePoint(0x4e00 + i) + "。\n傘を。\n行こう。", initial_translation: "雨。\n走吧。",
      final_translation: "下雨了。走吧。", human_decision: { accepted: true, finalTranslation: "下雨了。走吧。" },
      context_pack: i % 2 ? { lineLayout: { markers: [], rules } } : {}
    })) });
    const { skill } = await post("/api/learning/skills/generate", scope);
    const { jobId } = await post("/api/learning/skills/" + skill.id + "/evaluate", scope);
    let job;
    const deadline = Date.now() + 15000;
    do {
      ({ job } = await wb.invoke({ path: "/api/learning/evaluation-jobs/" + jobId }, context));
      if (["completed", "failed"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.equal(job.status, "completed", job.error || JSON.stringify(job.progress));
    assert.equal(job.progress.completed, 20);
    assert.equal(job.progress.failed, 0);
    assert.equal(job.reproducibility.policyVersion, "kami-evaluation-v4");
    assert.deepEqual(job.result.report.referenceStructureReviewIds, []);
    for (const side of ["champion", "candidate"]) {
      const rounds = job.result.report.structure[side];
      assert.ok(rounds.every(r => r.attemptedRepairs === 0 && r.final.missingLineBreaks === 0 && r.final.extraLineBreaks === 0));
    }
    assert.equal(calls.filter(c => c === "翻译").length, 40);
    assert.equal(calls.filter(c => c === "AIQA").length, 40);
    assert.equal(proposals.filter(feedback => !feedback).length, 1);
    assert.ok(proposals.filter(Boolean).every(feedback => feedback.failedGates.some(gate => gate.id === "material_gain")));
    assert.equal(calls.length, 80 + proposals.length, "自动复盘与句段翻译重试分开计数");
    assert.ok(inputs.every(text => text.includes("每行最多 8 字") && !text.includes("留出答案不得透传")));
    assert.ok(inputs.some(text => text.includes("已核对表格")));
    assert.ok(inputs.some(text => text.includes("行宽")));
  } finally { await wb.close(); await rm(root, { recursive: true, force: true }); }
});

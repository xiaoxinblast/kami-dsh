import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境必须在加载任何 src 模块前就绪：mock 模型服务 + 隔离 JSON 存储 + 空配置目录。
const dataDir = await mkdtemp(join(tmpdir(), "kami-proposal-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
delete process.env.KAMI_STORE;
process.env.MOCK_OPENAI_PORT = "11438";
process.env.LLM_BASE_URL = "http://127.0.0.1:11438/v1";
process.env.LLM_MODEL = "mock-model";

await import("./fixtures/mock-openai-server.mjs");
const store = await import("../src/store.mjs");
const engine = await import("../src/learning-engine.mjs");
const proposal = await import("../src/skill-proposal.mjs");

test("selectProposalTrajectories 只保留人工采纳的终稿并截断", () => {
  const accepted = (id, extra = {}) => ({
    id, status: "completed", finalTranslation: "有", humanDecision: { accepted: true, finalTranslation: "有" }, ...extra
  });
  const trajectories = [
    accepted("a"),
    accepted("b", { status: "review" }),
    accepted("c", { status: "running" }),
    accepted("d", { finalTranslation: "" , humanDecision: { accepted: true, finalTranslation: "" } }),
    accepted("e", { status: "failed" }),
    // 采纳记录里没写终稿时回落到轨迹自己的终稿
    { id: "f", status: "completed", finalTranslation: "有", humanDecision: { accepted: true } },
    // 机器稿：批次翻完就有了，但没有人采纳 → 不能当改进依据
    { id: "g", status: "completed", finalTranslation: "有" },
    { id: "h", status: "review", finalTranslation: "有", humanDecision: { accepted: false } }
  ];
  assert.deepEqual(proposal.selectProposalTrajectories(trajectories).map((item) => item.id), ["a", "b", "f"]);
  assert.equal(
    proposal.selectProposalTrajectories(Array.from({ length: 50 }, (_, index) => accepted(`t${index}`))).length,
    30
  );
});

test("候选提前预留二十条独立终稿，三十条证据足以学习并评测", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), source: `原文${i}`, finalTranslation: `终稿${i}`, status: "completed", humanDecision: { accepted: true } }));
  const selected = proposal.selectProposalTrajectories(rows);
  assert.equal(selected.length, 10);
  const training = new Set(selected.map((item) => item.id));
  assert.equal(rows.filter((item) => !training.has(item.id)).length, 20);
});

test("proposeChallengerSkill 走完模型提议、补丁合并与隔离保存的完整闭环", async () => {
  await store.initializeStore();
  const scope = { locale: "ja-JP", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template, metadata: { seed: 1 } });
  for (let index = 0; index < 5; index += 1) {
    const created = await store.saveLearningTrajectory({
      ...scope, batchId: "manual-review", segmentId: "", source: `自动提议测试句${index}` ,
      contextPack: {}, assetRefs: {}, model: "mock-model", promptVersion: "kami-translation-v1", status: "running", events: []
    });
    await store.updateLearningTrajectory(created.id, {
      finalTranslation: `訳${index}`,
      status: "completed",
      humanDecision: { accepted: true, finalTranslation: `訳${index}` }
    });
  }
  // 同一范围里再塞两条没人工采纳的机器稿：它们不能进候选技能的证据。
  const machineOnly = [];
  for (let index = 0; index < 2; index += 1) {
    const created = await store.saveLearningTrajectory({
      ...scope, batchId: "machine-only", segmentId: "", source: `未校对的机器稿${index}`,
      contextPack: {}, assetRefs: {}, model: "mock-model", promptVersion: "kami-translation-v1", status: "running", events: []
    });
    await store.updateLearningTrajectory(created.id, { finalTranslation: `机器${index}`, status: "completed" });
    machineOnly.push(created.id);
  }
  const trajectories = await store.listLearningTrajectories({ ...scope, limit: 100 });
  const challenger = await proposal.proposeChallengerSkill({ scope, champion, trajectories, promptVersion: "kami-translation-v1" });

  assert.equal(challenger.status, "challenger");
  assert.equal(challenger.parentId, champion.id);
  assert.equal(challenger.version, 2);
  assert.equal(challenger.strategy.retrieval.translationMemory.limit, 8, "模型补丁应合并进候选策略");
  assert.deepEqual(challenger.strategy.prompting.additionalRules, ["输出前逐项核对强制术语"]);
  assert.deepEqual(
    challenger.evidenceIds.sort(),
    trajectories.filter((item) => item.humanDecision?.accepted === true).map((item) => item.id).sort(),
    "只有人工采纳的终稿能当证据"
  );
  assert.ok(machineOnly.every((id) => !challenger.evidenceIds.includes(id)), "未校对的机器稿不能进候选技能证据");
  assert.equal(challenger.metadata.seed, 1, "冠军 metadata 应保留并合并");
  assert.equal(challenger.metadata.generatedBy, "mock-model");
});

test("垃圾补丁经白名单净化后入库并记录净化明细", async () => {
  const scope = { locale: "th-TH", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template });
  const created = await store.saveLearningTrajectory({
    ...scope, batchId: "manual-review", segmentId: "", source: "返回垃圾补丁的测试句",
    contextPack: {}, assetRefs: {}, model: "mock-model", promptVersion: "kami-translation-v1", status: "running", events: []
  });
  await store.updateLearningTrajectory(created.id, {
    finalTranslation: "訳",
    status: "completed",
    humanDecision: { accepted: true, finalTranslation: "訳" }
  });
  const trajectories = await store.listLearningTrajectories({ ...scope, limit: 100 });
  const challenger = await proposal.proposeChallengerSkill({ scope, champion, trajectories, promptVersion: "kami-translation-v1" });

  // 数值夹紧；被丢弃的字段回落冠军原值（includeNextSegments=1、includeDocumentMetadata=true）
  assert.equal(challenger.strategy.context.includePreviousSegments, 6);
  assert.equal(challenger.strategy.context.includeNextSegments, 1, "非数值应丢弃并保留冠军原值");
  assert.equal(challenger.strategy.context.includeDocumentMetadata, true);
  // 非法 limit 丢弃并保留冠军原值 5，越界 limit 夹紧
  assert.equal(challenger.strategy.retrieval.translationMemory.limit, 5);
  assert.equal(challenger.strategy.retrieval.qaCases.limit, 20);
  assert.equal(challenger.strategy.retrieval.qaCases.enabled, true);
  assert.deepEqual(challenger.strategy.retrieval.styleProfile, { enabled: false, limit: 3 });
  // 规则：注入丢弃、截断到 12 条
  const rules = challenger.strategy.prompting.additionalRules;
  assert.equal(rules.length, 12);
  assert.ok(!rules.some((rule) => /忽略|密钥/.test(rule)), "注入规则应被丢弃");
  assert.equal(challenger.strategy.prompting.additionalInstruction.length, 600);
  // QA 夹紧
  assert.equal(challenger.strategy.qa.minimumScore, 70);
  assert.equal(challenger.strategy.qa.maximumRevisionAttempts, 4);
  assert.equal(challenger.strategy.qa.blockOnHardError, true, "非法布尔应丢弃并保留冠军原值");
  // 未知区块被丢弃
  assert.equal(challenger.strategy.extraSection, undefined);
  // 净化明细写入 metadata
  assert.ok(Array.isArray(challenger.metadata.sanitization?.warnings));
  assert.ok(challenger.metadata.sanitization.warnings.length > 0);
  assert.equal(challenger.metadata.generatedBy, "mock-model");
});

test("没有可用轨迹时抛出与手动入口一致的 409", async () => {
  const scope = { locale: "ko-KR", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template, id: "champion-empty-trajectory" });
  await assert.rejects(
    () => proposal.proposeChallengerSkill({ scope, champion, trajectories: [] }),
    (error) => error.statusCode === 409 && /还没有人工采纳的终稿/.test(error.message)
  );
  // 只有机器稿同样不能生成：这是这一版明确加上的闸门。
  await assert.rejects(
    () => proposal.proposeChallengerSkill({
      scope,
      champion,
      trajectories: [{ id: "machine-1", status: "completed", finalTranslation: "机器稿" }]
    }),
    (error) => error.statusCode === 409 && /还没有人工采纳的终稿/.test(error.message)
  );
});

/**
 * 手动生成成功后要顺手刷新自动提议的记账：否则卡片上会一直挂着"上次自动提议失败"的旧报错，
 * 而候选其实已经生成出来了（实测踩到过）。
 */
test("手动生成成功会清掉自动提议的失败记录，并标明来源是手动", async () => {
  const [server, app] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  const route = server.slice(server.indexOf('url.pathname === "/api/learning/skills/generate"'), server.indexOf('url.pathname.startsWith("/api/learning/skills/")'));
  assert.match(route, /lastError: "",/u, "手动成功要清掉 lastError");
  assert.match(route, /lastSource: "manual"/u, "要标明这次是手动生成");
  assert.match(route, /await updateTranslationSkill\(champion\.id, \{/u);
  assert.match(route, /candidateId: String\(skill\.id \|\| ""\)/u);
  // 自动链路也要能区分来源，失败时保留上次来源。
  const autoProposal = await readFile(new URL("../src/auto-proposal.mjs", import.meta.url), "utf8");
  assert.match(autoProposal, /lastSource: "auto"/u);
  assert.match(autoProposal, /lastSource: String\(previous\.lastSource \|\| ""\)/u);
  // 卡片上要把"手动"标出来。
  assert.match(app, /上次生成候选 \$\{escapeHtml\(formatLearningDate\(autoPropose\.lastProposedAt\)\)\}\$\{autoPropose\.lastSource === "manual" \? "（手动）" : ""\}/u);
});

/**
 * 机器稿不能当生成依据：后端筛选、取数窗口与界面口径三处必须一致，
 * 否则会出现"按钮能点但服务端 409"或者"明明有人工终稿却找不到"。
 */
test("界面与后端同口径：只有人工采纳终稿能生成候选", async () => {
  const [server, app] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  assert.match(server, /const trajectories = await listLearningTrajectories\(\{ \.\.\.scope, limit: 500 \}\);/u, "手动入口取 500 条窗口，别被最新一批机器稿挤掉人工终稿");
  assert.match(server, /listTrajectories: async \(scope\) => listLearningTrajectories\(\{ \.\.\.scope, limit: 500 \}\)/u);
  assert.match(app, /function proposalTrajectories\(items = \[\]\)/u);
  assert.match(app, /proposalTrajectories\(payload\.trajectories \|\| payload\.evidence\)\.length/u, "按钮可用性要按人工采纳算");
  assert.match(app, /条轨迹（\$\{proposalCount\} 条人工采纳）/u, "总量与可生成候选的数量要分开显示");
  assert.match(app, /根据人工采纳终稿生成候选技能/u);
});

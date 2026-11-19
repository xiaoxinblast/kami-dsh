/**
 * Single-case skill benchmark shared by background evaluation jobs.
 *
 * Runs one holdout case against one skill variant (champion or challenger)
 * with clean-room retrieval isolation and real token-usage capture, so the
 * promotion gates see measured cost instead of a fake zero.
 */

import { assertLocale } from "./config.mjs";
import { classifyContent } from "./classifier.mjs";
import { DATA_ROOT, getAssets, getBatchRun, getMemories, getProjectStyleProfile, getQaCases, getUserProfile, listReferenceChunksForProject } from "./store.mjs";
import { readBatchOriginal } from "./batch-originals.mjs";
import { extractXliffPairs } from "./xliff-document.mjs";
import { runtimeOptions } from "./runtime-context.mjs";
import { checkLineLayout } from "./line-layout.mjs";
import { compareBenchmarkStructure, extraBreaksBesideMarker, visibleWording } from "./benchmark-structure.mjs";
import { matchTerms } from "./matcher.mjs";
import { embedSource } from "./embedding.mjs";
import { rankQaCases, rankTranslationMemories, splitReferenceAuthority } from "./translation-memory.mjs";
import { buildContextPack } from "./context-pack.mjs";
import { createUsageCollector, estimateUsageCost, evaluateTranslationWithModel, getProviderConfig, reviseTranslationWithQa, translateWithReflection } from "./provider.mjs";
import { calculateQaScore, runQa } from "./qa.mjs";
import { normalizedEditDistance } from "./learning-engine.mjs";
import { isolateBenchmarkAssets } from "./benchmark-isolation.mjs";
import { buildReferenceToolRunner, createProjectReferenceIndex } from "./reference-context.mjs";
import { benchmarkSnapshotFingerprint } from "./evaluation-policy.mjs";

/** 与生产共用同一个按项目缓存的参考资料索引。 */
const referenceIndex = createProjectReferenceIndex();

function benchmarkScope(skill) {
  const source = skill?.scope && skill.scope.locale ? skill.scope : skill;
  return {
    locale: assertLocale(source.locale),
    contentType: String(source.contentType || "general"),
    domain: String(source.domain || "general"),
    project: String(source.project || "default")
  };
}

function snapshotProvider(config = {}) {
  return {
    baseUrl: String(config.baseUrl || ""),
    model: String(config.model || ""),
    embeddingModel: String(config.embeddingModel || ""),
    inputPricePerMTok: config.inputPricePerMTok ?? "",
    outputPricePerMTok: config.outputPricePerMTok ?? ""
  };
}

export async function benchmarkLineBreakMarkers(trajectories, project) {
  const markers = {};
  for (const batchId of new Set(trajectories.filter((item) => item.source?.includes("<tag ")).map((item) => item.batchId).filter(Boolean))) {
    const run = await getBatchRun(batchId);
    if (run?.projectId && run.projectId !== project) continue;
    if (!/\.(?:mqxliff|xliff)$/iu.test(run?.filename || "")) continue;
    const bytes = await readBatchOriginal({ dataRoot: runtimeOptions().dataDirectory || DATA_ROOT, relativePath: run.runnerOptions?.originalFile });
    if (!bytes) continue;
    const pairs = extractXliffPairs(bytes, run.filename, { includeEmptyTargets: true, includeLineBreakMarkers: true });
    const units = new Map(pairs.map((pair) => [pair.entryId, pair]));
    for (const item of trajectories.filter((item) => item.batchId === batchId)) {
      const unit = units.get(String(item.entryId || item.assetRefs?.entryId || ""));
      if (unit?.source === item.source && unit.lineBreakMarkers.length) markers[item.id] = unit.lineBreakMarkers;
    }
  }
  return markers;
}

/**
 * Materialize every mutable retrieval input before the first model call. Both
 * variants and every repetition then see the same term library, memories, QA
 * cases, profiles and query embeddings even if Directus changes mid-run.
 */
export async function createBenchmarkSnapshot(scope, trajectories = [], { promptVersion = "", resolveLayouts } = {}) {
  const normalizedScope = benchmarkScope(scope);
  const [assets, styleProfile, qaCases, memories, userProfile] = await Promise.all([
    getAssets(normalizedScope.locale, { projectId: normalizedScope.project }),
    getProjectStyleProfile(normalizedScope.locale, { projectId: normalizedScope.project }),
    getQaCases(normalizedScope.locale, { projectId: normalizedScope.project, contentType: normalizedScope.contentType, domain: normalizedScope.domain, limit: -1 }),
    getMemories(normalizedScope.locale, { projectId: normalizedScope.project, contentType: normalizedScope.contentType, domain: normalizedScope.domain, limit: -1, exactContentType: true }),
    getUserProfile(normalizedScope.locale, { projectId: normalizedScope.project })
  ]);
  const queryEmbeddings = {};
  // Local embeddings are the normal fallback and are cheap; keeping this
  // sequential also avoids a snapshot creation burst against a remote service.
  for (const trajectory of trajectories) {
    const caseId = String(trajectory?.id || "");
    if (caseId) queryEmbeddings[caseId] = await embedSource(String(trajectory?.source || ""));
  }
  const lineLayouts = resolveLayouts ? await resolveLayouts(normalizedScope, trajectories, userProfile) : {};
  const frozen = {
    scope: normalizedScope,
    assets,
    styleProfile,
    qaCases,
    memories,
    userProfile,
    queryEmbeddings,
    lineLayouts,
    lineBreakMarkers: await benchmarkLineBreakMarkers(trajectories.filter(t => !lineLayouts[t.id]?.markers.length), normalizedScope.project),
    provider: snapshotProvider(getProviderConfig()),
    promptVersion: String(promptVersion || "")
  };
  return {
    ...frozen,
    createdAt: new Date().toISOString(),
    fingerprint: benchmarkSnapshotFingerprint(frozen)
  };
}

/**
 * @param options.styleProfileOverride  Use this style profile for translation
 *   instead of the scope's active one — this is what makes a style-profile
 *   draft an actual variable in a paired benchmark instead of a constant.
 * @param options.qaStyleProfile  Style profile the AIQA judge sees. When a
 *   style draft is under test the judge must keep reading the CURRENT active
 *   profile, otherwise each variant is graded by its own yardstick and the
 *   comparison measures nothing.
 */
export async function benchmarkTranslationSkill(skill, trajectory, {
  styleProfileOverride = undefined,
  qaStyleProfile = undefined,
  snapshot = null,
  scope: pairedScope = null,
  evaluationProfile = null,
  repetition = 0,
  seed = undefined
} = {}) {
  const scope = benchmarkScope(snapshot?.scope || pairedScope || skill);
  if (snapshot?.provider) {
    const liveProvider = getProviderConfig();
    if (String(liveProvider.baseUrl || "") !== String(snapshot.provider.baseUrl || "")
      || String(liveProvider.model || "") !== String(snapshot.provider.model || "")) {
      throw new Error("评测期间模型供应商或模型已变化，禁止把不同模型输出混入同一冻结快照；请重新发起评测");
    }
  }
  const source = String(trajectory.source || "");
  const context = trajectory.neighborContext ?? trajectory.contextPack?.neighborContext;
  const neighborContext = typeof context === "string" ? context : { previous: context?.previous, next: context?.next, note: context?.note };
  // 两侧共用冻结的任务语体；历史技能自身可以带有不同的注册语体。
  const classification = classifyContent(source, scope.contentType);
  classification.contentType = scope.contentType;
  const assets = snapshot?.assets || await getAssets(scope.locale, { projectId: scope.project });
  const matches = matchTerms(source, assets, { contentType: scope.contentType, domain: scope.domain });
  const queryEmbedding = snapshot?.queryEmbeddings?.[String(trajectory.id || "")] ?? await embedSource(source);
  const [styleProfile, qaCases, memories, userProfile] = snapshot
    ? [snapshot.styleProfile, snapshot.qaCases || [], snapshot.memories || [], snapshot.userProfile]
    : await Promise.all([
      getProjectStyleProfile(scope.locale, { projectId: scope.project }),
      getQaCases(scope.locale, { projectId: scope.project, contentType: scope.contentType, domain: scope.domain, limit: -1 }),
      getMemories(scope.locale, { projectId: scope.project, contentType: scope.contentType, domain: scope.domain, limit: -1, exactContentType: true }),
      getUserProfile(scope.locale, { projectId: scope.project })
    ]);
  // Clean-room isolation: never feed this holdout case its own final translation
  // back through memories, QA cases or distilled profile examples. The gold must
  // stay invisible to both variants or the benchmark measures copying, not skill.
  const translationStyleProfile = styleProfileOverride === undefined ? styleProfile : styleProfileOverride;
  const isolated = isolateBenchmarkAssets({ source, memories, qaCases, styleProfile: translationStyleProfile, userProfile });
  // 参考资料同样要过考试隔离：只允许与留出原文不同源的片段进入检索，否则
  // 上传过的旧译稿会变成"标准答案"喂给两个变体。
  const projectReferenceChunks = await listReferenceChunksForProject(scope.project, { limit: 1_000 }).catch(() => []);
  const referenceRunner = projectReferenceChunks.length
    ? buildReferenceToolRunner({
      index: referenceIndex,
      projectId: scope.project,
      settings: { enabled: true },
      skill,
      onlyChunkIds: new Set(isolateBenchmarkAssets({ source, referenceChunks: projectReferenceChunks }).referenceChunks.map((chunk) => chunk.id))
    })
    : null;
  const memoryLimit = Math.min(10, Math.max(1, Number(skill.strategy?.retrieval?.translationMemory?.limit) || 5));
  const qaCaseLimit = Math.min(10, Math.max(1, Number(skill.strategy?.retrieval?.qaCases?.limit) || 3));
  const translationReferences = rankTranslationMemories(source, isolated.memories, { limit: memoryLimit, queryEmbedding, contentTags: classification.contentTags || [] });
  const qaGuidance = rankQaCases(source, isolated.qaCases, { limit: qaCaseLimit, queryEmbedding });
  const contextPack = buildContextPack({
    source, locale: scope.locale, classification, matches, domain: scope.domain,
    neighborContext,
    styleProfile: isolated.styleProfile, translationSkill: skill, qaGuidance, userProfile: isolated.userProfile, translationReferences
  });
  // The judge gets its own pack so the style profile under test never becomes
  // the standard it is judged against.
  const judgeStyleProfile = qaStyleProfile === undefined
    ? contextPack.styleProfile
    : isolateBenchmarkAssets({ source, styleProfile: qaStyleProfile }).styleProfile;
  const qaContextPack = judgeStyleProfile === contextPack.styleProfile
    ? contextPack
    : buildContextPack({
      source, locale: scope.locale, classification, matches, domain: scope.domain,
      neighborContext,
      styleProfile: judgeStyleProfile, translationSkill: skill, qaGuidance, userProfile: isolated.userProfile, translationReferences
    });
  const startedAt = Date.now();
  const usage = createUsageCollector();
  const reproducibilityWarnings = new Set();
  const onSeedUnsupported = (warning) => reproducibilityWarnings.add(String(warning || "固定 seed 未生效"));
  const layout = snapshot?.lineLayouts?.[trajectory.id] ?? trajectory.lineLayout ?? trajectory.contextPack?.lineLayout;
  const lineBreaks = snapshot?.lineBreakMarkers?.[trajectory.id] ?? layout?.markers ?? [];
  const rules = layout?.rules || [];
  const compare = target => compareBenchmarkStructure(source, target, lineBreaks, rules);
  for (const pack of [contextPack, qaContextPack]) {
    pack.allowLineReflow = true;
    if (rules.length || lineBreaks.length) pack.lineLayout = { markers: lineBreaks, rules };
  }
  const translated = await translateWithReflection(contextPack, {
    reflect: false,
    lineBreakMarkers: lineBreaks,
    onUsage: usage.onUsage,
    temperature: evaluationProfile?.translationTemperature,
    seed,
    onSeedUnsupported,
    toolRunner: referenceRunner
  });
  const first = compare(translated.translation);
  let translation = translated.translation;
  const retry = Object.values(first).some(Boolean);
  if (retry) {
    const repaired = await reviseTranslationWithQa({ contextPack, translation, onUsage: usage.onUsage,
      seed, onSeedUnsupported,
      issues: [{ type: "layout", message: "只修复已指出的固定标记或排版违规，保留译文措辞。普通换行可根据译文合并或拆分。", counts: first, layoutIssues: checkLineLayout(translation, { markers: lineBreaks, rules }).map(issue => issue.message), lineBreakMarkers: lineBreaks }] });
    if (visibleWording(repaired) === visibleWording(translation)
      && !Object.values(compare(repaired)).some(Boolean)) translation = repaired;
  }
  const final = retry ? compare(translation) : first;
  const hardIssues = runQa({ source, translation, matches, locale: scope.locale });
  // Count each layout fault once, even when both token QA and sequence QA reported it.
  const structuralErrors = Object.values(final).reduce((sum, count) => sum + count, 0);
  if (structuralErrors) {
    const otherIssues = hardIssues.filter(issue => issue.type !== "inline_tag_sequence" && !issue.type.startsWith("line_layout_")
      && !(issue.type === "protected_token" && /^(?:<tag\s|<br\s*\/?>)/iu.test(issue.token)));
    hardIssues.length = 0;
    hardIssues.push(...otherIssues);
    for (let i = 0; i < structuralErrors; i++) hardIssues.push({ type: "layout", severity: "error", message: "固定标记或译文排版不符合要求" });
  }
  // 评测里的裁判同样不能把机器译例当标准，否则两个变体都在向系统自己的历史输出收敛。
  const referenceAuthority = splitReferenceAuthority(translationReferences);
  const aiIssues = await evaluateTranslationWithModel({
    contextPack: qaContextPack, translation,
    references: referenceAuthority.approved, machineDrafts: referenceAuthority.machineDrafts,
    qaCases: qaGuidance, onUsage: usage.onUsage,
    temperature: evaluationProfile?.qaTemperature,
    seed: Number.isInteger(seed) ? ((seed + 104729) & 0x7fffffff) : undefined,
    onSeedUnsupported
  });
  const score = calculateQaScore({ hardIssues, aiIssues });
  const required = matches.filter((item) => item.mode === "exact" && item.term?.enforcement === "required");
  const requiredTermHits = required.filter(({ term }) => translation.includes(String(term.target || ""))).length;
  const gold = String(trajectory.humanDecision?.finalTranslation || trajectory.finalTranslation || "");
  const editDistance = normalizedEditDistance(visibleWording(translation), visibleWording(gold));
  const usageSnapshot = usage.snapshot();
  const costUsd = usageSnapshot ? estimateUsageCost(usageSnapshot, snapshot?.provider || getProviderConfig()) : null;
  const repetitions = Math.max(1, Number(evaluationProfile?.repetitions) || 1);
  const caseId = repetitions > 1 ? `${trajectory.id}#r${Number(repetition) + 1}` : trajectory.id;
  return {
    caseId,
    sourceCaseId: trajectory.id,
    repetition: Number(repetition) || 0,
    scope,
    translation,
    structure: { first, final, retry, reference: compare(gold),
      extraPhysicalBreaksBesideMarker: extraBreaksBesideMarker(source, translation, lineBreaks) },
    ...(retry ? { initialTranslation: translated.translation } : {}),
    requiredTermHits,
    requiredTermTotal: required.length,
    hardErrorCount: hardIssues.filter((issue) => issue.severity === "error").length,
    qaScore: score,
    humanEditDistance: editDistance,
    humanAccepted: editDistance <= 0.12 && score >= 90 && !hardIssues.some((issue) => issue.severity === "error"),
    styleProfileId: String(contextPack.styleProfile?.id || ""),
    qaStyleProfileId: String(qaContextPack.styleProfile?.id || ""),
    isolation: isolated.isolation,
    usage: usageSnapshot || undefined,
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
    latencyMs: Date.now() - startedAt,
    reproducibility: {
      policyVersion: evaluationProfile?.policyVersion || "legacy",
      mode: evaluationProfile?.mode || "production-default",
      temperature: Number.isFinite(Number(evaluationProfile?.translationTemperature)) ? Number(evaluationProfile.translationTemperature) : undefined,
      seedRequested: Number.isInteger(seed),
      seedSupported: reproducibilityWarnings.size === 0,
      warnings: [...reproducibilityWarnings],
      snapshotFingerprint: String(snapshot?.fingerprint || "")
    }
  };
}

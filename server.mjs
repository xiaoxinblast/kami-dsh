import http from "node:http";
import { runtimeOptions } from "./src/runtime-context.mjs";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { ACTIVE_LOCALES, CONTENT_TAGS, CONTENT_TYPES, LOCALES, assertActiveLocale, assertLocale } from "./src/config.mjs";
import { classifyContent, descriptorFromContext, inferContentTags, resolveDomain } from "./src/classifier.mjs";
import { buildContextPack } from "./src/context-pack.mjs";
import { refineCorpus } from "./src/corpus.mjs";
import { matchTerms } from "./src/matcher.mjs";
import { resolveSegmentMatches } from "./src/batch-matches.mjs";
import { createTokenCache } from "./src/token-cache.mjs";
import { settleReadSections } from "./src/read-sections.mjs";
import { createMatcherPool } from "./src/matcher-pool.mjs";
import { adjudicateRuleConflictsWithModel, adjudicatePotentialTermsWithModel, alignSegmentsWithModel, alignTermSuggestionsWithModel, analyzeDocumentContextWithModel, analyzeSpreadsheetStructureWithModel, analyzeTermTableStructureWithModel, checkBatchConsistencyWithModel, classifyWithModel, costPricingConfigured, embed, extractTextFromImageWithModel, evaluateAutoQaWithModel, evaluateGrammarWithModel, evaluateTranslationWithModel, getProviderConfig, isEmbeddingConfigured, probeModelAvailability, resolveSurveyTargetsWithModel, reviewGateFailuresWithModel, surveyTermsWithModel, reviewTermCandidatesWithModel, reviseTranslationWithQa, translateWithReflection, translateWithRoute, updateProviderConfig, learnWorkingTermsWithModel } from "./src/provider.mjs";
import { formalTermKeys, mergeWorkingAssets, normalizeWorkingTerms } from "./src/working-glossary.mjs";
import { buildPatternKey } from "./src/pattern-memory.mjs";
import { DISTILL_THRESHOLD, distillBatchStyleLearning, distillStyleProfileIfReady, runEvolutionReview } from "./src/evolution.mjs";
import { calculateQaScore, presentAiQaIssues, runQa } from "./src/qa.mjs";
import { alignSegmentPairs, buildAlignmentIssues, calculateAutoQaScores, cosineSimilarity, createStructuralAlignmentScorer, dedupeIssues, normalizeQaInputText, runBasicQa, splitQaSegments, summarizeIssues } from "./src/auto-qa.mjs";
import { DATA_ROOT, completeImport, countStyleEvidence, countStyleEvidenceFiles, countLearningTrajectoriesByFile, deleteAsset, deleteLibraryEntries, deleteMemory, getAsset, getAssets, getAssetGenerationToken, getAssetStats, getImportPreview, getLibraryStats, getMemories, getStyleLearningRun, listLibraryEntries, listLibraryFiles, listStyleEvidenceFiles, updateMemory, getQaCases, findQaCase, getQaRuns, getStoreMetadata, getStyleEvidence, getStyleLearningRuns, getStyleProfile, getProjectStyleProfile, getUserProfile, initializeStore, rebuildEmbeddings, saveAsset, saveAssets, saveCorpus, saveImportPreview, saveMemories, saveMemory, saveQaCase, saveQaRun, saveStyleEvidence, saveStyleEvidences, loadStyleEvidenceIndex, saveStyleLearningRun, saveStyleProfileEvaluation, findStyleProfile, demoteMemories, approveQaCase, saveBatchRun, getBatchRun, listBatchRuns, listStyleProfiles, activateStyleProfile, rejectStyleProfile, listPendingQaCases, disposeQaCase, saveLearningTrajectory, listLearningTrajectories, countLearningTrajectoriesByScope, getLearningTrajectory, updateLearningTrajectory, saveTranslationSkill, listTranslationSkills, getTranslationSkill, updateTranslationSkill, activateTranslationSkill, rollbackTranslationSkill, saveSkillEvaluation, listSkillEvaluations, saveQaTask, getQaTask, listQaTasks, deleteQaTask, saveBackgroundTask, getBackgroundTask, listBackgroundTasks, deleteBackgroundTask, updateStyleProfileRules, saveQualityAsset, listQualityAssets, getQualityAsset, updateQualityAsset, saveQualityRun, listQualityRuns, updateQualityRun, saveTrainingRun, listTrainingRuns, getTrainingRun, getProjects, getProject, saveProject, deleteProject, purgeProject, getResourceLibraries, saveResourceLibrary, deleteResourceLibrary, saveReferenceDocument, getReferenceDocument, listReferenceDocuments, updateReferenceDocument, deleteReferenceDocument, saveReferenceFolder, getReferenceFolder, listReferenceFolders, deleteReferenceFolder, replaceReferenceChunks, listReferenceChunks, listReferenceChunksForProject, updateReferenceChunk } from "./src/store.mjs";
import { MAX_REFERENCE_FILE_BYTES, chunkReferencePages, extractReferenceFile, planReferenceExtraction, scanReferenceRisk } from "./src/reference-materials.mjs";
import { getMemoryCandidates, sampleStyleEvidence, saveTmImportAudit } from "./src/store.mjs";
import { buildReferenceToolRunner as assembleReferenceToolRunner, createProjectReferenceIndex } from "./src/reference-context.mjs";
import { canDeleteQaIssues, deleteQaIssue } from "./src/qa-issue-deletion.mjs";
import { applyModelDecisions, classifyImportCandidate, classifyImportRowKind, expandNestedTermCandidates, extractTermPairs, markExistingTermCandidates, termMatchKey } from "./src/table-term-extractor.mjs";
import { deletePreviewCache, readPreviewCandidates, readPreviewPage, writePreviewCache } from "./src/tm-preview-cache.mjs";
import { buildSuggestionCandidates, resolveTermSuggestions } from "./src/term-suggestions.mjs";
import { narrowByDomain, normalizeMemoryText, rankQaCases, rankTranslationMemories, scopeMachineDraftsToFile, splitReferenceAuthority } from "./src/translation-memory.mjs";
import { embedSource } from "./src/embedding.mjs";
import { countMemories, deleteBatchRun, deleteStyleProfile, deleteTranslationSkill, deleteUserProfile, persistImportCleaning, saveUserProfile } from "./src/store.mjs";
import { describeReferenceWithModel } from "./src/provider.mjs";
import { normalizeProviderProtocol } from "./src/provider-store.mjs";
import { clearLogs, getLogSettings, installConsoleCapture, listLogs, loadPreviousRunLogs, logInfo, readLogFile, setLogLevel, writeLog } from "./src/logger.mjs";
import { describeBatchColumns, exportBatchDocument, prepareBatchDocument } from "./src/batch-document.mjs";
import { deleteBatchOriginal, readBatchOriginal, saveBatchOriginal } from "./src/batch-originals.mjs";
import { extractXliffPairs } from "./src/xliff-document.mjs";
import { runTaskPool } from "./src/task-pool.mjs";
import { externalReviewTrajectoryPatch, linkExternalReviewTrajectories, matchReviewPairsToSegments } from "./src/external-review.mjs";
import { DEFAULT_TRANSLATION_STRATEGY, createDefaultTranslationSkill, effectiveStrategyValue, evaluateSkillPromotion, normalizedEditDistance, selectSkillHoldout, summarizeTrajectoryAttribution, validateCandidatePromotionState } from "./src/learning-engine.mjs";
import { benchmarkTranslationSkill, createBenchmarkSnapshot } from "./src/skill-benchmark.mjs";
import { createEvaluationJobRunner } from "./src/evaluation-jobs.mjs";
import { createLearningJobTaskBridge } from "./src/learning-task-bridge.mjs";
import { detectBatchVerse } from "./src/batch-verse.mjs";
import { createAutoProposer } from "./src/auto-proposal.mjs";
import { createConflictScanner } from "./src/conflict-scan.mjs";
import { renderInstruction, retireRule } from "./src/style-rules.mjs";
import { SETTING_SPECS, TITLE_BRACKET_CHOICES, settingGroups } from "./src/settings.mjs";
import { environmentOverrides, getSettings, resetSettings, saveSettings } from "./src/settings-store.mjs";
import { classifyChange, isNegativeEvidence, positiveEvidenceOnly } from "./src/style-delta.mjs";
import { NO_STYLE_PROFILE_ID, STYLE_MIN_EVALUATION_SAMPLES, STYLE_PROMOTION_GUARDRAILS, benchmarkStyleVariant, selectStyleHoldout, styleVariant, validateStylePromotionState } from "./src/style-benchmark.mjs";
import { proposeChallengerFromGateReview, proposeChallengerSkill, selectProposalTrajectories } from "./src/skill-proposal.mjs";
import { checkFactSchema, detectDeliveryContext, extractFactSchema } from "./src/fact-schema.mjs";
import { applyProjectQaPolicy, projectRuleMetadata } from "./src/project-config.mjs";
import { assessTranslationRisk, decideQualityRoute, qualityThresholdForRisk, selectTranslationRoute, TRANSLATION_ROUTES } from "./src/translation-routing.mjs";
import { QUALITY_TIERS, describeTierStrength, planQualityTier, resolveManualTier, selectQualityTier } from "./src/quality-tier.mjs";
import { CONTEXT_BRIEF_MIN_SEGMENTS, contextBriefEntries, mergeContextBrief, purposeForIndex, splitContextChunks, summarizeContextBrief } from "./src/context-brief.mjs";
import { CONSISTENCY_EVIDENCE_LIMITS, buildQualityReport, deterministicConsistencyFindings, mergeConsistencyFindings, splitConsistencyChunks } from "./src/consistency-check.mjs";
import { REPAIR_EVIDENCE_LABELS, REPAIR_SKIP_REASONS, planConsistencyRepairs, summarizeSourceGroups } from "./src/consistency-repair.mjs";
import { normalizeSource } from "./src/text.mjs";
import { deriveTermCandidatesFromHumanFinal, MEMORY_PURPOSES } from "./src/asset-governance.mjs";
import { buildReviewReceipt, normalizeReviewDecision } from "./src/review-receipt.mjs";
import { createRegressionCandidateFromQaCase, decideRegressionCandidate, normalizeGoldSet, normalizeRegressionSuite } from "./src/gold-regression.mjs";
import { buildGateQueue, decideReleaseGate, evaluateGoldRun, evaluateRegressionRun, gateRefreshDecision, gateRunCoversAssets, resolveGateAssets, selectGateCases, selectGateTargetSkill } from "./src/quality-gate.mjs";
import { deriveExternalReviewCases, mergeRegressionSources, regressionCaseSetDigest } from "./src/regression-sources.mjs";
import { alignSurveyToHumanFinal, decideTermWrite, normalizeSurveyTerms, pendingCandidateFromUnresolved, pendingReason, surveyPairs } from "./src/term-survey.mjs";
import { buildTermSurveyView } from "./src/term-survey-view.mjs";
import { chunkGateFailures, gateFailureCases, mergeGateReviewReports, termInputsFromReview } from "./src/gate-review.mjs";
import { buildTrainingExport, datasetToJsonl } from "./src/training-export.mjs";
import { advanceTrainingRun, buildTrainingManifest, canTransition, createTrainingRun, freezeTrainingDataset } from "./src/training-pipeline.mjs";
import { WorkbenchSessionMonitor, shutdownDockerDesktop } from "./src/workbench-lifecycle.mjs";
import { BACKGROUND_TASK_STALE_MS, interruptedTaskPatch, selectStaleRunningTasks } from "./src/background-task-sweep.mjs";
import { extractStyleGuideFile } from "./src/style-guide-import.mjs";
import { runServerBatch, retryServerBatchQa } from "./src/batch-runner.mjs";
import { buildBatchWorkflow, isIncompleteBatchQa, mergeBatchTaskRows } from "./public/batch-status.js";

const PUBLIC_ROOT = fileURLToPath(new URL("./public", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("./", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const AUTO_QA_EMBEDDING_SEGMENT_LIMIT = 80;
const AUTO_QA_MODEL_ALIGNMENT_SEGMENT_LIMIT = 24;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
/** 导入类请求要把多个文件按 base64 塞进一个 JSON，额度单独放宽。 */
const IMPORT_BODY_BYTES = 48 * 1024 * 1024;
/** 所有导入入口统一的单文件上限（前端同值，两边都要有）。 */
const IMPORT_FILE_BYTES = 20 * 1024 * 1024;
/** TM 预检只把前 N 条样例发给浏览器，其余按页取：8 万行表格有 8 万条候选。 */
const TM_PREVIEW_SAMPLE = 200;
const TERM_AI_CONCURRENCY = 5;
const TERM_AI_BATCH_SIZE = 24;
/** 术语批量写入的分块大小；导入 5000+ 条时逐条写会拖到分钟级。 */
const TERM_WRITE_BATCH_SIZE = 200;
/** 翻译记忆与风格证据的批量写入块大小：逐条写一次 8 万条的导入要 4 万次往返。 */
const MEMORY_WRITE_BATCH_SIZE = 200;
/** 跳过明细只保留前若干条，其余按原因计数。 */
const SKIPPED_DETAIL_LIMIT = 200;
/** 记忆库列表一页的条数与单页上限：一次渲染上万行 DOM 会卡，页面按页追加。 */
const MEMORY_LIST_LIMIT = 500;
const MEMORY_LIST_MAX = 1_000;
const TRANSLATION_PROMPT_VERSION = "kami-translation-v3";
const importProgress = new Map();
const AUTO_SHUTDOWN_ENABLED = process.env.KAMI_AUTO_SHUTDOWN === "1";
/** 显式关闭最后一个页面后的宽限期：够刷新或恢复标签页重新报到，又不至于让用户等。 */
const WORKBENCH_CLOSE_GRACE_MS = readGraceMs("KAMI_AUTO_SHUTDOWN_CLOSE_GRACE_MS", 15_000);
/**
 * 心跳失联宽限期。页面被最小化挂机或切到后台标签后，浏览器会把定时器节流到
 * 每分钟一次甚至冻结，5 秒心跳必然出现分钟级空档——那不是关闭页面。
 */
const WORKBENCH_HEARTBEAT_GRACE_MS = readGraceMs("KAMI_AUTO_SHUTDOWN_HEARTBEAT_GRACE_MS", 30 * 60_000);
/** 启动后还没有任何页面报到的宽限：浏览器冷启动可能远慢于 15 秒。 */
const WORKBENCH_STARTUP_GRACE_MS = readGraceMs("KAMI_AUTO_SHUTDOWN_STARTUP_GRACE_MS", 5 * 60_000);
const WORKBENCH_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** 后台任务进入这些状态后不再挂住收尾判定。 */
const BACKGROUND_TASK_TERMINAL_STATUSES = new Set(["completed", "failed", "review", "needs_attention", "abandoned"]);
let workbenchSessionMonitor = null;
let workbenchShutdownStarted = false;
const batchWorkers = new Map();
const batchQaWorkers = new Map();
const batchQaStarts = new Map();
const batchWorkflowWrites = new Map();
/** 批中手动改过的工作术语：内存里比批次记录新，跑批循环每段会先看一眼。 */
const workingGlossaryOverrides = new Map();
/**
 * 正在本进程内执行的后台任务。
 * 任务中心点「中断」只置一个标记，跑批的循环在下一处分块边界停下来：
 * 已写入的数据完整保留，剩下的稍后可以用同一个批次「继续导入」。
 */
const runningBackgroundTasks = new Map();
const CANCELLED = Symbol("taskCancelled");

function beginBackgroundRun(taskId) {
  let resolveSettled;
  const control = { cancelRequested: false, settled: new Promise((resolve) => { resolveSettled = resolve; }), resolveSettled: () => resolveSettled() };
  if (taskId) runningBackgroundTasks.set(taskId, control);
  return control;
}

function endBackgroundRun(taskId) {
  runningBackgroundTasks.get(taskId)?.resolveSettled();
  if (taskId) runningBackgroundTasks.delete(taskId);
}

function cancellationError(message) {
  return Object.assign(new Error(message || "已按用户要求中断"), { [CANCELLED]: true });
}

function isCancellation(error) {
  return Boolean(error && error[CANCELLED] === true);
}

function readGraceMs(variable, fallback) {
  const raw = process.env[variable];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, payload) {
  // 页面在长任务期间被关掉时连接已经断了：再写响应只会抛异常，没有意义。
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

/**
 * 创建后台任务记录（术语导入 / 双语资产导入 / Embedding 重建 / 批次导出）。
 *
 * 任务执行期间同时挂住工作台收尾判定：长任务不能在页面关闭宽限期里被杀掉。
 */
async function createBackgroundTask({ type, title, locale = "", projectId = "", progress = {}, payload = {} }) {
  const task = await saveBackgroundTask({
    type,
    projectId,
    title: String(title || "后台任务").slice(0, 160),
    locale,
    status: "in_progress",
    progress: { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0, ...progress },
    payload: payload || {}
  });
  workbenchSessionMonitor?.hold(backgroundTaskHoldId(task.id));
  return task;
}

/**
 * 投放上下文：显式传入的项目、渠道、平台、地区优先；没传时按受控词表从原文与
 * 任务补充信息里识别。术语与翻译记忆的适用范围据此收窄，识别不到就等于不限定。
 */
function deliveryContext(body = {}, text = "") {
  const metadata = Array.isArray(body?.neighborContext?.metadata) ? body.neighborContext.metadata : [];
  const detected = detectDeliveryContext({ source: text, metadata });
  return {
    project: String(body?.project || "default"),
    channel: body?.channel ? [String(body.channel)] : [],
    platform: body?.platform ? [String(body.platform)] : detected.platforms,
    region: body?.region ? [String(body.region)] : detected.regions
  };
}

/** 更新后台任务进度；任务已被删除时返回 false，执行方据此停止后续工作。 */
async function updateBackgroundTaskProgress(id, update) {
  const task = await getBackgroundTask(id);
  if (!task) return false;
  await saveBackgroundTask({ ...task, ...update });
  if (update.status && BACKGROUND_TASK_TERMINAL_STATUSES.has(String(update.status))) {
    workbenchSessionMonitor?.release(backgroundTaskHoldId(id));
  }
  return true;
}

function backgroundTaskHoldId(id) {
  return `task:${id}`;
}

/**
 * 收掉"上一轮被打断、库里还挂着进行中"的后台任务。
 *
 * 任务只在进程内存里推进：工作台重启（或被关掉）后，跑到一半的门禁/导入就没人再管了，
 * 但库里那行仍是 in_progress，任务中心会一直转圈、用户也不知道该不该等。
 * 判定只看"多久没有进度更新"，正在跑的任务几十秒就会写一次，不会误伤。
 */
async function sweepStaleBackgroundTasks({ reason = "startup" } = {}) {
  const tasks = await listBackgroundTasks({ limit: 500 }).catch(() => []);
  const stale = selectStaleRunningTasks(tasks, { now: Date.now(), staleMs: BACKGROUND_TASK_STALE_MS });
  for (const task of stale) {
    await updateBackgroundTaskProgress(task.id, interruptedTaskPatch(task)).catch(() => {});
    workbenchSessionMonitor?.release(backgroundTaskHoldId(task.id));
  }
  if (stale.length) {
    logInfo("已把长时间没有进度的后台任务标记为中断", { reason, count: stale.length, ids: stale.map((task) => task.id) });
  }
  return stale.length;
}

/**
 * 固定质量资产按版本累加：同一 seriesId 只增不改，因此任何一次门禁结论都能
 * 回到它当时实际跑的那个版本。
 */
async function nextQualityAssetVersion(scope, kind, seriesId) {
  const existing = await listQualityAssets({ ...scope, kind, seriesId, limit: 500 });
  return existing.reduce((maximum, item) => Math.max(maximum, Number(item.version) || 0), 0) + 1;
}

/** 启用某个版本时，同族其它版本一律退役，避免两个"当前基准"同时生效。 */
async function activateQualityAsset(asset) {
  const siblings = await listQualityAssets({
    locale: asset.locale, contentType: asset.contentType, domain: asset.domain, project: asset.project,
    kind: asset.kind, seriesId: asset.seriesId, limit: 500
  });
  for (const sibling of siblings) {
    if (sibling.id === asset.id || !sibling.enabled) continue;
    await updateQualityAsset(sibling.id, {
      status: "retired",
      enabled: false,
      payload: { ...sibling.payload, status: "retired", enabled: false }
    });
  }
  return updateQualityAsset(asset.id, {
    status: "active",
    enabled: true,
    payload: { ...asset.payload, status: "active", enabled: true }
  });
}

/** 解析某作用域当前生效的 Gold 样本与回归案例，附带版本指纹。 */
async function loadGateAssets(scope) {
  const [goldRecords, suiteRecords] = await Promise.all([
    listQualityAssets({ ...scope, kind: "gold_set", limit: 500 }),
    listQualityAssets({ ...scope, kind: "regression_suite", limit: 500 })
  ]);
  return resolveGateAssets({
    goldSets: goldRecords.map((item) => item.payload).filter(Boolean),
    regressionSuites: suiteRecords.map((item) => item.payload).filter(Boolean),
    scope
  });
}

/**
 * 用受测技能把固定资产整体跑一遍。走的是评测同一条基准链路，因此 Gold 样本
 * 自身的终稿不会通过记忆或问题库回流成为它自己的答案。
 */
async function runQualityGate({ scope, skill, triggeredBy = "", onProgress = null, shouldCancel = null }) {
  const assets = await loadGateAssets(scope);
  // 回归案例会随每次审校回填累积，按改动幅度封顶取前 N 条；Gold 样本是固定的，不封顶。
  const gateCases = selectGateCases(assets.cases, getSettings().learning.gateRegressionCaseLimit);
  // 同一条原文只翻一次：Gold 与回归重叠、回归集内部同句都合并成一次执行，
  // 但每一项仍然各自按自己的规则判定，结论口径不变。
  const dedupeEnabled = getSettings().learning.gateDedupeSources !== false;
  const queue = buildGateQueue({ samples: assets.samples, cases: gateCases, dedupe: dedupeEnabled });
  const goldResults = [];
  const regressionResults = [];
  const failures = [];
  let cancelled = "";
  let executed = 0;
  if (queue.length) {
    const snapshot = await createBenchmarkSnapshot(
      scope,
      queue.map((entry) => ({ id: entry.key, source: entry.source })),
      { promptVersion: TRANSLATION_PROMPT_VERSION }
    );
    for (const [index, entry] of queue.entries()) {
      // 中断在样本边界生效：已经跑完的样本全部保留，剩下的按"未执行"如实记录。
      if (shouldCancel?.()) { cancelled = "已按用户要求中断本次门禁执行"; break; }
      if (onProgress && (await onProgress(index, queue.length, entry)) === false) {
        cancelled = "后台任务记录已被删除，本次门禁执行已中止";
        break;
      }
      try {
        const benchmark = await benchmarkTranslationSkill(skill, { id: entry.key, source: entry.source }, { snapshot });
        executed += 1;
        const record = { translation: benchmark.translation, qaScore: benchmark.qaScore, hardErrorCount: benchmark.hardErrorCount, latencyMs: benchmark.latencyMs, costUsd: benchmark.costUsd };
        for (const sample of entry.gold) goldResults.push({ ...record, id: sample.id });
        for (const item of entry.regression) regressionResults.push({ ...record, id: item.id });
      } catch (error) {
        // 执行失败的样本保持"未执行"，由门禁判定为不完整而不是默认通过。
        for (const sample of entry.gold) failures.push({ id: sample.id, kind: "gold", message: error.message });
        for (const item of entry.regression) failures.push({ id: item.id, kind: "regression", message: error.message });
      }
    }
  }
  const gold = evaluateGoldRun({ samples: assets.samples, results: goldResults });
  const regression = evaluateRegressionRun({ cases: gateCases, results: regressionResults });
  const gate = decideReleaseGate({
    regression,
    gold,
    thresholds: { regressionPassRate: getSettings().learning.gateRegressionPassRate }
  });
  if (cancelled) {
    // 中断产生的记录必须说清"结论无效"，而不是伪装成一次失败的质量判定。
    gate.decision = "block";
    gate.allowed = false;
    gate.blocking = [{ code: "gate_interrupted", message: `${cancelled}：已执行 ${executed} / ${queue.length} 个样本，结论无效` }, ...gate.blocking];
  }
  return {
    gate,
    gold,
    regression,
    executionFailures: failures,
    cancelled,
    dedupe: { enabled: dedupeEnabled, executions: queue.length, planned: assets.samples.length + gateCases.length },
    gateCaseLimit: getSettings().learning.gateRegressionCaseLimit,
    regressionCaseTotal: assets.cases.length,
    assetVersions: { goldSets: assets.goldSetVersions, regressionSuites: assets.regressionSuiteVersions },
    triggeredBy
  };
}

/**
 * 派生当前作用域的全部回归案例：外部审校回填改动 + 人工批准的 QA 失败案例。
 * 外部案例不单独落库，它们是回归集的派生输入，来源始终可回溯到轨迹与批次段落。
 */
async function loadDerivedRegressionCases(scope) {
  const [trajectories, qaRecords] = await Promise.all([
    listLearningTrajectories({ ...scope, limit: 1_000 }),
    listQualityAssets({ ...scope, kind: "regression_candidate", status: "approved", limit: 500 })
  ]);
  // 旧轨迹没有 humanDecision.machineTranslation：回退到批次段落里记的 previousTranslation。
  const batchIds = [...new Set(trajectories
    .filter((item) => item.humanDecision?.accepted === true && !item.humanDecision?.machineTranslation && item.batchId)
    .map((item) => String(item.batchId)))];
  const batchSegments = new Map();
  await Promise.all(batchIds.map(async (batchId) => {
    try {
      const run = await getBatchRun(batchId);
      if (run?.segments) batchSegments.set(batchId, run.segments);
    } catch { /* 批次已删除：这条轨迹只能计数上报，不能凭空补一个机器稿 */ }
  }));
  const derived = deriveExternalReviewCases({
    trajectories,
    batchSegments,
    scope,
    minEditDistance: getSettings().learning.regressionEditDistance,
    now: new Date().toISOString()
  });
  const merged = mergeRegressionSources({
    externalCases: derived.cases,
    qaCandidates: qaRecords.map((item) => item.payload).filter(Boolean)
  });
  return { ...merged, externalStats: derived.stats };
}

/**
 * 按当前证据重建回归集。内容没变就复用现版本，避免每跑一次回填就堆一个空版本。
 * 返回 { asset, changed, stats, reason }：reason 说明为什么没有案例可入集。
 */
async function refreshRegressionSuite(scope, { reason = "", changeNote = "" } = {}) {
  const { cases, stats, externalStats } = await loadDerivedRegressionCases(scope);
  if (!cases.length) {
    return { asset: null, changed: false, stats, externalStats, reason: reason || "当前作用域没有审校改动或已批准的 QA 案例" };
  }
  const digest = regressionCaseSetDigest(cases);
  const seriesId = `regression:${scope.locale}:${scope.contentType}:${scope.domain}:${scope.project}`;
  const existing = await listQualityAssets({ ...scope, kind: "regression_suite", seriesId, limit: 500 });
  const active = existing
    .filter((item) => item.enabled && item.status === "active")
    .sort((left, right) => (Number(right.version) || 0) - (Number(left.version) || 0))[0];
  if (active?.payload?.metadata?.casesDigest === digest) {
    return { asset: active, changed: false, stats, externalStats, reason: "回归集内容未变化" };
  }
  const version = await nextQualityAssetVersion(scope, "regression_suite", seriesId);
  const payload = normalizeRegressionSuite({
    id: `${seriesId}#v${version}`,
    seriesId,
    version,
    scope,
    name: `${scope.locale} 失败回归集`,
    description: "由外部审校回填改动与人工批准的 QA 失败案例自动派生",
    status: "active",
    enabled: true,
    candidates: cases,
    createdAt: new Date().toISOString(),
    changeNote: changeNote || `自动重建：审校改动 ${externalStats.included} 条 · QA 案例 ${stats.qa} 条`,
    metadata: { casesDigest: digest, sources: stats, externalStats }
  });
  const saved = await saveQualityAsset({ kind: "regression_suite", scope, payload, status: payload.status, enabled: payload.enabled });
  const activated = await activateQualityAsset(saved);
  logInfo("回归集已按最新证据重建", { version, cases: cases.length, ...stats, reason });
  return { asset: activated, changed: true, stats, externalStats, reason: reason || "auto" };
}

/** 把一次门禁运行落成可追溯的记录。 */
async function persistQualityRun({ scope, skill, result, triggeredBy }) {
  return saveQualityRun({
    ...scope,
    skillId: skill?.id || "",
    skillVersion: String(skill?.version ?? ""),
    decision: result.gate.decision,
    regressionTotal: result.regression.total,
    regressionPassed: result.regression.passed,
    regressionPassRate: result.regression.passRate,
    goldTotal: result.gold.total,
    goldTermAccuracy: result.gold.termAccuracy,
    goldFactAccuracy: result.gold.factAccuracy,
    assetVersions: result.assetVersions,
    metrics: result.gold.metrics,
    report: {
      gold: { ...result.gold, samples: result.gold.samples.slice(0, 100) },
      regression: { ...result.regression, cases: result.regression.cases.slice(0, 100) },
      warnings: result.gate.warnings,
      executionFailures: result.executionFailures,
      dedupe: result.dedupe || null
    },
    blocking: result.gate.blocking,
    triggeredBy
  });
}

/** 正在跑门禁的技能：手动与自动触发共用，避免同一候选被重复跑两遍。 */
const qualityGateInFlight = new Set();

/**
 * 门禁统一入口：手动按钮与自动触发都走这里，保证进度上报、留档与并发去重一致。
 * 返回后台任务；真正跑模型的部分在后台继续。
 */
async function startQualityGateRun({ scope, skill, triggeredBy = "manual", reason = "manual" }) {
  const assets = await loadGateAssets(scope);
  const gateCases = selectGateCases(assets.cases, getSettings().learning.gateRegressionCaseLimit);
  const total = assets.samples.length + gateCases.length;
  if (!total) {
    const error = new Error("当前作用域没有启用的 Gold Set 或回归集，先建立固定评测资产");
    error.statusCode = 400;
    throw error;
  }
  const task = await createBackgroundTask({
    type: "quality-gate",
    title: `质量门禁 · ${scope.locale} · ${skill.name || skill.id}`,
    projectId: scope.project,
    locale: scope.locale,
    progress: { total, message: `准备执行 ${total} 个固定样本` }
  });
  // 注册进本进程的运行表：任务中心的「中断」才能真正停住门禁，
  // 而不是把任务标成中断、循环却继续往下跑。
  const control = beginBackgroundRun(task.id);
  qualityGateInFlight.add(String(skill.id));
  (async () => {
    try {
      const result = await runQualityGate({
        scope,
        skill,
        triggeredBy,
        shouldCancel: () => control.cancelRequested,
        onProgress: async (index, count) => updateBackgroundTaskProgress(task.id, {
          progress: { phase: "running", message: `正在执行第 ${index + 1} / ${count} 个固定样本`, percent: Math.round((index / Math.max(count, 1)) * 90), completed: index, total: count }
        })
      });
      const run = await persistQualityRun({ scope, skill, result, triggeredBy });
      if (result.cancelled) {
        await updateBackgroundTaskProgress(task.id, {
          status: "needs_attention",
          progress: { ...(task.progress || {}), phase: "cancelled", message: result.cancelled, completed: result.regression.total - (result.regression.missing?.length || 0), total },
          payload: { qualityRunId: run.id, decision: result.gate.decision, blocking: result.gate.blocking, skillId: skill.id, interrupted: true }
        });
        logInfo("质量门禁被中断，已留存部分结果", { skillId: skill.id, runId: run.id, blocking: result.gate.blocking?.[0]?.message || "" });
        return;
      }
      await updateBackgroundTaskProgress(task.id, {
        status: "completed",
        progress: { phase: "completed", message: `门禁结论：${result.gate.decision}`, percent: 100, completed: total, total },
        payload: { qualityRunId: run.id, decision: result.gate.decision, blocking: result.gate.blocking, skillId: skill.id }
      });
    } catch (error) {
      console.error("质量门禁后台任务失败", error);
      await updateBackgroundTaskProgress(task.id, {
        status: "failed",
        progress: { phase: "failed", message: `门禁执行失败：${error.message}`, percent: 100 },
        payload: { error: error.message }
      }).catch(() => {});
    } finally {
      endBackgroundRun(task.id);
      qualityGateInFlight.delete(String(skill.id));
      // 任务行可能已被删除（那时上面的进度更新会失败）：hold 必须在这里兜底释放，
      // 否则会话收尾判定会一直被这条不存在的任务挂住。
      workbenchSessionMonitor?.release(backgroundTaskHoldId(task.id));
    }
  })();
  logInfo("质量门禁已进入任务中心", { skillId: skill.id, total, reason });
  return { task, total };
}

/**
 * 审校回填或新候选生成后自动跑门禁：目标只认该作用域最新的候选。
 * 没有待晋升候选时不空跑生效版本——门禁是给候选发通行证的，不是刷新面板数字的工具。
 */
const autoGateScopes = new Set();

function triggerQualityGateRefresh(scope, { reason = "auto" } = {}) {
  if (!getSettings().learning.autoGateEnabled) return;
  const key = learningScopeKeyOf(scope);
  if (autoGateScopes.has(key)) return;
  autoGateScopes.add(key);
  void (async () => {
    try {
      const skills = await listTranslationSkills({ ...scope, limit: 100 });
      const assets = await loadGateAssets(scope);
      const target = selectGateTargetSkill(skills);
      const [latest] = target ? await listQualityRuns({ ...scope, skillId: target.id, limit: 10 }) : [];
      const decision = gateRefreshDecision({
        enabled: getSettings().learning.autoGateEnabled,
        skills,
        assets,
        latestRun: latest || null,
        inFlight: Boolean(target && qualityGateInFlight.has(String(target.id)))
      });
      if (!decision.run || !decision.skill) return;
      await startQualityGateRun({ scope, skill: decision.skill, triggeredBy: `auto:${reason}`, reason });
    } catch (error) {
      console.error("自动质量门禁失败", error);
    } finally {
      autoGateScopes.delete(key);
    }
  })();
}

/**
 * QA 案例被采纳后自动并入回归集：采纳动作本身就是那道人工闸门，
 * 不再要求第二次审批与署名。回归集内容有变化才出新版本。
 */
async function admitApprovedQaCase(qaCaseId) {
  const qaCase = await findQaCase(qaCaseId);
  if (!qaCase) return { skipped: "not_found" };
  const scope = learningScope({
    locale: qaCase.locale,
    contentType: qaCase.contentType || "general",
    domain: qaCase.domain || "general",
    project: qaCase.projectId || qaCase.project || "default"
  });
  const existing = await listQualityAssets({ ...scope, kind: "regression_candidate", sourceQaCaseId: qaCaseId, limit: 10 });
  let asset = existing[0] || null;
  if (!asset) {
    const candidate = createRegressionCandidateFromQaCase({ ...qaCase, scope }, {
      scope,
      createdAt: new Date().toISOString(),
      createdBy: "qa-approval"
    });
    const approved = decideRegressionCandidate(candidate, {
      decision: "approve",
      decidedAt: new Date().toISOString(),
      note: "QA 案例采纳后自动并入回归集"
    });
    asset = await saveQualityAsset({ kind: "regression_candidate", scope, payload: approved, status: approved.status, enabled: false });
  }
  const suite = await refreshRegressionSuite(scope, { reason: "qa-case-approved", changeNote: "QA 案例采纳后自动并入" });
  triggerQualityGateRefresh(scope, { reason: "qa-case-approved" });
  return {
    candidateId: asset?.id || "",
    suiteVersion: suite.asset?.version || null,
    suiteChanged: Boolean(suite.changed),
    cases: suite.stats?.total || 0
  };
}

/**
 * 参考资料检索索引：按项目缓存，写入后失效。只加载启用资料库里的可用资料。
 */
const referenceIndex = createProjectReferenceIndex();

/** 生产翻译与质检共用的参考资料工具装配。 */
function buildReferenceToolRunner({ projectId = "", onActivity = null, skill = null, onlyChunkIds = null } = {}) {
  return assembleReferenceToolRunner({
    index: referenceIndex,
    projectId,
    settings: getSettings().reference || {},
    skill,
    onActivity,
    onlyChunkIds
  });
}

/**
 * 参考资料上传后的落盘位置：data/uploads/references/<documentId><ext>。
 * 路径记在文档的 ingest_report 里，目录树则单独存 reference_folders。
 */
const REFERENCE_UPLOAD_DIRECTORY = join("uploads", "references");
const REFERENCE_FOLDER_MAX_NAME = 120;
const REFERENCE_FOLDER_INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/u;

function referenceFilePath(documentId, extension = "") {
  return join(DATA_ROOT, REFERENCE_UPLOAD_DIRECTORY, `${documentId}${extension}`);
}

function referenceRelativePath(documentId, extension = "") {
  return `${REFERENCE_UPLOAD_DIRECTORY}/${documentId}${extension}`.replace(/\\/gu, "/");
}

/**
 * 把请求体流式写到磁盘。
 *
 * 200MB 的资料不能先读进内存再 base64（浏览器实测 14 倍膨胀，服务端同样会顶满堆）：
 * 这里边收边写，超限立即中止并删掉半成品，返回 413 + 明说上限是多少。
 */
async function writeRequestBodyToFile(req, { path, limitBytes = MAX_REFERENCE_FILE_BYTES } = {}) {
  await mkdir(join(DATA_ROOT, REFERENCE_UPLOAD_DIRECTORY), { recursive: true });
  const handle = await open(path, "w");
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        await handle.close().catch(() => {});
        await rm(path, { force: true }).catch(() => {});
        const error = new Error(`单个参考资料不能超过 ${Math.round(limitBytes / 1024 / 1024)}MB（当前已超过，请压缩或拆分后再上传）`);
        error.statusCode = 413;
        throw error;
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return bytes;
}

function normalizeReferenceFolderName(value) {
  const name = String(value || "").trim().replace(/\s+/gu, " ");
  if (!name) throw Object.assign(new Error("文件夹名称不能为空"), { statusCode: 400 });
  if (name.length > REFERENCE_FOLDER_MAX_NAME) {
    throw Object.assign(new Error(`文件夹名称不能超过 ${REFERENCE_FOLDER_MAX_NAME} 个字符`), { statusCode: 400 });
  }
  if (name === "." || name === ".." || REFERENCE_FOLDER_INVALID_NAME.test(name)) {
    throw Object.assign(new Error("文件夹名称不能包含 / \\ : * ? \" < > | 等路径保留字符"), { statusCode: 400 });
  }
  return name;
}

async function referenceFoldersForProject(projectId) {
  return await listReferenceFolders({ projectId: String(projectId || "").trim() });
}

function referenceFolderDescendantIds(folders, rootId) {
  const ids = [];
  const queue = [String(rootId || "")];
  const seen = new Set();
  while (queue.length) {
    const parentId = queue.shift();
    for (const folder of folders) {
      if (String(folder.parentId || "") !== parentId) continue;
      if (seen.has(String(folder.id))) continue;
      seen.add(String(folder.id));
      ids.push(String(folder.id));
      queue.push(String(folder.id));
    }
  }
  return ids;
}

async function assertReferenceFolder(projectId, folderId) {
  const normalized = String(folderId || "").trim();
  if (!normalized) return null;
  const folder = await getReferenceFolder(normalized);
  if (!folder || folder.projectId !== String(projectId || "").trim()) {
    throw Object.assign(new Error("文件夹不存在或不属于当前项目"), { statusCode: 404 });
  }
  return folder;
}

async function assertReferenceFolderNameAvailable({ projectId, parentId = "", name, exceptId = "" }) {
  const normalizedParent = String(parentId || "").trim();
  await assertReferenceFolder(projectId, normalizedParent);
  const siblings = (await referenceFoldersForProject(projectId))
    .filter((folder) => String(folder.parentId || "") === normalizedParent && String(folder.id) !== String(exceptId || ""));
  const key = normalizeReferenceFolderName(name).toLocaleLowerCase("zh-CN");
  if (siblings.some((folder) => String(folder.name || "").toLocaleLowerCase("zh-CN") === key)) {
    throw Object.assign(new Error("同一层已经有一个同名文件夹"), { statusCode: 409 });
  }
}

async function ensureReferenceFolderPath({ projectId, parentId = "", path = [] }) {
  const segments = (Array.isArray(path) ? path : String(path || "").split("/"))
    .map((segment) => String(segment || "").trim())
    .filter(Boolean);
  let currentParent = String(parentId || "").trim();
  await assertReferenceFolder(projectId, currentParent);
  const folders = await referenceFoldersForProject(projectId);
  for (const raw of segments) {
    const name = normalizeReferenceFolderName(raw);
    let folder = folders.find((item) => String(item.parentId || "") === currentParent
      && String(item.name || "").toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"));
    if (!folder) {
      folder = await saveReferenceFolder({ projectId, parentId: currentParent, name });
      folders.push(folder);
    }
    currentParent = folder.id;
  }
  return { folderId: currentParent, folders };
}

async function referenceFolderScopeIds(projectId, folderId, { recursive = false } = {}) {
  const rootId = String(folderId || "").trim();
  await assertReferenceFolder(projectId, rootId);
  const folders = await referenceFoldersForProject(projectId);
  const descendants = referenceFolderDescendantIds(folders, rootId);
  return recursive ? [rootId, ...descendants] : [rootId];
}

async function deleteReferenceDocumentCompletely(documentId) {
  const document = await getReferenceDocument(documentId);
  const removed = await deleteReferenceDocument(documentId);
  if (!removed) return false;
  const sourcePath = String(document?.ingestReport?.sourcePath || "");
  if (sourcePath.startsWith(`${REFERENCE_UPLOAD_DIRECTORY}/`) && !sourcePath.includes("..")) {
    await rm(join(DATA_ROOT, sourcePath), { force: true }).catch(() => {});
  }
  return true;
}

async function describeReferenceDocumentById(document) {
  const { items } = await listReferenceChunks({ documentId: document.id, limit: 200 });
  const text = items
    .slice()
    .sort((left, right) => (Number(left.ordinal) || 0) - (Number(right.ordinal) || 0))
    .map((chunk) => String(chunk.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 6_000);
  if (!text) throw new Error("这份资料没有可读正文，无法生成描述");
  const description = await describeReferenceWithModel({ name: document.name, kind: document.kind, text });
  const updated = await updateReferenceDocument(document.id, {
    ingestReport: { ...(document.ingestReport || {}), description, describedAt: new Date().toISOString() }
  });
  referenceIndex.invalidate(document.projectId);
  return { description, document: updated };
}

/**
 * 参考资料导入：解析 → 分块 → 向量化 → 入库。扫描页与内嵌图片交给模型识图。
 *
 * 0 个片段是合法结果：用户选「只读文字」时，一份纯扫描件确实解析不出正文——
 * 这时资料照样入库（保留原文件与报告），只是暂时不可检索。
 */
async function ingestReferenceDocument({ document, vision = true, plan = null, onProgress = null }) {
  const filename = document.sourceFile || document.name || "资料";
  try {
    onProgress?.({ phase: "parsing", message: "正在解析参考资料", percent: 5 });
    const parsed = await extractReferenceFile({
      filename,
      path: join(DATA_ROOT, String(document.ingestReport?.sourcePath || "")),
      vision,
      onScannedPage: async ({ label, render, mediaType = "image/png" }) => {
        onProgress?.({ phase: "vision", message: `${label || "这一页"}：没有文字层，正在用模型识图`, percent: 20 });
        const image = await render();
        return await extractTextFromImageWithModel({ base64: image, mediaType });
      }
    });
    const chunks = chunkReferencePages(parsed.pages);
    if (!chunks.length && parsed.characters === 0) {
      onProgress?.({ phase: "indexing", message: vision ? "没有解析出可用文字内容" : "已按「只读文字」导入：这份资料没有文字层", percent: 90 });
    }
    const prepared = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      let embedding = null;
      try {
        embedding = (await embedSource(chunk.text))?.vector ?? null;
      } catch {
        embedding = null;
      }
      prepared.push({ ...chunk, embedding, risk: scanReferenceRisk(chunk.text), allowed: false, projectId: document.projectId });
      if (index % 20 === 0 || index === chunks.length - 1) {
        onProgress?.({ phase: "indexing", message: `正在向量化片段 ${index + 1} / ${chunks.length}`, percent: 30 + Math.round((index / chunks.length) * 60) });
      }
    }
    await replaceReferenceChunks(document.id, { projectId: document.projectId, chunks: prepared });
    const updated = await updateReferenceDocument(document.id, {
      status: "ready",
      sourceFormat: parsed.format,
      characters: parsed.characters,
      chunkCount: prepared.length,
      error: "",
      ingestReport: {
        ...(document.ingestReport || {}),
        format: parsed.format,
        stage: "ready",
        bytes: parsed.bytes,
        pages: parsed.pages.length,
        visionPages: parsed.pages.filter((page) => page.origin === "vision").length,
        visionImages: parsed.visionImages,
        skippedImages: parsed.skippedImages,
        visionSkippedByUser: parsed.visionSkippedByUser,
        visionEnabled: vision === true,
        plan,
        riskChunks: prepared.filter((chunk) => chunk.risk).length
      }
    });
    referenceIndex.invalidate(document.projectId);
    return updated;
  } catch (error) {
    await updateReferenceDocument(document.id, { status: "failed", error: String(error.message || error).slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/** 预扫结果直接写进文档报告，用于进度显示与导入统计。 */
async function saveReferencePlan(document, plan, stage) {
  return await updateReferenceDocument(document.id, {
    ingestReport: { ...(document.ingestReport || {}), plan, stage, bytes: plan.bytes }
  });
}

/** 同一份资料只能有一个写回者：覆盖重导时排队，旧任务不能把新结果覆盖掉。 */
const referenceIngestQueues = new Map();

function enqueueReferenceIngest({ taskId, documentId, visionMode = "all", autoScan = false }) {
  const previous = referenceIngestQueues.get(String(documentId)) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => runReferenceIngestInBackground({ taskId, documentId, visionMode, autoScan }))
    .catch((error) => console.error("[Kami] 参考资料导入失败", error))
    .finally(() => {
      if (referenceIngestQueues.get(String(documentId)) === next) referenceIngestQueues.delete(String(documentId));
    });
  referenceIngestQueues.set(String(documentId), next);
  return next;
}

/**
 * 上传参考资料的公共入口：落盘 → 建/复用文档记录 → 起后台任务（预扫 + 入库）。
 *
 * 原始字节入口边收边写（200MB 不进内存）；JSON 入口是给脚本用的，解出来的字节也统一
 * 落到同一位置，后续解析/重试/删除都只认这份存档。
 */
async function startReferenceUpload({ body, params, req }) {
  const read = (key) => String(body?.[key] ?? params?.get(key) ?? "").trim();
  const projectId = read("projectId");
  if (!projectId) throw Object.assign(new Error("请先选择项目"), { statusCode: 400 });
  const filename = read("filename");
  if (!filename) throw Object.assign(new Error("缺少文件名"), { statusCode: 400 });
  const folderId = read("folderId");
  await assertReferenceFolder(projectId, folderId);
  const extension = extname(filename).toLowerCase();
  const existing = (await listReferenceDocuments({ projectId, folderIds: [folderId], limit: 0 })).items
    .find((item) => String(item.sourceFile || "").toLocaleLowerCase("zh-CN") === filename.toLocaleLowerCase("zh-CN"));
  const document = existing
    ? await updateReferenceDocument(existing.id, {
      libraryId: read("libraryId"),
      folderId,
      name: read("name") || filename.replace(/\.[^.]+$/u, ""),
      kind: read("kind") || existing.kind || "other",
      contentType: read("contentType"),
      domain: read("domain"),
      sourceFile: filename,
      sourceFormat: "",
      characters: 0,
      chunkCount: 0,
      status: "indexing",
      error: "",
      ingestReport: null
    })
    : await saveReferenceDocument({
      projectId,
      libraryId: read("libraryId"),
      folderId,
      name: read("name") || filename.replace(/\.[^.]+$/u, ""),
      kind: read("kind") || "other",
      contentType: read("contentType"),
      domain: read("domain"),
      sourceFile: filename,
      sourceFormat: "",
      status: "indexing"
    });
  const absolute = referenceFilePath(document.id, extension);
  let bytes = 0;
  try {
    if (body) {
      const buffer = Buffer.from(String(body.base64 || "").replace(/^data:[^;]+;base64,/u, ""), "base64");
      if (!buffer.length) throw Object.assign(new Error("文件内容为空"), { statusCode: 400 });
      if (buffer.length > MAX_REFERENCE_FILE_BYTES) {
        throw Object.assign(new Error(`单个参考资料不能超过 ${Math.round(MAX_REFERENCE_FILE_BYTES / 1024 / 1024)}MB`), { statusCode: 413 });
      }
      await mkdir(join(DATA_ROOT, REFERENCE_UPLOAD_DIRECTORY), { recursive: true });
      await writeFile(absolute, buffer);
      bytes = buffer.length;
    } else {
      bytes = await writeRequestBodyToFile(req, { path: absolute });
      if (!bytes) throw Object.assign(new Error("文件内容为空"), { statusCode: 400 });
    }
  } catch (error) {
    if (existing) await updateReferenceDocument(document.id, { status: "failed", error: String(error.message || error).slice(0, 500) }).catch(() => {});
    else await deleteReferenceDocument(document.id).catch(() => {});
    throw error;
  }
  if (existing) {
    await replaceReferenceChunks(document.id, { projectId, chunks: [] }).catch(() => {});
    referenceIndex.invalidate(projectId);
  }
  await updateReferenceDocument(document.id, {
    ingestReport: { sourcePath: referenceRelativePath(document.id, extension), bytes, stage: "planning" }
  });
  const task = await createBackgroundTask({
    type: "reference_ingest",
    title: `参考资料导入：${filename}`,
    locale: ACTIVE_LOCALES[0],
    projectId,
    progress: { phase: "queued", message: "等待预扫", percent: 1 }
  });
  const rawVision = body?.vision ?? params?.get("vision");
  const visionMode = String(rawVision).trim().toLowerCase() === "none" || rawVision === false ? "none" : "all";
  const rawAutoScan = body?.autoScan ?? params?.get("autoScan");
  const autoScan = !(rawAutoScan === false || ["0", "false", "off", "no"].includes(String(rawAutoScan ?? "").trim().toLowerCase()));
  enqueueReferenceIngest({ taskId: task.id, documentId: document.id, visionMode, autoScan });
  return { taskId: task.id, backgroundTaskId: task.id, documentId: document.id, filename, bytes, folderId, visionMode, autoScan, replaced: Boolean(existing) };
}

async function runReferenceIngestInBackground({ taskId, documentId, visionMode = "all", autoScan = false }) {
  const control = beginBackgroundRun(taskId);
  try {
    const task = await getBackgroundTask(taskId);
    if (!task || task.status !== "in_progress") return;
    let document = await getReferenceDocument(documentId);
    if (!document) throw new Error("资料记录已不存在");
    let plan = document.ingestReport?.plan || null;
    if (!plan) {
      await updateBackgroundTaskProgress(taskId, { progress: { phase: "planning", message: "正在预扫页数与图片张数", percent: 3, completed: 0, total: 0 } });
      plan = await planReferenceExtraction({ filename: document.sourceFile || document.name, path: join(DATA_ROOT, String(document.ingestReport?.sourcePath || "")) });
      document = await saveReferencePlan(document, plan, "planning");
    }
    const vision = visionMode !== "none";
    await updateBackgroundTaskProgress(taskId, {
      progress: {
        phase: "parsing",
        message: vision
          ? `预扫完成：${plan.pages} 页 / ${plan.images} 张图，约 ${plan.estimatedVisionCalls} 次识图`
          : `预扫完成：${plan.pages} 页，仅读取文字层`,
        percent: 5,
        completed: 0,
        total: Math.max(0, vision ? plan.estimatedVisionCalls : plan.pages)
      }
    });
    document = await updateReferenceDocument(document.id, { ingestReport: { ...(document.ingestReport || {}), stage: "parsing" } });
    const ingested = await ingestReferenceDocument({
      document,
      vision,
      plan,
      onProgress: (update) => {
        if (control.cancelRequested) throw cancellationError();
        updateBackgroundTaskProgress(taskId, { progress: update }).catch(() => {});
      }
    });
    let autoScanError = "";
    if (autoScan) {
      if (!ingested.chunkCount) {
        autoScanError = "没有可读正文，已跳过资料说明";
      } else {
        await updateBackgroundTaskProgress(taskId, {
          progress: { phase: "describing", message: "正在生成资料说明", percent: 96, completed: ingested.chunkCount, total: ingested.chunkCount }
        });
        try {
          const latest = await getReferenceDocument(documentId);
          if (latest) await describeReferenceDocumentById(latest);
        } catch (error) {
          autoScanError = String(error.message || error);
        }
      }
    }
    const completedMessage = ingested.chunkCount
      ? `参考资料已就绪：${ingested.chunkCount} 个片段${autoScan ? autoScanError ? ` · 自动扫描：${autoScanError}` : " · 已生成资料说明" : ""}`
      : `资料已保存：只读文字模式下没有可检索正文${autoScanError ? ` · ${autoScanError}` : ""}`;
    await updateBackgroundTaskProgress(taskId, {
      status: "completed",
      progress: {
        phase: "completed",
        message: completedMessage,
        percent: 100, completed: ingested.chunkCount, total: ingested.chunkCount
      },
      payload: { documentId: ingested.id, name: ingested.name, chunkCount: ingested.chunkCount, characters: ingested.characters, autoScan, autoScanError }
    });
  } catch (error) {
    const cancelled = isCancellation(error);
    await updateBackgroundTaskProgress(taskId, {
      status: cancelled ? "needs_attention" : "failed",
      progress: { phase: cancelled ? "cancelled" : "failed", message: error.message, percent: 100 },
      payload: { error: error.message }
    }).catch(() => {});
  } finally {
    endBackgroundRun(taskId, control);
  }
}

async function runReferenceDescribeBatchInBackground({ taskId, documents }) {
  const control = beginBackgroundRun(taskId);
  const summary = { scanned: 0, skipped: 0, failed: 0, failures: [] };
  try {
    for (let index = 0; index < documents.length; index += 1) {
      if (control.cancelRequested) throw cancellationError("已按用户要求中断资料 AI 扫描");
      const document = documents[index];
      try {
        await describeReferenceDocumentById(document);
        summary.scanned += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({ id: document.id, name: document.name, error: String(error.message || error) });
      }
      await updateBackgroundTaskProgress(taskId, {
        progress: {
          phase: "describing",
          message: `AI 扫描：${index + 1} / ${documents.length}（成功 ${summary.scanned}，失败 ${summary.failed}）`,
          percent: Math.round(((index + 1) / documents.length) * 100),
          completed: index + 1,
          total: documents.length
        }
      });
    }
    await updateBackgroundTaskProgress(taskId, {
      status: summary.scanned || summary.skipped ? "completed" : "failed",
      progress: {
        phase: summary.scanned || summary.skipped ? "completed" : "failed",
        message: `AI 扫描完成：成功 ${summary.scanned}，失败 ${summary.failed}`,
        percent: 100,
        completed: documents.length,
        total: documents.length
      },
      payload: summary
    });
  } catch (error) {
    await updateBackgroundTaskProgress(taskId, {
      status: "needs_attention",
      progress: { phase: "cancelled", message: error.message, percent: 100 },
      payload: { ...summary, error: error.message }
    }).catch(() => {});
  } finally {
    endBackgroundRun(taskId, control);
  }
}

async function runReferenceFolderDeleteInBackground({ taskId, folder }) {
  const control = beginBackgroundRun(taskId);
  try {
    const folders = await referenceFoldersForProject(folder.projectId);
    const folderIds = [folder.id, ...referenceFolderDescendantIds(folders, folder.id)];
    const { items: documents } = await listReferenceDocuments({
      projectId: folder.projectId,
      folderIds,
      limit: 0
    });
    const failures = [];
    for (let index = 0; index < documents.length; index += 1) {
      if (control.cancelRequested) throw cancellationError("已按用户要求中断目录删除");
      const document = documents[index];
      try {
        await deleteReferenceDocumentCompletely(document.id);
      } catch (error) {
        failures.push({ id: document.id, name: document.name, error: String(error.message || error) });
      }
      await updateBackgroundTaskProgress(taskId, {
        progress: {
          phase: "deleting",
          message: `正在删除资料：${index + 1} / ${documents.length}`,
          percent: Math.round(((index + 1) / Math.max(1, documents.length + folderIds.length)) * 100),
          completed: index + 1,
          total: documents.length + folderIds.length
        }
      });
    }
    if (failures.length) {
      await updateBackgroundTaskProgress(taskId, {
        status: "needs_attention",
        progress: {
          phase: "delete_failed",
          message: `目录删除未完成：${failures.length} 份资料删除失败`,
          percent: 100,
          completed: documents.length - failures.length,
          total: documents.length + folderIds.length
        },
        payload: { folderId: folder.id, failures }
      });
      return;
    }
    const byId = new Map(folders.map((item) => [item.id, item]));
    const depth = (item) => {
      let value = 0;
      let current = item;
      while (current?.parentId && byId.has(current.parentId)) {
        value += 1;
        current = byId.get(current.parentId);
      }
      return value;
    };
    for (const target of folders.filter((item) => folderIds.includes(item.id)).sort((left, right) => depth(right) - depth(left))) {
      await deleteReferenceFolder(target.id);
    }
    referenceIndex.invalidate(folder.projectId);
    await updateBackgroundTaskProgress(taskId, {
      status: "completed",
      progress: {
        phase: "completed",
        message: `已删除文件夹与 ${documents.length} 份资料`,
        percent: 100,
        completed: documents.length + folderIds.length,
        total: documents.length + folderIds.length
      },
      payload: { folderId: folder.id, deletedDocuments: documents.length, deletedFolders: folderIds.length }
    });
  } catch (error) {
    await updateBackgroundTaskProgress(taskId, {
      status: "needs_attention",
      progress: { phase: "cancelled", message: error.message, percent: 100 },
      payload: { folderId: folder.id, error: error.message }
    }).catch(() => {});
  } finally {
    endBackgroundRun(taskId, control);
  }
}

function learningScope({ locale, contentType = "general", domain = "general", project = "default" }) {
  return { locale: assertLocale(locale), contentType: String(contentType || "general"), domain: String(domain || "general"), project: String(project || "default") };
}

/** 学习中心的"全部"：把该维度整维度放开（存储层用空串表示"不按这一维过滤"）。 */
function learningScopeAll(value) {
  return String(value || "").trim().toLowerCase() === "all";
}

function learningScopeQuery(scope) {
  return {
    ...scope,
    contentType: learningScopeAll(scope.contentType) ? "" : scope.contentType,
    domain: learningScopeAll(scope.domain) ? "" : scope.domain
  };
}

async function ensureChampionTranslationSkill(scope) {
  const template = createDefaultTranslationSkill({ scope });
  const runtimeDefault = {
    ...scope,
    id: template.id,
    name: template.name,
    description: template.description,
    changeReason: template.changeReason,
    version: template.version,
    status: "champion",
    strategy: template.strategy,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    evidenceIds: [],
    metrics: {}
  };
  try {
    const [champion] = await listTranslationSkills({ ...scope, status: "champion", limit: 1 });
    if (champion) return champion;
    const { id: _runtimeId, ...persistableDefault } = runtimeDefault;
    return await saveTranslationSkill(persistableDefault);
  } catch (error) {
    // Learning storage is observational infrastructure. A temporary Directus
    // failure must never take the production translation path down with it.
    return { ...runtimeDefault, persistenceStatus: "unavailable", persistenceError: error.message };
  }
}

function assertTrajectoryBinding(existing, { locale, source, contentType, domain, project = "default", batchId = "" }) {
  if (!existing) {
    const error = new Error("未找到对应的学习轨迹");
    error.statusCode = 404;
    throw error;
  }
  const sameScope = existing.locale === locale
    && String(existing.contentType || "general") === String(contentType || "general")
    && String(existing.domain || "general") === String(domain || "general")
    && String(existing.project || "default") === String(project || "default");
  const sameSource = String(existing.source || "").trim() === String(source || "").trim();
  const sameBatch = !batchId || !existing.batchId || String(existing.batchId) === String(batchId);
  if (!sameScope || !sameSource || !sameBatch) {
    const error = new Error("学习轨迹与当前原文、语种或业务范围不一致，已拒绝写入");
    error.statusCode = 409;
    throw error;
  }
  return existing;
}

function trajectoryMetricsFromIssues(issues = [], score = null, matches = []) {
  const required = matches.filter((item) => item.mode === "exact" && !item.scopeMismatch);
  const missing = new Set(issues.filter((item) => item.type === "required_term").map((item) => item.message));
  return {
    qaScore: Number.isFinite(score) ? score : null,
    hardErrorCount: issues.filter((item) => item.severity === "error").length,
    requiredTermTotal: required.length,
    requiredTermHits: Math.max(0, required.length - missing.size)
  };
}

function trajectoryToEvaluationSample(trajectory, { variant = "champion" } = {}) {
  const metrics = variant === "challenger" ? (trajectory.qaAfter || {}) : (trajectory.qaBefore || trajectory.qaAfter || {});
  const human = trajectory.humanDecision || {};
  const latency = (trajectory.events || []).findLast?.((item) => Number.isFinite(Number(item.latencyMs)))?.latencyMs;
  return {
    caseId: trajectory.id,
    scope: learningScope(trajectory),
    requiredTermHits: Number(metrics.requiredTermHits) || 0,
    requiredTermTotal: Number(metrics.requiredTermTotal) || 0,
    hardErrorCount: Number(metrics.hardErrorCount) || 0,
    qaScore: Number.isFinite(Number(metrics.qaScore)) ? Number(metrics.qaScore) : 0,
    humanEditDistance: Number.isFinite(Number(human.editDistance)) ? Number(human.editDistance) : 0,
    humanAccepted: human.accepted === true || trajectory.status === "completed",
    cost: Number.isFinite(Number(trajectory.costUsd)) ? Number(trajectory.costUsd) : undefined,
    latencyMs: Number(latency || 0)
  };
}

function learningEvaluationUiReport(result) {
  const requireCost = result.appliedGuardrails?.requireCost
    ?? result.gates?.some((item) => item.id === "cost")
    ?? false;
  const costBasis = requireCost
    ? "模型调用成本已计量，并参与本次成本回退门禁。"
    : "本次未启用成本门禁（requireCost=false）；成本即使可见也不影响晋升结论。";
  return {
    promotable: result.promotable,
    status: result.status,
    conclusion: result.reportZh,
    gates: result.gates,
    guardrails: result.appliedGuardrails || {},
    evaluationBasis: `同一人工批准留出集上的「生效版本 / 候选版本」隔离重跑；重跑前剔除与留出原文同源的翻译记忆、QA 案例和风格/画像正反例，防止标准答案泄漏进评测上下文；人工采纳率为相对人工终稿的自动近似指标，不冒充新增人工投票；${costBasis}`,
    metrics: [
      { key: "termAccuracy", label: "强制术语正确率", unit: "%", higherIsBetter: true, champion: result.championMetrics.mandatoryTermAccuracy, candidate: result.challengerMetrics.mandatoryTermAccuracy, delta: result.deltas.mandatoryTermAccuracy },
      { key: "hardErrors", label: "硬错误数", unit: "", higherIsBetter: false, champion: result.championMetrics.hardErrorCount, candidate: result.challengerMetrics.hardErrorCount, delta: result.deltas.hardErrorCount },
      { key: "qaScore", label: "AIQA 平均分", unit: "分", higherIsBetter: true, champion: result.championMetrics.qaScore, candidate: result.challengerMetrics.qaScore, delta: result.deltas.qaScore },
      { key: "editDistance", label: "人工编辑距离", unit: "%", higherIsBetter: false, champion: result.championMetrics.humanEditDistance, candidate: result.challengerMetrics.humanEditDistance, delta: result.deltas.humanEditDistance },
      { key: "acceptanceRate", label: "人工采纳率", unit: "%", higherIsBetter: true, champion: result.championMetrics.humanAcceptanceRate, candidate: result.challengerMetrics.humanAcceptanceRate, delta: result.deltas.humanAcceptanceRate }
    ]
  };
}

function assertCurrentCandidate(candidate, currentChampion, evaluation = null, { requireEvaluation = false } = {}) {
  const state = validateCandidatePromotionState({ candidate, currentChampion, evaluation, requireEvaluation });
  if (!state.valid) {
    const error = new Error(state.reasons.join("；"));
    error.statusCode = 409;
    throw error;
  }
  return state;
}

/**
 * 读取 JSON 请求体。
 *
 * `limitBytes` 默认 15MB；双语资产 / 人工 TM 的预检要把多个文件按 base64 塞进
 * 一个请求（base64 会放大约 33%），所以这两条路由给更大的额度。
 * 超限时先把剩余请求读完再抛错：直接掐断连接会让浏览器只看到
 * "Failed to fetch"，用户根本看不到"文件太大"这句话。
 */
async function readJsonBody(req, { limitBytes = MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  let overflowed = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      overflowed = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflowed) {
    const megabytes = Math.round(limitBytes / (1024 * 1024));
    const error = new Error(`请求内容超过 ${megabytes}MB 限制，请减少文件数量或改用更小的文件`);
    error.statusCode = 413;
    throw error;
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求 JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

/**
 * 读取原始字节请求体（文件直接当 body 发，不走 JSON + base64）。
 *
 * base64 会把体积放大 1/3，而且浏览器要先在内存里拼出整份 base64 字符串：
 * 实测 20MB 的文件就能把渲染进程推到 ~280MB，大一点的资料直接把页面顶成
 * "Out of Memory"。原始字节上传既不吃浏览器内存，也不吃 1/3 的体积。
 */
async function readRawBody(req, { limitBytes = IMPORT_FILE_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  let overflowed = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      overflowed = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflowed) {
    const error = new Error(`单个参考资料不能超过 ${Math.round(limitBytes / 1024 / 1024)}MB`);
    error.statusCode = 413;
    throw error;
  }
  return Buffer.concat(chunks);
}

function readWorkbenchSessionId(body) {
  const id = String(body?.id || "").trim();
  if (!WORKBENCH_SESSION_ID_PATTERN.test(id)) {
    const error = new Error("工作台页面标识无效");
    error.statusCode = 400;
    throw error;
  }
  return id;
}

async function classify(body) {
  // 表格自带的"位置/描述"列是比正文更强的用途信号，优先于文本启发式。
  const { descriptor, location } = descriptorFromContext(body.neighborContext);
  const heuristic = classifyContent(body.text, body.hint, { descriptor, location });
  if (!body.useModel || heuristic.source === "manual" || heuristic.confidence >= 0.86) return heuristic;
  try {
    const model = await classifyWithModel(body.text, { descriptor, location });
    if (!Object.hasOwn(CONTENT_TYPES, model.contentType)) throw new Error("模型返回不支持的内容类型");
    return {
      ...model,
      contentTags: inferContentTags(body.text, model.contentType, { descriptor, location })
    };
  } catch (error) {
    return { ...heuristic, fallbackReason: error.message };
  }
}

/**
 * 界面上「业务领域」现在可以是 auto，但写入与检索都需要一个具体值：
 * 存下 "auto" 会污染作用域，让这条资产永远匹配不上任何真实领域。
 * 所有入口统一经过这里落到具体领域。
 */
function concreteDomain(value, { text = "", contentType = "general" } = {}) {
  return resolveDomain(text, value, { contentType }).domain;
}

/** Load only enabled term libraries for a project and decorate each term with
 * the library metadata that is shown to the model and used for conflict order.
 * A project id is an isolation boundary: an unassigned/disabled library entry
 * must not leak into another project's match candidates. */
/**
 * 项目资产（术语库）缓存：一次 5,800+ 条术语约 285ms / 2.6MB，而翻译、QA、导出、
 * 批次详情每个请求都要它。术语写入会计入代际 token，写入后立即失效；TTL 只兜底
 * 「绕过工作台直接改 Directus」的情况。
 */
const projectAssetsCache = createTokenCache({ ttlMs: 30_000 });

async function getProjectAssets(locale, projectId = "") {
  const key = `${locale}\u0000${String(projectId || "")}`;
  return projectAssetsCache.get(key, getAssetGenerationToken(), () => loadProjectAssets(locale, projectId));
}

/**
 * 翻译主路径的术语匹配交给 worker：5,800+ 条术语、长句滑窗一次要数秒，
 * 放在主线程会让批次进度、/api/health 和 UI 轮询全部排队。
 * worker 失败/超时时回退同步匹配，保证译文不受影响。
 */
const matcherPool = createMatcherPool();

async function matchTermsForTranslation(text, assets, options) {
  try {
    return await matcherPool.match(text, assets, options);
  } catch (error) {
    console.warn(`[Kami] 术语匹配 worker 失败，回退同步：${error.message}`);
    return matchTerms(text, assets, options);
  }
}

async function loadProjectAssets(locale, projectId = "") {
  const normalizedProjectId = String(projectId || "").trim();
  const assets = await getAssets(locale, { projectId: normalizedProjectId });
  if (!normalizedProjectId) return { assets, libraries: [] };
  const libraries = await getResourceLibraries(normalizedProjectId, { kind: "term_base" });
  const byId = new Map(libraries.map((library) => [library.id, library]));
  return {
    libraries,
    assets: {
      ...assets,
      terms: (assets.terms || [])
        .map((term) => ({ ...term, library: byId.get(term.libraryId) || null }))
        .filter((term) => term.library?.enabled === true)
        .map((term) => ({
          ...term,
          libraryId: term.library.id,
          libraryName: term.library.name,
          libraryPriority: term.library.priority,
          libraryEnabled: term.library.enabled
        }))
    }
  };
}


async function runAiQaLoop({ contextPack, initialTranslation, matches, locale, contentType, domain, batchId, providedReferences = null, humanDecisions = [], passScore = 90, maxRevisions = 2, projectSettings = null, projectId = "" }) {
  const queryEmbedding = await embedSource(contextPack.source);
  let references = providedReferences;
  if (!references) {
    const libraries = projectId ? await getResourceLibraries(projectId, { kind: "translation_memory" }) : [];
    // 先粗筛候选再精排：整库打分在 8 万条时每段要十几秒（见 src/memory-index.mjs）。
    const memories = await getMemoryCandidates(locale, {
      projectId,
      source: contextPack.source,
      limit: getSettings().retrieval.candidatePoolSize,
      scopeFallback: true,
      contentType,
      domain,
      libraryIds: libraries.filter((library) => library.enabled).map((library) => library.id)
    });
    const librariesById = new Map(libraries.map((library) => [library.id, library]));
    const scopedMemories = memories.map((memory) => {
      const library = librariesById.get(memory.libraryId);
      return library ? { ...memory, libraryName: library.name, libraryRole: library.role, libraryPriority: library.priority, libraryEnabled: library.enabled } : memory;
    }).filter((memory) => !projectId || memory.libraryEnabled === true);
    references = rankTranslationMemories(contextPack.source, scopedMemories, {
      limit: 5,
      queryEmbedding,
      contentTags: contextPack.contentTags || [],
      projectId,
      entryId: contextPack.entryId || "",
      entryKey: contextPack.entryKey || "",
      catMinFuzzy: projectSettings?.tm?.catMinFuzzy || 60,
      llmMinRelevance: projectSettings?.tm?.llmMinRelevance || 60
    });
  }
  // 审校环节只能引用人工批准的译例；本系统自己 QA 通过后写回的机器译文另开一档，
  // 否则一次错误会在下一次审校里被当成"已批准"的规范。
  const { approved: approvedReferences, machineDrafts } = splitReferenceAuthority(references);
  const qaCases = contextPack.qaGuidance || [];
  let translation = initialTranslation;
  const deterministicIssues = (value) => [
    ...runQa({ source: contextPack.source, translation: value, matches, translationReferences: contextPack.translationReferences, locale, titleOverrides: getSettings().orthography.titleBrackets, contentType: contextPack.classification?.contentType || contentType || "general", registerPolicy: contextPack.styleProfile?.reviewRubric?.registerPolicy || null, projectSettings }),
    ...applyProjectQaPolicy(checkFactSchema({ schema: contextPack.factSchema || extractFactSchema({ source: contextPack.source }), translation: value, locale }), projectSettings || undefined)
  ];
  let hardIssues = deterministicIssues(translation);
  let aiIssues = [];
  let score = calculateQaScore({ hardIssues, aiIssues });
  let initialScore = score;
  let iterations = 0;
  let used = false;
  let fallbackReason = "";
  let termDecisions = [];

  try {
    const potentialIssues = hardIssues.filter((issue) => issue.type === "potential_term");
    if (potentialIssues.length) {
      try {
        const adjudication = await adjudicatePotentialTermsWithModel({ contextPack, translation, issues: potentialIssues });
        translation = adjudication.translation;
        termDecisions = adjudication.decisions;
      } catch {
        translation = await reviseTranslationWithQa({
          contextPack,
          translation,
          issues: potentialIssues.map((issue) => ({
            severity: "major",
            category: "terminology",
            message: `${issue.message}。请结合原文语义判断：若为同一概念则自然采用正式译法；若不是同一概念则保持原译，不得强行替换。`
          })),
          references,
          qaCases
        });
        termDecisions = potentialIssues.map((issue) => ({
          officialSource: issue.sourceTerm,
          matchedSource: issue.matchedSource,
          officialTarget: issue.targetTerm,
          decision: translation.includes(issue.targetTerm) ? "apply" : "not_applicable",
          reason: translation.includes(issue.targetTerm) ? "模型已在完整译文中采用正式术语" : "模型判断当前表达不应强制替换"
        }));
      }
      iterations += 1;
      hardIssues = deterministicIssues(translation);
      const notApplicable = new Set(termDecisions.filter((item) => item.decision === "not_applicable").map((item) => `${item.officialSource}\u0000${item.officialTarget}`));
      hardIssues = hardIssues.filter((issue) => issue.type !== "potential_term" || !notApplicable.has(`${issue.sourceTerm}\u0000${issue.targetTerm}`));
      for (const issue of hardIssues) {
        if (issue.type !== "potential_term") continue;
        const decision = termDecisions.find((item) => item.officialSource === issue.sourceTerm && item.officialTarget === issue.targetTerm);
        if (decision?.decision === "apply") {
          issue.severity = "error";
          issue.message = `术语裁决要求采用正式译法，但修订结果仍未生效：${issue.sourceTerm} → ${issue.targetTerm}`;
        }
      }
    }
    aiIssues = await evaluateTranslationWithModel({ contextPack, translation, references: approvedReferences, machineDrafts, qaCases });
    used = true;
    score = calculateQaScore({ hardIssues, aiIssues });
    initialScore = score;
    while (score < passScore && iterations < maxRevisions) {
      const actionable = [...hardIssues.map((issue) => ({ severity: "critical", category: issue.type, message: issue.message })), ...aiIssues];
      translation = await reviseTranslationWithQa({ contextPack, translation, issues: actionable, references, qaCases });
      iterations += 1;
      hardIssues = deterministicIssues(translation);
      aiIssues = await evaluateTranslationWithModel({ contextPack, translation, references: approvedReferences, machineDrafts, qaCases });
      score = calculateQaScore({ hardIssues, aiIssues });
    }
  } catch (error) {
    fallbackReason = error.message;
  }

  if (!used) score = null;
  const passed = used && score >= passScore && !hardIssues.some((issue) => issue.severity === "error");
  const issues = [...hardIssues, ...presentAiQaIssues(aiIssues)];
  const status = passed ? "passed" : "review";
  const provider = getProviderConfig();
  await saveQaRun({
    projectId, locale, contentType, domain, source: contextPack.source, initialTranslation, finalTranslation: translation,
    score, status, iterations, issues, references: [...references, ...qaCases.map((item) => ({ ...item, kind: "qa_case" }))], styleProfileId: contextPack.styleProfile?.id,
    model: provider.model, batchId, fallbackReason, termDecisions, humanDecisions
  });
  const translationChanged = translation !== initialTranslation;
  if (used && (translationChanged || !passed)) {
    await saveQaCase({
      projectId, project: projectId, locale, contentType, domain, source: contextPack.source, rejectedTranslation: initialTranslation,
      correctedTranslation: translation, issues, scoreBefore: initialScore, scoreAfter: score,
      status: passed ? "machine_verified" : "review"
    });
  }
  // 机器结果只留在 QA 运行、学习轨迹和待审批 QA 案例中。即使达到分数门槛，
  // 也不能直接进入正式 TM；正式翻译记忆只由 /api/feedback/accept 的人工采纳产生。
  return {
    translation, issues, score, status, iterations, used, fallbackReason, references, qaCases, termDecisions, humanDecisions,
    memoryCandidate: passed ? {
      source: contextPack.source,
      target: translation,
      qualityStatus: "candidate",
      requiresHumanApproval: true,
      provenance: iterations ? "aiqa-corrected" : "aiqa-passed"
    } : null
  };
}

function importStatistics(candidates) {
  return {
    candidates: candidates.length,
    ready: candidates.filter((item) => item.decision === "ready").length,
    review: candidates.filter((item) => item.decision === "review").length,
    excluded: candidates.filter((item) => item.decision === "excluded").length,
    existing: candidates.filter((item) => item.existing).length,
    locales: Object.fromEntries(ACTIVE_LOCALES.map((locale) => [locale, candidates.filter((item) => item.locale === locale).length]))
  };
}

function reportImportProgress(id, update) {
  if (!id) return;
  const previous = importProgress.get(id) || {};
  importProgress.set(id, { ...previous, ...update, id, updatedAt: new Date().toISOString() });
}

/** 把执行体内部的 0~100 进度映射到外层区间（多个阶段拼一条进度条时用）。 */
function scaleProgressReport(report, from, to) {
  return (update) => {
    const inner = Math.max(0, Math.min(100, Number(update?.percent) || 0));
    report({ ...update, percent: from + Math.round((inner / 100) * (to - from)) });
  };
}

/** 按条数报进度：写审核队列这类阶段没有内部百分比，只有"已完成 N / 共 M"。 */
function countProgressReport(report, from, to) {
  return (update) => {
    const total = Number(update?.total) || 0;
    const completed = Number(update?.completed) || 0;
    report({ ...update, percent: total ? from + Math.round((completed / total) * (to - from)) : from });
  };
}

function scheduleImportProgressCleanup(id) {
  if (!id) return;
  const timer = setTimeout(() => importProgress.delete(id), 5 * 60_000);
  timer.unref?.();
}

function validModelDecisionCount(decisions, expected) {
  if (!Array.isArray(decisions)) return 0;
  return new Set(decisions
    .map((item) => Number(item?.index))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < expected)).size;
}

async function reviewCandidateGroup(locale, candidates) {
  let decisions;
  try {
    decisions = await reviewTermCandidatesWithModel(locale, candidates);
  } catch (error) {
    if (candidates.length === 1) {
      return {
        candidates,
        reviewed: 0,
        missing: 1,
        retries: 0,
        failures: [error.message]
      };
    }
    const middle = Math.ceil(candidates.length / 2);
    const left = await reviewCandidateGroup(locale, candidates.slice(0, middle));
    const right = await reviewCandidateGroup(locale, candidates.slice(middle));
    return {
      candidates: [...left.candidates, ...right.candidates],
      reviewed: left.reviewed + right.reviewed,
      missing: left.missing + right.missing,
      retries: left.retries + right.retries + 1,
      failures: [...(left.failures || []), ...(right.failures || [])]
    };
  }
  const applied = validModelDecisionCount(decisions, candidates.length);
  if (applied < candidates.length && candidates.length > 1) {
    const middle = Math.ceil(candidates.length / 2);
    const left = await reviewCandidateGroup(locale, candidates.slice(0, middle));
    const right = await reviewCandidateGroup(locale, candidates.slice(middle));
    return {
      candidates: [...left.candidates, ...right.candidates],
      reviewed: left.reviewed + right.reviewed,
      missing: left.missing + right.missing,
      retries: left.retries + right.retries + 1,
      failures: [...(left.failures || []), ...(right.failures || [])]
    };
  }
  return {
    candidates: applyModelDecisions(candidates, decisions),
    reviewed: applied,
    missing: Math.max(0, candidates.length - applied),
    retries: 0,
    failures: []
  };
}

/**
 * AI 逐条清洗候选：判定 keep / rowKind / 句内术语，并就地回写候选。
 * 术语库页面的导入预览与双语资产导入的后台清洗共用这一段，避免两条路径漂移。
 */
async function cleanCandidatesWithModel(candidates, { onProgress = () => {}, percentRange = [30, 86], shouldCancel = null } = {}) {
  const [startPercent, endPercent] = percentRange;
  const cancelled = () => typeof shouldCancel === "function" && shouldCancel() === true;
  const locales = [...new Set(candidates.map((candidate) => candidate.locale))];
  // 上一轮已经判定过的候选带着 ai-cleaned 标记（见 persistImportCleaning）：不再重复调模型。
  const cachedCount = candidates.filter((candidate) => candidate.contentTypeSource === "ai-cleaned").length;
  const groups = locales.flatMap((locale) => {
    const indexes = candidates.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.locale === locale && !candidate.existing && candidate.contentTypeSource !== "ai-cleaned");
    const batches = [];
    for (let offset = 0; offset < indexes.length; offset += TERM_AI_BATCH_SIZE) {
      batches.push({ locale, indexes: indexes.slice(offset, offset + TERM_AI_BATCH_SIZE) });
    }
    return batches;
  });
  const ai = { requested: true, used: false, reviewed: 0, cached: cachedCount, total: candidates.length, missing: candidates.length - cachedCount, retries: 0, fallbackReason: "", batches: groups.length };
  if (!groups.length) return { candidates, ai };
  let completed = 0;
  onProgress({ phase: "ai-cleaning", message: `AI 并发清洗：0 / ${groups.length} 批${cachedCount ? `（复用 ${cachedCount} 条已判定结果）` : ""}`, percent: startPercent, completed, total: groups.length, concurrency: TERM_AI_CONCURRENCY });
  const results = await runTaskPool(groups, async ({ locale, indexes }) => {
    // 中断检查放在每个分块开头：并发里已经发出的请求自然跑完，剩下的立刻放弃。
    if (cancelled()) throw cancellationError("AI 清洗已按用户要求中断");
    const result = await reviewCandidateGroup(locale, indexes.map(({ candidate }) => candidate));
    indexes.forEach(({ index }, localIndex) => { candidates[index] = result.candidates[localIndex]; });
    return { reviewed: result.reviewed, missing: result.missing, retries: result.retries, failures: result.failures };
  }, {
    concurrency: TERM_AI_CONCURRENCY,
    onSettled: () => {
      completed += 1;
      const percent = startPercent + Math.round((completed / groups.length) * (endPercent - startPercent));
      onProgress({ phase: "ai-cleaning", message: `AI 并发清洗：${completed} / ${groups.length} 批`, percent, completed, total: groups.length, concurrency: TERM_AI_CONCURRENCY });
    }
  });
  const stopped = results.find((result) => result.status === "rejected" && isCancellation(result.reason));
  if (stopped) throw stopped.reason;
  const failures = [
    ...results.filter((result) => result.status === "rejected").map((result) => result.reason?.message || String(result.reason)),
    ...results.filter((result) => result.status === "fulfilled").flatMap((result) => result.value.failures || [])
  ];
  ai.reviewed = results.filter((result) => result.status === "fulfilled").reduce((sum, result) => sum + result.value.reviewed, 0);
  // 缺失只算这一轮真正送去判定的条目：复用缓存的不该被当成"模型没返回"。
  ai.missing = Math.max(0, (candidates.length - cachedCount) - ai.reviewed);
  ai.retries = results.filter((result) => result.status === "fulfilled").reduce((sum, result) => sum + result.value.retries, 0);
  ai.used = ai.reviewed > 0;
  const incomplete = ai.missing ? `模型仅返回 ${ai.reviewed}/${candidates.length - cachedCount} 条有效判断，缺失项保留安全规则并标记未覆盖` : "";
  ai.fallbackReason = [...new Set([...failures, incomplete].filter(Boolean))].join("；");
  return { candidates, ai };
}

/**
 * 双语资产导入的后台执行体。三种模式：
 *   - 术语表 + 关闭 AI 清洗：用本地规则分流，短词条进术语库、完整句段进主 TM，不调模型；
 *   - 术语表 + 打开 AI 清洗：先让模型逐条判定 keep / rowKind / 句内术语，再按判定分流；
 *   - 人工 TM：整批作为人工确认译文写入主 TM。
 *
 * 任务创建后立刻返回，审核队列写入、AI 清洗、入库、风格学习都在这条后台链路里，
 * 进度同时写进内存进度表（弹窗轮询）与后台任务（任务中心），关掉页面也会继续跑完。
 * 续跑（persistCandidates=false）复用已有批次，不重复写审核队列。
 */
async function runAssetImportInBackground({ taskId, projectId, batchId, filename, candidates, purpose, aiCleaning, styleEvidence, termLibraryId = "", tmLibraryId = "", persistCandidates = false }) {
  let progressWrites = Promise.resolve();
  const control = beginBackgroundRun(taskId);
  const shouldCancel = () => control.cancelRequested;
  let persistedBatchId = String(batchId || "");
  const reportImmediate = (update) => {
    reportImportProgress(taskId, { status: "running", ...update });
    progressWrites = progressWrites
      .then(() => updateBackgroundTaskProgress(taskId, { progress: update }))
      .catch(() => {});
  };
  const scaleReport = (from, to) => scaleProgressReport(reportImmediate, from, to);
  const countReport = (from, to) => countProgressReport(reportImmediate, from, to);
  // 批次号在写队列之后才是"真"的：catch 里也要用得到，所以声明在 try 之外。
  let batch = batchId;
  try {
    let working = candidates.map((candidate) => ({ ...candidate }));
    if (persistCandidates) {
      reportImmediate({ phase: "queueing", message: `正在写入审核队列：0 / ${working.length} 条候选`, percent: 1, completed: 0, total: working.length });
      const persisted = await saveImportPreview({
        batchId: batchId || undefined,
        projectId,
        filename,
        fileType: "multi",
        requestedLocale: "zh-CN",
        candidates: working,
        statistics: { rowsScanned: working.length, pairedRows: working.length },
        fileMode: "multi",
        ai: { used: false, requested: aiCleaning }
      }, { onProgress: countReport(1, 8) });
      batch = persisted.batchId;
      working = persisted.candidates;
      // 批次号一拿到就写进任务载荷：进程被杀（服务重启）时任务里也已经有批次号，
      // 重启后的「继续导入」才真的找得到这批候选。
      await updateBackgroundTaskProgress(taskId, { payload: { batchId: batch, filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false } }).catch(() => {});
      reportImmediate({ phase: "queued", message: `审核队列就绪（${working.length} 条），开始导入`, percent: 9, completed: 0, total: working.length });
    }
    reportImmediate({ phase: "preparing", message: aiCleaning ? "准备 AI 清洗" : "准备按表导入", percent: 10, completed: 0, total: working.length });
    let ai = { requested: aiCleaning, used: false, reviewed: 0, total: working.length };
    if (aiCleaning) {
      const cleaned = await cleanCandidatesWithModel(working, { onProgress: reportImmediate, percentRange: [12, 45], shouldCancel });
      ai = cleaned.ai;
      const nested = expandNestedTermCandidates(working);
      if (nested.length) working = [...working, ...nested];
      reportImmediate({ phase: "routing", message: `AI 清洗完成：保留 ${working.filter((candidate) => candidate.decision !== "excluded").length} / ${working.length} 条，开始分库`, percent: 46, completed: 0, total: working.length });
    }
    const routed = purpose === "tm"
      ? working.map((candidate) => ({ ...candidate, assetType: "memory", styleEvidence }))
      : working.map((candidate) => {
        // AI 判定优先；没有判定时回落到本地规则。明确选了"术语表"的表按表导入，
        // 只挡无效行，不因为条目偏长或带"："就改派到主 TM。
        const modelKind = ["term", "memory"].includes(candidate.modelRowKind) ? candidate.modelRowKind : "";
        const kind = modelKind || (candidate.assetType === "memory" ? "memory" : classifyImportRowKind(candidate));
        if (kind === "invalid") {
          return { ...candidate, assetType: "term", decision: "excluded", reasons: [...(candidate.reasons || []), "无效行：不是可入库的双语条目"] };
        }
        return { ...candidate, assetType: kind === "memory" ? "memory" : "term", styleEvidence };
      });
    if (aiCleaning) {
      // 清洗结论写回候选行（含本轮新产生的句内术语行）：续跑时只判定没有标记的条目，
      // 不会把已经洗过的整批重新送模型。
      reportImmediate({ phase: "saving-cleaning", message: `正在保存清洗结果：0 / ${routed.length} 条`, percent: 47, completed: 0, total: routed.length });
      const persistedCleaning = await persistImportCleaning(batch, { projectId, filename, candidates: routed });
      reportImmediate({ phase: "routing", message: `清洗结果已保存（${persistedCleaning} 条），开始分库`, percent: 49, completed: 0, total: routed.length });
    }
    const result = await commitTermImport(
      { projectId, batchId: batch, filename, candidates: routed, styleEvidence, termLibraryId, tmLibraryId },
      scaleReport(50, 92),
      shouldCancel
    );
    await progressWrites;
    const summary = result.summary;
    await updateBackgroundTaskProgress(taskId, {
      status: "completed",
      progress: {
        phase: "completed",
        message: `导入完成：术语 ${summary.terms} 条、主 TM ${summary.memories} 条、跳过 ${summary.skipped} 条`,
        percent: 100,
        completed: summary.imported,
        total: routed.length
      },
      payload: {
        batchId: batch || batchId,
        filename,
        purpose,
        aiCleaning,
        styleEvidence,
        termLibraryId,
        tmLibraryId,
        summary,
        ai: ai.used ? { used: true, reviewed: ai.reviewed, fallbackReason: ai.fallbackReason } : { used: false, requested: Boolean(aiCleaning) },
        skippedDetails: summary.skippedDetails || []
      }
    });
    reportImportProgress(taskId, { status: "completed", phase: "completed", message: "导入完成", percent: 100, completed: summary.imported, total: routed.length });
    console.log(`[Kami] 双语资产导入完成：${filename} · 术语 ${summary.terms} 条 · 主 TM ${summary.memories} 条 · 跳过 ${summary.skipped} 条`);
  } catch (error) {
    await progressWrites.catch(() => {});
    const cancelled = isCancellation(error);
    await updateBackgroundTaskProgress(taskId, {
      status: cancelled ? "needs_attention" : "failed",
      progress: {
        phase: cancelled ? "cancelled" : "failed",
        message: error.message,
        percent: cancelled ? undefined : 100,
        completed: 0,
        total: candidates.length
      },
      // 批次号可能是后台写队列时才拿到的：带上它，任务中心才能用「继续导入」补跑。
      payload: { batchId: batch || batchId, filename, purpose, aiCleaning, styleEvidence, error: error.message, resumable: Boolean(batch || batchId) }
    }).catch(() => {});
    reportImportProgress(taskId, { status: cancelled ? "needs_attention" : "failed", phase: cancelled ? "cancelled" : "failed", message: error.message, error: cancelled ? "" : error.message, percent: cancelled ? undefined : 100 });
    console.error(cancelled ? `[Kami] 双语资产导入已中断：${filename} · ${error.message}` : `[Kami] 双语资产导入失败：${filename} · ${error.message}`);
  } finally {
    endBackgroundRun(taskId);
    scheduleImportProgressCleanup(taskId);
  }
}

/**
 * 人工 TM 导入的后台执行体：先写主 TM 与风格学习，**成功之后**才写审计。
 *
 * 队列后置的理由：老的"先写 term_candidates"每次都把整份候选先落库，
 * 7 万条就是十几万次行写入的代价，而且任何失败（503、没建库、进程被杀）
 * 都会留下几万条 pending 垃圾。现在失败路径库里一行不写，
 * "继续导入"改读本地预检缓存（`data/runtime/tm-preview`，7 天）。
 */
async function runTmImportInBackground({ taskId, projectId, filename, batchId, candidates, styleEvidence, sourceFileType, tmLibraryId = "", requestedLocale = "zh-CN" }) {
  const auditBatchId = String(batchId || randomUUID());
  let progressWrites = Promise.resolve();
  const control = beginBackgroundRun(taskId);
  const shouldCancel = () => control.cancelRequested;
  const report = (update) => {
    reportImportProgress(taskId, { status: "running", ...update });
    progressWrites = progressWrites
      .then(() => updateBackgroundTaskProgress(taskId, { progress: update }))
      .catch(() => {});
  };
  try {
    // 批次号在建任务时就定下来，并立刻写进任务载荷：失败/重启后「继续导入」靠它找预检缓存。
    await updateBackgroundTaskProgress(taskId, { payload: { batchId: auditBatchId, filename, tmLibraryId, resumable: true } }).catch(() => {});
    report({ phase: "importing", message: `开始写入主 TM：共 ${candidates.length} 条`, percent: 6, completed: 0, total: candidates.length });
    const result = await commitTermImport(
      { projectId, batchId: auditBatchId, filename, candidates, styleEvidence, tmLibraryId },
      scaleProgressReport(report, 6, 90),
      shouldCancel,
      { skipQueueCompletion: true }
    );
    report({ phase: "auditing", message: "正在写导入审计", percent: 94, completed: candidates.length, total: candidates.length });
    await saveTmImportAudit({
      batchId: auditBatchId,
      filename,
      fileType: sourceFileType || "tm",
      projectId,
      requestedLocale,
      summary: result.summary,
      candidates,
      decisions: result.decisions
    });
    await releasePreviewCaches(auditBatchId);
    await progressWrites;
    const summary = result.summary;
    await updateBackgroundTaskProgress(taskId, {
      status: "completed",
      progress: {
        phase: "completed",
        message: `导入完成：术语 ${summary.terms} 条、主 TM ${summary.memories} 条、跳过 ${summary.skipped} 条`,
        percent: 100,
        completed: summary.imported,
        total: candidates.length
      },
      payload: {
        batchId: auditBatchId,
        filename,
        summary,
        skippedDetails: summary.skippedDetails || [],
        styleProfiles: (result.styleProfiles || []).length,
        resumable: false
      }
    });
    reportImportProgress(taskId, { status: "completed", phase: "completed", message: "导入完成", percent: 100, completed: summary.imported, total: candidates.length });
    console.log(`[Kami] 人工 TM 导入完成：${filename} · 主 TM ${summary.memories} 条 · 跳过 ${summary.skipped} 条`);
  } catch (error) {
    await progressWrites.catch(() => {});
    const cancelled = isCancellation(error);
    await updateBackgroundTaskProgress(taskId, {
      status: cancelled ? "needs_attention" : "failed",
      progress: {
        phase: cancelled ? "cancelled" : "failed",
        message: error.message,
        percent: cancelled ? undefined : 100,
        completed: 0,
        total: candidates.length
      },
      // 预检缓存留着：任务中心的「继续导入」用它重跑（记忆/证据按原文去重，不会写重）。
      payload: { batchId: auditBatchId, filename, error: error.message, resumable: true }
    }).catch(() => {});
    reportImportProgress(taskId, { status: cancelled ? "needs_attention" : "failed", phase: cancelled ? "cancelled" : "failed", message: error.message, error: cancelled ? "" : error.message, percent: cancelled ? undefined : 100 });
    console.error(cancelled ? `[Kami] 人工 TM 导入已中断：${filename} · ${error.message}` : `[Kami] 人工 TM 导入失败：${filename} · ${error.message}`);
  } finally {
    endBackgroundRun(taskId);
    scheduleImportProgressCleanup(taskId);
  }
}

/** 预检缓存只在导入成功后删除；失败时留着给「继续导入」重跑。 */
async function releasePreviewCaches(batchId) {
  for (const id of String(batchId || "").split(",").map((value) => value.trim()).filter(Boolean)) {
    await deletePreviewCache(id).catch(() => {});
  }
}

/**
 * 解析一次 TM 导入实际要写入的候选。
 *
 * 新流程：预检把候选留在服务端（`data/runtime/tm-preview`），前端只回传批次号
 * 与被取消勾选的序号，服务端读回来合成最终候选。8 万条候选约 49MB，
 * 走浏览器来回传既慢又会撞上请求体上限。
 * 兼容路径：请求体里直接带 `candidates`（老客户端、接口测试）时按原样使用。
 */
async function resolveTmImportCandidates(body = {}) {
  const deselectSet = (value) => new Set((Array.isArray(value) ? value : [])
    .map((item) => Math.trunc(Number(item)))
    .filter((item) => Number.isFinite(item) && item >= 0));
  const applySelection = (storedCandidates, deselected) => storedCandidates
    .map((candidate, index) => ({ ...candidate, selected: candidate?.selected !== false && !deselected.has(index) }));
  const batches = Array.isArray(body.batches) ? body.batches.filter((item) => item?.batchId) : [];
  if (batches.length) {
    const candidates = [];
    const batchIds = [];
    let sourceFileType = "";
    for (const batch of batches) {
      const batchId = String(batch.batchId);
      const stored = await readPreviewCandidates(batchId);
      if (!stored) return { candidates: [], error: "预检缓存已过期，请重新预检后再导入" };
      if (!sourceFileType && batch.sourceFileType) sourceFileType = String(batch.sourceFileType);
      candidates.push(...applySelection(stored, deselectSet(batch.deselected)));
      batchIds.push(batchId);
    }
    return { candidates, batchId: batchIds.join(","), sourceFileType };
  }
  if (body.batchId && !Array.isArray(body.candidates)) {
    const batchId = String(body.batchId);
    const stored = await readPreviewCandidates(batchId);
    if (!stored) return { candidates: [], error: "预检缓存已过期，请重新预检后再导入" };
    return {
      candidates: applySelection(stored, deselectSet(body.deselected)),
      batchId,
      sourceFileType: String(body.sourceFileType || "")
    };
  }
  if (Array.isArray(body.candidates) && body.candidates.length) {
    return {
      candidates: body.candidates.map((candidate) => ({ ...candidate, selected: candidate?.selected !== false })),
      batchId: String(body.batchId || ""),
      sourceFileType: String(body.sourceFileType || "")
    };
  }
  return { candidates: [], error: "TM 导入批次或候选无效" };
}

async function previewTermImport(body, onProgress = () => {}) {
  onProgress({ phase: "structure", message: "正在解析表格并识别日语列与简体中文列", percent: 5, completed: 0, total: 1 });
  const useModel = body.useModel !== false;
  const analyzeStructure = useModel ? (snapshot, requestedLocale) => analyzeTermTableStructureWithModel(snapshot, requestedLocale) : undefined;
  const extracted = await extractTermPairs(body, { analyzeStructure });
  onProgress({ phase: "assets", message: "正在读取简体中文术语库", percent: 24, completed: 1, total: 1 });
  let candidates = extracted.candidates.map((candidate) => classifyImportCandidate({ ...candidate, sourceFile: body.filename || "" }));
  const assetsByLocale = {};
  const locales = [...new Set(candidates.map((candidate) => candidate.locale))];
  await Promise.all(locales.map(async (locale) => { assetsByLocale[locale] = (await getProjectAssets(locale, body.projectId)).assets.terms; }));

  const ai = useModel
    ? (await cleanCandidatesWithModel(candidates, { onProgress })).ai
    : { requested: false, used: false, reviewed: 0, total: candidates.length, missing: candidates.length, retries: 0, fallbackReason: "" };
  const nestedTerms = expandNestedTermCandidates(candidates);
  candidates = markExistingTermCandidates([...candidates, ...nestedTerms], assetsByLocale);
  ai.nestedTerms = nestedTerms.length;
  ai.candidateTotal = candidates.length;
  extracted.candidates = candidates;
  extracted.projectId = String(body.projectId || "").trim();
  extracted.statistics = { ...extracted.statistics, ...importStatistics(candidates) };
  extracted.ai = ai;
  onProgress({ phase: "saving", message: "正在写入 Directus 审核队列", percent: 92, completed: 0, total: 1 });
  const saved = await saveImportPreview(extracted);
  onProgress({ phase: "completed", message: "识别与清洗完成", percent: 100, completed: 1, total: 1 });
  return { ...extracted, ...saved };
}

/** Local-only multi-file bilingual asset preflight.  It deliberately does not
 * call a model or write a candidate to the asset tables; the caller must send
 * the returned candidates to the commit endpoint after reviewing the defaults. */
async function previewBilingualAssets(body = {}) {
  const projectId = String(body.projectId || "").trim();
  if (!projectId || !(await getProject(projectId))) throw Object.assign(new Error("项目不存在"), { statusCode: 404 });
  const purpose = body.purpose === "tm" ? "tm" : "term";
  const files = Array.isArray(body.files) ? body.files.slice(0, 50) : [];
  if (!files.length) throw Object.assign(new Error("没有待预检的双语资产文件"), { statusCode: 400 });
  const previews = [];
  let candidates = [];
  for (const file of files) {
    const filename = String(file?.filename || "").trim();
    const encoded = String(file?.base64 || "").replace(/^data:[^;]+;base64,/u, "");
    if (!filename || !encoded) {
      previews.push({ filename, type: "unknown", entries: 0, anomalies: ["文件名或内容为空"], defaultPurpose: "tm" });
      continue;
    }
    try {
      const lower = filename.toLowerCase();
      let pairs;
      let type;
      let defaultPurpose = "tm";
      if (/\.(xliff|mqxliff)$/iu.test(lower)) {
        type = lower.endsWith(".mqxliff") ? "mqxliff" : "xliff";
        pairs = extractXliffPairs(Buffer.from(encoded, "base64"), filename);
      } else if (/\.(xlsx|csv)$/iu.test(lower)) {
        type = lower.endsWith(".csv") ? "csv" : "xlsx";
        const extracted = await extractTermPairs({ filename, base64: encoded, locale: "zh-CN" });
        defaultPurpose = extracted.fileMode === "glossary" ? "term_cleaning" : "tm";
        pairs = extracted.candidates.map((candidate) => ({
          entryId: candidate.entryId || "",
          source: candidate.source,
          target: candidate.target,
          note: candidate.note || "",
          sheetMode: candidate.sheetMode || "mixed",
          sourceRow: candidate.rowNumber || null,
          sheet: candidate.sheet || "",
          context: candidate.sheetModeReason || candidate.sheet || ""
        }));
      } else {
        previews.push({ filename, type: "unsupported", entries: 0, anomalies: ["仅支持 .xlsx、.csv、.xliff、.mqxliff"], defaultPurpose: "tm" });
        continue;
      }
      const fileCandidates = pairs.map((pair, index) => ({
        ...pair,
        locale: "zh-CN",
        assetType: defaultPurpose === "term_cleaning" ? "term" : "memory",
        purpose: defaultPurpose,
        styleEvidence: false,
        decision: "ready",
        selected: true,
        rowNumber: pair.sourceRow || index + 1,
        score: 1,
        contentType: "general",
        domain: "general",
        sourceFile: filename,
        sourceRow: pair.sourceRow || index + 1
      }));
      candidates.push(...fileCandidates);
      previews.push({
        filename,
        type,
        entries: fileCandidates.length,
        anomalies: fileCandidates.length ? [] : ["未找到完整双语条目"],
        defaultPurpose,
        defaults: { termCleanup: defaultPurpose === "term_cleaning", styleEvidence: false, tm: defaultPurpose === "tm" }
      });
    } catch (error) {
      previews.push({ filename, type: "invalid", entries: 0, anomalies: [error.message], defaultPurpose: "tm" });
    }
  }
  // 选"术语表"时预检就比对库内术语：弹窗上先讲清楚有多少条已存在、多少条与库内译法冲突，
  // 不必等导入完再在任务里发现被跳过。人工 TM 侧不做库内比对（主 TM 几千条带向量，
  // 预检阶段拉全库代价太高），它的重复在写入主 TM 时按条目身份 / 原文+译文处理。
  let duplicates = { existing: 0, conflict: 0 };
  if (purpose === "term") {
    const assets = (await getProjectAssets("zh-CN", projectId)).assets;
    // 按"选了术语表之后的本地分流结果"比对：混合表里的短词条同样会写进术语库，
    // 不能因为文件自己更像 TM 就漏报重复。
    candidates = markExistingTermCandidates(
      candidates.map((candidate) => (classifyImportRowKind(candidate) === "term" ? { ...candidate, assetType: "term" } : candidate)),
      { "zh-CN": assets.terms }
    );
    duplicates = {
      existing: candidates.filter((candidate) => candidate.existing).length,
      conflict: candidates.filter((candidate) => candidate.conflict).length
    };
    for (const file of previews) {
      const own = candidates.filter((candidate) => candidate.sourceFile === file.filename);
      const counts = { existing: own.filter((candidate) => candidate.existing).length, conflict: own.filter((candidate) => candidate.conflict).length };
      if (counts.existing || counts.conflict) file.duplicates = counts;
    }
  }
  return {
    batchId: randomUUID(),
    projectId,
    files: previews,
    candidates,
    duplicates,
    statistics: { files: previews.length, entries: candidates.length, anomalies: previews.filter((file) => file.anomalies?.length).length },
    write: { modelCalled: false, databaseWritten: false }
  };
}

async function trajectoriesForExternalReview(locale, projectId) {
  if (!projectId) return [];
  const scoped = await listLearningTrajectories({ locale, project: projectId, limit: 1_000 });
  if (projectId === "default") return scoped;
  // 旧版本把真实项目的轨迹错误写在 default 作用域。只在它关联的批次明确属于
  // 当前项目时兼容接回，不能仅凭相同原文把其他项目的历史轨迹捞进来。
  const legacy = await listLearningTrajectories({ locale, project: "default", limit: 1_000 });
  const runs = new Map();
  await Promise.all([...new Set(legacy.map((trajectory) => trajectory.batchId).filter(Boolean))].map(async (batchId) => {
    try { runs.set(batchId, await getBatchRun(batchId)); }
    catch { runs.set(batchId, null); }
  }));
  return [...scoped, ...legacy.filter((trajectory) => runs.get(trajectory.batchId)?.projectId === projectId)];
}

/**
 * 导入目标库校验：库必须存在、属于当前项目、类型匹配、且处于启用状态。
 * 不传 libraryId 时返回 null，调用方沿用原来的默认库口径。
 */
async function resolveImportLibrary(projectId, { libraryId = "", kind = "term_base" } = {}) {
  const requested = String(libraryId || "").trim();
  if (!requested) return null;
  const library = (await getResourceLibraries(projectId)).find((item) => item.id === requested);
  if (!library) throw Object.assign(new Error("选择的资源库不存在或不属于当前项目"), { statusCode: 400 });
  if (library.kind !== kind) {
    throw Object.assign(new Error(kind === "term_base" ? "选择的资源库不是术语库" : "选择的资源库不是翻译记忆库"), { statusCode: 400 });
  }
  if (library.enabled !== true) throw Object.assign(new Error(`「${library.name}」未启用，不能作为导入目标；请先在项目设置里启用`), { statusCode: 400 });
  return library;
}

/**
 * 库导出：术语库与 TM 各一套列定义，导出整个库（不受页面分页与搜索影响）。
 * 复用 batch_export 任务类型与 /api/export-tasks 下载链路，避免再加一种任务类型。
 */
async function buildLibraryExport({ kind, locale, libraryName = "库", items = [] }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(kind === "tm" ? "翻译记忆" : "术语库");
  const headers = kind === "tm"
    ? ["日语原文", "简体中文译文", "条目 ID", "状态", "来源文件", "行号", "来源", "更新时间"]
    : ["日语原文", "简体中文译法", "别名", "禁用译法", "注释", "语体", "强制级别", "来源", "更新时间"];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  const qualityLabels = { human_approved: "人工确认", machine_verified: "机器译文", provisional: "候选" };
  for (const item of items) {
    sheet.addRow(kind === "tm"
      ? [item.source, item.target, item.entryKey || "", qualityLabels[item.qualityStatus] || "候选", item.sourceFile || "", item.sourceRow ?? "", item.provenance || "", item.updatedAt || item.createdAt || ""]
      : [
        item.source, item.target,
        (item.aliases || []).join(", "), (item.forbidden || []).join(", "),
        item.note || "",
        (item.contentTypes || []).map((type) => CONTENT_TYPES[type]?.label || type).join(", "),
        item.enforcement || "", item.provenance || "", item.updatedAt || item.createdAt || ""
      ]);
  }
  for (const column of sheet.columns) column.width = 30;
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(libraryName).replace(/[\\/:*?"<>|]/gu, "_").slice(0, 60);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `${kind === "tm" ? "TM" : "术语库"}_${safeName}_${locale}_${stamp}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };
}

/**
 * 写入 TM / 术语。`options.skipQueueCompletion` 给"队列后置"的 TM 导入用：
 * 那些调用方没有先写 term_candidates（候选直接来自预检缓存），所以不能再去按
 * candidateId 回写队列状态，改由调用方在成功后写审计行（saveTmImportAudit）。
 */
async function commitTermImport(body, onProgress = null, shouldCancel = null, options = {}) {
  const skipQueueCompletion = options.skipQueueCompletion === true;
  if (!body.batchId || !Array.isArray(body.candidates)) {
    const error = new Error("导入批次或候选数据无效");
    error.statusCode = 400;
    throw error;
  }
  const report = (update) => {
    if (typeof onProgress === "function") onProgress(update);
  };
  const cancelled = () => typeof shouldCancel === "function" && shouldCancel() === true;
  const total = body.candidates.length;
  const projectId = String(body.projectId || "").trim();
  const projectLibraries = projectId ? await getResourceLibraries(projectId) : [];
  // 导入目标：调用方可以指定具体库（库页面行内导入），不指定时保持原来的默认口径。
  const requestedTermLibrary = String(body.termLibraryId || "").trim();
  const requestedTmLibrary = String(body.tmLibraryId || "").trim();
  const masterTm = requestedTmLibrary
    ? projectLibraries.find((library) => library.id === requestedTmLibrary)
    : projectLibraries.find((library) => library.kind === "translation_memory" && library.role === "master");
  const termLibrary = requestedTermLibrary
    ? projectLibraries.find((library) => library.id === requestedTermLibrary)
    : (projectLibraries.find((library) => library.kind === "term_base" && library.enabled) || projectLibraries.find((library) => library.kind === "term_base"));
  let done = 0;
  const imported = [];
  const skipped = [];
  const skipCounts = new Map();
  const recordSkip = (entry) => {
    // 跳过原因会写进任务记录并显示在界面上：长的（比如 Directus 报错）截断，避免把任务行撑爆。
    const reason = String(entry?.reason || "未知原因").slice(0, 120);
    skipCounts.set(reason, (skipCounts.get(reason) || 0) + 1);
    if (skipped.length < SKIPPED_DETAIL_LIMIT) skipped.push({ ...entry, reason });
  };
  const skippedTotal = () => [...skipCounts.values()].reduce((sum, count) => sum + count, 0);
  const decisions = [];
  const trajectoryLinks = [];
  const trajectoryLinkFailures = [];
  const trajectoryMatch = projectId
    ? linkExternalReviewTrajectories(
      body.candidates.map((candidate) => candidate?.assetType === "memory" && candidate?.selected !== false ? candidate : null),
      await trajectoriesForExternalReview("zh-CN", projectId)
    )
    : { links: [], unmatched: [], ambiguous: [], alreadyAccepted: [] };
  const trajectoryByCandidate = new Map(trajectoryMatch.links.map((link) => [link.candidateIndex, link]));
  const styleEvidenceByScope = new Map();
  // 库内术语只读一次：写成"每条候选拉一次整库"会在几千条导入时变成 O(n²) 的
  // 网络往返，正是上一版导入 5859 条要跑 8 分钟的原因。
  const termIndexByLocale = new Map();
  const loadTermIndex = async (locale) => {
    let index = termIndexByLocale.get(locale);
    if (index) return index;
    const terms = projectId ? (await getProjectAssets(locale, projectId)).assets.terms : [];
    index = { pairs: new Set(), sourcesWithTargets: new Map() };
    // 别名也进索引：库内条目的别名被当成新术语再导一次，同样是重复。
    const addTerm = (sourceText, target) => {
      const key = termMatchKey(sourceText);
      if (!key) return;
      const targetKey = termMatchKey(target);
      index.pairs.add(`${key}\u0000${targetKey}`);
      const targets = index.sourcesWithTargets.get(key) || [];
      if (!targets.some((item) => termMatchKey(item) === targetKey)) targets.push(target);
      index.sourcesWithTargets.set(key, targets);
    };
    for (const term of terms) {
      addTerm(term.source, term.target);
      for (const alias of term.aliases || []) addTerm(alias, term.target);
    }
    termIndexByLocale.set(locale, index);
    return index;
  };
  // 术语成批写入：逐条 POST 在几千条规模下同样拖慢整批。
  const pendingTerms = [];
  // 翻译记忆与风格证据同样成批写：逐条写时"每条都拉一次全项目证据"是平方级开销，
  // 一份 8 万行的过往译文按老实现根本跑不完。
  const pendingMemories = [];
  const pendingEvidence = [];
  const styleEvidenceIndexes = new Map();
  const styleEvidenceIndexFor = async (locale) => {
    if (!styleEvidenceIndexes.has(locale)) {
      styleEvidenceIndexes.set(locale, await loadStyleEvidenceIndex(locale, { projectId }));
    }
    return styleEvidenceIndexes.get(locale);
  };
  const flushEvidence = async () => {
    const batch = pendingEvidence.splice(0, pendingEvidence.length);
    if (!batch.length) return;
    const groups = new Map();
    for (const entry of batch) {
      const list = groups.get(entry.locale) || [];
      list.push(entry);
      groups.set(entry.locale, list);
    }
    for (const [locale, entries] of groups.entries()) {
      const index = await styleEvidenceIndexFor(locale);
      let saved = [];
      try {
        saved = await saveStyleEvidences(entries.map((entry) => entry.input), { index });
      } catch (error) {
        for (const entry of entries) recordSkip({ source: entry.input.source, locale, reason: `风格证据写入失败：${error.message}` });
        continue;
      }
      entries.forEach((entry, position) => {
        const result = saved[position];
        if (!result?.id) {
          recordSkip({ source: entry.input.source, locale, reason: result?.error || "风格证据写入失败" });
          return;
        }
        const scopeKey = `${locale}\u0000${entry.input.contentType}\u0000${entry.input.domain}`;
        const group = styleEvidenceByScope.get(scopeKey) || [];
        group.push({ ...entry.candidate, evidenceId: result.id });
        styleEvidenceByScope.set(scopeKey, group);
      });
    }
  };
  const flushMemories = async () => {
    const batch = pendingMemories.splice(0, pendingMemories.length);
    if (!batch.length) return;
    const groups = new Map();
    for (const entry of batch) {
      const list = groups.get(entry.locale) || [];
      list.push(entry);
      groups.set(entry.locale, list);
    }
    for (const [locale, entries] of groups.entries()) {
      let saved = [];
      try {
        saved = await saveMemories(locale, entries.map((entry) => entry.input));
      } catch (error) {
        for (const entry of entries) {
          entry.decision.status = "rejected";
          recordSkip({ source: entry.input.source, locale, reason: `写入失败：${error.message}` });
        }
        continue;
      }
      for (const [position, entry] of entries.entries()) {
        const result = saved[position];
        if (!result?.id) {
          entry.decision.status = "rejected";
          recordSkip({ source: entry.input.source, locale, reason: result?.error || "写入翻译记忆失败" });
          continue;
        }
        imported.push({ id: result.id, source: entry.input.source, target: entry.input.target, locale, assetType: "memory", contentType: entry.input.contentType, domain: entry.input.domain });
        if (entry.evidence) pendingEvidence.push({ locale, input: entry.evidence, candidate: entry.candidate });
        if (entry.linkedTrajectory) {
          try {
            const patch = externalReviewTrajectoryPatch({
              trajectory: entry.linkedTrajectory,
              target: entry.input.target,
              sourceFile: entry.sourceFile,
              sourceRow: entry.sourceRow,
              matchMethod: entry.trajectoryMethod
            });
            await updateLearningTrajectory(entry.linkedTrajectory.id, patch);
            trajectoryLinks.push({ candidateIndex: entry.candidateIndex, trajectoryId: entry.linkedTrajectory.id, source: entry.input.source, method: entry.trajectoryMethod });
            triggerAutoProposal({ locale: entry.linkedTrajectory.locale, contentType: entry.linkedTrajectory.contentType, domain: entry.linkedTrajectory.domain, project: entry.linkedTrajectory.project });
          } catch (error) {
            trajectoryLinkFailures.push({ candidateIndex: entry.candidateIndex, trajectoryId: entry.linkedTrajectory.id, source: entry.input.source, reason: error.message });
          }
        }
      }
    }
  };
  let termsWritten = 0;
  const flushTerms = async () => {
    if (!pendingTerms.length) return;
    const batch = pendingTerms.splice(0, pendingTerms.length);
    let saved = [];
    try {
      saved = await saveAssets(batch[0].locale, batch.map((item) => item.input));
    } catch (error) {
      const written = Number(error.createdItems?.length) || 0;
      error.message = `术语写入中断（已写入 ${termsWritten + written} 条）：${error.message}`;
      throw error;
    }
    saved.forEach((term, index) => {
      const item = batch[index];
      imported.push({ id: term.id, source: item.input.source, target: item.input.target, locale: item.input.locale || item.locale, assetType: "term", domain: item.input.domains?.[0] || "general", enforcement: "preferred" });
    });
    termsWritten += saved.length;
  };
  for (const [candidateIndex, candidate] of body.candidates.entries()) {
    if (cancelled()) {
      // 已攒在内存里的术语先落库，再中断：这样"继续导入"只需补剩下的。
      await flushTerms();
      throw cancellationError(`已中断：已写入 ${imported.length} 条，可在任务中心继续导入`);
    }
    const decision = { candidateId: candidate.candidateId, status: "rejected", decision: candidate.decision };
    if (!candidate.selected || candidate.existing || candidate.decision === "excluded") {
      recordSkip({ source: candidate.source, locale: candidate.locale, reason: candidate.existing ? "已存在" : "未选择" });
      decisions.push(decision);
      continue;
    }
    try {
      const locale = assertActiveLocale(candidate.locale);
      const source = String(candidate.source || "").trim();
      const target = String(candidate.target || "").trim();
      if (!source || !target) throw new Error("源词或译法为空");
      const fallback = classifyImportCandidate({ ...candidate, source, target, sourceFile: body.filename || candidate.sourceFile || "" });
      const sourceFile = String(candidate.sourceFile || body.filename || "").trim();
      const requestedContentType = String(body.contentType || "auto");
      const contentType = requestedContentType !== "auto" && Object.hasOwn(CONTENT_TYPES, requestedContentType)
        ? requestedContentType
        : (Object.hasOwn(CONTENT_TYPES, candidate.contentType) ? candidate.contentType : fallback.contentType);
      const contentTags = requestedContentType !== "auto"
        ? inferContentTags(source, contentType, { sourceFile: body.filename || candidate.sourceFile || "" })
        : (candidate.contentTags || fallback.contentTags || []);
      const domain = ["game", "marketing", "community", "general"].includes(String(body.domain || ""))
        ? String(body.domain)
        : (["game", "marketing", "community", "general"].includes(candidate.domain) ? candidate.domain : fallback.domain);
      const enforcement = "preferred";
      if (candidate.assetType === "memory") {
        const trajectoryLink = trajectoryByCandidate.get(candidateIndex);
        const linkedTrajectory = trajectoryLink?.trajectory || null;
        const evidenceContentType = linkedTrajectory?.contentType || contentType;
        const evidenceDomain = linkedTrajectory?.domain || domain;
        const machineTranslation = linkedTrajectory
          ? String(linkedTrajectory.finalTranslation || linkedTrajectory.initialTranslation || "").trim()
          : "";
        if (projectId && !masterTm) throw new Error("当前项目没有启用主 TM，无法写入人工确认译文");
        const allowStyleEvidence = candidate.styleEvidence === true || (candidate.styleEvidence === undefined && body.styleEvidence !== false);
        // 攒够一批再写：单条写入是"查重 + 写入"两次往返，8 万条就是 16 万次。
        pendingMemories.push({
          candidateIndex,
          decision,
          locale,
          candidate,
          linkedTrajectory,
          trajectoryMethod: trajectoryLink?.method || "",
          sourceFile,
          sourceRow: candidate.sourceRow || candidate.rowNumber,
          evidence: allowStyleEvidence ? {
            locale,
            source,
            target,
            contentType: evidenceContentType,
            domain: evidenceDomain,
            contentTags,
            machineTranslation,
            entryKey: candidate.entryKey || "",
            batchId: body.batchId,
            sourceFile,
            sourceRow: candidate.sourceRow || candidate.rowNumber,
            projectId,
            status: "accepted",
            provenance: linkedTrajectory ? "external-review-import" : "table-import"
          } : null,
          input: {
            source, target, domain, contentType,
            contentTags,
            qualityStatus: "human_approved", qaScore: 100, provenance: "table-import", sourceFile,
            batchId: body.batchId, sourceRow: candidate.rowNumber, projectId, project: projectId, libraryId: masterTm?.id || "",
            entryId: candidate.entryId || "", entryKey: candidate.entryKey || "",
            previousSource: candidate.previousSource || "", nextSource: candidate.nextSource || ""
          }
        });
        if (pendingMemories.length >= MEMORY_WRITE_BATCH_SIZE) await flushMemories();
      } else {
        if (projectId && !termLibrary) throw new Error("当前项目没有启用术语库，无法写入术语");
        const index = await loadTermIndex(locale);
        const sourceKey = termMatchKey(source);
        const pairKey = `${sourceKey}\u0000${termMatchKey(target)}`;
        if (index.pairs.has(pairKey)) {
          recordSkip({ source, locale, reason: "已存在相同对照" });
          decisions.push(decision);
          continue;
        }
        const existingTargets = index.sourcesWithTargets.get(sourceKey) || [];
        if (existingTargets.length) {
          recordSkip({ source, locale, reason: `库内已有译法：${existingTargets[0]}` });
          decisions.push(decision);
          continue;
        }
        // 先记进索引，同一批里后面重复的原文就会按"库内已有译法"跳过，
        // 不再依赖"写一条读一次库"。
        index.pairs.add(pairKey);
        index.sourcesWithTargets.set(sourceKey, [target]);
        const sourceRow = Number(candidate.rowNumber) || null;
        pendingTerms.push({
          locale,
          input: {
          source, target, aliases: [], forbidden: [], domains: [domain], contentTypes: [contentType || "general"], contentTags,
          enforcement, status: "approved",
          // 记账信息进 provenance；note 只放原表注释，因为它会原样发给模型。
          provenance: `table-import:${String(sourceFile || "unknown").slice(0, 120)}${sourceRow ? `#${sourceRow}` : ""}`,
          note: String(candidate.note || "").trim().slice(0, 500),
          projectId, libraryId: termLibrary?.id || ""
          }
        });
        if (pendingTerms.length >= TERM_WRITE_BATCH_SIZE) await flushTerms();
      }
      decision.status = "accepted";
      decision.decision = "ready";
      decisions.push(decision);
    } catch (error) {
      recordSkip({ source: candidate.source, locale: candidate.locale, reason: error.message });
      decisions.push(decision);
    }
    done += 1;
    if (done % TERM_WRITE_BATCH_SIZE === 0 || done === total) {
      report({ phase: "importing", message: `正在入库：${done} / ${total}`, percent: 10 + Math.round((done / Math.max(total, 1)) * 70), completed: done, total });
    }
  }
  await flushMemories();
  await flushEvidence();
  await flushTerms();
  report({ phase: "distilling", message: "风格学习与蒸馏", percent: 88, completed: done, total });
  const styleProfiles = [];
  const batchLearning = [];
  const styleFallbacks = [];
  for (const [scopeKey, currentEvidence] of styleEvidenceByScope.entries()) {
    const [locale, contentType, domain] = scopeKey.split("\u0000");
    let learning = null;
    try {
      learning = await distillBatchStyleLearning({
        batchId: body.batchId,
        filename: body.filename,
        locale,
        contentType,
        domain,
        projectId,
        evidence: currentEvidence
      });
      if (learning) batchLearning.push(learning);
    } catch (error) {
      styleFallbacks.push({ locale, contentType, domain, stage: "batch-learning", reason: `本批风格浓缩失败：${error.message}` });
    }
    try {
      const { distilled, ...pending } = await distillStyleProfileIfReady({
        locale, projectId,
        contentType,
        domain,
        sourceBatchId: body.batchId,
        learningRunId: learning?.id || "",
        threshold: getSettings().learning.styleDistillThreshold,
        growthWindow: getSettings().learning.styleDistillGrowthWindow,
        positiveLimit: getSettings().learning.distillPositiveSamples,
        negativeLimit: getSettings().learning.distillNegativeSamples,
        staleRounds: getSettings().learning.ruleStaleRounds
      });
      if (distilled) {
        styleProfiles.push(distilled);
        // 规则集刚变过，这时候才值得扫冲突；人工采纳本身不改规则，扫了是白烧模型调用。
        triggerConflictScan({ locale, contentType, domain, project: projectId });
        if (learning?.id) {
          const promoted = await saveStyleLearningRun({ ...learning, id: learning.id, status: "promoted", promotedProfileId: distilled.id });
          const index = batchLearning.findIndex((item) => item.id === learning.id);
          if (index >= 0) batchLearning[index] = promoted;
        }
      }
      else styleFallbacks.push({ locale, contentType, domain, ...pending });
    } catch (error) {
      styleFallbacks.push({ locale, contentType, domain, reason: error.message });
    }
  }
  const summary = {
    imported: imported.length,
    terms: imported.filter((item) => item.assetType === "term").length,
    memories: imported.filter((item) => item.assetType === "memory").length,
    styleLearningRuns: batchLearning.length,
    styleProfiles: styleProfiles.length,
    trajectoriesLinked: trajectoryLinks.length,
    trajectoryAmbiguous: trajectoryMatch.ambiguous.length,
    trajectoryUnmatched: trajectoryMatch.unmatched.length,
    trajectoryAlreadyAccepted: trajectoryMatch.alreadyAccepted.length,
    trajectoryLinkFailures: trajectoryLinkFailures.length,
    skipped: skippedTotal(),
    skippedByReason: Object.fromEntries(skipCounts),
    // 明细只留前 200 条，计数不受影响。
    skippedDetails: skipped,
    completedAt: new Date().toISOString()
  };
  if (!skipQueueCompletion) await completeImport(body.batchId, decisions, summary);
  return { batchId: body.batchId, imported, skipped, batchLearning, styleProfiles, styleFallbacks, trajectoryLinks, trajectoryMatch: { ambiguous: trajectoryMatch.ambiguous, unmatched: trajectoryMatch.unmatched, alreadyAccepted: trajectoryMatch.alreadyAccepted }, trajectoryLinkFailures, summary, decisions };
}

async function translateBatchSegment(body, path = "/api/translate") {
  const dispatch = runtimeOptions().dispatch;
  if (dispatch) return dispatch({ method: "POST", path, body });
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `翻译请求失败（${response.status}）`);
  return payload;
}

/**
 * 审校回填：把在 memoQ 里审校过的双语文件接回同一条批次。
 *
 * 用户确认过"覆盖就行"：命中的段落直接覆盖译文并标记人工采纳；同一批对照写入主 TM
 * （provenance=external-review-import）并按既有规则接回学习轨迹；未匹配和有歧义的照实报出来，
 * 不猜、不静默丢弃。
 */

/**
 * 回填时把"翻译期术语普查"的结果用人工终稿确认，并按策略入库。
 *
 * 分工是刻意的：模型只负责"哪个词像术语"，译法一律以人工终稿为准。
 * 自动入库仅限"库里没有该源词 + 终稿逐字保留了 AI 建议译法"，其余进待审核批次。
 */
async function applyTermSurveyToReview({ run, projectId, filename, applied, scope }) {
  const stats = { surveyed: 0, confirmed: 0, resolved: 0, autoWritten: 0, pendingReview: 0, skipped: 0, libraryName: "", warning: "", batchId: "" };
  const surveyed = Array.isArray(run?.runnerOptions?.termSurvey?.terms) ? run.runnerOptions.termSurvey.terms : [];
  if (!surveyed.length) return stats;
  stats.surveyed = surveyed.length;
  const pairs = applied.map(({ segment, pair }) => ({
    id: String(segment.id || ""),
    source: String(pair.source || ""),
    machineTranslation: String(segment.result?.humanReview?.previousTranslation || ""),
    humanFinal: String(pair.target || "")
  }));
  const aligned = alignSurveyToHumanFinal({ terms: surveyed, pairs });
  stats.confirmed = aligned.confirmed.length;
  stats.skipped = aligned.noEvidence.length;
  let resolved = [];
  if (aligned.unresolved.length) {
    try {
      for (let index = 0; index < aligned.unresolved.length; index += 20) {
        const chunk = aligned.unresolved.slice(index, index + 20);
        const outcome = await resolveSurveyTargetsWithModel({ locale: run.locale, scope, items: chunk });
        resolved.push(...(outcome?.matches || []));
      }
    } catch (error) {
      // 模型不可用不能变成"凭空入库"：这一批全部转待审核，由人工核对终稿。
      stats.warning = `术语对齐模型不可用，本批全部转待审核：${error.message}`;
    }
    stats.resolved = resolved.length;
  }
  const inputs = [...aligned.confirmed, ...resolved];
  // 模型没能给出结论的（含模型不可用）一律进待审核，绝不静默丢弃。
  const resolvedKeys = new Set(resolved.map((item) => String(item.source || "").trim()));
  const presetPending = aligned.unresolved
    .filter((item) => !resolvedKeys.has(String(item.source || "").trim()))
    .map((item) => pendingCandidateFromUnresolved(item, {
      locale: run.locale,
      contentType: run.contentType || "general",
      domain: run.domain || "general",
      project: projectId,
      batchId: run.batchId,
      filename
    }))
    .filter(Boolean);
  const written = inputs.length || presetPending.length
    ? await persistTermCandidateInputs({
      locale: run.locale,
      projectId,
      contentType: run.contentType || "general",
      domain: run.domain || "general",
      batchId: run.batchId,
      filename,
      inputs,
      presetPending,
      sourceLabel: "翻译期术语普查"
    })
    : { autoWritten: 0, pendingReview: 0, unmatched: 0, libraryName: "", warning: "", batchId: "", items: [] };
  // 逐条结果写回批次记录：界面要能回答"哪一条自动入库、哪一条待审、哪一条被忽略"，
  // 只存汇总数字的话回填结束后就再也查不到了。
  const review = {
    at: new Date().toISOString(),
    stats: {
      surveyed: stats.surveyed,
      confirmed: stats.confirmed,
      resolved: stats.resolved,
      autoWritten: written.autoWritten || 0,
      pendingReview: written.pendingReview || 0,
      skipped: stats.skipped,
      libraryName: written.libraryName || "",
      warning: written.warning || stats.warning || ""
    },
    terms: [
      ...aligned.noEvidence.map((item) => ({
        source: item.source,
        target: item.suggestedTarget,
        action: "skipped",
        reason: "人工终稿里没有出现这个源词"
      })),
      ...(written.items || [])
    ]
  };
  try {
    const latest = await getBatchRun(run.batchId) || run;
    const survey = latest.runnerOptions?.termSurvey || run.runnerOptions?.termSurvey;
    if (survey) {
      await saveBatchRun({
        ...latest,
        runnerOptions: { ...(latest.runnerOptions || {}), termSurvey: { ...survey, review } }
      });
    }
  } catch (error) {
    console.error(`[Kami] 术语普查逐条结果写回失败（${run.batchId}）：${error.message}`);
  }
  return { ...stats, ...written, review };
}

/**
 * 术语候选的公共落地：按策略分流（自动入库 / 待审核），两处调用者
 * （回填确认、门禁复盘的术语建议）共用同一套判定与写库路径。
 */
async function persistTermCandidateInputs({ locale, projectId, contentType = "general", domain = "general", batchId = "", filename = "", inputs = [], presetPending = [], sourceLabel = "术语候选" }) {
  const stats = { autoWritten: 0, pendingReview: 0, unmatched: 0, libraryName: "", warning: "", batchId: "", items: [] };
  const assets = (await getProjectAssets(locale, projectId).catch(() => ({ assets: {} }))).assets || {};
  const existingTerms = assets.terms || [];
  const autoWriteEnabled = getSettings().learning.termAutoWriteReviewedTerms !== false;
  const autoCandidates = [];
  const pendingCandidates = [...presetPending];
  for (const input of inputs) {
    let derived = [];
    try {
      derived = deriveTermCandidatesFromHumanFinal({
        locale,
        source: input.segmentSource,
        finalTranslation: input.humanFinal,
        matches: [],
        suggestions: [{
          source: input.source,
          target: input.target,
          confidence: Math.max(0.9, Number(input.confidence) || 0),
          reason: input.reason || sourceLabel,
          preserveOriginal: input.preserveSource === true
        }],
        existingTerms,
        contentType,
        domain,
        project: projectId,
        batchId,
        sourceFile: filename,
        minimumSuggestionConfidence: 0.5
      });
    } catch (error) {
      stats.warning = stats.warning || `术语候选生成失败：${error.message}`;
    }
    const candidate = derived[0];
    if (!candidate) {
      stats.unmatched += 1;
      continue;
    }
    const decision = decideTermWrite(
      { source: candidate.source, target: candidate.target, proposalAction: candidate.proposalAction, verbatim: input.verbatim === true },
      { existingTerms, autoWriteEnabled }
    );
    const record = {
      ...candidate,
      selected: true,
      decision: decision.auto ? "ready" : "review",
      candidateRole: candidate.proposalAction,
      candidateOrigin: `term-survey:${candidate.proposalAction}`,
      reasons: [pendingReason({ reason: input.reason }, decision)]
    };
    if (decision.auto) autoCandidates.push(record);
    else pendingCandidates.push(record);
    // 逐条留档：界面要显示"哪一条自动入库、哪一条转待审"，只报汇总数字是不够的。
    stats.items.push({
      source: candidate.source,
      target: candidate.target,
      action: decision.auto ? "auto_written" : "pending_review",
      reason: decision.auto ? "" : pendingReason({ reason: input.reason }, decision)
    });
  }
  for (const pending of presetPending) {
    stats.items.push({
      source: String(pending?.source || "").trim(),
      target: String(pending?.target || "").trim(),
      action: "pending_review",
      reason: "模型没能在人工终稿里定位到对应译法"
    });
  }

  const libraries = await getResourceLibraries(projectId).catch(() => []);
  const termLibrary = libraries.find((library) => library.kind === "term_base" && library.enabled !== false) || null;
  stats.libraryName = termLibrary?.name || "";
  if (autoCandidates.length && termLibrary) {
    try {
      const preview = await saveImportPreview({
        filename: `${String(filename || "审校回填").slice(0, 100)} · 术语自动入库`,
        fileType: "external-review-terms",
        requestedLocale: locale,
        projectId,
        fileMode: "term",
        statistics: { rowsScanned: autoCandidates.length, candidates: autoCandidates.length, ready: autoCandidates.length, review: 0 },
        ai: { requested: true, used: true, reviewed: autoCandidates.length, total: autoCandidates.length, source: "term-survey" },
        sheets: [],
        candidates: autoCandidates
      });
      await commitTermImport({
        batchId: preview.batchId,
        projectId,
        filename: `${filename} · 术语自动入库`,
        termLibraryId: termLibrary.id,
        candidates: autoCandidates
      });
      stats.autoWritten = autoCandidates.length;
    } catch (error) {
      stats.warning = stats.warning || `术语自动入库失败，已转为待审核：${error.message}`;
      pendingCandidates.push(...autoCandidates.map((candidate) => ({ ...candidate, decision: "review", reasons: [...(candidate.reasons || []), "自动入库失败，转人工确认"] })));
      for (const item of stats.items) {
        if (item.action === "auto_written") {
          item.action = "pending_review";
          item.reason = "自动入库失败，转人工确认";
        }
      }
    }
  } else if (autoCandidates.length) {
    pendingCandidates.push(...autoCandidates.map((candidate) => ({ ...candidate, decision: "review", reasons: [...(candidate.reasons || []), "项目没有启用的术语库，转人工确认"] })));
    for (const item of stats.items) {
      if (item.action === "auto_written") {
        item.action = "pending_review";
        item.reason = "项目没有启用的术语库，转人工确认";
      }
    }
  }

  if (pendingCandidates.length) {
    try {
      const preview = await saveImportPreview({
        filename: `${String(filename || "审校回填").slice(0, 100)} · 术语候选`,
        fileType: "external-review-terms",
        requestedLocale: locale,
        projectId,
        fileMode: "term",
        statistics: { rowsScanned: pendingCandidates.length, candidates: pendingCandidates.length, ready: 0, review: pendingCandidates.length },
        ai: { requested: true, used: true, reviewed: pendingCandidates.length, total: pendingCandidates.length, source: "term-survey" },
        sheets: [],
        candidates: pendingCandidates
      });
      stats.batchId = preview.batchId;
      stats.pendingReview = pendingCandidates.length;
      const task = await createBackgroundTask({
        type: "term_import",
        title: `术语候选 · ${filename}`,
        projectId,
        locale,
        progress: { phase: "pending-commit", message: `待审核 ${pendingCandidates.length} 条术语${stats.autoWritten ? `（另有 ${stats.autoWritten} 条已自动入库）` : ""}`, percent: 100, completed: 1, total: 1 },
        payload: { batchId: preview.batchId, candidateCount: pendingCandidates.length, autoWritten: stats.autoWritten, libraryName: stats.libraryName }
      });
      await updateBackgroundTaskProgress(task.id, {
        status: "review",
        progress: { phase: "pending-commit", message: `待审核 ${pendingCandidates.length} 条术语${stats.autoWritten ? `（另有 ${stats.autoWritten} 条已自动入库）` : ""}`, percent: 100, completed: 1, total: 1 },
        payload: { batchId: preview.batchId, candidateCount: pendingCandidates.length, autoWritten: stats.autoWritten, libraryName: stats.libraryName }
      }).catch(() => {});
    } catch (error) {
      stats.warning = stats.warning || `术语候选批次保存失败：${error.message}`;
    }
  } else if (stats.autoWritten) {
    await createBackgroundTask({
      type: "term_import",
      title: `术语自动入库 · ${filename}`,
      projectId,
      locale,
      progress: { phase: "completed", message: `自动入库 ${stats.autoWritten} 条术语（库：${stats.libraryName || "未命名"}）`, percent: 100, completed: stats.autoWritten, total: stats.autoWritten },
      payload: { candidateCount: 0, autoWritten: stats.autoWritten, libraryName: stats.libraryName }
    }).then((task) => updateBackgroundTaskProgress(task.id, {
      status: "completed",
      progress: { phase: "completed", message: `自动入库 ${stats.autoWritten} 条术语（库：${stats.libraryName || "未命名"}）`, percent: 100, completed: stats.autoWritten, total: stats.autoWritten },
      payload: { candidateCount: 0, autoWritten: stats.autoWritten, libraryName: stats.libraryName }
    })).catch(() => {});
  }
  return stats;
}

async function importBatchReview({ run, pairs, projectId, filename }) {
  const segments = Array.isArray(run.segments) ? run.segments : [];
  const selected = segments.filter((segment) => segment.selected !== false);
  const matched = matchReviewPairsToSegments(selected, pairs);
  const appliedAt = new Date().toISOString();
  const applied = matched.matches.map((match) => {
    const segment = selected[match.segmentIndex];
    const pair = pairs[match.pairIndex];
    const previousTranslation = String(segment.translation || "");
    segment.translation = String(pair.target || "").trim();
    segment.accepted = true;
    segment.result = {
      ...(segment.result || {}),
      humanReview: {
        source: "external-review-import",
        at: appliedAt,
        method: match.method,
        previousTranslation,
        sourceFile: filename,
        sourceRow: pair.sourceRow || null
      }
    };
    return { segment, pair, match };
  });
  if (applied.length) await saveBatchRun({ ...run, segments });

  const libraries = await getResourceLibraries(projectId).catch(() => []);
  const masterTm = libraries.find((library) => library.kind === "translation_memory" && library.role === "master");
  const trajectoryMatch = linkExternalReviewTrajectories(
    applied.map(({ pair }) => ({
      source: pair.source, target: pair.target,
      entryId: pair.entryId || "", entryKey: pair.entryKey || "",
      sheet: pair.sheet || "", sourceRow: pair.sourceRow || null,
      previousSource: pair.previousSource || "", nextSource: pair.nextSource || ""
    })),
    await trajectoriesForExternalReview(run.locale, projectId)
  );
  const linkByIndex = new Map(trajectoryMatch.links.map((link) => [link.candidateIndex, link]));
  // 已采纳过的轨迹也要能定位：终稿这次若有变化，学习语料必须跟着更新，不能只更新 TM。
  const acceptedByIndex = new Map((trajectoryMatch.acceptedLinks || []).map((link) => [link.candidateIndex, link]));
  const failures = [];
  let memoriesWritten = 0;
  let trajectoriesLinked = 0;
  let trajectoriesUpdated = 0;
  let acceptedUnchanged = 0;
  for (const [index, { pair }] of applied.entries()) {
    try {
      await saveMemory(run.locale, {
        source: pair.source, target: pair.target,
        domain: run.domain || "general", contentType: run.contentType || "general",
        qualityStatus: "human_approved", qaScore: 100,
        provenance: "external-review-import",
        sourceFile: filename, batchId: run.batchId,
        projectId, project: projectId, libraryId: masterTm?.id || "",
        entryId: pair.entryId || "", entryKey: pair.entryKey || "",
        previousSource: pair.previousSource || "", nextSource: pair.nextSource || ""
      });
      memoriesWritten += 1;
    } catch (error) {
      failures.push({ source: pair.source, reason: `写入主 TM 失败：${error.message}` });
      continue;
    }
    const link = linkByIndex.get(index);
    if (link) {
      try {
        await updateLearningTrajectory(link.trajectory.id, externalReviewTrajectoryPatch({
          trajectory: link.trajectory, target: pair.target, sourceFile: filename,
          sourceRow: pair.sourceRow || null, matchMethod: link.method
        }));
        trajectoriesLinked += 1;
      } catch (error) {
        failures.push({ source: pair.source, reason: `接回学习轨迹失败：${error.message}` });
      }
      continue;
    }
    const accepted = acceptedByIndex.get(index);
    if (!accepted) continue;
    // 这条终稿上一轮已经采纳过：内容一样就不动（也不重复记事件），
    // 只有真的改了才更新轨迹终稿，否则学习语料会一直停留在旧版本。
    const previousFinal = String(accepted.trajectory.finalTranslation || "").trim();
    if (previousFinal === String(pair.target || "").trim()) {
      acceptedUnchanged += 1;
      continue;
    }
    try {
      await updateLearningTrajectory(accepted.trajectory.id, externalReviewTrajectoryPatch({
        trajectory: accepted.trajectory, target: pair.target, sourceFile: filename,
        sourceRow: pair.sourceRow || null, matchMethod: accepted.method
      }));
      trajectoriesUpdated += 1;
    } catch (error) {
      failures.push({ source: pair.source, reason: `更新已采纳学习轨迹失败：${error.message}` });
    }
  }

  logInfo("审校回填完成", {
    batchId: run.batchId, filename, pairs: pairs.length,
    matched: matched.matches.length, unmatched: matched.unmatched.length, ambiguous: matched.ambiguous.length,
    trajectoriesLinked, trajectoriesUpdated, acceptedUnchanged
  });
  // 回填就是这套工作流的"人工审校结论"。改动直接进回归集，并自动对新候选跑一次门禁，
  // 让下一次发版判断用的永远是刚回填的证据，而不是等人来点按钮。
  const regressionScope = learningScope({
    locale: run.locale,
    contentType: run.contentType || "general",
    domain: run.domain || "general",
    project: projectId
  });
  let regression = null;
  try {
    const result = await refreshRegressionSuite(regressionScope, {
      reason: "external-review-import",
      changeNote: `审校回填 ${filename}`
    });
    regression = {
      changed: Boolean(result.changed),
      suiteVersion: result.asset?.version || null,
      cases: result.stats?.total || 0,
      externalCases: result.stats?.external || 0,
      reason: result.reason
    };
    if (result.changed) triggerQualityGateRefresh(regressionScope, { reason: "external-review-import" });
  } catch (error) {
    console.error("审校回填后重建回归集失败", error);
    regression = { error: error.message };
  }
  // 术语普查的确认与入库：同样以人工终稿为准，失败只记警告，不影响回填结果本身。
  let termSurvey = null;
  try {
    termSurvey = await applyTermSurveyToReview({ run, projectId, filename, applied, scope: regressionScope });
  } catch (error) {
    console.error("审校回填后处理术语普查失败", error);
    termSurvey = { error: error.message };
  }
  return {
    batchId: run.batchId, filename, total: pairs.length,
    matched: matched.matches.length,
    changed: matched.matches.filter((match) => match.changed).length,
    unchanged: matched.unchanged.length,
    unmatched: matched.unmatched.length,
    ambiguous: matched.ambiguous.length,
    memoriesWritten,
    trajectoriesLinked,
    trajectoriesUpdated,
    trajectoryAlreadyAccepted: trajectoryMatch.alreadyAccepted.length,
    trajectoryAcceptedUnchanged: acceptedUnchanged,
    trajectoryUnmatched: trajectoryMatch.unmatched.length,
    trajectoryAmbiguous: trajectoryMatch.ambiguous.length,
    regression,
    termSurvey,
    // 本批解析时跳过的句段：回填里"原文不在批次中"的条目多半就是它们（锁定 / 已有译文），
    // 明细里带上原因，用户才看得懂为什么这几条进不来。
    skippedUnits: {
      locked: Number(run.structure?.xliff?.skippedLocked) || 0,
      existing: Number(run.structure?.xliff?.skippedExisting) || 0
    },
    failures: failures.slice(0, 50),
    details: {
      unmatched: matched.unmatched.slice(0, 50),
      ambiguous: matched.ambiguous.slice(0, 50)
    }
  };
}

/** 语境分析与一致性核对都是"整份文件"级任务：同一批次同时只允许跑一个。 */
const contextAnalysisTasks = new Map();
const consistencyCheckTasks = new Map();
const CONTEXT_ANALYSIS_CONCURRENCY = 3;
const CONSISTENCY_CHECK_CONCURRENCY = 3;
/** 术语普查的并发：和一致性核对同级，避免和大批次翻译抢模型额度。 */
const termSurveyTasks = new Map();

function taskProgressReporter(taskId) {
  return (update) => { if (taskId) updateBackgroundTaskProgress(taskId, { progress: update }).catch(() => {}); };
}

/**
 * 通读整份文件，产出语境档案。
 *
 * 分片并行（每片 ≤300 条且 ≤40000 字），片内失败只丢这一片，最后合并成一份档案；
 * 全部分片都失败时档案标记为 failed，翻译路径自动回落通用口径。
 */
async function runContextAnalysis(batchId, { taskId = "" } = {}) {
  const run = await getBatchRun(batchId);
  if (!run) throw new Error("未找到这条翻译任务");
  const segments = Array.isArray(run.segments) ? run.segments : [];
  if (!segments.length) throw new Error("这条任务还没有分段，无法做语境分析");
  const chunks = splitContextChunks(segments);
  const report = taskProgressReporter(taskId);
  const provider = getProviderConfig();
  const declaredLabel = CONTENT_TYPES[run.contentType]?.label || "";
  report({ phase: "analyzing", message: `正在通读全文：0 / ${chunks.length} 片`, percent: 5, completed: 0, total: chunks.length });
  let completed = 0;
  const failures = [];
  const results = await runTaskPool(chunks, async (chunk) => analyzeDocumentContextWithModel({
    filename: run.filename,
    format: run.format,
    locale: run.locale,
    declaredPurpose: run.contentType && run.contentType !== "general" ? declaredLabel : "",
    entries: contextBriefEntries(segments, chunk.indices),
    part: { index: chunk.index, total: chunks.length }
  }), {
    concurrency: CONTEXT_ANALYSIS_CONCURRENCY,
    onSettled: (result) => {
      completed += 1;
      if (result.status === "rejected") failures.push(String(result.reason?.message || result.reason));
      report({
        phase: "analyzing",
        message: `正在通读全文：${completed} / ${chunks.length} 片`,
        percent: 5 + Math.round((completed / chunks.length) * 80),
        completed,
        total: chunks.length
      });
    }
  });
  const parts = [];
  const dropped = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    parts.push(result.value.part);
    dropped.push(...(result.value.dropped || []));
  }
  const brief = mergeContextBrief(parts, { filename: run.filename, total: segments.length, model: provider.model });
  brief.dropped = dropped.slice(0, 50);
  if (failures.length && !parts.length) brief.status = "failed";
  if (failures.length) brief.warning = `${failures.length} 片分析失败：${failures[0]}`;
  const latest = await getBatchRun(batchId);
  await saveBatchRun({ ...(latest || run), contextBrief: brief });
  return brief;
}

/** 起一个语境分析后台任务；同一批次已在跑时直接复用。 */
function startContextAnalysis(batchId) {
  const running = contextAnalysisTasks.get(batchId);
  if (running) return running;
  const tracked = (async () => {
    const run = await getBatchRun(batchId);
    if (!run) return { batchId, taskId: "", failed: "未找到这条翻译任务" };
    const task = await createBackgroundTask({
      type: "context_analysis",
      title: `语境分析 · ${run.filename}`,
      locale: run.locale,
      projectId: run.projectId,
      progress: { phase: "queued", message: "已进入后台队列", total: (run.segments || []).length }
    });
    try {
      const brief = await runContextAnalysis(batchId, { taskId: task.id });
      await updateBackgroundTaskProgress(task.id, {
        status: brief.status === "ready" ? "completed" : "failed",
        progress: {
          phase: brief.status === "ready" ? "completed" : "failed",
          message: brief.status === "ready"
            ? `语境分析完成：${brief.sections.length} 个区间，覆盖 ${brief.coverage.covered} / ${brief.coverage.total} 条`
            : "语境分析失败，翻译将按通用口径继续",
          percent: 100,
          completed: brief.coverage.covered,
          total: brief.coverage.total
        },
        payload: {
          batchId,
          documentPurpose: brief.documentType?.purpose || "general",
          sections: brief.sections.length,
          coverage: brief.coverage,
          warning: brief.warning || ""
        }
      });
      return { batchId, taskId: task.id, brief };
    } catch (error) {
      await updateBackgroundTaskProgress(task.id, {
        status: "failed",
        progress: { phase: "failed", message: error.message, percent: 100 }
      }).catch(() => {});
      return { batchId, taskId: task.id, failed: error.message };
    }
  })().finally(() => contextAnalysisTasks.delete(batchId));
  contextAnalysisTasks.set(batchId, tracked);
  return tracked;
}

/**
 * 一致性核对的证据：风格指南 + 术语库命中 + 主/参考/工作 TM 精确命中。
 * 都按"这一批真实出现的原文"去查，不把整个库灌进提示词。
 */
function consistencyTermEvidence(run, segments, assets) {
  const bySegment = new Map();
  const terms = new Map();
  for (const segment of segments) {
    const hits = matchTerms(segment.source || "", assets, {
      contentType: run.contentType,
      domain: run.domain,
      // 一致性证据只取 exact；关掉滑窗编辑距离，否则 5.8k 术语 × 全部段落要几十秒。
      exactOnly: true,
      ...deliveryContext(run, segment.source || "")
    }).filter((match) => match.mode === "exact" && String(match.expectedTarget || match.term?.target || "").trim());
    const list = hits.map((match) => ({
      source: String(match.term?.source || match.matchPhrase || "").trim(),
      target: String(match.expectedTarget || match.term?.target || "").trim(),
      mode: String(match.mode || "")
    })).filter((item) => item.source && item.target);
    bySegment.set(String(segment.id || ""), list);
    for (const item of list) {
      const key = `${normalizeSource(item.source)}\u0000${normalizeSource(item.target)}`;
      if (!terms.has(key)) terms.set(key, item);
    }
  }
  return { bySegment, terms: [...terms.values()] };
}

/** TM 条目的权威排序：人工条永远排在机器条前面，主 TM 排在参考 TM 前面。 */
function tmEvidenceRank(entry = {}) {
  const human = String(entry.qualityStatus || "") === "human_approved";
  const role = String(entry.libraryRole || "");
  if (human && role === "master") return 0;
  if (human && role === "reference") return 1;
  if (human) return 2;
  if (role === "master") return 3;
  if (role === "working") return 4;
  return 5;
}

function tmEvidenceLabel(entry = {}) {
  return ["主 TM 人工条", "参考 TM 人工条", "人工译例", "主 TM 机器条", "工作 TM 机器条", "TM 机器条"][tmEvidenceRank(entry)] || "TM 条目";
}

/** 按原文精确查 TM：只查这一批出现过的原文，不拉整库（项目 TM 动辄上万条）。 */
async function consistencyTmEvidence({ locale, projectId, contentType, domain, sources = [] }) {
  const libraries = projectId ? await getResourceLibraries(projectId, { kind: "translation_memory" }).catch(() => []) : [];
  const libraryById = new Map(libraries.map((library) => [library.id, library]));
  const bySource = new Map();
  const seen = new Set();
  const phrases = [...new Set((Array.isArray(sources) ? sources : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 60);
  for (const phrase of phrases) {
    const rows = await getMemories(locale, { projectId, contentType, domain, limit: 50, search: phrase, scopeFallback: true }).catch(() => []);
    const entries = [];
    for (const row of rows) {
      if (normalizeMemoryText(row.source) !== normalizeMemoryText(phrase)) continue;
      const key = String(row.id || `${row.source}\u0000${row.target}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const library = libraryById.get(row.libraryId);
      entries.push({
        id: row.id,
        source: String(row.source || ""),
        target: String(row.target || ""),
        qualityStatus: String(row.qualityStatus || ""),
        libraryId: String(row.libraryId || ""),
        libraryRole: String(library?.role || ""),
        libraryName: String(library?.name || ""),
        batchId: String(row.batchId || "")
      });
    }
    if (entries.length) bySource.set(normalizeSource(phrase), entries);
  }
  return bySource;
}

/** 给一片的提示词选出这一片用得上的证据（术语命中 + 原文精确命中的 TM 条目）。 */
function consistencyChunkEvidence({ style = null, termEvidence = { bySegment: new Map() }, tmEvidence = new Map(), pairs = [] }) {
  const terms = [];
  const termKeys = new Set();
  for (const pair of pairs) {
    for (const item of termEvidence.bySegment.get(String(pair.id)) || []) {
      const key = `${normalizeSource(item.source)}\u0000${normalizeSource(item.target)}`;
      if (termKeys.has(key)) continue;
      termKeys.add(key);
      terms.push(item);
    }
  }
  const tm = [];
  const seen = new Set();
  for (const pair of pairs) {
    for (const entry of tmEvidence.get(normalizeSource(pair.source)) || []) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      tm.push(entry);
    }
  }
  tm.sort((left, right) => tmEvidenceRank(left) - tmEvidenceRank(right));
  return {
    style: style || null,
    terms: terms.slice(0, CONSISTENCY_EVIDENCE_LIMITS.terms),
    tm: tm.slice(0, CONSISTENCY_EVIDENCE_LIMITS.tm).map((entry) => ({
      source: entry.source,
      target: entry.target,
      authority: tmEvidenceLabel(entry)
    }))
  };
}

/** 段落当前会被确定性规则判出哪些问题；自动统一前后各算一次，用来挡"改出新错误"。 */
function consistencySegmentIssues(run, segment, translation) {
  return runQa({
    source: segment.source || "",
    translation: String(translation || ""),
    matches: Array.isArray(segment.result?.matches) ? segment.result.matches : [],
    locale: run.locale,
    titleOverrides: getSettings().orthography.titleBrackets,
    contentType: run.contentType || segment.result?.segmentPurpose || "general"
  });
}

/** 定向修订：只按一致性要求改这一处，改完由调用方做确定性校验。 */
async function reviseSegmentForConsistency({ run, segment, assets, source, target, reason }) {
  const locale = run.locale;
  const classification = await classify({ text: segment.source || "", hint: run.contentType || "general", useModel: false });
  const matches = matchTerms(segment.source || "", assets, {
    contentType: run.contentType,
    domain: run.domain,
    ...deliveryContext(run, segment.source || "")
  });
  const [styleProfile, qaCases, queryEmbedding] = await Promise.all([
    getProjectStyleProfile(locale, { projectId: run.projectId }).catch(() => null),
    getQaCases(locale, { projectId: run.projectId, contentType: classification.contentType, domain: run.domain, limit: -1, scopeFallback: true }).catch(() => []),
    embedSource(segment.source || "").catch(() => null)
  ]);
  const qaGuidance = rankQaCases(segment.source || "", qaCases, {
    limit: 3,
    queryEmbedding,
    contentType: classification.contentType,
    domain: run.domain
  });
  const contextPack = buildContextPack({
    titleOverrides: getSettings().orthography.titleBrackets,
    source: segment.source || "",
    locale,
    classification,
    matches,
    domain: run.domain,
    styleProfile,
    qaGuidance
  });
  const revised = await reviseTranslationWithQa({
    contextPack,
    translation: String(segment.translation || ""),
    issues: [{
      severity: "major",
      category: "consistency",
      message: `本文件要求统一：${source} 统一译为「${target}」（依据：${reason}）。只改这一处，其余内容、格式与信息保持不变。`
    }],
    references: [],
    qaCases: qaGuidance
  });
  return String(revised || "").trim();
}

/** 修复后只复核改动所在的分片，确认漂移消失；不整批重跑，避免重复花钱。 */
async function recheckConsistencyChunks({ run, pairs, changedIds, style, termEvidence, tmEvidence }) {
  const chunks = splitConsistencyChunks(pairs).filter((chunk) => chunk.ids.some((id) => changedIds.has(String(id))));
  if (!chunks.length) return { checkedChunks: 0, remaining: [], failures: [] };
  const byId = new Map(pairs.map((pair) => [String(pair.id), pair]));
  const results = await runTaskPool(chunks, async (chunk) => {
    const chunkPairs = chunk.ids.map((id) => byId.get(String(id))).filter(Boolean);
    return checkBatchConsistencyWithModel({
      filename: run.filename,
      locale: run.locale,
      purpose: run.contentType || "general",
      pairs: chunkPairs,
      part: { index: chunk.index, total: chunks.length },
      evidence: consistencyChunkEvidence({ style, termEvidence, tmEvidence, pairs: chunkPairs }),
      toolRunner: buildReferenceToolRunner({ projectId: run.projectId })
    });
  }, { concurrency: CONSISTENCY_CHECK_CONCURRENCY });
  return {
    checkedChunks: chunks.length,
    remaining: mergeConsistencyFindings(results.filter((result) => result.status === "fulfilled").map((result) => result.value)),
    failures: results.filter((result) => result.status === "rejected").map((result) => String(result.reason?.message || result.reason))
  };
}

/**
 * 一致性自动统一：按证据定案 → 能确定性替换的直接替换、不能的走一次定向修订 →
 * 逐段确定性校验（改出新的阻断问题就回退）→ 交给调用方落库。
 * 人工回填过的批次与"关掉自动统一"的设置都只报告，不改稿。
 */
async function applyConsistencyRepairs({ run, segments, findings, assets, taskId = "" }) {
  const report = taskProgressReporter(taskId);
  const repair = { at: new Date().toISOString(), enabled: true, blocked: null, changed: [], skipped: [] };
  if (getSettings().quality?.consistencyAutoRepair === false) {
    repair.enabled = false;
    repair.blocked = { reason: "设置里关闭了自动统一" };
    return { repair, segments };
  }
  if (segments.some((segment) => segment.accepted === true)) {
    repair.blocked = { reason: REPAIR_SKIP_REASONS.human_reviewed };
    return { repair, segments };
  }
  const byId = new Map(segments.map((segment) => [String(segment.id || ""), segment]));
  const sources = [];
  for (const finding of findings) {
    for (const id of finding.ids || []) {
      const source = byId.get(String(id))?.source;
      if (source) sources.push(source);
    }
    for (const term of finding.terms || []) sources.push(term.source);
    for (const item of finding.unify || []) sources.push(item.source);
  }
  const tmEvidence = await consistencyTmEvidence({
    locale: run.locale,
    projectId: run.projectId,
    contentType: run.contentType,
    domain: run.domain,
    sources
  });
  const plan = planConsistencyRepairs({
    findings,
    segments,
    groups: summarizeSourceGroups(segments),
    termTargetsFor: (source) => matchTerms(source || "", assets, {
      contentType: run.contentType,
      domain: run.domain,
      exactOnly: true,
      ...deliveryContext(run, source || "")
    }).filter((match) => match.mode === "exact" && String(match.expectedTarget || match.term?.target || "").trim())
      .map((match) => ({
        source: String(match.term?.source || match.matchPhrase || "").trim(),
        target: String(match.expectedTarget || match.term?.target || "").trim()
      })),
    tmEntriesFor: (source) => tmEvidence.get(normalizeSource(source)) || [],
    maxSegments: getSettings().quality?.consistencyRepairMaxSegments ?? 20
  });
  repair.skipped = plan.skipped;
  if (plan.blocked) {
    repair.blocked = plan.blocked;
    return { repair, segments };
  }
  if (!plan.actions.length) return { repair, segments };
  const updated = new Map(segments.map((segment) => [String(segment.id || ""), { ...segment }]));
  const totalChanges = plan.actions.reduce((sum, action) => sum + action.changes.length, 0);
  let completed = 0;
  report({ phase: "repairing", message: `正在按证据统一译法：0 / ${totalChanges} 段`, percent: 30, completed: 0, total: totalChanges });
  for (const action of plan.actions) {
    for (const change of action.changes) {
      completed += 1;
      const segment = updated.get(change.segmentId);
      if (!segment || segment.accepted === true) continue;
      const before = String(segment.translation || "");
      let after = change.method === "replace" ? String(change.after || "") : "";
      // 同一条 finding 可能有多个统一目标（例如一组 UI 选项），段落以它自己那条结论为准。
      const changeSource = change.source || action.source;
      const changeTarget = change.target || action.target;
      const changeEvidence = change.evidence || action.evidence || null;
      if (!after) {
        try {
          after = await reviseSegmentForConsistency({
            run,
            segment,
            assets,
            source: changeSource,
            target: changeTarget,
            reason: REPAIR_EVIDENCE_LABELS[changeEvidence?.kind] || "一致性核对"
          });
        } catch (error) {
          repair.skipped.push({ findingIndex: action.findingIndex, type: action.type, ids: [change.segmentId], reason: `定向修订失败：${error.message}` });
          continue;
        }
      }
      if (!after || after === before) {
        repair.skipped.push({
          findingIndex: action.findingIndex,
          type: action.type,
          ids: [change.segmentId],
          reason: change.reason || REPAIR_SKIP_REASONS.no_variant
        });
        continue;
      }
      const beforeIssues = consistencySegmentIssues(run, segment, before);
      const introduced = consistencySegmentIssues(run, segment, after).filter((issue) => issue.severity === "error"
        && !beforeIssues.some((previous) => previous.severity === "error" && previous.type === issue.type));
      if (introduced.length) {
        repair.skipped.push({ findingIndex: action.findingIndex, type: action.type, ids: [change.segmentId], reason: `校验未通过：${introduced[0].message}` });
        continue;
      }
      segment.translation = after;
      segment.result = {
        ...(segment.result || {}),
        consistencyRepair: {
          at: repair.at,
          before,
          after,
          method: change.method,
          source: changeSource,
          target: changeTarget,
          evidence: changeEvidence,
          overrodeModel: change.overrodeModel === true,
          finding: action.detail || ""
        }
      };
      repair.changed.push({
        segmentId: change.segmentId,
        findingIndex: action.findingIndex,
        type: action.type,
        source: changeSource,
        target: changeTarget,
        evidence: changeEvidence,
        overrodeModel: change.overrodeModel === true,
        method: change.method,
        before,
        after
      });
      report({
        phase: "repairing",
        message: `正在按证据统一译法：${completed} / ${totalChanges} 段`,
        percent: 30 + Math.round((completed / Math.max(1, totalChanges)) * 30),
        completed,
        total: totalChanges
      });
    }
  }
  if (!repair.changed.length) return { repair, segments };
  const nextSegments = segments.map((segment) => updated.get(String(segment.id || "")) || segment);
  await syncConsistencyRepairRecords({ run, changes: repair.changed, segments: nextSegments });
  return { repair, segments: nextSegments };
}

/**
 * 修复后的资产同步：工作 TM 里这条批次的机器条改成新译法（不新增分叉，也不碰人工条），
 * 有学习轨迹的段落把机器终稿同步成修复后的译文，保证 SFT / 回归集用的是实际交付的机器稿。
 */
async function syncConsistencyRepairRecords({ run, changes, segments }) {
  if (!changes.length) return;
  const libraries = run.projectId ? await getResourceLibraries(run.projectId, { kind: "translation_memory" }).catch(() => []) : [];
  const workingLibrary = libraries.find((library) => library.role === "working" && library.enabled !== false) || null;
  const byId = new Map(segments.map((segment) => [String(segment.id || ""), segment]));
  for (const change of changes) {
    const segment = byId.get(String(change.segmentId));
    if (!segment) continue;
    if (workingLibrary) {
      try {
        const rows = await getMemories(run.locale, {
          projectId: run.projectId,
          contentType: run.contentType,
          domain: run.domain,
          limit: 50,
          search: String(segment.source || ""),
          scopeFallback: true
        }).catch(() => []);
        const stale = rows.filter((row) => row.libraryId === workingLibrary.id
          && row.batchId === run.batchId
          && normalizeMemoryText(row.source) === normalizeMemoryText(segment.source)
          && normalizeMemoryText(row.target) !== normalizeMemoryText(change.after)
          && String(row.qualityStatus || "") !== "human_approved");
        for (const row of stale) await deleteMemory(run.locale, row.id).catch(() => {});
        await saveMemory(run.locale, {
          source: segment.source,
          target: change.after,
          domain: run.domain || "general",
          contentType: run.contentType || "general",
          qualityStatus: "machine_verified",
          assetTier: "working",
          project: run.projectId,
          projectId: run.projectId,
          libraryId: workingLibrary.id,
          provenance: "consistency-repair",
          batchId: run.batchId,
          entryId: segment.locator?.unitId || segment.locator?.entryId || segment.context?.entryId || "",
          entryKey: segment.entryKey || segment.locator?.entryKey || "",
          sourceFile: run.filename,
          sourceRow: segment.locator?.row || segment.context?.row || null
        });
      } catch (error) {
        console.error(`[Kami] 一致性修复后同步工作 TM 失败（${change.segmentId}）：${error.message}`);
      }
    }
    const trajectoryId = String(segment.result?.trajectoryId || "");
    if (!trajectoryId) continue;
    try {
      const trajectory = await getLearningTrajectory(trajectoryId).catch(() => null);
      if (!trajectory || trajectory.humanDecision?.accepted === true) continue;
      await updateLearningTrajectory(trajectoryId, {
        finalTranslation: change.after,
        events: [...(Array.isArray(trajectory.events) ? trajectory.events : []), {
          type: "consistency_repaired",
          at: new Date().toISOString(),
          segmentId: change.segmentId,
          source: change.source,
          target: change.target
        }]
      });
    } catch (error) {
      console.error(`[Kami] 一致性修复后同步学习轨迹失败（${change.segmentId}）：${error.message}`);
    }
  }
}

/** 每条待核对项写明"自动统一成了什么、依据是什么、为什么没改"。 */
function annotateConsistencyFindings(findings, repair, verification) {
  const changedByIndex = new Map();
  for (const change of repair.changed || []) {
    if (!changedByIndex.has(change.findingIndex)) changedByIndex.set(change.findingIndex, []);
    changedByIndex.get(change.findingIndex).push(change);
  }
  const skippedByIndex = new Map();
  for (const item of repair.skipped || []) {
    if (!skippedByIndex.has(item.findingIndex)) skippedByIndex.set(item.findingIndex, []);
    skippedByIndex.get(item.findingIndex).push(item);
  }
  const stillReported = new Set((verification?.remaining || []).flatMap((finding) => finding.ids || []).map(String));
  return findings.map((finding, index) => {
    if (repair.blocked) return { ...finding, repair: { status: "skipped", reason: repair.blocked.reason } };
    const changes = changedByIndex.get(index) || [];
    const skipped = skippedByIndex.get(index) || [];
    if (changes.length) {
      const still = changes.some((change) => stillReported.has(String(change.segmentId)));
      return {
        ...finding,
        repair: {
          status: still ? "partial" : "repaired",
          target: changes[0].target,
          evidence: changes[0].evidence || null,
          overrodeModel: changes.some((change) => change.overrodeModel === true),
          changedIds: changes.map((change) => change.segmentId),
          reason: still ? "统一后复核仍点到了这些段落" : ""
        }
      };
    }
    const reason = skipped[0]?.reason
      || (finding.source === "rule" && finding.type === "term_usage_gap" ? REPAIR_SKIP_REASONS.report_only : REPAIR_SKIP_REASONS.no_evidence);
    return { ...finding, repair: { status: "skipped", reason } };
  });
}

/**
 * 交付前一致性核对 + 质量报告 + 有依据的自动统一。
 * 确定性部分（同原文不同译文、术语登记译法未采用）不花额度先算；语义漂移分片交给模型，
 * 模型只报漂移与候选写法，统一成哪个由证据定案（见 src/consistency-repair.mjs）。
 * 结果写回批次记录，供批次页与任务中心查看。
 */
async function runConsistencyCheck(batchId, { taskId = "" } = {}) {
  const run = await getBatchRun(batchId);
  if (!run) throw new Error("未找到这条翻译任务");
  const segments = Array.isArray(run.segments) ? run.segments : [];
  const translated = segments.filter((segment) => segment.selected !== false && String(segment.translation || "").trim());
  if (!translated.length) throw new Error("这条任务还没有译文，无法核对一致性");
  const report = taskProgressReporter(taskId);
  const toPairs = (list) => list.map((segment) => ({
    id: String(segment.id || ""),
    source: String(segment.source || ""),
    translation: String(segment.translation || "")
  }));
  const pairs = toPairs(translated);
  const provider = getProviderConfig();
  const baseAssets = (await getProjectAssets(run.locale, run.projectId).catch(() => ({ assets: {} }))).assets || {};
  const assets = mergeWorkingAssets(baseAssets, run.runnerOptions?.workingGlossary, { batchId: run.batchId });
  // 先按当前主库 + 工作术语重算骨架，避免用户刚改过工作术语、旧骨架还带着未遮罩的词。
  const patternTerms = [...(baseAssets.terms || []), ...(run.runnerOptions?.workingGlossary?.terms || [])];
  for (const segment of segments) {
    if (segment.status !== "done" || !segment.result || !String(segment.source || "")) continue;
    segment.result = { ...segment.result, patternKey: buildPatternKey(segment.source, { terms: patternTerms }) };
  }
  const deterministic = deterministicConsistencyFindings(segments, { terms: assets.terms || [] });
  const styleProfile = await getProjectStyleProfile(run.locale, { projectId: run.projectId }).catch(() => null);
  const style = styleProfile ? {
    id: String(styleProfile.id || ""),
    name: String(styleProfile.name || ""),
    version: Number(styleProfile.version) || 0,
    instruction: String(styleProfile.instruction || ""),
    rules: (Array.isArray(styleProfile.rules) ? styleProfile.rules : [])
      .map((rule) => (typeof rule === "string" ? rule : rule?.text || rule?.instruction || ""))
      .filter(Boolean),
    registerPolicy: styleProfile.reviewRubric?.registerPolicy || null
  } : null;
  const termEvidence = consistencyTermEvidence(run, translated, assets);
  const tmSources = new Set(pairs.map((pair) => pair.source));
  for (const finding of [...deterministic]) {
    for (const term of finding.terms || []) tmSources.add(term.source);
  }
  const tmEvidence = await consistencyTmEvidence({
    locale: run.locale,
    projectId: run.projectId,
    contentType: run.contentType,
    domain: run.domain,
    sources: [...tmSources]
  });
  const chunks = splitConsistencyChunks(pairs);
  report({ phase: "checking", message: `正在核对跨条目一致性：0 / ${chunks.length} 片`, percent: 10, completed: 0, total: chunks.length });
  let completed = 0;
  const failures = [];
  const byId = new Map(pairs.map((pair) => [pair.id, pair]));
  const results = await runTaskPool(chunks, async (chunk) => {
    const chunkPairs = chunk.ids.map((id) => byId.get(id)).filter(Boolean);
    return checkBatchConsistencyWithModel({
      filename: run.filename,
      locale: run.locale,
      purpose: run.contentType || "general",
      pairs: chunkPairs,
      part: { index: chunk.index, total: chunks.length },
      evidence: consistencyChunkEvidence({ style, termEvidence, tmEvidence, pairs: chunkPairs }),
      toolRunner: buildReferenceToolRunner({ projectId: run.projectId })
    });
  }, {
    concurrency: CONSISTENCY_CHECK_CONCURRENCY,
    onSettled: (result) => {
      completed += 1;
      if (result.status === "rejected") failures.push(String(result.reason?.message || result.reason));
      report({
        phase: "checking",
        message: `正在核对跨条目一致性：${completed} / ${chunks.length} 片`,
        percent: 10 + Math.round((completed / chunks.length) * 20),
        completed,
        total: chunks.length
      });
    }
  });
  const modelFindings = mergeConsistencyFindings(results.filter((result) => result.status === "fulfilled").map((result) => result.value));
  const merged = [...deterministic, ...modelFindings];
  const repaired = await applyConsistencyRepairs({ run, segments, findings: merged, assets, taskId });
  const changedIds = new Set((repaired.repair.changed || []).map((change) => String(change.segmentId)));
  let verification = null;
  if (changedIds.size) {
    report({ phase: "verifying", message: `正在复核统一结果：0 片`, percent: 70, completed: 0, total: 1 });
    try {
      verification = await recheckConsistencyChunks({
        run,
        pairs: toPairs(repaired.segments.filter((segment) => segment.selected !== false && String(segment.translation || "").trim())),
        changedIds,
        style,
        termEvidence,
        tmEvidence
      });
    } catch (error) {
      verification = { checkedChunks: 0, remaining: [], failures: [error.message] };
    }
  }
  const findings = annotateConsistencyFindings(merged, repaired.repair, verification);
  const qualityReport = buildQualityReport({
    segments: repaired.segments, brief: run.contextBrief || null, findings, provider, styleProfile,
    batchId: run.batchId, filename: run.filename, locale: run.locale
  });
  const latest = await getBatchRun(batchId);
  // 写回前重新读一次批次，按 segment id 合并，避免覆盖这段时间里的并发改动。
  const latestSegments = Array.isArray(latest?.segments) ? latest.segments : [];
  const mergedSegments = latestSegments.length
    ? latestSegments.map((segment) => repaired.segments.find((item) => String(item.id) === String(segment.id)) || segment)
    : repaired.segments;
  const repairSummary = {
    at: repaired.repair.at,
    enabled: repaired.repair.enabled,
    blocked: repaired.repair.blocked,
    changed: repaired.repair.changed,
    skipped: repaired.repair.skipped,
    verification
  };
  await saveBatchRun({
    ...(latest || run),
    segments: mergedSegments,
    qualityReport: { report: qualityReport, findings, warning: failures[0] || "", repair: repairSummary }
  });
  return { report: qualityReport, findings, failures, repair: repairSummary };
}

/** 起一个一致性核对后台任务；同一批次已在跑时直接复用。 */
function startConsistencyCheck(batchId) {
  const running = consistencyCheckTasks.get(batchId);
  if (running) return running;
  const tracked = (async () => {
    const run = await getBatchRun(batchId);
    if (!run) return { batchId, taskId: "", failed: "未找到这条翻译任务" };
    const task = await createBackgroundTask({
      type: "consistency_check",
      title: `一致性核对 · ${run.filename}`,
      locale: run.locale,
      projectId: run.projectId,
      progress: { phase: "queued", message: "已进入后台队列", total: (run.segments || []).length },
      payload: { batchId }
    });
    try {
      await attachBatchWorkflowTask(batchId, "qualityReport", task.id);
      const outcome = await runConsistencyCheck(batchId, { taskId: task.id });
      const repairedCount = (outcome.repair?.changed || []).length;
      await updateBackgroundTaskProgress(task.id, {
        status: outcome.failures.length ? "needs_attention" : "completed",
        progress: {
          phase: "completed",
          message: `一致性核对完成：${outcome.findings.length} 条待核对${repairedCount ? ` · 已按证据自动统一 ${repairedCount} 段` : ""}，质检覆盖率 ${outcome.report.coverage.percent}%`,
          percent: 100,
          completed: outcome.findings.length,
          total: outcome.findings.length
        },
        payload: { batchId, findings: outcome.findings.length, repaired: repairedCount, report: outcome.report, warning: outcome.failures[0] || "" }
      });
      return { batchId, taskId: task.id, ...outcome };
    } catch (error) {
      await updateBackgroundTaskProgress(task.id, {
        status: "failed",
        progress: { phase: "failed", message: error.message, percent: 100 }
      }).catch(() => {});
      return { batchId, taskId: task.id, failed: error.message };
    }
  })().finally(() => consistencyCheckTasks.delete(batchId));
  consistencyCheckTasks.set(batchId, tracked);
  return tracked;
}

/**
 * 翻译期术语普查：整批翻完后让模型指出"像术语但库里没有"的说法，
 * 结果挂在批次记录的 runnerOptions.termSurvey 上，等审校回填时用人工终稿确认译法。
 *
 * 这一步失败不影响批次：只记一条失败任务，翻译结果照常使用。
 */
async function runTermSurvey(batchId, { taskId = "" } = {}) {
  const run = await getBatchRun(batchId);
  if (!run) throw new Error("未找到这条翻译任务");
  const pairs = surveyPairs(run.segments || []);
  if (!pairs.length) throw new Error("这条任务还没有译文，无法做术语普查");
  const chunks = splitConsistencyChunks(pairs);
  const byId = new Map(pairs.map((pair) => [pair.id, pair]));
  const existingTerms = (await getProjectAssets(run.locale, run.projectId).catch(() => ({ assets: {} }))).assets?.terms || [];
  const report = taskProgressReporter(taskId);
  report({ phase: "surveying", message: `正在查找疑似术语：0 / ${chunks.length} 片`, percent: 10, completed: 0, total: chunks.length });
  let completed = 0;
  const failures = [];
  const results = await runTaskPool(chunks, async (chunk) => surveyTermsWithModel({
    filename: run.filename,
    locale: run.locale,
    purpose: run.contentType || "general",
    pairs: chunk.ids.map((id) => byId.get(id)).filter(Boolean),
    part: { index: chunk.index, total: chunks.length },
    existingTerms
  }), {
    concurrency: CONSISTENCY_CHECK_CONCURRENCY,
    onSettled: (result) => {
      completed += 1;
      if (result.status === "rejected") failures.push(String(result.reason?.message || result.reason));
      report({
        phase: "surveying",
        message: `正在查找疑似术语：${completed} / ${chunks.length} 片`,
        percent: 10 + Math.round((completed / chunks.length) * 80),
        completed,
        total: chunks.length
      });
    }
  });
  const terms = normalizeSurveyTerms(
    results.filter((result) => result.status === "fulfilled").flatMap((result) => result.value?.terms || []),
    { existingTerms }
  );
  const analyzedPairs = results.reduce((total, result, index) => total + (result.status === "fulfilled" ? chunks[index].ids.length : 0), 0);
  const coverage = { analyzedPairs, totalSegments: (run.segments || []).filter((segment) => segment.selected !== false).length, chunks: chunks.length, failedChunks: failures.length };
  const latest = await getBatchRun(batchId) || run;
  await saveBatchRun({
    ...latest,
    runnerOptions: {
      ...(latest.runnerOptions || {}),
      termSurvey: {
        version: 1,
        filename: run.filename,
        model: getProviderConfig().model,
        generatedAt: new Date().toISOString(),
        terms,
        coverage,
        warning: failures[0] || ""
      }
    }
  });
  return { terms, failures, coverage };
}

/** 起一个术语普查后台任务；同一批次已在跑时直接复用。 */
function startTermSurvey(batchId) {
  const running = termSurveyTasks.get(batchId);
  if (running) return running;
  const tracked = (async () => {
    const run = await getBatchRun(batchId);
    if (!run) return { batchId, skipped: "not_found" };
    const task = await createBackgroundTask({
      type: "term_survey",
      title: `术语普查 · ${run.filename}`,
      locale: run.locale,
      projectId: run.projectId,
      progress: { phase: "queued", message: "已进入后台队列", total: (run.segments || []).length },
      payload: { batchId }
    });
    try {
      await attachBatchWorkflowTask(batchId, "termSurvey", task.id);
      const outcome = await runTermSurvey(batchId, { taskId: task.id });
      await updateBackgroundTaskProgress(task.id, {
        status: outcome.failures.length ? "needs_attention" : "completed",
        progress: {
          phase: "completed",
          message: outcome.terms.length
            ? `发现疑似术语 ${outcome.terms.length} 条：回填审校稿后会按人工终稿入库或转待审核`
            : "没有发现需要新增的术语",
          percent: 100,
          completed: outcome.terms.length,
          total: outcome.terms.length
        },
        payload: { batchId, candidateCount: outcome.terms.length, warning: outcome.failures[0] || "" }
      });
      return { batchId, taskId: task.id, ...outcome };
    } catch (error) {
      await updateBackgroundTaskProgress(task.id, {
        status: "failed",
        progress: { phase: "failed", message: `术语普查失败：${error.message}`, percent: 100 }
      }).catch(() => {});
      return { batchId, taskId: task.id, failed: error.message };
    }
  })().finally(() => termSurveyTasks.delete(batchId));
  termSurveyTasks.set(batchId, tracked);
  return tracked;
}

async function attachBatchWorkflowTask(batchId, stage, taskId) {
  const write = (batchWorkflowWrites.get(batchId) || Promise.resolve()).catch(() => {}).then(async () => {
    const run = await getBatchRun(batchId);
    if (!run) return;
    await saveBatchRun({ ...run, runnerOptions: { ...run.runnerOptions, workflowTasks: { ...run.runnerOptions?.workflowTasks, [stage]: taskId } } });
  });
  batchWorkflowWrites.set(batchId, write);
  try { await write; }
  finally { if (batchWorkflowWrites.get(batchId) === write) batchWorkflowWrites.delete(batchId); }
}

async function loadBatchWorkflow(run, knownTasks = new Map()) {
  if (!run.segments && !run.runnerOptions?.workflowTasks && ["completed", "needs_attention"].includes(run.runState)) {
    run = await getBatchRun(run.batchId) || run;
  }
  const ids = run.runnerOptions?.workflowTasks || {};
  const tasks = await Promise.all(["qualityReport", "termSurvey", "aiQa"].map((stage) => {
    const id = ids[stage];
    return id ? knownTasks.get(id) || getBackgroundTask(id) : null;
  }));
  const settings = getSettings();
  const workflow = buildBatchWorkflow(run, { qualityTask: tasks[0], termTask: tasks[1], qaTask: tasks[2],
    autoConsistencyCheck: settings.quality?.autoConsistencyCheck !== false, termSurveyEnabled: settings.learning.termSurveyEnabled !== false });
  if (!batchWorkers.has(run.batchId) && !batchQaWorkers.has(run.batchId)) {
    for (const [index, stage, running] of [[0, "qualityReport", consistencyCheckTasks], [1, "termSurvey", termSurveyTasks]]) {
      if (workflow[stage].status === "waiting" && !running.has(run.batchId) && tasks[index]?.status !== "in_progress") {
        workflow[stage] = { status: "not_started", message: `${stage === "qualityReport" ? "质量报告" : "术语普查"}尚未执行，可手动运行；补跑翻译或 QA 后也会自动触发` };
      }
    }
  }
  return { ...workflow, qaRetryBusy: batchQaWorkers.has(run.batchId) };
}

async function finalizeBatchWorkflow(batchId) {
  // 保留先统一译文、再做普查的顺序，避免两份批次快照相互覆盖；失败仍继续下一步。
  if (getSettings().quality?.autoConsistencyCheck !== false) {
    await startConsistencyCheck(batchId).catch((error) => console.error(`[Kami] 批次 ${batchId} 质量报告失败`, error));
  }
  if (getSettings().learning.termSurveyEnabled !== false) {
    await startTermSurvey(batchId).catch((error) => console.error(`[Kami] 批次 ${batchId} 术语普查失败`, error));
  }
}

function startBatchQaRetry(batchId, taskId, segmentIds) {
  const control = beginBackgroundRun(taskId);
  const tracked = (async () => {
    // 收尾正在写批次时先等它结束，避免 QA 与一致性修复互相覆盖。
    const worker = batchWorkers.get(batchId);
    await worker?.translationSettled;
    await worker?.followupPromise;
    await Promise.all([consistencyCheckTasks.get(batchId), termSurveyTasks.get(batchId)]);
    await attachBatchWorkflowTask(batchId, "aiQa", taskId);
    const outcome = await retryServerBatchQa(batchId, {
      loadRun: getBatchRun, saveRun: saveBatchRun, segmentIds,
      recheckSegment: (body) => translateBatchSegment(body, "/api/qa"),
      shouldCancel: () => control.cancelRequested,
      report: ({ completed, failed, total }) => updateBackgroundTaskProgress(taskId, {
        progress: { phase: "checking", message: `AIQA 重试：${completed} / ${total} 段${failed ? ` · ${failed} 段仍未完成` : ""}`,
          percent: total ? Math.round(completed / total * 100) : 100, completed, total, failed }
      })
    });
    const latest = await getBatchRun(batchId);
    if (latest && !outcome.cancelled) await saveBatchRun({ ...latest, runnerOptions: { ...latest.runnerOptions, qaCompletedAt: new Date().toISOString() } });
    await updateBackgroundTaskProgress(taskId, {
      status: outcome.cancelled || outcome.failed ? "needs_attention" : "completed",
      progress: { phase: outcome.cancelled ? "cancelled" : "completed", percent: 100, completed: outcome.completed, total: outcome.total, failed: outcome.failed,
        message: outcome.cancelled ? "AIQA 重试已中断，已完成结果保留" : `AIQA 重试已结束：成功 ${outcome.completed - outcome.failed} 段${outcome.failed ? ` · ${outcome.failed} 段仍未完成` : ""}` },
      payload: { batchId }
    });
    if (latest && !outcome.cancelled) await finalizeBatchWorkflow(batchId);
  })().catch(async (error) => {
    await updateBackgroundTaskProgress(taskId, { status: "failed", progress: { phase: "failed", message: `AIQA 重试失败：${error.message}` }, payload: { batchId } }).catch(() => {});
  }).finally(() => { endBackgroundRun(taskId); batchQaWorkers.delete(batchId); });
  batchQaWorkers.set(batchId, { taskId, promise: tracked });
}

function startBatchWorker(batchId, backgroundTaskId = "") {
  const existing = batchWorkers.get(batchId);
  if (existing) return existing;
  const controller = { pauseRequested: false, cancelRequested: false, promise: null, backgroundTaskId };
  let settleTranslation;
  controller.translationSettled = new Promise((resolve) => { settleTranslation = resolve; });
  const sessionId = `batch:${batchId}`;
  const heartbeat = setInterval(() => workbenchSessionMonitor?.touch(sessionId), 5_000);
  heartbeat.unref?.();
  workbenchSessionMonitor?.touch(sessionId);
  controller.promise = runServerBatch(batchId, {
    loadRun: getBatchRun,
    saveRun: async (run) => {
      await saveBatchRun(run);
      if (backgroundTaskId) {
        const selected = (run.segments || []).filter((segment) => segment.selected !== false);
        const completed = selected.filter((segment) => segment.status === "done").length;
        const failed = selected.filter((segment) => segment.status === "error").length;
        await updateBackgroundTaskProgress(backgroundTaskId, {
          status: run.runState === "completed" ? "completed" : run.runState === "needs_attention" ? "failed" : run.runnerOptions?.cancelled ? "needs_attention" : "in_progress",
          // 批次号与"可继续"标记：任务中心的「继续」靠它们找得到这个批次。
          payload: { batchId: run.batchId, filename: run.filename, resumable: true },
          progress: {
            phase: run.runnerOptions?.cancelled ? "cancelled" : run.runState || "running",
            message: run.runnerOptions?.cancelled ? `批次已中断：已完成 ${completed} / ${selected.length} 段，可继续` : run.runState === "paused" ? "批次已暂停" : `正在翻译：${completed} / ${selected.length}`,
            percent: selected.length ? Math.round((completed / selected.length) * 100) : 0,
            completed,
            total: selected.length,
            failed
          }
        });
      }
    },
    loadProject: getProject,
    classifyDocument: async (text) => (await classify({ text, hint: "auto", useModel: true })).contentType,
    translateSegment: translateBatchSegment,
    loadTermSources: async (run) => (await getProjectAssets(run.locale, run.projectId).catch(() => ({ assets: {} }))).assets?.terms || [],
    loadWorkingGlossary: async (run) => workingGlossaryOverrides.get(run.batchId) || null,
    learnTerms: async ({ run, segment, translation }) => {
      if (getSettings().learning.workingTermsEnabled === false) return [];
      const formalTerms = (await getProjectAssets(run.locale, run.projectId).catch(() => ({ assets: {} }))).assets?.terms || [];
      const raw = await learnWorkingTermsWithModel({
        source: segment.source,
        translation,
        existingTerms: formalTerms,
        workingTerms: run.runnerOptions?.workingGlossary?.terms || [],
        filename: run.filename,
        locale: run.locale,
        purpose: run.contentType || "general"
      });
      return normalizeWorkingTerms(raw, {
        formalTerms,
        sourceText: segment.source,
        targetText: translation,
        sourceSegmentId: segment.id
      });
    },
    shouldPause: () => controller.pauseRequested,
    shouldCancel: () => controller.cancelRequested,
    touch: () => workbenchSessionMonitor?.touch(sessionId),
    review: async (run) => runEvolutionReview({
      locale: run.locale,
      contentType: run.contentType,
      domain: run.domain,
      batchId: run.batchId,
      projectId: run.projectId,
      threshold: getSettings().learning.styleDistillThreshold,
      growthWindow: getSettings().learning.styleDistillGrowthWindow,
      positiveLimit: getSettings().learning.distillPositiveSamples,
      negativeLimit: getSettings().learning.distillNegativeSamples,
      staleRounds: getSettings().learning.ruleStaleRounds
    }),
    // 整批翻完之后自动跑一次交付前闭环：一致性核对 + 质量报告。
    // 这一步失败不影响批次完成状态，批次页可以手动重跑。
    finalize: (run) => {
      controller.translationComplete = true;
      controller.followupActive = true;
      controller.followupPromise = finalizeBatchWorkflow(run.batchId).finally(() => { controller.followupActive = false; });
      settleTranslation();
      return controller.followupPromise;
    }
  }).catch(async (error) => {
    const run = await getBatchRun(batchId).catch(() => null);
    if (run) await saveBatchRun({ ...run, runState: "needs_attention", runnerOptions: { ...run.runnerOptions, translationError: error.message } }).catch(() => {});
    if (backgroundTaskId) await updateBackgroundTaskProgress(backgroundTaskId, { status: "failed", progress: { phase: "failed", message: error.message, percent: 100 } }).catch(() => {});
    console.error(`后台批次 ${batchId} 失败`, error);
  }).finally(() => {
    settleTranslation();
    clearInterval(heartbeat);
    workbenchSessionMonitor?.close(sessionId);
    batchWorkers.delete(batchId);
  });
  batchWorkers.set(batchId, controller);
  return controller;
}

async function apiHandler(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, version: "0.7.0", locales: ACTIVE_LOCALES, backend: getStoreMetadata() });
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    // 日志界面：按"至少这个等级 + 关键词 + 起始时间"过滤，默认最近 300 条（最新在前）。
    const entries = listLogs({
      level: String(url.searchParams.get("level") || "").trim(),
      search: String(url.searchParams.get("search") || "").trim(),
      since: String(url.searchParams.get("since") || "").trim(),
      limit: Number(url.searchParams.get("limit")) || 300
    });
    return json(res, 200, { entries, settings: getLogSettings() });
  }
  if (req.method === "POST" && url.pathname === "/api/logs/settings") {
    const body = await readJsonBody(req);
    return json(res, 200, setLogLevel(body.level));
  }
  if (req.method === "DELETE" && url.pathname === "/api/logs") {
    const settings = clearLogs();
    logInfo("日志已清空");
    return json(res, 200, settings);
  }
  if (req.method === "GET" && url.pathname === "/api/logs/download") {
    const body = readLogFile();
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("kami.log")}`
    });
    res.end(body || "");
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/logs/client") {
    // 界面侧的报错（请求失败、未捕获异常）也写进同一份日志，
    // 这样"提示闪一下就没了"之后还能回来查原因。
    const body = await readJsonBody(req);
    const level = ["debug", "info", "warn", "error"].includes(String(body.level)) ? String(body.level) : "error";
    const entry = writeLog(level, `[界面] ${String(body.message || "").slice(0, 1_000)}`, body.detail ? { detail: body.detail, path: body.path || "" } : { path: body.path || "" });
    return json(res, 200, { ok: Boolean(entry) });
  }
  if (req.method === "POST" && url.pathname === "/api/workbench-session") {
    const sessionId = readWorkbenchSessionId(await readJsonBody(req));
    const accepted = workbenchSessionMonitor ? workbenchSessionMonitor.touch(sessionId) : true;
    return json(res, accepted ? 200 : 409, { ok: accepted, managed: Boolean(workbenchSessionMonitor) });
  }
  if (req.method === "POST" && url.pathname === "/api/workbench-session/close") {
    const sessionId = readWorkbenchSessionId(await readJsonBody(req));
    const accepted = workbenchSessionMonitor ? workbenchSessionMonitor.close(sessionId) : true;
    return json(res, accepted ? 200 : 409, { ok: accepted, managed: Boolean(workbenchSessionMonitor) });
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const assets = {};
    for (const locale of ACTIVE_LOCALES) {
      const stats = await getAssetStats(locale);
      assets[locale] = { revision: stats.revision, termCount: stats.termCount };
    }
    return json(res, 200, { locales: Object.fromEntries(ACTIVE_LOCALES.map((locale) => [locale, LOCALES[locale]])), contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS, provider: getProviderConfig(), backend: getStoreMetadata(), assets });
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    return json(res, 200, { projects: await getProjects({ status: url.searchParams.get("status") || "active" }) });
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJsonBody(req);
    const project = await saveProject({ name: body.name, description: body.description, settings: body.settings });
    const libraries = [];
    for (const seed of [
      { name: "术语库", kind: "term_base", role: "reference", priority: 1 },
      { name: "主 TM", kind: "translation_memory", role: "master", priority: 1 },
      { name: "工作 TM", kind: "translation_memory", role: "working", priority: 2 }
    ]) libraries.push(await saveResourceLibrary({ projectId: project.id, ...seed }));
    return json(res, 201, { project, libraries });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/projects/") && url.pathname.endsWith("/libraries")) {
    const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length, -"/libraries".length));
    const project = await getProject(projectId);
    if (!project) return json(res, 404, { error: "项目不存在" });
    const libraries = await getResourceLibraries(projectId);
    if (url.searchParams.get("withStats") !== "1") return json(res, 200, { projectId, libraries });
    // 库页面要显示"这个库里到底有多少条"：entry_count 列是历史遗留、从不更新，
    // 所以按 library_id 现算（一次 groupBy 聚合同时拿条目数与最新条目时间）。
    const stats = await getLibraryStats("zh-CN", projectId);
    return json(res, 200, {
      projectId,
      libraries: libraries.map((library) => ({
        ...library,
        entryCount: stats.get(library.id)?.entryCount || 0,
        lastEntryAt: stats.get(library.id)?.lastEntryAt || "",
        // TM 库里的"几个文件"：工作 TM 是按翻译文件累积的，库行要能看出来。
        fileCount: stats.get(library.id)?.fileCount || 0,
        latestFile: stats.get(library.id)?.latestFile || ""
      }))
    });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/projects/") && url.pathname.endsWith("/libraries")) {
    const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length, -"/libraries".length));
    if (!await getProject(projectId)) return json(res, 404, { error: "项目不存在" });
    const body = await readJsonBody(req);
    return json(res, 201, { library: await saveResourceLibrary({ ...body, projectId }) });
  }
  if ((req.method === "PATCH" || req.method === "DELETE") && url.pathname.startsWith("/api/projects/") && url.pathname.includes("/libraries/")) {
    const prefix = "/api/projects/";
    const marker = "/libraries/";
    const rest = url.pathname.slice(prefix.length);
    const markerIndex = rest.indexOf(marker);
    const projectId = decodeURIComponent(markerIndex >= 0 ? rest.slice(0, markerIndex) : "");
    const libraryId = decodeURIComponent(markerIndex >= 0 ? rest.slice(markerIndex + marker.length) : "");
    if (!projectId || !libraryId || !(await getProject(projectId))) return json(res, 404, { error: "项目或资源库不存在" });
    if (req.method === "DELETE") {
      const deleted = await deleteResourceLibrary(projectId, libraryId);
      return deleted ? json(res, 200, { ok: true, projectId, libraryId }) : json(res, 404, { error: "资源库不存在" });
    }
    const body = await readJsonBody(req);
    const existing = (await getResourceLibraries(projectId)).find((library) => library.id === libraryId);
    if (!existing) return json(res, 404, { error: "资源库不存在" });
    return json(res, 200, { library: await saveResourceLibrary({ ...existing, ...body, id: libraryId, projectId }) });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/projects/")) {
    const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
    const project = await getProject(projectId);
    return project ? json(res, 200, { ...project, qaRuleMetadata: projectRuleMetadata() }) : json(res, 404, { error: "项目不存在" });
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
    const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
    const body = await readJsonBody(req);
    const project = await getProject(projectId);
    if (!project) return json(res, 404, { error: "项目不存在" });
    return json(res, 200, await saveProject({ ...project, ...body, id: projectId }));
  }
  if (req.method === "DELETE" && /^\/api\/projects\/[^/]+$/u.test(url.pathname)) {
    const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
    if (url.searchParams.get("purge") === "1") {
      const result = await purgeProject(projectId);
      return result
        ? json(res, 200, { ok: true, purged: true, project: result.project, deleted: result.total })
        : json(res, 404, { error: "项目不存在" });
    }
    const project = await deleteProject(projectId);
    return project ? json(res, 200, { ok: true, purged: false, project }) : json(res, 404, { error: "项目不存在" });
  }
  if (req.method === "GET" && url.pathname === "/api/memories") {
    const locale = assertActiveLocale(url.searchParams.get("locale") || "zh-CN");
    // 列表按页取，另外单独统计总数：页面写"已显示 N / 共 M 条"，搜索也在服务端做，
    // 否则用户只能搜到已加载的那一页。
    const filters = {
      projectId: url.searchParams.get("projectId") || "",
      contentType: "general",
      domain: "general",
      search: (url.searchParams.get("search") || "").trim()
    };
    const limit = Math.min(MEMORY_LIST_MAX, Math.max(1, Number(url.searchParams.get("limit")) || MEMORY_LIST_LIMIT));
    const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
    const [memories, total] = await Promise.all([
      getMemories(locale, { ...filters, limit, offset }),
      countMemories(locale, filters)
    ]);
    return json(res, 200, { memories, total, limit, offset });
  }
  if ((req.method === "PATCH" || req.method === "DELETE") && url.pathname.startsWith("/api/memories/")) {
    const locale = assertActiveLocale(url.searchParams.get("locale") || "zh-CN");
    const id = decodeURIComponent(url.pathname.slice("/api/memories/".length));
    if (req.method === "DELETE") {
      const deleted = await deleteMemory(locale, id);
      return json(res, deleted ? 200 : 404, { deleted });
    }
    const body = await readJsonBody(req);
    const updated = await updateMemory(locale, id, {
      source: body.source,
      target: body.target,
      entryKey: body.entryKey,
      qualityStatus: body.qualityStatus
    });
    return updated ? json(res, 200, { memory: updated }) : json(res, 404, { error: "这条 TM 条目不存在" });
  }
  if (req.method === "GET" && url.pathname === "/api/assets") {
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    return json(res, 200, (await getProjectAssets(locale, url.searchParams.get("projectId") || "")).assets);
  }
  if (req.method === "POST" && url.pathname === "/api/assets") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const projectId = String(body.projectId || body.term?.projectId || "").trim();
    const term = { ...(body.term || {}), projectId };
    // 术语列表与模型参考只认"项目里启用的术语库"的条目：单条新增过去不写
    // library_id，保存后既不出现在列表里、也不参与翻译。这里补上归属。
    if (projectId && !term.libraryId) {
      // 编辑已有条目时要保留它原来的库归属，不能顺手挪到默认库。
      const existing = term.id ? await getAsset(locale, term.id).catch(() => null) : null;
      if (existing?.libraryId) {
        term.libraryId = existing.libraryId;
      } else {
        const libraries = await getResourceLibraries(projectId, { kind: "term_base" });
        const library = libraries.find((item) => item.enabled) || libraries[0];
        if (!library) throw Object.assign(new Error("这个项目还没有术语库，无法加入这条术语；请先在项目设置里新建术语库"), { statusCode: 400 });
        term.libraryId = library.id;
      }
    }
    return json(res, term.id ? 200 : 201, await saveAsset(locale, term));
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/assets/")) {
    // 编辑术语：先读回现有行再合并，只改内容字段，不动 library_id / 归属。
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const id = decodeURIComponent(url.pathname.slice("/api/assets/".length));
    const existing = await getAsset(locale, id);
    if (!existing) return json(res, 404, { error: "这条术语不存在" });
    const body = await readJsonBody(req);
    const term = {
      ...existing,
      ...(body.source === undefined ? {} : { source: body.source }),
      ...(body.target === undefined ? {} : { target: body.target }),
      ...(body.aliases === undefined ? {} : { aliases: body.aliases }),
      ...(body.forbidden === undefined ? {} : { forbidden: body.forbidden }),
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.contentTypes === undefined ? {} : { contentTypes: body.contentTypes }),
      ...(body.enforcement === undefined ? {} : { enforcement: body.enforcement }),
      id
    };
    return json(res, 200, await saveAsset(locale, term));
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/assets/")) {
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const id = decodeURIComponent(url.pathname.slice("/api/assets/".length));
    const deleted = await deleteAsset(locale, id);
    return json(res, deleted ? 200 : 404, { deleted });
  }
  if (req.method === "GET" && url.pathname === "/api/library-entries") {
    // 库页面：按库过滤 + 搜索 + 分页。libraryId 为空表示"全部库（合并视图）"。
    const locale = assertActiveLocale(url.searchParams.get("locale") || "zh-CN");
    const kind = url.searchParams.get("kind") === "tm" ? "tm" : "term";
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    if (!projectId) return json(res, 400, { error: "缺少项目" });
    const libraryId = String(url.searchParams.get("libraryId") || "").trim();
    const limit = Math.min(1_000, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
    const result = await listLibraryEntries({
      locale, kind, projectId, libraryId,
      // sourceFile=__none__ 表示"未标注来源"那一桶（单句翻译等没有文件名的行）。
      sourceFile: (url.searchParams.get("sourceFile") || "").trim(),
      search: (url.searchParams.get("search") || "").trim(),
      limit, offset
    });
    return json(res, 200, { ...result, kind, libraryId, sourceFile: (url.searchParams.get("sourceFile") || "").trim(), limit, offset });
  }
  if (req.method === "GET" && url.pathname === "/api/library-files") {
    // 库 → 文件 → 条目 的中间层：TM 库里每个来源文件多少条、几个批次、最近什么时候。
    const locale = assertActiveLocale(url.searchParams.get("locale") || "zh-CN");
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    const libraryId = String(url.searchParams.get("libraryId") || "").trim();
    if (!projectId || !libraryId) return json(res, 400, { error: "缺少项目或资源库" });
    const files = await listLibraryFiles({ locale, projectId, libraryId });
    // 文件层顺带回答两个问题：这个文件翻译到哪一步了（批次进度）、有没有学习轨迹。
    // 轨迹里带 human_decision.accepted 就说明人工审校版本已经回填过这个文件。
    const [runs, trajectoryCounts] = await Promise.all([
      listBatchRuns({ locale, projectId, limit: 500 }).catch(() => []),
      countLearningTrajectoriesByFile({ locale, project: projectId }).catch(() => [])
    ]);
    // 批次列表已按最近更新时间倒序：同名文件取第一条就是最新的那次翻译。
    const runByFile = new Map();
    for (const run of runs) {
      const name = String(run.filename || "").trim();
      if (!name || runByFile.has(name)) continue;
      runByFile.set(name, run);
    }
    const learningByFile = new Map(trajectoryCounts.map((item) => [item.sourceFile, item]));
    return json(res, 200, {
      libraryId,
      files: files.map((file) => {
        const name = String(file.sourceFile || "").trim();
        const run = name ? runByFile.get(name) : null;
        const learning = learningByFile.get(name);
        return {
          ...file,
          batch: run ? {
            batchId: run.batchId, status: run.status, runState: run.runState,
            totalSegments: run.totalSegments, completedSegments: run.completedSegments,
            failedSegments: run.failedSegments, qaPending: run.qaPending,
            qualityTiers: run.qualityTiers || null,
            updatedAt: run.updatedAt
          } : null,
          learning: { count: Number(learning?.count) || 0, humanReviewed: Number(learning?.humanReviewed) || 0 }
        };
      })
    });
  }
  if (req.method === "DELETE" && url.pathname === "/api/library-entries") {
    // "删库并删除库内条目"：先按库把条目 id 全量取回，再分批删（逐条 DELETE 在
    // 几千条规模下要跑几分钟）。删完顺手清一次库统计缓存。
    const locale = assertActiveLocale(url.searchParams.get("locale") || "zh-CN");
    const kind = url.searchParams.get("kind") === "tm" ? "tm" : "term";
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    const libraryId = String(url.searchParams.get("libraryId") || "").trim();
    if (!projectId || !libraryId) return json(res, 400, { error: "缺少项目或资源库" });
    const sourceFile = (url.searchParams.get("sourceFile") || "").trim();
    const { items } = await listLibraryEntries({ locale, kind, projectId, libraryId, sourceFile, search: "", limit: 0, offset: 0 });
    const ids = items.map((item) => item.id);
    const deleted = await deleteLibraryEntries(locale, kind, ids);
    logInfo("已删除库内条目", { locale, kind, libraryId, sourceFile, requested: ids.length, deleted });
    return json(res, 200, { deleted, requested: ids.length });
  }
  if (req.method === "POST" && url.pathname === "/api/library-export") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale || "zh-CN");
    const projectId = String(body.projectId || "").trim();
    if (!projectId || !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    const kind = body.kind === "tm" ? "tm" : "term";
    const libraryId = String(body.libraryId || "").trim();
    const sourceFile = String(body.sourceFile || "").trim();
    const libraries = await getResourceLibraries(projectId);
    const library = libraryId ? libraries.find((item) => item.id === libraryId) : null;
    if (libraryId && !library) return json(res, 404, { error: "资源库不存在或不属于当前项目" });
    const fileLabel = sourceFile ? ` · ${sourceFile === "__none__" ? "未标注来源" : sourceFile}` : "";
    const label = `${library ? library.name : `全部${kind === "tm" ? " TM" : "术语"}库`}${fileLabel}`;
    const task = await createBackgroundTask({
      type: "batch_export",
      title: `导出 · ${label}`,
      locale,
      projectId,
      progress: { phase: "exporting", message: "正在读取库内条目", percent: 10, completed: 0, total: 1 }
    });
    (async () => {
      try {
        const { items } = await listLibraryEntries({ locale, kind, projectId, libraryId, sourceFile, search: "", limit: 0, offset: 0 });
        await updateBackgroundTaskProgress(task.id, { progress: { phase: "exporting", message: `正在生成表格（${items.length} 条）`, percent: 55, completed: 0, total: items.length } });
        const exported = await buildLibraryExport({ kind, locale, libraryName: label, items });
        const directory = join(DATA_ROOT, "exports");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${task.id}.xlsx`), exported.buffer);
        await updateBackgroundTaskProgress(task.id, {
          status: "completed",
          progress: { phase: "completed", message: `导出完成：${items.length} 条`, percent: 100, completed: items.length, total: items.length },
          payload: {
            kind: "library_export",
            libraryId,
            libraryName: label,
            sourceFile,
            count: items.length,
            filename: exported.filename,
            mimeType: exported.mimeType,
            bytes: exported.buffer.length,
            downloadUrl: `/api/export-tasks/${task.id}/download`
          }
        });
      } catch (error) {
        await updateBackgroundTaskProgress(task.id, {
          status: "failed",
          progress: { phase: "failed", message: error.message, percent: 100, completed: 0, total: 1 },
          payload: { kind: "library_export", libraryId, libraryName: label, error: error.message }
        });
        console.error("[Kami] 库导出失败", error);
      }
    })().catch((error) => console.error("[Kami] 库导出后台任务异常", error));
    return json(res, 202, { taskId: task.id, backgroundTaskId: task.id, message: "导出已进入任务中心后台处理" });
  }
  if (req.method === "POST" && url.pathname === "/api/learning/conflict-scan") {
    const body = await readJsonBody(req);
    // 语体/领域只作参考：冲突审查按「语言 × 项目」整体扫一次。
    const scope = learningScope({ locale: assertActiveLocale(body.locale), project: body.project || "default" });
    return json(res, 200, await conflictScanner.scan(scope));
  }
  if (req.method === "POST" && url.pathname === "/api/learning/conflict-scan/apply") {
    // 扫描负责衡量，改写要人点。风格规则是唯一可以在这里就地退休的：
    // 技能规则须经配对评测晋升，译者画像走草稿流程，两者都不从这里绕过去。
    const body = await readJsonBody(req);
    const scope = learningScope({ locale: assertActiveLocale(body.locale), project: body.project || "default" });
    const ruleId = String(body.ruleId || "").trim();
    if (!ruleId) return json(res, 400, { error: "缺少要退休的规则 id" });
    const profile = await getProjectStyleProfile(scope.locale, { projectId: scope.project });
    if (!profile?.id) return json(res, 404, { error: "该项目没有生效中的风格规范" });
    const rules = retireRule(profile.rules, ruleId, { reason: String(body.reason || "").slice(0, 300) });
    if (!rules) return json(res, 409, { error: "该规则不存在或已经退休" });
    const updated = await updateStyleProfileRules(profile.id, {
      rules,
      instruction: renderInstruction(rules, profile.instruction)
    });
    // 退休之后原来的冲突已经不成立，立刻重扫一遍，免得报告继续显示旧结论。
    const report = await conflictScanner.scan(scope);
    return json(res, 200, { retired: ruleId, profileId: profile.id, activeRules: rules.filter((rule) => rule.status === "active").length, instruction: updated?.instruction || "", report });
  }
  if (req.method === "GET" && url.pathname === "/api/learning/conflict-scan") {
    const scope = learningScope({
      locale: assertActiveLocale(url.searchParams.get("locale")),
      project: url.searchParams.get("project") || "default"
    });
    return json(res, 200, conflictReports.get(learningScopeKeyOf(scope)) || { scope, conflicts: [], reason: "尚未扫描" });
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json(res, 200, {
      settings: getSettings(),
      groups: settingGroups(),
      titleBracketChoices: TITLE_BRACKET_CHOICES,
      locales: Object.fromEntries(ACTIVE_LOCALES.map((locale) => [locale, LOCALES[locale].label])),
      environmentOverrides: environmentOverrides()
    });
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    // 净化明细一并返回：被夹紧或整组回落时必须让人看见，不能悄悄改掉用户输入。
    const { settings, notes } = body?.reset === true ? resetSettings() : saveSettings(body?.settings ?? body);
    rescheduleConflictScan();
    return json(res, 200, { settings, notes, environmentOverrides: environmentOverrides() });
  }
  if (req.method === "POST" && url.pathname === "/api/classify") {
    const body = await readJsonBody(req);
    const classification = await classify(body);
    // 领域与语体一起返回，界面在开始翻译前就能看出「自动识别」会落到哪里。
    return json(res, 200, {
      ...classification,
      domainResolution: resolveDomain(body.text, body.domain, { contentType: classification.contentType })
    });
  }
  if (req.method === "POST" && url.pathname === "/api/match") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const projectId = String(body.projectId || "").trim();
    const assets = (await getProjectAssets(locale, projectId)).assets;
    if (projectId && !(await getProject(projectId))) {
      const error = new Error("项目不存在");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, {
      locale,
      matches: matchTerms(body.text, assets, { contentType: body.contentType, domain: body.domain, ...deliveryContext(body, body.text) })
    });
  }
  if (req.method === "POST" && url.pathname === "/api/corpus/refine") {
    const body = await readJsonBody(req);
    const refined = refineCorpus(body.text, body.options);
    return json(res, 200, refined);
  }
  if (req.method === "POST" && url.pathname === "/api/corpus") {
    const body = await readJsonBody(req);
    const refined = refineCorpus(body.text, body.options);
    return json(res, 201, await saveCorpus({ ...body, ...refined }));
  }
  if (req.method === "POST" && url.pathname === "/api/tm-import/preview") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const projectId = String(body.projectId || "").trim();
    if (!projectId || !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    // 记忆库可以一次选多个文件：files 数组优先，单文件参数继续兼容。
    const files = (Array.isArray(body.files) && body.files.length
      ? body.files
      : [{ filename: body.filename, base64: body.base64 }])
      .map((file) => ({ filename: String(file?.filename || "").trim(), base64: String(file?.base64 || "").replace(/^data:[^;]+;base64,/u, "") }))
      .filter((file) => file.filename || file.base64);
    if (!files.length) return json(res, 400, { error: "没有待导入的人工 TM 文件" });
    const unsupported = files.find((file) => !/\.(xlsx|csv|xliff|mqxliff)$/iu.test(file.filename));
    if (unsupported) return json(res, 400, { error: `人工 TM 只支持 .xlsx、.csv、.xliff、.mqxliff：${unsupported.filename}` });
    // 统一单文件上限：xlsx/csv 在解析器里也有同样的闸门，这里补上 XLIFF 这一路。
    const tooLarge = files.find((file) => Buffer.byteLength(String(file.base64 || ""), "base64") > IMPORT_FILE_BYTES);
    if (tooLarge) return json(res, 400, { error: `${tooLarge.filename} 超过单文件 ${Math.round(IMPORT_FILE_BYTES / (1024 * 1024))}MB 上限` });
    const candidates = [];
    let rowsScanned = 0;
    let totalRows = 0;
    let rowLimit = 0;
    let truncation = null;
    const fileTypes = new Set();
    for (const file of files) {
      let pairs;
      let parsed = null;
      if (/\.(xlsx|csv)$/iu.test(file.filename)) {
        parsed = await extractTermPairs({ filename: file.filename, base64: file.base64, locale: "zh-CN" });
        pairs = parsed.candidates.map((candidate) => ({
          entryId: candidate.entryId || "",
          source: candidate.source,
          target: candidate.target,
          note: candidate.note || "",
          previousSource: "",
          nextSource: "",
          context: candidate.sheet || "",
          sourceRow: candidate.rowNumber || null,
          sheet: candidate.sheet || ""
        }));
      } else {
        pairs = extractXliffPairs(Buffer.from(file.base64, "base64"), file.filename);
      }
      rowsScanned += pairs.length;
      // 整表行数用于界面提示（"共 N 行 / 本次读取 M 行"），XLIFF 没有行概念就按候选数记。
      totalRows += Number(parsed?.statistics?.totalRows) || pairs.length;
      if (Number(parsed?.statistics?.rowLimit) > 0) rowLimit = Number(parsed.statistics.rowLimit);
      fileTypes.add(file.filename.toLowerCase().endsWith(".mqxliff") ? "mqxliff" : file.filename.toLowerCase().endsWith(".xliff") ? "xliff" : file.filename.toLowerCase().endsWith(".csv") ? "csv" : "xlsx");
      pairs.forEach((pair, index) => {
        candidates.push({
          ...pair, locale: "zh-CN", assetType: "memory", decision: "ready", selected: true,
          rowNumber: index + 1, score: 1, contentType: "general", domain: "general",
          sourceFile: file.filename, sourceRow: pair.sourceRow || index + 1
        });
      });
      // 单表读取上限命中时要明确报出来：静默少读 89% 是最坏的一种"成功"。
      if (parsed?.statistics?.truncated) {
        truncation = {
          file: file.filename,
          totalRows: parsed.statistics.totalRows,
          rowsScanned: parsed.statistics.rowsScanned,
          rowLimit: parsed.statistics.rowLimit
        };
      }
    }
    const batchId = randomUUID();
    // 候选留在服务端：8 万条候选序列化约 49MB，来回传两次既慢又会撞上请求体上限。
    await writePreviewCache({
      batchId,
      meta: {
        filename: files.length === 1 ? files[0].filename : `${files[0].filename} 等 ${files.length} 个文件`,
        fileType: "tm",
        sourceFileType: [...fileTypes][0] || "xlsx",
        projectId,
        requestedLocale: "zh-CN",
        files: files.map((file) => file.filename),
        statistics: { rowsScanned, pairedRows: candidates.length, totalRows, rowLimit, truncated: Boolean(truncation), ...(truncation || {}) }
      },
      candidates
    });
    return json(res, 200, {
      batchId,
      filename: files.length === 1 ? files[0].filename : `${files[0].filename} 等 ${files.length} 个文件`,
      fileType: "tm",
      sourceFileType: [...fileTypes][0] || "xlsx",
      projectId,
      // 只回一页样例：列表要看完就按页取（GET /api/tm-import/preview/:batchId）。
      candidates: candidates.slice(0, TM_PREVIEW_SAMPLE),
      total: candidates.length,
      sampleLimit: TM_PREVIEW_SAMPLE,
      files: files.map((file) => file.filename),
      statistics: { rowsScanned, pairedRows: candidates.length, totalRows, rowLimit, truncated: Boolean(truncation), ...(truncation || {}) },
      write: { modelCalled: false, databaseWritten: false }
    });
  }
  // 预检列表分页：只回一页候选，避免把 49MB 候选一次性塞进浏览器。
  if (req.method === "GET" && url.pathname.startsWith("/api/tm-import/preview/")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/tm-import/preview/".length));
    const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || TM_PREVIEW_SAMPLE));
    const page = await readPreviewPage(batchId, { offset, limit });
    if (!page) return json(res, 404, { error: "预检缓存已过期，请重新预检" });
    return json(res, 200, page);
  }
  if (req.method === "POST" && url.pathname === "/api/assets-import/preview") {
    return json(res, 200, await previewBilingualAssets(await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES })));
  }
  if (req.method === "POST" && url.pathname === "/api/assets-import/commit") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const projectId = String(body.projectId || "").trim();
    if (!projectId || !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    if (!body.batchId || !Array.isArray(body.candidates)) return json(res, 400, { error: "预检批次或候选无效" });
    const purpose = body.purpose === "tm" ? "tm" : "term";
    const aiCleaning = purpose === "term" && body.aiCleaning === true;
    // 批次级开关决定风格证据：预检候选里遗留的逐文件勾选值在这里统一归一。
    const styleEvidence = body.styleEvidence === true;
    // 目标库先校验再建任务：选错库要立刻报错，不能等后台跑到一半才失败。
    const termLibrary = await resolveImportLibrary(projectId, { libraryId: body.termLibraryId, kind: "term_base" });
    const tmLibrary = await resolveImportLibrary(projectId, { libraryId: body.tmLibraryId, kind: "translation_memory" });
    const termLibraryId = termLibrary?.id || "";
    const tmLibraryId = tmLibrary?.id || "";
    const filename = String(body.filename || body.candidates[0]?.sourceFile || "双语资产导入").slice(0, 120);
    const candidates = body.candidates.map((candidate) => ({
      ...candidate,
      selected: candidate.selected !== false,
      assetType: purpose === "tm" ? "memory" : "term",
      styleEvidence
    }));
    if (!candidates.length) return json(res, 400, { error: "没有可导入的候选" });
    // 只创建任务就立刻返回：审核队列写入、清洗、入库都在后台链路里，
    // 否则几千条候选的队列写入会让弹窗长时间只有一个灰掉的按钮。
    const task = await createBackgroundTask({
      type: "asset_import",
      title: `导入 · ${filename}`,
      projectId,
      progress: { phase: "queued", message: aiCleaning ? "已排队：先写审核队列，再做 AI 清洗" : "已排队：先写审核队列，再按表导入", total: candidates.length },
      // 批次号建任务时就写进去：服务重启打断时，「继续导入」才有批次可用。
      payload: { batchId: String(body.batchId || ""), filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false }
    });
    runAssetImportInBackground({
      taskId: task.id,
      projectId,
      batchId: String(body.batchId || ""),
      filename,
      candidates,
      purpose,
      aiCleaning,
      styleEvidence,
      termLibraryId,
      tmLibraryId,
      persistCandidates: true
    }).catch((error) => console.error("[Kami] 双语资产导入后台任务异常", error));
    return json(res, 202, { taskId: task.id, backgroundTaskId: task.id, batchId: String(body.batchId || ""), accepted: candidates.length, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId });
  }
  if (req.method === "POST" && url.pathname === "/api/assets-import/resume") {
    // 续传：用同一个批次的候选重跑一次。已写入的"原文+译文"会被当成重复跳过，
    // 所以中断、失败、服务重启之后都能安全补齐，不需要重新上传文件。
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const projectId = String(body.projectId || "").trim();
    if (!projectId || !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    const batchId = String(body.batchId || "").trim();
    if (!batchId) return json(res, 400, { error: "缺少导入批次" });
    const preview = await getImportPreview(batchId);
    if (!preview || !Array.isArray(preview.candidates) || !preview.candidates.length) {
      return json(res, 404, { error: "找不到这批导入的候选，需重新上传文件" });
    }
    const purpose = body.purpose === "tm" ? "tm" : "term";
    const aiCleaning = purpose === "term" && body.aiCleaning === true;
    const styleEvidence = body.styleEvidence === true;
    const termLibrary = await resolveImportLibrary(projectId, { libraryId: body.termLibraryId, kind: "term_base" });
    const tmLibrary = await resolveImportLibrary(projectId, { libraryId: body.tmLibraryId, kind: "translation_memory" });
    const termLibraryId = termLibrary?.id || "";
    const tmLibraryId = tmLibrary?.id || "";
    const filename = String(preview.filename || "双语资产导入").slice(0, 120);
    // 持久化的候选不带 selected（库里没有这一列），续跑时要按"默认全选"还原，
    // 否则整批会被当成"未选择"直接跳过。
    // contentTypeSource = "ai-cleaned" 表示这条上一轮已经判定过：AI 清洗会跳过它，省掉重复调用。
    const candidates = preview.candidates.map((candidate) => ({ ...candidate, selected: candidate.selected !== false }));
    const task = await createBackgroundTask({
      type: "asset_import",
      title: `续传 · ${filename}`,
      projectId,
      progress: { phase: "queued", message: "正在续传未完成的导入", total: candidates.length },
      payload: { batchId, filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false }
    });
    runAssetImportInBackground({
      taskId: task.id,
      projectId,
      batchId,
      filename,
      candidates,
      purpose,
      aiCleaning,
      styleEvidence,
      termLibraryId,
      tmLibraryId,
      // 候选已经在这个批次里，续跑不要再写一遍审核队列。
      persistCandidates: false
    }).catch((error) => console.error("[Kami] 双语资产续传任务异常", error));
    return json(res, 202, { taskId: task.id, batchId, accepted: candidates.length, termLibraryId, tmLibraryId });
  }
  if (req.method === "POST" && url.pathname === "/api/tm-import/commit") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const projectId = String(body.projectId || "").trim();
    if (!projectId || !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    // 候选优先从预检缓存里读回来：浏览器只回批次号与取消勾选的序号，
    // 8 万条候选（约 49MB）不再经前端来回搬运。旧客户端仍可直接传 candidates。
    const resolved = await resolveTmImportCandidates(body);
    if (!resolved.candidates.length) return json(res, 400, { error: resolved.error });
    const candidates = resolved.candidates;
    const batchId = resolved.batchId || String(body.batchId || "");
    const filename = String(body.filename || "人工 TM 导入").slice(0, 120);
    // 页面要进度条时走后台任务：9332 条要跑好几分钟，同步请求期间界面只能干等。
    const tmLibrary = await resolveImportLibrary(projectId, { libraryId: body.tmLibraryId, kind: "translation_memory" });
    const tmLibraryId = tmLibrary?.id || "";
    if (body.background === true) {
      const task = await createBackgroundTask({
        type: "term_import",
        title: `TM 导入 · ${filename}`,
        projectId,
        progress: { phase: "queued", message: "已排队：开始写入主 TM", total: candidates.length },
        payload: { batchId, filename, tmLibraryId, resumable: true }
      });
      runTmImportInBackground({
        taskId: task.id,
        projectId,
        filename,
        batchId,
        candidates,
        styleEvidence: body.styleEvidence !== false,
        sourceFileType: body.sourceFileType,
        tmLibraryId
      }).catch((error) => console.error("[Kami] 人工 TM 导入后台任务异常", error));
      // 预检缓存不在这里删：导入成功才删，失败要留给「继续导入」。
      return json(res, 202, { taskId: task.id, backgroundTaskId: task.id, batchId, accepted: candidates.length, background: true, tmLibraryId });
    }
    // 同步路径（接口测试 / 小批量）：同样是"先写主 TM，成功后再写审计"。
    const result = await commitTermImport(
      { ...body, projectId, batchId, candidates, tmLibraryId },
      null,
      null,
      { skipQueueCompletion: true }
    );
    await saveTmImportAudit({
      batchId,
      filename,
      fileType: body.sourceFileType || "tm",
      projectId,
      requestedLocale: "zh-CN",
      summary: result.summary,
      candidates,
      decisions: result.decisions
    });
    await releasePreviewCaches(batchId);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/term-import/preview") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const requestedLocale = body.locale === "auto" ? "auto" : assertActiveLocale(body.locale || "zh-CN");
    const scopedBody = { ...body, locale: requestedLocale };
    const progressId = String(body.progressId || "").trim();
    const task = await createBackgroundTask({
      type: "term_import",
      title: String(body.filename || "术语导入表格").slice(0, 120),
      projectId: String(body.projectId || ""),
      locale: requestedLocale === "auto" ? "" : requestedLocale
    });
    let progressWrites = Promise.resolve();
    const progress = (update) => {
      reportImportProgress(progressId, { status: "running", ...update });
      progressWrites = progressWrites.then(() => updateBackgroundTaskProgress(task.id, { progress: update })).catch(() => {});
    };
    try {
      const result = await previewTermImport(scopedBody, progress);
      reportImportProgress(progressId, { status: "completed", phase: "completed", message: "识别与清洗完成", percent: 100 });
      await progressWrites;
      await updateBackgroundTaskProgress(task.id, {
        status: "review",
        progress: { phase: "pending-commit", message: "识别完成，等待确认入库", percent: 100, completed: 1, total: 1 },
        payload: { batchId: result.batchId, candidateCount: result.candidates.length }
      });
      return json(res, 200, { ...result, backgroundTaskId: task.id });
    } catch (error) {
      reportImportProgress(progressId, { status: "failed", phase: "failed", message: error.message, error: error.message });
      await progressWrites;
      await updateBackgroundTaskProgress(task.id, {
        status: "failed",
        progress: { phase: "failed", message: error.message, percent: 100, completed: 0, total: 0 },
        payload: { error: error.message }
      });
      throw error;
    } finally {
      scheduleImportProgressCleanup(progressId);
    }
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/term-import/review/")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/term-import/review/".length));
    const preview = await getImportPreview(batchId);
    if (!preview) {
      const error = new Error("未找到这批术语审核数据");
      error.statusCode = 404;
      throw error;
    }
    const assetsByLocale = {};
    const locales = [...new Set((preview.candidates || []).map((candidate) => candidate.locale).filter(Boolean))];
    await Promise.all(locales.map(async (locale) => { assetsByLocale[locale] = (await getProjectAssets(locale, preview.projectId)).assets.terms; }));
    return json(res, 200, { ...preview, candidates: markExistingTermCandidates(preview.candidates || [], assetsByLocale) });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/term-import/progress/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/term-import/progress/".length));
    const progress = importProgress.get(id);
    return json(res, progress ? 200 : 404, progress || { error: "识别任务尚未开始" });
  }
  if (req.method === "POST" && url.pathname === "/api/term-import/commit") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const backgroundTaskId = String(body.backgroundTaskId || "");
    // 目标库先校验：选错库要立刻报错，别等写到一半才失败。
    const commitProjectId = String(body.projectId || "").trim();
    if (commitProjectId) {
      const termLibrary = await resolveImportLibrary(commitProjectId, { libraryId: body.termLibraryId, kind: "term_base" });
      const tmLibrary = await resolveImportLibrary(commitProjectId, { libraryId: body.tmLibraryId, kind: "translation_memory" });
      body.termLibraryId = termLibrary?.id || "";
      body.tmLibraryId = tmLibrary?.id || "";
    }
    const control = beginBackgroundRun(backgroundTaskId);
    const onProgress = (update) => {
      if (!backgroundTaskId) return;
      updateBackgroundTaskProgress(backgroundTaskId, { progress: update }).catch(() => {});
    };
    try {
      const result = await commitTermImport(body, onProgress, () => control.cancelRequested);
      if (backgroundTaskId) {
        const backgroundTask = await getBackgroundTask(backgroundTaskId);
        await updateBackgroundTaskProgress(backgroundTaskId, {
          status: "completed",
          progress: { phase: "completed", message: "导入完成", percent: 100, completed: 1, total: 1 },
          payload: { ...(backgroundTask?.payload || {}), summary: result.summary }
        });
      }
      return json(res, 201, { ...result, backgroundTaskId });
    } catch (error) {
      if (!isCancellation(error)) throw error;
      // 用户主动中断：标成"可继续"，不要让它停在"进行中"。
      if (backgroundTaskId) {
        const backgroundTask = await getBackgroundTask(backgroundTaskId).catch(() => null);
        await updateBackgroundTaskProgress(backgroundTaskId, {
          status: "needs_attention",
          progress: { ...(backgroundTask?.progress || {}), phase: "cancelled", message: error.message },
          payload: { ...(backgroundTask?.payload || {}), batchId: String(body.batchId || backgroundTask?.payload?.batchId || ""), resumable: true }
        }).catch(() => {});
        reportImportProgress(backgroundTaskId, { status: "needs_attention", phase: "cancelled", message: error.message });
      }
      return json(res, 200, { cancelled: true, message: error.message, backgroundTaskId });
    } finally {
      endBackgroundRun(backgroundTaskId);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/provider") {
    return json(res, 200, getProviderConfig());
  }
  if (req.method === "POST" && url.pathname === "/api/provider") {
    return json(res, 200, updateProviderConfig(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/provider/probe") {
    // 面板里刚改、还没保存的地址/密钥也要能试：空字段回落到当前生效配置。
    const body = await readJsonBody(req).catch(() => ({}));
    const saved = getProviderConfig();
    const baseUrl = String(body.baseUrl ?? "").trim().replace(/\/$/, "") || saved.baseUrl;
    const model = String(body.model ?? "").trim() || saved.model;
    const submittedApiKey = String(body.apiKey ?? "").trim();
    if (!baseUrl || !model) return json(res, 400, { ok: false, error: "Base URL 与主模型都要填写后才能测试连接" });
    // 协议也按面板里刚选的那份试：改了协议还没保存就点测试连接，测的应该是新协议。
    const protocol = normalizeProviderProtocol(Object.hasOwn(body, "protocol") ? body.protocol : saved.protocol);
    // apiKey 留空表示"用已保存的那把"：不能塞 undefined 覆盖掉运行配置里的密钥。
    const override = { baseUrl, model, protocol, ...(submittedApiKey ? { apiKey: submittedApiKey } : {}) };
    const startedAt = Date.now();
    try {
      await probeModelAvailability({ config: override, timeoutMs: 20_000 });
      return json(res, 200, { ok: true, baseUrl, model, protocol, latencyMs: Date.now() - startedAt });
    } catch (error) {
      // 连不上是预期结果之一，不抛 5xx：界面要拿到原因原样展示。
      return json(res, 200, { ok: false, baseUrl, model, protocol, latencyMs: Date.now() - startedAt, error: String(error?.message || error) });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/embedding/rebuild") {
    const body = await readJsonBody(req);
    const locale = body.locale ? assertActiveLocale(body.locale) : null;
    const locales = locale ? [locale] : ACTIVE_LOCALES;
    const task = await createBackgroundTask({
      type: "embedding_rebuild",
      title: `Embedding 重建 · ${locale || "全部语言"}`,
      projectId: String(body.projectId || ""),
      locale: locale || ""
    });
    (async () => {
      let externalEmbeddingWorking = false;
      try {
        await embed("重建探针");
        externalEmbeddingWorking = true;
      } catch {
        // 外部向量服务不可用：整轮重建使用本地词面向量，避免每条都撞超时
      }
      const results = {};
      let failure = "";
      for (let index = 0; index < locales.length; index += 1) {
        const target = locales[index];
        const alive = await updateBackgroundTaskProgress(task.id, {
          progress: { phase: "rebuilding", message: `正在重建 ${target}（${index + 1} / ${locales.length}）${externalEmbeddingWorking ? "" : "· 本地词面向量"}`, percent: Math.round((index / Math.max(locales.length, 1)) * 90), completed: index, total: locales.length }
        });
        if (!alive) return;
        try {
          results[target] = await rebuildEmbeddings(target, { forceLocal: !externalEmbeddingWorking });
        } catch (error) {
          failure += `${target}: ${error.message}；`;
        }
      }
      await updateBackgroundTaskProgress(task.id, {
        status: failure ? "failed" : "completed",
        progress: { phase: failure ? "failed" : "completed", message: failure ? "部分语言重建失败" : "重建完成", percent: 100, completed: locales.length, total: locales.length },
        payload: { embeddingModel: getProviderConfig().embeddingModel || null, externalEmbeddingWorking, results, error: failure }
      });
    })().catch((error) => console.error("Embedding 重建后台任务失败", error));
    return json(res, 202, { backgroundTaskId: task.id, message: "Embedding 重建已进入任务中心后台执行" });
  }
  if (req.method === "POST" && url.pathname === "/api/feedback/accept") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const source = String(body.source || "").trim();
    const translation = String(body.translation || "").trim();
    if (!source || !translation) {
      const error = new Error("原文与采纳译文不能为空");
      error.statusCode = 400;
      throw error;
    }
    const contentType = body.contentType || "general";
    const domain = concreteDomain(body.domain, { text: source, contentType });
    const projectId = String(body.projectId || body.project || "default").trim();
    const project = projectId;
    const projectLibraries = projectId ? await getResourceLibraries(projectId) : [];
    const masterTm = projectLibraries.find((library) => library.kind === "translation_memory" && library.role === "master");
    let linkedTrajectory = null;
    if (body.trajectoryId) {
      linkedTrajectory = assertTrajectoryBinding(
        await getLearningTrajectory(String(body.trajectoryId)),
        { locale, source, contentType, domain, project, batchId: body.batchId || "" }
      );
    }
    const contentTags = linkedTrajectory?.contextPack?.contentTags
      || classifyContent(source, contentType, { sourceFile: body.sourceFile || "" }).contentTags
      || [];
    const memory = await saveMemory(locale, {
      source, target: translation, domain, contentType,
      contentTags,
      qualityStatus: "human_approved", qaScore: 100, provenance: "human-accept",
      styleProfileId: body.styleProfileId || "", batchId: body.batchId || "", projectId, project: projectId, libraryId: masterTm?.id || "",
      sourceFile: body.sourceFile || "", sourceRow: body.sourceRow || null, projectId,
      entryId: body.entryId || "", entryKey: body.entryKey || ""
    });
    const demoted = await demoteMemories(locale, source, memory.id, { projectId });
    // 机器初稿只从轨迹取，不接受客户端提交：与终稿的差异是风格信号本身，
    // 必须来自服务端记录的那一版，否则蒸馏学到的是可以被伪造的"改动"。
    const machineTranslation = linkedTrajectory
      ? String(linkedTrajectory.finalTranslation || linkedTrajectory.initialTranslation || "").trim()
      : "";
    const evidence = await saveStyleEvidence({
      locale, source, target: translation, contentType, domain,
      contentTags,
      machineTranslation, polarity: "positive",
      status: "accepted", provenance: "human-accept",
      sourceFile: body.sourceFile || "", sourceRow: body.sourceRow || null, projectId
    });
    const qaCaseApproved = body.qaCaseId ? await approveQaCase(String(body.qaCaseId)) : false;
    let termCandidateBatch = null;
    let termCandidateWarning = "";
    try {
      const assets = (await getProjectAssets(locale, body.projectId || "")).assets;
      const matches = matchTerms(source, assets, { contentType, domain, ...deliveryContext(body, source) });
      const termCandidates = deriveTermCandidatesFromHumanFinal({
        locale,
        source,
        finalTranslation: translation,
        matches,
        suggestions: Array.isArray(body.termSuggestions) ? body.termSuggestions : [],
        existingTerms: assets.terms || [],
        contentType,
        domain,
        project,
        batchId: body.batchId || "",
        taskId: body.trajectoryId || "",
        sourceFile: body.sourceFile || "",
        sourceRow: body.sourceRow || null
      }).filter((candidate) => candidate.proposalAction !== "add_usage_evidence")
        .map((candidate) => ({
          ...candidate,
          score: candidate.confidence,
          decision: candidate.proposalAction === "create_term" ? "ready" : "review",
          candidateOrigin: `human-final:${candidate.proposalAction}`,
          candidateRole: candidate.proposalAction,
          parentCandidateKey: candidate.originTermId || "",
          reasons: [candidate.evidence?.reason || "人工终稿中发现术语候选", `建议动作：${candidate.proposalAction}`]
        }));
      if (termCandidates.length) {
        termCandidateBatch = await saveImportPreview({
          filename: `${String(body.sourceFile || "人工终稿").slice(0, 100)} · 术语候选`,
          fileType: "human-final",
          requestedLocale: locale,
          fileMode: "term",
          statistics: { rowsScanned: 1, candidates: termCandidates.length, ready: termCandidates.filter((item) => item.decision === "ready").length, review: termCandidates.filter((item) => item.decision === "review").length },
          ai: { requested: false, used: false, reviewed: 0, total: termCandidates.length, source: "human-final" },
          sheets: [],
          candidates: termCandidates
        });
      }
    } catch (error) {
      termCandidateWarning = `正式译文已采纳，但术语候选生成失败：${error.message}`;
    }
    let trajectory = null;
    if (linkedTrajectory) {
        const humanDecision = {
          accepted: true,
          finalTranslation: translation,
          editDistance: normalizedEditDistance(linkedTrajectory.finalTranslation || linkedTrajectory.initialTranslation || "", translation),
          decidedAt: new Date().toISOString(),
          source: "human-accept"
        };
        trajectory = await updateLearningTrajectory(linkedTrajectory.id, {
          finalTranslation: translation,
          humanDecision,
          status: "completed",
          events: [...(Array.isArray(linkedTrajectory.events) ? linkedTrajectory.events : []), { type: "human_accepted", at: humanDecision.decidedAt, editDistance: humanDecision.editDistance }]
        });
    }
    if (trajectory) {
      triggerAutoProposal({ locale, contentType, domain, project });
    }
    return json(res, 201, { memory, demoted, evidence, qaCaseApproved, trajectory, termCandidateBatch, termCandidateWarning });
  }
  if (req.method === "GET" && url.pathname === "/api/style-profiles") {
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const status = String(url.searchParams.get("status") || "").trim() || null;
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    if (projectId && !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    const [profiles, evidence, qaRuns, learningRuns, totals] = await Promise.all([
      listStyleProfiles(locale, status, { projectId }),
      // 面板展示的是"分析取样"结果：人工采纳优先 → 语体分层 → 来源覆盖，
      // 而不是"最新 1000 条"（大导入会把窗口全占掉）。
      sampleStyleEvidence(locale, { projectId, limit: 1_000 }),
      getQaRuns(locale, { projectId, limit: 500 }),
      getStyleLearningRuns(locale, { projectId, limit: 30 }),
      countStyleEvidence(locale, { projectId }).catch(() => null)
    ]);
    // 风格资产是项目级的：面板只展示一个池子。
    // 数字要用真实总数（limit=1000 的列表长度会把 8134 条显示成 1000），
    // 语体分布另走 byContentType，只作展示与分层取样的说明。
    const total = Number(totals?.total) || evidence.length;
    const byProvenance = totals?.byProvenance || {};
    const tableImport = Number(byProvenance["table-import"]) || 0;
    const humanAccept = Number(byProvenance["human-accept"]) || 0;
    const pool = {
      contentType: "general",
      domain: "general",
      scopeLabel: "全项目",
      evidenceCount: total,
      threshold: DISTILL_THRESHOLD,
      sampled: evidence.length,
      sources: { tableImport, humanAccept, qaReview: qaRuns.length, revised: 0, negative: 0, other: Math.max(0, total - tableImport - humanAccept) },
      byContentType: totals?.byContentType || []
    };
    for (const item of evidence) {
      if (isNegativeEvidence(item)) pool.sources.negative += 1;
      // 改写证据带着机器初稿，是信息量最高的一类，单独计数便于判断这个池子够不够"有话可说"。
      if (!isNegativeEvidence(item) && classifyChange(item) === "revised") pool.sources.revised += 1;
    }
    // "这套规则是从哪些文件学来的"：证据池按来源文件统计，蒸馏版本再按自己的取样 id 归一次。
    const poolFiles = await countStyleEvidenceFiles(locale, { projectId }).catch(() => []);
    const evidenceFileRows = await listStyleEvidenceFiles(locale, { ids: profiles.styleProfiles.flatMap((item) => item.evidenceIds || []) }).catch(() => []);
    const fileById = new Map(evidenceFileRows.map((row) => [row.id, row.sourceFile]));
    const summarizeFiles = (names) => {
      const counts = new Map();
      for (const name of names) if (name) counts.set(name, (counts.get(name) || 0) + 1);
      return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    };
    const styleProfiles = profiles.styleProfiles.map((item) => {
      // 本版取样覆盖到的来源文件（evidenceIds 对应的那些证据行）。
      const ids = item.evidenceIds || [];
      const files = summarizeFiles(ids.map((id) => fileById.get(String(id))));
      // 老版本取样的证据行可能已被清掉：明确说"原证据已不在库中"，而不是显示成没有来源。
      return { ...item, evidenceFiles: files, ...(ids.length && !files.length ? { evidenceFilesMissing: ids.length } : {}) };
    });
    return json(res, 200, {
      ...profiles,
      styleProfiles,
      learningRuns,
      evidencePools: [{ ...pool, files: poolFiles }],
      evidenceByScope: pool.byContentType
    });
  }
  if (req.method === "POST" && url.pathname === "/api/style-profiles/distill") {
    // 立即重新蒸馏：不用等下一次批次/导入结束。风格资产是项目级的，一次只蒸一份。
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale || "zh-CN");
    const projectId = String(body.projectId || "").trim();
    if (!projectId || !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    const tuning = getSettings();
    const outcome = await distillStyleProfileIfReady({
      locale,
      projectId,
      threshold: tuning.learning.styleDistillThreshold,
      growthWindow: tuning.learning.styleDistillGrowthWindow,
      positiveLimit: tuning.learning.distillPositiveSamples,
      negativeLimit: tuning.learning.distillNegativeSamples,
      staleRounds: tuning.learning.ruleStaleRounds
    }).catch((error) => ({ distilled: null, failed: error.message }));
    logInfo("手动重新蒸馏项目风格规范", {
      locale, projectId, evidenceCount: Number(outcome.evidenceCount) || 0, distilled: Boolean(outcome.distilled)
    });
    return json(res, 200, {
      locale,
      projectId,
      evidenceCount: Number(outcome.evidenceCount) || 0,
      distilled: Boolean(outcome.distilled),
      profile: outcome.distilled
        ? { id: outcome.distilled.id, name: outcome.distilled.name, version: outcome.distilled.version, rules: (outcome.distilled.rules || []).length }
        : null,
      skipped: outcome.skipped || "",
      reason: outcome.reason || outcome.failed || ""
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/style-profiles/evaluation-jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/style-profiles/evaluation-jobs/".length));
    const job = styleEvaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到该风格评测任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, job);
  }
  if (req.method === "POST" && /^\/api\/style-learning-runs\/[^/]+\/refresh$/u.test(url.pathname)) {
    // 重跑"本批风格浓缩"：模型失败时记录里只剩本地统计，这里用同一批证据再调一次模型，
    // 成功后就地更新那条记录（不新增记录、不改状态）。
    const id = decodeURIComponent(url.pathname.slice("/api/style-learning-runs/".length, -"/refresh".length));
    const run = await getStyleLearningRun(id);
    if (!run) return json(res, 404, { error: "未找到这条批次学习记录" });
    const evidence = await getStyleEvidence(run.locale, { projectId: run.projectId, batchId: run.batchId, limit: 1_000 });
    if (!evidence.length) return json(res, 400, { error: "这批风格证据已经不在库里，无法重跑浓缩" });
    const learning = await distillBatchStyleLearning({
      batchId: run.batchId,
      filename: run.filename,
      locale: run.locale,
      contentType: run.contentType,
      domain: run.domain,
      projectId: run.projectId,
      evidence,
      learningRunId: run.id
    });
    const failed = String(learning?.caveat || "").includes("模型浓缩失败");
    logInfo("重跑本批风格浓缩", { id: run.id, batchId: run.batchId, evidence: evidence.length, failed });
    return json(res, 200, { learning, failed });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/evaluate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/evaluate".length));
    const body = await readJsonBody(req);
    const draft = await findStyleProfile(id);
    if (!draft || !draft.contentType) {
      const error = new Error("未找到该风格草稿");
      error.statusCode = 404;
      throw error;
    }
    const scope = learningScope({
      locale: draft.locale,
      contentType: draft.contentType,
      domain: draft.domain || "general",
      project: body.project || "default"
    });
    const activeProfile = await getProjectStyleProfile(scope.locale, { projectId: scope.project });
    const state = validateStylePromotionState({ draft, activeProfile });
    if (!state.valid) {
      const error = new Error(state.reasons.join("；"));
      error.statusCode = 409;
      throw error;
    }
    const running = styleEvaluationJobs.findActiveForChallenger(id);
    if (running) return json(res, 200, running);

    // 草稿是从这些原文蒸馏出来的，留出集必须把它们排除，否则评测的是背诵而不是泛化。
    const evidenceIds = new Set((draft.evidenceIds || []).map(String));
    const distilledFromSources = evidenceIds.size
      ? (await getStyleEvidence(scope.locale, { projectId: scope.project, limit: 1_000 }))
        .filter((item) => evidenceIds.has(String(item.id))).map((item) => item.source)
      : [];
    // 规范是项目级的，留出集也要覆盖整个项目：只按 locale + project 取轨迹。
    const holdout = selectStyleHoldout(
      await listLearningTrajectories({ locale: scope.locale, project: scope.project, limit: 500 }),
      { scope, distilledFromSources, projectLevel: true }
    );
    const minStyleSamples = getSettings().learning.styleEvaluationMinSamples;
    if (holdout.length < minStyleSamples) {
      const error = new Error(`可用留出终稿 ${holdout.length} 条，未达风格评测所需的 ${minStyleSamples} 条（已排除蒸馏用过的 ${distilledFromSources.length} 条原文）`);
      error.statusCode = 409;
      throw error;
    }
    const provider = getProviderConfig();
    return json(res, 202, await styleEvaluationJobs.create({
      scope,
      champion: { id: activeProfile?.id || NO_STYLE_PROFILE_ID },
      challenger: { id: draft.id },
      trajectories: holdout,
      requireCost: costPricingConfigured(provider),
      forceRegenerate: body.forceRegenerate === true
    }));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/activate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/activate".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const located = await findStyleProfile(id);
    const requestedProjectId = String(body.projectId || "").trim();
    if (located && String(located.projectId || "") !== requestedProjectId) {
      const error = new Error("未找到当前项目的风格指南");
      error.statusCode = 404;
      throw error;
    }
    // 有评测结论且结论反对时必须显式 force，并把这次越过闸门的事实记在规范上。
    if (located?.kind !== "user_profile" && located?.evaluation && located.evaluation.promotable !== true && body.force !== true) {
      const error = new Error(`评测结论不支持启用：${located.evaluation.conclusion || "未达晋升门槛"}。确认仍要启用请勾选“忽略评测结论”。`);
      error.statusCode = 409;
      throw error;
    }
    const activated = await activateStyleProfile(id);
    if (!activated) {
      const error = new Error("未找到该风格规范");
      error.statusCode = 404;
      throw error;
    }
    // 生效风格换人：同作用域里针对旧生效版本的风格评测作废，就地停掉。
    await failEvaluationJobs(styleEvaluationJobs,
      (job) => sameEvaluationScope(job.scope, {
        locale: activated.locale,
        contentType: activated.contentType,
        domain: activated.domain,
        project: activated.projectId
      }) && String(job.championId) !== String(id),
      "生效风格已更新，本次评测终止");
    // 译者画像不参与配对评测，也不在 style_profiles 表里，不能往那儿写激活依据。
    if (located && located.kind !== "user_profile") {
      const basis = !located.evaluation ? "unevaluated" : located.evaluation.promotable === true ? "evaluated" : "forced";
      await saveStyleProfileEvaluation(id, { ...(located.evaluation || {}), activationBasis: basis, activatedAt: new Date().toISOString() });
      activated.evaluation = { ...(located.evaluation || {}), activationBasis: basis };
    }
    return json(res, 200, activated);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/reject")) {
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/reject".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const located = await findStyleProfile(id);
    if (located && String(located.projectId || "") !== String(body.projectId || "")) {
      const error = new Error("未找到当前项目的风格指南");
      error.statusCode = 404;
      throw error;
    }
    const rejected = await rejectStyleProfile(id);
    if (!rejected) {
      const error = new Error("无法拒绝该风格规范（可能已激活或不存在）");
      error.statusCode = 404;
      throw error;
    }
    await failEvaluationJobs(styleEvaluationJobs, (job) => String(job.challengerId) === String(id), "风格草稿已被拒绝，评测终止");
    return json(res, 200, rejected);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/rules")) {
    // 删掉一条自动蒸馏出来的规则。规则集是累积的（带 id / 证据数），所以
    // 既要把这条从 rules 里去掉，也要重建 instruction（提示词读的就是它）。
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/rules".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text) return json(res, 400, { error: "缺少要删除的规则文本" });
    const profile = await findStyleProfile(id);
    if (!profile) return json(res, 404, { error: "风格版本不存在" });
    if (profile.kind === "user_profile") {
      return json(res, 409, { error: "人工风格指南是一整篇文档，不能按条删规则；请直接删除这篇指南或重新导入" });
    }
    const rules = Array.isArray(profile.rules) ? profile.rules : [];
    const nextRules = rules.filter((rule) => String(rule?.rule || "").trim() !== text);
    const strippedInstruction = stripStyleRuleLine(profile.instruction, text);
    if (nextRules.length === rules.length && strippedInstruction === String(profile.instruction || "")) {
      return json(res, 404, { error: "这一版里找不到这条规则（可能已经删掉或被重新蒸馏过）" });
    }
    const instruction = nextRules.some((rule) => rule?.status !== "retired")
      ? renderInstruction(nextRules, "")
      : strippedInstruction;
    const updated = await updateStyleProfileRules(id, { rules: nextRules, instruction });
    logInfo("删除风格规则", { id, rule: text.slice(0, 60) });
    return json(res, 200, { deleted: true, remaining: nextRules.filter((rule) => rule?.status !== "retired").length, instruction: updated?.instruction ?? instruction });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/style-profiles/")) {
    // 删掉一个不再要的风格版本。生效版本不能删：先在界面上停用，再删。
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const profile = await findStyleProfile(id);
    if (!profile) return json(res, 404, { error: "风格版本不存在" });
    if (String(profile.projectId || "") !== String(body.projectId || "")) {
      return json(res, 404, { error: "未找到当前项目的风格版本" });
    }
    if (String(profile.status) === "active") {
      return json(res, 409, { error: profile.kind === "user_profile" ? "这份风格指南正在生效：先「停用」，再删除" : "当前生效版本不能删除：先「停用」，再删除" });
    }
    const deleted = profile.kind === "user_profile" ? await deleteUserProfile(id) : await deleteStyleProfile(id);
    await failEvaluationJobs(styleEvaluationJobs, (job) => String(job.challengerId) === String(id), "风格草稿已被删除，评测终止");
    logInfo(profile.kind === "user_profile" ? "删除人工风格指南" : "删除风格版本", { id, version: profile.version, status: profile.status });
    return json(res, 200, { deleted, id });
  }
  if (req.method === "GET" && url.pathname === "/api/qa-cases/pending") {
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const projectId = String(url.searchParams.get("projectId") || "");
    return json(res, 200, await listPendingQaCases(locale, { projectId }));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/qa-cases/") && url.pathname.endsWith("/approve")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-cases/".length, -"/approve".length));
    const approved = await approveQaCase(id);
    if (!approved) {
      const error = new Error("未找到该 QA 案例");
      error.statusCode = 404;
      throw error;
    }
    // 采纳即入集：这条人工决定本身就是回归集的闸门，不再需要第二次审批与署名。
    // 并集失败不影响采纳结果本身，只把原因带回界面。
    let regression = null;
    try {
      regression = await admitApprovedQaCase(id);
    } catch (error) {
      console.error("QA 案例采纳后并入回归集失败", error);
      regression = { error: error.message };
    }
    return json(res, 200, { id, status: "human_approved", regression });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/qa-cases/") && url.pathname.endsWith("/dispose")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-cases/".length, -"/dispose".length));
    const disposed = await disposeQaCase(id);
    if (!disposed) {
      const error = new Error("未找到该 QA 案例");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { id, disposed });
  }
  if (req.method === "POST" && url.pathname === "/api/evolution/review") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const result = await runEvolutionReview({
      locale,
      contentType: body.contentType || "general",
      domain: body.domain || "general",
      batchId: body.batchId || "",
      projectId: String(body.projectId || ""),
      threshold: getSettings().learning.styleDistillThreshold,
      growthWindow: getSettings().learning.styleDistillGrowthWindow,
      positiveLimit: getSettings().learning.distillPositiveSamples,
      negativeLimit: getSettings().learning.distillNegativeSamples,
      staleRounds: getSettings().learning.ruleStaleRounds
    });
    return json(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/learning") {
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const requestedScope = learningScope({
      locale,
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "game",
      project: url.searchParams.get("project") || "default"
    });
    // "全部"是按整维度浏览：查询时不带这一维的 filter，但默认冠军只能属于具体范围，
    // 所以全部视图不去创建默认技能（否则会凭空多出一个 contentType=all 的冠军）。
    const queriedScope = learningScopeQuery(requestedScope);
    if (queriedScope.contentType && queriedScope.domain) await ensureChampionTranslationSkill(requestedScope);
    const [skills, trajectories, evaluations] = await Promise.all([
      listTranslationSkills({ ...queriedScope, limit: 500 }),
      listLearningTrajectories({ ...queriedScope, limit: 500 }),
      listSkillEvaluations({ ...queriedScope, limit: 500 })
    ]);
    // 语体与领域是逐段判定的：用户刚导入完语料，打开的常常是空作用域。
    // 这里顺带给出"本项目其它范围各有多少条"，界面才能在空作用域上直接指路。
    const scopeCounts = await countLearningTrajectoriesByScope({ locale, project: requestedScope.project }).catch(() => []);
    // 每条轨迹的来源文件：批次原文件名（证据行上要写清"这条轨迹来自哪个文件"）。
    const batchFiles = Object.fromEntries((await listBatchRuns({ projectId: requestedScope.project, limit: 500 }).catch(() => []))
      .map((run) => [String(run.batchId), String(run.filename || "")])
      .filter(([, filename]) => filename));
    // 一个范围一份生效版本：具体范围取那一份，全部视图把范围内的都带上（界面逐张标范围）。
    // 每个被用过的范围都有一份默认策略，全部视图会长出来一长串；有轨迹的范围排前面，
    // 让人先看到真正在用的那些（0 条轨迹的默认策略排在后面）。
    const trajectoryCountOfScope = new Map(scopeCounts.map((item) => [`${item.contentType}\u0000${item.domain}`, item.count]));
    const champions = skills
      .filter((item) => item.status === "champion"
        && item.project === requestedScope.project
        && (!queriedScope.contentType || item.contentType === queriedScope.contentType)
        && (!queriedScope.domain || item.domain === queriedScope.domain))
      .sort((left, right) => (trajectoryCountOfScope.get(`${right.contentType}\u0000${right.domain}`) || 0)
        - (trajectoryCountOfScope.get(`${left.contentType}\u0000${left.domain}`) || 0)
        || String(left.contentType).localeCompare(String(right.contentType))
        || String(left.domain).localeCompare(String(right.domain)));
    const champion = champions.length === 1
      ? champions[0]
      : champions.find((item) => item.contentType === requestedScope.contentType && item.domain === requestedScope.domain) || null;
    const candidates = skills.filter((item) => ["challenger", "draft"].includes(item.status));
    const evidence = trajectories.map((item) => ({
      ...item,
      // 这条轨迹来自哪个文件：优先轨迹自己记的来源文件，其次它所属批次的原文件。
      sourceFile: String(item.assetRefs?.sourceFile || batchFiles[String(item.batchId || "")] || ""),
      attribution: (() => {
        try {
          return summarizeTrajectoryAttribution({
            id: item.id,
            scope: learningScope(item),
            initial: item.qaBefore || {},
            final: item.qaAfter || {},
            context: item.contextPack || {},
            revisions: (item.events || []).filter((event) => /revision/u.test(event.type || "")),
            humanFeedback: item.humanDecision || {}
          });
        } catch { return null; }
      })()
    }));
    return json(res, 200, {
      overview: { trajectoryCount: trajectories.length, skillCount: skills.length, pendingCount: candidates.filter((item) => !evaluations.some((evaluation) => evaluation.challengerSkillId === item.id)).length },
      champion,
      champions,
      skills,
      candidates,
      scopeCounts,
      batchFiles,
      evaluations: evaluations.map((item) => ({ ...item, result: item.report || {} })),
      evidence,
      trajectories
    });
  }
  if (req.method === "GET" && url.pathname === "/api/learning/overview") {
    // 学习中心总览：语体/领域只作参考，所以整个项目就是一条流水线。
    // 仍然返回 scopes 数组（长度 1），前端与旧客户端都不用改读取方式。
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const project = String(url.searchParams.get("project") || "default");
    const [scopeCounts, skills, goldRecords, suiteRecords, runs] = await Promise.all([
      countLearningTrajectoriesByScope({ locale, project }).catch(() => []),
      listTranslationSkills({ locale, project, limit: 500 }),
      listQualityAssets({ locale, project, kind: "gold_set", limit: 500 }),
      listQualityAssets({ locale, project, kind: "regression_suite", limit: 500 }),
      listQualityRuns({ locale, project, limit: 200 })
    ]);
    const scope = learningScope({ locale, project });
    const trajectoryCount = scopeCounts.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const files = [];
    const fileIndex = new Map();
    for (const item of scopeCounts) {
      for (const file of item.files || []) {
        const name = String(file.file || file.name || "");
        if (!name) continue;
        const current = fileIndex.get(name) || { file: name, count: 0, humanReviewed: 0 };
        current.count += Number(file.count) || 0;
        current.humanReviewed += Number(file.humanReviewed) || 0;
        if (!fileIndex.has(name)) fileIndex.set(name, current);
      }
    }
    files.push(...[...fileIndex.values()].sort((left, right) => right.count - left.count));
    const champion = skills
      .filter((item) => item.status === "champion")
      .sort((left, right) => (Number(right.version) || 0) - (Number(left.version) || 0))[0] || null;
    const candidates = skills.filter((item) => ["challenger", "draft"].includes(item.status));
    const assets = resolveGateAssets({
      goldSets: goldRecords.map((item) => item.payload).filter(Boolean),
      regressionSuites: suiteRecords.map((item) => item.payload).filter(Boolean),
      scope
    });
    const latest = runs[0] || null;
    const hasAssets = Boolean(assets.samples.length || assets.cases.length);
    const scopes = [{
      scope: { contentType: "general", domain: "general", locale, project },
      trajectoryCount,
      files,
      champion: champion ? { id: champion.id, version: champion.version, name: champion.name } : null,
      candidateCount: candidates.length,
      latestCandidate: candidates
        .sort((left, right) => (Number(right.version) || 0) - (Number(left.version) || 0))
        .map((item) => ({ id: item.id, version: item.version, status: item.status, name: item.name }))[0] || null,
      assets: {
        goldSampleCount: assets.samples.length,
        regressionCaseCount: assets.cases.length,
        goldenVersions: assets.goldSetVersions,
        regressionSuiteVersions: assets.regressionSuiteVersions
      },
      gate: latest
        ? {
          decision: latest.decision,
          runId: latest.id,
          skillId: latest.skillId,
          createdAt: latest.createdAt,
          coversCurrentAssets: gateRunCoversAssets(latest, assets)
        }
        : hasAssets ? { decision: "not_run", runId: "", skillId: "", createdAt: null, coversCurrentAssets: false } : null
    }];
    return json(res, 200, { locale, project, scopes });
  }
  if (req.method === "GET" && url.pathname === "/api/learning/evidence") {
    // 来源证据明细：服务端筛选 + 分页。列表类界面不允许"取一页当全量"，
    // 所以这里必须同时返回 total，界面写清"已显示 N / 共 M 条"。
    const locale = assertActiveLocale(url.searchParams.get("locale"));
    const requestedScope = learningScope({
      locale,
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "general",
      project: url.searchParams.get("project") || "default"
    });
    const queriedScope = learningScopeQuery(requestedScope);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const skillId = String(url.searchParams.get("skillId") || "");
    const kind = String(url.searchParams.get("kind") || "");
    const file = String(url.searchParams.get("file") || "");
    const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
    const [trajectories, skill, batchRuns] = await Promise.all([
      listLearningTrajectories({ ...queriedScope, limit: 1_000 }),
      skillId ? getTranslationSkill(skillId) : null,
      listBatchRuns({ projectId: requestedScope.project, limit: 500 }).catch(() => [])
    ]);
    const batchFiles = Object.fromEntries(batchRuns.map((run) => [String(run.batchId), String(run.filename || "")]).filter(([, name]) => name));
    const fileOf = (item) => String(item.assetRefs?.sourceFile || item.humanDecision?.sourceFile || batchFiles[String(item.batchId || "")] || "");
    let rows = trajectories;
    if (skill) {
      const evidenceIds = new Set((skill.evidenceIds || []).map(String));
      rows = rows.filter((item) => evidenceIds.has(String(item.id)));
    }
    if (kind === "accepted") rows = rows.filter((item) => item.humanDecision?.accepted === true);
    else if (kind === "review") rows = rows.filter((item) => item.status === "review");
    else if (kind === "completed") rows = rows.filter((item) => item.status === "completed");
    if (file) rows = rows.filter((item) => fileOf(item) === file);
    if (search) {
      rows = rows.filter((item) => String(item.source || "").toLowerCase().includes(search)
        || String(item.finalTranslation || "").toLowerCase().includes(search));
    }
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    return json(res, 200, {
      scope: requestedScope,
      total,
      limit,
      offset,
      hasMore: offset + page.length < total,
      items: page.map((item) => ({
        ...item,
        sourceFile: fileOf(item),
        attribution: (() => {
          try {
            return summarizeTrajectoryAttribution({
              id: item.id,
              scope: learningScope(item),
              initial: item.qaBefore || {},
              final: item.qaAfter || {},
              context: item.contextPack || {},
              revisions: (item.events || []).filter((event) => /revision/u.test(event.type || "")),
              humanFeedback: item.humanDecision || {}
            });
          } catch { return null; }
        })()
      }))
    });
  }
  if (req.method === "POST" && url.pathname === "/api/learning/skills/generate") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const champion = await ensureChampionTranslationSkill(scope);
    // 取 500 条窗口：机器稿会挤在最新的一批里，窗口太小会把人工采纳的老终稿挤出去。
    const trajectories = await listLearningTrajectories({ ...scope, limit: 500 });
    // 手动与自动提议共用同一实现，保证轨迹筛选、补丁合并与证据隔离完全一致。
    const skill = await proposeChallengerSkill({ scope, champion, trajectories, promptVersion: TRANSLATION_PROMPT_VERSION });
    // 手动成功也要刷新自动提议的记账：否则卡片上会一直挂着"上次自动提议失败"的旧报错，
    // 而候选其实已经生成出来了。（失败只由自动链路记录，这里只负责清掉它。）
    const acceptedCount = trajectories.filter((item) => item.status === "completed"
      && item.humanDecision?.accepted === true
      && String(item.finalTranslation || "").trim()).length;
    await updateTranslationSkill(champion.id, {
      metadata: {
        ...(champion.metadata || {}),
        autoPropose: {
          ...(champion.metadata?.autoPropose || {}),
          lastAcceptedCount: acceptedCount,
          lastProposedAt: new Date().toISOString(),
          lastError: "",
          candidateId: String(skill.id || ""),
          lastSource: "manual"
        }
      }
    }).catch((error) => console.error("刷新自动提议记账失败（候选已生成，不影响结果）", error));
    // 新候选生成后就让门禁跟上：否则候选会一直挂着"尚未跑过门禁"，等人去点。
    triggerQualityGateRefresh(scope, { reason: "candidate-created" });
    return json(res, 201, { skill, candidate: skill });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/evaluate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/evaluate".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const challenger = await getTranslationSkill(id);
    if (!challenger || !["challenger", "draft"].includes(challenger.status)) {
      const error = new Error("未找到可评测的候选技能");
      error.statusCode = 404;
      throw error;
    }
    const scope = learningScope(challenger);
    const champion = await ensureChampionTranslationSkill(scope);
    assertCurrentCandidate(challenger, champion);
    const trajectories = await listLearningTrajectories({ ...scope, limit: 500 });
    const evaluationPool = selectSkillHoldout(trajectories, { scope, trainingEvidenceIds: challenger.evidenceIds || [], limit: 60 });
    if (evaluationPool.length < 20) {
      // 证据不足：不发起任何模型调用，直接生成可审计的 insufficient 结论。
      const championSamples = evaluationPool.map((item) => trajectoryToEvaluationSample(item, { variant: "champion" }));
      const challengerSamples = evaluationPool.map((item) => trajectoryToEvaluationSample(item, { variant: "champion" }));
      const result = evaluateSkillPromotion({
        scope,
        champion: { id: champion.id, scope, samples: championSamples },
        challenger: { id: challenger.id, scope, samples: challengerSamples },
        minSamples: 20,
        minimumCoverage: 0.8,
        guardrails: { requireCost: false }
      });
      const report = learningEvaluationUiReport(result);
      report.conclusion = `证据不足：当前只有 ${evaluationPool.length} 条未参与本候选学习的人工批准终稿，至少需要 20 条才会真正重跑「生效版本 / 候选版本」并开放晋升。`;
      report.benchmark = {
        requestedPairs: evaluationPool.length,
        completedPairs: 0,
        failedPairs: 0,
        failures: [],
        isolation: { excludedMemories: 0, excludedQaCases: 0, excludedStyleExamples: 0, excludedUserProfileExamples: 0, totalExcluded: 0 }
      };
      const evaluation = await saveSkillEvaluation({
        ...scope,
        championSkillId: champion.id,
        challengerSkillId: challenger.id,
        sampleCount: championSamples.length,
        championMetrics: result.championMetrics,
        challengerMetrics: result.challengerMetrics,
        metricDeltas: result.deltas,
        decision: "needs_review",
        report,
        evaluator: "kami-learning-engine-v1"
      });
      return json(res, 200, { evaluation: { ...evaluation, result: report }, result: report });
    }
    // 评测转入后台任务：同一候选已有排队/运行中的任务时直接复用，避免重复烧钱。
    const active = evaluationJobs.findActiveForChallenger(challenger.id);
    if (active) return json(res, 200, { jobId: active.jobId, job: active, alreadyRunning: true });
    const job = await evaluationJobs.create({
      scope,
      champion,
      challenger,
      trajectories: evaluationPool,
      // 定价配置完整时启用真实成本门禁；否则保持跳过，避免空数据锁死晋升。
      requireCost: costPricingConfigured(),
      forceRegenerate: body.forceRegenerate === true
    });
    return json(res, 202, { jobId: job.jobId, job });
  }
  if (req.method === "GET" && url.pathname === "/api/learning/evaluation-jobs") {
    const scope = url.searchParams.get("locale")
      ? learningScope({
        locale: url.searchParams.get("locale"),
        contentType: url.searchParams.get("contentType") || "general",
        domain: url.searchParams.get("domain") || "general",
        project: url.searchParams.get("project") || "default"
      })
      : null;
    return json(res, 200, { jobs: evaluationJobs.list(scope) });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/evaluation-jobs/") && url.pathname.endsWith("/resume")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/learning/evaluation-jobs/".length, -("/resume".length)));
    const job = evaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到评测任务");
      error.statusCode = 404;
      throw error;
    }
    const candidate = await getTranslationSkill(job.challengerId);
    const [currentChampion] = await listTranslationSkills({ ...learningScope(job.scope), status: "champion", limit: 1 });
    try {
      assertCurrentCandidate(candidate, currentChampion);
    } catch (error) {
      // 候选已经被拒绝 / 已被新版本替代：这个任务永远续跑不了，直接判失败。
      // 否则前端每轮轮询都会再 POST 一次续跑，日志被 409 刷屏（实测每 4 秒一条）。
      await evaluationJobs.fail(jobId, `无法续跑：${error.message}`);
      return json(res, 409, { error: `无法续跑：${error.message}` });
    }
    await evaluationJobs.resume(jobId);
    return json(res, 200, { job: evaluationJobs.get(jobId) });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/evaluation-jobs/") && url.pathname.endsWith("/retry-failed")) {
    // 只重跑失败的那几组样本：已成功的样本继续沿用，不用把 27 组全部重新烧一遍模型调用。
    const jobId = decodeURIComponent(url.pathname.slice("/api/learning/evaluation-jobs/".length, -"/retry-failed".length));
    const job = evaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到评测任务");
      error.statusCode = 404;
      throw error;
    }
    if (!Number(job.progress?.failed)) return json(res, 409, { error: "这条评测没有失败样本，不需要重试" });
    const active = evaluationJobs.findActiveForChallenger(job.challengerId);
    if (active && active.jobId !== jobId) {
      return json(res, 409, { error: "该候选已有进行中的评测任务，等它跑完再重试失败样本" });
    }
    const candidate = await getTranslationSkill(job.challengerId);
    const [currentChampion] = await listTranslationSkills({ ...learningScope(job.scope), status: "champion", limit: 1 });
    try {
      assertCurrentCandidate(candidate, currentChampion);
    } catch (error) {
      await evaluationJobs.fail(jobId, `无法重试：${error.message}`);
      return json(res, 409, { error: `无法重试：${error.message}` });
    }
    const retried = await evaluationJobs.retryFailed(jobId);
    logInfo("只重试失败的评测样本", { jobId, challengerId: job.challengerId, progress: retried?.progress });
    return json(res, 202, { job: retried });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/learning/evaluation-jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/learning/evaluation-jobs/".length));
    const job = evaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到评测任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { job });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/activate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/activate".length));
    const skill = await getTranslationSkill(id);
    if (!skill) {
      const error = new Error("未找到候选技能");
      error.statusCode = 404;
      throw error;
    }
    const scope = learningScope(skill);
    const [currentChampion] = await listTranslationSkills({ ...scope, status: "champion", limit: 1 });
    const [latest] = await listSkillEvaluations({ challengerSkillId: id, limit: 1 });
    assertCurrentCandidate(skill, currentChampion, latest, { requireEvaluation: true });
    // 发版门禁：固定资产上的回归必须在这个候选上真跑过并通过，而且结论要覆盖当前
    // 资产版本。回归集更新后旧 pass 自动作废——否则拿旧结论放行等于门禁形同虚设。
    const [latestGateRun] = await listQualityRuns({ ...scope, skillId: id, limit: 1 });
    const assets = await loadGateAssets(scope);
    const covers = latestGateRun ? gateRunCoversAssets(latestGateRun, assets) : false;
    if (!latestGateRun || latestGateRun.decision !== "pass" || !covers) {
      const staleVersions = latestGateRun
        ? `门禁跑过的是 Gold ${(latestGateRun.assetVersions?.goldSets || []).join("、") || "无"} / 回归 ${(latestGateRun.assetVersions?.regressionSuites || []).join("、") || "无"}，` +
          `当前是 Gold ${assets.goldSetVersions.join("、") || "无"} / 回归 ${assets.regressionSuiteVersions.join("、") || "无"}`
        : "";
      const error = new Error(latestGateRun
        ? (covers
          ? `质量门禁未通过（${latestGateRun.decision}），不能晋升：${(latestGateRun.blocking || []).map((item) => item.message).join("；") || "无阻断说明"}`
          : `质量门禁结论已过期：资产版本已经变化，需要重跑。${staleVersions}`)
        : "该候选尚未在固定 Gold Set 与回归集上跑过质量门禁，不能晋升");
      error.statusCode = 409;
      error.details = {
        gate: latestGateRun
          ? { decision: latestGateRun.decision, blocking: latestGateRun.blocking || [], runId: latestGateRun.id, coversCurrentAssets: covers, assetVersions: latestGateRun.assetVersions || {} }
          : { decision: "not_run" },
        currentAssets: { goldSets: assets.goldSetVersions, regressionSuites: assets.regressionSuiteVersions },
        hint: "先执行 POST /api/quality/runs（面板上的「运行门禁」会自动带上当前候选）"
      };
      throw error;
    }
    const activated = await activateTranslationSkill(id);
    // 生效版本换人：同作用域里针对旧生效版本的评测都作废，停掉它们别让客户端去续跑。
    await failEvaluationJobs(evaluationJobs,
      (job) => sameEvaluationScope(job.scope, scope) && String(job.championId) !== String(id),
      "生效版本已更新，本次评测终止");
    return json(res, 200, { skill: activated, gate: latestGateRun || null });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/disable")) {
    // 规则冲突审查里"停用候选"：只有还没生效的版本能这么处理。
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/disable".length));
    const before = await getTranslationSkill(id);
    if (!before) {
      const error = new Error("技能版本不存在");
      error.statusCode = 404;
      throw error;
    }
    if (!["challenger", "draft"].includes(String(before.status || ""))) {
      const error = new Error("只有候选/草稿可以停用；生效版本请走回滚或新候选");
      error.statusCode = 409;
      throw error;
    }
    const skill = await updateTranslationSkill(id, { status: "inactive" });
    await failEvaluationJobs(evaluationJobs, (job) => String(job.challengerId) === String(id), "候选技能已被停用，评测终止");
    return json(res, 200, { skill });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/reject")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/reject".length));
    const skill = await updateTranslationSkill(id, { status: "rejected" });
    if (!skill) {
      const error = new Error("未找到候选技能");
      error.statusCode = 404;
      throw error;
    }
    // 候选已被拒绝：它身上没跑完的评测不会再续跑，就地判失败（原因写进任务中心）。
    await failEvaluationJobs(evaluationJobs, (job) => String(job.challengerId) === String(id), "候选技能已被拒绝，评测终止");
    return json(res, 200, { skill });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/rollback")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/rollback".length));
    const before = await getTranslationSkill(id);
    const result = await rollbackTranslationSkill(id);
    // 生效版本换人：同作用域里针对旧生效版本的评测全部作废，别让它们续跑。
    if (before) {
      await failEvaluationJobs(evaluationJobs,
        (job) => sameEvaluationScope(job.scope, learningScope(before)) && String(job.championId) !== String(result?.champion?.id || ""),
        "生效版本已回滚，本次评测终止");
    }
    return json(res, 200, result);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/learning/skills/")) {
    // 删掉一个不再要的候选版本。生效版本不能删：删了等于生产翻译失去当前策略，
    // 要走「先用新版本替换 / 回滚」这条线。
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length));
    const skill = await getTranslationSkill(id);
    if (!skill) return json(res, 404, { error: "技能版本不存在" });
    if (String(skill.status) === "champion") {
      return json(res, 409, { error: "当前生效版本不能删除：先启用新版本或回滚，再删掉它" });
    }
    const deleted = await deleteTranslationSkill(id);
    await failEvaluationJobs(evaluationJobs, (job) => String(job.challengerId) === String(id), "候选技能已被删除，评测终止");
    logInfo("删除翻译技能版本", { id, version: skill.version, status: skill.status });
    return json(res, 200, { deleted, id });
  }
  if (req.method === "GET" && url.pathname === "/api/quality/assets") {
    const scope = learningScope({
      locale: url.searchParams.get("locale"),
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "general",
      project: url.searchParams.get("project") || "default"
    });
    const kind = url.searchParams.get("kind") || "";
    const [goldSets, candidates, suites] = await Promise.all([
      kind && kind !== "gold_set" ? [] : listQualityAssets({ ...scope, kind: "gold_set", limit: 200 }),
      kind && kind !== "regression_candidate" ? [] : listQualityAssets({ ...scope, kind: "regression_candidate", limit: 200 }),
      kind && kind !== "regression_suite" ? [] : listQualityAssets({ ...scope, kind: "regression_suite", limit: 200 })
    ]);
    const active = await loadGateAssets(scope);
    return json(res, 200, {
      scope,
      goldSets,
      regressionCandidates: candidates,
      regressionSuites: suites,
      active: {
        goldSampleCount: active.samples.length,
        regressionCaseCount: active.cases.length,
        goldSetVersions: active.goldSetVersions,
        regressionSuiteVersions: active.regressionSuiteVersions
      }
    });
  }
  if (req.method === "POST" && url.pathname === "/api/quality/gold-sets") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const seriesId = String(body.seriesId || "").trim() || `gold:${scope.locale}:${scope.contentType}:${scope.domain}:${scope.project}`;
    const version = await nextQualityAssetVersion(scope, "gold_set", seriesId);
    // 内容不可变：这里永远是新建一个版本，绝不覆盖已存在的版本。
    const payload = normalizeGoldSet({
      id: `${seriesId}#v${version}`,
      seriesId,
      version,
      parentVersionId: String(body.parentVersionId || ""),
      scope,
      name: String(body.name || "").trim() || `${scope.locale} 固定 Gold Set`,
      description: String(body.description || ""),
      status: body.status === "active" ? "active" : "draft",
      enabled: body.status === "active",
      samples: Array.isArray(body.samples) ? body.samples : [],
      createdAt: new Date().toISOString(),
      createdBy: String(body.createdBy || "").trim(),
      changeNote: String(body.changeNote || "")
    });
    const saved = await saveQualityAsset({ kind: "gold_set", scope, payload, status: payload.status, enabled: payload.enabled });
    return json(res, 201, { asset: payload.status === "active" ? await activateQualityAsset(saved) : saved });
  }
  if (req.method === "POST" && url.pathname === "/api/quality/gold-sets/from-trajectories") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 40));
    const trajectories = await listLearningTrajectories({ ...scope, limit: 500 });
    // Gold 样本只能来自人工采纳的终稿：机器自评通过的译文没有资格当基准。
    const accepted = trajectories.filter((item) => item.status === "completed"
      && item.humanDecision?.accepted === true
      && String(item.humanDecision?.finalTranslation || item.finalTranslation || "").trim()
      && String(item.source || "").trim());
    const seen = new Set();
    const samples = [];
    for (const item of accepted) {
      const key = String(item.source).trim();
      if (seen.has(key) || samples.length >= limit) continue;
      seen.add(key);
      samples.push({
        id: `gold-${item.id}`,
        source: key,
        referenceTargets: [String(item.humanDecision?.finalTranslation || item.finalTranslation).trim()],
        notes: `来自人工采纳终稿 ${item.id}`,
        metadata: { trajectoryId: item.id, batchId: item.batchId || "", createdAt: item.createdAt || "" }
      });
    }
    return json(res, 200, { scope, candidates: samples, acceptedTotal: accepted.length });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/quality/assets/") && url.pathname.endsWith("/activate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/quality/assets/".length, -"/activate".length));
    const asset = await getQualityAsset(id);
    if (!asset) {
      const error = new Error("未找到质量资产");
      error.statusCode = 404;
      throw error;
    }
    if (asset.kind === "regression_candidate") {
      const error = new Error("回归候选通过审批接口决定，不能直接启用");
      error.statusCode = 400;
      throw error;
    }
    if (!asset.itemCount) {
      const error = new Error("空的固定资产不能启用");
      error.statusCode = 400;
      throw error;
    }
    return json(res, 200, { asset: await activateQualityAsset(asset) });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/quality/assets/") && url.pathname.endsWith("/retire")) {
    const id = decodeURIComponent(url.pathname.slice("/api/quality/assets/".length, -"/retire".length));
    const asset = await getQualityAsset(id);
    if (!asset) {
      const error = new Error("未找到质量资产");
      error.statusCode = 404;
      throw error;
    }
    const retired = await updateQualityAsset(id, { status: "retired", enabled: false, payload: { ...asset.payload, status: "retired", enabled: false } });
    return json(res, 200, { asset: retired });
  }
  if (req.method === "POST" && url.pathname === "/api/quality/regression-candidates") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const qaCaseId = String(body.qaCaseId || "").trim();
    if (!qaCaseId) {
      const error = new Error("缺少 qaCaseId");
      error.statusCode = 400;
      throw error;
    }
    const qaCases = await getQaCases(scope.locale, { projectId: scope.project, contentType: scope.contentType, domain: scope.domain, limit: -1 });
    const qaCase = qaCases.find((item) => String(item.id) === qaCaseId);
    if (!qaCase) {
      const error = new Error("未找到该 QA 案例，或它尚未经过人工批准");
      error.statusCode = 404;
      throw error;
    }
    const existing = await listQualityAssets({ ...scope, kind: "regression_candidate", sourceQaCaseId: qaCaseId, limit: 10 });
    if (existing.length) return json(res, 200, { asset: existing[0], alreadyExists: true });
    const payload = createRegressionCandidateFromQaCase({ ...qaCase, scope }, {
      scope,
      createdAt: new Date().toISOString(),
      createdBy: String(body.createdBy || "").trim()
    });
    const saved = await saveQualityAsset({ kind: "regression_candidate", scope, payload, status: payload.status, enabled: false });
    return json(res, 201, { asset: saved });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/quality/regression-candidates/") && url.pathname.endsWith("/decision")) {
    const id = decodeURIComponent(url.pathname.slice("/api/quality/regression-candidates/".length, -"/decision".length));
    const body = await readJsonBody(req);
    const asset = await getQualityAsset(id);
    if (!asset || asset.kind !== "regression_candidate") {
      const error = new Error("未找到回归候选");
      error.statusCode = 404;
      throw error;
    }
    // 第二道人工闸门：候选进回归集之前必须被明确批准或拒绝，拒绝还要写原因。
    const decided = decideRegressionCandidate(asset.payload, {
      decision: String(body.decision || ""),
      reviewer: String(body.reviewer || "").trim(),
      decidedAt: new Date().toISOString(),
      note: String(body.note || "")
    });
    const updated = await updateQualityAsset(id, { status: decided.status, approval: decided.approval, payload: decided });
    // 决定之后立刻按最新证据重建回归集：批准＝入集，拒绝＝从下一版里消失。
    const scope = learningScope(asset);
    let regression = null;
    try {
      const result = await refreshRegressionSuite(scope, { reason: `candidate-${decided.status}` });
      regression = { changed: Boolean(result.changed), suiteVersion: result.asset?.version || null, cases: result.stats?.total || 0 };
      if (decided.status === "approved") triggerQualityGateRefresh(scope, { reason: "candidate-approved" });
    } catch (error) {
      console.error("回归候选裁定后重建回归集失败", error);
    }
    return json(res, 200, { asset: updated, regression });
  }
  if (req.method === "POST" && url.pathname === "/api/quality/regression-suites") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    // 案例来源有两处：外部审校回填的改动与人工批准的 QA 失败案例。两者都是派生输入，
    // 所以这里永远是"按最新证据重建"，不再需要先把候选一条条审批进集。
    const result = await refreshRegressionSuite(scope, {
      reason: "manual",
      changeNote: String(body.changeNote || "").trim() || "按最新证据手动重建"
    });
    if (!result.asset) {
      const error = new Error(`${result.reason}：先把审校后的双语文件回填一次，或在译文质检里采纳失败案例`);
      error.statusCode = 400;
      throw error;
    }
    return json(res, result.changed ? 201 : 200, {
      asset: result.asset,
      changed: Boolean(result.changed),
      stats: { externalCases: result.stats?.external || 0, qaCases: result.stats?.qa || 0, total: result.stats?.total || 0 },
      reason: result.reason
    });
  }
  if (req.method === "GET" && url.pathname === "/api/quality/runs") {
    const scope = learningScope({
      locale: url.searchParams.get("locale"),
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "general",
      project: url.searchParams.get("project") || "default"
    });
    const runs = await listQualityRuns({ ...scope, skillId: url.searchParams.get("skillId") || "", limit: Number(url.searchParams.get("limit")) || 20 });
    return json(res, 200, { scope, runs });
  }
  if (req.method === "POST" && /^\/api\/quality\/runs\/[^/]+\/review$/u.test(url.pathname)) {
    // 门禁失败复盘：把"这次又犯的错"按模式归类，给出下一步能做什么。
    // 报告只写进运行记录的 report.review，不改结论、不改资产。
    const id = decodeURIComponent(url.pathname.slice("/api/quality/runs/".length, -"/review".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const scope = learningScope(body);
    const target = (await listQualityRuns({ ...scope, limit: 100 })).find((item) => String(item.id) === id) || null;
    if (!target) {
      const error = new Error("未找到这次门禁运行");
      error.statusCode = 404;
      throw error;
    }
    const cases = gateFailureCases(target);
    if (!cases.length) {
      const empty = { summary: "这次门禁没有失败样本，不需要复盘", patterns: [], generatedAt: new Date().toISOString(), caseCount: 0, model: "" };
      await updateQualityRun(id, { report: { review: empty } });
      return json(res, 200, { runId: id, review: empty, cached: false });
    }
    const existing = target.report?.review;
    if (existing?.patterns && body.force !== true) {
      return json(res, 200, { runId: id, review: existing, cached: true });
    }
    const chunks = chunkGateFailures(cases);
    const parts = [];
    const failures = [];
    for (const chunk of chunks) {
      try {
        parts.push(await reviewGateFailuresWithModel({
          locale: target.locale || scope.locale,
          scope: { contentType: target.contentType || scope.contentType, domain: target.domain || scope.domain },
          cases: chunk.cases,
          part: chunks.length > 1 ? { index: chunk.index, total: chunks.length } : null
        }));
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (!parts.length) {
      const error = new Error(`复盘失败：${failures[0] || "模型不可用"}`);
      error.statusCode = 502;
      throw error;
    }
    const merged = mergeGateReviewReports(parts);
    const review = {
      ...merged,
      generatedAt: new Date().toISOString(),
      model: getProviderConfig().model,
      caseCount: cases.length,
      warning: failures[0] || ""
    };
    await updateQualityRun(id, { report: { review } });
    logInfo("门禁失败复盘已生成", { runId: id, cases: cases.length, patterns: review.patterns.length });
    return json(res, 200, { runId: id, review, cached: false });
  }
  if (req.method === "POST" && /^\/api\/quality\/runs\/[^/]+\/terms$/u.test(url.pathname)) {
    // 复盘里的术语建议 → 术语候选：期望译法取自这次失败案例的人工终稿，
    // 入库策略与回填时完全一致（终稿逐字确认才自动写入，其余待审核）。
    const id = decodeURIComponent(url.pathname.slice("/api/quality/runs/".length, -"/terms".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const scope = learningScope(body);
    const target = (await listQualityRuns({ ...scope, limit: 50 })).find((item) => String(item.id) === id);
    if (!target) {
      const error = new Error("未找到这次门禁运行");
      error.statusCode = 404;
      throw error;
    }
    const review = target.report?.review;
    if (!review?.patterns?.length) {
      const error = new Error("这次运行还没有复盘报告，先生成复盘");
      error.statusCode = 400;
      throw error;
    }
    const inputs = termInputsFromReview(review, gateFailureCases(target));
    if (!inputs.length) {
      const error = new Error("复盘里没有可转成术语的建议");
      error.statusCode = 400;
      throw error;
    }
    const written = await persistTermCandidateInputs({
      locale: target.locale || scope.locale,
      projectId: scope.project,
      contentType: target.contentType || scope.contentType,
      domain: target.domain || scope.domain,
      batchId: `gate-review:${id}`,
      filename: `门禁复盘 ${String(target.createdAt || id).slice(0, 19)}`,
      inputs,
      sourceLabel: "门禁复盘"
    });
    return json(res, 200, { runId: id, candidates: inputs.length, ...written });
  }
  if (req.method === "POST" && url.pathname === "/api/learning/skills/from-gate-review") {
    // 据此改写技能：把复盘报告（含失败原文与人工终稿）交给模型产出策略补丁，
    // 复用与「生成候选技能」完全相同的净化、合并与落库路径。
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const runId = String(body.runId || "");
    const target = runId ? (await listQualityRuns({ ...scope, limit: 50 })).find((item) => String(item.id) === runId) : (await listQualityRuns({ ...scope, limit: 1 }))[0];
    if (!target) {
      const error = new Error("未找到这次门禁运行");
      error.statusCode = 404;
      throw error;
    }
    const review = target.report?.review;
    if (!review?.patterns?.length) {
      const error = new Error("这次运行还没有复盘报告，先生成复盘");
      error.statusCode = 400;
      throw error;
    }
    const [champion] = await listTranslationSkills({ ...scope, status: "champion", limit: 1 });
    const usableChampion = champion || await ensureChampionTranslationSkill(scope);
    const cases = gateFailureCases(target);
    // 证据口径与轨迹提炼一致：凡是喂给模型的东西都登记为证据，之后不会回流进留出集。
    const patternIds = Array.isArray(body.patternIds) ? body.patternIds.map(String) : null;
    const selectedPatterns = patternIds?.length ? review.patterns.filter((pattern) => patternIds.includes(String(pattern.id))) : review.patterns;
    const selectedCaseIds = new Set(selectedPatterns.flatMap((pattern) => pattern.caseIds || []));
    const evidenceIds = [...new Set(cases
      .filter((item) => !selectedCaseIds.size || selectedCaseIds.has(item.caseId))
      .map((item) => String(item.sourceTrajectoryId || ""))
      .filter(Boolean))];
    const skill = await proposeChallengerFromGateReview({
      scope,
      champion: usableChampion,
      review: { ...review, patterns: selectedPatterns },
      cases,
      evidenceIds,
      runId: String(target.id)
    });
    return json(res, 201, { skill, candidate: skill, runId: String(target.id) });
  }
  if (req.method === "POST" && url.pathname === "/api/quality/runs") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const skill = body.skillId ? await getTranslationSkill(String(body.skillId)) : await ensureChampionTranslationSkill(scope);
    if (!skill) {
      const error = new Error("未找到受测技能");
      error.statusCode = 404;
      throw error;
    }
    const { task, total } = await startQualityGateRun({
      scope,
      skill,
      triggeredBy: String(body.triggeredBy || "manual"),
      reason: "manual"
    });
    return json(res, 202, { backgroundTaskId: task.id, message: `质量门禁已进入任务中心，将执行 ${total} 个固定样本`, total });
  }
  if (req.method === "GET" && url.pathname === "/api/quality/gate") {
    const scope = learningScope({
      locale: url.searchParams.get("locale"),
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "general",
      project: url.searchParams.get("project") || "default"
    });
    const skillId = url.searchParams.get("skillId") || "";
    const [assets, runs] = await Promise.all([
      loadGateAssets(scope),
      listQualityRuns({ ...scope, ...(skillId ? { skillId } : {}), limit: 5 })
    ]);
    const latest = runs[0] || null;
    const gateCaseLimit = getSettings().learning.gateRegressionCaseLimit;
    const gateCases = selectGateCases(assets.cases, gateCaseLimit);
    const coversCurrentAssets = latest ? gateRunCoversAssets(latest, assets) : false;
    const sources = assets.cases.reduce((carry, item) => {
      if (item.sourceKind === "external_review") carry.externalReview += 1;
      else carry.qaApproved += 1;
      return carry;
    }, { externalReview: 0, qaApproved: 0 });
    return json(res, 200, {
      scope,
      latestRun: latest,
      recentRuns: runs,
      assets: {
        goldSampleCount: assets.samples.length,
        regressionCaseCount: assets.cases.length,
        regressionCaseTotal: assets.cases.length,
        gateCaseCount: gateCases.length,
        gateCaseLimit,
        goldSetVersions: assets.goldSetVersions,
        regressionSuiteVersions: assets.regressionSuiteVersions,
        sources,
        // 结论是否覆盖当前资产：回归集或 Gold Set 出了新版本，旧结论就不能再当证据。
        coverage: {
          valid: coversCurrentAssets,
          reason: !latest
            ? "尚未运行门禁"
            : coversCurrentAssets
              ? "结论覆盖当前 Gold Set 与回归集版本"
              : "资产版本已更新，需要重跑门禁"
        }
      },
      // 没跑过就是没证据，前端据此显示"未验证"而不是"通过"。
      status: latest ? latest.decision : "not_run"
    });
  }
  if (req.method === "POST" && url.pathname === "/api/learning/export") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const format = String(body.format || "json");
    const [trajectories, qaCases, assets] = await Promise.all([
      listLearningTrajectories({ ...scope, limit: 1000 }),
      getQaCases(scope.locale, { projectId: scope.project, contentType: scope.contentType, domain: scope.domain, limit: -1 }),
      loadGateAssets(scope)
    ]);
    const bundle = buildTrainingExport({
      trajectories,
      qaCases: qaCases.map((item) => ({ ...item, project: scope.project })),
      goldSamples: assets.samples,
      regressionCases: assets.cases
    }, { scope, instruction: String(body.instruction || "") });
    if (format === "jsonl") {
      const kind = body.dataset === "dpo" ? "dpo" : "sft";
      const dataset = kind === "dpo" ? bundle.dpo : bundle.sft;
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="kami-${kind}-${scope.locale}-${Date.now()}.jsonl"`
      });
      res.end(datasetToJsonl(dataset));
      return;
    }
    return json(res, 200, {
      scope,
      manifest: bundle.manifest,
      sft: { count: bundle.sft.records.length, audit: bundle.sft.audit },
      dpo: { count: bundle.dpo.records.length, audit: bundle.dpo.audit }
    });
  }
  if (req.method === "GET" && url.pathname === "/api/training/runs") {
    const scope = learningScope({
      locale: url.searchParams.get("locale"),
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "general",
      project: url.searchParams.get("project") || "default"
    });
    // 列表要给出总数并支持"加载更多"，不能把取到的第一页当成全部。
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const all = await listTrainingRuns({ ...scope, limit: 200 });
    return json(res, 200, {
      scope,
      total: all.length,
      limit,
      offset,
      hasMore: offset + limit < all.length,
      runs: all.slice(offset, offset + limit)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/training/runs") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    // 冻结数据集：先按当前作用域重新导出一次，把内容指纹钉死，训练用的就是这一份。
    const [trajectories, qaCases, assets] = await Promise.all([
      listLearningTrajectories({ ...scope, limit: 1000 }),
      getQaCases(scope.locale, { projectId: scope.project, contentType: scope.contentType, domain: scope.domain, limit: -1 }),
      loadGateAssets(scope)
    ]);
    const bundle = buildTrainingExport({
      trajectories,
      qaCases: qaCases.map((item) => ({ ...item, project: scope.project })),
      goldSamples: assets.samples,
      regressionCases: assets.cases
    }, { scope });
    const method = String(body.method || "sft").toLowerCase();
    const datasets = [];
    if (method === "dpo") datasets.push(freezeTrainingDataset({ kind: "dpo", jsonl: datasetToJsonl(bundle.dpo), audit: bundle.dpo.audit, manifest: bundle.manifest, scope }));
    else datasets.push(freezeTrainingDataset({ kind: "sft", jsonl: datasetToJsonl(bundle.sft), audit: bundle.sft.audit, manifest: bundle.manifest, scope }));
    const run = createTrainingRun({
      scope,
      name: String(body.name || ""),
      recipe: {
        method,
        baseModel: String(body.baseModel || ""),
        teacherModel: String(body.teacherModel || ""),
        ...(body.epochs === undefined ? {} : { epochs: body.epochs }),
        ...(body.learningRate === undefined ? {} : { learningRate: body.learningRate }),
        ...(body.batchSize === undefined ? {} : { batchSize: body.batchSize }),
        ...(body.loraRank === undefined ? {} : { loraRank: body.loraRank })
      },
      datasets,
      createdBy: String(body.createdBy || ""),
      createdAt: new Date().toISOString(),
      note: String(body.note || "")
    });
    const frozen = advanceTrainingRun(run, { status: "frozen", at: new Date().toISOString(), by: String(body.createdBy || ""), note: "导出并冻结数据集" });
    const saved = await saveTrainingRun({ scope, payload: frozen });
    return json(res, 201, { run: saved, manifest: buildTrainingManifest(frozen) });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/training/runs/") && url.pathname.endsWith("/manifest")) {
    const id = decodeURIComponent(url.pathname.slice("/api/training/runs/".length, -"/manifest".length));
    const run = await getTrainingRun(id);
    if (!run) {
      const error = new Error("未找到训练任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { manifest: buildTrainingManifest(run.payload) });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/training/runs/") && url.pathname.endsWith("/advance")) {
    const id = decodeURIComponent(url.pathname.slice("/api/training/runs/".length, -"/advance".length));
    const body = await readJsonBody(req);
    const run = await getTrainingRun(id);
    if (!run) {
      const error = new Error("未找到训练任务");
      error.statusCode = 404;
      throw error;
    }
    const status = String(body.status || "");
    // 先判状态迁移是否合法，再去找门禁记录：否则从 frozen 直接投产会报成
    // "找不到门禁记录"，把真正的原因（顺序不对）盖掉。
    if (!canTransition(String(run.payload?.status || run.status || "draft"), status)) {
      const error = new Error(`训练任务不能从 ${run.payload?.status || run.status} 直接进入 ${status || "空状态"}`);
      error.statusCode = 409;
      throw error;
    }
    let gate;
    if (status === "promoted") {
      // 微调产物投产前必须自己拿到一条通过的门禁记录，和其它候选一视同仁。
      const scope = learningScope(run);
      const [latest] = await listQualityRuns({ ...scope, skillId: String(body.gateRunSkillId || run.payload?.artifact?.modelId || ""), limit: 1 });
      const chosen = body.qualityRunId
        ? (await listQualityRuns({ ...scope, limit: 50 })).find((item) => item.id === String(body.qualityRunId))
        : latest;
      if (!chosen) {
        const error = new Error("找不到可用于放行的质量门禁记录，请先对该微调模型执行一次门禁");
        error.statusCode = 409;
        throw error;
      }
      gate = {
        decision: chosen.decision,
        runId: chosen.id,
        regressionPassRate: chosen.regressionPassRate,
        goldTermAccuracy: chosen.goldTermAccuracy,
        checkedAt: chosen.createdAt
      };
    }
    const advanced = advanceTrainingRun(run.payload, {
      status,
      at: new Date().toISOString(),
      by: String(body.by || ""),
      note: String(body.note || ""),
      ...(body.externalJobId === undefined ? {} : { externalJobId: body.externalJobId }),
      ...(body.artifact === undefined ? {} : { artifact: body.artifact }),
      ...(body.error === undefined ? {} : { error: body.error }),
      ...(gate ? { gate } : {})
    });
    return json(res, 200, { run: await saveTrainingRun({ id: run.id, scope: learningScope(run), payload: advanced }) });
  }
  if (req.method === "POST" && url.pathname === "/api/batch/columns") {
    // 待译表格上传时的"列含义"弹窗：只分析结构（本地规则 + 可选 AI），不生成段落、不翻译。
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const locale = assertActiveLocale(body.locale || "zh-CN");
    const analyzeSpreadsheet = body.useAiStructure === false ? undefined : (snapshot, ruleAnalysis) => analyzeSpreadsheetStructureWithModel(snapshot, ruleAnalysis, locale);
    return json(res, 200, await describeBatchColumns(body, { analyzeSpreadsheet }));
  }
  if (req.method === "POST" && url.pathname === "/api/batch/prepare") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const locale = assertActiveLocale(body.locale || "zh-CN");
    const analyzeSpreadsheet = body.useAiStructure === false ? undefined : (snapshot, ruleAnalysis) => analyzeSpreadsheetStructureWithModel(snapshot, ruleAnalysis, locale);
    const project = body.projectId ? await getProject(String(body.projectId)) : null;
    if (body.projectId && !project) return json(res, 404, { error: "项目不存在" });
    const prepared = await prepareBatchDocument(body, { analyzeSpreadsheet, batch: project?.settings?.batch || {}, columnMapping: body.columnMapping || null });
    const { batchId } = await saveBatchRun({ ...prepared, projectId: body.projectId || "", locale, contentType: body.contentType || "general", domain: concreteDomain(body.domain, { contentType: body.contentType || "general" }), segments: prepared.segments, subBatches: prepared.subBatches, runState: "ready" });
    // 原文件按批次存档：以后导出写回不用再让用户重新选一遍（刷新页面也还在）。
    let originalFile = "";
    const originalBuffer = body.base64
      ? Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/u, ""), "base64")
      : (body.text !== undefined ? Buffer.from(String(body.text), "utf8") : null);
    if (originalBuffer?.length) {
      try {
        const saved = await saveBatchOriginal({ dataRoot: DATA_ROOT, batchId, filename: prepared.filename || body.filename, buffer: originalBuffer });
        originalFile = saved.relative;
        const run = await getBatchRun(batchId);
        if (run) await saveBatchRun({ ...run, runnerOptions: { ...(run.runnerOptions || {}), originalFile, originalBytes: saved.bytes } });
      } catch (error) {
        console.error(`[Kami] 原文件存档失败（批次 ${batchId}）：${error.message}`);
      }
    }
    // 解析完就让后台通读全文做语境分析（不阻塞上传响应）：翻译开始前必须有用途标注，
    // 否则就会回落到"读前 8000 字猜一次"。进度在任务中心与批次页都能看到。
    const contextBriefPending = prepared.segments.length >= CONTEXT_BRIEF_MIN_SEGMENTS;
    if (contextBriefPending) startContextAnalysis(batchId).catch((error) => console.error("[Kami] 语境分析启动失败", error));
    // requiresBrief 交给前端判门禁：阈值只写在服务端一处，页面不再自己记一份 6 段。
    return json(res, 200, { ...prepared, batchId, originalFile, contextBriefPending, requiresBrief: contextBriefPending });
  }
  if (req.method === "POST" && url.pathname === "/api/batch/run") {
    const body = await readJsonBody(req);
    const existing = body.batchId ? await getBatchRun(body.batchId) : null;
    const saved = await saveBatchRun({ ...existing, ...body, runnerOptions: { ...existing?.runnerOptions, ...body.runnerOptions }, locale: assertActiveLocale(body.locale || "zh-CN") });
    return json(res, 200, saved);
  }
  if (req.method === "GET" && url.pathname === "/api/batch/files") {
    // 翻译界面的"文件列表"：一个待译文件 = 一条批次。把进度、语境分析、QA 待处理、
    // 人工审校（学习轨迹里 accepted 的条数）与原文件存档情况一次算齐，前端一页就够了。
    const locale = assertActiveLocale(url.searchParams.get("locale") || ACTIVE_LOCALES[0]);
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    const [runs, countByFile] = await Promise.all([
      listBatchRuns({ locale, projectId, limit: 500 }).catch(() => []),
      countLearningTrajectoriesByFile({ locale, project: projectId }).catch(() => [])
    ]);
    const learningByFile = new Map(countByFile.map((item) => [String(item.sourceFile || "").trim(), item]));
    const files = runs.map((run) => {
      const learning = learningByFile.get(String(run.filename || "").trim()) || null;
      const brief = run.contextBrief || null;
      const briefStatus = contextAnalysisTasks.has(run.batchId)
        ? "pending"
        : brief?.status === "ready" ? "ready" : brief?.status || "none";
      return {
        batchId: run.batchId,
        filename: run.filename,
        format: run.format,
        locale: run.locale,
        projectId: run.projectId || "",
        runState: run.runState,
        status: run.status,
        totalSegments: run.totalSegments,
        completedSegments: run.completedSegments,
        failedSegments: run.failedSegments,
        qaPending: run.qaPending,
        qualityTiers: run.qualityTiers || null,
        brief: { status: briefStatus, sections: brief?.sections || 0 },
        learning: { count: Number(learning?.count) || 0, humanReviewed: Number(learning?.humanReviewed) || 0 },
        hasOriginal: Boolean(run.runnerOptions?.originalFile),
        originalBytes: Number(run.runnerOptions?.originalBytes) || 0,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      };
    });
    return json(res, 200, { locale, projectId, total: files.length, files });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/tasks/")) {
    // 删除一条翻译批次：正在跑就先中断并等它停下，再删记录；关联的后台任务行、
    // 原文件存档与后台导出文件一并清理，避免留下孤儿。
    const batchId = decodeURIComponent(url.pathname.slice("/api/tasks/".length));
    const run = await getBatchRun(batchId);
    if (!run) return json(res, 404, { error: "未找到这条翻译任务" });
    const stopFirst = String(url.searchParams.get("stop") || "") !== "0";
    const worker = batchWorkers.get(batchId);
    let stopped = false;
    if (worker && !stopFirst) {
      return json(res, 409, { error: "这条批次还在运行：请选择「停止并删除」或先中断它" });
    }
    if (worker) {
      worker.cancelRequested = true;
      stopped = true;
      const deadline = Date.now() + 15_000;
      while (batchWorkers.has(batchId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const related = (await listBackgroundTasks({ limit: 500 })).filter((task) => task.payload?.batchId === batchId);
    for (const task of related) {
      if (task.type === "batch_export") await rm(join(DATA_ROOT, "exports", `${task.id}.xlsx`), { force: true }).catch(() => {});
      await deleteBackgroundTask(task.id).catch(() => {});
    }
    if (run.runnerOptions?.originalFile) {
      await deleteBatchOriginal({ dataRoot: DATA_ROOT, relativePath: run.runnerOptions.originalFile }).catch(() => {});
    }
    const deleted = await deleteBatchRun(batchId);
    logInfo("已删除翻译批次", { batchId, filename: run.filename, stopped, relatedTasks: related.length });
    return json(res, deleted ? 200 : 404, { deleted, stopped, relatedTasks: related.length });
  }
  if (req.method === "POST" && /^\/api\/batch\/run\/[^/]+\/import-review$/u.test(url.pathname)) {
    // 审校回填：把在 memoQ 里改完的同一批文件导回来，覆盖译文 + 更新主 TM 与学习轨迹。
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    const run = await getBatchRun(batchId);
    if (!run || !body.projectId || run.projectId !== String(body.projectId)) return json(res, 404, { error: "未找到当前项目的批次任务" });
    const filename = String(body.filename || "").trim();
    const base64 = String(body.base64 || "").replace(/^data:[^;]+;base64,/u, "");
    if (!filename || !base64) return json(res, 400, { error: "请选择审校后导出的双语文件" });
    if (!/\.(xlsx|csv|xliff|mqxliff)$/iu.test(filename)) return json(res, 400, { error: "审校回填只支持 xlsx、csv、xliff、mqxliff" });
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) return json(res, 400, { error: "文件内容为空" });
    if (buffer.length > IMPORT_FILE_BYTES) return json(res, 400, { error: `审校文件超过 ${Math.round(IMPORT_FILE_BYTES / (1024 * 1024))}MB 上限` });
    const pairs = /\.(xlsx|csv)$/iu.test(filename)
      ? (await extractTermPairs({ filename, base64, locale: run.locale })).candidates.map((candidate) => ({
        source: candidate.source,
        target: candidate.target,
        entryId: candidate.entryId || "",
        sourceRow: candidate.rowNumber || null,
        sheet: candidate.sheet || "",
        note: candidate.note || ""
      }))
      : extractXliffPairs(buffer, filename);
    if (!pairs.length) return json(res, 400, { error: "文件里没有可回填的双语条目（需要原文与译文都非空）" });
    return json(res, 200, await importBatchReview({ run, pairs, projectId: String(body.projectId), filename }));
  }
  if (req.method === "POST" && /^\/api\/batch\/run\/[^/]+\/(?:start|resume)$/u.test(url.pathname)) {
    const parts = url.pathname.split("/");
    const batchId = decodeURIComponent(parts[4]);
    const body = await readJsonBody(req).catch(() => ({}));
    const run = await getBatchRun(batchId);
    if (!run || !body.projectId || run.projectId !== String(body.projectId)) return json(res, 404, { error: "未找到当前项目的批次任务" });
    if (batchQaWorkers.has(batchId) || batchQaStarts.has(batchId)) return json(res, 409, { error: "AIQA 重试或收尾正在运行，请在当前阶段结束后重试翻译" });
    if (batchWorkers.has(batchId)) return json(res, 200, { batchId, runState: "running", alreadyRunning: true });
    // 语境分析是翻译的前置条件：还没跑完就先把分析跑起来，让前端等在原地，
    // 而不是用"猜出来的语体"先把整批翻掉。
    const briefReady = run.contextBrief?.status === "ready";
    if (!briefReady && (run.segments || []).length >= CONTEXT_BRIEF_MIN_SEGMENTS) {
      const pending = contextAnalysisTasks.has(batchId);
      if (!pending) startContextAnalysis(batchId).catch((error) => console.error("[Kami] 语境分析启动失败", error));
      return json(res, 409, {
        code: "context_brief_pending",
        batchId,
        error: pending ? "语境分析还在进行，完成后翻译会自动开始" : "已开始语境分析，完成后翻译会自动开始"
      });
    }
    const segments = run.segments.map((segment) => segment.status === "error" || segment.status === "running" ? { ...segment, status: "pending", error: "" } : segment);
    // 保留 runnerOptions 里的原文件存档路径：写回原文件靠它。
    await saveBatchRun({
      ...run,
      segments,
      runnerOptions: {
        ...(run.runnerOptions || {}),
        cancelled: false,
        translationError: "",
        qualityTier: resolveManualTier({ qualityTier: body.qualityTier ?? run.runnerOptions?.qualityTier, route: body.route || run.runnerOptions?.route })
      },
      runState: "queued"
    });
    const task = await createBackgroundTask({
      type: "batch_translation",
      title: `批次翻译 · ${run.filename}`,
      locale: run.locale,
      projectId: run.projectId,
      progress: { phase: "queued", message: "已进入服务端批次队列", percent: 0, completed: 0, total: run.segments.filter((segment) => segment.selected !== false).length },
      payload: { batchId }
    });
    startBatchWorker(batchId, task.id);
    return json(res, 202, { batchId, runState: "queued", backgroundTaskId: task.id });
  }
  if (/^\/api\/batch\/run\/[^/]+\/context-brief$/u.test(url.pathname)) {
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const run = await getBatchRun(batchId);
    if (!run) return json(res, 404, { error: "未找到这条翻译任务" });
    if (req.method === "GET") {
      return json(res, 200, {
        batchId,
        pending: contextAnalysisTasks.has(batchId),
        brief: run.contextBrief || null,
        summary: summarizeContextBrief(run.contextBrief || null)
      });
    }
    if (req.method === "POST") {
      // 手动（重新）分析：立即返回，进度走 GET 轮询与任务中心；
      // 已在跑时服务端会复用同一次任务，不重复烧额度。
      const alreadyRunning = contextAnalysisTasks.has(batchId);
      if (!alreadyRunning) startContextAnalysis(batchId).catch((error) => console.error("[Kami] 语境分析任务异常", error));
      return json(res, 202, { batchId, pending: true, alreadyRunning });
    }
    if (req.method === "PATCH") {
      // 人工修正：用途区间、注意点与整体结论都可以改，改完立即对后续翻译生效。
      const body = await readJsonBody(req);
      const current = run.contextBrief || { version: 1, status: "ready", generatedAt: new Date().toISOString() };
      const next = { ...current };
      if (body.documentType && typeof body.documentType === "object") {
        next.documentType = { ...(current.documentType || {}), ...body.documentType };
      }
      if (Array.isArray(body.sections)) {
        const total = (run.segments || []).length;
        const sections = [];
        for (const section of body.sections) {
          const from = Math.trunc(Number(section?.from));
          const to = Math.trunc(Number(section?.to));
          if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || from < 1) continue;
          const purpose = Object.hasOwn(CONTENT_TYPES, String(section?.purpose || "")) ? String(section.purpose) : "general";
          sections.push({
            from: Math.min(from, total),
            to: Math.min(to, total),
            purpose,
            tone: String(section?.tone || "").slice(0, 80),
            note: String(section?.note || "").slice(0, 300)
          });
        }
        next.sections = sections;
      }
      if (Array.isArray(body.notes)) {
        next.notes = body.notes
          .map((note) => ({ text: String(note?.text || "").slice(0, 300), ids: Array.isArray(note?.ids) ? note.ids.map(String).slice(0, 20) : [] }))
          .filter((note) => note.text)
          .slice(0, 40);
      }
      next.status = "ready";
      next.editedAt = new Date().toISOString();
      const covered = new Set();
      for (const section of next.sections || []) for (let index = section.from; index <= section.to; index += 1) covered.add(index);
      next.coverage = { ...(current.coverage || {}), covered: covered.size, total: (run.segments || []).length, percent: run.segments?.length ? Math.round((covered.size / run.segments.length) * 100) : 0 };
      await saveBatchRun({ ...run, contextBrief: next });
      return json(res, 200, { batchId, summary: summarizeContextBrief(next) });
    }
    return json(res, 405, { error: "不支持的方法" });
  }
  if (/^\/api\/batch\/run\/[^/]+\/consistency-check$/u.test(url.pathname)) {
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const run = await getBatchRun(batchId);
    if (!run) return json(res, 404, { error: "未找到这条翻译任务" });
    if (req.method === "GET") {
      return json(res, 200, { batchId, pending: consistencyCheckTasks.has(batchId), ...(run.qualityReport || { report: null, findings: [] }) });
    }
    if (req.method === "POST") {
      // 同上：核对要跑几十次模型调用，不能挂在请求上等。
      if (batchQaWorkers.has(batchId)) return json(res, 409, { error: "AIQA 重试正在进行，结束后会自动重新生成质量报告" });
      const alreadyRunning = consistencyCheckTasks.has(batchId);
      if (!alreadyRunning) startConsistencyCheck(batchId).catch((error) => console.error("[Kami] 一致性核对任务异常", error));
      return json(res, 202, { batchId, pending: true, alreadyRunning });
    }
    return json(res, 405, { error: "不支持的方法" });
  }
  if (req.method === "POST" && /^\/api\/batch\/run\/[^/]+\/term-survey$/u.test(url.pathname)) {
    // 手动重跑术语普查：批次跑完会自动跑一次，界面上的「重新普查」走这里。
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const run = await getBatchRun(batchId);
    if (!run) return json(res, 404, { error: "未找到这条翻译任务" });
    if (batchQaWorkers.has(batchId)) return json(res, 409, { error: "AIQA 重试正在进行，结束后会自动重新做术语普查" });
    const alreadyRunning = termSurveyTasks.has(batchId);
    if (!alreadyRunning) startTermSurvey(batchId).catch((error) => console.error("[Kami] 术语普查任务异常", error));
    return json(res, 202, { batchId, pending: true, alreadyRunning });
  }
  if (req.method === "POST" && /^\/api\/batch\/run\/[^/]+\/pause$/u.test(url.pathname)) {
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const body = await readJsonBody(req).catch(() => ({}));
    const run = await getBatchRun(batchId);
    if (!run || !body.projectId || run.projectId !== String(body.projectId)) return json(res, 404, { error: "未找到当前项目的批次任务" });
    const worker = batchWorkers.get(batchId);
    if (worker) worker.pauseRequested = true;
    await saveBatchRun({ ...run, runState: "paused" });
    return json(res, 200, { batchId, runState: "paused", waitingForCurrentSegment: Boolean(worker) });
  }
  if (req.method === "POST" && /^\/api\/batch\/run\/[^/]+\/cancel$/u.test(url.pathname)) {
    // 中断批次：跑批循环在下一段开始前停下，已完成段落全部保留；
    // runState 只有数据库允许的那几个取值，所以中断用「已暂停 + cancelled 标记」表达，
    // 界面据此显示"已中断"，并且之后能直接「继续」。
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const body = await readJsonBody(req).catch(() => ({}));
    const run = await getBatchRun(batchId);
    if (!run || !body.projectId || run.projectId !== String(body.projectId)) return json(res, 404, { error: "未找到当前项目的批次任务" });
    const worker = batchWorkers.get(batchId);
    if (worker) {
      worker.cancelRequested = true;
      return json(res, 202, { batchId, runState: run.runState || "running", cancelling: true, waitingForCurrentSegment: true });
    }
    // 没有在跑的 worker（例如服务重启后残留）：直接落成中断状态，等用户决定是否继续。
    await saveBatchRun({ ...run, runState: "paused", runnerOptions: { ...(run.runnerOptions || {}), cancelled: true } });
    return json(res, 200, { batchId, runState: "paused", cancelling: false, stopped: true });
  }
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const type = url.searchParams.get("type") || "";
    const requestedLocale = url.searchParams.get("locale") || "";
    const locale = requestedLocale ? assertActiveLocale(requestedLocale) : ACTIVE_LOCALES[0];
    const status = url.searchParams.get("status") || "";
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    const search = url.searchParams.get("search") || "";
    const limit = Number(url.searchParams.get("limit")) || 200;
    // 三个区块互不依赖：任一 Directus 查询超时只丢这一块，不再把整个任务中心打成 500。
    const { values, failures } = await settleReadSections([
      { key: "batches", fallback: [], load: () => type === "autoqa" || type === "background" ? Promise.resolve([]) : listBatchRuns({ locale, projectId, status, search, limit }) },
      { key: "qaTasks", fallback: [], load: () => type === "batch" || type === "background" ? Promise.resolve([]) : listQaTasks({ locale, projectId, status, search, limit }) },
      { key: "backgroundTasks", fallback: [], load: () => type === "batch" || type === "autoqa" ? Promise.resolve([]) : listBackgroundTasks({ projectId, search, limit }) }
    ]);
    if (failures.length) {
      console.warn(`[Kami] 任务中心部分数据读取失败：${failures.map((item) => `${item.key}: ${item.error?.message || item.error}`).join("; ")}`);
    }
    const batches = values.batches;
    const qaTasks = values.qaTasks;
    const backgroundTasks = values.backgroundTasks.map((task) => ({
      id: task.id,
      type: "background",
      taskType: task.type,
      title: task.title,
      // 带上项目：任务行要能判断"这条是不是当前项目的"，验收脚本也按它过滤。
      projectId: task.projectId || "",
      locale: task.locale || "",
      contentType: "general",
      domain: "general",
      // 中断收尾写的是 needs_attention（配合 progress.phase=cancelled/interrupted），
      // 这里必须原样透出：旧映射把它并进"已完成"，被中断的门禁会被当成正常结束。
      status: task.status === "in_progress"
        ? "in_progress"
        : task.status === "review"
          ? "review"
          : ["failed", "needs_attention", "abandoned"].includes(String(task.status))
            ? "needs_attention"
            : "completed",
      overallScore: null,
      totalSegments: Number(task.progress?.total) || 0,
      completedSegments: Number(task.progress?.completed) || 0,
      failedSegments: 0,
      qaPending: 0,
      progress: task.progress || null,
      payload: task.payload || null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    })).filter((item) => (!item.locale || item.locale === locale) && (!status || item.status === status));
    const knownTasks = new Map(backgroundTasks.map((task) => [task.id, task]));
    const batchTasks = await Promise.all(batches.map(async (item) => {
      try {
        return { ...item, type: "batch", workflow: await loadBatchWorkflow(item, knownTasks) };
      } catch (error) {
        console.warn(`[Kami] 批次 ${item.batchId} 的阶段进度读取失败：${error.message}`);
        return { ...item, type: "batch", workflow: null };
      }
    }));
    const merged = [...mergeBatchTaskRows(batchTasks, backgroundTasks), ...qaTasks]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, limit);
    return json(res, 200, merged);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/export")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/export".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const run = await getBatchRun(batchId);
    const projectId = String(body.projectId || "");
    if (!run || (run.projectId && run.projectId !== projectId)) {
      const error = new Error("未找到该翻译任务");
      error.statusCode = 404;
      throw error;
    }
    assertActiveLocale(run.locale);
    /**
     * 导出方式（批次页与文件列表共用这一个后台端点，任务中心因此永远看得到导出进度）：
     *   in-place         写回原文件里该在的位置（翻译界面的「写回原文件」）
     *   translation-only 只要译文
     *   bilingual        原文 + 译文（文件列表默认）
     */
    const requestedMode = ["in-place", "translation-only", "translation", "bilingual"].includes(String(body.mode || ""))
      ? String(body.mode)
      : "bilingual";
    const mode = requestedMode === "translation" ? "translation" : requestedMode;
    const modeLabel = mode === "translation" || mode === "translation-only" ? "仅译文" : mode === "in-place" ? "写回原文件" : "双语";
    const requestedFormat = String(body.format || "").trim();
    const sourceFormat = String(body.sourceFormat || run.format || "").trim();
    // 批次页可能带着用户刚编辑过的段落：传了就按它导，没传就用服务端已保存的那份。
    const segments = Array.isArray(body.segments) && body.segments.length ? body.segments : run.segments;
    let providedOriginal = typeof body.base64 === "string" ? body.base64 : "";
    if (!providedOriginal && mode !== "translation") {
      const stored = await readBatchOriginal({ dataRoot: DATA_ROOT, relativePath: run.runnerOptions?.originalFile }).catch(() => null);
      if (stored) providedOriginal = stored.toString("base64");
    }
    // 用户在界面上临时补选的原文件：顺手存档，下次导出就不用再选（与同步导出同一口径）。
    if (providedOriginal && mode !== "translation" && !run.runnerOptions?.originalFile) {
      try {
        const saved = await saveBatchOriginal({
          dataRoot: DATA_ROOT,
          batchId: run.batchId,
          filename: run.filename,
          buffer: Buffer.from(providedOriginal.replace(/^data:[^;]+;base64,/u, ""), "base64")
        });
        await saveBatchRun({ ...run, runnerOptions: { ...(run.runnerOptions || {}), originalFile: saved.relative, originalBytes: saved.bytes } });
        run.runnerOptions = { ...(run.runnerOptions || {}), originalFile: saved.relative, originalBytes: saved.bytes };
        logInfo("已把用户补选的原文件存档到批次", { batchId: run.batchId, file: saved.relative });
      } catch (error) {
        console.error(`[Kami] 补存原文件失败（批次 ${run.batchId}）：${error.message}`);
      }
    }
    const task = await createBackgroundTask({ type: "batch_export", title: `导出${modeLabel} · ${run.filename}`, locale: run.locale, projectId: run.projectId || "" });
    (async () => {
      try {
        await updateBackgroundTaskProgress(task.id, { progress: { phase: "exporting", message: "正在合并导出文件", percent: 40, completed: 0, total: 1 } });
        const exported = await exportBatchDocument({
          filename: String(body.filename || run.filename),
          locale: run.locale,
          format: requestedFormat || (mode === "translation" ? "translation" : "bilingual"),
          sourceFormat,
          mode: mode === "in-place" ? "in-place" : mode === "translation-only" ? "translation-only" : "",
          segments,
          structure: body.structure ?? run.structure ?? null,
          runnerOptions: run.runnerOptions || null,
          base64: providedOriginal || undefined
        });
        await updateBackgroundTaskProgress(task.id, { progress: { phase: "saving", message: "正在保存文件", percent: 85, completed: 0, total: 1 } });
        const directory = join(DATA_ROOT, "exports");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${task.id}${exported.extension}`), Buffer.from(exported.base64, "base64"));
        await updateBackgroundTaskProgress(task.id, {
          status: "completed",
          progress: { phase: "completed", message: "导出完成", percent: 100, completed: 1, total: 1 },
          payload: { filename: exported.filename, extension: exported.extension, mimeType: exported.mimeType, bytes: exported.bytes, mode: requestedMode, downloadUrl: `/api/export-tasks/${task.id}/download` }
        });
      } catch (error) {
        await updateBackgroundTaskProgress(task.id, {
          status: "failed",
          progress: { phase: "failed", message: error.message, percent: 100, completed: 0, total: 1 },
          payload: { error: error.message }
        });
      }
    })().catch((error) => console.error("批次导出后台任务失败", error));
    return json(res, 202, { backgroundTaskId: task.id, message: "导出已进入任务中心后台处理" });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/original")) {
    // 导出原文件：原样给回上传时那份（不解压、不改动）。
    const batchId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/original".length));
    const run = await getBatchRun(batchId);
    const projectId = String(url.searchParams.get("projectId") || "");
    if (!run || (run.projectId && run.projectId !== projectId)) {
      const error = new Error("未找到该翻译任务");
      error.statusCode = 404;
      throw error;
    }
    const buffer = await readBatchOriginal({ dataRoot: DATA_ROOT, relativePath: run.runnerOptions?.originalFile });
    if (!buffer) {
      const error = new Error("这条批次没有留存原文件（早期导入或上传时存档失败）；可以重新上传该文件后再试");
      error.statusCode = 404;
      throw error;
    }
    const extension = extname(run.filename || "").toLowerCase();
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": buffer.length,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(run.filename || `original${extension}`)}`
    });
    res.end(buffer);
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/export-tasks/") && url.pathname.endsWith("/download")) {
    const id = decodeURIComponent(url.pathname.slice("/api/export-tasks/".length, -"/download".length));
    const task = await getBackgroundTask(id);
    if (!task || task.type !== "batch_export" || task.payload?.downloadUrl !== `/api/export-tasks/${id}/download`) {
      const error = new Error("导出任务不存在或尚未完成");
      error.statusCode = 404;
      throw error;
    }
    try {
      const extension = task.payload.extension || extname(task.payload.filename || "").toLowerCase() || ".xlsx";
      const body = await readFile(join(DATA_ROOT, "exports", `${id}${extension}`)).catch((error) => {
        // 旧版导出结果未返回 extension，文件曾保存为 `${id}undefined`；原样兼容读取。
        if (error.code !== "ENOENT") throw error;
        return readFile(join(DATA_ROOT, "exports", `${id}undefined`));
      });
      res.writeHead(200, {
        "content-type": task.payload.mimeType || "application/octet-stream",
        "content-length": body.length,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(task.payload.filename || `${id}.xlsx`)}`
      });
      res.end(body);
      return true;
    } catch {
      const error = new Error("导出文件已丢失，请重新导出");
      error.statusCode = 404;
      throw error;
    }
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/background-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/background-tasks/".length));
    const deleted = await deleteBackgroundTask(id);
    if (!deleted) {
      const error = new Error("后台任务不存在");
      error.statusCode = 404;
      throw error;
    }
    // 还在本进程里跑的任务（例如门禁）行删了、循环还在收尾：这时放开 hold 会让
    // "最后一个页面已关闭"的收尾判定立刻成立，工作台会在执行中途自己停掉。
    // 让执行方在 finally 里自己释放。
    if (!runningBackgroundTasks.has(id)) workbenchSessionMonitor?.release(backgroundTaskHoldId(id));
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && /^\/api\/background-tasks\/[^/]+\/cancel$/u.test(url.pathname)) {
    // 中断：正在本进程里跑的任务置标记，跑批循环在下一个分块边界停下；
    // 只是"重启后残留的进行中"任务则直接在这里收尾，避免一直显示进行中。
    const id = decodeURIComponent(url.pathname.slice("/api/background-tasks/".length, -"/cancel".length));
    const task = await getBackgroundTask(id);
    if (!task) return json(res, 404, { error: "后台任务不存在" });
    const control = runningBackgroundTasks.get(id);
    if (control) {
      control.cancelRequested = true;
      return json(res, 202, { id, cancelling: true, resumeAfterCancel: true });
    }
    if (!["in_progress", "review"].includes(task.status)) {
      return json(res, 200, { id, cancelling: false, alreadyStopped: true, status: task.status });
    }
    await updateBackgroundTaskProgress(id, {
      status: "needs_attention",
      progress: { ...(task.progress || {}), phase: "cancelled", message: "已中断（任务不在运行，可继续导入补齐）" },
      payload: { ...(task.payload || {}), resumable: Boolean(task.payload?.batchId || task.payload?.resumable) }
    });
    return json(res, 200, { id, cancelling: false, stopped: true });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/background-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/background-tasks/".length));
    const task = await getBackgroundTask(id);
    if (!task) return json(res, 404, { error: "后台任务不存在" });
    return json(res, 200, { ...task, taskType: task.type });
  }
  if (req.method === "POST" && /^\/api\/batch\/run\/[^/]+\/retry-qa$/u.test(url.pathname)) {
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const body = await readJsonBody(req);
    const run = await getBatchRun(batchId);
    if (!run || !body.projectId || run.projectId !== String(body.projectId)) return json(res, 404, { error: "未找到当前项目的批次任务" });
    const existing = batchQaWorkers.get(batchId);
    if (existing) return json(res, 202, { batchId, backgroundTaskId: existing.taskId, alreadyRunning: true });
    if (batchQaStarts.has(batchId)) {
      const task = await batchQaStarts.get(batchId);
      return json(res, 202, { batchId, backgroundTaskId: task.id, alreadyRunning: true });
    }
    if (["queued", "running"].includes(run.runState)) return json(res, 409, { error: "本轮翻译仍在进行，请等翻译结束后仅重试未完成的 AIQA" });
    const segmentIds = Array.isArray(body.segmentIds) ? body.segmentIds.map(String) : null;
    const count = run.segments.filter((segment) => isIncompleteBatchQa(segment) && (!segmentIds || segmentIds.includes(String(segment.id)))).length;
    if (!count) return json(res, 200, { batchId, total: 0, message: "没有未完成的 AIQA" });
    const worker = batchWorkers.get(batchId);
    const waiting = Boolean(worker && (!worker.translationComplete || worker.followupActive)) || consistencyCheckTasks.has(batchId) || termSurveyTasks.has(batchId);
    const starting = (async () => {
      const task = await createBackgroundTask({ type: "batch_qa_retry", title: `重试 AIQA · ${run.filename}`, locale: run.locale, projectId: run.projectId,
        progress: { phase: "queued", message: waiting ? "已排队：等待当前报告 / 普查结束后仅重试未完成的 AIQA" : `准备重试 ${count} 段未完成的 AIQA`, percent: 0, completed: 0, total: count }, payload: { batchId } });
      await attachBatchWorkflowTask(batchId, "aiQa", task.id);
      startBatchQaRetry(batchId, task.id, segmentIds);
      return task;
    })();
    batchQaStarts.set(batchId, starting);
    try {
      const task = await starting;
      return json(res, 202, { batchId, backgroundTaskId: task.id, total: count, waiting });
    } finally { if (batchQaStarts.get(batchId) === starting) batchQaStarts.delete(batchId); }
  }
  if (req.method === "GET" && /^\/api\/batch\/run\/[^/]+\/status$/u.test(url.pathname)) {
    const batchId = decodeURIComponent(url.pathname.split("/")[4]);
    const run = await getBatchRun(batchId);
    const projectId = String(url.searchParams.get("projectId") || "");
    if (!run || (projectId && run.projectId !== projectId)) return json(res, 404, { error: "未找到当前项目的批次任务" });
    return json(res, 200, { batchId, runState: run.runState, workflow: await loadBatchWorkflow(run),
      qualityReportAt: run.qualityReport?.report?.generatedAt || "", termSurveyAt: run.runnerOptions?.termSurvey?.generatedAt || "",
      qaCompletedAt: run.runnerOptions?.qaCompletedAt || "" });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/batch/run/") && url.pathname.endsWith("/working-terms")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/batch/run/".length, -"/working-terms".length));
    const body = await readJsonBody(req);
    const run = await getBatchRun(batchId);
    if (!run) {
      const error = new Error("未找到这个批次");
      error.statusCode = 404;
      throw error;
    }
    const projectId = String(body.projectId || "");
    if (projectId && run.projectId !== projectId) return json(res, 404, { error: "未找到当前项目的批次任务" });
    const assets = (await getProjectAssets(run.locale, run.projectId)).assets;
    const glossary = run.runnerOptions?.workingGlossary
      || { version: 1, batchId: run.batchId, filename: run.filename, locale: run.locale, revision: 0, terms: [], conflicts: [] };
    const terms = Array.isArray(glossary.terms) ? [...glossary.terms] : [];
    const action = String(body.action || "upsert");
    const source = String(body.source || "").trim();
    const key = normalizeSource(source);
    if (action === "delete") {
      const next = terms.filter((term) => normalizeSource(term.source) !== key);
      const updated = { ...glossary, terms: next, revision: (Number(glossary.revision) || 0) + 1 };
      await saveBatchRun({ ...run, runnerOptions: { ...run.runnerOptions, workingGlossary: updated } });
      return json(res, 200, updated);
    }
    const normalized = normalizeWorkingTerms([{ ...body, source, target: body.target, origin: "manual", status: "active" }], {
      formalTerms: assets.terms || []
    })[0];
    if (!normalized) return json(res, 400, { error: "术语为空、超过长度限制，或主术语库已有同源词" });
    const index = terms.findIndex((term) => normalizeSource(term.source) === key);
    if (index >= 0) terms[index] = { ...terms[index], ...normalized, id: terms[index].id || normalized.id, updatedAt: new Date().toISOString() };
    else terms.push(normalized);
    const updated = { ...glossary, terms, revision: (Number(glossary.revision) || 0) + 1 };
    await saveBatchRun({ ...run, runnerOptions: { ...run.runnerOptions, workingGlossary: updated } });
    workingGlossaryOverrides.set(run.batchId, updated);
    return json(res, 200, updated);
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/batch/run/")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/batch/run/".length));
    const run = await getBatchRun(batchId);
    if (!run) {
      const error = new Error("未找到该批次的保存进度");
      error.statusCode = 404;
      throw error;
    }
    const projectId = String(url.searchParams.get("projectId") || "");
    if (projectId && run.projectId !== projectId) return json(res, 404, { error: "未找到当前项目的批次任务" });
    assertActiveLocale(run.locale);
    const [assets, qaRuns] = await Promise.all([
      getProjectAssets(run.locale, run.projectId).then((result) => result.assets),
      getQaRuns(run.locale, { projectId: run.projectId, contentType: run.contentType, domain: run.domain, batchId: run.batchId, limit: 500 })
    ]);
    const latestRunBySource = new Map();
    for (const qaRun of qaRuns) if (!latestRunBySource.has(qaRun.source)) latestRunBySource.set(qaRun.source, qaRun);
    const segments = run.segments.map((segment) => {
      const qaRun = latestRunBySource.get(segment.source);
      if (!qaRun) return segment;
      const savedQa = segment.result?.aiQa;
      // 同原文可出现多次；独立 QA 记录只能补详情，不能覆盖该句段已保存的执行结论。
      if (savedQa && (qaRun.finalTranslation !== segment.translation
        || qaRun.score !== (segment.result.qaScore ?? savedQa.score ?? null)
        || qaRun.status !== savedQa.status || qaRun.fallbackReason !== (savedQa.fallbackReason || ""))) return segment;
      const references = (qaRun.references || []).filter((item) => item.kind !== "qa_case");
      const qaCases = (qaRun.references || []).filter((item) => item.kind === "qa_case");
      // 复用翻译时保存的 matches：几千条术语时重算一段要数秒，轮询会占满事件循环。
      const matches = resolveSegmentMatches(segment, assets, { contentType: run.contentType, domain: run.domain, ...deliveryContext(run, segment.source) });
      return {
        ...segment,
        translation: segment.translation || qaRun.finalTranslation,
        status: segment.status === "pending" ? "done" : segment.status,
        result: {
          ...(segment.result || {}),
          translation: segment.translation || qaRun.finalTranslation,
          matches,
          issues: qaRun.issues || [],
          qaScore: qaRun.score,
          aiQa: { ...(segment.result?.aiQa || {}), score: qaRun.score, status: qaRun.status, iterations: qaRun.iterations, used: qaRun.score != null, fallbackReason: qaRun.fallbackReason, references, qaCases, termDecisions: qaRun.termDecisions || [], humanDecisions: qaRun.humanDecisions || [] }
        }
      };
    });
    // requiresBrief 由服务端算：前端只负责"没就绪就把开始按钮置灰"，不再自己记阈值。
    return json(res, 200, {
      ...run,
      segments,
      // 术语普查界面数据：模型建议 / 机器稿实际用法 / 人工终稿 / 术语库登记 / 回填处理结果。
      workflow: await loadBatchWorkflow({ ...run, segments }),
      termSurvey: buildTermSurveyView({
        survey: run.runnerOptions?.termSurvey || null,
        segments,
        termAssets: assets.terms || []
      }),
      requiresBrief: segments.length >= CONTEXT_BRIEF_MIN_SEGMENTS,
      contextBriefPending: contextAnalysisTasks.has(run.batchId)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/style-guides/import") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale || "zh-CN");
    const projectId = String(body.projectId || "").trim();
    if (projectId && !(await getProject(projectId))) return json(res, 404, { error: "项目不存在" });
    const guide = await extractStyleGuideFile({ filename: body.filename, base64: body.base64 });
    // 人工上传的风格指南是用户自己定的规则，导入即生效：存成 active 才有意义
    // （draft 只会躺在"待批准"里，getUserProfile 不返回它，翻译根本用不到）。
    const profile = await saveUserProfile({
      locale,
      name: `风格指南 · ${guide.name}`,
      instruction: guide.text,
      examples: [],
      evidenceCount: 0,
      status: "active",
      generatedBy: "style-guide-import",
      projectId
    });
    return json(res, 201, { profile, filename: guide.filename, characters: guide.characters });
  }
  if (req.method === "POST" && url.pathname === "/api/batch/export/preflight") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale || "zh-CN");
    const project = body.projectId ? await getProject(String(body.projectId)) : null;
    const projectSettings = project?.settings || null;
    const assets = (await getProjectAssets(locale, body.projectId || "")).assets;
    const segments = Array.isArray(body.segments) ? body.segments.filter((segment) => segment?.selected !== false) : [];
    // 参考译例只算一次：原来每段都对整库（本项目 8000+ 条）跑一次排序，67 段就要几分钟，
    // 用户点"导出"后只看到按钮变灰、最后什么都等不到。文档级参考足够驱动导出前的规则检查。
    const documentText = segments.map((segment) => segment?.source || "").join("\n").slice(0, 8_000);
    const memoryLibraries = body.projectId ? await getResourceLibraries(String(body.projectId), { kind: "translation_memory" }) : [];
    const enabledMaster = memoryLibraries.find((library) => library.enabled && library.role === "master");
    // 只取主 TM 的候选，粗筛的候选池也按同一个库收窄。
    const memories = enabledMaster
      ? await getMemoryCandidates(locale, {
        projectId: body.projectId || "",
        source: documentText,
        limit: getSettings().retrieval.candidatePoolSize,
        libraryIds: [enabledMaster.id]
      })
      : [];
    const masterMemories = enabledMaster
      ? memories.filter((memory) => memory.libraryId === enabledMaster.id).map((memory) => ({ ...memory, libraryRole: "master", libraryName: enabledMaster.name, libraryPriority: enabledMaster.priority }))
      : [];
    const translationReferences = documentText
      ? rankTranslationMemories(documentText, masterMemories, {
        limit: 20,
        locale,
        contentType: body.contentType || "general",
        domain: body.domain || "general",
        projectId: body.projectId || "",
        catMinFuzzy: projectSettings?.tm?.catMinFuzzy || 60,
        llmMinRelevance: projectSettings?.tm?.llmMinRelevance || 60
      })
      : [];
    const issues = segments.flatMap((segment, index) => {
      // 导出预检与批次详情同一个坑：逐段重算术语匹配，几千条术语时整页会卡几十秒。
      const matches = resolveSegmentMatches(segment, assets, { contentType: body.contentType || "general", domain: body.domain || "general", ...deliveryContext(body, segment.source || "") });
      return runQa({ source: segment.source || "", translation: segment.translation || "", matches, translationReferences, locale, contentType: body.contentType || "general", projectSettings }).map((issue) => ({ ...issue, segmentId: segment.id || `seg-${index + 1}`, segmentIndex: index + 1 }));
    });
    const blocking = issues.filter((issue) => ["error", "critical"].includes(issue.severity));
    return json(res, 200, { ok: blocking.length === 0, blocking, warnings: issues.filter((issue) => !["error", "critical"].includes(issue.severity)), total: issues.length });
  }
  if (req.method === "POST" && url.pathname === "/api/batch/export") {
    const body = await readJsonBody(req);
    // 写回原文件时优先用批次存档里的原文件：用户在导入时已经上传过，不该再问一次。
    if (body.mode !== "translation-only" && !body.base64 && body.batchId) {
      const run = await getBatchRun(String(body.batchId)).catch(() => null);
      const stored = await readBatchOriginal({ dataRoot: DATA_ROOT, relativePath: run?.runnerOptions?.originalFile });
      if (stored) {
        body.base64 = stored.toString("base64");
        body.filename = body.filename || run.filename;
      }
    }
    // 老批次（改动前导入、没有存档）用户这次补选了原文件：顺手存下来，下次就不用再选。
    if (body.mode !== "translation-only" && body.base64 && body.batchId) {
      const run = await getBatchRun(String(body.batchId)).catch(() => null);
      if (run && !run.runnerOptions?.originalFile) {
        try {
          const saved = await saveBatchOriginal({
            dataRoot: DATA_ROOT,
            batchId: run.batchId,
            filename: run.filename,
            buffer: Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/u, ""), "base64")
          });
          await saveBatchRun({ ...run, runnerOptions: { ...(run.runnerOptions || {}), originalFile: saved.relative, originalBytes: saved.bytes } });
          logInfo("已把用户补选的原文件存档到批次", { batchId: run.batchId, file: saved.relative });
        } catch (error) {
          console.error(`[Kami] 补存原文件失败（批次 ${body.batchId}）：${error.message}`);
        }
      }
    }
    return json(res, 200, await exportBatchDocument({ ...body, locale: assertActiveLocale(body.locale || "zh-CN") }));
  }
  if (req.method === "POST" && url.pathname === "/api/qa/resolve") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const source = String(body.source || "").trim();
    const translation = String(body.translation || "").trim();
    const action = String(body.action || "");
    const issueIndex = Number(body.issueIndex);
    const currentIssues = Array.isArray(body.issues) ? body.issues.slice(0, 30) : [];
    const issue = Number.isInteger(issueIndex) ? currentIssues[issueIndex] : null;
    if (!source || !translation || !issue || !["approve", "accept", "partial", "reject", "revise"].includes(action)) {
      const error = new Error("QA 决定缺少原文、译文、问题或有效操作");
      error.statusCode = 400;
      throw error;
    }
    const reviewAction = action === "approve" ? "reject" : action;
    if (reviewAction === "reject" && issue.severity === "error" && issue.mqmSeverity !== "minor") {
      const error = new Error("阻断级 QA 问题不能直接批准，请先让 AI 修订或人工编辑译文");
      error.statusCode = 409;
      throw error;
    }

    const contentType = body.contentType || "general";
    const domain = concreteDomain(body.domain, { text: source, contentType });
    const project = String(body.projectId || body.project || "default");
    const batchId = body.batchId || "manual-review";
    let linkedTrajectory = null;
    if (body.trajectoryId) {
      linkedTrajectory = assertTrajectoryBinding(
        await getLearningTrajectory(String(body.trajectoryId)),
        { locale, source, contentType, domain, project, batchId: body.batchId || "" }
      );
    }
    const assets = (await getProjectAssets(locale, body.projectId || "")).assets;
    const matches = matchTerms(source, assets, { contentType, domain, ...deliveryContext(body, source) });
    const classification = await classify({ text: source, hint: contentType, useModel: false });
    const styleProfile = await getProjectStyleProfile(locale, { projectId: project });
    const translationSkill = await ensureChampionTranslationSkill(learningScope({ locale, contentType, domain, project }));
    const qaGuidance = rankQaCases(source, await getQaCases(locale, { projectId: project, contentType, domain, limit: -1 }), { limit: 3, queryEmbedding: await embedSource(source) });
    const contextPack = buildContextPack({
      titleOverrides: getSettings().orthography.titleBrackets, source, locale, classification, matches, domain, styleProfile, translationSkill, qaGuidance });
    const priorDecisions = Array.isArray(body.humanDecisions) ? body.humanDecisions.slice(0, 30) : [];
    const decidedAt = new Date().toISOString();
    let decision = normalizeReviewDecision({
      id: randomUUID(),
      issueId: String(issue.id || `${batchId}:${issueIndex}:${issue.type || issue.category || "qa"}`),
      segmentId: body.segmentId || "",
      field: body.field || "translation",
      category: issue.category || issue.type || "other",
      severity: issue.mqmSeverity || issue.severity || "warning",
      issue: issue.message || "QA 意见",
      suggestion: issue.suggestion || "",
      action: reviewAction,
      reason: String(body.reason || (action === "approve" ? "人工确认当前译文可接受，因此拒绝该条建议" : "")),
      acceptedParts: Array.isArray(body.acceptedParts) ? body.acceptedParts : [],
      rejectedParts: Array.isArray(body.rejectedParts) ? body.rejectedParts : [],
      revisionInstruction: String(body.revisionInstruction || (["accept", "partial", "revise"].includes(reviewAction) ? issue.suggestion || issue.message || "按该条 QA 意见修订" : "")),
      beforeTranslation: translation,
      decidedBy: String(body.reviewer || "当前用户"),
      decidedAt
    });
    const humanDecisions = [...priorDecisions, decision];

    if (["accept", "partial", "revise"].includes(reviewAction)) {
      const revisedTranslation = await reviseTranslationWithQa({
        contextPack, translation, issues: [{
          ...issue,
          message: reviewAction === "partial"
            ? `仅修订人工接受的部分：${decision.acceptedParts.join("；")}。不得采纳这些部分：${decision.rejectedParts.join("；")}。${decision.revisionInstruction}`
            : decision.revisionInstruction
        }],
        references: Array.isArray(body.references) ? body.references : [], qaCases: qaGuidance
      });
      decision = normalizeReviewDecision({ ...decision, afterTranslation: revisedTranslation });
      humanDecisions[humanDecisions.length - 1] = decision;
      const aiQa = await runAiQaLoop({
        contextPack, initialTranslation: revisedTranslation, matches, locale, contentType, domain, batchId, humanDecisions, projectId: body.projectId || ""
      });
      const receipt = buildReviewReceipt({
        id: randomUUID(), taskId: body.trajectoryId || batchId, taskName: body.taskName || "翻译 QA",
        batchId, locale, processedBy: decision.decidedBy || "当前用户", processedAt: decidedAt, decisions: [decision]
      });
      if (linkedTrajectory) {
        await updateLearningTrajectory(linkedTrajectory.id, {
          finalTranslation: aiQa.translation,
          qaAfter: { ...trajectoryMetricsFromIssues(aiQa.issues, aiQa.score, matches), issues: aiQa.issues, iterations: aiQa.iterations },
          humanDecision: { accepted: reviewAction === "accept", action: reviewAction, decisions: humanDecisions, receipt, decidedAt },
          status: aiQa.status === "passed" ? "completed" : "review",
          events: [...(Array.isArray(linkedTrajectory.events) ? linkedTrajectory.events : []), { type: `human_${reviewAction}`, at: decidedAt, receiptId: receipt.id }]
        });
      }
      return json(res, 200, { matches, translation: aiQa.translation, issues: aiQa.issues, qaScore: aiQa.score, aiQa, reviewReceipt: receipt, styleProfile: contextPack.styleProfile, trajectoryId: body.trajectoryId || "" });
    }

    const remainingIssues = currentIssues.filter((_, index) => index !== issueIndex);
    const score = remainingIssues.length ? (Number.isFinite(Number(body.qaScore)) ? Number(body.qaScore) : 90) : 100;
    const status = remainingIssues.some((item) => item.severity === "error") || score < 90 ? "review" : "passed";
    const provider = getProviderConfig();
    const references = Array.isArray(body.references) ? body.references.slice(0, 12) : [];
    const termDecisions = Array.isArray(body.termDecisions) ? body.termDecisions.slice(0, 20) : [];
    await saveQaRun({
      projectId: project, locale, contentType, domain, source, initialTranslation: translation, finalTranslation: translation,
      score, status, iterations: Number(body.iterations) || 0, issues: remainingIssues, references,
      styleProfileId: contextPack.styleProfile?.id || "", model: provider.model, batchId,
      fallbackReason: "", termDecisions, humanDecisions
    });
    if (linkedTrajectory) {
      await updateLearningTrajectory(linkedTrajectory.id, {
        finalTranslation: translation,
        qaAfter: { ...trajectoryMetricsFromIssues(remainingIssues, score, matches), issues: remainingIssues, iterations: Number(body.iterations) || 0 },
        humanDecision: { accepted: false, action: "qa_issue_rejected", decisions: humanDecisions, decidedAt },
        status: status === "passed" ? "completed" : "review",
        events: [...(Array.isArray(linkedTrajectory.events) ? linkedTrajectory.events : []), { type: "qa_issue_rejected", at: decidedAt }]
      });
      triggerAutoProposal({ locale, contentType, domain, project });
    }
    const receipt = buildReviewReceipt({
      id: randomUUID(), taskId: body.trajectoryId || batchId, taskName: body.taskName || "翻译 QA",
      batchId, locale, processedBy: decision.decidedBy || "当前用户", processedAt: decidedAt, decisions: [decision]
    });
    return json(res, 200, {
      matches, translation, issues: remainingIssues, qaScore: score,
      aiQa: {
        score, status, iterations: Number(body.iterations) || 0, used: true, fallbackReason: "",
        references: references.filter((item) => item.kind !== "qa_case"),
        qaCases: references.filter((item) => item.kind === "qa_case"), termDecisions, humanDecisions
      },
      styleProfile: contextPack.styleProfile,
      reviewReceipt: receipt,
      trajectoryId: body.trajectoryId || ""
    });
  }
  if (req.method === "POST" && url.pathname === "/api/qa") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const projectRecord = body.projectId ? await getProject(String(body.projectId)) : null;
    const projectSettings = projectRecord?.settings || null;
    const assets = (await getProjectAssets(locale, body.projectId || "")).assets;
    const workingTerms = normalizeWorkingTerms(body.workingTerms, { formalTerms: assets.terms || [] });
    const scopedAssets = mergeWorkingAssets(assets, { batchId: body.batchId || "", terms: workingTerms }, { batchId: body.batchId || "" });
    const contentType = body.contentType || "general";
    const domain = concreteDomain(body.domain, { text: body.source || "", contentType });
    const matches = matchTerms(body.source || "", scopedAssets, { contentType, domain, ...deliveryContext(body, body.source || "") });
    if (body.aiQa !== true) return json(res, 200, { matches, issues: runQa({ source: body.source || "", translation: body.translation || "", matches, locale, titleOverrides: getSettings().orthography.titleBrackets, contentType, projectSettings }) });
    const classification = await classify({ text: body.source || "", hint: contentType, useModel: false });
    const projectId = String(body.projectId || body.project || "default");
    const styleProfile = await getProjectStyleProfile(locale, { projectId });
    const translationSkill = await ensureChampionTranslationSkill(learningScope({ locale, contentType, domain, project: projectId }));
    const qaGuidance = rankQaCases(body.source || "", await getQaCases(locale, { projectId, contentType, domain, limit: -1, scopeFallback: true }), { limit: 3, queryEmbedding: await embedSource(body.source || ""), contentType, domain });
    const contextPack = buildContextPack({
      titleOverrides: getSettings().orthography.titleBrackets, source: body.source || "", locale, classification, matches, domain, styleProfile, translationSkill, qaGuidance });
    const aiQa = await runAiQaLoop({ contextPack, initialTranslation: body.translation || "", matches, locale, contentType, domain, batchId: body.batchId || "manual-recheck", projectSettings, projectId: body.projectId || "" });
    return json(res, 200, { matches, translation: aiQa.translation, issues: aiQa.issues, qaScore: aiQa.score, aiQa, styleProfile: contextPack.styleProfile });
  }
/**
 * 质检一组已经按句段对齐好的双语条目（文件原生句段，或批次里已存的段落）。
 *
 * 规则层永远跑（免费、秒级）；只有 deepCheck 打开时才追加语法专项与三层模型检查，
 * 因为那是逐条调模型，几千条会很贵。
 */
async function evaluateQaPairList({ pairs, assets, locale, contentType, domain, projectSettings, styleProfile, references, machineDrafts, qaCases, evidence, deepCheck = false }) {
  const tasks = pairs.map((pair, index) => async () => {
    const source = String(pair.source || "");
    const translation = String(pair.target || pair.translation || "");
    const matches = matchTerms(source, assets, { contentType, domain, ...deliveryContext({}, source) });
    let issues = runBasicQa({ source, translation, matches, locale, titleOverrides: getSettings().orthography.titleBrackets, contentType, projectSettings });
    if (deepCheck) {
      const [grammarResult, aiResult] = await Promise.allSettled([
        evaluateGrammarWithModel({ translation, locale, contentType }),
        evaluateAutoQaWithModel({ source, translation, locale, contentType, domain, styleProfile, references, machineDrafts, qaCases, evidence })
      ]);
      const extra = [];
      if (grammarResult.status === "fulfilled") extra.push(...grammarResult.value);
      if (aiResult.status === "fulfilled") extra.push(...aiResult.value);
      issues = dedupeIssues([...issues, ...extra]);
    }
    return {
      index: index + 1,
      source,
      translation,
      entryId: pair.entryId || "",
      entryKey: pair.entryKey || "",
      sourceRow: pair.sourceRow || null,
      sheet: pair.sheet || "",
      issues,
      qaScore: calculateAutoQaScores(issues, { segmentCount: 1 }).overall
    };
  });
  const settled = await runTaskPool(tasks, (task) => task(), { concurrency: deepCheck ? 2 : 8 });
  const failed = settled.filter((result) => result.status === "rejected").map((result) => String(result.reason?.message || result.reason));
  const evaluated = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const allIssues = evaluated.flatMap((segment) => segment.issues.map((issue) => ({ ...issue, segmentIndex: segment.index })));
  return {
    segments: evaluated,
    scores: calculateAutoQaScores(allIssues, { segmentCount: evaluated.length }),
    summary: summarizeIssues(allIssues),
    issues: allIssues,
    failureReasons: failed
  };
}

/** 质检：上传的双语文件按它自己的句段检查（表格一行一条、XLIFF 一个 trans-unit 一条），不切句不对齐。 */
async function evaluateQaFile(body = {}) {
  const locale = assertActiveLocale(body.locale || "zh-CN");
  const filename = String(body.filename || "").trim();
  const base64 = String(body.base64 || "").replace(/^data:[^;]+;base64,/u, "");
  if (!filename || !base64) throw Object.assign(new Error("请选择要质检的双语文件"), { statusCode: 400 });
  if (!/\.(xlsx|csv|xliff|mqxliff)$/iu.test(filename)) throw Object.assign(new Error("质检只支持 xlsx、csv、xliff、mqxliff"), { statusCode: 400 });
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw Object.assign(new Error("文件内容为空"), { statusCode: 400 });
  if (buffer.length > IMPORT_FILE_BYTES) throw Object.assign(new Error(`文件超过 ${Math.round(IMPORT_FILE_BYTES / (1024 * 1024))}MB 上限`), { statusCode: 400 });
  const pairs = /\.(xlsx|csv)$/iu.test(filename)
    ? (await extractTermPairs({ filename, base64, locale })).candidates.map((candidate) => ({
      source: candidate.source, target: candidate.target, entryId: candidate.entryId || "",
      sourceRow: candidate.rowNumber || null, sheet: candidate.sheet || ""
    }))
    : extractXliffPairs(buffer, filename);
  if (!pairs.length) throw Object.assign(new Error("文件里没有可质检的双语条目（原文与译文都要非空）"), { statusCode: 400 });
  const projectId = String(body.projectId || "");
  const project = projectId ? await getProject(projectId) : null;
  const projectSettings = project?.settings || null;
  const assets = (await getProjectAssets(locale, projectId)).assets;
  const contentType = body.contentType && body.contentType !== "auto" ? body.contentType : "general";
  const domain = concreteDomain(body.domain, { contentType });
  const styleProfile = await getProjectStyleProfile(locale, { projectId });
  const evidence = positiveEvidenceOnly(await sampleStyleEvidence(locale, { projectId, contentType, domain, limit: 12, positiveOnly: true })).slice(0, 6);
  const evaluated = await evaluateQaPairList({
    pairs, assets, locale, contentType, domain, projectSettings, styleProfile,
    references: [], machineDrafts: [], qaCases: [], evidence,
    deepCheck: body.deepCheck === true
  });
  logInfo("文件质检完成", { filename, segments: evaluated.segments.length, deepCheck: body.deepCheck === true, issues: evaluated.issues.length });
  const result = {
    sourceKind: "file",
    filename,
    projectId,
    locale,
    contentType,
    domain,
    segmentCount: evaluated.segments.length,
    segments: evaluated.segments,
    scores: evaluated.scores,
    summary: evaluated.summary,
    alignmentNote: `按文件原生句段检查（${evaluated.segments.length} 条），未做切句与对齐。`,
    deepCheck: body.deepCheck === true,
    fallbackReason: evaluated.failureReasons.join("；")
  };
  // 存进任务中心：这样文件质检也能回放（不重新调模型）与删除。
  try {
    const task = await saveQaTask({
      projectId,
      locale,
      contentType,
      domain,
      title: `${filename} 质检`,
      sourceText: pairs.map((pair) => pair.source).join("\n").slice(0, 20_000),
      translationText: pairs.map((pair) => pair.target).join("\n").slice(0, 20_000),
      segmentCounts: { source: pairs.length, translation: pairs.length },
      overallScore: result.scores.overall,
      dimensionScores: result.scores.dimensions,
      summary: result.summary,
      alignmentNote: result.alignmentNote,
      model: getProviderConfig().model,
      report: result
    });
    result.qaTaskId = task.id;
  } catch (error) {
    console.error(`[Kami] 质检报告入库失败：${error.message}`);
  }
  return result;
}

/** 质检：直接回放某条批次里翻译时已经算好的逐段结果（不重复调模型）。 */
async function evaluateQaBatch(batchId, projectId = "") {
  const run = await getBatchRun(batchId);
  if (!run) throw Object.assign(new Error("未找到这条翻译批次"), { statusCode: 404 });
  if (projectId && run.projectId && run.projectId !== String(projectId)) throw Object.assign(new Error("这条批次不属于当前项目"), { statusCode: 404 });
  const selected = (run.segments || []).filter((segment) => segment.selected !== false);
  const segments = selected.map((segment, index) => {
    const result = segment.result || {};
    return {
      index: index + 1,
      source: segment.source || "",
      translation: segment.translation || "",
      entryId: segment.locator?.unitId || segment.locator?.entryId || "",
      entryKey: segment.entryKey || segment.locator?.entryKey || "",
      sourceRow: segment.locator?.row || null,
      sheet: segment.locator?.sheet || "",
      status: segment.status || "pending",
      accepted: segment.accepted === true,
      qaScore: Number.isFinite(result.qaScore) ? result.qaScore : null,
      aiQaStatus: result.aiQa?.status || "",
      aiQaFallbackReason: result.aiQa?.fallbackReason || "",
      issues: Array.isArray(result.issues) ? result.issues : []
    };
  });
  const allIssues = segments.flatMap((segment) => segment.issues.map((issue) => ({ ...issue, segmentIndex: segment.index })));
  return {
    sourceKind: "batch",
    batchId: run.batchId,
    filename: run.filename,
    runState: run.runState || "ready",
    segmentCount: segments.length,
    segments,
    scores: calculateAutoQaScores(allIssues, { segmentCount: Math.max(1, segments.length) }),
    summary: summarizeIssues(allIssues),
    alignmentNote: `直接回放这条批次翻译时的逐段检查结果（${segments.length} 段），没有重新调用模型。`
  };
}

  if (req.method === "POST" && url.pathname === "/api/qa/file") {
    return json(res, 200, await evaluateQaFile(await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES })));
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/qa/batch/")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/qa/batch/".length));
    return json(res, 200, await evaluateQaBatch(batchId, url.searchParams.get("projectId") || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/auto-qa") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    const source = String(body.source || "").trim();
    const translation = String(body.translation || "").trim();
    if (!source || !translation) {
      const error = new Error("请同时提供日语原文与简体中文译文");
      error.statusCode = 400;
      throw error;
    }
    const contentType = body.contentType || "general";
    // 网页粘贴常带 HTML 标签：剥离后参与分析，但必须保留换行作为多段文本边界。
    const stripTags = normalizeQaInputText;
    const tagsStripped = /<[^>]*>/u.test(source) || /<[^>]*>/u.test(translation);
    const cleanSource = stripTags(source);
    const cleanTranslation = stripTags(translation);
    if (!cleanSource || !cleanTranslation) {
      const error = new Error("剥离 HTML 标签后没有可用文本");
      error.statusCode = 400;
      throw error;
    }
    const projectRecord = body.projectId ? await getProject(String(body.projectId)) : null;
    const projectSettings = projectRecord?.settings || null;
    const assets = (await getProjectAssets(locale, body.projectId || "")).assets;
    const classification = await classify({ text: cleanSource, hint: contentType, useModel: false });
    const scopeContentType = classification.contentType || "general";
    const settings = getSettings();
    const qaTuning = {
      penalties: { critical: settings.quality.penaltyCritical, major: settings.quality.penaltyMajor, minor: settings.quality.penaltyMinor },
      weights: { basic: settings.quality.weightBasic, fidelity: settings.quality.weightFidelity, nuance: settings.quality.weightNuance }
    };
    const domainResolution = resolveDomain(cleanSource, body.domain, { contentType: scopeContentType });
    const domain = domainResolution.domain;
    // 术语匹配放在识别之后，用真正生效的语体与领域加权，而不是界面提交的原始值。
    const matches = matchTerms(cleanSource, assets, { contentType: scopeContentType, domain, ...deliveryContext(body, cleanSource) });
    const projectId = String(body.projectId || "");
    const styleProfile = await getProjectStyleProfile(locale, { projectId });
    const queryEmbedding = await embedSource(cleanSource);
    // 粗筛候选再精排：语体/领域只影响排序加成，粗筛也不按它们过滤。
    const narrowedMemories = narrowByDomain(await getMemoryCandidates(locale, {
      projectId,
      source: cleanSource,
      limit: getSettings().retrieval.candidatePoolSize,
      scopeFallback: true,
      contentType: scopeContentType,
      domain
    }), domain);
    const narrowedQaCases = narrowByDomain(await getQaCases(locale, { projectId, contentType: scopeContentType, domain, limit: -1, scopeFallback: true }), domain);
    domainResolution.relaxedRetrieval = narrowedMemories.relaxed || narrowedQaCases.relaxed;
    const references = rankTranslationMemories(cleanSource, narrowedMemories.items, { limit: 5, queryEmbedding, contentTags: classification.contentTags || [], locale, contentType: scopeContentType, domain, projectId, campaign: String(body.campaign || ""), ...deliveryContext(body, cleanSource) });
    const qaCases = rankQaCases(cleanSource, narrowedQaCases.items, { limit: 3, queryEmbedding, contentType: scopeContentType, domain });
    const evidence = positiveEvidenceOnly(await sampleStyleEvidence(locale, { projectId, contentType: scopeContentType, domain, limit: 12, positiveOnly: true })).slice(0, 6);
    // 只有人工批准的译例能充当"标准"；机器译文另开一档，仅供一致性参考。
    const { approved: approvedReferences, machineDrafts } = splitReferenceAuthority(references);
    const sourceSegments = splitQaSegments(cleanSource);
    const translationSegments = splitQaSegments(cleanTranslation);

    // 逐句对齐三级降级：语义向量 DP 对齐（支持 1:N / N:1 合并）→ 模型逐句对齐 → 按位置近似配对。
    // 本地词面向量跨语言无意义，绝不能拿来做中↔外对齐。
    let alignmentNote = "";
    let pairPlan = null;
    let alignmentMethod = "position";
    if (isEmbeddingConfigured() && (sourceSegments.length + translationSegments.length) <= AUTO_QA_EMBEDDING_SEGMENT_LIMIT) {
      try {
        await embed("对齐探针");
        const embedSegments = async (segments) => {
          const settledEmbeddings = await runTaskPool(segments, (segment) => embedSource(segment), { concurrency: 6 });
          return settledEmbeddings.map((result) => result.status === "fulfilled" ? result.value : null);
        };
        const [sourceEmbeddings, translationEmbeddings] = await Promise.all([
          embedSegments(sourceSegments),
          embedSegments(translationSegments)
        ]);
        if ([...sourceEmbeddings, ...translationEmbeddings].every((embedding) => embedding && !embedding.local)) {
          const scoreMatrix = sourceEmbeddings.map((sourceEmbedding) =>
            translationEmbeddings.map((translationEmbedding) => cosineSimilarity(sourceEmbedding?.vector, translationEmbedding?.vector)));
          const maxScore = Math.max(0, ...scoreMatrix.flat());
          if (maxScore >= 0.1) {
            pairPlan = alignSegmentPairs(sourceSegments.length, translationSegments.length, (i, j) => scoreMatrix[i][j]);
            alignmentMethod = "embedding";
          }
        }
      } catch {
        // Embedding 服务异常，继续降级
      }
    }
    if (!pairPlan && sourceSegments.length !== translationSegments.length && (sourceSegments.length + translationSegments.length) <= AUTO_QA_MODEL_ALIGNMENT_SEGMENT_LIMIT) {
      try {
        const plan = await alignSegmentsWithModel({ sourceSegments, translationSegments, locale });
        if (plan) {
          pairPlan = plan;
          alignmentMethod = "model";
        }
      } catch {
        // 模型对齐失败，按位置配对
      }
    }
    if (!pairPlan) {
      pairPlan = alignSegmentPairs(
        sourceSegments.length,
        translationSegments.length,
        createStructuralAlignmentScorer(sourceSegments, translationSegments)
      );
      alignmentMethod = "structural";
    }
    // 句数相同也可能存在漏句/错位（译文把后面的句子提前、或整句删掉）：非一一对应即给出对齐说明
    const identityAlignment = pairPlan.pairs.length === sourceSegments.length
      && pairPlan.unmatchedSource.length === 0
      && pairPlan.unmatchedTranslation.length === 0
      && pairPlan.pairs.every((pair, index) => pair.sourceIndices.length === 1 && pair.translationIndices.length === 1 && pair.sourceIndices[0] === index && pair.translationIndices[0] === index);
    if (!identityAlignment) {
      const counts = `原文 ${sourceSegments.length} 句 / 译文 ${translationSegments.length} 句`;
      alignmentNote = alignmentMethod === "embedding"
        ? `${counts}，已按语义向量自动对齐（可合并相邻句、标出漏译/增译）。`
        : alignmentMethod === "model"
          ? `${counts}，已由模型逐句对齐（可合并相邻句、标出漏译/增译）。`
          : `${counts}，语义对齐不可用，已按数字、专名与位置锚点近似对齐，请人工核对。`;
    }

    // 每个对齐组独立执行：语言正确性专项（拼写/语法）+ 三层检查，两路并行（并发 2 组）
    const pairTasks = pairPlan.pairs.map((pair) => async () => {
      const pairSource = pair.sourceIndices.map((index) => sourceSegments[index]).join("\n");
      const pairTranslation = pair.translationIndices.map((index) => translationSegments[index]).join("\n");
      const segmentMatches = matchTerms(pairSource, assets, { contentType: scopeContentType, domain, ...deliveryContext(body, pairSource) });
      const basicIssues = runBasicQa({ source: pairSource, translation: pairTranslation, matches: segmentMatches, locale, titleOverrides: getSettings().orthography.titleBrackets, contentType: scopeContentType, projectSettings });
      const [grammarResult, aiResult] = await Promise.allSettled([
        evaluateGrammarWithModel({ translation: pairTranslation, locale, contentType: scopeContentType }),
        evaluateAutoQaWithModel({
          source: pairSource, translation: pairTranslation, locale, contentType: scopeContentType, domain,
          styleProfile, references: approvedReferences, machineDrafts, qaCases, evidence,
          toolRunner: buildReferenceToolRunner({ projectId: String(body.projectId || "").trim() })
        })
      ]);
      const failures = [];
      let grammarIssues = [];
      if (grammarResult.status === "fulfilled") grammarIssues = grammarResult.value;
      else failures.push(`语法专项失败：${String(grammarResult.reason?.message || grammarResult.reason)}`);
      let aiIssues = [];
      if (aiResult.status === "fulfilled") aiIssues = aiResult.value;
      else failures.push(`三层检查失败：${String(aiResult.reason?.message || aiResult.reason)}`);
      const issues = dedupeIssues([...grammarIssues, ...basicIssues, ...aiIssues]);
      return {
        index: 0,
        sourceIndices: pair.sourceIndices,
        translationIndices: pair.translationIndices,
        source: pairSource,
        translation: pairTranslation,
        issues,
        scores: calculateAutoQaScores(issues, { penalties: qaTuning.penalties, weights: qaTuning.weights }),
        summary: summarizeIssues(issues),
        // 每段的扣分只能记在自己头上，文档级打分才能按段封顶后再平均。
        fallbackReason: failures.join("；")
      };
    });
    const settled = await runTaskPool(pairTasks, (task) => task(), { concurrency: 2 });
    const segments = settled
      .filter((result) => result.status === "fulfilled")
      .map((result, index) => ({ ...result.value, index: index + 1 }));
    const alignmentIssues = buildAlignmentIssues({
      sourceSegments, translationSegments,
      unmatchedSource: pairPlan.unmatchedSource,
      unmatchedTranslation: pairPlan.unmatchedTranslation
    });
    const allIssues = [
      ...segments.flatMap((segment) => segment.issues.map((issue) => ({ ...issue, segmentIndex: segment.index }))),
      ...alignmentIssues.map((issue, index) => ({ ...issue, segmentIndex: `alignment-${index}` }))
    ];
    const scores = calculateAutoQaScores(allIssues, { segmentCount: Math.max(1, segments.length), penalties: qaTuning.penalties, weights: qaTuning.weights });
    const summary = summarizeIssues(allIssues);
    const fallbackReason = segments
      .filter((segment) => segment.fallbackReason)
      .map((segment) => `第 ${segment.index} 组模型检查失败：${segment.fallbackReason}`)
      .join("；");
    const report = {
      locale, matches, tagsStripped, alignmentNote,
      segmentCounts: { source: sourceSegments.length, translation: translationSegments.length },
      segments, alignmentIssues,
      scores, summary,
      classification, domainResolution, styleProfile,
      references: references.filter((item) => item.kind !== "qa_case"),
      qaCases,
      fallbackReason
    };
    const task = await saveQaTask({
      projectId,
      locale,
      contentType: scopeContentType,
      domain,
      sourceText: cleanSource,
      translationText: cleanTranslation,
      title: cleanSource.slice(0, 40),
      segmentCounts: report.segmentCounts,
      overallScore: scores.overall,
      dimensionScores: scores.dimensions,
      summary,
      alignmentNote,
      model: getProviderConfig().model,
      report
    });
    return json(res, 200, { ...report, taskId: task.id });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/qa-tasks/") && url.pathname.endsWith("/issues/delete")) {
    if (!canDeleteQaIssues(req)) return json(res, 403, { error: "只有在本机打开的报告可以删除 AI 意见" });
    const id = decodeURIComponent(url.pathname.slice("/api/qa-tasks/".length, -"/issues/delete".length));
    const task = await getQaTask(id);
    if (!task) return json(res, 404, { error: "未找到该质检任务" });
    const body = await readJsonBody(req);
    const result = deleteQaIssue({
      report: task.report || {},
      task,
      fingerprint: String(body.fingerprint || "")
    });
    const saved = await saveQaTask({ ...task, ...result.task });
    return json(res, 200, { ok: true, scores: result.scores, summary: result.summary, deletedIssues: result.deletedIssues, taskId: saved.id });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/qa-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-tasks/".length));
    const task = await getQaTask(id);
    if (!task) {
      const error = new Error("未找到该质检任务");
      error.statusCode = 404;
      throw error;
    }
    assertActiveLocale(task.locale);
    return json(res, 200, {
      task: {
        id: task.id, title: task.title, locale: task.locale, contentType: task.contentType, domain: task.domain,
        sourceText: task.sourceText, translationText: task.translationText, segmentCounts: task.segmentCounts,
        overallScore: task.overallScore, dimensionScores: task.dimensionScores, summary: task.summary,
        alignmentNote: task.alignmentNote, model: task.model, createdAt: task.createdAt, updatedAt: task.updatedAt
      },
      report: task.report
    });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/qa-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-tasks/".length));
    const task = await getQaTask(id);
    if (!task) {
      const error = new Error("未找到该质检任务");
      error.statusCode = 404;
      throw error;
    }
    assertActiveLocale(task.locale);
    const deleted = await deleteQaTask(id);
    if (!deleted) {
      const error = new Error("未找到该质检任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/reference-folders") {
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    if (!projectId) return json(res, 400, { error: "缺少项目" });
    const folders = await referenceFoldersForProject(projectId);
    const { items: documents } = await listReferenceDocuments({ projectId, limit: 0 });
    const counts = new Map();
    for (const document of documents) {
      const id = String(document.folderId || "");
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return json(res, 200, {
      items: folders.map((folder) => ({ ...folder, documentCount: counts.get(folder.id) || 0 }))
    });
  }
  if (req.method === "POST" && url.pathname === "/api/reference-folders/ensure") {
    const body = await readJsonBody(req);
    const projectId = String(body.projectId || "").trim();
    if (!projectId) return json(res, 400, { error: "缺少项目" });
    const parentId = String(body.parentId || "").trim();
    const paths = Array.isArray(body.paths) ? body.paths : [];
    const created = [];
    for (const path of paths) {
      const result = await ensureReferenceFolderPath({ projectId, parentId, path });
      created.push({ path, folderId: result.folderId });
    }
    return json(res, 200, { items: created, folders: await referenceFoldersForProject(projectId) });
  }
  if (req.method === "POST" && url.pathname === "/api/reference-folders") {
    const body = await readJsonBody(req);
    const projectId = String(body.projectId || "").trim();
    if (!projectId) return json(res, 400, { error: "缺少项目" });
    const parentId = String(body.parentId || "").trim();
    const name = normalizeReferenceFolderName(body.name);
    await assertReferenceFolderNameAvailable({ projectId, parentId, name });
    return json(res, 201, { folder: await saveReferenceFolder({ projectId, parentId, name }) });
  }
  if (req.method === "PATCH" && /^\/api\/reference-folders\/[^/]+$/u.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice("/api/reference-folders/".length));
    const folder = await getReferenceFolder(id);
    if (!folder) return json(res, 404, { error: "文件夹不存在" });
    const body = await readJsonBody(req);
    const projectId = folder.projectId;
    const parentId = body.parentId === undefined ? folder.parentId : String(body.parentId || "").trim();
    const name = body.name === undefined ? folder.name : normalizeReferenceFolderName(body.name);
    if (parentId === id || referenceFolderDescendantIds(await referenceFoldersForProject(projectId), id).includes(parentId)) {
      return json(res, 409, { error: "不能把文件夹移动到自身或它的子文件夹里" });
    }
    await assertReferenceFolderNameAvailable({ projectId, parentId, name, exceptId: id });
    return json(res, 200, { folder: await saveReferenceFolder({ ...folder, name, parentId, id }) });
  }
  if (req.method === "DELETE" && /^\/api\/reference-folders\/[^/]+$/u.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice("/api/reference-folders/".length));
    const folder = await getReferenceFolder(id);
    if (!folder) return json(res, 404, { error: "文件夹不存在" });
    const folders = await referenceFoldersForProject(folder.projectId);
    const folderIds = [folder.id, ...referenceFolderDescendantIds(folders, folder.id)];
    const { items: documents } = await listReferenceDocuments({ projectId: folder.projectId, folderIds, limit: 0 });
    const indexing = documents.filter((document) => document.status === "indexing");
    if (indexing.length) return json(res, 409, { error: `文件夹里有 ${indexing.length} 份资料正在导入，请等完成后再删除` });
    const task = await createBackgroundTask({
      type: "reference_folder_delete",
      title: `删除资料文件夹：${folder.name}`,
      locale: ACTIVE_LOCALES[0],
      projectId: folder.projectId,
      progress: { phase: "queued", message: "等待删除", percent: 1, completed: 0, total: documents.length + folderIds.length }
    });
    runReferenceFolderDeleteInBackground({ taskId: task.id, folder }).catch((error) => console.error("[Kami] 参考资料文件夹删除失败", error));
    return json(res, 202, { taskId: task.id, backgroundTaskId: task.id, folderId: folder.id });
  }
  if (req.method === "GET" && url.pathname === "/api/references") {
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    const folderId = String(url.searchParams.get("folderId") || "").trim();
    const hasFolderFilter = url.searchParams.has("folderId");
    const recursive = url.searchParams.get("recursive") === "1";
    const folderIds = hasFolderFilter ? await referenceFolderScopeIds(projectId, folderId, { recursive }) : null;
    const result = await listReferenceDocuments({
      projectId,
      libraryId: String(url.searchParams.get("libraryId") || "").trim(),
      folderIds,
      folderId: hasFolderFilter ? folderId : "",
      status: String(url.searchParams.get("status") || "").trim(),
      search: String(url.searchParams.get("search") || "").trim(),
      offset: Number(url.searchParams.get("offset")) || 0,
      limit: Number(url.searchParams.get("limit")) || 50
    });
    return json(res, 200, {
      total: result.total,
      items: result.items,
      libraries: projectId ? await getResourceLibraries(projectId).catch(() => []) : []
    });
  }
  if (req.method === "POST" && url.pathname === "/api/references/file") {
    return json(res, 202, await startReferenceUpload({ body: null, params: url.searchParams, req }));
  }
  if (req.method === "POST" && url.pathname === "/api/references") {
    const body = await readJsonBody(req, { limitBytes: IMPORT_BODY_BYTES });
    return json(res, 202, await startReferenceUpload({ body, params: new URLSearchParams(), req }));
  }
  if (req.method === "POST" && url.pathname === "/api/references/describe-batch") {
    const body = await readJsonBody(req);
    const projectId = String(body.projectId || "").trim();
    if (!projectId) return json(res, 400, { error: "缺少项目" });
    const candidatesById = new Map();
    const requestedFolderIds = Array.isArray(body.folderIds) ? [...new Set(body.folderIds.map((id) => String(id).trim()).filter(Boolean))] : [];
    if (requestedFolderIds.length) {
      const folders = await referenceFoldersForProject(projectId);
      const expanded = new Set();
      for (const folderId of requestedFolderIds) {
        const folder = folders.find((item) => item.id === folderId);
        if (!folder) throw Object.assign(new Error("文件夹不存在或不属于当前项目"), { statusCode: 404 });
        expanded.add(folder.id);
        for (const descendantId of referenceFolderDescendantIds(folders, folder.id)) expanded.add(descendantId);
      }
      const scoped = await listReferenceDocuments({ projectId, folderIds: [...expanded], limit: 0 });
      for (const document of scoped.items) candidatesById.set(document.id, document);
    }
    if (Array.isArray(body.documentIds) && body.documentIds.length) {
      const ids = [...new Set(body.documentIds.map(String))].slice(0, 500);
      const documents = await Promise.all(ids.map((id) => getReferenceDocument(id)));
      for (const document of documents) {
        if (document && document.projectId === projectId) candidatesById.set(document.id, document);
      }
    }
    let candidates = [...candidatesById.values()];
    if (!requestedFolderIds.length && !(Array.isArray(body.documentIds) && body.documentIds.length)) {
      const folderId = String(body.folderId || "").trim();
      const folderIds = body.folderId !== undefined
        ? await referenceFolderScopeIds(projectId, folderId, { recursive: body.recursive !== false })
        : null;
      candidates = (await listReferenceDocuments({
        projectId,
        folderIds,
        status: "ready",
        search: String(body.search || "").trim(),
        limit: 0
      })).items;
    }
    const documents = candidates.filter((document) => document.status === "ready" && !document.ingestReport?.description);
    if (!documents.length) return json(res, 409, { error: "选中范围内没有需要生成描述的可用资料（已有描述的会跳过）" });
    const task = await createBackgroundTask({
      type: "reference_describe",
      title: `资料 AI 扫描 · ${documents.length} 份`,
      locale: ACTIVE_LOCALES[0],
      projectId,
      progress: { phase: "queued", message: "等待 AI 扫描", percent: 1, completed: 0, total: documents.length }
    });
    runReferenceDescribeBatchInBackground({ taskId: task.id, documents }).catch((error) => console.error("[Kami] 资料 AI 扫描失败", error));
    return json(res, 202, { taskId: task.id, backgroundTaskId: task.id, total: documents.length, skipped: candidates.length - documents.length });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/references/") && url.pathname.endsWith("/plan")) {
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length, -"/plan".length));
    const document = await getReferenceDocument(id);
    if (!document) return json(res, 404, { error: "资料不存在" });
    // stage 一定要给：前端靠它判断"还在预扫 / 等人确认 / 已经跑完了"，空字符串会被当成还在跑。
    const stage = document.ingestReport?.stage
      || (document.status === "ready" ? "ready" : document.status === "failed" ? "failed" : document.status === "disabled" ? "disabled" : "");
    return json(res, 200, { documentId: id, plan: document.ingestReport?.plan || null, stage });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/references/") && url.pathname.endsWith("/ingest")) {
    // 确认后的正式导入：vision=true 全量识图，false 只读文字。原文件一直在磁盘上，不用重传。
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length, -"/ingest".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const document = await getReferenceDocument(id);
    if (!document) return json(res, 404, { error: "资料不存在" });
    if (!document.ingestReport?.sourcePath) return json(res, 409, { error: "这份资料没有留存的源文件，无法重新导入，请重新上传" });
    const task = await createBackgroundTask({
      type: "reference_ingest",
      title: `参考资料导入：${document.sourceFile || document.name}`,
      locale: ACTIVE_LOCALES[0],
      projectId: document.projectId,
      progress: { phase: "queued", message: body.vision === false ? "等待解析（只读文字）" : "等待解析", percent: 1 }
    });
    enqueueReferenceIngest({
      taskId: task.id,
      documentId: id,
      visionMode: body.vision === false ? "none" : "all",
      autoScan: body.autoScan !== false
    });
    return json(res, 202, { taskId: task.id, backgroundTaskId: task.id, documentId: id, vision: body.vision !== false, autoScan: body.autoScan !== false });
  }
  if (req.method === "PATCH" && /^\/api\/references\/[^/]+$/u.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length));
    const document = await getReferenceDocument(id);
    if (!document) return json(res, 404, { error: "资料不存在" });
    const body = await readJsonBody(req);
    const folderId = String(body.folderId || "").trim();
    await assertReferenceFolder(document.projectId, folderId);
    const updated = await updateReferenceDocument(id, { folderId });
    referenceIndex.invalidate(document.projectId);
    return json(res, 200, { document: updated });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/references/") && url.pathname.endsWith("/chunks")) {
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length, -"/chunks".length));
    const document = await getReferenceDocument(id);
    if (!document) return json(res, 404, { error: "资料不存在" });
    const result = await listReferenceChunks({
      documentId: id,
      offset: Number(url.searchParams.get("offset")) || 0,
      limit: Number(url.searchParams.get("limit")) || 50
    });
    return json(res, 200, { document, total: result.total, items: result.items });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/references/") && url.pathname.endsWith("/reindex")) {
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length, -"/reindex".length));
    const document = await getReferenceDocument(id);
    if (!document) return json(res, 404, { error: "资料不存在" });
    const existing = await listReferenceChunks({ documentId: id, limit: 200 });
    const refreshed = [];
    for (const chunk of existing.items) {
      let embedding = chunk.embedding;
      try {
        embedding = (await embedSource(chunk.text))?.vector ?? null;
      } catch {
        embedding = chunk.embedding ?? null;
      }
      refreshed.push({ ...chunk, embedding, risk: scanReferenceRisk(chunk.text) });
    }
    await replaceReferenceChunks(id, { projectId: document.projectId, chunks: refreshed });
    await updateReferenceDocument(id, { status: "ready", chunkCount: refreshed.length, error: "" });
    referenceIndex.invalidate(document.projectId);
    return json(res, 200, { ok: true, chunkCount: refreshed.length });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/references/") && url.pathname.endsWith("/describe")) {
    // 让模型先扫一遍这份资料、写一两句描述；翻译时模型据此决定要不要读全文。
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length, -"/describe".length));
    const document = await getReferenceDocument(id);
    if (!document) return json(res, 404, { error: "资料不存在" });
    const { description, document: updated } = await describeReferenceDocumentById(document);
    logInfo("参考资料描述已生成", { id, name: document.name, description });
    return json(res, 200, { id, description, document: updated });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/references/") && url.pathname.endsWith("/status")) {
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length, -"/status".length));
    const body = await readJsonBody(req);
    const status = body.status === "disabled" ? "disabled" : "ready";
    const updated = await updateReferenceDocument(id, { status });
    if (!updated) return json(res, 404, { error: "资料不存在" });
    referenceIndex.invalidate(updated.projectId);
    return json(res, 200, { document: updated });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/references/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/references/".length));
    const document = await getReferenceDocument(id);
    const removed = await deleteReferenceDocumentCompletely(id);
    if (!removed) return json(res, 404, { error: "资料不存在" });
    referenceIndex.invalidate(document?.projectId || "");
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/reference-chunks/") && url.pathname.endsWith("/allow")) {
    const id = decodeURIComponent(url.pathname.slice("/api/reference-chunks/".length, -"/allow".length));
    const body = await readJsonBody(req);
    const updated = await updateReferenceChunk(id, { allowed: body.allowed !== false });
    if (!updated) return json(res, 404, { error: "片段不存在" });
    referenceIndex.invalidate(updated.projectId);
    return json(res, 200, { chunk: updated });
  }
  if (req.method === "POST" && url.pathname === "/api/translate") {
    const body = await readJsonBody(req);
    const locale = assertActiveLocale(body.locale);
    if (!String(body.source || "").trim()) {
      const error = new Error("请输入日语原文");
      error.statusCode = 400;
      throw error;
    }
    // 用途优先来自语境档案（整份文件通读后的区间标注），其次才是调用方指定的语体，
    // 最后才逐句猜。档案标注是"读到过上下文"的结论，比单句启发式可靠得多。
    const briefPurpose = Object.hasOwn(CONTENT_TYPES, String(body.segmentPurpose || "").trim()) ? String(body.segmentPurpose).trim() : "";
    const classification = await classify({
      text: body.source,
      hint: briefPurpose || body.contentType,
      useModel: body.useModelClassification && !briefPurpose,
      neighborContext: body.neighborContext
    });
    if (briefPurpose) {
      classification.source = "context-brief";
      classification.confidence = Math.max(Number(classification.confidence) || 0, 0.9);
      classification.evidence = [`语境档案标注用途：${CONTENT_TYPES[briefPurpose].label}`];
    }
    const projectId = String(body.projectId || "").trim();
    const baseAssets = (await getProjectAssets(locale, projectId)).assets;
    const workingTerms = normalizeWorkingTerms(body.workingTerms, { formalTerms: baseAssets.terms || [] });
    const assets = mergeWorkingAssets(baseAssets, { batchId: body.batchId || "", terms: workingTerms }, { batchId: body.batchId || "" });
    const projectRecord = projectId ? await getProject(projectId) : null;
    if (projectId && !projectRecord) {
      const error = new Error("项目不存在");
      error.statusCode = 404;
      throw error;
    }
    const projectSettings = projectRecord?.settings || null;
    const domainResolution = resolveDomain(body.source, body.domain, { contentType: classification.contentType });
    const domain = domainResolution.domain;
    const scope = learningScope({ locale, contentType: classification.contentType, domain, project: projectId || body.project || "default" });
    const translationSkill = await ensureChampionTranslationSkill(scope);
    const tuning = getSettings();
    const factory = DEFAULT_TRANSLATION_STRATEGY;
    const memoryLimit = Math.min(20, Math.max(1, effectiveStrategyValue(
      translationSkill.strategy?.retrieval?.translationMemory?.limit, factory.retrieval.translationMemory.limit, tuning.retrieval.translationMemoryLimit)));
    const qaCaseLimit = Math.min(20, Math.max(1, effectiveStrategyValue(
      translationSkill.strategy?.retrieval?.qaCases?.limit, factory.retrieval.qaCases.limit, tuning.retrieval.qaCaseLimit)));
    const passScore = Math.min(100, Math.max(60, effectiveStrategyValue(
      translationSkill.strategy?.qa?.minimumScore, factory.qa.minimumScore, tuning.quality.qaPassScore)));
    const maxRevisions = Math.min(4, Math.max(0, effectiveStrategyValue(
      translationSkill.strategy?.qa?.maximumRevisionAttempts, factory.qa.maximumRevisionAttempts, tuning.quality.maxRevisionAttempts)));
    const delivery = deliveryContext(body, body.source);
    const matches = await matchTermsForTranslation(body.source, assets, {
      contentType: classification.contentType,
      domain,
      ...delivery
    });
    const queryEmbedding = await embedSource(body.source);
    const [storedStyleProfile, localeQaCases, userProfile, projectLibraries] = await Promise.all([
      // 统一降级链：同语体同领域 → 同语体通用 → 通用同领域 → 通用×通用。
      getProjectStyleProfile(locale, { projectId }),
      getQaCases(locale, { projectId, contentType: classification.contentType, domain, limit: -1, scopeFallback: true }),
      getUserProfile(locale, { projectId }),
      projectId ? getResourceLibraries(projectId, { kind: "translation_memory" }) : []
    ]);
    // 候选先粗筛再精排：整库 8 万条时，这一段的代价是每段十几秒 / 369MB。
    const localeMemories = await getMemoryCandidates(locale, {
      projectId,
      source: body.source,
      limit: getSettings().retrieval.candidatePoolSize,
      scopeFallback: true,
      contentType: classification.contentType,
      domain,
      libraryIds: projectLibraries.filter((library) => library.enabled).map((library) => library.id)
    });
    const librariesById = new Map(projectLibraries.map((library) => [library.id, library]));
    const scopedMemories = localeMemories.map((memory) => {
      const library = librariesById.get(memory.libraryId);
      return library ? { ...memory, libraryName: library.name, libraryRole: library.role, libraryPriority: library.priority, libraryEnabled: library.enabled } : null;
    }).filter((memory) => memory?.libraryEnabled === true);
    const narrowedQaCases = narrowByDomain(localeQaCases, domain);
    const narrowedMemories = narrowByDomain(scopedMemories, domain);
    // 工作 TM 的机器草稿只在本文件内互认：别的文件的机器译文没有人工确认，
    // 也常与当前文件的设定冲突，不再跨文件进入参考位。
    const fileScopedMemories = scopeMachineDraftsToFile(narrowedMemories.items, {
      sourceFile: body.sourceFile || body.neighborContext?.document || "",
      batchId: body.batchId || ""
    });
    domainResolution.relaxedRetrieval = narrowedMemories.relaxed || narrowedQaCases.relaxed;
    const qaGuidance = rankQaCases(body.source, narrowedQaCases.items, {
      limit: qaCaseLimit,
      queryEmbedding,
      contentType: classification.contentType,
      domain
    });
    const translationReferences = rankTranslationMemories(body.source, fileScopedMemories, {
      limit: memoryLimit,
      queryEmbedding,
      contentTags: classification.contentTags || [],
      locale,
      contentType: classification.contentType,
      domain,
      projectId,
      // 条目身份优先用 memoQ 的稳定 ID：命中同一条目算 101/102 的 CAT 匹配。
      entryId: body.entryId || "",
      entryKey: body.entryKey || "",
      campaign: String(body.campaign || ""),
      retrievalPurpose: projectId ? MEMORY_PURPOSES.WORKING_CONSISTENCY : undefined,
      catMinFuzzy: projectSettings?.tm?.catMinFuzzy || 60,
      llmMinRelevance: projectSettings?.tm?.llmMinRelevance || 60,
      ...delivery
    });
    // 透明化：这一次到底吃到了哪一档作用域（规范按链位、记忆按档位计数）。
    const scopeUsage = {
      contentType: classification.contentType,
      domain,
      styleProfile: storedStyleProfile
        ? {
          name: storedStyleProfile.name,
          contentType: storedStyleProfile.contentType,
          domain: storedStyleProfile.domain,
          version: Number(storedStyleProfile.version) || 1,
          rank: Number(storedStyleProfile.scopeRank) || 0
        }
        : null,
      memoryScopes: translationReferences.reduce((counts, item) => {
        const rank = Number.isInteger(item.scopeRank) ? item.scopeRank : 0;
        if (rank === 0) counts.exact += 1;
        else if (rank >= 3) counts.general += 1;
        else counts.partial += 1;
        return counts;
      }, { exact: 0, partial: 0, general: 0 })
    };
    // 批次排比/韵文检测：同一批次的多行共用一种句式时，注入模板约束；
    // 客户端顺序翻译时还会带上本批已定稿译文作为风格锚点。
    let batchVerse = null;
    if (body.batchId) {
      try {
        const batchRun = await getBatchRun(String(body.batchId));
        batchVerse = detectBatchVerse(batchRun?.segments || []);
      } catch { /* 批次记录不可用不影响翻译 */ }
    }
    const neighborMetadata = Array.isArray(body.neighborContext?.metadata) ? body.neighborContext.metadata : [];
    const factSchema = extractFactSchema({
      source: body.source,
      metadata: neighborMetadata.filter((item) => item?.role !== "constraint"),
      constraints: neighborMetadata.filter((item) => item?.role === "constraint")
    });
    const contextPack = buildContextPack({
      titleOverrides: getSettings().orthography.titleBrackets,
      source: body.source,
      locale,
      classification,
      matches,
      domain,
      neighborContext: body.neighborContext || "",
      styleProfile: storedStyleProfile || body.styleProfile || null,
      translationSkill,
      qaGuidance,
      userProfile,
      translationReferences,
      batchVerse,
      batchReferences: body.batchReferences || [],
      patternReferences: body.patternReferences || [],
      batchGroupEntries: body.batchGroupEntries || [],
      factSchema,
      // 当前段落的条目身份（memoQ x-mmq-context / 表格里的条目 ID 列）。
      entryId: body.entryId || "",
      entryKey: body.entryKey || ""
    });
    const provider = getProviderConfig();
    const risk = assessTranslationRisk({
      source: body.source,
      contentType: classification.contentType,
      facts: { count: factSchema.summary?.translationFacts || 0 },
      metadata: neighborMetadata,
      protectedTokens: contextPack.protectedTokens
    });
    // 质量档取代了"生成路线"：逐段判定流程强度（是否模型质检、几轮修订、几候选），
    // 模型与思考强度在同一批次内保持统一，只有升级时才换。
    const manualTier = resolveManualTier({ qualityTier: body.qualityTier, route: body.route });
    const tierDecision = selectQualityTier({
      source: body.source,
      purpose: classification.contentType,
      risk,
      factCount: factSchema.summary?.translationFacts || 0,
      protectedTokens: contextPack.protectedTokens,
      termConflicts: (contextPack.preferredTerms || []).filter((term) => term.conflict === true).length,
      metadata: neighborMetadata,
      manualTier
    });
    const tierPlanFor = (tier) => planQualityTier({ tier, purpose: classification.contentType, provider, risk });
    let routing = tierPlanFor(tierDecision.tier);
    let qualityTier = routing.tier;
    let qualityUpgradeFrom = "";
    const tierStrength = describeTierStrength({ tier: routing.tier, provider });
    let routingDescription = `${QUALITY_TIERS[routing.tier].description}${tierStrength ? ` ${tierStrength}` : ""}`;
    const startedAt = Date.now();
    let trajectory = null;
    let learningCaptureError = translationSkill.persistenceError || "";
    try {
      trajectory = await saveLearningTrajectory({
        ...scope, batchId: body.batchId || "", segmentId: body.segmentId || "", source: body.source,
        contextPack, assetRefs: {
          translationSkillId: translationSkill.id,
          styleProfileId: contextPack.styleProfile?.id || "",
          termIds: matches.map((item) => item.term?.id).filter(Boolean),
          memoryIds: translationReferences.map((item) => item.id).filter(Boolean),
          qaCaseIds: qaGuidance.map((item) => item.id).filter(Boolean),
          entryId: body.entryId || "",
          sourceFile: body.sourceFile || body.neighborContext?.document || "",
          sourceRow: body.sourceRow || body.neighborContext?.row || null,
          sheet: body.neighborContext?.sheet || "",
          previousSource: body.previousSource || body.neighborContext?.previous || "",
          nextSource: body.nextSource || body.neighborContext?.next || ""
        },
        model: routing.model || provider.model, promptVersion: TRANSLATION_PROMPT_VERSION,
        status: "running", events: [{ type: "started", at: new Date().toISOString(), routing }]
      });
    } catch (error) {
      learningCaptureError = error.message;
    }
    try {
      const aiQaEnabled = body.aiQa !== false;
      const routedPassScore = Math.max(passScore, qualityThresholdForRisk(risk.tier));
      const hardErrorCount = (list) => (list || []).filter((issue) => issue.severity === "error").length;
      const deterministicIssues = (translation) => [
        ...runQa({ source: body.source, translation, matches, translationReferences: contextPack.translationReferences, locale, titleOverrides: getSettings().orthography.titleBrackets, contentType: classification.contentType, registerPolicy: contextPack.styleProfile?.reviewRubric?.registerPolicy || null, projectSettings }),
        ...applyProjectQaPolicy(checkFactSchema({ schema: factSchema, translation, locale }), projectSettings || undefined)
      ];
      // 一次执行 = 一次初译 + 本档允许的质检强度。快速档不跑模型质检，只跑确定性检查。
      const referenceUsages = [];
      const referenceToolRunner = buildReferenceToolRunner({
        projectId,
        skill: translationSkill,
        onActivity: (activity) => referenceUsages.push(activity)
      });
      const executePlan = async (plan) => {
        const useModelQa = aiQaEnabled && plan.modelQa;
        const translationResult = await translateWithRoute(contextPack, { routePlan: plan, reflect: plan.reflect === true, toolRunner: referenceToolRunner });
        if (useModelQa) {
          const loop = await runAiQaLoop({
            contextPack, initialTranslation: translationResult.translation, matches, locale,
            contentType: classification.contentType, domain, batchId: body.batchId || "",
            providedReferences: translationReferences, passScore: routedPassScore,
            maxRevisions: Math.min(maxRevisions, Number.isFinite(plan.maxRevisions) ? plan.maxRevisions : maxRevisions),
            projectSettings, projectId
          });
          return { translation: translationResult, aiQa: loop };
        }
        return {
          translation: translationResult,
          aiQa: {
            translation: translationResult.translation,
            issues: deterministicIssues(translationResult.translation),
            score: null, status: "deterministic_only", iterations: 0, used: false,
            fallbackReason: "", references: [], qaCases: []
          }
        };
      };
      const executed = await executePlan(routing);
      let result = executed.translation;
      let aiQa = executed.aiQa;
      let qualityRoute = decideQualityRoute({
        qaScore: aiQa.score,
        hardErrorCount: hardErrorCount(aiQa.issues),
        riskTier: risk.tier,
        hasQualityUpgrade: Boolean(routing.upgradeTier),
        aiQaUsed: aiQa.used
      });
      if (!aiQa.used) {
        // 没跑模型质检时"AIQA 未完成"不构成阻断：确定性检查干净就放行，
        // 出现阻断问题则升档重做，而不是把整批快速档段落都推给人工。
        qualityRoute = hardErrorCount(aiQa.issues)
          ? {
            decision: routing.upgradeTier ? "escalate_model" : "human_review",
            threshold: routedPassScore,
            reason: `确定性检查发现 ${hardErrorCount(aiQa.issues)} 个阻断问题`
          }
          : { decision: "auto_pass", threshold: routedPassScore, reason: "确定性检查通过（本档不做模型质检）" };
      }
      if (qualityRoute.decision === "escalate_model" && routing.upgradeTier) {
        const previousResult = result;
        const previousTier = routing.tier;
        const escalationPlan = { ...tierPlanFor(routing.upgradeTier), escalated: true };
        const rerun = await executePlan(escalationPlan);
        result = rerun.translation;
        aiQa = rerun.aiQa;
        const combinedCandidates = [...(result.candidates || []), ...(previousResult.candidates || [])]
          .filter((item, index, list) => list.findIndex((other) => other.translation === item.translation) === index)
          .slice(0, 4);
        result = { ...result, candidates: combinedCandidates };
        qualityUpgradeFrom = previousTier;
        routing = escalationPlan;
        qualityTier = escalationPlan.tier;
        routingDescription = `${qualityRoute.reason}，已自动升级到${QUALITY_TIERS[qualityTier]?.label || qualityTier}档重做。`;
        qualityRoute = decideQualityRoute({
          qaScore: aiQa.score,
          hardErrorCount: hardErrorCount(aiQa.issues),
          riskTier: risk.tier,
          hasQualityUpgrade: false,
          alreadyEscalated: true,
          aiQaUsed: aiQa.used
        });
      }
      const suggestionCandidates = buildSuggestionCandidates(aiQa.translation, matches);
      let alignment = { requested: suggestionCandidates.length > 0, used: false, fallbackReason: "" };
      let modelSuggestions = [];
      if (suggestionCandidates.length) {
        try {
          modelSuggestions = await alignTermSuggestionsWithModel(locale, aiQa.translation, suggestionCandidates);
          alignment.used = true;
        } catch (error) {
          alignment.fallbackReason = error.message;
        }
      }
      const termSuggestions = resolveTermSuggestions(aiQa.translation, suggestionCandidates, modelSuggestions);
      if (projectId && aiQa.translation && !(aiQa.issues || []).some((issue) => ["error", "critical"].includes(issue.severity))) {
        const workingLibrary = projectLibraries.find((library) => library.role === "working" && library.enabled);
        if (workingLibrary) {
          try {
            await saveMemory(locale, {
              source: body.source,
              target: aiQa.translation,
              domain,
              contentType: classification.contentType,
              qualityStatus: "machine_verified",
              assetTier: "working",
              project: projectId,
              projectId,
              libraryId: workingLibrary.id,
              qaScore: aiQa.score,
              provenance: "batch-working-tm",
              batchId: body.batchId || "",
              entryId: body.entryId || "",
              entryKey: body.entryKey || "",
              previousSource: body.previousSource || "",
              nextSource: body.nextSource || "",
              sourceFile: body.sourceFile || body.neighborContext?.document || "",
              sourceRow: body.sourceRow || body.neighborContext?.row || null
            });
          } catch (error) {
            learningCaptureError = learningCaptureError || `工作 TM 写入失败：${error.message}`;
          }
        }
      }
      const initialIssues = runQa({ source: body.source, translation: result.initial || result.translation, matches, translationReferences: contextPack.translationReferences, locale, titleOverrides: getSettings().orthography.titleBrackets, contentType: classification.contentType, registerPolicy: contextPack.styleProfile?.reviewRubric?.registerPolicy || null, projectSettings });
      let completedTrajectory = trajectory;
      if (trajectory) {
        try {
          completedTrajectory = await updateLearningTrajectory(trajectory.id, {
            initialTranslation: result.initial || result.translation,
            finalTranslation: aiQa.translation,
            termDecisions: aiQa.termDecisions || [],
            qaBefore: { ...trajectoryMetricsFromIssues(initialIssues, calculateQaScore({ hardIssues: initialIssues }), matches), issues: initialIssues },
            qaAfter: { ...trajectoryMetricsFromIssues(aiQa.issues, aiQa.score, matches), issues: aiQa.issues, iterations: aiQa.iterations },
            referenceUsage: { refs: referenceToolRunner?.refs?.() || [], events: referenceUsages },
            events: [
              { type: "started", at: trajectory.createdAt },
              { type: "completed", at: new Date().toISOString(), latencyMs: Date.now() - startedAt, aiQaIterations: aiQa.iterations }
            ],
            status: aiQa.status === "review" || qualityRoute.decision === "human_review" ? "review" : "completed",
            error: aiQa.fallbackReason || ""
          });
        } catch (error) {
          learningCaptureError = error.message;
        }
      }
      return json(res, 200, {
        locale,
        classification,
        domainResolution,
        matches,
        contextPack,
        ...result,
        translation: aiQa.translation,
        candidates: [
          ...((result.candidates || []).some((item) => item.translation === aiQa.translation)
            ? []
            : [{ index: -1, translation: aiQa.translation, recommended: true, reason: "QA 修订终稿" }]),
          ...(result.candidates || []).map((item) => ({ ...item, recommended: item.translation === aiQa.translation }))
        ],
        issues: aiQa.issues,
        qaScore: aiQa.score,
        aiQa,
        factSchema,
        // 质量档是给用户看的结论；routing 保留 route/model 等执行细节供排查。
        qualityTier,
        qualityTierLabel: QUALITY_TIERS[qualityTier]?.label || "",
        qualityTierSource: tierDecision.manual ? "manual" : "auto",
        tierReason: tierDecision.reason,
        tierSignals: tierDecision.signals,
        // 没配高质量模型时严苛档只能靠流程强度提升，界面必须说实话。
        tierStrength: describeTierStrength({ tier: qualityTier, provider }),
        qualityUpgradeFrom,
        routing: {
          ...routing,
          label: `${QUALITY_TIERS[qualityTier]?.label || qualityTier}档`,
          description: routingDescription,
          tierReason: tierDecision.reason,
          signals: tierDecision.signals,
          manual: tierDecision.manual,
          risk
        },
        qualityRoute,
        scopeUsage,
        styleProfile: contextPack.styleProfile,
        translationSkill: { id: translationSkill.id, name: translationSkill.name, version: translationSkill.version, status: translationSkill.status },
        trajectoryId: completedTrajectory?.id || "",
        learningCapture: { captured: Boolean(completedTrajectory?.id) && !learningCaptureError, warning: learningCaptureError },
        termSuggestions,
        suggestionAlignment: alignment
      });
    } catch (error) {
      if (trajectory) {
        await updateLearningTrajectory(trajectory.id, {
          status: "failed",
          error: error.message,
          events: [{ type: "started", at: trajectory.createdAt }, { type: "failed", at: new Date().toISOString(), latencyMs: Date.now() - startedAt, error: error.message }]
        }).catch(() => undefined);
      }
      throw error;
    }
  }
  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const path = join(PUBLIC_ROOT, safePath);
  if (!path.startsWith(PUBLIC_ROOT)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(path)] || "application/octet-stream",
      "content-length": body.length,
      // 本机工作台随时会被更新；让浏览器一直用磁盘上的最新前端，别拿旧 JS 猜行为。
      "cache-control": "no-store"
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// 工作台只在 Directus 资产后台上运行。JSON 存储仅供单元测试，
// 用它跑真实翻译会在没有术语、记忆与风格规范的情况下静默产出低质译文。
if (!runtimeOptions().embedded && process.env.KAMI_STORE !== "directus") {
  console.error([
    "[Kami] 拒绝启动：KAMI_STORE 必须为 directus。",
    "本工作台的语言资产全部存放在 Directus，缺少它的翻译结果没有参考价值。",
    "请使用 npm start（它会加载 directus/.env），并确认其中 KAMI_STORE=directus。"
  ].join("\n"));
  process.exit(1);
}

try {
  // 日志先接管 console，再初始化：启动阶段的报错也要留在日志里。
  if (!runtimeOptions().embedded) installConsoleCapture();
  loadPreviousRunLogs();
  logInfo("工作台进程启动", { version: process.env.npm_package_version || "", port: PORT, pid: process.pid });
  if (!runtimeOptions().embedded) startHeapWatchdog();
  await initializeStore();
  await recoverInterruptedBatchWorkers();
  await recoverInterruptedImportTasks();
  await recoverLegacyReferenceIngestTasks();
} catch (error) {
  if (runtimeOptions().embedded) throw error;
  console.error(`[Kami] 启动失败\n${error.message}`);
  process.exit(1);
}

// 技能评测后台任务队列：同一时刻只跑一个评测，逐对持久化检查点，重启后可续跑。
/**
 * 评测任务 → 任务中心 / 通知中心。
 *
 * 评测以前只活在学习中心自己那一栏：跑完没有通知、失败也没有记录，用户只能盯着
 * 按钮文字。桥接到后台任务以后，任务中心能看到它的进度与结论，通知中心也会在
 * 完成 / 失败时提醒（失败的原因就写在任务详情里）。
 */
const syncLearningJobTask = createLearningJobTaskBridge({
  createTask: (input) => createBackgroundTask(input),
  updateTask: (id, update) => updateBackgroundTaskProgress(id, update),
  patchJob: (jobId, fields, job) => (String(job?.kind || "") === "style-evaluation" ? styleEvaluationJobs : evaluationJobs).patch(jobId, fields),
  describe: async (job) => {
    const scope = job?.scope || {};
    if (String(job?.kind || "") === "style-evaluation") {
      const profiles = await styleProfilesInScope(scope).catch(() => []);
      const draft = profiles.find((profile) => String(profile.id) === String(job.challengerId));
      return draft ? `风格评测 · ${draft.name || `v${draft.version}`}` : "风格评测";
    }
    const candidate = await getTranslationSkill(job?.challengerId).catch(() => null);
    return candidate ? `候选技能评测 · ${candidate.name || `v${candidate.version}`}` : "候选技能评测";
  },
  onError: (error) => console.warn(`[Kami] 评测任务同步到任务中心失败（不影响评测）：${error?.message || error}`)
});

async function disposeEmbeddedWorkbench() {
  if (!runtimeOptions().embedded) return;
  if (conflictScanTimer) clearInterval(conflictScanTimer);
  for (const control of batchWorkers.values()) control.pauseRequested = true;
  for (const control of runningBackgroundTasks.values()) control.cancelRequested = true;
  await Promise.allSettled([
    ...[...batchWorkers.values(), ...batchQaWorkers.values()].map((control) => control.promise),
    ...contextAnalysisTasks.values(), ...consistencyCheckTasks.values(), ...termSurveyTasks.values(),
    ...[...runningBackgroundTasks.values()].map((control) => control.settled),
    ...referenceIngestQueues.values(), evaluationJobs.stop(), styleEvaluationJobs.stop()
  ]);
  await matcherPool.close();
}

const evaluationJobs = createEvaluationJobRunner({
  benchmark: benchmarkTranslationSkill,
  createSnapshot: ({ scope, trajectories }) => createBenchmarkSnapshot(scope, trajectories, { promptVersion: TRANSLATION_PROMPT_VERSION }),
  jobsDirectory: join(DATA_ROOT, "learning", "jobs"),
  concurrency: 5,
  onChanged: syncLearningJobTask,
  deps: {
    getSkill: getTranslationSkill,
    getCurrentChampion: async (scope) => (await listTranslationSkills({ ...scope, status: "champion", limit: 1 }))[0] || null,
    validatePromotionState: (input) => validateCandidatePromotionState(input),
    saveEvaluation: saveSkillEvaluation,
    updateSkillMetrics: (id, metrics) => updateTranslationSkill(id, { metrics }),
    buildUiReport: learningEvaluationUiReport
  }
});
await evaluationJobs.initialize();

/** 同一项目的风格规范列表（含草稿与停用版本），供风格评测解析变体。 */
async function styleProfilesInScope(scope) {
  // 规范是项目级的：按语体×领域过滤会让 project-level 草稿在当前作用域下找不到，
  // 评测直接返回"变体不存在"。
  const { styleProfiles } = await listStyleProfiles(scope.locale, null, { projectId: scope.project });
  return styleProfiles;
}

async function resolveStyleVariant(id, scope) {
  const profiles = await styleProfilesInScope(scope);
  const profile = String(id) === NO_STYLE_PROFILE_ID ? null : profiles.find((item) => item.id === String(id)) || null;
  if (String(id) !== NO_STYLE_PROFILE_ID && !profile) return null;
  const [skill, activeProfile] = await Promise.all([
    ensureChampionTranslationSkill(scope),
    getProjectStyleProfile(scope.locale, { projectId: scope.project })
  ]);
  // AIQA 始终看当前生效版本，否则草稿会用自己的标准给自己打分。
  return styleVariant({ id, scope, skill, profile, qaProfile: activeProfile });
}

// 风格草稿评测：唯一变量是风格规范本身，技能、留出集与检索隔离两边完全一致。
const styleEvaluationJobs = createEvaluationJobRunner({
  benchmark: benchmarkStyleVariant,
  createSnapshot: ({ scope, trajectories }) => createBenchmarkSnapshot(scope, trajectories, { promptVersion: TRANSLATION_PROMPT_VERSION }),
  jobsDirectory: join(DATA_ROOT, "learning", "jobs"),
  concurrency: 5,
  kind: "style-evaluation",
  guardrails: STYLE_PROMOTION_GUARDRAILS,
  onChanged: syncLearningJobTask,
  deps: {
    getSkill: resolveStyleVariant,
    getCurrentChampion: async (scope) => {
      const active = await getProjectStyleProfile(scope.locale, { projectId: scope.project });
      return resolveStyleVariant(active?.id || NO_STYLE_PROFILE_ID, scope);
    },
    validatePromotionState: ({ candidate, currentChampion }) => validateStylePromotionState({
      draft: candidate?.styleProfile,
      activeProfile: currentChampion?.styleProfile
    }),
    saveEvaluation: async (payload) => {
      const evaluation = {
        draftProfileId: String(payload.challengerSkillId || ""),
        activeProfileId: String(payload.championSkillId || ""),
        sampleCount: payload.sampleCount,
        decision: payload.decision,
        promotable: payload.report?.promotable === true,
        conclusion: payload.report?.conclusion || "",
        report: payload.report,
        evaluatedAt: new Date().toISOString(),
        evaluator: "kami-style-benchmark-v1"
      };
      await saveStyleProfileEvaluation(evaluation.draftProfileId, evaluation);
      return { id: evaluation.draftProfileId };
    },
    updateSkillMetrics: async () => undefined,
    buildUiReport: learningEvaluationUiReport
  }
});
await styleEvaluationJobs.initialize();

/**
 * 候选被拒绝 / 删除、生效版本被换掉以后，指向它的评测任务永远续跑不了。
 *
 * 以前这类任务会停在 interrupted，客户端每轮轮询都去续跑一次、撞一次 409，
 * 用户只看到一句"评测无法续跑"，任务中心里还挂着一条永远跑不完的"进行中"。
 * 现在在源头上就把它判失败：状态、原因都落到任务中心与通知中心。
 */
async function failEvaluationJobs(runner, predicate, reason) {
  for (const job of runner.list()) {
    if (["completed", "failed"].includes(String(job.status))) continue;
    if (!predicate(job)) continue;
    await runner.fail(job.jobId, reason);
  }
}

function sameEvaluationScope(jobScope, scope) {
  return ["locale", "contentType", "domain", "project"].every((field) => String(jobScope?.[field] ?? "") === String(scope?.[field] ?? ""));
}

// 自动候选生成：人工批准终稿达到阈值后，在后台提议 challenger；评测与激活仍走人工闸门。
const autoProposer = createAutoProposer({
  // 设置面板里的值；环境变量已在 settings-store 里优先合并过。
  threshold: getSettings().learning.autoProposeThreshold,
  growthWindow: getSettings().learning.autoProposeGrowthWindow,
  deps: {
    getCurrentChampion: async (scope) => (await listTranslationSkills({ ...scope, status: "champion", limit: 1 }))[0] || null,
    countAcceptedTrajectories: async (scope) => {
      const trajectories = await listLearningTrajectories({ ...scope, limit: 500 });
      return trajectories.filter((item) => item.status === "completed" && item.humanDecision?.accepted === true && String(item.finalTranslation || "").trim()).length;
    },
    listActiveCandidates: async (scope) => {
      const skills = await listTranslationSkills({ ...scope, limit: 20 });
      return skills.filter((item) => ["challenger", "draft"].includes(item.status));
    },
    listTrajectories: async (scope) => listLearningTrajectories({ ...scope, limit: 500 }),
    selectTrajectories: (trajectories) => selectProposalTrajectories(trajectories),
    propose: ({ scope, champion, trajectories }) => proposeChallengerSkill({ scope, champion, trajectories, promptVersion: TRANSLATION_PROMPT_VERSION }),
    recordMetadata: async (championId, existingMetadata, autoPropose) => {
      try {
        await updateTranslationSkill(championId, { metadata: { ...(existingMetadata || {}), autoPropose } });
      } catch (error) {
        // Directus 尚未 provision metadata 字段时记账失败不应阻断候选生成本身。
        console.error(`记录自动候选生成状态失败（可能需要先执行 npm run directus:provision）：${error.message}`);
      }
    }
  }
});

// 规则冲突扫描：风格规则、技能附加规则与译者画像都会往同一份提示词里写文字，
// 三者互不知情。蒸馏沉淀之后与定时各扫一遍，结论进任务中心等人工处置——
// 退休风格规则和改技能规则各自都有闸门，这里不能绕过去自己改。
const conflictReports = new Map();

const conflictScanner = createConflictScanner({
  deps: {
    loadScopeRules: async (scope) => {
      const [styleProfile, champion, activeProfile, allSkills] = await Promise.all([
        getProjectStyleProfile(scope.locale, { projectId: scope.project }),
        ensureChampionTranslationSkill(scope),
        getUserProfile(scope.locale, { projectId: scope.project }),
        listTranslationSkills({ ...scope, limit: 200 })
      ]);
      // 人工指南与译者画像是同一个槽位（同一时间只有一个 active）：
      // 人工导入的整篇指南按名字/证据数识别，其余才当译者画像。
      const isGuide = Boolean(activeProfile)
        && (/^风格指南/u.test(String(activeProfile.name || "")) || (Number(activeProfile.evidenceCount) || 0) === 0);
      const skills = (allSkills.length ? allSkills : [champion])
        .filter((item) => item && ["champion", "challenger", "draft"].includes(String(item.status || "")));
      return {
        humanGuide: isGuide ? activeProfile : null,
        styleProfile,
        skills,
        translationSkill: champion,
        userProfile: isGuide ? null : activeProfile
      };
    },
    adjudicate: (input) => adjudicateRuleConflictsWithModel(input),
    recordReport: async (report) => {
      conflictReports.set(learningScopeKeyOf(report.scope), report);
    }
  }
});

function learningScopeKeyOf(scope) {
  // 语体/领域只作参考：冲突报告按「语言 × 项目」结算。
  return [scope.locale, scope.project || "default"].join("\u0000");
}

function triggerConflictScan(scope) {
  conflictScanner.scan(scope)
    .then((report) => {
      if (report.conflicts?.length) {
        console.log(`[Kami] 规则冲突扫描：${scope.locale}/${scope.contentType}/${scope.domain} 发现 ${report.conflicts.length} 处冲突，待人工处置`);
      }
    })
    .catch((error) => console.error("规则冲突扫描失败", error));
}

/**
 * 定时扫描。代码库此前没有任何调度器，这是第一个，所以刻意保持最小：
 * 只扫"已经有活跃风格规范"的作用域（没有规范就没有可冲突的规则），
 * 逐个串行走扫描器自身的队列，不与翻译争抢模型。默认关闭（间隔 0）。
 */
let conflictScanTimer = null;

/**
 * 声明在这里、调用也在这里：`let` 不像函数声明那样提升，早期版本在模块顶部
 * 就调用 rescheduleConflictScan()，启动时直接 TDZ 报错退出。
 */
function rescheduleConflictScan() {
  if (conflictScanTimer) clearInterval(conflictScanTimer);
  conflictScanTimer = null;
  const minutes = getSettings().learning.conflictScanIntervalMinutes;
  if (!minutes) return;
  conflictScanTimer = setInterval(async () => {
    try {
      for (const project of await getProjects()) {
        for (const locale of ACTIVE_LOCALES) {
          // 项目级扫描：一份规范 + 全部技能版本 + 人工指南/画像，扫一次就够。
          const { styleProfiles } = await listStyleProfiles(locale, "active", { projectId: project.id });
          if (!styleProfiles.length) continue;
          await conflictScanner.scan(learningScope({ locale, project: project.id }));
        }
      }
    } catch (error) {
      console.error("规则冲突定时扫描失败", error);
    }
  }, minutes * 60_000);
  conflictScanTimer.unref?.();
  console.log(`[Kami] 规则冲突定时扫描已启用：每 ${minutes} 分钟`);
}

function triggerAutoProposal(scope) {
  autoProposer.maybePropose(scope)
    .then((result) => {
      if (result?.proposed) {
        console.log(`已自动生成候选技能：${result.candidateId}（${result.reason}）`);
        // 候选是自动长出来的，门禁也要自动跟上，否则"批准启用"会被未跑门禁拦住。
        triggerQualityGateRefresh(scope, { reason: "auto-candidate" });
        return;
      }
      // 阈值未到/窗口防抖/已有候选等是正常不提议；其他原因按异常记录，避免被静默吞掉。
      const reason = String(result?.reason || "");
      if (!/^(人工批准终稿|自上次自动提议后|当前作用域已有待评测候选|作用域尚无生效版本|没有可复盘的完成轨迹)/u.test(reason)) {
        console.error(`自动候选生成检查异常：${reason}`);
      }
    })
    .catch((error) => console.error("自动候选生成检查失败", error));
}

const server = http.createServer(async (req, res) => {
  // 用户关页面会直接掐断连接；把响应上的错误吞掉，别让长任务把它升级成进程级异常。
  res.on("error", () => {});
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await apiHandler(req, res, url);
      if (handled === false) json(res, 404, { error: "API not found" });
      return;
    }
    if (!(await serveStatic(req, res, url))) json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]`, error);
    json(res, error.statusCode || 500, { error: error.message || "Internal server error" });
  }
});

function closeServerForAutomaticShutdown() {
  return new Promise((resolve) => {
    let completed = false;
    let timeout = null;
    const finish = () => {
      if (completed) return;
      completed = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    timeout = setTimeout(finish, 3_000);
    timeout.unref?.();
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") console.error("[Kami] 关闭工作台 HTTP 服务失败", error);
      finish();
    });
    server.closeAllConnections?.();
  });
}

/**
 * 内存看门狗：评测任务会把输入快照读进内存（实测 77 MB JSON 解析后约 450 MB 堆），
 * 一旦顶到 Node 堆上限，进程会被 OOM 掉，界面上只表现为"连不上工作台"，
 * 日志里什么都没有。接近上限时先留一条 warn，事后能直接看出是内存问题。
 */

/**
 * 从 instruction 文本里删掉一条规则的整行。
 * 新版规范的正文由 rules 重建，旧版（没有结构化 rules）只能按行删：
 * 既认「· 规则正文」，也认裸文本，忽略首尾空白与项目符号。
 */
function stripStyleRuleLine(instruction, text) {
  const target = String(text || "").trim();
  if (!target) return String(instruction || "");
  return String(instruction || "")
    .split(/\r?\n/u)
    .filter((line) => line.replace(/^[\s·•*\-]+/u, "").trim() !== target)
    .join("\n");
}

function startHeapWatchdog() {
  const timer = setInterval(() => {
    const used = process.memoryUsage().heapUsed;
    const limit = v8.getHeapStatistics().heap_size_limit;
    if (!limit || used / limit < 0.85) return;
    logWarn("堆内存接近上限，评测任务可能把工作台压垮", {
      usedMB: Math.round(used / 1024 / 1024),
      limitMB: Math.round(limit / 1024 / 1024)
    });
  }, 60_000);
  timer.unref?.();
}

async function recoverInterruptedBatchWorkers() {
  const tasks = await listBackgroundTasks({ limit: 500 });
  for (const project of await getProjects()) {
    const runs = await listBatchRuns({ projectId: project.id, limit: 500 });
    for (const summary of runs) {
      if (!["queued", "running"].includes(summary.runState)) continue;
      const run = await getBatchRun(summary.batchId);
      if (!run) continue;
      await saveBatchRun({
        ...run,
        runState: "paused",
        segments: run.segments.map((segment) => segment.status === "running"
          ? { ...segment, status: "pending", error: "服务重启后等待继续" }
          : segment)
      });
      // 对应的后台任务也要收尾，否则任务中心那条「批次翻译」会一直停在"进行中"。
      const task = tasks.find((item) => item.type === "batch_translation" && item.status === "in_progress" && item.payload?.batchId === run.batchId);
      if (task) {
        await saveBackgroundTask({
          ...task,
          status: "needs_attention",
          progress: { ...(task.progress || {}), phase: "interrupted", message: "服务重启导致中断，可在任务中心继续翻译" },
          payload: { ...(task.payload || {}), batchId: run.batchId, filename: run.filename, resumable: true }
        });
      }
      console.log(`[Kami] 已暂停服务重启前未完成的批次：${run.filename}`);
    }
  }
}

/**
 * 服务重启会打断正在执行的后台导入。把它们标成"可继续"而不是永远停在
 * 进行中，用户才能在任务中心点「继续导入」把剩下的候选补完。
 */
async function recoverInterruptedImportTasks() {
  const tasks = await listBackgroundTasks({ limit: 500 });
  for (const task of tasks) {
    if (!["term_import", "asset_import", "reference_ingest", "reference_describe", "reference_folder_delete"].includes(task.type)) continue;
    if (task.status !== "in_progress") continue;
    const referenceTask = ["reference_ingest", "reference_describe", "reference_folder_delete"].includes(task.type);
    await saveBackgroundTask({
      ...task,
      status: "needs_attention",
      progress: {
        ...(task.progress || {}),
        phase: "interrupted",
        message: referenceTask ? "服务重启导致中断，请在参考资料页重试" : "服务重启导致中断，可在任务中心继续导入"
      },
      payload: { ...(task.payload || {}), resumable: !referenceTask || task.type === "reference_ingest" }
    });
    console.log(`[Kami] 已标记被服务重启打断的后台导入：${task.title}`);
  }
}

/**
 * 旧版参考资料导入会在图片过多时停在 review，等一个已经取消的确认弹窗。
 * 这里按资料的真实状态收尾：已导入的直接完成，未导入的改为可操作的失败提示。
 */
async function recoverLegacyReferenceIngestTasks() {
  const tasks = await listBackgroundTasks({ limit: 500 });
  for (const task of tasks) {
    if (task.type !== "reference_ingest" || task.status !== "review") continue;
    const documentId = String(task.payload?.documentId || "");
    const document = documentId ? await getReferenceDocument(documentId).catch(() => null) : null;
    if (document?.status === "ready") {
      await updateBackgroundTaskProgress(task.id, {
        status: "completed",
        progress: {
          phase: "completed",
          message: "旧版等待确认已由后续导入完成取代",
          percent: 100,
          completed: Number(document.chunkCount) || 0,
          total: Number(document.chunkCount) || 0
        },
        payload: { ...(task.payload || {}), superseded: true }
      });
      continue;
    }
    await updateBackgroundTaskProgress(task.id, {
      status: "needs_attention",
      progress: {
        phase: "legacy_confirmation_cancelled",
        message: "旧版等待确认已取消；新的上传会按已选识图模式直接导入",
        percent: 100,
        completed: 0,
        total: Number(task.progress?.total) || 0
      },
      payload: { ...(task.payload || {}), documentId, requiresReimport: true }
    });
    console.log(`[Kami] 已校准旧版参考资料待确认任务：${task.title}`);
  }
}

async function shutdownManagedWorkbench() {
  if (workbenchShutdownStarted) return;
  workbenchShutdownStarted = true;
  workbenchSessionMonitor?.dispose();
  console.log("[Kami] 最后一个工作台页面已关闭，正在停止工作台与 Docker Desktop。");
  logInfo("工作台收尾：最后一个页面已关闭", { graceMs: WORKBENCH_CLOSE_GRACE_MS });
  await closeServerForAutomaticShutdown();
  try {
    await shutdownDockerDesktop({ cwd: PROJECT_ROOT });
  } catch (error) {
    console.error(`[Kami] 自动停止 Docker Desktop 失败：${error.message}`);
  } finally {
    process.exit(0);
  }
}

const HOST = process.env.KAMI_HOST || "127.0.0.1";
if (!runtimeOptions().embedded) server.listen(PORT, HOST, () => {
  console.log(`Kami Localization Workbench: http://127.0.0.1:${PORT}`);
  rescheduleConflictScan();
  // 启动先扫一遍：上一次被重启打断的任务不该在任务中心永远转圈。
  sweepStaleBackgroundTasks({ reason: "startup" }).catch((error) => console.error(`[Kami] 清理残留后台任务失败：${error.message}`));
  const staleSweepTimer = setInterval(() => {
    sweepStaleBackgroundTasks({ reason: "interval" }).catch(() => {});
  }, BACKGROUND_TASK_STALE_MS);
  staleSweepTimer.unref?.();
  if (AUTO_SHUTDOWN_ENABLED) {
    workbenchSessionMonitor = new WorkbenchSessionMonitor({
      closeGraceMs: WORKBENCH_CLOSE_GRACE_MS,
      heartbeatGraceMs: WORKBENCH_HEARTBEAT_GRACE_MS,
      startupGraceMs: WORKBENCH_STARTUP_GRACE_MS,
      onIdle: shutdownManagedWorkbench
    });
    workbenchSessionMonitor.start();
    console.log(`[Kami] 关闭最后一个页面 ${WORKBENCH_CLOSE_GRACE_MS / 1000} 秒后自动停止；最小化挂机时心跳失联 ${Math.round(WORKBENCH_HEARTBEAT_GRACE_MS / 60_000)} 分钟才视为关闭，后台任务执行期间不会停止。`);
  }
});

export { apiHandler, disposeEmbeddedWorkbench };

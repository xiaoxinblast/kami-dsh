import { splitBatchSubBatches, splitTranslationGroups } from "./batch-document.mjs";
import { contextBriefSlice, purposeForIndex } from "./context-brief.mjs";
import { createCheckpointWriter } from "./checkpoint-writer.mjs";
import { isTransientConnectionError, retryTransient } from "./transient-errors.mjs";
import { buildPatternKey, selectPatternReferences } from "./pattern-memory.mjs";
import { emptyWorkingGlossary, mergeWorkingTermsIntoGlossary } from "./working-glossary.mjs";
import { verifiedSurveyMemory } from "./term-memory-survey.mjs";
import { isIncompleteBatchQa, isIncompleteBatchStage } from "../public/batch-status.js";
import { translationRetryReason } from "./translation-output.mjs";
import { microBatchSegments } from "./micro-batch.mjs";
import { measureStage } from "./performance.mjs";
import { withRuntimeCall } from "./runtime-context.mjs";

/** 连接层失败自动重试一次：等 2 秒再试，内容层错误不重试。 */
const SEGMENT_RETRY_DELAY_MS = 2_000;

function compactResult(result) {
  if (!result) return null;
  const clip = (value, limit = 800) => String(value || "").slice(0, limit);
  return {
    translation: clip(result.translation, 10_000),
    ...(result.stages ? { stages: result.stages, draft: clip(result.draft, 10_000) } : {}),
    ...(result.referenceUsage ? { referenceUsage: result.referenceUsage } : {}),
    qaScore: Number.isFinite(result.qaScore) ? result.qaScore : null,
    matches: (result.matches || []).slice(0, 20),
    issues: (result.issues || []).slice(0, 30),
    aiQa: result.aiQa ? {
      score: Number.isFinite(result.aiQa.score) ? result.aiQa.score : null,
      status: result.aiQa.status,
      iterations: result.aiQa.iterations || 0,
      used: Boolean(result.aiQa.used),
      fallbackReason: clip(result.aiQa.fallbackReason, 500),
      termDecisions: (result.aiQa.termDecisions || []).slice(0, 12),
      humanDecisions: (result.aiQa.humanDecisions || []).slice(0, 30)
    } : null,
    // 本段实际用的用途与质量档：批次页、质量报告与人工复核都要能回溯到"为什么这样跑"。
    segmentPurpose: result.classification?.contentType || result.segmentPurpose || "",
    qualityTier: result.qualityTier || "",
    tierReason: clip(result.tierReason || "", 200),
    qualityUpgradeFrom: result.qualityUpgradeFrom || "",
    styleProfile: result.styleProfile ? { id: result.styleProfile.id, name: result.styleProfile.name, version: result.styleProfile.version } : null,
    trajectoryId: result.trajectoryId || "",
    patternKey: clip(result.patternKey || "", 400),
    ...(result.performance ? { performance: result.performance } : {})
  };
}

function contextBoundary(segment = {}) {
  return `${segment.locator?.type || ""}\u0000${segment.locator?.sheet || segment.context?.sheet || ""}`;
}

/** 保留邻近原文以消解跨句比喻；不把先前机器译文当作语义依据。 */
export function batchNeighborContext(run, segment) {
  const position = run.segments.indexOf(segment), boundary = contextBoundary(segment);
  const nearby = [];
  for (const direction of [-1, 1]) {
    const items = [];
    for (let offset = 1; offset <= (direction < 0 ? 8 : 4); offset += 1) {
      const index = position + direction * offset, item = run.segments[index];
      if (!item || contextBoundary(item) !== boundary) break;
      items.push({ index, source: String(item.source || "").slice(0, 300) });
    }
    nearby.push(...items);
  }
  return {
    ...(segment.context || {}),
    previous: segment.context?.previous || run.segments[position - 1]?.source || "",
    next: segment.context?.next || run.segments[position + 1]?.source || "",
    document: run.filename, segmentIndex: position + 1, segmentCount: run.segments.length,
    note: [segment.context?.note, nearby.length ? `相邻原文（只用于消歧）：\n${nearby.sort((a, b) => a.index - b.index).map(item => `#${item.index + 1} ${item.source}`).join("\n")}` : ""].filter(Boolean).join("\n"),
    entryKey: segment.entryKey || segment.locator?.entryKey || ""
  };
}

function executionGroups(segments, settings, segmentationMode) {
  if (segmentationMode !== "group") return new Map();
  const groups = splitTranslationGroups(segments, {
    maxEntries: settings.groupMaxEntries,
    maxChars: settings.groupMaxChars
  });
  const byId = new Map();
  for (const group of groups) {
    const entries = segments.filter((segment) => group.segmentIds.includes(segment.id));
    for (const segment of entries) byId.set(segment.id, entries);
  }
  return byId;
}

function checkpointSubBatches(subBatches, segments) {
  return subBatches.map((batch) => {
    const entries = batch.segmentIds.map((id) => segments.find((segment) => segment.id === id)).filter(Boolean);
    const completed = entries.filter((segment) => segment.status === "done").length;
    const failed = entries.filter((segment) => segment.status === "error").length;
    return {
      ...batch,
      completed,
      failed,
      status: failed ? "needs_attention" : completed === entries.length ? "completed" : completed ? "running" : "queued"
    };
  });
}

export async function runServerBatch(batchId, {
  loadRun,
  saveRun,
  loadProject,
  classifyDocument,
  translateSegment,
  translateGroup = null,
  segmentIds = null,
  loadTermSources = async () => [],
  loadWorkingGlossary = null,
  learnTerms = null,
  learnGroupTerms = null,
  shouldPause = () => false,
  shouldCancel = () => false,
  touch = () => {},
  review = async () => {},
  finalize = async () => {}
} = {}) {
  const run = await loadRun(batchId);
  if (!run) throw new Error("未找到批次任务");
  const project = await loadProject(run.projectId);
  if (!project) throw new Error("批次所属项目不存在");
  const formalTermSources = await Promise.resolve().then(() => loadTermSources(run)).catch(() => []) || [];
  // 续跑时把已完成的段落先放进句式历史，后面的段落仍能拿到同框架参考。
  const patternHistory = (Array.isArray(run.segments) ? run.segments : [])
    .filter((segment) => segment.status === "done" && String(segment.translation || "").trim())
    .map((segment) => ({ segmentId: segment.id, source: segment.source, target: segment.translation }));
  const batchSettings = project.settings?.batch || {};
  const tmSettings = project.settings?.tm || {};
  const retryIds = segmentIds ? new Set(segmentIds.map(String)) : null;
  const selected = (run.segments || []).filter((segment) => segment.selected !== false && (!retryIds || retryIds.has(String(segment.id))));
  // 重译不能拿本段旧机器稿自学的译法证明自己；撤下旧候选，再从本次结果学习。
  const glossary = run.runnerOptions?.workingGlossary;
  if (retryIds && Array.isArray(glossary?.terms)) {
    const retrySources = new Set(selected.filter(segment => segment.status !== "done").map(segment => String(segment.id)));
    const terms = glossary.terms.filter(term => term.origin !== "segment-learn" || !retrySources.has(String(term.sourceSegmentId)) || verifiedSurveyMemory(term));
    if (terms.length !== glossary.terms.length) run.runnerOptions = { ...run.runnerOptions, workingGlossary: { ...glossary, terms, revision: (Number(glossary.revision) || 0) + 1 } };
  }
  // 语境档案已经给出整份文件的用途时直接用它；没有档案才退回"读前 8000 字判一次"。
  const brief = run.contextBrief && run.contextBrief.status === "ready" ? run.contextBrief : null;
  const declaredContentType = String(run.contentType || "general");
  const contentType = brief?.documentType?.purpose
    || (declaredContentType && declaredContentType !== "general" ? declaredContentType
      : await classifyDocument(selected.map((segment) => segment.source).join("\n").slice(0, 8_000)));
  const subBatches = splitBatchSubBatches(selected, {
    maxEntries: batchSettings.subBatchMaxEntries,
    maxChars: batchSettings.subBatchMaxChars
  });
  const groupById = executionGroups(selected, batchSettings, run.segmentationMode);
  const options = run.runnerOptions || {};
  run.contentType = contentType || "general";
  run.runState = "running";
  run.subBatches = checkpointSubBatches(subBatches, run.segments);
  const checkpoint = createCheckpointWriter({ save: () => saveRun(run) });
  await checkpoint.commit();

  const drafts = new Map(), attemptedGroups = new Set();
  let pendingTerms = [];
  const inputFor = (segment) => {
    const position = run.segments.indexOf(segment);
    const context = batchNeighborContext(run, segment);
    // 用途按语境档案的区间继承；档案没覆盖到的段落回落文件级用途。
    let segmentPurpose = purposeForIndex(brief, position, contentType || "general");
    const speaker = String(segment.context?.note || "").match(/(?:^|[\r\n|])\s*(?:(?:SOURCE|EN)_)?SPEAKER\s*[:：]\s*([^\r\n]+)/iu)?.[1]?.trim();
    if (["ui", "item_name"].includes(segmentPurpose) && speaker && !/^(?:N\/?A|none|null|-+)$/iu.test(speaker)) segmentPurpose = "dialogue";
    const workingTerms = Array.isArray(run.runnerOptions?.workingGlossary?.terms)
      ? run.runnerOptions.workingGlossary.terms.filter((term) => term?.status !== "rejected")
      : [];
    const patternTerms = [...formalTermSources, ...workingTerms];
    return {
      patternKey: buildPatternKey(segment.source, { terms: patternTerms }),
      body: {
        projectId: run.projectId,
        source: segment.source,
        locale: run.locale,
        contentType: segmentPurpose,
        segmentPurpose,
        domain: run.domain,
        documentBrief: contextBriefSlice(brief, position, segment.id),
        neighborContext: context,
        batchId: run.batchId,
        segmentId: segment.id,
        entryId: segment.locator?.unitId || segment.locator?.entryId || segment.context?.entryId || "",
        entryKey: segment.entryKey || segment.locator?.entryKey || "",
        sourceFile: run.filename,
        sourceRow: segment.locator?.row || segment.context?.row || null,
        previousSource: context.previous,
        nextSource: context.next,
        batchReferences: run.segments.slice(0, position).filter(item => item.status === "done" && item.translation && contextBoundary(item) === contextBoundary(segment))
          .slice(-Math.max(0, Number(tmSettings.contextAnchorCount ?? 5))).map(item => ({ source: item.source, target: item.translation })),
        patternReferences: selectPatternReferences({ source: segment.source, terms: patternTerms, previous: patternHistory.filter(item => String(item.segmentId) !== String(segment.id)) }),
        workingTerms,
        batchGroupEntries: (groupById.get(segment.id) || []).map(item => ({ id: item.id, source: item.source, context: item.context })),
        qualityTier: options.qualityTier || "auto",
        reflect: options.reflect !== false,
        useModelClassification: false,
        ...(retryIds ? { workflowStage: "translation" } : {})
      }
    };
  };
  const applyLearned = (learned, segment) => {
    if (!Array.isArray(learned) || !learned.length) return;
    const glossary = run.runnerOptions?.workingGlossary || emptyWorkingGlossary({ batchId: run.batchId, filename: run.filename, locale: run.locale });
    const merged = mergeWorkingTermsIntoGlossary(glossary, learned, { sourceSegmentId: segment.id });
    run.runnerOptions = { ...run.runnerOptions, workingGlossary: merged };
    // 新增术语后，已翻段落的骨架会变（术语位置从正文变成遮罩）；只重算含该词的段落。
    const learnedSources = learned.map(term => String(term.source || "")).filter(Boolean);
    for (const item of run.segments) {
      if (retryIds && !retryIds.has(String(item.id))) continue;
      if (item.status !== "done" || !item.result || !String(item.source || "")) continue;
      if (!learnedSources.some(source => item.source.includes(source))) continue;
      item.result = { ...item.result, patternKey: buildPatternKey(item.source, { terms: [...formalTermSources, ...merged.terms] }) };
    }
  };
  const flushGroupTerms = async () => {
    const segments = pendingTerms;
    pendingTerms = [];
    if (!segments.length) return;
    try {
      const learned = await withRuntimeCall({ performanceTrace: segments.at(-1).result?.performance }, () => measureStage("workingTerms", () => learnGroupTerms({ run, segments }), { groupSize: segments.length }));
      applyLearned(learned, segments[0]);
    } catch (error) {
      console.warn(`[Kami] 小批工作术语学习失败，已跳过：${error.message}`);
    }
  };

  for (const subBatch of subBatches) {
    for (const segmentId of subBatch.segmentIds) {
      touch();
      if (shouldCancel()) {
        await flushGroupTerms();
        // 中断：当前段跑完就停，已完成的段落全部保留，之后可以「继续」接着翻。
        run.runState = "paused";
        run.runnerOptions = { ...run.runnerOptions, cancelled: true };
        run.subBatches = checkpointSubBatches(subBatches, run.segments);
        await checkpoint.commit();
        return run;
      }
      if (shouldPause()) {
        await flushGroupTerms();
        run.runState = "paused";
        run.subBatches = checkpointSubBatches(subBatches, run.segments);
        await checkpoint.commit();
        return run;
      }
      const segment = run.segments.find((item) => item.id === segmentId);
      if (!segment || segment.selected === false || segment.status === "done" || !retryIds && segment.status === "error") continue;
      segment.status = "running";
      segment.error = "";
      // "这段正在翻"只更新内存：每段都整行写一次会把 Directus 压出压力保护，
      // 真正的断点由段落结果那次 commit 保证。
      await checkpoint.mark();
      const position = run.segments.indexOf(segment);
      // UI 可能在批中改了工作术语；只有外部版本比本进程新时才覆盖，避免把本段刚学到的词冲掉。
      if (loadWorkingGlossary) {
        const external = await Promise.resolve().then(() => loadWorkingGlossary(run)).catch(() => null);
        if (external && Number(external.revision || 0) > Number(run.runnerOptions?.workingGlossary?.revision || 0)) {
          run.runnerOptions = { ...run.runnerOptions, workingGlossary: external };
        }
      }
      let groupFallback = null;
      try {
        if (translateGroup && !attemptedGroups.has(segment.id)) {
          const candidates = microBatchSegments(run.segments, position, (_, index) => purposeForIndex(brief, index, contentType || "general"));
          const stop = candidates.findIndex(item => !subBatch.segmentIds.includes(item.id) || (retryIds && !retryIds.has(String(item.id))) || attemptedGroups.has(item.id));
          const group = stop < 0 ? candidates : candidates.slice(0, stop);
          if (group.length > 1) {
            group.forEach(item => attemptedGroups.add(item.id));
            const groupStarted = Date.now();
            try {
              const generated = await translateGroup(group.map(item => inputFor(item).body));
              if (generated?.length === group.length && group.every(item => generated.some(draft => draft.id === item.id && draft.source === item.source))) {
                generated.forEach(draft => drafts.set(draft.id, draft));
              }
            } catch (error) {
              console.warn(`[Kami] 小批翻译失败，退回逐段流程：${error.message}`);
            }
            if (!drafts.has(segment.id)) groupFallback = { stage: "microBatchAttempt", startedAt: new Date(groupStarted).toISOString(), durationMs: Date.now() - groupStarted, status: "fallback", groupSize: group.length };
          }
        }
        const { body, patternKey } = inputFor(segment);
        const translateOnce = () => translateSegment(body, { draft: drafts.get(segment.id) || null });
        // 连接层失败（网络抖动 / 模型 502-504）先自动重试一次再判失败；
        // 内容层错误（空译文、格式、校验）不重试，避免白花模型额度。
        const result = await retryTransient(translateOnce, {
          attempts: 2,
          delayMs: SEGMENT_RETRY_DELAY_MS,
          onRetry: (error) => console.warn(`[Kami] 第 ${position + 1} 段连接失败，自动重试一次：${error.message}`)
        });
        segment.translation = result.translation;
        segment.result = compactResult({ ...result, patternKey });
        if (groupFallback) {
          segment.result.performance ||= { version: 1, events: [] };
          segment.result.performance.events.push(groupFallback);
        }
        segment.status = "done";
        segment.accepted = false;
        // 本段翻完立刻学本文件术语：下一次请求就能用上；失败不影响本段。
        // 小批初译已共享组内上下文，统一在本组最终译文保存后学习，供下一组使用。
        if (!retryIds && drafts.has(segment.id) && learnGroupTerms) {
          pendingTerms.push(segment);
        } else if (!retryIds && learnTerms && (!result.stages || result.stages.localQa?.status === "completed")) {
          try {
            const learned = await withRuntimeCall({ performanceTrace: segment.result?.performance }, () => measureStage("workingTerms", () => learnTerms({ run, segment, translation: segment.translation })));
            applyLearned(learned, segment);
          } catch (error) {
            console.warn(`[Kami] 第 ${position + 1} 段工作术语学习失败，已跳过：${error.message}`);
          }
        }
        patternHistory.push({ segmentId: segment.id, source: segment.source, target: segment.translation });
      } catch (error) {
        segment.status = "error";
        segment.error = String(error?.message || error);
        if (error.performance) segment.result = { ...segment.result, performance: error.performance };
      }
      drafts.delete(segment.id);
      if (!drafts.size) await flushGroupTerms();
      run.subBatches = checkpointSubBatches(subBatches, run.segments);
      await withRuntimeCall({ performanceTrace: segment.result?.performance }, () => measureStage("save", () => checkpoint.commit()));
    }
  }

  const failed = selected.filter((segment) => segment.status === "error").length;
  const incomplete = selected.some(segment => segment.result?.stages && segment.result.stages.localQa?.status !== "completed");
  run.runState = failed || incomplete ? "needs_attention" : retryIds && run.segments.some((segment) => segment.selected !== false && segment.status !== "done") ? "paused" : "completed";
  run.runnerOptions = { ...run.runnerOptions, translationCompletedAt: new Date().toISOString(), stageRetryOnly: Boolean(retryIds) };
  run.subBatches = checkpointSubBatches(subBatches, run.segments);
  await checkpoint.commit();
  // 交付前闭环先跑：一致性核对 + 质量报告是用户翻完立刻要看的结论；
  // 风格学习与复盘（review）会调多次模型，排在后面免得把报告拖到几分钟后。
  if (!retryIds && !failed && !incomplete && selected.some((segment) => segment.status === "done" && segment.translation)) await finalize(run);
  if (!retryIds && !failed && !incomplete) await review(run);
  return run;
}

/** 只重跑已有译文中未完成的 AIQA，逐段保存；成功段与翻译失败段不改。 */
export async function retryServerBatchQa(batchId, { loadRun, saveRun, recheckSegment, stage = null, segmentIds = null, shouldCancel = () => false, report = async () => {} } = {}) {
  let run = await loadRun(batchId);
  if (!run) throw new Error("未找到批次任务");
  const ids = segmentIds ? new Set(segmentIds.map(String)) : null;
  const incomplete = (segment) => stage ? isIncompleteBatchStage(segment, stage) : isIncompleteBatchQa(segment);
  const targets = run.segments.filter((segment) => incomplete(segment) && !segment.accepted && !translationRetryReason(segment) && (!ids || ids.has(String(segment.id))));
  let completed = 0;
  let failed = 0;
  await report({ completed, failed, total: targets.length });
  for (const target of targets) {
    if (shouldCancel()) break;
    run = await loadRun(batchId);
    const segment = run?.segments.find((item) => item.id === target.id);
    if (!segment) break;
    if (!segment.accepted && incomplete(segment)) {
      const originalTranslation = segment.translation;
      let update;
      try {
        const qa = await recheckSegment({ projectId: run.projectId, source: segment.source, translation: originalTranslation,
          locale: run.locale, contentType: segment.result?.segmentPurpose || run.contentType || "general",
          domain: run.domain || "auto", batchId, segmentId: segment.id,
          ...(stage ? { workflowStage: stage, stages: segment.result.stages,
            neighborContext: batchNeighborContext(run, segment), documentBrief: contextBriefSlice(run.contextBrief, run.segments.indexOf(segment), segment.id),
            useModelClassification: false, qualityTier: segment.result.qualityTier } : {}),
          workingTerms: [],
          aiQa: true });
        if (stage !== "proofreading" && qa.translation != null && qa.translation !== originalTranslation) throw new Error("QA 返回的译文与待检查译文不一致，评分未保存，请重试 QA");
        const translation = qa.translation || originalTranslation;
        update = { ...segment, translation, accepted: translation === originalTranslation ? segment.accepted : false,
          result: { ...segment.result, ...compactResult({ ...segment.result, ...qa, translation, draft: segment.result?.draft || qa.draft }) } };
      } catch (error) {
        update = { ...segment, result: { ...segment.result,
          ...(stage ? { stages: { ...segment.result.stages, [stage]: { status: "failed", error: String(error.message || error) } } } : {}),
          aiQa: { ...segment.result?.aiQa, fallbackReason: String(error.message || error) } } };
      }
      // 回写前重新读取，不能覆盖并发编辑或用户已经修好的 QA。
      run = await loadRun(batchId);
      const current = run?.segments.find((item) => item.id === segment.id);
      if (current && !current.accepted && current.translation === originalTranslation && incomplete(current)) {
        run.segments = run.segments.map((item) => item.id === segment.id ? update : item);
        run.runnerOptions = { ...run.runnerOptions, stageRetryOnly: true,
          ...(update.translation !== originalTranslation ? { translationCompletedAt: new Date().toISOString() } : {}) };
        await saveRun(run);
      }
      if (incomplete(run?.segments.find((item) => item.id === segment.id) || update)) failed += 1;
    }
    completed += 1;
    await report({ completed, failed, total: targets.length });
  }
  return { run, completed, failed, total: targets.length, cancelled: shouldCancel() };
}

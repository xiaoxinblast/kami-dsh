/**
 * Background evaluation jobs: FIFO queue, progress checkpointing and resume.
 *
 * One skill evaluation runs at a time so local models are not thrashed by
 * concurrent benchmarks. Every completed pair is persisted as JSON under the
 * jobs directory, so a server restart only interrupts the in-flight pair and
 * the job can be resumed instead of restarting from zero.
 *
 * The module stays storage-agnostic: all store access goes through the `deps`
 * object injected by the HTTP layer, which keeps it unit-testable with fakes
 * or a mock OpenAI server.
 */
import { runtimeOptions, withRuntimeCall } from "./runtime-context.mjs";

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { evaluateSkillPromotion } from "./learning-engine.mjs";
import { runPairedSkillBenchmarks } from "./learning-benchmark.mjs";
import { benchmarkSnapshotFingerprint, evaluationProfileForContentType } from "./evaluation-policy.mjs";

const QUEUED = "queued";
const RUNNING = "running";
const INTERRUPTED = "interrupted";
const COMPLETED = "completed";
const FAILED = "failed";
const TERMINAL_STATUSES = new Set([COMPLETED, FAILED]);
const RESUMABLE_STATUSES = new Set([QUEUED, INTERRUPTED, FAILED]);
/** 改名失败里属于"短暂被挡住"的错误码：Windows 上文件被并发打开时常见。 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function benchmarkVariantFingerprintInput(value) {
  if (!value || typeof value !== "object") return value;
  const ignored = new Set([
    "metrics", "evaluation", "metadata", "createdAt", "updatedAt", "activatedAt",
    "created_at", "updated_at", "date_created", "date_updated", "status"
  ]);
  if (Array.isArray(value)) return value.map(benchmarkVariantFingerprintInput);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ignored.has(key))
    .map(([key, item]) => [key, benchmarkVariantFingerprintInput(item)]));
}

function sampleArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function flattenVariantSamples(job, variant) {
  return job.requestedCaseIds.flatMap((caseId) => sampleArray(job.caseSamples?.[caseId]?.[variant]));
}

function conclusionClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "promote") return "promote";
  if (normalized === "reject") return "reject";
  return "inconclusive";
}

function persistableTrajectory(trajectory) {
  return {
    id: String(trajectory.id || ""),
    source: String(trajectory.source || ""),
    finalTranslation: String(trajectory.finalTranslation || ""),
    humanDecision: trajectory.humanDecision ? {
      accepted: trajectory.humanDecision.accepted === true,
      finalTranslation: String(trajectory.humanDecision.finalTranslation || "")
    } : null,
    neighborContext: trajectory.contextPack?.neighborContext || ""
  };
}

function publicJob(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    scope: job.scope,
    championId: job.championId,
    challengerId: job.challengerId,
    status: job.status,
    progress: {
      requested: job.requestedCaseIds.length,
      completed: Object.keys(job.caseSamples).length,
      failed: Object.keys(job.caseFailures).length
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || "",
    error: job.error || "",
    // 任务中心那条镜像记录的 id：重启后照它继续更新，不再新建一条。
    backgroundTaskId: String(job.backgroundTaskId || ""),
    completionHookWarning: String(job.completionHookWarning || ""),
    automaticRetryCount: Number(job.automaticRetryCount) || 0,
    result: job.result || null,
    reproducibility: {
      policyVersion: job.evaluationProfile?.policyVersion || "legacy",
      mode: job.evaluationProfile?.mode || "legacy",
      repetitions: Number(job.evaluationProfile?.repetitions) || 1,
      snapshotFingerprint: String(job.snapshotFingerprint || ""),
      reusedFromJobId: String(job.reusedFromJobId || "")
    }
  };
}

/**
 * @param kind        Job kind stored on every checkpoint. A runner only ever
 *   restores its own kind from disk, so several runners (skill evaluation,
 *   style-profile evaluation) can share one jobs directory without stealing
 *   each other's checkpoints.
 * @param guardrails  Extra promotion guardrails merged into every conclusion,
 *   e.g. restricting which metrics may justify a style-profile promotion.
 * @param onChanged  每次状态或进度变化后回调（收到的是 publicJob）。用于把评测
 *   同步给任务中心 / 通知中心：评测以前只在学习中心自己那一栏可见，跑完也没人通知。
 */
export function createEvaluationJobRunner({ benchmark, createSnapshot = null, jobsDirectory, deps, concurrency = 5, kind = "skill-evaluation", guardrails = {}, automaticRetryLimit = 0, onCompleted = null, onChanged = null, now = () => new Date().toISOString() } = {}) {
  if (typeof benchmark !== "function") throw new TypeError("benchmark 必须是函数");
  for (const name of ["getSkill", "getCurrentChampion", "validatePromotionState", "saveEvaluation", "updateSkillMetrics", "buildUiReport"]) {
    if (typeof deps?.[name] !== "function") throw new TypeError(`evaluation job deps 缺少 ${name}`);
  }

  const jobs = new Map();
  let running = false;
  let runningPromise;
  let stopping = false;
  const callContexts = new Map();
  /** 同一个 job 的回调必须按顺序落地，否则后到的旧进度会盖掉新进度。 */
  const changeChains = new Map();

  /**
   * 状态回传：串行、吞异常。任务中心写不进去（记录被删掉、库抖了）绝不能让评测本身失败。
   */
  function notifyChanged(job) {
    if (typeof onChanged !== "function") return Promise.resolve();
    const previous = changeChains.get(job.jobId) || Promise.resolve();
    const next = previous
      .then(() => onChanged(publicJob(job)))
      .catch(() => undefined);
    changeChains.set(job.jobId, next);
    return next;
  }

  async function jobPath(jobId) {
    return join(jobsDirectory, `${jobId}.json`);
  }

  /**
   * 原子写：先写临时文件再改名。Windows 上 rename 覆盖已有文件可能被别的句柄
   * （杀软 / 索引器 / 恰好同时在读这份检查点的调用方）短暂挡住，报 EPERM/EACCES/EBUSY。
   * 这类错误是瞬时的，退避重试几次即可，不能让一次写入抖动把整条队列带崩。
   */
  async function renameWithRetry(from, to, attempts = 4) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        if (!TRANSIENT_RENAME_CODES.has(String(error?.code || "")) || attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * attempt));
      }
    }
  }

  async function persist(job) {
    await mkdir(dirname(await jobPath(job.jobId)), { recursive: true });
    const path = await jobPath(job.jobId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    // 不做缩进：这份检查点里有输入快照（实测 77 MB 数据，缩进后 200 MB），
    // 每完成一对样本都要重写一次——缩进只是让写盘和临时字符串都翻三倍。
    // _persistChain 是运行期的 Promise，序列化只会变成 {} 再被读回来（见 chainPersist 的防御）。
    const { _persistChain, ...persisted } = job;
    await writeFile(temporary, `${JSON.stringify(persisted)}
`, "utf8");
    await renameWithRetry(temporary, path);
  }

  /**
   * 已完成的评测不再需要输入快照。
   *
   * benchmarkSnapshot 是这份检查点里最大的一块（实测 77 MB JSON，解析进内存后 450 MB 堆），
   * 而 completed 的任务永远不会被续跑（RESUMABLE_STATUSES 里没有它）。磁盘上保留一份供审计，
   * 内存里立刻释放——否则重启时把每个历史任务都读进内存，再加上正在跑的评测，
   * 很容易把 Node 默认的 ~4 GB 堆顶爆，进程被 OOM 掉，界面表现为"连不上工作台"。
   */
  function releaseCompletedPayload(job) {
    if (!job || job.status !== COMPLETED) return false;
    if (!job.benchmarkSnapshot) return false;
    job.benchmarkSnapshot = null;
    return true;
  }

  function chainPersist(job) {
    // 从检查点恢复的任务会带着序列化过的 _persistChain（一个 {}），直接 .then 会抛
    // "(job._persistChain || Promise.resolve(...)).then is not a function"——实测在
    // "续跑被拒绝 → fail() → markFailed() → chainPersist()" 这条路上必崩。
    const previous = job._persistChain;
    job._persistChain = (previous && typeof previous.then === "function" ? previous : Promise.resolve())
      .then(() => persist(job))
      .catch(() => undefined);
    return job._persistChain;
  }

  async function restoreFromDisk() {
    let files = [];
    try { files = await readdir(jobsDirectory); } catch { return; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(join(jobsDirectory, file), "utf8"));
        if (!job?.jobId || job.kind !== kind) continue;
        // 老检查点里可能残留序列化过的 _persistChain（{}），恢复时就地清掉。
        job._persistChain = Promise.resolve();
        if ([QUEUED, RUNNING].includes(job.status)) {
          job.status = INTERRUPTED;
          job.error = "服务重启中断了本次评测，可续跑剩余样本";
          job.updatedAt = now();
          await persist(job);
        }
        // 历史里已完成的评测只需要摘要：快照留在磁盘上，不进内存。
        releaseCompletedPayload(job);
        jobs.set(job.jobId, job);
        // 未跑完 / 失败的评测要同步到任务中心，用户才知道"上次那条停了"；
        // 已完成的结论在学习中心里已经有了，不再往任务中心灌历史。
        if (job.status !== COMPLETED) await notifyChanged(job);
      } catch { /* 损坏的检查点文件不阻断启动，直接忽略 */ }
    }
  }

  function pumpQueue() {
    if (running || stopping) return;
    running = true;
    runningPromise = (async () => {
      try {
      while (!stopping) {
        const next = [...jobs.values()].find((job) => job.status === QUEUED);
        if (!next) break;
        // 收尾阶段的意外异常（例如检查点正好被别的句柄挡住）只记日志：
        // 已经有终态的评测不能被降级成失败，队列也不能因此停摆。
        await withRuntimeCall(callContexts.get(next.jobId) || { modelRoute: next.modelRoute }, () => execute(next)).catch((error) => {
          if ([COMPLETED, FAILED].includes(next.status)) {
            console.error("评测收尾异常（评测结论已落盘，保持原状态）", error);
            return undefined;
          }
          return markFailed(next, String(error?.message || error));
        });
      }
      } finally {
        running = false;
      }
    })();
  }

  function markFailed(job, message) {
    job.status = FAILED;
    job.error = message;
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    const written = chainPersist(job);
    notifyChanged(job);
    return written;
  }

  async function execute(job) {
    job.status = RUNNING;
    job.error = "";
    job.evaluationProfile ||= evaluationProfileForContentType(job.scope?.contentType);
    job.updatedAt = now();
    await persist(job);
    notifyChanged(job);

    // Fail fast when the pairing is already stale, before spending model calls.
    const [liveChampion, liveCandidate] = await Promise.all([deps.getSkill(job.championId, job.scope), deps.getSkill(job.challengerId, job.scope)]);
    const currentChampion = await deps.getCurrentChampion(job.scope);
    const initialValidation = deps.validatePromotionState({ candidate: liveCandidate, currentChampion });
    if (!initialValidation.valid || currentChampion?.id !== job.championId) {
      await markFailed(job, initialValidation.reasons.join("；") || "评测对应的生效版本已过期");
      return;
    }

    // Old checkpoints may be resumed only when they have not generated any
    // samples yet. Mixing old live-retrieval samples with a new frozen snapshot
    // would produce an unauditable comparison.
    if (!job.benchmarkSnapshot && typeof createSnapshot === "function") {
      if (Object.keys(job.caseSamples || {}).length) {
        await markFailed(job, "旧版评测检查点缺少输入快照，已有样本不能与新版可复现评测混用，请重新发起评测");
        return;
      }
      const allTrajectories = job.requestedCaseIds.map((caseId) => job.caseTrajectories[caseId]).filter(Boolean);
      job.benchmarkSnapshot = await createSnapshot({
        scope: job.scope,
        trajectories: allTrajectories,
        champion: liveChampion,
        challenger: liveCandidate
      });
      job.snapshotFingerprint = benchmarkSnapshotFingerprint({
        benchmark: job.benchmarkSnapshot?.fingerprint || job.benchmarkSnapshot,
        champion: benchmarkVariantFingerprintInput(job.championVariant || liveChampion),
        challenger: benchmarkVariantFingerprintInput(job.challengerVariant || liveCandidate),
        trajectories: job.caseTrajectories,
        evaluationProfile: job.evaluationProfile
      });
      await persist(job);
    }

    if (!job.snapshotFingerprint) {
      job.snapshotFingerprint = benchmarkSnapshotFingerprint({
        benchmark: job.benchmarkSnapshot?.fingerprint || job.benchmarkSnapshot,
        champion: benchmarkVariantFingerprintInput(job.championVariant || liveChampion),
        challenger: benchmarkVariantFingerprintInput(job.challengerVariant || liveCandidate),
        trajectories: job.caseTrajectories,
        evaluationProfile: job.evaluationProfile
      });
    }
    if (job.forceRegenerate !== true && Object.keys(job.caseSamples || {}).length === 0) {
      const reusable = [...jobs.values()].reverse().find((other) => other.jobId !== job.jobId
        && other.status === COMPLETED
        && other.championId === job.championId
        && other.challengerId === job.challengerId
        && other.snapshotFingerprint === job.snapshotFingerprint
        && Object.keys(other.caseSamples || {}).length === job.requestedCaseIds.length
        && Object.keys(other.caseFailures || {}).length === 0);
      if (reusable) {
        job.caseSamples = cloneJson(reusable.caseSamples);
        job.reusedFromJobId = reusable.jobId;
        job.updatedAt = now();
        await persist(job);
      }
    }

    const champion = job.championVariant || liveChampion;
    const candidate = job.challengerVariant || liveCandidate;

    const trajectories = job.requestedCaseIds
      .filter((caseId) => !job.caseSamples[caseId] && !job.caseFailures[caseId])
      .map((caseId) => job.caseTrajectories[caseId])
      .filter(Boolean);

    if (trajectories.length) {
      await runPairedSkillBenchmarks({
        trajectories,
        champion,
        challenger: candidate,
        benchmark,
        concurrency,
        snapshot: job.benchmarkSnapshot || null,
        evaluationProfile: job.evaluationProfile,
        scope: job.scope,
        onProgress: (progress) => {
          if (progress.status === "fulfilled") {
            job.caseSamples[progress.caseId] = {
              champion: progress.championSamples?.length ? progress.championSamples : sampleArray(progress.championSample),
              challenger: progress.challengerSamples?.length ? progress.challengerSamples : sampleArray(progress.challengerSample)
            };
          } else if (progress.caseId) {
            job.caseFailures[progress.caseId] = progress.error || "评测失败";
            job.caseFailureCodes[progress.caseId] = String(progress.errorCode || "");
          }
          job.updatedAt = now();
          chainPersist(job);
          notifyChanged(job);
        }
      });
      await job._persistChain;
    }

    // 仅补跑执行失败的配对，成功样本和冻结快照保留；次数写入检查点，重启不重置。
    if (!stopping && Object.keys(job.caseFailures).length && (Number(job.automaticRetryCount) || 0) < automaticRetryLimit) {
      job.automaticRetryCount = (Number(job.automaticRetryCount) || 0) + 1;
      job.lastAutomaticFailures = { ...job.caseFailures };
      job.caseFailures = {};
      job.caseFailureCodes = {};
      job.status = QUEUED;
      job.updatedAt = now();
      await persist(job);
      notifyChanged(job);
      return;
    }

    const championSamples = flattenVariantSamples(job, "champion");
    const challengerSamples = flattenVariantSamples(job, "challenger");
    const failures = job.requestedCaseIds.filter((caseId) => job.caseFailures[caseId]).map((caseId) => ({
      caseId,
      error: job.caseFailures[caseId],
      code: String(job.caseFailureCodes?.[caseId] || "")
    }));
    // 失败分成"模型没产出译文"和"接口/质检报错"两类：前者可以直接只重试失败样本，
    // 后者要看上游状态。报告里分开写，用户才知道该点哪个按钮。
    const missingTranslations = failures.filter((item) => item.code === "empty_translation").length;
    const failureReasons = [...failures.reduce((counts, item) => {
      const key = item.code || item.error || "其他错误";
      counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map()).entries()].map(([reason, count]) => ({ reason, count }));

    const repetitions = Math.max(1, Math.trunc(Number(job.evaluationProfile?.repetitions) || 1));
    const evaluationGuardrails = { ...guardrails, requireCost: job.requireCost === true };
    const result = evaluateSkillPromotion({
      scope: job.scope,
      champion: { id: job.championId, scope: job.scope, samples: championSamples },
      challenger: { id: job.challengerId, scope: job.scope, samples: challengerSamples },
      // Every paired case must complete for a real conclusion; a single failed
      // pair makes the whole run insufficient instead of pretending a zero.
      minSamples: job.requestedCaseIds.length * repetitions,
      minimumCoverage: 0.8,
      guardrails: evaluationGuardrails
    });
    const repeatConclusions = Array.from({ length: repetitions }, (_, repetition) => {
      const championRepeat = championSamples.filter((sample) => Number(sample.repetition || 0) === repetition);
      const challengerRepeat = challengerSamples.filter((sample) => Number(sample.repetition || 0) === repetition);
      const repeatResult = evaluateSkillPromotion({
        scope: job.scope,
        champion: { id: job.championId, scope: job.scope, samples: championRepeat },
        challenger: { id: job.challengerId, scope: job.scope, samples: challengerRepeat },
        minSamples: job.requestedCaseIds.length,
        minimumCoverage: 0.8,
        guardrails: evaluationGuardrails
      });
      return {
        repetition: repetition + 1,
        status: repeatResult.status,
        qaDelta: repeatResult.deltas.qaScore,
        editDistanceDelta: repeatResult.deltas.humanEditDistance
      };
    });
    const report = deps.buildUiReport(result);
    report.benchmark = {
      requestedPairs: job.requestedCaseIds.length,
      completedPairs: Object.keys(job.caseSamples).length,
      completedDraws: championSamples.length,
      repetitions,
      failedPairs: failures.length,
      failures: failures.slice(0, 10),
      missingTranslations,
      failureReasons,
      isolation: [...championSamples, ...challengerSamples].reduce((summary, sample) => {
        const isolation = sample?.isolation || {};
        return {
          excludedMemories: summary.excludedMemories + (isolation.excludedMemories || 0),
          excludedQaCases: summary.excludedQaCases + (isolation.excludedQaCases || 0),
          excludedStyleExamples: summary.excludedStyleExamples + (isolation.excludedStyleExamples || 0),
          excludedUserProfileExamples: summary.excludedUserProfileExamples + (isolation.excludedUserProfileExamples || 0),
          totalExcluded: summary.totalExcluded + (isolation.totalExcluded || 0)
        };
      }, { excludedMemories: 0, excludedQaCases: 0, excludedStyleExamples: 0, excludedUserProfileExamples: 0, totalExcluded: 0 })
    };
    const seedWarnings = [...new Set([...championSamples, ...challengerSamples]
      .flatMap((sample) => sample?.reproducibility?.warnings || []).filter(Boolean))];
    const withinRunClasses = new Set(repeatConclusions.map((item) => conclusionClass(item.status)).filter((value) => value !== "inconclusive"));
    const comparablePriorRuns = [...jobs.values()].filter((other) => other.jobId !== job.jobId
      && other.status === COMPLETED
      && other.championId === job.championId
      && other.challengerId === job.challengerId
      && other.snapshotFingerprint
      && other.snapshotFingerprint === job.snapshotFingerprint
      && other.result?.report?.reproducibility?.policyVersion === job.evaluationProfile?.policyVersion);
    const currentClass = conclusionClass(result.status);
    const priorClasses = new Set(comparablePriorRuns.map((other) => conclusionClass(other.result?.report?.status)).filter((value) => value !== "inconclusive"));
    const contradictoryPriorRun = currentClass !== "inconclusive" && priorClasses.size > 0 && !priorClasses.has(currentClass);
    const unstable = withinRunClasses.size > 1 || contradictoryPriorRun;
    report.reproducibility = {
      policyVersion: job.evaluationProfile?.policyVersion || "legacy",
      mode: job.evaluationProfile?.mode || "legacy",
      repetitions,
      sourceCaseCount: job.requestedCaseIds.length,
      completedDraws: championSamples.length,
      translationTemperature: job.evaluationProfile?.translationTemperature,
      qaTemperature: job.evaluationProfile?.qaTemperature,
      seedRequested: job.evaluationProfile?.seedRequested === true,
      seedSupported: seedWarnings.length === 0,
      warnings: seedWarnings,
      snapshotFingerprint: String(job.snapshotFingerprint || ""),
      assetSnapshotFingerprint: String(job.benchmarkSnapshot?.fingerprint || ""),
      model: String(job.benchmarkSnapshot?.provider?.model || ""),
      promptVersion: String(job.benchmarkSnapshot?.promptVersion || ""),
      repeatConclusions,
      comparablePriorRuns: comparablePriorRuns.length,
      reusedFromJobId: String(job.reusedFromJobId || ""),
      stable: !unstable
    };
    const reproducibilityBasis = repetitions > 1
      ? `本次按 ${repetitions} 轮配对采样比较均值，并检查各轮结论是否一致`
      : "本次使用低温度与固定 seed 的确定性回归模式";
    const reuseBasis = job.reusedFromJobId
      ? `；输入未变化，本次复用任务 ${job.reusedFromJobId.slice(0, 8)} 已保存的真实输出，只按当前门禁重新判定`
      : "";
    report.evaluationBasis = `${report.evaluationBasis || ""}${report.evaluationBasis ? "；" : ""}${reproducibilityBasis}；术语、记忆、QA、风格、画像、模型和提示词版本已冻结为快照 ${String(job.snapshotFingerprint || "").slice(0, 12)}${reuseBasis}。`;
    if (unstable && !failures.length) {
      result.promotable = false;
      result.status = "unstable";
      report.promotable = false;
      report.status = "unstable";
      report.conclusion = `结果不稳定，暂不形成晋升结论：${withinRunClasses.size > 1 ? "同一次评测的多轮配对采样得出了相反结论" : "相同冻结输入的近期评测结论互相矛盾"}。系统已禁止把这次随机波动当作「生效版本 / 候选版本」的真实优劣。`;
    }
    if (failures.length) {
      report.promotable = false;
      report.status = "insufficient";
      const breakdown = missingTranslations
        ? `其中 ${missingTranslations} 组是模型没有产出译文（不是候选翻译质量差），可以只重试这些失败样本。`
        : "";
      report.conclusion = `评测未完成：${failures.length} 组「生效版本 / 候选版本」对照在翻译或独立 AIQA 阶段失败。${breakdown}失败样本不会按“零问题”计分，本次结果禁止晋升。`;
    }

    // Revalidate after the potentially long benchmark: the champion may have
    // changed or the candidate may have been rejected while model calls ran.
    const [refreshedCandidate, refreshedChampion] = await Promise.all([deps.getSkill(job.challengerId, job.scope), deps.getCurrentChampion(job.scope)]);
    const revalidation = deps.validatePromotionState({ candidate: refreshedCandidate, currentChampion: refreshedChampion });
    if (!revalidation.valid) {
      await markFailed(job, revalidation.reasons.join("；"));
      return;
    }

    const evaluation = await deps.saveEvaluation({
      ...job.scope,
      championSkillId: refreshedChampion.id,
      challengerSkillId: refreshedCandidate.id,
      sampleCount: championSamples.length,
      championMetrics: result.championMetrics,
      challengerMetrics: result.challengerMetrics,
      metricDeltas: result.deltas,
      decision: report.promotable === true ? "promote" : report.status === "reject" ? "reject" : "needs_review",
      report,
      evaluator: "kami-learning-engine-v2"
    });
    await deps.updateSkillMetrics(refreshedCandidate.id, result.challengerMetrics);

    job.result = { evaluationId: String(evaluation?.id || ""), report };
    job.status = COMPLETED;
    job.error = "";
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    await persist(job);
    notifyChanged(job);
    if (typeof onCompleted === "function") {
      try {
        await onCompleted(publicJob(job));
      } catch (error) {
        // 评测结论已经可靠持久化；后续门禁编排失败只记警告，不能把已完成的评测伪装成失败。
        job.completionHookWarning = String(error?.message || error);
        await persist(job);
      }
    }
    // 所有落盘都完成后才释放内存里的快照：磁盘上留着完整的一份，内存里只留结论。
    releaseCompletedPayload(job);
  }

  return {
    async initialize() {
      await restoreFromDisk();
    },
    async recover() {
      if (stopping) return;
      for (const job of jobs.values()) {
        if (job.status !== INTERRUPTED) continue;
        job.status = QUEUED;
        job.error = "";
        job.updatedAt = now();
        await persist(job);
        notifyChanged(job);
      }
      pumpQueue();
    },
    async stop() {
      stopping = true;
      await runningPromise;
      for (const job of jobs.values()) {
        if (job.status !== QUEUED) continue;
        job.status = INTERRUPTED;
        job.error = "工作台已停止，可续跑剩余样本";
        job.updatedAt = now();
        await persist(job);
        notifyChanged(job);
      }
      await Promise.allSettled([...changeChains.values()]);
    },
    async create({ scope, champion, challenger, trajectories, requireCost = false, forceRegenerate = false }) {
      if (stopping) throw new Error("评测队列已停止");
      const evaluationProfile = evaluationProfileForContentType(scope?.contentType);
      const [resolvedChampion, resolvedChallenger] = await Promise.all([
        deps.getSkill(String(champion.id || ""), scope),
        deps.getSkill(String(challenger.id || ""), scope)
      ]);
      const frozenChampion = cloneJson(resolvedChampion || champion);
      const frozenChallenger = cloneJson(resolvedChallenger || challenger);
      const caseTrajectories = Object.fromEntries(trajectories.map((item) => [String(item.id || ""), persistableTrajectory(item)]));
      const job = {
        jobId: randomUUID(),
        kind,
        scope,
        championId: String(champion.id || ""),
        challengerId: String(challenger.id || ""),
        championVariant: frozenChampion,
        challengerVariant: frozenChallenger,
        requireCost: requireCost === true,
        modelRoute: runtimeOptions().modelRoute ? { provider: runtimeOptions().modelRoute.provider, model: runtimeOptions().modelRoute.model } : undefined,
        automaticRetryCount: 0,
        requestedCaseIds: trajectories.map((item) => String(item.id || "")).filter(Boolean),
        caseTrajectories,
        caseSamples: {},
        caseFailures: {},
        // 失败原因码（如 empty_translation）：报告里要能区分"模型没产出译文"和"接口报错"。
        caseFailureCodes: {},
        evaluationProfile,
        benchmarkSnapshot: null,
        snapshotFingerprint: "",
        reusedFromJobId: "",
        forceRegenerate: forceRegenerate === true,
        status: QUEUED,
        result: null,
        error: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: ""
      };
      jobs.set(job.jobId, job);
      callContexts.set(job.jobId, { ...runtimeOptions(), modelRoute: runtimeOptions().modelRoute || job.modelRoute });
      await persist(job);
      notifyChanged(job);
      pumpQueue();
      return publicJob(job);
    },
    get(jobId) {
      const job = jobs.get(String(jobId));
      return job ? publicJob(job) : null;
    },
    list(scope = null) {
      const matchesScope = (job) => !scope || ["locale", "project"].every((field) => job.scope?.[field] === scope[field]);
      return [...jobs.values()].filter(matchesScope).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(publicJob);
    },
    findActiveForChallenger(challengerId) {
      const active = [...jobs.values()].find((job) => job.challengerId === String(challengerId) && !TERMINAL_STATUSES.has(job.status));
      return active ? publicJob(active) : null;
    },
    async resume(jobId) {
      if (stopping) throw new Error("评测队列已停止");
      const job = jobs.get(String(jobId));
      if (!job) return null;
      if (!RESUMABLE_STATUSES.has(job.status)) return publicJob(job);
      if (Object.keys(job.caseSamples).length >= job.requestedCaseIds.length) return publicJob(job);
      job.status = QUEUED;
      callContexts.set(job.jobId, { ...runtimeOptions(), modelRoute: runtimeOptions().modelRoute || job.modelRoute });
      job.error = "";
      job.updatedAt = now();
      await persist(job);
      notifyChanged(job);
      pumpQueue();
      return publicJob(job);
    },
    /**
     * 只重试失败的样本。
     *
     * 以前一条评测挂掉一组就只能「重新评测」——27 组样本全部重跑一遍，模型调用白烧一遍。
     * 这里把 caseFailures 清空后重新入队：execute() 只会跑"既没有样本也没有失败记录"
     * 的 case，也就是刚才失败的那几组，已成功的样本原样沿用。
     */
    async retryFailed(jobId) {
      if (stopping) throw new Error("评测队列已停止");
      const job = jobs.get(String(jobId));
      if (!job) return null;
      // 只有跑完/中断/失败的任务才谈得上"重试失败样本"：正在排队或正在跑的别插队。
      if (![COMPLETED, FAILED, INTERRUPTED].includes(job.status)) return publicJob(job);
      if (!Object.keys(job.caseFailures || {}).length) return publicJob(job);
      if (!job.benchmarkSnapshot) {
        // 已完成的检查点会把输入快照从内存里放掉（实测 77MB JSON），而只重试失败样本
        // 必须用同一份冻结输入重跑，所以从磁盘读回来；磁盘上也没有就只能重新发起完整评测。
        try {
          const persisted = JSON.parse(await readFile(await jobPath(job.jobId), "utf8"));
          if (persisted?.benchmarkSnapshot) job.benchmarkSnapshot = persisted.benchmarkSnapshot;
        } catch { /* 读不出来就走下面这条明确失败 */ }
        if (!job.benchmarkSnapshot) {
          const error = new Error("这份评测检查点缺少输入快照，无法只重试失败样本，请重新发起完整评测");
          error.statusCode = 409;
          throw error;
        }
      }
      job.caseFailures = {};
      job.caseFailureCodes = {};
      job.status = QUEUED;
      callContexts.set(job.jobId, { ...runtimeOptions(), modelRoute: runtimeOptions().modelRoute || job.modelRoute });
      job.error = "";
      job.finishedAt = "";
      job.updatedAt = now();
      await persist(job);
      notifyChanged(job);
      pumpQueue();
      return publicJob(job);
    },
    /**
     * 调用方往检查点上记自己的关联信息（目前只有任务中心的记录 id）。
     * 走检查点而不是另存一张映射表：重启后照样能接回同一条任务记录。
     */
    async patch(jobId, fields = {}) {
      const job = jobs.get(String(jobId));
      if (!job) return null;
      Object.assign(job, fields);
      await persist(job);
      return publicJob(job);
    },
    /**
     * 明确终止一个任务（候选已经被拒绝、配对已经过期……）。
     * 这类任务永远续跑不了，必须落到终态：否则每个客户端每轮轮询都会再试一次续跑，
     * 日志会被 409 刷屏（实测每 4 秒一条）。
     */
    async fail(jobId, reason = "") {
      const job = jobs.get(String(jobId));
      if (!job) return null;
      if (TERMINAL_STATUSES.has(job.status)) return publicJob(job);
      await markFailed(job, String(reason || "评测任务已终止"));
      return publicJob(job);
    }
  };
}

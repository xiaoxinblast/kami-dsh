import { renderTranslationMarkup } from "./term-highlighter.js";
import { segmentIds, segmentMatchesQuery, segmentNotes } from "./segment-search.js";
import { learningEvaluationResult } from "./learning-utils.js";
import { styleProfileDiff } from "./style-utils.js";
import { batchQualityReportPending, buildBatchWorkflow, summarizeBatchSegments } from "./batch-status.js";
import { startWorkbenchSession } from "./session-lifecycle.js";
import { groupTaskEntries, taskEntryStatus } from "./task-groups.js";
import { createProjectSettingsPanel } from "./project-settings.js";
import { createProjectWizard } from "./project-wizard.js";
import { createParameterSettingsPanel, createProviderSettingsPanel } from "./settings-panels.js";

startWorkbenchSession();

const state = {
  bootstrap: null,
  projects: [],
  activeProjectId: "",
  activeProject: null,
  serverVersion: "0.0.0",
  view: "workbench",
  workbenchLocale: "zh-CN",
  assetLocale: "zh-CN",
  styleLocale: "zh-CN",
  learningLocale: "zh-CN",
  autoQaLocale: "zh-CN",
  qaSource: "batch",
  qaSegments: [],
  qaFilter: "",
  qaCursor: -1,
  qaResult: null,
  qaFile: null,
  memoryLocale: "zh-CN",
  learningData: null,
  learningLoading: false,
  learningSelectedSkillId: "",
  // 学习中心是项目级单流水线：这里只记当前选中的技能版本。
  learningScope: null,
  learningStep: "",
  learningEvidence: { items: [], total: 0, hasMore: false, loading: false },
  trainingTotal: 0,
  trainingHasMore: false,
  // 正在跑的评测任务：状态放在这里，页面重绘后按钮不会退回"运行评测"。
  learningEvaluationJobs: [],
  conflictReport: null,
  referenceDocuments: [],
  referenceFolders: [],
  referenceLibraries: [],
  referenceFolderId: "",
  referenceTotal: 0,
  referenceOffset: 0,
  referenceSelection: { documents: new Set(), folders: new Set() },
  referenceExpanded: new Set(),
  referenceLoading: false,
  referenceVisionMode: "all",
  referenceAutoScan: true,
  referenceDragPayload: null,
  referenceDropFolderId: "",
  referenceContextTarget: null,
  referenceStatus: "",
  referenceSearch: "",
  referenceDetail: null,
  tasks: [],
  taskFilter: "",
  taskGroupExpanded: new Set(),
  // 通知中心：由任务列表 + 待处理 QA 案例推导，未读只记一个时间点。
  notifications: [],
  notificationHighlight: null,
  styleData: null,
  memories: [],
  memoryTotal: 0,
  // 术语库 / 记忆库按"库"管理：库列表 + 选中库后的条目视图。
  assetLibraries: [],
  memoryLibraries: [],
  assetLibraryId: "",
  memoryLibraryId: "",
  assetEntries: [],
  assetEntryTotal: 0,
  memoryEntryTotal: 0,
  importTermLibraryId: "",
  importTmLibraryId: "",
  memoryImportTargetId: "",
  // TM 库的第三层：当前打开的来源文件（""=停在文件列表，__none__=未标注来源）。
  memoryLibraryFile: "",
  memoryLibraryFiles: [],
  memoryImportFile: null,
  memoryImportPreview: null,
  styleGuideFile: null,
  batchTab: "setup",
  batchWorkflow: null,
  termFilter: "",
  batchSegmentQuery: "",
  lastResult: null,
  importFile: null,
  importFiles: [],
  assetPreflight: null,
  assetImportIntent: "auto",
  assetImportReturnView: "",
  assetImportPurpose: "term",
  assetImportAiCleaning: false,
  assetImportStyleEvidence: false,
  assetImportTaskId: "",
  assetImportWizard: false,
  assetImportStartedAt: 0,
  assetImportProgress: null,
  assetImportTicker: 0,
  memoryImportFiles: [],
  memoryStyleEvidence: true,
  importPreview: null,
  importCompleted: false,
  importCandidateTab: "terms",
  importVisibleCount: { terms: 150, styles: 150 },
  importBatchLearning: [],
  busy: false,
  activeSuggestion: null,
  // 翻译视图的默认落地是"文件列表"，单句输入与当前文件各是一个标签。
  translationMode: "files",
  batchFiles: [],
  batchFilesLoading: false,
  batchFileStatus: "",
  batchFileSearch: "",
  /** 上次打开的文件：只在列表里高亮 +「继续」，不自动跳到批次页。 */
  lastBatchId: "",
  batchFile: null,
  batchBase64: "",
  batchPreview: null,
  batchRunning: false,
  batchPaused: false,
  batchCancelling: false,
  logs: [],
  logLevel: "",
  logSearch: "",
  logErrorCount: 0,
  reviewImportBatchId: "",
  batchHasStoredOriginal: false,
  batchSegmentFilter: "",
  batchQaCursor: -1,
  batchClassification: null,
  batchStyleProfile: null,
  // 语境档案（整份文件的用途区间）与质量报告：翻译前/翻译后的两份整体结论。
  batchBrief: null,
  batchBriefPending: false,
  batchBriefDraft: null,
  batchReport: null,
  projectSettings: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function supportsBatchApi(version) {
  const [major, minor] = String(version || "0.0.0").split(".").map(Number);
  return major > 0 || minor >= 5;
}

/** Directus 的压力保护（503 Under pressure）是"我很忙"，不是"我坏了"：值得等一下再试。 */
const DIRECTUS_BUSY_RETRY_MS = 1_500;

function isDirectusBusyError(error) {
  if (Number(error?.status) === 503) return true;
  return /Under pressure|Service "api" is unavailable|压力保护/u.test(String(error?.message || ""));
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}, { logFailure = true } = {}) {
  const send = async () => {
    let response;
    try {
      response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
    } catch (error) {
      // fetch 直接抛错说明请求根本没到服务端（工作台在重启 / 已停止 / 连接被掐断），
      // 这时浏览器只会给一句 Failed to fetch，对用户没有任何指导意义。
      const detail = String(error?.message || "");
      const generic = /Failed to fetch|Load failed|NetworkError|network error/iu.test(detail);
      const message = generic
        ? "连不上工作台：可能正在重启或已停止，请刷新页面后重试"
        : `请求失败（${detail}）：请确认工作台仍在运行`;
      throw Object.assign(new Error(message), { offline: true, detail });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error || `请求失败：${response.status}`;
      throw Object.assign(new Error(message), { status: response.status, body: payload });
    }
    return payload;
  };
  try {
    return await send();
  } catch (error) {
    const canLog = logFailure && !String(path).startsWith("/api/logs");
    // 压力保护值得自动重试一次：批次/任务这些轮询接口遇上 503 时，
    // 用户不该看到一屏红字，稍等一秒半再试通常就成功了。
    if (!isDirectusBusyError(error)) {
      // 界面上只闪一句提示，同时把原始信息写进日志，事后能查。
      if (canLog) {
        if (error.offline) recordClientLog("error", `请求未送达：${options.method || "GET"} ${path}`, String(error.detail || ""));
        else recordClientLog("error", `${options.method || "GET"} ${path} → HTTP ${error.status || ""}`.trim(), String(error.message || ""));
      }
      throw error;
    }
    await sleepMs(DIRECTUS_BUSY_RETRY_MS);
    try {
      return await send();
    } catch (retryError) {
      const detail = String(retryError?.message || "");
      if (canLog) recordClientLog("warn", `${options.method || "GET"} ${path} 遇 Directus 压力保护，自动重试后仍失败`, detail);
      throw new Error("Directus 正忙（服务压力保护）：已自动重试一次仍未成功，稍等片刻再试即可，数据没有丢");
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function projectPayload() {
  return state.activeProjectId ? { projectId: state.activeProjectId } : {};
}

/**
 * 语体与领域不再让用户逐段配置：翻译路径统一按自动识别走，需要人工纠正时
 * 改语境档案里的区间用途（整份文件一次），而不是在每个请求上手填两个下拉框。
 */
function scopePayload() {
  return { contentType: "auto", domain: "auto" };
}

function renderProjectSelector() {
  const select = $("#projectSelect");
  if (!select) return;
  select.innerHTML = state.projects.length
    ? state.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === state.activeProjectId ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("")
    : '<option value="">暂无项目</option>';
  select.disabled = !state.projects.length;
  const hasProject = Boolean(state.projects.length);
  const settingsButton = $("#openProjectSettings");
  const deleteButton = $("#deleteProject");
  if (settingsButton) settingsButton.disabled = !hasProject;
  if (deleteButton) deleteButton.disabled = !hasProject;
}

async function loadProjects() {
  const payload = await api("/api/projects");
  state.projects = Array.isArray(payload.projects) ? payload.projects : [];
  if (!state.projects.length) {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "默认项目", description: "日语到简体中文本地化项目" }) });
    state.projects = [created.project];
  }
  const saved = localStorage.getItem("kami-project-id");
  state.activeProjectId = state.projects.some((project) => project.id === saved) ? saved : state.projects[0].id;
  state.activeProject = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
  state.projectSettings = state.activeProject.settings || null;
  localStorage.setItem("kami-project-id", state.activeProjectId);
  renderProjectSelector();
}

async function selectProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || project.id === state.activeProjectId) return;
  state.activeProjectId = project.id;
  state.activeProject = project;
  state.projectSettings = project.settings || null;
  state.referenceFolderId = "";
  state.referenceFolders = [];
  state.referenceDocuments = [];
  state.referenceSelection = { documents: new Set(), folders: new Set() };
  state.referenceExpanded = new Set();
  localStorage.setItem("kami-project-id", project.id);
  renderProjectSelector();
  await loadAssets(state.assetLocale);
  await loadMemories(state.memoryLocale);
  if (state.view === "references") await loadReferences();
  toast(`已切换到项目：${project.name}`);
}

async function createProjectFromWizard({ name, description }) {
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ name, description }) });
  state.projects = [...state.projects, created.project];
  state.activeProjectId = created.project.id;
  state.activeProject = created.project;
  state.projectSettings = created.project.settings || null;
  localStorage.setItem("kami-project-id", created.project.id);
  renderProjectSelector();
  await Promise.all([loadAssets(state.assetLocale), loadMemories(state.memoryLocale)]);
  return created.project;
}

async function importWizardSource(file) {
  const accepted = await setBatchFile(file);
  if (accepted === false) throw new Error("已取消列含义确认，请重新选择待译文件");
  if (!state.batchPreview) throw new Error("待译文件解析失败，请检查文件内容");
  return { filename: file.name };
}

async function importWizardTerms(files, { aiCleaning = false, styleEvidence = false } = {}) {
  // 向导的术语库步骤固定按"术语表"导入；等预检弹窗被处理完再推进下一步。
  const outcome = await setImportFiles(files, {
    intent: "terms",
    purpose: "term",
    aiCleaning,
    styleEvidence,
    returnView: "workbench",
    fromWizard: true
  });
  if (!outcome?.submitted) return { submitted: false };
  return {
    submitted: true,
    count: outcome.count,
    files: files.length,
    taskId: outcome.taskId,
    batchId: outcome.batchId || state.assetPreflight?.batchId || "",
    aiCleaning: Boolean(outcome.aiCleaning)
  };
}

async function previewWizardTm(file) {
  return api("/api/tm-import/preview", { method: "POST", body: JSON.stringify({ ...projectPayload(), filename: file.name, base64: await fileToBase64(file) }) });
}

async function commitWizardTm(preview, { styleEvidence = true } = {}) {
  const candidates = (preview.candidates || []).map((candidate) => ({ ...candidate, selected: true }));
  // 向导的这一步只负责提交：写入走后台任务，免得卡在"下一步"上几分钟。
  return api("/api/tm-import/commit", { method: "POST", body: JSON.stringify({ ...projectPayload(), batchId: preview.batchId, filename: preview.filename, candidates, styleEvidence, background: true }) });
}

async function importWizardStyleGuide(file) {
  return importStyleGuideFile(file, state.styleLocale);
}

function finishProjectWizard(summary = []) {
  const parts = summary.filter(Boolean);
  toast(parts.length ? `项目初始化完成：${parts.slice(0, 3).join("；")}` : "项目已创建，可稍后在项目设置中继续配置");
}

let projectWizard;
function getProjectWizard() {
  projectWizard ||= createProjectWizard($("#projectDialog"), {
    onCreateProject: createProjectFromWizard,
    onImportSource: importWizardSource,
    onImportTerms: importWizardTerms,
    onPreviewTm: previewWizardTm,
    onCommitTm: commitWizardTm,
    onImportStyleGuide: importWizardStyleGuide,
    onOpenQaSettings: () => openProjectSettings({ tab: "qa" }),
    onFinished: finishProjectWizard
  });
  return projectWizard;
}

function openDeleteProjectDialog() {
  if (!state.projects.length) return toast("当前没有可删除的项目");
  $("#deleteProjectList").innerHTML = state.projects.map((project) => `
    <label class="project-delete-row">
      <input type="checkbox" value="${escapeHtml(project.id)}" ${project.id === state.activeProjectId ? "checked" : ""} />
      <span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.description || "未填写项目说明")}</small></span>
      ${project.id === state.activeProjectId ? '<em>当前项目</em>' : ""}
    </label>`).join("");
  $("#deleteProjectSelectAll").checked = false;
  $("#deleteProjectData").checked = false;
  updateDeleteSelection();
  updateDeleteConfirmLabel();
  $("#deleteProjectDialog").showModal();
}

function updateDeleteSelection() {
  const rows = $$("#deleteProjectList input[type=checkbox]");
  const selected = rows.filter((input) => input.checked);
  $("#deleteProjectCount").textContent = `已选 ${selected.length} 个`;
  $("#deleteProjectSelectAll").checked = rows.length > 0 && selected.length === rows.length;
  $("#deleteProjectConfirm").disabled = selected.length === 0;
}

function updateDeleteConfirmLabel() {
  const purge = Boolean($("#deleteProjectData")?.checked);
  $("#deleteProjectConfirm").textContent = purge ? "永久删除选中项目" : "删除选中项目";
}

async function deleteProjectFromDialog(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submitButton = formElement.querySelector('button[type="submit"]');
  const projectIds = $$("#deleteProjectList input[type=checkbox]:checked").map((input) => input.value);
  const purge = Boolean($("#deleteProjectData")?.checked);
  if (!projectIds.length) return toast("请至少选择一个项目");
  if (purge && !confirm(`确认永久删除选中的 ${projectIds.length} 个项目及其全部后台数据？此操作无法撤销。`)) return;
  submitButton.disabled = true;
  submitButton.textContent = "正在删除…";
  try {
    const results = await Promise.allSettled(projectIds.map((projectId) => api(`/api/projects/${encodeURIComponent(projectId)}${purge ? "?purge=1" : ""}`, { method: "DELETE" })));
    const failed = results.filter((result) => result.status === "rejected");
    $("#deleteProjectDialog").close();
    $("#deleteProjectData").checked = false;
    await loadProjects();
    await loadAssets(state.assetLocale);
    await loadMemories(state.memoryLocale);
    if (failed.length) toast(`已删除 ${projectIds.length - failed.length} 个项目，${failed.length} 个失败：${failed[0].reason?.message || "未知错误"}`);
    else toast(purge ? `已永久删除 ${projectIds.length} 个项目及后台数据` : `已从工作台移除 ${projectIds.length} 个项目`);
  } catch (error) { toast(error.message); }
  finally {
    submitButton.disabled = false;
    updateDeleteConfirmLabel();
  }
}

let projectSettingsPanel;
async function openProjectSettings({ tab = "libraries", addKind = "" } = {}) {
  if (!state.activeProjectId) return toast("请先选择项目");
  const button = $("#openProjectSettings");
  button.disabled = true;
  try {
    const [project, libraryPayload] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(state.activeProjectId)}`),
      api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries`)
    ]);
    projectSettingsPanel ||= createProjectSettingsPanel($("#projectSettingsDialog"), {
      api,
      onSaved(project) {
        state.activeProject = project;
        state.projectSettings = project.settings;
        state.projects = state.projects.map((item) => item.id === project.id ? project : item);
        renderProjectSelector();
        toast("项目设置已保存");
        // 资源库是术语库 / 记忆库页的同一份数据：保存后两个页面的库列表与导入下拉都要跟着更新。
        Promise.all([loadAssetsSafeRefresh("term"), loadAssetsSafeRefresh("tm")]).catch(() => {});
      }
    });
    projectSettingsPanel.open(project, Array.isArray(libraryPayload.libraries) ? libraryPayload.libraries : [], { initialTab: tab, addKind });
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

/**
 * 术语库 / 记忆库 / 导入页共用的「＋ 新增库」入口：直接打开项目设置面板的资源库页，
 * 并把目标类型的新库草稿摆好——新增与优先级都留在同一个面板里，避免两套库 CRUD。
 */
function openProjectLibraries({ addKind = "" } = {}) {
  return openProjectSettings({ tab: "libraries", addKind });
}

let toastTimer;
let batchSaveChain = Promise.resolve();
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3000);
}

function setBusy(busy, label) {
  state.busy = busy;
  const button = $("#primaryAction");
  button.disabled = busy;
  if (busy && label) button.textContent = label;
  if (!busy) refreshActions();
}

function updateImportProgress(progress = {}) {
  const container = $("#importProgress");
  if (!container) return;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  container.hidden = false;
  $("#importProgressText").textContent = progress.message || "正在识别与清洗";
  const batchMeta = Number(progress.total) > 0 ? ` · ${Number(progress.completed) || 0} / ${progress.total} 批` : "";
  const concurrencyMeta = progress.concurrency ? ` · ${progress.concurrency} 路并发` : "";
  $("#importProgressMeta").textContent = `${percent}%${batchMeta}${concurrencyMeta}`;
  $("#importProgressBar").style.width = `${percent}%`;
}

async function watchImportProgress(progressId, control) {
  while (!control.done) {
    try {
      const response = await fetch(`/api/term-import/progress/${encodeURIComponent(progressId)}`, { cache: "no-store" });
      if (response.ok) {
        const progress = await response.json();
        updateImportProgress(progress);
        if (progress.status === "completed" || progress.status === "failed") return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function renderLocaleStrip(container, selected, onSelect) {
  container.innerHTML = Object.entries(state.bootstrap.locales).map(([locale, details]) => `
    <button class="locale-button ${selected === locale ? "active" : ""}" data-locale="${locale}">
      <img class="locale-flag" src="${escapeHtml(details.flagAsset)}" alt="" aria-hidden="true" />
      <span>${details.label}</span>
    </button>
  `).join("");
  container.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => onSelect(button.dataset.locale)));
}

function pageCopy(view) {
  if (view === "learning") return ["LEARNING CENTER", "学习中心", "将翻译轨迹沉淀为可评测、可批准、可回滚的翻译技能。"];
  return {
    workbench: ["TRANSLATION", "翻译", "上传待译文件后自动分段、逐段审校并合并导出；单句输入仍可在这里即时处理。"],
    autoqa: ["TRANSLATION QA", "译文质检", "检查已有译文：按文件原生句段（或批次回放）跑硬规则与三层审查；只检查，不改译文。"],
    tasks: ["TASK CENTER", "任务中心", "查看、恢复、审校并导出日语→简体中文翻译任务。"],
    references: ["REFERENCE MATERIALS", "参考资料", "角色设定、剧本、故事梗概等；只在模型主动查询时按片段返回，不随每次翻译注入。"],
    import: ["BILINGUAL ASSET INGESTION", "双语资产导入", "先预检文件类型与资产去向，确认后再写入当前项目。"],
    assets: ["TERM ASSETS", "术语库", "查看日语→简体中文的物理隔离术语集合。"],
    memories: ["PROJECT TM", "记忆库 TM", "查看当前项目的主 TM、工作 TM 与参考 TM。"],
    styles: ["STYLE GUIDANCE", "风格指导", "查看并控制已沉淀的翻译风格规则。"],
    logs: ["RUNTIME LOG", "日志", "后台报错、任务进度与模型调用记录；报错不再只闪一下。"]
  }[view];
}

/**
 * 界面侧的报错也记进同一份日志：提示只显示 3 秒，日志里能回看。
 * 走的是 fire-and-forget，日志接口自己失败时不再递归上报。
 */
function recordClientLog(level, message, detail = "") {
  const text = String(message || "").trim();
  if (!text) return;
  if (level === "error") {
    // 界面上提示 3 秒就没了：角标留个痕迹，用户知道有错可查。
    bumpLogBadge(state.logErrorCount + 1);
    if (state.view === "logs") loadLogs().catch(() => {});
  }
  fetch("/api/logs/client", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level, message: text.slice(0, 1_000), detail: String(detail || "").slice(0, 2_000), path: location.pathname })
  }).catch(() => {});
}

window.addEventListener("error", (event) => {
  recordClientLog("error", `未捕获异常：${event?.message || "未知错误"}`, `${event?.filename || ""}:${event?.lineno || 0}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  recordClientLog("error", `未处理的 Promise 拒绝：${reason?.message || String(reason || "未知原因")}`, reason?.stack || "");
});

function refreshActions() {
  if (state.busy) return;
  const primary = $("#primaryAction");
  const secondary = $("#secondaryAction");
  const tertiary = $("#tertiaryAction");
  const cancelBatch = $("#cancelBatchAction");
  [secondary, tertiary].forEach((button) => { button.hidden = true; button.disabled = false; });
  if (cancelBatch) { cancelBatch.hidden = true; cancelBatch.disabled = false; }
  primary.disabled = false;
  primary.title = "";
  if (state.view === "workbench") {
    if (state.translationMode === "files") {
      primary.textContent = "添加新文件";
      primary.disabled = false;
      primary.title = `上传待译文件（TXT / Markdown / DOCX / XLSX / CSV / XLIFF / MQXLIFF，最大 ${UPLOAD_FILE_LABEL}）`;
    } else if (state.translationMode === "single") {
      primary.textContent = "开始翻译";
      secondary.hidden = false;
      secondary.textContent = "清空";
      if (state.lastResult) {
        tertiary.hidden = false;
        tertiary.textContent = "复制译文";
      }
    } else {
      const segments = state.batchPreview?.segments || [];
      const hasPending = segments.some((segment) => segment.selected && segment.status !== "done");
      const hasCompleted = segments.some((segment) => segment.status === "done" && segment.translation);
      const reportPending = hasCompleted && batchQualityReportPending(state.batchPreview, currentBatchWorkflow());
      // 语境分析是硬门禁：没就绪就不让点，点了只会被服务端 409 挡住、干等十分钟。
      const briefBlocked = Boolean(state.batchPreview?.requiresBrief) && state.batchBrief?.status !== "ready";
      primary.textContent = state.batchRunning ? (state.batchPaused ? "暂停中…" : "暂停批次")
        : !state.batchPreview ? "解析并分段"
          : briefBlocked ? (state.batchBriefPending ? "等待语境分析…" : "语境分析未就绪")
            : hasPending ? (segments.some((segment) => segment.selected && segment.status === "error") && !segments.some((segment) => segment.selected && ["pending", "running"].includes(segment.status)) ? `重试失败句段（${segments.filter((segment) => segment.selected && segment.status === "error").length}）` : state.batchPreview.runState === "paused" ? "继续翻译" : "开始批次翻译") : reportPending ? "质量报告生成中…" : "本轮翻译已结束";
      primary.disabled = state.batchRunning ? state.batchPaused : briefBlocked || (!state.batchPreview && !state.batchFile) || (Boolean(state.batchPreview) && !hasPending);
      if (briefBlocked) {
        primary.title = state.batchBriefPending
          ? "语境分析还在后台跑，完成后会自动解锁；进度也能在任务中心看"
          : "语境分析失败或还没做：点「重新分析」，或手动编辑用途后立即开始翻译";
      }
      // 中断：正在服务端后台跑（或已交出去）时才出现，点了当前段跑完就停，进度保留。
      if (cancelBatch && state.batchPreview) {
        const running = state.batchRunning || ["queued", "running"].includes(state.batchPreview.runState || "");
        cancelBatch.hidden = !running;
        cancelBatch.disabled = !running;
        cancelBatch.textContent = state.batchCancelling ? "中断中…" : "中断批次";
      }
      if (state.batchFile || state.batchPreview) {
        secondary.hidden = false;
        secondary.textContent = "清空批次";
      }
      if (hasCompleted) {
        tertiary.hidden = false;
        tertiary.textContent = reportPending ? "等质量报告…" : "导出";
        tertiary.disabled = reportPending;
        tertiary.title = reportPending ? "质量报告还在生成（含 AI 终审），完成后才能导出" : "";
      }
    }
  } else if (state.view === "import") {
    primary.textContent = state.assetPreflight ? "打开导入预检" : state.importPreview && !state.importCompleted ? "确认选中项入库" : state.importFile ? "重新预检" : "等待拖入双语资产";
    primary.disabled = state.importCompleted || (!state.assetPreflight && !state.importPreview && !state.importFile);
    if (state.importFile || state.importPreview) {
      secondary.hidden = false;
      secondary.textContent = "重新选择";
    }
    // 预检弹窗关掉后页面里要留一条能再打开的入口（顶部主按钮不是每个人都看得懂）。
    renderImportResume();
  } else if (state.view === "assets") {
    primary.textContent = "新增单条";
  } else if (state.view === "memories") {
    primary.textContent = "刷新 TM";
  } else if (state.view === "tasks") {
    primary.textContent = "刷新任务";
  } else if (state.view === "styles") {
    primary.textContent = "刷新风格";
  } else if (state.view === "autoqa") {
    // 顶部按钮跟着"来源"走：批次/文件用各自的入口，粘贴文本才用输入框内容。
    const source = state.qaSource || "batch";
    primary.textContent = source === "batch" ? "查看质检结果" : "开始质检";
    primary.disabled = source === "batch"
      ? !$("#qaBatchSelect")?.value
      : source === "file"
        ? !state.qaFile
        : (!($("#autoQaSource")?.value.trim() && $("#autoQaTarget")?.value.trim()));
    if (source === "paste" && ($("#autoQaSource")?.value.trim() || $("#autoQaTarget")?.value.trim())) {
      secondary.hidden = false;
      secondary.textContent = "清空";
    }
  }
  if (state.view === "learning") {
    const inPipeline = learningInPipeline();
    primary.textContent = state.learningLoading ? "正在读取学习轨迹……" : "根据人工采纳终稿生成候选技能";
    const payload = state.learningData?.data || state.learningData || {};
    const usableCount = state.learningData ? proposalTrajectories(payload.trajectories || payload.evidence).length : 0;
    // 项目级单流水线：没有可用的人工终稿就不在这里空点。
    primary.disabled = !inPipeline || state.learningLoading || !state.learningData || usableCount === 0;
    primary.title = !inPipeline
      ? "候选技能按项目生成：语体/领域由系统自动判定，只作参考"
      : (!state.learningLoading && usableCount === 0 ? "当前范围还没有人工采纳的终稿：先回填外部审校结果，或在质检里人工采纳。机器稿不能作为生成候选技能的依据。" : "");
  }
}

function setTranslationMode(mode) {
  if (mode === "batch" && !supportsBatchApi(state.serverVersion)) {
    toast("批次模块已安装，需重启服务后启用");
    return;
  }
  // 三种落地：files（待译文件列表，默认）/ single（单句）/ batch（某个文件的队列）。
  state.translationMode = ["batch", "single"].includes(mode) ? mode : "files";
  $$(".translation-mode").forEach((button) => button.classList.toggle("active", button.dataset.translationMode === state.translationMode));
  $("#fileListWorkspace").hidden = state.translationMode !== "files";
  $("#singleWorkspace").hidden = state.translationMode !== "single";
  $("#batchWorkspace").hidden = state.translationMode !== "batch";
  // 批次模式下质量档在「分段与翻译策略」面板里，上面的那一行属于单句输入：同时出现
  // 会让同一个设置看着像两个开关。切模式时把值带过去，隐藏的那一个不会留下别的档位。
  const tierRow = $("#tierRow");
  // 质量档那一行属于单句输入：文件列表与批次页里各有自己的入口，同时出现会像两个开关。
  if (tierRow) tierRow.hidden = state.translationMode !== "single";
  $("#batchQualityTier").value = $("#qualityTier").value;
  $("#viewDescription").textContent = pageCopy("workbench")[2];
  if (state.translationMode === "files") loadBatchFiles().catch((error) => toast(error.message));
  if (state.translationMode === "batch") renderBatchTabs();
  refreshActions();
}

function switchView(view) {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  state.view = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  const [eyebrow, title, description] = pageCopy(view);
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $("#viewDescription").textContent = description;
  if (view === "assets") updateAssetLocale(state.assetLocale);
  if (view === "memories") updateMemoryLocale(state.memoryLocale);
  if (view === "assets") renderLibraryShell("term");
  if (view === "memories") { renderLibraryShell("tm"); renderLibraryFiles("tm"); }
  if (view === "references") loadReferences().catch((error) => toast(error.message));
  if (view === "tasks") startTaskCenterPolling();
  else stopTaskCenterPolling();
  if (view === "styles") loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message));
  if (view === "workbench") setTranslationMode(state.translationMode);
  if (view === "learning") loadLearning(state.learningLocale);
  if (view === "autoqa") { updateAutoQaLocale(state.autoQaLocale); setQaSource(state.qaSource || "batch"); }
  if (view === "logs") { loadLogs().catch((error) => toast(error.message)); startLogAutoRefresh(); } else stopLogAutoRefresh();
  refreshActions();
}

function setTranslationStatus(type, text) {
  const badge = $("#translationState");
  badge.className = `badge ${type}`;
  badge.textContent = text;
}

function updateWorkbenchLocale(locale) {
  const localeChanged = state.workbenchLocale !== locale;
  state.workbenchLocale = locale;
  renderLocaleStrip($("#workbenchLocales"), locale, updateWorkbenchLocale);
  const details = state.bootstrap.locales[locale];
  $("#targetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
  $("#targetTitle").textContent = `${details.label}译文`;
  state.lastResult = null;
  $("#targetOutput").textContent = "译文将在这里显示";
  $("#targetOutput").classList.add("empty");
  $("#targetOutput").contentEditable = "false";
  $("#toggleTargetEdit").hidden = true;
  $("#acceptTranslation").disabled = true;
  $("#sendToAutoQa").hidden = true;
  $("#targetLegend").hidden = true;
  $("#translationCandidates").hidden = true;
  $("#translationCandidates").innerHTML = "";
  $("#termMatches").textContent = "尚未匹配";
  $("#termMatches").className = "term-matches empty-list";
  $("#qaList").textContent = "翻译后显示相似译例、评分与修订结果";
  $("#qaList").className = "qa-list empty-list";
  setTranslationStatus("neutral", "等待翻译");
  if (localeChanged && state.batchPreview) {
    state.batchPreview.segments.forEach((segment) => {
      segment.translation = "";
      segment.result = null;
      segment.error = "";
      segment.status = "pending";
    });
    state.batchClassification = null;
    state.batchStyleProfile = null;
    renderBatchSegments();
  }
  refreshActions();
  previewClassificationAndMatches();
}

function renderMatches(matches) {
  $("#matchCount").textContent = `${matches.length} 条`;
  if (!matches.length) {
    $("#termMatches").className = "term-matches empty-list";
    $("#termMatches").textContent = "当前日语→简体中文术语库没有命中项";
    return;
  }
  $("#termMatches").className = "term-matches";
  $("#termMatches").innerHTML = matches.map(({ term, score, mode, matchPhrase }) => `
    <div class="term-chip ${mode === "exact" ? "" : "potential"}"><div><strong>${escapeHtml(term.source)} → ${escapeHtml(term.target)}</strong><small>${mode === "exact" ? "正式术语精确命中 · 结合句义判断" : mode === "smart" ? `智能近似：${escapeHtml(matchPhrase)} · 待判断` : `字符近似：${escapeHtml(matchPhrase)} · 待判断`}</small></div><span class="match-score">${Math.round(score * 100)}</span></div>
  `).join("");
}

function renderQa(result) {
  const errors = result.issues.filter((issue) => issue.severity === "error");
  $("#issueCount").textContent = result.aiQa?.fallbackReason ? "AIQA 未完成" : Number.isFinite(result.qaScore) ? `AIQA ${result.qaScore} 分 · ${result.aiQa?.iterations || 0} 次修订` : errors.length ? `${errors.length} 个阻断项` : result.issues.length ? `${result.issues.length} 条建议` : "硬校验通过";
  const reflection = result.reflection ? `<div class="reflection-box"><strong>模型反思</strong>\n${escapeHtml(result.reflection)}</div>` : "";
  const retrieval = result.aiQa?.references?.length ? `<div class="reflection-box"><strong>相似译例检索</strong>\n${result.aiQa.references.map((item) => {
    const tags = contentTagLabels(item.contentType || "general", item.contentTags);
    const origin = item.sourceFile ? `${item.sourceFile}${item.sourceRow ? ` 第 ${item.sourceRow} 行` : ""}` : (item.provenance || "历史资产");
    return `${Math.round(item.similarity * 100)}% · ${contentTypeLabel(item.contentType || "general")}${tags.length ? ` / ${tags.join(" / ")}` : ""} · ${origin}\n${item.source} → ${item.target}`;
  }).map(escapeHtml).join("\n\n")}</div>` : "";
  const qaCases = result.aiQa?.qaCases?.length ? `<div class="reflection-box"><strong>历史 AIQA 反例</strong>\n${result.aiQa.qaCases.map((item) => `${Math.round(item.similarity * 100)}% · ${item.rejectedTranslation} → ${item.correctedTranslation}`).map(escapeHtml).join("\n")}</div>` : "";
  const issues = result.issues.map((issue, index) => `<div class="qa-item ${issue.severity}"><div>${escapeHtml(issue.message)}</div><div class="qa-decision-actions"><button class="button ghost small single-qa-action" data-action="accept" data-issue-index="${index}">采纳并让 AI 修订</button><button class="button ghost small single-qa-action" data-action="partial" data-issue-index="${index}">部分采纳</button>${issue.severity !== "error" || issue.mqmSeverity === "minor" ? `<button class="button ghost small single-qa-action" data-action="reject" data-issue-index="${index}">拒绝意见</button>` : ""}</div></div>`).join("");
  const humanDecisions = result.aiQa?.humanDecisions?.length ? `<div class="reflection-box"><strong>人工 QA 决定</strong>\n${result.aiQa.humanDecisions.map((item) => `${item.actionLabel || item.action || item.decision || "已处理"} · ${item.issue?.message || item.issue || "QA 意见"}`).map(escapeHtml).join("\n")}</div>` : "";
  const receipt = result.reviewReceipt?.textZh ? `<div class="reflection-box review-receipt"><strong>审阅意见处理回执</strong>\n${escapeHtml(result.reviewReceipt.textZh)}</div>` : "";
  const routing = result.routing ? `<div class="reflection-box"><strong>本段用途与质量档</strong>\n${escapeHtml(`${contentTypeLabel(result.classification?.contentType || "general")} · ${result.qualityTierLabel || "标准"}档${result.qualityTierSource === "manual" ? "（手动指定）" : "（自动判定）"}${result.qualityUpgradeFrom ? ` · 已由${result.qualityUpgradeFrom === "fast" ? "快速" : "标准"}档自动升级` : ""}`)}\n${escapeHtml(result.tierReason || (result.routing.description || ""))}${result.tierStrength ? `\n${escapeHtml(result.tierStrength)}` : ""}</div>` : "";
  const referenceRefs = result.referenceUsage?.refs || [];
  const referenceBox = referenceRefs.length
    ? `<div class="reflection-box"><strong>本次查阅的资料</strong>\n${escapeHtml([...new Set(referenceRefs.map((ref) => [ref.documentName, ref.heading].filter(Boolean).join(" · ")).filter(Boolean))].join("；"))}</div>`
    : "";
  const qualityRoute = result.qualityRoute ? `<div class="reflection-box"><strong>质量判定</strong>\n${escapeHtml(`${result.qualityRoute.decision || "human_review"} · ${result.qualityRoute.reason || ""}`)}</div>` : "";
  const factSummary = result.factSchema?.facts?.length || result.factSchema?.limits?.length ? `<div class="reflection-box"><strong>事实与交付约束</strong>\n${escapeHtml(`${result.factSchema.facts?.length || 0} 个事实锚点 · ${result.factSchema.limits?.length || 0} 项交付限制`)}</div>` : "";
  $("#qaList").className = "qa-list";
  const fallback = result.aiQa?.fallbackReason ? `<div class="qa-item warning">AIQA 暂未完成：${escapeHtml(result.aiQa.fallbackReason)}</div>` : "";
  $("#qaList").innerHTML = `${routing}${qualityRoute}${factSummary}${referenceBox}${reflection}${retrieval}${qaCases}${humanDecisions}${receipt}${fallback}${issues || (!fallback ? '<div class="qa-item">硬规则与检索式 AIQA 均通过</div>' : '')}`;
  $$(".single-qa-action").forEach((button) => button.addEventListener("click", () => resolveSingleQaIssue(Number(button.dataset.issueIndex), button.dataset.action, button)));
}

const AUTO_QA_DIMENSIONS = [
  ["basic", "基本检查", "语言正确性专项（拼写/语法/标点，模型）+ 品牌名、格式与句内一致性（本地规则）"],
  ["fidelity", "语义忠实性", "漏译、增译、错译与语义偏差，着重检查项"],
  ["nuance", "Nuance 一致性", "敬语级别、语气词、正式度与句式节奏的细微差异"]
];

function updateAutoQaLocale(locale) {
  state.autoQaLocale = locale;
  const strip = $("#autoQaLocales");
  if (strip) renderLocaleStrip(strip, locale, updateAutoQaLocale);
  const details = state.bootstrap.locales[locale];
  $("#autoQaTargetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
  $("#autoQaTargetTitle").textContent = `${details.label}译文`;
  $("#autoQaState").textContent = "等待质检";
  $("#autoQaState").className = "badge neutral";
  $("#autoQaReport").hidden = true;
  refreshActions();
}

function clearAutoQa() {
  $("#autoQaSource").value = "";
  $("#autoQaTarget").value = "";
  $("#autoQaSourceCount").textContent = "0 字";
  $("#autoQaState").textContent = "等待质检";
  $("#autoQaState").className = "badge neutral";
  $("#autoQaReport").hidden = true;
  refreshActions();
}

/**
 * 把已完成的译文交接到 Auto QA。
 *
 * 翻译流程与质检流程此前是两个互不相通的入口：译完要复制原文、切页面、再粘贴
 * 译文，长批次基本没人愿意做。这里把原文/译文/语言/语体/领域一次带过去，
 * 语体与领域用**翻译时实际生效**的判定结果，而不是 Auto QA 页上的当前选择，
 * 否则质检会用另一套作用域去比对，判出来的 nuance 问题没有意义。
 */
async function handOffToAutoQa({ source, translation, locale, contentType, domain, label }) {
  const cleanSource = String(source || "").trim();
  const cleanTranslation = String(translation || "").trim();
  if (!cleanSource || !cleanTranslation) return toast("没有可质检的译文");

  $("#autoQaSource").value = cleanSource;
  $("#autoQaTarget").value = cleanTranslation;
  $("#autoQaSourceCount").textContent = `${[...cleanSource].length} 字`;

  if (locale && state.bootstrap?.locales?.[locale]) {
    state.autoQaLocale = locale;
    // 质检页现在按"来源"分区，不再有语言 chip（只有 zh-CN）；这里必须容错，
    // 否则 null 会抛错被外层 catch 吞掉，后面的 bindEvents() 全都不会执行。
    const autoQaStrip = $("#autoQaLocales");
    if (autoQaStrip) renderLocaleStrip(autoQaStrip, state.autoQaLocale, updateAutoQaLocale);
    $("#autoQaTargetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
    $("#autoQaTargetTitle").textContent = `${state.bootstrap.locales[locale]?.label || locale}译文`;
  }
  switchView("autoqa");
  toast(`${label} 已送入 Auto QA，开始逐句质检…`);
  await runAutoQa();
}

function sendCurrentTranslationToAutoQa() {
  const result = state.lastResult;
  if (!result?.translation) return toast("请先完成一次翻译");
  return handOffToAutoQa({
    source: $("#sourceText").value,
    translation: result.translation,
    locale: state.workbenchLocale,
    contentType: result.classification?.contentType,
    domain: result.domainResolution?.domain,
    label: "当前译文"
  });
}

/**
 * 批次交接按原始顺序拼接已完成分段，原文与译文用同样的换行拼法，
 * Auto QA 的逐句对齐才能把它们一一对上。未完成的分段直接跳过——
 * 让空译文进去只会制造整句漏译的假问题。
 */
function sendBatchToAutoQa() {
  const segments = (state.batchPreview?.segments || [])
    .filter((segment) => segment.status === "done" && String(segment.translation || "").trim())
    .sort((left, right) => (left.index || 0) - (right.index || 0));
  if (!segments.length) return toast("批次里还没有完成的译文");
  const skipped = (state.batchPreview?.segments || []).length - segments.length;
  return handOffToAutoQa({
    source: segments.map((segment) => segment.source).join("\n"),
    translation: segments.map((segment) => segment.translation).join("\n"),
    locale: state.workbenchLocale,
    contentType: state.batchClassification?.contentType,
    // 领域取服务端实际判定的结果；批次的领域由系统自动判定，这里不再回落到手工下拉。
    domain: segments.find((segment) => segment.result?.domainResolution?.domain)?.result.domainResolution.domain || "",
    label: skipped > 0 ? `批次 ${segments.length} 段（跳过未完成 ${skipped} 段）` : `批次全部 ${segments.length} 段`
  });
}


let providerSettingsPanel;
let segmentSearchTimer = 0;
function getProviderSettingsPanel() {
  providerSettingsPanel ||= createProviderSettingsPanel($("#providerDialog"), {
    api,
    onSaved(provider) {
      state.bootstrap.provider = provider;
      $("#providerLabel").textContent = `${provider.model} · ${new URL(provider.baseUrl).hostname}`;
      toast("模型设置已更新");
    }
  });
  return providerSettingsPanel;
}

let parameterSettingsPanel;
function getParameterSettingsPanel() {
  parameterSettingsPanel ||= createParameterSettingsPanel($("#settingsDialog"), {
    api,
    onSaved(result) {
      toast(result.notes?.length ? `设置已保存，其中 ${result.notes.length} 项被自动校正` : "设置已保存并立即生效");
    }
  });
  return parameterSettingsPanel;
}

function openProviderSettings() {
  getProviderSettingsPanel().open(state.bootstrap.provider);
}

function openParameterSettings() {
  getParameterSettingsPanel().open().catch((error) => toast(error.message));
}

const QA_STATE_LABELS = { attention: "需要复核", suggest: "建议确认", pass: "通过", pending: "未完成" };

/** 段落的质检状态：分数 <90、AIQA 未完成、或有阻断级问题 → 需要复核；有意见 → 建议确认。 */
function qaSegmentState(segment) {
  const issues = segment.issues || [];
  if (segment.aiQaFallbackReason) return "attention";
  if (Number.isFinite(segment.qaScore) && segment.qaScore < 90) return "attention";
  if (issues.some((issue) => ["error", "critical"].includes(issue.severity))) return "attention";
  if (!segment.translation) return "pending";
  if (issues.length) return "suggest";
  return "pass";
}

function qaSeverityLabel(issue) {
  if (issue.severity === "critical") return "阻断";
  if (issue.severity === "error") return "阻断";
  if (issue.severity === "major") return "主要";
  return "轻微";
}

/** 统一段列表：筛选 chips + 跳到下一条待处理，批次/文件两条来源共用。 */
function renderQaSegments() {
  const segments = state.qaSegments || [];
  const container = $("#qaSegments");
  if (!container) return;
  const filters = $("#qaFilters");
  if (!segments.length) {
    container.innerHTML = "";
    if (filters) filters.innerHTML = "";
    return;
  }
  const counts = { "": segments.length, attention: 0, suggest: 0, pass: 0, pending: 0 };
  segments.forEach((segment) => { counts[qaSegmentState(segment)] += 1; });
  if (filters) {
    filters.innerHTML = [["", "全部"], ["attention", "需要复核"], ["suggest", "建议确认"], ["pass", "通过"], ["pending", "未完成"]]
      .map(([value, label]) => `<button class="qa-filter-chip${(state.qaFilter || "") === value ? " active" : ""}" type="button" data-qa-filter="${value}">${label} ${counts[value]}</button>`)
      .join("");
  }
  const filter = state.qaFilter || "";
  const visible = filter ? segments.filter((segment) => qaSegmentState(segment) === filter) : segments;
  container.innerHTML = visible.length ? visible.map((segment) => {
    const status = qaSegmentState(segment);
    const issues = segment.issues || [];
    const meta = [segment.entryKey || segment.entryId, segment.sourceRow ? `第 ${segment.sourceRow} 行` : "", segment.sheet].filter(Boolean).join(" · ");
    return `<article class="qa-segment ${status}" data-qa-index="${segment.index}">
      <div class="qa-segment-head"><span class="qa-segment-index">${segment.index}</span><span class="qa-segment-state ${status}">${QA_STATE_LABELS[status]}</span>${Number.isFinite(segment.qaScore) ? `<span class="qa-segment-score">${Math.round(segment.qaScore)} 分</span>` : ""}${meta ? `<span class="qa-segment-meta">${escapeHtml(meta)}</span>` : ""}</div>
      <div class="qa-segment-pair"><p><span>原文</span>${escapeHtml(segment.source || "")}</p><p><span>译文</span>${escapeHtml(segment.translation || "（无译文）")}</p></div>
      ${issues.length ? `<div class="qa-segment-issues">${issues.map((issue) => `<div class="qa-issue ${escapeHtml(issue.severity || "warning")}"><strong>${escapeHtml(qaSeverityLabel(issue))}${issue.category ? ` · ${escapeHtml(issue.category)}` : ""}</strong><span>${escapeHtml(issue.message || "")}</span>${issue.suggestion ? `<em>建议：${escapeHtml(issue.suggestion)}</em>` : ""}</div>`).join("")}</div>` : ""}
    </article>`;
  }).join("") : '<div class="empty-list">当前筛选下没有段落</div>';
}

/** 跳到下一条待处理（需要复核/建议确认）：在当前筛选结果里循环。 */
function jumpToNextQaSegment() {
  const filter = state.qaFilter || "";
  const list = filter ? (state.qaSegments || []).filter((segment) => qaSegmentState(segment) === filter) : (state.qaSegments || []).filter((segment) => ["attention", "suggest"].includes(qaSegmentState(segment)));
  if (!list.length) return toast("当前筛选下没有待处理段落");
  state.qaCursor = (Number(state.qaCursor) + 1) % list.length;
  const target = list[state.qaCursor];
  const row = document.querySelector(`.qa-segment[data-qa-index="${CSS.escape(String(target.index))}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-highlighted");
  setTimeout(() => row.classList.remove("is-highlighted"), 2_000);
}

/** 把批次/文件质检结果渲染成统一视图（同时把旧粘贴视图收起来）。 */
function applyQaResult(payload) {
  state.qaResult = payload;
  state.autoQaTaskId = payload.taskId || state.autoQaTaskId || "";
  const segments = (payload.segments || []).map((segment, index) => ({
    index: Number(segment.index) || index + 1,
    source: segment.source || "",
    translation: segment.translation || "",
    qaScore: Number.isFinite(Number(segment.qaScore)) ? Number(segment.qaScore) : null,
    issues: Array.isArray(segment.issues) ? segment.issues : [],
    aiQaFallbackReason: segment.aiQaFallbackReason || segment.fallbackReason || "",
    entryId: segment.entryId || "", entryKey: segment.entryKey || "",
    sourceRow: segment.sourceRow || null, sheet: segment.sheet || ""
  }));
  state.qaSegments = segments;
  state.qaFilter = "";
  state.qaCursor = -1;
  $("#autoQaReport").hidden = false;
  $("#qaAlignmentNote").textContent = payload.alignmentNote || "";
  $("#qaSegments").hidden = false;
  $("#qaFilters").hidden = false;
  const legacy = $("#autoQaIssues");
  if (legacy) { legacy.hidden = true; legacy.innerHTML = ""; }
  const scores = payload.scores || { overall: 0, dimensions: {} };
  const summary = payload.summary || {};
  $("#autoQaScores").innerHTML = [["overall", "综合分", "基本 20% · 忠实性 50% · Nuance 30%"], ...AUTO_QA_DIMENSIONS]
    .map(([key, label, caption]) => {
      const value = key === "overall" ? scores.overall : scores.dimensions?.[key];
      const stats = key === "overall" ? null : summary[key];
      const detail = key === "overall" ? caption : stats?.total ? `${stats.total} 条问题 · 阻断 ${stats.error || 0} · 主要 ${stats.major || 0} · 轻微 ${stats.minor || 0}` : "未发现问题";
      return `<div class="autoqa-score-card ${autoQaScoreTone(value)}"><strong>${Number.isFinite(Number(value)) ? Math.round(Number(value)) : "—"}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(detail || "")}</small></div>`;
    }).join("");
  renderQaSegments();
}

/** 质检来源切换：批次 / 文件 / 粘贴。 */
function setQaSource(source) {
  state.qaSource = source;
  $$("#qaSourceTabs .qa-source-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.qaSource === source));
  $$("[data-qa-panel]").forEach((panel) => { panel.hidden = panel.dataset.qaPanel !== source; });
  refreshActions();
  if (source === "batch") loadQaBatches().catch((error) => toast(error.message));
}

async function loadQaBatches() {
  const select = $("#qaBatchSelect");
  if (!select) return;
  const query = new URLSearchParams({ type: "batch", limit: "100" });
  if (state.activeProjectId) query.set("projectId", state.activeProjectId);
  const tasks = await api(`/api/tasks?${query}`);
  const batches = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task.type === "batch" && task.batchId && Number(task.completedSegments) > 0)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  select.innerHTML = batches.length
    ? batches.map((task) => `<option value="${escapeHtml(task.batchId)}">${escapeHtml(task.filename)} · ${task.completedSegments}/${task.totalSegments}${task.qaPending ? ` · ${task.qaPending} 条待处理` : ""}</option>`).join("")
    : '<option value="">当前项目还没有可质检的批次</option>';
  select.disabled = !batches.length;
  $("#qaBatchLoad").disabled = !batches.length;
}

async function runQaFromBatch() {
  const batchId = $("#qaBatchSelect")?.value;
  if (!batchId) return toast("先选择一个翻译批次");
  setBusy(true, "正在回放批次质检结果…");
  try {
    applyQaResult(await api(`/api/qa/batch/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`));
    toast("已回放这条批次的质检结果（未重新调用模型）");
  } catch (error) {
    toast(error.message);
  } finally { setBusy(false); }
}

async function runQaFromFile() {
  const file = state.qaFile;
  if (!file) return toast("先选择要质检的双语文件");
  setBusy(true, $("#qaDeepCheck").checked ? "正在按文件句段质检（含 AI 深度检查）…" : "正在按文件句段质检…");
  try {
    applyQaResult(await api("/api/qa/file", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      locale: state.autoQaLocale,
      filename: file.name,
      base64: await fileToBase64(file),
      ...scopePayload(),
      deepCheck: $("#qaDeepCheck").checked
    }) }));
    toast("质检完成（按文件原生句段，未做切句对齐）");
  } catch (error) {
    toast(error.message);
  } finally { setBusy(false); }
}

/** 下载质检报告：CSV，一行一条问题，方便丢给同事或存档。 */
function downloadQaReport() {
  const segments = state.qaSegments || [];
  if (!segments.length) return toast("还没有质检结果");
  const rows = [["段号", "状态", "分数", "原文", "译文", "级别", "分类", "问题", "建议"]];
  segments.forEach((segment) => {
    const status = QA_STATE_LABELS[qaSegmentState(segment)];
    const issues = segment.issues || [];
    if (!issues.length) rows.push([segment.index, status, segment.qaScore ?? "", segment.source, segment.translation, "", "", "", ""]);
    issues.forEach((issue) => rows.push([
      segment.index, status, segment.qaScore ?? "", segment.source, segment.translation,
      qaSeverityLabel(issue), issue.category || "", issue.message || "", issue.suggestion || ""
    ]));
  });
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const payload = { filename: `质检报告-${state.qaResult?.filename || "结果"}.csv`, mimeType: "text/csv;charset=utf-8", base64: btoa(unescape(encodeURIComponent(`\uFEFF${csv}`))) };
  saveExportedFile(payload).then((saved) => toast(saved.message)).catch((error) => toast(error.message));
}

async function runAutoQa() {
  const source = $("#autoQaSource").value.trim();
  const translation = $("#autoQaTarget").value.trim();
  if (!source || !translation) {
    toast("请同时填写日语原文与简体中文译文");
    return;
  }
  setBusy(true, "Auto QA 质检中…");
  $("#autoQaState").textContent = "质检中…";
  $("#autoQaState").className = "badge warning";
  try {
    const payload = await api("/api/auto-qa", {
      method: "POST",
      body: JSON.stringify({
        ...projectPayload(),
        source, translation,
        locale: state.autoQaLocale,
        ...scopePayload()
      })
    });
    renderAutoQaReport(payload);
    state.qaSegments = [];
    $("#qaSegments").hidden = true;
    $("#qaFilters").hidden = true;
    const legacyIssues = $("#autoQaIssues");
    if (legacyIssues) legacyIssues.hidden = false;
    toast(`质检完成：${payload.scores.overall} 分 · 已保存到任务中心`);
  } catch (error) {
    $("#autoQaState").textContent = "质检失败";
    $("#autoQaState").className = "badge error";
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function autoQaScoreTone(score) {
  return score >= 90 ? "good" : score >= 70 ? "warn" : "bad";
}

function renderAutoQaReport(payload) {
  const { scores, summary, segments = [], alignmentIssues = [], alignmentNote, tagsStripped, segmentCounts, fallbackReason, references, qaCases, classification, domainResolution, styleProfile } = payload;
  const scoreCard = (score, label, caption, tone) => `
    <div class="autoqa-score-card ${tone}"><strong>${score}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(caption)}</small></div>`;
  $("#autoQaScores").innerHTML =
    scoreCard(scores.overall, "综合分", "基本 20% · 忠实性 50% · Nuance 30%", "overall")
    + AUTO_QA_DIMENSIONS.map(([dimension, label]) => {
      const value = scores.dimensions[dimension];
      const stats = summary[dimension] || {};
      const counts = stats.total
        ? `${stats.total} 条问题 · 阻断 ${stats.error} · 主要 ${stats.major} · 轻微 ${stats.minor}`
        : "未发现问题";
      return scoreCard(value, label, counts, autoQaScoreTone(value));
    }).join("");

  const evidenceLines = [];
  if (styleProfile?.name) evidenceLines.push(`风格规范：${styleProfile.name} v${styleProfile.version || 1}`);
  if (references?.length) evidenceLines.push(`已批准译例 ${references.length} 条`);
  if (qaCases?.length) evidenceLines.push(`历史 QA 反例 ${qaCases.length} 条`);
  if (classification?.contentType) {
    const label = state.bootstrap?.contentTypes?.[classification.contentType]?.label || classification.contentType;
    evidenceLines.push(`识别语体：${label}（${CLASSIFY_SOURCE_LABELS[classification.source] || classification.source || "识别"}）`);
    const tags = contentTagLabels(classification.contentType, classification.contentTags);
    if (tags.length) evidenceLines.push(`场景标签：${tags.join(" / ")}`);
  }
  if (domainResolution?.domain) {
    const label = DOMAIN_LABELS[domainResolution.domain] || domainResolution.domain;
    const note = domainResolution.relaxedRetrieval ? "，该领域无资产，检索已放宽到全部" : "";
    evidenceLines.push(`识别领域：${label}（${CLASSIFY_SOURCE_LABELS[domainResolution.source] || domainResolution.source}${note}）`);
  }
  const evidenceBox = evidenceLines.length
    ? `<div class="reflection-box"><strong>Nuance 对照证据</strong>\n${escapeHtml(evidenceLines.join("\n"))}</div>`
    : "";
  const notes = [];
  if (tagsStripped) notes.push("输入含 HTML 标签，已剥离后分析。");
  if (alignmentNote) notes.push(alignmentNote);
  const noteBox = notes.length ? `<div class="reflection-box"><strong>逐句对齐说明</strong>\n${escapeHtml(notes.join("\n"))}</div>` : "";
  const fallback = fallbackReason
    ? `<div class="qa-item error">部分句子模型层质检未完成：${escapeHtml(fallbackReason)}</div>`
    : "";
  const alignmentBlock = alignmentIssues.length
    ? `<section class="autoqa-dimension">
        <div class="autoqa-dimension-head"><div><span class="card-kicker">SENTENCE ALIGNMENT</span><h3>整句级问题</h3><small>按语义向量逐句对齐时发现的疑似漏译 / 增译</small></div><span class="asset-count">${alignmentIssues.length} 条</span></div>
        ${alignmentIssues.map((issue) => renderAutoQaIssue(issue, null)).join("")}
      </section>`
    : "";
  const openByDefault = segments.length <= 6;
  const segmentCards = segments.map((segment, index) => renderAutoQaSegment(segment, openByDefault || index < 2)).join("");
  $("#autoQaIssues").innerHTML = `
    ${evidenceBox}${noteBox}${fallback}${alignmentBlock}
    <section class="autoqa-dimension">
      <div class="autoqa-dimension-head"><div><span class="card-kicker">PER-SENTENCE CHECKS</span><h3>逐句检查</h3><small>原文 ${segmentCounts?.source ?? segments.length} 句 / 译文 ${segmentCounts?.translation ?? segments.length} 句，每一句按三个维度独立审查</small></div><span class="asset-count subtle">${segments.length} 组</span></div>
      ${segmentCards || `<div class="qa-item warning">未能配对任何句子，请检查输入内容。</div>`}
    </section>`;
  $("#autoQaReport").hidden = false;

  const overall = scores.overall;
  $("#autoQaState").textContent = fallbackReason ? "部分模型检查失败" : `${overall} 分`;
  $("#autoQaState").className = `badge ${overall >= 90 ? "success" : overall >= 70 ? "warning" : "error"}`;
}

function renderAutoQaSegment(segment, open) {
  const { index, sourceIndices, translationIndices, source, translation, issues, scores, fallbackReason: segmentFallback } = segment;
  const metrics = AUTO_QA_DIMENSIONS.map(([dimension, label]) =>
    `<span class="autoqa-segment-metric ${autoQaScoreTone(scores.dimensions[dimension])}"><i>${scores.dimensions[dimension]}</i>${label}</span>`).join("");
  const sourceLabel = sourceIndices.length > 1 ? `原文第 ${sourceIndices.join("、")} 句合并` : `原文第 ${sourceIndices[0] || index} 句`;
  const translationLabel = translationIndices.length > 1 ? `译文第 ${translationIndices.join("、")} 句合并` : `译文第 ${translationIndices[0] || index} 句`;
  const segmentFailure = segmentFallback ? `<div class="qa-item warning">本组模型检查失败：${escapeHtml(segmentFallback)}，仅展示本地基本检查。</div>` : "";
  const body = `<div class="autoqa-segment-body">
      <div class="autoqa-segment-pair">
        <div><span>${escapeHtml(sourceLabel)}</span><p>${escapeHtml(source)}</p></div>
        <div><span>${escapeHtml(translationLabel)}</span><p>${escapeHtml(translation)}</p></div>
      </div>
      ${segmentFailure}
      ${issues.length ? issues.map((issue) => renderAutoQaIssue(issue, index)).join("") : `<div class="qa-item">本句三层检查通过</div>`}
    </div>`;
  return `<details class="autoqa-segment"${open ? " open" : ""}>
    <summary>
      <span class="autoqa-segment-index">#${index}</span>
      <span class="autoqa-segment-score ${autoQaScoreTone(scores.overall)}">${scores.overall}</span>
      ${metrics}
      <span class="autoqa-segment-text">${escapeHtml(source.length > 42 ? `${source.slice(0, 42)}…` : source)}</span>
    </summary>
    ${body}
  </details>`;
}

function renderAutoQaIssue(issue, segmentIndex = null) {
  const canDeleteIssue = Boolean(state.autoQaTaskId) && window.isSecureContext && Boolean(globalThis.crypto?.subtle);
  const deleteButton = canDeleteIssue
    ? `<button class="button ghost small autoqa-issue-delete" type="button" data-qa-issue-delete="${encodeURIComponent(JSON.stringify({ issue, segmentIndex }))}">删除该意见</button>`
    : "";
  const severityLabel = issue.severity === "critical" || issue.severity === "error" ? "阻断"
    : issue.severity === "major" ? "主要" : "轻微";
  const spans = issue.sourceSpan || issue.targetSpan
    ? `<div class="autoqa-span-pair">${issue.sourceSpan ? `<span>原文「${escapeHtml(issue.sourceSpan)}」</span>` : ""}${issue.targetSpan ? `<span>译文「${escapeHtml(issue.targetSpan)}」</span>` : ""}</div>`
    : "";
  const suggestion = issue.suggestion ? `<small class="autoqa-suggestion">建议：${escapeHtml(issue.suggestion)}</small>` : "";
  const confidence = Number.isFinite(Number(issue.confidence))
    ? `<span class="autoqa-confidence">置信 ${Math.round(Number(issue.confidence) * 100)}%</span>`
    : "";
  return `<div class="autoqa-issue ${issue.severity}">
    ${deleteButton}
    <div class="autoqa-issue-head"><span class="autoqa-category">${escapeHtml(issue.category || "other")}</span><span class="autoqa-severity ${issue.severity}">${severityLabel}</span>${confidence}</div>
    <p>${escapeHtml(issue.message)}</p>${spans}${suggestion}
  </div>`;
}

function compactQaReferences(aiQa = {}) {
  return [...(aiQa.references || []), ...(aiQa.qaCases || []).map((item) => ({ ...item, kind: "qa_case" }))]
    .slice(0, 12)
    .map(({ embedding, ...item }) => item);
}

function qaResolutionBody({ source, translation, result, action, issueIndex, contentType, domain, batchId, review = {} }) {
  return {
    source, translation, action, issueIndex,
    issues: result.issues || [], qaScore: result.qaScore,
    locale: state.workbenchLocale, contentType, domain, batchId,
    trajectoryId: result.trajectoryId || result.trajectory_id || "",
    iterations: result.aiQa?.iterations || 0,
    references: compactQaReferences(result.aiQa),
    termDecisions: result.aiQa?.termDecisions || [],
    humanDecisions: result.aiQa?.humanDecisions || [],
    ...review
  };
}

async function resolveSingleQaIssue(issueIndex, action, button) {
  const result = state.lastResult;
  if (!result?.issues?.[issueIndex]) return;
  const issue = result.issues[issueIndex];
  const review = {};
  if (action === "accept" && !confirm("确认采纳这条 QA 意见，并让翻译模型按意见做最小修订？")) return;
  if (action === "partial") {
    const accepted = prompt("填写要采纳的部分（多项可用分号分隔）：", issue.suggestion || issue.message || "");
    if (accepted == null) return;
    const rejected = prompt("填写不采纳的部分及边界（必填）：", "其余表述保持不变");
    if (rejected == null) return;
    const instruction = prompt("给翻译模型的精确修订要求：", accepted);
    if (instruction == null) return;
    review.acceptedParts = accepted.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.rejectedParts = rejected.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.revisionInstruction = instruction.trim();
  }
  if (action === "reject") {
    const reason = prompt("请说明拒绝这条 QA 意见的原因（会写入处理回执）：", "当前译文在本语境中可接受");
    if (reason == null || !reason.trim()) return;
    review.reason = reason.trim();
  }
  button.disabled = true;
  button.textContent = ["accept", "partial", "revise"].includes(action) ? "AI 修订中…" : "记录中…";
  try {
    const resolved = await api("/api/qa/resolve", { method: "POST", body: JSON.stringify(qaResolutionBody({
      source: $("#sourceText").value.trim(), translation: result.translation, result, action, issueIndex,
      contentType: result.classification?.contentType || "general", domain: result.domainResolution?.domain || "auto", batchId: "single-review", review
    })) });
    state.lastResult = { ...result, ...resolved, translation: resolved.translation, issues: resolved.issues, qaScore: resolved.qaScore, aiQa: resolved.aiQa, reviewReceipt: resolved.reviewReceipt };
    renderTranslationOutput();
    renderQa(state.lastResult);
    setResultStatus(state.lastResult.issues, state.lastResult.aiQa);
    toast(["accept", "partial", "revise"].includes(action) ? `AI 已按决定修订并重新 QA：${resolved.qaScore} 分` : "已拒绝该条建议并生成处理回执");
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "accept" ? "采纳并让 AI 修订" : action === "partial" ? "部分采纳" : "拒绝意见";
    toast(error.message);
  }
}

function setResultStatus(issues = [], aiQa = null) {
  if (aiQa?.fallbackReason) return setTranslationStatus("warning", "AIQA 未完成");
  if (Number.isFinite(aiQa?.score) && aiQa.score < 90) return setTranslationStatus("error", "AIQA 待复核");
  if (issues.some((issue) => issue.severity === "error")) setTranslationStatus("error", "需要处理");
  else if (issues.length) setTranslationStatus("warning", "建议确认");
  else setTranslationStatus("success", "QA 通过");
}

const CLASSIFY_SOURCE_LABELS = {
  manual: "人工指定", descriptor: "表格声明", "content-type": "语体决定",
  model: "模型识别", heuristic: "正文推断", fallback: "默认值"
};

const DOMAIN_LABELS = { game: "游戏", general: "通用", marketing: "市场营销", community: "社区运营" };

/**
 * 「自动识别」选项此前只能等翻译跑完、在结果区的小字里才知道判成了什么。
 * 语体与领域都直接决定取哪份风格规范和哪批记忆，判定结果必须当场可见。
 */
function resolutionSummary(classification, domainResolution) {
  const parts = [];
  if (classification?.contentType) {
    const label = state.bootstrap?.contentTypes?.[classification.contentType]?.label || classification.contentType;
    const tags = contentTagLabels(classification.contentType, classification.contentTags);
    parts.push(`语体 <strong>${escapeHtml(label)}</strong>${tags.length ? ` · ${escapeHtml(tags.join(" / "))}` : ""}（${escapeHtml(CLASSIFY_SOURCE_LABELS[classification.source] || classification.source || "识别")}）`);
  }
  if (domainResolution?.domain) {
    const label = DOMAIN_LABELS[domainResolution.domain] || domainResolution.domain;
    const note = domainResolution.relaxedRetrieval ? "，该领域无资产，检索已放宽到全部" : "";
    parts.push(`领域 <strong>${escapeHtml(label)}</strong>（${escapeHtml(CLASSIFY_SOURCE_LABELS[domainResolution.source] || domainResolution.source)}${escapeHtml(note)}）`);
  }
  return parts.join(" · ");
}

/**
 * 本次参考透明化：风格规范是项目级的（每项目一份），记忆仍按作用域排序，
 * 这里把"用的是哪一版规范、译例来自哪一档"说清楚。
 */
function scopeUsageText(scopeUsage) {
  if (!scopeUsage) return "";
  const parts = [];
  const profile = scopeUsage.styleProfile;
  if (profile) {
    parts.push(`项目规范${profile.name ? `「${profile.name}」` : ""} v${profile.version || 1}`);
  } else {
    parts.push("无启用中的项目规范");
  }
  const counts = scopeUsage.memoryScopes || {};
  const total = (counts.exact || 0) + (counts.partial || 0) + (counts.general || 0);
  if (total) {
    const detail = [
      counts.exact ? `同作用域 ${counts.exact}` : "",
      counts.partial ? `相邻作用域 ${counts.partial}` : "",
      counts.general ? `通用 ${counts.general}` : ""
    ].filter(Boolean).join(" / ");
    parts.push(`译例 ${total} 条（${detail}）`);
  }
  return `本次参考：${parts.join(" · ")}`;
}

function renderTranslationOutput() {
  const result = state.lastResult;
  if (!result) return;
  const rendered = renderTranslationMarkup(result.translation, result.matches, result.termSuggestions || []);
  $("#targetOutput").classList.remove("empty");
  $("#targetOutput").innerHTML = rendered.html;
  $("#targetLegend").hidden = rendered.officialCount + rendered.suggestionCount === 0;
  $("#officialLegend").hidden = rendered.officialCount === 0;
  $("#officialCount").textContent = `${rendered.officialCount} 处正式术语`;
  $("#suggestionLegend").hidden = rendered.suggestionCount === 0;
  $("#suggestionCount").textContent = `${rendered.suggestionCount} 处疑似术语`;
  $$(".term-suggestion").forEach((button) => button.addEventListener("click", () => openTermSuggestion(button.dataset.suggestionId)));
  const editable = $("#targetOutput").isContentEditable;
  if (editable) {
    $("#targetOutput").textContent = result.translation;
  }
  $("#toggleTargetEdit").hidden = false;
  $("#toggleTargetEdit").textContent = editable ? "完成编辑" : "编辑译文";
  $("#acceptTranslation").disabled = !result.translation;
  $("#sendToAutoQa").hidden = !result.translation;
  renderTranslationCandidates(result);
}

function renderTranslationCandidates(result) {
  const panel = $("#translationCandidates");
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length < 2) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `<div class="candidate-picker-head"><div><strong>模型候选</strong><small>${escapeHtml(result.routing?.label || "多候选路线")} · 推荐项已完成本轮 QA</small></div><span>${candidates.length} 版</span></div><div class="candidate-picker-list">${candidates.map((candidate, index) => {
    const selected = candidate.translation === result.translation;
    return `<button class="candidate-translation ${selected ? "selected" : ""}" data-translation-candidate="${index}" type="button"><span>${selected ? "当前采用" : `候选 ${index + 1}`}${candidate.recommended ? " · 系统推荐" : ""}</span><strong>${escapeHtml(candidate.translation)}</strong><small>${escapeHtml(candidate.reason || "点击采用并重新 QA")}</small></button>`;
  }).join("")}</div>`;
  $$('[data-translation-candidate]').forEach((button) => button.addEventListener("click", () => selectTranslationCandidate(Number(button.dataset.translationCandidate), button)));
}

async function selectTranslationCandidate(index, button) {
  const result = state.lastResult;
  const candidate = result?.candidates?.[index];
  if (!candidate || candidate.translation === result.translation) return;
  button.disabled = true;
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: $("#sourceText").value.trim(),
      translation: candidate.translation,
      locale: state.workbenchLocale,
      contentType: result.classification?.contentType || "general",
      domain: result.domainResolution?.domain || "auto",
      aiQa: true
    }) });
    state.lastResult = { ...result, ...qa, candidates: result.candidates, routing: result.routing, translation: qa.translation };
    renderTranslationOutput();
    renderMatches(state.lastResult.matches || result.matches || []);
    renderQa(state.lastResult);
    setResultStatus(state.lastResult.issues || [], state.lastResult.aiQa);
    toast(`已采用候选 ${index + 1} 并重新完成 QA`);
  } catch (error) {
    button.disabled = false;
    toast(`候选暂未采用：${error.message}`);
  }
}

function toggleTargetEdit() {
  const output = $("#targetOutput");
  const editable = output.isContentEditable;
  output.contentEditable = String(!editable);
  if (!editable) {
    output.textContent = state.lastResult.translation;
    $("#toggleTargetEdit").textContent = "完成编辑";
  } else {
    state.lastResult.translation = output.textContent.trim();
    renderTranslationOutput();
  }
}

async function acceptSingleTranslation() {
  if (!state.lastResult) return;
  const output = $("#targetOutput");
  const translation = output.isContentEditable ? output.textContent.trim() : state.lastResult.translation;
  if (!translation) return toast("没有可采纳的译文");
  if (output.isContentEditable) state.lastResult.translation = translation;
  setBusy(true, "采纳中…");
  try {
    const result = await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: $("#sourceText").value.trim(),
      translation,
      locale: state.workbenchLocale,
      contentType: state.lastResult.classification.contentType,
      domain: state.lastResult.domainResolution?.domain || "auto",
      styleProfileId: state.lastResult.styleProfile?.id || "",
      qaCaseId: state.lastResult.aiQa?.qaCases?.[0]?.id || "",
      termSuggestions: state.lastResult.termSuggestions || [],
      trajectoryId: state.lastResult.trajectoryId || state.lastResult.trajectory_id || ""
    }) });
    if (output.isContentEditable) toggleTargetEdit();
    toast(`${result.termCandidateWarning || `已采纳为正式译法${result.demoted ? `，${result.demoted} 条旧机器译文已降权` : ""}，并沉淀为风格证据${result.termCandidateBatch ? "；新术语已进入待审核候选" : ""}`}`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function openTermSuggestion(id) {
  const suggestion = state.lastResult?.termSuggestions?.find((item) => item.id === id);
  if (!suggestion) return;
  state.activeSuggestion = suggestion;
  $("#suggestionSource").textContent = `${suggestion.matchedSource} ≈ ${suggestion.sourceTerm}`;
  $("#suggestionCurrent").textContent = suggestion.currentText;
  $("#suggestionReplacement").textContent = suggestion.replacement;
  $("#suggestionConfidence").textContent = `综合置信度 ${Math.round(Math.min(suggestion.matchScore, suggestion.confidence) * 100)}% · ${suggestion.reason}`;
  $("#termSuggestionDialog").showModal();
}

async function applyTermSuggestion() {
  const suggestion = state.activeSuggestion;
  if (!suggestion || !state.lastResult) return;
  state.lastResult.translation = state.lastResult.translation.split(suggestion.currentText).join(suggestion.replacement);
  state.lastResult.termSuggestions = (state.lastResult.termSuggestions || []).filter((item) => item.id !== suggestion.id);
  $("#termSuggestionDialog").close();
  state.activeSuggestion = null;
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: $("#sourceText").value,
      translation: state.lastResult.translation,
      locale: state.workbenchLocale,
      contentType: state.lastResult.classification.contentType,
      domain: state.lastResult.domainResolution?.domain || "auto",
      aiQa: true
    }) });
    state.lastResult.translation = qa.translation;
    state.lastResult.matches = qa.matches;
    state.lastResult.issues = qa.issues;
    state.lastResult.qaScore = qa.qaScore;
    state.lastResult.aiQa = qa.aiQa;
  } catch (error) { toast(`替换成功，但 QA 刷新失败：${error.message}`); }
  renderTranslationOutput();
  renderMatches(state.lastResult.matches);
  renderQa(state.lastResult);
  setResultStatus(state.lastResult.issues, state.lastResult.aiQa);
  toast(`已将“${suggestion.currentText}”替换为正式译法“${suggestion.replacement}”`);
}

let previewTimer;
function previewClassificationAndMatches() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    // 翻译与审校进行中不要用预检结果覆盖结果面板：预检响应可能比翻译晚回来，
    // 那样用户看到的就是"只有语体没有本次参考"的旧信息。
    if (state.busy) return;
    const text = $("#sourceText").value.trim();
    $("#sourceCount").textContent = `${[...text].length} 字`;
    if (!text || !state.bootstrap) return;
    try {
      const classification = await api("/api/classify", { method: "POST", body: JSON.stringify({ text, hint: "auto", domain: "auto" }) });
      const resolvedDomain = classification.domainResolution?.domain || "auto";
      const matched = await api("/api/match", { method: "POST", body: JSON.stringify({ ...projectPayload(), text, locale: state.workbenchLocale, contentType: classification.contentType, domain: resolvedDomain }) });
      $("#classificationPreview").innerHTML = `<span class="pulse-dot"></span><span>${resolutionSummary(classification, classification.domainResolution)} · 置信度 ${Math.round(classification.confidence * 100)}% · 命中 ${matched.matches.length} 条术语</span>`;
      renderMatches(matched.matches);
    } catch (error) {
      $("#classificationPreview").textContent = error.message;
    }
  }, 300);
}

async function translate() {
  const source = $("#sourceText").value.trim();
  if (!source) return toast("请先输入日语原文");
  setBusy(true, "翻译与审校中…");
  setTranslationStatus("warning", "处理中");
  try {
    const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source, locale: state.workbenchLocale, ...scopePayload(),
      qualityTier: $("#qualityTier").value,
      neighborContext: $("#neighborContext").value, useModelClassification: true
    }) });
    state.lastResult = result;
    renderTranslationOutput();
    // 透明化：除了语体/领域判定，还要说清这次到底吃到了哪一档作用域的规范与译例。
    const scopeNote = scopeUsageText(result.scopeUsage);
    $("#classificationPreview").innerHTML = `<span class="pulse-dot"></span><span>${resolutionSummary(result.classification, result.domainResolution)}${scopeNote ? ` · ${escapeHtml(scopeNote)}` : ""}</span>`;
    renderMatches(result.matches);
    renderQa(result);
    setResultStatus(result.issues, result.aiQa);
  } catch (error) {
    setTranslationStatus("error", "翻译失败");
    toast(error.message);
  } finally { setBusy(false); }
}

function clearTranslation() {
  $("#sourceText").value = "";
  $("#neighborContext").value = "";
  updateWorkbenchLocale(state.workbenchLocale);
}

async function setBatchFile(file) {
  if (!file) return;
  if (!/\.(txt|md|docx|xlsx|csv|xliff|mqxliff)$/i.test(file.name)) return toast("请选择 TXT、Markdown、DOCX、XLSX、CSV、XLIFF 或 MQXLIFF 文件");
  if (file.size > UPLOAD_FILE_BYTES) return toast(`文件不能超过 ${UPLOAD_FILE_LABEL}`);
  state.batchFile = file;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  state.batchColumnMapping = null;
  updateBatchSegmentationOptions(file.name);
  $("#batchFilePrompt").textContent = file.name;
  $("#batchFileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · 正在智能识别`;
  $("#batchDropZone").classList.add("has-file");
  $("#batchSourceMeta").textContent = "AI 结构识别中";
  $("#spreadsheetAnalysis").hidden = true;
  renderBatchSegments();
  refreshActions();
  // 表格文件先让用户确认列含义：哪一列是日文原文、哪一列是已有译文/条目 ID、首行是不是表头。
  if (/\.(xlsx|csv)$/iu.test(file.name)) {
    const confirmed = await confirmBatchColumns(file);
    if (!confirmed) {
      resetBatchFileSelection();
      return false;
    }
  }
  await prepareBatch();
  return true;
}

/** 文件列表状态 → 文案与颜色。语境分析单独算一列，不放这里。 */
const BATCH_FILE_STATUS_META = {
  ready: ["未开始", "neutral"],
  in_progress: ["翻译中", "warning"],
  paused: ["已中断", "warning"],
  review: ["QA 待处理", "warning"],
  needs_attention: ["存在失败", "error"],
  completed: ["已完成", "success"]
};

const BRIEF_STATUS_META = {
  none: ["未开始", "neutral"],
  pending: ["分析中", "warning"],
  ready: ["已就绪", "success"],
  failed: ["失败", "error"]
};

async function loadBatchFiles() {
  if (!state.activeProjectId) return;
  state.batchFilesLoading = true;
  try {
    const params = new URLSearchParams({ locale: state.workbenchLocale, projectId: state.activeProjectId });
    const payload = await api(`/api/batch/files?${params}`);
    state.batchFiles = Array.isArray(payload.files) ? payload.files : [];
  } catch (error) {
    state.batchFiles = [];
    toast(error.message);
  } finally {
    state.batchFilesLoading = false;
    renderBatchFileList();
  }
}

function formatBatchFileBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return "";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function renderBatchFileList() {
  const container = $("#batchFileList");
  if (!container) return;
  const keyword = state.batchFileSearch.trim().toLowerCase();
  const files = (state.batchFiles || [])
    .filter((file) => !state.batchFileStatus || file.status === state.batchFileStatus)
    .filter((file) => !keyword || String(file.filename || "").toLowerCase().includes(keyword));
  $("#batchFileCount").textContent = `${files.length} / 共 ${(state.batchFiles || []).length} 个文件`;
  if (!files.length) {
    container.innerHTML = `<div class="empty-list batch-empty">${(state.batchFiles || []).length
      ? "没有符合筛选条件的文件。"
      : "还没有待译文件：点右上角「添加新文件」或把文件拖进上传区，解析完就能在这里看到进度、QA 与人工审校状态。"}</div>`;
    return;
  }
  container.innerHTML = files.map((file) => {
    const [statusLabel, statusClass] = BATCH_FILE_STATUS_META[file.status] || [file.status || "未知", "neutral"];
    const [briefLabel, briefClass] = BRIEF_STATUS_META[file.brief?.status] || BRIEF_STATUS_META.none;
    const total = Number(file.totalSegments) || 0;
    const done = Number(file.completedSegments) || 0;
    const failed = Number(file.failedSegments) || 0;
    const percent = total ? Math.round((done / total) * 100) : 0;
    const reviewed = Number(file.learning?.humanReviewed) || 0;
    const trajectories = Number(file.learning?.count) || 0;
    const sizeText = formatBatchFileBytes(file.originalBytes);
    const isLast = String(state.lastBatchId || "") === String(file.batchId);
    // 质量档是逐段判定的：这里把"自动档实际用了哪几档"列出来，
    // 旧版本翻的段落没有档位字段，如实标"未记录"，不猜。
    const tierText = describeQualityTiers(file.qualityTiers);
    return `<article class="batch-file-row${isLast ? " is-last-opened" : ""}" data-batch-file="${escapeHtml(file.batchId)}">
      <div class="batch-file-main">
        <div class="batch-file-title"><strong>${escapeHtml(file.filename)}</strong>
          <span class="badge ${statusClass === "error" ? "error" : statusClass === "warning" ? "warning" : statusClass === "success" ? "success" : "neutral"}">${escapeHtml(statusLabel)}</span>
          ${isLast ? '<span class="batch-file-chip success">上次打开的</span>' : ""}
        </div>
        <small>${escapeHtml(String(file.format || "").toUpperCase())}${sizeText ? ` · ${sizeText}` : ""} · ${total} 段 · 最近更新 ${escapeHtml(formatTaskTime(file.updatedAt))}</small>
        ${tierText ? `<small class="batch-file-tiers" title="质量档按每段的风险自动判定；未记录的段落来自旧版本翻译">质量档：${escapeHtml(tierText)}</small>` : ""}
        <div class="batch-file-progress"><div><i style="width:${percent}%"></i></div><span>${done} / ${total}${failed ? `（失败 ${failed}）` : ""}</span></div>
      </div>
      <div class="batch-file-status">
        <span class="batch-file-chip ${briefClass}">语境 ${escapeHtml(briefLabel)}${file.brief?.status === "ready" && file.brief.sections ? ` · ${file.brief.sections} 区间` : ""}</span>
        <span class="batch-file-chip ${Number(file.qaPending) ? "warning" : ""}">QA 待处理 ${Number(file.qaPending) || 0}</span>
        <span class="batch-file-chip ${reviewed ? "success" : ""}">人工审校 ${reviewed ? `${reviewed} 条` : "无"}${trajectories && !reviewed ? `（${trajectories} 条轨迹未采纳）` : ""}</span>
      </div>
      <div class="batch-file-actions">
        <button class="button secondary small" type="button" data-batch-action="open" data-batch-id="${escapeHtml(file.batchId)}">打开文件</button>
        <button class="button ghost small" type="button" data-batch-action="export" data-batch-id="${escapeHtml(file.batchId)}" title="导出原文件 / 译文 / 双语">导出</button>
        <button class="button ghost small danger" type="button" data-batch-action="delete" data-batch-id="${escapeHtml(file.batchId)}">删除</button>
      </div>
    </article>`;
  }).join("");
}

/** 打开某个文件的批次工作台：把服务端的最新 run 合进页面状态。 */
async function openBatchFile(batchId, { silent = false } = {}) {
  if (!batchId) return false;
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`);
    state.batchFile = null;
    state.batchBase64 = "";
    state.batchPreview = run;
    state.batchHasStoredOriginal = Boolean(run.runnerOptions?.originalFile);
    state.batchClassification = { contentType: run.contentType || "general", source: "server-runner" };
    state.batchBrief = run.contextBrief || null;
    state.batchBriefPending = run.contextBrief?.status === "ready" ? false : Boolean(run.contextBriefPending);
    state.batchBriefDraft = null;
    state.batchReport = run.qualityReport || null;
    state.batchWorkflow = run.workflow || null;
    state.batchRunning = ["queued", "running"].includes(run.runState || "");
    state.batchPaused = run.runState === "paused";
  // 打开已有批次先落在队列上：文件与策略只需要在开跑前看一眼。
  state.batchTab = (run.segments || []).length ? "queue" : "setup";
  state.batchSegmentQuery = "";
  if ($("#batchSegmentSearch")) $("#batchSegmentSearch").value = "";
    localStorage.setItem("kami-batch-id", batchId);
    $("#batchFilePrompt").textContent = run.filename || "已载入批次";
    $("#batchFileMeta").textContent = `${(run.segments || []).length} 段 · ${["completed", "needs_attention"].includes(run.runState) ? "本轮翻译已结束" : run.runState === "paused" ? "已暂停" : "进行中"}`;
    $("#batchDropZone").classList.add("has-file");
    $("#batchBackFilename").textContent = run.filename || "";
    setTranslationMode("batch");
    renderBatchSegments();
    renderBatchBrief();
    renderBatchWorkflow();
    renderBatchReport();
    renderBatchTermSurvey();
    renderBatchTabs();
    await loadBatchBrief(run.batchId);
    startBatchBriefWatch(run.batchId);
    // 从文件列表打开正在跑的批次时也要持续轮询：否则这一页只在打开时取一次进度，
    // 任务中心却一直在刷新，看起来就是这边更新慢。
    if (state.batchRunning) pollServerBatch(batchId).catch((error) => toast(error.message));
    refreshActions();
    return true;
  } catch (error) {
    if (!silent) toast(error.message);
    return false;
  }
}

/** 导出一个批次：原文件直接下载；译文 / 双语走后端导出任务，完成后自动下载。 */
async function exportBatchFile(batchId, button) {
  const file = (state.batchFiles || []).find((item) => item.batchId === batchId);
  if (!file) return toast("找不到这条文件记录");
  return exportBatchTask(batchId, button);
}

/** 文件列表、当前文件和任务中心共用导出选项、门禁、后台生成与下载。 */
async function exportBatchTask(batchId, button, { segments = null } = {}) {
  const originalLabel = button?.textContent || "导出";
  const setButton = (text) => {
    if (!button) return;
    button.disabled = true;
    button.textContent = text;
  };
  const restoreButton = () => {
    if (!button) return;
    button.disabled = false;
    button.textContent = originalLabel;
  };
  setButton("读取中…");
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`);
    if (segments) run.segments = segments;
    if (batchQualityReportPending(run, run.workflow)) {
      await openExportDialog({ title: "质量报告生成中", summary: "本轮翻译已结束，质量报告（含 AI 终审）还在生成；完成后才能导出。进度可在任务中心查看。", items: [] });
      return;
    }
    const hasOriginal = Boolean(run.runnerOptions?.originalFile);
    let base64 = state.batchPreview?.batchId === batchId ? state.batchBase64 || undefined : undefined;
    const needsSource = ["xlsx", "csv", "xliff", "mqxliff"].includes(run.format);
    const missingSource = needsSource && !hasOriginal && !base64;
    const choice = await openChoiceDialog({
      kicker: "EXPORT OPTIONS",
      title: missingSource ? "没有原文件，无法写回" : `导出「${run.filename}」`,
      summary: `${hasOriginal ? "原文件已随批次存档。" : "没有原文件存档。"}双语文件保留原文与译文：表格填译文列，XLIFF / MQXLIFF 填 target；文本文档生成 XLSX 双语表。${batchWriteBackLabelFor(run)}`,
      options: [
        missingSource
          ? { id: "pick-source", label: "选择原文件并导出双语文件", hint: "选中该批次的原文件，译文填回对应位置；原文件会同时存档" }
          : { id: "bilingual", label: "导出双语文件", hint: "原文 + 译文，保留表格其它列与 XLIFF 结构；文本文档生成双语表" },
        { id: "translation", label: "导出译文", hint: "只保留译文；DOCX 生成译文文档，XLIFF / MQXLIFF 生成单列译文表" },
        ...(hasOriginal ? [{ id: "original", label: "导出原文件", hint: "下载上传时的原文件，内容不变" }] : []),
        { id: "task-xlsx", label: "导出任务 Excel（含 QA 信息）", hint: "序号 / 原文 / 译文 / 状态 / AIQA 分数 / QA 意见 / 人工决定" }
      ]
    });
    if (!choice) return;
    if (choice === "original") {
      setButton("下载中…");
      const delivered = await deliverExportedFile({ payload: {
        filename: run.filename,
        downloadUrl: `/api/tasks/${encodeURIComponent(batchId)}/original?projectId=${encodeURIComponent(run.projectId || state.activeProjectId || "")}`
      } }, "");
      toast(`原文件已交给浏览器保存 · ${delivered.message}`);
      return;
    }
    if (choice === "pick-source") {
      if (!(await pickBatchSourceFile())) return;
      base64 = state.batchBase64;
    }
    setButton(button?.id === "tertiaryAction" ? "正在检查导出条件…" : "检查中…");
    const gate = await exportPreflightForBatch(batchId, run);
    if (gate === null) {
      const proceed = await openExportDialog({
        title: "导出前检查没能完成", summary: "检查耗时过长或服务暂时不可用。可以跳过检查直接导出，也可以稍后重试。",
        items: [], forceLabel: "跳过检查，直接导出"
      });
      if (!proceed) return;
    } else if (!gate) return;
    setButton(button?.id === "tertiaryAction" ? "正在生成导出文件…" : "导出中…");
    const mode = choice === "translation" ? "translation" : "bilingual";
    const started = await api(`/api/tasks/${encodeURIComponent(batchId)}/export`, {
      method: "POST", body: JSON.stringify({
        ...projectPayload(), projectId: run.projectId || state.activeProjectId || "",
        filename: run.filename, format: choice === "task-xlsx" ? "task-xlsx" : mode,
        sourceFormat: run.format, mode, base64, structure: run.structure, segments: run.segments
      })
    });
    const finished = await waitForBackgroundTask(started.backgroundTaskId, { timeoutMs: 120_000 });
    if (finished?.status !== "completed") throw new Error(finished?.progress?.message || "导出未完成，请在任务中心查看进度");
    const delivered = await deliverExportedFile(finished, started.backgroundTaskId, { filename: run.filename });
    await openExportDialog({
      title: "导出完成", summary: `${finished.payload?.filename || run.filename} · ${choice === "translation" ? "仅译文" : choice === "task-xlsx" ? "任务 Excel（含 QA 信息）" : "双语文件"}。${delivered.message || ""}；任务中心可追溯。`, items: []
    });
  } catch (error) {
    if (error.message === "已取消保存") toast(error.message);
    else await openExportDialog({ title: "导出失败", summary: error.message, items: [] });
  } finally {
    restoreButton();
  }
}

/** 导出前的 QA 门禁：有硬问题就列出来，让用户决定是否照常导出。 */
async function exportPreflightForBatch(batchId, file) {
  const run = file.segments ? file : await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`);
  if (!run) throw new Error("未找到这条翻译任务");
  const gate = await api("/api/batch/export/preflight", {
    method: "POST",
    signal: AbortSignal.timeout(EXPORT_PREFLIGHT_TIMEOUT_MS),
    body: JSON.stringify({
      ...projectPayload(),
      batchId,
      locale: run.locale,
      contentType: run.contentType || "general",
      domain: run.domain || "general",
      segments: (run.segments || []).map(({ id, source, selected, translation }) => ({ id, source, selected, translation }))
    })
  }).catch(() => null);
  if (!gate) return null;
  if (gate.ok && !gate.warnings?.length) return true;
  if (gate.ok) return openExportDialog({ title: `导出前有 ${gate.warnings.length} 条提醒`, summary: "只是提醒，不影响导出。可以看一眼再决定。", items: gate.warnings.slice(0, 20), forceLabel: "继续导出" });
  return await openExportDialog({
    title: `导出被 QA 门禁挡住（${gate.blocking.length} 项）`,
    summary: `${file.filename}：这些是规则层的硬问题（占位符、术语、数字、未翻译等）。修好再导出最稳，也可以强制导出。`,
    items: gate.blocking.slice(0, 20),
    forceLabel: "仍然导出（跳过门禁）"
  });
}

/** 删除一个待译文件：批次记录 + 原文件存档 + 导出文件一起清掉，已入库的 TM/术语/学习轨迹保留。 */
async function deleteBatchFileRow(batchId, button) {
  const file = (state.batchFiles || []).find((item) => item.batchId === batchId);
  if (!confirm(`确认删除「${file?.filename || "这份文件"}」？\n\n会删除：批次记录、原文件存档、导出文件。\n保留：已写入主 TM / 术语库的条目，以及学习中心里由它产生的轨迹（人工审校记录不会丢）。`)) return;
  if (button) { button.disabled = true; button.textContent = "删除中…"; }
  try {
    await api(`/api/tasks/${encodeURIComponent(batchId)}?stop=1`, { method: "DELETE" });
    toast(`已删除「${file?.filename || "文件"}」`);
    if (state.batchPreview?.batchId === batchId) resetBatchFileSelection();
    await loadBatchFiles();
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = "删除"; }
  }
}

/** 下载一个后端生成的文件（走浏览器原生下载，不把几百 MB 塞进 JS 内存）。 */
function downloadUrl(url) {
  const anchor = document.createElement("a");
  anchor.href = url;
  // 明确声明是下载：服务端带了 content-disposition，但补一个 download 能保证
  // 任何情况下都不会把 JSON/二进制直接导航到当前标签页里。
  anchor.download = "";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** 等一个后台任务到终态。 */
async function waitForBackgroundTask(taskId, { timeoutMs = 60_000, intervalMs = 1_200 } = {}) {
  if (!taskId) return null;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await api(`/api/background-tasks/${encodeURIComponent(taskId)}`, {}, { logFailure: false }).catch(() => null);
    const task = response?.task || response;
    if (task) {
      last = task;
      if (["completed", "failed", "needs_attention"].includes(task.status)) return task;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

/**
 * 后台导出任务完成后把文件交给用户：浏览器支持时仍然弹「另存为」，
 * 下载接口报错时明确失败，不把 JSON 错误响应当成文件，也不误报成功。
 */
async function deliverExportedFile(finished, taskId, { filename = "" } = {}) {
  const href = finished?.payload?.downloadUrl || `/api/export-tasks/${encodeURIComponent(taskId)}/download`;
  const response = await fetch(href);
  if (!response.ok || response.headers.get("content-type")?.includes("application/json")) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `下载失败（HTTP ${response.status}），请重新导出`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("导出文件为空，请重新导出");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return await saveExportedFile({
    filename: finished?.payload?.filename || filename || "导出文件",
    mimeType: finished?.payload?.mimeType || response.headers.get("content-type") || "application/octet-stream",
    base64: btoa(binary)
  });
}

const BATCH_COLUMN_ROLES = [
  { value: "source_text", label: "日文原文（要翻译）" },
  { value: "existing_translation", label: "已有译文（参考）" },
  { value: "translation_output", label: "写回译文的列" },
  { value: "entry_id", label: "条目 ID" },
  { value: "context", label: "上下文 / 说明" },
  { value: "constraint", label: "约束（字数、语言…）" },
  { value: "ignore", label: "忽略此列" }
];

/**
 * 待译表格上传后的"列含义"确认弹窗。
 *
 * 只对 .xlsx / .csv 弹：先让服务端给出每列的建议角色与样例，用户逐列调整、并决定首行是不是表头，
 * 确认后把映射交给 /api/batch/prepare。返回 true 表示用户确认（可以继续解析），false 表示取消。
 */
async function confirmBatchColumns(file) {
  const dialog = $("#batchColumnDialog");
  if (!dialog) return true;
  let structure = null;
  try {
    structure = await api("/api/batch/columns", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: file.name,
      base64: await fileToBase64(file),
      locale: state.workbenchLocale,
      useAiStructure: true
    }) });
  } catch (error) {
    // 结构识别失败不该拦住上传：退回原来的全自动解析，并把原因告诉用户。
    toast(`列结构识别失败，将按自动识别导入：${error.message}`);
    return true;
  }
  state.batchColumns = structure;
  state.batchColumnMapping = null;

  const renderColumns = () => {
    const sheets = structure.sheets || [];
    $("#batchColumnSummary").textContent = `已识别 ${sheets.length} 个工作表、${sheets.reduce((sum, sheet) => sum + (sheet.columns?.length || 0), 0)} 列（${structure.structureSource === "model" ? "AI + 规则" : "本地规则"}）。逐列确认后再开始分段，只有「日文原文」列会被送去翻译。`;
    $("#batchColumnBody").innerHTML = sheets.map((sheet, sheetIndex) => `
      <section class="batch-column-sheet" data-sheet="${escapeHtml(sheet.sheet)}">
        <div class="batch-column-sheet-head">
          <div><strong>${escapeHtml(sheet.sheet)}</strong><small>${sheet.rowCount} 行 · ${escapeHtml(sheet.reason || "")}</small></div>
          <label class="batch-column-header-toggle"><input type="checkbox" data-sheet-header="${sheetIndex}" ${sheet.headerRow ? "checked" : ""} />首行是表头</label>
        </div>
        ${(sheet.columns || []).map((column) => `
          <div class="batch-column-row">
            <div class="batch-column-key"><b>${escapeHtml(column.letter)} 列</b>${escapeHtml(column.header || "无表头")}</div>
            <div class="batch-column-samples">${column.headerEmpty ? '<em class="batch-column-tag">表头为空 · 按下面内容识别</em>' : ""}${(column.samples?.length ? column.samples : ["（空）"]).map((sample) => `<em class="${sample === "（空）" ? "is-empty" : ""}">${escapeHtml(sample)}</em>`).join("")}<em class="is-empty">识别依据：${escapeHtml(column.reason || "")}</em></div>
            <select data-sheet-index="${sheetIndex}" data-column="${column.column}">${BATCH_COLUMN_ROLES.map((role) => `<option value="${role.value}"${column.role === role.value ? " selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}</select>
          </div>`).join("")}
      </section>`).join("") || '<div class="empty-list">这个文件没有可识别的列</div>';
    updateBatchColumnState();
  };

  const collectMapping = () => ({
    sheets: (structure.sheets || []).map((sheet, sheetIndex) => ({
      sheet: sheet.sheet,
      headerRow: $(`[data-sheet-header="${sheetIndex}"]`)?.checked ? (sheet.headerRow || 1) : null,
      columns: $$(`select[data-sheet-index="${sheetIndex}"]`).map((select) => ({ column: Number(select.dataset.column), role: select.value }))
    }))
  });

  const updateBatchColumnState = () => {
    const mapping = collectMapping();
    const sourceCount = mapping.sheets.reduce((sum, sheet) => sum + sheet.columns.filter((column) => column.role === "source_text").length, 0);
    // 直接用当前选择（用户可能刚把某列改成写回列），标签从原始结构里取。
    const outputColumns = mapping.sheets.flatMap((sheet, sheetIndex) => sheet.columns
      .filter((column) => column.role === "translation_output")
      .map((column) => (structure.sheets[sheetIndex]?.columns || []).find((item) => item.column === column.column) || { letter: String(column.column) }));
    const outputCount = outputColumns.length;
    $("#batchColumnConfirm").disabled = sourceCount === 0;
    $("#batchColumnHint").classList.toggle("is-error", sourceCount === 0);
    $("#batchColumnHint").textContent = sourceCount
      ? `将翻译 ${sourceCount} 列日文原文；${outputCount ? `译文导出时写到「${outputColumns.map((column) => column.label || column.letter).join("」「")}」` : "没有指定写回列 → 导出时原位覆盖原文列"}；「已有译文」只作参考、「条目 ID」用于写回记忆库时的身份匹配。`
      : "至少要指定一列「日文原文」，否则没有可翻译的内容。";
    $$("#batchColumnBody select").forEach((select) => { select.dataset.role = select.value; });
  };

  renderColumns();
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("change", onChange);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClick = (event) => {
      if (event.target.closest("#batchColumnConfirm")) return finish(collectMapping());
      if (event.target.closest("#batchColumnReset")) {
        state.batchColumns = structure;
        renderColumns();
      }
    };
    const onChange = (event) => {
      const target = event.target;
      if (target.matches("[data-sheet-header]")) {
        const index = Number(target.dataset.sheetHeader);
        structure.sheets[index].headerRow = target.checked ? (structure.sheets[index].headerRow || 1) : null;
        renderColumns();
        return;
      }
      updateBatchColumnState();
    };
    const onCancel = (event) => { event.preventDefault(); finish(null); };
    // × / 取消 走通用关闭按钮，关闭事件兜底成"未确认"。
    const onClose = () => finish(null);
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("change", onChange);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
  if (!result) return false;
  state.batchColumnMapping = result;
  return true;
}

/** 取消列确认时把上传状态清干净，避免界面停在"已选择文件"却没有解析结果。 */
function resetBatchFileSelection() {
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchColumnMapping = null;
  $("#batchFile").value = "";
  $("#batchFilePrompt").textContent = "拖入或点击选择文件";
  $("#batchFileMeta").textContent = `拖入后自动识别；支持 TXT、Markdown、DOCX、XLSX、CSV、XLIFF、MQXLIFF，最大 ${UPLOAD_FILE_LABEL}`;
  $("#batchDropZone").classList.remove("has-file");
  $("#batchSourceMeta").textContent = "等待文件";
  renderBatchSegments();
  refreshActions();
}

async function resetBatch() {
  if (state.batchRunning) await pauseBatch();
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchRunning = false;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  updateBatchSegmentationOptions("");
  localStorage.removeItem("kami-batch-id");
  $("#batchFile").value = "";
  $("#batchFilePrompt").textContent = "拖入或点击选择文件";
  $("#batchFileMeta").textContent = `拖入后自动识别；支持 TXT、Markdown、DOCX、XLSX、CSV、XLIFF、MQXLIFF，最大 ${UPLOAD_FILE_LABEL}`;
  $("#batchDropZone").classList.remove("has-file");
  $("#batchSourceMeta").textContent = "尚未载入";
  $("#spreadsheetAnalysis").hidden = true;
  state.batchTab = "setup";
  state.termFilter = "";
  state.batchSegmentQuery = "";
  if ($("#batchSegmentSearch")) $("#batchSegmentSearch").value = "";
  renderBatchSegments();
  renderBatchTermSurvey();
  renderBatchTabs();
  refreshActions();
}

function batchStatus(segment) {
  if (!segment.selected) return ["pending", "已跳过", "导出时保留原文"];
  if (segment.status === "running") return ["running", "翻译中", "术语匹配与 QA"];
  if (segment.status === "error") return ["error", "翻译失败", segment.error || "可继续重试"];
  if (segment.status === "done") {
    const issues = segment.result?.issues || [];
    if (segment.result?.aiQa?.fallbackReason) {
      const reason = String(segment.result.aiQa.fallbackReason).replace(/\s+/g, " ").slice(0, 90);
      return ["warning", "AIQA 未完成", reason || "需要重试或人工复核"];
    }
    if (Number.isFinite(segment.result?.qaScore) && segment.result.qaScore < 90) return ["warning", "需要复核", `AIQA ${segment.result.qaScore} 分`];
    const errors = issues.filter((issue) => issue.severity === "error").length;
    if (errors) return ["warning", "需要复核", `${errors} 个阻断项`];
    if (issues.length) return ["warning", "建议确认", `${issues.length} 条建议`];
    return ["success", "QA 通过", `${Number.isFinite(segment.result?.qaScore) ? `${segment.result.qaScore} 分 · ` : ""}${segment.result?.matches?.length || 0} 条术语`];
  }
  return ["pending", "待翻译", "等待队列"];
}

function renderSpreadsheetAnalysis(analysis) {
  const element = $("#spreadsheetAnalysis");
  if (!analysis?.sheets?.length) {
    element.hidden = true;
    return;
  }
  const roleLabels = { source_text: "正文", context: "补充信息", constraint: "约束", existing_translation: "已有译文", ignore: "忽略" };
  const sourceLabel = analysis.usedModel ? "AI 已识别" : "规则降级识别";
  element.hidden = false;
  element.innerHTML = `<div class="analysis-head"><strong>Excel 结构识别</strong><span>${sourceLabel}${analysis.fallbackReason ? ` · ${escapeHtml(analysis.fallbackReason)}` : ""}</span></div>${analysis.sheets.map((sheet) => `
    <div class="analysis-sheet"><strong>${escapeHtml(sheet.sheet)} · ${sheet.headerRow ? `表头第 ${sheet.headerRow} 行` : "无表头自动推断"} · ${Math.round((sheet.confidence || 0) * 100)}%</strong><div class="analysis-columns">${sheet.columns.map((column) => `<span class="analysis-column ${column.role}" title="${escapeHtml(column.reason)}">${escapeHtml(column.letter)} · ${escapeHtml(column.label)} → ${roleLabels[column.role] || column.role}</span>`).join("")}</div></div>
  `).join("")}`;
}

function renderBatchTarget(segment) {
  const running = segment.status === "running";
  const rendered = segment.result && segment.translation
    ? renderTranslationMarkup(segment.translation, segment.result.matches || [], [])
    : { html: escapeHtml(segment.translation || ""), officialCount: 0 };
  const placeholder = running ? "正在翻译…" : "译文将在这里显示";
  return `<div class="batch-segment-target${running ? " disabled" : ""}" data-id="${escapeHtml(segment.id)}" data-placeholder="${placeholder}" role="textbox" aria-label="第 ${segment.index} 段译文" aria-multiline="true" contenteditable="${running ? "false" : "true"}">${rendered.html}</div>${rendered.officialCount ? `<div class="batch-term-legend"><i></i>${rendered.officialCount} 处正式术语</div>` : ""}`;
}

function batchIssueHtml(issue, index, segmentId) {
  const severity = issue.mqmSeverity || issue.severity || "warning";
  const label = severity === "critical" ? "严重" : severity === "major" || severity === "error" ? "主要" : "次要";
  const spans = [issue.sourceSpan ? `原文：${issue.sourceSpan}` : "", issue.targetSpan ? `译文：${issue.targetSpan}` : ""].filter(Boolean).join(" · ");
  const reject = issue.severity !== "error" || issue.mqmSeverity === "minor" ? `<button class="button ghost small batch-qa-action" data-action="reject" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">拒绝意见</button>` : "";
  return `<div class="batch-qa-issue ${escapeHtml(severity)}"><strong>${label} · ${escapeHtml(issue.category || issue.type || "QA")}</strong><p>${escapeHtml(issue.message || "未说明问题")}</p>${issue.suggestion ? `<p class="suggestion">建议：${escapeHtml(issue.suggestion)}</p>` : ""}${spans ? `<small>${escapeHtml(spans)}</small>` : ""}<div class="qa-decision-actions"><button class="button ghost small batch-qa-action" data-action="accept" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">采纳并让 AI 修订</button><button class="button ghost small batch-qa-action" data-action="partial" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">部分采纳</button>${reject}</div></div>`;
}

/**
 * 每段的常显元信息行：ID · 注释 · 命中术语 · 命中的 TM 译例。
 * 长内容截断，完整清单仍在下面的「查看术语、译例与 QA 意见」里。
 */
const SEGMENT_META_TERM_LIMIT = 3;
const SEGMENT_META_REFERENCE_LIMIT = 2;

function renderSegmentMeta(segment = {}) {
  const ids = segmentIds(segment);
  const notes = segmentNotes(segment);
  const matches = Array.isArray(segment.result?.matches) ? segment.result.matches : [];
  const references = Array.isArray(segment.result?.aiQa?.references) ? segment.result.aiQa.references : [];
  const termChips = matches.slice(0, SEGMENT_META_TERM_LIMIT).map((match) => {
    const mode = match?.mode !== "exact" ? "疑似" : (match?.scopeMismatch ? "跨语体登记" : "登记术语");
    return `<span class="segment-meta-chip" title="${escapeHtml(`${match?.term?.source || match?.matchPhrase || ""} → ${match?.term?.target || ""}`)}">${escapeHtml(match?.term?.source || match?.matchPhrase || "")} → ${escapeHtml(match?.term?.target || "")}<small>${escapeHtml(mode)}</small></span>`;
  }).join("");
  const moreTerms = matches.length > SEGMENT_META_TERM_LIMIT
    ? `<span class="segment-meta-chip more">+${matches.length - SEGMENT_META_TERM_LIMIT}</span>` : "";
  const referenceChips = references.slice(0, SEGMENT_META_REFERENCE_LIMIT).map((item) => {
    const percent = Math.round((Number(item?.similarity) || 0) * 100);
    const status = item?.qualityStatus === "human_approved" ? "人工批准" : "机器验证";
    const text = `${item?.source || ""} → ${item?.target || ""}`;
    return `<span class="segment-meta-chip" title="${escapeHtml(text)}">${percent}% · ${escapeHtml(status)}：${escapeHtml(text.length > 42 ? `${text.slice(0, 42)}…` : text)}</span>`;
  }).join("");
  const moreReferences = references.length > SEGMENT_META_REFERENCE_LIMIT
    ? `<span class="segment-meta-chip more">+${references.length - SEGMENT_META_REFERENCE_LIMIT}</span>` : "";
  const noteText = notes.join(" ／ ");
  const fields = [
    `<span class="segment-meta-field"><em>ID</em><span class="segment-meta-value">${escapeHtml(ids[0] || "—")}</span>${ids[1] ? `<small title="${escapeHtml(ids.slice(1).join("、"))}">· ${escapeHtml(ids[1].length > 16 ? `${ids[1].slice(0, 16)}…` : ids[1])}</small>` : ""}</span>`,
    noteText ? `<span class="segment-meta-field note" title="${escapeHtml(noteText)}"><em>注释</em><span class="segment-meta-note">${escapeHtml(noteText)}</span></span>` : "",
    `<span class="segment-meta-field"><em>术语</em>${termChips || '<span class="segment-meta-empty">—</span>'}${moreTerms}</span>`,
    `<span class="segment-meta-field"><em>TM</em>${referenceChips || '<span class="segment-meta-empty">无达到门槛的译例</span>'}${moreReferences}</span>`
  ].filter(Boolean);
  return `<div class="batch-segment-meta">${fields.join("")}</div>`;
}

function renderBatchDetails(segment) {
  const result = segment.result;
  if (segment.status !== "done" || !result) return "";
  const aiQa = result.aiQa || {};
  const matches = result.matches || [];
  const issues = result.issues || [];
  const references = aiQa.references || [];
  const qaCases = aiQa.qaCases || [];
  const termDecisions = aiQa.termDecisions || [];
  const humanDecisions = aiQa.humanDecisions || [];
  const summary = [
    aiQa.fallbackReason ? "AIQA 未完成" : Number.isFinite(result.qaScore) ? `AIQA ${result.qaScore} 分` : "规则 QA",
    `${matches.length} 条术语`,
    `${references.length} 条译例`,
    `${aiQa.iterations || 0} 次修订`,
    issues.length ? `${issues.length} 条建议` : aiQa.fallbackReason ? "AIQA 待重试" : "无问题"
  ];
  const scopeNote = scopeUsageText(result.scopeUsage);
  if (scopeNote) summary.push(scopeNote);
  const summaryText = summary.join(" · ");
  const termsHtml = matches.length ? matches.map((match) => `<div class="batch-detail-item"><strong>${escapeHtml(match.term?.source)} → ${escapeHtml(match.term?.target)}</strong><small>${match.mode === "exact" ? "正式/别名命中" : `疑似命中：${escapeHtml(match.matchPhrase || "")}`} · ${Math.round((match.score || 0) * 100)}%</small></div>`).join("") : '<div class="batch-detail-empty">本段没有命中术语</div>';
  const issuesHtml = issues.length ? issues.map((issue, index) => batchIssueHtml(issue, index, segment.id)).join("") : `<div class="batch-detail-empty">${aiQa.fallbackReason ? "硬规则通过；AIQA 尚待重试" : "硬规则与 AIQA 均未发现问题"}</div>`;
  const referencesHtml = references.length ? references.map((item) => {
    const type = contentTypeLabel(item.contentType || "general");
    const tags = contentTagLabels(item.contentType || "general", item.contentTags);
    const origin = item.sourceFile
      ? `${item.sourceFile}${item.sourceRow ? ` · 第 ${item.sourceRow} 行` : ""}`
      : ({ "human-accept": "工作台人工采纳", "table-import": "术语表导入", "aiqa-passed": "AIQA 通过", "aiqa-corrected": "AIQA 修订" }[item.provenance] || item.provenance || "历史资产");
    return `<div class="batch-memory-item"><div><strong>${Math.round((item.similarity || 0) * 100)}% · ${escapeHtml(item.qualityStatus === "human_approved" ? "人工批准" : "机器验证")}</strong><small>${escapeHtml([type, ...tags, origin].filter(Boolean).join(" · "))}</small><p>${escapeHtml(item.source)}</p><p class="target">${escapeHtml(item.target)}</p></div></div>`;
  }).join("") : '<div class="batch-detail-empty">没有达到相关度门槛的同类译例</div>';
  const qaCasesHtml = qaCases.length ? `<section><h5>历史 AIQA 反例</h5>${qaCases.map((item) => `<div class="batch-memory-item"><div><p>${escapeHtml(item.rejectedTranslation || "")}</p><p class="target">修订：${escapeHtml(item.correctedTranslation || "")}</p></div></div>`).join("")}</section>` : "";
  const decisionsHtml = termDecisions.length ? `<section><h5>AI 术语裁决</h5>${termDecisions.map((item) => `<div class="batch-detail-item"><strong>${item.decision === "apply" ? "已采用" : "不强制替换"} · ${escapeHtml(item.matchedSource)} → ${escapeHtml(item.officialTarget)}</strong><small>${escapeHtml(item.reason)}</small></div>`).join("")}</section>` : "";
  const humanDecisionsHtml = humanDecisions.length ? `<section><h5>人工 QA 决定</h5>${humanDecisions.map((item) => `<div class="batch-detail-item"><strong>${escapeHtml(item.actionLabel || item.action || item.decision || "已处理")}</strong><small>${escapeHtml(item.issue?.message || item.issue || item.reason || "QA 意见")}</small></div>`).join("")}</section>` : "";
  const receiptHtml = result.reviewReceipt?.textZh ? `<section><h5>处理回执</h5><div class="reflection-box review-receipt">${escapeHtml(result.reviewReceipt.textZh)}</div></section>` : "";
  const fallback = aiQa.fallbackReason ? `<div class="batch-qa-fallback"><strong>AIQA 未完成</strong><span>${escapeHtml(aiQa.fallbackReason)}</span><button type="button" class="button ghost small retry-segment-qa" data-id="${escapeHtml(segment.id)}">仅重跑本段 QA</button></div>` : "";
  return `<details class="batch-segment-details${aiQa.fallbackReason ? " has-warning" : ""}">
    <summary>${escapeHtml(summaryText)}<span>查看术语、译例与 QA 意见</span></summary>
    ${fallback}
    <div class="batch-detail-grid">
      <section><h5>术语命中</h5>${termsHtml}</section>
      <section><h5>QA 意见</h5>${issuesHtml}</section>
      <section><h5>相似译例检索</h5>${referencesHtml}</section>
      ${qaCasesHtml}
      ${decisionsHtml}
      ${humanDecisionsHtml}
      ${receiptHtml}
    </div>
  </details>`;
}

/**
 * 分段属于哪一类 QA 状态：需要复核（分数低 / AIQA 未完成 / 有阻断项）、
 * 建议确认（有 warning 建议）、通过、待翻译、已跳过。
 * 翻译界面的筛选与"跳到下一条待处理"用它，口径与任务中心的待处理计数一致。
 */
function batchSegmentGroup(segment) {
  if (!segment.selected) return "skipped";
  if (segment.status === "error") return "attention";
  if (segment.status !== "done") return "pending";
  const result = segment.result || {};
  const issues = result.issues || [];
  if (result.aiQa?.fallbackReason) return "attention";
  if (Number.isFinite(result.qaScore) && result.qaScore < 90) return "attention";
  if (issues.some((issue) => ["error", "critical"].includes(issue.severity))) return "attention";
  if (segment.accepted) return "pass";
  if (issues.length) return "suggest";
  return "pass";
}

const BATCH_QA_CHIPS = [["", "全部"], ["attention", "需要复核"], ["suggest", "建议确认"], ["pending", "待翻译"], ["pass", "通过"], ["skipped", "已跳过"]];

/** 任务中心「N 条待处理」：打开这条批次并直接跳到第一条待处理分段。 */
async function jumpToTaskQa(batchId, button) {
  const task = findBatchTask(batchId);
  if (!task) return toast("找不到这条批次任务");
  if (button) button.disabled = true;
  try {
    await openTask(batchId);
    if (state.batchPreview?.batchId !== batchId) return;
    state.batchQaCursor = -1;
    jumpToNextBatchIssue();
  } finally {
    if (button) button.disabled = false;
  }
}

/** 跳到下一条待处理分段（需要复核 / 建议确认），在当前筛选结果里循环，滚动并高亮。 */
function jumpToNextBatchIssue() {
  const segments = state.batchPreview?.segments || [];
  const filter = state.batchSegmentFilter || "";
  const pool = segments.filter((segment) => (filter
    ? batchSegmentGroup(segment) === filter
    : ["attention", "suggest"].includes(batchSegmentGroup(segment))));
  if (!pool.length) return toast("没有待处理的分段");
  state.batchQaCursor = (Number(state.batchQaCursor) + 1) % pool.length;
  const target = pool[state.batchQaCursor];
  // 当前筛选可能把它隐藏了：先切到"全部"，保证目标可见。
  if (filter && pool.length === 1) {
    state.batchSegmentFilter = "";
    batchSegmentLimit = BATCH_SEGMENT_PAGE_SIZE;
    renderBatchSegments();
  }
  // 目标可能在"加载更多"之后：先把分页扩到包含它，再滚动。
  const targetIndex = filteredBatchSegments().findIndex(({ segment }) => segment.id === target.id);
  if (targetIndex >= batchSegmentLimit) {
    batchSegmentLimit = targetIndex + 1;
    renderBatchSegments();
  }
  const row = document.querySelector(`.batch-segment[data-segment-id="${CSS.escape(String(target.id))}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-highlighted");
  setTimeout(() => row.classList.remove("is-highlighted"), 2_500);
}

/**
 * 跳过说明：XLIFF 里被跳过的句段（锁定 / 已有译文）不参与翻译，但要讲清楚，
 * 否则用户会以为"段数不对/漏翻了"——导出时这些句段会原样保留。
 */
function batchSkipSummary(structure) {
  const xliff = structure?.xliff || {};
  const locked = Number(xliff.skippedLocked) || 0;
  const existing = Number(xliff.skippedExisting) || 0;
  const skipped = locked + existing;
  if (!skipped) return "";
  const reasons = [locked ? `锁定 ${locked}` : "", existing ? `已有译文 ${existing}` : ""].filter(Boolean).join("、");
  return ` · 跳过 ${skipped}（${reasons}）`;
}

/** 分段队列左上角那句"N 字 · M 段 / M 段 · 历史任务"统一带上跳过说明。 */
function batchSourceMetaText({ segments, characters, suffix }) {
  const count = Number(segments) || 0;
  const prefix = characters ? `${characters} 字 · ` : "";
  return `${prefix}${count} 段${batchSkipSummary(state.batchPreview?.structure)}${suffix ? ` · ${suffix}` : ""}`;
}

const BATCH_STAGE_LABELS = { translation: "翻译", aiQa: "AIQA", qualityReport: "质量报告", termSurvey: "术语普查" };
const BATCH_STAGE_STATES = { completed: "已完成", in_progress: "进行中", waiting: "等待", needs_attention: "未完成", blocked: "暂无法执行", disabled: "自动执行已关闭", paused: "已暂停", not_started: "未开始" };
let batchWorkflowTimer = 0;
let batchWorkflowPolling = false;

function batchWorkflowCards(workflow) {
  if (!workflow) return "";
  return Object.entries(BATCH_STAGE_LABELS).map(([key, label]) => {
    const stage = workflow[key];
    if (!stage) return "";
    return `<div class="batch-workflow-stage ${escapeHtml(stage.status)}"><strong>${label}<span>${key === "translation" && stage.finished ? "本轮已结束" : escapeHtml(BATCH_STAGE_STATES[stage.status] || stage.status)}</span></strong><small>${escapeHtml(stage.message || "")}</small>${stage.status === "in_progress" ? `<div class="batch-workflow-track"><i style="width:${Math.max(0, Math.min(100, Number(stage.percent) || 0))}%"></i></div>` : ""}</div>`;
  }).join("");
}

function currentBatchWorkflow() {
  const run = state.batchPreview;
  if (!run) return null;
  return state.batchWorkflow?.batchId === run.batchId ? state.batchWorkflow : buildBatchWorkflow({ ...run, qualityReport: state.batchReport });
}

function renderBatchWorkflow() {
  const panel = $("#batchWorkflow");
  if (!panel) return;
  const workflow = currentBatchWorkflow();
  panel.hidden = !workflow;
  if (!workflow) return;
  $("#batchWorkflowStages").innerHTML = batchWorkflowCards(workflow);
  const summary = workflow.summary;
  $("#batchWorkflowSummary").textContent = `${workflow.overall?.message || workflow.translation.message}${summary.qaIncomplete ? ` · AIQA 未完成 ${summary.qaIncomplete} 段` : ""}`;
  $("#batchWorkflowNote").textContent = summary.failed || summary.qaIncomplete
    ? `报告与普查继续使用已有译文，覆盖缺口会保留提示：${summary.failed ? `翻译失败 ${summary.failed} 段` : ""}${summary.failed && summary.qaIncomplete ? "；" : ""}${summary.qaIncomplete ? `AIQA 未完成 ${summary.qaIncomplete} 段` : ""}。重试后会自动刷新收尾结果。`
    : "质量报告与术语普查的执行状态分别显示；本轮翻译结束后，后续检查仍可能进行中。";
  const retry = $("#batchRetryQa");
  const qaRunning = ["waiting", "in_progress"].includes(workflow.aiQa.status) || workflow.qaRetryBusy;
  retry.hidden = !summary.qaIncomplete && !qaRunning;
  retry.disabled = state.batchRunning || qaRunning;
  retry.textContent = qaRunning ? workflow.aiQa.status === "completed" || workflow.aiQa.status === "needs_attention" ? "QA 重试收尾中…" : "AIQA 重试中…" : `重试未完成 AIQA（${summary.qaIncomplete}）`;
  if (state.translationMode === "batch" && state.view === "workbench" && (workflow.qaRetryBusy || Object.keys(BATCH_STAGE_LABELS).some((key) => ["waiting", "in_progress"].includes(workflow[key]?.status))) && !batchWorkflowTimer) startBatchWorkflowWatch();
}

function startBatchWorkflowWatch(batchId = state.batchPreview?.batchId) {
  window.clearInterval(batchWorkflowTimer);
  batchWorkflowTimer = 0;
  if (!batchId) return;
  const update = async () => {
    if (batchWorkflowPolling || document.hidden) return;
    if (state.batchPreview?.batchId !== batchId || state.view !== "workbench" || state.translationMode !== "batch") {
      window.clearInterval(batchWorkflowTimer); batchWorkflowTimer = 0; return;
    }
    if (state.batchRunning) return;
    batchWorkflowPolling = true;
    try {
      const payload = await api(`/api/batch/run/${encodeURIComponent(batchId)}/status?projectId=${encodeURIComponent(state.activeProjectId || "")}`, {}, { logFailure: false });
      if (!payload.workflow) { window.clearInterval(batchWorkflowTimer); batchWorkflowTimer = 0; return; }
      const summary = summarizeBatchSegments(state.batchPreview.segments);
      const changed = payload.workflow.summary.qaIncomplete !== summary.qaIncomplete
        || payload.qualityReportAt !== (state.batchReport?.report?.generatedAt || "")
        || payload.termSurveyAt !== (state.batchPreview.runnerOptions?.termSurvey?.generatedAt || state.batchPreview.termSurvey?.generatedAt || "")
        || payload.qaCompletedAt !== (state.batchPreview.runnerOptions?.qaCompletedAt || "");
      const stagesChanged = JSON.stringify(state.batchWorkflow) !== JSON.stringify(payload.workflow);
      state.batchWorkflow = payload.workflow;
      renderBatchWorkflow();
      renderBatchTabs();
      if (stagesChanged) { renderBatchReport(); renderBatchTermSurvey(); }
      if (changed) {
        const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`);
        if (state.batchPreview?.batchId === batchId) mergeServerBatchRun(run);
      }
      if (!payload.workflow.qaRetryBusy && !Object.keys(BATCH_STAGE_LABELS).some((key) => ["waiting", "in_progress"].includes(payload.workflow[key]?.status))) {
        window.clearInterval(batchWorkflowTimer); batchWorkflowTimer = 0;
      }
    } catch (error) {
      $("#batchWorkflowNote").textContent = `阶段进度读取失败：${error.message}。页面会继续重试，也可刷新后查看。`;
    } finally { batchWorkflowPolling = false; }
  };
  batchWorkflowTimer = window.setInterval(update, 2_000);
  update();
}

async function retryBatchQa(batchId = state.batchPreview?.batchId, button = $("#batchRetryQa"), segmentIds = null) {
  if (!batchId) return;
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "提交 QA 重试…"; }
  try {
    const result = await api(`/api/batch/run/${encodeURIComponent(batchId)}/retry-qa`, { method: "POST", body: JSON.stringify({ ...projectPayload(), segmentIds }) });
    toast(result.alreadyRunning ? "这条 QA 重试或收尾已在执行，进度见阶段状态" : result.total === 0 ? result.message : result.waiting ? "QA 重试已排队，等当前报告 / 普查结束后自动执行" : "已开始仅重试未完成的 AIQA，完成后自动刷新报告与普查");
    if (state.batchPreview?.batchId === batchId && result.total !== 0 && !result.alreadyRunning) {
      state.batchWorkflow = { ...currentBatchWorkflow(), aiQa: { status: "waiting", message: "QA 重试已排队" } };
      renderBatchWorkflow();
      startBatchWorkflowWatch(batchId);
    }
    if (state.view === "tasks") await loadTasks();
  } catch (error) { toast(`AIQA 重试失败：${error.message}`); }
  finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = original; }
    if (state.batchPreview?.batchId === batchId) renderBatchWorkflow();
  }
}

const BATCH_SEGMENT_PAGE_SIZE = 200;
let batchSegmentLimit = BATCH_SEGMENT_PAGE_SIZE;
let batchSegmentLimitBatchId = "";

/** 当前筛选/搜索下要展示的段落（保留原始序号）；分页和跳转共用这一份口径。 */
function filteredBatchSegments() {
  const segments = state.batchPreview?.segments || [];
  const filter = state.batchSegmentFilter || "";
  const query = state.batchSegmentQuery || "";
  return segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => !filter || batchSegmentGroup(segment) === filter)
    .filter(({ segment }) => segmentMatchesQuery(segment, query));
}

function renderBatchSegments() {
  renderBatchWorkflow();
  const container = $("#batchSegments");
  const segments = state.batchPreview?.segments || [];
  const batchId = state.batchPreview?.batchId || "";
  if (batchSegmentLimitBatchId !== batchId) {
    // 切批次时回到第一页，避免把上一批的"加载更多"状态带过来。
    batchSegmentLimitBatchId = batchId;
    batchSegmentLimit = BATCH_SEGMENT_PAGE_SIZE;
  }
  if (!segments.length) {
    container.innerHTML = '<div class="empty-list batch-empty">拖入或选择文件后，会自动识别正文并生成分句队列。</div>';
    $("#batchProgressText").textContent = "等待解析";
    $("#batchProgressMeta").textContent = "0 / 0";
    $("#batchProgressBar").style.width = "0%";
    $("#batchQaFilter").hidden = true;
    const countNode = $("#batchSegmentCount");
    if (countNode) countNode.textContent = "已显示 0 / 共 0 条";
    return;
  }
  const selected = segments.filter((segment) => segment.selected);
  const completed = selected.filter((segment) => segment.status === "done").length;
  const failed = selected.filter((segment) => segment.status === "error").length;
  const percent = selected.length ? Math.round((completed / selected.length) * 100) : 0;
  const styleSuffix = state.batchStyleProfile?.name ? ` · ${state.batchStyleProfile.name}` : "";
  const qaIncomplete = summarizeBatchSegments(selected).qaIncomplete;
  const reportPending = batchQualityReportPending(state.batchPreview, currentBatchWorkflow());
  $("#batchProgressText").textContent = reportPending
    ? `正在生成质量报告…${styleSuffix}`
    : `${state.batchRunning ? (state.batchPaused ? "将在当前段后暂停" : "批次翻译中") : ["completed", "needs_attention"].includes(state.batchPreview?.runState) || completed + failed === selected.length ? "本轮翻译已结束" : failed ? "部分分段待重试" : "分段已就绪"}${styleSuffix}`;
  $("#batchProgressMeta").textContent = `成功 ${completed} / ${selected.length}${failed ? ` · 翻译失败 ${failed} 段` : ""}${qaIncomplete ? ` · AIQA 未完成 ${qaIncomplete} 段` : ""}`;
  $("#batchProgressBar").style.width = `${percent}%`;
  // 筛选 chips + 跳转：几十上百段时不用靠肉眼滚（口径与任务中心"待处理"一致）。
  const counts = { "": segments.length, attention: 0, suggest: 0, pending: 0, pass: 0, skipped: 0 };
  segments.forEach((segment) => { counts[batchSegmentGroup(segment)] += 1; });
  const filter = state.batchSegmentFilter || "";
  $("#batchQaFilter").hidden = false;
  $("#batchQaChips").innerHTML = BATCH_QA_CHIPS
    .filter(([value]) => value === "" || counts[value] > 0)
    .map(([value, label]) => `<button class="qa-filter-chip${filter === value ? " active" : ""}" type="button" data-batch-filter="${value}">${label} ${counts[value]}</button>`)
    .join("");
  const query = state.batchSegmentQuery || "";
  const visibleSegments = filteredBatchSegments();
  const renderedSegments = visibleSegments.slice(0, batchSegmentLimit);
  const countNode = $("#batchSegmentCount");
  if (countNode) countNode.textContent = `已显示 ${renderedSegments.length} / 共 ${segments.length} 条${visibleSegments.length !== segments.length ? `（筛选内 ${visibleSegments.length}）` : ""}`;
  const rows = renderedSegments.map(({ segment, index }) => {
    const [className, label, meta] = batchStatus(segment);
    const acceptEnabled = segment.status === "done" && segment.translation && !segment.accepted;
    const position = index + 1;
    return `<div class="batch-segment ${segment.status === "running" ? "is-running" : ""} ${segment.status === "error" ? "has-error" : ""}" data-segment-id="${segment.id}">
      <div class="batch-segment-index"><input class="batch-segment-check" data-id="${segment.id}" type="checkbox" ${segment.selected ? "checked" : ""} ${state.batchRunning ? "disabled" : ""} aria-label="选择第 ${position} 段" /><span class="row-ref">${position}</span></div>
      <div class="batch-segment-source"><div class="segment-source-text">${escapeHtml(segment.source)}</div>${segment.context?.metadata?.length || segment.context?.referenceTranslations?.length ? `<div class="segment-context">${(segment.context.metadata || []).map((item) => `<span class="${item.role === "constraint" ? "constraint" : ""}" title="${escapeHtml(item.value)}">${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}${(segment.context.referenceTranslations || []).map((item) => `<span class="reference" title="${escapeHtml(item.value)}">参考 · ${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}</div>` : ""}</div>
      <div class="batch-target-cell">${renderBatchTarget(segment)}</div>
      <div class="segment-status ${className}"><strong>${segment.accepted ? "已采纳" : label}</strong><small>${escapeHtml(meta)}</small>${segmentTierChips(segment)}${acceptEnabled ? `<button class="button ghost small accept-segment" data-id="${segment.id}">采纳</button>` : ""}</div>
      ${renderSegmentMeta(segment)}
      ${renderBatchDetails(segment)}
    </div>`;
  }).join("");
  const remaining = visibleSegments.length - renderedSegments.length;
  const loadMore = remaining > 0
    ? `<button class="button ghost small" id="batchLoadMore" type="button">加载更多（还有 ${remaining} 条）</button>`
    : "";
  container.innerHTML = (rows || `<div class="empty-list batch-empty">${query || filter ? "当前筛选下没有分段。" : "还没有分段。"}</div>`) + loadMore;
  $("#batchLoadMore")?.addEventListener("click", () => {
    batchSegmentLimit += BATCH_SEGMENT_PAGE_SIZE;
    renderBatchSegments();
  });
  $("#acceptAllSegments").hidden = !segments.some((segment) => segment.status === "done" && segment.translation && !segment.accepted);
  $$("#batchQaChips .qa-filter-chip").forEach((chip) => chip.addEventListener("click", () => {
    state.batchSegmentFilter = chip.dataset.batchFilter || "";
    state.batchQaCursor = -1;
    batchSegmentLimit = BATCH_SEGMENT_PAGE_SIZE;
    renderBatchSegments();
  }));
  $("#batchToAutoQa").hidden = !segments.some((segment) => segment.status === "done" && String(segment.translation || "").trim());
  $$(".batch-segment-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const segment = segments.find((item) => item.id === checkbox.dataset.id);
    if (segment) segment.selected = checkbox.checked;
    renderBatchSegments();
    refreshActions();
    saveBatchProgress();
  }));
  $$(".batch-segment-target[contenteditable='true']").forEach((target) => {
    target.addEventListener("input", () => {
      const segment = segments.find((item) => item.id === target.dataset.id);
      if (!segment) return;
      segment.translation = target.innerText.replace(/\n+$/u, "").trim();
      segment.accepted = false;
    });
    target.addEventListener("blur", () => {
      const segment = segments.find((item) => item.id === target.dataset.id);
      if (!segment) return;
      segment.translation = target.innerText.replace(/\n+$/u, "").trim();
      if (segment.translation) {
        segment.status = "done";
        segment.result = segment.result || { issues: [], matches: [] };
        segment.result.translation = segment.translation;
      }
      segment.accepted = false;
      renderBatchSegments();
      refreshActions();
      saveBatchProgress();
    });
  });
  $$(".accept-segment").forEach((button) => button.addEventListener("click", () => acceptSegment(button.dataset.id)));
  $$(".retry-segment-qa").forEach((button) => button.addEventListener("click", () => retrySegmentQa(button.dataset.id)));
  $$(".batch-qa-action").forEach((button) => button.addEventListener("click", () => resolveBatchQaIssue(button.dataset.id, Number(button.dataset.issueIndex), button.dataset.action, button)));
}

async function resolveBatchQaIssue(segmentId, issueIndex, action, button) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment?.result?.issues?.[issueIndex]) return;
  const issue = segment.result.issues[issueIndex];
  const review = {};
  if (action === "accept" && !confirm("确认采纳这条 QA 意见，并让翻译模型按意见修订本段？")) return;
  if (action === "partial") {
    const accepted = prompt("填写要采纳的部分（多项可用分号分隔）：", issue.suggestion || issue.message || "");
    if (accepted == null) return;
    const rejected = prompt("填写不采纳的部分及边界（必填）：", "其余表述保持不变");
    if (rejected == null) return;
    const instruction = prompt("给翻译模型的精确修订要求：", accepted);
    if (instruction == null) return;
    review.acceptedParts = accepted.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.rejectedParts = rejected.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.revisionInstruction = instruction.trim();
  }
  if (action === "reject") {
    const reason = prompt("请说明拒绝这条 QA 意见的原因（会写入处理回执）：", "当前译文在本语境中可接受");
    if (reason == null || !reason.trim()) return;
    review.reason = reason.trim();
  }
  button.disabled = true;
  button.textContent = ["accept", "partial", "revise"].includes(action) ? "AI 修订中…" : "记录中…";
  try {
    const resolved = await api("/api/qa/resolve", { method: "POST", body: JSON.stringify(qaResolutionBody({
      source: segment.source, translation: segment.translation, result: segment.result, action, issueIndex,
      contentType: segment.result?.segmentPurpose || state.batchClassification?.contentType || "general", domain: "auto",
      batchId: state.batchPreview.batchId || "batch-review", review
    })) });
    segment.translation = resolved.translation || segment.translation;
    segment.result = { ...segment.result, ...resolved, translation: segment.translation, issues: resolved.issues, qaScore: resolved.qaScore, aiQa: resolved.aiQa, reviewReceipt: resolved.reviewReceipt };
    segment.status = "done";
    segment.accepted = false;
    await saveBatchProgress();
    renderBatchSegments();
    toast(["accept", "partial", "revise"].includes(action) ? `第 ${segment.index} 段已由 AI 修订并重新 QA：${resolved.qaScore} 分` : `第 ${segment.index} 段已记录拒绝意见`);
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "accept" ? "采纳并让 AI 修订" : action === "partial" ? "部分采纳" : "拒绝意见";
    toast(error.message);
  }
}

async function retrySegmentQa(segmentId) {
  const button = document.querySelector(`.retry-segment-qa[data-id="${CSS.escape(segmentId)}"]`);
  return retryBatchQa(state.batchPreview?.batchId, button, [segmentId]);
}

async function prepareBatch() {
  if (!state.batchFile) return toast("请先选择要翻译的文件");
  setBusy(true, state.batchFile?.name.toLowerCase().endsWith(".xlsx") ? "AI 识别表格结构中…" : "解析与分段中…");
  try {
    state.batchBase64 = state.batchFile ? await fileToBase64(state.batchFile) : "";
    const prepared = await api("/api/batch/prepare", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: state.batchFile?.name || "未命名文件",
      base64: state.batchBase64 || undefined,
      segmentationMode: $("#batchSegmentationMode").value,
      locale: state.workbenchLocale,
      useAiStructure: true,
      columnMapping: state.batchColumnMapping || undefined
    }) });
    prepared.segments.forEach((segment) => Object.assign(segment, { selected: true, status: "pending", translation: "", result: null, error: "", accepted: false }));
    state.batchPreview = prepared;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    state.batchBrief = null;
    state.batchBriefDraft = null;
    state.batchBriefPending = Boolean(prepared.contextBriefPending);
    state.batchReport = null;
    localStorage.setItem("kami-batch-id", prepared.batchId || "");
    await saveBatchProgress();
    $("#batchSourceMeta").textContent = batchSourceMetaText({
      segments: prepared.statistics.segments,
      characters: prepared.statistics.characters
    });
    renderSpreadsheetAnalysis(prepared.spreadsheetAnalysis);
    $("#batchFileMeta").textContent = `${(state.batchFile.size / 1024).toFixed(1)} KB · ${prepared.spreadsheetAnalysis?.usedModel ? "AI 已识别正文与补充信息" : prepared.format === "xlsx" ? "已按规则识别表格" : "已完成分段"}`;
    renderBatchSegments();
    renderBatchBrief();
    renderBatchReport();
    renderBatchTermSurvey();
    // 解析完直接落到队列：用户接下来要看的是分段结果。
    state.batchTab = "queue";
    renderBatchTabs();
    if (prepared.contextBriefPending) { await loadBatchBrief(prepared.batchId); startBatchBriefWatch(prepared.batchId); }
    toast(prepared.format === "xlsx" ? `已识别 ${prepared.statistics.segments} 个翻译单元，补充信息不会作为正文翻译` : `已自动拆分为 ${prepared.statistics.segments} 段，可取消不需要翻译的段落`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function structuredContextGroups(segments) {
  const maxEntries = Math.max(2, Number(state.projectSettings?.batch?.groupMaxEntries) || 10);
  const maxChars = Math.max(300, Number(state.projectSettings?.batch?.groupMaxChars) || 1500);
  const groups = [];
  let current = [];
  let chars = 0;
  let boundary = "";
  for (const segment of segments) {
    const length = [...String(segment.source || "")].length;
    const nextBoundary = `${segment.locator?.type || ""}\u0000${segment.locator?.sheet || segment.context?.sheet || ""}`;
    if (current.length && (current.length >= maxEntries || chars + length > maxChars || (boundary && nextBoundary !== boundary))) {
      groups.push(current);
      current = [];
      chars = 0;
      boundary = "";
    }
    current.push(segment);
    chars += length;
    boundary ||= nextBoundary;
  }
  if (current.length) groups.push(current);
  const byId = new Map();
  groups.forEach((group, index) => group.forEach((segment) => byId.set(segment.id, { index, group })));
  return byId;
}

function mergeServerBatchRun(run) {
  if (!state.batchPreview || state.batchPreview.batchId !== run.batchId) return;
  const current = new Map(state.batchPreview.segments.map((segment) => [segment.id, segment]));
  state.batchPreview.subBatches = run.subBatches || [];
  state.batchPreview.runState = run.runState || "ready";
  state.batchPreview.runnerOptions = run.runnerOptions || null;
  state.batchWorkflow = run.workflow || null;
  if (run.termSurvey !== undefined) state.batchPreview.termSurvey = run.termSurvey;
  // 轮询返回的 workflow 必须立刻渲染：否则翻译进行中只有段落列表在刷新，
  // 顶部「正在翻译：N / M 段」会停在上次打开页面时的状态，看起来比任务中心慢。
  renderBatchWorkflow();
  state.batchPreview.segments = (run.segments || []).map((segment, index) => ({
    ...(current.get(segment.id) || {}),
    ...segment,
    index: index + 1
  }));
  state.batchClassification = { contentType: run.contentType || "general", source: "server-runner" };
  if (run.contextBrief !== undefined) {
    state.batchBrief = run.contextBrief;
    if (run.contextBrief) state.batchBriefPending = false;
  }
  if (run.qualityReport !== undefined) state.batchReport = run.qualityReport;
  renderBatchSegments();
  renderBatchBrief();
  renderBatchReport();
  renderBatchTermSurvey();
  renderBatchTabs();
  refreshActions();
}

async function pollServerBatch(batchId) {
  while (state.batchRunning && state.batchPreview?.batchId === batchId) {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId)}`);
    mergeServerBatchRun(run);
    if (["completed", "needs_attention", "paused"].includes(run.runState)) {
      state.batchRunning = false;
      state.batchPaused = false;
      state.batchCancelling = false;
      refreshActions();
      renderBatchSegments();
      await loadBatchBrief(batchId);
      await loadBatchReport(batchId);
      if (run.runState === "completed") toast(batchQualityReportPending(run, run.workflow) ? "翻译已结束，正在生成质量报告；完成后才能导出" : "本轮翻译已结束，质量报告与术语普查进度可在阶段状态中查看");
      else if (run.runState === "paused" && run.runnerOptions?.cancelled) toast("批次已中断，已完成的段落保留，可随时继续");
      else if (run.runState === "paused") toast("后台批次已暂停，进度已保存");
      else toast("本轮翻译已结束，失败段可点「重试失败句段」，已有译文继续生成报告与术语普查");
      startBatchWorkflowWatch(batchId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
}

/** 质量档：批次级设置，逐段由服务端判定实际档位。 */
function batchQualityTier() {
  return $("#batchQualityTier")?.value || "auto";
}

/**
 * 质量档只有一个设置，两种模式各在自己版面里显示它：单句在上方的质量档行，
 * 批次在「分段与翻译策略」面板里（上面的行在批次模式下隐藏，避免同一个设置
 * 在两处同时可选、看着像两个开关）。改任意一处都同步到另一处。
 */
function syncQualityTier(value, source) {
  for (const select of [$("#qualityTier"), $("#batchQualityTier")]) {
    if (select && select !== source) select.value = value;
  }
}

function briefPurposeLabel(purpose) {
  return state.bootstrap?.contentTypes?.[purpose]?.label || purpose || "通用";
}

function segmentTierChips(segment) {
  const purpose = segment.result?.segmentPurpose;
  const tier = segment.result?.qualityTier;
  // 段落没跑过（还没翻）就什么都不显示；翻过但没记档位＝旧版本翻译，如实标出来。
  const translated = String(segment.translation || "").trim() || segment.status === "done";
  if (!purpose && !tier && !translated) return "";
  const tierLabel = QUALITY_TIER_LABELS[tier] || "";
  const upgraded = segment.result?.qualityUpgradeFrom ? `<span class="segment-chip upgraded" title="由${{ fast: "快速", standard: "标准" }[segment.result.qualityUpgradeFrom] || segment.result.qualityUpgradeFrom}档自动升级">↑${tierLabel}</span>` : (tierLabel ? `<span class="segment-chip">${tierLabel}</span>` : "");
  const unrecorded = !tier && translated
    ? '<span class="segment-chip muted" title="这一段是较早版本翻译的，结果里没有记录质量档；重新翻译后会记录">档位未记录</span>'
    : "";
  return `<span class="segment-chips">${purpose ? `<span class="segment-chip purpose" title="${escapeHtml(segment.result?.tierReason || "")}">${escapeHtml(briefPurposeLabel(purpose))}</span>` : ""}${upgraded}${unrecorded}</span>`;
}

const QUALITY_TIER_LABELS = { fast: "快速", standard: "标准", strict: "严苛" };

/** 把服务端给的档位分布说成一句话；全是旧数据时返回空串（由调用方决定怎么提示）。 */
function describeQualityTiers(tiers) {
  if (!tiers) return "";
  const recorded = ["fast", "standard", "strict"].map((key) => [Number(tiers[key]) || 0, QUALITY_TIER_LABELS[key]]);
  const parts = recorded.filter(([count]) => count > 0).map(([count, label]) => `${label} ${count}`);
  const unrecorded = Number(tiers.unrecorded) || 0;
  if (unrecorded) parts.push(parts.length ? `未记录 ${unrecorded}` : "未记录（旧版本翻译）");
  return parts.join(" · ");
}

/**
 * 语境档案：翻译前通读整份文件得到的用途区间。默认只读，编辑态可以改区间用途、
 * 删除某条注意点——因为它是全流程的输入，用户必须能纠正系统的判断。
 */
function renderBatchBrief() {
  const panel = $("#batchBriefPanel");
  if (!panel) return;
  const brief = state.batchBrief;
  const pending = state.batchBriefPending;
  if (!brief && !pending) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const draft = state.batchBriefDraft;
  const summary = $("#batchBriefSummary");
  if (pending) {
    summary.textContent = "正在通读全文做语境分析……完成后每段用途会自动继承，翻译开始前必须完成";
  } else if (brief?.status === "ready") {
    const coverage = brief.coverage || {};
    summary.textContent = `${briefPurposeLabel(brief.documentType?.purpose)} · ${(brief.sections || []).length} 个用途区间 · 覆盖 ${coverage.covered || 0} / ${coverage.total || 0} 条${brief.documentType?.summary ? ` · ${brief.documentType.summary}` : ""}`;
  } else {
    summary.textContent = "语境分析失败：翻译会按通用口径继续，可重新分析或手动补用途";
  }
  const editing = Boolean(draft);
  $("#batchBriefActions").hidden = !editing;
  $("#batchBriefEditToggle").textContent = editing ? "编辑中" : "编辑注意点";
  const sections = editing ? draft.sections : (brief?.sections || []);
  $("#batchBriefSections").innerHTML = sections.length
    ? sections.map((section, index) => `<div class="batch-brief-row">
        <span class="batch-brief-range">第 ${section.from}–${section.to} 条</span>
        <span class="batch-brief-purpose">${escapeHtml(briefPurposeLabel(section.purpose))}</span>
        ${editing
          ? `<input data-brief-section-note="${index}" value="${escapeHtml(section.note || "")}" placeholder="这段的处理要点（可留空）" />`
          : `<span class="batch-brief-note-text">${escapeHtml(section.note || "")}</span>`}
      </div>`).join("")
    : '<div class="empty-list batch-empty">还没有用途区间。</div>';
  const notes = editing ? draft.notes : (brief?.notes || []);
  $("#batchBriefNotes").innerHTML = notes.length
    ? `<div class="batch-brief-note-head">格式与一致性注意点</div>${notes.map((note, index) => `<div class="batch-brief-note"><span>${escapeHtml(note.text)}</span>${editing ? `<button class="button ghost small" type="button" data-brief-note-remove="${index}">删除</button>` : ""}</div>`).join("")}`
    : "";
  const crossRefs = brief?.crossRefs || [];
  if (!editing && crossRefs.length) {
    $("#batchBriefNotes").innerHTML += `<div class="batch-brief-note-head">跨条目必须一致</div>${crossRefs.map((ref) => `<div class="batch-brief-note"><span>${escapeHtml(ref.note)}</span><em>${escapeHtml((ref.ids || []).join("、"))}</em></div>`).join("")}`;
  }
  renderBatchTabs();
}

async function loadBatchBrief(batchId = state.batchPreview?.batchId) {
  if (!batchId) return;
  try {
    const payload = await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`);
    state.batchBrief = payload.brief || null;
    state.batchBriefPending = Boolean(payload.pending);
  } catch {
    state.batchBrief = null;
    state.batchBriefPending = false;
  }
  renderBatchBrief();
  refreshActions();
  return state.batchBrief;
}

let batchBriefTimer = 0;

/** 语境分析在后台跑时每 3 秒看一眼：完成了自动解锁「开始翻译」，不用手动刷新。 */
function startBatchBriefWatch(batchId = state.batchPreview?.batchId) {
  if (batchBriefTimer) window.clearInterval(batchBriefTimer);
  batchBriefTimer = 0;
  if (!batchId || !state.batchBriefPending) return;
  batchBriefTimer = window.setInterval(async () => {
    if (state.view !== "workbench" || state.translationMode !== "batch") return;
    const brief = await loadBatchBrief(batchId);
    if (brief || !state.batchBriefPending) {
      window.clearInterval(batchBriefTimer);
      batchBriefTimer = 0;
      refreshActions();
    }
  }, 3_000);
}

async function rerunBatchBrief() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId) return;
  state.batchBriefPending = true;
  renderBatchBrief();
  try {
    await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast("已重新开始语境分析，完成后可在任务中心查看");
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const brief = await loadBatchBrief(batchId);
      if (brief) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  } catch (error) {
    state.batchBriefPending = false;
    renderBatchBrief();
    toast(`语境分析失败：${error.message}`);
  }
}

/** 等语境分析出结果（最多约 10 分钟）：先触发一次分析，再轮询状态。 */
async function waitForBatchBrief(batchId) {
  state.batchBriefPending = true;
  renderBatchBrief();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (attempt === 0) {
      try {
        await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`, { method: "POST", body: JSON.stringify(projectPayload()) });
      } catch { /* 已经在跑时服务端会复用同一次任务 */ }
    }
    const brief = await loadBatchBrief(batchId);
    if (brief) {
      state.batchBriefPending = false;
      renderBatchBrief();
      return brief.status === "ready";
    }
    if (!state.batchBriefPending) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  state.batchBriefPending = false;
  renderBatchBrief();
  return false;
}

function toggleBatchBriefEdit() {
  if (state.batchBriefDraft) {
    state.batchBriefDraft = null;
  } else if (state.batchBrief) {
    state.batchBriefDraft = {
      sections: (state.batchBrief.sections || []).map((section) => ({ ...section })),
      notes: (state.batchBrief.notes || []).map((note) => ({ ...note }))
    };
  }
  renderBatchBrief();
}

async function saveBatchBriefEdit() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId || !state.batchBriefDraft) return;
  // 区间用途由语境分析自动判定、只读展示（语体/领域只作参考）；这里只保存注意点。
  for (const input of $$("#batchBriefSections input[data-brief-section-note]")) {
    const section = state.batchBriefDraft.sections[Number(input.dataset.briefSectionNote)];
    if (section) section.note = input.value.trim();
  }
  try {
    const payload = await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`, {
      method: "PATCH",
      body: JSON.stringify({ ...projectPayload(), sections: state.batchBriefDraft.sections, notes: state.batchBriefDraft.notes })
    });
    state.batchBriefDraft = null;
    await loadBatchBrief(batchId);
    toast(`语境档案已更新：${payload.summary?.sections || 0} 个用途区间`);
  } catch (error) {
    toast(`保存失败：${error.message}`);
  }
}

/** 质量报告与跨条目待核对清单。 */
function renderBatchReport() {
  const panel = $("#batchReportPanel");
  if (!panel) return;
  const payload = state.batchReport;
  const stage = currentBatchWorkflow()?.qualityReport;
  const running = ["waiting", "in_progress"].includes(stage?.status);
  $("#batchConsistencyRun").disabled = running;
  $("#batchConsistencyRun").textContent = running ? "质量报告进行中…" : stage?.status === "needs_attention" ? "重试质量报告" : payload?.report ? "重新核对" : "生成质量报告";
  if (!payload?.report) {
    panel.hidden = !state.batchPreview;
    $("#batchReportSummary").textContent = stage?.message || "还没有质量报告";
    $("#batchReportEmpty").textContent = stage?.message || "翻译结束后自动生成质量报告。";
    $("#batchReportMetrics").innerHTML = "";
    $("#batchReportFindings").innerHTML = "";
    $("#batchReportRepair").hidden = true;
    renderBatchTabs();
    return;
  }
  const report = payload.report;
  panel.hidden = false;
  $("#batchReportSummary").textContent = `${running ? "正在刷新；下方为上次报告 · " : ""}${report.totals?.translated || 0} / ${report.totals?.selected || 0} 段已翻译 · 质检覆盖 ${report.coverage?.percent ?? 0}% · 平均 ${report.scores?.average ?? "—"} 分${report.coverage?.qaIncomplete ? ` · AIQA 未完成 ${report.coverage.qaIncomplete} 段` : ""}${payload.warning ? ` · 检查未完成：${payload.warning}` : ""}`;
  const metrics = [
    ["档位分布", `快速 ${report.tiers?.fast || 0} · 标准 ${report.tiers?.standard || 0} · 严苛 ${report.tiers?.strict || 0}${report.upgrades ? ` · 升级 ${report.upgrades}` : ""}`],
    // 采用率只看精确命中：模糊/智能命中只是提示（「パス→帕斯」落在「プレミアムパス」里就该让位），
    // 混进分母会把"语境判断"算成漏用，数字既难看又不准。
    ["术语采用率", report.terms?.adoptionRate === null
      ? "无精确命中"
      : `${report.terms?.adoptionRate ?? 0}%（${report.terms?.applied || 0} / ${report.terms?.expectedUses || 0}）${(report.terms?.expectedUses || 0) - (report.terms?.applied || 0) ? `，${(report.terms?.expectedUses || 0) - (report.terms?.applied || 0)} 条按语境判断未采用` : ""}${report.terms?.fuzzyExpected ? `；模糊命中 ${report.terms?.fuzzyApplied || 0} / ${report.terms?.fuzzyExpected || 0}（仅供参考）` : ""}`],
    ["保护标记", `${report.protectedTokens?.preserved || 0} / ${report.protectedTokens?.total || 0}`],
    ["事实锚点问题", `${report.facts?.issueCount || 0} 处 / ${report.facts?.segments || 0} 段`],
    ["待人工复核", `${report.humanReview?.suggested || 0} 段${(report.humanReview?.reasons || []).length ? `（${report.humanReview.reasons.map((item) => `${item.reason} × ${item.count}`).join("；")}）` : ""}`],
    ["跨条目待核对", `${report.consistency?.findings || 0} 条`]
  ];
  $("#batchReportMetrics").innerHTML = metrics.map(([label, value]) => `<div class="batch-report-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  renderBatchRepair(payload);
  renderBatchTabs();
  const findings = payload.findings || [];
  $("#batchReportFindings").innerHTML = findings.length
    ? `<div class="batch-brief-note-head">待核对清单</div>${findings.map((finding) => `<div class="batch-brief-note"><span><strong>${escapeHtml(FINDING_TYPE_LABELS[finding.type] || finding.type)}</strong> · ${escapeHtml(finding.detail)}${finding.suggestion ? `<em>建议：${escapeHtml(finding.suggestion)}</em>` : ""}${findingRepairNote(finding) ? `<em>处理：${escapeHtml(findingRepairNote(finding))}</em>` : ""}${findingEvidenceNote(finding) ? `<em>依据：${escapeHtml(findingEvidenceNote(finding))}</em>` : ""}</span><em>${escapeHtml((finding.ids || []).join("、"))}</em></div>`).join("")}`
    : '<div class="empty-list batch-empty">没有发现跨条目不一致。</div>';
}

const FINDING_TYPE_LABELS = {
  duplicate_source: "同原文不同译文",
  term_usage_gap: "术语译法未统一",
  term_drift: "术语漂移",
  name_drift: "专名漂移",
  voice_drift: "角色口吻漂移",
  style_conflict: "与风格规范冲突",
  pattern_drift: "句式/固定说法漂移",
  format_risk: "格式风险"
};

const REPAIR_EVIDENCE_LABELS = {
  term: "术语库",
  tm_master: "主 TM 人工条",
  tm_reference: "参考 TM 人工条",
  file_majority: "文件内多数",
  paired_scheme: "配对方案",
  ai_judgement: "AI 终审"
};

/** 一条待核对项最后是怎么处理的：自动统一、部分修复、还是只报告。 */
function findingRepairNote(finding = {}) {
  const repair = finding.repair;
  if (!repair) return "";
  if (repair.status === "repaired") {
    const label = REPAIR_EVIDENCE_LABELS[repair.evidence?.kind] || "";
    return `已自动统一为「${repair.target}」${label ? `（依据：${label}${repair.evidence?.ref ? ` · ${repair.evidence.ref}` : ""}）` : ""}${repair.overrodeModel ? "，并覆盖了模型原先的建议" : ""}`;
  }
  if (repair.status === "partial") {
    return `已改 ${(repair.changedIds || []).length} 段，复核仍点到这些段落`;
  }
  return repair.reason || "只报告，未自动改";
}

/** finding 自己带的依据（模型填的 evidence，或规则算出的登记译法）。 */
function findingEvidenceNote(finding = {}) {
  const items = Array.isArray(finding.evidence) ? finding.evidence : [];
  if (!items.length) return "";
  return items.slice(0, 2).map((item) => [item.kind, item.ref].filter(Boolean).join(" · ")).filter(Boolean).join("；");
}

/** 一致性修复区：改了几段、依据是什么、哪些没改。 */
function renderBatchRepair(payload) {
  const box = $("#batchReportRepair");
  if (!box) return;
  const repair = payload?.repair;
  const changed = Array.isArray(repair?.changed) ? repair.changed : [];
  const skipped = Array.isArray(repair?.skipped) ? repair.skipped : [];
  if (!repair || (!changed.length && !repair.blocked && !skipped.length)) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const parts = ['<div class="batch-brief-note-head">一致性修复</div>'];
  if (repair.blocked) {
    parts.push(`<div class="batch-brief-note"><span>本次没有自动改稿：${escapeHtml(repair.blocked.reason || "")}</span><em></em></div>`);
  } else {
    const byKind = new Map();
    for (const change of changed) {
      const kind = REPAIR_EVIDENCE_LABELS[change.evidence?.kind] || "依据";
      byKind.set(kind, (byKind.get(kind) || 0) + 1);
    }
    const evidenceText = [...byKind.entries()].map(([kind, count]) => `${kind} × ${count}`).join(" · ");
    parts.push(`<div class="batch-brief-note"><span><strong>已按证据自动统一 ${changed.length} 段</strong>${evidenceText ? `（${escapeHtml(evidenceText)}）` : ""}</span><em></em></div>`);
    for (const change of changed.slice(0, 12)) {
      const label = REPAIR_EVIDENCE_LABELS[change.evidence?.kind] || "依据";
      const ref = change.evidence?.ref ? ` · ${escapeHtml(change.evidence.ref)}` : "";
      parts.push(`<div class="batch-brief-note"><span><strong>${escapeHtml(change.segmentId || "")}</strong> · ${escapeHtml(change.before || "")} → ${escapeHtml(change.after || "")}<em>依据：${escapeHtml(label)}${ref}${change.overrodeModel ? " · 已覆盖模型建议" : ""}</em></span><em></em></div>`);
    }
    if (changed.length > 12) parts.push(`<div class="batch-brief-note"><span>另有 ${changed.length - 12} 段按同一依据统一</span><em></em></div>`);
    const reasons = new Map();
    for (const item of skipped) reasons.set(item.reason || "只报告", (reasons.get(item.reason || "只报告") || 0) + 1);
    for (const [reason, count] of reasons) {
      parts.push(`<div class="batch-brief-note"><span>未自动改 ${count} 处：${escapeHtml(reason)}</span><em></em></div>`);
    }
    if (repair.verification) {
      parts.push(`<div class="batch-brief-note"><span>复核：改动所在 ${Number(repair.verification.checkedChunks) || 0} 片，仍报 ${(repair.verification.remaining || []).length} 条</span><em></em></div>`);
    }
  }
  box.innerHTML = parts.join("");
  box.hidden = false;
}

/* ── 当前文件的分区标签页 ───────────────────────────────────────── */

const BATCH_TABS = ["setup", "queue", "brief", "report", "terms"];

function setBatchTab(tab) {
  state.batchTab = BATCH_TABS.includes(tab) ? tab : "setup";
  renderBatchTabs();
}

function updateTabBadge(node, label) {
  if (!node) return;
  node.textContent = label || "";
  node.hidden = !label;
}

/** 标签页与徽标：队列还剩多少段、报告有几条待核对、普查出几条术语。 */
function renderBatchTabs() {
  const active = BATCH_TABS.includes(state.batchTab) ? state.batchTab : "setup";
  $$("#batchTabs [data-batch-tab]").forEach((button) => {
    const isActive = button.dataset.batchTab === active;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  $$("#batchWorkspace [data-batch-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.batchPanel !== active;
  });
  const segments = state.batchPreview?.segments || [];
  const pending = segments.filter((segment) => segment.selected && segment.status !== "done").length;
  updateTabBadge($("#batchTabQueueBadge"), pending ? String(pending) : "");
  updateTabBadge($("#batchTabBriefBadge"), state.batchBriefPending ? "分析中" : "");
  const findings = Array.isArray(state.batchReport?.findings) ? state.batchReport.findings.length : 0;
  const workflow = currentBatchWorkflow();
  const stageBadge = (stage) => ["waiting", "in_progress", "needs_attention", "blocked"].includes(stage?.status) ? BATCH_STAGE_STATES[stage.status] : "";
  updateTabBadge($("#batchTabReportBadge"), stageBadge(workflow?.qualityReport) || (findings ? String(findings) : ""));
  const surveyed = state.batchPreview?.termSurvey?.terms || [];
  updateTabBadge($("#batchTabTermsBadge"), stageBadge(workflow?.termSurvey) || (surveyed.length ? String(surveyed.length) : ""));
}

/* ── 术语普查 ───────────────────────────────────────────────────── */

const TERM_OUTCOME_LABELS = {
  auto_written: { label: "已自动入库", tone: "ok" },
  pending_review: { label: "待审核", tone: "warn" },
  skipped: { label: "已忽略", tone: "muted" }
};

const TERM_FILTERS = [
  ["", "全部"],
  ["missing", "机器稿没用建议译法"],
  ["library", "库里已有登记"],
  ["reviewed", "人工已核对"],
  ["unreviewed", "待回填"]
];

function termSurveyView() {
  return state.batchPreview?.termSurvey || null;
}

/** 一条术语：模型建议、机器稿实际用法、人工终稿、库里登记与处理结果。 */
function renderTermCard(term) {
  const confidence = Math.round((Number(term.confidence) || 0) * 100);
  const machineText = term.machine.matched
    ? (term.machine.adopted
      ? `机器稿 ${term.machine.adopted} / ${term.machine.matched} 段用了这个译法`
      : `机器稿 ${term.machine.matched} 段都没用这个译法`)
    : "原文里找不到这个源词，机器稿无法核对";
  const humanText = !term.human.reviewed
    ? "还没回填人工终稿"
    : (term.human.kept === term.human.segments
      ? `人工终稿保留了这个译法（${term.human.segments} 段）`
      : `人工终稿改掉了：${term.human.kept ? `只有 ${term.human.kept} / ${term.human.segments} 段保留` : "全部没保留"}`);
  const libraryText = term.library.found
    ? `库里已有登记：${term.library.target}${term.library.status ? `（${term.library.status}）` : ""}`
    : "库里没有登记";
  const outcome = term.outcome ? TERM_OUTCOME_LABELS[term.outcome.action] : null;
  const statusText = outcome ? outcome.label : (term.library.found ? "库里已有" : "等待人工审校回填");
  const statusTone = outcome ? outcome.tone : (term.library.found ? "info" : "muted");
  const statusNote = term.outcome?.action === "auto_written"
    ? (term.outcome.libraryName ? `写入库：${term.outcome.libraryName}` : "")
    : (term.outcome?.reason || "");
  const samples = (term.machine.samples || []).map((sample) => `<div class="batch-term-row"><small>${escapeHtml(sample.id)} 机器稿${sample.human ? " / 人工终稿" : ""}</small><span>${escapeHtml(sample.machine || "（空）")}</span>${sample.human ? `<span>${escapeHtml(sample.human)}</span>` : ""}</div>`).join("");
  return `<div class="batch-term-card">
    <div class="batch-term-head"><strong>${escapeHtml(term.source)}</strong><span class="batch-term-arrow">→</span><span class="batch-term-target">${escapeHtml(term.suggestedTarget)}</span><span class="batch-term-status ${statusTone}">${escapeHtml(statusText)}</span></div>
    <div class="batch-term-meta"><span>AI 建议 · 置信度 ${confidence}%</span><span>${escapeHtml(machineText)}</span></div>
    <div class="batch-term-row"><small>模型依据</small><span>${escapeHtml(term.reason || "模型没写依据")}</span></div>
    <div class="batch-term-row"><small>人工审校</small><span>${escapeHtml(humanText)}</span></div>
    <div class="batch-term-row"><small>术语库</small><span>${escapeHtml(libraryText)}</span>${statusNote ? `<small>${escapeHtml(statusNote)}</small>` : ""}</div>
    ${samples}
  </div>`;
}


/** 本文件工作术语：自动学习 + 手动修正；改动只影响当前批次。 */
function renderBatchWorkingTerms() {
  const host = $("#batchWorkingTerms");
  if (!host) return;
  const glossary = state.batchPreview?.runnerOptions?.workingGlossary || null;
  const terms = Array.isArray(glossary?.terms) ? glossary.terms.filter((term) => term.status !== "rejected") : [];
  const addButton = $("#batchWorkingTermAdd");
  if (addButton) {
    addButton.onclick = async () => {
      const source = prompt("原文（日语，必须与文件里的写法一致）：", "");
      if (source == null || !source.trim()) return;
      const target = prompt("本文件统一译法（简体中文）：", "");
      if (target == null || !target.trim()) return;
      await saveWorkingTerm({ action: "upsert", source: source.trim(), target: target.trim() });
    };
  }
  if (!terms.length) {
    host.innerHTML = '<div class="empty-list batch-empty">本文件还没有工作术语；翻译一段后会自动学习，也可以手动添加。</div>';
    return;
  }
  host.innerHTML = terms.map((term) => {
    const source = escapeHtml(term.source);
    const target = escapeHtml(term.target);
    const origin = term.origin === "manual" ? "手动" : "自动学习";
    const enforcement = term.enforcement === "required" ? "已锁定为强制" : "优先采用";
    const segment = term.sourceSegmentId ? `来源 ${escapeHtml(String(term.sourceSegmentId).slice(0, 12))}` : "手动添加";
    return `<div class="batch-term-card">
      <div class="batch-term-head"><strong>${source}</strong><span class="batch-term-arrow">→</span><span class="batch-term-target">${target}</span><span class="batch-term-status info">${origin}</span></div>
      <div class="batch-term-meta"><span>${enforcement}</span><span>${segment}</span>${term.confidence ? `<span>置信度 ${Math.round(Number(term.confidence) * 100)}%</span>` : ""}</div>
      <div class="batch-working-actions"><button class="button ghost small" type="button" data-working-action="edit" data-working-source="${source}">改译法</button><button class="button ghost small" type="button" data-working-action="lock" data-working-source="${source}">${term.enforcement === "required" ? "取消锁定" : "锁定为强制"}</button><button class="button ghost small danger" type="button" data-working-action="delete" data-working-source="${source}">删除</button></div>
    </div>`;
  }).join("");
  $$("#batchWorkingTerms [data-working-action]").forEach((button) => button.addEventListener("click", async () => {
    const term = terms.find((item) => item.source === button.dataset.workingSource);
    if (!term) return;
    if (button.dataset.workingAction === "delete") {
      if (!confirm(`删除工作术语「${term.source}」？已翻译段落不会自动改回。`)) return;
      await saveWorkingTerm({ action: "delete", source: term.source });
      return;
    }
    if (button.dataset.workingAction === "lock") {
      await saveWorkingTerm({ action: "upsert", source: term.source, target: term.target, enforcement: term.enforcement === "required" ? "preferred" : "required" });
      return;
    }
    const target = prompt(`「${term.source}」在本文件的统一译法：`, term.target);
    if (target == null || !target.trim() || target.trim() === term.target) return;
    await saveWorkingTerm({ action: "upsert", source: term.source, target: target.trim(), enforcement: term.enforcement });
    if (confirm("已翻译段落可能还在用旧译法，现在按新译法统一吗？")) {
      await runConsistencyCheckNow();
    }
  }));
}

async function saveWorkingTerm(payload) {
  const batchId = state.batchPreview?.batchId;
  if (!batchId) return toast("先打开一条批次");
  try {
    const glossary = await api(`/api/batch/run/${encodeURIComponent(batchId)}/working-terms`, {
      method: "POST",
      body: JSON.stringify({ projectId: state.activeProjectId || "", ...payload })
    });
    state.batchPreview.runnerOptions = { ...(state.batchPreview.runnerOptions || {}), workingGlossary: glossary };
    renderBatchWorkingTerms();
    toast(payload.action === "delete" ? "工作术语已删除" : "工作术语已更新");
  } catch (error) {
    toast(error.message);
  }
}

function renderBatchTermSurvey() {
  renderBatchWorkingTerms();
  const list = $("#batchTermSurveyList");
  if (!list) return;
  const chips = $("#batchTermSurveyChips");
  const filters = $("#batchTermSurveyFilters");
  const view = termSurveyView();
  const stage = currentBatchWorkflow()?.termSurvey;
  const running = ["waiting", "in_progress"].includes(stage?.status);
  $("#batchTermSurveyRun").disabled = running;
  $("#batchTermSurveyRun").textContent = running ? "术语普查进行中…" : stage?.status === "needs_attention" ? "重试术语普查" : "重新普查";
  if (!view || !view.terms.length) {
    chips.innerHTML = "";
    filters.hidden = true;
    $("#batchTermSurveySummary").textContent = stage?.message || "翻译结束后自动查找疑似术语；回填人工终稿后再决定入库。";
    list.innerHTML = `<div class="empty-list batch-empty">${view?.generatedAt && stage?.status === "completed" ? "术语普查已完成，没有发现需要新增的术语。" : stage?.message || "打开一条批次后，可以在这里看术语普查结果。"}</div>`;
    renderBatchTabs();
    return;
  }
  const stats = view.stats || {};
  const coverage = view.coverage ? `${view.coverage.analyzedPairs || 0} / ${view.coverage.totalSegments || 0} 段` : "";
  $("#batchTermSurveySummary").textContent = [
    view.generatedAt ? `普查时间 ${formatStyleTime(view.generatedAt)}` : "",
    view.model ? `模型 ${view.model}` : "",
    coverage ? `覆盖 ${coverage}` : ""
  ].filter(Boolean).join(" · ") || "术语普查结果";
  chips.innerHTML = [
    `共 ${stats.total || 0} 条`,
    `机器稿已采用 ${stats.adopted || 0}`,
    stats.missingInMachine ? `机器稿未采用 ${stats.missingInMachine}` : "",
    stats.unlocated ? `原文里找不到 ${stats.unlocated}` : "",
    `库里已有登记 ${stats.inLibrary || 0}`,
    stats.reviewed ? `人工已核对 ${stats.reviewed}` : "尚未回填人工终稿",
    stats.autoWritten ? `已自动入库 ${stats.autoWritten}` : "",
    stats.pendingReview ? `待审核 ${stats.pendingReview}` : "",
    stats.skipped ? `已忽略 ${stats.skipped}` : ""
  ].filter(Boolean).map((text) => `<span>${escapeHtml(text)}</span>`).join("")
    + (view.warning ? `<span>警告：${escapeHtml(view.warning)}</span>` : "");
  filters.hidden = false;
  const active = state.termFilter || "";
  filters.innerHTML = TERM_FILTERS
    .map(([value, label]) => `<button class="qa-filter-chip${active === value ? " active" : ""}" type="button" data-term-filter="${value}">${escapeHtml(label)}</button>`)
    .join("");
  const visible = view.terms.filter((term) => {
    if (active === "missing") return term.machine.matched > 0 && term.machine.adopted === 0;
    if (active === "library") return term.library.found;
    if (active === "reviewed") return term.human.reviewed;
    if (active === "unreviewed") return !term.human.reviewed;
    return true;
  });
  list.innerHTML = visible.length
    ? `<div class="batch-brief-note-head">已显示 ${visible.length} / 共 ${view.terms.length} 条</div>${visible.map(renderTermCard).join("")}`
    : '<div class="empty-list batch-empty">当前筛选下没有术语。</div>';
  renderBatchTabs();
}

/** 手动重跑术语普查：端点起后台任务，这里轮询批次记录等结果刷新。 */
async function runTermSurveyNow() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId) return;
  try {
    await api(`/api/batch/run/${encodeURIComponent(batchId)}/term-survey`, { method: "POST", body: JSON.stringify(projectPayload()) });
    state.batchWorkflow = { ...currentBatchWorkflow(), termSurvey: { status: "waiting", message: "术语普查已进入后台队列" } };
    renderBatchWorkflow();
    renderBatchTermSurvey();
    startBatchWorkflowWatch(batchId);
    toast("术语普查已开始，可在阶段状态中查看进度");
  } catch (error) { toast(`术语普查启动失败：${error.message}`); }
}

async function loadBatchReport(batchId = state.batchPreview?.batchId) {
  if (!batchId) return;
  try {
    state.batchReport = await api(`/api/batch/run/${encodeURIComponent(batchId)}/consistency-check`);
  } catch {
    state.batchReport = null;
  }
  renderBatchReport();
}

async function runConsistencyCheckNow() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId) return;
  try {
    await api(`/api/batch/run/${encodeURIComponent(batchId)}/consistency-check`, { method: "POST", body: JSON.stringify(projectPayload()) });
    state.batchWorkflow = { ...currentBatchWorkflow(), qualityReport: { status: "waiting", message: "质量报告已进入后台队列" } };
    renderBatchWorkflow();
    renderBatchReport();
    startBatchWorkflowWatch(batchId);
    toast("质量报告已开始，可在阶段状态中查看进度");
  } catch (error) { toast(`质量报告启动失败：${error.message}`); }
}

async function pauseBatch() {
  if (!state.batchPreview?.batchId || state.batchPaused) return;
  state.batchPaused = true;
  refreshActions();
  await api(`/api/batch/run/${encodeURIComponent(state.batchPreview.batchId)}/pause`, {
    method: "POST",
    body: JSON.stringify(projectPayload())
  });
}

/**
 * 中断批次：当前段跑完就停，已完成的段落全部保留，之后可以「继续 / 重试」接着翻。
 * 与暂停的区别只是"是用户主动中断"，任务中心据此显示已中断。
 */
async function cancelBatchRun() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId || state.batchCancelling) return;
  if (!confirm("中断这个批次？已完成的段落会保留，之后可以继续翻译。")) return;
  state.batchCancelling = true;
  refreshActions();
  try {
    const result = await api(`/api/batch/run/${encodeURIComponent(batchId)}/cancel`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast(result.cancelling ? "已请求中断：当前段落跑完就停" : "批次已中断，已完成段落保留");
    if (!result.cancelling) {
      state.batchRunning = false;
      state.batchPaused = false;
      state.batchCancelling = false;
      refreshActions();
    }
  } catch (error) {
    state.batchCancelling = false;
    refreshActions();
    toast(error.message);
  }
}

async function runBatch() {
  if (!state.batchPreview?.batchId || state.batchRunning) return;
  const hasPending = state.batchPreview.segments.some((segment) => segment.selected && segment.status !== "done");
  if (!hasPending) return toast("没有待翻译的分段");
  // 语境分析是翻译的前置条件：服务端会返回 409，这里等在原地，避免用"猜出来的用途"翻整批。
  if (state.batchBriefPending || !state.batchBrief || state.batchBrief.status !== "ready") {
    const ready = await waitForBatchBrief(state.batchPreview.batchId);
    if (!ready) return toast("语境分析还没完成，请稍后重试或手动重新分析");
  }
  state.batchRunning = true;
  state.batchPaused = false;
  refreshActions();
  renderBatchSegments();
  try {
    await saveBatchProgress();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await api(`/api/batch/run/${encodeURIComponent(state.batchPreview.batchId)}/start`, {
          method: "POST",
          body: JSON.stringify({ ...projectPayload(), qualityTier: batchQualityTier() })
        });
        break;
      } catch (error) {
        // 服务端发现语境档案还没就绪：等它跑完再自动继续，而不是把 409 甩给用户。
        if (attempt === 0 && /语境分析/.test(error.message)) {
          toast("服务端还在做语境分析，完成后自动开始翻译");
          const ready = await waitForBatchBrief(state.batchPreview.batchId);
          if (!ready) throw error;
          continue;
        }
        throw error;
      }
    }
    toast("批次已交给服务端后台执行，关闭页面也会继续");
    await pollServerBatch(state.batchPreview.batchId);
  } catch (error) {
    state.batchRunning = false;
    state.batchPaused = false;
    refreshActions();
    renderBatchSegments();
    toast(`后台批次启动失败：${error.message}`);
  }
}

async function runBatchInBrowserLegacy() {
  if (!state.batchPreview || state.batchRunning) return;
  const segments = state.batchPreview.segments;
  const queue = segments.filter((segment) => segment.selected && segment.status !== "done");
  if (!queue.length) return toast("没有待翻译的分段");
  state.batchRunning = true;
  state.batchPaused = false;
  refreshActions();
  renderBatchSegments();
  const structuredGroupMode = state.batchPreview.segmentationMode === "group";
  const groupById = structuredGroupMode ? structuredContextGroups(queue) : new Map();
  if (!state.batchClassification) {
    const documentText = segments.filter((segment) => segment.selected).map((segment) => segment.source).join("\n").slice(0, 8_000);
    try {
      state.batchClassification = await api("/api/classify", { method: "POST", body: JSON.stringify({
        text: documentText,
        hint: "auto",
        useModel: true
      }) });
      const contentType = state.batchClassification.contentType;
      state.batchStyleProfile = {
        id: `batch-${contentType}`,
        name: state.bootstrap.contentTypes[contentType].label,
        source: "batch-content-type",
        instruction: state.bootstrap.contentTypes[contentType].register
      };
      renderBatchSegments();
    } catch (error) {
      state.batchRunning = false;
      refreshActions();
      renderBatchSegments();
      return toast(`批次语体识别失败：${error.message}`);
    }
  }
  for (const segment of queue) {
    if (state.batchPaused) break;
    segment.status = "running";
    segment.error = "";
    renderBatchSegments();
    const position = segments.indexOf(segment);
    const groupContext = groupById.get(segment.id);
    const context = {
      ...(segment.context || {}),
      previous: segment.context?.previous || segments[position - 1]?.source || "",
      next: segment.context?.next || segments[position + 1]?.source || "",
      document: state.batchPreview.filename,
      segmentIndex: position + 1,
      segmentCount: segments.length
    };
    try {
      // 本批已定稿译文作为风格锚点：后续各行严格仿照同一句式与用词。
      const anchorCount = Math.max(0, Number(state.projectSettings?.tm?.contextAnchorCount ?? 5));
      const contextKey = `${segment.locator?.type || ""}\u0000${segment.locator?.sheet || segment.context?.sheet || ""}`;
      const batchReferences = segments.slice(0, position)
        .filter((item) => item.translation && `${item.locator?.type || ""}\u0000${item.locator?.sheet || item.context?.sheet || ""}` === contextKey)
        .slice(-anchorCount)
        .map((item) => ({ source: item.source, target: item.translation }));
      const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        source: segment.source,
        locale: state.workbenchLocale,
        contentType: segment.result?.segmentPurpose || state.batchClassification.contentType,
        domain: "auto",
        neighborContext: context,
        styleProfile: state.batchStyleProfile,
        batchId: state.batchPreview.batchId || state.batchPreview.filename,
        segmentId: segment.id,
        entryId: segment.locator?.unitId || segment.locator?.entryId || segment.context?.entryId || "",
        sourceFile: state.batchPreview.filename || "",
        sourceRow: segment.locator?.row || segment.context?.row || null,
        previousSource: context.previous || "",
        nextSource: context.next || "",
        batchReferences,
        batchGroupEntries: groupContext?.group.map((item) => ({ id: item.id, source: item.source, context: item.context })) || [],
        qualityTier: batchQualityTier(),
        useModelClassification: false
      }) });
      if (result.styleProfile?.source === "style-library") state.batchStyleProfile = result.styleProfile;
      segment.translation = result.translation;
      segment.result = result;
      segment.status = "done";
      segment.accepted = false;
    } catch (error) {
      segment.status = "error";
      segment.error = error.message;
    }
    renderBatchSegments();
    saveBatchProgress();
  }
  state.batchRunning = false;
  const paused = state.batchPaused;
  state.batchPaused = false;
  renderBatchSegments();
  refreshActions();
  await saveBatchProgress();
  if (!paused && segments.some((segment) => segment.status === "done")) {
    try {
      const review = await api("/api/evolution/review", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        locale: state.workbenchLocale,
        contentType: state.batchClassification?.contentType || "general",
        domain: "auto",
        batchId: state.batchPreview.batchId || ""
      }) });
      const parts = [];
      if (review.distilled) parts.push(`已生成风格规范草稿 v${review.distilled.version}`);
      else if (review.distillPending) parts.push(`风格证据 ${styleDistillProgress(review.distillPending)}`);
      if (review.profile) parts.push(`已生成译者画像草稿 v${review.profile.version}`);
      else if (review.profilePending) parts.push(`画像证据 ${review.profilePending.acceptedCount}/${review.profilePending.threshold}`);
      if (review.review?.trend?.length) parts.push(`复盘发现 ${review.review.trend.length} 类问题趋势`);
      toast(parts.length ? `任务后复盘完成：${parts.join("；")}` : "任务后复盘完成，暂无新的风格发现");
    } catch {}
  }
  const failed = segments.filter((segment) => segment.selected && segment.status === "error").length;
  if (paused) toast("批次已暂停，当前进度已保留");
  else if (failed) toast(`批次运行结束，${failed} 段失败，可点击“继续 / 重试”`);
  else toast("批次翻译完成，可以导出原格式文件");
}

function taskStatusLabel(status) {
  return { ready: "待启动", in_progress: "进行中", paused: "已暂停", review: "QA 待处理", needs_attention: "存在失败", completed: "已完成" }[status] || "待处理";
}

function formatTaskTime(value) {
  if (!value) return "时间未知";
  try { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return String(value); }
}

let tasksLoading = false;
async function loadTasks() {
  // 轮询 + 手动刷新 + 搜索防抖可能同时触发；同一时刻只发一个 /api/tasks。
  if (tasksLoading) return;
  tasksLoading = true;
  try {
    const query = new URLSearchParams();
    if ($("#taskType")?.value) query.set("type", $("#taskType").value);
    if ($("#taskLocale")?.value) query.set("locale", $("#taskLocale").value);
    if ($("#taskSearch")?.value.trim()) query.set("search", $("#taskSearch").value.trim());
    if (state.activeProjectId) query.set("projectId", state.activeProjectId);
    state.tasks = await api(`/api/tasks?${query}`);
    renderTasks();
  } finally {
    tasksLoading = false;
  }
}

const TASK_CENTER_POLL_MS = 3000;
let taskCenterTimer = 0;

function stopTaskCenterPolling() {
  if (!taskCenterTimer) return;
  window.clearInterval(taskCenterTimer);
  taskCenterTimer = 0;
}

function startTaskCenterPolling() {
  if (!taskCenterTimer) {
    taskCenterTimer = window.setInterval(() => {
      if (document.hidden || state.view !== "tasks") return;
      loadTasks().catch(() => {});
    }, TASK_CENTER_POLL_MS);
  }
  loadTasks().catch(() => {});
}

/**
 * 通知中心：把任务中心那两份现成数据（任务列表 + 待处理 QA 案例）翻译成
 * "完成了 / 需要处理 / 进行中"的条目。不额外维护一张通知表：任务被删掉，
 * 对应通知自然消失；已读与否只记一个时间点。
 */
/** 轮询只要够新就行：30 秒一轮既能让角标及时，也不会给 Directus 添压力。 */
const NOTIFICATION_POLL_MS = 30000;
const NOTIFICATION_LIMIT = 20;
let notificationTimer = 0;

function notificationSeenAt() {
  try { return localStorage.getItem("kami-notification-seen") || ""; } catch { return ""; }
}

function setNotificationSeenAt(value) {
  try { localStorage.setItem("kami-notification-seen", value); } catch { /* 隐私模式写不进去：角标照常算，只是不记住 */ }
}

/** 通知里的一行细节：进度、失败、待处理各取需要的部分。 */
function notificationTaskDetail(task) {
  const counts = [];
  if (Number(task.failedSegments)) counts.push(`${Number(task.failedSegments)} 段失败`);
  if (Number(task.qaPending)) counts.push(`${Number(task.qaPending)} 条待处理`);
  const segments = Number(task.totalSegments) ? `${Number(task.completedSegments) || 0} / ${Number(task.totalSegments)} 段` : "";
  // 后台任务自带更具体的进度文案（"正在入库：120 / 900"），有就用它，别把同一件事写两遍。
  const head = String(task.progress?.message || "").trim() || segments;
  return [head, ...counts, head ? "" : String(task.taskType || "")].filter(Boolean).join(" · ");
}

function buildNotifications(tasks = [], pendingQaCases = []) {
  const items = [];
  for (const task of tasks) {
    const at = task.updatedAt || task.createdAt || "";
    const label = task.filename || task.title || "任务";
    const detail = notificationTaskDetail(task);
    // 学习中心的评测任务在任务中心里也有记录，点通知要跳回学习中心看结论。
    const view = task.payload?.learningJobId ? "learning" : "tasks";
    if (task.status === "completed") items.push({ id: `task:${task.id}:completed`, kind: "done", at, view, title: `已完成：${label}`, detail });
    else if (task.status === "needs_attention") items.push({ id: `task:${task.id}:attention`, kind: "attention", at, view, title: `需要处理：${label}`, detail });
    else if (task.status === "review") items.push({ id: `task:${task.id}:review`, kind: "attention", at, view, title: `待复核：${label}`, detail });
    else if (["in_progress", "paused"].includes(task.status)) items.push({ id: `task:${task.id}:running`, kind: "running", at, view, title: `${task.status === "paused" ? "已暂停" : "进行中"}：${label}`, detail });
  }
  const pendingCount = pendingQaCases.length;
  if (pendingCount) {
    const latest = pendingQaCases.map((item) => item.updatedAt || item.createdAt || "").sort().at(-1) || "";
    items.push({
      id: `qa-pending:${pendingCount}`, kind: "attention", at: latest, view: "autoqa",
      title: `${pendingCount} 个 QA 案例等着处理`,
      detail: "在译文质检里逐条采纳或丢弃，处理完才会进入学习与回归集。"
    });
  }
  return items
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))
    .slice(0, NOTIFICATION_LIMIT);
}

function unreadNotifications() {
  const seenAt = notificationSeenAt();
  return (state.notifications || []).filter((item) => item.at && item.at > seenAt);
}

function renderNotificationCenter() {
  const badge = $("#notificationBadge");
  const bell = $("#notificationBell");
  const list = $("#notificationList");
  if (!badge || !list) return;
  const unread = unreadNotifications();
  badge.hidden = unread.length === 0;
  badge.textContent = unread.length > 99 ? "99+" : String(unread.length);
  bell?.classList.toggle("has-unread", unread.length > 0);
  $("#notificationMeta").textContent = unread.length ? `${unread.length} 条未读 · 共 ${state.notifications.length} 条` : `共 ${state.notifications.length} 条 · 没有未读`;
  // 读过的条目要"退到背景里"：文字变浅、圆点从彩色变灰，只剩时间戳和条目本身。
  const seenAt = notificationSeenAt();
  const highlight = state.notificationHighlight;
  list.innerHTML = state.notifications.length
    ? state.notifications.map((item) => {
      const isUnread = highlight ? highlight.has(item.id) : Boolean(item.at) && item.at > seenAt;
      return `<button class="notification-item ${escapeHtml(item.kind)} ${isUnread ? "is-unread" : "is-read"}" type="button" data-notification-view="${escapeHtml(item.view || "")}" title="${escapeHtml(item.detail || "")}"><span class="notification-dot" aria-hidden="true"></span><div><strong>${escapeHtml(item.title)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</div><span class="notification-time">${escapeHtml(item.at ? formatTaskTime(item.at) : "")}</span></button>`;
    }).join("")
    : '<div class="empty-list"><div><strong>暂无通知</strong><span>任务完成、失败或需要处理时会出现在这里。</span></div></div>';
}

function setNotificationPanel(open) {
  const panel = $("#notificationPanel");
  const bell = $("#notificationBell");
  if (!panel || !bell) return;
  panel.hidden = !open;
  bell.setAttribute("aria-expanded", String(open));
  if (open) {
    // 打开就算读过（角标立刻清），但这一次打开里保留"这几条是新到的"高亮：
    // 否则刚点开就全变浅色，根本看不出哪几条是新来的。关掉面板即结束本次高亮。
    state.notificationHighlight = new Set(unreadNotifications().map((item) => item.id));
    if (state.notificationHighlight.size) setNotificationSeenAt(new Date().toISOString());
  } else {
    state.notificationHighlight = null;
  }
  renderNotificationCenter();
}

async function loadNotifications() {
  if (!state.activeProjectId) return;
  const params = new URLSearchParams({ limit: "60", projectId: state.activeProjectId });
  const qaParams = new URLSearchParams({ locale: state.autoQaLocale || "zh-CN", projectId: state.activeProjectId });
  // 后台轮询失败不该刷日志、也不该点亮日志角标：Directus 抖一下不该等于一次报错。
  // 真要看错误，去任务中心/日志页，那是用户主动发起的请求。
  const silent = { logFailure: false };
  const [tasks, pendingQaCases] = await Promise.all([
    api(`/api/tasks?${params}`, {}, silent).catch(() => []),
    api(`/api/qa-cases/pending?${qaParams}`, {}, silent).catch(() => [])
  ]);
  state.notifications = buildNotifications(Array.isArray(tasks) ? tasks : [], Array.isArray(pendingQaCases) ? pendingQaCases : []);
  renderNotificationCenter();
}

function startNotificationPolling() {
  notificationTimer ||= window.setInterval(() => {
    // 页面在后台就不轮询：没人看的刷新只会白占请求。
    if (document.hidden) return;
    loadNotifications().catch(() => {});
  }, NOTIFICATION_POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadNotifications().catch(() => {}); });
  loadNotifications().catch(() => {});
}

function renderTasks() {
  const allTasks = state.tasks || [];
  const entries = groupTaskEntries(allTasks, { labelFor: (type) => BACKGROUND_TASK_LABELS[type] || type });
  const statusOf = (entry) => taskEntryStatus(entry);
  const counts = { running: 0, attention: 0, done: 0, other: 0 };
  const bucketOf = (status) => status === "in_progress" ? "running" : status === "needs_attention" ? "attention" : status === "completed" ? "done" : "other";
  for (const entry of entries) counts[bucketOf(statusOf(entry))] += 1;
  $("#taskCount").textContent = `${allTasks.length} 个任务`;
  const chip = (id, label, count) => `<button class="task-stat ${id}${state.taskFilter === id ? " active" : ""}" type="button" data-task-filter="${id}" aria-pressed="${state.taskFilter === id}"><strong>${count}</strong> ${label}</button>`;
  const filterNames = { running: "进行中", attention: "待处理", done: "已完成" };
  $("#taskSummary").innerHTML = `${chip("running", "进行中", counts.running)}${chip("attention", "待处理", counts.attention)}${chip("done", "已完成", counts.done)}<button class="task-stat total" type="button" data-task-filter="all" aria-pressed="${!state.taskFilter}">共 ${allTasks.length} 个任务 · ${entries.length} 条记录</button>`;
  const advanced = [];
  const typeSelect = $("#taskType");
  if (typeSelect?.value) advanced.push(typeSelect.options[typeSelect.selectedIndex]?.textContent || "已筛类型");
  const search = $("#taskSearch")?.value.trim() || "";
  if (search) advanced.push(`“${search}”`);
  if (state.taskFilter) advanced.unshift(filterNames[state.taskFilter] || "");
  $("#taskToolsSummary").textContent = advanced.length ? `已筛选：${advanced.filter(Boolean).join(" · ")}` : "全部任务";
  $("#taskFilterDot").hidden = !(typeSelect?.value || search);
  const renderCard = (task) => {
    if (task.type === "autoqa") return renderQaTaskRow(task);
    if (task.type === "background") return renderBackgroundTaskRow(task);
    return renderBatchTaskRow(task);
  };
  const renderBundle = (bundle) => {
    const status = statusOf(bundle);
    const expanded = state.taskGroupExpanded.has(bundle.key);
    const label = status === "in_progress" ? "进行中" : status === "needs_attention" ? "待处理" : status === "completed" ? "已完成" : "其他";
    const summary = bundle.summary;
    const parts = [`完成 ${summary.completed}`];
    if (summary.attention) parts.push(`待处理 ${summary.attention}`);
    if (summary.running) parts.push(`进行中 ${summary.running}`);
    return `<section class="task-bundle" data-task-bundle="${escapeHtml(bundle.key)}">
      <button class="task-bundle-head" type="button" data-task-bundle-toggle="${escapeHtml(bundle.key)}" aria-expanded="${expanded}">
        <span class="task-bundle-caret" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
        <span class="task-bundle-title"><strong>${escapeHtml(bundle.title)}</strong><small>${escapeHtml(parts.join(" · "))} · ${escapeHtml(formatTaskTime(bundle.updatedAt))}</small></span>
        <span class="task-status ${status}">${label}</span>
      </button>
      <div class="task-bundle-body" ${expanded ? "" : "hidden"}>${bundle.tasks.map(renderCard).join("")}</div>
    </section>`;
  };
  const sections = [
    { id: "running", title: "进行中", hint: "后台正在跑，关掉页面也会继续", match: (entry) => statusOf(entry) === "in_progress" },
    { id: "attention", title: "待处理", hint: "失败、待复核或等你确认", match: (entry) => statusOf(entry) === "needs_attention" },
    { id: "done", title: "已完成", hint: "结果、导出与审计记录", match: (entry) => statusOf(entry) === "completed" },
    { id: "other", title: "其他", hint: "", match: () => true }
  ];
  const filter = state.taskFilter || "";
  const visibleSections = filter ? sections.filter((section) => section.id === filter) : sections;
  const claimed = new Set();
  const html = entries.length ? visibleSections.map((section) => {
    const items = [];
    for (const entry of entries) {
      if (claimed.has(entry) || !section.match(entry)) continue;
      claimed.add(entry);
      items.push(entry);
    }
    if (!items.length) return "";
    return `<section class="task-group" data-task-group="${section.id}">
      <div class="task-group-head"><strong>${escapeHtml(section.title)}</strong><span>${items.length} 条${section.hint ? ` · ${escapeHtml(section.hint)}` : ""}</span></div>
      <div class="task-group-list">${items.map((entry) => entry.kind === "group" ? renderBundle(entry) : renderCard(entry)).join("")}</div>
    </section>`;
  }).join("") : "";
  $("#taskList").innerHTML = html || `<div class="empty-list task-empty">${filter ? "当前筛选下没有任务；点「共 N 个任务」回到全部。" : "没有符合当前筛选条件的历史任务"}</div>`;
  $$(".task-row [data-action]").forEach((button) => button.addEventListener("click", () => {
    const id = button.closest(".task-row").dataset.taskId;
    const action = button.dataset.action;
    if (action === "open-task") openTask(id);
    else if (action === "export-task") exportTaskRow(id, button);
    else if (action === "open-qa-task") openQaTask(id);
    else if (action === "delete-qa-task") deleteQaTaskRow(id, button);
    else if (action === "download-export") downloadBackgroundExport(id, button);
    else if (action === "open-import-review") openImportReview(id, button);
    else if (action === "open-batch") openTask(button.dataset.batchId || "");
    else if (action === "continue-import") continueImportTask(id, button);
    else if (action === "pause-task") pauseBatchTask(id, button);
    else if (action === "continue-task") continueBatchTask(id, button);
    else if (action === "retry-qa-task") retryBatchQa(id, button);
    else if (action === "retry-report-task" || action === "retry-survey-task") runBatchTaskAction(button, {
      busyText: "提交中…", endpoint: `/api/batch/run/${encodeURIComponent(id)}/${action === "retry-report-task" ? "consistency-check" : "term-survey"}`,
      body: projectPayload(), doneText: () => "已开始重试，阶段进度会自动更新"
    });
    else if (action === "import-review") importReviewTask(id, button);
    else if (action === "jump-qa") jumpToTaskQa(id, button);
    else if (action === "delete-task") deleteTaskRow(id, button);
    else if (action === "cancel-task") cancelBatchTask(id, button);
    else if (action === "cancel-background") cancelBackgroundTaskRow(id, button);
    else if (action === "delete-background") deleteBackgroundTaskRow(id, button);
    else if (action === "open-learning") switchView("learning");
    else if (action === "open-reference") openReferenceTaskTarget(button).catch((error) => toast(error.message));
  }));
}
async function openReferenceTaskTarget(button) {
  const taskKind = button.dataset.referenceTaskKind || "";
  const targetId = button.dataset.referenceTarget || "";
  switchView("references");
  if (taskKind === "reference_folder_delete") {
    state.referenceFolderId = targetId;
    await loadReferences();
    return;
  }
  if (!targetId) return;
  await loadReferences();
  const document = (state.referenceDocuments || []).find((item) => item.id === targetId);
  if (document?.folderId !== undefined && document.folderId !== state.referenceFolderId) {
    state.referenceFolderId = document.folderId || "";
    await loadReferences();
  }
  if ((state.referenceDocuments || []).some((item) => item.id === targetId)) await openReferenceDetail(targetId);
}

const BACKGROUND_TASK_LABELS = { term_import: "术语导入", term_survey: "术语普查", asset_import: "双语资产导入", batch_translation: "后台批次翻译", context_analysis: "语境分析", consistency_check: "一致性核对", quality_gate: "质量门禁", embedding_rebuild: "Embedding 重建", batch_export: "批次导出", skill_evaluation: "技能评测", style_evaluation: "风格评测", reference_ingest: "参考资料导入", reference_describe: "资料 AI 扫描", reference_folder_delete: "资料目录删除" };

/** 导入类任务的中断/失败都能用同一个批次续跑（已写入的重复项会自动跳过）。 */
function resumableImportTask(task) {
  if (!["term_import", "asset_import"].includes(task.taskType)) return false;
  if (!["failed", "needs_attention"].includes(task.status)) return false;
  return Boolean(task.payload?.batchId || task.payload?.resumable);
}

function renderBackgroundTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const progress = task.progress || {};
  const percent = Number.isFinite(Number(progress.percent)) ? Math.max(0, Math.min(100, Number(progress.percent))) : (task.status === "completed" ? 100 : 0);
  // 中断与服务重启打断都用 progress.phase 区分，状态本身仍是库里允许的取值。
  const stoppedPhase = ["cancelled", "interrupted"].includes(progress.phase);
  const statusLabel = stoppedPhase ? "已中断" : task.status === "in_progress" ? "进行中" : task.status === "review" ? "等待审核" : ["needs_attention", "failed"].includes(task.status) ? "失败" : "已完成";
  const statusClass = task.status === "in_progress" || task.status === "review" ? "warning" : task.status === "needs_attention" ? "error" : "success";
  const message = progress.message || "";
  const download = task.taskType === "batch_export" && task.status === "completed" && task.payload?.downloadUrl;
  const summary = task.payload?.summary;
  const canResumeImport = task.taskType === "term_import" && task.status === "review" && task.payload?.batchId;
  const canContinueImport = resumableImportTask(task);
  // 语境分析与一致性核对都属于某条批次：任务行要能一键跳回批次页看结果。
  const canOpenBatch = ["context_analysis", "consistency_check"].includes(task.taskType) && Boolean(task.payload?.batchId);
  // 评测任务跑起来就不能中途掐（评测器不支持半路取消），别给一个按了没反应的"中断"。
  const canOpenLearning = Boolean(task.payload?.learningJobId);
  const referenceTargetId = String(task.payload?.documentId || task.payload?.folderId || "");
  const canOpenReference = ["reference_ingest", "reference_describe", "reference_folder_delete"].includes(task.taskType) && Boolean(referenceTargetId);
  const canCancel = task.status === "in_progress" && !canOpenLearning;
  // 导入类任务会把审校稿接回学习轨迹：接回多少条、多少条因歧义/找不到原文没接上，
  // 用户要能在任务行直接看到，不用去翻任务 payload。
  const trajectoryText = summary && summary.trajectoriesLinked != null
    ? ` · 接回轨迹 ${summary.trajectoriesLinked} 条${(Number(summary.trajectoryAmbiguous) || Number(summary.trajectoryUnmatched))
      ? `（歧义 ${summary.trajectoryAmbiguous ?? 0} / 未匹配 ${summary.trajectoryUnmatched ?? 0}）`
      : ""}${Number(summary.trajectoryAlreadyAccepted) ? ` · 此前已采纳跳过 ${Number(summary.trajectoryAlreadyAccepted)} 条` : ""}`
    : "";
  const payloadText = summary
    ? `术语 ${summary.terms ?? 0} · 译例 ${summary.memories ?? 0} · 风格草稿 ${summary.styleProfiles ?? 0} · 跳过 ${summary.skipped ?? 0}${summary.skippedByReason ? `（${Object.entries(summary.skippedByReason).map(([reason, count]) => `${reason} ${count}`).join("；")}）` : ""}${trajectoryText}`
    : task.payload?.error ? `错误：${task.payload.error}` : "";
  return `<article class="task-row task-card" data-task-id="${escapeHtml(task.id)}" data-task-status="${escapeHtml(task.status || "")}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.title)}</strong><span class="task-status ${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span><span class="task-type-chip">${escapeHtml(BACKGROUND_TASK_LABELS[task.taskType] || "后台")}</span></div><small title="${escapeHtml(message || payloadText || "")}">${locale ? `${escapeHtml(locale.label)} · ` : ""}${escapeHtml(message || payloadText || contentTypeLabel(task.contentType))} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:${percent}%"></i></div><span>${task.totalSegments ? `${task.completedSegments} / ${task.totalSegments}` : `${percent}%`}</span></div>
    <div class="task-qa"><strong title="${escapeHtml(payloadText || "")}">${payloadText || (canResumeImport ? `${task.payload.candidateCount || 0} 条候选` : "—")}</strong><small>${task.status === "in_progress" ? "后台执行中" : canResumeImport ? "识别完成，等待人工确认" : formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-actions">${canOpenReference ? `<button class="button secondary small" data-action="open-reference" data-reference-target="${escapeHtml(referenceTargetId)}" data-reference-task-kind="${escapeHtml(task.taskType)}">打开位置</button>` : ""}${canOpenLearning ? '<button class="button secondary small" data-action="open-learning">打开学习中心</button>' : ""}${download ? `<button class="button primary small" data-action="download-export">下载 Excel</button>` : ""}${canOpenBatch ? `<button class="button secondary small" data-action="open-batch" data-batch-id="${escapeHtml(task.payload.batchId)}">查看批次</button>` : ""}${canResumeImport ? `<button class="button secondary small" data-action="open-import-review">继续审核</button>` : ""}${canContinueImport ? `<button class="button secondary small" data-action="continue-import">继续导入</button>` : ""}${canCancel ? '<button class="button ghost small" data-action="cancel-background">中断</button>' : ""}<button class="button ghost small danger" data-action="delete-background">删除</button></div>
  </article>`;
}

/** 删除一条翻译批次：在跑的可以先中断再删（服务端会清理关联任务、原文件存档与导出文件）。 */
async function deleteTaskRow(batchId, button) {
  const task = findBatchTask(batchId);
  if (!task) return toast("找不到这条批次任务");
  const running = ["queued", "running"].includes(task.runState);
  const choice = await confirmTaskDelete({
    title: `删除「${task.filename}」`,
    summary: running
      ? "这条批次正在后台翻译。你想怎么处理？"
      : `删除后这条批次的段落与进度都会消失（已采纳进记忆库的译文不受影响）。共 ${task.totalSegments} 段。`,
    running,
    stopHint: "先中断翻译（当前段跑完就停），再删除批次记录",
    recordHint: running ? "翻译会继续跑完，但任务中心不再显示这条批次" : "删除批次记录"
  });
  if (!choice) return;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(batchId)}?stop=${choice === "stop" ? "1" : "0"}`, { method: "DELETE", body: JSON.stringify(projectPayload()) });
    if (localStorage.getItem("kami-batch-id") === batchId) {
      localStorage.removeItem("kami-batch-id");
      if (state.batchPreview?.batchId === batchId) resetBatchFileSelection?.();
    }
    toast(result.stopped ? "已停止并删除该批次" : "已删除该批次");
    await loadTasks();
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

/** 任务中心里的批次操作：暂停 / 继续 / 中断，都走已有的批次接口。 */
function findBatchTask(id) {
  return (state.tasks || []).find((item) => item.type === "batch" && item.batchId === id) || null;
}

async function runBatchTaskAction(button, { busyText, endpoint, body, doneText }) {
  const original = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = busyText; }
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    toast(doneText(result));
    await loadTasks();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

async function pauseBatchTask(id, button) {
  const task = findBatchTask(id);
  if (!task) return toast("找不到这条批次任务");
  await runBatchTaskAction(button, {
    busyText: "暂停中…",
    endpoint: `/api/batch/run/${encodeURIComponent(id)}/pause`,
    body: { projectId: task.projectId || state.activeProjectId || "" },
    doneText: () => "已请求暂停：当前段落结束就停，进度已保存"
  });
}

async function continueBatchTask(id, button) {
  const task = findBatchTask(id);
  if (!task) return toast("找不到这条批次任务");
  await runBatchTaskAction(button, {
    busyText: "续跑中…",
    endpoint: `/api/batch/run/${encodeURIComponent(id)}/start`,
    body: {
      projectId: task.projectId || state.activeProjectId || "",
      route: task.runnerOptions?.route || "auto",
      qualityTier: task.runnerOptions?.qualityTier || "auto",
      reflect: task.runnerOptions?.reflect !== false
    },
    doneText: (result) => result?.alreadyRunning ? "这个批次已经在后台跑着了" : "已继续：只翻还没完成的段落"
  });
}

async function cancelBatchTask(id, button) {
  const task = findBatchTask(id);
  if (!task) return toast("找不到这条批次任务");
  if (!confirm(`中断「${task.filename}」？已完成的段落会保留，之后可以继续翻译。`)) return;
  await runBatchTaskAction(button, {
    busyText: "中断中…",
    endpoint: `/api/batch/run/${encodeURIComponent(id)}/cancel`,
    body: { projectId: task.projectId || state.activeProjectId || "" },
    doneText: (result) => result?.cancelling ? "已请求中断：当前段落跑完就停" : "批次已中断，已完成段落保留"
  });
}

/**
 * 审校回填：把在 memoQ 里改完的同一批文件导回来。
 * 命中的段落直接覆盖译文并标记人工采纳，同时写入主 TM 并接回学习轨迹；
 * 未匹配和有歧义的条目会在弹窗里逐条列出来，不静默丢弃。
 */
function importReviewTask(batchId, button) {
  const task = findBatchTask(batchId);
  if (!task) return toast("找不到这条批次任务");
  state.reviewImportBatchId = batchId;
  const input = $("#reviewImportFile");
  input.value = "";
  input.click();
  void button;
}

function renderReviewImportDetails(report) {
  const sections = [];
  if (report.details?.unmatched?.length) {
    // 本批解析时跳过的句段（锁定 / 已有译文）不在可回填范围内：把数字写在标题里，
    // 用户才看得懂为什么这些原文"不在批次里"。
    const skipped = report.skippedUnits || {};
    const skipParts = [Number(skipped.locked) ? `锁定 ${Number(skipped.locked)}` : "", Number(skipped.existing) ? `已有译文 ${Number(skipped.existing)}` : ""].filter(Boolean);
    const skipHint = skipParts.length ? `（本批解析时已跳过：${skipParts.join(" / ")}，它们不在可回填范围）` : "";
    sections.push(`<div><strong>未匹配 ${report.unmatched} 条</strong><small>这些原文不在这个批次里，或属于被跳过的段落${escapeHtml(skipHint)}</small>${report.details.unmatched.map((item) => `<p>${escapeHtml(String(item.source).slice(0, 60))} <em>${escapeHtml(item.reason)}</em></p>`).join("")}</div>`);
  }
  if (report.details?.ambiguous?.length) {
    sections.push(`<div><strong>有歧义 ${report.ambiguous} 条</strong><small>同一条原文在批次里出现多次，缺少条目 ID 时不敢乱认（没有写入）</small>${report.details.ambiguous.map((item) => `<p>${escapeHtml(String(item.source).slice(0, 60))} <em>${escapeHtml(item.reason)}</em></p>`).join("")}</div>`);
  }
  if (report.failures?.length) {
    sections.push(`<div><strong>失败 ${report.failures.length} 条</strong>${report.failures.map((item) => `<p>${escapeHtml(String(item.source).slice(0, 60))} <em>${escapeHtml(item.reason)}</em></p>`).join("")}</div>`);
  }
  return sections.length ? sections.join("") : '<div class="manual-guide-empty"><strong>全部条目都按条目 ID 精确匹配</strong><p>没有未匹配或歧义条目。</p></div>';
}

async function submitReviewImport(file) {
  const batchId = state.reviewImportBatchId;
  if (!file || !batchId) return;
  const dialog = $("#reviewImportDialog");
  $("#reviewImportSummary").textContent = `正在回填「${file.name}」……`;
  $("#reviewImportDetails").innerHTML = "";
  if (!dialog.open) dialog.showModal();
  try {
    const report = await api(`/api/batch/run/${encodeURIComponent(batchId)}/import-review`, { method: "POST", body: JSON.stringify({
      ...projectPayload(), filename: file.name, base64: await fileToBase64(file)
    }) });
    // 已采纳过的轨迹不算"新接回"：把这三个数字分开写，否则"接回 0 条"看起来像失败。
    const linkedParts = [`接回学习轨迹 ${report.trajectoriesLinked} 条`];
    if (Number(report.trajectoriesUpdated)) linkedParts.push(`更新已采纳轨迹 ${Number(report.trajectoriesUpdated)} 条`);
    const acceptedSkipped = Number(report.trajectoryAcceptedUnchanged) || Number(report.trajectoryAlreadyAccepted);
    if (acceptedSkipped) linkedParts.push(`此前已采纳、内容相同跳过 ${acceptedSkipped} 条`);
    $("#reviewImportSummary").textContent = `已回填 ${report.matched} / ${report.total} 条（其中 ${report.changed} 条译文有改动）· 写入主 TM ${report.memoriesWritten} 条 · ${linkedParts.join(" · ")}`;
    $("#reviewImportDetails").innerHTML = renderReviewImportDetails(report);
    toast(`审校回填完成：匹配 ${report.matched} 条，写入主 TM ${report.memoriesWritten} 条`);
    await loadTasks();
  } catch (error) {
    $("#reviewImportSummary").textContent = `回填失败：${error.message}`;
    toast(error.message);
  }
}

/** 导入类任务（术语 / 双语资产 / TM）的中断：跑批循环在下一处分块边界停下。 */
async function cancelBackgroundTaskRow(id, button) {
  const original = button?.textContent || "中断";
  if (button) { button.disabled = true; button.textContent = "中断中…"; }
  try {
    const result = await api(`/api/background-tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast(result.cancelling ? "已请求中断：正在跑的循环会在下一处分块停下" : result.stopped ? "任务已标记中断" : "任务已经不在运行");
    await loadTasks();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

/**
 * 任务中心的「继续导入」：复用同一个批次续跑。已写入的条目会被当作重复跳过，
 * 所以中断或服务重启之后都能补齐剩余候选。
 */
async function continueImportTask(id, button) {
  const task = (state.tasks || []).find((item) => item.id === id);
  const batchId = task?.payload?.batchId;
  if (!batchId) return toast("这条任务没有可续传的批次，需重新上传文件");
  const original = button?.textContent || "继续导入";
  if (button) { button.disabled = true; button.textContent = "续传中…"; }
  try {
    // TM 导入（term_import）的续传读服务端预检缓存，而不是审核队列：
    // 队列改为导入成功后才写，失败时库里本来就没有候选可续。
    if (task.taskType === "term_import") {
      const started = await api("/api/tm-import/commit", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        batchId,
        filename: task.payload?.filename || task.title || "人工 TM 导入",
        background: true
      }) });
      toast(`已重新提交导入 ${started.accepted || 0} 条，进度见任务中心`);
      await loadTasks();
      return;
    }
    const result = await api("/api/assets-import/resume", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId,
      purpose: task.payload?.purpose || "term",
      aiCleaning: task.payload?.aiCleaning === true,
      styleEvidence: task.payload?.styleEvidence === true
    }) });
    toast(`已续传 ${result.accepted || 0} 条候选，进度见任务中心`);
    await loadTasks();
    watchAssetImportTask(result.taskId, { returnView: "" }).catch(() => {});
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

async function openImportReview(id, button) {
  const task = (state.tasks || []).find((item) => item.id === id);
  const batchId = task?.payload?.batchId;
  if (!batchId) return toast("这条旧任务没有关联审核批次，无法恢复");
  const original = button?.textContent || "继续审核";
  if (button) { button.disabled = true; button.textContent = "恢复中…"; }
  try {
    const result = await api(`/api/term-import/review/${encodeURIComponent(batchId)}`);
    result.candidates.forEach((candidate) => { candidate.selected = candidate.decision === "ready" && !candidate.existing; });
    state.importFile = null;
    state.importPreview = { ...result, backgroundTaskId: id };
    state.importCompleted = result.status === "completed";
    state.importCandidateTab = "terms";
    state.importVisibleCount = { terms: 150, styles: 150 };
    state.importBatchLearning = [];
    $("#termFile").value = "";
    $("#filePrompt").textContent = result.filename || task.title;
    $("#fileMeta").textContent = `${result.candidates.length} 条候选 · 已从审核队列恢复`;
    $("#dropZone").classList.add("has-file");
    updateImportProgress({ phase: "pending-commit", message: "识别完成，等待确认入库", percent: 100, completed: 1, total: 1 });
    $("#mappingNote").textContent = `已恢复昨晚保存的审核批次，共 ${result.candidates.length} 条候选；尚未写入正式术语库。页面按每批 150 条显示，避免大批量数据再次卡住。`;
    $("#importBatchLearningPanel").hidden = true;
    $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
    switchView("import");
    renderImportCandidates();
    toast(`已恢复 ${result.candidates.length} 条候选，请继续审核`);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

async function downloadBackgroundExport(id, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "下载中…";
  try {
    const response = await api(`/api/background-tasks/${encodeURIComponent(id)}`);
    const delivered = await deliverExportedFile(response.task || response, id);
    toast(delivered.message);
  } catch (error) {
    toast(`下载失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/**
 * 删除任务：进行中的任务要先问清楚是"停止并删除"还是"只删记录"，
 * 否则删了列表项后台还在跑，用户以为任务已经没了。
 */
async function confirmTaskDelete({ title, summary, running, stopHint, recordHint }) {
  const options = [];
  if (running) options.push({ id: "stop", label: "停止并删除", hint: stopHint || "先中断任务，等它真正停下再删除记录" });
  options.push({ id: "record", label: running ? "仅删除记录" : "删除", hint: recordHint || (running ? "后台会继续跑完，但列表里不再显示" : "删除这条记录，已完成的结果一并清掉") });
  return openChoiceDialog({ kicker: "DELETE TASK", title, summary, options });
}

async function deleteBackgroundTaskRow(id, button) {
  const task = (state.tasks || []).find((item) => item.id === id);
  const running = task?.status === "in_progress";
  // 门禁/评测这类任务没有"仅删记录还继续跑"这回事：记录一删，执行方在下一个样本边界
  // 就查不到任务了，只能按"执行已中断"收尾。文案得说清，否则会得到一条看不懂的阻断结论。
  const abortsOnDelete = ["quality-gate", "skill_evaluation"].includes(String(task?.taskType || ""));
  const choice = await confirmTaskDelete({
    title: `删除「${task?.title || "后台任务"}」`,
    summary: running
      ? "这条任务还在后台运行。你想怎么处理？"
      : "确认删除这条任务记录？（导入类任务已写入的数据不会被删除）",
    running: Boolean(running),
    stopHint: abortsOnDelete
      ? "先请求中断：在下一个样本前停下，已跑完的样本保留"
      : "先请求中断（跑批循环在下一处分块停下），再删除记录",
    recordHint: running
      ? (abortsOnDelete
        ? "删掉记录＝放弃这次执行：会以「执行已中断」收尾，不会给出有效结论"
        : "后台会继续跑完，但列表里不再显示")
      : "只删记录"
  });
  if (!choice) return;
  if (choice === "stop") {
    await api(`/api/background-tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify(projectPayload()) }).catch(() => {});
    // 给跑批循环一点时间在分块边界停下，避免刚删完又被进度写回来。
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await api(`/api/background-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadTasks();
    toast("已删除后台任务");
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

function referenceFolderById(id) {
  return (state.referenceFolders || []).find((folder) => folder.id === String(id || "")) || null;
}

function referenceChildFolders(parentId = "") {
  const normalized = String(parentId || "");
  return (state.referenceFolders || [])
    .filter((folder) => String(folder.parentId || "") === normalized)
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "zh-CN", { numeric: true }));
}

function referenceFolderDescendantIds(folderId) {
  const ids = [];
  const queue = [String(folderId || "")];
  const seen = new Set();
  while (queue.length) {
    const parent = queue.shift();
    for (const folder of referenceChildFolders(parent)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      ids.push(folder.id);
      queue.push(folder.id);
    }
  }
  return ids;
}

function referenceFolderPath(folderId, { includeRoot = true } = {}) {
  const names = [];
  let current = referenceFolderById(folderId);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name || "未命名文件夹");
    current = referenceFolderById(current.parentId);
  }
  if (includeRoot) names.unshift("根目录");
  return names.join(" / ");
}

function referenceVisionModeLabel(mode = state.referenceVisionMode) {
  return mode === "none" ? "仅文字" : "文字 + 图片";
}

function renderReferenceVisionToggle() {
  $$("[data-reference-vision]").forEach((button) => {
    const active = button.dataset.referenceVision === state.referenceVisionMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderReferenceTree() {
  const container = $("#referenceTree");
  if (!container) return;
  const renderNode = (folder, depth) => {
    const children = referenceChildFolders(folder.id);
    const expanded = state.referenceExpanded.has(folder.id);
    const selected = state.referenceFolderId === folder.id;
    return `<div class="reference-tree-node" data-reference-folder-id="${escapeHtml(folder.id)}">
      <div class="reference-tree-row ${selected ? "is-selected" : ""}" style="--tree-depth:${depth * 14}px" draggable="true">
        <button class="reference-tree-toggle" type="button" data-reference-tree-toggle="${escapeHtml(folder.id)}" ${children.length ? "" : "disabled"}>${children.length ? (expanded ? "▾" : "▸") : ""}</button>
        <button class="reference-tree-name" type="button" data-reference-folder-open="${escapeHtml(folder.id)}" title="${escapeHtml(referenceFolderPath(folder.id))}"><span aria-hidden="true">▣</span><span>${escapeHtml(folder.name)}</span></button>
        <small>${Number(folder.documentCount) || 0}</small>
        <button class="reference-tree-more" type="button" data-reference-folder-menu="${escapeHtml(folder.id)}" aria-label="文件夹操作">⋯</button>
      </div>
      ${expanded && children.length ? `<div class="reference-tree-children">${children.map((child) => renderNode(child, depth + 1)).join("")}</div>` : ""}
    </div>`;
  };
  container.innerHTML = `<div class="reference-tree-node" data-reference-folder-id="">
    <div class="reference-tree-row reference-tree-root ${state.referenceFolderId ? "" : "is-selected"}" style="--tree-depth:0px">
      <button class="reference-tree-toggle" type="button" disabled></button>
      <button class="reference-tree-name" type="button" data-reference-folder-open=""><span aria-hidden="true">⌂</span><span>项目根目录</span></button>
      <small>${(state.referenceFolders || []).filter((folder) => !folder.parentId).length}</small>
    </div>
  </div>${referenceChildFolders("").map((folder) => renderNode(folder, 0)).join("")}`;
}

function renderReferenceBreadcrumb() {
  const container = $("#referenceBreadcrumb");
  if (!container) return;
  const trail = [];
  let current = referenceFolderById(state.referenceFolderId);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = referenceFolderById(current.parentId);
  }
  container.innerHTML = [
    `<button type="button" class="reference-crumb ${state.referenceFolderId ? "" : "is-current"}" data-reference-folder-open="">⌂ 项目根目录</button>`,
    ...trail.map((folder, index) => `<span aria-hidden="true">/</span><button type="button" class="reference-crumb ${index === trail.length - 1 ? "is-current" : ""}" data-reference-folder-open="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</button>`)
  ].join("");
}

let referencePollTimer = 0;
let referencePolling = false;

async function loadReferences({ append = false } = {}) {
  const projectId = state.activeProjectId || "";
  if (!projectId) return;
  state.referenceLoading = true;
  const offset = append ? (state.referenceDocuments || []).length : 0;
  const query = new URLSearchParams({
    projectId,
    folderId: state.referenceFolderId || "",
    status: state.referenceStatus || "",
    search: state.referenceSearch || "",
    offset: String(offset),
    limit: "100"
  });
  if (state.referenceSearch) query.set("recursive", "1");
  const [foldersPayload, payload] = await Promise.all([
    // 服务端还没重启时旧进程没有目录接口：仍按根目录平铺展示，避免整页打不开。
    api(`/api/reference-folders?projectId=${encodeURIComponent(projectId)}`, {}, { logFailure: false }).catch(() => ({ items: [] })),
    api(`/api/references?${query}`)
  ]);
  state.referenceFolders = foldersPayload.items || [];
  if (state.referenceFolderId && !referenceFolderById(state.referenceFolderId)) state.referenceFolderId = "";
  state.referenceLibraries = payload.libraries || [];
  state.referenceDocuments = append ? [...(state.referenceDocuments || []), ...(payload.items || [])] : (payload.items || []);
  state.referenceTotal = Number(payload.total) || 0;
  state.referenceOffset = state.referenceDocuments.length;
  const visibleDocuments = new Set(state.referenceDocuments.map((item) => item.id));
  const visibleFolders = new Set((state.referenceFolders || []).map((folder) => folder.id));
  state.referenceSelection.documents = new Set([...state.referenceSelection.documents].filter((id) => visibleDocuments.has(id)));
  state.referenceSelection.folders = new Set([...state.referenceSelection.folders].filter((id) => visibleFolders.has(id)));
  $("#referenceCount").textContent = `已显示 ${state.referenceDocuments.length} / 共 ${state.referenceTotal} 条`;
  $("#referenceLoadMore").hidden = state.referenceDocuments.length >= state.referenceTotal;
  renderReferenceVisionToggle();
  renderReferenceTree();
  renderReferenceBreadcrumb();
  renderReferenceList();
  scheduleReferencePolling();
  state.referenceLoading = false;
}

function scheduleReferencePolling() {
  const hasIndexing = (state.referenceDocuments || []).some((item) => item.status === "indexing");
  if (!hasIndexing || referencePollTimer) return;
  referencePollTimer = window.setTimeout(async () => {
    referencePollTimer = 0;
    if (referencePolling || state.view !== "references" || document.hidden) return;
    referencePolling = true;
    try { await loadReferences(); }
    catch { /* 后台轮询失败不打断页面 */ }
    finally { referencePolling = false; }
  }, 2200);
}

function referenceStatusMarkup(item) {
  const statusLabel = { indexing: "索引中", ready: "可用", failed: "失败", disabled: "已停用" }[item.status] || item.status;
  if (item.status === "indexing" && item.ingestReport?.stage === "planning") return "预扫中";
  return statusLabel;
}

function renderReferenceList() {
  const container = $("#referenceList");
  if (!container) return;
  const folders = referenceChildFolders(state.referenceFolderId || "");
  const items = state.referenceDocuments || [];
  const folderRows = folders.map((folder) => `<article class="reference-folder-row" data-reference-folder-id="${escapeHtml(folder.id)}" draggable="true">
    <label class="reference-select"><input type="checkbox" data-reference-folder-select="${escapeHtml(folder.id)}" ${state.referenceSelection.folders.has(folder.id) ? "checked" : ""} aria-label="选择文件夹 ${escapeHtml(folder.name)}" /></label>
    <span class="reference-folder-icon" aria-hidden="true">▣</span>
    <div class="reference-main"><strong>${escapeHtml(folder.name)}</strong><small>${Number(folder.documentCount) || 0} 份资料 · 双击打开</small></div>
    <div class="reference-folder-actions">
      <button class="button ghost small" type="button" data-reference-folder-action="new" data-id="${escapeHtml(folder.id)}">新建子文件夹</button>
      <button class="button ghost small" type="button" data-reference-folder-action="rename" data-id="${escapeHtml(folder.id)}">重命名</button>
      <button class="button ghost small danger" type="button" data-reference-folder-action="delete" data-id="${escapeHtml(folder.id)}">删除</button>
    </div>
  </article>`).join("");
  const documentRows = items.map((item) => {
    const statusText = referenceStatusMarkup(item);
    const scope = [item.contentType ? `语体 ${escapeHtml(contentTypeLabel(item.contentType))}` : "", item.domain ? `领域 ${escapeHtml(item.domain)}` : ""].filter(Boolean).join(" · ") || "全项目通用";
    const visionCount = Number(item.ingestReport?.visionPages || 0) + Number(item.ingestReport?.visionImages || 0);
    const path = referenceFolderPath(item.folderId);
    const checked = state.referenceSelection.documents.has(item.id);
    return `<article class="reference-row ${checked ? "is-selected" : ""}" data-reference-id="${escapeHtml(item.id)}" draggable="true">
      <label class="reference-select"><input type="checkbox" data-reference-select="${escapeHtml(item.id)}" ${checked ? "checked" : ""} aria-label="选择 ${escapeHtml(item.name)}" /></label>
      <div class="reference-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sourceFile || "")} ${item.sourceFormat ? `· ${escapeHtml(item.sourceFormat)}` : ""} · ${scope} · ${escapeHtml(path)}</small>
        ${item.ingestReport?.description ? `<p class="reference-description">${escapeHtml(item.ingestReport.description)}</p>` : '<p class="reference-description is-empty">还没有描述：可勾选后批量 AI 扫描，翻译时模型就能按说明决定要不要读它。</p>'}
        ${item.error ? `<small class="reference-error">${escapeHtml(item.error)}</small>` : ""}</div>
      <div class="reference-metrics"><span class="badge ${item.status === "ready" ? "success" : item.status === "failed" ? "error" : "warning"}">${escapeHtml(statusText)}</span><small>${item.characters} 字 · ${item.chunkCount} 片段${visionCount ? ` · ${visionCount} 张图识图` : ""}${item.ingestReport?.bytes ? ` · ${(item.ingestReport.bytes / 1024 / 1024).toFixed(1)}MB` : ""}</small></div>
      <div class="task-actions">
        <button class="button secondary small" data-reference-action="detail" data-id="${escapeHtml(item.id)}">查看片段</button>
        <button class="button ghost small" data-reference-action="describe" data-id="${escapeHtml(item.id)}" title="让 AI 读一遍这份资料，写一两句说明">${item.ingestReport?.description ? "重新扫描" : "让 AI 扫描"}</button>
        ${item.ingestReport?.sourcePath ? `<button class="button ghost small" data-reference-action="reingest" data-id="${escapeHtml(item.id)}" title="按当前识图开关重新解析这份资料">重新导入</button>` : ""}
        <button class="button ghost small" data-reference-action="reindex" data-id="${escapeHtml(item.id)}">重新索引</button>
        <button class="button ghost small" data-reference-action="toggle" data-id="${escapeHtml(item.id)}" data-status="${item.status === "disabled" ? "ready" : "disabled"}">${item.status === "disabled" ? "启用" : "停用"}</button>
        <button class="button ghost small danger" data-reference-action="delete" data-id="${escapeHtml(item.id)}">删除</button>
      </div>
    </article>`;
  }).join("");
  container.innerHTML = folderRows || documentRows
    ? `${folderRows}${documentRows}`
    : '<div class="empty-list">这个目录还没有参考资料。可以把文件或整个文件夹拖进来，也可以点右上角「新建文件夹」开始整理。</div>';
  renderReferenceSelectionBar();
}

function renderReferenceSelectionBar() {
  const bar = $("#referenceSelectionBar");
  if (!bar) return;
  const count = state.referenceSelection.documents.size + state.referenceSelection.folders.size;
  $("#referenceSelectionText").textContent = `已选 ${count} 项`;
  $("#referenceClearSelection").disabled = count === 0;
  $("#referenceBatchDescribe").disabled = count === 0;
}

/**
 * 与服务端 MAX_REFERENCE_FILE_BYTES 同值：前端先拦一遍。
 * 上传走原始字节直传（File 当 body），浏览器不会再把它读进内存拼 base64。
 */
const REFERENCE_MAX_FILE_BYTES = 200 * 1024 * 1024;
const REFERENCE_ACCEPTED_EXTENSION = /\.(?:txt|md|docx|xlsx|csv|pdf|pptx|png|jpe?g|gif|webp|bmp)$/iu;

function setReferenceVisionMode(mode, { persist = true } = {}) {
  state.referenceVisionMode = mode === "none" ? "none" : "all";
  if (persist) {
    try { localStorage.setItem("kami-reference-vision-mode", state.referenceVisionMode); } catch { /* 隐私模式下只保留本次选择 */ }
  }
  renderReferenceVisionToggle();
}

function setReferenceAutoScan(enabled, { persist = true } = {}) {
  state.referenceAutoScan = enabled !== false;
  $("#referenceAutoScan").checked = state.referenceAutoScan;
  if (persist) {
    try { localStorage.setItem("kami-reference-auto-scan", state.referenceAutoScan ? "1" : "0"); } catch { /* 隐私模式下只保留本次选择 */ }
  }
}

function loadReferencePreferences() {
  try {
    const saved = localStorage.getItem("kami-reference-vision-mode");
    if (saved === "none" || saved === "all") setReferenceVisionMode(saved, { persist: false });
    else setReferenceVisionMode("all", { persist: false });
    setReferenceAutoScan(localStorage.getItem("kami-reference-auto-scan") !== "0", { persist: false });
  } catch {
    setReferenceVisionMode("all", { persist: false });
    setReferenceAutoScan(true, { persist: false });
  }
}

async function readAllReferenceDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

async function collectReferenceEntry(entry, parentPath, output) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    output.push({ file, path: [...parentPath] });
    return;
  }
  if (!entry.isDirectory) return;
  const path = [...parentPath, entry.name || "新建文件夹"];
  for (const child of await readAllReferenceDirectoryEntries(entry.createReader())) {
    await collectReferenceEntry(child, path, output);
  }
}

async function collectReferenceDropItems(dataTransfer) {
  const entries = [...(dataTransfer?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return [...(dataTransfer?.files || [])].map((file) => ({ file, path: [] }));
  const output = [];
  for (const entry of entries) await collectReferenceEntry(entry, [], output);
  return output;
}

function referenceItemsFromInput(files, { relative = false } = {}) {
  return [...(files || [])].map((file) => {
    const parts = relative ? String(file.webkitRelativePath || file.name).split("/") : [file.name];
    return { file, path: parts.slice(0, -1).filter(Boolean) };
  });
}

async function ensureReferenceUploadFolders(projectId, parentId, paths) {
  const unique = new Map();
  for (const path of paths) {
    if (!path.length) continue;
    unique.set(JSON.stringify(path), path);
  }
  if (!unique.size) return new Map();
  const payload = await api("/api/reference-folders/ensure", {
    method: "POST",
    body: JSON.stringify({ projectId, parentId, paths: [...unique.values()] })
  });
  return new Map((payload.items || []).map((item) => [JSON.stringify(item.path), item.folderId]));
}

async function uploadReferenceFiles(files) {
  return await uploadReferenceItems(referenceItemsFromInput(files), state.referenceFolderId || "");
}

async function uploadReferenceItems(items, destinationFolderId = state.referenceFolderId || "") {
  const projectId = state.activeProjectId || "";
  if (!projectId) return toast("请先选择项目");
  const accepted = [];
  const rejected = [];
  for (const item of items || []) {
    if (!REFERENCE_ACCEPTED_EXTENSION.test(item.file?.name || "")) {
      rejected.push(`${item.file?.name || "未知文件"}：格式不支持`);
      continue;
    }
    if (Number(item.file?.size) > REFERENCE_MAX_FILE_BYTES) {
      rejected.push(`${item.file.name}：超过 200MB`);
      continue;
    }
    accepted.push(item);
  }
  if (!accepted.length) {
    $("#referenceUploadNote").textContent = rejected.length ? `没有文件被接受：${rejected.slice(0, 3).join("；")}${rejected.length > 3 ? "…" : ""}` : "没有可上传的文件";
    if (rejected.length) toast(rejected[0]);
    return;
  }
  $("#referenceUploadNote").textContent = `正在准备 ${accepted.length} 个文件的上传目录……`;
  let folderIds = new Map();
  try {
    folderIds = await ensureReferenceUploadFolders(projectId, destinationFolderId, accepted.map((item) => item.path));
  } catch (error) {
    $("#referenceUploadNote").textContent = `创建上传目录失败：${error.message}`;
    toast(error.message);
    return;
  }
  const tasks = [];
  const failures = [...rejected];
  // 同一次批量上传共用一个组号：任务中心把它们折叠成"这一次的导入"，下次上传另起一组。
  const uploadGroupId = globalThis.crypto?.randomUUID?.() || `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let index = 0; index < accepted.length; index += 1) {
    const item = accepted[index];
    const file = item.file;
    $("#referenceUploadNote").textContent = `正在上传 ${index + 1} / ${accepted.length}：${file.name}`;
    try {
      const targetFolderId = folderIds.get(JSON.stringify(item.path)) || destinationFolderId;
      const query = new URLSearchParams({
        projectId,
        folderId: targetFolderId || "",
        filename: file.name,
        name: file.name.replace(/\.[^.]+$/u, ""),
        vision: state.referenceVisionMode,
        autoScan: state.referenceAutoScan ? "1" : "0",
        uploadGroupId
      });
      const started = await api(`/api/references/file?${query}`, {
        method: "POST",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream" }
      });
      if (started.taskId) tasks.push(started.taskId);
    } catch (error) {
      failures.push(`${file.name}：${error.message}`);
    }
  }
  const visionText = state.referenceVisionMode === "none" ? "仅读取文字层" : "读取文字与图片";
  const autoScanText = state.referenceAutoScan ? "，导入完成后会自动生成资料说明" : "";
  $("#referenceUploadNote").textContent = tasks.length
    ? `已提交 ${tasks.length} 个文件，${visionText}${autoScanText}；任务完成后这里会自动刷新。${failures.length ? `另有 ${failures.length} 个未上传。` : ""}`
    : `没有文件上传成功。${failures.slice(0, 3).join("；")}`;
  if (failures.length) toast(failures[0]);
  await loadReferences();
  if (tasks.length) watchReferenceIngestTasks(tasks).catch(() => {});
}

async function watchReferenceIngestTasks(taskIds) {
  const pending = new Set(taskIds);
  const total = pending.size;
  while (pending.size) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    for (const id of [...pending]) {
      const response = await api(`/api/background-tasks/${encodeURIComponent(id)}`, {}, { logFailure: false })
        .catch(() => null);
      const task = response?.task || response;
      if (!task) {
        pending.delete(id);
        continue;
      }
      if (task.progress?.message) {
        $("#referenceUploadNote").textContent = `${task.progress.message}${pending.size > 1 ? ` · 还有 ${pending.size} 个任务` : ""}`;
      }
      if (["completed", "failed", "needs_attention"].includes(task.status)) pending.delete(id);
    }
  }
  await loadReferences().catch(() => {});
  toast(total > 1 ? `${total} 个参考资料导入任务已结束` : "参考资料导入任务已结束");
}

function toggleReferenceSelection(kind, id, selected) {
  const bucket = kind === "folder" ? state.referenceSelection.folders : state.referenceSelection.documents;
  if (selected) bucket.add(id);
  else bucket.delete(id);
  renderReferenceList();
}

function clearReferenceSelection() {
  state.referenceSelection.documents = new Set();
  state.referenceSelection.folders = new Set();
  renderReferenceList();
}

async function selectAllReferenceDocuments() {
  const projectId = state.activeProjectId || "";
  if (!projectId) return;
  const query = new URLSearchParams({
    projectId,
    folderId: state.referenceFolderId || "",
    status: state.referenceStatus || "",
    search: state.referenceSearch || "",
    limit: "0"
  });
  if (state.referenceSearch) query.set("recursive", "1");
  const payload = await api(`/api/references?${query}`);
  state.referenceSelection.documents = new Set((payload.items || []).map((item) => item.id));
  state.referenceSelection.folders = new Set(referenceChildFolders(state.referenceFolderId || "").map((folder) => folder.id));
  renderReferenceList();
}

async function batchDescribeReferenceSelection() {
  const documentIds = [...state.referenceSelection.documents];
  const folderIds = [...state.referenceSelection.folders];
  if (!documentIds.length && !folderIds.length) return toast("请先勾选要扫描的资料或文件夹");
  const started = await api("/api/references/describe-batch", {
    method: "POST",
    body: JSON.stringify({ projectId: state.activeProjectId || "", documentIds, folderIds })
  });
  $("#referenceUploadNote").textContent = `已提交 ${started.total} 份资料做 AI 扫描，已有描述已跳过 ${started.skipped || 0} 份。`;
  toast(`已开始批量 AI 扫描（${started.total} 份）`);
  watchReferenceTask(started.taskId, { refresh: true }).catch(() => {});
}

async function watchReferenceTask(taskId, { refresh = false } = {}) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const response = await api(`/api/background-tasks/${encodeURIComponent(taskId)}`, {}, { logFailure: false })
      .catch(() => null);
    const task = response?.task || response;
    if (!task) break;
    if (task.progress?.message) $("#referenceUploadNote").textContent = task.progress.message;
    if (["completed", "failed", "needs_attention"].includes(task.status)) {
      toast(task.status === "completed" ? "批量 AI 扫描完成" : `资料任务结束：${task.progress?.message || task.status}`);
      break;
    }
  }
  if (refresh) await loadReferences().catch(() => {});
}

function openReferenceFolderDialog({ mode = "create", folderId = "", parentId = "" } = {}) {
  const folder = folderId ? referenceFolderById(folderId) : null;
  state.referenceContextTarget = { kind: "folder-dialog", mode, folderId, parentId };
  $("#referenceFolderDialogTitle").textContent = mode === "rename" ? "重命名文件夹" : mode === "create" ? "新建文件夹" : "新建子文件夹";
  $("#referenceFolderName").value = folder?.name || "";
  $("#referenceFolderHint").textContent = mode === "rename"
    ? "名称会立即更新，资料位置不变。"
    : `将创建在：${folderId ? referenceFolderPath(folderId) : parentId ? referenceFolderPath(parentId) : referenceFolderPath(state.referenceFolderId)}`;
  const dialog = $("#referenceFolderDialog");
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => $("#referenceFolderName").focus(), 0);
}

async function submitReferenceFolderForm(event) {
  event.preventDefault();
  const target = state.referenceContextTarget || {};
  const name = $("#referenceFolderName").value.trim();
  if (!name) return;
  try {
    if (target.mode === "rename" && target.folderId) {
      await api(`/api/reference-folders/${encodeURIComponent(target.folderId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name })
      });
      toast("文件夹已重命名");
    } else {
      const created = await api("/api/reference-folders", {
        method: "POST",
        body: JSON.stringify({
          projectId: state.activeProjectId || "",
          parentId: target.parentId || state.referenceFolderId || "",
          name
        })
      });
      if (created.folder?.parentId) state.referenceExpanded.add(created.folder.parentId);
      toast("文件夹已创建");
    }
    $("#referenceFolderDialog").close();
    state.referenceContextTarget = null;
    await loadReferences();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteReferenceFolderById(id) {
  const folder = referenceFolderById(id);
  if (!folder) return;
  const count = Number(folder.documentCount) || 0;
  const descendants = referenceFolderDescendantIds(id).length;
  if (!confirm(`确认删除「${folder.name}」？\n\n会连同 ${descendants} 个子文件夹和 ${count} 份直属资料一起删除，且不能恢复。`)) return;
  try {
    const started = await api(`/api/reference-folders/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("目录删除已进入后台任务");
    watchReferenceTask(started.taskId, { refresh: true }).catch(() => {});
    if (state.referenceFolderId === id) state.referenceFolderId = folder.parentId || "";
    await loadReferences();
  } catch (error) {
    toast(error.message);
  }
}

function referenceTargetPayload(target) {
  if (!target) return null;
  if (target.kind === "folder") {
    const ids = state.referenceSelection.folders.has(target.id) ? [...state.referenceSelection.folders] : [target.id];
    return { kind: "folder", ids };
  }
  if (target.kind === "document") {
    const ids = state.referenceSelection.documents.has(target.id) ? [...state.referenceSelection.documents] : [target.id];
    return { kind: "documents", ids };
  }
  return null;
}

async function moveReferencePayload(payload, targetFolderId = "") {
  if (!payload) return;
  try {
    if (payload.kind === "folder") {
      for (const id of payload.ids) {
        await api(`/api/reference-folders/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ parentId: targetFolderId })
        });
      }
    } else {
      for (const id of payload.ids) {
        await api(`/api/references/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ folderId: targetFolderId })
        });
      }
    }
    state.referenceSelection.documents = new Set();
    state.referenceSelection.folders = new Set();
    toast(`已移动 ${payload.ids.length} 项`);
    await loadReferences();
  } catch (error) {
    toast(error.message);
  }
}

function openReferenceMoveDialog(payload) {
  if (!payload) return;
  state.referenceContextTarget = { kind: "move", payload };
  const excluded = payload.kind === "folder"
    ? new Set([payload.ids[0], ...referenceFolderDescendantIds(payload.ids[0])])
    : new Set();
  const options = [{ id: "", name: "项目根目录", depth: 0 }];
  const append = (parentId, depth) => {
    for (const folder of referenceChildFolders(parentId)) {
      if (!excluded.has(folder.id)) options.push({ id: folder.id, name: folder.name, depth });
      append(folder.id, depth + 1);
    }
  };
  append("", 1);
  $("#referenceMoveTarget").innerHTML = options.map((item) => `<option value="${escapeHtml(item.id)}">${"　".repeat(item.depth)}${escapeHtml(item.name)}</option>`).join("");
  $("#referenceMoveTarget").value = payload.kind === "documents" ? state.referenceFolderId || "" : "";
  const dialog = $("#referenceMoveDialog");
  if (!dialog.open) dialog.showModal();
}

async function submitReferenceMoveForm(event) {
  event.preventDefault();
  const target = state.referenceContextTarget || {};
  const payload = target.payload;
  const folderId = $("#referenceMoveTarget").value;
  $("#referenceMoveDialog").close();
  state.referenceContextTarget = null;
  await moveReferencePayload(payload, folderId);
}

function closeReferenceContextMenu() {
  const menu = $("#referenceContextMenu");
  if (menu) menu.hidden = true;
}

function openReferenceContextMenu(event, target) {
  event.preventDefault();
  event.stopPropagation();
  const menu = $("#referenceContextMenu");
  if (!menu) return;
  const document = target.kind === "document" ? (state.referenceDocuments || []).find((item) => item.id === target.id) : null;
  const items = target.kind === "folder"
    ? (!target.id ? [
      { action: "new", label: "新建文件夹" }
    ] : [
      { action: "open", label: "打开" },
      { action: "new", label: "新建子文件夹" },
      { action: "rename", label: "重命名" },
      { action: "move", label: "移动到…" },
      { action: "delete", label: "删除文件夹", danger: true }
    ])
    : [
      { action: "detail", label: "查看片段" },
      { action: "describe", label: document?.ingestReport?.description ? "重新 AI 扫描" : "AI 扫描" },
      { action: "move", label: "移动到…" },
      { action: "delete", label: "删除资料", danger: true }
    ];
  state.referenceContextTarget = target;
  menu.innerHTML = items.map((item) => `<button type="button" data-reference-menu-action="${item.action}" class="${item.danger ? "danger" : ""}">${item.label}</button>`).join("");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 12)}px`;
  menu.hidden = false;
}

async function handleReferenceMenuAction(action) {
  const target = state.referenceContextTarget;
  closeReferenceContextMenu();
  if (!target) return;
  if (target.kind === "folder") {
    if (action === "open") {
      state.referenceFolderId = target.id;
      state.referenceSearch = "";
      $("#referenceSearch").value = "";
      clearReferenceSelection();
      await loadReferences();
    } else if (action === "new") openReferenceFolderDialog({ mode: "create", parentId: target.id });
    else if (action === "rename") openReferenceFolderDialog({ mode: "rename", folderId: target.id });
    else if (action === "move") openReferenceMoveDialog(referenceTargetPayload(target));
    else if (action === "delete") await deleteReferenceFolderById(target.id);
    return;
  }
  if (target.kind === "document") {
    if (action === "move") openReferenceMoveDialog(referenceTargetPayload(target));
    else await referenceAction(action, target.id);
  }
}

function referenceDragPayloadFromEvent(event) {
  const listRow = event.target.closest?.("#referenceList .reference-row");
  if (listRow?.dataset.referenceId) {
    const id = listRow.dataset.referenceId;
    return referenceTargetPayload({ kind: "document", id });
  }
  const folderRow = event.target.closest?.("[data-reference-folder-id]");
  if (folderRow?.dataset.referenceFolderId) {
    return referenceTargetPayload({ kind: "folder", id: folderRow.dataset.referenceFolderId });
  }
  return null;
}

function handleReferenceDragStart(event) {
  if (!event.target.closest?.("[data-reference-id], [data-reference-folder-id]")) return;
  const payload = referenceDragPayloadFromEvent(event);
  if (!payload) return;
  state.referenceDragPayload = payload;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-kami-reference", JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", payload.kind === "folder" ? "移动文件夹" : `移动 ${payload.ids.length} 份资料`);
}

function referenceDropFolderIdFromEvent(event) {
  const folder = event.target.closest?.("[data-reference-folder-id], [data-reference-folder-open]");
  if (!folder) return state.referenceFolderId || "";
  return String(folder.dataset.referenceFolderId ?? folder.dataset.referenceFolderOpen ?? "");
}

let referenceDragDepth = 0;
let referenceDropSafetyTimer = 0;

function scheduleReferenceDropSafetyReset() {
  if (referenceDropSafetyTimer) window.clearTimeout(referenceDropSafetyTimer);
  referenceDropSafetyTimer = window.setTimeout(() => hideReferenceDropOverlay(), 2_500);
}

function hideReferenceDropOverlay() {
  if (referenceDropSafetyTimer) window.clearTimeout(referenceDropSafetyTimer);
  referenceDropSafetyTimer = 0;
  referenceDragDepth = 0;
  $("#referenceDropOverlay").hidden = true;
  $("#referenceDropZone")?.classList.remove("dragging");
  $$(".reference-drop-target").forEach((element) => element.classList.remove("reference-drop-target"));
}

function showReferenceDropOverlay({ folderId = state.referenceFolderId || "", kind = "upload" } = {}) {
  const overlay = $("#referenceDropOverlay");
  if (!overlay) return;
  const path = referenceFolderPath(folderId);
  const targetName = referenceFolderById(folderId)?.name || path;
  $("#referenceDropOverlayTitle").textContent = kind === "move"
    ? `移动到「${targetName}」`
    : folderId ? `导入到「${targetName}」` : "文件拖入这里导入";
  $("#referenceDropOverlayTarget").textContent = kind === "move" ? `目标：${path}` : `将导入到：${path}`;
  overlay.hidden = false;
  $("#referenceDropZone")?.classList.add("dragging");
}

function referenceDropKind(dataTransfer) {
  return [...(dataTransfer?.types || [])].includes("Files") ? "upload" : "move";
}

function handleReferenceDragEnter(event) {
  event.preventDefault();
  referenceDragDepth += 1;
  const kind = referenceDropKind(event.dataTransfer);
  showReferenceDropOverlay({ folderId: referenceDropFolderIdFromEvent(event), kind });
  event.dataTransfer.dropEffect = kind === "upload" ? "copy" : "move";
  scheduleReferenceDropSafetyReset();
}

function handleReferenceDragOver(event) {
  event.preventDefault();
  const kind = referenceDropKind(event.dataTransfer);
  const target = event.target.closest?.("[data-reference-folder-id], [data-reference-folder-open]");
  $$(".reference-drop-target").forEach((element) => element.classList.remove("reference-drop-target"));
  target?.classList.add("reference-drop-target");
  showReferenceDropOverlay({ folderId: referenceDropFolderIdFromEvent(event), kind });
  event.dataTransfer.dropEffect = kind === "upload" ? "copy" : "move";
  scheduleReferenceDropSafetyReset();
}

function handleReferenceDragLeave(event) {
  if (event.relatedTarget && $("#referenceDropZone")?.contains(event.relatedTarget)) return;
  referenceDragDepth -= 1;
  if (referenceDragDepth <= 0) hideReferenceDropOverlay();
}

async function handleReferenceDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  const targetFolderId = referenceDropFolderIdFromEvent(event);
  const hasFiles = referenceDropKind(event.dataTransfer) === "upload";
  hideReferenceDropOverlay();
  if (hasFiles) {
    const items = await collectReferenceDropItems(event.dataTransfer).catch((error) => {
      toast(error.message);
      return [];
    });
    if (items.length) await uploadReferenceItems(items, targetFolderId);
    return;
  }
  let payload = state.referenceDragPayload;
  try {
    payload ||= JSON.parse(event.dataTransfer.getData("application/x-kami-reference") || "null");
  } catch { /* 非站内拖动 */ }
  state.referenceDragPayload = null;
  if (payload) await moveReferencePayload(payload, targetFolderId);
}

async function openReferenceDetail(id) {
  const payload = await api(`/api/references/${encodeURIComponent(id)}/chunks?limit=50`);
  state.referenceDetail = payload;
  const panel = $("#referenceDetailPanel");
  panel.hidden = false;
  $("#referenceDetailTitle").textContent = payload.document?.name || "资料详情";
  const report = payload.document?.ingestReport || {};
  $("#referenceDetailMeta").textContent = [
    `${payload.document?.sourceFile || ""}${payload.document?.sourceFormat ? `（${payload.document.sourceFormat}）` : ""}`,
    `共 ${payload.total} 个片段`,
    report.bytes ? `原文件 ${(report.bytes / 1024 / 1024).toFixed(1)}MB` : "",
    report.plan?.pages ? `预扫 ${report.plan.pages} 页 / ${report.plan.images} 张图` : "",
    report.visionPages ? `其中 ${report.visionPages} 页由模型识图` : "",
    report.visionImages ? `${report.visionImages} 张内嵌图片已识图` : "",
    report.visionSkippedByUser ? `${report.visionSkippedByUser} 张图按「只读文字」跳过` : "",
    report.skippedImages ? `${report.skippedImages} 张图太小或不是位图，未识图` : "",
    report.riskChunks ? `${report.riskChunks} 个片段被判定含注入特征，默认不参与检索` : ""
  ].filter(Boolean).join(" · ");
  $("#referenceDetailActions").innerHTML = `<button class="button ghost small" data-reference-action="reindex" data-id="${escapeHtml(id)}">重新索引</button>`;
  $("#referenceChunks").innerHTML = (payload.items || []).map((chunk) => `<article class="reference-chunk ${chunk.risk ? "risk" : ""}">
    <div class="reference-chunk-head"><strong>${escapeHtml(chunk.heading || `片段 ${chunk.ordinal + 1}`)}</strong>
      <small>${chunk.page ? `位置 ${escapeHtml(chunk.page)} · ` : ""}${chunk.origin === "vision" ? "模型识图" : "原文抽取"} · ${chunk.characters} 字${chunk.id ? ` · ${escapeHtml(chunk.id)}` : ""}</small>
      ${chunk.risk ? `<span class="badge warning">疑似注入${chunk.allowed ? "（已放行）" : ""}</span><button class="button ghost small" data-reference-action="allow" data-id="${escapeHtml(chunk.id)}" data-allowed="${chunk.allowed ? "false" : "true"}">${chunk.allowed ? "取消放行" : "放行"}</button>` : ""}</div>
    <p>${escapeHtml(chunk.text)}</p>
  </article>`).join("") || '<div class="empty-list">这份资料还没有片段。</div>';
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function referenceAction(action, id, button) {
  try {
    if (action === "detail") return await openReferenceDetail(id);
    if (action === "reingest") {
      const document = (state.referenceDocuments || []).find((item) => item.id === id);
      if (!confirm(`按当前「${referenceVisionModeLabel()}」重新导入「${document?.name || "这份资料"}」？`)) return;
      const started = await api(`/api/references/${encodeURIComponent(id)}/ingest`, {
        method: "POST",
        body: JSON.stringify({ vision: state.referenceVisionMode !== "none", autoScan: state.referenceAutoScan })
      });
      toast(`已开始重新导入：${referenceVisionModeLabel()}`);
      watchReferenceTask(started.taskId, { refresh: true }).catch(() => {});
      return;
    }
    if (action === "describe") {
      // 让模型读一遍正文，写一两句"这份资料是干嘛的"，翻译时据此决定要不要读全文。
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "扫描中…";
      try {
        const result = await api(`/api/references/${encodeURIComponent(id)}/describe`, { method: "POST" });
        toast(`资料描述已更新：${result.description}`);
      } catch (error) {
        button.disabled = false;
        button.textContent = original;
        throw error;
      }
      await loadReferences();
      return;
    }
    if (action === "reindex") {
      button.disabled = true;
      button.textContent = "重建中…";
      await api(`/api/references/${encodeURIComponent(id)}/reindex`, { method: "POST" });
      toast("已重新生成向量索引");
    } else if (action === "toggle") {
      await api(`/api/references/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ status: button.dataset.status }) });
      toast(button.dataset.status === "disabled" ? "已停用，不再参与检索" : "已启用");
    } else if (action === "allow") {
      await api(`/api/reference-chunks/${encodeURIComponent(id)}/allow`, { method: "POST", body: JSON.stringify({ allowed: button.dataset.allowed === "true" }) });
      toast(button.dataset.allowed === "true" ? "已放行该片段" : "已取消放行");
    } else if (action === "delete") {
      if (!confirm("确认删除这份参考资料？它的全部片段会一并删除，模型将再也查不到。")) return;
      await api(`/api/references/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("已删除参考资料");
      $("#referenceDetailPanel").hidden = true;
    }
    await loadReferences();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderBatchTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const progress = task.totalSegments ? Math.round(task.completedSegments / task.totalSegments * 100) : 0;
  // 中断过的批次：run_state 只能是库里允许的取值，所以中断用 runnerOptions.cancelled 标记，
  // 这里据此显示"已中断"并给出「继续翻译」。
  const cancelled = task.runnerOptions?.cancelled === true;
  const runningState = ["queued", "running"].includes(task.runState);
  const hasPending = Number(task.completedSegments) < Number(task.totalSegments);
  const canResume = hasPending && !runningState;
  const canImportReview = Number(task.completedSegments) > 0;
  const workflow = task.workflow || buildBatchWorkflow(task);
  const qaIncomplete = workflow.summary.qaIncomplete || Number(task.qaIncomplete) || 0;
  const ended = ["completed", "needs_attention"].includes(task.runState);
  const endedLabel = task.failedSegments ? `本轮已结束 · ${task.failedSegments} 段失败` : hasPending ? `本轮已结束 · ${Number(task.totalSegments) - Number(task.completedSegments)} 段未完成` : qaIncomplete ? `翻译完成 · AIQA 未完成 ${qaIncomplete} 段` : task.qaPending ? "翻译完成 · QA 待处理" : "翻译完成";
  const reportPending = batchQualityReportPending(task, workflow);
  const rowStatus = cancelled ? "已中断" : reportPending ? `生成质量报告${task.failedSegments ? ` · ${task.failedSegments} 段失败` : ""}` : ended ? endedLabel : taskStatusLabel(task.status);
  const rowStatusClass = reportPending ? "in_progress" : task.status;
  const qaRunning = ["waiting", "in_progress"].includes(workflow.aiQa.status) || workflow.qaRetryBusy;
  const tierText = describeQualityTiers(task.qualityTiers);
  return `<article class="task-row task-card task-batch-card" data-task-id="${escapeHtml(task.batchId)}" data-task-status="${escapeHtml(task.status || "")}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.filename)}</strong><span class="task-status ${escapeHtml(rowStatusClass)}">${escapeHtml(rowStatus)}</span><span class="task-type-chip">批次</span></div><small>${escapeHtml(locale?.label || task.locale)} · ${escapeHtml(contentTypeLabel(task.contentType))} · ${escapeHtml(task.domain)} · ${formatTaskTime(task.updatedAt)}</small>${tierText ? `<small class="task-tiers" title="质量档按每段的风险自动判定；未记录的段落来自旧版本翻译">质量档：${escapeHtml(tierText)}</small>` : ""}</div>
    <div class="task-progress"><div><i style="width:${progress}%"></i></div><span>${task.completedSegments} / ${task.totalSegments}</span></div>
    <div class="task-qa">${task.qaPending
      ? `<button class="qa-jump" type="button" data-action="jump-qa" title="打开这条批次并跳到第一条待处理"><strong>${task.qaPending} 条待处理</strong><small>点击定位 →</small></button>`
      : "<strong>QA 已清</strong>"}${qaIncomplete ? `<small>AIQA 未完成 ${qaIncomplete} 段</small>` : ""}${task.failedSegments ? `<small>${task.failedSegments} 段失败</small>` : `<small>${task.format || "text"}</small>`}</div>
    <div class="task-actions"><button class="button secondary small" data-action="open-task">打开文件</button>${canResume ? `<button class="button primary small" data-action="continue-task">${ended && task.failedSegments ? "重试失败句段" : "继续翻译"}</button>` : ""}${qaIncomplete || qaRunning ? `<button class="button secondary small" data-action="retry-qa-task" ${runningState || qaRunning ? "disabled" : ""}>${qaRunning ? "AIQA 重试中…" : `重试未完成 AIQA（${qaIncomplete}）`}</button>` : ""}${runningState ? '<button class="button secondary small" data-action="pause-task">暂停</button>' : ""}${runningState ? '<button class="button ghost small" data-action="cancel-task">中断</button>' : ""}<button class="button secondary small" data-action="export-task"${reportPending ? ' disabled title="质量报告还在生成（含 AI 终审），完成后才能导出"' : ""}>导出</button>${canImportReview ? '<button class="button ghost small" data-action="import-review">导入审校结果</button>' : ""}<button class="button ghost small danger" data-action="delete-task">删除</button></div>
    <div class="task-workflow"><div class="batch-workflow-stages">${batchWorkflowCards(workflow)}</div>${workflow.qualityReport.status === "needs_attention" ? '<button class="button ghost small" data-action="retry-report-task">重试质量报告</button>' : ""}${workflow.termSurvey.status === "needs_attention" ? '<button class="button ghost small" data-action="retry-survey-task">重试术语普查</button>' : ""}</div>
  </article>`;
}

function renderQaTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const scoreTone = task.overallScore == null ? "neutral" : task.overallScore >= 90 ? "success" : task.overallScore >= 70 ? "warning" : "error";
  return `<article class="task-row task-card" data-task-id="${escapeHtml(task.id)}" data-task-status="${escapeHtml(task.status || "")}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.title)}</strong><span class="badge ${scoreTone}">${task.overallScore == null ? "未评分" : `${task.overallScore} 分`}</span><span class="task-type-chip">Auto QA</span></div><small>${escapeHtml(locale?.label || task.locale)} · ${escapeHtml(contentTypeLabel(task.contentType))} · ${escapeHtml(task.domain)} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:100%"></i></div><span>${task.totalSegments} 句原文</span></div>
    <div class="task-qa"><strong>${task.qaPending ? `${task.qaPending} 个问题` : "未发现问题"}</strong><small>${escapeHtml(task.status === "review" ? "需要复核" : "已通过")}</small></div>
    <div class="task-actions"><button class="button secondary small" data-action="open-qa-task">查看报告</button><button class="button ghost small danger" data-action="delete-qa-task">删除</button></div>
  </article>`;
}

/** 与 server 的 issueFingerprint 保持一致：字段顺序、空白折叠、截断长度都不能变。 */
async function autoQaIssueFingerprint(issue, segmentIndex) {
  const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const parts = [
    segmentIndex == null ? "" : String(segmentIndex),
    clean(issue.dimension),
    clean(issue.severity),
    clean(issue.category || issue.type),
    clean(issue.message),
    clean(issue.sourceSpan),
    clean(issue.targetSpan || issue.span)
  ];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function deleteAutoQaIssue(button) {
  if (!state.autoQaTaskId) return toast("请先打开一条已保存的质检报告");
  if (!confirm("删除这条 AI 意见？评分会按剩余意见重算，删除记录会留档。")) return;
  const payload = JSON.parse(decodeURIComponent(button.dataset.qaIssueDelete));
  button.disabled = true;
  try {
    const fingerprint = await autoQaIssueFingerprint(payload.issue, payload.segmentIndex);
    const result = await api(`/api/qa-tasks/${encodeURIComponent(state.autoQaTaskId)}/issues/delete`, {
      method: "POST",
      body: JSON.stringify({ fingerprint })
    });
    toast(`已删除该意见，综合分重算为 ${result.scores?.overall ?? "—"}`);
    await openQaTask(state.autoQaTaskId);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function openQaTask(id) {
  try {
    const payload = await api(`/api/qa-tasks/${encodeURIComponent(id)}`);
    const { task, report } = payload;
      state.autoQaTaskId = id;
    // 新版质检（文件/批次来源）的报告是新结构：直接回放到统一段列表，不重新调模型。
    if (report?.sourceKind) {
      switchView("autoqa");
      applyQaResult(report);
      toast("已回放这次质检报告（未重新调用模型）");
      return;
    }
    $("#autoQaSource").value = task.sourceText || "";
    $("#autoQaTarget").value = task.translationText || "";
    $("#autoQaSourceCount").textContent = `${[...(task.sourceText || "")].length} 字`;
    state.autoQaLocale = task.locale;
    const strip = $("#autoQaLocales");
    if (strip) renderLocaleStrip(strip, state.autoQaLocale, updateAutoQaLocale);
    $("#autoQaTargetKicker").textContent = `TARGET · ${task.locale.toUpperCase()}`;
    $("#autoQaTargetTitle").textContent = `${state.bootstrap.locales[task.locale]?.label || task.locale}译文`;
    switchView("autoqa");
    renderAutoQaReport(report);
    toast("已回放质检报告（未重新调用模型）");
  } catch (error) { toast(error.message); }
}

async function deleteQaTaskRow(id, button) {
  if (!confirm("确认删除这条质检任务？删除后无法恢复。")) return;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await api(`/api/qa-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadTasks();
    toast("已删除质检任务");
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

/**
 * 任务中心导出：和翻译界面的导出是同一个选择——写回原文件 / 仅译文 / 任务 Excel。
 * 写回原文件靠"导入时随批次存档的原文件"，所以这里也不用再让用户选文件。
 */
async function exportTaskRow(batchId, button) {
  return exportBatchTask(batchId, button);
}

/** 任务中心那条批次记录的写回列提示（结构里存着列角色）。 */
function batchWriteBackLabelFor(run) {
  const sheets = run?.structure?.spreadsheetAnalysis?.sheets || run?.spreadsheetAnalysis?.sheets || [];
  for (const sheet of sheets) {
    const output = (sheet.columns || []).find((column) => column.role === "translation_output");
    if (output) return ` · 写回列：${output.label || `${output.letter} 列`}`;
  }
  return "";
}

function applyStoredBatchRun(run) {
  state.batchWorkflow = run.workflow || null;
  state.batchBase64 = "";
  state.batchFile = null;
  // 导入时上传的原文件由服务端随批次存档；有它就不需要用户再选一次。
  state.batchHasStoredOriginal = Boolean(run.runnerOptions?.originalFile);
  state.batchPreview = {
    batchId: run.batchId, filename: run.filename, format: run.format,
    segmentationMode: run.segmentationMode, structure: run.structure, subBatches: run.subBatches || [], runState: run.runState || "ready",
    runnerOptions: run.runnerOptions || null,
    termSurvey: run.termSurvey || null,
    segments: run.segments.map((segment, index) => ({
      id: segment.id, index: index + 1, source: segment.source, translation: segment.translation || "",
      status: segment.status || "pending", selected: segment.selected !== false, accepted: Boolean(segment.accepted),
      locator: segment.locator || undefined, context: segment.context || undefined, result: segment.result || null, error: segment.error || ""
    }))
  };
  state.batchClassification = { contentType: run.contentType || "general", source: "restored" };
  state.batchStyleProfile = null;
  state.batchBrief = run.contextBrief || null;
  state.batchBriefDraft = null;
  state.batchBriefPending = false;
  state.batchReport = run.qualityReport || null;
  updateBatchSegmentationOptions(run.filename || "");
  state.workbenchLocale = run.locale || state.workbenchLocale;
  localStorage.setItem("kami-batch-id", run.batchId);
  renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
  $("#batchSourceMeta").textContent = batchSourceMetaText({ segments: run.segments.length, suffix: "历史任务" });
  $("#batchFilePrompt").textContent = run.filename || "已恢复历史任务";
  $("#batchFileMeta").textContent = "任务内容已从后台恢复，可继续 QA、编辑或导出 Excel";
  $("#batchDropZone").classList.add("has-file");
  switchView("workbench");
  setTranslationMode("batch");
  state.batchTab = run.segments.length ? "queue" : "setup";
  state.batchSegmentQuery = "";
  if ($("#batchSegmentSearch")) $("#batchSegmentSearch").value = "";
  // 打开历史任务时清掉上一次的 QA 筛选，免得看起来"段落少了"。
  state.batchSegmentFilter = "";
  state.batchQaCursor = -1;
  renderBatchSegments();
  renderBatchBrief();
  renderBatchWorkflow();
  renderBatchReport();
  renderBatchTermSurvey();
  renderBatchTabs();
  refreshActions();
}

async function openTask(batchId) {
  try {
    // 任务中心点「打开文件」：直接把这条批次铺进工作台并切到「当前文件」标签。
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId)}`);
    applyStoredBatchRun(run);
    toast(`已打开任务：${run.filename}`);
    if (["queued", "running"].includes(run.runState)) {
      state.batchRunning = true;
      refreshActions();
      pollServerBatch(run.batchId).catch((error) => toast(error.message));
    }
  } catch (error) { toast(error.message); }
}

function invalidateBatchTranslations(message) {
  if (!state.batchPreview || state.batchRunning) return;
  const hadTranslations = state.batchPreview.segments.some((segment) => segment.status === "done");
  state.batchPreview.segments.forEach((segment) => {
    segment.translation = "";
    segment.result = null;
    segment.error = "";
    segment.status = "pending";
  });
  state.batchClassification = null;
  state.batchStyleProfile = null;
  renderBatchSegments();
  refreshActions();
  if (hadTranslations) toast(message);
}

/**
 * 通用"选一个"弹窗：导出方式（写回原文件 / 仅译文 / 任务 Excel）、删除确认都用它。
 * 返回所选 option id，取消关闭返回空字符串。
 */
function openChoiceDialog({ kicker = "CHOOSE", title, summary, options }) {
  const dialog = $("#exportOptionsDialog");
  $("#exportOptionsKicker").textContent = kicker;
  $("#exportOptionsTitle").textContent = title;
  $("#exportOptionsSummary").textContent = summary;
  $("#exportOptionsBody").innerHTML = options
    .map((option) => `<button class="export-option" type="button" data-export-option="${escapeHtml(option.id)}"><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.hint || "")}</small></button>`)
    .join("");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClick = (event) => {
      const option = event.target.closest("[data-export-option]");
      if (option) return finish(option.dataset.exportOption);
      if (event.target.closest("[data-close='exportOptionsDialog']")) finish("");
    };
    const onClose = () => finish("");
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("close", onClose);
    if (!dialog.open) dialog.showModal();
  });
}

/** 让用户补选原文件（历史任务没保存原文件时，写回需要它）。 */
function pickBatchSourceFile() {
  return new Promise((resolve) => {
    const input = $("#batchSourceFile");
    input.value = "";
    const onChange = async (event) => {
      input.removeEventListener("change", onChange);
      const file = event.target.files?.[0];
      if (!file) return resolve(false);
      state.batchFile = file;
      state.batchBase64 = await fileToBase64(file);
      $("#batchFilePrompt").textContent = file.name;
      resolve(true);
    };
    input.addEventListener("change", onChange);
    input.click();
  });
}

/** 当前表格的写回列（没有写回列就是原位覆盖原文）。 */
function batchWriteBackLabel() {
  const sheets = state.batchPreview?.spreadsheetAnalysis?.sheets || [];
  for (const sheet of sheets) {
    const output = (sheet.columns || []).find((column) => column.role === "translation_output");
    if (output) return `${sheet.sheet} · ${output.label || `${output.letter} 列`}（译文列）`;
  }
  const hasTable = ["xlsx", "csv"].includes(state.batchPreview?.format);
  return hasTable ? "没有指定译文列 → 原位覆盖日文原文列" : "";
}

async function exportBatch() {
  if (!state.batchPreview) return;
  return exportBatchTask(state.batchPreview.batchId, $("#tertiaryAction"), { segments: state.batchPreview.segments });
}

const EXPORT_PREFLIGHT_TIMEOUT_MS = 90_000;

/**
 * 导出相关的弹窗：门禁阻断 / 提醒 / 完成 / 失败都在这里给出落点。
 * 带 forceLabel 时返回 true 表示用户选择"仍然导出"，否则 false。
 */
function openExportDialog({ title, summary, items = [], forceLabel = "" }) {
  const dialog = $("#exportDialog");
  $("#exportDialogTitle").textContent = title;
  $("#exportDialogSummary").textContent = summary;
  $("#exportDialogDetails").innerHTML = items.length
    ? items.map((item) => `<div><strong>第 ${Number(item.segmentIndex) || "?"} 段</strong><p>${escapeHtml(item.message || "")}${item.suggestion ? `<em>${escapeHtml(item.suggestion)}</em>` : ""}</p></div>`).join("")
    : "";
  const jump = $("#exportDialogJump");
  jump.hidden = !items.length;
  const force = $("#exportDialogForce");
  force.hidden = !forceLabel;
  if (forceLabel) force.textContent = forceLabel;
  const firstSegmentId = items.find((item) => item.segmentId)?.segmentId || "";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClick = (event) => {
      if (event.target.closest("#exportDialogForce")) return finish(true);
      if (event.target.closest("#exportDialogJump")) { jumpToBatchSegment(firstSegmentId); finish(false); return; }
      if (event.target.closest("[data-close='exportDialog']")) finish(false);
    };
    const onClose = () => finish(false);
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("close", onClose);
    if (!dialog.open) dialog.showModal();
  });
}

/** 跳到批次翻译页并高亮某一段，配合导出弹窗的"去看第一条"。 */
function jumpToBatchSegment(segmentId) {
  switchView("workbench");
  setTranslationMode("batch");
  const row = segmentId ? document.querySelector(`.batch-segment[data-segment-id="${CSS.escape(String(segmentId))}"]`) : null;
  if (!row) return toast("已回到批次翻译页，请按段号查看");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-highlighted");
  setTimeout(() => row.classList.remove("is-highlighted"), 2_500);
}

/**
 * 保存导出文件：优先用系统的"另存为"让用户挑位置（Chromium 系支持），
 * 不支持时回退成普通下载——并明确告诉用户文件去了哪里，避免"点了没反应"的错觉。
 */
async function saveExportedFile(payload) {
  const binary = atob(payload.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const extension = String(payload.filename || "").split(".").pop() || "bin";
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: payload.filename,
        types: [{ description: "导出文件", accept: { [payload.mimeType || "application/octet-stream"]: [`.${extension}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return { message: `已保存到你选择的位置：${handle.name || payload.filename}` };
    } catch (error) {
      if (String(error?.name) === "AbortError") throw new Error("已取消保存");
      // 其它原因（浏览器策略、权限）回退成下载，不让导出彻底失败。
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { message: "浏览器不会弹保存位置时必须自行设置：默认已存到「下载」目录" };
}

function batchFeedbacks() {
  return state.batchPreview?.segments.filter((segment) => segment.status === "done" && segment.translation && !segment.accepted) || [];
}

async function acceptSegment(segmentId) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment || !segment.translation) return;
  try {
    const result = await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: segment.source,
      translation: segment.translation,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: "auto",
      styleProfileId: state.batchStyleProfile?.id || "",
      qaCaseId: segment.result?.aiQa?.qaCases?.[0]?.id || "",
      termSuggestions: segment.result?.termSuggestions || [],
      batchId: state.batchPreview.batchId || "",
      sourceFile: state.batchPreview.filename || "",
      // 条目身份：采纳进主 TM 时带上，后续同一条目的译例才能按 ID 命中。
      entryId: segment.locator?.unitId || segment.locator?.entryId || "",
      entryKey: segment.entryKey || segment.locator?.entryKey || "",
      trajectoryId: segment.result?.trajectoryId || segment.result?.trajectory_id || ""
    }) });
    segment.accepted = true;
    saveBatchProgress();
    renderBatchSegments();
    refreshActions();
    toast(`已采纳：${segment.source.slice(0, 20)}…${result.demoted ? `（${result.demoted} 条旧译降权）` : ""}`);
  } catch (error) { toast(error.message); }
}

async function acceptAllSegments() {
  const pending = batchFeedbacks();
  if (!pending.length) return;
  if (!confirm(`确认采纳全部 ${pending.length} 段译文？采纳后将写入翻译记忆与风格证据。`)) return;
  setBusy(true, `采纳中（0 / ${pending.length}）…`);
  let done = 0;
  for (const segment of pending) {
    try {
      await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        source: segment.source,
        translation: segment.translation,
        locale: state.workbenchLocale,
        contentType: state.batchClassification?.contentType || "general",
        domain: "auto",
        styleProfileId: state.batchStyleProfile?.id || "",
        qaCaseId: segment.result?.aiQa?.qaCases?.[0]?.id || "",
        termSuggestions: segment.result?.termSuggestions || [],
        batchId: state.batchPreview.batchId || "",
        sourceFile: state.batchPreview.filename || "",
        entryId: segment.locator?.unitId || segment.locator?.entryId || "",
        entryKey: segment.entryKey || segment.locator?.entryKey || "",
        trajectoryId: segment.result?.trajectoryId || segment.result?.trajectory_id || ""
      }) });
      segment.accepted = true;
      done += 1;
      setBusy(true, `采纳中（${done} / ${pending.length}）…`);
      saveBatchProgress();
    } catch (error) {
      toast(`第 ${segment.index} 段采纳失败：${error.message}`);
    }
  }
  setBusy(false);
  renderBatchSegments();
  toast(`已采纳 ${done} / ${pending.length} 段译文`);
}

async function saveBatchProgress() {
  if (!state.batchPreview?.batchId) return;
  const preview = state.batchPreview;
  localStorage.setItem("kami-batch-id", preview.batchId);
  const payload = {
      ...projectPayload(),
      batchId: preview.batchId,
      filename: preview.filename,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: "auto",
      format: preview.format,
      segmentationMode: preview.segmentationMode,
      structure: preview.structure,
      segments: preview.segments.map(({ id, source, translation, status, selected, accepted, locator, context, result }) => ({ id, source, translation, status, selected, accepted, locator, context, result: compactBatchResult(result) }))
  };
  batchSaveChain = batchSaveChain.catch(() => undefined).then(() => api("/api/batch/run", { method: "POST", body: JSON.stringify(payload) }));
  try { await batchSaveChain; }
  catch (error) { console.warn("批次进度保存失败：", error.message); }
}

function compactBatchResult(result) {
  if (!result) return null;
  const compactText = (value, limit = 800) => String(value || "").slice(0, limit);
  return {
    translation: compactText(result.translation, 10_000),
    qaScore: Number.isFinite(result.qaScore) ? result.qaScore : null,
    matches: (result.matches || []).slice(0, 20).map((match) => ({ mode: match.mode, matchPhrase: compactText(match.matchPhrase, 120), score: match.score, term: { source: compactText(match.term?.source, 120), target: compactText(match.term?.target, 120), enforcement: match.term?.enforcement, forbidden: match.term?.forbidden || [] } })),
    issues: (result.issues || []).slice(0, 30),
    aiQa: result.aiQa ? {
      score: Number.isFinite(result.aiQa.score) ? result.aiQa.score : null,
      status: result.aiQa.status,
      iterations: result.aiQa.iterations || 0,
      used: Boolean(result.aiQa.used),
      fallbackReason: compactText(result.aiQa.fallbackReason, 500),
      termDecisions: (result.aiQa.termDecisions || []).slice(0, 12),
      humanDecisions: (result.aiQa.humanDecisions || []).slice(0, 30),
      referenceCount: (result.aiQa.references || []).length,
      qaCaseCount: (result.aiQa.qaCases || []).length
    } : null,
    styleProfile: result.styleProfile ? { id: result.styleProfile.id, name: result.styleProfile.name, version: result.styleProfile.version } : null,
    patternKey: compactText(result.patternKey, 400)
  };
}

async function restoreBatchProgress() {
  const batchId = localStorage.getItem("kami-batch-id");
  if (!batchId) return;
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId)}`);
    if (!run?.segments?.length) return;
    state.batchPreview = {
      batchId: run.batchId,
      filename: run.filename,
      format: run.format,
      segmentationMode: run.segmentationMode,
      structure: run.structure,
      runnerOptions: run.runnerOptions || null,
      termSurvey: run.termSurvey || null,
      segments: run.segments.map((segment, index) => ({
        id: segment.id,
        index: index + 1,
        source: segment.source,
        translation: segment.translation || "",
        status: segment.status || "pending",
        selected: segment.selected !== false,
        accepted: Boolean(segment.accepted),
        locator: segment.locator || undefined,
        context: segment.context || undefined,
        result: segment.result || null,
        error: ""
      }))
    };
    state.batchClassification = { contentType: run.contentType || "general", source: "restored" };
    state.batchStyleProfile = null;
    state.batchBrief = run.contextBrief || null;
    state.batchBriefDraft = null;
    state.batchBriefPending = false;
    state.batchReport = run.qualityReport || null;
    state.batchHasStoredOriginal = Boolean(run.runnerOptions?.originalFile);
    state.workbenchLocale = run.locale || state.workbenchLocale;
    // 不自动跳进批次页：翻译视图的默认落地是文件列表，这里只记下"上次打开的是哪一份"，
    // 列表里给它一个「继续」的入口（用户明确要求默认先看到文件列表）。
    state.lastBatchId = run.batchId;
    renderBatchFileList();
    renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
    const details = state.bootstrap.locales[state.workbenchLocale];
    $("#targetKicker").textContent = `TARGET · ${state.workbenchLocale.toUpperCase()}`;
    $("#targetTitle").textContent = `${details.label}译文`;
    $("#batchSourceMeta").textContent = batchSourceMetaText({ segments: run.segments.length, suffix: "已恢复保存的进度" });
    if (!run.runnerOptions?.originalFile) {
      $("#batchFilePrompt").textContent = run.filename || "已恢复保存的进度";
      $("#batchFileMeta").textContent = `${run.segments.length} 段 · 刷新后自动恢复`;
      $("#batchDropZone").classList.add("has-file");
    } else {
      $("#batchFilePrompt").textContent = run.filename;
      $("#batchFileMeta").textContent = "进度已恢复 · 导出前请重新选择同名原文件";
      $("#batchDropZone").classList.add("has-file");
    }
    renderBatchSegments();
    renderBatchBrief();
    renderBatchReport();
    refreshActions();
    if (["queued", "running"].includes(run.runState)) {
      state.batchRunning = true;
      pollServerBatch(run.batchId).catch((error) => toast(error.message));
    }
    toast("已恢复上次未完成的批次进度");
  } catch {
    localStorage.removeItem("kami-batch-id");
  }
}

async function updateAssetLocale(locale) {
  state.assetLocale = locale;
  renderLocaleStrip($("#assetLocales"), locale, updateAssetLocale);
  const details = state.bootstrap.locales[locale];
  $("#assetListTitle").textContent = `${details.label}术语库`;
  $("#targetTermLabel").textContent = `${details.label}正式译法`;
  await loadAssets(locale);
}

async function loadStyleProfiles(locale) {
  try {
    const [drafts, active, pending] = await Promise.all([
      api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&status=draft&projectId=${encodeURIComponent(state.activeProjectId)}`),
      api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&status=active&projectId=${encodeURIComponent(state.activeProjectId)}`),
      api(`/api/qa-cases/pending?locale=${encodeURIComponent(locale)}&projectId=${encodeURIComponent(state.activeProjectId)}`)
    ]);
    renderStyleProfiles(drafts, active, pending);
  } catch (error) {
    $("#styleProfileList").innerHTML = `<div class="empty-list">风格规范加载失败：${escapeHtml(error.message)}</div>`;
  }
}

/** 蒸馏跳过原因决定进度怎么读：阈值看总量，增长窗口看增量，待审草稿没有进度可言。 */
function styleDistillProgress(pending = {}) {
  if (pending.skipped === "pending_draft") return "待审核草稿";
  if (pending.skipped === "growth_window") return `新增 ${pending.sinceLastDistill ?? 0}/${pending.growthWindow}`;
  if (Number.isFinite(Number(pending.evidenceCount)) && Number.isFinite(Number(pending.threshold))) {
    return `${pending.evidenceCount}/${pending.threshold}`;
  }
  return String(pending.reason || "暂不蒸馏");
}

function contentTypeLabel(value) {
  return state.bootstrap?.contentTypes?.[value]?.label || value;
}

function contentTagLabels(contentType, tags = []) {
  const dictionary = state.bootstrap?.contentTags?.[contentType] || {};
  return (Array.isArray(tags) ? tags : []).map((tag) => dictionary[tag] || tag).filter(Boolean);
}

/**
 * 草稿卡片上的评测状态。译者画像不在配对评测覆盖范围内，单独标注，
 * 免得看起来像"漏评"。
 */
function styleEvaluationState(item) {
  if (item.kind !== "style") return { tone: "neutral", label: "译者画像暂不参与配对评测，按人工判断启用" };
  const evaluation = item.evaluation;
  if (!evaluation || !evaluation.evaluatedAt) return { tone: "warn", label: "尚未评测：直接启用属于凭感觉改风格，建议先跑一次配对评测" };
  const sample = `${evaluation.sampleCount ?? 0} 组留出对照`;
  if (evaluation.promotable === true) return { tone: "pass", label: `评测通过 · ${sample} · ${evaluation.conclusion || "达到晋升门槛"}` };
  return { tone: "fail", label: `评测未通过 · ${sample} · ${evaluation.conclusion || "未达晋升门槛"}` };
}

async function pollStyleEvaluation(jobId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let job;
    try { job = await api(`/api/style-profiles/evaluation-jobs/${encodeURIComponent(jobId)}`); }
    catch { return null; }
    if (["completed", "failed", "interrupted"].includes(job.status)) return job;
    $("#styleProfileCount").textContent = `评测中 ${job.progress.completed}/${job.progress.requested}`;
  }
  return null;
}

function renderStyleProfiles(drafts, active, pending) {
  const activeById = new Map([...(active.styleProfiles || []), ...(active.userProfiles || [])].map((item) => [item.id, item]));
  const profileCards = [];
  for (const item of drafts.styleProfiles || []) {
    const previous = item.parentId ? activeById.get(item.parentId) : null;
    profileCards.push({ ...item, kind: "style", kindLabel: `风格规范 · ${contentTypeLabel(item.contentType)} / ${item.domain}`, previous });
  }
  for (const item of drafts.userProfiles || []) {
    const previous = item.parentId ? activeById.get(item.parentId) : null;
    profileCards.push({ ...item, kind: "user", kindLabel: "译者画像 · 全局", previous });
  }
  profileCards.sort((a, b) => b.version - a.version);
  $("#styleProfileCount").textContent = `${profileCards.length} 待审核`;

  const profileHtml = profileCards.map((item) => `
    <div class="style-profile-card" data-profile-id="${escapeHtml(item.id)}">
      <div class="style-profile-head"><strong>v${item.version} · ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.kindLabel)} · ${item.evidenceCount} 条证据${item.status === "draft" ? " · 草稿" : ""}</span></div>
      <div class="style-profile-instruction">${escapeHtml(item.instruction)}</div>
      <div class="style-profile-diff" hidden><div><strong>当前生效版本</strong><p>${escapeHtml(item.previous?.instruction || "无（首个版本）")}</p></div><div><strong>本草稿</strong><p>${escapeHtml(item.instruction)}</p></div></div>
      <div class="style-profile-evaluation ${escapeHtml(styleEvaluationState(item).tone)}">${escapeHtml(styleEvaluationState(item).label)}</div>
      <div class="style-profile-actions">
        <button class="button ghost small" data-action="diff">对比新旧</button>
        ${item.kind === "style" ? '<button class="button ghost small" data-action="evaluate">评测</button>' : ""}
        <button class="button ghost small" data-action="activate">激活</button>
        <button class="button ghost small" data-action="reject">拒绝</button>
      </div>
    </div>
  `).join("");
  const pendingHtml = pending.length ? `<div class="qa-case-pending"><strong>AIQA 待复核案例（${pending.length}）</strong>${pending.map((item) => `
    <div class="qa-case-row" data-case-id="${escapeHtml(item.id)}">
      <div><small>${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)} · ${escapeHtml(item.source.slice(0, 40))}</small><p><s>${escapeHtml((item.rejectedTranslation || "").slice(0, 60))}</s> → <strong>${escapeHtml((item.correctedTranslation || "").slice(0, 60))}</strong></p></div>
      <div class="qa-case-actions"><button class="button ghost small" data-action="approve-case">采纳为反例</button><button class="button ghost small" data-action="dispose-case">作废</button></div>
    </div>
  `).join("")}</div>` : "";
  $("#styleProfileList").innerHTML = profileHtml || '<div class="empty-list">当前语言没有待审核的风格草稿</div>' + pendingHtml;

  $$(".style-profile-card [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest(".style-profile-card");
    const id = card.dataset.profileId;
    if (button.dataset.action === "diff") {
      card.querySelector(".style-profile-diff").hidden = !card.querySelector(".style-profile-diff").hidden;
      return;
    }
    if (button.dataset.action === "evaluate") {
      button.disabled = true;
      try {
        const job = await api(`/api/style-profiles/${encodeURIComponent(id)}/evaluate`, { method: "POST", body: JSON.stringify({ project: state.activeProjectId || "default" }) });
        toast(`风格评测已进入后台：${job.progress.requested} 组留出对照，只有风格规范一个变量`);
        const finished = await pollStyleEvaluation(job.jobId);
        if (finished?.status === "completed") toast(finished.result?.report?.conclusion || "风格评测完成");
        else if (finished) toast(`风格评测未完成：${finished.error || finished.status}`);
      } catch (error) { toast(error.message); }
      finally {
        button.disabled = false;
        await loadStyleProfiles(state.assetLocale);
      }
      return;
    }
    try {
      await api(`/api/style-profiles/${encodeURIComponent(id)}/${button.dataset.action}`, { method: "POST", body: JSON.stringify(projectPayload()) });
      toast(button.dataset.action === "activate" ? "已激活，开始参与翻译" : "已拒绝该草稿");
      await loadStyleProfiles(state.assetLocale);
    } catch (error) {
      // 评测结论反对时后端返回 409；越过闸门必须是一次明确的人工决定，并会被记录。
      if (button.dataset.action === "activate" && /评测结论不支持启用/.test(error.message) && confirm(`${error.message}

仍要启用吗？本次越过评测闸门会记录在该风格规范上。`)) {
        try {
          await api(`/api/style-profiles/${encodeURIComponent(id)}/activate`, { method: "POST", body: JSON.stringify({ ...projectPayload(), force: true }) });
          toast("已忽略评测结论并启用，该决定已记录");
          await loadStyleProfiles(state.assetLocale);
          return;
        } catch (forceError) { toast(forceError.message); return; }
      }
      toast(error.message);
    }
  }));
  $$(".qa-case-row [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".qa-case-row").dataset.caseId;
    try {
      await api(`/api/qa-cases/${encodeURIComponent(id)}/${button.dataset.action === "approve-case" ? "approve" : "dispose"}`, { method: "POST" });
      toast(button.dataset.action === "approve-case" ? "已采纳为反例，将参与后续 QA 指导" : "已作废该案例");
      await loadStyleProfiles(state.assetLocale);
    } catch (error) { toast(error.message); }
  }));
}

async function updateStyleLocale(locale) {
  state.styleLocale = locale;
  renderLocaleStrip($("#styleLocales"), locale, updateStyleLocale);
  const details = state.bootstrap.locales[locale];
  $("#styleGuidanceTitle").textContent = `${details.label}翻译风格指导`;
  await loadStyleGuidance(locale);
}

async function importStyleGuideFile(file, locale = state.styleLocale) {
  if (!file) throw new Error("请先选择风格指南文件");
  if (!/\.(txt|md|docx)$/iu.test(file.name)) throw new Error("风格指南仅支持 .txt、.md、.docx");
  if (file.size > 5 * 1024 * 1024) throw new Error("风格指南不能超过 5MB");
  const result = await api("/api/style-guides/import", { method: "POST", body: JSON.stringify({
    ...projectPayload(),
    locale,
    filename: file.name,
    base64: await fileToBase64(file)
  }) });
  await loadStyleGuidance(locale);
  return result;
}

/** 上传控件既要看出"能点"，也要看出"选中了哪个文件"。 */
function renderStyleGuidePicker() {
  const file = state.styleGuideFile;
  $("#styleGuideFileName").textContent = file
    ? `${file.name} · ${formatBytes(file.size)}`
    : "支持 TXT / Markdown / DOCX，最大 5MB";
  $("#styleGuideFile").closest(".library-file-button")?.classList.toggle("has-file", Boolean(file));
}

async function importStyleGuide() {
  const file = state.styleGuideFile;
  if (!file) return;
  const button = $("#styleGuideImportButton");
  const note = $("#styleGuideImportNote");
  button.disabled = true;
  note.className = "library-import-note";
  note.textContent = "正在读取并启用风格指南……";
  try {
    const result = await importStyleGuideFile(file);
    state.styleGuideFile = null;
    $("#styleGuideFile").value = "";
    renderStyleGuidePicker();
    note.classList.add("is-ok");
    note.textContent = `已启用：${result.filename} · ${result.characters} 字 · 作为当前项目的风格规则立即生效`;
    toast("风格指南已导入并启用，优先于自动蒸馏的规则");
  } catch (error) {
    button.disabled = false;
    note.classList.add("is-error");
    note.textContent = error.message;
    toast(error.message);
  }
}

function splitStyleRules(instruction) {
  // 历史接口：只返回真正的规则行（小节标题不算规则、也不按「；」拆条）。
  return parseStyleDocument(instruction).filter((block) => block.type === "rule").map((block) => block.text);
}

/**
 * 风格规范（无论人工导入还是自动蒸馏）都是**带小节的文档**：
 *   【用词】/「# 标题」/「一、」这类是章节标题，`・`/`-`/`1.` 开头的才是规则条目。
 * 旧实现按换行 + 「；」硬切，于是把标题也算成规则、还把一条规则拆成两条（12 行显示成 14 条）。
 *
 * 这里统一解析成块：heading（章节）/ rule（规则，去掉项目符号前缀）/ divider（分隔线）。
 * 同一段文字给两种界面用：人工指南按文档渲染，蒸馏规范按小节分组列规则。
 */
function parseStyleDocument(text) {
  const blocks = [];
  for (const raw of String(text || "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[=\-*_]{3,}$/u.test(line)) { blocks.push({ type: "divider", text: "" }); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/u);
    if (heading) {
      blocks.push({ type: "heading", level: Math.min(4, heading[1].length), text: heading[2].trim() });
      continue;
    }
    const bracketHeading = line.match(/^【(.+)】$/u);
    if (bracketHeading) { blocks.push({ type: "heading", level: 2, text: bracketHeading[1].trim() }); continue; }
    const numberedHeading = line.match(/^[一二三四五六七八九十]+、\s*(.+?)[。.]?$/u);
    if (numberedHeading && line.length <= 24) { blocks.push({ type: "heading", level: 2, text: numberedHeading[1].trim() }); continue; }
    const rule = line
      .replace(/^[・·•*\-]\s*/u, "")
      .replace(/^\d+[.)、]\s*/u, "")
      .trim();
    if (rule) blocks.push({ type: "rule", text: rule });
  }
  return blocks;
}

/** 人工指南的"查看正文"：按文档结构渲染，一行都不丢。 */
function renderStyleGuideDocument(text) {
  const blocks = parseStyleDocument(text);
  if (!blocks.length) return '<p class="guide-doc-empty">正文为空</p>';
  return blocks.map((block) => {
    if (block.type === "divider") return '<hr class="guide-doc-divider" />';
    if (block.type === "heading") return `<p class="guide-doc-heading lv${block.level || 2}">${escapeHtml(block.text)}</p>`;
    return `<p>${escapeHtml(block.text)}</p>`;
  }).join("");
}

/** 人工指南卡片里的"查看正文"：全文渲染（不截断），并给一个复制入口。 */
function renderManualGuideDocument(instruction) {
  const text = String(instruction || "");
  const characters = [...text].length;
  return `<details class="style-examples manual-guide-details"><summary>查看正文（全文 ${characters} 字，按文档结构展开）</summary>
    <div class="guide-doc">${renderStyleGuideDocument(text)}</div>
    <div class="guide-doc-footer"><button class="button ghost small" type="button" data-action="copy-guide">复制全文</button><small>正文按导入时的原文保存，没有被改写</small></div>
  </details>`;
}

function formatStyleTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 人工风格指南状态模块：一眼看清"有没有人工指南、是哪一份、现在是否启用"。
 *
 * 人工导入的指南由 /api/style-guides/import 命名成"风格指南 · <文件名>"，
 * 用它跟从译文里蒸馏出来的译者画像区分（两者都存在 user_profiles 里）。
 */
/**
 * 立即重新蒸馏：不用等下一次批次/导入结束。逐个作用域按同一套门禁判定，
 * 够条件（证据 ≥ 阈值、距上次蒸馏的新增 ≥ 增长窗口、且没有待审草稿）才会调模型。
 */
async function distillStyleNow(button) {
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "蒸馏中…";
  try {
    const result = await api("/api/style-profiles/distill", {
      method: "POST",
      body: JSON.stringify({ ...projectPayload(), locale: state.styleLocale })
    });
    // 项目级蒸馏一次只出一份：成功就说版本与规则数，跳过就把门禁原因原样说明。
    if (result.distilled) {
      toast(`已重新蒸馏项目规范 v${result.profile.version}（${result.profile.rules} 条规则，证据 ${result.evidenceCount} 条）`);
    } else {
      toast(result.reason ? `暂未蒸馏：${result.reason}` : "当前还没有风格证据可蒸馏");
    }
    await loadStyleGuidance(state.styleLocale);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "立即重新蒸馏";
  }
}

function renderManualGuide(profiles) {
  const container = $("#manualGuideStatus");
  if (!container) return;
  const guides = (profiles.userProfiles || []).filter((item) => String(item.name || "").startsWith("风格指南 · "));
  const current = guides.find((item) => item.status === "active")
    || [...guides].sort((left, right) => (Number(right.version) || 0) - (Number(left.version) || 0))[0]
    || null;
  if (!current) {
    container.innerHTML = '<div class="manual-guide-empty"><strong>还没有人工风格指南</strong><p>用上面的入口导入 TXT / Markdown / DOCX；导入后立即启用，并优先于自动蒸馏出的规则。</p></div>';
    return;
  }
  const status = String(current.status || "draft");
  const statusLabel = status === "active" ? "已启用" : status === "draft" ? "待批准" : "已停用";
  const statusNote = status === "active"
    ? "正在作为最高优先级风格规则参与翻译"
    : status === "draft" ? "尚未启用，当前翻译不会使用它" : "已停用，历史版本仍保留";
  const history = guides.filter((item) => item.id !== current.id).length;
  const deleteButton = '<button class="button ghost small danger" data-action="delete-guide" title="删除这份人工风格指南">删除</button>';
  const action = (status === "active"
    ? '<button class="button ghost small" data-action="disable">停用（保留历史）</button>'
    : `<button class="button secondary small" data-action="activate">${status === "draft" ? "批准并启用" : "重新启用"}</button>`) + deleteButton;
  container.innerHTML = `<article class="manual-guide-card ${escapeHtml(status)}" data-profile-id="${escapeHtml(current.id)}">
    <div class="manual-guide-head"><div><strong>${escapeHtml(String(current.name || "").replace(/^风格指南 · /u, ""))}</strong><small>${escapeHtml(statusNote)} · v${Number(current.version) || 1} · 正文 ${[...String(current.instruction || "")].length} 字 · 最近更新 ${escapeHtml(formatStyleTime(current.updatedAt))}${history ? ` · 另有 ${history} 个历史版本` : ""}</small></div><span class="style-state ${escapeHtml(status)}">${statusLabel}</span></div>
    <div class="manual-guide-actions">${renderManualGuideDocument(current.instruction)}${action}</div>
  </article>`;
}

async function loadStyleGuidance(locale = state.styleLocale) {
  const [profiles, pending] = await Promise.all([
    api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&projectId=${encodeURIComponent(state.activeProjectId)}`),
    api(`/api/qa-cases/pending?locale=${encodeURIComponent(locale)}&projectId=${encodeURIComponent(state.activeProjectId)}`)
  ]);
  state.styleData = { profiles, pending };
  renderStyleGuidance();
  // 规则冲突审查也归这一页：它比的就是风格规则、技能规则与译者画像三方。
  await loadStyleConflictReport();
}

/** 来源文件清单的展示文本：最多列两个文件，其余写"等 N 个文件"。 */
function formatEvidenceFiles(files = []) {
  const list = learningArray(files).filter((item) => item?.name);
  if (!list.length) return "";
  const shown = list.slice(0, 2).map((item) => `${item.name}（${Number(item.count) || 0} 条）`).join("、");
  return list.length > 2 ? `${shown} 等 ${list.length} 个文件` : shown;
}

function renderStyleGuidance() {
  const profiles = state.styleData?.profiles || { styleProfiles: [], userProfiles: [], evidencePools: [] };
  const pending = state.styleData?.pending || [];
  const learningRuns = learningRunsFromPayload(profiles);
  const statusFilter = $("#styleStatus")?.value || "";
  // 人工导入的指南是"整篇文档"，它有自己的模块（上面那块，含全文与启用开关）。
  // 这里只列从语料蒸馏 / 复盘出来的规则——它们才是真正一条一条的规则。
  const items = (profiles.styleProfiles || [])
    .map((item) => ({ ...item, kind: "style", scopeLabel: `${contentTypeLabel(item.contentType)} · ${item.domain}` }))
    .filter((item) => !statusFilter || item.status === statusFilter);
  const activeCount = [...(profiles.userProfiles || []), ...(profiles.styleProfiles || [])].filter((item) => item.status === "active").length;
  $("#styleGuidanceCount").textContent = `${activeCount} 条启用 · ${items.length} 条显示`;
  renderManualGuide(profiles);
  $("#styleLearningCount").textContent = `${learningRuns.length} 个批次范围`;
  $("#styleLearningRuns").innerHTML = learningRuns.length ? renderLearningCards(learningRuns) : '<div class="empty-list compact">还没有可展示的批次学习记录；导入完整双语句段后会在这里说明 AI 具体学到了什么。</div>';
  // 渲染完要挂事件：这一块的卡片里有"重跑模型浓缩"这类按记录操作的按钮。
  bindStyleLearningLinks($("#styleLearningRuns"));
  const pools = profiles.evidencePools || [];
  // 风格资产是项目级的：只有一个池子。语体分布折起来，需要判断"证据里有没有对白/公告"
  // 时再展开（蒸馏会按语体分层取样）。
  const poolTotal = pools.reduce((sum, pool) => sum + (Number(pool.evidenceCount) || 0), 0);
  const poolThreshold = Number(pools[0]?.threshold) || 8;
  const poolPercent = Math.min(100, Math.round((poolTotal / Math.max(1, poolThreshold)) * 100));
  const scopeBreakdown = (profiles.evidenceByScope || pools[0]?.byContentType || []);
  const scopeDetail = scopeBreakdown.length
    ? scopeBreakdown.map((bucket) => `<div class="style-pool"><div><strong>${escapeHtml(contentTypeLabel(bucket.contentType))}</strong><small>该语体的证据条数（蒸馏按语体分层取样，保证每类都有代表）</small></div><div class="style-pool-progress"><i style="width:${Math.min(100, Math.round(((Number(bucket.count) || 0) / Math.max(1, poolTotal)) * 100))}%"></i></div><span>${bucket.count} 条</span></div>`).join("")
    : '<div class="empty-list compact">还没有证据。</div>';
  const poolDetail = pools.map((pool) => {
    const percent = Math.min(100, Math.round((pool.evidenceCount / Math.max(1, pool.threshold)) * 100));
    const sources = pool.sources || {};
    const sampledNote = Number(pool.sampled) && Number(pool.sampled) < Number(pool.evidenceCount)
      ? `<small>分析取样：${pool.sampled} 条（口径：人工采纳优先 → 语体分层 → 来源覆盖；改写 / 负例按取样统计）</small>`
      : "";
    // 池子也要说清"证据来自哪些文件"：蒸馏出来的规则才能回溯到具体交付物。
    const poolFiles = formatEvidenceFiles(pool.files);
    const filesNote = poolFiles ? `<small class="style-pool-files">来源文件：${escapeHtml(poolFiles)}</small>` : "";
    return `<div class="style-pool is-project"><div><strong>项目规范证据池</strong><small>直接证据：表格导入 ${sources.tableImport || 0} · 人工采纳 ${sources.humanAccept || 0}${sources.other ? ` · 历史/其他 ${sources.other}` : ""}${sources.revised ? ` · 含改写 ${sources.revised}` : ""}${sources.negative ? ` · 反例 ${sources.negative}` : ""}</small><small>辅助复盘：AIQA 记录 ${sources.qaReview || 0}（不计入 ${pool.threshold} 条直接证据）</small>${filesNote}${sampledNote}</div><div class="style-pool-progress"><i style="width:${percent}%"></i></div><span>${pool.evidenceCount} / ${pool.threshold}</span></div>`;
  }).join("");
  $("#styleEvidencePools").innerHTML = pools.length
    ? `<div class="style-pool-heading"><div><strong>正在积累的项目证据池</strong><small>累计达到 ${poolThreshold} 条才会蒸馏；蒸馏时按语体分层取样，规则会写明适用场景</small></div><button class="button secondary small" type="button" id="styleDistillNow">立即重新蒸馏</button></div>
      <div class="style-pool is-total"><div><strong>全部证据（项目级）</strong><small>翻译时只用这一份项目规范，不再按语体×领域各取一份</small></div><div class="style-pool-progress"><i style="width:${poolPercent}%"></i></div><span>${poolTotal} / ${poolThreshold}</span></div>
      ${poolDetail}
      <details class="advanced-scope"><summary>按语体查看证据分布（${scopeBreakdown.length} 类）</summary>${scopeDetail}</details>`
    : '<div class="empty-list compact">还没有完整双语句段进入风格证据池；导入短术语不会产生风格。</div>';
  // 池子每次重画，按钮要重新挂：不用等下一次批次跑完就能手动触发蒸馏。
  $("#styleDistillNow")?.addEventListener("click", (event) => distillStyleNow(event.currentTarget));
  $("#styleGuidanceList").innerHTML = items.length ? items.map((item) => {
    // 蒸馏结果同样是带小节的文档：小节标题单独显示，规则在小节内编号，
    // 标题既不算规则、也不会因为「；」被拆成两条。
    // 待批准草案与当前生效版本逐字相同的规则占多数：折叠起来只展开变化的部分，
    // 否则两张卡片并排看就是"同一批规则抄了两遍"。
    const diff = styleProfileDiff(item, item.status === "active" ? null : (profiles.styleProfiles || []).find((other) => other.id !== item.id && other.status === "active" && (other.contentType || "general") === (item.contentType || "general") && (other.domain || "general") === (item.domain || "general")));
    const reusedTexts = new Set(diff?.reusedTexts || []);
    const updatedTexts = new Set(diff?.updatedTexts || []);
    const sections = [];
    for (const block of parseStyleDocument(item.instruction)) {
      if (block.type === "divider") continue;
      if (block.type === "heading") { sections.push({ title: block.text, rules: [] }); continue; }
      if (!sections.length) sections.push({ title: "", rules: [] });
      sections.at(-1).rules.push(block.text);
    }
    const ruleCount = sections.reduce((sum, section) => sum + section.rules.length, 0);
    const reusedCount = sections.reduce((sum, section) => sum + section.rules.filter((rule) => reusedTexts.has(rule)).length, 0);
    const sectionCount = sections.filter((section) => section.title).length;
    const examples = (item.examples || []).slice(0, 4);
    const sourceBatchId = item.sourceBatchId || item.source_batch_id || "";
    const learningSummary = item.learningSummary || item.learning_summary || "";
    // 这一版规则的取样来自哪些文件：蒸馏结果必须能回溯到具体交付物。
    const evidenceFiles = formatEvidenceFiles(item.evidenceFiles || item.evidence_files);
    const missingFiles = Number(item.evidenceFilesMissing ?? item.evidence_files_missing) || 0;
    const evidenceFilesNote = evidenceFiles
      ? `<small class="style-evidence-files">来源文件：${escapeHtml(evidenceFiles)}</small>`
      : (missingFiles ? `<small class="style-evidence-files">来源文件：原证据已不在库中（本版取样 ${missingFiles} 条）</small>` : "");
    const diffChips = diff
      ? `<p class="style-rule-diff">对比 v${diff.baselineVersion}：新增 ${diff.added} · 改写 ${diff.updated} · 逐字沿用 ${diff.reused} · 已退休 ${diff.retired}</p>`
      : "";
    const ruleRow = (rule, index, { reused = false } = {}) => `<div class="style-rule-row${reused ? " reused" : ""}"><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(rule)}${updatedTexts.has(rule) ? '<em class="style-rule-tag">本版改写</em>' : ""}</p><button class="button ghost small danger" type="button" data-action="delete-rule" data-rule="${escapeHtml(rule)}" title="从这一版规则里删掉这条">删除</button></div>`;
    return `<article class="style-guidance-card ${escapeHtml(item.status)}" data-profile-id="${escapeHtml(item.id)}">
      <div class="style-guidance-head"><div><strong>${escapeHtml(item.name)}</strong><small>适用范围：${escapeHtml(state.bootstrap.locales[state.styleLocale].label)} × ${escapeHtml(item.scopeLabel)} · v${item.version}</small><small>生成方式：${escapeHtml(item.name.startsWith("风格指南 · ") ? "人工上传，正文未被改写" : item.name.includes("复盘修订") ? "AIQA 复盘结合已沉淀语料" : "同类双语语料自动精炼")} · ${item.evidenceCount} 条证据${sourceBatchId ? ` · 来源批次 ${escapeHtml(String(sourceBatchId).slice(0, 8))}` : ""}</small>${evidenceFilesNote}</div><span class="style-state ${escapeHtml(item.status)}">${item.status === "active" ? "已启用" : item.status === "draft" ? "待批准" : "已停用"}</span></div>
      ${learningSummary ? `<p class="style-learning-summary">本批浓缩：${escapeHtml(learningSummary)}</p>` : ""}
      <p class="style-rule-count">${sectionCount ? `${sectionCount} 个小节 · ` : ""}共 ${ruleCount} 条规则${reusedCount ? `（其中 ${reusedCount} 条与 v${diff.baselineVersion} 逐字相同，已折叠）` : ""}</p>
      ${diffChips}
      <div class="style-rule-list">${ruleCount ? sections.map((section) => {
        const changed = section.rules.filter((rule) => !reusedTexts.has(rule));
        const reused = section.rules.filter((rule) => reusedTexts.has(rule));
        return `<div class="style-rule-section-group">${section.title ? `<p class="style-rule-section">${escapeHtml(section.title)}</p>` : ""}${changed.map((rule, index) => ruleRow(rule, index)).join("")}${reused.length ? `<details class="style-rule-reused"><summary>沿用 v${diff.baselineVersion} 的 ${reused.length} 条（逐字相同）</summary>${reused.map((rule, index) => ruleRow(rule, index, { reused: true })).join("")}</details>` : ""}</div>`;
      }).join("") : '<div class="batch-detail-empty">该版本没有可展示的规则条目</div>'}</div>
      ${examples.length ? `<details class="style-examples"><summary>查看 ${examples.length} 个正反例</summary>${examples.map((example) => `<div><strong>${example.type === "negative" ? "反例" : "正例"}</strong><p>${escapeHtml(example.source || "")}</p><p>${escapeHtml(example.target || "")}</p><small>${escapeHtml(example.reason || "")}</small></div>`).join("")}</details>` : ""}
      <div class="style-guidance-actions"><button class="button ${item.status === "active" ? "ghost" : "secondary"} small" data-action="${item.status === "active" ? "disable" : "activate"}">${item.status === "active" ? "停用（保留历史）" : "批准并启用"}</button><button class="button ghost small danger" data-action="delete-profile" title="${item.status === "active" ? "生效中的版本要先停用才能删除" : "删除这一版风格规范"}">删除</button></div>
    </article>`;
  }).join("") : '<div class="empty-list">当前筛选条件下没有自动蒸馏的规则条目；人工导入的风格指南在上面的「人工风格指南」模块里单独展示（它是一整篇文档，不按条计）。</div>';
  $("#styleQaCount").textContent = `${pending.length} 条`;
  $("#styleQaList").innerHTML = pending.length ? pending.map((item) => `<div class="qa-case-row" data-case-id="${escapeHtml(item.id)}"><div><small>${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)} · ${escapeHtml(item.source.slice(0, 55))}</small><p><s>${escapeHtml((item.rejectedTranslation || "").slice(0, 90))}</s> → <strong>${escapeHtml((item.correctedTranslation || "").slice(0, 90))}</strong></p></div><div class="qa-case-actions"><button class="button secondary small" data-action="approve-case">采纳为反例</button><button class="button ghost small" data-action="dispose-case">作废</button></div></div>`).join("") : '<div class="empty-list">当前没有待审核案例</div>';

  $$(".style-guidance-card [data-action], #manualGuideStatus [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest("[data-profile-id]").dataset.profileId;
    const action = button.dataset.action;
    if (action === "copy-guide") {
      // 指南可能几千字：复制走剪贴板，内容直接从当前数据里取，不依赖 DOM 截断。
      const guide = (state.styleData?.profiles?.userProfiles || []).find((item) => item.id === id);
      try {
        await navigator.clipboard.writeText(String(guide?.instruction || ""));
        toast("已复制人工风格指南全文");
      } catch (error) { toast(`复制失败：${error.message}`); }
      return;
    }
    if (action === "delete-rule") {
      const text = String(button.dataset.rule || "");
      if (!confirm(`删除这条风格规则？\n\n${text}`)) return;
      button.disabled = true;
      try {
        await api(`/api/style-profiles/${encodeURIComponent(id)}/rules`, { method: "DELETE", body: JSON.stringify({ ...projectPayload(), text }) });
        toast("规则已删除，后续翻译不再注入它");
        await loadStyleGuidance(state.styleLocale);
      } catch (error) { button.disabled = false; toast(error.message); }
      return;
    }
    if (action === "delete-profile" || action === "delete-guide") {
      const label = action === "delete-guide" ? "这份人工风格指南" : "这一版风格规范";
      if (!confirm(`确认删除${label}？删除后无法恢复。`)) return;
      button.disabled = true;
      try {
        await api(`/api/style-profiles/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify(projectPayload()) });
        toast(`已删除${label}`);
        await loadStyleGuidance(state.styleLocale);
      } catch (error) { button.disabled = false; toast(error.message); }
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/style-profiles/${encodeURIComponent(id)}/${action === "activate" ? "activate" : "reject"}`, { method: "POST", body: JSON.stringify(projectPayload()) });
      toast(action === "activate" ? "风格已启用，后续翻译将注入该规则" : "风格已关闭，历史版本仍保留但不参与翻译");
      await loadStyleGuidance(state.styleLocale);
    } catch (error) { button.disabled = false; toast(error.message); }
  }));
  $$("#styleQaList .qa-case-row [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".qa-case-row").dataset.caseId;
    try {
      await api(`/api/qa-cases/${encodeURIComponent(id)}/${button.dataset.action === "approve-case" ? "approve" : "dispose"}`, { method: "POST" });
      toast(button.dataset.action === "approve-case" ? "已采纳为 AIQA 反例" : "已作废该案例");
      await loadStyleGuidance(state.styleLocale);
    } catch (error) { toast(error.message); }
  }));
}

const LOG_LEVEL_LABELS = { debug: "调试", info: "信息", warn: "警告", error: "错误" };
const LOG_AUTO_REFRESH_MS = 3_000;
let logAutoRefreshTimer = null;

function logTimeLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function renderLogs() {
  const entries = state.logs || [];
  $("#logCount").textContent = `${entries.length} 条`;
  const errors = entries.filter((entry) => entry.level === "error").length;
  bumpLogBadge(errors);
  $("#logHint").textContent = errors
    ? `当前筛选下有 ${errors} 条错误。记录等级决定服务端记多少：调到「调试」会记下更多细节，调到「仅错误」只留报错。`
    : "记录等级决定服务端记多少：调到「调试」会记下更多细节，调到「仅错误」只留报错。";
  $("#logList").innerHTML = entries.length ? entries.map((entry) => `
    <div class="log-row ${escapeHtml(entry.level)}">
      <span class="log-time">${escapeHtml(logTimeLabel(entry.ts))}${entry.previous ? '<em class="log-previous">上次运行</em>' : ""}</span>
      <span class="log-level ${escapeHtml(entry.level)}">${escapeHtml(LOG_LEVEL_LABELS[entry.level] || entry.level)}</span>
      <div class="log-body"><p class="log-message">${escapeHtml(entry.message)}</p>${entry.detail ? `<p class="log-detail">${escapeHtml(entry.detail)}</p>` : ""}</div>
    </div>`).join("") : '<div class="empty-list">当前筛选下没有日志</div>';
  $$("#logLevels .log-level-chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.level === (state.logLevel || "")));
}

/** 侧边栏角标：有几条错误可查。正在看日志页时不打扰。 */
function bumpLogBadge(count) {
  state.logErrorCount = Math.max(0, Number(count) || 0);
  const badge = $("#logNavBadge");
  if (!badge) return;
  badge.hidden = state.logErrorCount === 0 || state.view === "logs";
  badge.textContent = String(state.logErrorCount);
}

async function loadLogs() {
  if (!state.bootstrap) return;
  const params = new URLSearchParams({ limit: "300" });
  if (state.logLevel) params.set("level", state.logLevel);
  if (state.logSearch) params.set("search", state.logSearch);
  const payload = await api(`/api/logs?${params}`);
  state.logs = payload.entries || [];
  const level = payload.settings?.level;
  if (level && $("#logVerbosity")) $("#logVerbosity").value = level;
  renderLogs();
}

function startLogAutoRefresh() {
  stopLogAutoRefresh();
  if (!$("#logAutoRefresh")?.checked) return;
  logAutoRefreshTimer = setInterval(() => {
    if (state.view !== "logs") return;
    loadLogs().catch(() => {});
  }, LOG_AUTO_REFRESH_MS);
}

function stopLogAutoRefresh() {
  if (logAutoRefreshTimer) clearInterval(logAutoRefreshTimer);
  logAutoRefreshTimer = null;
}

async function loadAssets(locale) {
  state.assetLocale = locale;
  await loadProjectLibraries();
  renderLibraryTable("term");
  if (state.assetLibraryId) await loadLibraryEntries("term", { append: false });
  else renderAssetLibrarySummary();
}

function updateBatchSegmentationOptions(filename = "") {
  const structured = /\.(xlsx|csv|xliff|mqxliff)$/iu.test(String(filename));
  const select = $("#batchSegmentationMode");
  if (!select) return;
  for (const option of select.options) option.hidden = structured ? !["unit", "group"].includes(option.value) : ["unit", "group"].includes(option.value);
  if (structured && !["unit", "group"].includes(select.value)) select.value = "unit";
  if (!structured && !["sentence", "paragraph"].includes(select.value)) select.value = "sentence";
  const label = select.closest("label")?.querySelector("span");
  if (label) label.textContent = structured ? "结构化文件翻译方式" : "翻译单元";
}

async function updateMemoryLocale(locale) {
  state.memoryLocale = locale;
  renderLocaleStrip($("#memoryLocales"), locale, updateMemoryLocale);
  await loadMemories(locale);
}

const MEMORY_PAGE_SIZE = 500;
let memorySearchTimer;
let termSearchTimer;

/**
 * 记忆库按页读取：标题写"已显示 N / 共 M 条"，搜索也交给服务端。
 * 之前接口固定 limit=500 且前端只在前 500 条里过滤，用户会以为库里只有 500 条。
 */
async function loadMemories(locale, { append = false } = {}) {
  state.memoryLocale = locale;
  await loadProjectLibraries();
  renderLibraryTable("tm");
  if (state.memoryLibraryId) await loadLibraryEntries("tm", { append: false });
  else renderMemoryLibrarySummary();
  return undefined;
}

function renderMemoryCount() {
  renderEntryCount("tm");
}

/**
 * 文件清单 + 逐文件状态。用户最需要的是"它确实在动"：每个文件一行，
 * 状态从 待预检 → 识别中 → 已识别 N 条 / 失败，而不是一句静止的"正在预检"。
 */
function renderImportFileList(container, files, states) {
  if (!container) return;
  const totalBytes = files.reduce((sum, file) => sum + (file?.size || 0), 0);
  const done = files.filter((file) => states.get(file.name)?.status === "done" || states.get(file.name)?.status === "failed").length;
  const failed = files.filter((file) => states.get(file.name)?.status === "failed").length;
  container.hidden = !files.length;
  if (!files.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="import-file-head"><strong>${files.length} 个文件 · ${formatBytes(totalBytes)}</strong><span>已预检 ${done} / ${files.length}${failed ? ` · 失败 ${failed}` : ""}</span></div>
    <ul>${files.map((file) => {
      const state = states.get(file.name) || { status: "pending" };
      const label = state.status === "done" ? `已识别 ${state.entries || 0} 条`
        : state.status === "running" ? "识别中…"
          : state.status === "failed" ? `失败：${state.error || "解析失败"}`
            : "待预检";
      return `<li class="${state.status}"><span class="import-file-name">${escapeHtml(file.name)}</span><small>${escapeHtml(formatBytes(file.size))}</small><em>${escapeHtml(label)}</em></li>`;
    }).join("")}</ul>`;
}

function elapsedText(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`;
}

/**
 * 双语资产预检。去向与清洗开关在**上传前**就已经定了：整批一个类型，
 * 需要混合处理时分两次导入，避免"同一个文件既当术语又当 TM"。
 * 预检逐文件进行，进度与每个文件的结果都直接显示在拖入区下方。
 */
async function setImportFiles(files = [], {
  intent = "auto",
  returnView = "",
  purpose = "",
  aiCleaning = null,
  styleEvidence = null,
  fromWizard = false
} = {}) {
  const selected = Array.from(files).filter(Boolean);
  if (!selected.length) return;
  const supported = /\.(xlsx|csv|xliff|mqxliff)$/iu;
  const invalid = selected.find((file) => !supported.test(file.name));
  if (invalid) return toast(`${invalid.name} 不是支持的双语资产格式`);
  // 与记忆库、批次入口统一：单文件 32MB，一次最多 200 个文件；不再限制单次总量
  //（预检是逐文件请求，请求体积不随文件数量增长）。
  const oversize = selected.find((file) => file.size > MEMORY_IMPORT_FILE_BYTES);
  if (oversize) return toast(`${oversize.name} 超过单文件 ${UPLOAD_FILE_LABEL} 上限（${formatBytes(oversize.size)}）`);
  if (selected.length > IMPORT_MAX_FILES) return toast(`一次最多选择 ${IMPORT_MAX_FILES} 个文件，当前 ${selected.length} 个`);
  const resolvedPurpose = purpose || (intent === "terms" ? "term" : readImportPurpose());
  state.importFiles = selected;
  state.importFile = selected[0];
  state.assetPreflight = null;
  state.assetImportIntent = intent;
  state.assetImportReturnView = returnView;
  state.assetImportPurpose = resolvedPurpose;
  // 默认值只在切换类型时由 syncImportPurposeControls 给（人工 TM 默认勾、术语表默认不勾）；
  // 这里一律以界面上的当前勾选为准，否则用户刚取消的勾选会被"默认值"又勾回去。
  state.assetImportAiCleaning = resolvedPurpose === "term" ? (aiCleaning ?? readImportAiCleaning()) : false;
  state.assetImportStyleEvidence = styleEvidence ?? readImportStyleEvidence();
  state.assetImportTaskId = "";
  state.assetImportWizard = fromWizard;
  assetPreflightOutcome = null;
  $("#filePrompt").textContent = selected.length === 1 ? selected[0].name : `已选择 ${selected.length} 个文件`;
  $("#dropZone").classList.add("has-file");
  const fileStates = new Map(selected.map((file) => [file.name, { status: "pending", entries: 0, error: "" }]));
  renderImportFileList($("#importFileList"), selected, fileStates);
  const startedAt = Date.now();
  const progress = (message, percent) => {
    $("#fileMeta").textContent = `${message} · 已用时 ${elapsedText(startedAt)}（本地解析，不调用模型）`;
    updateImportProgress({ message, percent });
  };
  try {
    // 一个文件一个请求：进度是真实的 N/M，而且某个文件坏了不会把整批带崩。
    const merged = { batchId: "", files: [], candidates: [], duplicates: { existing: 0, conflict: 0 }, statistics: { files: 0, entries: 0, anomalies: 0 } };
    const failures = [];
    for (const [index, file] of selected.entries()) {
      fileStates.get(file.name).status = "running";
      renderImportFileList($("#importFileList"), selected, fileStates);
      progress(`正在预检 ${index + 1} / ${selected.length}：${file.name}`, Math.round((index / selected.length) * 100));
      try {
        const result = await api("/api/assets-import/preview", { method: "POST", body: JSON.stringify({
          ...projectPayload(),
          // 类型决定要不要在预检里比对库内术语：选"人工 TM"时服务端不做这项开销。
          purpose: state.assetImportPurpose,
          files: [{ filename: file.name, base64: await fileToBase64(file) }]
        }) });
        if (!merged.batchId) merged.batchId = result.batchId;
        merged.files.push(...(result.files || []));
        merged.candidates.push(...(result.candidates || []));
        merged.duplicates.existing += result.duplicates?.existing || 0;
        merged.duplicates.conflict += result.duplicates?.conflict || 0;
        merged.statistics.files += result.files?.length || 0;
        merged.statistics.entries += result.statistics?.entries || 0;
        merged.statistics.anomalies += result.statistics?.anomalies || 0;
        fileStates.get(file.name).status = "done";
        fileStates.get(file.name).entries = result.statistics?.entries || 0;
      } catch (error) {
        failures.push({ filename: file.name, error: error.message });
        merged.files.push({ filename: file.name, type: "invalid", entries: 0, anomalies: [error.message], defaultPurpose: "term" });
        merged.statistics.files += 1;
        merged.statistics.anomalies += 1;
        fileStates.get(file.name).status = "failed";
        fileStates.get(file.name).error = error.message;
      }
      renderImportFileList($("#importFileList"), selected, fileStates);
    }
    progress(`预检完成：${selected.length - failures.length} / ${selected.length} 个文件，共 ${merged.statistics.entries} 条双语条目`, 100);
    state.assetPreflight = { ...merged, failures };
    // 上一轮提交把弹窗切成了"关闭窗口，后台继续"并收起候选表；新一轮预检必须复位，
    // 否则用户第二次导入时弹窗里根本没有确认按钮。
    resetAssetPreflightSubmitState();
    renderAssetPreflight();
    resetAssetImportProgress();
    $("#assetPreflightDialog").showModal();
    if (fromWizard) {
      // 向导必须等用户处理完预检弹窗再推进，否则会在弹窗后面偷偷跳过这一步。
      return await new Promise((resolve) => { assetPreflightDeferred = { resolve }; });
    }
    return { submitted: false };
  } catch (error) {
    $("#importFileList").hidden = false;
    $("#fileMeta").textContent = `预检中断：${error.message}`;
    updateImportProgress({ message: `预检中断：${error.message}`, percent: 100 });
    toast(error.message);
    return { submitted: false };
  }
}

function readImportPurpose() {
  const checked = $$('input[name="importPurpose"]').find((input) => input.checked);
  return checked?.value === "tm" ? "tm" : "term";
}

function readImportAiCleaning() {
  return Boolean($("#importAiCleaning")?.checked);
}

function readImportStyleEvidence() {
  return Boolean($("#importStyleEvidence")?.checked);
}

/**
 * 类型选择联动：AI 清洗只对术语表有意义（人工 TM 本来就已人工确认），
 * 风格证据则默认跟着类型走（人工 TM 默认写、术语表默认不写）。
 */
function syncImportPurposeControls({ resetDefaults = false } = {}) {
  const purpose = readImportPurpose();
  state.assetImportPurpose = purpose;
  const aiRow = $("#importAiCleaningRow");
  if (aiRow) aiRow.hidden = purpose !== "term";
  // 人工 TM 是整批进 TM：术语库那一栏留着会让人以为还能分开选，直接收起。
  const termRow = $("#importTermLibraryRow");
  if (termRow) termRow.hidden = purpose !== "term";
  if (resetDefaults) {
    if ($("#importAiCleaning")) $("#importAiCleaning").checked = false;
    if ($("#importStyleEvidence")) $("#importStyleEvidence").checked = purpose === "tm";
  }
}

/** 预检弹窗的收尾：向导要等它关掉才知道这一步到底提交了什么。 */
let assetPreflightDeferred = null;
let assetPreflightOutcome = null;

function resolveAssetPreflight() {
  const deferred = assetPreflightDeferred;
  assetPreflightDeferred = null;
  if (deferred) deferred.resolve(assetPreflightOutcome || { submitted: false });
}

function closeAssetPreflightDialog() {
  const dialog = $("#assetPreflightDialog");
  if (dialog?.open) dialog.close();
  resolveAssetPreflight();
  // 关掉之后要留一条能再打开的入口，否则用户只能去猜顶部按钮会变文案。
  refreshActions();
}

function resetAssetImportProgress() {
  const container = $("#assetImportProgress");
  if (!container) return;
  container.hidden = true;
  $("#assetImportProgressBar").style.width = "0%";
}

/**
 * 预检弹窗的"还没提交"界面状态。提交成功后确认按钮会被隐藏、换成"关闭窗口"，
 * 候选表也会收起；下一轮预检必须回到可确认的状态，不能沿用上一轮的结果。
 */
function resetAssetPreflightSubmitState() {
  const confirm = $("#assetPreflightConfirm");
  if (confirm) {
    confirm.hidden = false;
    confirm.disabled = false;
    confirm.textContent = "确认并继续";
  }
  const close = $("#assetPreflightClose");
  if (close) close.hidden = true;
  const tableWrap = $("#assetPreflightTableWrap");
  if (tableWrap) tableWrap.hidden = false;
}

function updateAssetImportProgress(progress = {}) {
  const container = $("#assetImportProgress");
  if (!container) return;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  container.hidden = false;
  const elapsed = state.assetImportStartedAt ? ` · 已用时 ${((Date.now() - state.assetImportStartedAt) / 1000).toFixed(1)} 秒` : "";
  $("#assetImportProgressText").textContent = `${progress.message || "正在导入"}${progress.status === "completed" || progress.status === "failed" ? "" : elapsed}`;
  $("#assetImportProgressMeta").textContent = `${percent}%`;
  $("#assetImportProgressBar").style.width = `${percent}%`;
  container.classList.toggle("is-failed", progress.status === "failed");
}

/** 提交与执行期间让"已用时"持续走动：静止的界面让人以为卡死了。 */
function startAssetImportTicker() {
  stopAssetImportTicker();
  state.assetImportTicker = window.setInterval(() => {
    if (!state.assetImportProgress) return;
    updateAssetImportProgress(state.assetImportProgress);
  }, 500);
}

function stopAssetImportTicker() {
  if (state.assetImportTicker) window.clearInterval(state.assetImportTicker);
  state.assetImportTicker = 0;
}

function rememberAssetImportProgress(progress) {
  state.assetImportProgress = { ...(state.assetImportProgress || {}), ...progress };
  updateAssetImportProgress(state.assetImportProgress);
}

function renderAssetPreflight() {
  const preview = state.assetPreflight;
  if (!preview) return;
  // 已经提交过的批次不能再用"确认后进入后台导入"的文案：任务在服务端跑，
  // 这里改出来的去向只对下一次导入有效，摘要必须说清楚当前这一批去了哪里。
  const submitted = assetPreflightOutcome?.submitted === true;
  const submittedLabel = submitted ? assetPreflightOutcome.destinationLabel || importDestinationLabel(assetPreflightOutcome.purpose) : "";
  renderAssetPreflightDestination();
  const aiRow = $("#assetPreflightAiRow");
  if (aiRow) aiRow.hidden = state.assetImportPurpose !== "term";
  if ($("#assetPreflightAiCleaning")) $("#assetPreflightAiCleaning").checked = state.assetImportAiCleaning;
  if ($("#assetPreflightStyleEvidence")) $("#assetPreflightStyleEvidence").checked = state.assetImportStyleEvidence;
  const purposeLabel = submitted ? submittedLabel : importDestinationLabel();
  $("#assetPreflightBody").innerHTML = (preview.files || []).map((file) => {
    const duplicates = file.duplicates || {};
    const duplicateBadges = [
      duplicates.existing ? `<span class="badge neutral">库内已存在 ${Number(duplicates.existing)}</span>` : "",
      duplicates.conflict ? `<span class="badge warning">与库内译法冲突 ${Number(duplicates.conflict)}</span>` : ""
    ].filter(Boolean).join("");
    return `<tr><td>${escapeHtml(file.filename)}</td><td>${escapeHtml(file.type || "未知")}</td><td>${Number(file.entries) || 0}</td><td>${escapeHtml(purposeLabel)}</td><td><small>${escapeHtml((file.anomalies || []).join("；") || "未发现异常")}${state.assetImportStyleEvidence ? " · 写入风格证据" : ""}</small>${duplicateBadges ? `<div class="preflight-duplicate-flags">${duplicateBadges}</div>` : ""}</td></tr>`;
  }).join("") || '<tr><td colspan="5" class="table-empty">没有可预检的文件</td></tr>';
  const cleaningText = state.assetImportPurpose === "tm"
    ? "不调用模型"
    : state.assetImportAiCleaning ? "AI 清洗（较慢）" : "不调用模型，按本地规则分流";
  const duplicates = preview.duplicates || {};
  // 预检就讲清楚库里已经有什么：同对照会跳过，冲突不覆盖，两者都要用户先知道。
  const duplicateText = duplicates.existing || duplicates.conflict
    ? ` 其中库内已存在相同对照 ${duplicates.existing || 0} 条（入库时跳过）、与库内译法冲突 ${duplicates.conflict || 0} 条（不会覆盖库内条目，要改用术语库页面手动改）。`
    : "";
  $("#assetPreflightSummary").textContent = submitted
    ? `已提交后台导入：${preview.files?.length || 0} 个文件、${Number(assetPreflightOutcome.count) || 0} 条双语条目。去向：${submittedLabel}；${assetPreflightOutcome.aiCleaning ? "先做 AI 清洗再入库" : "按本地规则分流写入"}。可以关掉这个窗口，进度与结果在任务中心可查。`
    : `已识别 ${preview.files?.length || 0} 个文件、${preview.statistics?.entries || 0} 条双语条目。去向：${purposeLabel}；${cleaningText}。${duplicateText}确认后进入后台导入。`;
  const termLibrary = libraryById("term", state.importTermLibraryId);
  const tmLibrary = libraryById("tm", state.importTmLibraryId);
  const targetParts = state.assetImportPurpose === "tm"
    ? [`人工 TM → ${tmLibrary?.name || "主 TM"}`]
    : [`术语 → ${termLibrary?.name || "默认术语库"}`, `句段 → ${tmLibrary?.name || "主 TM"}`];
  $("#assetPreflightTarget").textContent = submitted
    ? `目标库：${submittedLabel}。这一批已经提交，改选只影响下一次导入。`
    : `目标库：${targetParts.join(" · ")}。下面的去向可以在这里直接改；缺库时点「＋ 新增库」，新增和优先级都在同一个面板里。`;
}

/**
 * 预检弹窗里的去向控件：类型单选 + 目标库下拉，和页面上的选择共用同一份 state。
 * 之前这里只有一行只读文字，用户必须退回上一页才能换库，也没法在这里改类型。
 */
function renderAssetPreflightDestination() {
  const purpose = state.assetImportPurpose === "tm" ? "tm" : "term";
  $$('input[name="assetPreflightPurpose"]').forEach((input) => { input.checked = input.value === purpose; });
  const termRow = $("#assetPreflightTermLibraryRow");
  if (termRow) termRow.hidden = purpose !== "term";
  state.importTermLibraryId = fillLibrarySelect($("#assetPreflightTermLibrary"), state.assetLibraries, state.importTermLibraryId) || state.importTermLibraryId;
  state.importTmLibraryId = fillLibrarySelect($("#assetPreflightTmLibrary"), state.memoryLibraries, state.importTmLibraryId, true) || state.importTmLibraryId;
  // 页面上的下拉与提示一起跟着走：关掉弹窗后看到的目标就是刚改过的那个。
  if ($("#importTermLibrary")) $("#importTermLibrary").value = state.importTermLibraryId;
  if ($("#importTmLibrary")) $("#importTmLibrary").value = state.importTmLibraryId;
  const pageTermRow = $("#importTermLibraryRow");
  if (pageTermRow) pageTermRow.hidden = purpose !== "term";
}

/**
 * 预检里的"去向"必须写清写进哪个库：选了参考 TM 却按角色笼统写成"主 TM"，
 * 那是在描述另一件事——用户会以为选择没生效。
 */
function importDestinationNames() {
  return {
    termName: libraryById("term", state.importTermLibraryId)?.name || "默认术语库",
    tmName: libraryById("tm", state.importTmLibraryId)?.name || "主 TM"
  };
}

function importDestinationLabel(purpose = state.assetImportPurpose) {
  const { termName, tmName } = importDestinationNames();
  return purpose === "tm"
    ? `人工终稿 → 「${tmName}」`
    : `短词条 → 「${termName}」；句段 → 「${tmName}」`;
}

/**
 * 预检关掉之后的续入口：一个文件已经预检过，页面就得留一条"还没确认"的提示，
 * 而不是只在顶部主按钮上换个文案。
 */
function renderImportResume() {
  const banner = $("#importPreflightResume");
  if (!banner) return;
  const preview = state.assetPreflight;
  const dialogOpen = $("#assetPreflightDialog")?.open === true;
  banner.hidden = !preview || dialogOpen;
  if (banner.hidden) return;
  const submitted = assetPreflightOutcome?.submitted === true;
  const files = preview.files?.length || 0;
  const entries = preview.statistics?.entries || 0;
  const { termName, tmName } = importDestinationNames();
  $("#importPreflightResumeTitle").textContent = submitted
    ? `已提交后台导入：${files} 个文件、${entries} 条双语条目`
    : `预检结果还没确认：${files} 个文件、${entries} 条双语条目`;
  $("#importPreflightResumeMeta").textContent = submitted
    ? "进度与结果在任务中心可查；这里可以再看一眼这次的去向与跳过明细。"
    : state.assetImportPurpose === "tm" ? `确认后整批写入「${tmName}」。` : `确认后短词条写入「${termName}」，完整句段写入「${tmName}」。`;
  $("#importPreflightResumeOpen").textContent = submitted ? "查看预检结果" : "打开导入预检";
  $("#importPreflightResumeReset").hidden = submitted;
  // 已经提交到后台的导入不能从这里"取消"（任务在服务端跑，去任务中心中断）；未确认的才可以放弃。
  $("#importPreflightCancel").hidden = submitted;
}

function reopenAssetPreflight() {
  const dialog = $("#assetPreflightDialog");
  if (!dialog || !state.assetPreflight) return;
  if (!dialog.open) dialog.showModal();
  renderImportResume();
}

/**
 * 放弃这次导入：预检结果、已选文件与进度都清掉，拖入区回到能重新选文件的状态。
 * 只处理"还没提交"的情况——已经进了后台任务的导入要去任务中心中断。
 */
function cancelAssetImport() {
  if (state.assetImportTaskId && assetPreflightOutcome?.submitted === true) return;
  state.assetPreflight = null;
  state.assetImportProgress = null;
  state.assetImportTaskId = "";
  assetPreflightOutcome = null;
  state.importFiles = [];
  state.importFile = null;
  state.importPreview = null;
  state.importCompleted = false;
  $("#filePrompt").textContent = "拖入或点击选择双语资产文件";
  $("#fileMeta").textContent = `支持多选 .xlsx / .csv / .xliff / .mqxliff，单个文件不超过 ${UPLOAD_FILE_LABEL}；先本地预检，再确认导入`;
  $("#dropZone").classList.remove("has-file");
  $("#importFileList").hidden = true;
  $("#importFileList").innerHTML = "";
  resetAssetImportProgress();
  refreshActions();
  toast("已取消这次导入，可以重新选文件");
}

async function confirmAssetPreflight() {
  const preview = state.assetPreflight;
  if (!preview) return;
  const candidates = (preview.candidates || []).map((candidate) => ({ ...candidate, selected: candidate.selected !== false }));
  if (!candidates.length) return toast("没有可入库的双语条目");
  const purpose = state.assetImportPurpose;
  // 弹窗里的勾选是最终生效值（预检弹窗可能来自术语库/记忆库页面，那里没有前置选择器）。
  const aiCleaning = purpose === "term" && Boolean($("#assetPreflightAiCleaning")?.checked);
  const styleEvidence = Boolean($("#assetPreflightStyleEvidence")?.checked);
  state.assetImportAiCleaning = aiCleaning;
  state.assetImportStyleEvidence = styleEvidence;
  try {
    // 点下确认就立刻切成进度视图：这次请求只创建后台任务，但用户不该盯着灰按钮猜。
    state.assetImportStartedAt = Date.now();
    state.assetImportProgress = { phase: "submitting", message: "正在创建后台导入任务…", percent: 0 };
    updateAssetImportProgress(state.assetImportProgress);
    startAssetImportTicker();
    $("#assetPreflightConfirm").disabled = true;
    $("#assetPreflightConfirm").textContent = "提交中…";
    $("#assetPreflightSummary").textContent = `正在创建后台导入任务：${candidates.length} 条条目、${state.importFiles?.length || 0} 个文件。任务一旦创建，关掉这个窗口也会继续跑完。`;
    const result = await api("/api/assets-import/commit", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId: preview.batchId,
      filename: state.importFile?.name || "双语资产导入",
      candidates,
      purpose,
      aiCleaning,
      styleEvidence,
      termLibraryId: state.importTermLibraryId || "",
      tmLibraryId: state.importTmLibraryId || ""
    }) });
    const returnView = state.assetImportReturnView;
    const accepted = Number(result.accepted) || candidates.length;
    state.assetImportTaskId = result.taskId || result.backgroundTaskId || "";
    assetPreflightOutcome = {
      submitted: true,
      taskId: state.assetImportTaskId,
      batchId: result.batchId || preview.batchId,
      count: accepted,
      files: state.importFiles?.length || 0,
      aiCleaning,
      purpose,
      // 提交时的去向要冻结下来：之后再改下拉，摘要也不能换成别的库。
      destinationLabel: importDestinationLabel(purpose)
    };
    $("#assetPreflightConfirm").hidden = true;
    $("#assetPreflightClose").hidden = false;
    if (returnView) $("#assetPreflightTableWrap").hidden = true;
    rememberAssetImportProgress({ status: "running", message: aiCleaning ? "任务已创建：先写审核队列，再做 AI 清洗" : "任务已创建：先写审核队列，再按表导入", percent: 1 });
    toast(`已开始后台导入 ${accepted} 条；可以关掉这个窗口继续下一步`);
    renderAssetPreflight();
    watchAssetImportTask(state.assetImportTaskId, { returnView }).catch(() => {});
  } catch (error) {
    stopAssetImportTicker();
    rememberAssetImportProgress({ status: "failed", message: `创建后台任务失败：${error.message}`, percent: 0 });
    $("#assetPreflightConfirm").disabled = false;
    $("#assetPreflightConfirm").textContent = "确认并继续";
    toast(error.message);
  }
}

/**
 * 后台导入的进度与收尾。页面被关掉也没关系：任务在服务端继续跑，
 * 任务中心会保留进度与跳过明细。
 */
async function watchAssetImportTask(taskId, { returnView = "" } = {}) {
  if (!taskId) return;
  let finished = false;
  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    let task = null;
    try {
      task = await api(`/api/background-tasks/${encodeURIComponent(taskId)}`);
    } catch { finished = true; break; }
    if (!task) { finished = true; break; }
    rememberAssetImportProgress({ status: task.status, ...(task.progress || {}) });
    if (task.status === "completed" || task.status === "failed" || task.status === "needs_attention") {
      finished = true;
      stopAssetImportTicker();
      const summary = task.payload?.summary;
      if (task.status === "completed") {
        const skipped = Number(summary?.skipped) || 0;
        const text = `导入完成：术语 ${summary?.terms || 0} 条、主 TM ${summary?.memories || 0} 条${skipped ? `、跳过 ${skipped} 条（${Object.entries(summary?.skippedByReason || {}).map(([reason, count]) => `${reason} ${count}`).join("；")}）` : ""}。`;
        $("#mappingNote").textContent = text;
        toast(text);
        await Promise.all([loadAssets(state.assetLocale), loadMemories(state.memoryLocale)]);
      } else {
        $("#mappingNote").textContent = `后台导入未完成：${task.progress?.message || task.payload?.error || "未知原因"}。可在任务中心点「继续导入」补齐。`;
        toast("后台导入未完成，可在任务中心继续导入");
      }
      if (returnView) switchView(returnView);
    }
  }
}

/** 已选的人工 TM 文件列表 + 逐文件预检状态。 */
function renderMemoryImportFiles(states = new Map()) {
  const container = $("#memoryImportFiles");
  const files = state.memoryImportFiles.length ? state.memoryImportFiles : [state.memoryImportFile].filter(Boolean);
  if (!container) return;
  const button = $("#memoryImportButton");
  if (button) button.textContent = files.length > 1 ? `预检 ${files.length} 个文件` : "预检 TM";
  renderImportFileList(container, files, states);
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const UPLOAD_FILE_BYTES = 32 * 1024 * 1024;
const UPLOAD_FILE_LABEL = String(Math.round(UPLOAD_FILE_BYTES / (1024 * 1024))) + "MB";
/** 兼容旧名字：预检与上传共用同一个单文件上限。 */
const MEMORY_IMPORT_FILE_BYTES = UPLOAD_FILE_BYTES;
/** 一次最多选多少个文件：预检是逐文件的，这里只是防止误拖几百个文件把界面卡住。 */
const IMPORT_MAX_FILES = 200;

/** 只挑出超限的文件（文件名 → 原因）：一个 22MB 的文件不该让同批其它文件都导不进来。 */
function oversizedMemoryImportFiles(files) {
  return new Map(files
    .filter((file) => file.size > MEMORY_IMPORT_FILE_BYTES)
    .map((file) => [file.name, `超过单文件 ${UPLOAD_FILE_LABEL} 上限（${formatBytes(file.size)}）`]));
}

/** 记忆库页行内「导入」：目标库固定为这一行，打开弹窗再选文件（预检 → 确认写库）。 */
function openMemoryImportDialog(libraryId) {
  const library = libraryById("tm", libraryId);
  state.memoryImportTargetId = String(libraryId || "");
  state.memoryImportFiles = [];
  state.memoryImportFile = null;
  state.memoryImportPreview = null;
  const picker = $("#memoryFile");
  if (picker) picker.value = "";
  $("#memoryImportTarget").textContent = library
    ? `目标库：${library.name}（${libraryRoleLabel("tm", library)} · 优先级 ${Number(library.priority) || 1}）`
    : "目标库：主 TM";
  $("#memoryImportButton").disabled = true;
  $("#memoryImportButton").textContent = "预检 TM";
  renderMemoryImportFiles();
  $("#memoryImportNote").textContent = `选择文件后会自动本地预检（不调用模型）；确认后写入「${library?.name || "主 TM"}」，并自动接回当前项目中可唯一定位的原翻译轨迹。`;
  $("#memoryImportPreview").hidden = true;
  $("#memoryImportPreviewBody").innerHTML = "";
  $("#memoryImportCount").textContent = "已显示 0 / 共 0 条";
  $("#memoryImportMore").hidden = true;
  $("#memoryImportProgress").hidden = true;
  $("#memoryImportDialog").showModal();
}

/** 预检列表每页条数：8 万条候选不能一次性铺进 DOM，也不能一次性发给浏览器。 */
const MEMORY_IMPORT_PAGE = 200;

function renderMemoryImportRows() {
  const preview = state.memoryImportPreview;
  if (!preview) return;
  // 条目 ID 列优先显示 memoQ 的 x-mmq-context（稳定身份），没有才退回表内序号。
  $("#memoryImportPreviewBody").innerHTML = preview.rows.map((entry) => {
    const candidate = entry.candidate;
    const checked = !preview.deselected.has(entry.globalIndex);
    return `<tr><td><input type="checkbox" data-memory-index="${entry.globalIndex}" ${checked ? "checked" : ""} /></td><td>${escapeHtml(candidate.entryKey || candidate.entryId || "")}</td><td>${escapeHtml(candidate.source)}</td><td>${escapeHtml(candidate.target)}</td><td>${escapeHtml([candidate.sourceFile, candidate.sourceRow ? `第 ${candidate.sourceRow} 行` : ""].filter(Boolean).join(" · "))}</td></tr>`;
  }).join("") || '<tr><td colspan="5" class="table-empty">没有可写入的双语条目</td></tr>';
  $("#memoryImportCount").textContent = `已显示 ${preview.rows.length} / 共 ${preview.total} 条`;
  $("#memoryImportMore").hidden = preview.rows.length >= preview.total;
}

/** 加载更多：候选存在服务端，按页取回来接着渲染，不重复发整份候选。 */
async function loadMoreMemoryImport() {
  const preview = state.memoryImportPreview;
  if (!preview) return;
  const batch = preview.batches.find((item) => item.loaded < item.total);
  if (!batch) return;
  const button = $("#memoryImportMore");
  button.disabled = true;
  try {
    const page = await api(`/api/tm-import/preview/${encodeURIComponent(batch.batchId)}?offset=${batch.loaded}&limit=${MEMORY_IMPORT_PAGE}`);
    const items = Array.isArray(page.items) ? page.items : [];
    items.forEach((candidate, index) => {
      preview.rows.push({ globalIndex: batch.offsetBase + batch.loaded + index, candidate });
    });
    batch.loaded += items.length;
    // 服务端返回空页时收尾，避免"加载更多"永远转圈。
    if (!items.length) batch.loaded = batch.total;
    renderMemoryImportRows();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function previewMemoryImport() {
  const files = state.memoryImportFiles.length ? state.memoryImportFiles : [state.memoryImportFile].filter(Boolean);
  if (!files.length) return;
  const invalid = files.find((file) => !/\.(xlsx|csv|xliff|mqxliff)$/iu.test(file.name));
  if (invalid) return toast(`${invalid.name}：人工 TM 只支持 .xlsx、.csv、.xliff、.mqxliff`);
  if (files.length > IMPORT_MAX_FILES) return toast(`一次最多选择 ${IMPORT_MAX_FILES} 个文件，当前 ${files.length} 个`);
  // 超限只挡它自己：同批其它文件照常预检，不能因为一个超限文件整批失败。
  const oversized = oversizedMemoryImportFiles(files);
  const importable = files.filter((file) => !oversized.has(file.name));
  if (!importable.length) {
    const message = [...oversized.values()][0];
    $("#memoryImportNote").textContent = message;
    renderMemoryImportFiles(new Map(files.map((file) => [file.name, { status: "failed", entries: 0, error: oversized.get(file.name) || "" }])));
    return toast(message);
  }
  try {
    $("#memoryImportButton").disabled = true;
    const startedAt = Date.now();
    const fileStates = new Map(files.map((file) => [file.name, oversized.has(file.name)
      ? { status: "failed", entries: 0, error: oversized.get(file.name) }
      : { status: "pending", entries: 0, error: "" }]));
    renderMemoryImportFiles(fileStates);
    const batches = [];
    const rows = [];
    // 超限文件也记进失败清单：末尾摘要的"N / M 个文件"要把它算上，不能悄悄少一个。
    const failures = [...oversized].map(([filename, error]) => ({ filename, error }));
    let offsetBase = 0;
    let truncated = null;
    for (const [index, file] of importable.entries()) {
      fileStates.get(file.name).status = "running";
      renderMemoryImportFiles(fileStates);
      $("#memoryImportNote").textContent = `正在本地预检 ${index + 1} / ${importable.length}：${file.name} · 已用时 ${elapsedText(startedAt)}（解析表格 / XLIFF，不调用模型）`;
      try {
        const result = await api("/api/tm-import/preview", { method: "POST", body: JSON.stringify({
          ...projectPayload(),
          filename: file.name,
          files: [{ filename: file.name, base64: await fileToBase64(file) }]
        }) });
        const found = Array.isArray(result.candidates) ? result.candidates : [];
        const total = Number(result.total) || found.length;
        batches.push({
          batchId: result.batchId,
          filename: file.name,
          sourceFileType: result.sourceFileType || "",
          total,
          loaded: found.length,
          offsetBase,
          statistics: result.statistics || {}
        });
        found.forEach((candidate, rowIndex) => rows.push({ globalIndex: offsetBase + rowIndex, candidate }));
        offsetBase += total;
        if (result.statistics?.truncated) truncated = { ...result.statistics, file: file.name };
        fileStates.get(file.name).status = "done";
        fileStates.get(file.name).entries = total;
      } catch (error) {
        failures.push({ filename: file.name, error: error.message });
        fileStates.get(file.name).status = "failed";
        fileStates.get(file.name).error = error.message;
      }
      renderMemoryImportFiles(fileStates);
    }
    const preview = {
      filename: files.length === 1 ? files[0].name : `${files[0].name} 等 ${files.length} 个文件`,
      batches,
      rows,
      total: offsetBase,
      deselected: new Set()
    };
    state.memoryImportPreview = preview;
    const evidenceText = state.memoryStyleEvidence ? "确认后同时写入主 TM 与风格学习证据。" : "确认后只写入主 TM，不进入风格证据池。";
    const failureText = failures.length ? `；${failures.length} 个文件未导入：${failures.map((item) => `${item.filename}（${item.error}）`).join("、")}` : "";
    const sampleText = preview.total > rows.length ? `列表先展示前 ${rows.length} 条用于抽查（未展示的同样按默认写入）` : "列表已展示全部条目";
    const truncationText = truncated
      ? `⚠️ ${truncated.file} 共 ${truncated.totalRows} 行，本次只读取前 ${truncated.rowsScanned} 行（单表上限 ${truncated.rowLimit} 行），超出部分没有导入。`
      : "";
    $("#memoryImportNote").textContent = `本地预检识别 ${preview.total} 条双语 TM（来自 ${files.length - failures.length} / ${files.length} 个文件，用时 ${elapsedText(startedAt)}）；${sampleText}；尚未调用模型，也尚未写入数据库${failureText}。${evidenceText}${truncationText ? ` ${truncationText}` : ""}`;
    $("#memoryImportPreview").hidden = false;
    renderMemoryImportRows();
    $("#memoryImportConfirm").disabled = !preview.total;
  } catch (error) {
    $("#memoryImportNote").textContent = `预检失败：${error.message}`;
    toast(error.message);
  } finally {
    $("#memoryImportButton").disabled = false;
  }
}

async function commitMemoryImport() {
  const preview = state.memoryImportPreview;
  if (!preview) return;
  // 只回传批次号 + 未勾选的序号：候选本体留在服务端，避免 8 万条来回搬运。
  const batches = preview.batches.map((batch) => ({
    batchId: batch.batchId,
    filename: batch.filename,
    sourceFileType: batch.sourceFileType,
    deselected: [...preview.deselected]
      .filter((index) => index >= batch.offsetBase && index < batch.offsetBase + batch.total)
      .map((index) => index - batch.offsetBase)
  }));
  const selectedCount = preview.total - preview.deselected.size;
  if (selectedCount <= 0) return toast("请至少选择一条 TM");
  try {
    $("#memoryImportConfirm").disabled = true;
    // 写入改为后台任务：几千条要跑几分钟，界面得有进度、也要允许关页面。
    const started = await api("/api/tm-import/commit", { method: "POST", body: JSON.stringify({ ...projectPayload(), batches, filename: preview.filename, styleEvidence: state.memoryStyleEvidence, tmLibraryId: state.memoryImportTargetId || "", background: true }) });
    const taskId = started.taskId || started.backgroundTaskId;
    $("#memoryImportProgress").hidden = false;
    $("#memoryImportProgressText").textContent = `已提交后台写入 ${started.accepted ?? selectedCount} 条…`;
    const startedAt = Date.now();
    let task = null;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      task = await api(`/api/background-tasks/${encodeURIComponent(taskId)}`).catch(() => null);
      if (!task) break;
      const percent = Math.max(0, Math.min(100, Number(task.progress?.percent) || 0));
      const done = task.status === "completed" || task.status === "failed";
      $("#memoryImportProgressText").textContent = `${task.progress?.message || "正在写入"}${done ? "" : ` · 已用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`}`;
      $("#memoryImportProgressMeta").textContent = `${percent}%`;
      $("#memoryImportProgressBar").style.width = `${percent}%`;
      $("#memoryImportNote").textContent = "写入在后台执行：可以关掉这个页面，进度与结果都能在任务中心查到。";
      if (done) break;
    }
    const summary = task?.payload?.summary;
    const skippedText = Number(summary?.skipped) ? `；跳过 ${summary.skipped} 条` : "";
    const evidenceText = state.memoryStyleEvidence ? "，并已写入风格学习证据池" : "";
    if (task?.status === "completed") {
      const targetName = libraryById("tm", state.memoryImportTargetId)?.name || "目标 TM";
      $("#memoryImportNote").textContent = `TM 已写入「${targetName}」：${summary?.memories ?? 0} 条${evidenceText}；接回原翻译轨迹 ${summary?.trajectoriesLinked || 0} 条${skippedText}。`;
      toast("人工 TM 导入完成");
    } else {
      $("#memoryImportNote").textContent = `后台写入未完成：${task?.progress?.message || "请到任务中心查看"}。可在任务中心点「继续导入」补齐。`;
      toast("后台写入未完成，可在任务中心继续");
    }
    $("#memoryImportPreview").hidden = true;
    state.memoryImportPreview = null;
    await loadAssetsSafeRefresh("tm");
  } catch (error) {
    $("#memoryImportNote").textContent = error.message;
    toast(error.message);
  } finally {
    $("#memoryImportConfirm").disabled = false;
  }
}

function renderMemories() {
  // 搜索已在服务端完成：这里直接渲染服务端返回的这一页，不能再按输入框二次过滤，
  // 否则会把服务端匹配到的条目又筛掉（大小写、全半角等口径不一致）。
  renderLibraryEntries("tm");
}

/** 术语库 / 记忆库共用的库列表与条目视图。kind: "term" | "tm" */
const ENTRY_PAGE_SIZE = 500;

function projectLibraryList(kind) {
  return kind === "term" ? state.assetLibraries : state.memoryLibraries;
}

function libraryById(kind, id) {
  return projectLibraryList(kind).find((library) => library.id === String(id)) || null;
}

function libraryKindLabel(kind) {
  return kind === "term" ? "术语库" : "TM";
}

function libraryRoleLabel(kind, library) {
  if (kind === "term") return "术语库";
  if (library?.role === "master") return "主 TM";
  if (library?.role === "working") return "工作 TM";
  return "参考 TM";
}

function activeLibraryId(kind) {
  return kind === "term" ? state.assetLibraryId : state.memoryLibraryId;
}

function activeEntries(kind) {
  return kind === "term" ? state.assetEntries : state.memories;
}

function entrySearchValue(kind) {
  return ($(kind === "term" ? "#assetSearch" : "#memorySearch")?.value || "").trim();
}

/**
 * 库列表与导入下拉的唯一数据源：项目设置里的资源库 + 实时条目数。
 * 项目设置保存、库开关、删库之后都要重新调用它，保证两处永远一致。
 */
async function loadProjectLibraries() {
  if (!state.activeProjectId) return [];
  const payload = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries?withStats=1`);
  const libraries = Array.isArray(payload.libraries) ? payload.libraries : [];
  state.assetLibraries = libraries.filter((library) => library.kind === "term_base");
  state.memoryLibraries = libraries.filter((library) => library.kind === "translation_memory");
  renderImportTargetOptions();
  return libraries;
}

/**
 * 库下拉共用的填充逻辑：页面上的目标库与预检弹窗里的去向都走这里，
 * 选项文案、未启用标记、默认选中口径必须一致。返回实际选中的库 id。
 */
function fillLibrarySelect(select, libraries, preferredId, preferMaster = false) {
  if (!select) return "";
  select.innerHTML = (libraries || [])
    .map((library) => `<option value="${escapeHtml(library.id)}" ${library.enabled ? "" : "disabled"}>${escapeHtml(library.name)}${library.enabled ? "" : "（未启用）"}</option>`)
    .join("");
  const list = libraries || [];
  const usable = list.find((library) => library.id === String(preferredId || "") && library.enabled)
    || (preferMaster ? list.find((library) => library.role === "master" && library.enabled) : null)
    || list.find((library) => library.enabled)
    || list[0];
  select.value = usable?.id || "";
  return select.value;
}

/** 双语资产导入页的目标库下拉：只列启用中的库作为可选项，默认取主 TM / 首选术语库。 */
function renderImportTargetOptions() {
  state.importTermLibraryId = fillLibrarySelect($("#importTermLibrary"), state.assetLibraries, state.importTermLibraryId) || state.importTermLibraryId;
  state.importTmLibraryId = fillLibrarySelect($("#importTmLibrary"), state.memoryLibraries, state.importTmLibraryId, true) || state.importTmLibraryId;
  renderAssetPreflightDestination();
}

function formatLibraryTime(value) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function libraryRowMarkup(kind, library, index = 0, total = 1) {
  const entries = Number(library.entryCount) || 0;
  const roleLabel = libraryRoleLabel(kind, library);
  const roleClass = kind === "term" ? "term" : (library.role || "reference");
  const id = escapeHtml(library.id);
  const name = escapeHtml(library.name || "未命名资源库");
  // 工作 TM / 主 TM 是按翻译文件往里写的：把"几个文件"直接写在库行上，
  // 不然用户只看到一个总数，不知道里面其实是好几批。
  const fileBadge = kind === "tm" && Number(library.fileCount) > 0
    ? `<span class="library-badge files">${Number(library.fileCount)} 个文件</span>`
    : "";
  return `<tr class="library-row${library.enabled ? "" : " is-disabled"}" data-library-kind="${kind}" data-library-id="${id}">
    <td><label class="library-toggle"><input type="checkbox" data-library-toggle="1" data-kind="${kind}" data-id="${id}" ${library.enabled ? "checked" : ""} aria-label="启用/停用 ${escapeHtml(library.name)}" /><span aria-hidden="true"></span></label></td>
    <td><span class="library-badge ${roleClass}">${escapeHtml(roleLabel)}</span></td>
    <td><strong>${name}</strong>${fileBadge}<small>${escapeHtml(library.latestFile ? `最近：${library.latestFile}` : library.description || "")}</small></td>
    <td>日 → 简中</td>
    <td class="library-count">${entries}</td>
    <td><div class="library-priority"><strong>${Number(library.priority) || 1}</strong><button class="priority-step" type="button" data-library-action="priority" data-direction="up" data-kind="${kind}" data-id="${id}" aria-label="上调 ${name} 的优先级" ${index === 0 ? "disabled" : ""}>↑</button><button class="priority-step" type="button" data-library-action="priority" data-direction="down" data-kind="${kind}" data-id="${id}" aria-label="下调 ${name} 的优先级" ${index >= total - 1 ? "disabled" : ""}>↓</button></div></td>
    <td>${escapeHtml(formatLibraryTime(library.lastEntryAt))}</td>
    <td class="library-actions">
      <button class="button secondary small" type="button" data-library-action="open" data-kind="${kind}" data-id="${id}">打开</button>
      <button class="button ghost small" type="button" data-library-action="import" data-kind="${kind}" data-id="${id}" ${library.enabled ? "" : "disabled"} title="${library.enabled ? "导入到这个库" : "未启用的库不能作为导入目标"}">导入</button>
      <button class="button ghost small" type="button" data-library-action="export" data-kind="${kind}" data-id="${id}">导出</button>
      <button class="button ghost small" type="button" data-library-action="settings" data-kind="${kind}" data-id="${id}">设置</button>
      <button class="button ghost small danger" type="button" data-library-action="delete" data-kind="${kind}" data-id="${id}">删除</button>
    </td></tr>`;
}

function renderLibraryTable(kind) {
  const body = $(kind === "term" ? "#assetLibraryBody" : "#memoryLibraryBody");
  if (!body) return;
  const libraries = projectLibraryList(kind);
  const total = libraries.reduce((sum, library) => sum + (Number(library.entryCount) || 0), 0);
  const mergeRow = `<tr class="library-row is-merge" data-library-kind="${kind}" data-library-id="">
    <td><span class="library-merge-dot" title="合并视图不改变任何库的启用状态"></span></td>
    <td><span class="library-badge merge">合并</span></td>
    <td><strong>全部库（合并视图）</strong><small>把当前语言的 ${libraries.length} 个${libraryKindLabel(kind)}合并查看</small></td>
    <td>日 → 简中</td>
    <td class="library-count">${total}</td>
    <td>—</td><td>—</td>
    <td class="library-actions">
      <button class="button secondary small" type="button" data-library-action="open" data-kind="${kind}" data-id="">打开</button>
      <button class="button ghost small" type="button" data-library-action="export" data-kind="${kind}" data-id="">导出</button>
    </td></tr>`;
  const rows = libraries.map((library, index) => libraryRowMarkup(kind, library, index, libraries.length)).join("");
  body.innerHTML = `${mergeRow}${rows}` || mergeRow;
  // 打开了具体库时表头写的是"已显示 N / 共 M 条"，不要被库列表的总数覆盖。
  if (!activeLibraryId(kind)) {
    if (kind === "term") renderAssetLibrarySummary();
    else renderMemoryLibrarySummary();
  }
}

function renderAssetLibrarySummary() {
  const total = state.assetLibraries.reduce((sum, library) => sum + (Number(library.entryCount) || 0), 0);
  $("#assetRevision").textContent = `${total} 条`;
  $("#assetList").innerHTML = "";
}

function renderMemoryLibrarySummary() {
  const total = state.memoryLibraries.reduce((sum, library) => sum + (Number(library.entryCount) || 0), 0);
  $("#memoryCount").textContent = `${total} 条`;
  const more = $("#memoryMoreBar");
  if (more) more.hidden = true;
  $("#memoryList").innerHTML = "";
}

/** 两级切换：库列表 ↔ 条目视图，面包屑显示当前库。 */
function renderLibraryShell(kind) {
  const libraryId = activeLibraryId(kind);
  const fileId = kind === "tm" ? state.memoryLibraryFile : "";
  const listView = $(kind === "term" ? "#assetLibraryView" : "#memoryLibraryView");
  const filesView = kind === "tm" ? $("#memoryFilesView") : null;
  const entryView = $(kind === "term" ? "#assetEntryView" : "#memoryEntryView");
  const breadcrumb = $(kind === "term" ? "#assetBreadcrumb" : "#memoryBreadcrumb");
  const backButton = $(kind === "term" ? "#assetBreadcrumbBack" : "#memoryBreadcrumbBack");
  const nameNode = $(kind === "term" ? "#assetBreadcrumbName" : "#memoryBreadcrumbName");
  const metaNode = $(kind === "term" ? "#assetBreadcrumbMeta" : "#memoryBreadcrumbMeta");
  const fileNode = kind === "tm" ? $("#memoryBreadcrumbFile") : null;
  const library = libraryId ? libraryById(kind, libraryId) : null;
  // 库里还没有按文件分组的条目时不停在空的文件层，直接进条目（不然是个死胡同）。
  const hasFiles = (state.memoryLibraryFiles || []).length > 0;
  const showFiles = kind === "tm" && Boolean(libraryId) && !fileId && hasFiles;
  if (listView) listView.hidden = Boolean(libraryId);
  if (filesView) filesView.hidden = !showFiles;
  if (entryView) entryView.hidden = !(libraryId && !showFiles);
  if (breadcrumb) breadcrumb.hidden = !libraryId;
  if (backButton) backButton.textContent = fileId ? "← 返回文件列表" : "← 返回库列表";
  if (library) {
    if (nameNode) nameNode.textContent = library.name || "未命名资源库";
    if (metaNode) metaNode.textContent = `${libraryRoleLabel(kind, library)} · ${Number(library.entryCount) || 0} 条 · 日 → 简中 · 优先级 ${Number(library.priority) || 1}`;
  }
  if (fileNode) {
    fileNode.hidden = !fileId;
    fileNode.textContent = fileId ? `当前文件：${fileId === "__none__" ? "未标注来源" : fileId}` : "";
  }
}

/** 库 → 文件 → 条目 的中间层：工作 TM / 主 TM 按翻译文件分开显示。 */
async function loadLibraryFiles(kind, libraryId) {
  const locale = kind === "term" ? state.assetLocale : state.memoryLocale;
  const params = new URLSearchParams({ locale, projectId: state.activeProjectId || "", libraryId });
  const payload = await api(`/api/library-files?${params}`);
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (kind === "tm") state.memoryLibraryFiles = files;
  return files;
}

function renderLibraryFiles(kind) {
  if (kind !== "tm") return;
  const body = $("#memoryFileBody");
  if (!body) return;
  const files = state.memoryLibraryFiles || [];
  // 文件分组只是浏览/导出/清理的维度，会不会影响翻译匹配要看库的角色：
  // 工作 TM 的机器草稿按文件隔离；主 TM / 参考 TM 的匹配永远是整个库（跨文件）。
  const library = libraryById("tm", state.memoryLibraryId);
  const note = $("#memoryFilesNote");
  if (note) {
    note.textContent = library?.role === "working"
      ? "工作 TM 按翻译文件分开：每个文件一批机器译文，只在同一个文件内参与一致性参考；这里的「打开」只看该文件的条目。「翻译进度」来自同名的翻译批次，「学习轨迹」里的人工终稿条数来自审校回填。"
      : "文件分组只用于浏览、导出与清理。翻译匹配取的是整个库（跨全部文件），人工确认译文不受文件限制。「翻译进度」来自同名的翻译批次，「学习轨迹」里的人工终稿条数来自审校回填。";
  }
  body.innerHTML = files.length ? files.map((file) => {
    const key = escapeHtml(file.sourceFile || "__none__");
    const label = file.sourceFile || "未标注来源";
    const progress = libraryFileProgressMarkup(file);
    const learning = libraryFileLearningMarkup(file);
    return `<tr class="library-row" data-file-key="${key}">
      <td><strong>${escapeHtml(label)}</strong>${file.sourceFile ? "" : "<small>单句翻译等没有文件名的条目</small>"}</td>
      <td class="library-count">${Number(file.entryCount) || 0}</td>
      <td>${progress}</td>
      <td>${learning}</td>
      <td>${escapeHtml(formatLibraryTime(file.lastEntryAt))}</td>
      <td class="library-actions">
        <button class="button secondary small" type="button" data-file-action="open" data-key="${key}">打开</button>
        <button class="button ghost small" type="button" data-file-action="export" data-key="${key}">导出</button>
        <button class="button ghost small danger" type="button" data-file-action="delete" data-key="${key}">删除该文件草稿</button>
      </td></tr>`;
  }).join("") : '<tr><td colspan="6" class="table-empty">这个库里还没有按文件分组的条目</td></tr>';
  // 文件数据是异步到的：渲染完要重算一次外壳（有没有文件决定停在文件层还是直接进条目），
  // 否则中途的重绘会按"空文件表"把文件层隐藏掉。
  renderLibraryShell(kind);
}

/**
 * 文件层的第一个问题：这个文件翻到哪一步了。进度取自同名的翻译批次（最近一次）。
 * 双语资产导入的条目没有对应批次——那是"来源不同"，不是"没翻译完"，所以要分开说。
 */
function libraryFileProgressMarkup(file) {
  const batchId = String(file.batch?.batchId || file.batchId || "");
  const batchCount = Number(file.batchCount) || 0;
  const batchHint = batchId
    ? `批次 ${batchId.slice(0, 8)}${batchCount > 1 ? `（共 ${batchCount} 批）` : ""}`
    : "";
  const run = file.batch;
  if (!run) {
    return `<span class="file-state is-unknown">没有翻译批次</span><small>${batchHint ? `${escapeHtml(batchHint)} · 可能来自双语资产导入` : "条目来自双语资产导入"}</small>`;
  }
  const total = Number(run.totalSegments) || 0;
  const done = Number(run.completedSegments) || 0;
  const failed = Number(run.failedSegments) || 0;
  const tone = run.status === "completed" ? "is-done" : run.status === "needs_attention" ? "is-failed" : "is-running";
  const label = run.status === "completed" ? "翻译完成" : taskStatusLabel(run.status);
  return `<span class="file-state ${tone}">${escapeHtml(label)}</span><small>${done} / ${total} 段${failed ? ` · ${failed} 段失败` : ""}${batchHint ? ` · ${escapeHtml(batchHint)}` : ""}</small>`;
}

/** 文件层的第二个问题：有没有人工审校版本回填过（回填会写进轨迹的人工终稿）。 */
function libraryFileLearningMarkup(file) {
  const learning = file.learning || {};
  const count = Number(learning.count) || 0;
  const reviewed = Number(learning.humanReviewed) || 0;
  if (!count) return '<span class="file-state is-unknown">尚无学习轨迹</span><small>双语资产导入只回填已有机器稿；跑过一次批次翻译后才有轨迹</small>';
  return `<span class="file-state ${reviewed ? "is-done" : "is-pending"}">${reviewed ? `已回填人工终稿 ${reviewed} 条` : "未回填人工终稿"}</span><small>学习轨迹 ${count} 条${reviewed ? "" : "（都是机器稿）"}</small>`;
}

async function openLibraryFile(kind, fileKey) {
  if (kind !== "tm") return;
  state.memoryLibraryFile = String(fileKey || "");
  renderLibraryShell(kind);
  const search = $("#memorySearch");
  if (search) search.value = "";
  await loadLibraryEntries("tm", { append: false });
}

async function closeLibraryFile(kind) {
  if (kind !== "tm") return;
  state.memoryLibraryFile = "";
  renderLibraryShell(kind);
  // 先用已有数据把文件列表画出来（切换要立刻生效），刷新在后台做。
  renderLibraryFiles(kind);
  loadLibraryFiles(kind, state.memoryLibraryId)
    .then(() => renderLibraryFiles(kind))
    .catch(() => {});
}

/** 删掉某个文件在这个库里产生的条目（工作 TM 的按批次清理）。 */
async function deleteLibraryFile(kind, fileKey) {
  const file = (state.memoryLibraryFiles || []).find((item) => (item.sourceFile || "__none__") === fileKey);
  const label = file?.sourceFile || "未标注来源";
  const count = Number(file?.entryCount) || 0;
  const choice = await openChoiceDialog({
    kicker: "DELETE FILE ENTRIES",
    title: `删除「${label}」的条目`,
    summary: `这会删除该文件在这个库里的 ${count} 条条目（例如工作 TM 里这个文件产生的机器译文）。其它文件的条目不受影响。`,
    options: [
      { id: "delete", label: `删除这 ${count} 条`, hint: "只删这个文件在这个库里的条目，别的文件不动" },
      { id: "cancel", label: "取消", hint: "什么都不做" }
    ]
  });
  if (choice !== "delete") return;
  const locale = state.memoryLocale;
  await api(`/api/library-entries?locale=${encodeURIComponent(locale)}&kind=${kind}&projectId=${encodeURIComponent(state.activeProjectId)}&libraryId=${encodeURIComponent(state.memoryLibraryId)}&sourceFile=${encodeURIComponent(fileKey)}`, { method: "DELETE" });
  toast(`已删除「${label}」的 ${count} 条条目`);
  await loadAssetsSafeRefresh("tm");
  await closeLibraryFile("tm");
}

async function loadLibraryEntries(kind, { append = false } = {}) {
  const libraryId = activeLibraryId(kind);
  const locale = kind === "term" ? state.assetLocale : state.memoryLocale;
  const params = new URLSearchParams({ locale, kind, limit: String(ENTRY_PAGE_SIZE), search: entrySearchValue(kind) });
  if (state.activeProjectId) params.set("projectId", state.activeProjectId);
  if (libraryId) params.set("libraryId", libraryId);
  // TM 库停在文件列表时不取条目；打开某个文件后只取这个文件的行。
  if (kind === "tm" && state.memoryLibraryFile) params.set("sourceFile", state.memoryLibraryFile);
  if (append) params.set("offset", String(activeEntries(kind).length));
  const payload = await api(`/api/library-entries?${params}`);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (kind === "term") {
    state.assetEntries = append ? [...state.assetEntries, ...items] : items;
    state.assetEntryTotal = Number(payload.total) || 0;
  } else {
    state.memories = append ? [...state.memories, ...items] : items;
    state.memoryEntryTotal = Number(payload.total) || 0;
  }
  renderLibraryEntries(kind);
  renderEntryCount(kind);
}

function renderEntryCount(kind) {
  if (kind === "term") {
    const loaded = state.assetEntries.length;
    const total = Math.max(state.assetEntryTotal, loaded);
    $("#assetRevision").textContent = loaded < total ? `已显示 ${loaded} / 共 ${total} 条` : `${total} 条`;
    const more = $("#assetMoreBar");
    if (more) {
      more.hidden = loaded >= total;
      if (loaded < total) $("#assetMoreMeta").textContent = `还有 ${total - loaded} 条未显示`;
    }
    return;
  }
  const loaded = state.memories.length;
  const total = Math.max(state.memoryEntryTotal, loaded);
  $("#memoryCount").textContent = loaded < total ? `已显示 ${loaded} / 共 ${total} 条` : `${total} 条`;
  const more = $("#memoryMoreBar");
  if (more) {
    more.hidden = loaded >= total;
    if (loaded < total) $("#memoryMoreMeta").textContent = `还有 ${total - loaded} 条未显示`;
  }
}

function entriesEmptyText(kind) {
  return entrySearchValue(kind) ? "当前筛选没有条目" : `这个${libraryKindLabel(kind)}里还没有条目`;
}

function renderLibraryEntries(kind) {
  const items = activeEntries(kind);
  if (kind === "term") {
    $("#assetList").innerHTML = items.length ? items.map((term) => `
      <div class="asset-row" data-entry-id="${escapeHtml(term.id)}"><div class="asset-row-main"><strong>${escapeHtml(term.source)}</strong><span class="arrow">→</span><strong>${escapeHtml(term.target)}</strong><div class="asset-meta"><span>${escapeHtml(libraryById("term", term.libraryId)?.name || "正式术语")}</span>${(term.contentTypes || []).map((type) => `<span>${escapeHtml(state.bootstrap.contentTypes[type]?.label || type)}</span>`).join("")}${term.provenance ? `<span>${escapeHtml(term.provenance)}</span>` : ""}</div>${String(term.note || "").trim() ? `<p class="asset-note" title="${escapeHtml(term.note)}"><em>注释</em>${escapeHtml(term.note)}</p>` : ""}</div><div class="asset-row-actions"><button class="button ghost small" type="button" data-term-action="edit" data-id="${escapeHtml(term.id)}">编辑</button><button class="button ghost small danger" type="button" data-term-action="delete" data-id="${escapeHtml(term.id)}">删除</button></div></div>
    `).join("") : `<div class="empty-list asset-empty">${entriesEmptyText("term")}</div>`;
    return;
  }
  $("#memoryList").innerHTML = items.length ? items.map((item) => `
    <div class="asset-row" data-entry-id="${escapeHtml(item.id)}"><div class="asset-row-main"><strong>${escapeHtml(item.source)}</strong><span class="arrow">→</span><strong>${escapeHtml(item.target)}</strong><div class="asset-meta"><span>${escapeHtml(libraryById("tm", item.libraryId)?.name || (item.qualityStatus === "human_approved" ? "人工确认" : item.qualityStatus === "machine_verified" ? "机器译文" : "候选"))}</span><span>${item.qualityStatus === "human_approved" ? "人工确认" : item.qualityStatus === "machine_verified" ? "机器译文" : "候选"}</span>${item.entryKey ? `<span>${escapeHtml(item.entryKey)}</span>` : ""}${item.sourceFile ? `<span>${escapeHtml(item.sourceFile)}</span>` : ""}${item.batchId ? `<span>批次 ${escapeHtml(String(item.batchId).slice(0, 8))}</span>` : ""}${item.sourceRow ? `<span>第 ${item.sourceRow} 行</span>` : ""}</div></div><div class="asset-row-actions"><button class="button ghost small" type="button" data-memory-action="edit" data-id="${escapeHtml(item.id)}">编辑</button><button class="button ghost small danger" type="button" data-memory-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div></div>
  `).join("") : `<div class="empty-list">${entriesEmptyText("tm")}</div>`;
}

async function openLibrary(kind, libraryId) {
  if (kind === "term") state.assetLibraryId = String(libraryId || "");
  else state.memoryLibraryId = String(libraryId || "");
  // 打开 TM 库先看"来源文件"这一层（工作 TM 的语义就是按文件分开的）；
  // 术语库没有文件语义，直接进条目。
  if (kind === "tm") {
    state.memoryLibraryFile = "";
    state.memoryLibraryFiles = [];
    if (state.memoryLibraryId) {
      try {
        await loadLibraryFiles("tm", state.memoryLibraryId);
      } catch (error) {
        toast(error.message);
      }
    }
    renderLibraryFiles("tm");
  }
  renderLibraryShell(kind);
  const search = $(kind === "term" ? "#assetSearch" : "#memorySearch");
  if (search) search.value = "";
  const showFiles = kind === "tm" && Boolean(state.memoryLibraryId) && (state.memoryLibraryFiles || []).length > 0;
  if (!showFiles) await loadLibraryEntries(kind, { append: false });
}

async function closeLibrary(kind) {
  if (kind === "term") {
    state.assetLibraryId = "";
    state.assetEntries = [];
    state.assetEntryTotal = 0;
  } else {
    state.memoryLibraryId = "";
    state.memoryLibraryFile = "";
    state.memoryLibraryFiles = [];
    state.memories = [];
    state.memoryEntryTotal = 0;
  }
  renderLibraryShell(kind);
  await loadAssetsSafeRefresh(kind);
}

/** 刷新库列表（含实时条目数）；库内条目视图打开时一并刷新。 */
async function loadAssetsSafeRefresh(kind) {
  await loadProjectLibraries();
  renderLibraryTable(kind);
  if (activeLibraryId(kind)) await loadLibraryEntries(kind, { append: false });
  else if (kind === "term") renderAssetLibrarySummary();
  else renderMemoryLibrarySummary();
}

async function toggleLibraryEnabled(kind, libraryId, enabled) {
  const library = libraryById(kind, libraryId);
  if (!library) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries/${encodeURIComponent(libraryId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
  toast(enabled ? `已启用「${library.name}」，它会参与翻译检索` : `已停用「${library.name}」，它不再参与翻译检索`);
  await loadAssetsSafeRefresh(kind);
}

/**
 * 列表里的 ↑ ↓：和项目设置面板同一套口径——先按当前顺序换位，再把同类库的优先级
 * 重新写成连续的 1、2、3…。只改被换动的那几个库，避免整表重写。
 */
async function moveLibraryPriority(kind, libraryId, direction) {
  const libraries = projectLibraryList(kind);
  const index = libraries.findIndex((library) => library.id === String(libraryId));
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= libraries.length) return;
  const ordered = [...libraries];
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const changed = ordered
    .map((library, position) => ({ library, priority: position + 1 }))
    .filter(({ library, priority }) => (Number(library.priority) || 1) !== priority);
  if (!changed.length) return;
  for (const { library, priority } of changed) {
    await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries/${encodeURIComponent(library.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ priority })
    });
  }
  const moved = ordered[target];
  toast(`「${moved.name}」现在是第 ${target + 1} 位`);
  await loadAssetsSafeRefresh(kind);
}

async function deleteLibrary(kind, libraryId) {
  const library = libraryById(kind, libraryId);
  if (!library) return;
  const count = Number(library.entryCount) || 0;
  const choice = await openChoiceDialog({
    kicker: "DELETE LIBRARY",
    title: `删除「${library.name}」`,
    summary: `这个库里现在有 ${count} 条条目。库设置会被删除，你要怎么处理库内条目？`,
    options: [
      { id: "keep", label: "仅删除库", hint: `${count} 条条目保留在数据库里，但不再归属任何库、也不再参与检索` },
      { id: "purge", label: `连条目一起删除（${count} 条）`, hint: "永久删除库内全部条目，无法恢复" }
    ]
  });
  if (!choice) return;
  try {
    if (choice === "purge" && count > 0) {
      const locale = kind === "term" ? state.assetLocale : state.memoryLocale;
      await api(`/api/library-entries?locale=${encodeURIComponent(locale)}&kind=${kind}&projectId=${encodeURIComponent(state.activeProjectId)}&libraryId=${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    }
    await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    if (activeLibraryId(kind) === libraryId) {
      if (kind === "term") state.assetLibraryId = "";
      else state.memoryLibraryId = "";
      renderLibraryShell(kind);
    }
    toast(choice === "purge" ? `已删除「${library.name}」与库内 ${count} 条条目` : `已删除「${library.name}」，库内条目保留但不再归属`);
    await loadAssetsSafeRefresh(kind);
  } catch (error) { toast(error.message); }
}

/** 行内导入：术语走双语资产导入预检，TM 走人工 TM 预检弹窗，目标库就是这一行。 */
function importIntoLibrary(kind, libraryId) {
  const library = libraryById(kind, libraryId);
  if (!library) return;
  if (library.enabled !== true) return toast(`「${library.name}」未启用，不能作为导入目标`);
  if (kind === "term") {
    state.importTermLibraryId = library.id;
    if ($("#importTermLibrary")) $("#importTermLibrary").value = library.id;
    $("#termLibraryFile").click();
    return;
  }
  openMemoryImportDialog(library.id);
}

async function exportLibrary(kind, libraryId, button, sourceFile = "") {
  const library = libraryId ? libraryById(kind, libraryId) : null;
  const fileLabel = sourceFile ? ` · ${sourceFile === "__none__" ? "未标注来源" : sourceFile}` : "";
  const label = `${library ? library.name : `全部${libraryKindLabel(kind)}`}${fileLabel}`;
  if (button) {
    button.disabled = true;
    button.textContent = "提交中…";
  }
  try {
    await api("/api/library-export", {
      method: "POST",
      body: JSON.stringify({
        ...projectPayload(),
        locale: kind === "term" ? state.assetLocale : state.memoryLocale,
        kind,
        libraryId: libraryId || "",
        sourceFile: sourceFile || ""
      })
    });
    toast(`「${label}」导出已进入任务中心，跑完在那里下载 Excel`);
  } catch (error) { toast(error.message); }
  finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导出";
    }
  }
}

function openTermEditDialog(entry) {
  const form = $("#assetForm");
  if (!form || !entry) return;
  form.reset();
  form.source.value = entry.source || "";
  form.target.value = entry.target || "";
  form.aliases.value = (entry.aliases || []).join(", ");
  form.forbidden.value = (entry.forbidden || []).join(", ");
  form.note.value = entry.note || "";
  $("#assetDialogId").value = entry.id;
  $("#assetDialogTitle").textContent = "编辑术语";
  $("#assetDialogSubmit").textContent = "保存修改";
  const library = entry.libraryId ? libraryById("term", entry.libraryId) : null;
  $("#assetDialogTarget").textContent = `所属库：${library?.name || "未归属"} · 修改不会改变库归属`;
  $("#assetDialog").showModal();
}

function resetTermDialog() {
  const form = $("#assetForm");
  if (!form) return;
  form.reset();
  $("#assetDialogId").value = "";
  $("#assetDialogTitle").textContent = "新增单条术语";
  $("#assetDialogSubmit").textContent = "保存到当前语言库";
  const library = state.assetLibraryId ? libraryById("term", state.assetLibraryId) : null;
  $("#assetDialogTarget").textContent = library
    ? `将保存到：${library.name}`
    : "将保存到：项目里优先级最高的启用术语库（想指定库请先在术语库页打开那个库）";
}

async function deleteTermEntry(entry) {
  if (!entry) return;
  if (!confirm(`确认删除术语「${entry.source} → ${entry.target}」？删除后翻译不再参考它。`)) return;
  await api(`/api/assets/${encodeURIComponent(entry.id)}?locale=${encodeURIComponent(state.assetLocale)}&projectId=${encodeURIComponent(state.activeProjectId || "")}`, { method: "DELETE" });
  toast("已删除术语");
  await loadAssetsSafeRefresh("term");
}

function openMemoryEntryDialog(entry) {
  const form = $("#memoryEntryForm");
  if (!form || !entry) return;
  form.reset();
  form.source.value = entry.source || "";
  form.target.value = entry.target || "";
  form.entryKey.value = entry.entryKey || "";
  $("#memoryEntryId").value = entry.id;
  const library = entry.libraryId ? libraryById("tm", entry.libraryId) : null;
  $("#memoryEntryMeta").textContent = [
    `所属库：${library?.name || "未归属"}`,
    entry.qualityStatus === "human_approved" ? "人工确认" : entry.qualityStatus === "machine_verified" ? "机器译文" : "候选",
    entry.sourceFile ? `来源 ${entry.sourceFile}${entry.sourceRow ? ` 第 ${entry.sourceRow} 行` : ""}` : "",
    "修改不会改变库归属"
  ].filter(Boolean).join(" · ");
  $("#memoryEntryDialog").showModal();
}

async function deleteMemoryEntry(entry) {
  if (!entry) return;
  if (!confirm(`确认删除这条 TM 条目？\n${entry.source}\n→ ${entry.target}`)) return;
  await api(`/api/memories/${encodeURIComponent(entry.id)}?locale=${encodeURIComponent(state.memoryLocale)}`, { method: "DELETE" });
  toast("已删除 TM 条目");
  await loadAssetsSafeRefresh("tm");
}

async function setImportFile(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) return toast("请选择 .xlsx 或 .csv 表格");
  if (file.size > UPLOAD_FILE_BYTES) return toast(`表格不能超过 ${UPLOAD_FILE_LABEL}`);
  state.importFile = file;
  state.importPreview = null;
  state.importCompleted = false;
  state.importCandidateTab = "terms";
  state.importVisibleCount = { terms: 150, styles: 150 };
  state.importBatchLearning = [];
  $("#filePrompt").textContent = file.name;
  $("#fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · AI 正在识别表格结构`;
  $("#dropZone").classList.add("has-file");
  $("#mappingNote").textContent = "正在自动识别日语列、简体中文列和无表头数据结构……";
  $("#importSummary").innerHTML = "<span>AI 结构识别中</span>";
  updateImportProgress({ message: "正在上传并解析表格", percent: 2 });
  $("#termImportSummary").innerHTML = "<span>等待术语识别</span>";
  $("#styleImportSummary").innerHTML = "<span>等待译例识别</span>";
  $("#termImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核术语候选</td></tr>';
  $("#styleImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核完整译例</td></tr>';
  $("#importBatchLearningPanel").hidden = true;
  $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
  setImportCandidateTab("terms");
  refreshActions();
  await cleanTable();
}

function resetImport() {
  state.importFile = null;
  state.importFiles = [];
  state.assetPreflight = null;
  state.assetImportIntent = "auto";
  state.assetImportReturnView = "";
  state.assetImportTaskId = "";
  state.assetImportWizard = false;
  assetPreflightOutcome = null;
  state.importPreview = null;
  state.importCompleted = false;
  state.importCandidateTab = "terms";
  state.importVisibleCount = { terms: 150, styles: 150 };
  state.importBatchLearning = [];
  $("#termFile").value = "";
  $("#filePrompt").textContent = "拖入或点击选择双语资产文件";
  $("#fileMeta").textContent = `支持多选 .xlsx / .csv / .xliff / .mqxliff，单个文件不超过 ${UPLOAD_FILE_LABEL}；先本地预检，再确认导入`;
  $("#dropZone").classList.remove("has-file");
  renderImportFileList($("#importFileList"), [], new Map());
  $("#mappingNote").textContent = "拖入表格后会自动识别结构并生成审核队列。";
  $("#importSummary").innerHTML = "<span>尚未清洗</span>";
  $("#importProgress").hidden = true;
  $("#importProgressBar").style.width = "0%";
  $("#termImportSummary").innerHTML = "<span>0 条术语</span>";
  $("#styleImportSummary").innerHTML = "<span>0 条译例</span>";
  $("#termImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有术语候选</td></tr>';
  $("#styleImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有完整译例</td></tr>';
  $("#importBatchLearningPanel").hidden = true;
  $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
  if ($("#assetPreflightDialog")?.open) $("#assetPreflightDialog").close();
  setImportCandidateTab("terms");
  refreshActions();
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decisionLabel(candidate) {
  if (candidate.existing) return ["已存在", "existing"];
  if (candidate.conflict) return ["译法冲突", "review"];
  if (candidate.decision === "ready") return ["可入库", "ready"];
  if (candidate.decision === "review") return ["需复核", "review"];
  return ["已排除", "excluded"];
}

function selectedCandidates() {
  return state.importPreview?.candidates.filter((candidate) => candidate.selected) || [];
}

function importCandidateKind(candidate) {
  const nested = Boolean(candidate?.nested || candidate?.parentCandidateKey || candidate?.parent_candidate_key);
  return candidate?.assetType === "memory" && !nested ? "styles" : "terms";
}

function indexedImportCandidates(kind) {
  return (state.importPreview?.candidates || [])
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => importCandidateKind(candidate) === kind);
}

function setImportCandidateTab(tab) {
  const next = tab === "styles" ? "styles" : "terms";
  state.importCandidateTab = next;
  $$('[data-import-candidate-tab]').forEach((button) => {
    const active = button.dataset.importCandidateTab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const termsPane = $("#importTermsPane");
  const stylesPane = $("#importStylesPane");
  if (termsPane) {
    termsPane.hidden = next !== "terms";
    termsPane.classList.toggle("active", next === "terms");
  }
  if (stylesPane) {
    stylesPane.hidden = next !== "styles";
    stylesPane.classList.toggle("active", next === "styles");
  }
}

function updateCandidateSelectAll(id, entries) {
  const checkbox = $(id);
  if (!checkbox) return;
  const selectable = entries.map(({ candidate }) => candidate).filter((candidate) => !candidate.existing && candidate.decision !== "excluded");
  checkbox.checked = selectable.length > 0 && selectable.every((candidate) => candidate.selected);
  checkbox.indeterminate = selectable.some((candidate) => candidate.selected) && !selectable.every((candidate) => candidate.selected);
}

function updateImportSummary() {
  if (!state.importPreview) return;
  const candidates = state.importPreview.candidates;
  const ai = state.importPreview.ai;
  const terms = indexedImportCandidates("terms");
  const styles = indexedImportCandidates("styles");
  const selected = selectedCandidates();
  $("#importSummary").innerHTML = `
    <span>总候选 <strong>${candidates.length}</strong></span><span>术语 <strong>${terms.length}</strong></span><span>完整译例 <strong>${styles.length}</strong></span><span>已选 <strong>${selected.length}</strong></span><span>${ai?.used ? `AI 已逐条归类 ${ai.reviewed} 条` : ai?.requested ? "AI 不可用 · 已用本地规则" : "本地规则归类"}</span>
  `;
  const nestedCount = terms.filter(({ candidate }) => candidate.nested || candidate.parentCandidateKey || candidate.parent_candidate_key).length;
  const termSelected = terms.filter(({ candidate }) => candidate.selected).length;
  const styleSelected = styles.filter(({ candidate }) => candidate.selected).length;
  const styleScopes = new Set(styles.map(({ candidate }) => `${candidate.locale}\u0000${candidate.contentType || "general"}\u0000${candidate.domain || "general"}`));
  $("#termImportSummary").innerHTML = `<span>术语 <strong>${terms.length}</strong></span><span>句内提取 <strong>${nestedCount}</strong></span><span>已选 <strong>${termSelected}</strong></span><span>需复核 <strong>${terms.filter(({ candidate }) => candidate.decision === "review").length}</strong></span>`;
  $("#styleImportSummary").innerHTML = `<span>完整译例 <strong>${styles.length}</strong></span><span>风格范围 <strong>${styleScopes.size}</strong></span><span>已选 <strong>${styleSelected}</strong></span><span>需复核 <strong>${styles.filter(({ candidate }) => candidate.decision === "review").length}</strong></span>`;
  updateCandidateSelectAll("#selectAllTermCandidates", terms);
  updateCandidateSelectAll("#selectAllStyleCandidates", styles);
}

function renderImportCandidateRows(entries, kind) {
  if (!entries.length) return `<tr><td colspan="6" class="table-empty">${kind === "terms" ? "没有识别到独立或句内术语候选" : "没有识别到可用的完整双语译例"}</td></tr>`;
  const visibleCount = Math.max(150, Number(state.importVisibleCount?.[kind]) || 150);
  const visibleEntries = entries.slice(0, visibleCount);
  const rows = visibleEntries.map(({ candidate, index }) => {
    const [label, className] = decisionLabel(candidate);
    const disabled = candidate.existing || candidate.decision === "excluded" || state.importCompleted;
    const locale = state.bootstrap.locales[candidate.locale] || { shortLabel: candidate.locale, label: candidate.locale };
    const rowLabel = candidate.rowNumber ? `第 ${candidate.rowNumber} 行` : "来源行未知";
    const nested = Boolean(candidate.nested || candidate.parentCandidateKey || candidate.parent_candidate_key);
    const evidenceMeta = nested && Number(candidate.occurrences) > 1 ? ` · ${candidate.occurrences} 条父句证据` : "";
    const meta = kind === "terms"
      ? `${nested ? "句内参考候选" : "正式术语"} · ${candidate.domain || "general"}${evidenceMeta} · ${rowLabel}`
      : `${contentTypeLabel(candidate.contentType || "general")} · ${candidate.domain || "general"} · ${rowLabel}`;
    const sourceEditor = kind === "terms"
      ? `<input class="table-input candidate-source" data-index="${index}" value="${escapeHtml(candidate.source)}" ${disabled ? "disabled" : ""} />`
      : `<textarea class="table-input table-textarea candidate-source" data-index="${index}" rows="2" ${disabled ? "disabled" : ""}>${escapeHtml(candidate.source)}</textarea>`;
    const targetEditor = kind === "terms"
      ? `<input class="table-input candidate-target" data-index="${index}" value="${escapeHtml(candidate.target)}" ${disabled ? "disabled" : ""} />`
      : `<textarea class="table-input table-textarea candidate-target" data-index="${index}" rows="2" ${disabled ? "disabled" : ""}>${escapeHtml(candidate.target)}</textarea>`;
    return `<tr class="candidate-${className}">
      <td class="check-cell"><input class="candidate-check" data-index="${index}" type="checkbox" ${candidate.selected ? "checked" : ""} ${disabled ? "disabled" : ""} /></td>
      <td><span class="locale-tag">${escapeHtml(locale.shortLabel)} · ${escapeHtml(locale.label)}</span><small class="row-ref">${escapeHtml(meta)}</small></td>
      <td>${sourceEditor}</td>
      <td>${targetEditor}</td>
      <td><span class="decision-badge ${className}">${label}</span><small class="score">${Math.round((Number(candidate.score) || 0) * 100)} 分</small></td>
      <td class="reason-cell">${escapeHtml((candidate.reasons || []).join("；") || "短语长度与语言特征通过")}</td>
    </tr>`;
  }).join("");
  if (visibleEntries.length >= entries.length) return rows;
  return `${rows}<tr><td colspan="6" class="table-empty"><button class="button secondary small" data-import-load-more="${kind}">再显示 ${Math.min(150, entries.length - visibleEntries.length)} 条</button><small class="row-ref">已显示 ${visibleEntries.length} / ${entries.length}</small></td></tr>`;
}

function renderImportCandidates() {
  const terms = indexedImportCandidates("terms");
  const styles = indexedImportCandidates("styles");
  $("#termImportCandidates").innerHTML = renderImportCandidateRows(terms, "terms");
  $("#styleImportCandidates").innerHTML = renderImportCandidateRows(styles, "styles");
  $$(".candidate-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.importPreview.candidates[Number(checkbox.dataset.index)].selected = checkbox.checked; updateImportSummary(); }));
  $$(".candidate-source").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].source = input.value.trim(); }));
  $$(".candidate-target").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].target = input.value.trim(); }));
  $$('[data-import-load-more]').forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.importLoadMore;
    state.importVisibleCount[kind] = (Number(state.importVisibleCount[kind]) || 150) + 150;
    renderImportCandidates();
  }));
  if (!indexedImportCandidates(state.importCandidateTab).length && (terms.length || styles.length)) setImportCandidateTab(terms.length ? "terms" : "styles");
  else setImportCandidateTab(state.importCandidateTab);
  updateImportSummary();
}

function normalizeLearningRules(value, instruction = "") {
  const raw = Array.isArray(value) ? value : value ? [value] : splitStyleRules(instruction);
  return raw.map((rule) => {
    if (typeof rule === "string") return { category: "风格规则", text: rule };
    return {
      category: String(rule?.category || rule?.dimension || rule?.type || "风格规则"),
      text: String(rule?.guidance || rule?.instruction || rule?.rule || rule?.observation || rule?.text || "").trim(),
      confidence: Number(rule?.confidence)
    };
  }).filter((rule) => rule.text).slice(0, 12);
}

function normalizeStyleLearningRun(item = {}) {
  const profile = item.profile || item.styleProfile || {};
  const locale = item.locale || item.targetLocale || item.target_locale || profile.locale || profile.targetLocale || profile.target_locale || "";
  const contentType = item.contentType || item.content_type || profile.contentType || profile.content_type || "general";
  const domain = item.domain || profile.domain || "general";
  const instruction = String(item.instruction || item.instructions || profile.instruction || profile.instructions || "").trim();
  const evidenceCount = Number(item.evidenceCount ?? item.evidence_count ?? item.batchEvidenceCount ?? item.batch_evidence_count ?? profile.evidenceCount ?? profile.evidence_count) || 0;
  const profileId = item.profileId || item.profile_id || item.promotedProfileId || item.promoted_profile_id || profile.id || "";
  const profileStatus = item.profileStatus || item.profile_status || profile.status || (profileId ? "draft" : "");
  return {
    ...item,
    locale,
    contentType,
    domain,
    evidenceCount,
    summary: String(item.summary || item.learningSummary || item.learning_summary || item.reason || instruction || "已完成本批风格观察，等待更多同类证据。"),
    rules: normalizeLearningRules(item.rules || item.learnedRules || item.learned_rules, instruction),
    examples: (Array.isArray(item.examples) ? item.examples : Array.isArray(profile.examples) ? profile.examples : []).slice(0, 4),
    confidence: Number(item.confidence ?? item.learningConfidence ?? item.learning_confidence),
    caveat: String(item.caveat || item.limitation || item.warning || ""),
    status: String(item.status || item.learningStatus || item.learning_status || (profileId ? "promoted" : "observed")),
    batchId: String(item.batchId || item.batch_id || ""),
    filename: String(item.filename || item.sourceFile || item.source_file || ""),
    profileId: String(profileId),
    profileName: String(item.profileName || item.profile_name || profile.name || ""),
    profileStatus: String(profileStatus),
    profileVersion: Number(item.profileVersion ?? item.profile_version ?? profile.version) || null
  };
}

function learningRunsFromPayload(payload = {}, { includeProfileFallback = false } = {}) {
  const direct = payload.batchLearning || payload.learningRuns || payload.recentLearningRuns || payload.styleLearningRuns || payload.styleLearning || [];
  if (Array.isArray(direct) && direct.length) return direct.map(normalizeStyleLearningRun);
  if (!includeProfileFallback) return [];
  const profiles = Array.isArray(payload.styleProfiles) ? payload.styleProfiles.map((profile) => normalizeStyleLearningRun({ ...profile, profile, status: profile.status || "promoted" })) : [];
  const pending = Array.isArray(payload.styleFallbacks) ? payload.styleFallbacks.map((item) => normalizeStyleLearningRun({ ...item, status: "collecting", summary: item.reason })) : [];
  return [...profiles, ...pending];
}

function learningStatus(run) {
  const status = String(run.profileStatus || run.status || "").toLowerCase();
  if (status === "active") return ["已启用", "active"];
  if (["draft", "promoted", "ready"].includes(status) || run.profileId) return ["已形成待批准规范", "draft"];
  if (["failed", "error"].includes(status)) return ["学习失败", "error"];
  if (["dismissed", "rejected", "inactive"].includes(status)) return ["已关闭", "inactive"];
  return ["已学习 · 继续积累", "observed"];
}

function renderLearningCards(runs, { showJump = false } = {}) {
  return runs.map((run) => {
    const [statusLabel, statusClass] = learningStatus(run);
    const locale = state.bootstrap.locales[run.locale] || { shortLabel: run.locale || "--", label: run.locale || "未知语言" };
    const rules = run.rules || [];
    const examples = run.examples || [];
    const confidence = Number.isFinite(run.confidence) ? `${Math.round((run.confidence <= 1 ? run.confidence * 100 : run.confidence))}% 置信` : "";
    const profileMeta = run.profileId
      ? `${run.profileName || "风格规范"}${run.profileVersion ? ` v${run.profileVersion}` : ""} · ${run.profileStatus === "active" ? "已启用" : "待批准"}`
      : "尚未形成正式规范";
    const sourceMeta = [run.filename, run.batchId ? `批次 ${run.batchId.slice(0, 8)}` : "", `${run.evidenceCount} 条本批证据`, confidence].filter(Boolean).join(" · ");
    return `<article class="batch-learning-card ${escapeHtml(statusClass)}">
      <div class="batch-learning-head"><div><span class="locale-tag">${escapeHtml(locale.shortLabel)} · ${escapeHtml(locale.label)}</span><strong>${escapeHtml(contentTypeLabel(run.contentType))} · ${escapeHtml(run.domain)}</strong><small>${escapeHtml(sourceMeta || `${run.evidenceCount} 条本批证据`)}</small></div><span class="style-state ${escapeHtml(statusClass)}">${statusLabel}</span></div>
      <p class="batch-learning-summary">${escapeHtml(run.summary)}</p>
      ${rules.length ? `<div class="batch-learning-rules">${rules.map((rule) => `<div><span>${escapeHtml(rule.category)}</span><p>${escapeHtml(rule.text)}</p>${Number.isFinite(rule.confidence) ? `<small>${Math.round((rule.confidence <= 1 ? rule.confidence * 100 : rule.confidence))}%</small>` : ""}</div>`).join("")}</div>` : '<div class="batch-detail-empty">模型没有返回可拆分的规则条目，已保留学习摘要。</div>'}
      ${examples.length ? `<details class="style-examples"><summary>查看 ${examples.length} 个本批代表例句</summary>${examples.map((example) => `<div><strong>${example.type === "negative" ? "反例" : "正例"}</strong><p>${escapeHtml(example.source || "")}</p><p>${escapeHtml(example.target || "")}</p><small>${escapeHtml(example.reason || "")}</small></div>`).join("")}</details>` : ""}
      ${run.caveat ? `<p class="batch-learning-caveat">${escapeHtml(run.caveat)}</p>` : ""}
      <div class="batch-learning-foot"><small>${escapeHtml(profileMeta)}</small><div class="batch-learning-actions">${modelCondenseFailed(run) && run.id ? `<button class="button secondary small" type="button" data-rerun-condense="${escapeHtml(run.id)}">重跑模型浓缩</button>` : ""}${showJump && run.locale ? `<button class="button ghost small style-learning-link" type="button" data-style-learning-locale="${escapeHtml(run.locale)}">查看风格指导</button>` : ""}</div></div>
    </article>`;
  }).join("");
}

function bindStyleLearningLinks(container) {
  container?.querySelectorAll(".style-learning-link").forEach((button) => button.addEventListener("click", () => {
    const locale = button.dataset.styleLearningLocale;
    if (state.bootstrap.locales[locale]) state.styleLocale = locale;
    renderLocaleStrip($("#styleLocales"), state.styleLocale, updateStyleLocale);
    switchView("styles");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  container?.querySelectorAll("[data-rerun-condense]").forEach((button) => button.addEventListener("click", () => rerunBatchCondense(button)));
}

/** 这一批是不是"模型浓缩没成功、只留了本地统计"（据此决定要不要给重跑入口）。 */
function modelCondenseFailed(run) {
  const caveat = String(run?.caveat || "");
  return caveat.includes("模型浓缩失败") || caveat.includes("模型浓缩暂不可用");
}

/** 重跑本批浓缩：模型通了就换成模型产出，仍然失败就把新的失败原因写在卡片上。 */
async function rerunBatchCondense(button) {
  const id = button.dataset.rerunCondense;
  if (!id || button.disabled) return;
  button.disabled = true;
  button.textContent = "重跑中…";
  try {
    const result = await api(`/api/style-learning-runs/${encodeURIComponent(id)}/refresh`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast(result.failed ? `模型浓缩仍然失败：${result.learning?.caveat || "未知原因"}` : "已用模型重新浓缩这一批，记录已更新");
    await loadStyleGuidance(state.styleLocale);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = "重跑模型浓缩";
  }
}

function renderImportBatchLearning() {
  const panel = $("#importBatchLearningPanel");
  const list = $("#importBatchLearningList");
  const runs = state.importBatchLearning || [];
  panel.hidden = !runs.length;
  $("#importBatchLearningCount").textContent = `${runs.length} 个范围`;
  list.innerHTML = runs.length ? renderLearningCards(runs, { showJump: true }) : '<div class="empty-list">本批没有完整译例，因此没有产生风格学习记录。</div>';
  bindStyleLearningLinks(list);
}

function learningArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function learningId(item = {}) {
  return String(item.id || item.skillId || item.skill_id || item.versionId || item.version_id || "");
}

/**
 * 学习中心是项目级的一条流水线：语体与领域只作参考（影响排序与提示词），
 * 不再需要用户选择，也不再隔离资产。这里只判"是不是当前语言 + 当前项目"。
 */
function learningInPipeline() {
  return true;
}

function learningScopeValue() {
  return { contentType: "general", domain: "general" };
}

function learningScopeMatches(item = {}) {
  const locale = item.locale || item.targetLocale || item.target_locale || item.scope?.locale;
  const project = item.project || item.scope?.project;
  const activeProject = state.activeProjectId || "default";
  return (!locale || locale === state.learningLocale)
    && (!project || project === "default" || project === activeProject);
}

/** 候选与生效版本配对：全部视图下要用"该候选自己范围"的生效版本做评测基线。 */
function learningChampionFor(skill, champions = []) {
  const list = learningArray(champions);
  if (!skill) return list[0] || null;
  const contentType = String(skill.contentType || skill.content_type || skill.scope?.contentType || "general");
  const domain = String(skill.domain || skill.scope?.domain || "general");
  return list.find((item) => (String(item.contentType || item.content_type || "general") === contentType)
    && (String(item.domain || item.scope?.domain || "general") === domain)) || list[0] || null;
}

function validLearningTrajectories(items = []) {
  return learningArray(items).filter((item) => learningScopeMatches(item)
    && ["completed", "review"].includes(String(item.status || "").toLowerCase())
    && String(item.finalTranslation || item.final_translation || "").trim());
}

/** 能作为候选技能依据的轨迹：人工采纳过的终稿（与后端 selectProposalTrajectories 同一口径）。 */
function proposalTrajectories(items = []) {
  return validLearningTrajectories(items).filter((item) => item.humanDecision?.accepted === true
    || item.human_decision?.accepted === true);
}

function learningPayload() {
  const payload = state.learningData?.data || state.learningData || {};
  const allSkills = learningArray(payload.skills);
  const champions = learningArray(payload.champions || payload.champion || payload.activeSkill || payload.active_skill)
    .concat(allSkills.filter((skill) => ["active", "champion"].includes(String(skill.status || skill.lifecycle || "").toLowerCase())));
  const explicitCandidates = learningArray(payload.candidates || payload.challengers || payload.candidateSkills || payload.candidate_skills);
  const candidates = explicitCandidates.concat(explicitCandidates.length ? [] : allSkills.filter((skill) => ["draft", "challenger", "candidate", "ready", "evaluated", "evaluating"].includes(String(skill.status || skill.lifecycle || "").toLowerCase())));
  const unique = (items) => [...new Map(items.map((item) => [learningId(item) || JSON.stringify(item), item])).values()];
  // 一个范围一份生效版本：具体范围取那一份，全部视图把范围内的都列出来（逐张标范围）。
  const scopedChampions = unique(champions).filter(learningScopeMatches);
  return {
    payload,
    champion: scopedChampions[0] || null,
    champions: scopedChampions,
    candidates: unique(candidates).filter(learningScopeMatches),
    evaluations: learningArray(payload.evaluations || payload.skillEvaluations || payload.skill_evaluations),
    evidence: learningArray(payload.evidence || payload.trajectories || payload.recentTrajectories || payload.recent_trajectories)
  };
}

function learningStatusMeta(item = {}) {
  const status = String(item.status || item.lifecycle || item.state || "candidate").toLowerCase();
  if (["active", "champion"].includes(status)) return ["生效中", "active"];
  if (["ready", "passed", "evaluated"].includes(status)) return ["评测通过", "ready"];
  if (["evaluating", "running"].includes(status)) return ["评测中", "running"];
  if (["rejected", "dismissed"].includes(status)) return ["已拒绝", "rejected"];
  if (["failed", "blocked"].includes(status)) return ["未通过", "failed"];
  if (["reject", "insufficient"].includes(status)) return [status === "insufficient" ? "证据不足" : "评测未通过", "failed"];
  if (status === "needs_review") return ["证据不足", "insufficient"];
  if (status === "unstable") return ["结果不稳定", "insufficient"];
  if (status === "stale") return ["评测基线已过期", "stale"];
  if (status === "promote") return ["评测通过", "ready"];
  return ["待评测", "candidate"];
}

function learningSkillTitle(skill = {}) {
  const contentType = skill.contentType || skill.content_type || skill.scope?.contentType || skill.scope?.content_type || "general";
  const domain = skill.domain || skill.scope?.domain || "general";
  return skill.name || skill.title || `${contentTypeLabel(contentType)} · ${learningDomainLabel(domain)}`;
}

function learningVersion(skill = {}) {
  const version = skill.version ?? skill.revision ?? skill.skillVersion ?? skill.skill_version;
  return version === undefined || version === null || version === "" ? "未标记版本" : `v${version}`;
}

function learningEvaluationFor(skill, evaluations) {
  const id = learningId(skill);
  return skill.evaluation || evaluations.find((item) => String(item.skillId || item.skill_id || item.candidateId || item.candidate_id || item.challengerSkillId || item.challenger_skill_id || item.challengerId || item.challenger_id || "") === id) || null;
}

function learningRules(skill = {}) {
  const strategy = skill.strategy || {};
  const output = [];
  const instruction = strategy.prompting?.additionalInstruction || strategy.instruction;
  if (instruction) output.push(`增量执行指导：${instruction}`);
  const additionalRules = learningArray(strategy.prompting?.additionalRules || strategy.additionalRules);
  output.push(...additionalRules.map((item) => `增量规则：${String(item)}`));
  if (Number.isFinite(Number(strategy.retrieval?.translationMemory?.limit))) output.push(`相似译例召回上限：${Number(strategy.retrieval.translationMemory.limit)} 条`);
  if (Number.isFinite(Number(strategy.retrieval?.qaCases?.limit))) output.push(`历史 QA 反例召回上限：${Number(strategy.retrieval.qaCases.limit)} 条`);
  if (Number.isFinite(Number(strategy.qa?.minimumScore))) output.push(`AIQA 通过分数：${Number(strategy.qa.minimumScore)} 分`);
  if (Number.isFinite(Number(strategy.qa?.maximumRevisionAttempts))) output.push(`AIQA 自动修订上限：${Number(strategy.qa.maximumRevisionAttempts)} 次`);
  if (output.length) return output.slice(0, 8);
  const raw = skill.changes || skill.rules || skill.instructions || skill.steps || [];
  if (Array.isArray(raw)) return raw.map((item) => typeof item === "string" ? item : item.text || item.rule || item.instruction || item.summary).filter(Boolean).slice(0, 8);
  if (typeof raw === "string") return raw.split(/\r?\n/u).map((item) => item.replace(/^[-*\d.\s]+/u, "").trim()).filter(Boolean).slice(0, 8);
  const changedPaths = learningArray(skill.metadata?.changedPaths || skill.metadata?.changed_paths);
  if (changedPaths.length) return changedPaths.map((item) => String(item)).slice(0, 8);
  return [];
}

function renderLearningChampion(champions) {
  const container = $("#learningChampion");
  const list = learningArray(champions);
  if (!list.length) {
    $("#learningChampionStatus").textContent = "尚无生效版本";
    container.innerHTML = '<div class="empty-list learning-empty"><div><strong>这个范围还没有生产技能</strong><span>先根据人工采纳的终稿生成候选，完成评测并批准后，它才会成为这个范围的生效版本。</span></div></div>';
    return;
  }
  // 一次只看一个范围：这里就是该范围的生效版本，不再有"其它范围"的折叠壳。
  $("#learningChampionStatus").textContent = `${learningVersion(list[0])} · 已启用`;
  container.innerHTML = list.map((champion) => renderLearningChampionCard(champion)).join("");
}

function renderLearningChampionCard(champion) {
  const rules = learningRules(champion);
  const [statusLabel, statusClass] = learningStatusMeta({ ...champion, status: "active" });
  const evidenceCount = Number(champion.evidenceCount ?? champion.evidence_count ?? champion.trajectoryCount ?? champion.trajectory_count)
    || learningArray(champion.evidenceIds || champion.evidence_ids).length;
  const canRollback = Boolean(champion.parentId || champion.parent_id || Number(champion.version) > 1);
  const autoPropose = champion.metadata?.autoPropose || champion.metadata?.auto_propose;
  const autoProposeNote = autoPropose
    ? (autoPropose.lastError
      ? `<span class="learning-auto-note error">自动候选生成上次失败：${escapeHtml(autoPropose.lastError)}（新的人工终稿到达后会重试）</span>`
      : `<span class="learning-auto-note">自动候选生成已启用 · ${escapeHtml(String(autoPropose.lastAcceptedCount ?? ""))} 条人工终稿时触发${autoPropose.lastProposedAt ? ` · 上次生成候选 ${escapeHtml(formatLearningDate(autoPropose.lastProposedAt))}${autoPropose.lastSource === "manual" ? "（手动）" : ""}` : ""}</span>`)
    : "";
  return `<article class="learning-skill-card champion">
    <div class="learning-skill-head"><div><span class="learning-skill-version">${escapeHtml(learningVersion(champion))}</span><h3>${escapeHtml(learningSkillTitle(champion))}</h3><small>${evidenceCount} 条轨迹支撑${champion.activatedAt || champion.activated_at ? ` · ${escapeHtml(formatLearningDate(champion.activatedAt || champion.activated_at))} 启用` : ""}</small></div><span class="learning-status ${statusClass}">${statusLabel}</span></div>
    <p class="learning-skill-summary">${escapeHtml(champion.summary || champion.description || champion.instruction || "当前稳定生产版本。所有新候选都将以此版本作为评测基线。")}</p>
    ${autoProposeNote}
    ${rules.length ? `<div class="learning-rule-grid">${rules.map((rule, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(rule)}</p></div>`).join("")}</div>` : ""}
    <div class="learning-card-footer"><small>回滚会恢复上一已验证版本，并保留本版本审计记录。</small><div class="learning-actions"><button class="button ghost small" type="button" data-learning-action="rollback" data-skill-id="${escapeHtml(learningId(champion))}" ${canRollback ? "" : "disabled"}>${canRollback ? "回滚上一版本" : "无可回滚版本"}</button></div></div>
  </article>`;
}

function formatLearningDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function evaluationPassed(evaluation, skill = {}) {
  const result = learningEvaluationResult(evaluation);
  if (typeof result.promotable === "boolean") return result.promotable;
  if (typeof evaluation?.passed === "boolean") return evaluation.passed;
  const gate = String(evaluation?.decision || result.status || evaluation?.gateStatus || evaluation?.gate_status || skill.status || "").toLowerCase();
  return ["passed", "ready", "evaluated", "promote", "approved"].includes(gate);
}

function renderLearningCandidates(candidates, evaluations, champions, validTrajectoryCount) {
  const list = $("#learningCandidateList");
  $("#learningCandidateCount").textContent = `${candidates.length} 个候选`;
  if (!candidates.length) {
    list.innerHTML = validTrajectoryCount
      ? '<div class="empty-list learning-empty"><div><strong>当前没有候选技能</strong><span>可用顶部主操作从当前范围的人工采纳终稿中提炼隔离候选，或等人工终稿达到阈值后由系统自动提议；生成不会直接改变生产翻译。</span></div></div>'
      : '<div class="empty-list learning-empty"><div><strong>当前范围还没有人工采纳的终稿</strong><span>批次翻完只会产生机器稿轨迹；回填外部审校结果、或在质检里人工采纳之后，系统才会开放候选技能生成。</span></div></div>';
    return;
  }
  if (!candidates.some((item) => learningId(item) === state.learningSelectedSkillId)) state.learningSelectedSkillId = learningId(candidates[0]);
  list.innerHTML = candidates.map((skill) => {
    const id = learningId(skill);
    // 全部视图下候选来自不同范围：基线必须取它自己范围的生效版本，不能用别的范围的。
    const champion = learningChampionFor(skill, champions);
    const evaluation = learningEvaluationFor(skill, evaluations);
    const evaluationResult = learningEvaluationResult(evaluation);
    const currentChampionId = learningId(champion);
    const evaluationChampionId = String(evaluation?.championSkillId || evaluation?.champion_skill_id || evaluationResult.championId || evaluationResult.champion_id || "");
    const candidateParentId = String(skill.parentId || skill.parent_id || "");
    const baselineCurrent = !currentChampionId
      || ((!evaluationChampionId || evaluationChampionId === currentChampionId) && (!candidateParentId || candidateParentId === currentChampionId));
    const resolvedStatus = !baselineCurrent ? "stale" : evaluationPassed(evaluation, skill) ? "ready" : (evaluationResult.status || evaluation?.decision || evaluation?.status || skill.status);
    const [statusLabel, statusClass] = learningStatusMeta({ ...skill, status: resolvedStatus });
    const selected = id === state.learningSelectedSkillId;
    const reason = skill.changeReason || skill.change_reason || skill.reason || skill.rationale || skill.summary || "由近期高频修订与成功翻译轨迹提出。";
    const sanitizationWarnings = skill.metadata?.sanitization?.warnings || skill.metadata?.sanitization_warnings || [];
    const sanitizationNote = sanitizationWarnings.length
      ? `<div class="learning-auto-note" title="模型补丁中超出白名单、越界或疑似注入的内容已被净化，不影响候选生成。">模型补丁已净化 ${sanitizationWarnings.length} 处：${escapeHtml(String(sanitizationWarnings[0].reason || sanitizationWarnings[0] || ""))}${sanitizationWarnings.length > 1 ? " 等" : ""}</div>`
      : "";
    const rules = learningRules(skill);
    const evidenceCount = Number(skill.evidenceCount ?? skill.evidence_count ?? skill.trajectoryCount ?? skill.trajectory_count) || learningArray(skill.evidence || skill.evidenceIds || skill.evidence_ids).length;
    const canActivate = Boolean(evaluation && baselineCurrent && evaluationPassed(evaluation, skill));
    // 正在跑的评测属于页面状态：只要任务还没结束，按钮就一直写"评测中 N/M"，
    // 中间任何一次重绘（切视图、换范围、点卡片）都不会把它退回"运行评测"。
    const activeJob = activeEvaluationJobFor(id);
    // 候选刚生成时还没有任何评测：evaluation 为 null，这里不能直接读它的字段
    // （曾经因此抛 "Cannot read properties of null (reading 'decision')"，整个学习中心变成读取失败）。
    const reviewStatus = String(evaluationResult.status || evaluation?.decision || "").toLowerCase();
    const insufficient = evaluation && ["insufficient", "needs_review"].includes(reviewStatus);
    const unstable = evaluation && reviewStatus === "unstable";
    // 一组样本失败就整条重跑太亏：只要这条评测里还有失败样本，就给一个"仅重试失败"的入口。
    const retryableJob = activeJob ? null : retryableEvaluationJobFor(id);
    const failedSamples = Number(retryableJob?.progress?.failed) || 0;
    const footerText = !baselineCurrent
      ? "该候选基于旧的生效版本生成，不能再晋升；请拒绝它，并从当前生效版本重新生成候选。"
      : activeJob
        ? `${evaluationProgressText(activeJob)} 评测在后台队列里跑，完成后会自动刷新这里的结论。`
        : !evaluation
          ? "尚未与当前生效版本进行隔离评测。"
          : canActivate
            ? "已在当前生效版本基线上通过完整门槛，可由人工批准启用。"
            : unstable
              ? (evaluationResult.conclusion || "重复评测结论互相矛盾，系统已暂停形成优劣结论。")
              : insufficient
                ? `${evaluationResult.conclusion || "评测证据不足或执行未完成，当前没有形成优劣结论。"}${failedSamples ? ` 已成功的样本会沿用，可以只重试失败的 ${failedSamples} 组。` : ""}`
                : "评测门槛未通过，不能进入生产。";
    return `<article class="learning-skill-card candidate ${selected ? "selected" : ""}" data-learning-select="${escapeHtml(id)}" tabindex="0">
      <div class="learning-skill-head"><div><span class="learning-skill-version">${escapeHtml(learningVersion(skill))}</span><h3>${escapeHtml(learningSkillTitle(skill))}</h3><small>${evidenceCount} 条来源证据${skill.createdAt || skill.created_at ? ` · ${escapeHtml(formatLearningDate(skill.createdAt || skill.created_at))}` : ""}</small></div><span class="learning-status ${statusClass}">${statusLabel}</span></div>
      <div class="learning-change-reason"><span>为什么提出这次变更</span><p>${escapeHtml(reason)}</p></div>
      ${sanitizationNote}
      ${rules.length ? `<details class="learning-change-details"><summary>查看 ${rules.length} 项候选执行配置</summary>${rules.map((rule) => `<p>${escapeHtml(rule)}</p>`).join("")}</details>` : ""}
      <details class="learning-skill-evidence" data-skill-evidence="${escapeHtml(id)}"><summary>看这一版引用了哪些来源证据</summary><div class="learning-skill-evidence-body"><div class="empty-list compact">展开后读取……</div></div></details>
      <div class="learning-card-footer"><small>${escapeHtml(footerText)}</small><div class="learning-actions"><button class="button secondary small" type="button" data-learning-action="evaluate" data-skill-id="${escapeHtml(id)}" data-baseline-current="${baselineCurrent ? "1" : "0"}" data-has-evaluation="${evaluation ? "1" : "0"}" ${baselineCurrent && !activeJob ? "" : "disabled"}>${escapeHtml(activeJob ? evaluationProgressText(activeJob) : evaluation ? "重新评测" : "运行评测")}</button>${retryableJob ? `<button class="button secondary small" type="button" data-learning-action="retry-failed" data-skill-id="${escapeHtml(id)}" data-job-id="${escapeHtml(retryableJob.jobId)}" title="只重跑这 ${failedSamples} 组失败样本，已成功的样本继续沿用">仅重试失败 ${failedSamples} 组</button>` : ""}<button class="button ghost small danger" type="button" data-learning-action="reject" data-skill-id="${escapeHtml(id)}">拒绝</button><button class="button ghost small danger" type="button" data-learning-action="delete" data-skill-id="${escapeHtml(id)}" title="把这个候选版本从列表里删掉（评测记录保留）">删除</button></div></div>
    </article>`;
  }).join("");
}

const learningMetricLabels = {
  qaScore: ["AIQA 平均分", "分", true], qa_score: ["AIQA 平均分", "分", true],
  termAccuracy: ["术语正确率", "%", true], term_accuracy: ["术语正确率", "%", true], mandatoryTermAccuracy: ["强制术语正确率", "%", true],
  acceptanceRate: ["相对人工终稿的近似通过率", "%", true], acceptance_rate: ["相对人工终稿的近似通过率", "%", true], humanAcceptanceRate: ["相对人工终稿的近似通过率", "%", true],
  editDistance: ["相对人工终稿的编辑距离", "%", false], edit_distance: ["相对人工终稿的编辑距离", "%", false], humanEditDistance: ["相对人工终稿的编辑距离", "%", false],
  hardErrorRate: ["硬错误率", "%", false], hard_error_rate: ["硬错误率", "%", false], hardErrorCount: ["硬错误数", "", false], hardErrorFreeRate: ["无硬错误率", "%", true],
  averageCost: ["平均模型成本", "", false], averageLatencyMs: ["平均延迟", "ms", false]
};

function learningNumber(value) {
  return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

function learningMetricDefinition(key, fallbackLabel = "", fallbackUnit = "", fallbackHigher = true) {
  const definition = learningMetricLabels[key];
  return definition || [fallbackLabel || key, fallbackUnit, fallbackHigher];
}

function normalizeLearningMetrics(evaluation = {}) {
  const result = learningEvaluationResult(evaluation);
  if (Array.isArray(result.metrics)) return result.metrics.map((metric, index) => {
    const key = metric.key || metric.name || `metric-${index}`;
    const [label, unit, higher] = learningMetricDefinition(key, metric.label || `指标 ${index + 1}`, metric.unit || "", metric.higherIsBetter ?? metric.higher_is_better ?? true);
    return {
      key, label, unit: metric.unit || unit, higher: metric.higherIsBetter ?? metric.higher_is_better ?? higher,
      champion: learningNumber(metric.champion ?? metric.baseline ?? metric.control),
      candidate: learningNumber(metric.candidate ?? metric.challenger ?? metric.value),
      delta: learningNumber(metric.delta)
    };
  });
  const baseline = result.championMetrics || result.champion_metrics || result.champion || result.baseline || result.baselineMetrics || result.baseline_metrics || {};
  const candidate = result.challengerMetrics || result.challenger_metrics || result.candidate || result.challenger || result.candidateMetrics || result.candidate_metrics || {};
  const metricObject = result.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const preferredKeys = ["mandatoryTermAccuracy", "hardErrorCount", "hardErrorFreeRate", "qaScore", "humanEditDistance", "humanAcceptanceRate"];
  const keys = [...new Set([...preferredKeys.filter((key) => key in baseline || key in candidate), ...Object.keys(metricObject)])];
  if (baseline.cost || candidate.cost) keys.push("averageCost");
  if (baseline.latencyMs || candidate.latencyMs) keys.push("averageLatencyMs");
  return keys.map((key) => {
    const item = metricObject[key];
    const definition = learningMetricLabels[key] || [key, item?.unit || "", item?.higherIsBetter ?? item?.higher_is_better ?? true];
    const baselineValue = key === "averageCost" ? baseline.cost?.average : key === "averageLatencyMs" ? baseline.latencyMs?.average : baseline[key];
    const candidateValue = key === "averageCost" ? candidate.cost?.average : key === "averageLatencyMs" ? candidate.latencyMs?.average : candidate[key];
    return {
      key, label: item?.label || definition[0], unit: item?.unit || definition[1], higher: item?.higherIsBetter ?? item?.higher_is_better ?? definition[2],
      champion: learningNumber(item?.champion ?? item?.baseline ?? baselineValue), candidate: learningNumber(item?.candidate ?? item?.challenger ?? item?.value ?? candidateValue), delta: learningNumber(item?.delta ?? result.deltas?.[key] ?? result.metricDeltas?.[key] ?? result.metric_deltas?.[key])
    };
  }).filter((metric) => Number.isFinite(metric.champion) || Number.isFinite(metric.candidate));
}

function learningMetricDisplay(value, unit) {
  if (!Number.isFinite(value)) return "—";
  const normalized = unit === "%" && Math.abs(value) <= 1 ? value * 100 : value;
  return `${normalized.toFixed(Math.abs(normalized) >= 100 ? 0 : 1)}${unit}`;
}

function renderLearningEvaluation(candidate, evaluation, champion) {
  const matrix = $("#learningEvaluationMatrix");
  if (!candidate || !evaluation) {
    matrix.innerHTML = '<div class="empty-list learning-empty"><div><strong>还没有可对比的评测</strong><span>在候选卡片底部运行评测，结果会在这里与当前生效版本逐项比较。</span></div></div>';
    return;
  }
  const metrics = normalizeLearningMetrics(evaluation);
  const result = learningEvaluationResult(evaluation);
  const passed = evaluationPassed(evaluation, candidate);
  const evaluationStatus = String(result.status || evaluation.decision || "").toLowerCase();
  const insufficient = ["insufficient", "needs_review"].includes(evaluationStatus);
  const unstable = evaluationStatus === "unstable";
  const currentChampionId = learningId(champion);
  const evaluatedChampionId = String(evaluation.championSkillId || evaluation.champion_skill_id || result.championId || result.champion_id || "");
  const stale = Boolean(currentChampionId && evaluatedChampionId && currentChampionId !== evaluatedChampionId);
  const comparisonLabel = stale ? "旧生效版本基线评测" : unstable ? "结果不稳定 · 暂不形成优劣结论" : insufficient ? "证据不足 · 暂不形成优劣结论" : "已完成生效版本 / 候选版本对比";
  const gateClass = stale ? "stale" : unstable || insufficient ? "insufficient" : passed ? "passed" : "failed";
  const gateLabel = stale ? "基线已过期" : unstable ? "多轮结论互相矛盾" : insufficient ? "评测未完整完成" : passed ? "通过晋升门槛" : "未通过晋升门槛";
  const evaluationBasis = result.evaluationBasis || "编辑距离与近似通过率均由候选译文相对人工批准终稿自动计算，不代表新增人工投票或主观打分。";
  // 样本执行情况单独说一行：以前"模型没产出译文"会被算成候选质量差，
  // 用户只看到"硬错误变多"，根本不知道其实是 5 组没跑成。
  const benchmark = result.benchmark || {};
  const requestedPairs = Number(benchmark.requestedPairs) || 0;
  const completedPairs = Number(benchmark.completedPairs) || 0;
  const failedPairs = Number(benchmark.failedPairs) || 0;
  const missingTranslations = Number(benchmark.missingTranslations) || 0;
  const sampleLine = requestedPairs
    ? `样本执行：${completedPairs} / ${requestedPairs} 组完成${failedPairs
      ? ` · ${failedPairs} 组未跑成${missingTranslations ? `（其中 ${missingTranslations} 组是模型没有产出译文，可只重试失败样本）` : ""}`
      : ""}`
    : "";
  const conclusion = result.reportZh || (typeof evaluation.report === "string" ? evaluation.report : "") || result.conclusion || result.summary || result.reason || (passed ? "候选通过全部晋升门槛。" : "候选尚未通过全部晋升门槛。将在批准前保持隔离。 ");
  matrix.innerHTML = `<div class="learning-evaluation-title"><div><span>${escapeHtml(comparisonLabel)}</span><strong>${escapeHtml(learningSkillTitle(candidate))} ${escapeHtml(learningVersion(candidate))}</strong></div><span class="learning-gate ${gateClass}">${gateLabel}</span></div>
    <p class="learning-evaluation-basis">${escapeHtml(evaluationBasis)}</p>
    ${metrics.length ? `<div class="learning-metric-table"><div class="learning-metric-row heading"><span>指标</span><span>当前生效版本</span><span>候选版本</span><span>变化</span></div>${metrics.map((metric) => {
      const rawDelta = Number.isFinite(metric.delta) ? metric.delta : metric.candidate - metric.champion;
      const improved = metric.higher ? rawDelta >= 0 : rawDelta <= 0;
      return `<div class="learning-metric-row"><strong>${escapeHtml(metric.label)}</strong><span>${learningMetricDisplay(metric.champion, metric.unit)}</span><span>${learningMetricDisplay(metric.candidate, metric.unit)}</span><span class="metric-delta ${improved ? "positive" : "negative"}">${rawDelta > 0 ? "+" : ""}${learningMetricDisplay(rawDelta, metric.unit)}</span></div>`;
    }).join("")}</div>` : '<div class="empty-list learning-empty">评测已完成，但服务端没有返回可展示的指标。</div>'}
    ${sampleLine ? `<p class="learning-evaluation-samples">${escapeHtml(sampleLine)}</p>` : ""}
    <p class="learning-evaluation-conclusion">${escapeHtml(conclusion)}</p>`;
}

/**
 * 来源证据：明细走服务端筛选与分页，界面上永远写清"已显示 N / 共 M 条"。
 * 以前是把接口返回的前 30 条平铺出来，既看不出总量，也没法按文件或类型筛。
 */
const LEARNING_EVIDENCE_PAGE_SIZE = 20;

async function loadLearningEvidence({ reset = false } = {}) {
  if (!learningInPipeline()) return;
  const list = $("#learningEvidenceList");
  const moreBar = $("#learningEvidenceMoreBar");
  const moreMeta = $("#learningEvidenceMoreMeta");
  if (reset) {
    state.learningEvidence = { items: [], total: 0, offset: 0, loading: false };
  }
  const current = state.learningEvidence || { items: [], total: 0, offset: 0, loading: false };
  if (current.loading) return;
  if (!reset && current.items.length && !current.hasMore) return;
  state.learningEvidence = { ...current, loading: true };
  if (reset && list) list.innerHTML = '<div class="empty-list learning-empty">正在读取来源证据……</div>';
  if (moreBar) moreBar.hidden = true;
  try {
    const scope = learningActionBody();
    const params = new URLSearchParams({
      locale: scope.locale,
      project: scope.project,
      limit: String(LEARNING_EVIDENCE_PAGE_SIZE),
      offset: String(reset ? 0 : current.items.length)
    });
    const kind = $("#learningEvidenceKind")?.value || "";
    const file = $("#learningEvidenceFile")?.value || "";
    const search = $("#learningEvidenceSearch")?.value.trim() || "";
    if (kind) params.set("kind", kind);
    if (file) params.set("file", file);
    if (search) params.set("search", search);
    const payload = await api(`/api/learning/evidence?${params}`);
    const items = reset ? payload.items : [...current.items, ...payload.items];
    state.learningEvidence = {
      items,
      total: Number(payload.total) || 0,
      hasMore: Boolean(payload.hasMore),
      loading: false,
      files: payload.files || current.files || []
    };
    renderLearningEvidence();
    if (moreBar) moreBar.hidden = !state.learningEvidence.hasMore;
    if (moreMeta) {
      moreMeta.textContent = `已显示 ${items.length} / 共 ${state.learningEvidence.total} 条`;
    }
  } catch (error) {
    state.learningEvidence = { items: [], total: 0, hasMore: false, loading: false };
    if (list) list.innerHTML = `<div class="empty-list learning-empty">来源证据读取失败：${escapeHtml(error.message)}</div>`;
    if (moreBar) moreBar.hidden = true;
  }
}

function renderLearningEvidence() {
  const rows = learningArray(state.learningEvidence?.items);
  const total = Number(state.learningEvidence?.total) || 0;
  const list = $("#learningEvidenceList");
  const candidates = learningPayload().candidates;
  const selectedCandidate = candidates.find((item) => learningId(item) === state.learningSelectedSkillId);
  const selectedEvidenceIds = new Set(learningArray(selectedCandidate?.evidenceIds || selectedCandidate?.evidence_ids).map(String));
  $("#learningEvidenceCount").textContent = total ? `已显示 ${rows.length} / 共 ${total} 条` : "0 条证据";
  list.innerHTML = rows.length ? rows.map((item) => {
    const accepted = item.humanDecision?.accepted === true || item.human_decision?.accepted === true;
    const typeLabel = accepted ? "人工采纳轨迹" : item.status === "review" ? "待复核轨迹" : "完成轨迹";
    const referenceRefs = item.referenceUsage?.refs || [];
    const referenceLine = referenceRefs.length
      ? `<small class="learning-reference-line">本次查阅资料 ${referenceRefs.length} 段：${escapeHtml([...new Set(referenceRefs.map((ref) => [ref.documentName, ref.heading].filter(Boolean).join(" · ")).filter(Boolean))].slice(0, 3).join("；"))}${referenceRefs.length > 3 ? "…" : ""}</small>`
      : "";
    const attribution = item.attribution || {};
    const title = item.title || item.reason || item.changeReason || item.change_reason || item.summary
      || ({ improved: "发现正向改进信号", needs_learning: "发现需要继续学习的修订信号", observed: "已记录轨迹，尚不能可靠归因" }[attribution.outcome])
      || "已记录完成轨迹，尚未形成可靠归因";
    const attributionText = String(attribution.reportZh || attribution.report || "").slice(0, 800);
    const source = item.source || item.sourceText || item.source_text || "";
    const target = item.correctedTranslation || item.corrected_translation || item.finalTranslation || item.final_translation || item.translation || item.target || "";
    const ref = item.taskId || item.task_id || item.trajectoryId || item.trajectory_id || item.id || "";
    const linked = selectedEvidenceIds.has(String(item.id || ref));
    const sourceFile = String(item.sourceFile || item.assetRefs?.sourceFile || "");
    // 全部视图下每条轨迹要能看出自己属于哪个语体 × 领域，条目本身就是证据。
    return `<article class="learning-evidence-item ${linked ? "linked" : ""}"><div class="learning-evidence-meta"><span>${escapeHtml(typeLabel)}</span><small>${escapeHtml(ref ? `#${String(ref).slice(0, 12)}` : "可追溯来源")}${linked ? " · 本候选来源" : ""}${item.createdAt || item.created_at ? ` · ${escapeHtml(formatLearningDate(item.createdAt || item.created_at))}` : ""}</small>${sourceFile ? `<small class="learning-evidence-file" title="${escapeHtml(sourceFile)}">来源：${escapeHtml(sourceFile)}</small>` : ""}</div><div><strong>${escapeHtml(title)}</strong>${attributionText ? `<p class="learning-evidence-reason">${escapeHtml(attributionText)}</p>` : ""}${source ? `<p>${escapeHtml(source)}</p>` : ""}${target ? `<p class="learning-evidence-target">→ ${escapeHtml(target)}</p>` : ""}</div></article>`;
  }).join("") : '<div class="empty-list learning-empty"><div><strong>当前范围还没有学习证据</strong><span>完成翻译、AIQA 修订或人工采纳后，证据会连同轨迹编号出现在这里。</span></div></div>';
}

/** 来源文件下拉：项目级从 scopeCounts 汇总取，避免让用户手打文件名。 */
function renderLearningEvidenceFiles() {
  const select = $("#learningEvidenceFile");
  if (!select) return;
  const payload = state.learningData?.data || state.learningData || {};
  const files = [...new Set(learningArray(payload.scopeCounts)
    .flatMap((row) => learningArray(row?.files).map((file) => String(file?.name || "")))
    .filter(Boolean))];
  const current = select.value;
  select.innerHTML = `<option value="">全部文件</option>${files.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  if (files.includes(current)) select.value = current;
}

/** 技能卡片里的"这一版引用了哪些证据"：按需拉这一版的 evidenceIds。 */
async function loadSkillEvidencePreview(details) {
  if (!details?.open) return;
  const body = details.querySelector(".learning-skill-evidence-body");
  if (!body || details.dataset.evidenceLoaded === "1") return;
  details.dataset.evidenceLoaded = "1";
  const skillId = details.dataset.skillEvidence;
  try {
    const params = new URLSearchParams({ ...learningActionBody(), skillId, limit: "5", offset: "0" });
    const payload = await api(`/api/learning/evidence?${params}`);
    if (!payload.items?.length) {
      body.innerHTML = '<div class="empty-list compact">这一版没有登记来源证据</div>';
      return;
    }
    body.innerHTML = payload.items.map((item) => {
      const accepted = item.humanDecision?.accepted === true;
      const target = item.finalTranslation || item.translation || "";
      return `<div class="learning-skill-evidence-item"><small>${accepted ? "人工采纳" : "完成轨迹"}${item.sourceFile ? ` · ${escapeHtml(item.sourceFile)}` : ""}</small><p>${escapeHtml(item.source || "")}</p><p class="target">${escapeHtml(target)}</p></div>`;
    }).join("") + (payload.total > payload.items.length ? `<small class="learning-skill-evidence-more">共 ${payload.total} 条，完整列表见下方「来源证据与变更原因」</small>` : "");
  } catch (error) {
    body.innerHTML = `<div class="empty-list compact">读取失败：${escapeHtml(error.message)}</div>`;
  }
}

const CONFLICT_ACTION_LABELS = {
  "retire-style-rule": { badge: "建议退休弱势规则", tone: "actionable" },
  "disable-skill": { badge: "建议停用候选技能", tone: "actionable" },
  review: { badge: "需人工判断", tone: "manual" }
};

/** 风格页的冲突面板：项目级，语体/领域由系统自动判定且只作参考。 */
function styleConflictScope() {
  // 项目级：语体/领域由系统自动判定、只作参考，这里不再传。
  return { locale: state.styleLocale, project: state.activeProjectId || "default" };
}

function renderStyleConflicts(report) {
  const conflicts = Array.isArray(report?.conflicts) ? report.conflicts : [];
  const count = $("#styleConflictCount");
  const list = $("#styleConflictList");
  if (!count || !list) return;
  renderStyleConflictSources(report);
  // 「还没扫过」和「扫过了没冲突」是两回事，混起来会让人以为已经检查过。
  if (!report?.scannedAt) {
    count.textContent = "尚未扫描";
    list.innerHTML = `<div class="empty-list learning-empty"><div><strong>${escapeHtml(report?.reason || "尚未扫描")}</strong><span>扫描会比对人工风格指南、蒸馏规范、技能附加规则与译者画像四方，只有模型确认无法同时遵守的才算冲突；人工指南优先。</span></div></div>`;
    return;
  }
  count.textContent = conflicts.length
    ? `${conflicts.length} 处冲突 · 比对 ${report.scannedRules || 0} 条规则`
    : `无冲突 · 比对 ${report.scannedRules || 0} 条规则`;
  if (!conflicts.length) {
    const detail = report.reason || `已比对 ${report.scannedRules || 0} 条规则、${report.candidates || 0} 对同方面组合。`;
    list.innerHTML = `<div class="empty-list learning-empty"><div><strong>${escapeHtml(report.reason ? "本次没有得出冲突结论" : "四方规则没有互相矛盾")}</strong><span>${escapeHtml(detail)}</span></div></div>`;
    return;
  }
  list.innerHTML = conflicts.map((conflict, index) => {
    const meta = CONFLICT_ACTION_LABELS[conflict.action] || CONFLICT_ACTION_LABELS.review;
    const side = (rule, winning) => `<div class="learning-conflict-side ${winning ? "winning" : ""}"><span>${escapeHtml(rule.originLabel || "")}${winning ? " · 优先" : ""}</span><p>${escapeHtml(rule.rule || "")}</p><small>${rule.evidenceCount ? `${rule.evidenceCount} 条证据` : "无证据计数"}</small></div>`;
    const winnerRule = conflict.winner?.rule || "";
    const isWinner = (rule) => Boolean(winnerRule) && rule.rule === winnerRule;
    const canRetire = conflict.action === "retire-style-rule" && conflict.ruleId;
    const canDisable = conflict.action === "disable-skill" && conflict.skillId;
    return `<article class="learning-conflict-item ${meta.tone}">
      <div class="learning-conflict-head"><span class="learning-conflict-badge ${meta.tone}">${escapeHtml(meta.badge)}</span><small>${escapeHtml((conflict.aspects || []).join("、") || "同一方面")}</small></div>
      ${conflict.situation ? `<p class="learning-conflict-situation">${escapeHtml(conflict.situation)}</p>` : ""}
      <div class="learning-conflict-sides">${side(conflict.left, isWinner(conflict.left))}${side(conflict.right, isWinner(conflict.right))}</div>
      <p class="learning-conflict-reason">${escapeHtml(conflict.reason || "")}</p>
      ${conflict.recommendation ? `<p class="learning-conflict-reason subtle">模型建议：${escapeHtml(conflict.recommendation)}</p>` : ""}
      ${canRetire ? `<div class="learning-conflict-foot"><button class="button ghost small" type="button" data-conflict-retire="${escapeHtml(conflict.ruleId)}" data-conflict-index="${index}">退休这条蒸馏规则</button><small>只改蒸馏规范；人工指南与技能不受影响</small></div>` : ""}
      ${canDisable ? `<div class="learning-conflict-foot"><button class="button ghost small danger" type="button" data-conflict-disable="${escapeHtml(conflict.skillId)}" data-conflict-index="${index}">停用这个候选技能</button><small>只停用未生效的候选版本，随时可以重新生成</small></div>` : ""}
    </article>`;
  }).join("");
  $$("[data-conflict-retire]").forEach((button) => button.addEventListener("click", () => retireConflictRule(button)));
  $$("[data-conflict-disable]").forEach((button) => button.addEventListener("click", () => disableConflictSkill(button)));
}

/** 来源说明：这次比对了人工指南 / 蒸馏规范 / 技能规则 / 译者画像各多少条。 */
function renderStyleConflictSources(report) {
  const box = $("#styleConflictSources");
  if (!box) return;
  if (!report?.scannedAt) {
    box.textContent = "尚未扫描：扫描会列出人工指南 / 蒸馏规范 / 技能规则 / 译者画像各有多少条参与比对。";
    return;
  }
  const sources = report.sources || {};
  const skillList = learningArray(sources.skills);
  const skillText = skillList
    .map((item) => `v${item.version}${item.status === "champion" ? "·生效" : "·候选"} ${Number(item.count) || 0} 条`)
    .join(" / ");
  box.textContent = [
    `人工风格指南 ${Number(sources.guide) || 0} 条${sources.guideName ? `（${sources.guideName}）` : ""}`,
    `蒸馏规范 ${Number(sources.style) || 0} 条`,
    `技能规则 ${skillList.reduce((sum, item) => sum + (Number(item.count) || 0), 0)} 条${skillText ? `（${skillText}）` : ""}`,
    `译者画像 ${Number(sources.profile) || 0} 条`
  ].join(" · ") + "；优先级：人工指南 > 蒸馏规范 > 技能规则 > 译者画像。";
}

async function loadStyleConflictReport() {
  if (!$("#styleConflictList")) return;
  const scope = styleConflictScope();
  const params = new URLSearchParams({ locale: scope.locale, project: scope.project });
  try {
    state.conflictReport = await api(`/api/learning/conflict-scan?${params}`);
  } catch {
    // 冲突报告是诊断信息，读不到不该把整个风格页拖成错误态。
    state.conflictReport = null;
  }
  renderStyleConflicts(state.conflictReport);
}

async function runStyleConflictScan(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "扫描中……";
  try {
    state.conflictReport = await api("/api/learning/conflict-scan", { method: "POST", body: JSON.stringify(styleConflictScope()) });
    renderStyleConflicts(state.conflictReport);
    const found = state.conflictReport.conflicts?.length || 0;
    toast(found ? `发现 ${found} 处规则冲突` : state.conflictReport.reason || "四方规则没有互相矛盾");
  } catch (error) {
    toast(`扫描失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/** 冲突面板的"停用候选技能"：只对未生效的版本开放。 */
async function disableConflictSkill(button) {
  const conflict = (state.conflictReport?.conflicts || [])[Number(button.dataset.conflictIndex)];
  const skillId = button.dataset.conflictDisable;
  if (!skillId) return;
  if (!confirm("确认停用这个候选技能版本？它会退出候选列表，评测任务一并终止；之后可以重新生成。")) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    await api(`/api/learning/skills/${encodeURIComponent(skillId)}/disable`, { method: "POST", body: JSON.stringify({}) });
    state.conflictReport = await api(`/api/learning/conflict-scan?${new URLSearchParams(styleConflictScope())}`);
    renderStyleConflicts(state.conflictReport);
    toast(`已停用候选技能${conflict?.skillVersion ? ` v${conflict.skillVersion}` : ""}`);
  } catch (error) {
    toast(`停用失败：${error.message}`);
    button.disabled = false;
    button.textContent = original;
  }
}

async function retireConflictRule(button) {
  const conflict = (state.conflictReport?.conflicts || [])[Number(button.dataset.conflictIndex)];
  if (!confirm("确认退休这条风格规则？它会立刻退出翻译提示词，记录保留在规范里可供复核。")) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    const result = await api("/api/learning/conflict-scan/apply", {
      method: "POST",
      body: JSON.stringify({ ...styleConflictScope(), ruleId: button.dataset.conflictRetire, reason: conflict?.reason || "" })
    });
    state.conflictReport = result.report;
    renderStyleConflicts(state.conflictReport);
    toast(`已退休该规则，当前生效 ${result.activeRules} 条`);
  } catch (error) {
    toast(`退休失败：${error.message}`);
    button.disabled = false;
    button.textContent = original;
  }
}

const GATE_STATUS_LABELS = {
  pass: "上次门禁通过",
  block: "上次门禁阻断",
  insufficient: "证据不足",
  not_run: "尚未运行"
};

function qualityPercent(value) {
  return value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
}

async function loadQualityGate() {
  const params = new URLSearchParams(learningActionBody());
  try {
    const [assets, gate] = await Promise.all([
      api(`/api/quality/assets?${params}`),
      api(`/api/quality/gate?${params}`)
    ]);
    state.qualityAssets = assets;
    state.qualityGate = gate;
    renderQualityGate();
    // 门禁结论同时决定步骤条第 4 步的状态与第 5 步能不能启用：
    // 异步取回后必须重绘一次，否则面板会一直停在"尚未读取"。
    if (learningInPipeline() && state.learningData) renderLearning();
  } catch (error) {
    state.qualityAssets = null;
    state.qualityGate = null;
    $("#learningGateStatus").textContent = "读取失败";
    $("#learningQualityAssets").innerHTML = `<div class="empty-list learning-empty">固定质量资产读取失败：${escapeHtml(error.message)}</div>`;
    $("#learningRegressionCandidates").innerHTML = "";
  }
}

function renderQualityGate() {
  const assets = state.qualityAssets;
  const gate = state.qualityGate;
  if (!assets || !gate) return;
  const status = gate.status || "not_run";
  const badge = $("#learningGateStatus");
  badge.textContent = GATE_STATUS_LABELS[status] || status;
  badge.dataset.gateStatus = status;
  const latest = gate.latestRun;
  const coverage = gate.assets.coverage || null;
  const sources = gate.assets.sources || { externalReview: 0, qaApproved: 0 };
  const gateCaseCount = Number(gate.assets.gateCaseCount) || 0;
  const caseTotal = Number(gate.assets.regressionCaseTotal ?? gate.assets.regressionCaseCount) || 0;
  const limit = Number(gate.assets.gateCaseLimit) || 0;
  const cards = [
    { label: "启用 Gold 样本", value: gate.assets.goldSampleCount, hint: gate.assets.goldSetVersions.join("、") || "尚未启用 Gold Set" },
    { label: "启用回归案例", value: caseTotal, hint: gate.assets.regressionSuiteVersions.join("、") || "尚未启用回归集" },
    { label: "本次跑 / 共", value: `${gateCaseCount} / ${caseTotal}`, hint: limit > 0 ? `单次上限 ${limit} 条，按改动幅度取前几（设置里可调）` : "未设上限，全部跑" },
    { label: "回归通过率", value: latest ? qualityPercent(latest.regressionPassRate) : "—", hint: latest ? `${latest.regressionPassed} / ${latest.regressionTotal} 通过` : "尚未运行门禁" },
    { label: "Gold 术语准确率", value: latest ? qualityPercent(latest.goldTermAccuracy) : "—", hint: latest ? `事实准确率 ${qualityPercent(latest.goldFactAccuracy)}` : "尚未运行门禁" }
  ];
  const blocking = (latest?.blocking || []).map((item) => `<li>${escapeHtml(item.message || item.code || "")}</li>`).join("");
  const coverageLine = coverage
    ? `<p class="learning-quality-coverage ${coverage.valid ? "ok" : "warn"}">结论覆盖：${escapeHtml(coverage.reason)}${latest ? ` · 该次跑的是 Gold ${escapeHtml((latest.assetVersions?.goldSets || []).join("、") || "无")} / 回归 ${escapeHtml((latest.assetVersions?.regressionSuites || []).join("、") || "无")}` : ""}</p>`
    : "";
  $("#learningQualityAssets").innerHTML = `
    <div class="learning-quality-cards">
      ${cards.map((card) => `<article class="learning-quality-card"><strong>${escapeHtml(String(card.value))}</strong><span>${escapeHtml(card.label)}</span><small>${escapeHtml(card.hint)}</small></article>`).join("")}
    </div>
    ${coverageLine}
    ${blocking ? `<div class="learning-quality-blocking"><strong>阻断原因</strong><ul>${blocking}</ul></div>` : ""}
    ${latest ? `<p class="learning-quality-meta">最近一次运行：${escapeHtml(latest.createdAt || "")} · 受测技能 ${escapeHtml(latest.skillId || "未记录")} · 触发方式 ${escapeHtml(latest.triggeredBy || "manual")}</p>` : ""}`;

  // 回归案例现在自动来自审校回填与人工采纳的 QA 案例，这一块只做只读来源说明。
  const failed = (latest?.report?.regression?.cases || []).filter((item) => item?.passed === false);
  const goldFailed = (latest?.report?.gold?.samples || []).filter((item) => item?.passed === false);
  $("#learningRegressionCandidates").innerHTML = `<div class="learning-quality-sources">
      <h3>回归案例来源（只读）</h3>
      <p>外部审校回填改动 ${Number(sources.externalReview) || 0} 条 · 人工采纳的 QA 失败案例 ${Number(sources.qaApproved) || 0} 条；每次回填后自动并入并出新版本，不需要人工审批与署名。</p>
      <small>当前回归集：${escapeHtml(gate.assets.regressionSuiteVersions.join("、") || "尚未建立")}</small>
      <div class="learning-gate-review" id="learningGateReview"></div>
    </div>`;
  renderGateReview(latest, failed, goldFailed);
}

const GATE_REVIEW_KIND_LABELS = { terminology: "术语问题", convention: "体例/规则", fact: "事实锚点", other: "其它" };

/**
 * 门禁失败不是死路：这里给出「总结失败原因」，并把复盘结果变成可执行动作——
 * 术语类转术语候选（同一套入库策略），体例类据此生成新的候选技能。
 */
function renderGateReview(run, failedCases = [], goldFailed = []) {
  const container = $("#learningGateReview");
  if (!container) return;
  if (!run) {
    container.innerHTML = "";
    return;
  }
  const totalFailed = failedCases.length + goldFailed.length;
  if (!totalFailed) {
    container.innerHTML = "";
    return;
  }
  const review = run.report?.review || null;
  const caseById = new Map([
    ...failedCases.map((item) => [String(item.id), { source: item.source, candidate: item.translation, expected: item.expectedTranslation }]),
    ...goldFailed.map((item) => [String(item.id), { source: item.source, candidate: item.translation, expected: (item.referenceTargets || [])[0] || "" }])
  ]);
  const header = `<div class="learning-gate-review-head">
      <div><strong>失败复盘</strong><small>${totalFailed} 条失败（回归 ${failedCases.length} · Gold ${goldFailed.length}）</small></div>
      ${review
        ? `<button class="button ghost small" type="button" data-gate-review="refresh" data-run-id="${escapeHtml(String(run.id))}">重新总结</button>`
        : `<button class="button secondary small" type="button" data-gate-review="summarize" data-run-id="${escapeHtml(String(run.id))}">总结失败原因</button>`}
    </div>`;
  if (!review) {
    container.innerHTML = `${header}
      <p class="learning-gate-review-hint">让模型把这批复发案例按根因归类，并给出可执行建议；术语类可直接转术语候选，体例类可一键据此生成新的候选技能。</p>
      <div class="learning-quality-failures"><strong>最近一次复发的历史失败</strong><ul>${failedCases.slice(0, 5).map((item) => `<li>${escapeHtml(item.source || item.id || "")} → 复现「${escapeHtml(item.failingTranslation || "")}」</li>`).join("")}</ul></div>`;
    bindGateReviewEvents();
    return;
  }
  const patterns = review.patterns || [];
  container.innerHTML = `${header}
    ${review.summary ? `<p class="learning-gate-review-summary">${escapeHtml(review.summary)}</p>` : ""}
    ${review.warning ? `<p class="learning-gate-review-warning">${escapeHtml(review.warning)}</p>` : ""}
    ${patterns.length ? patterns.map((pattern) => {
      const examples = (pattern.caseIds || []).map((id) => caseById.get(String(id))).filter(Boolean);
      const shown = examples.slice(0, 3);
      const rest = examples.slice(3);
      const isTerminology = pattern.kind === "terminology" && (pattern.termSuggestions || []).length;
      return `<article class="learning-gate-pattern" data-kind="${escapeHtml(pattern.kind)}">
        <div class="learning-gate-pattern-head">
          <span class="learning-gate-pattern-kind">${escapeHtml(GATE_REVIEW_KIND_LABELS[pattern.kind] || pattern.kind)}</span>
          <strong>${escapeHtml(pattern.label)}</strong>
          <small>${examples.length} 条案例</small>
        </div>
        ${pattern.reason ? `<p class="learning-gate-pattern-reason">${escapeHtml(pattern.reason)}</p>` : ""}
        ${pattern.suggestion ? `<p class="learning-gate-pattern-suggestion">建议：${escapeHtml(pattern.suggestion)}</p>` : ""}
        ${pattern.proposedRule ? `<p class="learning-gate-pattern-rule">可写入技能的规则：${escapeHtml(pattern.proposedRule)}</p>` : ""}
        ${(pattern.termSuggestions || []).length ? `<ul class="learning-gate-pattern-terms">${(pattern.termSuggestions || []).map((term) => `<li>${escapeHtml(term.source)} → ${escapeHtml(term.preserveSource ? `${term.source}（原文照抄）` : term.target)}</li>`).join("")}</ul>` : ""}
        ${shown.length ? `<div class="learning-gate-pattern-examples">${shown.map((item) => `<div><small>${escapeHtml(item.source)}</small><p><s>${escapeHtml(item.candidate || "")}</s> → <strong>${escapeHtml(item.expected || "")}</strong></p></div>`).join("")}</div>` : ""}
        ${rest.length ? `<details class="learning-gate-pattern-more"><summary>查看其余 ${rest.length} 条案例</summary>${rest.map((item) => `<div><small>${escapeHtml(item.source)}</small><p><s>${escapeHtml(item.candidate || "")}</s> → <strong>${escapeHtml(item.expected || "")}</strong></p></div>`).join("")}</details>` : ""}
        <div class="learning-gate-pattern-actions">
          ${isTerminology ? `<button class="button secondary small" type="button" data-gate-review="terms" data-run-id="${escapeHtml(String(run.id))}">提为术语候选</button>` : ""}
          <button class="button ${isTerminology ? "ghost" : "secondary"} small" type="button" data-gate-review="skill" data-run-id="${escapeHtml(String(run.id))}" data-pattern-id="${escapeHtml(String(pattern.id))}">据此生成新候选技能</button>
        </div>
      </article>`;
    }).join("") : '<div class="empty-list learning-empty">复盘没有得出结论，可以点「重新总结」再试一次。</div>'}`;
  bindGateReviewEvents();
}

function bindGateReviewEvents() {
  $$("[data-gate-review]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.gateReview;
    if (action === "summarize") return summarizeGateFailures(button);
    if (action === "refresh") return summarizeGateFailures(button, { force: true });
    if (action === "terms") return promoteGateReviewTerms(button);
    if (action === "skill") return createSkillFromGateReview(button);
  }));
}

async function summarizeGateFailures(button, { force = false } = {}) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "复盘中……";
  try {
    await api(`/api/quality/runs/${encodeURIComponent(button.dataset.runId)}/review`, {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), force })
    });
    toast("复盘完成：失败已按模式归类");
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = original;
  }
}

async function promoteGateReviewTerms(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    const result = await api(`/api/quality/runs/${encodeURIComponent(button.dataset.runId)}/terms`, {
      method: "POST",
      body: JSON.stringify(learningActionBody())
    });
    const written = Number(result.autoWritten) || 0;
    const pending = Number(result.pendingReview) || 0;
    toast(written || pending
      ? `术语候选已处理：自动入库 ${written} 条 · 待审核 ${pending} 条${pending ? "（任务中心可审核）" : ""}`
      : "复盘里的术语建议都不满足入库条件");
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function createSkillFromGateReview(button) {
  if (!confirm("根据这条复盘模式生成新的候选技能版本？生成后需要运行评测与门禁才能启用。")) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中……";
  try {
    const result = await api("/api/learning/skills/from-gate-review", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), runId: button.dataset.runId, patternIds: [button.dataset.patternId].filter(Boolean) })
    });
    const generated = result.skill || result.candidate;
    if (generated) state.learningSelectedSkillId = learningId(generated);
    toast("已据此生成新的候选技能，下一步请运行评测");
    await loadLearning(state.learningLocale);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = original;
  }
}

async function seedGoldSetFromTrajectories(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中……";
  try {
    const preview = await api("/api/quality/gold-sets/from-trajectories", { method: "POST", body: JSON.stringify(learningActionBody()) });
    if (!preview.candidates.length) {
      toast("当前范围还没有人工采纳的终稿，无法生成 Gold Set");
      return;
    }
    if (!confirm(`将从 ${preview.acceptedTotal} 条人工采纳终稿中取 ${preview.candidates.length} 条建立固定 Gold Set 并启用。建立后内容不可改，只能发新版本。继续？`)) return;
    const created = await api("/api/quality/gold-sets", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), samples: preview.candidates, status: "active", changeNote: "从人工采纳终稿生成" })
    });
    toast(`已建立 Gold Set ${created.asset.seriesId} v${created.asset.version}，共 ${created.asset.itemCount} 个样本`);
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function buildRegressionSuiteFromUi(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中……";
  try {
    const created = await api("/api/quality/regression-suites", { method: "POST", body: JSON.stringify({ ...learningActionBody(), changeNote: "由已批准回归候选生成" }) });
    const stats = created.stats || {};
    toast(created.changed
      ? `已按最新证据重建回归集 v${created.asset.version}：审校改动 ${stats.externalCases || 0} 条 · QA 案例 ${stats.qaCases || 0} 条`
      : `回归集 v${created.asset.version} 内容未变化（审校改动 ${stats.externalCases || 0} 条 · QA 案例 ${stats.qaCases || 0} 条）`);
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function runQualityGateFromUi(button) {
  const original = button.textContent;
  const previousRunId = state.qualityGate?.latestRun?.id || "";
  // 门禁是给候选发通行证的：这里必须带当前选中候选的 ID，跑生效版本没有意义。
  const candidate = learningPayload().candidates.find((item) => learningId(item) === state.learningSelectedSkillId)
    || learningPayload().candidates[0];
  if (!candidate) return toast("当前范围还没有候选技能，先在第 ② 步生成一个");
  try {
    const started = await api("/api/quality/runs", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), skillId: learningId(candidate), triggeredBy: "ui" })
    });
    toast(started.message || "质量门禁已进入任务中心");
    button.disabled = true;
    button.textContent = "执行中……";
    // 门禁按固定样本逐条真跑模型，耗时随样本数增长；这里只轮询结论是否落库。
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await loadQualityGate();
      const latest = state.qualityGate?.latestRun;
      if (latest && latest.id !== previousRunId) {
        toast(latest.decision === "pass" ? "质量门禁通过" : `质量门禁未通过：${latest.decision}`);
        break;
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function auditTrainingExport(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "统计中……";
  try {
    const report = await api("/api/learning/export", { method: "POST", body: JSON.stringify({ ...learningActionBody(), format: "json" }) });
    state.trainingExport = report;
    $("#learningExportSummary").textContent = `SFT ${report.sft.count} 条 · DPO ${report.dpo.count} 条`;
    const reasons = (audit) => Object.entries(audit.droppedByReason || {}).map(([reason, count]) => `<li>${escapeHtml(reason)} · ${count} 条</li>`).join("") || "<li>没有丢弃样本</li>";
    $("#learningExportReport").innerHTML = `
      <div class="learning-export-grid">
        <article><h4>SFT 监督数据</h4><strong>${report.sft.count}</strong><small>输入 ${report.sft.audit.input} 条 · 丢弃 ${report.sft.audit.dropped} 条</small><ul>${reasons(report.sft.audit)}</ul></article>
        <article><h4>DPO 偏好数据</h4><strong>${report.dpo.count}</strong><small>输入 ${report.dpo.audit.input} 条 · 丢弃 ${report.dpo.audit.dropped} 条</small><ul>${reasons(report.dpo.audit)}</ul></article>
      </div>
      <p class="learning-quality-meta">已从训练数据中排除 ${report.manifest.excludedEvaluationSources} 条固定评测原文（Gold ${report.manifest.goldSampleCount} 个样本、回归 ${report.manifest.regressionCaseCount} 个案例），避免训练集吃掉自己的基准。</p>`;
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function downloadTrainingDataset(dataset, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "导出中……";
  try {
    const response = await fetch("/api/learning/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...learningActionBody(), format: "jsonl", dataset })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `导出失败：${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) {
      toast("当前范围没有可导出的样本");
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `kami-${dataset}-${learningActionBody().locale}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    toast(`${dataset.toUpperCase()} 数据集已导出`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

const TRAINING_STATUS_LABEL = {
  draft: "草稿", frozen: "数据已冻结", submitted: "已提交", running: "训练中",
  succeeded: "训练成功", failed: "失败", cancelled: "已取消", registered: "产物已登记", promoted: "已投产"
};

const TRAINING_NEXT_ACTIONS = {
  frozen: [["submitted", "标记为已提交"]],
  submitted: [["running", "标记为训练中"], ["failed", "标记失败"]],
  running: [["succeeded", "标记训练成功"], ["failed", "标记失败"]],
  succeeded: [["registered", "登记产出模型"]],
  registered: [["promoted", "过门禁并投产"]]
};

const TRAINING_PAGE_SIZE = 20;

async function loadTrainingRuns({ reset = true } = {}) {
  const scope = learningActionBody();
  const offset = reset ? 0 : (state.trainingRuns || []).length;
  const params = new URLSearchParams({ ...scope, limit: String(TRAINING_PAGE_SIZE), offset: String(offset) });
  try {
    const payload = await api(`/api/training/runs?${params}`);
    state.trainingRuns = reset ? (payload.runs || []) : [...(state.trainingRuns || []), ...(payload.runs || [])];
    state.trainingTotal = Number(payload.total) || state.trainingRuns.length;
    state.trainingHasMore = Boolean(payload.hasMore);
    renderTrainingRuns();
  } catch (error) {
    $("#learningTrainingCount").textContent = "读取失败";
    $("#learningTrainingList").innerHTML = `<div class="empty-list learning-empty">微调任务读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderTrainingRuns() {
  const runs = state.trainingRuns || [];
  const total = Number(state.trainingTotal) || runs.length;
  $("#learningTrainingCount").textContent = total > runs.length ? `已显示 ${runs.length} / 共 ${total} 个任务` : `${total} 个任务`;
  $("#learningTrainingList").innerHTML = runs.length
    ? runs.map((run) => {
      const payload = run.payload || {};
      const datasets = (payload.datasets || []).map((item) => `${item.kind.toUpperCase()} ${item.recordCount} 条 · 指纹 ${String(item.contentFingerprint).slice(0, 12)}…`).join("；");
      const actions = (TRAINING_NEXT_ACTIONS[run.status] || [])
        .map(([status, label]) => `<button class="button ghost small" type="button" data-training-advance="${escapeHtml(status)}" data-run-id="${escapeHtml(run.id)}">${escapeHtml(label)}</button>`)
        .join("");
      return `<article class="learning-training-item" data-status="${escapeHtml(run.status)}">
        <div class="learning-training-head">
          <span class="learning-training-status">${escapeHtml(TRAINING_STATUS_LABEL[run.status] || run.status)}</span>
          <strong>${escapeHtml(run.name)}</strong>
          <small>${escapeHtml(run.method.toUpperCase())} · 基座 ${escapeHtml(run.baseModel || "未填")}${run.teacherModel ? ` · 教师 ${escapeHtml(run.teacherModel)}` : ""}</small>
        </div>
        <p class="learning-training-datasets">${escapeHtml(datasets || "无数据集")}</p>
        ${run.artifactModelId ? `<p class="learning-training-artifact">产出模型：${escapeHtml(run.artifactModelId)}${payload.gate ? ` · 门禁 ${escapeHtml(payload.gate.decision)}（${escapeHtml(payload.gate.runId || "")}）` : ""}</p>` : ""}
        ${run.error ? `<p class="learning-training-error">${escapeHtml(run.error)}</p>` : ""}
        <div class="learning-training-actions">
          <button class="button ghost small" type="button" data-training-manifest="${escapeHtml(run.id)}">下载交接清单</button>
          ${actions}
        </div>
      </article>`;
    }).join("")
    : '<div class="empty-list learning-empty">当前范围还没有微调任务</div>';
  const moreBar = $("#learningTrainingMoreBar");
  if (moreBar) {
    moreBar.hidden = !state.trainingHasMore;
    $("#learningTrainingMoreMeta").textContent = `已显示 ${runs.length} / 共 ${total} 个任务`;
  }
  $$("[data-training-advance]").forEach((button) => button.addEventListener("click", () => advanceTrainingRunFromUi(button.dataset.runId, button.dataset.trainingAdvance, button)));
  $$("[data-training-manifest]").forEach((button) => button.addEventListener("click", () => downloadTrainingManifest(button.dataset.trainingManifest)));
}

async function createTrainingRunFromUi(button) {
  const method = $("#trainingMethod").value;
  const baseModel = $("#trainingBaseModel").value.trim();
  if (!baseModel) return toast("请先填写基座模型");
  const teacherModel = $("#trainingTeacherModel").value.trim();
  if (method === "distillation" && !teacherModel) return toast("蒸馏必须填写教师模型");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "冻结中……";
  try {
    const created = await api("/api/training/runs", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), method, baseModel, teacherModel })
    });
    toast(`已冻结 ${created.run.totalRecords} 条样本并建立任务`);
    await loadTrainingRuns();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function advanceTrainingRunFromUi(runId, status, button) {
  const body = { ...learningActionBody(), status, by: "工作台" };
  if (status === "registered") {
    const modelId = prompt("产出模型 ID（外部训练平台返回的模型或适配器标识）");
    if (!modelId) return;
    body.artifact = { modelId, adapterUri: prompt("适配器地址（可留空）") || "" };
  }
  if (status === "failed") {
    body.error = prompt("失败原因") || "未填写原因";
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    await api(`/api/training/runs/${encodeURIComponent(runId)}/advance`, { method: "POST", body: JSON.stringify(body) });
    toast(status === "promoted" ? "门禁通过，微调模型已投产" : "任务状态已更新");
    await loadTrainingRuns();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function downloadTrainingManifest(runId) {
  try {
    const payload = await api(`/api/training/runs/${encodeURIComponent(runId)}/manifest`);
    const blob = new Blob([JSON.stringify(payload.manifest, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `kami-training-manifest-${runId}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    toast(error.message);
  }
}

/** 领域的中文名：自动判定出来的标签也要用用户看得懂的说法，不直接抛 game / marketing。 */
function learningDomainLabel(domain) {
  const option = LEARNING_DOMAIN_OPTIONS.find(([value]) => value === String(domain));
  return option ? option[1] : String(domain || "");
}

const LEARNING_STEP_LABELS = Object.freeze({
  champion: { index: "①", title: "生效版本", hint: "正在影响生产翻译的那一版" },
  candidates: { index: "②", title: "候选技能", hint: "从人工终稿与外部审校改动中提炼" },
  evaluation: { index: "③", title: "评测", hint: "候选 vs 当前生效版本的配对评测" },
  gate: { index: "④", title: "发版门禁", hint: "固定 Gold Set 与失败回归" },
  activate: { index: "⑤", title: "启用", hint: "通过后才替换生产版本" }
});

/** 业务领域的显示名：系统自动判定，只用于展示与排序说明。 */
const LEARNING_DOMAIN_OPTIONS = Object.freeze([
  ["general", "通用"],
  ["game", "游戏"],
  ["marketing", "市场营销"],
  ["community", "社区运营"]
]);

const LEARNING_GATE_STATUS_LABELS = Object.freeze({
  pass: "已通过", block: "被阻断", insufficient: "证据不足", not_run: "尚未运行"
});

function renderLearningPipelineVisibility() {
  // 项目级流水线：不再有"总览 / 进入范围"两级，也不再有语体/领域选择器。
  const pipeline = $("#learningPipeline");
  if (pipeline) pipeline.hidden = false;
}

/**
 * 步骤条：① 生效版本 → ② 候选 → ③ 评测 → ④ 门禁 → ⑤ 启用。
 * 状态由现有数据推导，默认展开第一个还没完成的步骤，让人一眼看到"下一步做什么"。
 */
function learningStepStates({ champions, candidates, evaluations, champion, selected, evaluation }) {
  const gate = state.qualityGate;
  const gateCoverage = gate?.assets?.coverage || null;
  const gateDecision = gate?.status || "not_run";
  const hasChampion = Boolean(champion || champions.length);
  const selectedEvaluation = selected ? learningEvaluationFor(selected, evaluations) : null;
  const selectedResult = selectedEvaluation ? learningEvaluationResult(selectedEvaluation) : null;
  const promotionReady = Boolean(selectedEvaluation) && evaluationPassed(selectedEvaluation, selected);
  const evaluationVerdict = !selectedEvaluation
    ? "尚未评测"
    : promotionReady
      ? "结论：可晋升"
      : ["insufficient", "needs_review"].includes(String(selectedResult?.status || selectedEvaluation.decision || "").toLowerCase())
        ? "结论：证据不足"
        : "结论：不应晋升";
  const gateReady = gateDecision === "pass" && gateCoverage?.valid !== false;
  const isActiveSkill = String(selected?.status || "") === "champion";
  return [
    { id: "champion", status: hasChampion ? "done" : "missing", detail: hasChampion ? `${learningVersion(champion || champions[0])} 已生效` : "还没有生效版本" },
    {
      id: "candidates",
      status: candidates.length ? "done" : "missing",
      detail: candidates.length ? `${candidates.length} 个候选${selected ? ` · 选中 ${learningVersion(selected)}` : ""}` : "还没有候选技能"
    },
    {
      id: "evaluation",
      status: !candidates.length ? "waiting" : !selectedEvaluation ? "current" : promotionReady ? "done" : "blocked",
      detail: evaluationVerdict
    },
    {
      id: "gate",
      status: gateDecision === "pass" ? (gateCoverage?.valid === false ? "blocked" : "done") : gateDecision === "not_run" ? "current" : "blocked",
      detail: `${LEARNING_GATE_STATUS_LABELS[gateDecision] || gateDecision}${gateCoverage && gateDecision !== "not_run" ? (gateCoverage.valid ? " · 覆盖当前资产" : " · 结论已过期") : ""}`
    },
    {
      id: "activate",
      status: isActiveSkill ? "done" : promotionReady && gateReady ? "current" : "waiting",
      detail: isActiveSkill ? "已经在生产" : promotionReady && gateReady ? "可以启用" : "等评测与门禁通过"
    }
  ];
}

function renderLearningSteps(steps) {
  const container = $("#learningSteps");
  if (!container) return;
  const current = state.learningStep || steps.find((step) => step.status !== "done" && step.status !== "waiting")?.id || "activate";
  container.innerHTML = steps.map((step, index) => {
    const meta = LEARNING_STEP_LABELS[step.id];
    const active = step.id === current;
    const tone = step.status === "done" ? "ok" : step.status === "blocked" ? "warn" : step.status === "current" ? "active" : "neutral";
    return `<li class="learning-step ${tone}${active ? " current" : ""}" data-learning-step="${escapeHtml(step.id)}"${index === 4 ? ' data-last="1"' : ""}>
      <button type="button" data-learning-step-button="${escapeHtml(step.id)}">
        <span class="learning-step-index">${meta.index}</span>
        <span class="learning-step-title">${escapeHtml(meta.title)}</span>
        <small>${escapeHtml(step.detail)}</small>
      </button>
    </li>`;
  }).join("");
  $$("#learningSteps [data-learning-step-button]").forEach((button) => button.addEventListener("click", () => setLearningStep(button.dataset.learningStepButton)));
  setLearningStep(current, { silent: true });
}

function setLearningStep(stepId, { silent = false } = {}) {
  const step = LEARNING_STEP_LABELS[stepId] ? stepId : "champion";
  state.learningStep = step;
  for (const id of Object.keys(LEARNING_STEP_LABELS)) {
    const section = document.getElementById(`learningStep${id.charAt(0).toUpperCase()}${id.slice(1)}`);
    if (section) section.hidden = id !== step;
  }
  $$("#learningSteps [data-learning-step]").forEach((item) => item.classList.toggle("current", item.dataset.learningStep === step));
  if (!silent) {
    const section = document.getElementById(`learningStep${step.charAt(0).toUpperCase()}${step.slice(1)}`);
    section?.scrollIntoView({ block: "nearest" });
  }
}

function renderLearning() {
  if (!state.learningData) return;
  const { payload, champions, candidates, evaluations } = learningPayload();
  const trajectories = validLearningTrajectories(payload.trajectories);
  const scopedSkills = learningArray(payload.skills).filter(learningScopeMatches);
  const trajectoryCount = trajectories.length;
  const proposalCount = proposalTrajectories(payload.trajectories).length;
  const skillCount = scopedSkills.length || candidates.length + champions.length;
  const pendingCount = candidates.filter((skill) => !learningEvaluationFor(skill, evaluations)).length;
  $("#learningPipelineChips").innerHTML = [
    `${trajectoryCount} 条轨迹（${proposalCount} 条人工采纳）`,
    `${skillCount} 个技能版本`,
    pendingCount ? `${pendingCount} 个候选未评测` : "候选均已评测"
  ].map((text) => `<span class="learning-chip">${escapeHtml(text)}</span>`).join("");
  renderLearningPipelineVisibility();
  const selected = candidates.find((item) => learningId(item) === state.learningSelectedSkillId) || candidates[0] || null;
  const evaluation = selected ? learningEvaluationFor(selected, evaluations) : null;
  const champion = learningChampionFor(selected, champions);
  renderLearningChampion(champions, payload.scopeCounts);
  renderLearningCandidates(candidates, evaluations, champions, trajectoryCount);
  renderLearningEvaluation(selected, evaluation, champion);
  renderLearningActivatePanel({ selected, evaluation, champion, candidates });
  renderLearningSteps(learningStepStates({ champions, candidates, evaluations, champion, selected, evaluation }));
  bindLearningCardEvents();
  refreshActions();
}

function bindLearningCardEvents() {
  $$("[data-learning-select]").forEach((card) => {
    const select = () => { state.learningSelectedSkillId = card.dataset.learningSelect; state.learningStep = "evaluation"; renderLearning(); };
    card.addEventListener("click", (event) => { if (!event.target.closest("button, summary, a")) select(); });
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
  });
  $$("[data-learning-action]").forEach((button) => button.addEventListener("click", () => runLearningAction(button.dataset.skillId, button.dataset.learningAction, button)));
  $$("[data-skill-evidence]").forEach((details) => details.addEventListener("toggle", () => loadSkillEvidencePreview(details)));
}

/**
 * 第 5 步：启用候选。评测与门禁都过了才放行；结论过期时写清"为什么还不能点"，
 * 而不是让人点了才看到 409。
 */
function renderLearningActivatePanel({ selected, evaluation, champion, candidates }) {
  const container = $("#learningActivatePanel");
  const status = $("#learningActivateStatus");
  if (!container) return;
  if (!selected) {
    status.textContent = "未选择候选";
    container.innerHTML = `<div class="empty-list learning-empty"><div><strong>还没有候选技能</strong><span>先在 ② 生成候选技能，跑完 ③ 评测与 ④ 门禁后才能启用。</span></div></div>`;
    return;
  }
  const isActive = String(selected.status || "").toLowerCase() === "champion";
  const evaluationReady = Boolean(evaluation) && evaluationPassed(evaluation, selected);
  const gate = state.qualityGate;
  const coverage = gate?.assets?.coverage || null;
  const gateReady = gate?.status === "pass" && coverage?.valid !== false;
  const reasons = [];
  if (!evaluation) reasons.push("还没有评测结论");
  else if (!evaluationReady) reasons.push("评测结论不支持晋升");
  if (!gate || gate.status === "not_run") reasons.push("还没有门禁结论");
  else if (gate.status !== "pass") reasons.push("门禁未通过");
  else if (coverage?.valid === false) reasons.push("门禁结论已过期（资产版本更新过）");
  status.textContent = isActive ? "已经在生产" : reasons.length ? "还不能启用" : "可以启用";
  const gateLine = gate
    ? `门禁：${LEARNING_GATE_STATUS_LABELS[gate.status] || gate.status}${coverage ? ` · ${coverage.reason}` : ""}`
    : "门禁：尚未读取";
  const regressionLine = gate?.assets
    ? `本次跑 ${Number(gate.assets.gateCaseCount) || 0} / 共 ${Number(gate.assets.regressionCaseTotal) || 0} 条回归案例 · Gold ${Number(gate.assets.goldSampleCount) || 0} 条`
    : "";
  container.innerHTML = `
    <div class="learning-activate-summary">
      <div><strong>${escapeHtml(learningSkillTitle(selected))}</strong><small>${escapeHtml(learningVersion(selected))} · 基线 ${escapeHtml(champion ? learningVersion(champion) : "无生效版本")} · ${candidates.length} 个候选</small></div>
      <div class="learning-activate-facts">
        <span>评测：${evaluation ? (evaluationReady ? "可晋升" : "不支持晋升") : "尚未评测"}</span>
        <span>${escapeHtml(gateLine)}</span>
        ${regressionLine ? `<span>${escapeHtml(regressionLine)}</span>` : ""}
      </div>
      ${reasons.length ? `<p class="learning-activate-blockers">还不能启用：${escapeHtml(reasons.join("；"))}</p>` : ""}
    </div>
    <div class="learning-activate-actions">
      <button class="button primary small" type="button" data-learning-action="activate" data-skill-id="${escapeHtml(learningId(selected))}" ${isActive || reasons.length ? "disabled" : ""}>批准启用</button>
      <button class="button ghost small" type="button" data-learning-action="rollback" data-skill-id="${escapeHtml(learningId(selected))}" ${isActive ? "" : "disabled"}>回滚上一版本</button>
      <small>启用后原版本不会删除，随时可以回滚；门禁记录会连同资产版本一起留档。</small>
    </div>`;
}

async function loadLearning(locale = state.learningLocale) {
  state.learningLocale = locale;
  renderLocaleStrip($("#learningLocales"), locale, loadLearning);
  $("#learningError").hidden = true;
  state.learningLoading = true;
  refreshActions();
  try {
    const scope = learningActionBody();
    const params = new URLSearchParams({ locale, project: scope.project });
    // 评测任务清单和页面数据一起取：正在跑的候选一进页面就显示"评测中"，
    // 而不是等用户再点一次"运行评测"才知道后台还在跑。
    [state.learningData] = await Promise.all([
      api(`/api/learning?${params}`),
      loadLearningEvaluationJobs()
    ]);
    state.learningLoading = false;
    renderLearning();
    startLearningEvaluationWatch();
    loadQualityGate();
    loadTrainingRuns();
    renderLearningEvidenceFiles();
    loadLearningEvidence({ reset: true });
  } catch (error) {
    state.learningData = null;
    state.learningLoading = false;
    $("#learningErrorMessage").textContent = error.message;
    $("#learningError").hidden = false;
    $("#learningChampionStatus").textContent = "未加载";
    $("#learningCandidateCount").textContent = "—";
    $("#learningEvidenceCount").textContent = "—";
    $("#learningChampion").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningCandidateList").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningEvaluationMatrix").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningEvidenceList").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    refreshActions();
  }
}

function learningActionBody() {
  // 语体/领域由服务端自动判定并只作参考：前端不再传这两个维度。
  return { locale: state.learningLocale, project: state.activeProjectId || "default" };
}

async function runLearningAction(skillId, action, button) {
  if (!skillId) return toast("技能缺少可操作的版本 ID");
  if (action === "evaluate") return runSkillEvaluation(skillId);
  if (action === "retry-failed") return retryFailedEvaluation(button?.dataset.jobId, button);
  if (action === "delete") return deleteLearningSkill(skillId);
  const prompts = { activate: "确认批准这个候选并替换当前生效版本？原版本仍可回滚。", reject: "确认拒绝这个候选版本？它会保留在审计记录中。", rollback: "确认回滚到上一已验证版本？当前版本不会被删除。" };
  if (prompts[action] && !confirm(prompts[action])) return;
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "处理中……"; }
  try {
    await api(`/api/learning/skills/${encodeURIComponent(skillId)}/${action}`, { method: "POST", body: JSON.stringify(learningActionBody()) });
    toast({ activate: "候选已批准并成为当前生效版本", reject: "候选已拒绝", rollback: "已回滚到上一验证版本" }[action] || "操作已完成");
    await loadLearning(state.learningLocale);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

/** 评测任务只在这几种状态下才算"还在跑"。 */
const LEARNING_EVALUATION_ACTIVE_STATUSES = new Set(["queued", "running", "interrupted"]);

/**
 * 删掉一个候选技能版本。拒绝只是标记状态（仍留在列表里），删除才是清掉；
 * 已经产生的评测记录保留，所以这里只提示"候选从列表里消失"。
 */
async function deleteLearningSkill(skillId) {
  const candidate = (learningPayload().candidates || []).find((item) => learningId(item) === String(skillId));
  const label = candidate ? learningSkillTitle(candidate) : "该候选";
  if (!confirm(`确认删除「${label}」？删除后无法恢复；已产生的评测记录会保留。`)) return;
  try {
    await api(`/api/learning/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
    toast(`已删除「${label}」`);
    if (state.learningSelectedSkillId === String(skillId)) state.learningSelectedSkillId = "";
    await loadLearning(state.learningLocale);
  } catch (error) { toast(error.message); }
}

function isActiveEvaluationJob(job) {
  return Boolean(job) && LEARNING_EVALUATION_ACTIVE_STATUSES.has(String(job.status || ""));
}

function activeEvaluationJobs() {
  return (state.learningEvaluationJobs || []).filter(isActiveEvaluationJob);
}

/** 某个候选正在跑的评测任务。历史行为只把这个状态写进按钮文字，重绘一次就丢。 */
function activeEvaluationJobFor(skillId) {
  const id = String(skillId || "");
  return activeEvaluationJobs().find((job) => String(job.challengerId || job.challenger_id || "") === id) || null;
}

/** 最近一条"有失败样本"的评测：只有它能只重试失败的那几组，不用整条重跑。 */
function retryableEvaluationJobFor(skillId) {
  const id = String(skillId || "");
  return learningArray(state.learningEvaluationJobs)
    .filter((job) => String(job.challengerId || job.challenger_id || "") === id && Number(job.progress?.failed) > 0)
    .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
    .at(-1) || null;
}

function evaluationProgressText(job) {
  const requested = Number(job?.progress?.requested) || 0;
  const completed = Number(job?.progress?.completed) || 0;
  const failed = Number(job?.progress?.failed) || 0;
  return `评测中 ${completed}/${requested}${failed ? `（${failed} 失败）` : ""}……`;
}

/**
 * 评测任务清单（含已经跑完的）。不上范围参数时服务端按整项目返回，
 * 界面上再按 challengerId 与当前范围匹配，避免多范围之间串任务。
 */
async function loadLearningEvaluationJobs() {
  const params = new URLSearchParams(learningActionBody());
  try {
    // 后台轮询静默：失败不写日志、不点亮日志角标。
    const payload = await api(`/api/learning/evaluation-jobs${params.size ? `?${params}` : ""}`, {}, { logFailure: false });
    state.learningEvaluationJobs = learningArray(payload.jobs);
  } catch {
    state.learningEvaluationJobs = [];
  }
  return state.learningEvaluationJobs;
}

let learningEvaluationTimer = 0;
const LEARNING_EVALUATION_POLL_MS = 4000;

/** 只更新进度文字，不整页重绘：用户可能正在看别的卡片。 */
function syncLearningEvaluationProgress() {
  for (const button of $$('[data-learning-action="evaluate"]')) {
    const job = activeEvaluationJobFor(button.dataset.skillId);
    button.disabled = button.dataset.baselineCurrent !== "1" || Boolean(job);
    button.textContent = job
      ? evaluationProgressText(job)
      : button.dataset.hasEvaluation === "1" ? "重新评测" : "运行评测";
  }
}

function stopLearningEvaluationWatch() {
  if (learningEvaluationTimer) window.clearInterval(learningEvaluationTimer);
  learningEvaluationTimer = 0;
}

function startLearningEvaluationWatch() {
  if (!activeEvaluationJobs().length) { stopLearningEvaluationWatch(); return; }
  learningEvaluationTimer ||= window.setInterval(() => { tickLearningEvaluationJobs(); }, LEARNING_EVALUATION_POLL_MS);
}

/**
 * 跟踪在跑的评测：每个任务单独取一次状态，中途的网络抖动只跳过这一轮，
 * 不再把"评测中"退回"运行评测"（那正是用户看到的假象）。
 */
async function tickLearningEvaluationJobs() {
  const active = activeEvaluationJobs();
  if (!active.length) { stopLearningEvaluationWatch(); return; }
  let finished = null;
  for (const job of active) {
    const jobId = encodeURIComponent(job.jobId);
    let fresh = null;
    try { ({ job: fresh } = await api(`/api/learning/evaluation-jobs/${jobId}`, {}, { logFailure: false })); }
    catch { continue; }
    if (fresh.status === "interrupted") {
      try { ({ job: fresh } = await api(`/api/learning/evaluation-jobs/${jobId}/resume`, { method: "POST" }, { logFailure: false })); }
      catch (error) {
        // 候选被拒绝 / 已被替换时续跑永远不会成功：就地判失败并停止跟踪，
        // 否则每一轮轮询都会再试一次，变成 409 刷屏 + 反复弹提示。
        const reason = String(error.message || "").replace(/^无法续跑：/u, "");
        state.learningEvaluationJobs = (state.learningEvaluationJobs || []).map((item) => item.jobId === job.jobId
          ? { ...item, status: "failed", error: `无法续跑：${reason}`, finishedAt: new Date().toISOString() }
          : item);
        toast(`评测任务无法续跑：${reason}`);
        continue;
      }
    }
    state.learningEvaluationJobs = (state.learningEvaluationJobs || []).map((item) => item.jobId === fresh.jobId ? fresh : item);
    if (["completed", "failed"].includes(fresh.status)) finished = fresh;
  }
  syncLearningEvaluationProgress();
  if (!finished) return;
  stopLearningEvaluationWatch();
  if (finished.status === "completed") {
    const report = finished.result?.report;
    toast(report?.promotable ? "候选评测完成并通过晋升门槛，可批准启用" : `候选评测完成：${report?.conclusion || "未通过晋升门槛"}`);
  } else {
    toast(`评测任务失败：${finished.error || "未知错误"}`);
  }
  await loadLearning(state.learningLocale);
}

/**
 * 只重试失败的样本。
 *
 * 一条 27 组样本的评测挂掉一组时，"重新评测"要重跑全部 27 组；这里只把失败的那几组
 * 重新排进队列，已成功的样本沿用原结果（服务端从检查点里取回同一份冻结输入）。
 */
async function retryFailedEvaluation(jobId, button) {
  if (!jobId) return toast("找不到要重试的评测任务");
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "重试中……"; }
  try {
    const { job } = await api(`/api/learning/evaluation-jobs/${encodeURIComponent(jobId)}/retry-failed`, { method: "POST" });
    const remaining = Math.max(0, (Number(job?.progress?.requested) || 0) - (Number(job?.progress?.completed) || 0));
    toast(remaining ? `只重试失败的 ${remaining} 组样本，已成功的样本继续沿用` : "已把失败样本重新排进队列");
    state.learningEvaluationJobs = [...(state.learningEvaluationJobs || []).filter((item) => item.jobId !== job?.jobId), job].filter(Boolean);
    renderLearning();
    startLearningEvaluationWatch();
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function runSkillEvaluation(skillId) {
  try {
    const created = await api(`/api/learning/skills/${encodeURIComponent(skillId)}/evaluate`, { method: "POST", body: JSON.stringify(learningActionBody()) });
    if (!created.jobId) {
      // 留出集不足 20 条：服务端已生成可审计的 insufficient 结论，无需模型调用。
      toast(created.result?.conclusion || "证据不足，暂不能发起真实评测");
      await loadLearning(state.learningLocale);
      return;
    }
    if (created.alreadyRunning) toast("该候选已有进行中的评测任务，已接续跟踪");
    state.learningEvaluationJobs = [...(state.learningEvaluationJobs || []).filter((job) => job.jobId !== created.jobId), created.job];
    renderLearning();
    startLearningEvaluationWatch();
  } catch (error) {
    toast(error.message);
  }
}

async function generateLearningSkill() {
  setBusy(true, "正在提炼候选技能……");
  try {
    const result = await api("/api/learning/skills/generate", { method: "POST", body: JSON.stringify(learningActionBody()) });
    const generated = result.skill || result.candidate || result.data;
    if (generated) state.learningSelectedSkillId = learningId(generated);
    toast("已根据人工采纳终稿生成隔离候选，下一步请运行评测");
    await loadLearning(state.learningLocale);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function cleanTable() {
  if (!state.importFile) return toast("请先选择表格");
  setBusy(true, "识别与清洗中…");
  state.importBatchLearning = [];
  renderImportBatchLearning();
  const progressId = globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const progressControl = { done: false };
  const progressWatcher = watchImportProgress(progressId, progressControl);
  try {
    const result = await api("/api/term-import/preview", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: state.importFile.name,
      base64: await fileToBase64(state.importFile),
      progressId
    }) });
    result.candidates.forEach((candidate) => { candidate.selected = candidate.decision === "ready" && !candidate.existing; });
    state.importPreview = result;
    state.importCompleted = false;
    state.importVisibleCount = { terms: 150, styles: 150 };
    const mappings = result.sheets.map((sheet) => `${sheet.sheet}：日语列 ${sheet.sourceColumn}，简体中文列 ${Object.entries(sheet.targetColumns).map(([locale, column]) => `${state.bootstrap.locales[locale].shortLabel} ${column}`).join(" / ")}`).join("；");
    const structureText = result.structureAnalysis?.used
      ? "AI 已识别列结构（支持无表头）"
      : result.structureAnalysis?.requested ? "AI 结构识别不可用，已回退本地整列推断" : "使用本地整列推断";
    const aiText = result.ai?.used ? `AI 已复核 ${result.ai.reviewed} 条` : result.ai?.requested ? `AI 清洗不可用，已回退本地规则` : "使用本地规则清洗";
    $("#mappingNote").textContent = `${mappings}。${structureText}；${aiText}。候选不会在确认前写入正式术语库。`;
    renderImportCandidates();
    toast(`已筛出 ${result.candidates.length} 组候选，请审核后导入`);
  } catch (error) {
    updateImportProgress({ message: `识别失败：${error.message}`, percent: 100 });
    toast(error.message);
  }
  finally {
    progressControl.done = true;
    await progressWatcher;
    setBusy(false);
  }
}

async function commitImport() {
  if (!state.importPreview) return;
  if (!selectedCandidates().length) return toast("请至少选择一组候选资产");
  setBusy(true, "正在分库写入…");
  // 几千条的分库写入要跑几分钟：预检批次已经建了后台任务，这里跟着它的进度走，
  // 不要只让按钮变成"正在分库写入…"然后就静止不动。
  const backgroundTaskId = state.importPreview.backgroundTaskId || "";
  let watching = Boolean(backgroundTaskId);
  const watcher = (async () => {
    const startedAt = Date.now();
    while (watching) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!watching) return;
      const task = await api(`/api/background-tasks/${encodeURIComponent(backgroundTaskId)}`).catch(() => null);
      if (!task) return;
      updateImportProgress({ ...(task.progress || {}), message: `${task.progress?.message || "正在分库写入"} · 已用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒` });
      if (["completed", "failed", "needs_attention"].includes(task.status)) return;
    }
  })();
  try {
    const result = await api("/api/term-import/commit", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId: state.importPreview.batchId,
      filename: state.importPreview.filename,
      candidates: state.importPreview.candidates,
      backgroundTaskId: state.importPreview.backgroundTaskId || ""
    }) });
    state.importCompleted = true;
    const importedIds = new Set(result.imported.map((item) => `${item.locale}\u0000${item.source}\u0000${item.target}`));
    state.importPreview.candidates.forEach((candidate) => {
      if (importedIds.has(`${candidate.locale}\u0000${candidate.source}\u0000${candidate.target}`)) candidate.existing = true;
      candidate.selected = false;
    });
    state.importBatchLearning = learningRunsFromPayload(result, { includeProfileFallback: true });
    renderImportBatchLearning();
    const pendingStyles = (result.styleFallbacks || []).slice(0, 4).map((item) => `${state.bootstrap.locales[item.locale]?.shortLabel || item.locale} ${contentTypeLabel(item.contentType)} ${styleDistillProgress(item)}`).join("；");
    const learnedText = state.importBatchLearning.length ? `本批已形成 ${state.importBatchLearning.length} 个风格学习范围，具体内容见下方。` : "本批没有生成可展示的风格学习结果。";
    const skippedReasons = Object.entries(result.summary.skippedByReason || {}).map(([reason, count]) => `${reason} ${count}`).join("；");
    $("#mappingNote").textContent = `批次已完成：写入术语 ${result.summary.terms || 0} 条、完整译例 / 风格证据 ${result.summary.memories || 0} 条、生成风格草稿 ${result.summary.styleProfiles || 0} 个，跳过 ${result.summary.skipped ?? result.skipped.length} 条${skippedReasons ? `（${skippedReasons}）` : ""}。${learnedText}${pendingStyles ? ` 尚在积累：${pendingStyles}。` : ""}所有资产均按日语→简体中文语言对与自动识别语体隔离。`;
    renderImportCandidates();
    await Promise.all([...new Set(result.imported.filter((item) => item.assetType === "term").map((item) => item.locale))].map((locale) => loadAssets(locale)));
    toast(`已导入 ${result.summary.terms || 0} 条术语和 ${result.summary.memories || 0} 条翻译记忆`);
  } catch (error) { toast(error.message); }
  finally {
    watching = false;
    await watcher;
    setBusy(false);
  }
}

function populateSelects() {
  // 语体/领域不再有用户选择器：术语、学习资产与冲突审查都按项目级处理。
  $("#taskLocale").innerHTML = Object.entries(state.bootstrap.locales).map(([locale, details]) => `<option value="${locale}">日语→${details.label}</option>`).join("");
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('input[name="importPurpose"]').forEach((input) => input.addEventListener("change", () => syncImportPurposeControls({ resetDefaults: true })));
  $("#importAiCleaning")?.addEventListener("change", (event) => { state.assetImportAiCleaning = event.target.checked; });
  $("#importStyleEvidence")?.addEventListener("change", (event) => { state.assetImportStyleEvidence = event.target.checked; });
  $("#memoryStyleEvidence")?.addEventListener("change", (event) => { state.memoryStyleEvidence = event.target.checked; });
  // 通知中心：铃铛开合、点外面或 Esc 关闭、点条目跳到对应页面。
  $("#notificationBell")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setNotificationPanel($("#notificationPanel").hidden);
  });
  $("#notificationMarkRead")?.addEventListener("click", (event) => { event.stopPropagation(); setNotificationSeenAt(new Date().toISOString()); renderNotificationCenter(); });
  $("#notificationPanel")?.addEventListener("click", (event) => event.stopPropagation());
  $("#notificationList")?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-notification-view]");
    if (!item) return;
    setNotificationPanel(false);
    if (item.dataset.notificationView) switchView(item.dataset.notificationView);
  });
  document.addEventListener("click", () => { if (!$("#notificationPanel")?.hidden) setNotificationPanel(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#notificationPanel")?.hidden) setNotificationPanel(false);
  });
  $("#assetPreflightDialog").addEventListener("close", () => { resolveAssetPreflight(); refreshActions(); });
  $("#assetPreflightClose").addEventListener("click", () => closeAssetPreflightDialog());
  $("#importPreflightResumeOpen")?.addEventListener("click", () => reopenAssetPreflight());
  $("#importPreflightResumeReset")?.addEventListener("click", () => { if (state.importFiles.length) setImportFiles(state.importFiles); });
  $("#importPreflightCancel")?.addEventListener("click", () => cancelAssetImport());
  // 预检弹窗里的去向：类型与目标库都能直接改，改完立刻回写到页面上那一组控件。
  $$('input[name="assetPreflightPurpose"]').forEach((input) => input.addEventListener("change", () => {
    state.assetImportPurpose = input.value === "tm" ? "tm" : "term";
    $$('input[name="importPurpose"]').forEach((pageInput) => { pageInput.checked = pageInput.value === state.assetImportPurpose; });
    renderAssetPreflight();
  }));
  $("#assetPreflightTermLibrary")?.addEventListener("change", (event) => {
    state.importTermLibraryId = event.target.value;
    if ($("#importTermLibrary")) $("#importTermLibrary").value = state.importTermLibraryId;
    renderAssetPreflight();
  });
  $("#assetPreflightTmLibrary")?.addEventListener("change", (event) => {
    state.importTmLibraryId = event.target.value;
    if ($("#importTmLibrary")) $("#importTmLibrary").value = state.importTmLibraryId;
    renderAssetPreflight();
  });
  $("#assetPreflightAddLibrary")?.addEventListener("click", () => openProjectLibraries({ addKind: state.assetImportPurpose === "tm" ? "translation_memory" : "term_base" }));
  $("#importAddLibrary")?.addEventListener("click", () => openProjectLibraries({ addKind: state.assetImportPurpose === "tm" ? "translation_memory" : "term_base" }));
  $("#assetPreflightAiCleaning")?.addEventListener("change", (event) => {
    state.assetImportAiCleaning = event.target.checked;
    renderAssetPreflight();
  });
  $("#assetPreflightStyleEvidence")?.addEventListener("change", (event) => {
    state.assetImportStyleEvidence = event.target.checked;
    renderAssetPreflight();
  });
  $$(".translation-mode").forEach((button) => button.addEventListener("click", () => setTranslationMode(button.dataset.translationMode)));
  $("#primaryAction").addEventListener("click", () => {
    if (state.view === "workbench" && state.translationMode === "files") $("#batchFile").click();
    else if (state.view === "workbench" && state.translationMode === "single") translate();
    else if (state.view === "workbench" && state.batchRunning) {
      pauseBatch().catch((error) => toast(error.message));
    }
    else if (state.view === "workbench") state.batchPreview ? runBatch() : prepareBatch();
    else if (state.view === "import") state.assetPreflight ? reopenAssetPreflight() : state.importPreview && !state.importCompleted ? commitImport() : state.importFiles.length ? setImportFiles(state.importFiles) : cleanTable();
    else if (state.view === "tasks") loadTasks().catch((error) => toast(error.message));
    else if (state.view === "memories") loadMemories(state.memoryLocale).catch((error) => toast(error.message));
    else if (state.view === "styles") loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message));
    else if (state.view === "learning") generateLearningSkill();
    else if (state.view === "autoqa") {
      const source = state.qaSource || "batch";
      const task = source === "batch" ? runQaFromBatch() : source === "file" ? runQaFromFile() : runAutoQa();
      Promise.resolve(task).catch((error) => toast(error.message));
    }
    else { resetTermDialog(); $("#assetDialog").showModal(); }
  });
  $("#secondaryAction").addEventListener("click", () => {
    if (state.view === "autoqa") return clearAutoQa();
    if (state.view === "workbench" && state.translationMode === "batch") resetBatch().catch((error) => toast(error.message));
    else if (state.view === "workbench") clearTranslation();
    else resetImport();
  });
  $("#tertiaryAction").addEventListener("click", async () => {
    if (state.view === "workbench" && state.translationMode === "batch") return exportBatch();
    await navigator.clipboard.writeText(state.lastResult.translation);
    toast("译文已复制");
  });
  $("#cancelBatchAction")?.addEventListener("click", () => cancelBatchRun().catch((error) => toast(error.message)));
  $("#reviewImportFile").addEventListener("change", (event) => submitReviewImport(event.target.files?.[0]));
  $("#batchJumpNext").addEventListener("click", () => jumpToNextBatchIssue());
  $("#batchQualityTier")?.addEventListener("change", () => {
    syncQualityTier($("#batchQualityTier").value, $("#batchQualityTier"));
    if (state.batchPreview) saveBatchProgress();
    toast(`质量档已设为${$("#batchQualityTier").selectedOptions[0]?.textContent || "自动"}，下一段起生效`);
  });
  $("#qualityTier")?.addEventListener("change", () => {
    syncQualityTier($("#qualityTier").value, $("#qualityTier"));
    if (state.batchPreview) saveBatchProgress();
  });
  $("#batchBriefRerun")?.addEventListener("click", () => rerunBatchBrief());
  $("#batchBriefEditToggle")?.addEventListener("click", () => toggleBatchBriefEdit());
  $("#batchBriefSave")?.addEventListener("click", () => saveBatchBriefEdit());
  $("#batchBriefCancel")?.addEventListener("click", () => { state.batchBriefDraft = null; renderBatchBrief(); });
  $("#batchConsistencyRun")?.addEventListener("click", () => runConsistencyCheckNow());
  $("#batchRetryQa")?.addEventListener("click", () => retryBatchQa());
  $("#batchBriefPanel")?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-brief-note-remove]");
    if (!remove || !state.batchBriefDraft) return;
    state.batchBriefDraft.notes.splice(Number(remove.dataset.briefNoteRemove), 1);
    renderBatchBrief();
  });
  $("#qaSourceTabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".qa-source-tab");
    if (tab) setQaSource(tab.dataset.qaSource);
  });
  $("#qaBatchLoad").addEventListener("click", () => runQaFromBatch());
  $("#qaFile").addEventListener("change", (event) => {
    state.qaFile = event.target.files?.[0] || null;
    $("#qaFilePrompt").textContent = state.qaFile ? `已选择：${state.qaFile.name}` : "上传双语文件";
    $("#qaFileRun").disabled = !state.qaFile;
    refreshActions();
  });
  $("#qaFileRun").addEventListener("click", () => runQaFromFile());
  $("#qaFilters").addEventListener("click", (event) => {
    const chip = event.target.closest(".qa-filter-chip");
    if (!chip) return;
    state.qaFilter = chip.dataset.qaFilter || "";
    state.qaCursor = -1;
    renderQaSegments();
  });
  $("#qaJumpNext").addEventListener("click", () => jumpToNextQaSegment());
  $("#qaDownload").addEventListener("click", () => downloadQaReport());
  $("#sourceText").addEventListener("input", previewClassificationAndMatches);
  $("#autoQaSource").addEventListener("input", () => {
    $("#autoQaSourceCount").textContent = `${[...$("#autoQaSource").value].length} 字`;
    $("#autoQaState").textContent = "等待质检";
    $("#autoQaState").className = "badge neutral";
    refreshActions();
  });
  $("#autoQaTarget").addEventListener("input", () => {
    $("#autoQaState").textContent = "等待质检";
    $("#autoQaState").className = "badge neutral";
    refreshActions();
  });
  ["autoQaSource", "autoQaTarget"].forEach((id) => $(`#${id}`).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) runAutoQa().catch((error) => toast(error.message));
  }));
  $("#batchTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-batch-tab]");
    if (!tab) return;
    setBatchTab(tab.dataset.batchTab);
  });
  // 分段搜索：原文 / 译文 / ID / 注释，150ms 防抖，Esc 清空。
  $("#batchSegmentSearch").addEventListener("input", (event) => {
    clearTimeout(segmentSearchTimer);
    const value = event.target.value;
    segmentSearchTimer = window.setTimeout(() => {
      state.batchSegmentQuery = value;
      batchSegmentLimit = BATCH_SEGMENT_PAGE_SIZE;
      renderBatchSegments();
    }, 150);
  });
  $("#batchSegmentSearch").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.target.value = "";
    clearTimeout(segmentSearchTimer);
    state.batchSegmentQuery = "";
    batchSegmentLimit = BATCH_SEGMENT_PAGE_SIZE;
    renderBatchSegments();
  });
  $("#batchSegments").addEventListener("click", (event) => {
    const note = event.target.closest(".segment-meta-note");
    if (!note) return;
    note.closest(".segment-meta-field")?.classList.toggle("is-open");
  });
  $("#batchTermSurveyRun").addEventListener("click", () => runTermSurveyNow());
  $("#batchTermSurveyFilters").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-term-filter]");
    if (!chip) return;
    state.termFilter = chip.dataset.termFilter || "";
    renderBatchTermSurvey();
  });
  $("#batchFile").addEventListener("change", (event) => setBatchFile(event.target.files[0]));
  $("#batchSegmentationMode").addEventListener("change", () => {
    if (!state.batchPreview) return;
    state.batchPreview = null;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    renderBatchSegments();
    refreshActions();
    if (state.batchFile) prepareBatch();
  });
  $("#batchDropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#batchDropZone").classList.add("dragging"); });
  $("#batchDropZone").addEventListener("dragleave", () => $("#batchDropZone").classList.remove("dragging"));
  $("#batchDropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#batchDropZone").classList.remove("dragging"); setBatchFile(event.dataTransfer.files[0]); });
  $("#assetSearch").addEventListener("input", () => {
    clearTimeout(termSearchTimer);
    termSearchTimer = setTimeout(() => {
      if (state.view !== "assets" || !state.assetLibraryId) return;
      loadLibraryEntries("term", { append: false }).catch((error) => toast(error.message));
    }, 300);
  });
  $("#assetMore").addEventListener("click", () => loadLibraryEntries("term", { append: true }).catch((error) => toast(error.message)));
  // 库列表：启用开关、打开 / 导入 / 导出 / 设置 / 删除。
  for (const [kind, selector] of [["term", "#assetLibraryBody"], ["tm", "#memoryLibraryBody"]]) {
    $(selector).addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-library-toggle]");
      if (toggle) {
        toggleLibraryEnabled(kind, toggle.dataset.id, toggle.checked).catch((error) => {
          toggle.checked = !toggle.checked;
          toast(error.message);
        });
        return;
      }
      const button = event.target.closest("[data-library-action]");
      if (!button) return;
      const libraryId = button.dataset.id || "";
      if (button.dataset.libraryAction === "open") openLibrary(kind, libraryId).catch((error) => toast(error.message));
      else if (button.dataset.libraryAction === "import") importIntoLibrary(kind, libraryId);
      else if (button.dataset.libraryAction === "export") exportLibrary(kind, libraryId, button);
      else if (button.dataset.libraryAction === "priority") moveLibraryPriority(kind, libraryId, button.dataset.direction).catch((error) => toast(error.message));
      else if (button.dataset.libraryAction === "settings") openProjectSettings({ tab: "libraries" });
      else if (button.dataset.libraryAction === "delete") deleteLibrary(kind, libraryId);
    });
  }
  // 库列表页自己带新增入口：不再要求先想到去项目设置里找。
  $("#assetAddLibrary")?.addEventListener("click", () => openProjectLibraries({ addKind: "term_base" }));
  $("#memoryAddLibrary")?.addEventListener("click", () => openProjectLibraries({ addKind: "translation_memory" }));
  $("#assetBreadcrumbBack").addEventListener("click", () => closeLibrary("term").catch((error) => toast(error.message)));
  // 面包屑返回是"退一步"：在文件层里先退到文件列表，在文件列表里才退到库列表。
  $("#memoryBreadcrumbBack").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    // 切换期间禁用：连点两次会连跳两级，既容易点错也会让页面处于中间状态。
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (state.memoryLibraryFile) await closeLibraryFile("tm");
      else await closeLibrary("tm");
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  $("#memoryFileBody").addEventListener("click", (event) => {
    const button = event.target.closest("[data-file-action]");
    if (!button) return;
    const key = button.dataset.key || "";
    if (button.dataset.fileAction === "open") openLibraryFile("tm", key).catch((error) => toast(error.message));
    else if (button.dataset.fileAction === "export") {
      exportLibrary("tm", state.memoryLibraryId, button, key);
    } else if (button.dataset.fileAction === "delete") deleteLibraryFile("tm", key).catch((error) => toast(error.message));
  });
  $("#assetList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-term-action]");
    if (!button) return;
    const entry = state.assetEntries.find((item) => item.id === button.dataset.id);
    if (button.dataset.termAction === "edit") openTermEditDialog(entry);
    else if (button.dataset.termAction === "delete") deleteTermEntry(entry).catch((error) => toast(error.message));
  });
  $("#memoryList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-memory-action]");
    if (!button) return;
    const entry = state.memories.find((item) => item.id === button.dataset.id);
    if (button.dataset.memoryAction === "edit") openMemoryEntryDialog(entry);
    else if (button.dataset.memoryAction === "delete") deleteMemoryEntry(entry).catch((error) => toast(error.message));
  });
  $("#importTermLibrary")?.addEventListener("change", (event) => { state.importTermLibraryId = event.target.value; });
  $("#importTmLibrary")?.addEventListener("change", (event) => { state.importTmLibraryId = event.target.value; });
  $("#memoryEntryForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = $("#memoryEntryId").value;
    if (!id) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/memories/${encodeURIComponent(id)}?locale=${encodeURIComponent(state.memoryLocale)}`, {
        method: "PATCH",
        body: JSON.stringify({ source: form.source.value, target: form.target.value, entryKey: form.entryKey.value })
      });
      $("#memoryEntryDialog").close();
      toast("TM 条目已更新");
      await loadAssetsSafeRefresh("tm");
    } catch (error) { toast(error.message); }
    finally { submit.disabled = false; }
  });
  $("#termLibraryFile").addEventListener("change", (event) => {
    const files = event.target.files;
    if (!files.length) return;
    switchView("import");
    setImportFiles(files, { intent: "terms", returnView: "assets" }).finally(() => { event.target.value = ""; });
  });
  $("#memorySearch").addEventListener("input", () => {
    clearTimeout(memorySearchTimer);
    memorySearchTimer = setTimeout(() => {
      if (state.view !== "memories") return;
      if (!state.memoryLibraryId) return;
      loadLibraryEntries("tm", { append: false }).catch((error) => toast(error.message));
    }, 300);
  });
  $("#memoryMore").addEventListener("click", () => loadLibraryEntries("tm", { append: true }).catch((error) => toast(error.message)));
  $("#memoryFile").addEventListener("change", (event) => {
    state.memoryImportFiles = [...event.target.files];
    state.memoryImportFile = state.memoryImportFiles[0] || null;
    $("#memoryImportButton").disabled = !state.memoryImportFiles.length;
    $("#memoryImportButton").textContent = state.memoryImportFiles.length > 1 ? `重新预检 ${state.memoryImportFiles.length} 个文件` : "重新预检 TM";
    renderMemoryImportFiles();
    if (!state.memoryImportFiles.length) {
      $("#memoryImportNote").textContent = "选择文件后会自动本地预检；确认后写入主 TM。";
      $("#memoryImportPreview").hidden = true;
      return;
    }
    // 选中即预检：等用户再点一次按钮，很多人会以为"没导入"。
    previewMemoryImport();
  });
  $("#memoryImportButton").addEventListener("click", () => previewMemoryImport());
  $("#memoryImportConfirm").addEventListener("click", () => commitMemoryImport());
  $("#memoryImportMore").addEventListener("click", () => loadMoreMemoryImport());
  // 勾选状态记在 Set 里：列表是分页渲染的，不能靠"当前 DOM 里有哪些 checkbox"判断。
  $("#memoryImportPreviewBody").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-memory-index]");
    const preview = state.memoryImportPreview;
    if (!input || !preview) return;
    const index = Number(input.dataset.memoryIndex);
    if (!Number.isFinite(index)) return;
    if (input.checked) preview.deselected.delete(index);
    else preview.deselected.add(index);
  });
  $("#taskLocale").addEventListener("change", loadTasks);
  $("#taskType").addEventListener("change", loadTasks);
  $("#taskSearch").addEventListener("input", () => { clearTimeout(state.taskSearchTimer); state.taskSearchTimer = setTimeout(() => loadTasks().catch((error) => toast(error.message)), 250); });
  $("#refreshTasks").addEventListener("click", () => loadTasks().catch((error) => toast(error.message)));
  $("#taskFilterToggle").addEventListener("click", () => {
    const panel = $("#taskFilterPanel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("#taskFilterToggle").setAttribute("aria-expanded", String(open));
  });
  $("#taskSummary").addEventListener("click", (event) => {
    const button = event.target.closest("[data-task-filter]");
    if (!button) return;
    const value = button.dataset.taskFilter;
    state.taskFilter = value === "all" || value === state.taskFilter ? "" : value;
    renderTasks();
  });
  $("#taskList").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-task-bundle-toggle]");
    if (!toggle) return;
    const key = toggle.dataset.taskBundleToggle;
    if (state.taskGroupExpanded.has(key)) state.taskGroupExpanded.delete(key);
    else state.taskGroupExpanded.add(key);
    renderTasks();
  });
  $("#styleStatus").addEventListener("change", renderStyleGuidance);
  $("#refreshStyles").addEventListener("click", () => loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message)));
  $("#logLevels").addEventListener("click", (event) => {
    const chip = event.target.closest(".log-level-chip");
    if (!chip) return;
    state.logLevel = chip.dataset.level || "";
    loadLogs().catch((error) => toast(error.message));
  });
  $("#logSearch").addEventListener("input", (event) => {
    state.logSearch = event.target.value.trim();
    clearTimeout(state.logSearchTimer);
    state.logSearchTimer = setTimeout(() => loadLogs().catch((error) => toast(error.message)), 250);
  });
  $("#logVerbosity").addEventListener("change", async (event) => {
    const level = event.target.value;
    try {
      const settings = await api("/api/logs/settings", { method: "POST", body: JSON.stringify({ level }) });
      $("#logVerbosity").value = settings.level;
      toast(`记录等级已切换为「${LOG_LEVEL_LABELS[settings.level] || settings.level}」`);
      await loadLogs();
    } catch (error) { toast(error.message); }
  });
  $("#logAutoRefresh").addEventListener("change", () => { if (state.view === "logs") startLogAutoRefresh(); else stopLogAutoRefresh(); });
  $("#logRefresh").addEventListener("click", () => loadLogs().catch((error) => toast(error.message)));
  $("#logDownload").addEventListener("click", () => { window.open("/api/logs/download", "_blank", "noopener"); });
  $("#logClear").addEventListener("click", async () => {
    if (!confirm("清空日志？磁盘上的日志文件也会一起删除。")) return;
    try {
      await api("/api/logs", { method: "DELETE" });
      await loadLogs();
      toast("日志已清空");
    } catch (error) { toast(error.message); }
  });
  $("#styleGuideFile").addEventListener("change", (event) => {
    state.styleGuideFile = event.target.files[0] || null;
    $("#styleGuideImportButton").disabled = !state.styleGuideFile;
    renderStyleGuidePicker();
    const note = $("#styleGuideImportNote");
    note.className = "library-import-note";
    note.textContent = state.styleGuideFile
      ? "已选择文件，点右侧按钮导入并立即启用。"
      : "人工风格指南按你的原话生效，优先级高于自动蒸馏出的规则，只作用于当前项目。";
  });
  $("#styleGuideImportButton").addEventListener("click", () => importStyleGuide());
  $("#retryLearning").addEventListener("click", () => loadLearning(state.learningLocale));
  $("#styleConflictScan").addEventListener("click", (event) => runStyleConflictScan(event.currentTarget));
  $("#learningGateRun").addEventListener("click", (event) => runQualityGateFromUi(event.currentTarget));
  $("#learningGoldSeed").addEventListener("click", (event) => seedGoldSetFromTrajectories(event.currentTarget));
  $("#learningRegressionBuild").addEventListener("click", (event) => buildRegressionSuiteFromUi(event.currentTarget));
  $("#learningExportAudit").addEventListener("click", (event) => auditTrainingExport(event.currentTarget));
  $("#learningExportSft").addEventListener("click", (event) => downloadTrainingDataset("sft", event.currentTarget));
  $("#learningExportDpo").addEventListener("click", (event) => downloadTrainingDataset("dpo", event.currentTarget));
  $("#learningEvidenceKind").addEventListener("change", () => loadLearningEvidence({ reset: true }));
  $("#learningEvidenceFile").addEventListener("change", () => loadLearningEvidence({ reset: true }));
  $("#learningEvidenceMore").addEventListener("click", () => loadLearningEvidence());
  $("#learningTrainingMore").addEventListener("click", () => loadTrainingRuns({ reset: false }));
  let evidenceSearchTimer = null;
  $("#learningEvidenceSearch").addEventListener("input", () => {
    clearTimeout(evidenceSearchTimer);
    evidenceSearchTimer = setTimeout(() => loadLearningEvidence({ reset: true }), 300);
  });
  $("#trainingCreate").addEventListener("click", (event) => createTrainingRunFromUi(event.currentTarget));
  $("#termFile").addEventListener("change", (event) => setImportFiles(event.target.files));
  $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("dragging"); });
  $("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("dragging"));
  $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("dragging"); setImportFiles(event.dataTransfer.files); });
  $("#assetPreflightConfirm").addEventListener("click", () => confirmAssetPreflight());
  $$('[data-import-candidate-tab]').forEach((button) => button.addEventListener("click", () => setImportCandidateTab(button.dataset.importCandidateTab)));
  [["#selectAllTermCandidates", "terms"], ["#selectAllStyleCandidates", "styles"]].forEach(([selector, kind]) => $(selector).addEventListener("change", (event) => {
    indexedImportCandidates(kind).forEach(({ candidate }) => { if (!candidate.existing && candidate.decision !== "excluded") candidate.selected = event.target.checked; });
    renderImportCandidates();
  }));
  $("#assetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const editingId = $("#assetDialogId").value;
    const payload = {
      source: form.get("source"), target: form.get("target"),
      aliases: String(form.get("aliases") || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean),
      forbidden: String(form.get("forbidden") || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean),
      // 语体/领域由系统按文件自动判定，术语默认全项目通用（标签只作参考）。
      contentTypes: ["general"], domains: ["general"], enforcement: "preferred", note: form.get("note")
    };
    try {
      if (editingId) {
        // 编辑只改内容：库归属由服务端保留，不会被"默认库"覆盖。
        await api(`/api/assets/${encodeURIComponent(editingId)}?locale=${encodeURIComponent(state.assetLocale)}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/assets", { method: "POST", body: JSON.stringify({
          ...projectPayload(),
          locale: state.assetLocale,
          // 打开某个库时"新增单条"就加进这个库；在库列表页则用项目默认库。
          term: { ...payload, ...(state.assetLibraryId ? { libraryId: state.assetLibraryId } : {}) }
        }) });
      }
      resetTermDialog();
      $("#assetDialog").close();
      await loadAssetsSafeRefresh("term");
      toast(editingId ? "术语已更新" : `已保存到${state.bootstrap.locales[state.assetLocale].label}术语库`);
    } catch (error) { toast(error.message); }
  });
  $("#refreshReferences").addEventListener("click", () => loadReferences().catch((error) => toast(error.message)));
  $("#referenceStatus").addEventListener("change", (event) => { state.referenceStatus = event.target.value; clearReferenceSelection(); loadReferences().catch((error) => toast(error.message)); });
  $("#referenceSearch").addEventListener("change", (event) => { state.referenceSearch = event.target.value.trim(); clearReferenceSelection(); loadReferences().catch((error) => toast(error.message)); });
  $("#referenceNewFolder").addEventListener("click", () => openReferenceFolderDialog({ mode: "create", parentId: state.referenceFolderId || "" }));
  $("#referenceLoadMore").addEventListener("click", () => loadReferences({ append: true }).catch((error) => toast(error.message)));
  $("#referenceSelectAll").addEventListener("click", () => selectAllReferenceDocuments().catch((error) => toast(error.message)));
  $("#referenceClearSelection").addEventListener("click", clearReferenceSelection);
  $("#referenceBatchDescribe").addEventListener("click", () => batchDescribeReferenceSelection().catch((error) => toast(error.message)));
  $$("[data-reference-vision]").forEach((button) => button.addEventListener("click", () => setReferenceVisionMode(button.dataset.referenceVision)));
  $("#referenceAutoScan").addEventListener("change", (event) => setReferenceAutoScan(event.target.checked));
  $("#referenceFolderForm").addEventListener("submit", submitReferenceFolderForm);
  $("#referenceMoveForm").addEventListener("submit", submitReferenceMoveForm);
  $("#referenceFileInput").addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    uploadReferenceFiles(files).catch((error) => toast(error.message));
  });
  $("#referenceFolderInput").addEventListener("change", (event) => {
    const items = referenceItemsFromInput(event.target.files, { relative: true });
    event.target.value = "";
    uploadReferenceItems(items, state.referenceFolderId || "").catch((error) => toast(error.message));
  });
  $("#referenceTree").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-reference-tree-toggle]");
    if (toggle) {
      const id = toggle.dataset.referenceTreeToggle;
      if (state.referenceExpanded.has(id)) state.referenceExpanded.delete(id);
      else state.referenceExpanded.add(id);
      renderReferenceTree();
      return;
    }
    const open = event.target.closest("[data-reference-folder-open]");
    if (open) {
      state.referenceFolderId = open.dataset.referenceFolderOpen || "";
      state.referenceSearch = "";
      $("#referenceSearch").value = "";
      clearReferenceSelection();
      loadReferences().catch((error) => toast(error.message));
      return;
    }
    const menu = event.target.closest("[data-reference-folder-menu]");
    if (menu) openReferenceContextMenu(event, { kind: "folder", id: menu.dataset.referenceFolderMenu });
  });
  $("#referenceBreadcrumb").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-folder-open]");
    if (!button) return;
    state.referenceFolderId = button.dataset.referenceFolderOpen || "";
    clearReferenceSelection();
    loadReferences().catch((error) => toast(error.message));
  });
  // 待译文件列表：刷新 / 筛选 / 搜索 / 返回 / 行内操作。
  $("#batchFilesRefresh")?.addEventListener("click", () => loadBatchFiles().catch((error) => toast(error.message)));
  $("#batchFileStatus")?.addEventListener("change", (event) => { state.batchFileStatus = event.target.value; renderBatchFileList(); });
  $("#batchFileSearch")?.addEventListener("input", (event) => { state.batchFileSearch = event.target.value.trim(); renderBatchFileList(); });
  $("#batchBackToList")?.addEventListener("click", () => setTranslationMode("files"));
  $("#batchFileList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-batch-action]");
    if (!button) return;
    const batchId = button.dataset.batchId;
    if (button.dataset.batchAction === "open") openBatchFile(batchId).catch((error) => toast(error.message));
    else if (button.dataset.batchAction === "export") exportBatchFile(batchId, button).catch((error) => toast(error.message));
    else if (button.dataset.batchAction === "delete") deleteBatchFileRow(batchId, button).catch((error) => toast(error.message));
  });
  $("#closeReferenceDetail").addEventListener("click", () => { $("#referenceDetailPanel").hidden = true; });
  $("#referenceList").addEventListener("click", (event) => {
    const folderButton = event.target.closest("[data-reference-folder-action]");
    if (folderButton) {
      const id = folderButton.dataset.id;
      if (folderButton.dataset.referenceFolderAction === "new") openReferenceFolderDialog({ mode: "create", parentId: id });
      else if (folderButton.dataset.referenceFolderAction === "rename") openReferenceFolderDialog({ mode: "rename", folderId: id });
      else if (folderButton.dataset.referenceFolderAction === "delete") deleteReferenceFolderById(id).catch((error) => toast(error.message));
      return;
    }
    const button = event.target.closest("[data-reference-action]");
    if (button) referenceAction(button.dataset.referenceAction, button.dataset.id, button).catch((error) => toast(error.message));
  });
  $("#referenceList").addEventListener("change", (event) => {
    const folderCheckbox = event.target.closest("[data-reference-folder-select]");
    if (folderCheckbox) {
      toggleReferenceSelection("folder", folderCheckbox.dataset.referenceFolderSelect, folderCheckbox.checked);
      return;
    }
    const checkbox = event.target.closest("[data-reference-select]");
    if (checkbox) toggleReferenceSelection("document", checkbox.dataset.referenceSelect, checkbox.checked);
  });
  $("#referenceList").addEventListener("dblclick", (event) => {
    const folder = event.target.closest("[data-reference-folder-id]");
    if (!folder) return;
    state.referenceFolderId = folder.dataset.referenceFolderId;
    clearReferenceSelection();
    loadReferences().catch((error) => toast(error.message));
  });
  $("#referenceList").addEventListener("contextmenu", (event) => {
    const folder = event.target.closest("[data-reference-folder-id]");
    if (folder) return openReferenceContextMenu(event, { kind: "folder", id: folder.dataset.referenceFolderId });
    const row = event.target.closest("[data-reference-id]");
    if (row) openReferenceContextMenu(event, { kind: "document", id: row.dataset.referenceId });
  });
  $("#referenceTree").addEventListener("contextmenu", (event) => {
    const node = event.target.closest("[data-reference-folder-id]");
    if (node) openReferenceContextMenu(event, { kind: "folder", id: node.dataset.referenceFolderId });
  });
  $("#referenceContextMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-menu-action]");
    if (button) handleReferenceMenuAction(button.dataset.referenceMenuAction).catch((error) => toast(error.message));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#referenceContextMenu")) closeReferenceContextMenu();
  });
  for (const selector of ["#referenceList", "#referenceTree"]) {
    $(selector).addEventListener("dragstart", handleReferenceDragStart);
    $(selector).addEventListener("drop", (event) => handleReferenceDrop(event).catch((error) => toast(error.message)));
  }
  $("#referenceDropZone").addEventListener("dragenter", handleReferenceDragEnter);
  $("#referenceDropZone").addEventListener("dragover", handleReferenceDragOver);
  $("#referenceDropZone").addEventListener("dragleave", handleReferenceDragLeave);
  $("#referenceDropZone").addEventListener("drop", (event) => handleReferenceDrop(event).catch((error) => toast(error.message)));
  window.addEventListener("dragend", hideReferenceDropOverlay);
  window.addEventListener("drop", hideReferenceDropOverlay);
  window.addEventListener("blur", hideReferenceDropOverlay);
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) hideReferenceDropOverlay();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideReferenceDropOverlay();
  });
  $("#referenceChunks").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-action]");
    if (button) referenceAction(button.dataset.referenceAction, button.dataset.id, button).catch((error) => toast(error.message));
  });
  $("#referenceDetailActions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-action]");
    if (button) referenceAction(button.dataset.referenceAction, button.dataset.id, button).catch((error) => toast(error.message));
  });
  $("#autoQaIssues").addEventListener("click", (event) => {
    const button = event.target.closest("[data-qa-issue-delete]");
    if (button) deleteAutoQaIssue(button).catch((error) => toast(error.message));
  });
  $("#openProvider").addEventListener("click", openProviderSettings);
  $("#confirmTermReplace").addEventListener("click", applyTermSuggestion);
  $("#toggleTargetEdit").addEventListener("click", toggleTargetEdit);
  $("#acceptTranslation").addEventListener("click", acceptSingleTranslation);
  $("#sendToAutoQa").addEventListener("click", sendCurrentTranslationToAutoQa);
  $("#openSettings").addEventListener("click", openParameterSettings);
  $("#projectSelect").addEventListener("change", (event) => selectProject(event.target.value).catch((error) => toast(error.message)));
  $("#newProject").addEventListener("click", () => getProjectWizard().open());
  $("#openProjectSettings").addEventListener("click", openProjectSettings);
  $("#deleteProject").addEventListener("click", openDeleteProjectDialog);
  $("#deleteProjectSelectAll").addEventListener("change", (event) => {
    $$("#deleteProjectList input[type=checkbox]").forEach((input) => { input.checked = event.target.checked; });
    updateDeleteSelection();
  });
  $("#deleteProjectList").addEventListener("change", updateDeleteSelection);
  $("#deleteProjectData").addEventListener("change", updateDeleteConfirmLabel);
  $("#deleteProjectForm").addEventListener("submit", deleteProjectFromDialog);
  $("#acceptAllSegments").addEventListener("click", acceptAllSegments);
  $("#batchToAutoQa").addEventListener("click", sendBatchToAutoQa);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
}

async function initialize() {
  try {
    const [bootstrap, health] = await Promise.all([api("/api/bootstrap"), api("/api/health")]);
    state.bootstrap = bootstrap;
    state.serverVersion = health.version || "0.0.0";
    await loadProjects();
    // 资产后台不可用时服务端直接拒绝启动，界面不会再出现"已回退到 JSON"的降级态。
    const batchModeButton = $('.translation-mode[data-translation-mode="batch"]');
    if (!supportsBatchApi(state.serverVersion)) {
      batchModeButton.title = "批次模块等待服务重启后启用";
      batchModeButton.querySelector("small").textContent = "等待服务重启后启用";
    }
    $("#serverDot").classList.add("online");
    $("#serverStatus").textContent = "服务在线";
    $("#providerLabel").textContent = `${state.bootstrap.provider.model} · ${new URL(state.bootstrap.provider.baseUrl).hostname}`;
    if (state.bootstrap.backend?.adminUrl) {
      $("#openAdmin").href = state.bootstrap.backend.adminUrl;
      $("#openAdmin").title = `${state.bootstrap.backend.label} · 日语→简体中文术语后台`;
    } else $("#openAdmin").hidden = true;
    populateSelects();
    loadReferencePreferences();
    renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
    renderLocaleStrip($("#assetLocales"), state.assetLocale, updateAssetLocale);
    renderLocaleStrip($("#memoryLocales"), state.memoryLocale, updateMemoryLocale);
    renderLocaleStrip($("#styleLocales"), state.styleLocale, updateStyleLocale);
    renderLocaleStrip($("#learningLocales"), state.learningLocale, loadLearning);
    // 质检页改成"来源"分区后没有语言 chip（只有 zh-CN）：必须容错，
    // 否则这里抛错会被外层 catch 吞掉，后面的 bindEvents() 全都不执行。
    if ($("#autoQaLocales")) renderLocaleStrip($("#autoQaLocales"), state.autoQaLocale, updateAutoQaLocale);
    bindEvents();
    updateBatchSegmentationOptions("");
    // 翻译视图的落地页是文件列表：单句输入与上次打开的批次都在列表页里选。
    setTranslationMode("files");
    await loadAssets(state.assetLocale);
    await loadMemories(state.memoryLocale);
    updateWorkbenchLocale(state.workbenchLocale);
    updateAutoQaLocale(state.autoQaLocale);
    refreshActions();
    await restoreBatchProgress();
    startNotificationPolling();
  } catch (error) {
    $("#serverStatus").textContent = "连接失败";
    $("#providerLabel").textContent = error.message;
  }
}

initialize();



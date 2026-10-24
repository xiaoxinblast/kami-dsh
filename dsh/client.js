window.__ModuleLoader__.load({
  id: "kami-dsh",
  chunk: "client.workbench-state.js",
  factory() {
    const resourceFields = [
      { field: "styleGuides", purpose: "style-guide", label: "风格指南", placeholder: "rules/style.md" },
      { field: "terms", purpose: "terms", label: "术语", placeholder: "glossary.xlsx" },
      { field: "translationMemories", purpose: "tm", label: "翻译记忆", placeholder: "resources/tm.xlsx" },
      { field: "references", purpose: "reference", label: "参考资料", placeholder: "references/story.md" }
    ];
    function linkedPaths(config, purpose, libraryId) {
      const field = resourceFields.find((item) => item.purpose === purpose)?.field;
      return (config[field] || []).filter((path) => !libraryId || (config.libraryFiles || []).some((item) => item.path === path && item.purpose === purpose && item.libraryId === libraryId));
    }
    function resourceSelection(config = {}, libraries = []) {
      return Object.fromEntries(resourceFields.map(({ field, purpose }) => [field, (config[field] || []).filter((path) => {
        const link = (config.libraryFiles || []).find((item) => item.path === path && item.purpose === purpose);
        return !link || libraries.find((item) => item.id === link.libraryId)?.enabled !== false;
      })]));
    }
    function libraryPriorityChanges(libraries, id, direction) {
      const ordered = [...libraries].sort((a, b) => Number(a.priority) - Number(b.priority));
      const index = ordered.findIndex((item) => item.id === id), target = index + direction;
      if (![1, -1].includes(direction) || index < 0 || target < 0 || target >= ordered.length) return [];
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return ordered.map((item, position) => ({ id: item.id, priority: position + 1 }));
    }
    function chooseBatch(files, selectedId = "", manual = false) {
      if (manual && selectedId) return selectedId;
      const sorted = [...files].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
      return (sorted.find((file) => ["running", "queued"].includes(file.runState)) || sorted[0])?.batchId || "";
    }
    function batchLabel(file, status) {
      const id = String(file.batchId || file.id || "");
      return [file.filename || file.title || id, status, id && `#${id.slice(0, 8)}`].filter(Boolean).join(" · ");
    }
    function skillLabel(skill, projectName, projectId) {
      return skill.name?.startsWith(`${skill.locale} · `) && skill.name.endsWith(projectId)
        ? `${projectName} · v${skill.version || 1}` : skill.name || `v${skill.version || 1}`;
    }
    function editingLocked(run) {
      return !run || ["running", "queued"].includes(run.runState) || run.workflow?.writeBusy === true || run.workflow?.qaRetryBusy === true
        || ["aiQa", "qualityReport", "termSurvey"].some((stage) => ["in_progress", "waiting"].includes(run.workflow?.[stage]?.status));
    }
    function qaLabel(segment) {
      if (segment.accepted && segment.result?.humanReview?.source === "external-review-import") return "memoQ 人工终稿";
      const qa = segment.result?.aiQa || {};
      if (qa.fallbackReason) return "QA 未完成";
      if (qa.status === "deterministic_only") return "规则检查";
      const score = qa.score ?? segment.result?.qaScore;
      return qa.used && Number.isFinite(score) ? `模型 QA · ${score}` : "尚未执行 QA";
    }
    function qaSummary(run, pending = false) {
      const translated = (run.segments || []).filter((segment) => segment.selected !== false && segment.status === "done" && segment.translation?.trim());
      const labels = translated.map(qaLabel), model = labels.filter((label) => label.startsWith("模型 QA · ")).length, rules = labels.filter((label) => label === "规则检查").length, human = labels.filter((label) => label === "memoQ 人工终稿").length;
      const incomplete = translated.length - model - rules - human, busy = pending || ["in_progress", "waiting"].includes(run.workflow?.aiQa?.status);
      const label = busy ? pending || run.workflow.aiQa.status === "in_progress" ? "正在处理" : "等待中"
        : labels.includes("QA 未完成") || (incomplete > 0 && model + rules > 0) ? "QA 未完成"
        : human > 0 && human === translated.length ? "memoQ 人工终稿" : rules > 0 && rules === translated.length ? "规则检查" : translated.length && !incomplete ? "已完成" : "尚未执行 QA";
      return { model, rules, human, incomplete, busy, label };
    }
    function issuesOf(segment) {
      const issues = segment.result?.qa?.issues || segment.result?.issues || segment.result?.aiQa?.issues || [];
      return [...issues, ...(segment.error ? [{ severity: "error", message: segment.error }] : []),
        ...(segment.result?.aiQa?.fallbackReason ? [{ severity: "warning", message: segment.result.aiQa.fallbackReason }] : [])];
    }
    function reportScore(report) {
      if (report.fallbackReason || (report.segments || []).some((segment) => segment.fallbackReason || segment.aiQaFallbackReason)) return null;
      if (report.sourceKind === "batch" && (!(report.segments || []).length || report.segments.some((segment) =>
        !Number.isFinite(segment.qaScore) || ["", "not_run", "deterministic_only"].includes(segment.aiQaStatus || "")))) return null;
      return Number.isFinite(report.scores?.overall) ? report.scores.overall : null;
    }
    function reviewPage(segments, { filter = "all", query = "", offset = 0, selectedId = "" } = {}) {
      const search = query.trim().toLocaleLowerCase();
      const rows = segments.map((segment, index) => ({ segment, number: index + 1 })).filter(({ segment, number }) => segment.draft && segment.id === selectedId ||
        (filter === "all" || (filter === "issues" ? issuesOf(segment).length : !segment.translation?.trim()))
        && (!search || `${number}\n${segment.id}\n${segment.source}\n${segment.translation || ""}`.toLocaleLowerCase().includes(search)));
      const start = Math.max(0, Math.min(Math.floor(offset / 20) * 20, Math.max(0, Math.floor((rows.length - 1) / 20) * 20)));
      const items = rows.slice(start, start + 20);
      return { items, total: rows.length, offset: start, selected: items.find(({ segment }) => segment.id === selectedId) || items[0] };
    }
    function resourcePage(paths, { folder = "", query = "", offset = 0 } = {}) {
      const search = query.trim().toLocaleLowerCase(), entries = new Map();
      for (const path of paths) {
        if (!path.startsWith(folder) || (search && !path.toLocaleLowerCase().includes(search))) continue;
        const rest = path.slice(folder.length), slash = rest.indexOf("/");
        const directory = !search && slash >= 0, key = directory ? folder + rest.slice(0, slash + 1) : path;
        if (directory && entries.has(key)) entries.get(key).count++;
        else entries.set(key, { path: key, name: directory ? rest.slice(0, slash) : search ? path : rest, folder: directory, count: 1 });
      }
      const rows = [...entries.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
      const start = Math.max(0, Math.min(offset, Math.max(0, Math.floor((rows.length - 1) / 20) * 20)));
      return { items: rows.slice(start, start + 20), total: rows.length, offset: start };
    }
    function promotionReady(evaluation, gate, candidateId) {
      return Boolean(candidateId && evaluation?.challengerSkillId === candidateId && evaluation.decision === "promote" && evaluation.report?.promotable === true
        && gate?.latestRun?.skillId === candidateId && gate.latestRun.decision === "pass" && gate.assets?.coverage?.valid === true);
    }
    function newView(workspace = "", projectId = "") {
      return { workspace, projectId, files: [], tasks: [], knownFiles: false, newBatches: [], selectedId: "", manual: false, run: null, drafts: {}, exports: {},
        pendingSelection: null, operations: {}, sections: {}, loadSerial: 0 };
    }
    class WorkbenchModel {
      constructor({ sessionId, call, prompt, visible = true }) {
        this.sessionId = sessionId; this.call = call; this.prompt = prompt; this.visible = visible; this.connected = false;
        this.workspace = null; this.projects = []; this.scopes = new Map(); this.view = newView();
        this.epoch = 0; this.refreshSerial = 0; this.listeners = new Set(); this.connection = { pending: false, error: "" };
      }
      subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
      emit() { for (const callback of this.listeners) callback(); }
      capture() { return { epoch: this.epoch, view: this.view }; }
      valid(token) { return this.visible && token.epoch === this.epoch && token.view === this.view; }
      setVisible(value) { if (this.visible !== value) { this.visible = value; this.epoch++; this.refreshSerial++; this.emit(); } }
      body(extra = {}, token = this.capture()) { return { projectId: token.view.projectId, locale: "zh-CN", ...extra }; }
      path(path, extras = {}, token = this.capture()) { return `${path}?${new URLSearchParams(this.body(extras, token))}`; }
      async request(operation, token = this.capture()) {
        if (!this.valid(token)) throw new Error("操作所属的会话或工作区已切换");
        const value = await this.call(this.sessionId, { ...operation, ...(token.view.workspace ? { expectedWorkspace: token.view.workspace } : {}) });
        if (!this.valid(token)) throw new Error("操作所属的会话或工作区已切换");
        return value;
      }
      invoke(path, method = "GET", body, token = this.capture()) { return this.request({ path, method, ...(body === undefined ? {} : { body }) }, token); }
      async perform(key, callback, replace = false) {
        const token = this.capture();
        if (!this.visible || (!replace && token.view.operations[key]?.pending)) return { ok: false };
        const operation = { pending: true, error: "", message: "" };
        token.view.operations[key] = operation; this.emit();
        try {
          const value = await callback(token);
          if (!this.valid(token) || token.view.operations[key] !== operation) return { ok: false };
          operation.message = typeof value === "string" ? value : "";
          return { ok: true, value };
        } catch (error) {
          if (this.valid(token) && token.view.operations[key] === operation) operation.error = error.message;
          return { ok: false, error };
        } finally {
          operation.pending = false;
          if (this.valid(token)) this.emit();
        }
      }
      async refresh() {
        if (!this.visible) return;
        const serial = ++this.refreshSerial;
        this.connection.pending = !this.workspace; this.emit();
        try {
          const state = await this.call(this.sessionId, { action: "workspace" });
          if (!this.visible || serial !== this.refreshSerial) return;
          const key = `${state.workspace}\0${state.config?.projectId || ""}`;
          if (key !== this.scopeKey) {
            this.epoch++; this.scopeKey = key;
            if (!this.scopes.has(key)) this.scopes.set(key, newView(state.workspace, state.config?.projectId || ""));
            this.view = this.scopes.get(key);
          }
          this.workspace = state; this.connected = true; this.connection = { pending: false, error: "" }; this.emit();
          const token = this.capture();
          if (!this.projects.length || !state.config?.projectId) {
            const value = await this.request({ path: "/api/projects" }, token);
            this.projects = value.projects || []; this.emit();
          }
          if (!token.view.projectId) return;
          await this.perform("task-list", async (current) => {
            const [files, tasks] = await Promise.all([
              this.invoke(this.path("/api/batch/files", {}, current), "GET", undefined, current),
              this.invoke(this.path("/api/tasks", { limit: 100 }, current), "GET", undefined, current)
            ]);
            if (!this.valid(current) || serial !== this.refreshSerial) return;
            const previousIds = new Set(current.view.files.map((file) => file.batchId));
            if (current.view.knownFiles) current.view.newBatches = [...new Set([...current.view.newBatches, ...(files.files || []).filter((file) => !previousIds.has(file.batchId)).map((file) => file.batchId)])];
            current.view.knownFiles = true;
            current.view.files = files.files || []; current.view.tasks = Array.isArray(tasks) ? tasks : tasks.items || [];
            const selected = chooseBatch(current.view.files, current.view.selectedId, current.view.manual);
            if (selected !== current.view.selectedId) { current.view.selectedId = selected; current.view.run = null; }
            current.view.newBatches = current.view.newBatches.filter((id) => id !== selected && current.view.files.some((file) => file.batchId === id));
            this.emit();
            if (selected) await this.loadRun(current, selected);
          }, true);
        } catch (error) {
          if (this.visible && serial === this.refreshSerial) { this.connected = false; this.connection = { pending: false, error: error.message }; this.emit(); }
        }
      }
      async loadRun(token = this.capture(), id = token.view.selectedId) {
        const serial = ++token.view.loadSerial;
        try {
          const value = await this.invoke(this.path(`/api/batch/run/${encodeURIComponent(id)}`, {}, token), "GET", undefined, token);
          if (this.valid(token) && token.view.selectedId === id && serial === token.view.loadSerial) { token.view.run = value.run || value; this.emit(); }
        } catch (error) { if (this.valid(token)) throw error; }
      }
      async activate(id) {
        delete this.view.operations.save;
        this.view.selectedId = id; this.view.run = null; this.view.manual = true; this.view.pendingSelection = null; this.emit();
        this.view.newBatches = this.view.newBatches.filter((value) => value !== id);
        if (id) return this.perform("task-load", (token) => this.loadRun(token, id), true);
      }
      async select(id) {
        if (id === this.view.selectedId) { this.view.manual = true; return; }
        if (this.dirty()) { this.view.pendingSelection = id; this.emit(); return; }
        return this.activate(id);
      }
      cancelSelection() { this.view.pendingSelection = null; this.emit(); }
      async confirmSelection(save) {
        const token = this.capture(), next = token.view.pendingSelection;
        if (next === null) return;
        if (save) { const result = await this.save(); if (!result?.ok || !this.valid(token)) return; }
        else delete token.view.drafts[token.view.selectedId];
        if (this.valid(token)) return this.activate(next);
      }
      dirty(id = this.view.selectedId) { return Object.keys(this.view.drafts[id] || {}).length > 0; }
      draftNotice() { return this.dirty() ? this.view.pendingSelection === null ? "draft" : "switch" : ""; }
      displayRun() {
        const run = this.view.run;
        if (!run) return null;
        const drafts = this.view.drafts[run.batchId] || {};
        return { ...run, segments: (run.segments || []).map((segment) => {
          return Object.hasOwn(drafts, segment.id) ? { ...segment, translation: drafts[segment.id], draft: true, accepted: false,
            result: { ...segment.result, issues: [], qa: null, qaScore: null, aiQa: { status: "not_run", used: false, score: null } } } : segment;
        }) };
      }
      async saveQaResults(report, token = this.capture(), id = token.view.selectedId) {
        const response = await this.invoke(this.path(`/api/batch/run/${encodeURIComponent(id)}`, {}, token), "GET", undefined, token);
        const latest = response.run || response;
        if (editingLocked(latest)) throw new Error("当前翻译或 QA 尚未结束，报告已保留，请稍后重试");
        let changed = false;
        const segments = latest.segments.map((segment) => {
          const checked = (report.segments || []).find((item) => item.source === segment.source && item.translation === segment.translation);
          if (!checked) return segment;
          changed = true;
          const score = Number.isFinite(checked.scores?.overall) ? checked.scores.overall : null, failed = Boolean(checked.fallbackReason);
          return { ...segment, result: { ...segment.result, qa: null, issues: checked.issues || [], qaScore: score,
            aiQa: { used: score !== null && !failed, status: failed ? "failed" : score !== null ? "completed" : "not_run", score, fallbackReason: checked.fallbackReason || "" } } };
        });
        if (changed) await this.invoke("/api/batch/run", "POST", this.body({ batchId: id, segments }, token), token);
        await this.loadRun(token, id);
      }
      edit(id, value) {
        if (editingLocked(this.view.run)) return false;
        const run = this.view.run, original = run.segments.find((segment) => segment.id === id);
        if (!original) return false;
        const drafts = this.view.drafts[run.batchId] ||= {};
        if (value === (original.translation || "")) delete drafts[id]; else drafts[id] = value;
        delete this.view.exports[run.batchId]; delete this.view.sections[`qa:${run.batchId}`];
        this.view.manual = true; this.emit(); return true;
      }
      async saveDrafts(token) {
        const id = token.view.selectedId, drafts = { ...token.view.drafts[id] };
        if (!Object.keys(drafts).length) return;
        if (editingLocked(token.view.run)) throw new Error("当前翻译或 QA 尚未结束，草稿已保留，请稍后保存");
        const response = await this.invoke(this.path(`/api/batch/run/${encodeURIComponent(id)}`, {}, token), "GET", undefined, token);
        const latest = response.run || response;
        if (editingLocked(latest)) throw new Error("当前翻译或 QA 尚未结束，草稿已保留，请稍后保存");
        const segments = latest.segments.map((segment) => !Object.hasOwn(drafts, segment.id) ? segment : { ...segment, translation: drafts[segment.id], status: drafts[segment.id].trim() ? "done" : "pending", error: "", accepted: false,
          result: { ...segment.result, translation: drafts[segment.id], qaScore: null, issues: [], qa: null, aiQa: { status: "not_run", used: false, score: null } } });
        await this.invoke("/api/batch/run", "POST", this.body({ batchId: id, segments,
          ...(latest.runnerOptions?.reviewFinal ? { runnerOptions: { reviewFinal: { ...latest.runnerOptions.reviewFinal, complete: false, stale: true } } } : {}) }, token), token);
        for (const [segmentId, value] of Object.entries(drafts)) if (token.view.drafts[id]?.[segmentId] === value) delete token.view.drafts[id][segmentId];
        await this.loadRun(token, id);
      }
      save() { return this.perform("save", async (token) => { await this.saveDrafts(token); return "译文已保存，可导出到 memoQ 审校。"; }); }
      linkReviewedFinal({ path, libraryId }) {
        const id = this.view.selectedId;
        return this.perform(`final:${id}`, async (token) => {
          if (this.dirty(id)) throw new Error("请先保存或放弃当前译文草稿，再关联人工终稿");
          const result = await this.request({ action: "review-final", batchId: id, projectId: token.view.projectId, path, libraryId }, token);
          token.view.sections[`final:${id}`] = result;
          delete token.view.sections[`qa:${id}`];
          await this.loadRun(token, id); await this.refresh();
          return result.alreadyLinked ? "当前终稿版本已关联" : result.failures?.length ? "终稿关联有未完成项目，请查看报告" : "已关联人工终稿，TM 与学习证据已更新";
        });
      }
      ask(text, key = "agent-read") {
        return this.perform(key, async (token) => {
          if (!this.prompt) throw new Error("当前会话的 Agent 入口不可用");
          await this.prompt(this.sessionId, text, token.view.workspace);
          return "已交给当前会话的 Agent";
        });
      }
      compileResource(resource) {
        return this.ask(`请立即编译刚关联的工作区资源 ${JSON.stringify({ path: resource.path, hash: resource.hash, purpose: resource.purpose, libraryId: resource.libraryId })}。先使用 DSH 原生工具理解原文件的内容和排版，再按 kami_file_import 的资源编译协议全量整理；不要求用户调整原件或套用固定模板。术语保留备注，TM 保留句对、上下文和来源，风格指南保留完整规则、例外和正反例。排除表头、空行、memoQ 保护行，不改写原件。将编译产物通过 compiledPath 或 resourceContext 保存；只有 compilation.status=ready 才报告完成，并汇报有效条数或字符数及跳过项。无法读取或理解的部分明确说明。`, `agent-compile:${resource.purpose}:${resource.path}`);
      }
      loadSection(name, operation) {
        return this.perform(`section:${name}`, async (token) => {
          const current = token.view.operations[`section:${name}`];
          const value = await operation(token);
          if (this.valid(token) && current === token.view.operations[`section:${name}`]) token.view.sections[name] = value;
        }, true);
      }
    }
    return { WorkbenchModel, resourceFields, linkedPaths, resourceSelection, libraryPriorityChanges, chooseBatch, batchLabel, skillLabel, editingLocked, qaLabel, qaSummary, issuesOf, reportScore, reviewPage, resourcePage, promotionReady };
  }
});

window.__ModuleLoader__.load({
  id: "kami-dsh",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const WORKBENCH_KIND = "kami-workbench";
    const WORKBENCH_TYPE = "kami-dsh/workbench";
    const words = {
      "Kami 翻译工作台": "Kami Workbench", "打开 Kami 翻译工作台": "Open Kami Workbench", "日语 → 简体中文 · 本地资产与任务": "Japanese → Simplified Chinese · Local assets and jobs",
      "翻译": "Translate", "资产": "Assets", "审校": "Review", "参考资料": "References", "学习": "Learning", "任务": "Jobs", "设置": "Settings",
      "新项目名称": "New project name", "新建项目": "New project", "请选择项目": "Select a project", "关联会话": "Session", "刷新": "Refresh",
      "先建立翻译会话": "Start a translation session first", "填写工作目录并新建翻译会话，或选择已有会话。": "Create a translation session with a working directory, or select an existing session.",
      "导入待译文件": "Import a file", "粘贴日语原文": "Paste Japanese source", "创建批次": "Create batch", "文件队列": "Files", "暂无文件": "No files yet",
      "开始 / 续跑": "Start / resume", "暂停": "Pause", "导出文件": "Export", "保存修改": "Save edits", "原文": "Source", "译文": "Translation",
      "段": "segments", "术语": "Terms", "翻译记忆": "Translation memory", "搜索": "Search", "上一页": "Previous", "下一页": "Next", "已显示": "Showing", "共": "of",
      "导入双语资产": "Import bilingual assets", "确认入库": "Approve import", "条候选": "candidates", "暂无条目": "No entries", "状态": "Status",
      "运行 QA": "Run QA", "质量报告": "Quality report", "尚未运行": "Not run yet", "上传参考资料": "Upload reference", "生成候选策略": "Propose strategy",
      "风格规范": "Style profiles", "风格指南": "Style guides", "人工风格指南": "Human style guides", "选择风格指南": "Select a style guide", "导入并立即启用": "Import and enable", "已启用": "Enabled", "当前生效": "Active", "历史版本": "Previous version", "指南全文": "Full guide", "尚未上传风格指南": "No style guides uploaded yet",
      "支持 .txt、.md、.docx；最大 5 MB，正文最多 50,000 字。": "Supports .txt, .md and .docx; up to 5 MB and 50,000 characters.", "仅用于当前项目；启用新指南后，旧版保留在历史记录中。": "Applies to this project only. Enabling a new guide keeps the previous version in history.",
      "策略版本": "Strategies", "评测": "Evaluate", "激活": "Activate", "备份本地数据库": "Back up database", "保存设置": "Save settings",
      "准备中…": "Working…", "已完成": "Done", "已保存": "Saved", "已提交": "Submitted", "请选择项目后继续": "Select a project to continue", "本地存储": "Local storage",
      "文件": "File", "关闭": "Close", "将保存当前译文为人工批准的 TM，并写入学习证据。": "Save this translation as human-approved TM and learning evidence.", "处理": "Process", "总分": "Score"
    };
    const zh = Object.fromEntries(Object.keys(words).map((key) => [key, key]));
    const { WorkbenchModel, resourceFields, linkedPaths, resourceSelection, libraryPriorityChanges, batchLabel, skillLabel, editingLocked, qaLabel, qaSummary, issuesOf, reportScore, reviewPage, resourcePage, promotionReady } = require("kami-dsh/client.workbench-state.js");
    Object.assign(words, {
      "待 Agent 编译": "Awaiting agent compilation", "已编译，可用于翻译": "Compiled and ready for translation", "让 Agent 编译": "Ask agent to compile", "刷新编译状态": "Refresh compilation status", "已关联，已交给 Agent 编译": "Linked and sent to the agent for compilation", "已关联，自动编译未提交，请重试": "Linked, but compilation could not be submitted. Please retry.",
      "项目资产": "Project assets", "按库关联本地原文件，统一管理任务所用的术语、记忆、指南和资料。": "Link local originals by library to manage terms, memories, guides and references.", "关联本地文件": "Link local files", "关联文件": "Linked files", "已有条目": "Saved entries", "个关联文件": "linked files", "新增库并关联文件": "Create a library and link files", "上移": "Move up", "下移": "Move down", "提高优先级": "Raise priority", "降低优先级": "Lower priority", "已调整库优先级": "Library priority updated", "库内关联原文件，由 Agent 查阅；优先级数字越小越优先，使用 ↑ ↓ 调整。": "Link originals for the Agent to read. Lower numbers have higher priority; use ↑ ↓ to reorder.",
      "任务": "Tasks", "资源": "Resources", "当前工作区": "Workspace", "更换项目": "Change project", "已连接": "Connected", "连接中": "Connecting", "连接失败": "Connection failed",
      "尚未绑定项目": "No project bound", "选择已有项目": "Select an existing project", "绑定项目": "Bind project", "新建并绑定": "Create and bind", "项目绑定": "Project binding",
      "快捷建批": "New batch", "在主会话中描述任务，也可以在此指定工作区文件。": "Describe a task in the conversation, or choose a workspace file here.", "待译文件路径": "Source file path", "本批次资源": "Resources for this batch",
      "解析并创建批次": "Parse and create batch", "创建后先预览原文，再开始翻译。": "Preview the parsed source before starting translation.", "仅覆盖本批次选择，不修改工作区默认资源。": "These selections apply to this batch only.",
      "当前任务": "Current task", "选择翻译批次": "Select a batch", "暂无翻译批次": "No translation batches", "从工作区开始": "Start with your workspace", "指定原文、关联资源，然后开始第一批翻译。": "Choose a source file and resources to start your first batch.",
      "正在处理": "In progress", "已暂停": "Paused", "待开始": "Ready", "需要处理": "Needs attention", "处理中": "Working", "翻译进度": "Translation progress", "问题": "issues", "失败": "failed", "未译": "pending",
      "翻译": "Translation", "质量检查": "QA", "一致性": "Consistency", "术语普查": "Term survey", "未开始": "Not started", "等待中": "Waiting", "已关闭": "Disabled", "等待条件": "Blocked",
      "开始翻译": "Start translation", "继续翻译": "Resume translation", "等待当前阶段结束": "Wait for the current stage", "批次需要先完成语境分析，请在主会话中推进。": "Complete the context brief in the conversation before starting this batch.",
      "已冻结的任务资源": "Frozen task resources", "任务启动后保持此版本；资源页预览的是工作区最新版。": "This task keeps its snapshot. Resource previews show the current workspace file.", "旧版任务 · 沿用原有资源": "Legacy task · original resources", "创建时间": "Created", "原文文件": "Source file",
      "译文复核": "Review translations", "全部译段": "All segments", "仅看问题": "Issues only", "尚未翻译": "Untranslated", "定位问题译段": "Find an issue", "此筛选下没有译段": "No matching segments", "待重新检查": "QA needs rerun",
      "尚未执行 QA": "QA not run", "规则检查": "Rule checks", "QA 未完成": "QA incomplete", "模型 QA": "Model QA", "执行中只读；阶段结束后可编辑译文。": "Read-only while processing. Edit once the stage settles.",
      "有未保存的译文草稿": "Unsaved translation drafts", "切换批次前，保存或放弃当前草稿。": "Save or discard your drafts before switching batches.", "保存并切换": "Save and switch", "放弃并切换": "Discard and switch", "取消切换": "Cancel", "草稿保存在当前会话中，退出应用前请保存。": "Drafts stay in this session. Save before exiting the app.",
      "译文已保存，可导出到 memoQ 审校。": "Translation saved. Export it for review in memoQ.",
      "检查本批次": "Check this batch", "查看上次报告": "View saved report", "上次保存的质量报告": "Last saved QA report", "当前任务快照": "Current task snapshot", "当前工作区最新资源": "Latest workspace resources", "报告没有评分": "No score available", "重试": "Retry",
      "工作区导出": "Export to workspace", "导出路径": "Output path", "留空使用工作区默认输出目录；同名文件会报错。": "Leave blank for the workspace output directory. Existing files are never overwritten.", "导出成功": "Exported", "任务记录": "Task history", "后台任务": "Background task", "独立审校": "Standalone QA", "翻译批次": "Translation batch", "打开批次": "Open batch", "关联批次": "Related batch", "任务 ID": "Task ID", "暂无任务记录": "No task history",
      "下次任务使用的资源": "Resources for the next task", "这些路径引用工作区原件；新建批次时读取最新版。": "These paths reference workspace originals. New batches read the latest content.", "工作区相对路径": "Workspace-relative path", "预览最新版": "Preview latest file", "关联到下次任务": "Use for the next task", "解除关联": "Unlink", "已关联": "Linked", "尚未关联文件": "No files linked", "工作区最新版预览": "Latest workspace preview", "关闭预览": "Close preview", "预览条数": "Preview items", "总条数": "Total items", "字符": "characters", "文件大小": "File size", "用途": "Purpose",
      "项目旧指南与参考资料": "Legacy project guides and references", "查看旧版资源": "View legacy resources", "旧版项目指南": "Legacy project guide", "正式资产库": "Canonical assets", "工作区文件资源请在“资源”中关联，不会自动写入正式库。": "Link workspace files in Resources. They are not automatically imported into the canonical library.",
      "搜索资产": "Search assets", "暂无正式资产": "No canonical assets", "工作区输出目录": "Workspace output directory", "保存输出目录": "Save output directory", "输入相对目录，例如 outputs": "Enter a relative directory, e.g. outputs", "本地参数与备份": "Local settings and backup", "已保存输出目录": "Output directory saved",
      "学习与评测": "Learning and evaluation", "人工激活后才用于后续任务。": "Activation requires your confirmation before use in future tasks.", "指南全文": "Full guide", "运行中": "Running", "已取消": "Cancelled", "已失败": "Failed", "已提交评测": "Evaluation submitted", "已激活": "Activated", "已关联工作区文件": "Workspace file linked", "已解除关联，工作区原件保留": "Unlinked. The original file is preserved.",
      "请明确选择已有 Kami 项目，或创建一个新项目。": "Select an existing Kami project or create a new one.", "未保存译文不会用于检查或导出。": "Save your drafts before QA or export.", "暂无待处理问题": "No pending issues", "资源已冻结": "Resources frozen", "返回任务": "Back to task",
      "发现新批次": "New batches found", "查看新批次": "View new batch", "复核译文": "Review translations", "重试未完成 QA": "Retry incomplete QA", "暂无已记录问题": "No recorded issues", "检查未完成，不表示通过": "Checks are incomplete. This is not a pass."
    });
    Object.assign(words, {"当前项目": "Current project", "选择候选": "Select candidate", "评测结果已保存": "Evaluation result saved", "交给 Agent 审校": "Ask agent to review", "返回译段列表": "Back to segments", "页": "Page", "跳转页码": "Go to page", "搜索原文、译文或段号": "Search source, translation or number", "搜索译段": "Search segments", "译段筛选": "Segment filter", "上个问题": "Previous issue", "下个问题": "Next issue", "译段列表": "Segments", "未保存": "Unsaved", "当前任务分区": "Task sections", "任务概览": "Overview", "工作区资源": "Workspace resources", "关联原文件，Agent 按任务需要查阅；新批次使用最新版本。": "Link original files. The agent reads them as needed; new batches use their latest versions.", "关联工作区文件": "Link a workspace file", "关联文件": "Link file", "个文件": "files", "搜索文件名或路径": "Search file names or paths", "搜索资源文件": "Search resource files", "全部文件": "All files", "上一级": "Parent folder", "让 Agent 查看原文件": "Ask agent to read original", "文件版本": "File version", "项目资产库": "Project libraries", "术语按库管理；TM 按库、来源文件和条目逐层浏览。": "Browse terms by library and TM by library, source file and entry.", "术语库": "Term bases", "记忆库 TM": "Translation memory", "个库": "libraries", "条": "entries", "全部库（合并视图）": "All libraries (merged)", "打开": "Open", "启用": "Enable", "主 TM": "Master TM", "工作 TM": "Working TM", "参考 TM": "Reference TM", "优先级": "Priority", "新增库": "New library", "库名称": "Library name", "库用途": "Library role", "创建库": "Create library", "全部库": "All libraries", "未标注来源": "Unspecified source", "搜索来源文件": "Search source files", "查看条目": "View entries", "条人工终稿": "human final translations", "人工确认": "Human approved", "机器译文": "Machine translation", "已批准": "Approved", "草稿": "Draft", "此库暂无来源文件": "No source files in this library", "翻译进度": "Translation progress", "启用的术语库参与翻译检索。": "Enabled term bases participate in translation retrieval.", "主 TM 保存人工确认译文，工作 TM 保存机器译文，参考 TM 提供检索参考。": "Master TM stores human-approved translations, working TM stores machine translations, and reference TM supports retrieval.", "学习中心": "Learning center", "按当前项目积累人工终稿；候选通过评测和门禁后，由你启用。": "Learn from human final translations in this project. Activate a candidate after evaluation and gate checks.", "学习流程": "Learning workflow", "生效版本": "Active version", "候选": "Candidate", "门禁": "Gate", "暂无记录": "No record", "尚未评测": "Not evaluated", "可以启用": "Ready to activate", "等待检查": "Waiting for checks", "当前生效版本": "Active version", "策略内容": "Strategy", "使用当前版本的默认策略": "Uses the version's default strategy", "查看候选": "View candidates", "候选版本": "Candidate versions", "选择并评测": "Select for evaluation", "变更内容": "Changes", "暂无候选": "No candidates", "从人工确认的终稿生成候选，不会自动替换生效版本。": "Generate a candidate from human-approved final translations. It does not replace the active version automatically.", "受测候选": "Candidate under test", "先生成候选": "Generate a candidate first", "生效版本与候选评测": "Compare active version and candidate", "使用未参与候选学习的人工终稿做配对评测。": "Evaluate paired outputs on human final translations excluded from candidate training.", "开始评测": "Start evaluation", "个配对样本": "paired samples", "指标": "Metric", "QA 分数": "QA score", "硬错误": "Hard errors", "术语准确率": "Term accuracy", "查看门禁": "View gate", "固定 Gold Set 与失败回归": "Fixed Gold Set and regression cases", "启用 Gold 样本": "Active Gold samples", "启用回归案例": "Active regression cases", "运行门禁": "Run gate", "管理固定质量资产": "Manage fixed quality assets", "从人工终稿预览 Gold Set": "Preview Gold Set from human finals", "个样本": "samples", "确认建立并启用": "Create and enable", "按最新证据重建回归集": "Rebuild regression suite", "启用候选": "Activate candidate", "当前候选评测和门禁已通过，可由你确认启用。": "This candidate has passed evaluation and current gate checks. You can activate it.", "需要当前候选的配对评测通过，且门禁结论覆盖最新质量资产。": "The candidate must pass paired evaluation and gate checks covering the current quality assets.", "确认启用候选": "Confirm activation", "确认启用": "Confirm activation", "规范内容": "Style instructions", "来源证据与变更原因": "Evidence and reasons for changes", "搜索原文、译文或来源": "Search source, translation or origin", "搜索学习证据": "Search learning evidence", "评测通过": "Evaluation passed", "需要复核": "Needs review", "未通过": "Failed", "已通过": "Passed", "已阻断": "Blocked", "证据不足": "Insufficient evidence", "交给 Agent 建批": "Ask agent to prepare batch", "直接解析建批": "Parse batch directly", "已交给当前会话的 Agent": "Sent to this session's agent", "已创建资源库": "Library created", "后台任务已提交，可在任务记录中查看进度。": "Background task submitted. Check task history for progress."});
    Object.assign(words, {
      "检查译文": "Check translation", "译文检查": "Translation checks", "终稿与学习": "Reviewed final", "待 memoQ 审校": "Awaiting memoQ review", "memoQ 人工终稿": "Human final from memoQ",
      "已关联人工终稿": "Reviewed final linked", "关联人工终稿": "Link reviewed final", "人工终稿相对路径": "Reviewed file path", "终稿记忆库": "Final translation memory", "终稿关联报告": "Final file report", "更换或重新关联终稿": "Link an updated final",
      "人工审校在 memoQ 完成，之后关联本地终稿。": "Review in memoQ, then link the local final file.",
      "导入 memoQ 并完成人工审校后，将双语终稿放回工作区，再关联到本批次。": "Review the export in memoQ, place the bilingual final in the workspace and link it to this batch.",
      "在 memoQ 完成人工审校后，关联本地双语终稿。整份终稿用于 TM，本批对应译段用于学习差异和术语更新。": "Link the local bilingual final after review in memoQ. The whole file supplies TM; matching batch segments supply learning and term updates.",
      "请先保存或放弃当前译文草稿，再关联人工终稿": "Save or discard translation drafts before linking the final.", "当前终稿版本已关联": "This final version is already linked", "终稿关联有未完成项目，请查看报告": "Some updates are incomplete. Check the report.", "已关联人工终稿，TM 与学习证据已更新": "Final linked. TM and learning evidence updated.",
      "TM 条目": "TM entries", "学习轨迹": "Learning samples", "术语更新": "Term updates", "待核对术语": "Terms to check", "对齐原批次": "Matched segments", "修改": "Changed", "条已审校轨迹": "reviewed learning samples",
      "已记录的人工终稿可在学习中心生成项目风格候选。": "Use the linked final evidence to generate project style candidates in Learning.", "未采用的终稿条目": "Excluded final entries",
      "已有译法冲突或证据不足的条目集中保留，核对后再更新术语库。": "Conflicting terms and uncertain evidence are collected here for checking before updating the term base.",
      "人工终稿使用 MQXLIFF / XLIFF": "Use MQXLIFF / XLIFF for reviewed finals", "从 memoQ 导出双语原文件建批，可用条目身份准确接回人工终稿。": "Create the batch from a bilingual memoQ export so segment identities can align the reviewed final."
    });
    Object.assign(zh, Object.fromEntries(Object.keys(words).map((key) => [key, key])));
    const css = `
      .kami{height:100%;min-width:0;overflow:auto;container-type:inline-size;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:inherit;box-sizing:border-box;scrollbar-gutter:stable}
      .kami *{box-sizing:border-box}.kami button,.kami input,.kami select,.kami textarea{font:inherit;color:inherit;font-size:13px;max-width:100%}.kami button,.kami input,.kami select{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-height:32px;padding:6px 10px}.kami button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;line-height:1.4}.kami button:hover{background:var(--dsw-alias-interactive-bg-hover)}.kami button:disabled{opacity:.5;cursor:default}.kami button:focus-visible,.kami input:focus-visible,.kami textarea:focus-visible,.kami select:focus-visible,.kami summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.kami .primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}.kami .primary:hover{filter:brightness(.95)}.kami .quiet{border-color:transparent;background:transparent}.kami .small{font-size:12px;min-height:28px;padding:4px 7px}.kami .icon-button{width:30px;padding:5px;flex:none}.kami .button-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.kami .button-row>*{min-width:0}.kami .button-row input{flex:1;min-width:100px}.kami button svg{flex:none}.kami input,.kami select{min-width:0}.kami input[type=checkbox]{min-height:0;width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
      .kami .masthead{padding:18px 20px 0;position:sticky;top:0;z-index:3;background:var(--dsw-alias-bg-layer-1)}.kami .brand-row{display:flex;align-items:center;gap:10px;min-width:0}.kami .brand-name{flex:1;min-width:0}.kami h1{margin:0;font-size:16px;font-weight:650;letter-spacing:-.3px}.kami .eyebrow{color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:1.5px;margin-top:3px}.kami .connection{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:5px;white-space:nowrap}.kami .connection-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.kami .workspace-bar{display:flex;align-items:center;gap:6px;padding:14px 0 13px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}.kami .workspace-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kami .project-chip{max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-size:11px}.kami nav{display:flex;flex-wrap:wrap;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 0 7px}.kami nav>button{flex:0 0 auto;min-width:0;padding:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);white-space:nowrap}.kami nav>button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600}.kami .body{padding:18px 20px 28px}.kami .stack{display:grid;gap:18px;min-width:0}.kami h2{font-size:18px;letter-spacing:-.4px;margin:0;font-weight:600;overflow-wrap:anywhere}.kami h3{font-size:14px;margin:0;font-weight:600}.kami p{font-size:13px;line-height:1.65;margin:7px 0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.kami .muted{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}.kami .section-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.kami .section-heading h3{flex:1}.kami .card{padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;min-width:0;background:var(--dsw-alias-bg-layer-2)}.kami .inset{background:var(--dsw-alias-bg-layer-1)}.kami .rule{border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}.kami .empty{display:grid;justify-items:center;text-align:center;gap:6px;padding:28px 12px}.kami .empty p{max-width:32em}.kami label{display:grid;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}.kami label>input,.kami label>select{width:100%}.kami textarea{width:100%;resize:vertical;min-height:104px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;font-size:14px;line-height:1.75}.kami textarea[readonly]{background:var(--dsw-alias-bg-layer-2)}.kami summary{cursor:pointer;line-height:1.5;font-size:13px;color:var(--dsw-alias-label-secondary)}.kami details[open]>summary{margin-bottom:14px}.kami .feedback{font-size:12px;line-height:1.6;margin:9px 0;overflow-wrap:anywhere;display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}.kami .feedback p{margin:0;font-size:12px}.kami .error{color:var(--dsw-alias-state-error-primary)}.kami .notice{padding:10px 12px;background:var(--dsw-alias-bg-layer-3);border-radius:8px;font-size:12px;line-height:1.6}.kami .notice .button-row{margin-top:10px}.kami code{font:11px/1.65 ui-monospace,Consolas,monospace;overflow-wrap:anywhere;word-break:break-word;color:var(--dsw-alias-label-secondary)}
      .kami .task-selector{width:100%;font-size:13px}.kami .task-title{margin:5px 0 12px}.kami .task-status{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;margin-bottom:10px}.kami .badge{font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-3);padding:2px 6px;border-radius:5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.kami .metrics{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);margin:10px 0 16px}.kami .metrics strong{font-size:17px;color:var(--dsw-alias-label-primary);font-weight:600;margin-right:4px}.kami progress{display:block;width:100%;height:5px;accent-color:var(--dsw-alias-brand-primary);border:0}.kami .stages{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0}.kami .stage{border-top:2px solid var(--dsw-alias-border-l2);padding-top:7px;min-width:0}.kami .stage[data-active=true]{border-color:var(--dsw-alias-brand-primary)}.kami .stage strong{font-size:11px;display:block;font-weight:500}.kami .stage span{font-size:10px;color:var(--dsw-alias-label-tertiary)}.kami .snapshot{margin-top:15px}.kami .snapshot-row{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2);display:grid;gap:2px}.kami .snapshot-row strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}.kami .snapshot-row code{font-size:10px}.kami .quick-form{display:grid;gap:14px;padding-top:3px}.kami .resource-checks{display:grid;gap:9px}.kami .resource-checks label{display:flex;align-items:flex-start;gap:8px;line-height:1.5;overflow-wrap:anywhere}.kami .resource-checks input{flex:none;margin-top:2px}.kami .resource-checks fieldset{margin:0;border:0;padding:0;min-width:0;display:grid;gap:8px}.kami .resource-checks legend{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:7px}.kami .quick-submit{display:flex;justify-content:space-between;gap:10px;align-items:center}.kami .quick-submit p{margin:0}
      .kami option{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
      .kami .review-anchor,.kami .task-side{scroll-margin-top:160px}
      .kami .review-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.kami .review-toolbar select{flex:1}.kami .issue-strip{display:flex;gap:6px;overflow:auto;padding:8px 0 4px;max-height:108px;flex-wrap:wrap}.kami .issue-strip button{font-size:11px;justify-content:flex-start;max-width:100%;text-align:left}.kami .segment{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2);scroll-margin-top:145px;outline-offset:3px}.kami .segment-heading{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}.kami .pairs{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}.kami .pairs>*{min-width:0}.kami .source-text{white-space:pre-wrap;line-height:1.75;font-size:14px;color:var(--dsw-alias-label-primary);padding:2px 0;margin:0}.kami .segment .source-label{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}.kami .issues{margin:10px 0;padding:0;list-style:none;display:grid;gap:5px}.kami .issues li{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}.kami .segment-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;flex-wrap:wrap}.kami .segment-footer details{flex:1}.kami .segment-footer summary{font-size:11px}.kami .pagination{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px}.kami .qa-report .score{font-size:24px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary)}.kami .task-record{padding:11px 0;border-top:1px solid var(--dsw-alias-border-l2);min-width:0}.kami .task-record strong{display:block;font-size:12px;font-weight:500;overflow-wrap:anywhere;margin:5px 0}.kami .task-record p{font-size:12px}.kami .type-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.kami .type-tabs button{font-size:12px}.kami .type-tabs button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);font-weight:600}.kami .resource-row{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.kami .resource-row strong{font-size:12px;overflow-wrap:anywhere;font-weight:500}.kami .resource-row .button-row{margin-top:7px}.kami .preview{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2)}.kami .preview-text{white-space:pre-wrap;font-size:13px;line-height:1.75;color:var(--dsw-alias-label-primary);max-height:420px;overflow:auto;padding:8px 0}.kami .asset-row{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.kami .asset-row p{white-space:pre-wrap;color:var(--dsw-alias-label-primary);margin:0;font-size:13px}.kami .asset-row .badge{justify-self:start}.kami .settings-fields{display:grid;gap:14px;padding:12px 0}.kami .settings-fields label:has(input[type=checkbox]){display:flex;flex-wrap:wrap;align-items:center;gap:8px}.kami .settings-fields label:has(input[type=checkbox]) p{flex-basis:100%}.kami .binding{display:grid;gap:12px;margin-bottom:18px}
      .kami .pagination{flex-wrap:wrap;font-size:11px}.kami .page-jump{display:flex;align-items:center;gap:5px;font-size:11px}.kami .page-jump input{width:50px;min-height:28px;padding:4px}.kami .review-toolbar input{flex:1;min-width:120px}.kami .review-layout{display:grid;gap:16px;align-items:start;min-width:0}.kami .review-list{max-height:360px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px}.kami .segment-row{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:9px;width:100%;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:0;text-align:left;padding:9px 10px;background:transparent;min-height:62px}.kami .segment-row:last-child{border-bottom:0}.kami .segment-row[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}.kami .segment-number{font-size:10px;color:var(--dsw-alias-label-tertiary);align-self:start;padding-top:3px}.kami .segment-excerpts{min-width:0;display:grid;gap:4px;font-size:12px;line-height:1.5}.kami .segment-excerpts>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}.kami .segment-row .badge{font-size:10px;align-self:start}.kami .segment-editor{display:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2);min-width:0}.kami .segment-editor .pairs{grid-template-columns:minmax(0,1fr)}.kami .segment-editor .source-text{max-height:180px;overflow:auto}.kami .segment-editor textarea{min-height:130px}.kami .type-tabs{padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);margin:4px 0}.kami .type-tabs button{background:transparent;border:0}.kami .breadcrumbs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;overflow-wrap:anywhere}.kami .file-list,.kami .library-list{min-width:0}.kami .file-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:7px 0}.kami .file-row>.feedback{grid-column:1/-1}.kami .file-title{display:flex;gap:8px;justify-content:flex-start;text-align:left;min-width:0;font-size:12px;border:0}.kami .file-title>span:not(.badge){overflow-wrap:anywhere;flex:1}.kami .library-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.kami .library-row>div:not(.feedback){flex:1;min-width:0}.kami .library-row strong{font-size:12px;overflow-wrap:anywhere}.kami .library-row p{font-size:11px;margin:5px 0}.kami .library-toggle{display:flex;align-items:center;gap:7px}.kami .library-row>.feedback{flex-basis:100%}.kami .learning-steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px}.kami .learning-steps>button{display:grid;gap:6px;align-content:start;min-width:0;padding:10px 5px;text-align:left;font-size:11px;background:var(--dsw-alias-bg-layer-2)}.kami .learning-steps>button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3)}.kami .learning-steps strong{font-size:11px;font-weight:600;overflow-wrap:anywhere}.kami .step-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);line-height:1.45}.kami .candidate-picker select{width:100%}.kami .candidate-row{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.kami .candidate-row[data-selected=true]{border-color:var(--dsw-alias-brand-primary)}.kami .candidate-row strong{font-size:12px}.kami .gate-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.kami .gate-metrics>div{display:grid;gap:7px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.kami .gate-metrics strong{font-size:23px;font-weight:600}.kami .gate-metrics span{font-size:11px;color:var(--dsw-alias-label-secondary)}.kami .metric-table{width:100%;border-collapse:collapse;font-size:12px}.kami .metric-table th,.kami .metric-table td{text-align:left;padding:9px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}.kami .metric-table th{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:500}
      .kami .review-layout[data-editing=true] .segment-editor{display:block}.kami .review-layout[data-editing=true] .review-index{display:none}.kami .review-back{margin-bottom:12px}
      .kami .library-row>.library-actions{flex:0 0 auto;display:flex;gap:4px;justify-content:flex-end}.kami .library-actions button{min-width:30px}
      .kami .primary{background:#174d40;border-color:#174d40;color:#f5efdf}.kami .primary:not(:disabled):hover{background:#23654f}.kami .type-tabs button[aria-pressed=true]{box-shadow:inset 0 -2px #82ad98}.kami .learning-steps>button[aria-pressed=true]{border-color:#82ad98;box-shadow:inset 0 2px #82ad98}.kami .segment-row[aria-pressed=true]{box-shadow:inset 3px 0 #82ad98}
      .kami .learning-view .stack>button,.kami .preview>button{justify-self:start}
      .kami .final-review .card{gap:10px}.kami .final-review p,.kami .final-review .metrics{margin:0}.kami .final-review details.card:not([open]){display:block}
      @container(min-width:860px){.kami .segment-editor{display:block}.kami .review-layout[data-editing=true] .review-index{display:block}.kami .review-back{display:none}.kami .review-layout{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}.kami .review-list{max-height:520px}.kami .segment-editor{position:sticky;top:160px}}
      @container(min-width:620px){.kami .pairs{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}.kami .asset-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:18px}.kami .task-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:22px;align-items:start}.kami .task-grid>.task-main{min-width:0}.kami .task-grid>.task-side{min-width:0}.kami .workspace-bar{padding-top:12px}.kami .body{padding:22px 24px 32px}.kami .masthead{padding-left:24px;padding-right:24px}.kami .quick-submit{justify-content:flex-start}.kami .review-toolbar select{flex:none;min-width:140px}}
      @container(min-width:900px){.kami .task-grid{grid-template-columns:minmax(0,1fr) 260px}}
      @container(max-width:360px){.kami .body{padding:14px 12px 22px}.kami .masthead{padding:14px 12px 0}.kami .connection-label{display:none}.kami h1{font-size:15px}.kami .project-chip{max-width:35%}.kami .card{padding:12px}.kami .stages{gap:4px}.kami .quick-submit{align-items:stretch;flex-direction:column}}
    `;
    const markPaths = [
      ["M13 19h20l9 9v23a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4V23a4 4 0 0 1 4-4Z", "#82ad98"],
      ["M29 9h16l10 10v25a4 4 0 0 1-4 4H29a4 4 0 0 1-4-4V13a4 4 0 0 1 4-4Z", "#f5efdf"],
      ["M45 9v10h10Z", "#c8b98e"],
      ["M32 26h16v3H32zm0 7h11v3H32Z", "#174d40"]
    ];
    function BrandMark({ size = 32, mono = false }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 64 64", fill: "none", "aria-hidden": true, focusable: "false" },
        !mono && h("rect", { width: 64, height: 64, rx: 15, fill: "#174d40" }),
        ...(mono ? [h("path", { key: "sheets", d: "M21 20H12v33h27v-7M27 10h17l10 10v25H27V10Zm17 0v10h10M34 27h12M34 34h9", stroke: "currentColor", strokeWidth: 4, strokeLinejoin: "round", strokeLinecap: "round" })]
          : markPaths.map(([d, fill], index) => h("path", { key: index, d, fill }))),
        !mono && h("path", { d: "M15 43h20m-5-5 5 5-5 5", stroke: "#f5efdf", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function Glyph({ name, size = 16 }) {
      const paths = { tasks: "M4 4h12v14H4zM7 8h6M7 12h6", resources: "M3 6h6l2 2h6v9H3z", assets: "m3 6 7-3 7 3-7 3-7-3Zm0 4 7 3 7-3M3 14l7 3 7-3", refresh: "M16 8a6 6 0 1 0 0 5M16 3v5h-5", plus: "M10 4v12M4 10h12", arrow: "M4 10h12M11 5l5 5-5 5", folder: "M3 6h6l2 2h6v9H3z" };
      return h("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", "aria-hidden": true }, h("path", { d: paths[name] || paths.tasks, stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function Button({ children, onClick, primary, disabled, busy, small, quiet, title, className = "" }) {
      return h("button", { type: "button", onClick, title, disabled: disabled || busy, "aria-busy": busy || undefined, className: `${primary ? "primary" : ""} ${small ? "small" : ""} ${quiet ? "quiet" : ""} ${className}` }, children);
    }
    function Feedback({ model, name, retry, t }) {
      const operation = model.view.operations[name];
      if (!operation) return null;
      return h(React.Fragment, null,
        operation.pending && (name !== "task-list" || !model.view.knownFiles) && h("div", { className: "feedback", role: "status" }, t("准备中…")),
        operation.error && h("div", { className: "feedback error", role: "alert" }, operation.error, retry && h(Button, { onClick: retry, small: true }, t("重试"))),
        operation.message && h("div", { className: "feedback", role: "status" }, t(operation.message)));
    }
    const stateWords = { ready: "待开始", pending: "待开始", queued: "等待中", running: "运行中", in_progress: "正在处理", paused: "已暂停", completed: "已完成", done: "已完成", needs_attention: "需要处理", failed: "已失败", error: "已失败", review: "需要处理", not_started: "未开始", waiting: "等待中", disabled: "已关闭", blocked: "等待条件", abandoned: "已取消" };
    const stateText = (value, t) => t(stateWords[value] || value || "未开始");
    const timeText = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    const sizeText = (bytes) => Number(bytes) >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : Number(bytes) >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Number(bytes) || 0} B`;
    const scopeArgs = (model, token, extra = {}) => model.body(extra, token);
    function Empty({ title, description, artwork, t }) {
      return h("div", { className: "empty" }, artwork && h(BrandMark, { size: 58 }), h("h3", null, t(title)), description && h("p", null, t(description)));
    }
    function useSection(model, name, load, dependencies = []) {
      useEffect(() => { model.loadSection(name, load); }, [model, model.scopeKey, model.visible, ...dependencies]);
      return model.view.sections[name];
    }
    function Pager({ offset, total, size = 20, onChange, t }) {
      if (!total) return null;
      return h("div", { className: "pagination" }, h(Button, { small: true, disabled: offset === 0, onClick: () => onChange(Math.max(0, offset - size)) }, t("上一页")),
        h("span", { className: "muted" }, `${offset + 1}–${Math.min(offset + size, total)} / ${total}`),
        h("label", { className: "page-jump" }, t("页"), h("input", { type: "number", min: 1, max: Math.ceil(total / size), value: Math.floor(offset / size) + 1, "aria-label": t("跳转页码"), onChange: (event) => onChange((Math.max(1, Math.min(Math.ceil(total / size), Number(event.target.value) || 1)) - 1) * size) })),
        h(Button, { small: true, disabled: offset + size >= total, onClick: () => onChange(offset + size) }, t("下一页")));
    }
    function KamiPanelPresence({ useKamiMounted, useSessions, openWorkbench, closeWorkbench }) {
      const sessionId = useKamiMounted((value) => value);
      const preset = useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset);
      useEffect(() => {
        if (preset === "kami-translator") openWorkbench(sessionId);
        else if (preset) closeWorkbench(sessionId);
      }, [sessionId, preset, openWorkbench, closeWorkbench]);
      return null;
    }
    function WorkbenchOpener({ sessionId, useSessions, openWorkbench, t }) {
      const preset = useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset);
      if (preset !== "kami-translator") return null;
      const label = t("打开 Kami 翻译工作台");
      return h("button", { type: "button", title: label, "aria-label": label, onClick: () => openWorkbench(sessionId), style: { width: 28, height: 28, border: 0, borderRadius: 8, cursor: "pointer", font: "inherit", color: "var(--dsw-alias-label-secondary)", background: "transparent", display: "inline-grid", placeItems: "center" } }, h(BrandMark, { size: 21, mono: true }));
    }
    function WorkbenchTab(props) {
      const preset = props.useSessions((state) => state.byId[props.sessionId]?.projectionValues?.agentPreset);
      const { tab } = props.useTabInfo();
      return preset === "kami-translator" ? h(Workbench, { ...props, key: props.sessionId, visible: tab.visible }) : null;
    }
    function WorkbenchTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 } }, h(BrandMark, { size: 16, mono: true }), tab.title);
    }
    function BindingForm({ model, t, close }) {
      const [existing, setExisting] = useState(model.view.projectId), [name, setName] = useState("");
      useSection(model, "projects", async (token) => { const value = await model.request({ path: "/api/projects" }, token); model.projects = value.projects || []; return value; });
      const bind = (args) => model.perform("binding", async (token) => {
        await model.request({ action: "workspace", actionType: "bind", ...args }, token);
        await model.refresh(); close();
      });
      return h("section", { className: "card binding" }, h("h3", null, t("项目绑定")), h("p", { className: "muted" }, t("请明确选择已有 Kami 项目，或创建一个新项目。")),
        h("div", { className: "button-row" }, h("select", { value: existing, "aria-label": t("选择已有项目"), onChange: (event) => setExisting(event.target.value), style: { flex: 1 } }, h("option", { value: "" }, t("选择已有项目")), ...model.projects.map((project) => h("option", { key: project.id, value: project.id }, project.name))), h(Button, { disabled: !existing, busy: model.view.operations.binding?.pending, onClick: () => bind({ projectId: existing }) }, t("绑定项目"))),
        h("div", { className: "button-row" }, h("input", { value: name, placeholder: t("新项目名称"), "aria-label": t("新项目名称"), onChange: (event) => setName(event.target.value) }), h(Button, { disabled: !name.trim(), busy: model.view.operations.binding?.pending, onClick: () => bind({ name: name.trim() }) }, t("新建并绑定"))),
        h(Feedback, { model, name: "binding", t }), model.view.projectId && h(Button, { quiet: true, onClick: close }, t("关闭")));
    }
    function QuickBatch({ model, t }) {
      const [path, setPath] = useState(""), [excluded, setExcluded] = useState([]), [previewId, setPreviewId] = useState("");
      const config = model.workspace?.config || {};
      const enabledResources = resourceSelection(config, model.workspace?.libraries);
      const selectedResources = () => Object.fromEntries(resourceFields.map(({ field }) => [field, enabledResources[field].filter((item) => !excluded.includes(`${field}:${item}`))]));
      const withResources = Object.values(selectedResources()).some((items) => items.length);
      const agentCreate = () => model.ask(`请为工作区原文件 ${JSON.stringify(path.trim())} 创建 Kami 翻译批次，供我预览，先不要启动翻译。本批次资源为 ${JSON.stringify(selectedResources())}。请先用 DSH 工具直接查阅原格式资源，以当前哈希和实际查阅结果提供 resourceContext；不创建纯文本转换副本，不正式入库。`, "agent-create");
      const create = () => model.perform("create", async (token) => {
        const resources = selectedResources();
        const value = await model.request({ action: "file", purpose: "translation", path: path.trim(), resources, projectId: token.view.projectId }, token);
        setPreviewId(value.batchId); await model.select(value.batchId); await model.refresh();
      });
      return h("details", { className: "card", open: !model.view.run || undefined }, h("summary", null, t("快捷建批")),
        h("form", { className: "quick-form", onSubmit: (event) => { event.preventDefault(); withResources ? agentCreate() : create(); } },
          h("p", { className: "muted" }, t("在主会话中描述任务，也可以在此指定工作区文件。")),
          h("label", null, t("待译文件路径"), h("input", { value: path, placeholder: "source/dialogue.docx", onChange: (event) => { setPath(event.target.value); setPreviewId(""); } })),
          h("details", null, h("summary", null, t("本批次资源")), h("p", { className: "muted" }, t("仅覆盖本批次选择，不修改工作区默认资源。")), h("div", { className: "resource-checks" }, ...resourceFields.map(({ field, label }) => h("fieldset", { key: field }, h("legend", null, t(label)),
            ...enabledResources[field].map((item) => { const key = `${field}:${item}`; return h("label", { key }, h("input", { type: "checkbox", checked: !excluded.includes(key), onChange: (event) => setExcluded(event.target.checked ? excluded.filter((value) => value !== key) : [...excluded, key]) }), item); }), !enabledResources[field].length && h("span", { className: "muted" }, t("尚未关联文件")))))),
          h("div", { className: "quick-submit" }, h(Button, { primary: true, disabled: !path.trim(), busy: model.view.operations[withResources ? "agent-create" : "create"]?.pending, onClick: withResources ? agentCreate : create }, h(Glyph, { name: "plus" }), t(withResources ? "交给 Agent 建批" : "解析并创建批次")), withResources && h(Button, { small: true, quiet: true, disabled: !path.trim(), busy: model.view.operations.create?.pending, onClick: create }, t("直接解析建批")), h("p", { className: "muted" }, t("创建后先预览原文，再开始翻译。"))),
          h(Feedback, { model, name: "create", retry: create, t }), h(Feedback, { model, name: "agent-create", t }), previewId && h("p", { className: "muted", role: "status" }, t("资源已冻结"), " · ", previewId)));
    }
    function Snapshot({ run, t }) {
      const snapshot = run.runnerOptions?.workspaceSnapshot;
      return h("details", { className: "snapshot" }, h("summary", null, t("已冻结的任务资源")), !snapshot ? h("p", { className: "muted" }, t("旧版任务 · 沿用原有资源")) : h(React.Fragment, null,
        h("p", { className: "muted" }, t("任务启动后保持此版本；资源页预览的是工作区最新版。")),
        h("p", { className: "muted" }, t("创建时间"), " · ", timeText(snapshot.createdAt)),
        ...[snapshot.source && { ...snapshot.source, purpose: "translation" }, ...(snapshot.resources || [])].filter(Boolean).map((resource, index) => h("div", { className: "snapshot-row", key: `${resource.purpose}:${resource.path}:${index}` },
          h("strong", null, resource.path), h("span", { className: "muted" }, t(resourceFields.find((item) => item.purpose === resource.purpose)?.label || "原文文件"), " · ", sizeText(resource.size)), h("code", null, "SHA-256 ", resource.hash))),
        h("code", null, snapshot.id)));
    }
    function TaskSummary({ model, run, t, review, exportFile }) {
      const selected = run.segments.filter((segment) => segment.selected !== false), done = selected.filter((segment) => segment.status === "done" && segment.translation?.trim()).length;
      const failed = selected.filter((segment) => ["error", "failed"].includes(segment.status)).length, problems = selected.reduce((count, segment) => count + issuesOf(segment).length, 0);
      const locked = editingLocked(run), pending = model.dirty(), id = run.batchId;
      const translated = selected.filter((segment) => segment.status === "done" && segment.translation?.trim());
      const qaFailed = translated.some((segment) => segment.result?.aiQa?.fallbackReason);
      const qa = qaSummary(run, model.view.operations[`qa:${id}`]?.pending);
      const qaDescription = `${qa.model} ${t("段")} ${t("模型 QA")} · ${qa.rules} ${t("段")} ${t("规则检查")} · ${qa.human} ${t("段")} ${t("memoQ 人工终稿")} · ${qa.incomplete} ${t("段")} ${t("QA 未完成")}`;
      const command = (verb) => model.perform(`${verb}:${id}`, async (token) => {
        await model.invoke(`/api/batch/run/${encodeURIComponent(id)}/${verb}`, "POST", scopeArgs(model, token), token);
        await model.loadRun(token, id);
      });
      return h("section", { className: "card" }, h("div", { className: "task-status" }, h("span", { className: "muted" }, t("当前任务")), h("span", { className: "badge" }, stateText(run.workflow?.overall?.status || run.runState || "ready", t))),
        h("h2", { className: "task-title" }, run.filename || id), h("progress", { max: Math.max(1, selected.length), value: done, "aria-label": t("翻译进度") }),
        done > 0 && ["mqxliff", "xliff"].includes(run.format) && h("p", { className: "muted" }, t(run.runnerOptions?.reviewFinal?.complete ? "已关联人工终稿" : "待 memoQ 审校")),
        h("div", { className: "metrics" }, h("span", null, h("strong", null, `${done}/${selected.length}`), t("段")), h("span", null, h("strong", null, problems), t("问题")), failed > 0 && h("span", { className: "error" }, h("strong", null, failed), t("失败"))),
        h("div", { className: "stages" }, ...[["translation", "翻译"], ["aiQa", "质量检查"], ["qualityReport", "一致性"], ["termSurvey", "术语普查"]].map(([key, label]) => h("div", { className: "stage", key, "data-active": key === "aiQa" ? qa.busy : ["in_progress", "waiting"].includes(run.workflow?.[key]?.status), title: key === "aiQa" ? qaDescription : run.workflow?.[key]?.message || "" }, h("strong", null, t(label)), h("span", null, key === "aiQa" ? t(qa.label) : stateText(run.workflow?.[key]?.status, t))))),
        h("div", { className: "button-row" }, ["running", "queued"].includes(run.runState)
          ? h(Button, { onClick: () => command("pause"), busy: model.view.operations[`pause:${id}`]?.pending }, t("暂停"))
          : done === selected.length && selected.length && !locked ? h(Button, { primary: true, disabled: pending || model.view.operations[`qa:${id}`]?.pending, busy: model.view.operations[`retry-qa:${id}`]?.pending, onClick: qaFailed ? () => command("retry-qa") : review }, t(qaFailed ? "重试未完成 QA" : "检查译文"))
          : h(Button, { primary: true, onClick: () => command("start"), busy: model.view.operations[`start:${id}`]?.pending, disabled: locked || pending || model.view.operations[`qa:${id}`]?.pending || run.contextBriefPending || (run.requiresBrief && run.contextBrief?.status !== "ready") }, h(Glyph, { name: "arrow" }), t(locked ? "等待当前阶段结束" : done ? "继续翻译" : "开始翻译")),
          h(Button, { onClick: () => model.save(), disabled: !pending || locked, busy: model.view.operations.save?.pending }, t("保存修改")),
          done > 0 && h(Button, { onClick: exportFile, disabled: locked || pending, quiet: true }, t("工作区导出"))),
        run.workflow?.overall?.status === "in_progress" && h("p", { className: "muted" }, run.workflow.overall.message),
        run.contextBriefPending && h("p", { className: "muted" }, t("批次需要先完成语境分析，请在主会话中推进。")),
        h(Feedback, { model, name: `start:${id}`, retry: () => command("start"), t }), h(Feedback, { model, name: `pause:${id}`, retry: () => command("pause"), t }), h(Feedback, { model, name: `retry-qa:${id}`, retry: () => command("retry-qa"), t }), h(Feedback, { model, name: "save", retry: () => model.save(), t }), h(Snapshot, { run, t }));
    }
    function QaReport({ report, t, label = "质量报告" }) {
      if (!report) return null;
      const issues = [...(report.segments || []).flatMap((segment) => segment.issues || []), ...(report.alignmentIssues || [])];
      return h("section", { className: "card qa-report" }, h("div", { className: "section-heading" }, h("h3", null, t(label)), h("span", { className: "score" }, reportScore(report) ?? "—")),
        report.fallbackReason && h("p", { className: "error", role: "alert" }, report.fallbackReason), reportScore(report) == null && h("p", { className: "muted" }, t("报告没有评分")),
        report.sourceKind === "batch" && h("p", { className: "muted" }, t("规则检查"), " · ", (report.segments || []).filter((segment) => segment.aiQaStatus === "deterministic_only").length, " / ", report.segmentCount || 0),
        reportScore(report) == null && h("p", { className: "muted" }, t("检查未完成，不表示通过")),
        h("ul", { className: "issues" }, ...issues.map((issue, index) => h("li", { key: index }, issue.message || issue.description || ""))), !issues.length && h("p", { className: "muted" }, t("暂无已记录问题")));
    }
    function ReviewPanel({ model, run, t }) {
      const [filter, setFilter] = useState("all"), [offset, setOffset] = useState(0), [selected, setSelected] = useState(""), [query, setQuery] = useState(""), [editing, setEditing] = useState(false);
      const id = run.batchId, qaKey = `qa:${id}`;
      const locked = editingLocked(run) || model.view.operations[qaKey]?.pending || model.view.operations.save?.pending;
      const page = reviewPage(run.segments, { filter, query, offset, selectedId: selected }), current = page.selected, segment = current?.segment;
      const issueSegments = run.segments.filter((item) => issuesOf(item).length);
      const locate = (direction) => {
        const index = issueSegments.findIndex((item) => item.id === segment?.id);
        const origin = index < 0 ? direction > 0 ? -1 : 0 : index;
        const next = issueSegments[(origin + direction + issueSegments.length) % issueSegments.length];
        if (!next) return;
        setFilter("all"); setQuery(""); setOffset(Math.floor(run.segments.indexOf(next) / 20) * 20); setSelected(next.id); setEditing(true);
      };
      const inspect = () => model.perform(qaKey, async (token) => {
        const value = await model.invoke("/api/auto-qa", "POST", scopeArgs(model, token, { batchId: id, source: run.segments.map((item) => item.source).join("\n"), translation: run.segments.map((item) => item.translation || "").join("\n") }), token);
        token.view.sections[qaKey] = value; await model.saveQaResults(value, token, id);
      });
      const savedReport = () => model.loadSection(qaKey, (token) => model.invoke(model.path(`/api/qa/batch/${encodeURIComponent(id)}`, {}, token), "GET", undefined, token));
      return h("section", { className: "stack" }, h("div", { className: "section-heading" }, h("h3", null, t("译文检查")), h("span", { className: "muted" }, `${page.total} / ${run.segments.length} ${t("段")}`)),
        h("div", { className: "review-toolbar" }, h("input", { type: "search", value: query, placeholder: t("搜索原文、译文或段号"), "aria-label": t("搜索译段"), onChange: (event) => { setQuery(event.target.value); setOffset(0); setEditing(false); } }),
          h("select", { value: filter, "aria-label": t("译段筛选"), onChange: (event) => { setFilter(event.target.value); setOffset(0); setEditing(false); } }, ...[["all", "全部译段"], ["issues", "仅看问题"], ["pending", "尚未翻译"]].map(([value, label]) => h("option", { key: value, value }, t(label))))),
        h("div", { className: "button-row" }, h(Button, { small: true, onClick: inspect, disabled: locked || model.dirty() || !run.segments.some((item) => item.translation?.trim()) }, t("检查本批次")), h(Button, { small: true, quiet: true, onClick: savedReport }, t("查看上次报告")),
          issueSegments.length > 0 && h(React.Fragment, null, h(Button, { small: true, quiet: true, onClick: () => locate(-1) }, t("上个问题")), h(Button, { small: true, quiet: true, onClick: () => locate(1) }, t("下个问题")))),
        h(Feedback, { model, name: qaKey, retry: inspect, t }), h(Feedback, { model, name: `section:${qaKey}`, retry: savedReport, t }),
        model.view.sections[qaKey] && h("details", { className: "rule" }, h("summary", null, t("上次保存的质量报告")), h(QaReport, { report: model.view.sections[qaKey], t })),
        h("div", { className: "review-layout", "data-editing": editing }, h("div", { className: "review-index" }, h("div", { className: "review-list", "aria-label": t("译段列表") }, ...page.items.map(({ segment: item, number }) => h("button", { type: "button", className: "segment-row", key: item.id, "aria-pressed": segment?.id === item.id, onClick: () => { setSelected(item.id); setEditing(true); } },
          h("span", { className: "segment-number" }, `#${number}`), h("span", { className: "segment-excerpts" }, h("span", null, item.source), h("span", { className: "muted" }, item.translation || t("尚未翻译"))), h("span", { className: "badge" }, item.draft ? t("未保存") : issuesOf(item).length ? `${issuesOf(item).length} ${t("问题")}` : stateText(item.status, t))))),
          h(Pager, { offset: page.offset, total: page.total, onChange: setOffset, t })),
          segment && h("article", { className: "segment segment-editor", key: segment.id }, h(Button, { small: true, quiet: true, className: "review-back", onClick: () => setEditing(false) }, t("返回译段列表")), h("div", { className: "segment-heading" }, h("strong", null, `#${current.number}`), h("span", null, segment.draft ? t("待重新检查") : qaLabel(segment).startsWith("模型 QA · ") ? `${t("模型 QA")} · ${qaLabel(segment).split(" · ")[1]}` : t(qaLabel(segment)))),
            locked && h("p", { className: "muted" }, t("执行中只读；阶段结束后可编辑译文。")),
            h("div", { className: "pairs" }, h("div", null, h("span", { className: "source-label" }, t("原文")), h("p", { className: "source-text" }, segment.source)), h("label", null, h("span", { className: "source-label" }, t("译文")), h("textarea", { value: segment.translation || "", readOnly: locked, "aria-label": `${t("译文")} ${current.number}`, onChange: (event) => model.edit(segment.id, event.target.value) }))),
            h("ul", { className: "issues" }, ...issuesOf(segment).map((issue, index) => h("li", { key: index }, issue.message || issue.description || ""))),
            h("div", { className: "segment-footer" }, h("span", { className: "muted" }, t(segment.accepted && !segment.draft ? segment.result?.humanReview?.source === "external-review-import" ? "已关联人工终稿" : "人工确认" : "人工审校在 memoQ 完成，之后关联本地终稿。"))),
            h("div", { className: "button-row" }, h(Button, { primary: true, small: true, onClick: () => model.save(), disabled: !model.dirty() || locked, busy: model.view.operations.save?.pending }, t("保存修改"))), h(Feedback, { model, name: "save", t }))),
        !page.total && h(Empty, { title: "此筛选下没有译段", t }));
    }
    function ExportPanel({ model, run, t, onFinal }) {
      const [path, setPath] = useState(""), id = run.batchId, key = `export:${id}`, receipt = model.view.exports[id];
      const write = () => model.perform(key, async (token) => {
        const result = await model.request({ action: "export", batchId: id, projectId: token.view.projectId, mode: "writeback", outputPath: path.trim() }, token);
        token.view.exports[id] = { ...result, at: new Date().toISOString() };
      });
      return h("section", { className: "card stack" }, h("h3", null, t("工作区导出")),
        h("label", null, t("导出路径"), h("input", { value: path, placeholder: `${model.workspace?.config?.outputDirectory || "outputs"}/`, onChange: (event) => setPath(event.target.value) })),
        h("p", { className: "muted" }, t("留空使用工作区默认输出目录；同名文件会报错。")),
        h(Button, { onClick: write, busy: model.view.operations[key]?.pending, disabled: editingLocked(run) || model.dirty() || model.view.operations[`qa:${id}`]?.pending || !run.segments.some((segment) => segment.translation?.trim()) }, t("导出文件")),
        model.dirty() && h("p", { className: "muted" }, t("未保存译文不会用于检查或导出。")), h(Feedback, { model, name: key, retry: write, t }),
        receipt && h("div", { className: "notice", role: "status" }, h("strong", null, t("导出成功")), h("p", null, h("code", null, receipt.path)), h("span", { className: "muted" }, `${sizeText(receipt.bytes)} · ${timeText(receipt.at)}`)),
        ["mqxliff", "xliff"].includes(run.format) && h("div", { className: "stack" }, h("p", { className: "muted" }, t("导入 memoQ 并完成人工审校后，将双语终稿放回工作区，再关联到本批次。")), h(Button, { onClick: onFinal, quiet: true }, t("关联人工终稿"))));
    }
    function FinalReviewPanel({ model, run, t }) {
      const current = run.runnerOptions?.reviewFinal, id = run.batchId, key = `final:${id}`;
      const libraries = (model.workspace?.libraries || []).filter((item) => item.kind === "translation_memory" && item.role !== "working" && item.enabled !== false);
      const [path, setPath] = useState(current?.path || ""), [libraryId, setLibraryId] = useState(current?.libraryId || libraries.find((item) => item.role === "master")?.id || libraries[0]?.id || ""), [offset, setOffset] = useState(0);
      const report = model.view.sections[key] || current?.report, terms = (report?.termSurvey?.review?.terms || []).filter((item) => item.action === "pending_review");
      const link = () => model.linkReviewedFinal({ path: path.trim(), libraryId });
      if (!["mqxliff", "xliff"].includes(run.format)) return h(Empty, { title: "人工终稿使用 MQXLIFF / XLIFF", description: "从 memoQ 导出双语原文件建批，可用条目身份准确接回人工终稿。", t });
      return h("div", { className: "stack final-review" }, h("details", { className: "card stack", open: !current?.complete || undefined }, h("summary", { className: "section-heading" }, t(current?.complete ? "更换或重新关联终稿" : "关联人工终稿"), h("span", { className: "badge" }, t(current?.complete ? "已关联人工终稿" : "待 memoQ 审校"))),
        h("p", { className: "muted" }, t("在 memoQ 完成人工审校后，关联本地双语终稿。整份终稿用于 TM，本批对应译段用于学习差异和术语更新。")),
        h("label", null, t("人工终稿相对路径"), h("input", { value: path, placeholder: "reviewed/story.mqxliff", onChange: (event) => setPath(event.target.value) })),
        h("label", null, t("终稿记忆库"), h("select", { value: libraryId, onChange: (event) => setLibraryId(event.target.value) }, ...libraries.map((library) => h("option", { key: library.id, value: library.id }, library.name)))),
        h(Button, { primary: true, onClick: link, disabled: !path.trim() || !libraryId || editingLocked(run) || model.dirty(), busy: model.view.operations[key]?.pending }, t("关联人工终稿")),
        model.dirty() && h("p", { className: "muted" }, t("请先保存或放弃当前译文草稿，再关联人工终稿")),
        h(Feedback, { model, name: key, retry: link, t })),
        report && h("section", { className: "card stack", "aria-label": t("终稿关联报告") }, h("h3", null, t("终稿关联报告")),
          h("div", { className: "metrics" }, ...[["TM 条目", report.memoriesWritten], ["学习轨迹", (report.trajectoriesLinked || 0) + (report.trajectoriesUpdated || 0) + (report.trajectoryAcceptedUnchanged || 0)], ["术语更新", report.termSurvey?.autoWritten], ["待核对术语", report.termSurvey?.pendingReview]].map(([label, value]) => h("span", { key: label }, h("strong", null, value || 0), t(label)))),
          h("p", { className: "muted" }, `${t("对齐原批次")} ${report.matched || 0} ${t("段")} · ${t("修改")} ${report.changed || 0} ${t("段")}`),
          h("p", { className: "muted" }, t("已记录的人工终稿可在学习中心生成项目风格候选。")),
          report.termSurvey?.warning && h("p", { className: "error", role: "alert" }, report.termSurvey.warning),
          ...(report.failures || []).map((item, index) => h("p", { className: "error", key: index, role: "alert" }, item.reason)),
          ((report.rejected?.unmatched?.length || 0) + (report.rejected?.ambiguous?.length || 0) > 0) && h("details", null, h("summary", null, t("未采用的终稿条目")), ...(report.rejected.unmatched || []).concat(report.rejected.ambiguous || []).slice(0, 20).map((item, index) => h("p", { key: index }, item.source, " · ", item.reason))),
          current?.hash && h("details", null, h("summary", null, t("文件版本")), h("p", null, h("code", null, current.path)), h("code", null, current.hash), h("p", { className: "muted" }, timeText(current.at)))),
        terms.length > 0 && h("section", { className: "card stack" }, h("h3", null, t("待核对术语")), h("p", { className: "muted" }, t("已有译法冲突或证据不足的条目集中保留，核对后再更新术语库。")), ...terms.slice(offset, offset + 20).map((item, index) => h("article", { className: "resource-row", key: index }, h("strong", null, `${item.source} → ${item.target}`), h("p", { className: "muted" }, item.reason))), h(Pager, { offset, total: terms.length, onChange: setOffset, t })));
    }
    function TaskHistory({ model, t }) {
      const [expanded, setExpanded] = useState(false), tasks = model.view.tasks;
      return h("details", { open: expanded, onToggle: (event) => setExpanded(event.currentTarget.open) }, h("summary", null, t("任务记录"), ` · ${tasks.length}`),
        expanded && (!tasks.length ? h(Empty, { title: "暂无任务记录", t }) : tasks.map((task, index) => h("article", { className: "task-record", key: `${task.type}:${task.id || task.batchId || index}` },
          h("div", { className: "task-status" }, h("span", { className: "badge" }, t(task.type === "batch" ? "翻译批次" : task.type === "background" ? "后台任务" : "独立审校")), h("span", { className: "muted" }, stateText(task.status || task.runState, t))),
          h("strong", null, task.title || task.filename || task.taskType || task.id), task.progress && h("progress", { max: 100, value: task.progress.percent || 0, "aria-label": task.title || task.id }),
          h("p", null, task.progress?.message || task.error || ""), h("p", { className: "muted" }, timeText(task.updatedAt || task.createdAt)),
          task.type === "batch" && h(Button, { small: true, onClick: () => model.select(task.batchId || task.id) }, t("打开批次")),
          task.type !== "batch" && task.payload?.batchId && h(Button, { small: true, onClick: () => model.select(task.payload.batchId) }, t("关联批次")),
          h("details", null, h("summary", null, t("任务 ID")), h("code", null, task.id || task.batchId))))));
    }
    function TaskView({ model, t }) {
      const run = model.displayRun(), view = model.view;
      const [panel, setPanel] = useState("overview");
      const notice = model.draftNotice();
      return h("div", { className: "stack" }, h("label", null, t("选择翻译批次"), h("select", { className: "task-selector", value: view.selectedId, onChange: (event) => model.select(event.target.value) }, h("option", { value: "", disabled: view.files.length > 0 }, t(view.files.length ? "选择翻译批次" : "暂无翻译批次")), ...view.files.map((file) => h("option", { key: file.batchId, value: file.batchId }, batchLabel(file, stateText(file.runState || file.status, t)))))),
        h(Feedback, { model, name: "task-list", retry: () => model.refresh(), t }), h(Feedback, { model, name: "task-load", retry: () => model.activate(view.selectedId), t }),
        view.newBatches.length > 0 && h("div", { className: "notice", role: "status" }, t("发现新批次"), ` · ${view.newBatches.length} `, h(Button, { small: true, quiet: true, onClick: () => model.select(view.newBatches[0]) }, t("查看新批次"))),
        notice === "switch" && h("section", { className: "notice", role: "alert" }, h("strong", null, t("有未保存的译文草稿")), h("p", null, t("切换批次前，保存或放弃当前草稿。")), h("div", { className: "button-row" }, h(Button, { primary: true, busy: view.operations.save?.pending, disabled: editingLocked(run), onClick: () => model.confirmSelection(true) }, t("保存并切换")), h(Button, { onClick: () => model.confirmSelection(false) }, t("放弃并切换")), h(Button, { quiet: true, onClick: () => model.cancelSelection() }, t("取消切换")))),
        notice === "draft" && h("div", { className: "notice", role: "status" }, t("有未保存的译文草稿"), h("p", { className: "muted" }, t("草稿保存在当前会话中，退出应用前请保存。"))),
        !run && !view.operations["task-load"]?.pending && h(Empty, { title: "从工作区开始", description: "指定原文、关联资源，然后开始第一批翻译。", artwork: true, t }),
        (!run || panel === "overview") && h(QuickBatch, { model, t }),
        run && h("section", { className: "stack", key: run.batchId }, h("div", { className: "type-tabs", "aria-label": t("当前任务分区") }, ...[["overview", "任务概览"], ["review", "译文检查"], ["export", "工作区导出"], ["final", "终稿与学习"]].map(([value, label]) => h("button", { type: "button", key: value, "aria-pressed": panel === value, onClick: () => setPanel(value) }, t(label)))),
          panel === "overview" ? h(TaskSummary, { model, run, t, review: () => setPanel("review"), exportFile: () => setPanel("export") }) : panel === "review" ? h(ReviewPanel, { model, run, t, key: run.batchId }) : panel === "final" ? h(FinalReviewPanel, { model, run, t, key: run.batchId }) : h(ExportPanel, { model, run, t, key: run.batchId, onFinal: () => setPanel("final") })), h(TaskHistory, { model, t }));
    }
    function ResourcePreview({ model, preview, t, close }) {
      const key = `agent-read:${preview.purpose}:${preview.path}`;
      const compileKey = `agent-compile:${preview.purpose}:${preview.path}`, ready = preview.compilation?.status === "ready";
      const inspect = () => model.ask(`请使用 DSH 文件工具查阅工作区原文件 ${JSON.stringify(preview.path)}，用途为${resourceFields.find((item) => item.purpose === preview.purpose)?.label || preview.purpose}。直接查看原格式，不改动原件。请说明其中与翻译有关的内容。`, key);
      const refresh = () => model.loadSection("preview", (token) => model.request({ action: "file", path: preview.path, purpose: preview.purpose, register: false, projectId: token.view.projectId }, token));
      return h("section", { className: "preview stack" }, h("div", { className: "section-heading" }, h("h3", null, preview.filename || preview.path), h(Button, { quiet: true, small: true, onClick: close }, t("关闭"))),
        h("code", null, preview.path), h("p", { className: "muted" }, t(resourceFields.find((item) => item.purpose === preview.purpose)?.label || "资源"), " · ", sizeText(preview.size)),
        preview.compilation && h("div", { className: "stack" }, h("p", { className: "muted" }, t(ready ? "已编译，可用于翻译" : "待 Agent 编译"), ready && ` · ${preview.purpose === "style-guide" ? `${preview.compilation.characters} ${t("字符")}` : `${preview.compilation.itemCount} ${t("条")}`}`), !ready && h("div", { className: "button-row" }, h(Button, { onClick: () => model.compileResource(preview), busy: model.view.operations[compileKey]?.pending }, t("让 Agent 编译")), h(Button, { quiet: true, onClick: refresh }, t("刷新编译状态"))), h(Feedback, { model, name: compileKey, retry: () => model.compileResource(preview), t })),
        h(Button, { onClick: inspect, busy: model.view.operations[key]?.pending }, t("让 Agent 查看原文件")), h(Feedback, { model, name: key, retry: inspect, t }),
        h("details", null, h("summary", null, t("文件版本")), h("code", null, "SHA-256 ", preview.hash)));
    }
    function LegacyResources({ model, t }) {
      const [open, setOpen] = useState(false);
      const load = () => model.loadSection("legacy", async (token) => {
        const [styles, references] = await Promise.all([model.invoke(model.path("/api/style-profiles", {}, token), "GET", undefined, token), model.invoke(model.path("/api/references", { limit: 50 }, token), "GET", undefined, token)]);
        return { guides: (styles.userProfiles || []).filter((profile) => profile.projectId === token.view.projectId && String(profile.name || "").startsWith("风格指南 · ")), references: references.items || [] };
      });
      const data = model.view.sections.legacy;
      return h("details", { onToggle: (event) => { setOpen(event.currentTarget.open); if (event.currentTarget.open && !data) load(); } }, h("summary", null, t("项目旧指南与参考资料")), open && h(React.Fragment, null, h(Feedback, { model, name: "section:legacy", retry: load, t }),
        ...(data?.guides || []).map((profile) => h("section", { className: "resource-row", key: profile.id }, h("strong", null, profile.name), h("p", { className: "muted" }, t("旧版项目指南"), ` · v${profile.version || 1} · ${stateText(profile.status, t)}`), h("details", null, h("summary", null, t("指南全文")), h("div", { className: "preview-text" }, profile.instruction || "")))),
        ...(data?.references || []).map((reference) => h("section", { className: "resource-row", key: reference.id }, h("strong", null, reference.filename || reference.name || reference.title), h("p", null, reference.description || ""))), data && !data.guides.length && !data.references.length && h(Empty, { title: "暂无条目", t })));
    }
    function LocalFiles({ model, purpose, library, t }) {
      const [paths, setPaths] = useState({}), [folder, setFolder] = useState(""), [query, setQuery] = useState(""), [offset, setOffset] = useState(0);
      const resource = resourceFields.find((item) => item.purpose === purpose), key = `resource:${purpose}:${library?.id || ""}`, unlinkKey = `unlink-resource:${purpose}:${library?.id || ""}`, config = model.workspace?.config || {}, preview = model.view.sections.preview;
      const files = linkedPaths(config, purpose, library?.id);
      const listing = resourcePage(files, { folder, query, offset });
      const inspect = (path) => model.loadSection("preview", (token) => model.request({ action: "file", path, purpose, libraryId: library?.id, register: false, projectId: token.view.projectId }, token));
      const link = () => model.perform(key, async (token) => {
        const result = await model.request({ action: "file", path: paths[purpose]?.trim(), purpose, libraryId: library?.id, projectId: token.view.projectId }, token);
        token.view.sections.preview = result; delete token.view.operations[unlinkKey]; await model.refresh();
        if (!model.valid(token)) return;
        if (result.compilation?.status === "pending") return (await model.compileResource(result)).ok ? "已关联，已交给 Agent 编译" : "已关联，自动编译未提交，请重试";
        return "已关联工作区文件";
      });
      const unlink = (path) => model.perform(unlinkKey, async (token) => {
        const latest = await model.request({ action: "workspace" }, token);
        await model.request({ action: "workspace", actionType: "configure", resources: { [resource.field]: (latest.config[resource.field] || []).filter((item) => item !== path) } }, token);
        if (token.view.sections.preview?.path === path) delete token.view.sections.preview;
        delete token.view.operations[key];
        await model.refresh(); return "已解除关联，工作区原件保留";
      });
      const changeFolder = (value) => { setFolder(value); setOffset(0); delete model.view.sections.preview; model.emit(); };
      return h("div", { className: "stack" },
        h("details", { className: "card", open: !files.length || undefined }, h("summary", null, t("关联工作区文件")), h("div", { className: "quick-form" }, h("label", null, t("工作区相对路径"), h("input", { value: paths[purpose] || "", placeholder: resource.placeholder, onChange: (event) => setPaths({ ...paths, [purpose]: event.target.value }) })),
          h(Button, { primary: true, disabled: !paths[purpose]?.trim(), busy: model.view.operations[key]?.pending, onClick: link }, t("关联文件")), h(Feedback, { model, name: key, retry: link, t }))),
        h("section", { className: "card stack" }, h("div", { className: "section-heading" }, h("h3", null, t("关联本地文件")), h("span", { className: "muted" }, `${files.length} ${t("个文件")}`)),
          h("input", { type: "search", value: query, placeholder: t("搜索文件名或路径"), "aria-label": t("搜索资源文件"), onChange: (event) => { setQuery(event.target.value); setOffset(0); } }),
          h("div", { className: "breadcrumbs" }, h(Button, { small: true, quiet: true, onClick: () => changeFolder("") }, t("全部文件")), folder && h(React.Fragment, null, h("span", { className: "muted" }, folder), h(Button, { small: true, quiet: true, onClick: () => changeFolder(folder.replace(/[^/]+\/$/u, "")) }, t("上一级")))),
          h("div", { className: "file-list" }, ...listing.items.map((entry) => h("div", { className: "file-row", key: entry.path }, h("button", { type: "button", className: "file-title quiet", onClick: () => entry.folder ? changeFolder(entry.path) : inspect(entry.path) }, h(Glyph, { name: entry.folder ? "folder" : "tasks" }), h("span", null, entry.name), entry.folder && h("span", { className: "badge" }, entry.count)),
            !entry.folder && h(Button, { small: true, quiet: true, onClick: () => unlink(entry.path), busy: model.view.operations[unlinkKey]?.pending }, t("解除关联")))), !listing.total && h(Empty, { title: "尚未关联文件", t })),
          h(Pager, { offset: listing.offset, total: listing.total, onChange: setOffset, t })),
        h(Feedback, { model, name: "section:preview", t }), h(Feedback, { model, name: unlinkKey, t }), preview?.purpose === purpose && files.includes(preview.path) && h(ResourcePreview, { model, preview, t, close: () => { delete model.view.sections.preview; model.emit(); } }));
    }
    function LibraryAssets({ model, purpose, t }) {
      const kind = purpose === "tm" ? "tm" : "term", priorityKey = `library-priority:${purpose}`;
      const [mode, setMode] = useState("files"), [libraryId, setLibraryId] = useState(""), [sourceFile, setSourceFile] = useState(null), [input, setInput] = useState(""), [search, setSearch] = useState(""), [offset, setOffset] = useState(0), [name, setName] = useState(""), [role, setRole] = useState("reference");
      const loadLibraries = (token) => model.invoke(model.path(`/api/projects/${encodeURIComponent(token.view.projectId)}/libraries`, { withStats: 1 }, token), "GET", undefined, token);
      const catalog = useSection(model, "asset-libraries", loadLibraries) || {};
      const libraries = (catalog.libraries || []).filter((item) => item.kind === (kind === "term" ? "term_base" : "translation_memory"));
      const library = libraries.find((item) => item.id === libraryId), filesMode = kind === "tm" && libraryId && libraryId !== "all" && sourceFile === null;
      const section = `assets:${kind}:${libraryId}:${sourceFile}:${search}:${offset}`;
      const load = (token) => libraryId && mode === "entries" ? model.invoke(model.path(filesMode ? "/api/library-files" : "/api/library-entries", { kind, libraryId: libraryId === "all" ? "" : libraryId, search, offset, limit: 20, ...(sourceFile === null ? {} : { sourceFile }) }, token), "GET", undefined, token) : Promise.resolve({});
      const data = useSection(model, section, load, [kind, libraryId, sourceFile, search, offset, mode]) || {};
      const open = (id, file = null) => { setLibraryId(id); setSourceFile(file); setMode(id === "all" || file !== null ? "entries" : "files"); setOffset(0); setInput(""); setSearch(""); };
      const create = () => model.perform("library-create", async (token) => {
        const result = await model.invoke(`/api/projects/${encodeURIComponent(token.view.projectId)}/libraries`, "POST", { name: name.trim(), kind: kind === "term" ? "term_base" : "translation_memory", role: kind === "term" ? "reference" : role }, token);
        setName(""); await model.loadSection("asset-libraries", loadLibraries); await model.refresh(); open(result.library.id); return "已创建资源库";
      });
      const enable = (item) => model.perform(`library-enable:${item.id}`, async (token) => {
        await model.invoke(`/api/projects/${encodeURIComponent(token.view.projectId)}/libraries/${encodeURIComponent(item.id)}`, "PATCH", { enabled: item.enabled === false }, token);
        await model.loadSection("asset-libraries", loadLibraries); await model.refresh();
      });
      const move = (item, direction) => model.perform(priorityKey, async (token) => {
        const latest = await loadLibraries(token);
        const changes = libraryPriorityChanges((latest.libraries || []).filter((entry) => entry.kind === item.kind), item.id, direction);
        try {
          for (const change of changes) await model.invoke(`/api/projects/${encodeURIComponent(token.view.projectId)}/libraries/${encodeURIComponent(change.id)}`, "PATCH", { priority: change.priority }, token);
        } finally { await model.loadSection("asset-libraries", loadLibraries); await model.refresh(); }
        return "已调整库优先级";
      });
      const rows = filesMode ? data.files || [] : data.items || [];
      return h("div", { className: "stack" },
        h(Feedback, { model, name: "section:asset-libraries", retry: () => model.loadSection("asset-libraries", loadLibraries), t }),
        !libraryId ? h(React.Fragment, null, h("section", { className: "card stack" }, h("div", { className: "section-heading" }, h("h3", null, t(kind === "term" ? "术语库" : "记忆库 TM")), h("span", { className: "muted" }, `${libraries.length} ${t("个库")}`)),
          h("p", { className: "muted" }, t("库内关联原文件，由 Agent 查阅；优先级数字越小越优先，使用 ↑ ↓ 调整。")),
          h("div", { className: "library-list" }, h("div", { className: "library-row" }, h("div", null, h("strong", null, t("全部库（合并视图）")), h("p", { className: "muted" }, `${libraries.reduce((sum, item) => sum + (Number(item.entryCount) || 0), 0)} ${t("条")}`)), h(Button, { small: true, onClick: () => open("all") }, t("打开"))),
            ...libraries.map((item, index) => h("div", { className: "library-row", key: item.id }, h("label", { className: "library-toggle" }, h("input", { type: "checkbox", checked: item.enabled !== false, disabled: model.view.operations[`library-enable:${item.id}`]?.pending, "aria-label": `${t("启用")} ${item.name}`, onChange: () => enable(item) }), h("span", { className: "badge" }, t(item.role === "master" ? "主 TM" : item.role === "working" ? "工作 TM" : kind === "term" ? "术语库" : "参考 TM"))),
              h("div", { className: "library-title" }, h("strong", null, item.name), h("p", { className: "muted" }, `${item.entryCount || 0} ${t("条")} · ${linkedPaths(model.workspace?.config || {}, purpose, item.id).length} ${t("个关联文件")} · ${t("优先级")} ${item.priority || 1}`, kind === "tm" ? ` · ${item.fileCount || 0} ${t("个文件")}` : "")), h("div", { className: "library-actions" }, h(Button, { small: true, disabled: index === 0 || model.view.operations[priorityKey]?.pending, "aria-label": `${t("上移")} ${item.name}`, title: t("提高优先级"), onClick: () => move(item, -1) }, "↑"), h(Button, { small: true, disabled: index === libraries.length - 1 || model.view.operations[priorityKey]?.pending, "aria-label": `${t("下移")} ${item.name}`, title: t("降低优先级"), onClick: () => move(item, 1) }, "↓"), h(Button, { small: true, onClick: () => open(item.id) }, t("打开"))), h(Feedback, { model, name: `library-enable:${item.id}`, t }))))),
          h("details", { className: "card" }, h("summary", null, t("新增库并关联文件")), h("div", { className: "quick-form" }, h("label", null, t("库名称"), h("input", { value: name, onChange: (event) => setName(event.target.value) })), kind === "tm" && h("label", null, t("库用途"), h("select", { value: role, onChange: (event) => setRole(event.target.value) }, ...[["master", "主 TM"], ["working", "工作 TM"], ["reference", "参考 TM"]].map(([value, label]) => h("option", { key: value, value }, t(label))))), h(Button, { disabled: !name.trim(), busy: model.view.operations["library-create"]?.pending, onClick: create }, t("创建库")), h(Feedback, { model, name: "library-create", retry: create, t }))))
          : h("section", { className: "card stack" }, h("div", { className: "breadcrumbs" }, h(Button, { small: true, quiet: true, onClick: () => open("") }, t("全部库")), h("span", null, " / "), h(Button, { small: true, quiet: true, onClick: () => open(libraryId) }, library?.name || t("全部库（合并视图）")), sourceFile !== null && h("span", { className: "muted" }, " / ", sourceFile === "__none__" ? t("未标注来源") : sourceFile)),
            libraryId !== "all" && h("div", { className: "type-tabs" }, ...[["files", "关联文件"], ["entries", "已有条目"]].map(([value, label]) => h("button", { type: "button", key: value, "aria-pressed": mode === value, onClick: () => { setMode(value); setSourceFile(null); setOffset(0); setInput(""); setSearch(""); } }, t(label)))),
            mode === "files" && library ? h(LocalFiles, { model, purpose, library, t, key: libraryId }) : h(React.Fragment, null,
            h("form", { className: "button-row", onSubmit: (event) => { event.preventDefault(); setSearch(input); setOffset(0); if (search === input) model.loadSection(section, load); } }, h("input", { type: "search", value: input, placeholder: t(filesMode ? "搜索来源文件" : "搜索资产"), "aria-label": t(filesMode ? "搜索来源文件" : "搜索资产"), onChange: (event) => setInput(event.target.value) }), h(Button, { onClick: () => { setSearch(input); setOffset(0); if (search === input) model.loadSection(section, load); } }, t("搜索"))),
            h(Feedback, { model, name: `section:${section}`, retry: () => model.loadSection(section, load), t }),
            h("div", null, ...rows.map((item, index) => filesMode ? h("article", { className: "library-row", key: item.sourceFile || index }, h("div", { className: "library-title" }, h("strong", null, item.sourceFile || t("未标注来源")), h("p", { className: "muted" }, `${item.entryCount || item.count || 0} ${t("条")} · ${item.learning?.humanReviewed || 0} ${t("条已审校轨迹")}`), item.batch && h("p", { className: "muted" }, `${t("翻译进度")} ${item.batch.completedSegments || 0} / ${item.batch.totalSegments || 0}`)), h(Button, { small: true, onClick: () => open(libraryId, item.sourceFile || "__none__") }, t("查看条目")))
              : h("article", { className: "asset-row", key: item.id || index }, h("div", null, h("span", { className: "muted" }, t("原文")), h("p", null, item.source || item.name || "")), h("div", null, h("span", { className: "muted" }, t("译文")), h("p", null, item.target || item.translation || "")), h("span", { className: "badge" }, t(({ human_approved: "人工确认", machine_verified: "机器译文", approved: "已批准", draft: "草稿" })[item.qualityStatus || item.status] || item.qualityStatus || item.status || "")))), !rows.length && !model.view.operations[`section:${section}`]?.pending && h(Empty, { title: filesMode ? "此库暂无来源文件" : "暂无正式资产", t })),
            h(Pager, { offset, total: data.total || 0, onChange: setOffset, t }))), !libraryId && h(Feedback, { model, name: priorityKey, t }));
    }
    function AssetsView({ model, t }) {
      const [purpose, setPurpose] = useState("terms");
      return h("div", { className: "stack" }, h("div", null, h("h2", null, t("项目资产")), h("p", null, t("按库关联本地原文件，统一管理任务所用的术语、记忆、指南和资料。"))),
        h("div", { className: "type-tabs" }, ...[["terms", "术语库"], ["tm", "记忆库 TM"], ["style-guide", "风格指南"], ["reference", "参考资料"]].map(([value, label]) => h("button", { type: "button", key: value, "aria-pressed": purpose === value, onClick: () => setPurpose(value) }, t(label)))),
        ["terms", "tm"].includes(purpose) ? h(LibraryAssets, { model, purpose, t, key: purpose }) : h(React.Fragment, null, h(LocalFiles, { model, purpose, t, key: purpose }), h(LegacyResources, { model, t })));
    }
    function StandaloneQa({ model, t }) {
      const [source, setSource] = useState(""), [target, setTarget] = useState("");
      const withResources = Object.values(resourceSelection(model.workspace?.config, model.workspace?.libraries)).some((paths) => paths.length);
      const agentInspect = () => model.ask(`请用当前工作区已关联的资源审校下面的日中译文。先用 DSH 工具查阅原格式资源，不创建转换副本，然后执行 Kami 独立审校，并在主会话中说明问题。原文：${JSON.stringify(source)}；译文：${JSON.stringify(target)}。`, "agent-qa");
      const inspect = () => model.perform("standalone-qa", async (token) => { token.view.sections.standaloneQa = await model.invoke("/api/auto-qa", "POST", scopeArgs(model, token, { source, translation: target }), token); });
      return h("div", { className: "stack" }, h("div", null, h("h2", null, t("独立审校")), h("p", { className: "muted" }, t("当前工作区最新资源"))),
        h("div", { className: "pairs" }, h("label", null, t("原文"), h("textarea", { value: source, onChange: (event) => setSource(event.target.value) })), h("label", null, t("译文"), h("textarea", { value: target, onChange: (event) => setTarget(event.target.value) }))),
        h("div", null, h(Button, { primary: true, disabled: !source.trim() || !target.trim(), busy: model.view.operations[withResources ? "agent-qa" : "standalone-qa"]?.pending, onClick: withResources ? agentInspect : inspect }, t(withResources ? "交给 Agent 审校" : "运行 QA")), h(Feedback, { model, name: "standalone-qa", retry: inspect, t }), h(Feedback, { model, name: "agent-qa", t })), h(QaReport, { report: model.view.sections.standaloneQa, t }));
    }
    function LearningEvidence({ model, t }) {
      const [open, setOpen] = useState(false), [offset, setOffset] = useState(0), [search, setSearch] = useState("");
      const load = (token) => open ? model.invoke(model.path("/api/learning/evidence", { contentType: "all", domain: "all", offset, limit: 20, search }, token), "GET", undefined, token) : Promise.resolve(null);
      const data = useSection(model, "learning-evidence", load, [open, offset, search]);
      return h("details", { className: "card", open, onToggle: (event) => setOpen(event.currentTarget.open) }, h("summary", null, t("来源证据与变更原因")), open && h("div", { className: "stack" },
        h("input", { type: "search", value: search, placeholder: t("搜索原文、译文或来源"), "aria-label": t("搜索学习证据"), onChange: (event) => { setSearch(event.target.value); setOffset(0); } }),
        h(Feedback, { model, name: "section:learning-evidence", retry: () => model.loadSection("learning-evidence", load), t }),
        ...(data?.items || []).map((item) => h("article", { className: "resource-row", key: item.id }, h("span", { className: "badge" }, t(item.humanDecision?.accepted ? "人工确认" : "机器译文")), h("p", { className: "muted" }, item.sourceFile || t("未标注来源")), h("p", null, item.source), h("p", null, item.humanDecision?.finalTranslation || item.finalTranslation || item.initialTranslation || ""))),
        data && !data.items?.length && h(Empty, { title: "暂无条目", t }), h(Pager, { offset, total: data?.total || 0, onChange: setOffset, t })));
    }
    function LearningView({ model, t }) {
      const [step, setStep] = useState("champion"), [selected, setSelected] = useState(""), [offset, setOffset] = useState(0), [styleOffset, setStyleOffset] = useState(0);
      const load = async (token) => { const [learning, styles] = await Promise.all([model.invoke(model.path("/api/learning", { contentType: "general", domain: "general" }, token), "GET", undefined, token), model.invoke(model.path("/api/style-profiles", {}, token), "GET", undefined, token)]); return { ...learning, styleProfiles: styles.styleProfiles || [] }; };
      const data = useSection(model, "learning", load) || {}, candidates = data.candidates || [], candidate = candidates.find((item) => item.id === selected) || candidates[0], candidateId = candidate?.id || "";
      const champion = data.champion || data.champions?.[0], scope = { contentType: candidate?.contentType || "general", domain: candidate?.domain || "general" };
      const gateKey = `learning-gate:${candidateId}`, loadGate = (token) => model.invoke(model.path("/api/quality/gate", { ...scope, ...(candidateId ? { skillId: candidateId } : {}) }, token), "GET", undefined, token);
      const gate = useSection(model, gateKey, loadGate, [candidateId]);
      const evaluation = (data.evaluations || []).find((item) => item.challengerSkillId === candidateId);
      const evaluationKey = `evaluate-learning:${candidateId}`, gateActionKey = `run-gate:${candidateId}`, activationKey = `activate-learning:${candidateId}`;
      const canPromote = promotionReady(evaluation, gate, candidateId) && candidate?.parentId === champion?.id && evaluation?.championSkillId === champion?.id;
      const statuses = { promote: "评测通过", needs_review: "需要复核", reject: "未通过", pass: "已通过", block: "已阻断", insufficient: "证据不足", not_run: "尚未运行" };
      const operation = (key, path, body = {}) => model.perform(key, async (token) => {
        const value = await model.invoke(path, "POST", scopeArgs(model, token, { ...scope, ...body }), token);
        if (value.skill?.id && key === "generate") { setSelected(value.skill.id); setStep("candidates"); }
        await model.loadSection("learning", load); await model.loadSection(gateKey, loadGate);
        return key.startsWith("activate-learning:") ? "已激活" : value.evaluation ? "评测结果已保存" : value.message || (value.jobId || value.backgroundTaskId ? "后台任务已提交，可在任务记录中查看进度。" : "已完成");
      });
      useEffect(() => {
        if (!model.visible) return;
        const timer = setInterval(() => { model.loadSection("learning", load); model.loadSection(gateKey, loadGate); }, 5000);
        return () => clearInterval(timer);
      }, [model, model.visible, model.scopeKey, candidateId]);
      const previewGold = () => model.loadSection("gold-preview", (token) => model.invoke("/api/quality/gold-sets/from-trajectories", "POST", scopeArgs(model, token, scope), token));
      const gold = model.view.sections["gold-preview"];
      return h("div", { className: "stack learning-view" }, h("div", null, h("h2", null, t("学习中心")), h("p", null, t("按当前项目积累人工终稿；候选通过评测和门禁后，由你启用。"))),
        h("div", { className: "learning-steps", "aria-label": t("学习流程") }, ...[["champion", "生效版本", champion ? `v${champion.version || 1}` : "暂无记录"], ["candidates", "候选", `${candidates.length}`], ["evaluation", "评测", evaluation ? statuses[evaluation.decision] || evaluation.decision : "尚未评测"], ["gate", "门禁", gate?.status ? statuses[gate.status] || gate.status : "尚未运行"], ["activate", "启用", canPromote ? "可以启用" : "等待检查"]].map(([value, label, hint], index) => h("button", { type: "button", key: value, "aria-pressed": step === value, onClick: () => setStep(value) }, h("span", { className: "muted" }, String(index + 1).padStart(2, "0")), h("strong", null, t(label)), h("span", { className: "step-hint" }, t(hint))))),
        h(Feedback, { model, name: "section:learning", retry: () => model.loadSection("learning", load), t }),
        step === "champion" && h("section", { className: "card stack" }, h("div", { className: "section-heading" }, h("h3", null, t("当前生效版本")), champion && h("span", { className: "badge" }, `v${champion.version || 1}`)), champion ? h(React.Fragment, null, h("strong", null, skillLabel(champion, model.workspace?.project?.name || t("当前项目"), model.view.projectId)), h("p", null, champion.description || ""), h("details", null, h("summary", null, t("策略内容")), h("div", { className: "preview-text" }, champion.strategy?.instruction || champion.instruction || t("使用当前版本的默认策略")))) : h(Empty, { title: "暂无条目", t }), h(Button, { onClick: () => setStep("candidates") }, t("查看候选"))),
        step === "candidates" && h("section", { className: "card stack" }, h("div", { className: "section-heading" }, h("h3", null, t("候选版本")), h(Button, { small: true, onClick: () => operation("generate", "/api/learning/skills/generate"), busy: model.view.operations.generate?.pending }, t("生成候选策略"))),
          h(Feedback, { model, name: "generate", t }), ...candidates.slice(offset, offset + 20).map((item) => h("article", { className: "candidate-row", key: item.id, "data-selected": candidateId === item.id }, h("div", { className: "section-heading" }, h("strong", null, skillLabel(item, model.workspace?.project?.name || t("当前项目"), model.view.projectId)), h(Button, { small: true, primary: candidateId === item.id, onClick: () => { setSelected(item.id); setStep("evaluation"); } }, t("选择候选"))), h("p", null, item.description || ""), h("details", null, h("summary", null, t("变更内容")), h("div", { className: "preview-text" }, item.strategy?.instruction || item.instruction || "")))), !candidates.length && h(Empty, { title: "暂无候选", description: "从人工确认的终稿生成候选，不会自动替换生效版本。", t }), h(Pager, { offset, total: candidates.length, onChange: setOffset, t })),
        ["evaluation", "gate", "activate"].includes(step) && h("div", { className: "candidate-picker" }, h("label", null, t("受测候选"), h("select", { value: candidateId, onChange: (event) => setSelected(event.target.value) }, !candidates.length && h("option", { value: "" }, t("先生成候选")), ...candidates.map((item) => h("option", { key: item.id, value: item.id }, skillLabel(item, model.workspace?.project?.name || t("当前项目"), model.view.projectId)))))),
        step === "evaluation" && h("section", { className: "card stack" }, h("h3", null, t("生效版本与候选评测")), h("p", { className: "muted" }, t("使用未参与候选学习的人工终稿做配对评测。")),
          h(Button, { disabled: !candidateId, busy: model.view.operations[evaluationKey]?.pending, onClick: () => operation(evaluationKey, `/api/learning/skills/${encodeURIComponent(candidateId)}/evaluate`) }, t("开始评测")), h(Feedback, { model, name: evaluationKey, t }),
          evaluation ? h(React.Fragment, null, h("span", { className: "badge" }, t(statuses[evaluation.decision] || evaluation.decision)), h("p", null, evaluation.report?.conclusion || evaluation.result?.conclusion || ""), h("p", { className: "muted" }, `${evaluation.sampleCount || 0} ${t("个配对样本")}`),
            h("table", { className: "metric-table" }, h("thead", null, h("tr", null, h("th", null, t("指标")), h("th", null, t("生效版本")), h("th", null, t("候选")))), h("tbody", null, ...[["qaScore", "QA 分数"], ["hardErrorCount", "硬错误"], ["mandatoryTermAccuracy", "术语准确率"]].map(([key, label]) => h("tr", { key }, h("td", null, t(label)), h("td", null, Number.isFinite(evaluation.championMetrics?.[key]) ? evaluation.championMetrics[key] : "—"), h("td", null, Number.isFinite(evaluation.challengerMetrics?.[key]) ? evaluation.challengerMetrics[key] : "—")))))) : h(Empty, { title: "尚未评测", t }), h(Button, { quiet: true, onClick: () => setStep("gate") }, t("查看门禁"))),
        step === "gate" && h("section", { className: "card stack" }, h("div", { className: "section-heading" }, h("h3", null, t("固定 Gold Set 与失败回归")), h("span", { className: "badge" }, t(statuses[gate?.status] || "尚未运行"))), h(Feedback, { model, name: `section:${gateKey}`, retry: () => model.loadSection(gateKey, loadGate), t }),
          h("div", { className: "gate-metrics" }, h("div", null, h("strong", null, gate?.assets?.goldSampleCount || 0), h("span", null, t("启用 Gold 样本"))), h("div", null, h("strong", null, gate?.assets?.regressionCaseCount || 0), h("span", null, t("启用回归案例")))),
          h("p", { className: "muted" }, gate?.assets?.coverage?.reason || t("尚未运行门禁")), ...(gate?.latestRun?.blocking || []).map((item, index) => h("p", { className: "error", key: index }, item.message)),
          h(Button, { disabled: !candidateId, busy: model.view.operations[gateActionKey]?.pending, onClick: () => operation(gateActionKey, "/api/quality/runs", { skillId: candidateId }) }, t("运行门禁")), h(Feedback, { model, name: gateActionKey, t }),
          h("details", { className: "rule" }, h("summary", null, t("管理固定质量资产")), h("div", { className: "stack" }, h(Button, { onClick: previewGold, busy: model.view.operations["section:gold-preview"]?.pending }, t("从人工终稿预览 Gold Set")), h(Feedback, { model, name: "section:gold-preview", t }),
            gold && h("div", { className: "notice" }, `${gold.candidates?.length || 0} ${t("个样本")}`, gold.candidates?.length > 0 && h(Button, { onClick: () => operation("create-gold", "/api/quality/gold-sets", { samples: gold.candidates, status: "active", changeNote: "从人工终稿生成" }), busy: model.view.operations["create-gold"]?.pending }, t("确认建立并启用"))), h(Feedback, { model, name: "create-gold", t }),
            h(Button, { onClick: () => operation("build-regression", "/api/quality/regression-suites"), busy: model.view.operations["build-regression"]?.pending }, t("按最新证据重建回归集")), h(Feedback, { model, name: "build-regression", t })))),
        step === "activate" && h("section", { className: "card stack" }, h("h3", null, t("启用候选")), h("p", null, t(canPromote ? "当前候选评测和门禁已通过，可由你确认启用。" : "需要当前候选的配对评测通过，且门禁结论覆盖最新质量资产。")),
          h(Button, { primary: true, disabled: !canPromote, busy: model.view.operations[activationKey]?.pending, onClick: () => operation(activationKey, `/api/learning/skills/${encodeURIComponent(candidateId)}/activate`) }, t("确认启用候选")), h(Feedback, { model, name: activationKey, t })),
        h("details", { className: "card" }, h("summary", null, t("风格规范"), ` · ${data.styleProfiles?.length || 0}`), h("div", { className: "stack" }, ...(data.styleProfiles || []).slice(styleOffset, styleOffset + 20).map((item) => {
          const key = `style:${item.id}`;
          return h("article", { className: "resource-row", key }, h("strong", null, skillLabel(item, model.workspace?.project?.name || t("当前项目"), model.view.projectId)), h("p", { className: "muted" }, stateText(item.status, t)), h("details", null, h("summary", null, t("规范内容")), h("div", { className: "preview-text" }, item.instruction || "")), item.status === "draft" && h("div", { className: "button-row" }, h(Button, { small: true, onClick: () => operation(`evaluate:${key}`, `/api/style-profiles/${encodeURIComponent(item.id)}/evaluate`), busy: model.view.operations[`evaluate:${key}`]?.pending }, t("评测")), h("details", null, h("summary", null, t("激活")), h("p", { className: "muted" }, t("人工激活后才用于后续任务。")), h(Button, { small: true, onClick: () => operation(`activate:${key}`, `/api/style-profiles/${encodeURIComponent(item.id)}/activate`), busy: model.view.operations[`activate:${key}`]?.pending }, t("确认启用")))), h(Feedback, { model, name: `evaluate:${key}`, t }), h(Feedback, { model, name: `activate:${key}`, t }));
        }), !data.styleProfiles?.length && h(Empty, { title: "暂无条目", t }), h(Pager, { offset: styleOffset, total: data.styleProfiles?.length || 0, onChange: setStyleOffset, t }))), h(LearningEvidence, { model, t }));
    }
    function SettingsView({ model, t }) {
      const data = useSection(model, "settings", (token) => model.invoke("/api/settings", "GET", undefined, token));
      const [settings, setSettings] = useState(null), [directory, setDirectory] = useState(model.workspace?.config?.outputDirectory || "outputs");
      useEffect(() => { if (data) setSettings(data.settings || data); }, [data]);
      const save = () => model.perform("settings-save", async (token) => { const result = await model.invoke("/api/settings", "POST", settings, token); setSettings(result.settings || result); return result.notes?.map((item) => `${item.label}：${item.note}`).join("；") || "已保存"; });
      return h("div", { className: "stack" }, h("h2", null, t("本地参数与备份")),
        h("section", { className: "card stack" }, h("label", null, t("工作区输出目录"), h("input", { value: directory, placeholder: t("输入相对目录，例如 outputs"), onChange: (event) => setDirectory(event.target.value) })), h(Button, { disabled: !directory.trim(), busy: model.view.operations.directory?.pending, onClick: () => model.perform("directory", async (token) => { await model.request({ action: "workspace", actionType: "configure", resources: { outputDirectory: directory.trim() } }, token); await model.refresh(); return "已保存输出目录"; }) }, t("保存输出目录")), h(Feedback, { model, name: "directory", t })),
        h("section", null, h(Button, { busy: model.view.operations.backup?.pending, onClick: () => model.perform("backup", async (token) => { const result = await model.request({ action: "backup" }, token); return result.path; }) }, t("备份本地数据库")), h(Feedback, { model, name: "backup", t })),
        h(Feedback, { model, name: "section:settings", retry: () => model.loadSection("settings", (token) => model.invoke("/api/settings", "GET", undefined, token)), t }),
        settings && h("section", { className: "stack" }, ...(data?.groups || []).map((group) => h("details", { className: "rule", key: group.group }, h("summary", null, t(({ quality: "质量检查", reference: "参考资料", learning: "学习与评测", retrieval: "检索", orthography: "标点", performance: "性能" })[group.group] || group.fields[0]?.label || group.group)),
          h("div", { className: "settings-fields" }, ...group.fields.map((field) => {
            const keys = field.path.split("."), value = keys.reduce((object, key) => object?.[key], settings);
            const change = (next) => { const updated = structuredClone(settings); let object = updated; for (const key of keys.slice(0, -1)) object = object[key] ??= {}; object[keys.at(-1)] = next; setSettings(updated); };
            return h("label", { key: field.path }, field.label, h("input", { type: typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : "text", min: field.min, max: field.max, step: field.step, value: typeof value === "boolean" ? undefined : value ?? "", checked: typeof value === "boolean" ? value : undefined, onChange: (event) => change(typeof value === "boolean" ? event.target.checked : typeof value === "number" ? Number(event.target.value) : event.target.value) }), h("p", { className: "muted" }, field.hint));
          })))), h(Button, { onClick: save, busy: model.view.operations["settings-save"]?.pending }, t("保存设置")), h(Feedback, { model, name: "settings-save", retry: save, t })));
    }
    function WorkspaceBody({ model, t, scrollRef }) {
      const [tab, setTab] = useState("任务"), [binding, setBinding] = useState(false);
      useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [tab, scrollRef]);
      const bound = Boolean(model.view.projectId), showBinding = !bound || binding;
      const content = tab === "任务" ? h(TaskView, { model, t }) : tab === "资产" ? h(AssetsView, { model, t }) : tab === "学习" ? h(LearningView, { model, t }) : tab === "审校" ? h(StandaloneQa, { model, t }) : h(SettingsView, { model, t });
      return h(React.Fragment, null, h("div", { className: "masthead" }, h("header", { className: "brand-row" }, h(BrandMark, { size: 36 }), h("div", { className: "brand-name" }, h("h1", null, t("Kami 翻译工作台")), h("div", { className: "eyebrow" }, "KAMI · JA / ZH-CN")), h("div", { className: `connection ${model.connected ? "" : "error"}`, role: "status" }, h("span", { className: "connection-dot", "aria-hidden": true }), h("span", { className: "connection-label" }, t(model.connected ? "已连接" : model.connection.pending ? "连接中" : "连接失败")))),
        h("div", { className: "workspace-bar" }, h(Glyph, { name: "folder", size: 14 }), h("span", { className: "workspace-path", title: model.workspace?.workspace }, model.workspace?.workspace || t("当前工作区")), h("button", { type: "button", className: "project-chip quiet", title: t("更换项目"), onClick: () => setBinding(!binding) }, model.workspace?.project?.name || t("尚未绑定项目")), h("button", { type: "button", className: "icon-button quiet", title: t("刷新"), "aria-label": t("刷新"), onClick: () => model.refresh() }, h(Glyph, { name: "refresh", size: 14 }))),
        h("nav", { "aria-label": "Kami" }, ...["任务", "资产", "学习", "审校", "设置"].map((label) => h("button", { type: "button", key: label, "aria-pressed": tab === label, onClick: () => setTab(label) }, t(label))))),
        h("div", { className: "body" }, model.connection.error && h("div", { className: "feedback error", role: "alert" }, model.connection.error, h(Button, { small: true, onClick: () => model.refresh() }, t("重试"))),
          showBinding && model.workspace && h(BindingForm, { model, t, close: () => setBinding(false) }), bound && content));
    }
    function Workbench(props) {
      const [, render] = useState(0), modelRef = useRef(null), scrollRef = useRef(null);
      if (!modelRef.current) modelRef.current = new WorkbenchModel({ sessionId: props.sessionId, call: props.call, prompt: props.prompt, visible: props.visible !== false });
      const model = modelRef.current, t = props.t || ((key) => key);
      useEffect(() => model.subscribe(() => render((value) => value + 1)), [model]);
      useEffect(() => {
        model.setVisible(props.visible !== false);
        if (props.visible === false) return;
        let active = false;
        const refresh = async () => { if (active) return; active = true; try { await model.refresh(); } finally { active = false; } };
        refresh(); const timer = setInterval(refresh, 5000);
        return () => { clearInterval(timer); model.setVisible(false); };
      }, [model, props.visible]);
      return h("main", { className: "kami", ref: scrollRef, "aria-label": t("Kami 翻译工作台") }, h("style", null, css), h(WorkspaceBody, { model, t, scrollRef, key: model.scopeKey || "loading" }));
    }
    return {
      inject: ["slots", "locale", "remote", "remote.session", "sessions", "sidebarRight", "sidebarRightTabs"],
      async apply(ctx) {
        ctx.effect(() => ctx.locale.register("kami-dsh", { zh, en: words }));
        const json = { mode: "strict", typeSymbol: "kami-dsh#Json", jsonSchema: {}, create: () => ({ parse(value) {
          return JSON.parse(JSON.stringify(value, (_key, item) => {
            if (["undefined", "function", "symbol"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Kami operation must contain JSON values");
            return item;
          }));
        } }) };
        const sessionId = { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", jsonSchema: { type: "string" }, create: () => ({ parse(value) {
          if (typeof value !== "string" || !value) throw new TypeError("Kami session id must be a nonempty string");
          return value;
        } }) };
        const unmountRemote = await ctx.remote.$mount({ package: "kami-dsh", descriptors: [{
          id: "kami-dsh#kamiUi/invoke", service: "kamiUi", namespace: "kamiUi", method: "invoke", invocation: { kind: "direct" },
          parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: sessionId }, { name: "operation", wire: "operation", source: "json", codec: json }],
          cancellation: { parameter: "signal" }, result: json
        }] });
        ctx.effect(() => unmountRemote);
        await ctx.inject(["remote.kamiUi"], (ctx) => {
          const call = async (session, operation) => {
            if (!session) throw new Error("请先打开一个 DSH 翻译会话");
            const result = await ctx.remote.kamiUi.invoke(session, operation);
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
          };
          const prompt = async (sessionId, text, workspace) => {
            const state = await call(sessionId, { action: "workspace" });
            if (!state.isKamiSession || state.workspace !== workspace) throw new Error("当前会话与工作区的 Kami 预设不匹配，请新建翻译会话");
            const result = await ctx.remote.session.prompt({ requestId: crypto.randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] }); if (!result.ok) throw new Error(result.error.message); return result.value; };
          const openWorkbench = (sessionId) => {
            if (!sessionId || ctx.sidebarRight.mounted.getSnapshot() !== sessionId || ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset !== "kami-translator") return;
            const existing = ctx.sidebarRight.openTabs.getSnapshot().find((tab) => tab.sessionId === sessionId && tab.kind === WORKBENCH_KIND);
            if (existing) { ctx.sidebarRight.focus(existing.tabId); if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); }
            else ctx.sidebarRight.openTab(WORKBENCH_KIND);
          };
          const closeWorkbench = (sessionId) => {
            if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return;
            for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) if (tab.sessionId === sessionId && tab.kind === WORKBENCH_KIND) ctx.sidebarRight.close(tab.tabId);
          };
          ctx.effect(() => ctx.sidebarRightTabs.register({ id: WORKBENCH_TYPE, kind: WORKBENCH_KIND, title: () => ctx.locale.bind("kami-dsh")("Kami 翻译工作台"), keepMounted: true }));
          ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: WORKBENCH_TYPE, locale: "kami-dsh", inject: () => ({ call, prompt }) }, WorkbenchTab));
          ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: WORKBENCH_TYPE, locale: "kami-dsh" }, WorkbenchTitle));
          ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "kami-session-panel", inject: () => ({ hooks: { kamiMounted: ctx.sidebarRight.mounted }, openWorkbench, closeWorkbench }) }, KamiPanelPresence));
          for (const name of ["conversation.hero.options", "conversation.session.header.utilities"]) ctx.slots.inject(name, () => ctx.slots.register({ name, id: "kami-workbench-open", locale: "kami-dsh", inject: () => ({ openWorkbench }) }, WorkbenchOpener));
        });
      }
    };
  }
});

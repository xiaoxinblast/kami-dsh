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
    function chooseBatch(files, selectedId = "", manual = false) {
      if (manual && selectedId) return selectedId;
      const sorted = [...files].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
      return (sorted.find((file) => ["running", "queued"].includes(file.runState)) || sorted[0])?.batchId || "";
    }
    function batchLabel(file, status) {
      const id = String(file.batchId || file.id || "");
      return [file.filename || file.title || id, status, id && `#${id.slice(0, 8)}`].filter(Boolean).join(" · ");
    }
    function editingLocked(run) {
      return !run || ["running", "queued"].includes(run.runState) || run.workflow?.writeBusy === true || run.workflow?.qaRetryBusy === true
        || ["aiQa", "qualityReport", "termSurvey"].some((stage) => ["in_progress", "waiting"].includes(run.workflow?.[stage]?.status));
    }
    function qaLabel(segment) {
      const qa = segment.result?.aiQa || {};
      if (qa.fallbackReason) return "QA 未完成";
      if (qa.status === "deterministic_only") return "规则检查";
      const score = qa.score ?? segment.result?.qaScore;
      return qa.used && Number.isFinite(score) ? `模型 QA · ${score}` : "尚未执行 QA";
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
    function newView(workspace = "", projectId = "") {
      return { workspace, projectId, files: [], tasks: [], knownFiles: false, newBatches: [], selectedId: "", manual: false, run: null, drafts: {}, exports: {}, approvals: {},
        pendingSelection: null, operations: {}, sections: {}, loadSerial: 0 };
    }
    class WorkbenchModel {
      constructor({ sessionId, call, visible = true }) {
        this.sessionId = sessionId; this.call = call; this.visible = visible; this.connected = false;
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
        const report = this.view.sections[`qa:${run.batchId}`];
        return { ...run, segments: (run.segments || []).map((segment) => {
          const checked = report?.segments?.find((item) => item.source === segment.source && item.translation === segment.translation);
          const score = checked?.scores?.overall;
          const value = checked && report.sourceKind !== "batch" ? { ...segment, result: { ...segment.result, issues: checked.issues || [], qa: null,
            qaScore: Number.isFinite(score) ? score : null, aiQa: { used: !checked.fallbackReason, status: checked.fallbackReason ? "failed" : "completed", score: score ?? null, fallbackReason: checked.fallbackReason || "" } } } : segment;
          const approved = this.view.approvals[`${run.batchId}:${segment.id}`] === segment.translation;
          return Object.hasOwn(drafts, segment.id) ? { ...value, translation: drafts[segment.id], draft: true, accepted: false,
            result: { ...value.result, issues: [], qa: null, qaScore: null, aiQa: { status: "not_run", used: false, score: null } } } : { ...value, accepted: value.accepted || approved };
        }) };
      }
      edit(id, value) {
        if (editingLocked(this.view.run)) return false;
        const run = this.view.run, original = run.segments.find((segment) => segment.id === id);
        if (!original) return false;
        const drafts = this.view.drafts[run.batchId] ||= {};
        if (value === (original.translation || "")) delete drafts[id]; else drafts[id] = value;
        delete this.view.exports[run.batchId]; delete this.view.sections[`qa:${run.batchId}`];
        delete this.view.approvals[`${run.batchId}:${id}`]; delete this.view.operations[`approve:${run.batchId}:${id}`];
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
        await this.invoke("/api/batch/run", "POST", this.body({ batchId: id, segments }, token), token);
        for (const [segmentId, value] of Object.entries(drafts)) if (token.view.drafts[id]?.[segmentId] === value) delete token.view.drafts[id][segmentId];
        await this.loadRun(token, id);
      }
      save() { return this.perform("save", async (token) => { await this.saveDrafts(token); return "译文已保存；人工采纳与导出需分别执行。"; }); }
      loadSection(name, operation) {
        return this.perform(`section:${name}`, async (token) => {
          const current = token.view.operations[`section:${name}`];
          const value = await operation(token);
          if (this.valid(token) && current === token.view.operations[`section:${name}`]) token.view.sections[name] = value;
        }, true);
      }
    }
    return { WorkbenchModel, resourceFields, chooseBatch, batchLabel, editingLocked, qaLabel, issuesOf, reportScore };
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
      "开始 / 续跑": "Start / resume", "暂停": "Pause", "导出文件": "Export", "保存修改": "Save edits", "原文": "Source", "译文": "Translation", "采纳为正式译法": "Approve translation",
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
    const { WorkbenchModel, resourceFields, batchLabel, editingLocked, qaLabel, issuesOf, reportScore } = require("kami-dsh/client.workbench-state.js");
    Object.assign(words, {
      "任务": "Tasks", "资源": "Resources", "更多": "More", "当前工作区": "Workspace", "更换项目": "Change project", "已连接": "Connected", "连接中": "Connecting", "连接失败": "Connection failed",
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
      "译文已保存；人工采纳与导出需分别执行。": "Translations saved. Approval and export are separate actions.", "确认采纳": "Confirm approval", "已人工采纳": "Human approved", "保存译文后才能正式采纳。": "Save the translation before approving it.",
      "检查本批次": "Check this batch", "查看上次报告": "View saved report", "上次保存的质量报告": "Last saved QA report", "当前任务快照": "Current task snapshot", "当前工作区最新资源": "Latest workspace resources", "报告没有评分": "No score available", "重试": "Retry",
      "工作区导出": "Export to workspace", "导出路径": "Output path", "留空使用工作区默认输出目录；同名文件会报错。": "Leave blank for the workspace output directory. Existing files are never overwritten.", "导出成功": "Exported", "任务记录": "Task history", "后台任务": "Background task", "独立审校": "Standalone QA", "翻译批次": "Translation batch", "打开批次": "Open batch", "关联批次": "Related batch", "任务 ID": "Task ID", "暂无任务记录": "No task history",
      "下次任务使用的资源": "Resources for the next task", "这些路径引用工作区原件；新建批次时读取最新版。": "These paths reference workspace originals. New batches read the latest content.", "工作区相对路径": "Workspace-relative path", "预览最新版": "Preview latest file", "关联到下次任务": "Use for the next task", "解除关联": "Unlink", "已关联": "Linked", "尚未关联文件": "No files linked", "工作区最新版预览": "Latest workspace preview", "关闭预览": "Close preview", "预览条数": "Preview items", "总条数": "Total items", "字符": "characters", "文件大小": "File size", "用途": "Purpose",
      "项目旧指南与参考资料": "Legacy project guides and references", "查看旧版资源": "View legacy resources", "旧版项目指南": "Legacy project guide", "正式资产库": "Canonical assets", "工作区文件资源请在“资源”中关联，不会自动写入正式库。": "Link workspace files in Resources. They are not automatically imported into the canonical library.",
      "搜索资产": "Search assets", "暂无正式资产": "No canonical assets", "工作区输出目录": "Workspace output directory", "保存输出目录": "Save output directory", "输入相对目录，例如 outputs": "Enter a relative directory, e.g. outputs", "本地参数与备份": "Local settings and backup", "已保存输出目录": "Output directory saved",
      "学习与评测": "Learning and evaluation", "人工激活后才用于后续任务。": "Activation requires your confirmation before use in future tasks.", "指南全文": "Full guide", "运行中": "Running", "已取消": "Cancelled", "已失败": "Failed", "已提交评测": "Evaluation submitted", "已激活": "Activated", "已关联工作区文件": "Workspace file linked", "已解除关联，工作区原件保留": "Unlinked. The original file is preserved.",
      "请明确选择已有 Kami 项目，或创建一个新项目。": "Select an existing Kami project or create a new one.", "未保存译文不会用于检查或导出。": "Save your drafts before QA or export.", "暂无待处理问题": "No pending issues", "资源已冻结": "Resources frozen", "返回任务": "Back to task",
      "发现新批次": "New batches found", "查看新批次": "View new batch", "复核译文": "Review translations", "重试未完成 QA": "Retry incomplete QA", "暂无已记录问题": "No recorded issues", "检查未完成，不表示通过": "Checks are incomplete. This is not a pass."
    });
    Object.assign(zh, Object.fromEntries(Object.keys(words).map((key) => [key, key])));
    const css = `
      .kami{height:100%;min-width:0;overflow:auto;container-type:inline-size;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:inherit;box-sizing:border-box;scrollbar-gutter:stable}
      .kami *{box-sizing:border-box}.kami button,.kami input,.kami select,.kami textarea{font:inherit;color:inherit;font-size:13px;max-width:100%}.kami button,.kami input,.kami select{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-height:32px;padding:6px 10px}.kami button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;line-height:1.4}.kami button:hover{background:var(--dsw-alias-interactive-bg-hover)}.kami button:disabled{opacity:.5;cursor:default}.kami button:focus-visible,.kami input:focus-visible,.kami textarea:focus-visible,.kami select:focus-visible,.kami summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.kami .primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}.kami .primary:hover{filter:brightness(.95)}.kami .quiet{border-color:transparent;background:transparent}.kami .small{font-size:12px;min-height:28px;padding:4px 7px}.kami .icon-button{width:30px;padding:5px;flex:none}.kami .button-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.kami .button-row>*{min-width:0}.kami .button-row input{flex:1;min-width:100px}.kami button svg{flex:none}.kami input,.kami select{min-width:0}.kami input[type=checkbox]{min-height:0;width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
      .kami .masthead{padding:18px 20px 0;position:sticky;top:0;z-index:3;background:var(--dsw-alias-bg-layer-1)}.kami .brand-row{display:flex;align-items:center;gap:10px;min-width:0}.kami .brand-name{flex:1;min-width:0}.kami h1{margin:0;font-size:16px;font-weight:650;letter-spacing:-.3px}.kami .eyebrow{color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:1.5px;margin-top:3px}.kami .connection{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:5px;white-space:nowrap}.kami .connection-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.kami .workspace-bar{display:flex;align-items:center;gap:6px;padding:14px 0 13px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}.kami .workspace-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kami .project-chip{max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-size:11px}.kami nav{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 0 7px}.kami nav>button{flex:1;border:0;background:transparent;color:var(--dsw-alias-label-secondary)}.kami nav>button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600}.kami .more-select{width:74px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px}.kami .body{padding:18px 20px 28px}.kami .stack{display:grid;gap:18px;min-width:0}.kami h2{font-size:18px;letter-spacing:-.4px;margin:0;font-weight:600;overflow-wrap:anywhere}.kami h3{font-size:14px;margin:0;font-weight:600}.kami p{font-size:13px;line-height:1.65;margin:7px 0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.kami .muted{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}.kami .section-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.kami .section-heading h3{flex:1}.kami .card{padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;min-width:0;background:var(--dsw-alias-bg-layer-2)}.kami .inset{background:var(--dsw-alias-bg-layer-1)}.kami .rule{border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}.kami .empty{display:grid;justify-items:center;text-align:center;gap:6px;padding:28px 12px}.kami .empty p{max-width:32em}.kami label{display:grid;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}.kami label>input,.kami label>select{width:100%}.kami textarea{width:100%;resize:vertical;min-height:104px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;font-size:14px;line-height:1.75}.kami textarea[readonly]{background:var(--dsw-alias-bg-layer-2)}.kami summary{cursor:pointer;line-height:1.5;font-size:13px;color:var(--dsw-alias-label-secondary)}.kami details[open]>summary{margin-bottom:14px}.kami .feedback{font-size:12px;line-height:1.6;margin:9px 0;overflow-wrap:anywhere;display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}.kami .feedback p{margin:0;font-size:12px}.kami .error{color:var(--dsw-alias-state-error-primary)}.kami .notice{padding:10px 12px;background:var(--dsw-alias-bg-layer-3);border-radius:8px;font-size:12px;line-height:1.6}.kami .notice .button-row{margin-top:10px}.kami code{font:11px/1.65 ui-monospace,Consolas,monospace;overflow-wrap:anywhere;word-break:break-word;color:var(--dsw-alias-label-secondary)}
      .kami .task-selector{width:100%;font-size:13px}.kami .task-title{margin:5px 0 12px}.kami .task-status{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;margin-bottom:10px}.kami .badge{font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-3);padding:2px 6px;border-radius:5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.kami .metrics{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);margin:10px 0 16px}.kami .metrics strong{font-size:17px;color:var(--dsw-alias-label-primary);font-weight:600;margin-right:4px}.kami progress{display:block;width:100%;height:5px;accent-color:var(--dsw-alias-brand-primary);border:0}.kami .stages{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0}.kami .stage{border-top:2px solid var(--dsw-alias-border-l2);padding-top:7px;min-width:0}.kami .stage[data-active=true]{border-color:var(--dsw-alias-brand-primary)}.kami .stage strong{font-size:11px;display:block;font-weight:500}.kami .stage span{font-size:10px;color:var(--dsw-alias-label-tertiary)}.kami .snapshot{margin-top:15px}.kami .snapshot-row{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2);display:grid;gap:2px}.kami .snapshot-row strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}.kami .snapshot-row code{font-size:10px}.kami .quick-form{display:grid;gap:14px;padding-top:3px}.kami .resource-checks{display:grid;gap:9px}.kami .resource-checks label{display:flex;align-items:flex-start;gap:8px;line-height:1.5;overflow-wrap:anywhere}.kami .resource-checks input{flex:none;margin-top:2px}.kami .resource-checks fieldset{margin:0;border:0;padding:0;min-width:0;display:grid;gap:8px}.kami .resource-checks legend{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:7px}.kami .quick-submit{display:flex;justify-content:space-between;gap:10px;align-items:center}.kami .quick-submit p{margin:0}
      .kami option{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
      .kami .review-anchor,.kami .task-side{scroll-margin-top:160px}
      .kami .review-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.kami .review-toolbar select{flex:1}.kami .issue-strip{display:flex;gap:6px;overflow:auto;padding:8px 0 4px;max-height:108px;flex-wrap:wrap}.kami .issue-strip button{font-size:11px;justify-content:flex-start;max-width:100%;text-align:left}.kami .segment{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2);scroll-margin-top:145px;outline-offset:3px}.kami .segment-heading{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}.kami .pairs{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}.kami .pairs>*{min-width:0}.kami .source-text{white-space:pre-wrap;line-height:1.75;font-size:14px;color:var(--dsw-alias-label-primary);padding:2px 0;margin:0}.kami .segment .source-label{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}.kami .issues{margin:10px 0;padding:0;list-style:none;display:grid;gap:5px}.kami .issues li{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}.kami .segment-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;flex-wrap:wrap}.kami .segment-footer details{flex:1}.kami .segment-footer summary{font-size:11px}.kami .pagination{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px}.kami .qa-report .score{font-size:24px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary)}.kami .task-record{padding:11px 0;border-top:1px solid var(--dsw-alias-border-l2);min-width:0}.kami .task-record strong{display:block;font-size:12px;font-weight:500;overflow-wrap:anywhere;margin:5px 0}.kami .task-record p{font-size:12px}.kami .type-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.kami .type-tabs button{font-size:12px}.kami .type-tabs button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);font-weight:600}.kami .resource-row{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.kami .resource-row strong{font-size:12px;overflow-wrap:anywhere;font-weight:500}.kami .resource-row .button-row{margin-top:7px}.kami .preview{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2)}.kami .preview-text{white-space:pre-wrap;font-size:13px;line-height:1.75;color:var(--dsw-alias-label-primary);max-height:420px;overflow:auto;padding:8px 0}.kami .asset-row{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.kami .asset-row p{white-space:pre-wrap;color:var(--dsw-alias-label-primary);margin:0;font-size:13px}.kami .asset-row .badge{justify-self:start}.kami .settings-fields{display:grid;gap:14px;padding:12px 0}.kami .settings-fields label:has(input[type=checkbox]){display:flex;flex-wrap:wrap;align-items:center;gap:8px}.kami .settings-fields label:has(input[type=checkbox]) p{flex-basis:100%}.kami .binding{display:grid;gap:12px;margin-bottom:18px}
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
      const create = () => model.perform("create", async (token) => {
        const resources = Object.fromEntries(resourceFields.map(({ field }) => [field, (config[field] || []).filter((item) => !excluded.includes(`${field}:${item}`))]));
        const value = await model.request({ action: "file", purpose: "translation", path: path.trim(), resources, projectId: token.view.projectId }, token);
        setPreviewId(value.batchId); await model.select(value.batchId); await model.refresh();
      });
      return h("details", { className: "card", open: !model.view.run || undefined }, h("summary", null, t("快捷建批")),
        h("form", { className: "quick-form", onSubmit: (event) => { event.preventDefault(); create(); } },
          h("p", { className: "muted" }, t("在主会话中描述任务，也可以在此指定工作区文件。")),
          h("label", null, t("待译文件路径"), h("input", { value: path, placeholder: "source/dialogue.docx", onChange: (event) => { setPath(event.target.value); setPreviewId(""); } })),
          h("details", null, h("summary", null, t("本批次资源")), h("p", { className: "muted" }, t("仅覆盖本批次选择，不修改工作区默认资源。")), h("div", { className: "resource-checks" }, ...resourceFields.map(({ field, label }) => h("fieldset", { key: field }, h("legend", null, t(label)),
            ...(config[field] || []).map((item) => { const key = `${field}:${item}`; return h("label", { key }, h("input", { type: "checkbox", checked: !excluded.includes(key), onChange: (event) => setExcluded(event.target.checked ? excluded.filter((value) => value !== key) : [...excluded, key]) }), item); }), !(config[field] || []).length && h("span", { className: "muted" }, t("尚未关联文件")))))),
          h("div", { className: "quick-submit" }, h(Button, { primary: true, disabled: !path.trim(), busy: model.view.operations.create?.pending, onClick: create }, h(Glyph, { name: "plus" }), t("解析并创建批次")), h("p", { className: "muted" }, t("创建后先预览原文，再开始翻译。"))),
          h(Feedback, { model, name: "create", retry: create, t }), previewId && h("p", { className: "muted", role: "status" }, t("资源已冻结"), " · ", previewId)));
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
      const qaState = ["in_progress", "waiting"].includes(run.workflow?.aiQa?.status) ? stateText(run.workflow.aiQa.status, t) : qaFailed ? t("QA 未完成")
        : translated.length && translated.every((segment) => qaLabel(segment) === "规则检查") ? t("规则检查")
        : translated.length && translated.every((segment) => qaLabel(segment) === "规则检查" || qaLabel(segment).startsWith("模型 QA · ")) ? t("已完成") : t("尚未执行 QA");
      const command = (verb) => model.perform(`${verb}:${id}`, async (token) => {
        await model.invoke(`/api/batch/run/${encodeURIComponent(id)}/${verb}`, "POST", scopeArgs(model, token), token);
        await model.loadRun(token, id);
      });
      return h("section", { className: "card" }, h("div", { className: "task-status" }, h("span", { className: "muted" }, t("当前任务")), h("span", { className: "badge" }, stateText(run.runState || "ready", t))),
        h("h2", { className: "task-title" }, run.filename || id), h("progress", { max: Math.max(1, selected.length), value: done, "aria-label": t("翻译进度") }),
        h("div", { className: "metrics" }, h("span", null, h("strong", null, `${done}/${selected.length}`), t("段")), h("span", null, h("strong", null, problems), t("问题")), failed > 0 && h("span", { className: "error" }, h("strong", null, failed), t("失败"))),
        h("div", { className: "stages" }, ...[["translation", "翻译"], ["aiQa", "质量检查"], ["qualityReport", "一致性"], ["termSurvey", "术语普查"]].map(([key, label]) => h("div", { className: "stage", key, "data-active": ["in_progress", "waiting"].includes(run.workflow?.[key]?.status), title: run.workflow?.[key]?.message || "" }, h("strong", null, t(label)), h("span", null, key === "aiQa" ? qaState : stateText(run.workflow?.[key]?.status, t))))),
        h("div", { className: "button-row" }, ["running", "queued"].includes(run.runState)
          ? h(Button, { onClick: () => command("pause"), busy: model.view.operations[`pause:${id}`]?.pending }, t("暂停"))
          : done === selected.length && selected.length && !locked ? h(Button, { primary: true, disabled: pending || model.view.operations[`qa:${id}`]?.pending, busy: model.view.operations[`retry-qa:${id}`]?.pending, onClick: qaFailed ? () => command("retry-qa") : review }, t(qaFailed ? "重试未完成 QA" : "复核译文"))
          : h(Button, { primary: true, onClick: () => command("start"), busy: model.view.operations[`start:${id}`]?.pending, disabled: locked || pending || model.view.operations[`qa:${id}`]?.pending || run.contextBriefPending || (run.requiresBrief && run.contextBrief?.status !== "ready") }, h(Glyph, { name: "arrow" }), t(locked ? "等待当前阶段结束" : done ? "继续翻译" : "开始翻译")),
          h(Button, { onClick: () => model.save(), disabled: !pending || locked, busy: model.view.operations.save?.pending }, t("保存修改")),
          done > 0 && h(Button, { onClick: exportFile, disabled: locked || pending, quiet: true }, t("工作区导出"))),
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
      const [filter, setFilter] = useState("all"), [page, setPage] = useState(0), [focus, setFocus] = useState("");
      const nodes = useRef(new Map()), id = run.batchId, qaKey = `qa:${id}`;
      const locked = editingLocked(run) || model.view.operations[qaKey]?.pending || model.view.operations.save?.pending;
      const list = run.segments.filter((segment) => filter === "all" || (filter === "issues" ? issuesOf(segment).length : !segment.translation?.trim()));
      const pageStart = Math.min(page, Math.max(0, Math.floor((list.length - 1) / 20) * 20));
      const issueSegments = run.segments.filter((segment) => issuesOf(segment).length);
      useEffect(() => { const node = nodes.current.get(focus); if (node) { node.scrollIntoView({ block: "nearest" }); node.focus({ preventScroll: true }); } }, [focus, pageStart]);
      const inspect = () => model.perform(qaKey, async (token) => {
        const value = await model.invoke("/api/auto-qa", "POST", scopeArgs(model, token, { batchId: id, source: run.segments.map((segment) => segment.source).join("\n"), translation: run.segments.map((segment) => segment.translation || "").join("\n") }), token);
        token.view.sections[qaKey] = value; await model.loadRun(token, id);
      });
      const savedReport = () => model.loadSection(qaKey, (token) => model.invoke(model.path(`/api/qa/batch/${encodeURIComponent(id)}`, {}, token), "GET", undefined, token));
      const approve = (segment) => model.perform(`approve:${id}:${segment.id}`, async (token) => {
        await model.invoke("/api/feedback/accept", "POST", scopeArgs(model, token, { source: segment.source, translation: segment.translation, batchId: id, trajectoryId: segment.result?.trajectoryId, contentType: run.contentType, sourceFile: run.filename, entryId: segment.id }), token);
        token.view.approvals[`${id}:${segment.id}`] = segment.translation;
        await model.loadRun(token, id); return "已人工采纳";
      });
      return h("section", null, h("div", { className: "section-heading" }, h("h3", null, t("译文复核")), h("span", { className: "muted" }, `${run.segments.length} ${t("段")}`)),
        locked && h("p", { className: "muted" }, t("执行中只读；阶段结束后可编辑译文。")),
        h("div", { className: "review-toolbar" }, h("select", { value: filter, "aria-label": t("译文复核"), onChange: (event) => { setFilter(event.target.value); setPage(0); } }, ...[["all", "全部译段"], ["issues", "仅看问题"], ["pending", "尚未翻译"]].map(([value, label]) => h("option", { key: value, value }, t(label)))),
          h(Button, { small: true, onClick: inspect, disabled: locked || model.dirty() || !run.segments.some((segment) => segment.translation?.trim()) }, t("检查本批次")), h(Button, { small: true, quiet: true, onClick: savedReport }, t("查看上次报告"))),
        issueSegments.length > 0 && h("div", { className: "issue-strip", "aria-label": t("定位问题译段") }, ...issueSegments.slice(0, 50).map((segment) => h(Button, { key: segment.id, small: true, onClick: () => { setFilter("all"); setPage(Math.floor(run.segments.indexOf(segment) / 20) * 20); setFocus(segment.id); } }, `#${run.segments.indexOf(segment) + 1} · ${issuesOf(segment).length} ${t("问题")}`))),
        h(Feedback, { model, name: qaKey, retry: inspect, t }), h(Feedback, { model, name: `section:${qaKey}`, retry: savedReport, t }),
        model.view.sections[qaKey] && h(QaReport, { report: model.view.sections[qaKey], t, label: "上次保存的质量报告" }),
        ...list.slice(pageStart, pageStart + 20).map((segment) => h("article", { className: "segment", key: segment.id, tabIndex: -1, ref: (node) => node ? nodes.current.set(segment.id, node) : nodes.current.delete(segment.id) },
          h("div", { className: "segment-heading" }, h("span", null, `#${run.segments.indexOf(segment) + 1}`, " · ", stateText(segment.status, t)), h("span", null, segment.draft ? t("待重新检查") : qaLabel(segment).startsWith("模型 QA · ") ? `${t("模型 QA")} · ${qaLabel(segment).split(" · ")[1]}` : t(qaLabel(segment)))),
          h("div", { className: "pairs" }, h("div", null, h("span", { className: "source-label" }, t("原文")), h("p", { className: "source-text" }, segment.source)), h("label", null, h("span", { className: "source-label" }, t("译文")), h("textarea", { value: segment.translation || "", readOnly: locked, "aria-label": `${t("译文")} ${run.segments.indexOf(segment) + 1}`, onChange: (event) => model.edit(segment.id, event.target.value) }))),
          h("ul", { className: "issues" }, ...issuesOf(segment).map((issue, index) => h("li", { key: index }, issue.message || issue.description || ""))),
          h("div", { className: "segment-footer" }, segment.accepted && !segment.draft ? h("span", { className: "badge" }, t("已人工采纳")) : h("details", null, h("summary", null, t("采纳为正式译法")), h("p", { className: "muted" }, t("将保存当前译文为人工批准的 TM，并写入学习证据。")), segment.draft && h("p", { className: "muted" }, t("保存译文后才能正式采纳。")), h(Button, { small: true, disabled: locked || segment.draft || !segment.translation?.trim(), busy: model.view.operations[`approve:${id}:${segment.id}`]?.pending, onClick: () => approve(segment) }, t("确认采纳")))),
          h(Feedback, { model, name: `approve:${id}:${segment.id}`, retry: () => approve(segment), t }))),
        !list.length && h(Empty, { title: "此筛选下没有译段", t }),
        list.length > 20 && h("div", { className: "pagination" }, h(Button, { small: true, disabled: pageStart === 0, onClick: () => setPage(Math.max(0, pageStart - 20)) }, t("上一页")), h("span", { className: "muted" }, `${pageStart + 1}–${Math.min(pageStart + 20, list.length)} / ${list.length}`), h(Button, { small: true, disabled: pageStart + 20 >= list.length, onClick: () => setPage(pageStart + 20) }, t("下一页"))));
    }
    function ExportPanel({ model, run, t }) {
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
        receipt && h("div", { className: "notice", role: "status" }, h("strong", null, t("导出成功")), h("p", null, h("code", null, receipt.path)), h("span", { className: "muted" }, `${sizeText(receipt.bytes)} · ${timeText(receipt.at)}`)));
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
      const reviewRef = useRef(null), exportRef = useRef(null);
      const notice = model.draftNotice();
      return h("div", { className: "stack" }, h("label", null, t("选择翻译批次"), h("select", { className: "task-selector", value: view.selectedId, onChange: (event) => model.select(event.target.value) }, h("option", { value: "", disabled: view.files.length > 0 }, t(view.files.length ? "选择翻译批次" : "暂无翻译批次")), ...view.files.map((file) => h("option", { key: file.batchId, value: file.batchId }, batchLabel(file, stateText(file.runState || file.status, t)))))),
        h(Feedback, { model, name: "task-list", retry: () => model.refresh(), t }), h(Feedback, { model, name: "task-load", retry: () => model.activate(view.selectedId), t }),
        view.newBatches.length > 0 && h("div", { className: "notice", role: "status" }, t("发现新批次"), ` · ${view.newBatches.length} `, h(Button, { small: true, quiet: true, onClick: () => model.select(view.newBatches[0]) }, t("查看新批次"))),
        notice === "switch" && h("section", { className: "notice", role: "alert" }, h("strong", null, t("有未保存的译文草稿")), h("p", null, t("切换批次前，保存或放弃当前草稿。")), h("div", { className: "button-row" }, h(Button, { primary: true, busy: view.operations.save?.pending, disabled: editingLocked(run), onClick: () => model.confirmSelection(true) }, t("保存并切换")), h(Button, { onClick: () => model.confirmSelection(false) }, t("放弃并切换")), h(Button, { quiet: true, onClick: () => model.cancelSelection() }, t("取消切换")))),
        notice === "draft" && h("div", { className: "notice", role: "status" }, t("有未保存的译文草稿"), h("p", { className: "muted" }, t("草稿保存在当前会话中，退出应用前请保存。"))),
        !run && !view.operations["task-load"]?.pending && h(Empty, { title: "从工作区开始", description: "指定原文、关联资源，然后开始第一批翻译。", artwork: true, t }),
        h(QuickBatch, { model, t }),
        run && h("div", { className: "task-grid", key: run.batchId }, h("div", { className: "task-main stack" }, h(TaskSummary, { model, run, t,
          review: () => { reviewRef.current?.scrollIntoView({ block: "start" }); reviewRef.current?.focus({ preventScroll: true }); },
          exportFile: () => { exportRef.current?.scrollIntoView({ block: "start" }); exportRef.current?.focus({ preventScroll: true }); } }), h("div", { className: "review-anchor", ref: reviewRef, tabIndex: -1 }, h(ReviewPanel, { model, run, t, key: run.batchId }))),
          h("aside", { className: "task-side stack", ref: exportRef, tabIndex: -1 }, h(ExportPanel, { model, run, t, key: run.batchId }))), h(TaskHistory, { model, t }));
    }
    function ResourcePreview({ preview, t, close }) {
      const pairs = ["terms", "tm"].includes(preview.purpose), rows = Array.isArray(preview.preview) ? preview.preview : [];
      return h("section", { className: "preview" }, h("div", { className: "section-heading" }, h("h3", null, t("工作区最新版预览")), h(Button, { quiet: true, small: true, onClick: close }, t("关闭预览"))),
        h("code", null, preview.path), h("p", { className: "muted" }, t(resourceFields.find((item) => item.purpose === preview.purpose)?.label || "资源"), " · ", sizeText(preview.size), preview.characters ? ` · ${preview.characters} ${t("字符")}` : ` · ${t("预览条数")} ${rows.length} / ${t("总条数")} ${preview.count || 0}`),
        typeof preview.preview === "string" ? h("div", { className: "preview-text" }, preview.preview) : rows.map((item, index) => pairs ? h("div", { className: "asset-row", key: index }, h("div", null, h("span", { className: "muted" }, t("原文")), h("p", null, item.source || "")), h("div", null, h("span", { className: "muted" }, t("译文")), h("p", null, item.target || item.translation || ""))) : h("div", { className: "preview-text", key: index }, item.text || item.content || item.title || "")),
        h("details", null, h("summary", null, "SHA-256"), h("code", null, preview.hash)));
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
    function ResourcesView({ model, t }) {
      const [purpose, setPurpose] = useState("style-guide"), [paths, setPaths] = useState({});
      const resource = resourceFields.find((item) => item.purpose === purpose), key = `resource:${purpose}`, config = model.workspace?.config || {}, preview = model.view.sections.preview;
      const inspect = (path = paths[purpose]) => model.loadSection("preview", (token) => model.request({ action: "file", path: path?.trim(), purpose, register: false, projectId: token.view.projectId }, token));
      const link = () => model.perform(key, async (token) => { const result = await model.request({ action: "file", path: paths[purpose]?.trim(), purpose, projectId: token.view.projectId }, token); token.view.sections.preview = result; await model.refresh(); return "已关联工作区文件"; });
      const unlink = (path) => model.perform(`unlink:${purpose}:${path}`, async (token) => {
        const latest = await model.request({ action: "workspace" }, token);
        await model.request({ action: "workspace", actionType: "configure", resources: { [resource.field]: (latest.config[resource.field] || []).filter((item) => item !== path) } }, token);
        await model.refresh(); return "已解除关联，工作区原件保留";
      });
      return h("div", { className: "stack" }, h("div", null, h("h2", null, t("下次任务使用的资源")), h("p", null, t("这些路径引用工作区原件；新建批次时读取最新版。")),
        h("div", { className: "type-tabs" }, ...resourceFields.map((item) => h("button", { key: item.purpose, type: "button", "aria-pressed": purpose === item.purpose, onClick: () => setPurpose(item.purpose) }, t(item.label), " ", (config[item.field] || []).length)))),
        h("section", { className: "card stack" }, h("label", null, t("工作区相对路径"), h("input", { value: paths[purpose] || "", placeholder: resource.placeholder, onChange: (event) => setPaths({ ...paths, [purpose]: event.target.value }) })),
          h("div", { className: "button-row" }, h(Button, { disabled: !paths[purpose]?.trim(), busy: model.view.operations["section:preview"]?.pending, onClick: () => inspect() }, t("预览最新版")), h(Button, { primary: true, disabled: !paths[purpose]?.trim(), busy: model.view.operations[key]?.pending, onClick: link }, t("关联到下次任务"))), h(Feedback, { model, name: key, retry: link, t })),
        h(Feedback, { model, name: "section:preview", retry: () => inspect(), t }), preview && h(ResourcePreview, { preview, t, close: () => { delete model.view.sections.preview; model.emit(); } }),
        h("section", null, h("h3", null, t("已关联"), " · ", t(resource.label)), ...(config[resource.field] || []).map((path) => h("div", { className: "resource-row", key: path }, h("strong", null, path), h("div", { className: "button-row" }, h(Button, { small: true, quiet: true, onClick: () => inspect(path) }, t("预览最新版")), h(Button, { small: true, quiet: true, onClick: () => unlink(path), busy: model.view.operations[`unlink:${purpose}:${path}`]?.pending }, t("解除关联"))), h(Feedback, { model, name: `unlink:${purpose}:${path}`, retry: () => unlink(path), t }))), !(config[resource.field] || []).length && h(Empty, { title: "尚未关联文件", t })), h(LegacyResources, { model, t }));
    }
    function AssetsView({ model, t }) {
      const [kind, setKind] = useState("term"), [input, setInput] = useState(""), [search, setSearch] = useState(""), [offset, setOffset] = useState(0);
      const load = (token) => model.invoke(model.path("/api/library-entries", { kind, search, offset, limit: 50 }, token), "GET", undefined, token);
      const data = useSection(model, "assets", load, [kind, search, offset]) || {};
      return h("div", { className: "stack" }, h("div", null, h("h2", null, t("正式资产库")), h("p", null, t("工作区文件资源请在“资源”中关联，不会自动写入正式库。"))),
        h("form", { className: "button-row", onSubmit: (event) => { event.preventDefault(); setSearch(input); setOffset(0); if (search === input) model.loadSection("assets", load); } }, h("select", { value: kind, "aria-label": t("资产"), onChange: (event) => { setKind(event.target.value); setOffset(0); } }, h("option", { value: "term" }, t("术语")), h("option", { value: "tm" }, t("翻译记忆"))), h("input", { value: input, placeholder: t("搜索资产"), "aria-label": t("搜索资产"), onChange: (event) => setInput(event.target.value) }), h(Button, { onClick: () => { setSearch(input); setOffset(0); if (search === input) model.loadSection("assets", load); } }, t("搜索"))),
        h(Feedback, { model, name: "section:assets", retry: () => model.loadSection("assets", load), t }),
        h("div", null, ...(data.items || []).map((item, index) => h("article", { className: "asset-row", key: item.id || index }, h("div", null, h("span", { className: "muted" }, t("原文")), h("p", null, item.source || item.name || "")), h("div", null, h("span", { className: "muted" }, t("译文")), h("p", null, item.target || item.translation || "")), h("span", { className: "badge" }, item.qualityStatus || item.status || ""))), !data.items?.length && h(Empty, { title: "暂无正式资产", t })),
        h("div", { className: "pagination" }, h(Button, { small: true, disabled: !offset, onClick: () => setOffset(Math.max(0, offset - 50)) }, t("上一页")), h("span", { className: "muted" }, `${Math.min(offset + 1, data.total || 0)}–${offset + (data.items?.length || 0)} / ${data.total || 0}`), h(Button, { small: true, disabled: offset + 50 >= (data.total || 0), onClick: () => setOffset(offset + 50) }, t("下一页"))));
    }
    function StandaloneQa({ model, t }) {
      const [source, setSource] = useState(""), [target, setTarget] = useState("");
      const inspect = () => model.perform("standalone-qa", async (token) => { token.view.sections.standaloneQa = await model.invoke("/api/auto-qa", "POST", scopeArgs(model, token, { source, translation: target }), token); });
      return h("div", { className: "stack" }, h("div", null, h("h2", null, t("独立审校")), h("p", { className: "muted" }, t("当前工作区最新资源"))),
        h("div", { className: "pairs" }, h("label", null, t("原文"), h("textarea", { value: source, onChange: (event) => setSource(event.target.value) })), h("label", null, t("译文"), h("textarea", { value: target, onChange: (event) => setTarget(event.target.value) }))),
        h("div", null, h(Button, { primary: true, disabled: !source.trim() || !target.trim(), busy: model.view.operations["standalone-qa"]?.pending, onClick: inspect }, t("运行 QA")), h(Feedback, { model, name: "standalone-qa", retry: inspect, t })), h(QaReport, { report: model.view.sections.standaloneQa, t }));
    }
    function LearningView({ model, t }) {
      const [selected, setSelected] = useState("general/game");
      const load = async (token) => { const [learning, styles] = await Promise.all([model.invoke(model.path("/api/learning", { contentType: "all", domain: "all" }, token), "GET", undefined, token), model.invoke(model.path("/api/style-profiles", {}, token), "GET", undefined, token)]); return { ...learning, styleProfiles: styles.styleProfiles || [] }; };
      const data = useSection(model, "learning", load) || {};
      const operation = (key, path, body) => model.perform(key, async (token) => { await model.invoke(path, "POST", scopeArgs(model, token, Object.fromEntries(Object.entries(body || {}).filter(([, value]) => value !== undefined))), token); await model.loadSection("learning", load); return key.startsWith("activate") ? "已激活" : "已提交评测"; });
      return h("div", { className: "stack" }, h("div", null, h("h2", null, t("学习与评测")), h("p", null, t("人工激活后才用于后续任务。"))),
        h("div", { className: "button-row" }, h("select", { value: selected, "aria-label": t("学习范围"), onChange: (event) => setSelected(event.target.value) }, ...[...new Set(["general/game", ...(data.scopeCounts || []).map((scope) => `${scope.contentType}/${scope.domain}`)])].map((value) => h("option", { key: value, value }, value))), h(Button, { onClick: () => { const [contentType, domain] = selected.split("/"); return operation("generate", "/api/learning/skills/generate", { contentType, domain }); }, busy: model.view.operations.generate?.pending }, t("生成候选策略"))),
        h(Feedback, { model, name: "generate", t }), h(Feedback, { model, name: "section:learning", retry: () => model.loadSection("learning", load), t }),
        ...[["策略版本", data.skills || [], "/api/learning/skills"], ["风格规范", data.styleProfiles || [], "/api/style-profiles"]].map(([label, items, prefix]) => h("section", { key: label }, h("h3", null, t(label)), ...items.map((item) => {
          const key = `${prefix}:${item.id}`;
          return h("article", { className: "resource-row", key }, h("strong", null, item.name || `v${item.version}`), h("p", { className: "muted" }, `${item.contentType || ""} / ${item.domain || ""} · ${item.status || ""}`), h("p", null, item.description || item.instruction || item.strategy?.instruction || ""),
            h("div", { className: "button-row" }, h(Button, { small: true, onClick: () => operation(`evaluate:${key}`, `${prefix}/${item.id}/evaluate`, { contentType: item.contentType, domain: item.domain }), busy: model.view.operations[`evaluate:${key}`]?.pending }, t("评测")),
              h("details", null, h("summary", null, t("激活")), h("p", { className: "muted" }, t("人工激活后才用于后续任务。")), h(Button, { small: true, onClick: () => operation(`activate:${key}`, `${prefix}/${item.id}/activate`, { contentType: item.contentType, domain: item.domain }), busy: model.view.operations[`activate:${key}`]?.pending }, t("激活")))), h(Feedback, { model, name: `evaluate:${key}`, t }), h(Feedback, { model, name: `activate:${key}`, t }));
        }), !items.length && h(Empty, { title: "暂无条目", t }))));
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
      const content = tab === "任务" ? h(TaskView, { model, t }) : tab === "资源" ? h(ResourcesView, { model, t }) : tab === "资产" ? h(AssetsView, { model, t }) : tab === "学习" ? h(LearningView, { model, t }) : tab === "审校" ? h(StandaloneQa, { model, t }) : h(SettingsView, { model, t });
      return h(React.Fragment, null, h("div", { className: "masthead" }, h("header", { className: "brand-row" }, h(BrandMark, { size: 36 }), h("div", { className: "brand-name" }, h("h1", null, t("Kami 翻译工作台")), h("div", { className: "eyebrow" }, "KAMI · JA / ZH-CN")), h("div", { className: `connection ${model.connected ? "" : "error"}`, role: "status" }, h("span", { className: "connection-dot", "aria-hidden": true }), h("span", { className: "connection-label" }, t(model.connected ? "已连接" : model.connection.pending ? "连接中" : "连接失败")))),
        h("div", { className: "workspace-bar" }, h(Glyph, { name: "folder", size: 14 }), h("span", { className: "workspace-path", title: model.workspace?.workspace }, model.workspace?.workspace || t("当前工作区")), h("button", { type: "button", className: "project-chip quiet", title: t("更换项目"), onClick: () => setBinding(!binding) }, model.workspace?.project?.name || t("尚未绑定项目")), h("button", { type: "button", className: "icon-button quiet", title: t("刷新"), "aria-label": t("刷新"), onClick: () => model.refresh() }, h(Glyph, { name: "refresh", size: 14 }))),
        h("nav", { "aria-label": "Kami" }, ...[["任务", "tasks"], ["资源", "resources"], ["资产", "assets"]].map(([label, icon]) => h("button", { type: "button", key: label, "aria-pressed": tab === label, onClick: () => setTab(label) }, h(Glyph, { name: icon, size: 14 }), t(label))),
          h("select", { className: "more-select", "aria-label": t("更多"), value: ["学习", "审校", "设置"].includes(tab) ? tab : "", onChange: (event) => { if (event.target.value) setTab(event.target.value); } }, h("option", { value: "", disabled: true }, t("更多")), ...[["学习", "学习与评测"], ["审校", "独立审校"], ["设置", "设置"]].map(([value, label]) => h("option", { value, key: value }, t(label)))))),
        h("div", { className: "body" }, model.connection.error && h("div", { className: "feedback error", role: "alert" }, model.connection.error, h(Button, { small: true, onClick: () => model.refresh() }, t("重试"))),
          showBinding && model.workspace && h(BindingForm, { model, t, close: () => setBinding(false) }), bound && content));
    }
    function Workbench(props) {
      const [, render] = useState(0), modelRef = useRef(null), scrollRef = useRef(null);
      if (!modelRef.current) modelRef.current = new WorkbenchModel({ sessionId: props.sessionId, call: props.call, visible: props.visible !== false });
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

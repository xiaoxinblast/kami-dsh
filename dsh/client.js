window.__ModuleLoader__.load({
  id: "kami-dsh",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect } = React;
    const words = {
      "Kami 翻译工作台": "Kami Workbench", "日语 → 简体中文 · 本地资产与任务": "Japanese → Simplified Chinese · Local assets and jobs",
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
    const css = `
      .kami{height:100%;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:inherit;padding:calc(var(--dsh-frame-top-clearance,24px) + 12px) 28px 32px;box-sizing:border-box}
      .kami *{box-sizing:border-box}.kami header{display:flex;gap:14px;align-items:center;margin-bottom:26px}.kami h1{font-size:23px;letter-spacing:-.6px;margin:0 0 5px;font-weight:600}.kami p{margin:6px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
      .kami-logo{width:46px;height:46px;border-radius:14px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);display:grid;place-items:center;font-size:29px;font-weight:600;font-family:Georgia,serif}.kami-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0}.kami nav{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);margin:18px 0 22px;padding-bottom:8px;flex-wrap:wrap}
      .kami button,.kami select,.kami input{font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 11px;color:inherit;background:var(--dsw-alias-bg-layer-2)}.kami button{cursor:pointer}.kami button:hover{background:var(--dsw-alias-interactive-bg-hover)}.kami button:disabled{opacity:.5;cursor:wait}.kami button[aria-selected=true],.kami .primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}.kami nav button{border:0;background:transparent}
      .kami textarea{font:inherit;font-size:14px;line-height:1.7;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;resize:vertical;width:100%;min-height:110px}.kami textarea:focus,.kami input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.kami .split{display:grid;grid-template-columns:220px minmax(0,1fr);gap:20px}.kami .pairs{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kami .card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-2)}.kami .card h3{margin:0 0 9px;font-size:15px}.kami .file{display:block;width:100%;text-align:left;margin-bottom:8px;overflow-wrap:anywhere}.kami .caption{color:var(--dsw-alias-label-tertiary);font-size:12px}.kami .segment{border-top:1px solid var(--dsw-alias-border-l2);padding:17px 0}.kami .segment p{white-space:pre-wrap;color:inherit;font-size:14px}.kami .notice{padding:11px 14px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);margin:12px 0;font-size:13px;overflow-wrap:anywhere}.kami .error{color:var(--dsw-alias-state-error-primary)}
      .kami table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}.kami td,.kami th{padding:12px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);text-align:left;overflow-wrap:anywhere;vertical-align:top}.kami th{color:var(--dsw-alias-label-secondary);font-weight:500}.kami .empty{padding:30px 12px;color:var(--dsw-alias-label-tertiary);text-align:center}.kami .score{font-size:42px;letter-spacing:-2px;font-weight:600}.kami label{font-size:13px;display:block;margin:8px 0}.kami .list{display:grid;gap:10px}.kami input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary)}.kami progress{width:100%;accent-color:var(--dsw-alias-brand-primary)}.kami details{margin:10px 0}.kami pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}.kami summary{cursor:pointer;font-size:13px}
      @media(max-width:1000px){.kami{padding-left:16px;padding-right:16px}.kami .split{grid-template-columns:1fr}.kami .pairs{grid-template-columns:1fr}.kami .file{display:inline-block;width:auto;margin-right:6px}}
    `;
    function Workbench(props) {
      const t = props.t || ((key) => key);
      const byId = props.useSessions ? props.useSessions((state) => state.byId) : {};
      const sessions = Object.values(byId || {});
      const active = sessions.find((session) => session.retainedBy?.mainView > 0)?.id || sessions[0]?.id || "";
      const [session, setSession] = useState("");
      const [sessionDirectory, setSessionDirectory] = useState("");
      const [agentInstruction, setAgentInstruction] = useState("");
      const sessionId = session || active;
      const [project, setProject] = useState("");
      const [projects, setProjects] = useState([]);
      const [projectName, setProjectName] = useState("");
      const [tab, setTab] = useState("翻译");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [text, setText] = useState("");
      const [files, setFiles] = useState([]);
      const [run, setRun] = useState(null);
      const [kind, setKind] = useState("term");
      const [query, setQuery] = useState("");
      const [offset, setOffset] = useState(0);
      const [data, setData] = useState({});
      const [preview, setPreview] = useState(null);
      const [guideUpload, setGuideUpload] = useState(null);
      const [previewOffset, setPreviewOffset] = useState(0);
      const [styleEvidence, setStyleEvidence] = useState(false);
      const [aiCleaning, setAiCleaning] = useState(false);
      const [learningScope, setLearningScope] = useState("general/game");
      const [qaSource, setQaSource] = useState("");
      const [qaTarget, setQaTarget] = useState("");
      const [report, setReport] = useState(null);
      const [settings, setSettings] = useState(null);
      const [segmentPage, setSegmentPage] = useState(0);
      const payload = (extra = {}) => ({ projectId: project, project, locale: "zh-CN", ...extra });
      const invoke = (path, method = "GET", body) => props.call(sessionId, { path, method, ...(body ? { body } : {}) });
      const action = async (callback) => { setBusy(true); setError(""); setNotice(""); try { return await callback(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
      const button = (label, onClick, primary = false) => h("button", { type: "button", disabled: busy, onClick: () => action(onClick), className: primary ? "primary" : "" }, t(label));
      const loadProjects = async () => { const value = await invoke("/api/projects"); setProjects(value.projects || []); if (!project && value.projects?.[0]) setProject(value.projects[0].id); };
      const scoped = (path, extras = {}) => `${path}?${new URLSearchParams({ projectId: project, project, locale: "zh-CN", ...extras })}`;
      const loadRun = async (id) => { const value = await invoke(scoped(`/api/batch/run/${encodeURIComponent(id)}`)); setRun(value.run || value); };
      const refresh = async () => {
        if (!project) return;
        if (tab === "翻译") { const value = await invoke(scoped("/api/batch/files")); setFiles(value.files || value.items || []); if (run?.batchId) await loadRun(run.batchId); }
        else if (tab === "资产") setData(await invoke(scoped("/api/library-entries", { kind, search: query, offset, limit: 50 })));
        else if (tab === "参考资料") setData(await invoke(scoped("/api/references", { search: query, offset, limit: 50 })));
        else if (tab === "风格指南") setData(await invoke(scoped("/api/style-profiles")));
        else if (tab === "学习") { const [learning, styles] = await Promise.all([invoke(scoped("/api/learning", { contentType: "all", domain: "all" })), invoke(scoped("/api/style-profiles"))]); setData({ ...learning, styleProfiles: styles.styleProfiles || [] }); }
      else if (tab === "任务") setData({ tasks: await invoke(scoped("/api/tasks", { limit: 50 })) });
        else if (tab === "设置") { const value = await invoke("/api/settings"); setSettings(value.settings || value); setData(value); }
      };
      useEffect(() => { if (sessionId) action(loadProjects); }, [sessionId]);
      useEffect(() => { setData({}); if (sessionId && project) action(refresh); }, [sessionId, project, tab, kind, offset]);
      useEffect(() => { setGuideUpload(null); }, [sessionId, project]);
      useEffect(() => {
        if (!sessionId || !project || !["running", "queued"].includes(run?.runState)) return;
        const timer = setInterval(() => { loadRun(run.batchId).catch((failure) => setError(failure.message)); }, 5000);
        return () => clearInterval(timer);
      }, [sessionId, project, run?.batchId, run?.runState]);
      const readUpload = async (event, target) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (target === "guide") setGuideUpload(null);
        await action(async () => {
          if (target === "guide" && !/\.(txt|md|docx)$/i.test(file.name)) throw new Error("风格指南仅支持 .txt、.md、.docx");
          if (target === "guide" && file.size > 5 * 1024 * 1024) throw new Error("风格指南不能超过 5 MB");
          if (file.size > 20 * 1024 * 1024) throw new Error("文件超过 20 MB");
          const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); });
          if (target === "assets") { const value = await invoke("/api/assets-import/preview", "POST", payload({ files: [{ filename: file.name, base64 }], filename: file.name, base64, purpose: kind === "tm" ? "tm" : "term" })); setPreview(value); setPreviewOffset(0); }
          else if (target === "reference") { await props.call(sessionId, { path: scoped("/api/references/file", { filename: file.name }), method: "POST", base64, headers: { "x-filename": encodeURIComponent(file.name), "x-project-id": project } }); await refresh(); }
          else if (target === "guide") setGuideUpload({ projectId: project, sessionId, filename: file.name, base64 });
          else { const value = await invoke("/api/batch/prepare", "POST", payload({ filename: file.name, base64 })); setRun(value); setSegmentPage(0); await refresh(); await loadRun(value.batchId); }
        });
        event.target.value = "";
      };
      const upload = (label, target, accept) => h("label", { className: "caption" }, t(label), h("input", { type: "file", accept, disabled: busy || !project, onChange: (event) => readUpload(event, target), style: { display: "block", marginTop: 8, maxWidth: "100%" } }));
      const download = async () => {
        const value = await invoke("/api/batch/export", "POST", payload({ ...run, mode: "writeback", locale: "zh-CN" }));
        const bytes = Uint8Array.from(atob(value.base64), (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
        const link = document.createElement("a"); link.href = url; link.download = value.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const empty = (label = "暂无条目") => h("div", { className: "empty" }, t(label));
      const guides = (data.userProfiles || []).filter((profile) => profile.projectId === project && String(profile.name || "").startsWith("风格指南 · "));
      const table = (items) => items?.length ? h("table", null, h("thead", null, h("tr", null, ...["原文", "译文", "状态"].map((label) => h("th", { key: label }, t(label))))), h("tbody", null, ...items.map((item, index) => h("tr", { key: item.id || index }, h("td", null, item.source || item.name || item.filename || item.title), h("td", null, item.target || item.translation || item.description || item.instruction || ""), h("td", null, item.status || item.qualityStatus || item.runState || ""))))) : empty();
      let content;
      if (!sessionId) content = h("section", { className: "card" }, h("h3", null, t("先建立翻译会话")), h("p", null, t("填写工作目录并新建翻译会话，或选择已有会话。")));
      else if (!project) content = empty("请选择项目后继续");
      else if (tab === "翻译") content = h("div", { className: "split" },
        h("aside", null, h("h3", null, t("文件队列")), ...files.map((file) => h("button", { key: file.batchId || file.id, className: "file", onClick: () => action(() => { setSegmentPage(0); return loadRun(file.batchId || file.id); }) }, file.filename || file.title, h("p", { className: "caption" }, file.runState || file.status))), !files.length && empty("暂无文件"), upload("导入待译文件", "batch", ".txt,.md,.csv,.docx,.xlsx,.xliff,.mqxliff")),
        h("div", null, !run ? h("section", { className: "card" }, h("h3", null, t("粘贴日语原文")), h("textarea", { value: text, onChange: (event) => setText(event.target.value), "aria-label": t("原文") }), h("div", { className: "kami-tools" }, button("创建批次", async () => { const value = await invoke("/api/batch/prepare", "POST", payload({ text, filename: "翻译.txt" })); setRun(value); await loadRun(value.batchId); }, true))) : h(React.Fragment, null,
          h("h3", null, run.filename), h("p", null, `${run.segments?.length || 0} ${t("段")} · ${run.runState || "ready"}`),
          h("div", { className: "kami-tools" }, button("开始 / 续跑", async () => { await invoke(`/api/batch/run/${run.batchId}/start`, "POST", payload()); await loadRun(run.batchId); }, true), button("暂停", () => invoke(`/api/batch/run/${run.batchId}/pause`, "POST", payload())), button("保存修改", async () => { await invoke("/api/batch/run", "POST", payload(run)); setNotice(t("已保存")); }), button("导出文件", download), button("关闭", async () => setRun(null))),
          ...(run.segments || []).slice(segmentPage, segmentPage + 30).map((segment, index) => h("section", { className: "segment", key: segment.id }, h("div", { className: "pairs" }, h("div", null, h("div", { className: "caption" }, `${segmentPage + index + 1} · ${t("原文")}`), h("p", null, segment.source)), h("div", null, h("div", { className: "caption" }, `${t("译文")} · ${segment.status || "pending"}`), h("textarea", { value: segment.translation || "", "aria-label": `${t("译文")} ${index + 1}`, onChange: (event) => setRun({ ...run, segments: run.segments.map((item) => item.id === segment.id ? { ...item, translation: event.target.value } : item) }) }), h("div", { className: "kami-tools" }, button("采纳为正式译法", async () => { await invoke("/api/feedback/accept", "POST", payload({ source: segment.source, translation: segment.translation, batchId: run.batchId, trajectoryId: segment.result?.trajectoryId, contentType: run.contentType, sourceFile: run.filename, entryId: segment.id })); setNotice(t("已保存")); })), h("p", { className: "caption" }, t("将保存当前译文为人工批准的 TM，并写入学习证据。")), segment.error && h("p", { className: "error" }, segment.error))), ...(segment.result?.qa?.issues || segment.result?.issues || []).map((issue, i) => h("p", { key: i, className: "caption" }, issue.message || issue.description)))),
          h("div", { className: "kami-tools" }, button("上一页", async () => setSegmentPage(Math.max(0, segmentPage - 30))), h("span", { className: "caption" }, `${segmentPage + 1}–${Math.min(segmentPage + 30, run.segments?.length || 0)}`), button("下一页", async () => setSegmentPage(Math.min(Math.max(0, (run.segments?.length || 1) - 1), segmentPage + 30)))))));
      else if (tab === "资产") content = h(React.Fragment, null,
        h("div", { className: "kami-tools" }, h("select", { value: kind, onChange: (event) => { setKind(event.target.value); setOffset(0); setPreview(null); } }, h("option", { value: "term" }, t("术语")), h("option", { value: "tm" }, t("翻译记忆"))), h("input", { placeholder: t("搜索"), value: query, onChange: (event) => setQuery(event.target.value) }), button("搜索", refresh)),
        upload("导入双语资产", "assets", ".xlsx,.csv,.mqxliff,.xliff"), preview && h("section", { className: "card" },
          h("h3", null, `${preview.candidates?.length || 0} ${t("条候选")}`),
          ...(preview.files || []).flatMap((file) => (file.anomalies || []).map((message, i) => h("p", { key: file.filename + i, className: "error" }, file.filename, "：", message))),
          h("label", null, h("input", { type: "checkbox", checked: styleEvidence, onChange: (event) => setStyleEvidence(event.target.checked) }), " 同时作为风格学习证据"),
          kind === "term" && h("label", null, h("input", { type: "checkbox", checked: aiCleaning, onChange: (event) => setAiCleaning(event.target.checked) }), " 使用模型清洗术语候选"),
          h("table", null, h("thead", null, h("tr", null, h("th", null, "选择 / 原文"), h("th", null, t("译文")), h("th", null, t("状态")))),
            h("tbody", null, ...(preview.candidates || []).slice(previewOffset, previewOffset + 50).map((item, index) => {
              const position = previewOffset + index;
              const edit = (change) => setPreview({ ...preview, candidates: preview.candidates.map((candidate, i) => i === position ? { ...candidate, ...change } : candidate) });
              return h("tr", { key: position }, h("td", null, h("label", null, h("input", { type: "checkbox", checked: item.selected !== false, onChange: (event) => edit({ selected: event.target.checked }) }), " ", item.source)), h("td", null, h("input", { value: item.target || "", "aria-label": `候选译文 ${position + 1}`, style: { width: "100%" }, onChange: (event) => edit({ target: event.target.value }) })), h("td", null, item.conflict ? "译法冲突" : item.existing ? "已存在" : item.decision));
            }))),
          h("div", { className: "kami-tools" }, button("上一页", async () => setPreviewOffset(Math.max(0, previewOffset - 50))), h("span", { className: "caption" }, `${previewOffset + 1}–${Math.min(previewOffset + 50, preview.candidates.length)}`), button("下一页", async () => { if (previewOffset + 50 < preview.candidates.length) setPreviewOffset(previewOffset + 50); }), button("确认入库", async () => { await invoke("/api/assets-import/commit", "POST", payload({ ...preview, styleEvidence, aiCleaning, purpose: kind === "tm" ? "tm" : "term" })); setPreview(null); setNotice(t("已提交")); }, true))),
        table(data.items || data.entries), h("div", { className: "kami-tools" }, h("span", { className: "caption" }, `${t("已显示")} ${(data.items || data.entries || []).length} / ${t("共")} ${data.total || 0}`), button("上一页", async () => setOffset(Math.max(0, offset - 50))), button("下一页", async () => { if (offset + 50 < data.total) setOffset(offset + 50); })));
      else if (tab === "审校") content = h(React.Fragment, null, h("div", { className: "pairs" }, h("label", null, t("原文"), h("textarea", { value: qaSource, onChange: (event) => setQaSource(event.target.value) })), h("label", null, t("译文"), h("textarea", { value: qaTarget, onChange: (event) => setQaTarget(event.target.value) }))), h("div", { className: "kami-tools" }, button("运行 QA", async () => setReport(await invoke("/api/auto-qa", "POST", payload({ source: qaSource, translation: qaTarget }))), true)), report && h("section", { className: "card" },
        h("h3", null, t("质量报告")), h("div", { className: "score" }, report.fallbackReason ? "—" : report.scores?.overall ?? "—"),
        report.fallbackReason && h("p", { className: "error" }, report.fallbackReason),
        h("p", null, Object.entries(report.summary || {}).map(([key, value]) => `${({ basic: "基础", fidelity: "忠实度", nuance: "表达" })[key] || key}：${value.total} 项`).join(" · ")),
        ...[...(report.segments || []).flatMap((segment) => segment.issues || []), ...(report.alignmentIssues || [])].map((issue, i) => h("p", { key: i }, `[${issue.severity}] `, issue.message || issue.description))));
      else if (tab === "参考资料") content = h(React.Fragment, null, upload("上传参考资料", "reference", ".txt,.md,.docx,.pdf,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.gif"), table(data.items), h("div", { className: "kami-tools" }, h("span", { className: "caption" }, `${t("已显示")} ${data.items?.length || 0} / ${t("共")} ${data.total || 0}`), button("上一页", async () => setOffset(Math.max(0, offset - 50))), button("下一页", async () => { if (offset + 50 < data.total) setOffset(offset + 50); })));
      else if (tab === "风格指南") content = h(React.Fragment, null, h("section", { className: "card" },
        h("h3", null, t("人工风格指南")), h("p", null, t("支持 .txt、.md、.docx；最大 5 MB，正文最多 50,000 字。")), h("p", null, t("仅用于当前项目；启用新指南后，旧版保留在历史记录中。")),
        upload("选择风格指南", "guide", ".txt,.md,.docx"), guideUpload && h("p", null, guideUpload.filename),
        h("button", { type: "button", className: "primary", disabled: busy || !guideUpload, onClick: () => action(async () => {
          if (!guideUpload || guideUpload.projectId !== project || guideUpload.sessionId !== sessionId) throw new Error("项目或会话已切换，请重新选择风格指南");
          const value = await invoke("/api/style-guides/import", "POST", payload({ filename: guideUpload.filename, base64: guideUpload.base64 }));
          setGuideUpload(null); await refresh(); setNotice(`${t("已启用")}：${value.filename} · ${value.characters} 字`);
        }) }, t("导入并立即启用"))),
        ...guides.map((profile) => h("section", { className: "card", key: profile.id }, h("h3", null, profile.name), h("p", { className: "caption" }, `v${profile.version || 1} · ${t(profile.status === "active" ? "当前生效" : "历史版本")}`), h("details", null, h("summary", null, t("指南全文")), h("pre", null, String(profile.instruction || ""))))), !guides.length && empty("尚未上传风格指南"));
      else if (tab === "学习") content = h(React.Fragment, null, h("div", { className: "kami-tools" },
        h("select", { value: learningScope, "aria-label": "学习范围", onChange: (event) => setLearningScope(event.target.value) }, ...[...new Set(["general/game", ...(data.scopeCounts || []).map((scope) => `${scope.contentType}/${scope.domain}`)])].map((scope) => h("option", { key: scope, value: scope }, scope))),
        button("生成候选策略", async () => { const [contentType, domain] = learningScope.split("/"); await invoke("/api/learning/skills/generate", "POST", payload({ contentType, domain })); await refresh(); }, true)), h("h3", null, t("策略版本")), ...(data.skills || []).map((skill) => h("section", { className: "card", key: skill.id }, h("h3", null, `${skill.name || "v" + skill.version} · ${skill.status}`), h("p", { className: "caption" }, `${skill.contentType} / ${skill.domain}`), h("p", null, skill.description || skill.strategy?.instruction || ""), h("div", { className: "kami-tools" }, button("评测", async () => { await invoke(`/api/learning/skills/${skill.id}/evaluate`, "POST", payload({ contentType: skill.contentType, domain: skill.domain })); setNotice(t("已提交")); }), button("激活", async () => { await invoke(`/api/learning/skills/${skill.id}/activate`, "POST", payload({ contentType: skill.contentType, domain: skill.domain })); await refresh(); })))), !data.skills?.length && empty(),
        h("h3", null, t("风格规范")), ...(data.styleProfiles || []).map((profile) => h("section", { className: "card", key: profile.id },
          h("h3", null, `${profile.name || "v" + profile.version} · ${profile.status}`),
          h("p", null, String(profile.instruction || "").slice(0, 1600)),
          h("div", { className: "kami-tools" }, button("评测", async () => { await invoke(`/api/style-profiles/${profile.id}/evaluate`, "POST", payload()); setNotice(t("已提交")); }), button("激活", async () => { await invoke(`/api/style-profiles/${profile.id}/activate`, "POST", payload()); await refresh(); })))));
      else if (tab === "任务") content = h("div", { className: "list" }, ...(data.tasks || data.items || []).map((task, index) => h("section", { className: "card", key: task.id || index }, h("h3", null, task.title || task.filename || task.type), h("p", null, task.status), task.progress && h("progress", { max: 100, value: task.progress.percent || 0 }), h("p", null, task.progress?.message || task.error || ""))), !(data.tasks || data.items)?.length && empty());
      else if (tab === "设置") content = h(React.Fragment, null,
        button("备份本地数据库", async () => { const result = await props.call(sessionId, { action: "backup" }); setNotice(result.path); }),
        settings && h("section", { className: "card" }, ...(data.groups || []).map((group) => h("details", { key: group.group },
          h("summary", null, ({ quality: "质量检查", reference: "参考资料", learning: "学习与评测", retrieval: "检索", orthography: "标点", performance: "性能" })[group.group] || group.fields[0]?.label || group.group),
          ...group.fields.map((field) => {
            const keys = field.path.split(".");
            const value = keys.reduce((object, key) => object?.[key], settings);
            const change = (next) => { const updated = structuredClone(settings); let object = updated; for (const key of keys.slice(0, -1)) object = object[key] ??= {}; object[keys.at(-1)] = next; setSettings(updated); };
            return h("label", { key: field.path }, field.label, " ",
              h("input", { type: typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : "text", min: field.min, max: field.max, step: field.step, value: typeof value === "boolean" ? undefined : value ?? "", checked: typeof value === "boolean" ? value : undefined, onChange: (event) => change(typeof value === "boolean" ? event.target.checked : typeof value === "number" ? Number(event.target.value) : event.target.value) }),
              h("p", { className: "caption" }, field.hint));
          }))),
        button("保存设置", async () => { const result = await invoke("/api/settings", "POST", settings); setSettings(result.settings); setNotice(result.notes?.map((item) => `${item.label}：${item.note}`).join("；") || t("已保存")); })));
      return h("main", { className: "kami" }, h("style", null, css), h("header", null, h("div", { className: "kami-logo", "aria-hidden": true }, "K"), h("div", null, h("h1", null, t("Kami 翻译工作台")), h("p", null, t("日语 → 简体中文 · 本地资产与任务")))),
        h("div", { className: "kami-tools" }, h("select", { value: project, "aria-label": t("请选择项目"), onChange: (event) => { setProject(event.target.value); setRun(null); setOffset(0); } }, h("option", { value: "" }, t("请选择项目")), ...projects.map((item) => h("option", { key: item.id, value: item.id }, item.name))), h("input", { value: projectName, placeholder: t("新项目名称"), onChange: (event) => setProjectName(event.target.value) }), button("新建项目", async () => { const value = await invoke("/api/projects", "POST", { name: projectName }); await loadProjects(); setProject(value.project.id); setProjectName(""); }), button("刷新", refresh)),
        sessions.length > 0 && h("label", { className: "caption" }, t("关联会话"), " ", h("select", { value: sessionId, onChange: (event) => setSession(event.target.value) }, ...sessions.map((item) => h("option", { key: item.id, value: item.id }, item.title || item.id.replace(/^session-/, "").slice(0, 8))))),
        h("details", null, h("summary", null, "翻译 agent 会话"),
          h("div", { className: "kami-tools" }, h("input", { placeholder: "工作目录（绝对路径）", "aria-label": "翻译工作目录", value: sessionDirectory, onChange: (event) => setSessionDirectory(event.target.value), style: { minWidth: 280 } }), button("新建翻译会话", async () => { if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(sessionDirectory.trim())) throw new Error("请输入工作目录的绝对路径"); const value = await props.createSession(sessionDirectory.trim()); setSession(value.sessionId); setNotice("已创建 Kami 翻译预设会话"); })),
          h("textarea", { "aria-label": "委托翻译 agent 的任务", placeholder: "描述要让 agent 完成的翻译、检索或 QA 任务", value: agentInstruction, onChange: (event) => setAgentInstruction(event.target.value) }),
          button("发送给翻译 agent", async () => { if (!agentInstruction.trim()) throw new Error("请输入任务内容"); await props.prompt(sessionId, agentInstruction.trim()); setAgentInstruction(""); setNotice("任务已发送，可在关联会话中查看 agent 的工具调用和回复"); })),
        h("nav", { "aria-label": "Kami" }, ...["翻译", "资产", "审校", "风格指南", "参考资料", "学习", "任务", "设置"].map((label) => h("button", { key: label, "aria-selected": tab === label, onClick: () => { setTab(label); setOffset(0); } }, t(label)))),
        busy && h("p", { role: "status" }, t("准备中…")), error && h("div", { className: "notice error", role: "alert" }, error), notice && h("div", { className: "notice", role: "status" }, notice), content);
    }
    return {
      inject: ["slots", "locale", "remote", "remote.session", "layout"],
      async apply(ctx) {
        ctx.effect(() => ctx.locale.register("kami-dsh", { zh, en: words }));
        const json = { mode: "src-json" };
        const unmountRemote = await ctx.remote.$mount({ package: "kami-dsh", descriptors: [{
          id: "kami-dsh#kamiUi/invoke", service: "kamiUi", namespace: "kamiUi", method: "invoke", invocation: { kind: "direct" },
          parameters: [{ name: "agent", wire: "agentId", source: "lookup", lookup: "agent", codec: json }, { name: "operation", wire: "operation", source: "json", codec: json }],
          cancellation: { parameter: "signal" }, result: json
        }] });
        ctx.effect(() => unmountRemote);
        const call = async (session, operation) => {
          if (!session) throw new Error("请先打开一个 DSH 翻译会话");
          const result = await ctx.remote.kamiUi.invoke(session, operation);
          if (!result.ok) throw new Error(result.error.message);
          return result.value;
        };
        const createSession = async (cwd) => { const result = await ctx.remote.session.create({ cwd, agentPreset: "kami-translator" }); if (!result.ok) throw new Error(result.error.message); return result.value; };
        const prompt = async (sessionId, text) => { const result = await ctx.remote.session.prompt({ requestId: crypto.randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] }); if (!result.ok) throw new Error(result.error.message); return result.value; };
        ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "kami-workbench", locale: "kami-dsh", inject: () => ({ call, createSession, prompt }) }, Workbench));
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "kami-workbench", label: () => ctx.locale.bind("kami-dsh")("Kami 翻译工作台"), order: 5, locale: "kami-dsh" }, () => h("span", { "aria-hidden": true }, "K")));
      }
    };
  }
});

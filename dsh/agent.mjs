import { defineTool } from "@deepseek-ai/dsh-tools";

export const inject = ["tools", "systemPrompt", "kamiWorkbench"];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.presentAs("native"));
  ctx.systemPrompt.section({
    name: "kami-translator",
    order: 50,
    text: "你是日语→简体中文本地化 agent。先用 kami_workspace 查询当前工作区绑定；未绑定时请用户明确选择已有项目或命名新项目，不按目录名猜测。使用 DSH 原生文件、搜索和已配置的文档工具查找并查阅工作区原文件，不上传或改写原件。风格指南、术语、TM、参考资料用 kami_file_import 按用途关联。术语和 TM 原文件归属指定的当前项目库（libraryId），沿用库的启停与优先级；翻译只使用启用库的文件。关联术语、TM、风格指南后，若 compilation.status=pending，立即理解原文件结构并编译，不得只登记路径就宣称完成。批量编译先调用 kami_workspace {action:'compilations',selection:[{path,purpose,libraryId}]}；省略 selection 检查所有启用库和项目风格指南。返回 groups 已按库分组，只编译其中 pending 的所选来源，ready 的未变化来源跳过。每个术语库、TM 库各有唯一汇总编译文件，项目的风格指南也汇总成一份；只更新选中文件，未选中的已有内容由 Host 保留，不要逐个来源生成独立编译文件。编译前用原生工具识别工作表、原文列、译文列、备注列、说明行和保护行；不能要求用户改成固定模板，也不能预设列位置。大表先理解结构，再用脚本按识别结果全量提取，核对条数，不得仅编译抽样内容。每个库只把本次选中来源写到该组 updatePath，JSON 为 {resources:[{path,hash,terms:[{ja,zh,note}]}]}；TM 的每个来源用 entries:[{source,target,context,file}]，风格指南用 style_guide 文本，保留全部权威规则、例外和正反例。hash 来自当前来源信息。然后以该组第一个来源 path、purpose、libraryId 调用 kami_file_import，传 compiledPath:updatePath；Host 按库一次增量合并、去重并原子保存，保留来源和备注。同原文不同译法保留，TM 不同上下文和条目身份保留，不只按原文覆盖。原件保持只读，派生更新文件只写到 .kami/compiled/。小资源也可在关联同一原文件时提交 resourceContext:[{path,hash,text或pairs}]，同样合并到库的唯一编译文件。以返回 compilation.status=ready 为完成依据，报告有效条数、重复合并和失败项；读取失败、语义不明确或未覆盖全部内容时明确报告，不能编造结果。编译文件记录各来源哈希，后续建批自动加载，无需反复提交 pairs；源文件变化后只更新相应来源。单批临时查阅结果仍可用 resourceContext 提供。参考资料只关联原件路径，不编译、不预解析、不建立片段或向量索引。建批时无需提前读取全部参考资料，也不向 resourceContext 填充参考正文。翻译与审校时按需调用当前会话的 read、read_image、grep 等原生工具直接查阅原件；Office/PDF 可使用已配置的 skill 和文档工具只读查阅，不要求固定排版，不先转换全部文件。读不到时明确说明，不用旧解析缓存冒充已查阅。待译文件由 Kami 建批、分段与原格式导出；先预览原文，再启动批处理。新批次冻结原文及术语、TM、风格指南版本；参考资料仅记录关联信息，正文以实际查阅的当前原件为准。续跑、QA、导出保留原文和已编译资源快照。任务资源不自动写入正式资产库，工作区 TM 只作为未批准参考。长任务返回 ID 后查询进度；导出写到工作区 outputs/，可指定工作区内 outputPath，同名文件报错。人工审校在 memoQ 完成，用户在工作台的“终稿与学习”中关联本地 MQXLIFF / XLIFF 人工终稿，一次更新 TM、原批次学习轨迹和术语普查。普通 TM 文件关联不代表人工审校；不得自行把机器稿标成人工终稿。学习版本仍由用户在工作台激活。不要把机器草稿当作人工规范。翻译业务通过 Kami 工具执行；失败时如实报告，不探测端口或通过浏览器、shell 绕过业务入口。除非用户要求，不委派其他 agent。"
  });
  ctx.tools.register(defineTool({
    name: "kami_workspace",
    description: "查询当前 DSH 工作区和 .kami/project.json；明确绑定已有 Kami 项目或创建新项目，配置任务资源与输出目录。切换会话目录后自动使用新工作区。",
    parameters: {
      action: { type: "string", description: "status（默认）、bind、configure、compilations（按库检查所选资源，返回 ready/pending 来源及库的统一编译文件）" },
      projectId: { type: "string", description: "bind 时使用的已有项目 ID，与 name 二选一" },
      name: { type: "string", description: "bind 时明确创建的新项目名称" },
      selection: { type: "json", description: "compilations 的可选范围 [{path,purpose:'terms|tm|style-guide',libraryId}]；只更新这些来源，保留库中其他来源。省略时检查全部启用资源；未变化的 ready 来源无需重复编译。返回 groups 每库一个 updatePath，编译产物由 Host 合并到库的唯一文件。" },
      resources: { type: "json", description: "configure 使用 {styleGuides:[],terms:[],translationMemories:[],references:[],outputDirectory:'outputs'}；路径相对工作区。空数组解除关联，不删除原件。术语/TM 可用 libraryFiles:[{path,purpose:'terms|tm',libraryId}] 指定所属库；停用库不参与新任务。返回 compilations 中 pending 的资源须立即由 Agent 理解原文件并编译。" }
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const workbench = await ctx.kamiWorkbench.ready;
      return workbench.workspace(args, ctx.kamiWorkbench.contextFor(exec.agent, exec.signal));
    }
  }));
  ctx.tools.register(defineTool({
    name: "kami_workbench",
    description: "管理本地翻译项目、资产和任务。读取详情、创建翻译批次、执行 QA 或导出；返回结构化结果。",
    parameters: {
      method: { type: "string", description: "GET、POST 或 PATCH；默认 GET" },
      path: { type: "string", required: true, description: "Kami 操作路径。先 GET /api/projects 选择项目；文件队列 GET /api/batch/files?projectId=…；任务 GET /api/tasks?projectId=…；完整操作索引见 kami_help。" },
      offset: { type: "integer", description: "返回数组的起始位置，默认 0" },
      limit: { type: "integer", description: "每个返回数组最多 1–30 项，默认 10；查询数据库分页还需在 path 中设置 limit/offset" },
      body: { type: "json", description: "写操作所需字段；项目与文件操作必须指定 projectId。对已有批次调用 /api/auto-qa 时携带 batchId，沿用该批次资源快照。" }
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const workbench = await ctx.kamiWorkbench.ready;
      const context = ctx.kamiWorkbench.contextFor(exec.agent, exec.signal);
      const value = await workbench.perform(args, context);
      if (value?.base64) return workbench.saveExport(value, value.filename, context, args.body?.outputPath);
      const limit = Math.max(1, Math.min(30, args.limit ?? 10));
      const offset = Math.max(0, args.offset ?? 0);
      const pagination = {};
      const page = (key, item) => {
        pagination[key] = { total: item.length, offset, limit, nextOffset: offset + limit < item.length ? offset + limit : null };
        return item.slice(offset, offset + limit);
      };
      const bounded = Array.isArray(value) ? page("items", value) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? page(key, item) : item])) : value;
      const text = JSON.stringify(bounded);
      if (text.length > 24_000) throw new Error("结果超过 24000 字符，请使用 limit/offset、搜索或记录 ID 缩小查询");
      return { value: bounded, pagination };
    }
  }));
  ctx.tools.register(defineTool({
    name: "kami_file_import",
    description: "关联工作区原文件。术语/TM/风格指南返回编译状态；pending 时由 Agent 理解原文件并编译，再提交 compiledPath 或 resourceContext 保存结果，后续翻译自动注入。参考资料只关联，翻译时由 Agent 用原生工具查阅，不预解析或建立索引。待译文件创建带资源快照的批次。不上传或移动原件，不自动写入正式术语/TM。",
    parameters: {
      path: { type: "string", required: true, description: "当前工作区内的相对文件路径" }, projectId: { type: "string", description: "兼容参数，必须与工作区绑定一致；可省略" },
      purpose: { type: "string", description: "translation（默认）、style-guide、terms、tm、reference" },
      libraryId: { type: "string", description: "术语或 TM 原文件所属的当前项目库 ID；关联文件沿用库的启停和优先级，不上传、不正式入库" },
      register: { type: "boolean", description: "非待译文件是否关联，默认 true；false 仅核查原文件信息" },
      compiledPath: { type: "string", description: "同一库的增量更新 JSON 路径，建议使用 compilations 返回的 updatePath。格式 {resources:[{path,hash,terms:[{ja,zh,note}]}]}；TM 每个来源用 entries:[{source,target,context,file}]，风格指南用 style_guide。只放本次所选来源，Host 一次合并到该库的唯一编译文件，去重并保留其他来源。兼容单源 source:{path,hash} 加 terms/entries/style_guide 格式。原件无需固定模板，须实际读取理解后全量提取；不写入正式资产库。" },
      resourceContext: { type: "json", description: "Agent 实际查阅后提供 [{path,hash,text}]，术语/TM 用 pairs:[{source,target,note}]。仅术语/TM/风格指南关联时持久保存为编译结果，建批时仅用于本批；参考资料不接受预解析正文，翻译时直接查阅原件。大表请写编译 JSON 后传 compiledPath，避免把全部句对塞进工具参数。版本变化会拒绝旧结果。" },
      resources: { type: "json", description: "可选，仅用于本批次的 styleGuides/terms/translationMemories/references 路径数组，覆盖工作区对应配置" }
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const workbench = await ctx.kamiWorkbench.ready;
      const result = await workbench.importFile(args, ctx.kamiWorkbench.contextFor(exec.agent, exec.signal));
      if (!result.batchId) return result;
      return { batchId: result.batchId, filename: result.filename, format: result.format, segmentCount: result.segments?.length, preview: result.segments?.slice(0, 5), requiresBrief: result.requiresBrief, snapshot: "已冻结原文及术语/TM/风格指南；参考资料仅关联，翻译时按需读取原件" };
    }
  }));
  ctx.tools.register(defineTool({
    name: "kami_help",
    description: "读取工作台操作索引与当前工作区状态。用 DSH 原生文件搜索工具查找文件。",
    parameters: {},
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const context = ctx.kamiWorkbench.contextFor(exec.agent, exec.signal);
      const workbench = await ctx.kamiWorkbench.ready;
      return { workspace: await workbench.workspace({}, context), operations: {
        workspace: "kami_workspace {action:'bind',projectId} 或 {action:'bind',name}；{action:'configure',resources:{...}}",
        file: "kami_file_import {path,purpose:'translation|style-guide|terms|tm|reference'}；待译文件创建批次，其他用途只关联文件，不正式入库",
        projects: "GET/POST /api/projects; POST body {name}",
        files: "GET /api/batch/files?projectId=…",
        inspect: "GET /api/batch/run/<batchId>?projectId=…",
        start: "POST /api/batch/run/<batchId>/start {projectId}",
        pause: "POST /api/batch/run/<batchId>/pause {projectId}",
        assets: "GET /api/library-entries?projectId=…&locale=zh-CN&kind=term&limit=50&offset=0; kind=tm for translation memory",
        qa: "GET /api/qa/batch/<batchId>?projectId=… 回放批次检查；POST /api/auto-qa {batchId,projectId,locale:'zh-CN',source,translation} 使用批次快照。独立审校省略 batchId，读取当前工作区资源；原生工具查阅的资源通过 body.resourceContext 提供。",
        tasks: "GET /api/tasks?projectId=…",
        learning: "GET /api/learning/overview?projectId=…&locale=zh-CN",
        export: "POST /api/batch/export {batchId,projectId,mode:'writeback',outputPath:'outputs/result.docx'}；使用已保存的分段与原件快照"
      } };
    }
  }));
}

import { defineTool } from "@deepseek-ai/dsh-tools";

export const inject = ["tools", "systemPrompt", "kamiWorkbench"];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.presentAs("native"));
  ctx.systemPrompt.section({
    name: "kami-translator",
    order: 50,
    text: "你是日语→简体中文本地化 agent。先用 kami_workspace 查询当前工作区绑定；未绑定时请用户明确选择已有项目或命名新项目，不按目录名猜测。使用 DSH 原生文件读取、编辑、搜索工具查找和检查工作区文件。用户指定的风格指南、术语、TM、参考资料用 kami_file_import 按用途关联，然后用同一工具解析待译文件，查看批次分段后启动批处理。新建批次时读取最新版文件并冻结快照；续跑、QA、导出沿用原快照。新文件内容需创建新批次。任务资源不自动写入正式资产库，工作区 TM 只作为未批准参考。长任务返回 ID 后查询进度；导出写到工作区 outputs/，可指定工作区内 outputPath，同名文件报错。人工批准、正式采纳和学习版本激活由用户在工作台完成。不要把机器草稿当作人工规范。翻译业务通过 Kami 工具执行；失败时如实报告，不探测端口或通过浏览器、shell 绕过。除非用户要求，不委派其他 agent。"
  });
  ctx.tools.register(defineTool({
    name: "kami_workspace",
    description: "查询当前 DSH 工作区和 .kami/project.json；明确绑定已有 Kami 项目或创建新项目，配置任务资源与输出目录。切换会话目录后自动使用新工作区。",
    parameters: {
      action: { type: "string", description: "status（默认）、bind、configure" },
      projectId: { type: "string", description: "bind 时使用的已有项目 ID，与 name 二选一" },
      name: { type: "string", description: "bind 时明确创建的新项目名称" },
      resources: { type: "json", description: "configure 使用 {styleGuides:[],terms:[],translationMemories:[],references:[],outputDirectory:'outputs'}；路径相对工作区。空数组解除关联，不删除原件。" }
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
      body: { type: "json", description: "写操作所需字段；项目与文件操作必须指定 projectId。" }
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
    description: "引用当前工作区文件；待译文件创建带资源快照的翻译批次，其余用途预览并关联到工作区。不上传或移动原件，不自动写入正式术语/TM。",
    parameters: {
      path: { type: "string", required: true, description: "当前工作区内的相对文件路径" }, projectId: { type: "string", description: "兼容参数，必须与工作区绑定一致；可省略" },
      purpose: { type: "string", description: "translation（默认）、style-guide、terms、tm、reference" },
      register: { type: "boolean", description: "非待译文件是否关联，默认 true；false 仅预览" },
      resources: { type: "json", description: "可选，仅用于本批次的 styleGuides/terms/translationMemories/references 路径数组，覆盖工作区对应配置" }
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const workbench = await ctx.kamiWorkbench.ready;
      const result = await workbench.importFile(args, ctx.kamiWorkbench.contextFor(exec.agent, exec.signal));
      if (!result.batchId) return { ...result, preview: typeof result.preview === "string" ? result.preview.slice(0, 8000) : result.preview };
      return { batchId: result.batchId, filename: result.filename, format: result.format, segmentCount: result.segments?.length, preview: result.segments?.slice(0, 5), requiresBrief: result.requiresBrief, snapshot: "已冻结原文和任务资源；续跑不重新读取工作区文件" };
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
        qa: "POST /api/auto-qa {projectId,locale:'zh-CN',source,translation}",
        tasks: "GET /api/tasks?projectId=…",
        learning: "GET /api/learning/overview?projectId=…&locale=zh-CN",
        export: "POST /api/batch/export {batchId,projectId,mode:'writeback',outputPath:'outputs/result.docx'}；使用已保存的分段与原件快照"
      } };
    }
  }));
}

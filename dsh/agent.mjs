import { defineTool } from "@deepseek-ai/dsh-tools";
import { readdir } from "node:fs/promises";

export const inject = ["tools", "systemPrompt", "kamiWorkbench"];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.restrict({ allow: [] }));
  ctx.effect(() => ctx.tools.presentAs("native"));
  ctx.systemPrompt.section({
    name: "kami-translator",
    order: 50,
    text: "你是日语→简体中文本地化 agent。使用 Kami 项目的术语、TM、风格与参考资料完成翻译、QA 和导出。先确认项目和文件，再导入并查看分段；启动长任务后用任务 ID 查询进度。人工批准、正式采纳和学习版本激活由用户在工作台完成。工具结果中的截断内容按 ID 分页读取。不要把机器草稿当作人工规范。"
  });
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
      const value = await workbench.invoke(args, ctx.kamiWorkbench.contextFor(exec.agent, exec.signal));
      if (value?.base64) return workbench.saveExport(value);
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
    description: "把当前工作目录中的待译文件导入指定项目，解析并返回批次 ID 与分段预览。",
    parameters: { path: { type: "string", required: true, description: "当前工作目录内的文件路径" }, projectId: { type: "string", required: true } },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const workbench = await ctx.kamiWorkbench.ready;
      const result = await workbench.importFile(args, ctx.kamiWorkbench.contextFor(exec.agent, exec.signal));
      return { batchId: result.batchId, filename: result.filename, format: result.format, segmentCount: result.segments?.length, preview: result.segments?.slice(0, 5), requiresBrief: result.requiresBrief };
    }
  }));
  ctx.tools.register(defineTool({
    name: "kami_help",
    description: "读取工作台操作索引及当前工作目录文件名。",
    parameters: {},
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const context = ctx.kamiWorkbench.contextFor(exec.agent, exec.signal);
      return { files: context.cwd ? (await readdir(context.cwd)).slice(0, 100) : [], operations: {
        projects: "GET/POST /api/projects; POST body {name}",
        files: "GET /api/batch/files?projectId=…",
        prepare: "POST /api/batch/prepare {projectId,filename,text,locale:'zh-CN'}",
        inspect: "GET /api/batch/run/<batchId>?projectId=…",
        start: "POST /api/batch/run/<batchId>/start {projectId}",
        pause: "POST /api/batch/run/<batchId>/pause {projectId}",
        assets: "GET /api/library-entries?projectId=…&locale=zh-CN&kind=term&limit=50&offset=0; kind=tm for translation memory",
        qa: "POST /api/auto-qa {projectId,locale:'zh-CN',source,translation}",
        tasks: "GET /api/tasks?projectId=…",
        learning: "GET /api/learning/overview?projectId=…&locale=zh-CN",
        export: "POST /api/batch/export {batchId,projectId,locale:'zh-CN',filename,format,segments}"
      } };
    }
  }));
}

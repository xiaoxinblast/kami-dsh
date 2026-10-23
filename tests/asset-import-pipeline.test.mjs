import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("续跑复用上一轮的 AI 清洗结果，只判定没标记过的条目", async () => {
  const server = await read("../server.mjs");
  // 清洗完先写回候选行，再入库：这样即使入库阶段被打断，判定结果也已经存住了。
  const job = server.slice(server.indexOf("async function runAssetImportInBackground"), server.indexOf("async function previewTermImport"));
  assert.match(job, /const persistedCleaning = await persistImportCleaning\(batch, \{ projectId, filename, candidates: routed \}\);/u);
  assert.match(job, /phase: "saving-cleaning"/u);
  // 已经有标记的候选不再送模型，并且不计入"模型没返回"的缺失统计
  assert.match(server, /candidate\.contentTypeSource !== "ai-cleaned"/u);
  assert.match(server, /const cachedCount = candidates\.filter\(\(candidate\) => candidate\.contentTypeSource === "ai-cleaned"\)\.length;/u);
  assert.match(server, /ai\.missing = Math\.max\(0, \(candidates\.length - cachedCount\) - ai\.reviewed\);/u);
  assert.match(server, /复用 \$\{cachedCount\} 条已判定结果/u);

  // 写回实现：老候选按 id 更新，本轮新产生的句内术语作为新行进同一批次，统一打 ai-cleaned 标记
  const directusStore = await read("../src/directus-store.mjs");
  const persist = directusStore.slice(
    directusStore.indexOf("export async function persistDirectusImportCleaning"),
    directusStore.indexOf("export async function getDirectusImportPreview")
  );
  assert.match(persist, /classification_source: "ai-cleaned"/u);
  assert.match(persist, /id: candidate\.candidateId/u);
  assert.match(persist, /\{ \.\.\.candidate, contentTypeSource: "ai-cleaned" \}/u);
  assert.match(persist, /createItemsInChunks\("\/items\/term_candidates"/u);
  // 候选行 → 表字段的映射只有一份（写队列与写回共用）
  assert.match(directusStore, /function importCandidateRecord\(candidate, \{ batchId, projectId = "", filename = "", aiUsed = false \} = \{\}\)/u);
  const store = await read("../src/store.mjs");
  assert.match(store, /export async function persistImportCleaning\(batchId, payload\)/u);
});

test("导入任务在开始就带上批次号，服务重启后「继续导入」才找得到候选", async () => {
  const server = await read("../server.mjs");
  const commitRoute = server.slice(
    server.indexOf('url.pathname === "/api/assets-import/commit"'),
    server.indexOf('url.pathname === "/api/assets-import/resume"')
  );
  // 之前批次号只在成功（或抛错）时才写进任务载荷：进程被杀就没有 batchId，
  // 任务中心虽然给出「继续导入」，点了却提示"没有可续传的批次"。
  assert.match(commitRoute, /payload: \{ batchId: String\(body\.batchId \|\| ""\), filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false \}/u);
  const resumeRoute = server.slice(
    server.indexOf('url.pathname === "/api/assets-import/resume"'),
    server.indexOf('url.pathname === "/api/batch/columns"')
  );
  assert.match(resumeRoute, /payload: \{ batchId, filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false \}/u);
  // 资产导入的后台链路写队列拿到批次号后立刻补写任务载荷。
  assert.match(server, /payload: \{ batchId: batch, filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false \}/u);
  // TM 导入走"队列后置"：批次号在建任务时就定下来写进载荷，审计在导入成功后写。
  assert.match(server, /payload: \{ batchId, filename, tmLibraryId, resumable: true \}/u);
  const storeFile = await read("../src/store.mjs");
  assert.match(storeFile, /export async function saveTmImportAudit\(input = \{\}\)/u);
});

test("中断：跑批循环在分块边界停下，任务标成可继续而不是一直进行中", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /const runningBackgroundTasks = new Map\(\);/u);
  assert.match(server, /function cancellationError\(message\)/u);
  // 路由：后台任务中断 + 批次中断
  assert.match(server, /\^\\\/api\\\/background-tasks\\\/\[\^\/\]\+\\\/cancel\$/u);
  assert.match(server, /\^\\\/api\\\/batch\\\/run\\\/\[\^\/\]\+\\\/cancel\$/u);
  // 中断落成 needs_attention + phase=cancelled + resumable，界面才知道可以继续
  assert.match(server, /phase: cancelled \? "cancelled" : "failed"/u);
  assert.match(server, /status: cancelled \? "needs_attention" : "failed"/u);
  assert.match(server, /const cancelled = isCancellation\(error\);/u);
  // 批次：中断用 runnerOptions.cancelled 标记（run_state 只有库里允许的取值）
  const runner = await read("../src/batch-runner.mjs");
  assert.match(runner, /run\.runState = "paused";\s*\n\s*run\.runnerOptions = \{ \.\.\.options, cancelled: true \};/u);
  assert.match(server, /shouldCancel: \(\) => controller\.cancelRequested/u);
  assert.match(server, /worker\.cancelRequested = true;/u);
});

test("服务重启后：批次任务与导入任务都会标成可继续", async () => {
  const server = await read("../server.mjs");
  const recovery = server.slice(
    server.indexOf("async function recoverInterruptedBatchWorkers"),
    server.indexOf("async function shutdownManagedWorkbench")
  );
  // 批次：运行中的批次置 paused，卡在 running 的段落退回 pending
  assert.match(recovery, /runState: "paused"/u);
  assert.match(recovery, /error: "服务重启后等待继续"/u);
  // 对应的后台任务行也要收尾，否则任务中心一直显示"进行中"
  assert.match(recovery, /item\.type === "batch_translation" && item\.status === "in_progress"/u);
  assert.match(recovery, /message: "服务重启导致中断，可在任务中心继续翻译"/u);
  assert.match(recovery, /payload: \{ \.\.\.\(task\.payload \|\| \{\}\), batchId: run\.batchId, filename: run\.filename, resumable: true \}/u);
  // 导入与参考资料后台任务：in_progress 的都要收尾，不能重启后永远转圈
  assert.match(server, /\["term_import", "asset_import", "reference_ingest", "reference_describe", "reference_folder_delete"\]\.includes\(task\.type\)/u);
});

test("术语导入不再逐条拉整库，改为一次索引 + 分块写入", async () => {
  const server = await read("../server.mjs");
  // 旧实现是每条候选都 getProjectAssets(整库) 判重，5859 条会变成分钟级导入。
  assert.doesNotMatch(server, /\.filter\(\(term\) => term\.source\.toLocaleLowerCase\(\) === source\.toLocaleLowerCase\(\)\)/u);
  assert.match(server, /const loadTermIndex = async \(locale\) =>/u);
  assert.match(server, /saveAssets\(batch\[0\]\.locale/u);
  assert.match(server, /const TERM_WRITE_BATCH_SIZE = 200;/u);
  assert.match(server, /const SKIPPED_DETAIL_LIMIT = 200;/u);
});

test("双语资产导入走后台任务，并支持同行批次续跑", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /url\.pathname === "\/api\/assets-import\/commit"/u);
  assert.match(server, /type: "asset_import"/u);
  assert.match(server, /runAssetImportInBackground\(/u);
  assert.match(server, /url\.pathname === "\/api\/assets-import\/resume"/u);
  // 持久化候选没有 selected 列：续跑必须按"默认全选"还原，否则整批会被判成未选择。
  assert.match(server, /const candidates = preview\.candidates\.map\(\(candidate\) => \(\{ \.\.\.candidate, selected: candidate\.selected !== false \}\)\);/u);
  assert.match(server, /const purpose = body\.purpose === "tm" \? "tm" : "term"/u);
  assert.match(server, /const aiCleaning = purpose === "term" && body\.aiCleaning === true/u);
  // 后台任务执行期间挂住收尾判定，否则导入会被"关页面"规则连带杀掉。
  assert.match(server, /workbenchSessionMonitor\?\.hold\(backgroundTaskHoldId\(task\.id\)\)/u);
  assert.match(server, /BACKGROUND_TASK_TERMINAL_STATUSES/u);
  assert.match(server, /async function recoverInterruptedImportTasks/u);
});

test("确认导入立刻返回任务号，审核队列写入放到后台并带进度", async () => {
  const server = await read("../server.mjs");
  const routeStart = server.indexOf('url.pathname === "/api/assets-import/commit"');
  const route = server.slice(routeStart, server.indexOf('url.pathname === "/api/assets-import/resume"', routeStart));
  // 路由里不能再直接写审核队列：那会让弹窗长时间只有一个灰按钮。
  assert.doesNotMatch(route, /await saveImportPreview\(/u);
  assert.match(route, /const task = await createBackgroundTask\(/u);
  assert.match(route, /persistCandidates: true/u);
  assert.match(server, /persistCandidates: false/u);
  // 后台链路里写队列，并按条数报进度。
  const job = server.slice(server.indexOf("async function runAssetImportInBackground"), server.indexOf("async function previewTermImport"));
  assert.match(job, /正在写入审核队列：0 \/ \$\{working\.length\} 条候选/u);
  assert.match(job, /\{ onProgress: countReport\(1, 8\) \}/u);
  assert.match(job, /payload: \{\s*\n\s*batchId: batch \|\| batchId,/u);
  // 队列写入本身要能报进度：createItemsInChunks -> saveImportPreview -> store 透传回调。
  const directusStore = await read("../src/directus-store.mjs");
  assert.match(directusStore, /export async function saveDirectusTmImportAudit\(/u);
  assert.match(directusStore, /async function createItemsInChunks\(path, records, \{ onProgress, maxItems \} = \{\}\)/u);
  assert.match(directusStore, /onProgress\?\.\(\{ completed: saved\.length, total: records\.length \}\)/u);
  assert.match(directusStore, /export async function saveDirectusImportPreview\(input, \{ onProgress \} = \{\}\)/u);
  const store = await read("../src/store.mjs");
  assert.match(store, /export async function saveImportPreview\(input, options\)/u);
});

test("批量写入一律按 2,000 条分块：7 万条一次请求会撞 Directus 超时", async () => {
  // 真机踩过：72,099 条风格证据走一个请求 → `Directus请求超时（120 秒）` → 整批证据 100% 失败。
  const directusStore = await read("../src/directus-store.mjs");
  assert.match(directusStore, /const BULK_INSERT_CHUNK_ITEMS = 2_000;/u);
  assert.match(directusStore, /async function createItemsInChunks\(path, records, \{ onProgress, maxItems \} = \{\}\)/u);
  assert.match(directusStore, /chunkDirectusRecords\(records, maxItems \? \{ maxItems \} : undefined\)/u);
  const chunked = directusStore.match(/maxItems: BULK_INSERT_CHUNK_ITEMS/gu) || [];
  assert.ok(chunked.length >= 5, `证据/审计/审核队列/术语/记忆都要分块（当前 ${chunked.length} 处）`);
  assert.match(directusStore, /createItemsInChunks\("\/items\/style_evidence", creates\.map\(\(entry\) => entry\.body\), \{/u);
  // 收尾的批量更新也必须分块：3.5 万条候选一个 PATCH 会把 Directus 压到 120 秒超时（真机踩过）。
  assert.match(directusStore, /async function updateItemsInChunks\(path, records\) \{\r?\n\s+for \(const chunk of chunkDirectusRecords\(records, \{ maxItems: BULK_INSERT_CHUNK_ITEMS \}\)\)/u);
});

test("术语注释取自原表，记账信息移出 note", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /provenance: `table-import:\$\{String\(sourceFile \|\| "unknown"\)\.slice\(0, 120\)\}\$\{sourceRow \? `#\$\{sourceRow\}` : ""\}`/u);
  assert.match(server, /note: String\(candidate\.note \|\| ""\)\.trim\(\)\.slice\(0, 500\)/u);
  assert.doesNotMatch(server, /note: `批次 \$\{body\.batchId\} · 原表第/u);
  const provider = await read("../src/provider.mjs");
  // 注释要参与 AI 清洗判断。
  assert.match(provider, /note: candidate\.note \|\| "",/u);
  assert.match(provider, /把它标为 noteColumn；没有这样的列时 noteColumn 必须为 null/u);
});

test("页面中途关闭不会让长任务抛未捕获异常", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /if \(res\.destroyed \|\| res\.writableEnded\) return;/u);
  assert.match(server, /res\.on\("error", \(\) => \{\}\);/u);
});

test("按原文查重改走哈希，长句不再把查询串撑爆（431）", async () => {
  const directus = await read("../src/directus-store.mjs");
  // 旧写法把整句原文/译文塞进 URL，几百字的句段直接触发 431 并让候选被跳过。
  assert.doesNotMatch(directus, /params\.set\("filter\[source\]\[_eq\]"/u);
  assert.doesNotMatch(directus, /params\.set\("filter\[target\]\[_eq\]"/u);
  // 空哈希（原文归一化后为空，例如整段只有内联标签占位符）必须走 `_empty`：
  // 空串进 `_eq` 会被 Directus 判 400，整条候选被跳过。
  assert.match(directus, /const sourceHash = memorySourceHash\(attempt\.source\);/u);
  assert.match(directus, /if \(sourceHash\) pairParams\.set\("filter\[source_hash\]\[_eq\]", sourceHash\);/u);
  assert.match(directus, /else pairParams\.set\("filter\[source_hash\]\[_empty\]", "true"\);/u);
  assert.match(directus, /const sourceHash = memorySourceHash\(source\);/u);
  assert.match(directus, /if \(sourceHash\) params\.set\("filter\[source_hash\]\[_eq\]", sourceHash\);/u);
  assert.doesNotMatch(directus, /\[_eq\]", memorySourceHash\(/u);
  assert.match(directus, /source_hash: memorySourceHash\(source\),/u);
  const memory = await read("../src/translation-memory.mjs");
  assert.match(memory, /export function memorySourceHash\(source = ""\)/u);
  // 报错信息会进任务记录并显示在界面上：必须去掉查询串并截断。
  assert.match(directus, /const plainPath = String\(path\)\.split\("\?"\)\[0\]\.slice\(0, 80\);/u);
  assert.match(directus, /失败（\$\{response\.status\}/u);
});

test("跳过原因与任务文案都做了截断，界面不会被长报错撑爆", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /const reason = String\(entry\?\.reason \|\| "未知原因"\)\.slice\(0, 120\);/u);
  const styles = await read("../public/styles.css");
  assert.match(styles, /\.task-row > \* \{ min-width: 0; \}/u);
  assert.match(styles, /\.task-main small, \.task-qa small, \.task-qa strong \{/u);
  assert.match(styles, /-webkit-line-clamp: 2;/u);
  const app = await read("../public/app.js");
  assert.match(app, /<strong title="\$\{escapeHtml\(payloadText \|\| ""\)\}">/u);
});

test("导入体积规则各入口统一：单文件 32MB、只限文件个数", async () => {
  const app = await read("../public/app.js");
  assert.doesNotMatch(app, /MEMORY_IMPORT_TOTAL_BYTES/u);
  assert.match(app, /const UPLOAD_FILE_BYTES = 32 \* 1024 \* 1024;/u);
  assert.match(app, /const IMPORT_MAX_FILES = 200;/u);
  const server = await read("../server.mjs");
  assert.match(server, /const IMPORT_FILE_BYTES = 32 \* 1024 \* 1024;/u);
  assert.match(server, /const tooLarge = files\.find\(\(file\) => Buffer\.byteLength\(String\(file\.base64 \|\| ""\), "base64"\) > IMPORT_FILE_BYTES\);/u);
  const html = await read("../public/index.html");
  assert.match(html, /单个文件不超过 32MB/u);
  // 文件类请求的 body 额度必须容得下 32MB 文件 base64 后的体积（约 43MB）。
  assert.match(server, /const IMPORT_BODY_BYTES = 48 \* 1024 \* 1024;/u);
  for (const route of ["/api/term-import/preview", "/api/term-import/commit", "/api/batch/prepare"]) {
    const index = server.indexOf(`url.pathname === "${route}"`);
    assert.ok(index > 0, `找不到路由 ${route}`);
    assert.match(server.slice(index, index + 220), /readJsonBody\(req, \{ limitBytes: IMPORT_BODY_BYTES \}\)/u, `${route} 需要放宽请求体额度`);
  }
  // 解析器侧的上限也要跟着改，否则 32MB 文件仍会被拒。
  const extractor = await read("../src/table-term-extractor.mjs");
  assert.match(extractor, /const MAX_FILE_BYTES = 32 \* 1024 \* 1024;/u);
  const batchDocument = await read("../src/batch-document.mjs");
  assert.match(batchDocument, /const MAX_FILE_BYTES = 32 \* 1024 \* 1024;/u);
  const batchOriginals = await read("../src/batch-originals.mjs");
  assert.match(batchOriginals, /const MAX_BYTES = 32 \* 1024 \* 1024;/u);
});

test("人工 TM 导入支持后台任务：接口立刻返回任务号，页面跟进度", async () => {
  const server = await read("../server.mjs");
  const routeIndex = server.indexOf('url.pathname === "/api/tm-import/commit"');
  assert.ok(routeIndex > 0);
  const route = server.slice(routeIndex, routeIndex + 2400);
  // 候选从预检缓存读回来：浏览器只回批次号与取消勾选的序号（8 万条候选约 49MB）。
  assert.match(route, /const resolved = await resolveTmImportCandidates\(body\);/u);
  assert.match(route, /if \(body\.background === true\) \{/u);
  assert.match(route, /type: "term_import"/u);
  assert.match(route, /runTmImportInBackground\(/u);
  assert.match(route, /return json\(res, 202, \{ taskId: task\.id/u);
  // 后台执行体：先把候选写进主 TM（进度沿用 commitTermImport 的内部百分比），
  // 成功之后才写审计；失败时库里一行都不留，预检缓存保留给「继续导入」。
  const job = server.slice(server.indexOf("async function runTmImportInBackground"), server.indexOf("async function previewTermImport"));
  assert.match(job, /scaleProgressReport\(report, 6, 90\)/u);
  assert.match(job, /\{ skipQueueCompletion: true \}/u);
  assert.match(job, /await saveTmImportAudit\(\{/u);
  assert.doesNotMatch(job, /saveImportPreview\(/u, "TM 导入不再先写审核队列");
  // 多文件导入的缓存批次号是逗号列表，只能用来读/清缓存；写库必须换成单个新批次号，
  // 否则 10 个文件拼成 369 字符会撞 batch_id / 审计主键的长度限制（真机踩过）。
  assert.match(job, /const previewBatchIds = String\(batchId \|\| ""\);/u);
  assert.match(job, /const auditBatchId = randomUUID\(\);/u);
  assert.match(job, /await releasePreviewCaches\(previewBatchIds\);/u);
  assert.match(job, /payload: \{ batchId: previewBatchIds, auditBatchId, filename, error: error\.message, resumable: true \}/u);
  assert.match(server, /async function releasePreviewCaches\(batchId\)/u);
  // 跳过重复/未选择的候选也要推进进度，否则整批都跳过时任务一直显示 0 / N。
  assert.ok((server.match(/reportImporting\(\);/gu) || []).length >= 4, "三处 continue 与正常收尾都要推进进度");
  // 「继续导入」把逗号列表原样传回来：解析器要逐个读缓存，不能整串当批次号。
  assert.match(server, /const batchIds = String\(body\.batchId\)\.split\(","\)\.map\(\(value\) => value\.trim\(\)\)\.filter\(Boolean\);/u);
  // 同步路径（接口测试/小批量）同样用新的单一批次号写审计。
  assert.match(route, /const auditBatchId = randomUUID\(\);/u);
  // 进度辅助函数与资产导入共用一份实现。
  assert.match(server, /function scaleProgressReport\(report, from, to\)/u);
  assert.match(server, /function countProgressReport\(report, from, to\)/u);

  const app = await read("../public/app.js");
  assert.match(app, /styleEvidence: state\.memoryStyleEvidence, tmLibraryId: state\.memoryImportTargetId \|\| "", background: true/u);
  assert.match(app, /#memoryImportProgressText/u);
  // 「继续导入」按任务类型分流：TM 导入读预检缓存重跑，资产导入走原来的审核队列续传。
  assert.match(app, /if \(task\.taskType === "term_import"\) \{/u);
  assert.match(app, /api\("\/api\/tm-import\/commit", \{ method: "POST", body: JSON\.stringify\(\{\s*\n\s*\.\.\.projectPayload\(\),\s*\n\s*batchId,/u);
  // 复核确认那条路径也跟同一批次的进度，不再只有按钮文字。
  assert.match(app, /const backgroundTaskId = state\.importPreview\.backgroundTaskId \|\| "";/u);
  const html = await read("../public/index.html");
  assert.match(html, /id="memoryImportProgress"/u);
  const wizard = await read("../public/project-wizard.js");
  assert.match(wizard, /已提交后台写入：\$\{tmResult\.accepted/u);
});

test("待译原文件上传：列映射弹窗 + 映射随解析请求下发", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /url.pathname === "\/api\/batch\/columns"/u);
  assert.match(server, /describeBatchColumns/u);
  // 解析时把人工映射带进去
  assert.match(server, /prepareBatchDocument\(body, \{ analyzeSpreadsheet, batch: project\?\.settings\?\.batch \|\| \{\}, columnMapping: body\.columnMapping \|\| null \}\)/u);
  const document = await read("../src/batch-document.mjs");
  assert.match(document, /analysis = applyColumnMapping\(analysis, columnMapping\);/u);
  assert.match(document, /export async function describeBatchColumns/u);
  const app = await read("../public/app.js");
  assert.match(app, /if \(\/\\\.\(xlsx\|csv\)\$\/iu\.test\(file\.name\)\) \{/u);
  assert.match(app, /const confirmed = await confirmBatchColumns\(file\);/u);
  assert.match(app, /columnMapping: state\.batchColumnMapping \|\| undefined/u);
  assert.match(app, /const accepted = await setBatchFile\(file\);/u);
  const html = await read("../public/index.html");
  assert.match(html, /id="batchColumnDialog"/u);
  assert.match(html, /id="batchColumnConfirm"/u);
});

test("条目 ID 从待译段落一路带到提示词与译文记忆库", async () => {
  const runner = await read("../src/batch-runner.mjs");
  assert.match(runner, /entryKey: segment\.entryKey \|\| segment\.locator\?\.entryKey \|\| "",/u);
  assert.match(runner, /entryKey: segment\.entryKey \|\| segment\.locator\?\.entryKey \|\| ""\s*\n\s*\};/u);
  const server = await read("../server.mjs");
  // 工作 TM / 人工采纳两条写库路径都带上条目身份
  assert.match(server, /entryId: body\.entryId \|\| "", entryKey: body\.entryKey \|\| ""/u);
  assert.match(server, /provenance: "batch-working-tm",[\s\S]{0,240}entryKey: body\.entryKey \|\| ""/u);
  // 提示词里单独一行标注条目 ID
  const provider = await read("../src/provider.mjs");
  assert.match(provider, /if \(context\.entryKey\) lines\.push\(`条目：\$\{context\.entryKey\}（仅用于理解/u);
  // CAT 匹配优先按条目 ID
  const memory = await read("../src/translation-memory.mjs");
  assert.match(memory, /entryKey && memory\?\.entryKey && String\(entryKey\) === String\(memory\.entryKey\)/u);
  const app = await read("../public/app.js");
  assert.match(app, /entryKey: segment\.entryKey \|\| segment\.locator\?\.entryKey \|\| "",/u);
});

test("Directus 压力保护（503）会让读请求退避重试", async () => {
  const store = await readFile(new URL("../src/directus-store.mjs", import.meta.url), "utf8");
  assert.ok(store.includes("const busy = isDirectusBusy(error);"), "读请求要识别 503 Under pressure");
  assert.ok(store.includes("(!connectionFailure && !busy)"));
  assert.ok(store.includes("busy ? 600 * attempt : 120 * attempt"), "压力保护要退避，不能立刻判死长任务");
});

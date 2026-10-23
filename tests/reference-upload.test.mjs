import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * 参考资料上传的两次事故与现在的大文件方案：
 *
 * 1) 上传时页面直接 "Out of Memory" —— 浏览器先把整个文件读成二进制字符串再 btoa，
 *    实测 20MB 的文件就把进程推到 ~280MB（是文件的 11 倍），大文件直接把渲染进程顶死。
 * 2) 就算不崩也会被拒：请求体走 15MB 的默认上限，而 base64 放大 1/3，11MB 以上永远传不上去。
 * 3) 上限太小：几百 MB 的扫描件/画册根本没法传。
 *
 * 现在：单文件 200MB，浏览器把 File 当请求体直传，服务端边收边写盘，内存里不出现整份文件。
 */
test("参考资料走 200MB 流式落盘上传，不再在浏览器里拼 base64", async () => {
  const [script, server, materials, html] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/reference-materials.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8")
  ]);
  // 前端：base64 那条路整体删掉，改成 200MB 守卫 + File 直传。
  assert.doesNotMatch(script, /referenceFileToBase64/u, "不该再有任何把整份文件读进内存的 base64 转换");
  assert.match(script, /const REFERENCE_MAX_FILE_BYTES = 200 \* 1024 \* 1024;/u);
  assert.match(script, /Number\(item\.file\?\.size\) > REFERENCE_MAX_FILE_BYTES/u);
  assert.match(script, /await api\(`\/api\/references\/file\?\$\{query\}`, \{/u);
  assert.match(script, /body: file,/u, "File 直接当请求体，浏览器按块发送");
  assert.match(html, /单文件不超过 200MB/u);
  // 服务端：上限提到 200MB，并且真的边收边写盘（超过就中止 + 删半成品）。
  assert.match(materials, /export const MAX_REFERENCE_FILE_BYTES = 200 \* 1024 \* 1024;/u);
  assert.match(server, /async function writeRequestBodyToFile\(req, \{ path, limitBytes = MAX_REFERENCE_FILE_BYTES \} = \{\}\)/u);
  assert.match(server, /const handle = await open\(path, "w"\);/u);
  assert.match(server, /if \(bytes > limitBytes\) \{/u);
  assert.match(server, /await rm\(path, \{ force: true \}\)\.catch\(\(\) => \{\}\);/u);
  assert.match(server, /error\.statusCode = 413;/u);
  assert.match(server, /const REFERENCE_UPLOAD_DIRECTORY = join\("uploads", "references"\);/u);
  // 两条入口（原始字节 / JSON 脚本）都落到同一份存档，后续解析、重试、删除都只认它。
  assert.match(server, /async function startReferenceUpload\(\{ body, params, req \}\) \{/u);
  assert.match(server, /await writeRequestBodyToFile\(req, \{ path: absolute \}\);/u);
  assert.match(server, /ingestReport: \{ sourcePath: referenceRelativePath\(document\.id, extension\), bytes, stage: "planning" \}/u);
});

test("上传前显式选择识图模式：不再产生等待确认的弹窗与 review 任务", async () => {
  const [server, script, materials] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/reference-materials.mjs", import.meta.url), "utf8")
  ]);
  // 预扫仍用于进度与统计，但不再作为阻塞门禁。
  assert.match(materials, /export async function planReferenceExtraction\(/u);
  assert.match(materials, /plan\.estimatedVisionCalls = plan\.scannedPages \+ plan\.images;/u);
  assert.doesNotMatch(server, /phase: "needs_confirmation"/u, "新的参考资料导入不再停在等待确认");
  assert.match(server, /const visionMode = String\(rawVision\).*"none".*"all"/u);
  assert.match(server, /enqueueReferenceIngest\(\{ taskId: task\.id/u);
  assert.match(server, /async function recoverLegacyReferenceIngestTasks\(\)/u);
  assert.match(server, /await recoverLegacyReferenceIngestTasks\(\)/u);
  assert.match(server, /旧版等待确认已由后续导入完成取代/u);
  assert.match(server, /await startReferenceUpload\(\{ body: null, params: url\.searchParams, req \}\)/u);
  assert.match(server, /url\.pathname\.endsWith\("\/ingest"\)/u);
  assert.match(server, /visionMode: body\.vision === false \? "none" : "all"/u);
  // 前端：上传前用开关决定 all / none，上传后直接轮询后台任务。
  assert.match(script, /data-reference-vision/u);
  assert.match(script, /setReferenceVisionMode/u);
  assert.match(script, /vision: state\.referenceVisionMode/u);
  assert.match(script, /autoScan: state\.referenceAutoScan/u);
  assert.match(script, /data-reference-folder-select/u);
  assert.match(script, /const folderIds = \[\.\.\.state\.referenceSelection\.folders\]/u);
  assert.match(script, /webkitGetAsEntry/u);
  assert.match(script, /createReader\(\)/u);
  assert.match(script, /\/api\/reference-folders\/ensure/u);
  assert.match(server, /url\.pathname === "\/api\/reference-folders\/ensure"/u);
  assert.match(server, /type: "reference_describe"/u);
  assert.match(server, /type: "reference_folder_delete"/u);
  assert.match(server, /const autoScan = !\(rawAutoScan === false/u);
  assert.match(server, /autoScanError/u);
  assert.match(server, /requestedFolderIds/u);
  assert.doesNotMatch(script, /referencePlanDialog/u);
});

test("解析前有内存护栏：zip 解压后超量直接拒绝，不把工作台顶成 OOM", async () => {
  const materials = await readFile(new URL("../src/reference-materials.mjs", import.meta.url), "utf8");
  assert.match(materials, /export const MAX_ZIP_UNCOMPRESSED_BYTES = 800 \* 1024 \* 1024;/u);
  assert.match(materials, /export const MAX_XLSX_XML_BYTES = 80 \* 1024 \* 1024;/u);
  assert.match(materials, /async function assertArchiveFitsMemory\(archive, format\) \{/u);
  assert.match(materials, /请拆分成多个文件再上传/u);
  for (const call of [/await assertArchiveFitsMemory\(archive, "docx"\);/u, /await assertArchiveFitsMemory\(await JSZip\.loadAsync\(buffer\), "xlsx"\);/u, /await assertArchiveFitsMemory\(archive, "pptx"\);/u]) {
    assert.match(materials, call);
  }
});

/**
 * 真机事故：3 个大 PDF 同时预扫把事件循环占满，/api/health 都超时。
 * 现在参考资料导入全局串行，预扫放进 worker 并带超时。
 */
test("参考资料导入串行执行，预扫放 worker 并限时", async () => {
  const [server, worker] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/reference-plan-worker.mjs", import.meta.url), "utf8")
  ]);
  assert.ok(server.includes("let referenceIngestQueue = Promise.resolve();"), "全局串行队列");
  assert.ok(server.includes("let referenceIngestQueued = 0;"));
  assert.equal(server.includes("referenceIngestQueues"), false, "不能再按文档各自排队（不同文档会并发）");
  assert.ok(server.includes("排队中：前面还有 ${ahead} 份参考资料在导入"), "排队任务要有可见提示");
  assert.ok(server.includes("const REFERENCE_PLAN_TIMEOUT_MS = 180_000;"));
  assert.ok(server.includes("new Worker(new URL(\"./src/reference-plan-worker.mjs\", import.meta.url)"), "预扫走 worker");
  assert.ok(server.includes("worker.terminate()"), "超时要能终止 worker");
  assert.ok(server.includes("await planReferenceExtractionIsolated({ filename"), "预扫必须走 worker 版");
  assert.ok(worker.includes("from \"./reference-materials.mjs\";"));
  assert.ok(worker.includes("parentPort?.postMessage({ ok: true, plan });"));
});

/**
 * 真机事故：上传被重启打断后资料一直停在 indexing，文件夹因此删不掉
 * （"文件夹里有 15 份资料正在导入"）。失败/中断和启动时都要把状态收尾。
 */
test("参考资料导入中断后不会一直停在 indexing", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("recoverInterruptedReferenceDocuments"));
  assert.ok(server.includes("服务重启导致导入中断，请重新导入"));
  assert.ok(server.includes('status: hasChunks ? "ready" : "failed"'), "有片段就恢复 ready，没有就标 failed");
  assert.ok(server.includes('if (latest && latest.status === "indexing")'), "失败/中断时也要收尾资料状态");
  assert.ok(server.includes("await recoverInterruptedReferenceDocuments();"), "启动时要扫一遍残留的 indexing 资料");
});

/**
 * 真机事故：156 份参考资料在串行队列里排队，5 分钟没有进度被清扫误判为中断；
 * 正在跑的批次翻译也被清扫误杀。清扫必须豁免本进程正在推进/排队中的任务。
 */
test("任务清扫不会误杀排队中的参考资料", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("const queuedReferenceTasks = new Set();"));
  assert.ok(server.includes("queuedReferenceTasks.add(String(taskId));"));
  assert.ok(server.includes("!runningBackgroundTasks.has(task.id) && !queuedReferenceTasks.has(String(task.id))"));
  assert.ok(server.includes("payload: { documentId: document.id, groupId:"), "上传任务要带 documentId 与上传组号，清扫收尾与任务中心折叠都要用");
  assert.ok(server.includes("导入被服务中断，请重新导入"));
});

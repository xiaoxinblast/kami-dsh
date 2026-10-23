import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("术语库和风格指导页面提供各自的上传入口", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="termLibraryFile"[^>]+accept="\.xlsx,\.csv"/u);
  assert.match(html, /id="styleGuideFile"[^>]+accept="\.txt,\.md,\.docx"/u);
  assert.match(html, /id="styleGuideImportButton"/u);
  // 上传入口不能只渲染成一行灰字：要有上传图标 + 加粗动作文字 + 虚线边框样式。
  assert.match(html, /class="library-file-button"[\s\S]{0,220}class="upload-mark"/u);
  assert.match(html, /class="library-file-cta">点击选择风格指南文件</u);
  assert.match(styles, /\.library-file-button \{ display: inline-flex;[\s\S]{0,200}border: 1px dashed/u);
  assert.match(styles, /\.library-file-button\.has-file \{/u);
  assert.match(script, /setImportFiles\(files, \{ intent: "terms", returnView: "assets" \}\)/u);
  assert.match(script, /api\("\/api\/style-guides\/import"/u);
  assert.doesNotMatch(html, /name="enforcement"/u);
});

test("双语资产导入在上传前就能选术语/TM，并可选 AI 清洗与风格证据", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /name="importPurpose" value="term"/u);
  assert.match(html, /name="importPurpose" value="tm"/u);
  assert.match(html, /id="importAiCleaning"/u);
  assert.match(html, /id="importStyleEvidence"/u);
  // 去向用分段开关、勾选用自绘方框：原生控件在窄列里会被挤成竖排单字/超大复选框。
  assert.match(html, /class="import-purpose-switch"/u);
  assert.match(html, /class="import-purpose-option"/u);
  assert.match(html, /class="import-toggle"/u);
  assert.match(html, /class="import-toggle-box"/u);
  assert.match(styles, /\.import-purpose-switch \{ display: flex;/u);
  assert.match(styles, /\.import-toggle-box \{ grid-column: 1;/u);
  assert.match(styles, /\.import-toggle > input \{ position: absolute; width: 1px;/u);
  // 预检弹窗里保留最终确认用的开关与只读去向说明。
  assert.match(html, /id="assetPreflightAiCleaning"/u);
  assert.match(html, /id="assetPreflightStyleEvidence"/u);
  assert.match(html, /id="assetImportProgress"/u);
  assert.match(html, /id="assetPreflightClose"/u);
  assert.doesNotMatch(html, /data-asset-purpose/u);
  assert.match(script, /purpose,\s*\n\s*aiCleaning,\s*\n\s*styleEvidence/u);
  assert.match(script, /const aiCleaning = purpose === "term" && Boolean\(\$\("#assetPreflightAiCleaning"\)\?\.checked\)/u);
});

test("记忆库支持批量选择文件导入，并可选择是否写入风格证据", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="memoryFile"[^>]+accept="\.xliff,\.mqxliff,\.xlsx,\.csv" multiple/u);
  assert.match(html, /id="memoryStyleEvidence" checked/u);
  assert.match(script, /state\.memoryImportFiles = \[\.\.\.event\.target\.files\]/u);
  // 逐文件预检：进度按文件推进；单个文件坏了（含超限）不影响其余文件。
  assert.match(script, /const importable = files\.filter\(\(file\) => !oversized\.has\(file\.name\)\);/u);
  assert.match(script, /for \(const \[index, file\] of importable\.entries\(\)\)/u);
  assert.match(script, /本地预检识别 \$\{preview\.total\} 条双语 TM（来自 \$\{files\.length - failures\.length\} \/ \$\{files\.length\} 个文件/u);
  // 提交走后台任务，页面按任务进度显示进度条。
  // 提交走后台任务，并且带上"导入到哪个库"（库页行内导入的目标库）。
  // 候选本体留在服务端：提交只回批次号 + 取消勾选的序号，避免 8 万条来回搬运。
  assert.match(script, /batches, filename: preview\.filename, styleEvidence: state\.memoryStyleEvidence, tmLibraryId: state\.memoryImportTargetId \|\| "", background: true \}\)/u);
  assert.match(script, /deselected: \[\.\.\.preview\.deselected\]/u);
  assert.match(html, /id="memoryImportProgress"/u);
  assert.match(html, /id="memoryImportMore"/u);
});

test("术语库列表显示原表注释", async () => {
  const [script, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(script, /class="asset-note" title="\$\{escapeHtml\(term\.note\)\}"/u);
  assert.match(styles, /\.asset-note \{ grid-column: 1\/-1;/u);
});

test("双语资产导入在前端按后台任务展示进度，并可续跑", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /asset_import: "双语资产导入"/u);
  assert.match(script, /async function watchAssetImportTask/u);
  assert.match(script, /async function continueImportTask/u);
  assert.match(script, /api\("\/api\/assets-import\/resume"/u);
  assert.match(script, /data-action="continue-import"/u);
});

test("预检逐个文件进行，并在界面上显示清单、进度与失败原因", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="importFileList"/u);
  assert.match(script, /function renderImportFileList\(container, files, states\)/u);
  assert.match(script, /for \(const \[index, file\] of selected\.entries\(\)\)/u);
  assert.match(script, /progress\(`正在预检 \$\{index \+ 1\} \/ \$\{selected\.length\}：\$\{file\.name\}`, Math\.round\(\(index \/ selected\.length\) \* 100\)\)/u);
  assert.match(script, /progress\(`预检完成：\$\{selected\.length - failures\.length\} \/ \$\{selected\.length\} 个文件，共 \$\{merged\.statistics\.entries\} 条双语条目`, 100\)/u);
  assert.match(styles, /\.import-file-list, \.memory-import-files \{/u);
  assert.match(styles, /\.import-file-list li\.running em/u);
  // 请求根本没到服务端时，不能只把浏览器的 Failed to fetch 丢给用户；
  // 同时要把原始信息写进日志（界面提示只闪 3 秒，事后要能查）。
  assert.match(script, /const message = generic\s*\n\s*\? "连不上工作台：可能正在重启或已停止，请刷新页面后重试"/u);
  // 离线错误先冒泡到 api() 外层的统一处理：那里按 offline 记日志，并把友好文案抛给界面。
  assert.match(script, /throw Object\.assign\(new Error\(message\), \{ offline: true, detail \}\);/u);
  assert.match(script, /recordClientLog\("error", `请求未送达：\$\{options\.method \|\| "GET"\} \$\{path\}`, String\(error\.detail \|\| ""\)\)/u);
  // 取文件时不能再用"人工 TM 默认勾选"覆盖用户刚改过的勾选状态。
  assert.match(script, /state\.assetImportStyleEvidence = styleEvidence \?\? readImportStyleEvidence\(\);/u);
  assert.doesNotMatch(script, /styleEvidence \?\? \(resolvedPurpose === "tm" \? true/u);
  // 导入类请求的额度单独放宽，超限也要给出可读提示而不是掐断连接。
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const IMPORT_BODY_BYTES = 48 \* 1024 \* 1024;/u);
  assert.match(server, /async function readJsonBody\(req, \{ limitBytes = MAX_BODY_BYTES \} = \{\}\)/u);
  assert.match(server, /请求内容超过 \$\{megabytes\}MB 限制，请减少文件数量或改用更小的文件/u);
});

test("预检弹窗里能直接改去向，关掉后还能重新打开", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  // 弹窗里直接给类型单选与目标库下拉，不再只有一行只读文字。
  assert.match(html, /id="assetPreflightPurposeRow"/u);
  assert.match(html, /name="assetPreflightPurpose" value="term"/u);
  assert.match(html, /name="assetPreflightPurpose" value="tm"/u);
  assert.match(html, /id="assetPreflightTermLibrary"/u);
  assert.match(html, /id="assetPreflightTmLibrary"/u);
  assert.match(script, /function renderAssetPreflightDestination\(\)/u);
  assert.match(script, /function fillLibrarySelect\(select, libraries, preferredId, preferMaster = false\)/u);
  assert.match(script, /state\.importTermLibraryId = fillLibrarySelect\(\$\("#assetPreflightTermLibrary"\), state\.assetLibraries, state\.importTermLibraryId\)/u);
  // 去向要写选中库的名字：写死"写入人工主 TM"会让选了参考 TM 的用户以为选择没生效。
  assert.match(script, /function importDestinationLabel\(purpose = state\.assetImportPurpose\)/u);
  assert.match(script, /人工终稿 → 「\$\{tmName\}」/u);
  assert.doesNotMatch(script, /写入人工主 TM/u);
  // 人工 TM 是整批进 TM：页面与弹窗里的"术语写入库"都要收起。
  assert.match(script, /const termRow = \$\("#importTermLibraryRow"\);\s*\n\s*if \(termRow\) termRow\.hidden = purpose !== "term";/u);
  assert.match(script, /const termRow = \$\("#assetPreflightTermLibraryRow"\);\s*\n\s*if \(termRow\) termRow\.hidden = purpose !== "term";/u);
  // 选中态要一眼看得出选的是哪一边：内描边 + 左侧色条 + 「已选」标记。
  assert.match(styles, /\.import-purpose-option:has\(input:checked\)::after \{ content: "已选"/u);
  // 关掉预检后页面里留一条提示，能再打开或重跑；关窗要走 refreshActions 才会更新。
  assert.match(html, /id="importPreflightResume"/u);
  assert.match(html, /id="importPreflightResumeOpen"/u);
  assert.match(script, /function renderImportResume\(\)/u);
  assert.match(script, /function closeAssetPreflightDialog\(\) \{[\s\S]{0,200}?refreshActions\(\);/u);
  assert.match(script, /\$\("#assetPreflightDialog"\)\.addEventListener\("close", \(\) => \{ resolveAssetPreflight\(\); refreshActions\(\); \}\)/u);
  // 提示条上要能直接放弃这次导入：清掉预检与已选文件，拖入区回到初始状态。
  assert.match(html, /id="importPreflightCancel"/u);
  assert.match(script, /function cancelAssetImport\(\)/u);
  assert.match(script, /state\.assetPreflight = null;[\s\S]{0,500}?\$\("#filePrompt"\)\.textContent = "拖入或点击选择双语资产文件";/u);
  assert.match(script, /\$\("#importPreflightCancel"\)\.hidden = submitted;/u);
  assert.match(script, /\$\("#importPreflightCancel"\)\?\.addEventListener\("click", \(\) => cancelAssetImport\(\)\)/u);
});

test("术语库、记忆库与导入页都能直接新增库，优先级也能在列表里调", async () => {
  const [html, script, settings] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/project-settings.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="assetAddLibrary"/u);
  assert.match(html, /id="memoryAddLibrary"/u);
  assert.match(html, /id="importAddLibrary"/u);
  assert.match(script, /function openProjectLibraries\(\{ addKind = "" \} = \{\}\)/u);
  assert.match(script, /\$\("#assetAddLibrary"\)\?\.addEventListener\("click", \(\) => openProjectLibraries\(\{ addKind: "term_base" \}\)\)/u);
  assert.match(script, /\$\("#memoryAddLibrary"\)\?\.addEventListener\("click", \(\) => openProjectLibraries\(\{ addKind: "translation_memory" \}\)\)/u);
  // 面板侧：带 addKind 打开时直接摆好新库草稿并聚焦名称，不另建一套库 CRUD。
  assert.match(settings, /open\(project, libraries, \{ initialTab = "libraries", addKind = "" \} = \{\}\)/u);
  assert.match(settings, /function addLibrary\(kind\)/u);
  assert.match(settings, /if \(\["term_base", "translation_memory"\]\.includes\(addKind\)\) \{/u);
  // 列表里的 ↑ ↓ 与面板同一套口径：换位后同类库重排成连续的 1、2、3…
  assert.match(script, /async function moveLibraryPriority\(kind, libraryId, direction\)/u);
  assert.match(script, /data-library-action="priority"/u);
});

test("工作 TM 的文件层显示翻译进度与人工审校回填", async () => {
  const [html, script, styles, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8")
  ]);
  assert.match(html, /<th>翻译进度<\/th><th>学习轨迹 \/ 人工审校<\/th>/u);
  assert.match(script, /function libraryFileProgressMarkup\(file\)/u);
  assert.match(script, /function libraryFileLearningMarkup\(file\)/u);
  assert.match(script, /双语资产导入只回填已有机器稿；跑过一次批次翻译后才有轨迹/u);
  assert.match(styles, /\.file-state\.is-done/u);
  // 服务端把"同名批次的进度"和"按来源文件分桶的轨迹"挂到文件行上。
  assert.match(server, /const \[runs, trajectoryCounts\] = await Promise\.all\(\[/u);
  assert.match(server, /countLearningTrajectoriesByFile\(\{ locale, project: projectId \}\)/u);
  assert.match(server, /learning: \{ count: Number\(learning\?\.count\) \|\| 0, humanReviewed: Number\(learning\?\.humanReviewed\) \|\| 0 \}/u);
});

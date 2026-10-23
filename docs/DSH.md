# DSH 本地翻译工作台

`kami-dsh` 是 `xiaoxinblast/kami` 的独立衍生项目，保留上游 Git 历史。目标语向为日语→简体中文。

## 安装

当前验证目标为 DSH `0.2.1-rc.2`（桌面 Electron `44.7.0` / Node `24.21.0`）。

1. 在 DSH 的“插件”→“添加插件”中填写 `https://github.com/xiaoxinblast/kami-dsh#main`，安装仓库中的当前版本。依赖由插件管理器安装。
2. 开发时也可在仓库运行 `npm ci`、`npm run dsh:check` 后安装绝对目录；Creator 模式的 `plugin_manager` 使用 `action: install_bundle` 与同一安装地址。
3. 打开一个 DSH 工作区会话，选择“Kami 翻译工作台”预设。工作台自动显示在该会话的右侧标签页，左侧不再提供全局工作台入口。先明确绑定已有 Kami 项目或新建项目。
4. 在右侧填写工作区相对路径，或直接在会话中委托翻译。右侧“翻译 agent 会话”也可向当前 Kami 会话发送任务；切换会话时，面板、工作区绑定和编辑状态随各自会话隔离。其他预设不显示 Kami 工作台，文件、浏览器、终端标签页继续保留。关闭工作台后，可用会话标题栏或新会话预设旁的 K 按钮重新打开。
5. 更新预设后新建翻译会话，以使用新版工具组合。

插件只通过 DSH 的管理入口安装，不修改 `app.asar`。更新已加载的 Host 模块后，按插件管理结果处理需要的重启；不要把“依赖已保存”当作已经生效。

本次桌面验收发现，连续热卸载／安装后，表格解析曾报 `ExcelJS.Workbook is not a constructor`；正常退出并重启 DSH 后，同一文件解析成功。更新到 0.9.0 后请正常重启一次 DSH，再开始翻译任务。

GitHub 安装不是自动更新。当前 DSH 对第三方插件要求先卸载旧程序包，再安装仓库地址；管理器会报告是否需要重启。本地资产位于独立的数据目录，卸载程序包不删除资产。也可安装明确的发布标签，把运行版本固定到已验收的提交。更新程序包不会把本地数据库或上传文件放进 GitHub。

若插件页热卸载报告 `profile reload requires the root Include entry`，退出 DSH 后可通过它自带的 CLI 更新程序包。已注册 `dsh` 命令时运行以下命令，再启动桌面端；未注册时可调用安装目录下的 `resources/runtime/cli/bin/dsh.cmd`：

```powershell
dsh plugin --profile desktop remove kami-dsh
dsh plugin --profile desktop add 'github:xiaoxinblast/kami-dsh#main'
```

## 本地数据

数据位于 `$DSH_HOME/kami-dsh/<profile>/`，默认桌面 profile 为 `desktop`。

- `kami.sqlite`：项目、术语、TM、QA、风格、参考资料和学习记录。
- `uploads/`：旧版已导入原文件与参考资料，保留兼容读取；新流程不再复制原件到此目录。
- `runtime/`：参数设置、日志，以及工作区资源解析缓存和任务原件快照，不保存模型 API Key。
- `learning/`：配对评测检查点。
- `exports/`：旧版导出和兼容接口的派生文件；新流程导出到工作区。
- `backups/`：从工作台创建的数据库备份。

数据库备份使用 SQLite 在线备份接口；迁移和完整人工备份还需保留 `uploads/`、`learning/` 与 `runtime/`（含任务原件快照和设置）。恢复应在插件停用时进行，使用备份数据库替换 `kami.sqlite`，同时恢复对应文件目录。

正常工作不启动 Kami HTTP 服务，不连接 Directus，也不依赖 Docker。业务入口在 DSH Host 内执行，SQLite 是正式存储。旧仓库的 HTTP 路由被复用为进程内操作分发，以保留现有翻译、QA、学习与导出行为。

## 一次性迁移

仅迁移时需要旧 Directus 临时可用。先关闭旧工作台的写入操作，再运行：

```powershell
npm run migrate:local -- --source-env '<旧项目>\directus\.env' --source-data '<旧运行目录>\data' --source-data '<旧源码目录>\data'
```

可用 `--destination '<目标数据目录>'` 指定独立目录。工具仅读取旧后台，不更改旧记录；会逐集合读取两遍并比较内容哈希，校验引用文件和数据库完整性后才发布正式数据库。重复执行仅接受与源数据完全相同的目标库，已有不同内容会拒绝覆盖。

结果写入本地 `migration-report.json`。`status: verified` 才表示完成；缺文件、冲突、权限不足或源数据变化均使迁移失败。账号凭据和旧分享链接不迁入。

## 翻译闭环

工作区文件是来源，SQLite 继续保存术语、TM、学习记录和任务。DSH agent 查找文件、选择资源和推进复核，Kami 执行批量翻译、QA、续跑与原格式导出。用户可修改译文并主动采纳为正式译法；学习版本仍需人工激活。

### 工作区配置与文件引用

首次使用必须明确绑定项目，不按文件夹名称猜测。`.kami/project.json` 示例：

```json
{
  "version": 1,
  "projectId": "已有或明确新建的 Kami 项目 ID",
  "styleGuides": ["rules/style.md"],
  "terms": ["glossary.xlsx"],
  "translationMemories": ["resources/tm.xlsx"],
  "references": ["references/story.docx"],
  "outputDirectory": "outputs"
}
```

路径均相对当前工作区，不要求移动文件。会话中切换工作目录后，使用 DSH `workingDirectory` 的当前值；目录缺失、越界路径、外部链接均报错，不回退到创建会话时的目录。页面和 agent 共用 Host 文件服务，文件字节不经浏览器或聊天 Base64。

在“风格指南”“资产”“参考资料”页填写路径，点击“预览并关联”。解除关联只修改配置，不删除原件。指南支持 `.txt`、`.md`、`.docx`，最大 5 MB、正文最多 50,000 字；术语/TM 支持 `.xlsx`、`.csv`、`.xliff`、`.mqxliff`，最大 20 MB。待译文件格式与既有批处理一致。

“解析并创建批次”就是任务创建边界：此时读取原文和全部所选资源的最新版，记录相对路径、SHA-256、解析快照，并在本地 `runtime/workspace-snapshots/` 保存用于格式写回的原件快照。后续运行、暂停、续跑、重启后续跑和导出都使用该快照；文件修改后需创建新批次。参考资料解析缓存按工作区、用途、路径和内容哈希区分，修改一个资料不会使其他资料的缓存失效。

工作区指南只用于任务，不启用或改写项目级旧指南。文件术语不覆盖主库已有术语；文件 TM 作为当前任务的未批准参考，不能充当人工批准的 QA 规范。引用文件不会重复写入术语、TM 或参考资料主库。旧项目指南、旧任务和 `uploads/` 继续可读，不自动迁移或清理。

导出默认写入工作区 `outputs/`，可指定工作区内的完整相对文件路径，例如 `outputs/dialogue.zh-CN.docx`。输出采用排他创建；同名文件报错，既有文件和源文件均不覆盖。DSH 文件服务当前只提供文本写入，二进制导出在 Host 校验同一服务解析的目标路径后使用本地排他创建。

### Agent 示例

先明确绑定项目，然后可以直接委托：

> 用 `rules/style.md` 和 `glossary.xlsx` 翻译 `source/dialogue.docx`，结果放到 `outputs/`。

- `kami_workspace`：`status` 查询；`bind` 指定已有 `projectId` 或明确新建的 `name`；`configure` 设置上述资源路径和输出目录。
- `kami_file_import`：`{path,purpose}`，用途为 `translation`（默认）、`style-guide`、`terms`、`tm`、`reference`。原有 `{path,projectId}` 参数保留，项目必须与工作区绑定一致。`register:false` 只预览；创建待译批次时可用 `resources` 指定本次任务的资源数组覆盖。
- `kami_workbench`：按批次 ID 启动、暂停、QA、检查进度与导出。`POST /api/batch/export` 可带 `outputPath`，返回工作区文件路径。
- `kami_help`：操作索引与当前工作区状态。

批次模型审校调用 `POST /api/auto-qa` 时携带 `batchId`、`projectId`、`locale`、`source` 和 `translation`，使用该批次冻结的指南和术语等资源；不存在的批次报错，不回退到当前文件。省略 `batchId` 则是独立审校，读取当前工作区的最新资源。

模型优先使用关联会话待生效的模型选择，其次是最近一次请求的 provider/model，新会话使用 DSH 默认模型。所有调用经过 DSH 模型服务，不另存模型 Key。固定 seed 不可用会明确标记，截断、错误和取消会转为失败，不能算作成功译文。图片识别通过 DSH 附件协议保存和发送图片，需要关联会话所选模型支持图像输入；不支持时任务报告失败。

工具和页面调用相同业务操作。页面通过独立的 DSH Remote 调用，不向关联会话追加命令或 JSON 记录；当前会话提供工作目录和模型选择，匹配 Kami 预设后接收明确发送的 agent 任务。批准、正式采纳、激活和删除保留为用户操作。大结果分页读取；导出文件返回本地路径，不把二进制塞进模型上下文。手动执行 `/kami` 仍保留 DSH 的命令日志。

专用预设包含 `@deepseek-ai/dsh-tool-fs` 与 `@deepseek-ai/dsh-tool-fs-search`，保留 DSH 通用工具，不再统一过滤。翻译业务通过 Kami 工具执行，文件查找、读取和编辑使用原生 DSH 工具。批次翻译与 QA 的内部调用也在进程内分发，不回调本机 HTTP 端口。

## 验证

```powershell
npm test
npm run dsh:check
npm pack --dry-run
```

`tests/dsh-workspace.test.mjs` 验证路径与链接隔离、任务快照、新文件版本、重启续跑、参考索引与防覆盖导出；SDK 启用时使用真实 DSH LocalFileSystem。`tests/dsh-ui-bridge.test.mjs` 使用真实 Client/Host SDK 检查严格 Remote 编解码、服务注入和页面不追加聊天 JSON。`tests/dsh-workbench.test.mjs` 在禁止 HTTP 的条件下用隔离数据库验证项目创建、批次翻译、原格式导出和数据库重开；`tests/migrate-local.test.mjs` 验证迁移一致性、防覆盖与源变化检测。DSH SDK 可用时，`tests/dsh-model-adapter.test.mjs` 验证消息协议，`tests/dsh-agent.test.mjs` 验证预设工具范围。原上游的浏览器／Directus 集成测试仍有相应环境条件，跳过项不计作验证通过。

UI 必须在真实 DSH 中截图验收；独立 HTML 预览不作为运行成功的证据。

Host 使用的 DSH SDK 在 manifest 中声明为可选 peer，由运行中的 DSH 提供，避免安装另一套 Host 服务。开发环境验证模型协议时可将 `DSH_TEST_LLM_MODULE` 指向同版本 DSH SDK 的 `lib/index.js` 文件 URL。

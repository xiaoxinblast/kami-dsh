# DSH 本地翻译工作台

`kami-dsh` 是 `xiaoxinblast/kami` 的独立衍生项目，保留上游 Git 历史。目标语向为日语→简体中文。

## 安装

当前验证目标为 DSH `0.2.1-rc.2`（桌面 Electron `44.7.0` / Node `24.21.0`）。

1. 在 DSH 的“插件”→“添加插件”中填写 `https://github.com/xiaoxinblast/kami-dsh#main`，安装仓库中的当前版本。依赖由插件管理器安装。
2. 开发时也可在仓库运行 `npm ci`、`npm run dsh:check` 后安装绝对目录；Creator 模式的 `plugin_manager` 使用 `action: install_bundle` 与同一安装地址。
3. 从侧边栏打开“Kami 翻译工作台”。展开“翻译 agent 会话”，填写工作目录并点“新建翻译会话”，自动使用专用预设；也可手动新建会话并选择“Kami 翻译工作台”预设。
4. 选择关联会话和翻译项目。在工作台操作文件，或通过“发送给翻译 agent”委托任务，在关联会话查看工具调用与回复。

插件只通过 DSH 的管理入口安装，不修改 `app.asar`。更新已加载的 Host 模块后，按插件管理结果处理需要的重启；不要把“依赖已保存”当作已经生效。

GitHub 安装不是自动更新。当前 DSH 对第三方插件要求先卸载旧程序包，再安装仓库地址；管理器会报告是否需要重启。本地资产位于独立的数据目录，卸载程序包不删除资产。也可安装明确的发布标签，把运行版本固定到已验收的提交。更新程序包不会把本地数据库或上传文件放进 GitHub。

若插件页热卸载报告 `profile reload requires the root Include entry`，退出 DSH 后可通过它自带的 CLI 更新程序包。已注册 `dsh` 命令时运行以下命令，再启动桌面端；未注册时可调用安装目录下的 `resources/runtime/cli/bin/dsh.cmd`：

```powershell
dsh plugin --profile desktop remove kami-dsh
dsh plugin --profile desktop add 'github:xiaoxinblast/kami-dsh#main'
```

## 本地数据

数据位于 `$DSH_HOME/kami-dsh/<profile>/`，默认桌面 profile 为 `desktop`。

- `kami.sqlite`：项目、术语、TM、QA、风格、参考资料和学习记录。
- `uploads/`：导入原文件与参考资料。
- `runtime/`：参数设置与日志，不保存模型 API Key。
- `learning/`：配对评测检查点。
- `exports/`：agent 导出的文件。
- `backups/`：从工作台创建的数据库备份。

数据库备份使用 SQLite 在线备份接口；迁移和完整人工备份还需保留 `uploads/`、`learning/` 与 `runtime/settings.json`。恢复应在插件停用时进行，使用备份数据库替换 `kami.sqlite`，同时恢复对应文件目录。

正常工作不启动 Kami HTTP 服务，不连接 Directus，也不依赖 Docker。业务入口在 DSH Host 内执行，SQLite 是正式存储。旧仓库的 HTTP 路由被复用为进程内操作分发，以保留现有翻译、QA、学习与导出行为。

## 一次性迁移

仅迁移时需要旧 Directus 临时可用。先关闭旧工作台的写入操作，再运行：

```powershell
npm run migrate:local -- --source-env '<旧项目>\directus\.env' --source-data '<旧运行目录>\data' --source-data '<旧源码目录>\data'
```

可用 `--destination '<目标数据目录>'` 指定独立目录。工具仅读取旧后台，不更改旧记录；会逐集合读取两遍并比较内容哈希，校验引用文件和数据库完整性后才发布正式数据库。重复执行仅接受与源数据完全相同的目标库，已有不同内容会拒绝覆盖。

结果写入本地 `migration-report.json`。`status: verified` 才表示完成；缺文件、冲突、权限不足或源数据变化均使迁移失败。账号凭据和旧分享链接不迁入。

## 翻译闭环

先导入或粘贴文件，确认分段后开始翻译。任务保留文件级工作术语、句式一致性、硬 QA、AIQA、修订和批次检查。用户可修改译文并主动采纳为正式译法，写入人工批准 TM 与学习证据；风格和策略仍走既有配对评测及激活门禁。

### 上传风格指南

选择项目后打开“风格指南”页，选择 `.txt`、`.md` 或 `.docx` 文件，再点击“导入并立即启用”。文件最大 5 MB，正文最多 50,000 字。选择文件本身不会更改生效指南；切换项目或关联会话后需要重新选择文件。

人工指南提取可读取的正文，不经过模型改写；导入后用于当前项目的翻译和 QA。新版启用后，旧版保留为历史记录。页面显示当前状态、版本和可展开的指南全文；自动学习生成的风格规范仍在“学习”页。

模型优先使用关联会话待生效的模型选择，其次是最近一次请求的 provider/model，新会话使用 DSH 默认模型。所有调用经过 DSH 模型服务，不另存模型 Key。固定 seed 不可用会明确标记，截断、错误和取消会转为失败，不能算作成功译文。图片识别通过 DSH 附件协议保存和发送图片，需要关联会话所选模型支持图像输入；不支持时任务报告失败。

工具和页面调用相同业务操作。页面通过独立的 DSH Remote 调用，不向关联会话追加命令或 JSON 记录；关联会话仅提供工作目录和模型选择，以及接收明确发送的 agent 任务。agent 使用 `kami_workbench`、`kami_file_import`、`kami_help`。批准、正式采纳、激活和删除保留为用户操作。大结果分页读取；导出文件返回本地路径，不把二进制塞进模型上下文。手动执行 `/kami` 仍保留 DSH 的命令日志。

专用预设过滤挂载时已有的 Host 通用工具，保留 Kami 工具向会话继承，并使用原生工具调用；该限制只作用于 Kami 预设。DSH 另行注入的会话级工具仍依宿主配置。批次翻译与 QA 的内部调用也在进程内分发，不回调本机 HTTP 端口。

## 验证

```powershell
npm test
npm run dsh:check
npm pack --dry-run
```

`tests/dsh-workbench.test.mjs` 在禁止 HTTP 的条件下用隔离数据库验证项目创建、批次翻译、原格式导出和数据库重开；`tests/migrate-local.test.mjs` 验证迁移一致性、防覆盖与源变化检测。DSH SDK 可用时，`tests/dsh-model-adapter.test.mjs` 验证消息协议，`tests/dsh-agent.test.mjs` 验证预设工具范围。原上游的浏览器／Directus 集成测试仍有相应环境条件，跳过项不计作验证通过。

UI 必须在真实 DSH 中截图验收；独立 HTML 预览不作为运行成功的证据。

Host 使用的 DSH SDK 在 manifest 中声明为可选 peer，由运行中的 DSH 提供，避免安装另一套 Host 服务。开发环境验证模型协议时可将 `DSH_TEST_LLM_MODULE` 指向同版本 DSH SDK 的 `lib/index.js` 文件 URL。

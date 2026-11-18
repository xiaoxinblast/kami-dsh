# DSH 有界兼容与 Windows 回归

Kami `0.9.37` 的引擎与全部十项 DSH peers 统一为 `>=0.2.2-rc.2 <0.2.3-0`。这包含后续 `0.2.2` RC 和正式版，不包含 `0.2.3-0`、`0.2.3-rc.1` 或更高版本。范围内准入不等于所有未来版本已经实测。保留下界的条件是同一 tarball 在 rc.2 和 rc.3 上均通过本插件自己的隔离测试；不能借用其他插件的结果。

本实现复用了 [RAG Memory 试点的固定提交](https://github.com/xiaoxinblast/DSH-RAG-Memory/tree/6c0ea2fb3ed4b2588b7fcceddf076407920f5b17) 的 release 选择、运行历史查重和普通 npm 隔离安装结构；实际宿主测试改为 Kami 的服务与合成文档流程。

## 触发与边界

`.github/workflows/dsh-compatibility.yml` 每天 **07:41 UTC** 检查，也可手动运行：

- `version` 可填精确官方版本，如 `0.2.2-rc.4`，或带 `dsh-v` 前缀；留空时选择最高的已发布 RC 或正式版。
- 分页调用 `deepseek-ai/deepseek-harness` 的官方 **List releases**，不用 `/latest`，不依赖本仓库的 Release 事件。忽略草稿、未发布项、其他产品标签、alpha/beta 等非 RC 预发布标签。
- 同一插件 SHA 下，查询该工作流已完成的 `Windows smoke (<版本>)` job。成功、失败、取消均算一次尝试；跳过或未完成不算。新插件 SHA 会重新检查。并发组串行化选择和测试。
- 手动勾选 `retry` 才重复已完成的尝试；若人工删除运行历史，相应查重记录也会消失。查重不使用可被淘汰的缓存，也不依赖 artifact 保留期。
- 范围外版本记录 `needs-validation` 并使选择 job 失败，不运行安装和激活。未知或未正式发布的精确标签也失败。必须另行修改、验证并提交范围，工作流不会自动放宽或豁免。

定时运行可能被 GitHub 延迟或停用；添加 schedule 不等于已经收到过定时触发。手动验证和定时验证应分别核对 Actions 运行记录。

## 运行内容

选择 job 先运行选择器、严格上界和去重回归。Windows job 先运行项目完整的可移植回归，然后执行 `scripts/ci/windows-smoke.ps1`：

1. 执行 `npm run dsh:check`，以离线、禁止生命周期脚本的 `npm pack` 打包。
2. 在 `.cache/compatibility/<版本>/install/<tarball SHA256>/` 通过普通 npm 安装 tarball、精确的官方 SDK 服务和全部直接 DSH peers。不使用 `--force`、`--legacy-peer-deps` 或兼容豁免。
3. 核对实际解析出的每个 DSH peer 都是所选精确版本，防止 npm 静默选择另一版。
4. 以真实官方 boot、Loader 和 profile 预检激活安装后的 Host 与四个工具入口，核对 Typert Remote 和浏览器构建入口。
5. 在独立 `DSH_HOME`、`DSH_AGENTS_HOME`、数据目录和凭据目录下，用真实 Session、AgentModel、受限文件服务和 SQLite 绑定合成项目，解析 TXT 和 DOCX，创建并回读批次，核对原件未改，重启后绑定仍可回读。

凭据服务为空，未注册任何模型适配器。烟测预加载器禁止 fetch、HTTP、HTTPS、socket 和 TLS 请求，包括回环；若发生任何请求，会记录并失败。安装阶段仅获取 npm 依赖，运行阶段不联网、不调用模型、不读取真实项目或邮件、不连接日用 DSH。完整桌面窗口交互及真实模型质量、耗时未覆盖。

## 固定依赖、权限与证据

- GitHub 托管 `windows-2022`；Node `24.21.0`、npm `11.12.1`。
- checkout、setup-node、upload-artifact 均固定到已核对的完整官方提交 SHA；checkout 不保存 Git 凭据。
- 根目录直接运行依赖固定到原锁文件的精确版本，SemVer 固定 `7.8.5`，开发安装用提交的锁文件与 `npm ci --ignore-scripts`。
- 所选 SDK 的直接包固定为精确 release 版本。其上游传递依赖仍由 npm 正常解析，完整解析锁文件作为 artifact 保存；它不是桌面安装包的逐字节镜像。
- 工作流仅有 `contents: read`、`actions: read`。GitHub API token 只传给选择步骤；Windows job 只有 `contents: read`。没有仓库写权限、Issue/PR 操作、外部密钥或模型凭据，不发布 GitHub Release，不部署插件。

Summary 和 artifact 记录 DSH 版本、插件提交 SHA、声明范围、tarball SHA256 及结果；保留 tarball、pack 清单、隔离安装锁文件、运行报告与网络日志，保留期 30 天。不会上传数据库、凭据目录或浏览器资料。SDK 尚未发布、依赖下载、激活或功能断言失败均是失败，不能算兼容通过。

## 本地复现同一个安装包

```powershell
npm ci --ignore-scripts --no-audit --no-fund
./scripts/ci/windows-smoke.ps1 -Version 0.2.2-rc.2
$archive = (Resolve-Path .cache/compatibility/0.2.2-rc.2/kami-dsh-0.9.37.tgz).Path
./scripts/ci/windows-smoke.ps1 -Version 0.2.2-rc.3 -Archive $archive
```

两个 `result.json` 的 `archiveSha256` 必须相同且均为 `passed`。`-Archive` 仅用于复用已经打好的同一包；正常 Actions 会从当前提交重新打包。测试加载器只在本测试进程解析指定的完整 SDK，不修改日用 profile 或原 SDK。

# Windows 版本发布

## 当前分发渠道

佳剪 Windows x64 公开安装版从 `Showrenzhe/jiajian` 的 GitHub Releases 获取更新。默认通道为「稳定」，可在设置的「软件更新与通道」中切换。[公开版本列表](https://github.com/Showrenzhe/jiajian/releases)

| 通道 | 发布标签 | 更新清单 | GitHub 发布标记 |
| --- | --- | --- | --- |
| 稳定 | `v主版本.次版本.修订号` | `latest.yml` | Latest |
| 预览 | `v主版本.次版本.修订号-preview.序号` | `preview.yml` | Pre-release |

稳定通道只接收正式版。预览通道允许接收预览版。切回稳定通道后，可等版本号高于当前预览版的正式版再更新。

### 检查更新

默认在每次启动时检查，持续运行期间每隔 24 小时可再检查。在「软件更新与通道」可改为「启动时及每 3 天」「启动时及每周」或「仅手动」。启用自动检查时，佳剪每小时判断一次是否到期，窗口重新获得焦点、电脑从睡眠恢复时也会判断。手动检查同样会重新计算间隔。

要手动检查，在标题栏打开「软件更新」，点「检查更新」或「再次检查」。发现新版后点「下载更新」，下载完成后点「保存并重启更新」。

### 从旧版升级

- 公开安装版 0.8.x 可从「软件更新」下载新版并保存草稿、重启安装。
- 已安装内部离线版 0.9.0 的同事，请保存草稿并退出佳剪，从公开发布页下载 `Jiajian-Setup-0.9.0-x64.exe`，手动覆盖安装一次。重开后从「最近草稿」继续编辑，后续版本可在应用内更新。[0.9.0 发布页](https://github.com/Showrenzhe/jiajian/releases/tag/v0.9.0)
- 从离线 ZIP 换用安装版时，先备份并迁移旧程序旁的 `run-data`。[从离线 ZIP 迁移](migration.md#从离线-zip-迁移)

## 构建与发布

1. 在发布 PR 中核对 `package.json` 的版本及 `release-notes/v版本.md` 的更新说明，等 Windows 检查通过并合入 main。
2. 在已合入 main 的发布提交上创建并推送对应标签，例如 `v0.9.0`。Actions 检查版本和提交，安装依赖，校验 FFmpeg 与许可，运行单元和更新测试，再生成并核对安装包。
3. 发布作业创建 GitHub Release 草稿，仅上传 Windows x64 安装包、同名 `.blockmap` 和对应通道的 YAML 清单。三份附件的 SHA-256 与构建目录相符、发布正文与应用更新说明一致后，草稿转为公开版本。
4. 若上传中断，在 Actions 的「发布佳剪 Windows 版本」中选择同一标签重跑。脚本会续用草稿，发现额外附件时停止并要求核对。已公开的同版本重跑只复查发布记录。

在 Windows 上可用 Node.js 24、Visual Studio C++ 构建工具和 Windows SDK 本地复核产物。若需自定义输出目录，在构建命令末尾追加 `"-c.directories.output=目录绝对路径"`，运行校验前再将 `$env:JIAJIAN_DIST_DIR` 设为同一目录。

```powershell
npm ci
./scripts/prepare-release-tools.ps1
npm test
npm run test:updates
./test/release-publish.test.ps1
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
node scripts/release-notes.cjs "v$version" "$env:TEMP/jiajian-notes.md"
npm run dist:win -- "-c.releaseInfo.releaseNotesFile=$env:TEMP/jiajian-notes.md"
node scripts/verify-release.cjs "$env:TEMP/jiajian-notes.md"
```

## 升级验收

1. 正式版公开后，用 0.8.x 公开安装版打开「软件更新」，核对版本和更新说明，再下载。在重启安装前保存测试草稿，升级后核对版本号、素材和草稿。
2. 在此前使用离线版 0.9.0 的测试机上先保存草稿并退出，运行公开版同版本安装包覆盖一次，重开原工程。下一个版本公开后核实能在应用内检查并安装更新。
3. 发布预览版时，在低版本测试机分别检查两个通道。预览通道可收到对应预览版，稳定通道继续显示正式版。已安装预览版的用户可等版本更高的正式版，或备份工程后手动安装所需正式版。
4. 需要回退时，备份工程和素材，退出佳剪，从版本列表安装上一稳定版，再用升级前的工程副本检查画面与口播。

## 公开源码的合并检查

合入 `main` 前，作者完成自检，负责人按开发指南核对 PR 及两项必需检查。[合并规则](development.md#合并规则)

管理员可在临时 PR 中提交一个确定失败的测试，确认合并受阻。恢复测试后，等 `Windows / 单元与桌面冒烟` 和 `Windows / 大工程帧间隔` 都通过，再关闭演练 PR。

## 公开安装包检查记录

2026-11-24 检查了当日仍公开的十个 Windows x64 安装包。逐包核对发布清单的 SHA-256、解开安装包和 app.asar，检查自有源码及包清单中的常见密钥特征、内网 IPv4 地址，以及工程、证书、环境配置和常见测试媒体文件名。

| 版本 | 核对的自有文本文件数 | 规则命中 |
| --- | ---: | ---: |
| v0.8.9 | 94 | 0 |
| v0.8.8 | 94 | 0 |
| v0.8.7 | 94 | 0 |
| v0.8.6 | 94 | 0 |
| v0.8.5 | 94 | 0 |
| v0.8.4 | 94 | 0 |
| v0.8.3 | 93 | 0 |
| v0.8.2 | 84 | 0 |
| v0.8.1 | 83 | 0 |
| v0.8.0 | 83 | 0 |

范围包括当前可下载的安装包。该记录无法判断已下载副本的去向、历史已撤回附件或第三方二进制中的任意内容。

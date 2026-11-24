# 发布佳剪 Windows 正式版

安装程序面向 Windows x64，更新源是公开仓库 Showrenzhe/jiajian 的正式 Release。安装版、应用内更新和 GitHub 发布说明共用版本标签。普通源码提交和分支推送用于开发。旧离线 ZIP 用户的迁移步骤见 [README](../README.md#启动)。

## 准备版本和说明

1. 在 Windows 上安装 Node.js 24 或更新版本和 Git。确定版本号后，使用 `npm version <版本号> --no-git-tag-version` 同步修改 package.json 与锁文件，将功能改动和这两个文件一起提交。
2. 运行 `node scripts/release-notes.cjs v<版本号>` 预览更新说明。默认取当前提交历史中低于本版的最高正式标签，汇总此后已合入的非合并提交标题。请用中文在提交标题里写清用户能看到的变化，例如「修复口播轨移动后波形位置未同步」。
3. 若要合并同类条目或补充迁移步骤，可将预览保存为 `release-notes/v<版本号>.md` 后编辑并提交。该文件优先于提交标题。构建从同一份正文生成应用内更新说明与 GitHub Release 正文，适合在打标签前审阅。

## 在本地验证

从仓库根目录打开 PowerShell 7。下列命令使用 package.json 的版本，仅在本机生成安装包。

```powershell
npm ci
./scripts/prepare-release-tools.ps1
$bin = (Resolve-Path 'tools/ffmpeg-8.0-full_build/bin').Path
$env:SUPERDIR_REPLICA_FFMPEG = Join-Path $bin 'ffmpeg.exe'
$env:SUPERDIR_REPLICA_FFPROBE = Join-Path $bin 'ffprobe.exe'
$env:PATH = "$bin;$env:PATH"
npm test
npm run test:desktop
npm run test:updates
node --test test/release-workflow.test.cjs
./test/release-publish.test.ps1
$tag = 'v' + (Get-Content -Raw package.json | ConvertFrom-Json).version
$notes = Join-Path $env:TEMP "jiajian-$tag.md"
node scripts/release-notes.cjs $tag $notes
npm run dist:win -- "-c.releaseInfo.releaseNotesFile=$notes"
node scripts/verify-release.cjs $notes
```

GitHub Actions 从官方 v0.8.3 Windows x64 安装包恢复 FFmpeg 8、FFprobe、LICENSE 和 README.txt。工作流先核对安装包的 SHA-256，再解出这四个文件并逐项核对。首次在本地构建时，若缺少这些文件，可安装 7-Zip 并将 `7z.exe` 加入 PATH，在仓库根目录设置 `$env:RUNNER_TEMP = $env:TEMP`，然后执行工作流「恢复已校验的离线工具」中从下载安装包到 `./scripts/prepare-release-tools.ps1` 的命令。如果保存了原版 v0.6.2 离线 ZIP，也可用 `./scripts/prepare-release-tools.ps1 -Archive <ZIP路径>` 恢复。本地文件齐备后，准备脚本直接校验它们。仓库 vendor 目录提供 PySceneDetect 及其 Python 运行库、Whisper 模型、人声分离及前景模型。[v0.8.3 官方安装包](https://github.com/Showrenzhe/jiajian/releases/tag/v0.8.3) · [恢复步骤与固定校验值](../.github/workflows/release-windows.yml)

## 发布与重跑

将正式版源码合入 main 后，在准备发布的提交上创建并推送 `v主版本.次版本.修订号` 标签。GitHub Actions 会启动「发布佳剪 Windows 正式版」，先确认标签提交已合入 main，再开始构建。修复构建流程后需要重跑既有标签时，在 Actions 页手动运行该工作流，为工作流选择已合入修复的 `main` 分支，在 `tag` 输入框填原正式标签。这样会使用更新后的工作流，从原标签构建并发布。仓库的 Actions 需允许工作流使用 `contents: write` 创建发布草稿和上传附件。

工作流从标签重新检出完整历史、测试并生成下列三个文件。佳剪在安装前使用更新清单中的 SHA-512 核对安装包。

| 附件 | 用途 |
| --- | --- |
| `Jiajian-Setup-版本号-x64.exe` | 首次安装和升级 |
| `Jiajian-Setup-版本号-x64.exe.blockmap` | 差分下载使用的分块映射 |
| `latest.yml` | 安装包名称、体积、SHA-512、版本和本版更新说明 |

工作流检查本地安装包、清单、更新正文和离线引擎后，将三项附件上传到发布草稿。GitHub 返回的三个 SHA-256 都与本地一致后，工作流才公开该版本。上传中断时，可在 Actions 中重跑同一标签，工作流会补齐草稿。如果正式版已经成功公开，重跑会核对现有附件与正文后结束。正式版已公开后，需要修正程序或说明时，请用新版本号发布。

# Windows 内部更新

佳剪源码仓库保持公开，已有 GitHub Releases 和附件继续保留。自 0.9.0 起，内部 Windows 安装包在本地 Windows 机器构建，通过公司内部目录或内部 HTTPS 更新服务分发。新版工作流合入后，公开仓库的 Actions 运行代码检查和测试，内部安装包构建作业会跳过。

发布负责人为一个版本开一个发布 PR，把同类小修复合并写入 `release-notes/v版本.md`。在本地给确定的发布提交打上与 package.json 对应的标签即可构建。稳定版采用正常语义版本，预览版采用例如 `0.9.0-preview.1` 的预发布版本。

**新版工作流合入公开仓库前，内部版本标签仅留在本机。** 旧版 `release-windows.yml` 监听 `v*.*.*` 标签推送，推送正式版标签会触发公开发布流程。推送源码分支时避免使用 `--tags`、`--follow-tags` 或附带内部标签的推送配置。

## 构建

在 Windows 安装 Node.js 24、Visual Studio C++ 构建工具与 Windows SDK，执行以下命令。

```powershell
npm ci
./scripts/prepare-release-tools.ps1
npm test
npm run test:smoke
npm run dist:win
node scripts/verify-release.cjs
```

未配置更新地址时可以离线安装。自定义打包输出目录时，用 `JIAJIAN_DIST_DIR` 指定校验目录。需要联网更新时，在构建进程中把 `JIAJIAN_UPDATE_URL` 设为管理员提供的内部 HTTPS 目录。该目录的访问控制由公司网关、VPN 或服务器负责。地址不能包含用户名、密码或查询串。请在测试安装机上先确认可以访问该目录，再构建安装包。

为正式构建准备更新说明，并传给 electron-builder。

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
node scripts/release-notes.cjs "v$version" "$env:TEMP/jiajian-notes.md"
npm run dist:win -- "-c.releaseInfo.releaseNotesFile=$env:TEMP/jiajian-notes.md"
node scripts/verify-release.cjs "$env:TEMP/jiajian-notes.md"
```

## 分发与回退

没有内部更新服务时，管理员通过公司内部目录提供已校验的离线 EXE。接入内部 HTTPS 后，管理员在本地检查带更新源的安装包，再运行 `scripts/publish-release.ps1 -Tag v版本 -Notes 说明文件 -Destination 内部服务器对应的目录绝对路径`。该命令先校验安装包与差分映射，然后替换稳定通道的 `latest.yml` 或预览通道的 `preview.yml`，并保留以前的安装包供回退。

更新入口在「设置 → 软件更新与通道」。默认稳定通道，在启动时及每 24 小时检查。可选每 3 天、每周或仅手动。发现版本后由用户选择下载、保存并重启。需要回退时，先备份工程和素材，退出佳剪，从内部历史目录安装上一个稳定版；避免使用旧版保存新版创建的工程，直至确认兼容。

## 内部 HTTPS 升级验收

1. 管理员提供真实内部 HTTPS 目录后，在同事实际使用的网络环境中确认测试机可访问。构建时通过本机环境变量注入地址。
2. 用同一个地址构建两个递增版本。先在测试机安装较低版本，再将较高版本及其通道清单放入服务器目录。核实两个版本的安装包都已留存。
3. 在测试机打开「设置 → 软件更新与通道」，选择对应通道。检查新版本、下载且通过校验后，保存草稿并重启，核对版本号及重新打开的草稿。
4. 真机试通后，向使用旧公开版或 0.9.0 离线版的同事分发一次带内部更新源的安装包，后续版本经所选通道更新。

## 公开源码的合并检查

main 分支的建议规则为经 PR 合并、至少一人批准并通过 `Windows / 单元与桌面冒烟`。管理员可用临时 PR 提交一个确定失败的测试，确认合并受阻，恢复测试后验证检查通过并关闭演练 PR。

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

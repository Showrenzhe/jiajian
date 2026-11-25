# Windows 内部更新

安装包与工程材料仅供内部使用。发布负责人为一个版本开一个发布 PR，把同类小修复合并写入 `release-notes/v版本.md`，合并后再为该提交创建与 package.json 相同的标签。稳定版采用正常语义版本，预览版采用例如 `0.9.0-preview.1` 的预发布版本。

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

管理员检查安装包后运行 `scripts/publish-release.ps1 -Tag v版本 -Notes 说明文件 -Destination 内部服务器对应的目录绝对路径`。该命令先校验安装包与差分映射，然后替换稳定通道的 `latest.yml` 或预览通道的 `preview.yml`，并保留以前的安装包。私有仓库也可以手动运行内部构建工作流，下载校验后的 Actions 产物，再用同一流程在内网分发。

更新入口在「设置 → 软件更新与通道」。默认稳定通道，在启动时及每 24 小时检查。可选每 3 天、每周或仅手动。发现版本后由用户选择下载、保存并重启。需要回退时，先备份工程和素材，退出佳剪，从内部历史目录安装上一个稳定版；避免使用旧版保存新版创建的工程，直至确认兼容。

## 内网试通与仓库切换

1. 在公司网内用内部地址构建一版测试安装包，确认带有相应的稳定或预览通道配置。用旧版本测试安装机验证检查、下载、校验、保存草稿并重启到新版本。
2. 核实团队已保留当前及上一版安装包。原公开更新器不能自动发现新地址，先向同事分发已带内网地址的安装包。
3. 由仓库管理员按约定切换为私有，退出账号检查仓库和旧发布页面返回 404。
4. 在 main 分支规则启用必须经 PR 合并、至少一人批准并要求通过 `Windows / 单元与桌面冒烟`。管理员用临时 PR 提交一个确定失败的测试，确认合并受阻，恢复测试后验证检查通过并关闭演练 PR。

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

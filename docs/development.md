# 开发指南

在 Windows x64 上使用 Node.js 24，运行 `npm ci`，然后 `npm start`。离线开发目录也可双击 `启动佳剪.cmd`。旧名 `启动编导工作台.cmd` 是同一启动入口的兼容名称。

## 媒体工具

运行 `./scripts/prepare-release-tools.ps1` 准备项目固定版本的 FFmpeg 8 和 FFprobe。单独运行 Node 测试时，应把 `tools/ffmpeg-8.0-full_build/bin` 加入当前进程的 PATH。也可用 `JIAJIAN_FFMPEG` 和 `JIAJIAN_FFPROBE` 指定绝对路径，历史 `SUPERDIR_REPLICA_*` 变量仍可读。各离线引擎的来源、版本和权重说明保存在 `vendor` 对应目录的 README 中。

## 验证

| 命令 | 用途 |
| --- | --- |
| `npm test` | 自动发现 Node 单元测试，含真实媒体输出 |
| `npm run test:smoke` | PR 使用的桌面冒烟 |
| `npm run test:full` | 所有 Node 测试及独立 Electron 桌面场景 |
| `npm run bench:frames` | 前台测量连续操作帧间隔 |
| `npm run bench:large` | 在 200 个分镜、1,000 个候选及 200 秒口播工程中采样，再生成并滚动 1,000 行预览 |
| `npm run typecheck` | 检查已补 JSDoc 的工程格式、时间、媒体与源剪辑逻辑 |
| `npm run lint` | 检查源代码、脚本和测试 |
| `npm run format -- 文件路径` | 用仓库 Prettier 配置整理指定文件 |

修改工程结构时，增加对应格式版本、迁移逻辑和旧工程重开回归。对媒体与时间线变更同时检查预览、保存重开和成片。提交前按 PR 模板核对主进程、preload、持久化和媒体参数，并为高风险改动安排人工评审。[构建与发布](windows-release.md)

## 本机运行记录

帧间隔报告写入 `run-data/benchmarks/standard.json` 或 `large.json`。在前台保持佳剪窗口可见，暂时关闭其他负载。报告包含 Electron、CPU、显示刷新率、缩放、GPU 适配器与合成状态，并列出各操作的 P95 和超过 25 ms 的间隔数。大工程含 5 条视频轨。批量列表另用 5 镜组合生成 1,000 个可选择结果，采样真实滚轮、窗口行数及筛选后的选择状态。

CI 保存本次大工程报告，下载上一次成功主线推送的未过期报告。图形适配器、刷新率、缩放、合成状态和工程规模相同时，若任一场景 P95 同时增加超过 20% 和 2 ms，检查标红。没有可比基线时保存本次数据。可在开发机用 `node scripts/compare-bench.cjs 旧报告.json 新报告.json` 复核。Windows 集成显卡机可直接运行同一命令生成报告；私有仓库也可手动选择在已配置好桌面会话、Node 24 的 `integrated-graphics` 运行器上采样。

Windows 应用容器需对 `node_modules/electron/dist` 有读取和执行权限。开发机曾因该目录 ACL 无法启动沙箱渲染器，补足此目录读取执行权限后可在普通桌面会话运行测试。

各场景实测值和本机显卡、刷新率记录见 [Windows 前台交互基线](benchmarks/README.md)。

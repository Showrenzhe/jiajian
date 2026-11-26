# 开发指南

在 Windows x64 上使用 Node.js 24，运行 `npm ci`，然后 `npm start`。离线开发目录也可双击 `启动佳剪.cmd`。旧名 `启动编导工作台.cmd` 是同一启动入口的兼容名称。

## 媒体工具

用 `JIAJIAN_FFMPEG` 和 `JIAJIAN_FFPROBE` 可分别指定可执行文件的绝对路径。旧名 `SUPERDIR_REPLICA_FFMPEG` 和 `SUPERDIR_REPLICA_FFPROBE` 保留到下一个次版本。同一工具同时设置新旧变量时优先读取新名。用到旧名时，每个进程在日志中提示一次。

未配置变量时，安装版使用安装目录 `resources/tools/ffmpeg-8.0-full_build/bin` 下的程序。源码运行和独立 Node 测试先使用仓库 `tools/ffmpeg-8.0-full_build/bin` 下的对应程序，缺少时从 PATH 查找。Windows 上可运行 `./scripts/prepare-release-tools.ps1` 准备固定版本。各离线引擎的来源、版本和权重说明保存在 `vendor` 对应目录的 README 中。

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

修改工程结构时，增加对应格式版本、迁移逻辑和旧工程重开回归。对媒体与时间线变更同时检查预览、保存重开和成片。[构建与发布](windows-release.md)

## 合并规则

1. 每个 PR 只处理一个任务，建议最多改动 30 个文件。超过时，作者在 PR 描述里说明为什么不拆分。
2. 作者提交 PR 前重读完整 diff，对照安全基线检查，并逐项填写模板中的“自检结论”。已完成的项目逐项勾选，不适用的项目逐项说明原因。遇到未验证的项目，在“未验证项”中说明原因和影响。
3. 负责人合并前至少打开一次 PR 的 `Files changed`，逐个查看本次改动的高风险文件，包括 `src/main.cjs`、`src/preload.cjs`、`src/draft-store.cjs`、`src/project-format.cjs`、`src/media.cjs`、`src/packaging.cjs` 以及 `.github/workflows/`、`scripts/` 下的文件，并核对作者对各文件的说明。
4. 等 PR 最新提交的 CI 全部通过，由负责人确认后合并到 `main`。下面列出的两项必需检查都要运行成功，不得跳过检查或强制合并。项目不设第二评审人。

### 仓库管理员设置

仓库管理员在 GitHub 的 Settings 中逐项设置，保存后核对。

- [ ] 在 Branches 中为 `main` 设置分支保护，要求通过 PR 合并，并将 `Windows / 单元与桌面冒烟`、`Windows / 大工程帧间隔` 同时列为必需状态检查。
- [ ] 在同一条规则中关闭允许强制推送和允许删除，禁止强制推送或删除 `main`。
- [ ] 在 PR 规则中保持“需要审批”（Require approvals）关闭，由负责人按上述规则确认合并。
- [ ] 在 Actions → General 中，将外部贡献者 Fork PR 工作流的运行审批范围设为所有外部贡献者，保存后由有写入权限的成员手动批准运行。

## 本机运行记录

帧间隔报告写入 `run-data/benchmarks/standard.json` 或 `large.json`。在前台保持佳剪窗口可见，暂时关闭其他负载。报告包含 Electron、CPU、显示刷新率、缩放、GPU 适配器与合成状态，并列出各操作的 P95 和超过 25 ms 的间隔数。大工程含 5 条视频轨。批量列表另用 5 镜组合生成 1,000 个可选择结果，采样真实滚轮、窗口行数及筛选后的选择状态。

CI 保存本次大工程报告，下载上一次成功主线推送的未过期报告。图形适配器、刷新率、缩放、合成状态和工程规模相同时，若任一场景 P95 同时增加超过 20% 和 2 ms，检查标红。没有可比基线时保存本次数据。可在开发机用 `node scripts/compare-bench.cjs 旧报告.json 新报告.json` 复核。在公司 Windows 集成显卡机器上使用前台桌面会话运行 `npm run bench:large`，即可生成该机的报告。

Windows 应用容器需对 `node_modules/electron/dist` 有读取和执行权限。开发机曾因该目录 ACL 无法启动沙箱渲染器，补足此目录读取执行权限后可在普通桌面会话运行测试。

各场景实测值和本机显卡、刷新率记录见 [Windows 前台交互基线](benchmarks/README.md)。

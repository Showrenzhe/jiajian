# 本地安全边界与回归

| 入口 | 当前行为 | 验证位置 |
| --- | --- | --- |
| 桌面窗口 | 沙箱与上下文隔离开启，Node 集成关闭。页面通过固定命名的 preload 接口与主进程通信。CSP 只接收本地脚本和应用媒体协议。 | `src/desktop.cjs`、`src/preload.cjs`、`src/ui/index.html` |
| IPC 与文件访问 | 处理器核对窗口、页面地址和顶层发送帧。文件操作使用主进程目录选择器、已登记的素材或工程编号，以及功能对应的输入校验。共享路径需显式选择或拖入，使用前复查根目录、真实路径和类型。工程内的离线引用可以保存，读取共享文件需先获得授权。 | `test/lan-material-desktop.cjs`、`test/project-format.test.cjs` |
| 外部链接 | 配音服务的开发者页面使用固定 HTTPS 地址。Windows 安装管理通过系统 Explorer 的固定参数打开。窗口阻止外来导航和新窗口。 | `src/desktop.cjs`、`test/software-update-desktop.cjs` |
| 本地媒体 | 子进程接收参数数组。字幕与文字写入私有任务目录中的固定名 UTF-8 文件，文字滤镜关闭变量展开。配置中的数字、枚举、颜色和裁切范围在生成滤镜前校验。 | `src/media.cjs`、`src/cover.cjs`、`src/packaging-render.cjs`、`test/import-security.test.cjs` |
| 文件导入 | SRT 限制 256 KiB，工程内容限制 1 MiB。工程封面独立验证 JPEG 和 256 KiB 二进制上限。读取器限制实际读取字节并严格解码 UTF-8。 | `src/subtitles.cjs`、`src/project-format.cjs`、`test/import-security.test.cjs` |
| 配音与创作 | 密钥交给系统 safeStorage，加密后仅存于用户设置。请求使用 HTTPS，设置超时，并支持取消。开发测试需要显式启用数字回环地址才能使用 HTTP。 | `src/cloud-tts-settings.cjs`、`src/cloud-tts.cjs`、`src/creative-service.cjs`、`test/cloud-tts.test.cjs` |
| 诊断 | 记录媒体程序类别、参数名称、退出码、预定义的错误摘录与进程退出原因。设置里可导出系统、图形设备与最多 200 条近期事件，参数值、路径和密钥均在记录时省略。 | `src/diagnostics.cjs`、`test/diagnostics.test.cjs`、`test/performance-desktop.cjs` |

在仓库根目录运行 `npm test` 执行离线单元与媒体回归，运行 `npm run test:desktop` 检查实际窗口、共享文件授权、保存和导出流程。

# 工程时间模型

生成预览和导出已选共用一份成片计划。排查切点时，先确认坐标属于原素材、成片画面还是口播音频。同一个数值 `start` 在视频裁剪区间表示源文件中的秒，在 SRT 字幕行表示毫秒，在已定位的包装层表示成片中的秒。

## 数据从哪里来

| 坐标 | 单位和换算 | 代码入口 |
| --- | --- | --- |
| 素材探测 | 优先取所选流的时长，其次取容器时长，向下截到毫秒后以秒保存。视频帧率来自 `avg_frame_rate` 的分子除以分母。 | `src/media.cjs` 的 `inspectAsset` |
| 工程与草稿 | 候选入出点、保留区间、固定分镜时长、口播偏移、画面落点和转场时长用秒，`speed` 是倍率。字幕起止用整数毫秒，`fps` 可选 24、25、30、60。 | `src/project-format.cjs` 的 `cleanConfig`、`saveProject`、`loadProject`，`src/shot-timing.cjs` 的 `normalizeRanges` |
| 素材剪辑 | 素材逐帧输入用源帧率换算为秒。应用剪辑时，`render` 根据素材帧率（未知时 30）将累计保留秒数四舍五入为帧，每段取相邻边界的差。音轨按每段已分配时长裁为 48 kHz 采样。 | `src/ui/video-cut-timeline.js`，`src/source-edit.cjs` |
| 成片画面 | 输出帧号从 0 开始。区间 `[起始帧, 结束帧)` 包含起点，下一镜接手结束帧。帧数除以工程输出帧率得到秒。 | `src/media.cjs` 的 `planMontage`、`montageArgs`，`src/ui/voice-alignment.js` |
| 音频与字幕 | 导出音轨为 48 kHz，延时和多区间裁剪可用整数采样。SRT 的 `00:00:00,125` 表示 125 毫秒。 | `src/media.cjs` 的 `montageArgs`，`src/subtitles.cjs` 的 `parseTime`、`formatTime` |

工程保存用户输入的源时间和设置，加载后根据当前输出帧率生成成片计划。`saveProject` 按扩展名选择磁盘版本，`.jiajian` 写版本 2，`.sdworkbench` 写版本 1，两者的 `format` 均为 `sdworkbench`。`loadProject` 通过 `projectReferences` 把版本 1 在内存中迁移到版本 2。重开旧工程保留原文件的版本号。

草稿始终写为版本 1 的 `.sdworkbench` 快照。每次保存增加 `draft.revision`，用来检测同时修改的冲突。此次兼容检查用版本 1 旧工程重开，并将草稿从修订 1 保存为修订 2，重新创建草稿库后再打开，磁盘版本均为 1。草稿元数据中的时长由 `draft-store.cjs` 的 `estimateDuration` 估算，按各镜首个启用候选的匹配时长、固定时长或裁剪变速后的时长求和，四舍五入到毫秒。草稿卡片显示到整秒。

## 审计复现

在 T9 主线的 `planMontage` 中，将 200 个源长 0.218 秒的分镜设为 2 倍速，按 30 fps 输出。每镜理想长度为 3.27 帧，总计恰好 654 帧。旧计划为每镜向上取整到 4 帧，共 800 帧，增加了 146 帧，约 4.87 秒。同样的输入改为单倍速，普通画面路径只累计源秒，首个切点落在 6.54 帧的位置。

口播使用独立时间单位。例如 125 毫秒的音频在 48 kHz 下恰好有 6,000 个采样，在 30 fps 下跨 3.75 帧。画面需要 4 帧才能覆盖声音结尾。把字幕末端放在第 4 帧的末端会让它超过音频末尾约 8.3 毫秒。

## 从播放时间得到输出帧

画面优先时，`pictureFrames` 将每个分镜的理想播放秒数乘以输出帧率。极短的独立分镜至少分到一帧。将这些数值累加，中间切点取最近整数帧，最后的切点向上取整以覆盖片尾。相邻切点相减得到 `outputFrames`，除以帧率得到 `outputDuration`。上例的前五个切点是 3、7、10、13、16，末点为 654，最后显示的帧号是 653。

分段口播优先时，`fitSegmentedVoice` 将每镜的口播偏移和剪后口播长度相加，四舍五入到 48 kHz 整数采样，再将累计采样数换成视频帧。没有口播的分镜按画面播放时长推进。`timelineDuration` 保存这段音频时长，同一切点的画面与声音可能相差不足一帧。整段口播优先时，`fitWholeVoice` 或 `fitReferenceWhole` 按所选规则分配素材，以整段口播长度为目标，最后一帧覆盖声音末尾。

普通顺排成片的总帧数等于各分镜 `outputFrames` 之和。独立落点的视频或时间线空档可以延长片尾，计算时取最晚结束的位置再向上对齐到帧。额外叠放的画面可以与原分镜同时播放，总时长按它们覆盖的区间计算。若音频终点早于画面末帧的结束位置，`audioDuration` 记录原始终点，`montageArgs` 按 48 kHz 将最终混音裁到该采样。随机封面额外增加 7–10 帧，选取素材库封面和首镜封面保持正文时长。

成片 MP4 的 `movie_timescale` 设为 48,000，使容器能表示一个音频采样的时长。`cover.cjs` 的 `publishCover` 在添加随机片头时，先按正文的计划采样数裁去解码 AAC 带出的填充，再把整段声音延迟片头所占的采样数。重新封装封面后仍使用同一电影时基。

`generatedSubtitleTrack` 把口播偏移、裁掉的源区间及倍速换算成成片上的位置。`appendCaptionCues` 先将音频窗口下界向上、上界向下取到整数毫秒，再将每行字幕裁入此窗口，没有可显示时长的行会移除。绑定口播的整段 SRT 同样受口播长度约束。贴到时间线上的独立字幕和素材自带字幕各自跟随其编辑位置。

## 倍速、转场和静音

- **倍速与时长匹配。** `planMontage` 汇总保留区间，扣去片头、片尾，源时长除以倍速得到理想播放秒数。`matchCandidateDuration` 用“保留源时长 ÷ 目标口播时长”计算视频匹配倍速，最低为 1。口播的 `voiceLength` 用保留源时长除以口播倍速。区间被剪成多段时，`sliceSource` 按保留顺序在源秒上截取。`fitVisuals` 根据镜内累计播放秒数分配帧，最后一段承接分镜剩余帧数。
- **转场。** `readShotTransitions` 接受 0.1–2 秒的淡黑或淡白。`sceneFades` 以相邻分镜的画面切点为中心，在两侧各分配半个转场。遇到短镜头会限长，同一镜头两端的淡变相遇时按比例缩短。FFmpeg 的 `fade` 逐输出帧采样，转场直接改变原有帧的亮度，分镜帧数和成片长度均保持原值。
- **分镜间自动去静音。** `prepareMontagePlans` 在分段口播优先并选择填充画面时，才分析相邻两段口播。`analyzeNarrationSilence` 使用 −40 dB、0.12 秒阈值，`voiceRange` 按保留区间及倍速调整接缝时间，每侧保留 0.025 秒气口。短于 0.1 秒的结果回退到原口播区间。开头、结尾和两镜之间夹着无口播分镜的边界保留。分析后沿用第一次抽取的组合。
- **音频工具去停顿。** `audio-tools.cjs` 的 `detectPauses` 用秒计算停顿和气口，将边界保留至小数点后六位。`processAudio` 按保留区间裁切、拼接音频。`retimeCaptions` 从每个字幕端点减去该端点以前已删除的总毫秒数，四舍五入到毫秒并移除空行。
- **连续配音分段。** `segmented-speech.cjs` 的 `alignScript` 在相邻词的接缝或实测停顿中点四舍五入到毫秒。`synthesizeSegmented` 将切点除以 1000 传给 FFmpeg，并用每包 48 个采样的 48 kHz PCM（每包 1 毫秒）切分。每行字幕以分段文件开头计时，末端受该文件实测时长限制。

### v2 工程能识别哪些倍速操作

拖入视频空位时，`src/ui/track-tools.js` 的 `fitVideoSpeed` 用保留源时长除以空位时长。0.1 秒填 10 秒得到 0.01×，60 秒填 1 秒得到 60×。`src/project-format.cjs` 接受的 `speed` 范围是 0.000001 至 `Number.MAX_SAFE_INTEGER`。

`src/ui/app.js` 的 `candidate` 创建普通候选时写入 `speed: 1`。手动改倍速会删除 `autoFitSpeed`，`serializeClip` 和 `src/project-format.cjs` 的 `cleanConfig` 仅保留值为 `true` 的自动标记。

复现时，取一份 v2 工程，将同一候选分别设为 `speed: 1` 和 `speed: 1, autoFitSpeed: false`，交给 `projectReferences` 读取。两次得到的候选字段完全相同，重开后无法区分默认 1× 和手动改回的 1×。对保留 8 秒、已设为 2× 的视频调用 `src/ui/voice-alignment.js` 的 `matchCandidateDuration(clip, 1)`，结果为 8×。

## 预览、导出与验证

剪辑台的实时草稿使用 `src/ui/draft-transport.js` 的 `timing` 和 `makePlan`，按当前选中候选、编辑尺上的秒数和口播匹配关系调度浏览器媒体元素。逐帧查看素材使用源帧率，草稿时间线逐帧移动使用工程帧率。编辑尺既可展示还未选入成片的轨道，也可保留没有素材的分镜占位。

点击“生成预览”后，`prepareMontagePlans` 对实际选中的素材、分镜顺序和口播编排成片。`createPreviewBatch` 缓存成片计划及其时长，`selectPreviewPlans` 按批次和序号取回原计划。列表中的“播放预览”和“导出已选”都通过 `exportBatch` 调用 FFmpeg。渲染器按计划中的 `fps` 取样、按 `outputFrames` 裁画面，同一组合有相同的切点。

运行 `node --test test/time-model.test.cjs` 可复核成片计划。固定种子生成 200 个分镜，在 24、25、30、60 fps 下逐镜核对帧边界、镜内裁剪分段和总帧数。另用整数采样核对每行口播字幕的上下界，并解码红、蓝、绿三镜短片，检查切换帧、淡黑和最后一帧。

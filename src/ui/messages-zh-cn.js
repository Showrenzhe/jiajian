'use strict';

window.editorMessages = Object.freeze({
  hdr: {badge:'HDR', setting:'HDR 素材', sdr:'转为 SDR（BT.709）', preserve:'保持 HDR',
    normalized:'原画预览', fallback:'当前 FFmpeg 缺少 HDR 转换滤镜，将保持 HDR。需要 SDR 时，请使用包含 zscale 和 tonemap 的 FFmpeg，然后重启佳剪。',
    legacyEdit:'部分旧 HDR 片段暂时沿用 8 位剪辑文件。请确认原片可读且磁盘可写，再重新打开以恢复 10 位画面。'},
  tourSteps: [
    ['material-import','导入素材','在素材库选择文件或文件夹，加入视频、图片和音频。'],
    ['add-shot','建分镜','在时间线新增分镜，再把视频或图片拖进对应的分镜。'],
    ['inspector-tab-narration','加口播','在口播面板选择整段或分段模式，再加入对应的音频。'],
    ['prepare-preview','生成预览','在混剪设置里生成预览，检查候选组合和成片时长。'],
    ['start-export','导出','勾选要保留的组合，点击导出并选择保存目录。'],
  ],
  keys: { undo:'撤销', redo:'重做', split:'分割', trimLeft:'剪掉左侧', trimRight:'剪掉右侧',
    reverse:'倒放', mirror:'镜像', crop:'裁剪画面', rotate:'旋转', save:'快速保存',
    back:'前一帧', forward:'后一帧', backTen:'后退十帧', forwardTen:'前进十帧' },
  emptyVideo:'拖入视频或图片到此处', emptyVoice:'拖入口播音频到此处',
  timelineMenu: {
    label:'时间线片段操作', remove:'删除', muteTrack:'静音轨道', unmuteTrack:'取消轨道静音',
    speed:'调整倍速', split:'在此处分割', edit:'编辑片段', doubleClick:'此处无菜单，可双击进入编辑',
  },
});

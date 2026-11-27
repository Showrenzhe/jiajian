'use strict';

((messages) => {
  if (typeof window !== 'undefined') window.editorMessages = messages;
  if (typeof module === 'object' && module.exports) module.exports = messages;
})(Object.freeze({
  glassEffect: {
    label: '玻璃效果', full: '完整', lite: '精简', off: '关闭',
    compatibility: '软件渲染兼容模式已关闭玻璃效果。退出兼容模式并重启佳剪后，将恢复你的选择。',
    storageError: '无法保存玻璃效果，请重试。',
  },
  speedPlanningErrors:{
    invalidPictureRange:'裁剪片段超出素材范围，或终点未晚于起点。',
    invalidWindow:'请检查素材保留时长、目标时长和自动倍速范围。',
    windowChanged:'目标时长已变化，请重新匹配。',
    expired:'倍速选择对应的混剪设置已变化，请重新生成。',
    invalidChoice:'请选择有效的倍速处理方式。',
    drawChanged:'原混剪组合已失效，请重新生成。',
  },
  projectSpeedFormat: {
    invalidMode: index => `第 ${index + 1} 组分镜的倍速模式无效。`,
    invalidOverflow: index => `第 ${index + 1} 组分镜的超限处理方式无效。`,
    backupConflict:'升级备份已存在且内容不同。请为工程另存新文件，或先移走旧备份。',
    backupFailed:'升级备份未完成，原文件已保留。请检查目录权限和剩余空间后重试。',
  },
  videoSpeed: {
    settings:'自动对齐倍速', min:'下限（倍）', max:'上限（倍）', saveRange:'保存范围',
    invalidRange:'请输入有效正数，下限须小于或等于上限。', storageError:'无法保存本机设置，请重试。',
    saved:'已保存，下一次自动对齐时生效。', inspector:'所选片段倍速', rate:'播放倍速',
    manualAction:'应用手动倍速', autoAction:'自动对齐…', cancel:'取消', pending:'应用时选择',
    legacy:'旧片段保留', manual:'手动锁定', auto:'自动对齐', original:'原片速度',
    title:'选择倍速处理方式', high:'所需倍速超过上限', low:'所需倍速低于下限',
    detail:(name,rate,min,max)=>`「${name}」需要 ${rate} 才能对齐目标时长。当前自动范围为 ${min} 至 ${max}。`,
    multiple:(name,count,rate,min,max)=>`包括「${name}」在内共有 ${count} 处超出 ${min} 至 ${max} 的自动范围，所需倍速最极端为 ${rate}。此次选择将应用于这 ${count} 处。`,
    unavailable:'（没有其他可用候选）',
    strategies:{'trim-start':'保留片头','trim-end':'保留片尾',continue:'按上限继续',loop:'循环播放',hold:'定格末帧',group:'使用同分镜候选补足'},
    cancelled:'已取消匹配。', protectedCount:n=>`${n} 条候选已锁定手动倍速`,
  },
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
}));

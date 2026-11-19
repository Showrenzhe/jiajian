'use strict';

const transcribe = { id: 'speech.transcribe', label: '语音转写与时间码' };
const writeScript = { id: 'script.generate', label: 'AI 脚本生成与改写' };
const synthesize = { id: 'speech.synthesize', label: '口播合成' };
const generateVideo = { id: 'video.generate', label: '视频素材生成' };
const publishStatus = { id: 'publication.status', label: '发布进度与回执' };

const definitions = [
  {
    id: 'replicate', title: '爆款复刻',
    summary: '拆解参考视频的台词、分镜和字幕，再改写脚本。',
    steps: ['导入参考视频或平台链接', '提取台词与分镜', '核对字幕和改写后的脚本'],
    requirements: [
      { id: 'media.resolve-link', label: '平台链接素材解析' }, transcribe,
      { id: 'video.scene-analysis', label: '画面与分镜分析' }, writeScript,
    ],
  },
  {
    id: 'montage', title: '视频混剪',
    summary: '编排本地素材、生成组合、预览并导出。',
    steps: ['导入分镜素材', '设置组合、口播和字幕', '预览并勾选导出'],
    localActions: [{ id: 'montage.open', label: '开始混剪' }],
  },
  {
    id: 'scene-split', title: '视频场景 AI 分割',
    summary: '按视频画面内容变化识别场景切点，并批量导出独立视频片段。',
    steps: ['选择视频或视频文件夹', '设置检测灵敏度和最短场景时长', '提交任务并查看分割结果'],
    localActions: [{ id: 'scene-split.open', label: '开始 AI 分割' }],
  },
  {
    id: 'ai-video', title: 'AI 成片',
    summary: '根据脚本生成配音和画面，再合成视频。',
    steps: ['填写创作需求', '确认脚本和分镜', '生成素材并合成'],
    requirements: [writeScript, synthesize, generateVideo],
  },
  {
    id: 'smart-slice', title: '智能切片',
    summary: '从长视频中识别精彩段落，整理为可预览的短片。',
    steps: ['导入长视频', '识别台词和精彩片段', '检查切片并选择导出'],
    requirements: [transcribe, { id: 'video.highlight-analysis', label: '精彩片段识别' }],
  },
  {
    id: 'assets', title: 'AIGC 素材生产',
    summary: '为视频生成图片和视频素材，或把已有素材导入本地混剪。',
    steps: ['填写生成描述或导入参考素材', '检查生成结果', '选取素材进入混剪'],
    requirements: [{ id: 'image.generate', label: '图片素材生成' }, generateVideo],
    localActions: [{ id: 'montage.import', label: '导入本地素材' }],
  },
  {
    id: 'digital-avatar', title: '数字分身',
    summary: '创建数字分身，并用选定的口播生成演示视频。',
    steps: ['导入授权的形象素材', '创建分身并选择口播', '生成和检查口播视频'],
    requirements: [{ id: 'avatar.create', label: '数字分身创建' }, { id: 'avatar.render', label: '分身视频合成' }],
  },
  {
    id: 'voice-clone', title: '声音克隆',
    summary: '从授权录音创建音色，再用该音色合成配音。',
    steps: ['导入授权的录音', '创建并试听音色', '选择音色制作配音'],
    requirements: [{ id: 'voice.clone', label: '音色创建与管理' }, synthesize],
  },
  {
    id: 'face-fusion', title: '人脸融合',
    summary: '用选定的人脸素材生成融合视频。',
    steps: ['导入授权的照片和视频', '选择目标人脸', '检查融合结果'],
    requirements: [{ id: 'video.face-fusion', label: '人脸定位与融合' }],
  },
  {
    id: 'script', title: '脚本创作',
    summary: '在本地编辑口播脚本，连接生成能力后可使用 AI 辅助创作。',
    steps: ['编写或导入台词', '整理脚本', '保存或用于口播制作'],
    requirements: [writeScript],
    localActions: [{ id: 'script.edit', label: '编辑本地脚本' }],
  },
  {
    id: 'audio', title: '音频提取',
    summary: '将本地视频的音轨批量保存为 MP3。',
    steps: ['导入本地视频', '选择输出目录', '提取并保存音轨'],
    localActions: [{ id: 'audio.open', label: '提取音频' }],
  },
  {
    id: 'distribution', title: '矩阵分发',
    summary: '选择作品和发布账号，提交分发任务并查看结果。',
    steps: ['连接发布账号', '选择作品并填写发布信息', '提交任务并查看回执'],
    requirements: [
      { id: 'publication.authorize', label: '发布账号授权' },
      { id: 'publication.submit', label: '平台发布任务提交' }, publishStatus,
    ],
  },
  {
    id: 'analytics', title: '数据看板',
    summary: '查看授权账号及已发布作品的表现。',
    steps: ['选择账号与时间范围', '读取作品和账号数据', '按平台查看指标'],
    requirements: [{ id: 'metrics.read', label: '平台数据与指标查询' }],
  },
  {
    id: 'teams', title: '团队/门店设置',
    summary: '查看团队、门店和成员，按角色分配权限。',
    steps: ['选择团队或门店', '查看或邀请成员', '设置成员权限'],
    requirements: [
      { id: 'team.manage', label: '团队与门店管理' },
      { id: 'team.roles', label: '成员邀请和权限管理' },
    ],
  },
  {
    id: 'tasks', title: '任务中心',
    summary: '查看本机生成的作品，连接服务后可查询云端任务。',
    steps: ['查看本地导出结果', '连接后查看云端任务进度', '按任务状态查看结果'],
    requirements: [{ id: 'task.read', label: '云端任务进度与结果' }, publishStatus],
    localActions: [{ id: 'tasks.recent', label: '查看本地导出' }],
  },
];

function describe({ requirements = [], localActions = [], ...definition }) {
  const status = requirements.length ? (localActions.length ? 'partial' : 'api-pending') : 'local';
  return structuredClone({ ...definition, status, requirements, localActions });
}

function listWorkflows() {
  return definitions.map(describe);
}

function getWorkflow(id) {
  const definition = definitions.find((workflow) => workflow.id === id);
  return definition ? describe(definition) : null;
}

module.exports = { listWorkflows, getWorkflow };

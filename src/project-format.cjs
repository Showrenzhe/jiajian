// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { isLocalPath, isMaterialPath, isSharedMaterialPath, checkedMaterialPath } = require('./material-path.cjs');
const { normalizeSourceEditRanges, prepareSourceEdit } = require('./source-edit.cjs');
const {
  audioExtensions, imageExtensions, videoExtensions, maxShots, maxCandidates, maxMontageBatch, maxWholeTracks,
  inspectAsset, createFrameThumbnail, planMontage, normalizeSubtitleStyle, normalizeGeneratedCaptions, normalizeMutedVideoTracks,
} = require('./media.cjs');
const { normalizeSubtitles } = require('./subtitles.cjs');
const { normalizeSubprojects } = require('./subprojects.cjs');
const { normalizeLibraryFolders } = require('./library-folders.cjs');
const { normalizeLayers, normalizeTransform, normalizePackaging } = require('./packaging.cjs');
const { normalizeShotSettings, normalizePictureRanges, normalizeSegmentVoiceCuts, normalizeSceneCuts } = require('./shot-timing.cjs');
const { normalizeCover } = require('./cover.cjs');
const { audioSpeed, normalizeMusicSpeeds, normalizeVolumeOverrides } = require('./shot-timing.cjs');
const { normalizeLook, inspectLut } = require('./visual-style.cjs');
const { candidateVideoLanes, normalizeVideoGaps, normalizeTimelineMarkers, placedVideoSpeed, minVideoSpeed } = require('./ui/track-tools.js');
const {projectSpeedFormat, timelineMarkerErrors, batchRandom:batchRandomMessages} = require('./ui/messages-zh-cn.js');
const { normalizeSettings: normalizeNarrationTrim, smartDefaults, legacyDefaults } = require('./ui/narration-trim.js');

const musicMix = require('./ui/music-mix.js');
const batchVariations = require('./ui/batch-variations.js');

const format = 'sdworkbench';
const version = 7;
/** @typedef {{start:number,end:number,reverse?:boolean,mirror?:boolean,rotation?:number,crop?:{x:number,y:number,width:number,height:number}}} EditRange */
/** @typedef {{id:string,ranges:EditRange[]}} EditRecipe */
/** @typedef {Map<string, Record<string, any>>} AssetCatalog */
// v1 asset declarations may omit size and duration; inspection supplies them when possible.
const migrations = new Map([
  [1, project => ({ ...project, version: 2 })],
  [2, project => ({ ...project, version: 3, config: cleanConfig(project.config, true).config })],
  [3, project => ({ ...project, version: 4, config: {...project.config, timelineMarkers:[]} })],
  [4, project => ({ ...project, version: 5, config: {...project.config, narrationTrim: legacyDefaults} })],
  [5, project => ({ ...project, version: 6, config: {...project.config, musicMix: musicMix.legacyDefaults} })],
  [6, project => ({ ...project, version: 7, config: {...project.config, batchRandom: batchVariations.newSettings()} })],
]);
function supportedProject(project) {
  return project?.format === format && (project.version === version || migrations.has(project.version));
}
function migrateProject(project) {
  if (!supportedProject(project)) throw Error('不支持此工程文件格式或版本。');
  let current=project;
  while (migrations.has(current.version)) current=migrations.get(current.version)(current);
  if (current.version!==version) throw Error('不支持此工程文件格式或版本。');
  return current;
}
const maxBytes = 1024 * 1024;
const maxScriptBytes = 256 * 1024;
const maxScriptRows = 1000;
const extensions = { audio: audioExtensions, image: imageExtensions, video: videoExtensions, lut:['cube'] };

function requireProjectPath(file) {
  if (!isLocalPath(file) || !['.jiajian', '.sdworkbench'].includes(path.extname(file).toLowerCase())) {
    throw new Error('请选择本地的 .jiajian 或 .sdworkbench 工程文件。');
  }
}

function normalizeScriptModel(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
      || !['whole', 'segmented'].includes(value.mode) || !['narration', 'textGroups'].includes(value.tab)) {
    throw new Error('工程中的脚本模式或标签页无效。');
  }

  function plainText(text, limit, label) {
    if (typeof text !== 'string' || text.length > limit) throw new Error(label + '必须为不超过 ' + limit + ' 字的文本。');
    return text.toWellFormed().replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
  }

  function rows(items, label, limit = 250) {
    if (!Array.isArray(items) || items.length > limit) throw new Error(label + `最多可保存 ${limit} 行。`);
    return Array.from(items, (item, index) => {
      const row = label + '第 ' + (index + 1) + ' 行';
      return {
        dialogue: plainText(item?.dialogue, 4096, row + '的台词'),
        note: plainText(item?.note, 4096, row + '的备注'),
      };
    });
  }

  const script = {
    title: plainText(value.title, 100, '脚本标题').replace(/[\t\n]/g, ' '),
    mode: value.mode,
    tab: value.tab,
    whole: rows(value.whole, '整段口播'),
    segmented: rows(value.segmented, '分段口播', maxScriptRows),
    textGroups: rows(value.textGroups, '文字组'),
  };
  if (Buffer.byteLength(JSON.stringify(script)) > maxScriptBytes) throw new Error('工程中的脚本内容超过 256 KiB。');
  return script;
}

function cleanConfig(config, migrateOldSpeed = false, legacyBatchFields = migrateOldSpeed) {
  if (!Array.isArray(config?.shots) || config.shots.length > maxShots
      || !Array.isArray(config.musicIds) || config.musicIds.length > maxCandidates) {
    throw new Error('工程中的分镜或配乐数量无效。');
  }
  const { ratio, resolution, fps, fit, keepAudio, unordered, useOriginal, useMirrors, musicVolume, count } = config;
  const { narrationId, priority, narrationMode, segmentNarrationIds, segmentNarrationSelection } = config;
  if (!['16:9', '9:16', '1:1'].includes(ratio) || ![720, 1080].includes(resolution)
      || ![24, 25, 30, 60].includes(fps) || !['fit', 'fill'].includes(fit)
      || ![keepAudio, unordered, useOriginal, useMirrors].every((value) => typeof value === 'boolean')
      || !(useOriginal || useMirrors) || !Number.isFinite(musicVolume) || musicVolume < 0 || musicVolume > 100
      || !Number.isInteger(count) || count < 1 || count > maxMontageBatch) {
    throw new Error('工程中的混剪设置无效，请检查画幅、音量和生成数量。');
  }
  if (priority !== undefined && !['picture', 'voice'].includes(priority)) {
    throw new Error('工程中的音画优先模式无效。');
  }
  if ((narrationMode !== undefined && !['whole', 'segmented'].includes(narrationMode))
      || (segmentNarrationSelection !== undefined && !['ordered', 'random'].includes(segmentNarrationSelection))) {
    throw new Error('工程中的口播或分段混剪模式无效。');
  }

  const references = new Map();
  function record(id, role) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工程中有无效的素材编号。');
    const previous = references.get(id);
    if (previous && role === 'library' && previous !== 'lut') return id;
    if (previous && previous !== role && !(previous === 'library' && role !== 'lut')) throw new Error('同一素材不能同时作为画面和音频。');
    references.set(id, role);
    return id;
  }
  const recordLayer = (id, kind) => record(id, kind === 'sound' ? 'audio' : kind === 'lut' ? 'lut' : 'visual');
  function cleanShot(shot, index) {
    if (!Array.isArray(shot) || shot.length > maxCandidates) throw new Error(`第 ${index + 1} 组分镜的候选素材数量无效。`);
    candidateVideoLanes(shot, maxCandidates);
    return Array.from(shot, (clip) => {
      const id = record(clip?.id, 'visual');
      const preference = legacyBatchFields ? 'normal' : batchVariations.normalizePreference(clip.batchPreference);
      if (![clip.start, clip.end].every(Number.isFinite) || clip.start < 0 || clip.end < clip.start) {
        throw new Error(`第 ${index + 1} 组分镜的裁切时间无效。`);
      }
      if (clip.sourceMuted !== undefined && typeof clip.sourceMuted !== 'boolean') throw new Error('片段原声静音状态无效。');
      if (clip.volume !== undefined && (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 100)) {
        throw new Error(`第 ${index + 1} 组分镜的原声音量无效。`);
      }
      if (clip.speed !== undefined && (!Number.isFinite(clip.speed) || clip.speed < minVideoSpeed || clip.speed > Number.MAX_SAFE_INTEGER)) {
        throw new Error(`第 ${index + 1} 组分镜的素材速度无效。`);
      }
      if (clip.autoFitSpeed !== undefined && typeof clip.autoFitSpeed !== 'boolean') {
        throw new Error(`第 ${index + 1} 组分镜的自动倍速设置无效。`);
      }
      // Preserve the old playback rules, including automatic placement, narration matching,
      // and a missing source rate. New alignment limits begin only after an explicit edit.
      const speedMode = migrateOldSpeed ? 'legacy' : clip.speedMode;
      const speedOverflow = migrateOldSpeed ? undefined : clip.speedOverflow;
      if (speedMode !== undefined && !['auto', 'manual', 'legacy'].includes(speedMode)) {
        throw new Error(projectSpeedFormat.invalidMode(index));
      }
      if (speedOverflow !== undefined && !['trim-start', 'trim-end', 'continue', 'loop', 'hold', 'group'].includes(speedOverflow)) {
        throw new Error(projectSpeedFormat.invalidOverflow(index));
      }
      if (clip.matchedDuration !== undefined && (!Number.isFinite(clip.matchedDuration) || clip.matchedDuration < 0.000001 || clip.matchedDuration > 86400)) {
        throw new Error(`第 ${index + 1} 组分镜的匹配时长无效。`);
      }
      if (clip.enabled !== undefined && typeof clip.enabled !== 'boolean') throw new Error('候选参与状态无效。');
      if (clip.videoGroup !== undefined && (typeof clip.videoGroup!=='string' || !clip.videoGroup.length || clip.videoGroup.length>64)) throw Error('视频片段组合编号无效。');
      if (clip.videoStart !== undefined && (!Number.isFinite(clip.videoStart) || clip.videoStart < 0 || clip.videoStart > Number.MAX_SAFE_INTEGER)) {
        throw new Error('视频片段的时间轴落点无效。');
      }
      if (clip.videoFollowsShot!==undefined && (typeof clip.videoFollowsShot!=='boolean' || clip.videoStart===undefined)) {
        throw new Error('视频片段的分镜跟随设置无效。');
      }
      if (clip.videoDuration !== undefined && (!Number.isFinite(clip.videoDuration) || clip.videoDuration <= 0 || clip.videoDuration > Number.MAX_SAFE_INTEGER)) {
        throw new Error('视频片段的时间轴裁切时长无效。');
      }
      if(clip.videoWindow!==undefined && (clip.videoStart===undefined || !Number.isFinite(clip.videoWindow) || clip.videoWindow<=0 || clip.videoWindow>Number.MAX_SAFE_INTEGER)) throw Error('视频轨插入时保留的片段时长无效。');
      if (clip.videoFit !== undefined && (clip.videoFit !== 'hold' || clip.videoStart === undefined || clip.videoDuration === undefined)) {
        throw new Error('视频片段的切点窗口无效。');
      }
      const ranges = clip.ranges === undefined ? undefined : normalizePictureRanges(clip.ranges, clip.start, clip.end);
      let sourceEdit;
      if (clip.sourceEdit !== undefined) {
        const original = record(clip.sourceEdit?.id, 'visual');
        if (original === id) throw new Error('剪辑成片与原素材不能使用同一编号。');
        sourceEdit = { id: original, ranges: normalizeSourceEditRanges(clip.sourceEdit.ranges, Number.MAX_SAFE_INTEGER) };
      }
      return {
        id, start: clip.start, end: clip.end,
        ...(preference !== 'normal' && {batchPreference: preference}),
        ...(sourceEdit && { sourceEdit }),
        ...(clip.videoLane !== undefined && { videoLane: clip.videoLane }),
        ...(clip.videoStart !== undefined && { videoStart: clip.videoStart }),
        ...(clip.videoFollowsShot !== undefined && { videoFollowsShot: clip.videoFollowsShot }),
        ...(clip.videoDuration !== undefined && { videoDuration: clip.videoDuration }),
        ...(clip.videoFit !== undefined && { videoFit: clip.videoFit }),
        ...(clip.videoGaps !== undefined && {videoGaps:normalizeVideoGaps(clip.videoGaps)}),
        ...(clip.videoWindow!==undefined && {videoWindow:clip.videoWindow}),
        ...(clip.videoGroup && {videoGroup:clip.videoGroup}),
        ...(clip.enabled !== undefined && { enabled: clip.enabled }),
        ...(clip.layers !== undefined && { layers: normalizeLayers(clip.layers, recordLayer) }),
        ...(clip.transform !== undefined && { transform: normalizeTransform(clip.transform) }),
        ...(clip.look !== undefined && {look:normalizeLook(clip.look,record)}),
        ...(clip.videoSubtitles && {videoSubtitles:normalizeSubtitles(clip.videoSubtitles)}),
        ...(ranges && { ranges }),
        ...(clip.volume !== undefined && { volume: clip.volume }),
        ...(clip.sourceMuted && {sourceMuted:true}),
        ...((clip.speed !== undefined || clip.autoFitSpeed) && { speed: placedVideoSpeed({...clip, speedMode, speedOverflow}) }),
        ...(speedMode !== undefined && { speedMode }),
        ...(speedOverflow !== undefined && { speedOverflow }),
        ...(clip.autoFitSpeed && { autoFitSpeed: true }),
        ...(clip.matchedDuration !== undefined && { matchedDuration: clip.matchedDuration }),
      };
    });
  }
  const shots = Array.from(config.shots, cleanShot);
  const musicIds = Array.from(config.musicIds, (id) => record(id, 'audio'));
  if (new Set(musicIds).size !== musicIds.length) throw new Error('工程中有重复的配乐。');
  const projectConfig = { shots, ratio, resolution, fps, fit, keepAudio, unordered, useOriginal, useMirrors, musicIds, musicVolume, count };
  // The v2 migration ignores fields that did not yet belong to that format.
  if (!migrateOldSpeed) {
    const trim = config.narrationTrim === undefined ? smartDefaults : config.narrationTrim;
    projectConfig.narrationTrim = normalizeNarrationTrim(trim);
    projectConfig.musicMix = musicMix.normalizeSettings(config.musicMix === undefined ? musicMix.smartDefaults : config.musicMix);
    projectConfig.batchRandom = batchVariations.normalizeSettings(config.batchRandom);
  }
  if (!migrateOldSpeed && config.timelineMarkers !== undefined) {
    projectConfig.timelineMarkers = normalizeTimelineMarkers(config.timelineMarkers, timelineMarkerErrors);
  }
  if (config.proxyEnabled !== undefined) {
    if (typeof config.proxyEnabled !== 'boolean') throw new Error('草稿代理开关无效。');
    projectConfig.proxyEnabled = config.proxyEnabled;
  }
  if (config.musicSpeeds !== undefined) projectConfig.musicSpeeds = normalizeMusicSpeeds(config.musicSpeeds, musicIds.length);
  if (config.narrationSpeed !== undefined) projectConfig.narrationSpeed = audioSpeed(config.narrationSpeed);
  if (config.processedLibrary !== undefined) {
    if (!Array.isArray(config.processedLibrary) || config.processedLibrary.length > 2000) throw new Error('已处理素材库无效。');
    projectConfig.processedLibrary = config.processedLibrary.map(({id,kind}) => {
      if (!['video','audio'].includes(kind)) throw new Error('已处理素材类型无效。');
      return { id:record(id,kind==='audio'?'audio':'visual'), kind };
    });
  }
  if (config.mutedVideoTracks !== undefined) projectConfig.mutedVideoTracks = normalizeMutedVideoTracks(config.mutedVideoTracks);
  if (config.trackControls !== undefined) projectConfig.trackControls = require('./ui/track-controls.js').normalize(config.trackControls);
  if (config.subprojects !== undefined) projectConfig.subprojects = normalizeSubprojects(config.subprojects, shots.length, cleanShot,(id)=>record(id,'audio'));
  if (!legacyBatchFields && config.batchSubprojectScope !== undefined) {
    if (typeof config.batchSubprojectScope !== 'boolean') throw Error(batchRandomMessages.invalidSettings);
    if (config.batchSubprojectScope && projectConfig.subprojects) projectConfig.batchSubprojectScope = true;
  }
  if (config.materialFolderKeys !== undefined) {
    const keys = config.materialFolderKeys;
    if (!Array.isArray(keys) || keys.length > 16 || !keys.every((key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) throw new Error('工程素材文件夹无效。');
    projectConfig.materialFolderKeys = [...new Set(keys)];
  }
  if (config.materialBins !== undefined) {
    const scopes = new Set([null, ...(projectConfig.subprojects?.projects ?? []).map((p) => p.id)]);
    if (!Array.isArray(config.materialBins) || config.materialBins.length > scopes.size) throw new Error('工程素材库无效。');
    projectConfig.materialBins = config.materialBins.map(({scope, ids, hidden}) => {
      if (!scopes.delete(scope) || !Array.isArray(ids) || !Array.isArray(hidden)
          || !hidden.every((key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) throw new Error('工程素材库条目无效。');
      return {scope, ids: [...new Set(ids.map((id) => record(id,'library')))], hidden: [...new Set(hidden)]};
    });
  }
  if (config.libraryFolders !== undefined) {
    const scopes = new Set([null, ...(projectConfig.subprojects?.projects ?? []).map(project => project.id)]);
    projectConfig.libraryFolders = normalizeLibraryFolders(config.libraryFolders, scopes, record);
  }
  if (config.packaging !== undefined) projectConfig.packaging = normalizePackaging(config.packaging, recordLayer, shots.length);
  if (config.shotSettings !== undefined) projectConfig.shotSettings = normalizeShotSettings(config.shotSettings, shots.length);
  if (config.voiceAlignment !== undefined) {
    if (!['fill', 'reference'].includes(config.voiceAlignment)) throw new Error('口播对齐规则无效。');
    projectConfig.voiceAlignment = config.voiceAlignment;
  }
  if (config.sceneCuts !== undefined) projectConfig.sceneCuts = normalizeSceneCuts(config.sceneCuts, record);
  if (config.cover !== undefined) projectConfig.cover = normalizeCover(config.cover,(id)=>record(id,'visual'));
  if (config.filterLibrary !== undefined) {
    if (!Array.isArray(config.filterLibrary)||config.filterLibrary.length>200) throw new Error('LUT 库无效。');
    projectConfig.filterLibrary=[...new Set(config.filterLibrary.map((id)=>record(id,'lut')))];
  }
  if(config.assetAliases!==undefined){
    if(!Array.isArray(config.assetAliases)||config.assetAliases.length>4096)throw new Error('素材名称数量无效。');
    projectConfig.assetAliases=config.assetAliases.map(({id,kind,name})=>{
      if(!['image','video','audio'].includes(kind)||typeof name!=='string'||!name.trim()||name.length>150||/[\\/\x00-\x1f]/.test(name))throw new Error('素材名称无效。');
      return {id:record(id,kind==='audio'?'audio':'visual'),kind,name};
    });
  }
  if(config.volumeOverrides!==undefined)projectConfig.volumeOverrides=normalizeVolumeOverrides(config.volumeOverrides,record,shots.length);
  if (config.segmentVoiceCuts !== undefined) projectConfig.segmentVoiceCuts = normalizeSegmentVoiceCuts(config.segmentVoiceCuts, segmentNarrationIds);
  if (config.musicStartShot !== undefined) {
    const start = config.musicStartShot;
    if (start !== null && (!Number.isInteger(start) || start < 0 || start >= shots.length)) {
      throw new Error('工程中的配乐起点分镜无效。');
    }
    projectConfig.musicStartShot = start;
  }
  if (narrationId !== undefined) projectConfig.narrationId = narrationId === null ? null : record(narrationId, 'audio');
  if (priority !== undefined) projectConfig.priority = priority;
  if (narrationMode !== undefined) projectConfig.narrationMode = narrationMode;
  if (segmentNarrationSelection !== undefined) projectConfig.segmentNarrationSelection = segmentNarrationSelection;
  if (segmentNarrationIds !== undefined) {
    if (!Array.isArray(segmentNarrationIds) || segmentNarrationIds.length !== shots.length) {
      throw new Error('分段口播轨道数量与分镜数量不匹配。');
    }
    projectConfig.segmentNarrationIds = Array.from(segmentNarrationIds, (row, index) => {
      if (!Array.isArray(row) || row.length > maxWholeTracks) throw new Error(`第 ${index + 1} 组的口播轨道无效。`);
      return Array.from(row, (id) => id === null ? null : record(id, 'audio'));
    });
  }
  if (config.timelineCaptions !== undefined) projectConfig.timelineCaptions = normalizeSubtitles(config.timelineCaptions);
  if (config.subtitles !== undefined) projectConfig.subtitles = normalizeSubtitles(config.subtitles);
  if (config.subtitleStyle !== undefined) projectConfig.subtitleStyle = normalizeSubtitleStyle(config.subtitleStyle);
  if (config.narrationVolume !== undefined) {
    if (!Number.isFinite(config.narrationVolume) || config.narrationVolume < 0 || config.narrationVolume > 100) {
      throw new Error('工程中的口播音量无效。');
    }
    projectConfig.narrationVolume = config.narrationVolume;
  }
  if (config.backgroundColor !== undefined) {
    if (typeof config.backgroundColor !== 'string' || !/^#[a-f0-9]{6}$/i.test(config.backgroundColor)) {
      throw new Error('工程中的留边背景颜色无效。');
    }
    projectConfig.backgroundColor = config.backgroundColor.toLowerCase();
  }
  if (config.shotTransitions !== undefined) {
    if (!Array.isArray(config.shotTransitions) || config.shotTransitions.length !== shots.length) {
      throw new Error('转场数量与分镜不匹配。');
    }
    projectConfig.shotTransitions = Array.from(config.shotTransitions, (transition) => {
      if (transition === null) return null;
      if (!['fade-black', 'fade-white'].includes(transition?.kind) || !Number.isFinite(transition.duration)
          || transition.duration < 0.1 || transition.duration > 2) throw new Error('工程中的转场设置无效。');
      return { kind: transition.kind, duration: transition.duration };
    });
  }
  if (config.extraWholeTracks !== undefined) {
    if (!Array.isArray(config.extraWholeTracks) || config.extraWholeTracks.length >= maxWholeTracks) {
      throw new Error(`工程最多支持 ${maxWholeTracks} 条整段口播轨。`);
    }
    projectConfig.extraWholeTracks = Array.from(config.extraWholeTracks, (track) => {
      if (!track || typeof track !== 'object' || Array.isArray(track)) throw new Error('工程中的整段口播轨无效。');
      return {
        narrationId: track.narrationId == null ? null : record(track.narrationId, 'audio'),
        ...(track.narrationSpeed !== undefined && {narrationSpeed: audioSpeed(track.narrationSpeed)}),
        subtitles: normalizeSubtitles(track.subtitles),
      };
    });
  }
  if (config.script !== undefined) projectConfig.script = normalizeScriptModel(config.script);
  if (config.wholeStartShots !== undefined) {
    if (!Array.isArray(config.wholeStartShots) || config.wholeStartShots.length!==1+(config.extraWholeTracks?.length ?? 0)
      || config.wholeStartShots.some((i)=>i!==null && (!Number.isInteger(i) || i<0 || i>=shots.length))) throw new Error('整段口播的跟随分镜无效。');
    projectConfig.wholeStartShots=[...config.wholeStartShots];
  }
  if (config.generatedCaptions !== undefined) {
    projectConfig.generatedCaptions = normalizeGeneratedCaptions(config.generatedCaptions, projectConfig);
  }
  return { references, config: projectConfig };
}

function mediaDeclaration(id, asset, role) {
  const file = asset?.missingPath ?? asset?.path;
  const kind = asset?.kind;
  const validKind = role === 'library' ? ['image','video','audio'].includes(kind) :
    role === 'visual' ? ['image','video'].includes(kind) : role === kind;
  if (!role || !validKind || !(kind === 'lut' ? isLocalPath(file) : isMaterialPath(file)) || !extensions[kind].includes(path.extname(file).slice(1).toLowerCase())) {
    throw new Error(`工程素材 ${id} 缺失或类型不匹配，请重新选择素材。`);
  }
  const duration = asset.missing ? asset.originalDuration : asset.duration;
  return { id, kind, path: file,
    ...(Number.isSafeInteger(asset.size) && asset.size >= 0 && {size:asset.size}),
    ...(Number.isFinite(duration) && duration > 0 && duration <= 86400 && {duration}),
  };
}

/** @returns {Generator<[string, EditRecipe]>} */
function* sourceEdits(config) {
  const subprojects = config.subprojects;
  const rows = subprojects ? [...subprojects.main, ...subprojects.projects.flatMap(project => project.shots)] : [];
  for (const shot of [...config.shots, ...rows.map(row => row.clips)]) {
    for (const clip of shot) {
      if (clip.sourceEdit) yield [clip.id, clip.sourceEdit];
    }
  }
}

function validateCuts(config, assets) {
  for (const [id, edit] of sourceEdits(config)) {
    const original = assets.get(edit.id);
    if (original?.kind !== 'video' || assets.get(id)?.kind !== 'video') throw new Error('素材剪辑需要原始视频和剪辑后的视频。');
    normalizeSourceEditRanges(edit.ranges, original.duration);
  }
  for (const item of config.cover?.items ?? []) {
    const asset = assets.get(item.id);
    if (!asset || (asset.kind === 'image' ? item.time !== 0 : asset.kind !== 'video' || item.time > asset.duration)) throw new Error('封面帧超出素材范围。');
  }
  normalizeSegmentVoiceCuts(config.segmentVoiceCuts, config.segmentNarrationIds, assets);
  for (const { assetId, points, used, hidden = [] } of config.sceneCuts ?? []) {
    const asset = assets.get(assetId);
    if (asset?.kind !== 'video' || points.some((point) => point >= asset.duration)
        || [...used, ...hidden].some((range) => range.end > asset.duration + 1e-6)) throw new Error('AI 拆分点超出视频范围。');
  }
  const populated = config.shots.flatMap((shot, index) => shot.length ? [index] : []);
  // Empty shots are useful while editing but cannot be part of a render plan.
  if (populated.length) {
    planMontage({
      ...config,
      // Inspect the cuts of every saved candidate, including tracks excluded from the current export.
      shots: populated.map((index) => config.shots[index].map((clip) => ({ ...clip, enabled: true, batchPreference:'normal' }))),
      ...(config.packaging && { packaging: {
        ...config.packaging,
        segmentNarration: populated.map((index) => config.packaging.segmentNarration[index] ?? []),
        textGroups: config.packaging.textMode === 'whole' ? config.packaging.textGroups :
          config.packaging.textGroups.map((row) => populated.map((index) => row[index] ?? [])),
      } }),
      shotSettings: config.shotSettings && populated.map((index) => config.shotSettings[index]),
      volumeOverrides:config.volumeOverrides?.flatMap(row=>row.kind!=='segment'?[row]:populated.includes(row.shot)?[{...row,shot:populated.indexOf(row.shot)}]:[]),
      segmentNarrationIds: config.segmentNarrationIds && populated.map((index) => config.segmentNarrationIds[index]),
      segmentVoiceCuts: config.segmentVoiceCuts && populated.map((index) => config.segmentVoiceCuts[index]),
      generatedCaptions: undefined, // Already validated before removing empty draft shots for this render check.
      shotTransitions: config.shotTransitions && populated.map((index) => config.shotTransitions[index]),
      musicStartShot: populated.includes(config.musicStartShot) ? populated.indexOf(config.musicStartShot) : null,
      wholeStartShots: config.wholeStartShots?.map((i)=>populated.includes(i) ? populated.indexOf(i) : null),
      count: 1,
    }, assets, () => 0);
  }
}

const coverFrames = new WeakMap();
let emptyCover;
const maxThumbnailBytes = 256 * 1024;
const maxThumbnailText = Math.ceil(maxThumbnailBytes / 3) * 4 + 32;

async function projectThumbnail(config, catalog, declarations) {
  const cover = config.cover;
  const chosen = cover?.mode === 'library' && cover.items[Math.max(0, cover.active)];
  const clips = config.shots.flat();
  const first = chosen || clips.find((clip) => clip.enabled !== false) || clips[0]
    || declarations.find((item) => item.kind === 'video' || item.kind === 'image');
  const asset = first && catalog.get(first.id);
  if (!asset || asset.missing) return null;
  if (isSharedMaterialPath(asset.path)) {
    const source = await checkedMaterialPath({path:asset.path, root:asset.path, kind:asset.kind}).catch(() => null);
    if (!source) return null;
  }
  const time = chosen ? chosen.time : first.ranges?.[0]?.start ?? first.start;
  const info = await fs.stat(asset.path).catch(() => null);
  if (!info?.isFile()) return null;
  const key = [asset.path, info.mtimeMs, info.size, time].join('|');
  let frame = coverFrames.get(asset);
  if (frame?.key !== key) {
    frame = { key, bytes: createFrameThumbnail(asset, { time }).catch(() => null) };
    coverFrames.set(asset, frame);
  }
  const bytes = await frame.bytes;
  if (!bytes) coverFrames.delete(asset);
  return bytes?.length <= maxThumbnailBytes ? 'data:image/jpeg;base64,' + bytes.toString('base64') : null;
}

function embeddedThumbnail(document) {
  const text = document?.thumbnail;
  if (typeof text !== 'string' || text.length > maxThumbnailText
      || !/^data:image\/jpeg;base64,\/9j\/[a-zA-Z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text.slice('data:image/jpeg;base64,'.length), 'base64');
  return bytes.length <= maxThumbnailBytes && bytes.at(-2) === 255 && bytes.at(-1) === 217 ? bytes : null;
}

/** Atomically saves a normalized editor snapshot, retaining unresolved declarations.
 * @param {string} file @param {Record<string, any>} config @param {AssetCatalog} catalog
 * @param {{overwrite?:boolean}} [options] */
async function saveProject(file, config, catalog, { overwrite = false } = {}) {
  requireProjectPath(file);
  const { references, config: projectConfig } = cleanConfig(config);
  const assets = [...references].map(([id, role]) => mediaDeclaration(id, catalog.get(id), role));
  if (!assets.some(row => catalog.get(row.id)?.missing)) validateCuts(projectConfig, catalog);
  const thumbnail = await projectThumbnail(projectConfig, catalog, assets)
    ?? await (emptyCover ??= fs.readFile(path.join(__dirname, 'ui', 'assets', 'project-cover.jpg')).then((bytes) => 'data:image/jpeg;base64,' + bytes.toString('base64')));
  const contents = Buffer.from(`${JSON.stringify({ thumbnail, format, version, config: projectConfig, assets }, null, 2)}\n`, 'utf8');
  if (contents.length - (thumbnail?.length ?? 0) > maxBytes) throw new Error('工程文件超过 1 MiB 的大小上限。');

  const temp = path.join(path.dirname(file), `.sdworkbench-${randomUUID()}.tmp`);
  const writer = await fs.open(temp, 'wx', 0o600);
  try {
    try {
      await writer.writeFile(contents);
      await writer.sync();
    } finally {
      await writer.close();
    }
    // Linking a complete sibling file publishes it without replacing a concurrent save.
    if (overwrite === true) await replaceProjectFile(temp, file);
    else await fs.link(temp, file);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw Object.assign(new Error('该工程文件已存在。请选择其他名称，或确认覆盖。'), { code: 'EEXIST' });
    }
    if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(error.code)) {
      throw new Error('无法在此目录安全保存工程。请检查目录权限，或选择支持原子保存的本地磁盘目录。', { cause: error });
    }
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** @param {string} file */
async function readProjectSnapshot(file) {
  const reader = await fs.open(file, 'r');
  try {
    const info = await reader.stat();
    if (!info.isFile()) throw new Error('所选工程路径不是文件。');
    if (info.size > maxBytes + maxThumbnailText) throw new Error('工程文件超过 1 MiB 的大小上限。');
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await reader.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error('工程文件正在变化。');
    if (length > maxBytes && !/^\s*\{\s*"thumbnail"\s*:/.test(buffer.subarray(0, 80).toString())) throw new Error('工程文件超过 1 MiB 的大小上限。');
    try {
      const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
      if (length > maxBytes && (!embeddedThumbnail(doc) || length - doc.thumbnail.length > maxBytes)) throw new Error();
      return {doc, bytes:buffer.subarray(0, length)};
    } catch {
      throw new Error('工程文件内容无效或已损坏。');
    }
  } finally {
    await reader.close();
  }
}

async function readProject(file) {
  return (await readProjectSnapshot(file)).doc;
}

// A sibling backup can be opened directly with the old application. Publish complete, independent
// bytes without replacing an existing backup, including after a failed save or a concurrent retry.
async function verifyUpgradeBackup(file, bytes) {
  const existing = await readProjectSnapshot(file);
  if (!bytes.equals(existing.bytes)) throw Error(projectSpeedFormat.backupConflict);
}

async function publishBackupDirectory(file, temp, bytes) {
  // exFAT does not support hard links. Renaming a directory containing the complete, synced
  // file is atomic and cannot replace another non-empty backup directory.
  const directory = file + '.pre-v' + version;
  const stage = await fs.mkdtemp(path.join(path.dirname(file),'.backup-dir-'));
  const stagedFile = path.join(stage,path.basename(file));
  try {
    await fs.rename(temp,stagedFile);
    try { await fs.rename(stage,directory); }
    catch (error) {
      if (!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(error.code)) throw error;
    }
    await verifyUpgradeBackup(path.join(directory,path.basename(file)),bytes);
  } finally {
    await fs.rm(stagedFile,{force:true});
    await fs.rmdir(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function backupBeforeUpgrade(file, snapshot) {
  const ext = path.extname(file);
  const backup = path.join(path.dirname(file), path.basename(file, ext) + '.pre-v' + version + ext);
  const temp = path.join(path.dirname(file), '.backup-' + randomUUID() + '.tmp');
  const writer = await fs.open(temp, 'wx', 0o600);
  try {
    try {
      await writer.writeFile(snapshot.bytes);
      await writer.sync();
    } finally { await writer.close(); }
    try { await fs.link(temp, backup); }
    catch (error) {
      if (error.code === 'EEXIST') await verifyUpgradeBackup(backup,snapshot.bytes);
      else if (['ENOTSUP','EOPNOTSUPP','ENOSYS','EPERM','EACCES','EINVAL','UNKNOWN'].includes(error.code)) {
        await publishBackupDirectory(file,temp,snapshot.bytes);
      } else throw error;
    }
  } finally { await fs.rm(temp, {force:true}); }
}

const pendingReplacements = new Map();
async function replaceProjectFile(stage, file, expectedDraftRevision = undefined) {
  const pathKey = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const previous = pendingReplacements.get(pathKey) ?? Promise.resolve();
  const replacement = previous.catch(() => {}).then(async () => {
    const original = await readProjectSnapshot(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (expectedDraftRevision !== undefined && expectedDraftRevision !== (original?.doc.draft?.revision ?? 0)) {
      throw Error('草稿已更新，请重新打开后再保存。');
    }
    if (original && supportedProject(original.doc) && original.doc.version < version) {
      try { await backupBeforeUpgrade(file, original); }
      catch (error) {
        throw new Error(projectSpeedFormat.backupFailed + ' ' + error.message, {cause:error});
      }
    }
    await fs.rename(stage, file);
  });
  pendingReplacements.set(pathKey, replacement);
  try { await replacement; }
  finally { if (pendingReplacements.get(pathKey) === replacement) pendingReplacements.delete(pathKey); }
}

/** @param {Record<string, any>} project */
function projectReferences(project) {
  const legacyBatchFields = project?.version < 7;
  project = migrateProject(project);
  if (project.config?.batchRandom === undefined) throw Error(batchRandomMessages.invalidSettings);
  const { references, config } = cleanConfig(project.config, false, legacyBatchFields);
  if (!Array.isArray(project.assets) || project.assets.length !== references.size) throw new Error('工程的素材清单与引用不一致。');
  const declared = new Set();
  const rows = project.assets.map((row) => {
    const id = row?.id;
    if (!references.has(id) || declared.has(id)) throw new Error('工程中有未使用或重复声明的素材。');
    declared.add(id);
    return mediaDeclaration(id, row, references.get(id));
  });
  return {config,rows};
}

/** @param {string} file
 * @param {(file:string) => string | Promise<string>} [resolvePath]
 * @param {typeof inspectAsset} [inspect]
 * @param {string} [sourceEditDirectory]
 * @param {{allowMissing?:boolean}} [options] */
async function loadProject(file,resolvePath,inspect=inspectAsset,sourceEditDirectory=path.join(os.tmpdir(),'jiajian-source-edits'), {allowMissing=false}={}) {
  requireProjectPath(file);
  const {config,rows}=projectReferences(await readProject(file));
  const assets = new Map();
  const edits = new Map(sourceEdits(config));
  const cancellation = new AbortController();
  try {
    for (let index = 0; index < rows.length; index += 4) {
      const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(60_000)]);
      const batch = await Promise.all(rows.slice(index, index + 4).map(async (row) => {
        try {
          if (isSharedMaterialPath(row.path) && !resolvePath) throw new Error('请先在素材库中导入这项共享素材。');
          const source=resolvePath ? await resolvePath(row.path) : row.path;
          return [row.id, row.kind==='lut' ? await inspectLut(source) : await inspect(source, row.kind, { signal })];
        } catch (error) {
          if (edits.has(row.id) && !signal.aborted) return [row.id, null];
          if (allowMissing && !signal.aborted && (['ENOENT','ENOTDIR','EACCES','OFFLINE'].includes(error.code)
              || (isSharedMaterialPath(row.path) && /共享素材|共享路径/.test(error.message)))) {
            return [row.id, require('./relink.cjs').missingAsset(row,config)];
          }
          const name = path.basename(row.path);
          if (error.code === 'ENOENT') throw new Error(`找不到工程素材「${name}」。请将它放回原位置后重试。`);
          if (signal.aborted) throw new Error('读取工程素材超时。');
          throw new Error(`无法读取工程素材「${name}」。${error.message}`);
        }
      }));
      for (const [id, asset] of batch) if (asset) assets.set(id, asset);
    }
    for (const [id, edit] of edits) {
      if (assets.has(id)) continue;
      const original = assets.get(edit.id);
      if (allowMissing && original?.missing) {
        assets.set(id, require('./relink.cjs').missingAsset(rows.find(row=>row.id===id),config));
        continue;
      }
      if (original?.kind !== 'video') throw new Error('找不到可用于恢复剪辑的原始视频。');
      const restored = await prepareSourceEdit(original, edit.ranges, sourceEditDirectory, { signal: cancellation.signal });
      assets.set(id, await inspect(restored, 'video', { signal: cancellation.signal }));
    }
  } catch (error) {
    cancellation.abort();
    throw error;
  }
  if (![...assets.values()].some(asset=>asset.missing)) validateCuts(config, assets);
  return { config, assets };
}

function missingReferences(config, catalog) {
  return [...cleanConfig(config).references.keys()].filter(id => catalog.get(id)?.missing);
}
/** Recreate a missing edit cache from its newly located original and persisted recipe.
 * @param {Record<string, any>} config @param {AssetCatalog} catalog @param {AssetCatalog} found
 * @param {string} directory @param {typeof inspectAsset} inspect */
async function restoreLocatedEdits(config,catalog,found,directory,inspect) {
  for (const [id,recipe] of sourceEdits(config)) {
    if (!catalog.get(id)?.missing || found.has(id)) continue;
    const source=found.get(recipe.id) ?? catalog.get(recipe.id);
    if (!source || source.missing) continue;
    const file=await prepareSourceEdit(source,recipe.ranges,directory);
    found.set(id,await inspect(file,'video'));
  }
}
module.exports = { embeddedThumbnail, readProject, saveProject, loadProject, projectReferences, normalizeScriptModel, missingReferences, validateCuts, restoreLocatedEdits, supportedProject, replaceProjectFile };

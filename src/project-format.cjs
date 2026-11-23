'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  audioExtensions, imageExtensions, videoExtensions, maxShots, maxCandidates, maxMontageBatch, maxWholeTracks,
  inspectAsset, createFrameThumbnail, planMontage, normalizeSubtitleStyle, normalizeGeneratedCaptions, normalizeMutedVideoTracks,
} = require('./media.cjs');
const { normalizeSubtitles } = require('./subtitles.cjs');
const { normalizeSubprojects } = require('./subprojects.cjs');
const { normalizeLayers, normalizeTransform, normalizePackaging } = require('./packaging.cjs');
const { normalizeShotSettings, normalizeRanges, candidateKey, normalizeSegmentVoiceCuts, normalizeSceneCuts } = require('./shot-timing.cjs');
const { normalizeCover } = require('./cover.cjs');
const { audioSpeed, normalizeMusicSpeeds, normalizeVolumeOverrides } = require('./shot-timing.cjs');
const { normalizeLook, inspectLut } = require('./visual-style.cjs');

const format = 'sdworkbench';
const version = 1;
const maxBytes = 1024 * 1024;
const maxScriptBytes = 256 * 1024;
const maxScriptRows = 1000;
const extensions = { audio: audioExtensions, image: imageExtensions, video: videoExtensions, lut:['cube'] };

function localPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || /^[\\/]{2}/.test(file)) return false;
  return process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(file) && !file.slice(2).includes(':'));
}

function requireProjectPath(file) {
  if (!localPath(file) || path.extname(file).toLowerCase() !== '.sdworkbench') {
    throw new Error('请选择本地的 .sdworkbench 工程文件。');
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

function cleanConfig(config) {
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
    if (references.has(id) && references.get(id) !== role) throw new Error('同一素材不能同时作为画面和音频。');
    references.set(id, role);
    return id;
  }
  const recordLayer = (id, kind) => record(id, kind === 'sound' ? 'audio' : kind === 'lut' ? 'lut' : 'visual');
  function cleanShot(shot, index) {
    if (!Array.isArray(shot) || shot.length > maxCandidates) throw new Error(`第 ${index + 1} 组分镜的候选素材数量无效。`);
    const seen = new Set();
    return Array.from(shot, (clip) => {
      const id = record(clip?.id, 'visual');
      if (![clip.start, clip.end].every(Number.isFinite) || clip.start < 0 || clip.end < clip.start) {
        throw new Error(`第 ${index + 1} 组分镜的裁切时间无效。`);
      }
      if (clip.volume !== undefined && (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 100)) {
        throw new Error(`第 ${index + 1} 组分镜的原声音量无效。`);
      }
      if (clip.speed !== undefined && (!Number.isFinite(clip.speed) || clip.speed < 0.5 || clip.speed > Number.MAX_SAFE_INTEGER)) {
        throw new Error(`第 ${index + 1} 组分镜的素材速度无效。`);
      }
      if (clip.matchedDuration !== undefined && (!Number.isFinite(clip.matchedDuration) || clip.matchedDuration < 0.000001 || clip.matchedDuration > 86400)) {
        throw new Error(`第 ${index + 1} 组分镜的匹配时长无效。`);
      }
      if (clip.enabled !== undefined && typeof clip.enabled !== 'boolean') throw new Error('候选参与状态无效。');
      const ranges = clip.ranges === undefined ? undefined : normalizeRanges(clip.ranges, clip.start, clip.end);
      const key = candidateKey({ ...clip, ranges });
      if (seen.has(key)) throw new Error(`第 ${index + 1} 组分镜有重复素材。`);
      seen.add(key);
      return {
        id, start: clip.start, end: clip.end,
        ...(clip.enabled !== undefined && { enabled: clip.enabled }),
        ...(clip.layers !== undefined && { layers: normalizeLayers(clip.layers, recordLayer) }),
        ...(clip.transform !== undefined && { transform: normalizeTransform(clip.transform) }),
        ...(clip.look !== undefined && {look:normalizeLook(clip.look,record)}),
        ...(clip.videoSubtitles && {videoSubtitles:normalizeSubtitles(clip.videoSubtitles)}),
        ...(ranges && { ranges }),
        ...(clip.volume !== undefined && { volume: clip.volume }),
        ...(clip.speed !== undefined && { speed: clip.speed }),
        ...(clip.matchedDuration !== undefined && { matchedDuration: clip.matchedDuration }),
      };
    });
  }
  const shots = Array.from(config.shots, cleanShot);
  const musicIds = Array.from(config.musicIds, (id) => record(id, 'audio'));
  if (new Set(musicIds).size !== musicIds.length) throw new Error('工程中有重复的配乐。');
  const projectConfig = { shots, ratio, resolution, fps, fit, keepAudio, unordered, useOriginal, useMirrors, musicIds, musicVolume, count };
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
  if (config.subprojects !== undefined) projectConfig.subprojects = normalizeSubprojects(config.subprojects, shots.length, cleanShot,(id)=>record(id,'audio'));
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
      return {scope, ids: [...new Set(ids.map((id) => record(id,'visual')))], hidden: [...new Set(hidden)]};
    });
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
  const file = asset?.path;
  const kind = asset?.kind;
  const validKind = role === 'visual' ? ['image','video'].includes(kind) : role === kind;
  if (!role || !validKind || !localPath(file) || !extensions[kind].includes(path.extname(file).slice(1).toLowerCase())) {
    throw new Error(`工程素材 ${id} 缺失或类型不匹配，请重新选择素材。`);
  }
  return { id, kind, path: file };
}

function validateCuts(config, assets) {
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
    const count = populated.length === config.shots.length ? config.count : 1;
    planMontage({
      ...config,
      // Inspect the cuts of every saved candidate, including tracks excluded from the current export.
      shots: populated.map((index) => config.shots[index].map((clip) => ({ ...clip, enabled: true }))),
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
      count,
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
  if (!asset) return null;
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

async function saveProject(file, config, catalog, { overwrite = false } = {}) {
  requireProjectPath(file);
  const { references, config: projectConfig } = cleanConfig(config);
  const assets = [...references].map(([id, role]) => mediaDeclaration(id, catalog.get(id), role));
  validateCuts(projectConfig, catalog);
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
    if (overwrite === true) await fs.rename(temp, file);
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

async function readProject(file) {
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
      return doc;
    } catch {
      throw new Error('工程文件内容无效或已损坏。');
    }
  } finally {
    await reader.close();
  }
}

function projectReferences(project) {
  if (project?.format !== format || project.version !== version) throw new Error('不支持此工程文件格式或版本。');
  const { references, config } = cleanConfig(project.config);
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

async function loadProject(file,resolvePath,inspect=inspectAsset) {
  requireProjectPath(file);
  const {config,rows}=projectReferences(await readProject(file));
  const assets = new Map();
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(60_000)]);
  try {
    for (let index = 0; index < rows.length; index += 4) {
      const batch = await Promise.all(rows.slice(index, index + 4).map(async (row) => {
        try {
          const source=resolvePath ? await resolvePath(row.path) : row.path;
          return [row.id, row.kind==='lut' ? await inspectLut(source) : await inspect(source, row.kind, { signal })];
        } catch (error) {
          const name = path.basename(row.path);
          if (error.code === 'ENOENT') throw new Error(`找不到工程素材「${name}」。请将它放回原位置后重试。`);
          if (signal.aborted) throw new Error('读取工程素材超时。');
          throw new Error(`无法读取工程素材「${name}」。${error.message}`);
        }
      }));
      for (const [id, asset] of batch) assets.set(id, asset);
    }
  } catch (error) {
    cancellation.abort();
    throw error;
  }
  validateCuts(config, assets);
  return { config, assets };
}

module.exports = { embeddedThumbnail, readProject, saveProject, loadProject, projectReferences, normalizeScriptModel };

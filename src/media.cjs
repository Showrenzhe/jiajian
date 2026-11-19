'use strict';

const { execFile, spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const { formatSubtitles, normalizeSubtitles, parseSubtitles } = require('./subtitles.cjs');
const { normalizeShotSettings, normalizeRanges, candidateKey, normalizeSegmentVoiceCuts, sliceSource } = require('./shot-timing.cjs');
const { normalizeCover, selectCover, publishCover } = require('./cover.cjs');
const { normalizeVolumeOverrides } = require('./shot-timing.cjs');
const { normalizeLook, chooseLooks, prepareLooks, lookGraph } = require('./visual-style.cjs');
const { normalizeLayers, normalizeTransform, normalizePackaging, packagingChoices, scheduleLayers } = require('./packaging.cjs');
const { composeLayers, writeLayerTexts } = require('./packaging-render.cjs');
const { visualMotion } = require('./layer-motion.cjs');
const { fontFamily } = require('./text-style.cjs');
const vendorPath = require('./vendor-path.cjs');

const ffmpegCommand = process.env.SUPERDIR_REPLICA_FFMPEG || 'ffmpeg';
const ffmpeg = /[\\/]/.test(ffmpegCommand) ? path.resolve(ffmpegCommand) : ffmpegCommand;
const ffprobe = process.env.SUPERDIR_REPLICA_FFPROBE || 'ffprobe';
const execFileAsync = promisify(execFile);
const subtitleFileName = 'subtitles.srt';
// libass force_style sets the alignment flags directly, with horizontal center = 2.
const subtitleAlignments = { bottom: 2, middle: 8 | 2, top: 4 | 2, custom: 8 | 2 };
const videoExtensions = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'mpeg', 'mpg', 'mts', 'm2ts'];
const imageExtensions = ['png', 'jpg', 'jpeg', 'bmp', 'webp'];
const audioExtensions = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus'];
const mediaInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpeg,mp3,wav,aac,flac,ogg'];
const stillInput = ['-protocol_whitelist', 'file,pipe', '-f', 'image2', '-pattern_type', 'none'];
// The old UI imposed a 16-shot product limit. Keep a generous serialization
// guard for malformed or runaway projects without exposing that legacy cap.
const maxShots = 1000;
const maxCandidates = 100;
const maxExports = 50;
const maxWholeTracks = 250;
const minClipSeconds = 0.1;
const maxStillSeconds = 60;
const minEdgeSilence = 0.12;
const seamPadding = 0.025;
const audioRate = 48000;
const dimensions = {
  '16:9': { 720: [1280, 720], 1080: [1920, 1080] },
  '9:16': { 720: [720, 1280], 1080: [1080, 1920] },
  '1:1': { 720: [720, 720], 1080: [1080, 1080] },
};

function runTool(executable, args, { signal, timeout = 0, onProgress, onLine, cwd } = {}) {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let failure;
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = timeout ? setTimeout(() => {
      failure = new Error('读取媒体信息超时。');
      stop();
    }, timeout) : null;

    child.on('error', (error) => {
      failure = error.code === 'ENOENT'
        ? new Error(`找不到 ${path.basename(executable)}，请检查 FFmpeg 和 FFprobe。`)
        : error;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part) => { errors = (errors + part).slice(-3000); });

    if (onLine || onProgress) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', onLine ?? ((line) => {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) onProgress(Number(match[1]) / 1e6);
      }));
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (part) => {
        output += part;
        if (output.length > 512 * 1024) {
          failure = new Error('媒体信息超过读取上限。');
          stop();
        }
      });
    }

    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errors.trim() || `媒体工具退出（${code}）。`));
      resolve(output);
    });
  });
}

async function inspectAsset(file, kind, { signal } = {}) {
  const extensions = { video: videoExtensions, audio: audioExtensions, image: imageExtensions };
  const allowed = Object.hasOwn(extensions, kind) ? extensions[kind] : [];
  if (!path.isAbsolute(file) || !allowed.includes(path.extname(file).slice(1).toLowerCase())) {
    throw new Error('请选择受支持的媒体文件。');
  }
  if (!(await fs.stat(file)).isFile()) throw new Error('所选路径不是文件。');

  const data = JSON.parse(await runTool(ffprobe, [
    '-v', 'error', ...(kind === 'image' ? stillInput : mediaInput),
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,pix_fmt,width,height,duration,avg_frame_rate:stream_tags=alpha_mode:stream_disposition=attached_pic:stream_side_data=rotation',
    '-of', 'json', '-i', file,
  ], { signal, timeout: 15000 }));

  const video = data.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  const stream = kind === 'audio' ? audio : video;
  if (!stream) throw new Error(kind === 'audio' ? '没有可用的音轨。' : '没有可用的视频帧。');
  if (kind !== 'audio' && (!video.width || !video.height)) throw new Error('无法读取素材尺寸。');

  const duration = [stream.duration, data.format?.duration]
    .map(Number)
    .find((value) => Number.isFinite(value) && value >= minClipSeconds);
  if (!duration && kind !== 'image') throw new Error('无法读取有效时长，素材至少需要 0.1 秒。');

  const rotation = Number(video?.side_data_list?.find((item) => item.rotation !== undefined)?.rotation || 0);
  const portraitRotation = Math.abs(rotation % 180) === 90;
  const [frames, seconds] = (video?.avg_frame_rate || '').split('/').map(Number);
  return {
    path: file,
    name: path.basename(file),
    kind,
    duration: kind === 'image' ? null : Math.floor((duration + 1e-9) * 1000) / 1000,
    codec: stream.codec_name || '',
    ...((video?.tags?.alpha_mode === '1' || /^(?:rgba|bgra|argb|abgr|yuva|gbrap|ya8|pal8)/.test(video?.pix_fmt ?? '')) && { alpha: true }),
    width: kind === 'audio' ? null : (portraitRotation ? video.height : video.width),
    height: kind === 'audio' ? null : (portraitRotation ? video.width : video.height),
    fps: kind === 'video' && frames > 0 && seconds > 0 ? frames / seconds : null,
    videoIndex: kind === 'audio' ? null : video.index,
    audioIndex: audio?.index ?? null,
  };
}

async function extractAudioWaveform(asset, range, {signal} = {}) {
  if (!['audio','video'].includes(asset?.kind) || !Number.isInteger(asset.audioIndex) || asset.audioIndex < 0) return null;
  const {duration} = asset;
  const start = range?.start ?? 0, end = Math.min(range?.end ?? duration, duration);
  if (!Number.isFinite(duration) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) return null;
  const samples = Math.round((end - start) * audioRate);
  if (!samples) return null;
  // Bound each decoded frame as well as the total number of peaks, even for a feature-length file.
  const targetSamples = Math.max(audioRate / 100, Math.ceil(samples / 4096));
  const framesPerPeak = Math.ceil(targetSamples / audioRate);
  const frameSamples = Math.ceil(targetSamples / framesPerPeak);
  const samplesPerPeak = framesPerPeak * frameSamples;
  const peaks = Array(Math.ceil(samples / samplesPerPeak)).fill(0);
  let frame = 0;
  const filters = [
    'aresample=48000:async=1:first_pts=0', `atrim=end_sample=${samples}`, `asetnsamples=n=${frameSamples}:p=0`,
    'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level',
    'ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=-',
  ];
  await runTool(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_threads','1',
    ...mediaInput, ...(start ? ['-ss',String(start)] : []), '-t',String(end-start),'-i',asset.path,
    '-map',`0:${asset.audioIndex}`,'-vn','-sn','-dn','-af',filters.join(','),'-f','null','-'], {
    signal, timeout: Math.max(30000, Math.min(600000, (end - start) * 150)),
    onLine(line) {
      const prefix = 'lavfi.astats.Overall.Peak_level=';
      if (!line.startsWith(prefix)) return;
      const index = Math.floor(frame++ / framesPerPeak);
      const db = Number(line.slice(prefix.length));
      if (index < peaks.length && Number.isFinite(db)) peaks[index] = Math.max(peaks[index], Math.min(1, 10 ** (db / 20)));
    },
  });
  return {start,end,duration,step:samplesPerPeak / audioRate,peaks};
}

async function createVideoThumbnail(asset, { signal, time: requestedTime } = {}) {
  const file = asset?.path;
  if (asset?.kind !== 'video' || typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')
      || /^[\\/]{2}/.test(file) || !videoExtensions.includes(path.extname(file).slice(1).toLowerCase())
      || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':')))
      || !Number.isInteger(asset.videoIndex) || asset.videoIndex < 0) return null;
  signal?.throwIfAborted();
  const info = await fs.stat(file).catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info?.isFile()) return null;
  const start = Number.isFinite(requestedTime) && Number.isFinite(asset.duration)
    ? Math.max(0,Math.min(requestedTime,asset.duration-1/(asset.fps||30)))
    : Number.isFinite(asset.duration) && asset.duration >= 0.25 ? Math.min(1, asset.duration / 10) : 0;
  const { stdout } = await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...mediaInput,
    '-ss', String(start), '-threads', '1', '-i', file, '-map', `0:${asset.videoIndex}`, '-frames:v', '1',
    '-filter_threads', '1', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1',
    '-an', '-sn', '-dn', '-c:v', 'mjpeg', '-q:v', '4', '-threads', '1', '-f', 'image2pipe', 'pipe:1',
  ], { signal, timeout: 6000, maxBuffer: 512 * 1024, encoding: 'buffer', windowsHide: true });
  return stdout.length > 4 && stdout[0] === 0xff && stdout[1] === 0xd8
    && stdout.at(-2) === 0xff && stdout.at(-1) === 0xd9 ? stdout : null;
}

async function createTrackProxy(asset, output, signal) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', ...mediaInput, '-i', asset.path,
    '-map', `0:${asset.videoIndex}`, '-filter_threads', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1',
    '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough'];
  if (asset.audioIndex !== null) args.push('-map', `0:${asset.audioIndex}`, '-c:a', 'aac', '-ac', '2', '-b:a', '96k');
  else args.push('-an');
  args.push('-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', output);
  await runTool(ffmpeg, args, { signal });
}

async function analyzeNarrationSilence(asset, { signal } = {}) {
  if (asset?.kind !== 'audio' || !Number.isInteger(asset.audioIndex) || asset.audioIndex < 0
      || !Number.isFinite(asset.duration) || asset.duration < minClipSeconds
      || typeof asset.path !== 'string' || !path.isAbsolute(asset.path)) {
    throw new Error('无法分析口播音频。');
  }
  const output = await runTool(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', ...mediaInput, '-threads', '1', '-i', asset.path,
    '-map', `0:${asset.audioIndex}`, '-vn', '-sn', '-dn',
    '-af', `asetpts=PTS-STARTPTS,silencedetect=noise=-40dB:d=${minEdgeSilence},ametadata=mode=print:file=-`,
    '-f', 'null', '-',
  ], { signal, timeout: 30000 });
  let leading = 0;
  let quietStart = null;
  for (const [, event, seconds] of output.matchAll(/^lavfi\.silence_(start|end)=([\d.e+-]+)$/gm)) {
    const position = Number(seconds);
    if (!Number.isFinite(position)) continue;
    if (event === 'start') {
      quietStart = position;
    } else {
      if (quietStart !== null && quietStart < 0.001) leading = position;
      quietStart = null;
    }
  }
  if (quietStart !== null && quietStart < 0.001) return { leading: 0, trailing: 0 };
  const trailing = quietStart === null ? 0 : Math.max(0, asset.duration - quietStart);
  return { leading, trailing };
}

function requireAsset(catalog, id, ...kinds) {
  const asset = typeof id === 'string' ? catalog.get(id) : null;
  if (!asset || !kinds.includes(asset.kind)) throw new Error('请重新导入缺失的素材。');
  return asset;
}

function requireNumber(value, min, max, description) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${description}应在 ${min} 到 ${max} 之间。`);
  }
  return value;
}

function isRgbColor(value) {
  return typeof value === 'string' && value.length === 7 && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeMutedVideoTracks(value = []) {
  if (!Array.isArray(value) || value.length > maxCandidates || new Set(value).size !== value.length
      || Array.from(value).some((index) => !Number.isInteger(index) || index < 0 || index >= maxCandidates)) {
    throw new Error('视频轨静音编号无效。');
  }
  return [...value].sort((a, b) => a - b);
}

function normalizeSubtitleStyle(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('字幕样式无效。');
  const { size = 18, textColor = '#ffffff', outlineColor = '#000000', position = 'bottom' } = value;
  if (!Number.isInteger(size) || size < 8 || size > 72) throw new Error('字幕字号应在 8 到 72 之间。');
  if (!isRgbColor(textColor) || !isRgbColor(outlineColor)) throw new Error('字幕颜色须为 #RRGGBB。');
  if (typeof position !== 'string' || !Object.hasOwn(subtitleAlignments, position)) throw new Error('字幕位置无效。');
  const style = { size, textColor: textColor.toLowerCase(), outlineColor: outlineColor.toLowerCase(), position };
  if (value.font !== undefined) {
    if (typeof value.font !== 'string' || !fontFamily(value.font)) throw new Error('请选择有效字幕字体。');
    style.font = value.font;
  }
  if (value.align !== undefined) {
    if (!['left','center','right'].includes(value.align)) throw new Error('字幕水平位置无效。');
    style.align = value.align;
  }
  for (const key of ['enabled','bold','italic','underline']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') throw new Error('字幕样式开关无效。');
    style[key] = value[key];
  }
  for (const [key, max] of [['outlineWidth',8],['spacing',12],['margin',64],['x',100],['y',100]]) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max) throw new Error('字幕位置、边距、字距或描边宽度无效。');
    style[key] = value[key];
  }
  return style;
}

function drawCombinations(shots, count, random) {
  const choices = new Map();
  const add = (indices) => choices.set(indices.join(','), indices);
  for (let attempt = 0; choices.size < count && attempt < count * 8; attempt += 1) {
    add(shots.map((shot) => Math.floor(random() * shot.length)));
  }
  // When almost every combination was requested, fill the few remaining slots without repeated retries.
  for (let index = 0; choices.size < count; index += 1) {
    let cursor = index;
    add(shots.map((shot) => {
      const selected = cursor % shot.length;
      cursor = Math.floor(cursor / shot.length);
      return selected;
    }));
  }
  return [...choices.values()];
}

function normalizeGeneratedCaptions(value, config) {
  if (value == null) return {};
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('口播字幕设置无效。');
  const attached = new Set([config.narrationId]);
  if (Array.isArray(config.extraWholeTracks)) {
    for (const track of config.extraWholeTracks) attached.add(track?.narrationId);
  }
  if (Array.isArray(config.segmentNarrationIds)) {
    for (const row of config.segmentNarrationIds) {
      if (Array.isArray(row)) for (const id of row) attached.add(id);
    }
  }

  const entries = Object.entries(value);
  if (entries.length > maxWholeTracks * (maxShots+1)) throw new Error('口播字幕数量超出上限。');
  return Object.fromEntries(entries.map(([id, text]) => {
    if (!attached.has(id)) throw new Error('口播字幕必须对应工程中的口播音频。');
    if (text && typeof text === 'object' && !Array.isArray(text)) return [id, normalizeSubtitles(text)];
    if (typeof text !== 'string' || text.length > 500) throw new Error('口播字幕须为不超过 500 字的文本或有效的带时间码字幕。');
    const cleaned = text.toWellFormed().replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
      .replace(/\n(?:[ \t]*\n)+/g, '\n').trim();
    if (!cleaned) throw new Error('口播字幕内容为空。');
    return [id, cleaned];
  }));
}

function captionFor(captions, id) {
  return Object.hasOwn(captions, id) ? captions[id] : null;
}

function segmentNarrationGroups(config, catalog, captions) {
  const ids = config.segmentNarrationIds === undefined ? [] : config.segmentNarrationIds;
  const cuts = normalizeSegmentVoiceCuts(config.segmentVoiceCuts, ids, catalog);
  const selection = config.segmentNarrationSelection === undefined ? 'ordered' : config.segmentNarrationSelection;
  if (!Array.isArray(ids) || ids.length > config.shots.length || !['ordered', 'random'].includes(selection)) {
    throw new Error('分段口播的分镜或匹配方式无效。');
  }
  const rows = config.shots.map((_shot, index) => {
    const row = ids[index] === undefined ? [] : ids[index];
    if (!Array.isArray(row) || row.length > maxWholeTracks) throw new Error(`第 ${index + 1} 组分镜的口播数量无效。`);
    return Array.from(row, (id, rowIndex) => id === null ? null : {
      asset: requireAsset(catalog, id, 'audio'),
      caption: captionFor(captions, id),
      ranges: cuts?.[index][rowIndex]?.ranges,
      offset: cuts?.[index][rowIndex]?.offset,
      rowIndex,
    });
  });
  if (selection === 'random') {
    const groups = rows.map((row) => {
      const voices = row.filter(Boolean);
      return voices.length ? voices : [null];
    });
    return { groups, pick: (choices, index) => groups[index][choices[index]] };
  }
  const tracks = Array.from({ length: maxWholeTracks }, (_, index) => index)
    .filter((index) => rows.some((row) => row[index]));
  return {
    groups: [tracks.length ? tracks : [-1]],
    pick: (choices, index) => rows[index][tracks[choices[0]]] ?? null,
  };
}

function wholeNarrationTracks(config, catalog, captions) {
  const extras = config.extraWholeTracks === undefined ? [] : config.extraWholeTracks;
  if (!Array.isArray(extras) || extras.length >= maxWholeTracks) {
    throw new Error(`整段口播最多可设置 ${maxWholeTracks} 条轨道。`);
  }
  return [config, ...extras].map((track) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) throw new Error('整段口播轨道设置无效。');
    return {
      narration: track.narrationId == null ? null : requireAsset(catalog, track.narrationId, 'audio'),
      subtitles: normalizeSubtitles(track.subtitles),
      caption: track.narrationId == null ? null : captionFor(captions, track.narrationId),
    };
  });
}

function readShotTransitions(value, count) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length !== count) throw new Error('转场设置必须与分镜对应。');
  return Array.from(value, (transition, index) => {
    if (transition === null) return null;
    if (!['fade-black', 'fade-white'].includes(transition?.kind)) throw new Error(`第 ${index + 1} 组的转场类型无效。`);
    return { kind: transition.kind, duration: requireNumber(transition.duration, 0.1, 2, '转场时长') };
  });
}

function withOutputFrames(clip, duration, fps) {
  const outputFrames = Math.max(1, Math.ceil(duration * fps - 1e-7));
  return { ...clip, outputFrames, outputDuration: outputFrames / fps };
}

function segmentSpeechDuration(clip) {
  const available = (clip.timelineDuration ?? clip.shotDuration ?? clip.duration) - (clip.voiceOffset ?? 0);
  return Math.max(0, Math.min(clip.narrationDuration ?? voiceLength(clip), available));
}

function voiceLength(clip) {
  return clip.narrationRanges?.reduce((sum, range) => sum + range.end - range.start, 0) ?? clip.narration.duration;
}

function appendCaptionCues(cues, caption, offset, speechDuration, speechStart = 0) {
  if (!caption) return;
  const start = Math.round(offset * 1000);
  const stop = Math.round((offset + speechDuration) * 1000);
  if (stop <= start) return;
  if (typeof caption === 'string') {
    cues.push({ start, end: stop, text: caption });
    return;
  }
  const sourceStart = Math.round(speechStart * 1000);
  for (const cue of caption.cues) {
    const shiftedStart = Math.max(start, start + cue.start - sourceStart);
    const shiftedEnd = Math.min(start + cue.end - sourceStart, stop);
    if (shiftedEnd > shiftedStart) cues.push({ ...cue,start: shiftedStart, end: shiftedEnd });
  }
}

function generatedSubtitleTrack({ segmented, clips, narration, caption, duration }) {
  const cues = [];
  if (segmented) {
    let position = 0;
    for (const clip of clips) {
      if (clip.caption && clip.narrationRanges && typeof clip.caption !== 'string') {
        const retained = sliceSource(clip.narrationRanges, clip.narrationStart ?? 0, segmentSpeechDuration(clip));
        let time = position + (clip.voiceOffset ?? 0);
        for (const range of retained) {
          appendCaptionCues(cues, clip.caption, time, range.end - range.start, range.start);
          time += range.end - range.start;
        }
      } else if (clip.caption) appendCaptionCues(cues, clip.caption, position + (clip.voiceOffset ?? 0), segmentSpeechDuration(clip), clip.narrationStart);
      position += clip.timelineDuration ?? clip.outputDuration;
    }
  } else if (narration) {
    appendCaptionCues(cues, caption, 0, Math.min(narration.duration, duration));
  }
  return cues.length ? normalizeSubtitles({ name: caption?.name ?? '口播字幕', cues }) : null;
}

function voiceRange(clips, index) {
  const clip = clips[index];
  const voice = clip.narration;
  const duration = voiceLength(clip);
  const { leading = 0, trailing = 0 } = voice.edgeSilence ?? {};
  const first = clip.narrationRanges?.[0], last = clip.narrationRanges?.at(-1);
  const head = first ? Math.min(first.end - first.start, leading - first.start) : leading;
  const tail = last ? Math.min(last.end - last.start, trailing - (voice.duration - last.end)) : trailing;
  const start = clips[index - 1]?.narration && head >= minEdgeSilence ? head - seamPadding : 0;
  const end = clips[index + 1]?.narration && tail >= minEdgeSilence ? tail - seamPadding : 0;
  if (!Number.isFinite(start + end) || duration - start - end < minClipSeconds) {
    return { narrationStart: 0, narrationDuration: duration };
  }
  return { narrationStart: start, narrationDuration: duration - start - end };
}

function visualPool(shot, selected) {
  return [selected, ...shot.filter((candidate) => candidate !== selected && candidate.mirror === selected.mirror)];
}

function pieces(clip) {
  if (!clip.retainedRanges) return [clip];
  const { retainedRanges, ...base } = clip;
  return retainedRanges.map(({ start, end }) => ({
    ...base, start, sourceDuration: end - start, duration: (end - start) / base.speed,
    layerStart: start - base.candidateStart,
  }));
}

function trimVisualEnd(visual, seconds) {
  const sourceDuration = seconds * (visual.speed ?? 1);
  return { ...visual, sourceDuration, duration: seconds };
}

function referenceVisuals(clip, target, frames, fps) {
  const original = pieces(clip);
  if (clip.duration <= target) return fitVisuals(clip, original, clip.duration / target, frames, fps);
  let remaining = target;
  const kept = [];
  for (const visual of original) {
    kept.push(visual.duration > remaining ? trimVisualEnd(visual, remaining) : visual);
    remaining -= visual.duration;
    if (remaining < 1e-9) break;
  }
  return fitVisuals(clip, kept, 1, frames, fps);
}

function visualDuration(visuals) {
  return visuals.reduce((seconds, visual) => seconds + visual.duration * (visual.repeat ?? 1), 0);
}

function repeatVisual(visuals, seconds) {
  if (seconds <= 1e-9) return;
  const shortest = visuals.reduce((best, visual) => visual.duration < best.duration ? visual : best);
  const repeat = Math.max(1, Math.ceil(seconds / shortest.duration - 1e-7));
  if (shortest === visuals.at(-1)) visuals[visuals.length - 1] = { ...shortest, repeat: repeat + 1 };
  else visuals.push({ ...shortest, repeat });
}

function fitVisuals(clip, visuals, tempo, outputFrames, fps) {
  let duration = 0;
  let assigned = 0;
  const parts = visuals.map((visual, index) => {
    duration += visual.duration * (visual.repeat ?? 1) / tempo;
    const boundary = index === visuals.length - 1 ? outputFrames : Math.min(outputFrames, Math.round(duration * fps));
    const frames = boundary - assigned;
    assigned = boundary;
    return { ...visual, speed: (visual.speed ?? 1) * tempo, outputFrames: frames, outputDuration: frames / fps };
  });
  return { ...clip, visuals: parts, outputFrames, outputDuration: outputFrames / fps };
}

function fitSegmentedVoice(clips, pools, fps, alignment) {
  let samples = 0;
  let assigned = 0;
  return clips.map((clip, index) => {
    const range = clip.narration ? (alignment === 'reference'
      ? { narrationStart: 0, narrationDuration: voiceLength(clip) } : voiceRange(clips, index)) : null;
    const target = range ? (clip.voiceOffset ?? 0) + range.narrationDuration : withOutputFrames(clip, clip.shotDuration ?? clip.duration, fps).outputDuration;
    const clipSamples = Math.round(target * audioRate);
    const timelineDuration = clipSamples / audioRate;
    samples += clipSamples;
    const frameBoundary = samples * fps / audioRate;
    const boundary = index === clips.length - 1 ? Math.ceil(frameBoundary) : Math.round(frameBoundary);
    const outputFrames = boundary - assigned;
    assigned = boundary;
    const timed = { ...clip, ...range, timelineDuration };
    if (range && alignment === 'reference') return referenceVisuals(timed, target, outputFrames, fps);
    if (!range && !clip.retainedRanges && !clip.shotDuration) return { ...timed, outputFrames, outputDuration: outputFrames / fps };
    const visuals = [];
    let duration = 0;
    for (const visual of pools[index]) {
      visuals.push(...pieces(visual));
      duration += visual.duration;
      if (duration >= target - 1e-9) break;
    }
    repeatVisual(visuals, target - duration);
    const tempo = Math.max(1, visualDuration(visuals) / target);
    return fitVisuals(timed, visuals, tempo, outputFrames, fps);
  });
}

function fitWholeVoice(clips, pools, target, fps) {
  const selections = pools.map(([selected]) => [selected]);
  const base = clips.reduce((seconds, clip) => seconds + clip.duration, 0);
  let duration = base;
  for (let candidate = 1; candidate < maxCandidates && duration < target - 1e-9; candidate += 1) {
    for (const [index, pool] of pools.entries()) {
      const visual = pool[candidate];
      if (!visual) continue;
      selections[index].push(visual);
      duration += visual.duration;
      if (duration >= target - 1e-9) break;
    }
  }
  const shortfall = target - duration;
  for (const [i, selected] of selections.entries()) selections[i] = selected.flatMap(pieces);
  if (shortfall > 1e-9) {
    for (const [index, visuals] of selections.entries()) repeatVisual(visuals, shortfall * clips[index].duration / base);
  }
  const durations = selections.map(visualDuration);
  const tempo = Math.max(1, durations.reduce((total, seconds) => total + seconds, 0) / target);
  const outputFrames = withOutputFrames(clips[0], target, fps).outputFrames;
  let elapsed = 0;
  let assigned = 0;
  return clips.map((clip, index) => {
    elapsed += durations[index] / tempo;
    const boundary = index === clips.length - 1 ? outputFrames : Math.min(outputFrames, Math.round(elapsed * fps));
    const frames = boundary - assigned;
    assigned = boundary;
    return fitVisuals(clip, selections[index], tempo, frames, fps);
  });
}

function fitReferenceWhole(clips, target, fps) {
  const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const stretch = Math.max(1, target / total);
  const result = [];
  let elapsed = 0;
  let assigned = 0;
  for (const clip of clips) {
    const seconds = Math.min(target - elapsed, clip.duration * stretch);
    if (seconds <= 1e-9) break;
    elapsed += seconds;
    const boundary = elapsed >= target - 1e-9 ? Math.ceil(target * fps - 1e-7) : Math.round(elapsed * fps);
    if (boundary > assigned) result.push(referenceVisuals(clip, seconds, boundary - assigned, fps));
    assigned = boundary;
  }
  return result;
}

function planMontage(config, catalog, random = Math.random, batchLimit = maxExports) {
  const checkLayerAsset = (id, kind) => {
    const expected = kind === 'sound' ? ['audio'] : kind === 'lut' ? ['lut'] : kind === 'sticker' ? ['image'] : ['image', 'video'];
    requireAsset(catalog, id, ...expected);
    return id;
  };
  if (!Array.isArray(config?.shots) || !config.shots.length || config.shots.length > maxShots) {
    throw new Error(`请设置 1 至 ${maxShots} 组分镜。`);
  }
  const size = Object.hasOwn(dimensions, config.ratio) ? dimensions[config.ratio][config.resolution] : null;
  if (!Array.isArray(size) || ![24, 25, 30, 60].includes(config.fps) || !['fit', 'fill'].includes(config.fit)) {
    throw new Error('请选择有效的画幅、分辨率、帧率和填充方式。');
  }
  if (typeof config.keepAudio !== 'boolean') throw new Error('请选择原声设置。');
  if (typeof config.unordered !== 'boolean') throw new Error('请选择分镜顺序。');
  if (typeof config.useOriginal !== 'boolean' || typeof config.useMirrors !== 'boolean' || !(config.useOriginal || config.useMirrors)) {
    throw new Error('至少选择原素材或水平镜像素材中的一种。');
  }
  if (!Number.isInteger(config.count)) throw new Error('生成数量必须是整数。');
  const transitions = readShotTransitions(config.shotTransitions, config.shots.length);
  const settings = normalizeShotSettings(config.shotSettings, config.shots.length);
  const coverSettings = normalizeCover(config.cover, (id) => { requireAsset(catalog, id, 'video', 'image'); return id; });
  const mutedTracks = new Set(normalizeMutedVideoTracks(config.mutedVideoTracks));
  const alignment = config.voiceAlignment ?? 'fill';
  if (!['fill', 'reference'].includes(alignment)) throw new Error('口播对齐规则无效。');
  const backgroundColor = config.backgroundColor === undefined ? '#000000' : config.backgroundColor;
  if (!isRgbColor(backgroundColor)) throw new Error('画面背景颜色须为 #RRGGBB。');
  const subtitleStyle = config.subtitleStyle === undefined ? undefined : normalizeSubtitleStyle(config.subtitleStyle);

  const shots = config.shots.map((shot, index) => {
    if (!Array.isArray(shot) || !shot.length || shot.length > maxCandidates) {
      throw new Error(`第 ${index + 1} 组需要 1 至 ${maxCandidates} 条候选视频。`);
    }
    const ids = new Set();
    const originals = shot.flatMap((clip, trackIndex) => {
      if (clip?.enabled !== undefined && typeof clip.enabled !== 'boolean') throw new Error('候选参与状态无效。');
      if (clip?.enabled === false) return [];
      const asset = requireAsset(catalog, clip?.id, 'video', 'image');
      const volume = clip.volume === undefined ? 1 : requireNumber(clip.volume, 0, 100, `${asset.name} 的原声音量`) / 100;
      const speed = clip.speed === undefined ? 1 : requireNumber(clip.speed, 0.5, 3, `${asset.name} 的播放速度`);
      const ranges = clip.ranges === undefined ? undefined : normalizeRanges(clip.ranges, clip.start, clip.end);
      const key = candidateKey({ ...clip, ranges });
      if (ids.has(key)) throw new Error(`第 ${index + 1} 组有重复素材。`);
      ids.add(key);
      const layers = clip.layers === undefined ? {} : { layers: normalizeLayers(clip.layers, checkLayerAsset) };
      if (clip.transform !== undefined) layers.transform = normalizeTransform(clip.transform);
      if (clip.look !== undefined) layers.look = normalizeLook(clip.look,(id,role)=>{requireAsset(catalog,id,...(role==='lut'?['lut']:['image','video']));return id;});
      const shotDuration = settings?.[index]?.duration;
      if (asset.kind === 'image') {
        if (ranges) throw new Error('图片不支持视频区间裁剪。');
        const duration = requireNumber(clip.end, minClipSeconds, maxStillSeconds, `${asset.name} 的播放时长`);
        return { asset, start: 0, volume: 0, duration: shotDuration ?? duration, ...layers };
      }
      const start = requireNumber(clip.start, 0, asset.duration, `${asset.name} 的入点`);
      const end = requireNumber(clip.end, 0, asset.duration, `${asset.name} 的出点`);
      if (clip.videoSubtitles && subtitleStyle?.enabled !== false) {
        const cues=normalizeSubtitles(clip.videoSubtitles).cues;
        const captions=cues.filter((c)=>c.end/1000>start && c.start/1000<end).map((c)=>({
          kind:'text',sourceCaption:true,text:c.text,highlights:c.highlights,start:Math.max(0,c.start/1000-start),end:Math.min(end,c.end/1000)-start,
          color:subtitleStyle?.textColor ?? '#ffffff',fontSize:(subtitleStyle?.size ?? 18)*2,
          x:.5,y:({top:.14,middle:.5,bottom:.86,custom:(subtitleStyle?.y ?? 85)/100})[subtitleStyle?.position ?? 'bottom'],scale:1,
        }));
        layers.layers=[...(layers.layers ?? []),...captions];
      }
      if (end - start < minClipSeconds - 1e-9) throw new Error(`${asset.name} 的有效片段至少需要 0.1 秒。`);
      let retained = ranges ?? [{ start, end }];
      let sourceDuration = retained.reduce((sum, range) => sum + range.end - range.start, 0);
      if(layers.look?.head || layers.look?.tail){
        sourceDuration -= (layers.look.head??0)+(layers.look.tail??0);
        if(sourceDuration<minClipSeconds-1e-7)throw new Error(asset.name+' 去片头片尾后不足 0.1 秒。');
        retained=sliceSource(retained,layers.look.head??0,sourceDuration);
      }
      if (shotDuration && sourceDuration > shotDuration * speed) {
        const size = shotDuration * speed;
        const offset = settings[index].smartTrim ? random() * (sourceDuration - size) : 0;
        retained = sliceSource(retained, offset, size);
        sourceDuration = size;
      }
      return { asset, start: retained[0].start, sourceDuration, duration: sourceDuration / speed, speed, volume: mutedTracks.has(trackIndex) ? 0 : volume, ...layers,
        ...(retained.length > 1 && { retainedRanges: retained, candidateStart: start }),
        ...(retained[0].start !== start && { layerStart: retained[0].start - start }),
        ...(shotDuration && { shotDuration }),
      };
    });
    if (!originals.length) throw new Error(`第 ${index + 1} 组分镜至少需要一条参与混剪的候选。`);
    return [
      ...(config.useOriginal ? originals : []),
      ...(config.useMirrors ? originals.map((clip) => ({ ...clip, mirror: true })) : []),
    ];
  });
  const narrationMode = config.narrationMode === undefined ? 'whole' : config.narrationMode;
  if (!['whole', 'segmented'].includes(narrationMode)) throw new Error('请选择有效的口播方式。');
  const captions = normalizeGeneratedCaptions(config.generatedCaptions, config);
  const segmented = narrationMode === 'segmented' ? segmentNarrationGroups(config, catalog, captions) : null;
  const wholeTracks = segmented ? [] : wholeNarrationTracks(config, catalog, captions);
  const voiceGroups = segmented?.groups ?? (wholeTracks.length > 1 ? [wholeTracks] : []);
  const pack = normalizePackaging(config.packaging ?? {}, checkLayerAsset, shots.length);
  const packaging = packagingChoices(pack, shots.length);
  const coverShot = coverSettings?.mode === 'first-shot';
  const groups = shots.map((shot,i) => coverShot && i === 0 ? [shot[0]] : shot).concat(voiceGroups, packaging.groups);
  const combinations = groups.reduce((total, group) => Math.min(batchLimit, total * group.length), 1);
  const count = requireNumber(config.count, 1, combinations, '生成数量');
  if (!Array.isArray(config.musicIds) || config.musicIds.length > maxCandidates || new Set(config.musicIds).size !== config.musicIds.length) {
    throw new Error('配乐库设置无效。');
  }
  const musicStartShot = config.musicStartShot ?? null;
  if (musicStartShot !== null && (!Number.isInteger(musicStartShot) || musicStartShot < 0 || musicStartShot >= shots.length)) {
    throw new Error('配乐起始分镜无效。');
  }
  const musicPool = config.musicIds.map((id) => requireAsset(catalog, id, 'audio'));
  const musicVolume = musicPool.length ? requireNumber(config.musicVolume, 0, 100, '配乐音量') / 100 : 0;
  const narrationVolume = config.narrationVolume === undefined ? 1 : requireNumber(config.narrationVolume, 0, 100, '口播音量') / 100;
  const priority = config.priority === undefined ? 'picture' : config.priority;
  if (!['picture', 'voice'].includes(priority)) throw new Error('请选择有效的混剪合成模式。');

  const effectUseCounts = new Map();
  const gains = new Map(normalizeVolumeOverrides(config.volumeOverrides??[],(id)=>{requireAsset(catalog,id,'audio');return id;},shots.length)
    .map(row=>[JSON.stringify([row.kind,row.id,row.shot??null,row.track??null]),row.value/100]));
  const gain=(kind,id,shot,track)=>gains.get(JSON.stringify([kind,id,shot??null,track??null]));
  return drawCombinations(groups, count, random).map((indices) => {
    if (coverShot) indices[0] = Math.min(shots[0].length - 1,Math.floor(random()*shots[0].length));
    const narrationChoices = indices.slice(shots.length, shots.length + voiceGroups.length);
    const selection = packaging.select(indices.slice(shots.length + voiceGroups.length));
    const wholeTrackIndex = narrationChoices[0] ?? 0;
    const { narration = null, subtitles = null, caption = null } = wholeTracks[wholeTrackIndex] ?? {};
    const scenes = shots.map((shot, index) => {
      const candidate = shot[indices[index]];
      const match = segmented?.pick(narrationChoices, index);
      const clip = {
        ...candidate,
        shotIndex: index,
        ...(transitions[index] && { transition: transitions[index] }),
        ...(segmented && { narration: match?.asset ?? null }),
        ...(match && { narrationRow: match.rowIndex }),
        ...(match && gain('segment',config.segmentNarrationIds[index][match.rowIndex],index,match.rowIndex)!=null && {voiceGain:gain('segment',config.segmentNarrationIds[index][match.rowIndex],index,match.rowIndex)}),
        ...(match?.caption && { caption: match.caption }),
        ...(match?.ranges && { narrationRanges: match.ranges }),
        ...(match?.offset && { voiceOffset: match.offset }),
      };
      return { clip, shot, index };
    });
    if (config.unordered) {
      const first = coverShot ? 1 : 0;
      for (let index = scenes.length - 1; index > first; index -= 1) {
        const other = first + Math.floor(random() * (index + 1 - first));
        [scenes[index], scenes[other]] = [scenes[other], scenes[index]];
      }
    }
    const musicStartIndex = musicStartShot === null ? 0 : scenes.findIndex(({ index }) => index === musicStartShot);
    let clips = scenes.map(({ clip }) => clip);
    if (clips.at(-1).transition) clips.at(-1).transition = null;
    const voicePriority = priority === 'voice' && (segmented || narration);
    const frameAligned = voicePriority || segmented || clips.some((clip) => clip.retainedRanges || clip.shotDuration || clip.speed !== undefined && clip.speed !== 1);
    const pools = scenes.map(({ shot, index }) => visualPool(shot, shot[indices[index]]));
    if (voicePriority) {
      if (segmented) clips = fitSegmentedVoice(clips, pools, config.fps, alignment);
      else if (alignment === 'reference') clips = fitReferenceWhole(clips, narration.duration, config.fps);
      else clips = fitWholeVoice(clips, pools, narration.duration, config.fps);
    } else if (frameAligned) {
      clips = clips.map((clip, index) => {
        const duration = clip.shotDuration ?? clip.duration;
        const framed = withOutputFrames(clip, duration, config.fps);
        if (!clip.retainedRanges && duration <= clip.duration + 1e-9) return framed;
        const visuals = [];
        let used = 0;
        for (const candidate of pools[index]) {
          visuals.push(...pieces(candidate));
          used += candidate.duration;
          if (used >= duration - 1e-9) break;
        }
        repeatVisual(visuals, duration - used);
        return fitVisuals(clip, visuals, Math.max(1, visualDuration(visuals) / duration), framed.outputFrames, config.fps);
      });
    }
    if (clips.at(-1).transition) clips.at(-1).transition = null;
    const baseDuration = clips.reduce((seconds, clip) => seconds + (clip.visuals ? visualDuration(clip.visuals) : clip.duration), 0);
    clips = chooseLooks(clips,catalog,random,effectUseCounts);
    const pictureDuration = frameAligned ? clips.reduce((frames, clip) => frames + clip.outputFrames, 0) / config.fps : baseDuration;
    const sourceVisualDuration = segmented || voicePriority ? baseDuration : pictureDuration;
    const duration = segmented && voicePriority
      ? clips.reduce((samples, clip) => samples + Math.round(clip.timelineDuration * audioRate), 0) / audioRate
      : (narration && voicePriority ? narration.duration : pictureDuration);
    const leading = clips.slice(0, musicStartIndex);
    const musicStart = frameAligned ? leading.reduce((frames, clip) => frames + clip.outputFrames, 0) / config.fps
      : leading.reduce((seconds, clip) => seconds + clip.duration, 0);
    const followShot=priority==='picture' && !segmented ? config.wholeStartShots?.[wholeTrackIndex] : null;
    const anchorIndex=followShot==null ? 0 : clips.findIndex((c)=>c.shotIndex===followShot);
    if(anchorIndex<0) throw new Error('整段口播跟随的分镜不存在。');
    const voiceStart=clips.slice(0,anchorIndex).reduce((sum,c)=>sum+(c.outputDuration ?? c.duration),0);
    const scheduled = chooseLooks(scheduleLayers({ pack, selection, catalog, clips, duration, fps: config.fps, wholeIndex: wholeTrackIndex, narration,voiceStart }),catalog,random,effectUseCounts);
    let voiceSubtitles=subtitleStyle?.enabled === false ? null : subtitles ?? generatedSubtitleTrack({segmented,clips,narration,caption,duration});
    if(voiceStart && voiceSubtitles) {
      const ms=Math.round(voiceStart*1000),stop=Math.round(duration*1000);
      const cues=voiceSubtitles.cues.map((cue)=>({...cue,start:cue.start+ms,end:Math.min(stop,cue.end+ms)})).filter((cue)=>cue.start<cue.end);
      voiceSubtitles=cues.length ? {...voiceSubtitles,cues} : null;
    }
    const layers=scheduled.filter((layer)=>!layer.sourceCaption);
    const videoCues=scheduled.filter((layer)=>layer.sourceCaption).map((l)=>({start:Math.round(l.start*1000),end:Math.round(l.end*1000),text:l.text,...(l.highlights && {highlights:l.highlights})})).filter((c)=>c.end>c.start);
    const cover = selectCover(coverSettings,catalog,duration,config.fps,random);
    const musicIndex=Math.floor(random()*musicPool.length);
    const voiceId=wholeTrackIndex?config.extraWholeTracks?.[wholeTrackIndex-1]?.narrationId:config.narrationId;
    return {
      kind: 'montage', clips, size, fps: config.fps, fit: config.fit, backgroundColor,
      ...(layers.length && { layers }), ...(selection.composite !== undefined && { composite: selection.composite }),
      keepAudio: config.keepAudio, music: musicPool[musicIndex] ?? null, musicVolume:gain('music',config.musicIds[musicIndex])??musicVolume, musicStart,
      narration, narrationVolume:(segmented?undefined:gain('whole',voiceId,null,wholeTrackIndex))??narrationVolume, narrationMode, priority, visualDuration: sourceVisualDuration,
      ...(videoCues.length && {videoSubtitles:{name:'视频字幕',cues:videoCues}}),
      subtitles: voiceSubtitles,...(voiceStart && {voiceStart}),
      ...(subtitleStyle && { subtitleStyle }),
      ...(wholeTracks.length > 1 && { wholeTrack: wholeTrackIndex + 1 }),
      ...(cover && {cover,contentDuration:duration}),
      duration: duration + (cover?.frames ?? 0)/config.fps,
    };
  });
}

function planExtraction(ids, catalog) {
  if (!Array.isArray(ids) || !ids.length || ids.length > maxExports || new Set(ids).size !== ids.length) {
    throw new Error(`请选择 1 至 ${maxExports} 条不同的视频。`);
  }
  return ids.map((id) => {
    const asset = requireAsset(catalog, id, 'video');
    if (asset.audioIndex === null) throw new Error(`${asset.name} 没有音轨。`);
    return { kind: 'audio', asset, duration: asset.duration };
  });
}

function time(value) {
  return value.toFixed(6);
}

function audioTempo(tempo) {
  const filters = [];
  while (tempo < 0.5) {
    filters.push('atempo=0.5');
    tempo *= 2;
  }
  while (tempo > 2) {
    filters.push('atempo=2');
    tempo /= 2;
  }
  if (tempo !== 1) filters.push(`atempo=${tempo}`);
  return filters;
}

function volumeFilter(gain) {
  return gain === 1 ? '' : `,volume=${gain}`;
}

function voiceInputFilter(input, asset, start, seconds, gain, output) {
  return `[${input}:${asset.audioIndex}]asetpts=PTS-STARTPTS,atrim=start=${time(start)}:duration=${seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${volumeFilter(gain)}${output}`;
}

function sceneFades(plan) {
  if (!plan.clips.some((clip) => clip.transition)) return [];
  let offset = 0;
  const spans = [];
  for (const clip of plan.clips) {
    const clipDuration = clip.outputDuration ?? clip.duration;
    const duration = Math.min(clipDuration, plan.duration - offset);
    if (duration < 1e-6) continue;
    offset += duration;
    spans.push({ duration, end: offset, transition: clip.transition });
  }
  const cuts = spans.slice(0, -1).map(({ end, duration, transition }, index) => {
    if (!transition) return null;
    const half = transition.duration / 2;
    return {
      time: end,
      color: transition.kind === 'fade-white' ? 'white' : 'black',
      out: Math.min(half, duration),
      in: Math.min(half, Math.max(1 / plan.fps, spans[index + 1].duration - 1 / plan.fps)),
    };
  });
  // A short shot can receive both halves. Keep them within the shot without overlapping.
  for (const [index, span] of spans.entries()) {
    const incoming = cuts[index - 1];
    const outgoing = cuts[index];
    if (!incoming || !outgoing || incoming.in + outgoing.out <= span.duration) continue;
    const ratio = span.duration / (incoming.in + outgoing.out);
    incoming.in *= ratio;
    outgoing.out *= ratio;
  }
  return cuts.filter(Boolean).flatMap((cut) => {
    const at = time(cut.time);
    return [
      `fade=t=out:st=${time(Math.max(0, cut.time - cut.out))}:d=${time(cut.out)}:color=${cut.color}:enable='lt(t,${at})'`,
      `fade=t=in:st=${at}:d=${time(cut.in)}:color=${cut.color}:enable='gte(t,${at})'`,
    ];
  });
}

function assColor(color) {
  const [, red, green, blue] = color.match(/^#(..)(..)(..)$/);
  return `&H00${blue}${green}${red}`;
}

function subtitleRenderStyle(style) {
  const family = style?.font ? fontFamily(style.font) : process.platform === 'win32' ? 'Microsoft YaHei' : null;
  const margin = style?.margin ?? 16;
  const font = family ? `FontName=${family},` : '';
  const base = `${font}FontSize=${style?.size ?? 18},Outline=${style?.outlineWidth ?? 2},Shadow=0,MarginV=${margin}`;
  if (!style) return base;
  const align = subtitleAlignments[style.position] + ({left:-1,center:0,right:1}[style.align ?? 'center']);
  return [base, `Alignment=${align}`, `PrimaryColour=${assColor(style.textColor)}`, `OutlineColour=${assColor(style.outlineColor)}`,
    `MarginL=${margin}`, `MarginR=${margin}`, `Spacing=${style.spacing ?? 0}`,
    `Bold=${style.bold ? -1 : 0}`, `Italic=${style.italic ? -1 : 0}`, `Underline=${style.underline ? -1 : 0}`].join(',');
}

async function previewSubtitleStyle({ style, ratio, cue }) {
  if (!Object.hasOwn(dimensions, ratio)) throw new Error('字幕预览画幅无效。');
  const normalized = normalizeSubtitleStyle(style);
  if (typeof cue?.text !== 'string' || cue.text.length > 320) throw new Error('字幕预览最多支持 320 个字。');
  const track = { name:'样式预览', cues:[{text:cue.text, highlights:cue.highlights, start:0, end:1000}] };
  const data = formatSubtitles(track, normalized);
  const tmp = await fs.mkdtemp(path.join(require('node:os').tmpdir(),'jiajian-subtitle-style-'));
  try {
    await fs.writeFile(path.join(tmp, subtitleFileName), data);
    const [width,height] = dimensions[ratio][720];
    const filter = `subtitles=filename=${subtitleFileName}:charenc=UTF-8:alpha=1:force_style='${subtitleRenderStyle(normalized)}'`;
    const {stdout} = await execFileAsync(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i',
      `color=c=black@0:s=${width}x${height}:r=1:d=1,format=rgba`, '-vf', filter,
      '-filter_threads','1','-frames:v','1','-c:v','png','-threads','1','-f','image2pipe','pipe:1'],
    {cwd:tmp,windowsHide:true,encoding:'buffer',timeout:12000,maxBuffer:2*1024*1024});
    return stdout;
  } finally {
    await fs.rm(path.join(tmp, subtitleFileName), {force:true});
    await fs.rmdir(tmp);
  }
}

function montageArgs(plan, { intermediate = false } = {}) {
  const { size: [width, height], fps, fit, keepAudio, music, musicVolume, musicStart = 0, narration, narrationVolume, duration } = plan;
  const clips = plan.clips.filter((clip) => clip.outputFrames !== 0);
  const segmented = plan.narrationMode === 'segmented';
  const alignVoices = segmented && plan.priority === 'voice' && clips.some((clip) => clip.narration);
  const frameAligned = clips[0].outputFrames !== undefined;
  const args = ['-filter_complex_threads', '2'];
  const filters = [];
  const segments = [];
  const voices = [];
  let inputCount = 0;
  const background = `0x${(plan.backgroundColor ?? '#000000').slice(1)}`;
  const fitFilter = fit === 'fit'
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${background}`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,crop=${width}:${height}`;

  clips.forEach((clip, index) => {
    const { asset, start, duration, sourceDuration = duration, speed = 1, volume, mirror, looped } = clip.visuals?.[0] ?? clip;
    const { narration: voice, outputFrames, outputDuration } = clip;
    const seconds = time(sourceDuration);
    const visualInput = inputCount++;
    if (asset.kind === 'image') {
      args.push(...stillInput, '-loop', '1', '-framerate', String(fps), '-threads', '2', '-t', seconds, '-i', asset.path);
    } else {
      args.push(...mediaInput, ...(asset.alpha && asset.codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : []),
        ...(looped ? ['-stream_loop', '-1'] : []), '-threads', '2', '-ss', time(start), '-t', seconds, '-i', asset.path);
    }
    const originalAudible = keepAudio && volume > 0 && asset.audioIndex !== null;
    const source = lookGraph({part:clip.visuals?.[0] ?? clip,source:`[${visualInput}:${asset.videoIndex}]`,index,width,height,fps,duration:seconds,graph:filters,
      addBackground:(bg)=>{
        const input=inputCount++;
        args.push(...(bg.kind==='image'?[...stillInput,'-loop','1','-framerate',String(fps)]:[...mediaInput,'-stream_loop','-1']),
          '-t',seconds,'-threads','2','-i',bg.path);
        return `[${input}:${bg.videoIndex}]`;
      }});
    const audio = originalAudible
      ? `[${visualInput}:${asset.audioIndex}]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${volumeFilter(volume)},apad`
      : 'anullsrc=r=48000:cl=stereo';
    const shape = `${fitFilter}${mirror ? ',hflip' : ''},format=${asset.alpha ? 'rgba' : 'yuv420p'}`;
    if (frameAligned) {
      const outputSeconds = time(outputDuration);
      filters.push(`${source}settb=AVTB,setpts=(PTS-STARTPTS)/${speed},fps=${fps},${shape},tpad=stop_mode=clone:stop=${outputFrames},trim=end_frame=${outputFrames}[v${index}]`);
      const tempo = originalAudible ? audioTempo(speed) : [];
      const hasVoice = voice && segmentSpeechDuration(clip) > 1e-7;
      const bed = hasVoice && !alignVoices ? `[bed${index}]` : `[a${index}]`;
      filters.push([audio, `atrim=duration=${seconds}`, ...tempo, `apad=whole_dur=${outputSeconds}`, `atrim=duration=${outputSeconds}`, `asetpts=PTS-STARTPTS${bed}`].join(','));
      if (hasVoice) {
        const voiceInput = inputCount++;
        const voiceStart = clip.narrationStart ?? 0;
        const voiceDuration = segmentSpeechDuration(clip);
        const sampleCount = Math.round((clip.timelineDuration ?? voiceDuration) * audioRate);
        const delay = Math.round((clip.voiceOffset ?? 0) * audioRate);
        const fill = (delay ? `,adelay=${delay}S:all=1` : '') + (alignVoices ? `,apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=N/SR/TB` : '');
        const segments = clip.narrationRanges ? sliceSource(clip.narrationRanges, voiceStart, voiceDuration) : [{ start: voiceStart, end: voiceStart + voiceDuration }];
        args.push(...mediaInput, '-t', time(Math.max(...segments.map((part) => part.end))), '-i', voice.path);
        if (segments.length === 1) {
          filters.push(voiceInputFilter(voiceInput, voice, segments[0].start, time(voiceDuration), clip.voiceGain??narrationVolume, `${fill}[voice${index}]`));
        } else {
          const branches = segments.map((_, n) => `[s${index}voice${n}]`);
          filters.push(`[${voiceInput}:${voice.audioIndex}]aresample=${audioRate},asplit=${branches.length}${branches.join('')}`);
          const outputs = segments.map(({ start, end }, n) => {
            const output = `[vpart${index}_${n}]`;
            filters.push(`${branches[n]}atrim=start_sample=${Math.round(start * audioRate)}:end_sample=${Math.round(end * audioRate)},asetpts=N/SR/TB${output}`);
            return output;
          });
          filters.push(`${outputs.join('')}concat=n=${outputs.length}:v=0:a=1,aformat=channel_layouts=stereo${volumeFilter(clip.voiceGain??narrationVolume)}${fill}[voice${index}]`);
        }
        if (!alignVoices) filters.push(`${bed}[voice${index}]amix=inputs=2:duration=first:normalize=0[a${index}]`);
      } else if (alignVoices) {
        const sampleCount = Math.round(clip.timelineDuration * audioRate);
        filters.push(`anullsrc=r=${audioRate}:cl=stereo,atrim=end_sample=${sampleCount}[voice${index}]`);
      }
      if (alignVoices) voices.push(`[voice${index}]`);
    } else {
      filters.push(`${source}setpts=PTS-STARTPTS,fps=${fps},${shape}[v${index}]`);
      filters.push(`${audio},atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`);
    }
    const part = clip.visuals?.[0] ?? clip;
    let video = `[v${index}]`;
    if (asset.alpha) {
      const span = part.outputDuration ?? part.duration;
      filters.push(`color=c=${background}:s=${width}x${height}:r=${fps}:d=${time(span)}[under${index}]`);
      filters.push(`[under${index}]${video}overlay=shortest=1[opaque${index}]`);
      video = `[opaque${index}]`;
    }
    if (part.transform) {
      const seconds = part.outputDuration ?? part.duration;
      const base = `[canvas${index}]`;
      filters.push(`color=c=${background}:s=${width}x${height}:r=${fps}:d=${time(seconds)}${base}`);
      video = visualMotion({ layer: { ...part.transform, kind: 'candidate', start: 0, end: seconds,
        mediaStart: part.layerStart ?? 0, tempo: part.speed ?? 1 }, index: 'clip' + index, canvas: plan.size, fps,
        source: video, filters, video: base, active: 'enable=1' });
    }
    segments.push(`${video}[a${index}]`);
  });

  filters.push(`${segments.join('')}concat=n=${clips.length}:v=1:a=1[joined][original]`);
  const seconds = time(duration);
  const audioTracks = ['[original]'];
  const totalFrames = frameAligned ? clips.reduce((total, clip) => total + clip.outputFrames, 0) : 0;
  if (frameAligned) {
    filters.push(`[joined]fps=${fps},tpad=stop_mode=clone:stop=${totalFrames},trim=end_frame=${totalFrames}[video]`);
  } else if (narration) {
    filters.push(`[joined]fps=${fps},tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds}[video]`);
  } else {
    filters.push(`[joined]fps=${fps}[video]`);
  }
  if (narration) {
    filters.push(`[original]apad=whole_dur=${seconds},atrim=duration=${seconds},asetpts=PTS-STARTPTS[bed]`);
    audioTracks[0] = '[bed]';
  }
  if (alignVoices) {
    filters.push(`${voices.join('')}concat=n=${voices.length}:v=0:a=1[alignedVoices]`);
    filters.push(`[original]atrim=end_sample=${Math.round(duration * audioRate)},asetpts=PTS-STARTPTS[bed]`);
    audioTracks[0] = '[bed]';
    audioTracks.push('[alignedVoices]');
  }
  let videoOutput = '[video]';
  const fades = sceneFades(plan);
  if (fades.length) {
    filters.push(`${videoOutput}${fades.join(',')}[transitions]`);
    videoOutput = '[transitions]';
  }
  if (plan.layers?.length) {
    ({ videoOutput, inputCount } = composeLayers(plan, args, filters, audioTracks, videoOutput, inputCount,
      { mediaInput, stillInput, audioTempo }));
  }
  if (plan.videoSubtitles) {
    filters.push(`${videoOutput}subtitles=filename=video-captions.srt:charenc=UTF-8:force_style='${subtitleRenderStyle(plan.subtitleStyle)}'[sourceCaptioned]`);
    videoOutput='[sourceCaptioned]';
  }
  if (plan.subtitles) {
    const style = subtitleRenderStyle(plan.subtitleStyle);
    filters.push(`${videoOutput}subtitles=filename=${subtitleFileName}:charenc=UTF-8:force_style='${style}'[captioned]`);
    videoOutput = '[captioned]';
  }
  const musicDelay = Math.round(musicStart * 48000);
  const musicDuration = duration - musicDelay / 48000;
  if (music && musicDuration >= 1 / 48000) {
    const index = inputCount++;
    args.push(...mediaInput, '-stream_loop', '-1', '-i', music.path);
    const delay = musicDelay > 0 ? `,adelay=${musicDelay}S:all=1` : '';
    filters.push(`[${index}:${music.audioIndex}]aresample=48000,aformat=channel_layouts=stereo,volume=${musicVolume},atrim=duration=${time(musicDuration)},asetpts=PTS-STARTPTS${delay}[music]`);
    audioTracks.push('[music]');
  }
  if (narration) {
    args.push(...mediaInput, '-i', narration.path);
    const delay=plan.voiceStart ? ',adelay='+Math.round(plan.voiceStart*48000)+'S:all=1' : '';
    filters.push(voiceInputFilter(inputCount, narration, 0, time(duration-(plan.voiceStart ?? 0)), narrationVolume, delay+'[narration]'));
    audioTracks.push('[narration]');
  }
  let audioOutput = audioTracks[0];
  if (audioTracks.length > 1) {
    filters.push(`${audioTracks.join('')}amix=inputs=${audioTracks.length}:duration=first:normalize=0,alimiter=limit=0.95:latency=1[mixed]`);
    audioOutput = '[mixed]';
  } else if (segmented && clips.some((clip) => clip.narration)) {
    filters.push(`${audioOutput}alimiter=limit=0.95:latency=1[mixed]`);
    audioOutput = '[mixed]';
  }

  return args.concat([
    '-filter_complex', filters.join(';'), '-map', videoOutput, '-map', audioOutput,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', intermediate ? '16' : '20', '-threads', '4',
    '-pix_fmt', 'yuv420p', '-ar', '48000', '-ac', '2',
    ...(intermediate ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']),
  ]);
}

function exportArgs(plan, target, options) {
  const args = plan.kind === 'montage' ? montageArgs(plan, options) : [
    ...mediaInput, '-i', plan.asset.path,
    '-map', `0:${plan.asset.audioIndex}`, '-vn', '-c:a', 'libmp3lame', '-q:a', '2',
  ];
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-nostats', '-progress', 'pipe:1', ...args, target];
}

async function renderFile(plan, file, directory, temporaryFiles, options) {
  const args = exportArgs(plan, file, options);
  const filterIndex = args.indexOf('-filter_complex');
  // Windows process arguments have a size limit. Store long graphs beside their
  // UTF-8 text assets, including intermediate renders for repeated source clips.
  if (filterIndex >= 0 && (plan.layers?.length || args[filterIndex + 1].length > 8000)) {
    const graph = path.join(directory, `filters-${temporaryFiles.length}.ffgraph`);
    temporaryFiles.push(graph);
    await fs.writeFile(graph, args[filterIndex + 1], { flag: 'wx' });
    args.splice(filterIndex, 2, '-/filter_complex', graph);
  }
  return runTool(ffmpeg, args, { ...options, cwd: directory });
}

async function prepareVisualTracks(plan, temporaryDirectory, temporaryFiles, { signal, onProgress }) {
  if (plan.kind !== 'montage') return { plan, onProgress };
  const activeParts = plan.clips.map((clip) => clip.visuals?.filter((visual) => visual.outputFrames > 0));
  const stageCount = activeParts.reduce((total, parts) => total + (parts?.filter((visual) => visual.repeat > 1).length ?? 0)
    + (parts?.length > 1 ? 1 : 0), 0);
  let rendered = 0;
  const renderTrack = async (parts) => {
    const outputFrames = parts.reduce((total, part) => total + part.outputFrames, 0);
    const duration = outputFrames / plan.fps;
    const output = path.join(temporaryDirectory, `visual-${temporaryFiles.length}.mov`);
    temporaryFiles.push(output);
    const track = {
      ...plan, clips: parts, duration, music: null, narration: null, narrationMode: 'whole', subtitles: null, videoSubtitles:null, layers: [],
    };
    await renderFile(track, output, temporaryDirectory, temporaryFiles, {
      intermediate: true, signal, onProgress: onProgress && ((seconds) => onProgress(plan.duration * 0.3 * (rendered + Math.min(1, seconds / duration)) / stageCount)),
    });
    rendered += 1;
    return { asset: { kind: 'video', path: output, videoIndex: 0, audioIndex: 1 }, start: 0, duration, volume: 1, outputFrames, outputDuration: duration };
  };

  const clips = [];
  for (const [index, clip] of plan.clips.entries()) {
    const parts = activeParts[index];
    if (!parts?.length) {
      clips.push(clip);
      continue;
    }
    const tracks = [];
    for (const visual of parts) {
      if (visual.repeat > 1) {
        const cycleDuration = (visual.sourceDuration ?? visual.duration) / visual.speed;
        const cycle = await renderTrack([withOutputFrames(visual, cycleDuration, plan.fps)]);
        tracks.push({ ...cycle, duration: visual.outputDuration, looped: true, outputFrames: visual.outputFrames, outputDuration: visual.outputDuration });
      } else {
        tracks.push(visual);
      }
    }
    const track = tracks.length === 1 ? tracks[0] : await renderTrack(tracks);
    clips.push({ ...clip, visuals: [track] });
  }
  return {
    plan: { ...plan, clips },
    onProgress: onProgress && (stageCount ? (seconds) => onProgress(plan.duration * 0.3 + seconds * 0.7) : onProgress),
  };
}

async function publish(temp, directory, stem, extension) {
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const target = path.join(directory, `${stem}${attempt === 1 ? '' : `-${attempt}`}.${extension}`);
    try {
      try {
        await fs.link(temp, target);
      } catch (error) {
        if (!['ENOTSUP', 'EPERM', 'EACCES', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
        await fs.copyFile(temp, target, constants.COPYFILE_EXCL);
      }
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('输出目录有过多重名文件。');
}

async function exportOne(plan, directory, stem, { signal, onProgress }) {
  signal?.throwIfAborted();
  const extension = plan.kind === 'montage' ? 'mp4' : 'mp3';
  const temporaryDirectory = await fs.mkdtemp(path.join(directory, '.sd-export-'));
  const temp = path.join(temporaryDirectory, `render.${extension}`);
  const captions = plan.subtitles ? path.join(temporaryDirectory, subtitleFileName) : null;
  const temporaryFiles = captions ? [temp, captions] : [temp];
  try {
    if (captions) await fs.writeFile(captions, formatSubtitles(plan.subtitles,plan.subtitleStyle), { encoding: 'utf8', flag: 'wx' });
    if (plan.videoSubtitles) {
      const file=path.join(temporaryDirectory,'video-captions.srt');
      temporaryFiles.push(file);
      await fs.writeFile(file,formatSubtitles(plan.videoSubtitles,plan.subtitleStyle),{encoding:'utf8',flag:'wx'});
    }
    await writeLayerTexts(plan.layers, temporaryDirectory, temporaryFiles);
    const contentPlan = plan.cover ? {...plan,cover:null,duration:plan.contentDuration} : plan;
    const styled = await prepareLooks(contentPlan,temporaryDirectory,temporaryFiles);
    const prepared = await prepareVisualTracks(styled, temporaryDirectory, temporaryFiles, { signal, onProgress });
    await renderFile(prepared.plan, temp, temporaryDirectory, temporaryFiles, { signal, onProgress: prepared.onProgress });
    signal?.throwIfAborted();
    if (!(await fs.stat(temp)).size) throw new Error('生成的媒体文件为空。');
    const complete = await publishCover(plan,temp,temporaryDirectory,temporaryFiles,(args,options)=>runTool(ffmpeg,args,options),signal);
    return await publish(complete, directory, stem, extension);
  } catch (error) {
    if (captions && error?.message?.includes("No such filter: 'subtitles'")) {
      throw new Error('当前 FFmpeg 不支持字幕渲染，请使用包含 libass 的 FFmpeg。', { cause: error });
    }
    throw error;
  } finally {
    for (const file of temporaryFiles) await fs.rm(file, { force: true });
    await fs.rmdir(temporaryDirectory);
  }
}

async function exportBatch(plans, directory, { signal, onUpdate = () => {} } = {}) {
  if (!path.isAbsolute(directory) || !(await fs.stat(directory)).isDirectory()) {
    throw new Error('请选择有效的输出目录。');
  }
  const results = [];
  const failures = [];
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  for (const [index, plan] of plans.entries()) {
    if (signal?.aborted) break;
    const progress = (fraction) => onUpdate({ index, count: plans.length, fraction, results: [...results], failures: [...failures] });
    progress(0);
    try {
      const label = plan.subproject?.name?.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60);
      const type = plan.kind === 'montage' ? (label ? `混剪-${label}` : '混剪') : '提取音频';
      const output = await exportOne(plan, directory, `${type}-${timestamp}-${String(index + 1).padStart(2, '0')}`, {
        signal,
        onProgress: (seconds) => progress(Math.min(seconds / plan.duration, 0.99)),
      });
      results.push({ index, name: path.basename(output), path: output });
    } catch (error) {
      if (signal?.aborted) break;
      failures.push({ index, message: error.message });
    }
    progress(1);
  }
  return { results, failures, cancelled: Boolean(signal?.aborted) };
}

async function recognizeLocalSpeech(asset, {signal} = {}) {
  if (!asset || !['video','audio'].includes(asset.kind) || (asset.kind==='video' && asset.audioIndex==null)) throw new Error('所选素材没有音轨。');
  const model=vendorPath('whisper', 'ggml-base-q5_1.bin');
  try {await fs.access(model);} catch {throw new Error('缺少离线字幕识别模型 ggml-base-q5_1.bin。');}
  const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'jiajian-caption-'));
  const localModel=path.join(dir,'model.bin'), result=path.join(dir,'speech.srt');
  try {
    // Relative filter filenames also work with drive letters, apostrophes and CJK user directories.
    await fs.link(model,localModel).catch(()=>fs.copyFile(model,localModel));
    await runTool(ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...mediaInput,'-i',asset.path,'-map','0:a:0','-vn',
      '-af','aresample=16000,whisper=model=model.bin:language=auto:use_gpu=false:queue=15:destination=speech.srt:format=srt','-f','null','-'],{cwd:dir,signal});
    const size=(await fs.stat(result).catch(()=>null))?.size;
    if (!size) throw new Error('没有识别到可用的人声。');
    if (size>256*1024) throw new Error('字幕内容超过 256 KiB。请分段识别。');
    let index=0;
    // The FFmpeg Whisper filter numbers every cue zero and uses a decimal point.
    const normalized=(await fs.readFile(result,'utf8')).replace(/(^|\r?\n\r?\n)\d+\r?\n(\d{2}:\d{2}:\d{2})[.,](\d{3}) --> (\d{2}:\d{2}:\d{2})[.,](\d{3})/g,
      (_match,prefix,from,ms,to,until)=>prefix+(++index)+'\n'+from+','+ms+' --> '+to+','+until);
    return parseSubtitles(normalized,'识别字幕 · '+path.parse(asset.name).name.slice(0,180));
  } finally {
    await Promise.all([result,localModel].map((file)=>fs.rm(file,{force:true})));
    await fs.rmdir(dir);
  }
}

module.exports = {
  runTool,
  extractAudioWaveform,
  recognizeLocalSpeech,
  createTrackProxy,
  normalizeMutedVideoTracks,
  videoExtensions, imageExtensions, audioExtensions, maxShots, maxCandidates, maxExports, maxWholeTracks, minClipSeconds, maxStillSeconds,
  inspectAsset, createVideoThumbnail, analyzeNarrationSilence, normalizeGeneratedCaptions, normalizeSubtitleStyle, previewSubtitleStyle, planMontage, planExtraction, exportBatch,
};

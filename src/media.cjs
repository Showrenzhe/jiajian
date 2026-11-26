// @ts-check
'use strict';

const { execFile, spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const { formatSubtitles, normalizeSubtitles, parseSubtitles } = require('./subtitles.cjs');
const { normalizeShotSettings, normalizeRanges, normalizeSegmentVoiceCuts, sliceSource } = require('./shot-timing.cjs');
const { candidateVideoLanes, pictureSpan, emptyVideoCells, usesPlacedVideoSource, soloLaneSequence, joinedVideoSequence, videoGroupLeaders, normalizeVideoGaps, placedVideoSpeed, minVideoSpeed } = require('./ui/track-tools.js');
const trackControls = require('./ui/track-controls.js');
const { preferSolo } = trackControls;
const { normalizeCover, selectCover, publishCover } = require('./cover.cjs');
const { audioSpeed, normalizeMusicSpeeds, normalizeVolumeOverrides } = require('./shot-timing.cjs');
const { normalizeLook, chooseLooks, prepareLooks, lookGraph } = require('./visual-style.cjs');
const { normalizeLayers, normalizeTransform, normalizePackaging, packagingChoices, scheduleLayers } = require('./packaging.cjs');
const { composeLayers, writeLayerTexts } = require('./packaging-render.cjs');
const { visualMotion } = require('./layer-motion.cjs');
const { fontFamily } = require('./text-style.cjs');
const { maxCandidates, minClipSeconds, minEdgeSilence, audioRate, withOutputFrames, voiceLength, pieces, repeatVisual, visualDuration, fitVisuals, placedVideoFrames, fitSegmentedVoice, fitWholeVoice, fitReferenceWhole } = require('./ui/voice-alignment.js');
const vendorPath = require('./vendor-path.cjs');
const { isMaterialPath } = require('./material-path.cjs');

const { mediaTool } = require('./media-tool.cjs');
const ffmpeg = mediaTool('ffmpeg');
const ffprobe = mediaTool('ffprobe');
const execFileAsync = promisify(execFile);
/** @typedef {Awaited<ReturnType<typeof inspectAsset>>} InspectedAsset */
/** @typedef {{signal?: AbortSignal}} MediaReadOptions */
/** @typedef {{size?: number, textColor?: string, outlineColor?: string, position?: string, font?: string, align?: string, enabled?: boolean, bold?: boolean, italic?: boolean, underline?: boolean, outlineWidth?: number, spacing?: number, margin?: number, x?: number, y?: number}} SubtitleStyle */
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
const maxExports = 50;
const maxMontageBatch = 1000;
const maxWholeTracks = 250;
const maxStillSeconds = 60;
const dimensions = {
  '16:9': { 720: [1280, 720], 1080: [1920, 1080] },
  '9:16': { 720: [720, 1280], 1080: [1080, 1920] },
  '1:1': { 720: [720, 720], 1080: [1080, 1080] },
};

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{signal?: AbortSignal, timeout?: number, onProgress?: (seconds: number) => void, onLine?: (line: string) => void, cwd?: string}} [options]
 * @returns {Promise<string>}
 */
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
      failure = 'code' in error && error.code === 'ENOENT'
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
      if (failure || code !== 0) require('./diagnostics.cjs').logToolFailure(executable,args,errors,code);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errors.trim() || `媒体工具退出（${code}）。`));
      resolve(output);
    });
  });
}

/** @param {string} file @param {string} kind @param {MediaReadOptions} [options] */
async function inspectAsset(file, kind, { signal } = {}) {
  const extensions = { video: videoExtensions, audio: audioExtensions, image: imageExtensions };
  const allowed = Object.hasOwn(extensions, kind) ? extensions[kind] : [];
  if (!path.isAbsolute(file) || !allowed.includes(path.extname(file).slice(1).toLowerCase())) {
    throw new Error('请选择受支持的媒体文件。');
  }
  const fileInfo = await fs.stat(file);
  if (!fileInfo.isFile()) throw new Error('所选路径不是文件。');

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
    name: path.basename(file), size: fileInfo.size,
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

/** @param {InspectedAsset} asset @param {{start?: number,end?: number}} range @param {MediaReadOptions} [options] */
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

function createVideoThumbnail(asset, options) {
  return asset?.kind === 'video' ? createFrameThumbnail(asset, options) : Promise.resolve(null);
}

/** @param {InspectedAsset} asset @param {{signal?: AbortSignal, time?: number}} [options] */
async function createFrameThumbnail(asset, { signal, time: requestedTime } = {}) {
  const file = asset?.path;
  const extensions = asset?.kind === 'image' ? imageExtensions : asset?.kind === 'video' ? videoExtensions : [];
  if (!isMaterialPath(file) || !extensions.includes(path.extname(file).slice(1).toLowerCase())
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
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...(asset.kind === 'image' ? stillInput : mediaInput),
    '-ss', String(start), '-threads', '1', '-i', file, '-map', `0:${asset.videoIndex}`, '-frames:v', '1',
    '-filter_threads', '1', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1',
    '-an', '-sn', '-dn', '-c:v', 'mjpeg', '-q:v', '4', '-threads', '1', '-f', 'image2pipe', 'pipe:1',
  ], { signal, timeout: 6000, maxBuffer: 512 * 1024, encoding: 'buffer', windowsHide: true });
  return stdout.length > 4 && stdout[0] === 0xff && stdout[1] === 0xd8
    && stdout.at(-2) === 0xff && stdout.at(-1) === 0xd9 ? stdout : null;
}

async function createTrackProxy(asset, output, signal, edge = 640, retime) {
  const filters = [];
  if (retime) filters.push('settb=AVTB', `setpts=(PTS-STARTPTS)/${retime.rate}`, `fps=${retime.fps}`,
    'tpad=stop_mode=clone:stop=1', `trim=end_frame=${Math.ceil(asset.duration * retime.fps / retime.rate - 1e-7)}`);
  filters.push(`scale=${edge}:${edge}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', ...mediaInput, '-i', asset.path,
    '-map', `0:${asset.videoIndex}`, '-filter_threads', '1', '-vf', filters.join(','),
    '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough'];
  if (asset.audioIndex !== null) {
    if (retime) args.push('-af', ['asetpts=PTS-STARTPTS', ...audioTempo(retime.rate)].join(','),
      '-t', time(asset.duration / retime.rate));
    args.push('-map', `0:${asset.audioIndex}`, '-c:a', 'aac', '-ac', '2', '-b:a', '96k');
  }
  else args.push('-an');
  args.push('-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', output);
  await runTool(ffmpeg, args, { signal, timeout: retime ? Math.min(300000,Math.max(30000,asset.duration * 1000)) : 0 });
}

/** @param {InspectedAsset} asset @param {MediaReadOptions} [options] */
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

/** @param {SubtitleStyle} [value] @returns {SubtitleStyle} */
function normalizeSubtitleStyle(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('字幕样式无效。');
  const { size = 18, textColor = '#ffffff', outlineColor = '#000000', position = 'bottom' } = value;
  if (!Number.isInteger(size) || size < 8 || size > 72) throw new Error('字幕字号应在 8 到 72 之间。');
  if (!isRgbColor(textColor) || !isRgbColor(outlineColor)) throw new Error('字幕颜色须为 #RRGGBB。');
  if (typeof position !== 'string' || !Object.hasOwn(subtitleAlignments, position)) throw new Error('字幕位置无效。');
  /** @type {SubtitleStyle} */
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
  for (const [key, max] of Object.entries({outlineWidth: 8, spacing: 12, margin: 64, x: 100, y: 100})) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max) throw new Error('字幕位置、边距、字距或描边宽度无效。');
    style[key] = value[key];
  }
  return style;
}

function drawCombinations(shots, count, random) {
  if (count === 1) return [shots.map(shot => Math.floor(random() * shot.length))];
  // Advance every group's shuffled deck together. After their common period,
  // shift to a new orbit. gcd(previous period, size) counts distinct offsets:
  // this covers the Cartesian product without rejection sampling or repeats.
  let period = 1n;
  const decks = shots.map(group => {
    const size = BigInt(group.length);
    let a = period, b = size;
    while (b) [a, b] = [b, a % b];
    period = period / a * size;
    const order = group.map((_, i) => i);
    for (let i = 0; i < order.length - 1; i++) {
      const j = i + Math.floor(random() * (order.length - i));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Original and mirrored variants share a source. Interleave those variants
    // so both versions of one file don't crowd out the other shots in a short batch.
    if (group.some(item => item?.mirror)) {
      const variants = new Map();
      for (const index of order) {
        const source = group[index].asset;
        if (!variants.has(source)) variants.set(source, []);
        variants.get(source).push(index);
      }
      const bySource = [...variants.values()];
      order.length = 0;
      for (let pass = 0; order.length < group.length; pass++) {
        for (const items of bySource) if (pass < items.length) order.push(items[pass]);
      }
    }
    return { order, offsets: a };
  });
  return Array.from({length: count}, (_, i) => {
    const step = BigInt(i) % period;
    let orbit = BigInt(i) / period;
    return decks.map(({order, offsets}) => {
      const shift = orbit % offsets;
      orbit /= offsets;
      return order[Number((step + shift) % BigInt(order.length))];
    });
  });
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

function segmentNarrationGroups(config, catalog, captions, controls) {
  const ids = config.segmentNarrationIds === undefined ? [] : config.segmentNarrationIds;
  const cuts = normalizeSegmentVoiceCuts(config.segmentVoiceCuts, ids, catalog);
  const selection = config.segmentNarrationSelection === undefined ? 'ordered' : config.segmentNarrationSelection;
  if (!Array.isArray(ids) || ids.length > config.shots.length || !['ordered', 'random'].includes(selection)) {
    throw new Error('分段口播的分镜或匹配方式无效。');
  }
  const rows = config.shots.map((_shot, index) => {
    const row = ids[index] === undefined ? [] : ids[index];
    if (!Array.isArray(row) || row.length > maxWholeTracks) throw new Error(`第 ${index + 1} 组分镜的口播数量无效。`);
    return Array.from(row, (id, rowIndex) => id === null || !trackControls.participates(controls,'voice'+rowIndex) ? null : {
      asset: requireAsset(catalog, id, 'audio'),
      caption: captionFor(captions, id),
      ranges: cuts?.[index][rowIndex]?.ranges,
      offset: cuts?.[index][rowIndex]?.offset,
      speed: cuts?.[index][rowIndex]?.speed,
      rowIndex,
    });
  });
  if (selection === 'random') {
    const groups = rows.map((row) => {
      const voices = preferSolo(row.filter(Boolean),item=>controls?.['voice'+item.rowIndex]?.solo);
      return voices.length ? voices : [null];
    });
    return { groups, pick: (choices, index) => groups[index][choices[index]] };
  }
  const occupied = Array.from({ length: maxWholeTracks }, (_, index) => index)
    .filter((index) => rows.some((row) => row[index]));
  const tracks = preferSolo(occupied,i=>controls?.['voice'+i]?.solo);
  return {
    groups: [tracks.length ? tracks : [-1]],
    pick: (choices, index) => rows[index][tracks[choices[0]]] ?? (tracks!==occupied ?
      preferSolo(rows[index].filter(Boolean),item=>controls?.['voice'+item.rowIndex]?.solo)[0] : null) ?? null,
  };
}

function wholeNarrationTracks(config, catalog, captions, controls) {
  const extras = config.extraWholeTracks === undefined ? [] : config.extraWholeTracks;
  if (!Array.isArray(extras) || extras.length >= maxWholeTracks) {
    throw new Error(`整段口播最多可设置 ${maxWholeTracks} 条轨道。`);
  }
  return [config, ...extras].map((track,index) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) throw new Error('整段口播轨道设置无效。');
    if (!trackControls.wholeRowParticipates(controls,index,track.narrationId!=null,track.subtitles!=null)) return null;
    return {
      narration: track.narrationId == null ? null : requireAsset(catalog, track.narrationId, 'audio'),
      speed: audioSpeed(track.narrationSpeed ?? 1),
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

function segmentSpeechDuration(clip) {
  const available = (clip.timelineDuration ?? clip.shotDuration ?? clip.duration) - (clip.voiceOffset ?? 0);
  return Math.max(0, Math.min(clip.narrationDuration ?? voiceLength(clip), available));
}

function appendCaptionCues(cues, caption, offset, speechDuration, speechStart = 0, speed = 1) {
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
    const shiftedStart = Math.max(start, start + Math.round((cue.start - sourceStart)/speed));
    const shiftedEnd = Math.min(start + Math.round((cue.end - sourceStart)/speed), stop);
    if (shiftedEnd > shiftedStart) cues.push({ ...cue,start: shiftedStart, end: shiftedEnd });
  }
}

function generatedSubtitleTrack({ segmented, clips, narration, caption, duration, narrationSpeed }) {
  const cues = [];
  if (segmented) {
    let position = 0;
    for (const clip of clips) {
      const speed = clip.narrationSpeed ?? 1;
      if (clip.caption && clip.narrationRanges && typeof clip.caption !== 'string') {
        const retained = sliceSource(clip.narrationRanges, (clip.narrationStart ?? 0)*speed, segmentSpeechDuration(clip)*speed);
        let time = position + (clip.voiceOffset ?? 0);
        for (const range of retained) {
          appendCaptionCues(cues, clip.caption, time, (range.end - range.start)/speed, range.start, speed);
          time += (range.end - range.start)/speed;
        }
      } else if (clip.caption) appendCaptionCues(cues, clip.caption, position + (clip.voiceOffset ?? 0), segmentSpeechDuration(clip), (clip.narrationStart ?? 0)*speed, speed);
      position += clip.timelineDuration ?? clip.outputDuration;
    }
  } else if (narration) {
    appendCaptionCues(cues, caption, 0, Math.min(narration.duration/narrationSpeed, duration), 0, narrationSpeed);
  }
  return cues.length ? normalizeSubtitles({ name: caption?.name ?? '口播字幕', cues }) : null;
}

function visualPool(shot, selected) {
  return [selected, ...shot.filter((candidate) => candidate !== selected && candidate.mirror === selected.mirror)];
}

// Placements are saved on the editor's untrimmed narration ruler. A generated
// take can shorten its seams or reorder its shots while leaving free clips fixed.
function editorSpeechWindows(shots, segmented, fps) {
  const firstRows = segmented.groups.map(() => 0);
  let originalStart = 0;
  return shots.map(([picture], index) => {
    const voice = segmented.pick(firstRows, index);
    const originalSpan = voice ? (voice.offset ?? 0) + voiceLength({
      narration: voice.asset, narrationRanges: voice.ranges, narrationSpeed: voice.speed,
    }) : withOutputFrames(picture, picture.shotDuration ?? picture.duration, fps).outputDuration;
    const window = { originalStart, originalSpan };
    originalStart += originalSpan;
    return window;
  });
}

function speechPlacementClocks(clips, windows, fps) {
  const clocks = new Map();
  let frame = 0;
  for (const clip of clips) {
    clocks.set(clip.shotIndex, { ...windows[clip.shotIndex], start: frame / fps, span: clip.outputFrames / fps });
    frame += clip.outputFrames;
  }
  return clocks;
}

function alignSpeechPlacement(source, clock, fps) {
  if (!clock || source.videoStart === undefined || source.videoFollowsShot === false) return source;
  const offset = source.videoStart - clock.originalStart;
  const window = source.videoWindow ?? source.videoDuration;
  const sameFrame = (a,b) => Math.round(a * fps) === Math.round(b * fps);
  const fillsShot = window !== undefined && sameFrame(source.videoStart, clock.originalStart)
    && sameFrame(source.videoStart + window, clock.originalStart + clock.originalSpan);
  // Older drafts may omit the binding flag. The entire fitted shot window is
  // identifiable by both endpoints; older automatic fits also follow within it.
  const follows = source.videoFollowsShot ?? (source.autoFitSpeed && offset >= -1e-7 && offset < clock.originalSpan - 1e-7);
  if (!follows && !(source.videoFit === 'hold' && fillsShot)) return source;
  const result = { ...source, videoStart: Math.max(0, clock.start + (fillsShot ? 0 : offset)) };
  if (fillsShot && clock.span > 0) {
    if (source.videoWindow !== undefined) result.videoWindow = clock.span;
    else result.videoDuration = clock.span;
    if (source.autoFitSpeed && source.asset.kind === 'video') {
      result.speed = source.sourceDuration / clock.span;
      result.duration = clock.span;
    }
  }
  return result;
}

// A fixed candidate can play in another shot and still win its owner's draw.
// Keep that placement and use an eligible sibling beneath the owner's uncovered frames.
function completeDisplacedShots(clips, sourceShots, indices, placementClocks, fps) {
  if (!clips.some(clip => clip.videoStart !== undefined && clip.videoFollowsShot !== true)) return clips;
  const frame = seconds => Math.round(seconds * fps);
  const occupied = [];
  const displaced = [];
  function reserve(start, end) {
    const first = frame(start);
    if (frame(end) > first) occupied.push({ start:first, span:frame(end)-first });
  }
  let time = 0;
  for (const clip of clips) {
    const span = clip.outputDuration ?? clip.duration;
    const at = clip.videoStart ?? time;
    const end = at + pictureSpan(clip, span);
    if (!clip.hiddenVideo) reserve(at,end);
    for (const gap of clip.videoGaps ?? []) reserve(gap.start,gap.start + gap.span);
    const clock = placementClocks?.get(clip.shotIndex);
    const ownerStart = clock?.originalStart ?? time;
    const ownerSpan = clock?.originalSpan ?? span;
    const selected = sourceShots[clip.shotIndex][indices[clip.shotIndex]];
    const fixedStart = selected.videoStart;
    if (span > 0 && fixedStart !== undefined && selected.videoFollowsShot !== true && !clip.hiddenVideo
        && (frame(fixedStart + pictureSpan(selected,ownerSpan)) <= frame(ownerStart) || frame(fixedStart) >= frame(ownerStart + ownerSpan))) {
      displaced.push({ clip, clock, start:frame(time), end:frame(time + span), visibleSpans:[] });
    }
    time += span;
  }
  if (!displaced.length) return clips;
  const gaps = emptyVideoCells(occupied, displaced.map(slot => slot.start), displaced.map(slot => slot.end-slot.start));
  for (const gap of gaps) {
    const slot = displaced[gap.index];
    slot.visibleSpans.push({ start:(gap.start-slot.start)/fps, end:(gap.start+gap.span-slot.start)/fps });
  }
  const extra = [];
  for (const { clip, clock, start, end, visibleSpans } of displaced) {
    if (!visibleSpans.length) continue;

    const seconds = (end-start)/fps;
    for (const source of sourceShots[clip.shotIndex]) {
      if (source.mirror !== clip.mirror || source.hiddenVideo || source.videoGroup || source.videoGaps?.length) continue;
      const candidate = alignSpeechPlacement(source,clock,fps);
      const first = candidate.videoStart ?? start/fps;
      // A partial or separately positioned edit does not offer a whole-shot replacement.
      if (frame(first) !== start || frame(first + pictureSpan(candidate,seconds)) < end) continue;
      const picture = { ...candidate, volume:0, layers:undefined };
      const tempo = picture.videoFit === 'hold' ? 1 : Math.max(1,picture.duration/seconds);
      const { visuals } = fitVisuals(picture,pieces(picture),tempo,end-start,fps);
      extra.push({ ...picture, shotIndex:clip.shotIndex, videoStart:start/fps, videoWindow:undefined, videoDuration:seconds,
        videoFit:'hold', visibleSpans, visuals, outputFrames:0, outputDuration:0, timelineDuration:0 });
      break;
    }
  }
  return clips.concat(extra);
}

function planMontage(config, catalog, random = Math.random, batchLimit = maxMontageBatch) {
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
  const controls = trackControls.forLayout(trackControls.normalize(config.trackControls), config.shots, config.segmentNarrationIds,
    1+(config.extraWholeTracks?.length ?? 0), config.musicIds?.length ?? 0, config.narrationMode==='segmented');
  const audible = key => trackControls.allows(controls,key,'audio');
  const visible = key => trackControls.allows(controls,key,'visual');
  const alignment = config.voiceAlignment ?? 'fill';
  if (!['fill', 'reference'].includes(alignment)) throw new Error('口播对齐规则无效。');
  const backgroundColor = config.backgroundColor === undefined ? '#000000' : config.backgroundColor;
  if (!isRgbColor(backgroundColor)) throw new Error('画面背景颜色须为 #RRGGBB。');
  const subtitleStyle = config.subtitleStyle === undefined ? undefined : normalizeSubtitleStyle(config.subtitleStyle);

  const fullSourceShots = [];
  const allSourcePictures = [];
  const shots = config.shots.map((shot, index) => {
    if (!Array.isArray(shot) || !shot.length || shot.length > maxCandidates) {
      throw new Error(`第 ${index + 1} 组需要 1 至 ${maxCandidates} 条候选视频。`);
    }
    const fullSources = new Map();
    const lanes = candidateVideoLanes(shot, maxCandidates);
    const originals = shot.flatMap((clip, candidateIndex) => {
      if (clip?.enabled !== undefined && typeof clip.enabled !== 'boolean') throw new Error('候选参与状态无效。');
      if (clip?.sourceMuted !== undefined && typeof clip.sourceMuted !== 'boolean') throw new Error('片段原声静音状态无效。');
      if (clip?.enabled === false || !trackControls.participates(controls,'vis'+lanes[candidateIndex])) return [];
      const asset = requireAsset(catalog, clip?.id, 'video', 'image');
      const volume = clip.volume === undefined ? 1 : requireNumber(clip.volume, 0, 100, `${asset.name} 的原声音量`) / 100;
      const ranges = clip.ranges === undefined ? undefined : normalizeRanges(clip.ranges, clip.start, clip.end);
      const layers = clip.layers === undefined ? {} : {
        layers: normalizeLayers(clip.layers, checkLayerAsset).filter(layer=>trackControls.participates(controls, trackControls.layerKey(layer))),
      };
      layers.videoLane = lanes[candidateIndex];
      if(clip.videoWindow!==undefined) layers.videoWindow=requireNumber(clip.videoWindow,Number.MIN_VALUE,Number.MAX_SAFE_INTEGER,'视频轨片段时长');
      if(clip.videoGaps) layers.videoGaps=normalizeVideoGaps(clip.videoGaps);
      if(clip.videoGroup) layers.videoGroup=clip.videoGroup;
      const laneKey = 'vis'+layers.videoLane;
      if (!visible(laneKey)) layers.hiddenVideo = true;
      if (clip.videoStart !== undefined) layers.videoStart = requireNumber(clip.videoStart, 0, Number.MAX_SAFE_INTEGER, '视频片段的时间轴落点');
      if (clip.videoFollowsShot !== undefined) layers.videoFollowsShot = clip.videoFollowsShot;
      if (clip.autoFitSpeed) layers.autoFitSpeed = true;
      if (clip.videoDuration !== undefined) layers.videoDuration = requireNumber(clip.videoDuration, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, '视频片段的时间轴裁切时长');
      if (clip.videoFit !== undefined) {
        if (clip.videoFit !== 'hold' || layers.videoStart === undefined || layers.videoDuration === undefined) throw new Error('视频片段的切点窗口无效。');
        layers.videoFit=clip.videoFit;
      }
      if (clip.transform !== undefined) layers.transform = normalizeTransform(clip.transform);
      if (clip.look !== undefined) layers.look = normalizeLook(clip.look,(id,role)=>{requireAsset(catalog,id,...(role==='lut'?['lut']:['image','video']));return id;});
      const matchedDuration = clip.matchedDuration === undefined ? undefined
        : requireNumber(clip.matchedDuration, 0.000001, 86400, '候选匹配时长');
      const fixed=settings?.[index]?.duration;
      const shotDuration = clip.videoFit==='hold' ? fixed ?? matchedDuration : matchedDuration ?? fixed;
      if (asset.kind === 'image') {
        if (ranges) throw new Error('图片不支持视频区间裁剪。');
        const duration = requireNumber(clip.end, minClipSeconds, maxStillSeconds, `${asset.name} 的播放时长`);
        return { asset, start: 0, volume: 0, duration: shotDuration ?? duration, ...layers };
      }
      const start = requireNumber(clip.start, 0, asset.duration, `${asset.name} 的入点`);
      const end = requireNumber(clip.end, 0, asset.duration, `${asset.name} 的出点`);
      if (clip.videoSubtitles && subtitleStyle?.enabled !== false && visible('local-subtitles')) {
        const cues=normalizeSubtitles(clip.videoSubtitles).cues;
        const captions=cues.filter((c)=>c.end/1000>start && c.start/1000<end).map((c)=>({
          kind:'text',sourceCaption:true,text:c.text,highlights:c.highlights,start:Math.max(0,c.start/1000-start),end:Math.min(end,c.end/1000)-start,
          color:subtitleStyle?.textColor ?? '#ffffff',fontSize:(subtitleStyle?.size ?? 18)*2,
          x:.5,y:({top:.14,middle:.5,bottom:.86,custom:(subtitleStyle?.y ?? 85)/100})[subtitleStyle?.position ?? 'bottom'],scale:1,
        }));
        layers.layers=[...(layers.layers ?? []),...captions];
      }
      if (end - start < minClipSeconds - 1e-9) throw new Error(`${asset.name} 的有效片段至少需要 0.1 秒。`);
      const speed = requireNumber(placedVideoSpeed(clip), minVideoSpeed, Number.MAX_SAFE_INTEGER, `${asset.name} 的播放速度`);
      let retained = ranges ?? [{ start, end }];
      let sourceDuration = retained.reduce((sum, range) => sum + range.end - range.start, 0);
      if(layers.look?.head || layers.look?.tail){
        sourceDuration -= (layers.look.head??0)+(layers.look.tail??0);
        if(sourceDuration<minClipSeconds-1e-7)throw new Error(asset.name+' 去片头片尾后不足 0.1 秒。');
        retained=sliceSource(retained,layers.look.head??0,sourceDuration);
      }
      function sourceClip(parts,length) {
        return { asset, start:parts[0].start, sourceDuration:length, duration:length/speed, speed,
          volume:clip.sourceMuted || mutedTracks.has(lanes[candidateIndex]) || !audible(laneKey) ? 0 : volume, ...layers,
          ...(matchedDuration && {matchedDuration}), ...(shotDuration && {shotDuration}),
          ...(parts.length>1 && {retainedRanges:parts,candidateStart:start}),
          ...(parts[0].start!==start && {layerStart:parts[0].start-start}) };
      }
      const full=sourceClip(retained,sourceDuration);
      if (!matchedDuration && shotDuration && sourceDuration > shotDuration * speed) {
        const size=shotDuration*speed;
        const offset=settings[index].smartTrim ? random()*(sourceDuration-size) : 0;
        const trimmed=sourceClip(sliceSource(retained,offset,size),size);
        // The selected narration row is known only after drawing a composition. Keep
        // the whole edited source for voice priority, including all user-retained cuts.
        fullSources.set(trimmed,full);
        return trimmed;
      }
      return full;
    });
    if (!originals.length) throw new Error(`第 ${index + 1} 组分镜至少需要一条参与混剪的候选。请启用视频轨道或候选片段。`);
    const variants=candidates=>[
      ...(config.useOriginal ? candidates : []),
      ...(config.useMirrors ? candidates.map(candidate=>({...candidate,mirror:true})) : []),
    ];
    const chosen=preferSolo(originals,clip=>controls?.['vis'+clip.videoLane]?.solo);
    const pictureShots=variants(videoGroupLeaders(chosen));
    const all=variants(chosen.map(c=>fullSources.get(c) ?? c));
    // Mirror variants share a sequence with pictures of the same orientation only.
    fullSourceShots.push([...videoGroupLeaders(all.filter(clip=>!clip.mirror)),...videoGroupLeaders(all.filter(clip=>clip.mirror))]);
    allSourcePictures.push(all);
    return pictureShots;
  });
  const narrationMode = config.narrationMode === undefined ? 'whole' : config.narrationMode;
  if (!['whole', 'segmented'].includes(narrationMode)) throw new Error('请选择有效的口播方式。');
  const captions = normalizeGeneratedCaptions(config.generatedCaptions, config);
  const segmented = narrationMode === 'segmented' ? segmentNarrationGroups(config, catalog, captions, controls) : null;
  const wholeTracks = segmented ? [] : wholeNarrationTracks(config, catalog, captions,controls);
  const wholeRows=preferSolo(wholeTracks.flatMap((track,i)=>track ? [i] : []), i=>wholeTracks[i].narration && controls?.['whole'+i]?.solo);
  const voiceGroups = segmented?.groups ?? (wholeRows.length > 1 ? [wholeRows] : []);
  const pack = trackControls.enabledPackaging(normalizePackaging(config.packaging ?? {}, checkLayerAsset, shots.length),controls);
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
  const musicSpeeds = config.musicSpeeds === undefined ? [] : normalizeMusicSpeeds(config.musicSpeeds, config.musicIds.length);
  const timelineCaptions = normalizeSubtitles(config.timelineCaptions);
  const musicPool = config.musicIds.map((id,i) => trackControls.participates(controls,'music'+i) ? requireAsset(catalog, id, 'audio') : null);
  const musicRows = preferSolo(musicPool.flatMap((asset,i)=>asset ? [i] : []), i=>controls?.['music'+i]?.solo);
  const musicVolume = musicRows.length ? requireNumber(config.musicVolume, 0, 100, '配乐音量') / 100 : 0;
  const narrationVolume = config.narrationVolume === undefined ? 1 : requireNumber(config.narrationVolume, 0, 100, '口播音量') / 100;
  const priority = config.priority === undefined ? 'picture' : config.priority;
  if (!['picture', 'voice'].includes(priority)) throw new Error('请选择有效的混剪合成模式。');
  const editorWindows = segmented && priority === 'voice' ? editorSpeechWindows(shots, segmented, config.fps) : null;

  const effectUseCounts = new Map();
  const gains = new Map(normalizeVolumeOverrides(config.volumeOverrides??[],(id)=>{requireAsset(catalog,id,'audio');return id;},shots.length)
    .map(row=>[JSON.stringify([row.kind,row.id,row.shot??null,row.track??null]),row.value/100]));
  const gain=(kind,id,shot,track)=>gains.get(JSON.stringify([kind,id,shot??null,track??null]));
  let draws = drawCombinations(groups, count, random);
  // With ordered narration, repeated takes of the same picture combination
  // follow the rows from top to bottom, retaining the shuffled picture order.
  if (segmented && config.segmentNarrationSelection !== 'random' && voiceGroups[0].length > 1) {
    const takes = new Map();
    const keys = draws.map(row => row.slice(0, shots.length).join(','));
    draws.forEach((row, index) => {
      if (!takes.has(keys[index])) takes.set(keys[index], []);
      takes.get(keys[index]).push(row);
    });
    for (const rows of takes.values()) rows.sort((a,b) => b[shots.length] - a[shots.length]);
    draws = keys.map(key => takes.get(key).pop());
  }
  return draws.map((indices) => {
    if (coverShot) indices[0] = Math.min(shots[0].length - 1,Math.floor(random()*shots[0].length));
    const narrationChoices = indices.slice(shots.length, shots.length + voiceGroups.length);
    const selection = packaging.select(indices.slice(shots.length + voiceGroups.length));
    const wholeTrackIndex = wholeRows[narrationChoices[0] ?? 0];
    const { narration = null, subtitles = null, caption = null, speed: narrationSpeed = 1 } = wholeTracks[wholeTrackIndex] ?? {};
    const wholeDuration = narration ? narration.duration/narrationSpeed : 0;
    const scenes = shots.map((fixedShot, index) => {
      const match = segmented?.pick(narrationChoices, index);
      const hasVoice = segmented ? Boolean(match) : Boolean(narration);
      const shot = priority==='voice' && alignment==='fill' && hasVoice ? fullSourceShots[index] : fixedShot;
      const selected = shot[indices[index]];
      const candidate = usesPlacedVideoSource(selected,priority==='voice' && hasVoice) ? fullSourceShots[index][indices[index]] : selected;
      const clip = {
        ...candidate,
        shotIndex: index,
        ...(transitions[index] && { transition: transitions[index] }),
        ...(segmented && { narration: match?.asset ?? null }),
        ...(match && { narrationRow: match.rowIndex }),
        ...(match && gain('segment',config.segmentNarrationIds[index][match.rowIndex],index,match.rowIndex)!=null && {voiceGain:gain('segment',config.segmentNarrationIds[index][match.rowIndex],index,match.rowIndex)}),
        ...(match && !audible('voice'+match.rowIndex) && {voiceGain:0}),
        ...(match?.caption && visible('caption'+match.rowIndex) && { caption: match.caption }),
        ...(match?.speed && { narrationSpeed: match.speed }),
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
      else if (alignment === 'reference') clips = fitReferenceWhole(clips, wholeDuration, config.fps);
      else clips = fitWholeVoice(clips, pools, wholeDuration, config.fps);
    } else if (frameAligned) {
      clips = clips.map((clip, index) => {
        const duration = clip.shotDuration ?? clip.duration;
        const framed = withOutputFrames(clip, duration, config.fps);
        if (usesPlacedVideoSource(clip,false)) return placedVideoFrames(clip,framed.outputFrames,config.fps);
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
    // Reference narration can finish before a later shot. Its explicitly
    // positioned picture still belongs at the requested absolute time.
    if (clips.length < scenes.length) {
      const scheduled=new Set(clips.map(clip=>clip.shotIndex));
      for(const {clip} of scenes) {
        if(scheduled.has(clip.shotIndex)) continue;
        const pool=allSourcePictures[clip.shotIndex],full=fullSourceShots[clip.shotIndex][indices[clip.shotIndex]];
        if(clip.videoFit==='hold' || clip.videoWindow!==undefined || clip.videoGaps?.length || clip.videoGroup || soloLaneSequence(pool,full,controls,clip.shotDuration ?? clip.duration).length) {
          clips.push({...clip,outputFrames:0,outputDuration:0,timelineDuration:0});
        }
      }
    }
    // Only the primary clip owns the shot clock and its narration. Additional
    // pictures on a soloed lane carry just their own source sound and edits.
    const placementClocks = editorWindows ? speechPlacementClocks(clips,editorWindows,config.fps) : null;
    const extraPictures=[];
    clips = clips.map(clip=>{
      const pool=allSourcePictures[clip.shotIndex];
      const full=fullSourceShots[clip.shotIndex][indices[clip.shotIndex]];
      const shotSpan=clip.outputDuration || clip.shotDuration || clip.duration;
      const soloSequence=soloLaneSequence(pool,full,controls,shotSpan);
      const sequence=soloSequence.length ? soloSequence : joinedVideoSequence(pool,full);
      const clock = placementClocks?.get(clip.shotIndex);
      clip = alignSpeechPlacement(clip,clock,config.fps);
      const fillWindow=clip.videoWindow!==undefined && clip.outputDuration<clip.videoWindow-1e-7;
      if(!sequence.length && clip.videoFit!=='hold' && !fillWindow && !(clip.videoGaps?.length && clip.outputDuration===0)) return clip;
      function fitPicture(source,owner) {
        source = alignSpeechPlacement(source,clock,config.fps);
        const videoDuration=pictureSpan(source,shotSpan);
        const {outputFrames}=withOutputFrames(source,videoDuration,config.fps);
        const {visuals}=fitVisuals(source,pieces(source),1,outputFrames,config.fps);
        return {...owner,...(source.videoStart !== undefined && {videoStart:source.videoStart}),videoFit:'hold',videoDuration,visuals};
      }
      for(const other of sequence) {
        if(other!==full) extraPictures.push(fitPicture(other,{...other,shotIndex:clip.shotIndex,outputFrames:0,outputDuration:0,timelineDuration:0}));
      }
      return clip.videoFit==='hold' || soloSequence.length || fillWindow || clip.outputDuration===0 ? fitPicture(full,clip) : clip;
    }).concat(extraPictures);
    clips = completeDisplacedShots(clips,fullSourceShots,indices,placementClocks,config.fps);
    clips = chooseLooks(clips,catalog,random,effectUseCounts);
    const pictureDuration = frameAligned ? clips.reduce((frames, clip) => frames + clip.outputFrames, 0) / config.fps : baseDuration;
    const sourceVisualDuration = segmented || voicePriority ? baseDuration : pictureDuration;
    const sequenceDuration = segmented && voicePriority
      ? clips.reduce((samples, clip) => samples + Math.round(clip.timelineDuration * audioRate), 0) / audioRate
      : (narration && voicePriority ? wholeDuration : pictureDuration);
    const duration = clips.reduce((end, clip) => {
      for(const gap of clip.videoGaps ?? []) end=Math.max(end,gap.start+gap.span);
      return clip.videoStart===undefined ? end : Math.max(end,clip.videoStart+pictureSpan(clip,clip.outputDuration ?? clip.duration));
    }, sequenceDuration);
    const leading = clips.slice(0, musicStartIndex);
    const musicStart = frameAligned ? leading.reduce((frames, clip) => frames + clip.outputFrames, 0) / config.fps
      : leading.reduce((seconds, clip) => seconds + clip.duration, 0);
    const followShot=priority==='picture' && !segmented ? config.wholeStartShots?.[wholeTrackIndex] : null;
    const anchorIndex=followShot==null ? 0 : clips.findIndex((c)=>c.shotIndex===followShot);
    if(anchorIndex<0) throw new Error('整段口播跟随的分镜不存在。');
    const voiceStart=clips.slice(0,anchorIndex).reduce((sum,c)=>sum+(c.outputDuration ?? c.duration),0);
    const scheduled = chooseLooks(scheduleLayers({ pack, selection, catalog, clips, duration, wholeIndex: wholeTrackIndex, narration,voiceStart,narrationSpeed }),catalog,random,effectUseCounts);
    const importedSubtitles = narration && subtitles && narrationSpeed !== 1 ? generatedSubtitleTrack({
      segmented:false, clips, narration, caption:subtitles, duration, narrationSpeed,
    }) : subtitles;
    let voiceSubtitles=subtitleStyle?.enabled === false || (!segmented && !visible('caption'+wholeTrackIndex)) ? null :
      subtitles ? importedSubtitles : generatedSubtitleTrack({segmented,clips,narration,caption,duration,narrationSpeed});
    if(voiceStart && voiceSubtitles) {
      const ms=Math.round(voiceStart*1000),stop=Math.round(duration*1000);
      const cues=voiceSubtitles.cues.map((cue)=>({...cue,start:cue.start+ms,end:Math.min(stop,cue.end+ms)})).filter((cue)=>cue.start<cue.end);
      voiceSubtitles=cues.length ? {...voiceSubtitles,cues} : null;
    }
    if (timelineCaptions && subtitleStyle?.enabled !== false && visible('pasted-captions')) {
      const end=Math.round(duration*1000);
      const pasted=timelineCaptions.cues.filter(cue=>cue.start<end).map(cue=>({...cue,end:Math.min(cue.end,end)}));
      if(pasted.length) voiceSubtitles={name:voiceSubtitles?.name ?? timelineCaptions.name,
        cues:[...(voiceSubtitles?.cues ?? []),...pasted].sort((a,b)=>a.start-b.start)};
    }
    const layers=scheduled.flatMap(layer=>{
      if (layer.sourceCaption) return [];
      const key=trackControls.layerKey(layer);
      const show=visible(key), play=audible(key);
      if (layer.kind==='sound') return play ? [layer] : [];
      if (layer.kind!=='pip') return show ? [layer] : [];
      if (!show) return play && layer.volume>0 && layer.asset?.audioIndex!=null ? [{...layer,kind:'sound'}] : [];
      return [play ? layer : {...layer,volume:0}];
    });
    const videoCues=scheduled.filter((layer)=>layer.sourceCaption).map((l)=>({start:Math.round(l.start*1000),end:Math.round(l.end*1000),text:l.text,...(l.highlights && {highlights:l.highlights})})).filter((c)=>c.end>c.start);
    const cover = selectCover(coverSettings,catalog,duration,config.fps,random);
    const musicIndex=musicRows[Math.floor(random()*musicRows.length)];
    const voiceId=wholeTrackIndex?config.extraWholeTracks?.[wholeTrackIndex-1]?.narrationId:config.narrationId;
    return {
      kind: 'montage', clips, size, fps: config.fps, fit: config.fit, backgroundColor,
      ...(layers.length && { layers }), ...(selection.composite !== undefined && { composite: selection.composite }),
      keepAudio: config.keepAudio, music: musicPool[musicIndex] ?? null, musicVolume:audible('music'+musicIndex) ? gain('music',config.musicIds[musicIndex])??musicVolume : 0, musicStart,
      ...(musicSpeeds[musicIndex] && {musicSpeed:musicSpeeds[musicIndex]}), ...(narrationSpeed!==1 && {narrationSpeed}),
      narration, narrationVolume:!segmented && !audible('whole'+wholeTrackIndex) ? 0 : (segmented?undefined:gain('whole',voiceId,null,wholeTrackIndex))??narrationVolume, narrationMode, priority, visualDuration: sourceVisualDuration,
      ...(videoCues.length && {videoSubtitles:{name:'视频字幕',cues:videoCues}}),
      subtitles: voiceSubtitles,...(voiceStart && {voiceStart}),
      ...(subtitleStyle && { subtitleStyle }),
      ...(wholeTracks.length > 1 && wholeTrackIndex!==undefined && { wholeTrack: wholeTrackIndex + 1 }),
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

function tempoFilter(speed) {
  return audioTempo(speed).map(filter => ',' + filter).join('');
}

function voiceInputFilter(input, asset, start, seconds, gain, output, speed=1) {
  return `[${input}:${asset.audioIndex}]asetpts=PTS-STARTPTS,atrim=start=${time(start)}:duration=${seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${tempoFilter(speed)}${volumeFilter(gain)}${output}`;
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
  const clips = plan.clips.filter((clip) => clip.outputFrames !== 0 || clip.videoFit === 'hold');
  const positioned = clips.some(clip => clip.videoStart !== undefined || clip.videoDuration !== undefined || clip.hiddenVideo || clip.visibleSpans);
  const segmented = plan.narrationMode === 'segmented';
  const alignVoices = segmented && plan.priority === 'voice' && clips.some((clip) => clip.narration);
  const frameAligned = clips[0].outputFrames !== undefined;
  const args = ['-filter_complex_threads', '2'];
  const filters = [];
  const segments = [];
  const voices = [];
  const pictureRows = [];
  let pictureTime = 0, speechTime = 0;
  let inputCount = 0;
  const background = `0x${(plan.backgroundColor ?? '#000000').slice(1)}`;
  const fitFilter = fit === 'fit'
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${background}`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,crop=${width}:${height}`;

  clips.forEach((clip, index) => {
    const { asset, start, duration, sourceDuration = duration, speed = 1, volume, mirror, looped } = clip.visuals?.[0] ?? clip;
    const voice=clip.narration;
    const renderClock=clip.videoFit==='hold' ? clip.visuals[0] : clip;
    const {outputFrames,outputDuration}=renderClock;
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
    if (frameAligned || clip.videoFit==='hold') {
      const outputSeconds = time(outputDuration);
      filters.push(`${source}settb=AVTB,setpts=(PTS-STARTPTS)/${speed},fps=${fps},${shape},tpad=stop_mode=clone:stop=${outputFrames},trim=end_frame=${outputFrames}[v${index}]`);
      const tempo = originalAudible ? audioTempo(speed) : [];
      const hasVoice = voice && segmentSpeechDuration(clip) > 1e-7;
      const bed = hasVoice && !alignVoices && !positioned ? `[bed${index}]` : `[a${index}]`;
      filters.push([audio, `atrim=duration=${seconds}`, ...tempo, `apad=whole_dur=${outputSeconds}`, `atrim=duration=${outputSeconds}`, `asetpts=PTS-STARTPTS${bed}`].join(','));
      if (hasVoice) {
        const voiceInput = inputCount++;
        const voiceSpeed = clip.narrationSpeed ?? 1;
        const voiceStart = (clip.narrationStart ?? 0)*voiceSpeed;
        const voiceDuration = segmentSpeechDuration(clip);
        const sampleCount = Math.round((clip.timelineDuration ?? voiceDuration) * audioRate);
        const delay = Math.round((clip.voiceOffset ?? 0) * audioRate);
        const fill = (delay ? `,adelay=${delay}S:all=1` : '') + (alignVoices ? `,apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=N/SR/TB` : '');
        const sourceDuration = voiceDuration*voiceSpeed;
        const segments = clip.narrationRanges ? sliceSource(clip.narrationRanges, voiceStart, sourceDuration) : [{ start: voiceStart, end: voiceStart + sourceDuration }];
        args.push(...mediaInput, '-t', time(Math.max(...segments.map((part) => part.end))), '-i', voice.path);
        if (segments.length === 1) {
          filters.push(voiceInputFilter(voiceInput, voice, segments[0].start, time(sourceDuration), clip.voiceGain??narrationVolume, `${fill}[voice${index}]`, voiceSpeed));
        } else {
          const branches = segments.map((_, n) => `[s${index}voice${n}]`);
          filters.push(`[${voiceInput}:${voice.audioIndex}]aresample=${audioRate},asplit=${branches.length}${branches.join('')}`);
          const outputs = segments.map(({ start, end }, n) => {
            const output = `[vpart${index}_${n}]`;
            filters.push(`${branches[n]}atrim=start_sample=${Math.round(start * audioRate)}:end_sample=${Math.round(end * audioRate)},asetpts=N/SR/TB${output}`);
            return output;
          });
          filters.push(`${outputs.join('')}concat=n=${outputs.length}:v=0:a=1,aformat=channel_layouts=stereo${tempoFilter(voiceSpeed)}${volumeFilter(clip.voiceGain??narrationVolume)}${fill}[voice${index}]`);
        }
        if (positioned) {
          filters.push(`[voice${index}]adelay=${Math.round(speechTime*audioRate)}S:all=1[timedVoice${index}]`);
          voices.push(`[timedVoice${index}]`);
        } else if (!alignVoices) filters.push(`${bed}[voice${index}]amix=inputs=2:duration=first:normalize=0[a${index}]`);
      } else if (alignVoices && !positioned) {
        const sampleCount = Math.round(clip.timelineDuration * audioRate);
        filters.push(`anullsrc=r=${audioRate}:cl=stereo,atrim=end_sample=${sampleCount}[voice${index}]`);
      }
      if (alignVoices && !positioned) voices.push(`[voice${index}]`);
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
    if (positioned) {
      const start = clip.videoStart ?? pictureTime;
      const span = clip.outputDuration ?? clip.duration;
      pictureRows.push({ index, start, span:pictureSpan(clip,span), video, lane:clip.videoLane ?? 0, hidden:clip.hiddenVideo,
        hold:clip.videoFit==='hold', visibleSpans:clip.visibleSpans });
      pictureTime += span;
      speechTime += clip.timelineDuration ?? span;
    } else segments.push(`${video}[a${index}]`);
  });

  const seconds = time(duration);
  let audioTracks = ['[original]'];
  const totalFrames = frameAligned ? clips.reduce((total, clip) => total + clip.outputFrames, 0) : 0;
  if (positioned) {
    // The shot clock still anchors narration. Pictures and their source sound own separate start times.
    filters.push(`color=c=${background}:s=${width}x${height}:r=${fps}:d=${seconds}[canvas]`,
      `anullsrc=r=${audioRate}:cl=stereo,atrim=duration=${seconds}[silence]`);
    let canvas = '[canvas]';
    audioTracks = ['[silence]', ...voices];
    for (const row of pictureRows.sort((a,b) => b.lane-a.lane || a.index-b.index)) {
      const { index, start, span, video, hidden, visibleSpans } = row;
      const intervals = visibleSpans ? visibleSpans.filter(range=>range.start<span) : [{start:0,end:span}];
      if (hidden || !intervals.length) filters.push(video+'nullsink');
      else {
        // Use the same output-frame boundary for the source PTS and the overlay gate.
        // Decimal seconds can otherwise round in opposite directions at a shared cut.
        const firstFrame = Math.round(start * fps);
        const active = intervals.map(range => {
          const begin = Math.round((start + range.start) * fps);
          const until = start + Math.min(span, range.end);
          // The canvas includes its final partial frame. Keep a picture that
          // reaches the actual end visible throughout that frame as well.
          const end = Math.abs(until - duration) < 1e-7 ? Math.ceil(until * fps - 1e-7) : Math.round(until * fps);
          return `gte(n,${begin})*lt(n,${end})`;
        }).join('+');
        const position = `settb=1/${fps},setpts=N+${firstFrame}`;
        filters.push(`${video}${position}[placed${index}]`,
          `${canvas}[placed${index}]overlay=eof_action=${row.hold?'repeat:repeatlast=1':'pass:repeatlast=0'}:enable='${active}'[placedCanvas${index}]`);
        canvas = `[placedCanvas${index}]`;
      }
      filters.push(`[a${index}]atrim=duration=${time(span)},adelay=${Math.round(start*audioRate)}S:all=1[placedSound${index}]`);
      audioTracks.push(`[placedSound${index}]`);
    }
    filters.push(canvas+'null[video]');
  } else {
    filters.push(`${segments.join('')}concat=n=${clips.length}:v=1:a=1[joined][original]`);
    if (frameAligned) {
      filters.push(`[joined]fps=${fps},tpad=stop_mode=clone:stop=${totalFrames},trim=end_frame=${totalFrames}[video]`);
    } else if (narration) {
      filters.push(`[joined]fps=${fps},tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds}[video]`);
    } else {
      filters.push(`[joined]fps=${fps}[video]`);
    }
  }
  if (narration && !positioned) {
    filters.push(`[original]apad=whole_dur=${seconds},atrim=duration=${seconds},asetpts=PTS-STARTPTS[bed]`);
    audioTracks[0] = '[bed]';
  }
  if (alignVoices && !positioned) {
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
    filters.push(`[${index}:${music.audioIndex}]aresample=48000,aformat=channel_layouts=stereo${tempoFilter(plan.musicSpeed ?? 1)},volume=${musicVolume},atrim=duration=${time(musicDuration)},asetpts=PTS-STARTPTS${delay}[music]`);
    audioTracks.push('[music]');
  }
  if (narration) {
    args.push(...mediaInput, '-i', narration.path);
    const delay=plan.voiceStart ? ',adelay='+Math.round(plan.voiceStart*48000)+'S:all=1' : '';
    filters.push(voiceInputFilter(inputCount, narration, 0, time((duration-(plan.voiceStart ?? 0))*(plan.narrationSpeed ?? 1)), narrationVolume, delay+'[narration]', plan.narrationSpeed));
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
    // These intermediate files contain a candidate's source pieces in local time.
    const track = {
      ...plan, clips:parts.map(({videoStart,videoDuration,videoFit,hiddenVideo,...part})=>part), duration, music:null, narration:null,
      narrationMode:'whole', subtitles:null, videoSubtitles:null, layers:[],
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
    // Visibility is applied over the underlying lanes after pre-rendering the source pieces.
    const visibleSpans=[];
    let frame=0;
    for (const part of parts) {
      const start=frame/plan.fps;
      frame+=part.outputFrames;
      if (part.hiddenVideo) continue;
      if (visibleSpans.at(-1)?.end===start) visibleSpans.at(-1).end=frame/plan.fps;
      else visibleSpans.push({start,end:frame/plan.fps});
    }
    clips.push({ ...clip, hiddenVideo:!visibleSpans.length, visuals: [track],
      ...(visibleSpans.length && parts.some(part=>part.hiddenVideo) && {visibleSpans}) });
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

/**
 * @typedef {{index: number, count: number, fraction: number, results: {index: number, name: string, path: string}[], failures: {index: number, message: string}[]}} ExportProgress
 * @param {Array<(ReturnType<typeof planMontage>[number] | ReturnType<typeof planExtraction>[number]) & {subproject?: {id: string, name: string}}>} plans
 * @param {string} directory
 * @param {{signal?: AbortSignal, onUpdate?: (item: ExportProgress) => void}} [options]
 */
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

/** @param {InspectedAsset} asset @param {MediaReadOptions} [options] */
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
  videoExtensions, imageExtensions, audioExtensions, maxShots, maxCandidates, maxExports, maxMontageBatch, maxWholeTracks, minClipSeconds, maxStillSeconds,
  inspectAsset, createFrameThumbnail, createVideoThumbnail, analyzeNarrationSilence, normalizeGeneratedCaptions, normalizeSubtitleStyle, previewSubtitleStyle, planMontage, planExtraction, exportBatch,
};

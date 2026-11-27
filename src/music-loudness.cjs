'use strict';

const path = require('node:path');
const { mediaTool } = require('./media-tool.cjs');
const { musicMix: messages } = require('./ui/messages-zh-cn.js');
const safeInput = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,matroska,webm,avi,mpegts,mpeg,mp3,wav,aac,flac,ogg',
];
const sampleRate = 48000;
const readNumber = (value) => (value === '-inf' ? null : Number(value));

// FFmpeg 8 writes the final JSON block on stderr. Restrict it to the tool's
// bounded tail and never put source paths, input metadata or filter text in UI.
async function inspectLoudness(
  file,
  stream,
  target,
  { signal, inputFilter = '', onProgress, errorMessage = messages.finalMeasurementFailed },
) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'info',
    ...safeInput,
    '-i',
    file,
    '-map',
    stream,
    '-vn',
    '-sn',
    '-dn',
    '-af',
    inputFilter + 'loudnorm=I=' + target + ':TP=-1:LRA=11:print_format=json',
    ...(onProgress ? ['-progress', 'pipe:1'] : []),
    '-f',
    'null',
    '-',
  ];
  const stats = await require('./media.cjs')
    .runTool(mediaTool('ffmpeg'), args, {
      signal,
      stderrStats: true,
      onProgress,
    })
    .catch((error) => {
      signal?.throwIfAborted();
      throw Error(errorMessage, { cause: error });
    });
  const json = [...stats.matchAll(/\[Parsed_loudnorm_\d+ @ [^\]\r\n]+\]\s*(\{\s*"input_i"\s*:[^{}]{1,1500}\})/g)].at(
    -1,
  )?.[1];
  if (!json) throw Error(errorMessage);
  const row = JSON.parse(json);
  const [i, tp, lra, threshold, offset] = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].map(
    (k) => readNumber(row[k]),
  );
  if (
    ![i, tp].every((v) => v === null || Number.isFinite(v)) ||
    (i !== null && ![tp, lra, threshold, offset].every(Number.isFinite))
  ) {
    throw Error(errorMessage);
  }
  return { i, tp, lra, threshold, offset };
}

async function measureMusicLoudness(asset, { signal } = {}) {
  if (!Number.isInteger(asset?.audioIndex) || asset.audioIndex < 0) throw Error(messages.measurementFailed);
  const stats = await inspectLoudness(asset.path, '0:' + asset.audioIndex, -18, {
    signal,
    inputFilter: 'aresample=48000,aformat=channel_layouts=stereo,',
    errorMessage: messages.measurementFailed,
  });
  return { integratedLufs: stats.i, truePeakDbtp: stats.tp };
}

function correctionFilter(stats, target, ceiling) {
  if (stats.i === null) {
    const gain = stats.tp === null ? 0 : Math.min(0, ceiling - stats.tp);
    return 'volume=' + gain + 'dB';
  }
  return [
    'loudnorm=I=' + target,
    'TP=' + ceiling,
    'LRA=11',
    'measured_I=' + stats.i,
    'measured_TP=' + stats.tp,
    'measured_LRA=' + stats.lra,
    'measured_thresh=' + stats.threshold,
    'offset=' + stats.offset,
    'linear=true',
  ].join(':');
}

async function normalizeFinalMix(source, plan, directory, files, signal, onProgress) {
  const target = plan.musicMix.normalizeLufs;
  const phase = (start, end) =>
    onProgress && ((seconds) => onProgress(start * plan.duration + (end - start) * Math.min(seconds, plan.duration)));
  const initial = await inspectLoudness(source, '0:a:0', target, { signal, onProgress: phase(0.65, 0.75) });
  let requested = target,
    ceiling = -1.25,
    actual;
  const sampleCount = Math.round(
    ((plan.audioDuration ?? plan.contentDuration ?? plan.duration) + (plan.cover?.frames ?? 0) / plan.fps) * sampleRate,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = path.join(directory, 'normalized-' + attempt + '.mp4');
    files.push(file);
    const filter =
      correctionFilter(initial, requested, ceiling) +
      ',aresample=48000,apad=whole_len=' +
      sampleCount +
      ',atrim=end_sample=' +
      sampleCount;
    await require('./media.cjs').runTool(
      mediaTool('ffmpeg'),
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel',
        'error',
        '-n',
        ...safeInput,
        '-i',
        source,
        '-map',
        '0:v',
        '-map',
        '0:a:0',
        '-c:v',
        'copy',
        '-af',
        filter,
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-movie_timescale',
        '48000',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        file,
      ],
      { signal, onProgress: attempt ? phase(0.94, 0.97) : phase(0.75, 0.86) },
    );
    actual = await inspectLoudness(file, '0:a:0', target, {
      signal,
      onProgress: attempt ? phase(0.97, 0.99) : phase(0.86, 0.94),
    });
    const levelOk = actual.i === null ? initial.i === null : Math.abs(actual.i - target) <= 1;
    const peakOk = initial.tp === null ? actual.tp === null : actual.tp !== null && actual.tp <= -1;
    if (levelOk && peakOk)
      return { file, ...(initial.i === null && initial.tp !== null && { normalizationNotice: 'peak-only' }) };
    if (actual.i !== null) requested = Math.min(-5, Math.max(-70, requested + target - actual.i));
    if (actual.tp !== null && actual.tp > -1) ceiling = Math.max(-9, ceiling - (actual.tp + 1) - 0.5);
  }
  throw Error(messages.normalizationFailed(target, actual.i, actual.tp));
}

module.exports = { measureMusicLoudness, normalizeFinalMix };

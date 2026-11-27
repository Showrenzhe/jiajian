'use strict';

const path = require('node:path');
const mix = require('./ui/music-mix.js');
const rate = 48000;
const sample = (seconds) => Math.round(seconds * rate);
const fixed = (value) => Number(value.toFixed(10));
const mediaInput = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,matroska,webm,avi,mpegts,mpeg,mp3,wav,aac,flac,ogg',
];

function musicInput(tempo) {
  return 'aresample=48000,aformat=channel_layouts=stereo' + tempo + ',asetpts=N/SR/TB';
}

// Store just one crossfaded period. Looping a full-length song on disk keeps
// memory bounded; for a short period aloop avoids thousands of file seeks.
async function prepareMusicCycle(plan, directory, files, tempo, run, signal) {
  if (!plan.music || !plan.musicVolume || plan.musicMix?.mode !== 'smart') return plan;
  const timing = mix.loopTiming(
    plan.music.duration,
    plan.musicSpeed ?? 1,
    plan.musicMix.crossfadeMs,
    plan.duration - (plan.musicStart ?? 0),
  );
  const end = sample(timing.length),
    x = sample(timing.overlap),
    period = end - x;
  if (!x) return plan;
  const source =
    '[0:' + plan.music.audioIndex + ']' + musicInput(tempo) + ',apad=whole_len=' + end + ',atrim=end_sample=' + end;
  const middle = period > x;
  const filters = [
    source + (middle ? ',asplit=3[head][tail][mid]' : ',asplit[head][tail]'),
    '[head]atrim=end_sample=' + x + ',asetpts=N/SR/TB,afade=t=in:ss=0:ns=' + x + '[fadein]',
    '[tail]atrim=start_sample=' + period + ',asetpts=N/SR/TB,afade=t=out:ss=0:ns=' + x + '[fadeout]',
    '[fadeout][fadein]amix=inputs=2:duration=first:normalize=0' + (middle ? '[seam]' : '[cycle]'),
  ];
  if (middle)
    filters.push(
      '[mid]atrim=start_sample=' + x + ':end_sample=' + period + ',asetpts=N/SR/TB[middle]',
      '[middle][seam]concat=n=2:v=0:a=1[cycle]',
    );
  const file = path.join(directory, 'music-cycle.flac');
  files.push(file);
  await run(
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-n',
      ...mediaInput,
      '-i',
      plan.music.path,
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[cycle]',
      '-c:a',
      'flac',
      '-sample_fmt',
      's32',
      file,
    ],
    { signal },
  );
  return { ...plan, musicCycle: { file, period, overlap: x } };
}

// Balanced lookup limits both FFmpeg expression depth and work per sample for
// long storyboards. Fields in these expressions come from the validated plan.
function envelopeExpression(points, offset) {
  const knots = points.map((point) => ({ ...point, time: fixed(point.time - offset) }));
  function interval(index) {
    if (index < 0) return '1';
    const a = knots[index],
      b = knots[index + 1];
    if (!b || a.gain === b.gain) return String(fixed(a.gain));
    return '(' + fixed(a.gain) + '+(t-(' + a.time + '))*(' + fixed((b.gain - a.gain) / (b.time - a.time)) + '))';
  }
  function render(lo, hi) {
    if (lo === hi) return interval(lo - 1);
    const mid = Math.floor((lo + hi) / 2);
    return 'if(lt(t,' + knots[mid].time + '),' + render(lo, mid) + ',' + render(mid + 1, hi) + ')';
  }
  return render(0, knots.length);
}

function appendMusic(plan, intervals, args, filters, input, tempo) {
  const delay = sample(plan.musicStart ?? 0),
    length = sample(plan.duration) - delay;
  if (!plan.music || length <= 0) return input;
  const cycle = plan.musicCycle;
  args.push(...mediaInput, '-i', plan.music.path);
  let source = '[' + input + ':' + plan.music.audioIndex + ']' + musicInput(tempo);
  input++;
  if (cycle) {
    filters.push(source + ',apad=whole_len=' + cycle.overlap + ',atrim=end_sample=' + cycle.overlap + '[musicHead]');
    const short = cycle.period <= 5 * rate;
    args.push(...mediaInput, ...(short ? [] : ['-stream_loop', '-1']), '-i', cycle.file);
    const loop = '[' + input + ':a:0]' + (short ? 'aloop=loop=-1:size=' + cycle.period + ',' : '');
    input++;
    filters.push(loop + 'atrim=end_sample=' + (length - cycle.overlap) + ',asetpts=N/SR/TB[musicRepeat]');
    source = '[musicHead][musicRepeat]concat=n=2:v=0:a=1';
  }
  let effects =
    ',atrim=end_sample=' + length + ',asetpts=N/SR/TB,volume=' + fixed(plan.musicVolume * (plan.musicGain ?? 1));
  const points = mix.duckEnvelope(intervals, plan.musicMix);
  if (points.length) effects += ",aeval=exprs='val(ch)*" + envelopeExpression(points, delay / rate) + "':c=same";
  if (delay) effects += ',adelay=' + delay + 'S:all=1';
  filters.push(source + effects + '[music]');
  return input;
}

module.exports = { prepareMusicCycle, appendMusic, musicInput };

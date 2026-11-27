'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const mix = require('../src/ui/music-mix.js');
const { prepareMusicCycle, appendMusic, musicInput } = require('../src/music-render.cjs');
const { measureMusicLoudness } = require('../src/music-loudness.cjs');
const { inspectAsset, exportBatch, planMontage, tempoFilter } = require('../src/media.cjs');
const { createPreviewBatch, selectPreviewPlans } = require('../src/preview-plans.cjs');
const { ffmpeg } = require('./fixtures.cjs');
const rate = 48000;

async function directory(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jj-mix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function audio(root, name, expression, duration) {
  const file = path.join(root, name + '.wav');
  await ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='" + expression + "':s=48000:d=" + duration, '-c:a', 'pcm_f32le', file]);
  return inspectAsset(file, 'audio');
}

async function picture(root) {
  const file = path.join(root, 'picture.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', '-threads', '1', '-update', '1', file]);
  return inspectAsset(file, 'image');
}

function montageConfig(length) {
  return {
    shots: [[{ id: 'picture', start: 0, end: length }]],
    ratio: '1:1',
    resolution: 720,
    fps: 25,
    fit: 'fit',
    keepAudio: false,
    unordered: false,
    useOriginal: true,
    useMirrors: false,
    shotSettings: [{ duration: length }],
    musicVolume: 100,
    musicIds: ['music'],
    count: 1,
    musicMix: mix.smartDefaults,
  };
}

function rms(pcm, start, end) {
  let power = 0,
    n = 0;
  for (let i = Math.round(start * rate); i < Math.round(end * rate); i++) {
    const value = pcm.readFloatLE(i * 4);
    power += value * value;
    n++;
  }
  return Math.sqrt(power / n);
}

test('shared envelope, loop phase, gain limits and settings match the 48 kHz clock', () => {
  assert.equal(mix.normalizeSettings().mode, 'legacy');
  assert.throws(() => mix.normalizeSettings({ ...mix.smartDefaults, normalizeLufs: -15 }));
  for (const [duckDb, releaseMs] of [
    [6, 200],
    [12, 400],
  ]) {
    const settings = { ...mix.smartDefaults, duckDb, releaseMs };
    const curve = mix.duckEnvelope(
      [
        { start: 0.2, end: 0.32 },
        { start: 0.31, end: 0.4 },
        { start: 0.45, end: 0.6 },
      ],
      settings,
    );
    const low = 10 ** (-duckDb / 20);
    assert.ok(Math.abs(mix.gainAt(curve, 0.35) - low) < 1e-9);
    assert.ok(mix.gainAt(curve, 0.45) > low && mix.gainAt(curve, 0.45) < 1);
    assert.ok(Math.abs(mix.gainAt(curve, 0.6 + releaseMs / 1000) - 1) < 1e-9);
  }
  assert.equal(mix.compensationGain({ integratedLufs: null, truePeakDbtp: -20 }, true), 1);
  assert.equal(mix.compensationGain({ integratedLufs: -40, truePeakDbtp: -3 }, true), 10 ** (2 / 20));
  assert.equal(mix.compensationGain({ integratedLufs: -40, truePeakDbtp: 0 }, true), 10 ** (-1 / 20));
  assert.equal(mix.compensationGain({ integratedLufs: -40, truePeakDbtp: -30 }, true), 10 ** (12 / 20));
  const timing = mix.loopTiming(0.18, 2, 200, 4);
  assert.equal(timing.overlap, 0.045);
  assert.equal(mix.loopAt(0.045, timing).length, 2);
  assert.equal(mix.loopTiming(0.18, 2, 200, 0.09).overlap, 0);
});

test('decoded music follows the shared duck/release and crossfade at every sample, including a short track', async (t) => {
  const root = await directory(t);
  const music = await audio(root, 'ramp', '0.25-0.4*t/0.12|0', 0.12);
  for (const [db, release] of [
    [6, 200],
    [mix.smartDefaults.duckDb, mix.smartDefaults.releaseMs],
    [12, 400],
  ]) {
    const duration = 0.84;
    const intervals = [{ start: 0.14, end: 0.31 }];
    const settings = { ...mix.smartDefaults, duckDb: db, releaseMs: release };
    const track = { music, musicMix: settings, musicVolume: 1, duration };
    const dir = path.join(root, String(db));
    await fs.mkdir(dir);
    const plan = await prepareMusicCycle(track, dir, [], '', ffmpeg);
    assert.ok(plan.musicCycle);
    const args = [],
      filters = [];
    appendMusic(plan, intervals, args, filters, 0, '');
    const bytes = await ffmpeg([
      ...args,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[music]',
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      'pipe:1',
    ]);
    const timing = mix.loopTiming(0.12, 1, 200, duration);
    const curve = mix.duckEnvelope(intervals, settings);
    let previous = 0,
      maxJump = 0,
      maxError = 0,
      onPower = 0,
      offPower = 0;
    assert.equal(bytes.length, duration * rate * 8);
    for (let i = 0; i < duration * rate; i++) {
      const sec = i / rate;
      const baseline = mix.loopAt(sec, timing).reduce((n, p) => n + p.gain * (0.25 - (0.4 * p.position) / 0.12), 0);
      const actual = bytes.readFloatLE(i * 8);
      maxError = Math.max(maxError, Math.abs(actual - baseline * mix.gainAt(curve, sec)));
      if (sec >= 0.18 && sec < 0.29) {
        onPower += actual * actual;
        offPower += baseline * baseline;
      }
      if (i) maxJump = Math.max(maxJump, Math.abs(actual - previous));
      previous = actual;
    }
    assert.ok(maxJump <= 0.02, 'largest per-sample seam jump ' + maxJump);
    assert.ok(maxError < 0.001, 'crossfade and release envelope error ' + maxError);
    assert.ok(Math.abs(10 * Math.log10(onPower / offPower) + db) <= 0.5);
    t.diagnostic(
      `${db} dB / ${release} ms：实测 ${(10 * Math.log10(onPower / offPower)).toFixed(3)} dB，最大样本跳变 ${maxJump.toFixed(6)}。`,
    );
  }
});

test('selected preview and export duck only the planned audible whole voice interval', async (t) => {
  const root = await directory(t);
  const music = await audio(root, 'music', '0.16*sin(2*PI*400*t)|0', 2);
  const voice = await audio(root, 'voice', '0|0.08*sin(2*PI*900*t)', 0.5);
  const catalog = new Map([
    ['picture', await picture(root)],
    ['music', music],
    ['voice', voice],
  ]);
  const config = { ...montageConfig(1.6), narrationId: 'voice' };
  const [plan] = planMontage(config, catalog, () => 0);
  plan.size = [96, 96];
  plan.voiceStart = 0.3;
  plan.narrationMap = { duration: 0.4, fadeDuration: 0, parts: [{ start: 0, end: 0.4, outStart: 0, outEnd: 0.4 }] };
  const batch = createPreviewBatch(config, catalog, [plan]);
  const chosen = selectPreviewPlans(batch, config, { id: batch.id, indices: [0] });
  const results = await exportBatch([...chosen, ...chosen, { ...plan, narrationVolume: 0 }], root);
  assert.deepEqual(results.failures, []);
  const files = await Promise.all(
    results.results.map(({ path: file }) =>
      ffmpeg(['-i', file, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']),
    ),
  );
  assert.deepEqual(files[0], files[1]);
  const ratio = (start, end) => 20 * Math.log10(rms(files[0], start, end) / rms(files[2], start, end));
  assert.ok(Math.abs(ratio(0.45, 0.65) + 9) < 0.5, 'speech attenuation ' + ratio(0.45, 0.65));
  assert.ok(Math.abs(ratio(0.08, 0.22)) < 0.5);
  assert.ok(Math.abs(ratio(1.04, 1.25)) < 0.5);
});

test('multi-track random compensation preserves draws and single or solo selection respects manual gain', async (t) => {
  const root = await directory(t);
  const a = await audio(root, 'a', '0.04*sin(2*PI*440*t)|0', 0.5);
  const b = { ...a, name: 'b' };
  for (const asset of [a, b]) asset.musicLoudness = { integratedLufs: -24, truePeakDbtp: -12 };
  const catalog = new Map([
    ['picture', await picture(root)],
    ['a', a],
    ['b', b],
  ]);
  function draw(config) {
    let draws = 0;
    const [plan] = planMontage({ ...montageConfig(1), musicIds: ['a', 'b'], ...config }, catalog, () => {
      draws++;
      return 0.75;
    });
    return { draws, plan };
  }
  const smart = draw({}),
    legacy = draw({ musicMix: mix.legacyDefaults });
  assert.equal(smart.plan.music, legacy.plan.music);
  assert.deepEqual(smart.plan.clips, legacy.plan.clips);
  assert.equal(smart.draws, legacy.draws);
  assert.equal(smart.plan.musicGain, 10 ** (6 / 20));
  assert.equal(draw({ trackControls: { music1: { solo: true } } }).plan.musicGain, 1);
  assert.equal(draw({ musicIds: ['a'] }).plan.musicGain, 1);
  assert.equal(
    draw({ musicIds: ['a'], musicMix: { ...mix.smartDefaults, compensateManual: true } }).plan.musicGain,
    10 ** (6 / 20),
  );
});

test('segmented narration uses retained ranges, speed and offset after a silent shot', async (t) => {
  const root = await directory(t);
  const music = await audio(root, 'music', '0.14*sin(2*PI*400*t)|0', 3);
  const voice = await audio(root, 'voice', '0|0.09*sin(2*PI*900*t)', 1);
  const catalog = new Map([
    ['music', music],
    ['v', voice],
    ['picture', await picture(root)],
  ]);
  const config = {
    ...montageConfig(1),
    shots: [[{ id: 'picture', start: 0, end: 0.6 }], [{ id: 'picture', start: 0, end: 1.4 }]],
    shotSettings: [{ duration: 0.6 }, { duration: 1.4 }],
    narrationMode: 'segmented',
    priority: 'picture',
    narrationTrim: { mode: 'smart' },
    segmentNarrationIds: [[], ['v']],
    segmentVoiceCuts: [
      [],
      [
        {
          offset: 0.2,
          speed: 2,
          ranges: [
            { start: 0.12, end: 0.52 },
            { start: 0.6, end: 1 },
          ],
        },
      ],
    ],
  };
  const plan = (flags) => ({
    ...planMontage({ ...config, trackControls: flags }, catalog, () => 0)[0],
    size: [96, 96],
  });
  const audible = plan(),
    muted = plan({ voice0: { muted: true } });
  assert.ok(Math.abs(audible.clips[1].narrationMap.duration - 0.4) < 1 / rate);
  const batch = await exportBatch([audible, muted], root);
  assert.deepEqual(batch.failures, []);
  const [withVoice, withoutVoice] = await Promise.all(
    batch.results.map((row) =>
      ffmpeg(['-i', row.path, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']),
    ),
  );
  const delta = (start, end) => 20 * Math.log10(rms(withVoice, start, end) / rms(withoutVoice, start, end));
  for (const [start, end, db] of [
    [0.5, 0.7, 0],
    [0.9, 1.13, -9],
    [1.54, 1.8, 0],
  ])
    assert.ok(Math.abs(delta(start, end) - db) < 0.5);
});

test('long crossfaded periods stream from disk at the requested tempo and start offset', async (t) => {
  const root = await directory(t);
  const music = await audio(root, 'long', '0.12+0.06*sin(2*PI*311*t)|0', 6.2);
  const speed = 1.1,
    start = 0.16,
    play = 12,
    timing = mix.loopTiming(music.duration, speed, 200, play);
  const tempo = tempoFilter(speed);
  const plan = await prepareMusicCycle(
    {
      music,
      musicSpeed: speed,
      musicStart: start,
      musicMix: mix.smartDefaults,
      musicVolume: 1,
      duration: start + play,
    },
    root,
    [],
    tempo,
    ffmpeg,
  );
  const args = [],
    filters = [];
  appendMusic(plan, [], args, filters, 0, tempo);
  assert.ok(args.includes('-stream_loop'));
  const samples = Math.round(timing.length * rate);
  const reference = await ffmpeg([
    '-i',
    music.path,
    '-af',
    musicInput(tempo) + ',apad=whole_len=' + samples + ',atrim=end_sample=' + samples + ',pan=mono|c0=c0',
    '-f',
    's16le',
    'pipe:1',
  ]);
  const first = Math.round((start + 2 * timing.period - 0.03) * rate),
    n = Math.round(0.28 * rate);
  filters.push('[music]atrim=start_sample=' + first + ':end_sample=' + (first + n) + ',pan=mono|c0=c0[result]');
  const rendered = await ffmpeg([
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[result]',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  let error = 0;
  assert.equal(rendered.length, 4 * n);
  for (let i = 0; i < n; i++) {
    const expected = mix
      .loopAt((first + i) / rate - start, timing)
      .reduce((sum, p) => sum + (p.gain * reference.readInt16LE(2 * Math.round(p.position * rate))) / 32768, 0);
    error = Math.max(error, Math.abs(expected - rendered.readFloatLE(4 * i)));
  }
  assert.ok(error < 0.001, 'streamed cycle error ' + error);
});

test('each final AAC stream reaches its own target after cover assembly and short material keeps peak safety', async (t) => {
  const root = await directory(t);
  const still = await picture(root);
  const quiet = await audio(root, 'quiet', '0.025*sin(2*PI*400*t)|0.025*sin(2*PI*400*t)', 4);
  const loud = await audio(root, 'loud', '0.6*sin(2*PI*400*t)|0.6*sin(2*PI*400*t)', 4);
  const silent = await audio(root, 'silent', '0|0', 0.2);
  const short = await audio(root, 'short', '0.97*sin(2*PI*800*t)|0.97*sin(2*PI*800*t)', 0.2);
  function draw(asset, length, target, cover) {
    const cfg = {
      ...montageConfig(length),
      musicMix: { ...mix.smartDefaults, normalizeLufs: target },
      ...(cover && { cover: { mode: 'random', items: [] } }),
    };
    return {
      ...planMontage(
        cfg,
        new Map([
          ['music', asset],
          ['picture', still],
        ]),
        () => 0,
      )[0],
      size: [96, 96],
    };
  }
  const plans = [
    draw(quiet, 4, -14, true),
    draw(loud, 4, -16, false),
    draw(silent, 0.2, -14, false),
    draw(short, 0.2, -16, false),
  ];
  const result = await exportBatch(plans, root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.results.length, 4);
  assert.equal(result.results[3].normalizationNotice, 'peak-only');
  for (const [i, row] of result.results.entries()) {
    const asset = await inspectAsset(row.path, 'video');
    const { integratedLufs, truePeakDbtp } = await measureMusicLoudness(asset);
    if (i < 2) assert.ok(Math.abs(integratedLufs - [-14, -16][i]) <= 1, JSON.stringify({ i, integratedLufs }));
    else assert.equal(integratedLufs, null);
    assert.ok(truePeakDbtp === null || truePeakDbtp <= -1);
    t.diagnostic(`成片 ${i + 1}：${integratedLufs ?? '不可测'} LUFS，${truePeakDbtp ?? '静音'} dBTP。`);
    if (!i) assert.ok(asset.duration > 4, 'random cover intro remains in the normalized video');
  }
  assert.equal(tempoFilter(3), ',atempo=2,atempo=1.5');
});

test('an unachievable loudness and peak pair fails that entry without publishing an unverified file', async (t) => {
  const root = await directory(t);
  const pulse = '0.97*pow(cos(PI*t),1000000)*cos(2*PI*3400*t)';
  const music = await audio(root, 'pulses', pulse + '|' + pulse, 4);
  const config = { ...montageConfig(4), musicMix: { ...mix.smartDefaults, normalizeLufs: -14 } };
  const [plan] = planMontage(
    config,
    new Map([
      ['music', music],
      ['picture', await picture(root)],
    ]),
    () => 0,
  );
  const batch = await exportBatch([{ ...plan, size: [96, 96] }], root);
  assert.equal(batch.results.length, 0);
  assert.equal(batch.failures.length, 1);
  assert.match(batch.failures[0].message, /LUFS.*dBTP/);
  t.diagnostic(batch.failures[0].message);
  assert.equal(
    (await fs.readdir(root)).some((name) => name.endsWith('.mp4') || name.startsWith('.sd-export-')),
    false,
  );
});

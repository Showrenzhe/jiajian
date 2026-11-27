'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  smartDefaults,
  legacyDefaults,
  normalizeSettings,
  buildMap,
  mapCaptions,
} = require('../src/ui/narration-trim.js');
const { analyzeNarrationPauses, inspectAsset, exportBatch, runTool } = require('../src/media.cjs');
const { prepareMontagePlans } = require('../src/preview-plans.cjs');
const { ffmpeg } = require('./fixtures.cjs');

test('静音分析以持续前进的媒体时间续期，卡住的读数仍会超时', async () => {
  const program = (value) =>
    'let n=0;const timer=setInterval(()=>{console.log("out_time_us="+' +
    value +
    ');if(++n===8)clearInterval(timer)},180)';
  await runTool(process.execPath, ['-e', program('n*1000')], { progressTimeout: 900 });
  await assert.rejects(runTool(process.execPath, ['-e', program('0')], { progressTimeout: 900 }), /超时/);
});

test('句末优先，其次实测停顿；窗口以外、未选区间和纯文本均不能作为断点', () => {
  const asset = { duration: 4, narrationPauses: [{ start: 2.8, end: 2.94 }] };
  const args = { asset, ranges: [{ start: 2, end: 3.6 }], available: 1, picture: true, settings: smartDefaults };
  const cue = (end, text) => ({ start: end - 100, end, text });
  const map = buildMap({
    ...args,
    caption: { cues: [cue(2640, '一句。'), cue(2780, '完成！”'), cue(2910, '没有句号')] },
  });
  assert.equal(map.reason, 'sentence');
  assert.equal(map.duration, 0.78);
  assert.equal(map.fadeDuration, 0);
  const pause = buildMap({ ...args, caption: '纯文本。' });
  assert.equal(pause.reason, 'pause');
  assert.equal(pause.duration, 0.87);
  const hard = buildMap({
    ...args,
    asset: { duration: 4 },
    available: 0.04,
    caption: { cues: [cue(1980, '上一段。')] },
  });
  assert.equal(hard.duration, 0.04);
  assert.equal(hard.fadeDuration, 0.04);
  assert.deepEqual(
    buildMap({ ...args, asset: { duration: 4, narrationPauses: [{ start: 0, end: 4 }] }, available: 0 }).parts,
    [],
  );
  const legacy = buildMap({ ...args, settings: legacyDefaults });
  assert.deepEqual([legacy.duration, legacy.fadeDuration], [1, 0]);
  assert.throws(() => normalizeSettings({ ...smartDefaults, fadeMs: 79 }), /范围/);
});

test('每行字幕均位于所属保留音频，含重排、重复、倍速、偏移及跨界裁剪', () => {
  const caption = {
    cues: [
      { start: 50, end: 550, text: '甲' },
      { start: 560, end: 1350, text: '乙' },
      { start: 1600, end: 2000, text: '丙' },
    ],
  };
  const ranges = [
    { start: 1.1, end: 1.7 },
    { start: 0.12, end: 0.7 },
    { start: 1.1, end: 1.7 },
  ];
  for (const speed of [0.5, 1, 1.3, 3])
    for (const available of [0, 0.099, 0.501, 1.313, 4]) {
      const map = buildMap({
        asset: { duration: 2 },
        ranges,
        speed,
        available,
        picture: true,
        settings: smartDefaults,
      });
      const offset = 0.003771;
      const cues = mapCaptions(map, caption, offset);
      for (const cue of cues) {
        const original = caption.cues.find((row) => row.text === cue.text);
        assert.ok(
          map.parts.some((part) => {
            const scale = (part.outEnd - part.outStart) / (part.end - part.start);
            const first = Math.max(part.start, original.start / 1000);
            const last = Math.min(part.end, original.end / 1000);
            const begin = offset + part.outStart + (first - part.start) * scale;
            const end = offset + part.outStart + (last - part.start) * scale;
            return (
              last > first &&
              cue.start / 1000 >= begin - 1 / 48000 &&
              cue.end / 1000 <= end + 1 / 48000 &&
              cue.end > cue.start
            );
          }),
          JSON.stringify({ cue, map }),
        );
      }
      assert.equal(Boolean(cues.length), available > 0);
      if (available === 4 && speed === 1)
        assert.deepEqual(
          cues.map((c) => c.text),
          ['乙', '丙', '甲', '乙', '乙', '丙'],
        );
    }
  const seam = {
    asset: {
      duration: 3,
      narrationPauses: [
        { start: 0.2, end: 0.6 },
        { start: 1.5, end: 1.9 },
      ],
    },
    ranges: [
      { start: 0.25, end: 0.9 },
      { start: 1.2, end: 1.8 },
    ],
    settings: smartDefaults,
    trimHead: true,
    trimTail: true,
  };
  const cut = buildMap(seam);
  assert.deepEqual([cut.trimStart, cut.trimEnd], [0.23, 0.18]);
  const short = buildMap({ ...seam, asset: { duration: 3, narrationPauses: [{ start: 0.2, end: 0.35 }] } });
  assert.deepEqual([short.trimStart, short.trimEnd], [0, 0]);
  assert.equal(buildMap({ ...seam, asset: { duration: 3, narrationPauses: [{ start: 0, end: 3 }] } }).reason, 'none');
});

test('真实静音扫描分参数缓存、拒绝已取消扫描；预览计划与成片保留断点、字幕、包装及淡出', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-narration-trim-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stillFile = path.join(dir, 'still.png');
  const toneFile = path.join(dir, 'tone.wav');
  const pausedFile = path.join(dir, 'paused.wav');
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=160x90', '-frames:v', '1', '-threads', '1', '-update', '1', stillFile]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1.6', '-c:a', 'pcm_s16le', toneFile]),
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:sample_rate=48000:duration=1.6',
      '-af',
      "volume=0:enable='between(t,0.68,0.90)'",
      '-c:a',
      'pcm_s16le',
      pausedFile,
    ]),
  ]);
  const sameTime = new Date('2025-01-01T00:00:00.000Z');
  await Promise.all([toneFile,pausedFile].map(file=>fs.utimes(file,sameTime,sameTime)));
  const before = await fs.stat(pausedFile,{bigint:true});
  const [still, tone, paused] = await Promise.all([
    inspectAsset(stillFile, 'image'),
    inspectAsset(toneFile, 'audio'),
    inspectAsset(pausedFile, 'audio'),
  ]);
  const catalog = new Map([
    ['still', still],
    ['tone', tone],
    ['paused', paused],
  ]);
  const clip = { id: 'still', start: 0, end: 1 };
  const base = {
    shots: [[clip]],
    ratio: '16:9',
    resolution: 720,
    fps: 25,
    fit: 'fit',
    keepAudio: false,
    unordered: false,
    useOriginal: true,
    useMirrors: false,
    count: 1,
    musicIds: [],
    priority: 'picture',
    narrationTrim: smartDefaults,
  };
  const fingerprint = await analyzeNarrationPauses(paused, smartDefaults);
  assert.equal(fingerprint.length, 1);
  assert.strictEqual(await analyzeNarrationPauses(paused, { ...smartDefaults, fadeMs: 150 }), fingerprint);
  assert.deepEqual(await analyzeNarrationPauses(paused, { ...smartDefaults, minSilenceMs: 350 }), []);
  await assert.rejects(analyzeNarrationPauses(paused, smartDefaults, { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  const controller = new AbortController();
  const differentThreshold = { ...smartDefaults, thresholdDb: -41 };
  const inFlight = analyzeNarrationPauses(paused, differentThreshold, { signal: controller.signal });
  const interrupt = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(inFlight, { name: 'AbortError' });
  } finally {
    clearTimeout(interrupt);
  }
  assert.equal((await analyzeNarrationPauses(paused, differentThreshold)).length, 1, '取消不会缓存不完整的结果');
  const get = async (options) => (await prepareMontagePlans({ ...base, ...options }, catalog))[0];
  const text = { kind: 'text', text: '绑定', start: 0.1, end: 1.31 };
  const natural = await get({
    narrationId: 'paused',
    packaging: { wholeNarration: [[text]] },
    generatedCaptions: {
      paused: {
        name: '口播',
        cues: [
          { start: 80, end: 660, text: '句末。' },
          { start: 700, end: 1150, text: '后半句' },
        ],
      },
    },
    timelineCaptions: { name: '独立', cues: [{ start: 850, end: 950, text: '固定' }] },
  });
  assert.equal(natural.duration, 1);
  assert.equal(natural.narrationMap.reason, 'sentence');
  assert.equal(natural.narrationMap.duration, 0.66);
  assert.deepEqual(
    natural.subtitles.cues.map((c) => [c.end, c.text]),
    [
      [660, '句末。'],
      [950, '固定'],
    ],
  );
  assert.equal(natural.layers[0].end, 0.66);
  const pausePlan = await get({
    narrationMode: 'segmented',
    segmentNarrationIds: [['paused']],
    generatedCaptions: { paused: '纯文本' },
    packaging: { segmentNarration: [[[text]]] },
  });
  const pauseMap = pausePlan.clips[0].narrationMap;
  assert.equal(pauseMap.reason, 'pause');
  assert.ok(pauseMap.duration > 0.7 && pauseMap.duration < 0.9);
  assert.ok(Math.abs(pausePlan.layers[0].end - pauseMap.duration) < 1 / 48000);
  assert.strictEqual(pausePlan.clips[0].narration, paused, '保留主进程已登记的素材身份');
  const sourceGap = fingerprint[0];
  const seamConfig = {
    priority: 'voice',
    narrationMode: 'segmented',
    shots: [[clip], [clip]],
    segmentNarrationIds: [['paused'], ['paused']],
    segmentVoiceCuts: [
      [{ ranges: [{ start: 0, end: sourceGap.end }] }],
      [{ ranges: [{ start: sourceGap.start, end: 1.6 }] }],
    ],
  };
  const seamPlan = await get(seamConfig);
  const removed = sourceGap.end - sourceGap.start - 0.12;
  assert.ok(Math.abs(seamPlan.clips[0].narrationMap.trimEnd - removed) < 1 / 48000);
  assert.ok(Math.abs(seamPlan.clips[1].narrationMap.trimStart - removed) < 1 / 48000);
  assert.ok(Math.abs(seamPlan.clips[1].narrationStart - removed) < 1 / 48000);
  const reference = await get({ ...seamConfig, voiceAlignment: 'reference' });
  assert.ok(reference.clips.every((c) => c.narrationMap.reason === 'none'));
  const wholeFollow = await get({
    shots: [[{ ...clip, end: 0.4 }], [{ ...clip, end: 0.6 }]],
    narrationId: 'tone',
    wholeStartShots: [1],
    narrationSpeed: 2,
    subtitles: { name: '双倍速', cues: [{ start: 100, end: 800, text: '完成。' }] },
  });
  assert.equal(wholeFollow.narrationMap.duration, 0.4);
  assert.deepEqual(wholeFollow.subtitles.cues, [{ start: 450, end: 800, text: '完成。' }]);
  const fadePlans = [];
  for (const fadeMs of [80, 100, 150]) {
    const plan = await get({
      narrationTrim: { ...smartDefaults, fadeMs },
      ...(fadeMs === 100
        ? {
            narrationMode: 'segmented',
            segmentNarrationIds: [['tone']],
            segmentVoiceCuts: [
              [
                {
                  ranges: [
                    { start: 0.8, end: 1.4 },
                    { start: 0, end: 0.7 },
                  ],
                },
              ],
            ],
          }
        : { narrationId: 'tone' }),
    });
    const map = plan.narrationMap ?? plan.clips[0].narrationMap;
    assert.deepEqual([map.reason, map.duration, map.fadeDuration], ['hard', 1, fadeMs / 1000]);
    fadePlans.push(plan);
  }
  const offsetOnly = await get({
    narrationMode: 'segmented',
    segmentNarrationIds: [['tone']],
    segmentVoiceCuts: [[{ offset: 1, speed: 1 }]],
    generatedCaptions: { tone: '落在画面之外' },
  });
  assert.equal(offsetOnly.clips[0].narrationMap.parts.length, 0);
  assert.equal(offsetOnly.subtitles, null);
  const zeroFrame = await get({
    priority: 'voice',
    fps: 24,
    narrationMode: 'segmented',
    shots: Array.from({ length: 4 }, () => [clip]),
    segmentNarrationIds: Array.from({ length: 4 }, () => ['tone']),
    segmentVoiceCuts: Array.from({ length: 4 }, () => [{ speed: 3, ranges: [{ start: 0, end: 0.1 }] }]),
    volumeOverrides: [0, 1, 3].map((shot) => ({ kind: 'segment', id: 'tone', shot, track: 0, value: 0 })),
  });
  assert.equal(zeroFrame.clips[2].outputFrames, 0);
  assert.equal(Math.round(zeroFrame.clips[2].narrationMap.duration * 48000), 1600);
  const render = await exportBatch([natural, pausePlan, ...fadePlans, wholeFollow, offsetOnly, zeroFrame], dir);
  assert.deepEqual(render.failures, []);
  async function rms(file, center) {
    const pcm = await ffmpeg([
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      'atrim=start=' + String(center - 0.004) + ':end=' + String(center + 0.004),
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ]);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 4) sum += pcm.readFloatLE(i) ** 2;
    return Math.sqrt(sum / (pcm.length / 4));
  }
  for (const { path: file } of render.results.slice(0, 2)) assert.ok((await rms(file, 0.95)) < 0.0005);
  assert.ok((await rms(render.results.at(-2).path, 0.5)) < 0.0005);
  assert.ok((await rms(render.results.at(-1).path, 0.08)) > 0.015, '零帧分镜仍播放该镜的口播采样');
  const sped = render.results.at(-3).path;
  assert.ok(
    (await rms(sped, 0.39)) < 0.0005 && (await rms(sped, 0.55)) > 0.04 && (await rms(sped, 0.815)) < 0.0005,
    '整段口播从跟随分镜起播，2 倍速句末后留静音，画面继续',
  );
  for (const [i, ms] of [80, 100, 150].entries()) {
    const file = render.results[i + 2].path;
    const full = await rms(file, 0.4);
    const middle = await rms(file, 1 - ms / 2000);
    const tail = await rms(file, 0.99);
    assert.ok(
      full > 0.04 && Math.abs(middle / full - 0.5) < 0.095 && Math.abs(tail / full - 0.01 / (ms / 1000)) < 0.065,
      JSON.stringify({ ms, full, middle, tail }),
    );
  }
  await fs.copyFile(toneFile, pausedFile);
  await fs.utimes(pausedFile,sameTime,sameTime);
  const after = await fs.stat(pausedFile,{bigint:true});
  assert.deepEqual([after.size,after.mtimeNs],[before.size,before.mtimeNs]);
  assert.deepEqual(await analyzeNarrationPauses(paused, smartDefaults), [], '同名音频被替换后应重新扫描');
});

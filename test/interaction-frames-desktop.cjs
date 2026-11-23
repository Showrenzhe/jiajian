'use strict';

// node test/run-interaction-frames.cjs [--presentation] [--strict]
// Each run opens a new local profile, generates the same media, fits the project,
// waits 700 ms, then records idle before the four gestures. The latter share a
// renderer and its image/video caches. Keep the window visible and other tests idle.
// --strict gates representative rAF intervals only. With --presentation, Viz also
// reports frames for this window, including compositor-only updates; a static view
// and the time between discrete wheel notches need not produce new display frames.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, screen } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { fixtures } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');

const durationMs = 2000;
const budget = 1000 / 60;
const root = process.env.JIAJIAN_FRAME_BENCH_ROOT;
assert.ok(root, '请从 npm run bench:frames 或 node test/run-interaction-frames.cjs 启动');
const project = path.join(root, '基准.sdworkbench');
const profile = path.join(root, 'profile');
app.setPath('userData', profile);

function sourceFingerprint() {
  const src = path.resolve(__dirname, '../src');
  const hash = createHash('sha256');
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  for (const file of files) hash.update(path.relative(src, file).split(path.sep).join('/')).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}

async function makeProject() {
  const files = await fixtures(root);
  const ids = ['red', 'green', 'blue'];
  const catalog = new Map(await Promise.all([...ids, 'music'].map(async id =>
    [id, await inspectAsset(files[id], id === 'music' ? 'audio' : 'video')])));
  const shots = Array.from({ length: 24 }, (_, index) => [0, 1, 2].map(lane =>
    ({ id: ids[(index + lane) % ids.length], start: 0, end: 1, videoLane: lane })));
  await saveProject(project, {
    shots, ratio: '16:9', resolution: 720, fps: 30, fit: 'fit', keepAudio: true,
    priority: 'picture', unordered: false, useOriginal: true, useMirrors: false, count: 1,
    musicIds: ['music'], musicVolume: 50, narrationMode: 'segmented',
    segmentNarrationIds: shots.map(() => ['music']),
    timelineCaptions: { name: '字幕', cues: shots.map((_, i) => ({ start: i * 1000, end: i * 1000 + 800, text: String(i + 1) })) },
  }, catalog);
}

function summarize({ timestamps, events, elapsedMs }) {
  const intervals = timestamps.slice(1).map((time, i) => time - timestamps[i]).sort((a, b) => a - b);
  assert.ok(intervals.length, '没有采到 rAF 帧间隔');
  const quantile = q => +intervals[Math.ceil(q * intervals.length) - 1].toFixed(2);
  return {
    elapsedMs: Math.round(elapsedMs), trustedEvents: events, intervals: intervals.length,
    medianMs: quantile(.5), p95Ms: quantile(.95), maxMs: quantile(1),
    over16_67Ms: intervals.filter(ms => ms > budget).length,
    // Normal 60 Hz timestamps can alternate between 16.6 and 16.7 ms.
    over25Ms: intervals.filter(ms => ms > 1.5 * budget).length,
  };
}

async function presentationFeedback(client, names) {
  const complete = new Promise(resolve => {
    function onMessage(_event, method, params) {
      if (method !== 'Tracing.tracingComplete') return;
      client.off('message', onMessage);
      resolve(params);
    }
    client.on('message', onMessage);
  });
  await client.sendCommand('Tracing.end');
  const { stream, dataLossOccurred } = await complete;
  assert.ok(!dataLossOccurred, '呈现追踪缓冲区溢出');
  let json = '';
  for (;;) {
    const chunk = await client.sendCommand('IO.read', { handle: stream });
    json += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
    if (chunk.eof) break;
  }
  await client.sendCommand('IO.close', { handle: stream });
  const events = JSON.parse(json).traceEvents;
  const shown = events.filter(e => e.name === 'Display::FrameDisplayed' && e.ph === 'I');
  const streams = new Set(shown.map(e => e.pid + '/' + e.tid));
  assert.ok(streams.size <= 1, '存在多个 Viz 显示线程，无法唯一归属窗口');
  for (const name of names) {
    const mark = suffix => events.find(e => e.name === 'jj-frame-' + name + suffix)?.ts;
    const begin = mark('-start'), end = mark('-end');
    assert.ok(begin < end, '缺少场景时间标记 ' + name);
    const times = shown.filter(e => e.ts >= begin && e.ts <= end).map(e => e.ts);
    const timestamps = [...new Set(times)].sort((a, b) => a-b).map(t => t / 1000);
    // Idle surfaces need no new presents. Long gaps also include time with no damage/input.
    const result = timestamps.length >= 2 ? summarize({ timestamps, elapsedMs: (end - begin) / 1000 }) : null;
    console.log(name + ' Viz.Display::FrameDisplayed ' + JSON.stringify({ feedbackEvents: times.length, distinctTimes: timestamps.length, result }));
  }
}

async function run() {
  const sourceSha256 = sourceFingerprint();
  const win = await launchDesktop({ show: true, dataDirectory: profile, checkOnStartup: false,
    dialogs: { async showOpenDialog() { return { canceled: false, filePaths: [project] }; } },
  });
  const wc = win.webContents;
  const read = code => wc.executeJavaScript(code, true);
  const send = (type, point, fields) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, ...fields });
  const mouseDown = p => send('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
  const mouseUp = p => send('mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 });
  const mouseMove = p => send('mouseMoved', p, { button: 'left', buttons: 1 });
  const selector = s => 'document.querySelector(' + JSON.stringify(s) + ')';
  const size = (s, key) => read(selector(s) + '.getBoundingClientRect().' + key);
  async function waitFor(expression) {
    const until = Date.now() + 20000;
    while (!await read(expression)) {
      if (Date.now() > until) throw Error('等候超时 ' + expression);
      await delay(40);
    }
  }
  async function point(s, portion = .5) {
    return read(`(() => {
      const el = ${selector(s)}, r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width * ${portion}), y = Math.round(r.top + r.height / 2);
      if (!el.contains(document.elementFromPoint(x,y))) throw Error('基准控件未命中 ' + el.className);
      return { x, y };
    })()`);
  }

  // Timestamp collection happens inside the renderer, independently of input dispatch.
  // An interval measures renderer rAF scheduling. It cannot confirm a Windows display present.
  const results = {};
  async function sample(name, gesture, eventType = 'pointermove') {
    await read(`new Promise(resolve => {
      const timestamps = [], type = ${JSON.stringify(eventType)};
      let events = 0, id;
      const onInput = e => { if (e.isTrusted) events++; };
      window.addEventListener(type, onInput, {capture:true, passive:true});
      const tick = time => {
        timestamps.push(time); id = requestAnimationFrame(tick);
        if (timestamps.length === 1) { performance.mark(${JSON.stringify('jj-frame-' + name + '-start')}); resolve(true); }
      };
      id = requestAnimationFrame(tick);
      window.finishSample = () => new Promise(done => requestAnimationFrame(() => {
        cancelAnimationFrame(id);
        window.removeEventListener(type, onInput, true);
        performance.mark(${JSON.stringify('jj-frame-' + name + '-end')});
        done({timestamps, events, elapsedMs: timestamps.at(-1) - timestamps[0]});
      }));
    })`);
    await gesture();
    const recorded = await read('window.finishSample()');
    if (name !== 'idle') assert.ok(recorded.events >= 10, name + ' 实际收到的输入不足 ' + recorded.events);
    const result = summarize(recorded);
    results[name] = result;
    console.log(name + ' ' + JSON.stringify(result));
  }

  // Drive input independently of both rAF and slow renderer acknowledgements. Bound the
  // queue so an unresponsive renderer cannot accumulate seconds of synthetic input.
  async function sweep(sendAt, spacing = 8) {
    const start = performance.now();
    const pending = new Set();
    let failed;
    for (;;) {
      const elapsed = performance.now() - start;
      if (elapsed >= durationMs || failed) break;
      if (pending.size < 8) {
        const call = sendAt(elapsed / durationMs).catch(error => { failed = error; })
          .finally(() => pending.delete(call));
        pending.add(call);
      }
      await delay(spacing);
    }
    await Promise.all(pending);
    if (failed) throw failed;
    await sendAt(1);
  }
  const wave = t => (1 - Math.cos(3 * Math.PI * t)) / 2;
  const between = (a, b, t) => ({ x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t });
  async function drag(start, end, verify) {
    await mouseDown(start);
    await sweep(t => mouseMove(between(start, end, wave(t))));
    await verify();
    await mouseUp(end);
  }

  try {
    await makeProject();
    const display = screen.getDisplayMatching(win.getBounds());
    win.setContentSize(Math.min(1400, display.workAreaSize.width - 24), Math.min(900, display.workAreaSize.height - 60));
    win.center();
    win.show();
    win.focus();
    wc.debugger.attach();
    await clickVisible(wc, '#home-open-project');
    await waitFor('document.querySelectorAll(".sequence-video .sequence-block[data-selectable]").length === 72');
    await read(selector('#timeline-fit') + '.click()');
    await delay(700);
    const displayNow = screen.getDisplayMatching(win.getBounds());
    const gpuInfo = await app.getGPUInfo('basic');
    const info = {
      appVersion: require('../package.json').version, electron: process.versions.electron,
      platform: os.release(), cpu: os.cpus()[0]?.model, refreshHz: displayNow.displayFrequency,
      scaleFactor: displayNow.scaleFactor, windowDip: win.getContentSize(), gpu: app.getGPUFeatureStatus().gpu_compositing,
      adapters: gpuInfo.gpuDevice?.map(({ active, vendorId, deviceId }) => ({ active, vendorId, deviceId })),
      tracks: await read('document.querySelectorAll(".sequence-row").length'),
      shots: 24, candidateClips: 72, durationMs, metric: 'renderer requestAnimationFrame timestamps',
      sourceSha256, driverSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    };
    console.log('environment ' + JSON.stringify(info));
    const trace = process.argv.includes('--presentation');
    if (trace) await wc.debugger.sendCommand('Tracing.start', {
      categories: 'blink.user_timing,disabled-by-default-display.framedisplayed', transferMode: 'ReturnAsStream',
    });
    await sample('idle', () => delay(durationMs));

    const cell = (shot, lane) => '.sequence-block[data-drop-shot="' + shot + '"][data-candidate-index="' + lane + '"]';
    const source = cell(2, 0), target = cell(9, 1);
    const before = await read(selector(source) + '.title');
    const from = await point(source), to = await point(target);
    await sample('candidateDrag', () => drag(from, to, () => waitFor('!!document.querySelector(".candidate-moving")')));
    await waitFor(selector(target) + '.title === ' + JSON.stringify(before));

    const ruler = '.sequence-ruler .sequence-content';
    const start = await point(ruler, .12), end = await point(ruler, .76);
    const cursor = '.sequence-cursor';
    const oldPosition = await size(cursor, 'left');
    await sample('playheadScrub', () => drag(start, end, async () => {
      assert.ok(Math.abs(await size(cursor, 'left') - oldPosition) > 50, '播放头应跟随指针');
    }));

    const seam = await point('[data-split="materials"]');
    const width = await size('#materials-pane', 'width');
    await sample('panelResize', () => drag(seam, { x: seam.x + 75, y: seam.y }, async () => {
      assert.ok(Math.abs(await size('#materials-pane', 'width') - width) > 24, '素材面板应改变宽度');
    }));

    const wheelPoint = await point('#timeline-clock', .5);
    const zoom = () => read(selector('#track-zoom') + '.valueAsNumber');
    const initialZoom = await zoom();
    let peakZoom = initialZoom;
    await sample('timelineZoom', () => sweep(async t => {
      await send('mouseWheel', wheelPoint, { modifiers: 2, deltaX: 0, deltaY: Math.floor(t * 9) % 2 ? 80 : -80 });
      if (t < .12) peakZoom = Math.max(peakZoom, await zoom());
    }, 40), 'wheel');
    assert.ok(peakZoom > initialZoom, '滚轮应确实放大工程时间线');
    if (trace) await presentationFeedback(wc.debugger, Object.keys(results));
    assert.equal(sourceFingerprint(), sourceSha256, '采样期间源码有改动，请重跑以便比较同一版本');
    console.log('rAF measures renderer scheduling. --presentation adds Chromium Viz presentation feedback. Physical scanout is unmeasured.');
    console.log('over16_67Ms includes timestamp rounding; over25Ms counts larger stalls.');
    if (process.argv.includes('--strict')) {
      assert.ok(Object.values(results).every(result => result.over25Ms === 0 && result.p95Ms <= 16.8),
        '代表用例的 rAF 门槛未通过 (p95 <= 16.8 ms，且没有 >25 ms 间隔)');
    }
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    if (!win.isDestroyed()) win.destroy();
  }
}

const watchdog = setTimeout(() => { console.error('基准超时，检查可见窗口和显示刷新'); app.exit(1); }, 120000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => { console.error(error); app.exit(1); });

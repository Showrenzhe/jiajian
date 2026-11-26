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
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, screen } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { fixtures, ffmpeg } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');

const large = process.argv.includes('--large');
const paired = process.argv.includes('--paired');
assert.ok(!paired || large, '--paired 需要 --large');
const durationMs = paired ? 14400 : 2000;
let activeScene = 'setup';
let completedInputs = 0;
const shotsCount = large ? 200 : 24;
const laneCount = large ? 5 : 3;
const budget = 1000 / 60;
const root = process.env.JIAJIAN_FRAME_BENCH_ROOT;
assert.ok(root, '请从 npm run bench:frames 或 node test/run-interaction-frames.cjs 启动');
const project = path.join(root, '基准.sdworkbench');
const batchProject = path.join(root, '批量基准.sdworkbench');
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
  const shots = Array.from({ length: shotsCount }, (_, index) => Array.from({length:laneCount},(_,lane) =>
    ({ id: ids[(index + lane) % ids.length], start: 0, end: 1, videoLane: lane })));
  // The two crossed slots otherwise both contain blue. Keep the same gesture
  // geometry and use red at its destination to verify both ends of the swap.
  if (paired) shots[4][1].id = 'red';
  const config = {
    shots, ratio: '16:9', resolution: 720, fps: 30, fit: 'fit', keepAudio: true,
    priority: 'picture', unordered: false, useOriginal: true, useMirrors: false, count: 1,
    musicIds: ['music'], musicVolume: 50, narrationMode: 'segmented',
    segmentNarrationIds: shots.map(() => ['music']),
    timelineCaptions: { name: '字幕', cues: shots.map((_, i) => ({ start: i * 1000, end: i * 1000 + 800, text: String(i + 1) })) },
  };
  if (large) {
    const longVoice = path.join(root,'整段口播.wav');
    await ffmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=200','-c:a','pcm_s16le',longVoice]);
    catalog.set('voice', await inspectAsset(longVoice,'audio'));
    delete config.segmentNarrationIds;
    Object.assign(config,{narrationMode:'whole',narrationId:'voice'});
    await saveProject(batchProject, {...config,shots:shots.slice(0,5),count:1000,narrationId:null,timelineCaptions:null}, catalog);
  }
  await saveProject(project,config,catalog);
}

function summarize({ timestamps, events, elapsedMs }) {
  const raw = timestamps.slice(1).map((time, i) => time - timestamps[i]);
  const intervals = [...raw].sort((a, b) => a - b);
  assert.ok(intervals.length, '没有采到 rAF 帧间隔');
  const quantile = q => +intervals[Math.ceil(q * intervals.length) - 1].toFixed(2);
  return {
    elapsedMs: Math.round(elapsedMs), trustedEvents: events, intervals: intervals.length,
    medianMs: quantile(.5), p95Ms: quantile(.95), maxMs: quantile(1),
    over16_67Ms: intervals.filter(ms => ms > budget).length,
    // Normal 60 Hz timestamps can alternate between 16.6 and 16.7 ms.
    over25Ms: intervals.filter(ms => ms > 1.5 * budget).length,
    ...(paired && { frameIntervalsMs: raw }),
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
  let chosenProject = project;
  const win = await launchDesktop({ show: true, dataDirectory: profile, checkOnStartup: false,
    dialogs: { async showOpenDialog() { return { canceled: false, filePaths: [chosenProject] }; } },
  });
  const wc = win.webContents;
  const read = code => wc.executeJavaScript(code, true);
  let actions;
  let actionStart;
  function send(type, point, fields) {
    const input = { type, ...point, ...fields };
    if (!actions) return wc.debugger.sendCommand('Input.dispatchMouseEvent', input);
    const atMs = performance.now() - actionStart;
    return wc.debugger.sendCommand('Input.dispatchMouseEvent', input).then(() => {
      actions.push({ atMs, ...input });
      completedInputs++;
    });
  }
  const mouseDown = p => send('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
  const mouseUp = p => send('mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 });
  const mouseMove = p => send('mouseMoved', p, { button: 'left', buttons: 1 });
  const selector = s => 'document.querySelector(' + JSON.stringify(s) + ')';
  const size = (s, key) => read(selector(s) + '.getBoundingClientRect().' + key);
  async function waitFor(expression) {
    const until = Date.now() + (large ? 90000 : 20000);
    while (!await read(expression)) {
      if (Date.now() > until) throw Error('等候超时 ' + expression);
      await delay(40);
    }
  }
  async function point(s, portion = .5) {
    const point = await read(`(() => {
      const el = ${selector(s)}, r = el.getBoundingClientRect();
      let left = Math.max(r.left, 0), top = Math.max(r.top, 0);
      let right = Math.min(r.right, document.documentElement.clientWidth);
      let bottom = Math.min(r.bottom, document.documentElement.clientHeight);
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, rect.left + parent.clientLeft);
          right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, rect.top + parent.clientTop);
          bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
        }
      }
      const visible = {left, top, right, bottom};
      if (right <= left || bottom <= top) return {matched:false, visible, bounds:r.toJSON()};
      const x = Math.floor(left + (right - left) * ${portion}), y = Math.floor((top + bottom) / 2);
      const hit = document.elementFromPoint(x,y);
      return {x,y,matched:el.contains(hit),hit:hit?.className,visible,bounds:r.toJSON()};
    })()`);
    assert.ok(point.matched, '基准控件未命中 ' + s + ' ' + JSON.stringify(point));
    return {x:point.x,y:point.y};
  }

  // Timestamp collection happens inside the renderer, independently of input dispatch.
  // An interval measures renderer rAF scheduling. It cannot confirm a Windows display present.
  const results = {};
  let batchPreview;
  // Observe the same native controls and resulting DOM in both application versions.
  async function timeBatchUpdate(id, eventName, expectedIndex, trigger) {
    await read(`(() => {
      const control=document.getElementById(${JSON.stringify(id)});
      const list=document.querySelector('#preview-batch-list');
      const summary=document.querySelector('#preview-batch-summary');
      const expected=${JSON.stringify(expectedIndex)};
      window.batchUpdateTiming=new Promise((resolve,reject)=>{
        let start, matched=false;
        const observer=new MutationObserver(check);
        const timer=setTimeout(()=>{
          observer.disconnect();
          reject(Error('批量列表没有响应 '+control.id+'='+control.value+'；事件起点 '+start+'；'+summary.textContent));
        },15000);
        function check() {
          if(start===undefined || matched) return;
          const rows=list.querySelectorAll('.batch-entry');
          const count=expected===null ? 1000 : 1;
          if(!list.checkVisibility() || !summary.textContent.endsWith('当前显示 '+count+' 条') ||
             !rows.length || (expected===null ? rows[0].dataset.index!=='0' :
               rows.length!==1 || rows[0].dataset.index!==String(expected))) return;
          matched=true;
          observer.disconnect();
          const updated=performance.now();
          // The second rAF follows a rendering opportunity for the verified rows.
          if(expected===null) requestAnimationFrame(()=>requestAnimationFrame(()=>done(performance.now())));
          else done(updated);
        }
        function done(end) {clearTimeout(timer);resolve(Number((end-start).toFixed(2)));}
        control.addEventListener(${JSON.stringify(eventName)},event=>{
          if(!event.isTrusted) return;
          start=event.timeStamp;
          observer.observe(list,{childList:true,subtree:true,characterData:true});
          observer.observe(summary,{childList:true,subtree:true,characterData:true});
        },{once:true,capture:true});
      });
    })()`);
    await trigger();
    return read('window.batchUpdateTiming');
  }
  async function sample(name, gesture, eventType = 'pointermove') {
    activeScene = name;
    completedInputs = 0;
    await read(`new Promise(resolve => {
      const timestamps = [], type = ${JSON.stringify(eventType)};
      let events = 0, id;
      const received = [];
      const types = ${paired} ? ['pointerdown','pointermove','pointerup','wheel'] : [type];
      const onInput = e => {
        if (!e.isTrusted) return;
        if (e.type === type) events++;
        if (${paired}) received.push({type:e.type, atMs:e.timeStamp - timestamps[0], x:e.clientX, y:e.clientY,
          ...(e.type === 'wheel' && {deltaX:e.deltaX, deltaY:e.deltaY})});
      };
      for (const t of types) window.addEventListener(t, onInput, {capture:true, passive:true});
      const tick = time => {
        timestamps.push(time); id = requestAnimationFrame(tick);
        if (timestamps.length === 1) { performance.mark(${JSON.stringify('jj-frame-' + name + '-start')}); resolve(true); }
      };
      id = requestAnimationFrame(tick);
      window.finishSample = () => new Promise(done => requestAnimationFrame(() => {
        cancelAnimationFrame(id);
        for (const t of types) window.removeEventListener(t, onInput, true);
        performance.mark(${JSON.stringify('jj-frame-' + name + '-end')});
        done({timestamps, events, elapsedMs: timestamps.at(-1) - timestamps[0], ...(${paired} && {received})});
      }));
    })`);
    if (paired) {
      actions = [];
      actionStart = performance.now();
    }
    await gesture();
    const recorded = await read('window.finishSample()');
    if (name !== 'idle') assert.ok(recorded.events >= (large ? 1 : 10), name + ' 实际收到的输入不足 ' + recorded.events);
    const result = summarize(recorded);
    if (paired) Object.assign(result, { actions, dispatchedInputs: actions.length, receivedInputs: recorded.received });
    actions = undefined;
    results[name] = result;
    console.log(name + ' ' + JSON.stringify(result, (key,value) =>
      ['actions','receivedInputs','frameIntervalsMs'].includes(key) ? undefined : value));
    activeScene = 'between scenes, after ' + name;
  }

  // Each checkout receives the same number, order and coordinates of inputs.
  // Wait for the previous acknowledgement, never drop a step or catch up in a burst.
  // The last step ends the gesture immediately; slow work extends the active span.
  async function fixedSteps(count, visit) {
    const spacing = durationMs / (count - 1);
    let next = performance.now();
    for (let index = 0; index < count; index++) {
      const wait = next - performance.now();
      if (wait > 0) await delay(wait);
      next = performance.now() + spacing;
      await visit(index, index / (count - 1));
    }
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
    if (paired) {
      await fixedSteps(240, (_index,t) => mouseMove(between(start, end, (1 - Math.cos(9 * Math.PI * t)) / 2)));
    } else {
      await sweep(t => mouseMove(between(start, end, wave(t))));
    }
    await verify();
    await mouseUp(end);
  }

  try {
    await makeProject();
    const display = screen.getDisplayMatching(win.getBounds());
    const [widthLimit, heightLimit] = process.argv.includes('--compact') ? [1000, 660] : [1400, 900];
    win.setContentSize(Math.min(widthLimit, display.workAreaSize.width - 24), Math.min(heightLimit, display.workAreaSize.height - 60));
    win.center();
    win.show();
    win.focus();
    wc.debugger.attach();
    await clickVisible(wc, '#home-open-project');
    await waitFor('document.querySelectorAll(".sequence-video .sequence-block[data-selectable]").length >= 3');
    if (!large) await read(selector('#timeline-fit') + '.click()');
    await delay(700);
    const displayNow = screen.getDisplayMatching(win.getBounds());
    const gpuInfo = await app.getGPUInfo('basic');
    const info = {
      appVersion: require('../package.json').version, electron: process.versions.electron,
      platform: os.release(), cpu: os.cpus()[0]?.model, refreshHz: displayNow.displayFrequency,
      scaleFactor: displayNow.scaleFactor, windowDip: win.getContentSize(), gpu: app.getGPUFeatureStatus().gpu_compositing,
      adapters: gpuInfo.gpuDevice?.map(({ active, vendorId, deviceId }) => ({ active, vendorId, deviceId })),
      tracks: await read('document.querySelectorAll(".sequence-row").length'),
      shots: shotsCount, candidateClips: shotsCount*laneCount, videoLanes:laneCount, narrationSeconds: large ? 200 : 0.4,
      durationMs, metric: 'renderer requestAnimationFrame timestamps',
      ...(paired && { samplingProtocol: 'paired-v1' }),
      sourceSha256, driverSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    };
    console.log('environment ' + JSON.stringify(info));
    const trace = process.argv.includes('--presentation');
    if (trace) await wc.debugger.sendCommand('Tracing.start', {
      categories: 'blink.user_timing,disabled-by-default-display.framedisplayed', transferMode: 'ReturnAsStream',
    });
    await sample('idle', () => delay(durationMs));

    const cell = (shot, lane) => '.sequence-block[data-drop-shot="' + shot + '"][data-candidate-index="' + lane + '"]';
    const source = cell(2, 0), target = cell(large ? 4 : 9, 1);
    const before = await read(selector(source) + '.title');
    const clipSource = slot => selector(slot) + '.dataset.clipSource';
    let originalIds;
    if (paired) {
      originalIds = await read('[' + clipSource(source) + ',' + clipSource(target) + ']');
      assert.ok(originalIds.every(Boolean) && originalIds[0] !== originalIds[1], '拖前两格必须能区分素材');
    }
    const from = await point(source), to = await point(target);
    await sample('candidateDrag', () => drag(from, to, () => waitFor('!!document.querySelector(".candidate-moving")')));
    if (paired) {
      await waitFor(clipSource(target) + ' === ' + JSON.stringify(originalIds[0]) + ' && '
        + clipSource(source) + ' === ' + JSON.stringify(originalIds[1]));
      results.candidateDrag.swapped = true;
    } else {
      await waitFor(selector(target) + '.title === ' + JSON.stringify(before));
    }
    const ruler = '.sequence-ruler .sequence-content';
    if (large) {
      await read(selector('#timeline-fit') + '.click()');
      await waitFor(selector(ruler) + '.clientWidth <= '+selector('#timeline-clock')+'.clientWidth');
    }
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
    if (paired) {
      assert.ok(initialZoom + 2 <= await read('Number(' + selector('#track-zoom') + '.max)'), '缩放需要两个可用档位');
      let expected = initialZoom;
      await sample('timelineZoom', () => fixedSteps(96, async index => {
        const direction = index % 4 < 2 ? 1 : -1;
        expected += direction;
        await send('mouseWheel', wheelPoint, { modifiers: 2, deltaX: 0, deltaY: -80 * direction });
        // Acknowledge the application-level result as well as input dispatch. In
        // particular, opposite notches must not cancel inside a single paint.
        await waitFor(selector('#track-zoom') + '.valueAsNumber === ' + expected);
        peakZoom = Math.max(peakZoom, expected);
      }), 'wheel');
      assert.equal(await zoom(), initialZoom, '连续缩放后应回到初始档位');
    } else {
      await sample('timelineZoom', () => sweep(async t => {
        await send('mouseWheel', wheelPoint, { modifiers: 2, deltaX: 0, deltaY: Math.floor(t * 9) % 2 ? 80 : -80 });
        if (t < .12) peakZoom = Math.max(peakZoom, await zoom());
      }, 40), 'wheel');
    }
    assert.ok(peakZoom > initialZoom, '滚轮应确实放大工程时间线');
    if (large) {
      chosenProject = batchProject;
      await clickVisible(wc,'#open-project');
      await waitFor('document.querySelector("#count").value === "1000" && !document.querySelector("#prepare-preview").disabled');
      await clickVisible(wc,'#inspector-tab-montage');
      const started = performance.now();
      await clickVisible(wc,'#prepare-preview');
      await waitFor('document.querySelector("#preview-batch").checkVisibility() && document.querySelector("#preview-batch-summary").textContent.includes("1000")');
      info.batchRows = 1000;
      info.batchReadyMs = Math.round(performance.now()-started);
      assert.ok(await read("document.querySelector('#batch-reuse-filter').value==='low' && !document.querySelector('#preview-batch-summary').textContent.endsWith('当前显示 1000 条')"), '首次显示全部 1000 条之前应仍在默认筛选');
      const key = async (name, code) => {
        for(const type of ['rawKeyDown','keyUp']) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:code});
        }
      };
      await clickVisible(wc,'#batch-reuse-filter');
      await waitFor("document.querySelector('#batch-reuse-filter').matches(':open')");
      const firstRenderMs = await timeBatchUpdate('batch-reuse-filter','change',null,()=>
        clickVisible(wc,'#batch-reuse-filter option[value=all]'));
      info.batchListRenderMs = firstRenderMs;
      batchPreview = {firstRenderMs, filterInputMs:[]};
      const list = '#preview-batch-list';
      await read(selector(list) + '.scrollIntoView({block:"center"})');
      const listPoint = await point(list);
      if (paired) {
        const position = selector(list) + '.scrollTop';
        const scrollTurns = [{ afterWheel: 0, scrollTop: await read(position) }];
        await sample('batchScroll', () => fixedSteps(240, async index => {
          const phase = index % 48;
          const direction = phase < 32 ? 1 : -1;
          await send('mouseWheel', listPoint, { deltaX:0, deltaY:120 * direction });
          if (phase !== 31 && phase !== 47) return;
          const previous = scrollTurns.at(-1).scrollTop;
          // Wheel dispatch and application scrolling are asynchronous. Verify real
          // travel in each of the ten legs, and reject gestures clipped at an edge.
          await waitFor('(' + position + ' - ' + previous + ') * ' + direction + ' > 500');
          const top = await read(position);
          const limit = await read(selector(list) + '.scrollHeight - ' + selector(list) + '.clientHeight');
          assert.ok(top > 0 && top < limit, '批量列表滚动到边界 ' + top + '/' + limit);
          scrollTurns.push({ afterWheel:index + 1, scrollTop:top });
        }), 'wheel');
        results.batchScroll.scrollTurns = scrollTurns;
      } else {
        await sample('batchScroll', () => sweep(() => send('mouseWheel',listPoint,{deltaX:0,deltaY:120}),30),'wheel');
      }
      assert.ok(await read(selector(list) + '.scrollTop') > 500, '列表须响应真实滚轮');
      const rendered = await read(selector(list) + '.querySelectorAll(".batch-entry").length');
      assert.ok(rendered > 0 && rendered < 35, '只挂载视口附近的预览行');
      await read('const sort=document.querySelector("#batch-sort"); sort.value="reuse"; sort.dispatchEvent(new Event("change"));');
      const percentages=await read('Array.from(document.querySelectorAll("#preview-batch-list .batch-reuse"),el=>Number(el.textContent.match(/(\\d+)%/)[1]))');
      assert.deepEqual(percentages,[...percentages].sort((a,b)=>a-b),'重复度升序须反映在可见行');
      await clickVisible(wc,'#batch-search');
      for(const number of [123,321,555,777,999]) {
        if(batchPreview.filterInputMs.length) {
          await read("document.querySelector('#batch-search').select()");
          await key('Backspace',8);
        }
        await waitFor("document.querySelector('#preview-batch-summary').textContent.endsWith('当前显示 1000 条')");
        const ms = await timeBatchUpdate('batch-search','input',number-1,()=>
          wc.debugger.sendCommand('Input.insertText',{text:'第 '+number+' 条'}));
        batchPreview.filterInputMs.push(ms);
      }
      assert.equal(await read(selector(list) + '.querySelector(".batch-title").textContent'), '第 999 条');
      await clickVisible(wc,'#select-all-previews');
      await clickVisible(wc,'#invert-preview-selection');
      assert.equal(await read(selector(list) + '.querySelector(".batch-select").checked'),false);
    }
    if (trace) await presentationFeedback(wc.debugger, Object.keys(results));
    assert.equal(sourceFingerprint(), sourceSha256, '采样期间源码有改动，请重跑以便比较同一版本');
    const report = path.resolve(process.env.JIAJIAN_BENCH_REPORT || ('run-data/benchmarks/'+(large?'large':'standard')+'.json'));
    mkdirSync(path.dirname(report),{recursive:true});
    writeFileSync(report,JSON.stringify({environment:info,results,batchPreview},null,2)+'\n');
    console.log('JSON',report);
    console.log('rAF measures renderer scheduling. --presentation adds Chromium Viz presentation feedback. Physical scanout is unmeasured.');
    console.log('over16_67Ms includes timestamp rounding; over25Ms counts larger stalls.');
    if(batchPreview) {
      console.log('batchPreview',JSON.stringify(batchPreview));
      if(!paired) assert.ok(results.batchScroll.p95Ms <= 25.05,'1000 条列表滚动 P95 超过 25.05 ms');
    }
    if (process.argv.includes('--strict')) {
      assert.ok(Object.values(results).every(result => result.over25Ms === 0 && result.p95Ms <= 16.8),
        '代表用例的 rAF 门槛未通过 (p95 <= 16.8 ms，且没有 >25 ms 间隔)');
    }
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    if (!win.isDestroyed()) win.destroy();
  }
}

const watchdog = setTimeout(() => {
  console.error('基准超时，检查可见窗口和显示刷新', { scene: activeScene, completedInputs });
  app.exit(1);
}, paired ? 600000 : large ? 300000 : 120000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => { console.error(error); app.exit(1); });

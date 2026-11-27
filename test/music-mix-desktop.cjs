'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeTheme } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject, loadProject } = require('../src/project-format.cjs');
const { ffmpeg } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function run(root) {
  app.setPath('userData', path.join(root, 'electron'));
  // Music and voice occupy separate stereo channels, so decoded music RMS
  // can be measured while the actual narration is audible.
  const catalog = new Map();
  for (const [id, source] of [
    ['picture', 'color=c=steelblue:s=320x180:r=30:d=3'],
    ['music', 'aevalsrc=0.16*cos(2*PI*100*t)|0:s=48000:d=0.805'],
    ['long', 'aevalsrc=0.08*sin(2*PI*240*t)|0:s=48000:d=4.52'],
    ['voice', 'aevalsrc=0|0.16*sin(2*PI*320*t):s=48000:d=1.02'],
  ]) {
    const video = id === 'picture',
      file = path.join(root, id + (video ? '.mp4' : '.wav'));
    await ffmpeg(['-f', 'lavfi', '-i', source, ...(video ? ['-c:v', 'libx264', '-threads', '1'] : []), file]);
    catalog.set(id, await inspectAsset(file, video ? 'video' : 'audio'));
  }
  const old = path.join(root, '旧混音.sdworkbench'),
    saved = path.join(root, '调整后.jiajian');
  const config = {
    ratio: '16:9',
    resolution: 720,
    fps: 30,
    fit: 'fit',
    keepAudio: false,
    count: 1,
    unordered: false,
    useOriginal: true,
    useMirrors: false,
    shots: [[{ id: 'picture', start: 0, end: 3 }]],
    musicIds: ['music'],
    musicVolume: 75,
    narrationId: 'voice',
  };
  await saveProject(old, config, catalog);
  const doc = JSON.parse(await fs.readFile(old, 'utf8'));
  doc.version = 5;
  delete doc.config.musicMix;
  await fs.writeFile(old, JSON.stringify(doc));
  const output = path.join(root, 'exports');
  await fs.mkdir(output);
  const longer = path.join(root, '流式配乐.jiajian');
  await saveProject(
    longer,
    { ...config, musicIds: ['long'], musicSpeeds: [2], musicMix: { mode: 'smart', compensateManual: true } },
    catalog,
  );
  const open = [old, saved, saved, longer];
  const win = await launchDesktop({
    show: false,
    dataDirectory: path.join(root, 'profile'),
    dialogs: {
      async showOpenDialog(_win, { title }) {
        if (title === '选择导出目录') return { canceled: false, filePaths: [output] };
        assert.equal(title, '打开工程');
        return { canceled: false, filePaths: [open.shift()] };
      },
      async showSaveDialog() {
        return { canceled: false, filePath: saved };
      },
    },
  });
  win.setContentSize(1366, 768);
  win.show();
  win.focus();
  const wc = win.webContents;
  wc.on('console-message', ({ level, message }) => {
    if (level === 'error') console.error(message);
  });
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = (expr) => wc.executeJavaScript(expr, true),
    q = (s) => 'document.querySelector(' + JSON.stringify(s) + ')';
  const field = (key) => '[data-mix-field="' + key + '"]';
  async function wait(expr) {
    for (const deadline = Date.now() + 25000; Date.now() < deadline;) {
      if (await read(expr)) return;
      await delay(35);
    }
    throw Error('等待超时 ' + expr + ' / ' + (await read(q('#notice') + '.textContent')));
  }
  async function click(selector) {
    for (const deadline = Date.now() + 5000; ;) {
      try {
        await clickVisible(wc, selector);
        return;
      } catch (error) {
        if (Date.now() >= deadline || !error.message.startsWith('无法点击可见的控件')) throw error;
        await delay(50);
      }
    }
  }
  async function key(name, code, virtualKey, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp'])
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key: name,
        code,
        windowsVirtualKeyCode: virtualKey,
        modifiers,
      });
  }
  async function changeMode() {
    await click(field('mode'));
    await key('ArrowUp', 'ArrowUp', 38);
    await key('Enter', 'Enter', 13);
    await wait(q(field('mode')) + '.value==="smart"');
  }
  await click('#home-open-project');
  await wait(q('#inspector-tab-music') + '?.checkVisibility()');
  if (await read(q('#editing-tour button') + '?.checkVisibility()')) await click('#editing-tour button');
  await click('#inspector-tab-music');
  assert.equal(await read(q(field('mode')) + '.value'), 'legacy');
  await changeMode();
  await click('#track-undo');
  await wait(q(field('mode')) + '.value==="legacy"');
  await click('#track-redo');
  await wait(q(field('mode')) + '.value==="smart"');
  await click(field('duckDb'));
  await key('a', 'KeyA', 65, 2);
  await wc.debugger.sendCommand('Input.insertText', { text: '12' });
  await key('Tab', 'Tab', 9);
  assert.equal(await read('montageConfig().musicMix.duckDb'), 12);
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await wait(
      'document.documentElement.dataset.theme===' +
        JSON.stringify(theme) +
        ' && !document.documentElement.hasAttribute("data-theme-changing")',
    );
    await read(q('#music-mix-settings') + '.scrollIntoView({block:"start",behavior:"instant"})');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const layout = await read(
      '({width:innerWidth,scroll:document.documentElement.scrollWidth,field:' +
        q(field('crossfadeMs')) +
        '.getBoundingClientRect().toJSON()})',
    );
    assert.equal(layout.width, layout.scroll);
    assert.ok(
      layout.field.x >= 0 && layout.field.right <= layout.width && layout.field.top >= 0 && layout.field.bottom <= 768,
    );
    if (process.env.JIAJIAN_MUSIC_EVIDENCE) {
      await fs.mkdir(process.env.JIAJIAN_MUSIC_EVIDENCE, { recursive: true });
      const image = await win.capturePage();
      assert.deepEqual(image.getSize(), { width: 1366, height: 768 });
      await fs.writeFile(path.join(process.env.JIAJIAN_MUSIC_EVIDENCE, '1366x768-' + theme + '.png'), image.toPNG());
    }
  }
  await click(field('normalizeLufs'));
  await key('End', 'End', 35);
  await key('Enter', 'Enter', 13);
  await wait('montageConfig().musicMix.normalizeLufs===-16');
  await click('#save-project');
  await wait(q('#notice') + '.textContent.includes("工程已保存")');
  assert.equal((await loadProject(saved)).config.musicMix.duckDb, 12);
  await click('#open-project');
  await wait(q('#notice') + '.textContent.includes("已打开工程")');
  assert.equal(await read('montageConfig().musicMix.duckDb'), 12);
  // Tap the real Web Audio bus before the device and retain its loop source.
  await read(`(()=>{
    const mix=playerTools.musicBus.output(), ctx=mix.context;
    const makeSource=ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource=()=>{const s=makeSource();window.testMusicSource=s;return s;};
    const tap=ctx.createScriptProcessor(1024,2,1);
    window.mixSamples=[];window.mixTap=tap;mix.connect(tap);tap.connect(ctx.destination);
    tap.onaudioprocess=e=>{
      const s=timeline.draftState(),audio=e.inputBuffer.getChannelData(0);let sum=0;
      for(const value of audio)sum+=value*value;
      if(s?.playing) window.mixSamples.push([s.time,Math.sqrt(sum/audio.length)]);
    };
  })()`);
  await click('#timeline-play');
  await wait('timeline.draftState()?.time>2.62');
  const samples = await read('window.mixSamples.slice()');
  function peakRms(from, to) {
    const values = samples.filter(([time]) => time > from && time < to).map((point) => point[1]);
    assert.ok(values.length >= 3);
    return Math.max(...values);
  }
  const reduction = 20 * Math.log10(peakRms(0.25, 0.58) / peakRms(1.6, 2.55));
  assert.ok(Math.abs(reduction + 12) < 0.5, '实时配乐应降低 12 dB，实测 ' + reduction);
  // The desktop sound device can drop 128-sample quanta. Inspect the actual
  // transport buffer and loop points on an uninterrupted Web Audio clock.
  const jump = await read(`(async()=>{
    const audition=window.testMusicSource, ctx=new OfflineAudioContext(2,3*48000,48000), s=ctx.createBufferSource();
    s.buffer=audition.buffer;s.loop=audition.loop;s.loopStart=audition.loopStart;s.loopEnd=audition.loopEnd;
    s.connect(ctx.destination);s.start();const data=(await ctx.startRendering()).getChannelData(0);
    let peak=0;for(let i=1;i<data.length;i++)peak=Math.max(peak,Math.abs(data[i]-data[i-1]));return peak;
  })()`);
  assert.ok(jump < 0.01, '实时播放器循环样本差超限 ' + jump);
  await wait('!timeline.isDraftPlaying()');
  await read('mixTap.disconnect();mixTap.onaudioprocess=null');
  await click('#inspector-tab-music');
  await click('#listen-music-mix');
  await wait(q('#preview-name') + '.textContent==="混剪预览 1" && ' + q('#preview') + '.readyState>=2');
  const preview = path.join(root, 'preview.mp4');
  const response = await wc.session.fetch(await read(q('#preview') + '.currentSrc'));
  assert.equal(response.status, 200);
  await fs.writeFile(preview, Buffer.from(await response.arrayBuffer()));
  await click('#clear-preview-selection');
  assert.equal(await read(q('#listen-music-mix') + '.disabled'), true);
  await click('#select-all-previews');
  const batch = await read('previewBatch.id');
  await click('#listen-music-mix');
  assert.equal(await read('previewBatch.id'), batch);
  await click(field('ducking'));
  await wait('!previewBatch');
  await click('#open-project');
  await wait(q('#notice') + '.textContent.includes("已打开工程") && !' + q('#start-export') + '.disabled');
  await click('#start-export');
  await wait(q('#output-status') + '.textContent.includes("已保存 1 条")');
  const files = (await fs.readdir(output)).filter((file) => file.endsWith('.mp4'));
  assert.equal(files.length, 1);
  const decode = (file) => ffmpeg(['-i', file, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1']);
  const [generated, exported] = await Promise.all([decode(preview), decode(path.join(output, files[0]))]);
  assert.ok(generated.equals(exported), '成片试听与独立导出的解码 PCM 应一致');
  await click('#open-project');
  await wait('montageConfig().musicSpeeds?.[0]===2');
  await read(`(()=>{
    const ctx=playerTools.musicBus.output().context,make=ctx.createMediaElementSource.bind(ctx);
    window.streamMusic=[];
    ctx.createMediaElementSource=audio=>{
      if (audio.tagName==='AUDIO' && !audio.isConnected) window.streamMusic.push(audio);
      return make(audio);
    };
  })()`);
  await click('#timeline-play');
  await wait('window.streamMusic.some(s=>!s.paused && s.playbackRate===2 && s.preservesPitch)');
  await click('#timeline-play');
  await wait('!timeline.isDraftPlaying()');
  const point = await read(`(()=>{
    const ruler=document.querySelector('.sequence-ruler .sequence-content').getBoundingClientRect();
    const clip=document.querySelector('.sequence-video [data-drop-shot="0"]').getBoundingClientRect();
    return {x:ruler.left+clip.width*1.8/3,y:ruler.top+ruler.height/2};
  })()`);
  for (const [type, buttons] of [
    ['mousePressed', 1],
    ['mouseReleased', 0],
  ]) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      ...point,
      type,
      button: 'left',
      buttons,
      clickCount: 1,
    });
  }
  await wait('Math.abs(timeline.playheadTime-1.8)<.06');
  await click('#timeline-play');
  await wait('window.streamMusic.filter(s=>!s.paused && !s.ended).length===2');
  await click('#timeline-play');
  await wait('window.streamMusic.every(s=>s.paused)');
  const mute = '[data-control-key="music0"] [data-track-action="muted"]',
    solo = '[data-control-key="whole0"] [data-track-action="solo"]';
  await click(mute);
  await wait('montageConfig().trackControls.music0.muted');
  await click('#timeline-play');
  await wait('timeline.isDraftPlaying()');
  assert.ok(await read('window.streamMusic.every(s=>s.paused)'), '配乐静音后流式解码器应停止');
  await click('#timeline-play');
  await click(mute);
  await click(solo);
  await click('#timeline-play');
  await wait('timeline.isDraftPlaying()');
  assert.ok(await read('window.streamMusic.every(s=>s.paused)'), '口播独听时配乐应静音');
  await click('#timeline-play');
  await click(solo);
  await click('#title-home');
  await wait(
    q('#home-create') +
      '?.checkVisibility() && !' +
      q('#home-create') +
      '.disabled && !document.getAnimations().some(a=>a.effect?.target?.contains(' +
      q('#home-create') +
      ') && a.playState==="running")',
  );
  await click('#home-create');
  await wait(
    'montageConfig().musicMix.mode==="smart" && montageConfig().musicMix.duckDb===9 && montageConfig().musicMix.normalizeLufs===null && !montageConfig().musicIds.length',
  );
  console.log(
    '实时配乐 RMS 变化',
    reduction.toFixed(2),
    'dB，循环采样最大跳差',
    jump.toFixed(5),
    '。成片试听与独立导出相同 PCM 样本帧',
    exported.length / 4,
    '。2×长曲定位、接缝双流、静音和独听通过。',
  );
}
async function main() {
  const managed = process.env.JIAJIAN_MUSIC_TEST_ROOT;
  const tempParent = await fs.realpath(os.tmpdir());
  const root = managed || (await fs.mkdtemp(path.join(tempParent, 'jiajian-music-mix-')));
  if (!managed) process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
  try {
    await run(root);
  } finally {
    if (!managed) {
      const actual = await fs.realpath(root);
      assert.equal(path.dirname(actual), tempParent);
      assert.ok(path.basename(actual).startsWith('jiajian-music-mix-'));
      await fs.rm(actual, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch((error) => {
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      });
    }
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { fixtures } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-space-'));
  app.setPath('userData', path.join(root, 'electron'));
  const files = await fixtures(root);
  const records = new Map(await Promise.all(['red', 'blue'].map(async (id) =>
    [id, await inspectAsset(files[id], 'video')])));
  const simple = path.join(root, '两个分镜.sdworkbench'), complex = path.join(root, '含包装.sdworkbench');
  const config = {
    shots: ['red', 'blue'].map((id) => [{ id, start: 0, end: 1.5 }]),
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: true,
    unordered: false, useOriginal: true, useMirrors: false, count: 1, priority: 'picture', musicIds: [], musicVolume: 50,
  };
  await saveProject(simple, config, records);
  await saveProject(complex, { ...config, packaging: { global: [
    { kind: 'text', start: 0, end: null, text: '成片试播', x: .5, y: .65, color: '#ffffff', fontSize: 40 },
  ] } }, records);
  const projects = [simple, complex];
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog(_win, options) {
      assert.equal(options.title, '打开工程');
      assert.ok(projects.length);
      return { canceled: false, filePaths: [projects.shift()] };
    },
  } });
  win.setContentSize(1420, 1000);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.debugger.attach();
  const read = (expression) => win.webContents.executeJavaScript(expression, true);
  const q = (selector) => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const time = '((parseFloat(' + q('.sequence-cursor') + '.style.left)-' + q('.sequence-ruler .sequence-content')
    + '.offsetLeft)*1.5/parseFloat(' + q('.sequence-video [data-drop-shot="1"]') + '.style.left))';
  const live = q('.draft-transport-preview:not([hidden]) video');
  const preview = q('#preview');
  const focus = q('#timeline-clock') + '.contains(document.activeElement)';
  const tracks = q('#timeline-tracks-tab') + '.getAttribute("aria-selected")==="true"';
  const send = (method, data) => win.webContents.debugger.sendCommand('Input.' + method, data);
  const key = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  async function space(held = false) {
    await send('dispatchKeyEvent', { ...key, type: 'keyDown', text: ' ' });
    if (held) {
      for (let i = 0; i < 3; i++) {
        await delay(65);
        await send('dispatchKeyEvent', { ...key, type: 'keyDown', text: ' ', autoRepeat: true });
      }
    }
    await send('dispatchKeyEvent', { ...key, type: 'keyUp' });
  }
  async function wait(condition, message, timeout = 7500) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await read(condition)) return;
      await delay(30);
    }
    const info = await read('({focus:document.activeElement.id || document.activeElement.className,'
      + 'heading:' + q('#preview-heading') + '.textContent,status:' + q('#notice') + '.textContent,'
      + 'time:' + time + ',previewTime:' + preview + '.currentTime})');
    throw new Error(message + ' ' + JSON.stringify(info));
  }
  async function click(selector, offset) {
    const point = await read('(() => {const e=' + q(selector) + ';e.scrollIntoView({block:"nearest",inline:"nearest"});'
      + 'const r=e.getBoundingClientRect(), x=r.left+' + (offset || 'r.width*.5') + ',y=r.top+r.height*.45;'
      + 'return {x,y,hit:e.contains(document.elementFromPoint(x,y))};})()');
    assert.ok(point.hit, selector + ' 可点击');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
  }
  async function seek(seconds) {
    const px = await read('parseFloat(' + q('.sequence-video [data-drop-shot="1"]') + '.style.left)*' + (seconds / 1.5));
    await click('.sequence-ruler .sequence-content', String(px));
    await wait('Math.abs(' + time + '-' + seconds + ')<.04', '点击时间标尺应设置播放头');
  }
  const videoCell = '.sequence-video [data-drop-shot="0"]';
  async function ensurePaused(input, beforeValue) {
    const before = await read(time);
    await space();
    await delay(230);
    assert.equal(await read(q(input) + '.value'), beforeValue + ' ', '编辑文字时可以输入空格');
    assert.ok(Math.abs(await read(time) - before) < .04, '编辑文字时不移动时间线播放头');
    assert.ok(await read(preview + '.paused && !(' + live + ' && !' + live + '.paused)'), '编辑文字时不播放');
  }
  try {
    await read(q('#home-open-project') + '.click()');
    await wait('!!' + q(videoCell), '打开双分镜工程');
    await click(videoCell);
    await space(true);
    await wait('!!' + live + ' && !' + live + '.paused && ' + time + '>.2', '点击分镜后按住空格应连续播放工程');
    assert.equal(await read(q('#preview-batch-list') + '.childElementCount'), 0, '普通分镜不需要生成批量预览');
    assert.ok(await read(focus), '点击素材后空格保留时间线焦点');
    const firstSource = await read(live + '.currentSrc');
    await wait('!!' + live + ' && !!' + live + '.currentSrc && ' + live + '.currentSrc!==' + JSON.stringify(firstSource)
      + ' && ' + time + '>1.65', '连续试播应切换到第二个分镜');
    await space();
    const paused = await read(time);
    const shownFrame = await read('[' + live + '.currentSrc,' + live + '.currentTime]');
    await delay(200);
    assert.ok(Math.abs(await read(time) - paused) < .03, '再按空格暂停并停在同一帧');
    assert.ok(await read(live + '.paused && ' + live + '.readyState>=2 && ' + live + '.getBoundingClientRect().width>0'), '暂停后第二个分镜的画面仍然可见');
    assert.deepEqual(await read('[' + live + '.currentSrc,' + live + '.currentTime]'), shownFrame, '暂停期间保留相同的素材帧');
    await space();
    assert.ok(Math.abs(await read(time) - paused) < .15, '重新播放的第一帧应接续暂停位置');
    await wait(time + '>' + (paused + .18), '空格从暂停处继续');
    await space();
    await seek(.71);
    await space();
    await wait('!!' + live + ' && !' + live + '.paused && ' + live + '.currentTime>.71 && ' + time + '>.76', '从标尺位置开始播放');
    const clock = q('#timeline-clock'), rulerLabel = q('.sequence-ruler .sequence-head > span');
    assert.ok(await read(clock + '.matches(":focus-visible")'), '点击标尺后按空格，时间线获得键盘焦点');
    assert.equal(await read('getComputedStyle(' + clock + ').outlineStyle'), 'none', '播放后时间线上下不应显示整幅焦点边框');
    assert.equal(await read('getComputedStyle(' + rulerLabel + ').outlineStyle'), 'solid', '标尺的时间标签应标示键盘焦点');
    await space();
    await click('#timeline-play');
    await wait('!!' + live + ' && !' + live + '.paused', '工具栏播放按钮可从暂停位置续播');
    assert.equal(await read('getComputedStyle(' + clock + ').outlineStyle'), 'none', '点击播放按钮不会描边整个时间线');
    await click('#timeline-play');
    await wait(live + '.paused', '再次点击工具栏播放按钮暂停');
    await click('#material-search');
    await ensurePaused('#material-search', '');
    await read(q('#timeline-layer-add') + '.click()');
    const textField = '.sequence-dialog[open] textarea';
    await wait('!!' + q(textField), '打开文字包装编辑器');
    await read(q(textField) + '.focus();' + q(textField) + '.setSelectionRange(' + q(textField) + '.value.length,' + q(textField) + '.value.length)');
    await ensurePaused(textField, await read(q(textField) + '.value'));
    await read(q('.sequence-dialog[open]') + '.close()');

    await read(q('#open-project') + '.click()');
    await wait('!!' + q('.sequence-layer.kind-text .sequence-block'), '打开带全局文字包装的工程');
    await seek(1.84);
    await read(preview + '.addEventListener("playing",function onPlay(){if(' + q('#preview-heading')
      + '.textContent==="成片预览"){window.firstCompositionTime=this.currentTime;this.removeEventListener("playing",onPlay);}})');
    await space();
    await wait('Number.isFinite(window.firstCompositionTime) && !' + preview + '.paused', '空格应直接准备并播放含包装成片', 45000);
    assert.ok(await read('window.firstCompositionTime>=1.76 && window.firstCompositionTime<2.18'), '成片从当前播放头开始播放');
    assert.ok(await read(tracks + ' && ' + focus), '生成成片期间保留分镜轨道和键盘焦点');
    await space();
    await wait(preview + '.paused', '成片按空格暂停');
    const last = await read(preview + '.currentTime');
    await space();
    assert.ok(Math.abs(await read(preview + '.currentTime') - last) < .15, '渲染成片续播时保留暂停帧位置');
    await wait('!' + preview + '.paused && ' + preview + '.currentTime>' + (last + .1), '成片从暂停处继续');
    assert.deepEqual(projects, []);
    console.log('时间线空格验收通过。实时跨分镜、渲染成片、定位、暂停续播、长按和文本输入均已验证。');
  } finally {
    win.webContents.debugger.detach();
    win.destroy();
  }
}
check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

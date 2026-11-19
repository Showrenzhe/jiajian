'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-wheel-'));
  const project = path.join(root, '滚轮缩放.sdworkbench');
  const longProject = path.join(root, '长工程.sdworkbench');
  let fileToOpen = project;
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog() { return { canceled: false, filePaths: [fileToOpen] }; },
  } });
  const seed = path.join(root, '原图.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=purple:s=160x90', '-frames:v', '1', '-threads', '1', '-update', '1', seed]);
  const image = await inspectAsset(seed, 'image');
  const images = new Map();
  for (let i = 0; i < 24; i++) {
    const name = '静帧' + String(i + 1).padStart(2, '0') + '.png';
    const file = path.join(root, name);
    await fs.copyFile(seed, file);
    images.set('still-' + i, { ...image, name, path: file });
  }
  const config = {
    shots: [...images.keys()].map(id => [{ id, start: 0, end: 3 }]),
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: true, priority: 'picture',
    unordered: false, useOriginal: true, useMirrors: false, count: 1, musicIds: [], musicVolume: 50,
  };
  await saveProject(project, config, images);
  const minuteShots = [...images.keys()].map(id => [{ id, start: 0, end: 60 }]);
  await saveProject(longProject, { ...config, shots: [config.shots[0], ...minuteShots] }, images);
  win.setContentSize(1240, 840);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = code => wc.executeJavaScript(code, true);
  const wheel = (point, deltaY, modifiers = 2) => wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel', ...point, deltaX: 0, deltaY, modifiers,
  });
  const pageZoom = wc.getZoomFactor();
  const pageScale = await read('visualViewport.scale');
  const settled = () => read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  async function until(check, message) {
    const end = Date.now() + 8000;
    while (!await check()) {
      if (Date.now() > end) throw new Error(message);
      await delay(35);
    }
  }
  function pointIn(selector, horizontal = .5) {
    return read(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width * ${horizontal}), y = Math.round(rect.top + Math.min(16, rect.height / 2));
      if (!el.contains(document.elementFromPoint(x, y))) throw new Error('滚轮位置未命中 ' + el.className);
      return { x, y };
    })()`);
  }
  const materials = '#materials-pane';
  const thumb = '#material-list .material-thumbnail';
  const width = selector => read(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width`);
  const setting = () => read('document.querySelector("#track-zoom").valueAsNumber');
  function track(x) {
    return read(`(() => {
      const view = document.querySelector('#timeline-clock'), lane = view.querySelector('.sequence-video .sequence-content');
      const clips = lane.querySelectorAll('.sequence-block');
      const origin = clips[0].getBoundingClientRect().left;
      const scale = (clips[1].getBoundingClientRect().left - origin) / 3;
      return { scale, time: (${x} - origin) / scale, left: view.scrollLeft, bar: document.querySelector('#track-horizontal-scroll').scrollLeft };
    })()`);
  }
  try {
    await read('document.querySelector("#home-open-project").click()');
    await until(() => read('document.querySelectorAll(".sequence-video .sequence-block").length === 24 && document.querySelectorAll("#material-list .material-tile").length === 24'), '应打开 72 秒工程并显示 24 张素材卡片');
    await read(`document.querySelector('#track-zoom').value = '3';
      document.querySelector('#track-zoom').dispatchEvent(new Event('input', { bubbles: true }));`);
    await settled();
    await read("document.querySelector('#timeline-clock').scrollLeft = 600");
    await settled();
    const ruler = await pointIn('#timeline-clock', .45);
    const start = await track(ruler.x);
    const originalWidth = await width(thumb);
    await wheel(ruler, -120);
    await until(async () => (await track(ruler.x)).scale > start.scale, '上滚应放大时间刻度');
    const enlarged = await track(ruler.x);
    assert.ok(Math.abs(enlarged.time - start.time) * enlarged.scale < 2, '缩放后鼠标下的时间应保持原位');
    assert.ok(Math.abs(enlarged.left - enlarged.bar) <= 2, '底部滚动条应同步至新的时间位置');
    assert.ok(await setting() > 3);
    assert.equal(await width(thumb), originalWidth);
    await wheel(ruler, 120);
    await until(async () => (await track(ruler.x)).scale < enlarged.scale, '下滚应缩小时间刻度');
    const reduced = await track(ruler.x);
    assert.ok(Math.abs(reduced.time - start.time) * reduced.scale < 2);
    await wheel(ruler, 120, 0);
    await settled();
    assert.equal((await track(ruler.x)).scale, reduced.scale, '普通滚轮应保留时间刻度');

    // Select a card in the middle of the scrollable library before it reflows.
    const sample = '#material-list li:nth-child(11)';
    await read(`document.querySelector('${sample}').scrollIntoView({block:'center'});
      document.querySelector('${sample} .material-select').click();`);
    await settled();
    const cardPoint = await pointIn(sample + ' .material-thumbnail');
    await wheel(cardPoint, -120);
    await until(async () => await width(thumb) > originalWidth + 1, '上滚应让素材缩略图实际变大');
    const largerThumb = await width(thumb);
    await wheel(cardPoint, -120);
    await settled();
    assert.equal(await width(thumb), largerThumb, '单列素材到达上限后应保持大小');
    const visibleCard = await read(`(() => {
      const pane = document.querySelector('${materials}').getBoundingClientRect();
      const card = document.querySelector('${sample}').getBoundingClientRect();
      return card.top < pane.bottom && card.bottom > pane.top;
    })()`);
    assert.ok(visibleCard, '重新排列网格后，鼠标附近的卡片应留在可见区');
    assert.ok(await read(`document.querySelector('${sample} .material-select').checked`));
    assert.equal((await track(ruler.x)).scale, reduced.scale);
    await wheel(cardPoint, 120);
    await until(async () => await width(thumb) < largerThumb - 1, '下滚应缩小素材缩略图');
    const normalWidth = await width(thumb);
    const top = await read(`document.querySelector('${materials}').scrollTop`);
    await wheel(cardPoint, top > 100 ? -120 : 120, 0);
    await until(async () => Math.abs(await read(`document.querySelector('${materials}').scrollTop`) - top) > 4, '不按 Ctrl 时应正常滚动素材库');
    assert.equal(await width(thumb), normalWidth);
    await read("document.querySelector('#timeline-tracks-panel').scrollTop = 0");
    await read("document.querySelector('#timeline-fit').click()");
    await settled();
    const fitPoint = await pointIn('#timeline-clock', .45);
    const fitted = await track(fitPoint.x);
    await wheel(fitPoint, -120);
    await until(async () => (await track(fitPoint.x)).scale > fitted.scale, '从适配刻度第一次上滚也应放大');
    assert.ok(Math.abs((await track(fitPoint.x)).time - fitted.time) * fitted.scale < 2);
    for (const [delta, bound] of [[-120, 'max'], [120, 'min']]) {
      const limit = await read(`Number(document.querySelector('#track-zoom').${bound})`);
      const steps = Math.abs(limit - await setting()) + 1;
      for (let i = 0; i < steps; i++) await wheel(fitPoint, delta);
      await until(async () => await setting() === limit, '连续滚动应抵达时间线滑块端点 ' + limit);
      const endpoint = await track(fitPoint.x);
      await wheel(fitPoint, delta);
      await settled();
      assert.equal((await track(fitPoint.x)).scale, endpoint.scale);
    }
    await read(`const view = document.querySelector('#timeline-view'); view.value = 'cards';
      view.dispatchEvent(new Event('change')); document.querySelector('#shots').scrollLeft = 250;`);
    await settled();
    const cardView = await pointIn('#shots', .45);
    const shot = '#visual-track-lane .shot';
    const beforeCard = await width(shot);
    await wheel(cardView, -120);
    await until(async () => await width(shot) > beforeCard + 1, '分镜卡片视图应按相同方向缩放');
    assert.equal(await width(thumb), normalWidth);
    const cardLevel = await setting();
    await read(`document.querySelector('#timeline-view').value = 'time';
      document.querySelector('#timeline-view').dispatchEvent(new Event('change'));`);
    await until(async () => Math.abs((await track(ruler.x)).scale - [16, 32, 60, 100, 180][cardLevel - 1]) < .1,
      '卡片手动缩放后切回时间线，应使用对应的常用刻度');

    fileToOpen = longProject;
    await read("document.querySelector('#open-project').click()");
    await until(() => read("document.querySelectorAll('#visual-track-lane .shot').length === 25"), '应打开 24 分钟工程');
    await read(`document.querySelector('#timeline-view').value='time';
      document.querySelector('#timeline-view').dispatchEvent(new Event('change'));
      document.querySelector('#timeline-fit').click();`);
    await settled();
    const longPoint = await pointIn('#timeline-clock', .4);
    const longFit = (await track(longPoint.x)).scale;
    assert.ok(longFit < 1, '长工程适配时刻度应低于 1px/s');
    const longScales = [longFit];
    for (const delta of [-120, -120, 120, 120, 120]) {
      const previous = longScales.at(-1);
      await wheel(longPoint, delta);
      await until(async () => Math.abs((await track(longPoint.x)).scale - previous) > .01, '长工程在适配附近每次滚动都应改变实际刻度');
      const scale = (await track(longPoint.x)).scale;
      const factor = delta < 0 ? scale / previous : previous / scale;
      assert.ok(factor > 1 && factor <= 2.3, '长工程缩放应平滑跨过适配位置, steps=' + JSON.stringify([...longScales, scale]));
      longScales.push(scale);
    }
    assert.equal(wc.getZoomFactor(), pageZoom);
    assert.equal(await read('visualViewport.scale'), pageScale);
    console.log('Wheel zoom passed', { timeBefore: start.time, timeAfter: enlarged.time, pixelsPerSecond: [start.scale, enlarged.scale], thumbnailWidths: [originalWidth, largerThumb, normalWidth], longScales });
  } finally {
    wc.debugger.detach();
    win.close();
  }
}

run().then(() => app.exit(0), err => { console.error(err); app.exit(1); });

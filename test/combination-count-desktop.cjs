'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { createDraftStore } = require('../src/draft-store.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-combinations-'));
  const profile = path.join(root, 'profile');
  app.setPath('userData', profile);
  const catalog = new Map(await Promise.all(['red', 'blue'].map(async (id) => {
    const file = path.join(root, id + '.png');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=' + id + ':s=64x64', '-frames:v', '1', '-threads', '1', '-update', '1', file]);
    return [id, await inspectAsset(file, 'image')];
  })));
  const shots = Array.from({ length: 60 }, () => [...catalog.keys()].map((id) => ({ id, start: 0, end: 1 })));
  await createDraftStore(path.join(profile, 'drafts')).create({ name: '60 组双候选', config: {
    shots, count: 1, useOriginal: true, useMirrors: false, unordered: false,
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: false, musicIds: [], musicVolume: 40,
  } }, catalog);
  const win = await launchDesktop({ show: false, dataDirectory: profile });
  const contents = win.webContents;
  contents.setBackgroundThrottling(false);
  const read = (code) => contents.executeJavaScript(code, true);
  async function waitFor(code, message) {
    const until = Date.now() + 20000;
    while (!await read(code)) {
      if (Date.now() >= until) throw new Error(message);
      await delay(40);
    }
  }
  try {
    win.setContentSize(1400, 960);
    await waitFor('!!document.querySelector(".draft-open")', '草稿未载入');
    await clickVisible(contents, '.draft-open');
    await waitFor('document.querySelectorAll("#shots .shot").length === 60', '草稿未恢复 60 组分镜');
    await clickVisible(contents, '#inspector-tab-montage');
    assert.equal(await read('document.querySelector("#combinations").innerText'),
      '可生成 1,152,921,504,606,846,976 种不重复组合。每批最多 1,000 条。');
    assert.equal(await read('document.querySelector("#count").max'), '1000');
    await clickVisible(contents, '#count');
    await read('document.querySelector("#count").select()');
    await contents.insertText('81');
    assert.equal(await read('document.querySelector("#count").valueAsNumber'), 81);
    assert.ok(await read('document.querySelector("#count").checkValidity() && !document.querySelector("#prepare-preview").disabled'));
    console.log('60 组双候选草稿的完整组合数、每批 1,000 条上限和实际填写 81 条通过。');
  } finally {
    win.destroy();
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

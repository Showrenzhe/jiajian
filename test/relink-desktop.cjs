'use strict';
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync } = require('node:fs');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { saveProject, loadProject } = require('../src/project-format.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { fixtures, ffmpeg } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { setTimeout: delay } = require('node:timers/promises');

async function test() {
  const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'jiajian-relink-ui-'));
  app.setPath('userData', root);
  app.setPath('sessionData', root);
  const old = path.join(root, 'before'),
    moved = path.join(root, 'after'),
    file = path.join(root, '旧项目.sdworkbench'),
    result = path.join(root, '恢复.jiajian');
  await fs.mkdir(old);
  const samples = await fixtures(old);
  const config = {
    shots: [[{ id: 'video', start: 0.1, end: 1.2 }]],
    ratio: '9:16',
    resolution: 720,
    fps: 30,
    fit: 'fill',
    keepAudio: false,
    unordered: false,
    useOriginal: true,
    useMirrors: false,
    musicIds: [],
    musicVolume: 20,
    count: 1,
  };
  await saveProject(file, config, new Map([['video', await inspectAsset(samples.red, 'video')]]));
  await fs.rename(old, moved);
  const output = path.join(root, 'outputs');
  await fs.mkdir(output);
  let cancelled = true;
  const win = await launchDesktop({
    show: false,
    dataDirectory: path.join(root, 'profile'),
    dialogs: {
      showOpenDialog: async (_win, opt) =>
        opt.title === '选择导出目录'
          ? { filePaths: [output] }
          : opt.properties.includes('openDirectory')
            ? cancelled
              ? { canceled: true, filePaths: [] }
              : { filePaths: [moved] }
            : { filePaths: [file] },
      showSaveDialog: async () => ({ filePath: result }),
    },
  });
  win.setContentSize(1440, 900);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  const read = (expr) => wc.executeJavaScript(expr, true),
    click = (selector) => clickVisible(wc, selector);
  const wait = async (expr) => {
    for (const end = Date.now() + 18000; Date.now() < end;) {
      if (await read(expr)) return;
      await delay(40);
    }
    throw Error(
      expr +
        ' ' +
        (await read(
          '[document.querySelector(".app-frame").dataset.mode,document.querySelector("#home-project-status").textContent,document.querySelector("#notice").textContent,document.querySelector("#missing-materials").hidden]',
        )),
    );
  };
  try {
    await click('#home-open-project');
    await wait(
      'document.querySelector(".app-frame").dataset.mode==="montage" && !document.querySelector("#missing-materials").hidden',
    );
    assert.match(await read('document.querySelector("#missing-materials").textContent'), /红色原声/);
    await click('#missing-materials summary');
    await click('#relink-materials');
    await wait('!operation');
    assert.equal(await read('document.querySelector("#missing-materials").hidden'), false);
    await assert.rejects(read('workbench.preparePreview(montageConfig())'), /重新定位/);
    cancelled = false;
    await click('#relink-materials');
    await wait('document.querySelector("#missing-materials").hidden');
    await wait('!operation && !document.querySelector("#save-project").disabled');
    await delay(250);
    await click('#save-project');
    await wait('document.querySelector("#notice").textContent.includes("已保存")');
    const restored = await loadProject(result);
    assert.equal([...restored.assets.values()][0].path, path.join(moved, path.basename(samples.red)));
    assert.equal(restored.config.shots[0][0].start, 0.1);
    assert.equal(restored.config.shots[0][0].end, 1.2);
    await click('#prepare-preview');
    await wait('!operation && !document.querySelector("#timeline-batch-tab").disabled');
    await click('#timeline-batch-tab');
    await wait('!document.querySelector("#preview-batch").hidden');
    await click('.preview-composition');
    await wait('!operation && !!previewBatch?.current?.clip');
    await click('#start-export');
    await wait('document.querySelector("#output-status").textContent.includes("已保存 1 条")');
    const mediaFiles = (await fs.readdir(output)).filter((name) => name.endsWith('.mp4'));
    assert.equal(mediaFiles.length, 1);
    const exported = path.join(output, mediaFiles[0]);
    const pixels = await ffmpeg([
      '-ss',
      '0.4',
      '-i',
      exported,
      '-vf',
      'scale=1:1',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    assert.ok(pixels[0] > 180 && pixels[1] < 40 && pixels[2] < 40, '重新定位的视频应导出红色画面');
    assert.ok(Math.abs((await inspectAsset(exported, 'video')).duration - 1.1) < 0.08);
    console.log('已验证缺失显示、取消、阻断、重新定位、保存重开、播放预览、导出并解码红色画面。');
  } finally {
    win.destroy();
  }
}
test().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

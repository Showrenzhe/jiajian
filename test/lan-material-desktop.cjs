'use strict';

const assert = require('node:assert/strict');
const { accessSync, constants, mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { fixtures } = require('./fixtures.cjs');

// Run on Windows with access to the existing SMB loopback share for the temp drive.
// The test never creates a share or changes network settings.
async function run() {
  const tmp = os.tmpdir();
  if (process.platform !== 'win32' || !/^[a-z]:\\/i.test(tmp)) {
    console.log('跳过 SMB 桌面测试，需要 Windows 和本机临时盘。');
    return;
  }
  const unc = file => '\\\\localhost\\' + file.charAt(0) + '$' + file.slice(2);
  try {
    accessSync(unc(tmp), constants.R_OK);
  } catch {
    console.log('跳过 SMB 桌面测试，本机临时盘的现有共享不可读。');
    return;
  }
  const root = mkdtempSync(path.join(tmp, 'jiajian-smb-'));
  const profile = path.join(root, 'profile');
  mkdirSync(profile);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  const folder = path.join(root, '共享 素材目录');
  const file = path.join(root, '共享 样片.mp4');
  const unselected = path.join(root, '未导入 样片.mp4');
  const still = path.join(folder, '目录 静帧.png');
  const project = path.join(root, '网络素材.sdworkbench');
  const otherProject = path.join(root, '未导入素材.sdworkbench');
  const picks = [];
  await fs.mkdir(folder);
  const media = await fixtures(root);
  await Promise.all([fs.copyFile(media.red, file), fs.copyFile(media.green, unselected), fs.copyFile(media.still, still)]);
  const win = await launchDesktop({ show: false, checkOnStartup: false, dataDirectory: profile, dialogs: {
    async showOpenDialog(_, options) {
      const next = picks.shift();
      assert.equal(options.title, next?.title);
      return { canceled: false, filePaths: [next.file] };
    },
    async showSaveDialog() { return { canceled: false, filePath: project }; },
  } });
  const wc = win.webContents;
  win.setContentSize(1400, 900);
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = js => wc.executeJavaScript(js, true);
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const tile = file => '.material-tile[title=' + JSON.stringify(path.basename(file)) + ']';
  const click = selector => clickVisible(wc, selector);
  async function wait(js, label) {
    const end = Date.now() + 10000;
    while (!await read(js)) {
      if (Date.now() > end) throw Error(label + ' / ' + await read('[document.querySelector("#material-message").textContent,document.querySelector("#notice").textContent].join(" / ")'));
      await delay(40);
    }
  }
  async function drop(selector, files) {
    const hitTest = '(()=>{const target=' + el(selector) + ';target.scrollIntoView({block:"nearest"});const r=target.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return target.contains(document.elementFromPoint(x,y))?{x,y}:null})()';
    await wait(hitTest, '拖放目标必须可见且命中 ' + selector);
    const point = await read(hitTest);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
    }
  }
  async function previewVideo() {
    await click(tile(file));
    await wait(el('#preview') + '.videoWidth === 320 && ' + el('#preview') + '.currentTime > 0 && ' +
      el('#preview-name') + '.textContent === ' + JSON.stringify(path.basename(file)), '中文空格共享视频应实际解码与播放');
    const url = await read(el('#preview') + '.currentSrc');
    const response = await wc.session.fetch(url, { headers: { Range: 'bytes=8-39' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), (await fs.readFile(file)).subarray(8, 40));
  }
  const hasThumbnail = name => el(tile(name) + ' img') + '?.naturalWidth > 0';
  try {
    await click('#home-create');
    await wait(el('#materials-heading') + '?.checkVisibility()', '等待素材库');
    await drop('#materials-heading', [unc(file)]);
    await wait(hasThumbnail(file), '共享视频应出现在库内并生成缩略图');
    await previewVideo();
    await drop('#materials-heading', [unc(media.blue), media.green, unc(folder)]);
    const folderTile = '.material-folder[title=' + JSON.stringify(path.basename(folder)) + ']';
    await wait(hasThumbnail(media.blue) + ' && ' + hasThumbnail(media.green) + ' && !!' + el(folderTile), '一次拖入网络视频、本地视频及共享文件夹');
    await click(folderTile);
    for (const type of ['rawKeyDown', 'char', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'char' ? '\r' : '' });
    }
    await wait(hasThumbnail(still), '目录中的共享静帧缩略图应解码');
    await click(tile(still));
    await wait(el('#still-preview') + '.naturalWidth === 160 && !' + el('#still-preview') + '.hidden', '共享图片应在播放器显示');
    await click('#material-breadcrumb .material-back');
    const missing = path.join(root, '已经移走.mp4');
    await drop('#materials-heading', [unc(missing)]);
    await wait(el('#material-message') + '.textContent.includes(' + JSON.stringify(path.basename(missing)) + ')', '缺失共享素材应反馈错误');
    assert.equal(await read('!!' + el(tile(missing))), false);
    picks.push({ title: '选择素材文件', file: unc(file) });
    await click('#material-import');
    await click('#material-import-files');
    await wait('document.querySelectorAll(".sequence-video .sequence-block[data-selectable]").length === 1', '共享视频应可进入时间线');
    await click('#save-project');
    await wait(el('#notice') + '.textContent.includes("工程已保存")', '保存含网络素材的工程');
    const saved = JSON.parse(await fs.readFile(project, 'utf8'));
    const declared = saved.assets.find(a => a.path === unc(file));
    assert.ok(declared, '工程记录共享原路径');
    picks.push({ title: '打开工程', file: project });
    await click('#open-project');
    await wait(el('#notice') + '.textContent.includes("已打开工程") && ' + hasThumbnail(file), '重新打开并还原共享素材');
    await previewVideo();

    // A project can refer to an existing sibling the user never dropped or selected.
    // Keep the edit available while the unapproved reference remains offline.
    declared.path = unc(unselected);
    await fs.writeFile(otherProject, JSON.stringify(saved));
    picks.push({ title: '打开工程', file: otherProject });
    await click('#open-project');
    await wait(el('#notice') + '.textContent.includes("已打开工程") && !' + el('#missing-materials') + '.hidden', '未取得许可的共享文件须显示为缺失');
    const offline=await read('shots[0][0].asset');
    assert.equal(offline.missing,true);
    assert.equal(offline.url,'');
    assert.equal((await wc.session.fetch('sd-workbench://asset/'+offline.id,{headers:{Range:'bytes=8-39'}})).status,404);
    await assert.rejects(read('workbench.preparePreview(montageConfig())'),/重新定位/);
    await assert.rejects(read('workbench.export("montage",montageConfig())'),/重新定位/);
    assert.deepEqual(picks, []);
    console.log('SMB 回环桌面回归通过。共享文件与目录拖放、普通本地文件、缩略图、字节范围、图像/视频解码、保存重开、缺失文件和未授权文件均已覆盖。');
  } finally {
    wc.debugger.detach();
    win.destroy();
  }
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { fixtures, ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-library-'));
  const library = path.join(root, '拍摄素材');
  const nested = path.join(library, '补拍镜头');
  await fs.mkdir(nested, { recursive: true });
  const files = await fixtures(library);
  const portraitVideo = path.join(nested, '9比16竖屏.mp4');
  const portraitStill = path.join(nested, '9比16竖图.png');
  await Promise.all([
    ffmpeg(['-f','lavfi','-i','color=cornflowerblue:s=180x320:r=24:d=1','-c:v','libx264','-threads','1',portraitVideo]),
    ffmpeg(['-f','lavfi','-i','color=coral:s=180x320','-frames:v','1','-threads','1',portraitStill]),
  ]);
  const originals = await Promise.all([files.red, files.still].map(file => fs.readFile(file)));
  const savedProject = path.join(root, '拖入文件夹.sdworkbench');
  const picks = [];
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showSaveDialog() { return { canceled: false, filePath: savedProject }; },
    async showOpenDialog(_win, options) {
      const next = picks.shift();
      assert.equal(options.title, next?.title);
      return { canceled: false, filePaths: next.files };
    },
  } });
  win.setContentSize(1400, 960);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = code => wc.executeJavaScript(code, true).catch(error => {
    throw new Error('Renderer check failed: ' + code, { cause: error });
  });
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const count = selector => 'document.querySelectorAll(' + JSON.stringify(selector) + ').length';
  const click = selector => read(el(selector) + '.click()');
  const send = (method, params) => wc.debugger.sendCommand('Input.' + method, params);
  async function wait(condition, label) {
    const end = Date.now() + 10000;
    while (!await read(condition)) {
      if (Date.now() > end) throw new Error(label + '；' + await read('[' + el('#material-message') + '.textContent,'
        + el('#preview-name') + '.textContent,' + el('#still-preview') + '.hidden,' + el('#still-preview') + '.naturalWidth,document.activeElement.title].join(" / ")'));
      await delay(40);
    }
  }
  async function point(selector) {
    const coordinates = '(() => {const target=' + el(selector) + ';target.scrollIntoView({block:"nearest"});'
      + 'const rect=target.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;'
      + 'return target.contains(document.elementFromPoint(x,y)) ? {x,y} : null;})()';
    await wait(coordinates, '控件被遮挡 ' + selector);
    return read(coordinates);
  }
  async function mouseClick(selector, button = 'left', times = 1) {
    const coords = await point(selector);
    for (let clickCount = 1; clickCount <= times; clickCount++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        const buttons = type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1;
        await send('dispatchMouseEvent', { type, ...coords, button, buttons, clickCount });
      }
    }
  }
  async function rightClick(selector) {
    await mouseClick(selector, 'right');
    await wait(el('#material-context-menu') + '.matches(":popover-open")', '右键应显示素材菜单');
  }
  async function key(name, code, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('dispatchKeyEvent', { type, key: name, code: name === 'z' ? 'KeyZ' : name, windowsVirtualKeyCode: code, modifiers });
    }
  }
  async function dropFiles(selector, files) {
    const coords = await point(selector);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await send('dispatchDragEvent', { type, ...coords, data });
    }
  }
  async function dragLibraryAudio(selector) {
    const source = await point('#processed-material-list li:first-child strong'), target = await point(selector);
    let data;
    const capture = (_event, method, params) => { if (method === 'Input.dragIntercepted') data = params.data; };
    wc.debugger.on('message', capture);
    await send('setInterceptDrags', { enabled: true });
    try {
      await send('dispatchMouseEvent', { type:'mouseMoved', ...source });
      await send('dispatchMouseEvent', { type:'mousePressed', ...source, button:'left', buttons:1, clickCount:1 });
      await send('dispatchMouseEvent', { type:'mouseMoved', x:source.x+9, y:source.y, button:'left',buttons:1 });
      await send('dispatchMouseEvent', { type:'mouseMoved', ...target, button:'left',buttons:1 });
      const end = Date.now() + 3000;
      while (!data && Date.now() < end) await delay(20);
      assert.ok(data?.items.some(item=>item.mimeType==='application/x-jiajian-processed-audio'), '素材库音频应发起原生拖放');
      for (const type of ['dragEnter','dragOver']) await send('dispatchDragEvent', { type, ...target, data });
      assert.equal(await read(el(selector)+'.dataset.materialDrop'), 'active', '鼠标所在的口播槽应显示接收状态');
      await send('dispatchDragEvent', { type:'drop', ...target, data });
    } finally {
      wc.debugger.off('message', capture);
      await send('dispatchMouseEvent', { type:'mouseReleased', ...target, button:'left', clickCount:1 });
      await send('setInterceptDrags', { enabled: false });
    }
  }
  async function pickFolder() {
    picks.push({ title: '选择素材文件夹', files: [library] });
    await mouseClick('#material-folder-import');
  }
  const item = (type, file) => '.' + type + '[title=' + JSON.stringify(path.basename(file)) + ']';
  const folder = item('material-folder', library), child = item('material-folder', nested);
  const red = item('material-tile', files.red), still = item('material-tile', files.still);
  const tracks = count('.sequence-video .sequence-block[data-selectable]');
  const menu = '#material-context-remove';
  const undo = () => key('z', 90, 2);

  try {
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await click('#home-create');
    await wait('!' + el('#materials-pane') + '.hidden && !' + el('#material-audio-open') + '.disabled', '新建草稿应打开素材库');
    picks.push({ title: '选择待处理音频', files: [files.music, files.otherMusic] });
    await mouseClick('#material-audio-open');
    await wait(el('#audio-tools-dialog') + '.open && ' + count('#audio-tool-source option') + '===2', '空素材库也应能选择多个音频进入处理窗口');
    const audioMode = el('#audio-tool-mode');
    await read(audioMode + '.value="both";' + audioMode + '.dispatchEvent(new Event("change"))');
    await mouseClick('#audio-tool-generate');
    assert.equal(await read('document.activeElement.id'), 'audio-tool-close');
    await key('Escape', 27);
    await wait(el('#audio-tool-status') + '.textContent.includes("已取消") && !' + audioMode + '.disabled', '取消处理后应保留窗口并可以重试');
    assert.equal(await read(el('#audio-tools-dialog') + '.open'), true);
    await read(audioMode + '.value="trim";' + audioMode + '.dispatchEvent(new Event("change"))');
    await mouseClick('#audio-detect');
    await wait(el('#audio-tool-status') + '.textContent.includes("检测到")', '重新操作应能完成两项素材的停顿检测');
    assert.equal(await read('document.activeElement.id'), 'audio-tool-close');
    await mouseClick('#audio-tool-close');
    picks.push({ title: '选择分镜素材', files: [files.red] });
    await mouseClick('#material-import');
    await wait(tracks + '===1 && !!' + el(red), '导入视频应同时显示素材和一个分镜');
    await pickFolder();
    await wait('!!' + el(folder), '应显示导入的文件夹');
    const icon = el(folder + ' svg');
    const initial = await read(icon + '.getBoundingClientRect().width');
    assert.ok(initial >= 30, '文件夹图标应占据可辨认的尺寸');
    assert.equal(await read(el(folder + ' use') + '.getAttribute("href")'), '#icon-library-folder');
    assert.ok(await read(el(folder + ' .material-folder-name') + '.getBoundingClientRect().top >= '
      + icon + '.getBoundingClientRect().bottom - 1'), '文件夹名称应在图标下方');
    const wheelPoint = await point(folder);
    await send('dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -120, modifiers: 2 });
    await wait(icon + '.getBoundingClientRect().width > ' + (initial + 1), 'Ctrl 加滚轮应放大文件夹图标');
    await send('dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 120, modifiers: 2 });
    await wait(icon + '.getBoundingClientRect().width <= ' + (initial + 1), '缩小后应恢复原尺寸');
    await mouseClick(folder);
    await wait('document.activeElement===' + el(folder) + ' && ' + el('#material-breadcrumb') + '.hidden', '单击目录应选中图标并停留在根目录');
    assert.ok(await read('getComputedStyle(' + el(folder) + ').boxShadow !== "none"'), '选中的文件夹应有清楚的外框');
    await key('Delete', 46);
    await wait('!' + el(folder) + ' && ' + tracks + '===1', '单击文件夹后按 Delete 应移除该文件夹');
    await undo();
    await wait('!!' + el(folder), '撤销应恢复根目录图标');
    await mouseClick(folder, 'left', 2);
    await wait('!!' + el(child) + ' && ' + el(red + ' img') + '?.naturalWidth > 0 && ' + el(still + ' img') + '?.naturalWidth > 0', '应能打开目录并显示子目录、视频和图片缩略图');
    const player = el('#preview');
    const playing = '!' + player + '.paused && ' + player + '.currentTime > 0';
    await mouseClick(red);
    await wait(playing, '文件夹里的视频也应点击直接播放');
    await mouseClick(still);
    await wait('!' + el('#still-preview') + '.hidden && ' + el('#still-preview') + '.naturalWidth > 0 && ' + player + '.paused',
      '选图片应立即显示图片并暂停当前视频');
    await rightClick(red);
    assert.equal(await read(el('#material-context-audio') + '.hidden'), false, '视频右键应能进入音频处理');
    if (process.env.JIAJIAN_LIBRARY_CAPTURE) {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const frame = await read('(() => {const p=' + el('#materials-pane') + '.getBoundingClientRect(),m=' + el('#material-context-menu')
        + '.getBoundingClientRect();return {x:Math.floor(p.x),y:Math.floor(p.y),width:Math.ceil(Math.max(p.right,m.right)-p.x+4),height:Math.ceil(Math.max(p.bottom,m.bottom)-p.y)};})()');
      const output = path.resolve(process.env.JIAJIAN_LIBRARY_CAPTURE);
      await fs.mkdir(path.dirname(output), { recursive: true });
      const capture = await wc.debugger.sendCommand('Page.captureScreenshot', { clip: { ...frame, scale: 1 } });
      await fs.writeFile(output, Buffer.from(capture.data, 'base64'));
    }
    await click(menu);
    await wait('!' + el(red) + ' && ' + tracks + '===1', '右键移除应隐藏素材并保留在用分镜');
    await undo();
    await wait(el(red) + '?.dataset.used==="true" && ' + tracks + '===1', 'Ctrl+Z 应恢复素材及已用标记');

    await click(red + ' ~ .material-select');
    await click(still + ' ~ .material-select');
    await rightClick(still);
    await click(menu);
    await wait('!' + el(red) + ' && !' + el(still) + ' && ' + tracks + '===1', '右键已勾选项应一起移除已用视频和未用图片');
    await undo();
    await wait('!!' + el(red) + ' && !!' + el(still), '多项移除应可一次撤销');
    await rightClick(child);
    await key('Escape', 27);
    await wait('document.activeElement===' + el(child), '关闭菜单应将焦点还给文件夹');
    await key('Delete', 46);
    await wait('!' + el(child) + ' && ' + tracks + '===1', 'Delete 应移除聚焦的子目录');
    await undo();
    await wait('!!' + el(child), '撤销应恢复子目录图标');
    await mouseClick(child);
    await key('Enter', 13);
    await wait(el('#material-breadcrumb') + '.textContent.includes("补拍镜头")', '回车应打开选中的子目录');
    for (const file of [portraitVideo, portraitStill]) {
      const tile = item('material-tile', file);
      await wait(el(tile + ' img') + '?.naturalWidth > 0', '竖屏素材应载入缩略图');
      const ratio = await read('(() => {const r=' + el(tile + ' .material-thumbnail')
        + '.getBoundingClientRect();return r.width / r.height})()');
      assert.ok(Math.abs(ratio - 9/16) < .003, '竖屏缩略图应以 9:16 展示，实际为 ' + ratio);
    }
    if (process.env.JIAJIAN_LIBRARY_CAPTURE) {
      const frame = await read('(() => {const r=' + el('#materials-pane') + '.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
      const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { clip: frame });
      const target = path.parse(process.env.JIAJIAN_LIBRARY_CAPTURE);
      await fs.writeFile(path.join(target.dir, target.name + '-portrait.png'), Buffer.from(shot.data, 'base64'));
    }
    await click('#material-breadcrumb .material-back');
    await wait('document.activeElement===' + el(child), '返回上一级应重新聚焦原目录');
    await click('#material-breadcrumb .material-back');
    await wait('!!' + el(folder) + ' && !!' + el(red), '返回素材库应恢复根目录列表');
    await rightClick(folder);
    await click(menu);
    await wait('!' + el(folder) + ' && !!' + el(red), '右键移除整个目录应保留单独导入的素材');
    await pickFolder();
    await wait(count(folder) + '===1', '重新添加同一目录应恢复单个文件夹图标');
    await read(el(red) + '.focus()');
    await key('Delete', 46);
    await wait('!' + el(red) + ' && ' + tracks + '===1', '素材卡片上按 Delete 应只移除库条目');
    picks.push({ title: '选择分镜素材', files: [files.red] });
    await click('#material-import');
    await wait(el(red) + '?.dataset.used==="true" && ' + tracks + '===2', '重新导入同一文件应恢复素材，照常创建新分镜');
    await mouseClick(red);
    await wait(count('.sequence-video .material-instance') + '===2', '素材应高亮时间线中使用它的两个实例');
    await wait(playing, '点选素材库视频应直接播放原片');
    await read(player + '.pause()');
    await mouseClick(red);
    await wait(playing, '再次点击同一素材应重新播放');
    const fold = '.sequence-video .sequence-head button[aria-expanded]';
    await click(fold);
    await wait(count('.sequence-video.sequence-folded .material-instance') + '===2', '折叠轨道应保留两个匹配片段');
    const foldedRing = await read('getComputedStyle(' + el('.sequence-folded .material-instance') + ', "::after").borderTopColor');
    assert.equal(foldedRing, await read('getComputedStyle(document.documentElement).getPropertyValue("--material-match-gold").trim()'));
    await click(fold);
    const green = item('material-tile', files.green);
    await dropFiles('#materials-heading', [files.green, nested]);
    await wait('!!' + el(green) + ' && !!' + el(child) + ' && ' + tracks + '===2', '拖入文件和文件夹只应扩充素材库');
    await wait(el(green + ' img') + '?.naturalWidth > 0 && !!' + el(green + ' .material-duration') + '?.textContent', '素材卡片应有实帧和时长');
    const usedRing = 'getComputedStyle(' + el(green) + ',"::after").boxShadow';
    assert.equal(await read(usedRing), 'none', '未使用的素材不显示已用光圈');
    await wait(el(folder + ' .folder-preview img') + '?.naturalWidth > 0', '素材目录应有实帧封面');
    await read('window.savedTile=' + el(green) + '; window.savedImage=window.savedTile.querySelector("img")');
    await dropFiles('.sequence-video [data-drop-shot="0"]', [files.green]);
    await wait(tracks + '===3 && ' + count('.shot') + '===2', '文件拖到已有分镜应只增加候选');
    assert.ok(await read('window.savedTile===' + el(green) + ' && window.savedImage===' + el(green + ' img')), '添加候选应复用原素材卡片及已解码帧');
    assert.notEqual(await read(usedRing), 'none', '使用后应立刻显示外发光');
    await undo();
    await wait(tracks + '===2 && ' + usedRing + '==="none"', '撤销使用后应立刻恢复原外框');
    await dropFiles('.sequence-video [data-drop-shot="0"]', [files.green]);
    await wait(tracks + '===3', '应可重新加入候选');
    await dropFiles('#new-shot-drop', [files.still, files.blue]);
    await wait(tracks + '===5 && ' + count('.shot') + '===4', '两个文件拖到空白区应建立两个分镜');
    await mouseClick(green);
    await wait(count('.sequence-video .material-instance') + '===1', '切换选中素材应清除旧的高亮');
    assert.equal(await read('getComputedStyle(' + el(green + ' .material-duration') + ').color'), 'rgb(255, 255, 255)');
    for (const theme of ['dark', 'light']) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await wait('document.documentElement.dataset.theme===' + JSON.stringify(theme), '素材卡应能切换主题');
      const glow = 'getComputedStyle(' + el('.sequence-video .material-instance') + ')';
      assert.ok(await read(glow + '.outlineWidth === "3px" && ' + glow + '.boxShadow !== "none" && '
        + glow + '.outlineColor === getComputedStyle(document.documentElement).getPropertyValue("--material-match-gold").trim()'),
      '两种主题下都应有金色外框和外发光');
      if (process.env.JIAJIAN_LIBRARY_CAPTURE) {
        const frame = await read('(() => {const r=' + el('#materials-pane') + '.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()');
        const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { clip: frame });
        const filename = path.parse(process.env.JIAJIAN_LIBRARY_CAPTURE);
        await fs.writeFile(path.join(filename.dir, filename.name + '-' + theme + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }
    await dropFiles('.sequence-voice [data-voice-row="0"]', [files.music]);
    await wait(el('.sequence-voice [data-voice-row="0"]') + '.textContent.includes(' + JSON.stringify(path.basename(files.music)) + ')', '本地音频应能直接放入口播轨');
    await dropFiles('#inspector-tab-music', [files.otherMusic]);
    await wait(el('.sequence-music .sequence-block') + '?.textContent.includes(' + JSON.stringify(path.basename(files.otherMusic)) + ')', '本地音频应能直接加入配乐');
    await mouseClick('#processed-material-list li strong');
    await wait(playing + ' && ' + el('#preview-name') + '.textContent===' + JSON.stringify(path.basename(files.music)),
      '单击素材库音频应直接试听');
    await wait(count('.sequence-voice .material-instance') + '===1', '口播轨里的同一音频应显示金色外框');
    assert.notEqual(await read('getComputedStyle(' + el('#processed-material-list li[data-used]') + ',"::after").boxShadow'), 'none',
      '已经加入口播的音频卡也应发光');
    const voiceSlot = '.sequence-voice [data-voice-row="1"]';
    await click('#add-whole-track');
    await wait('!!'+el(voiceSlot+'.sequence-empty'),'添加第二条整段口播轨');
    await dragLibraryAudio(voiceSlot);
    await wait(el(voiceSlot)+'.textContent.includes('+JSON.stringify(path.basename(files.music))+')','从素材库拖入第二条整段口播轨');
    await read(el('#narration-mode')+'.value="segmented";'+el('#narration-mode')+'.dispatchEvent(new Event("change",{bubbles:true}))');
    const addVoice = '.segment-narration-panel[data-shot-index="1"] .add-segment-narration';
    await click(addVoice);await click(addVoice);
    const segment = voiceSlot+'[data-voice-shot="1"]';
    await wait('!!'+el(segment+'.sequence-empty'),'分镜 2 应有第二轨空位');
    await dragLibraryAudio(segment);
    await wait(el(segment)+'.textContent.includes('+JSON.stringify(path.basename(files.music))+') && '+count('.sequence-voice [data-selectable]')+'===1','拖入的音频应仅出现在目标分镜的第二条口播轨');
    await mouseClick(red);
    await mouseClick(green);
    await wait(playing + ' && ' + el('#preview-name') + '.textContent===' + JSON.stringify(path.basename(files.green)),
      '快速切换后应播放最后选中的素材');
    await click('#save-project');
    await wait(el('#notice') + '.textContent.includes("工程已保存")', '应能保存带拖入文件夹的工程');
    assert.equal(JSON.parse(await fs.readFile(savedProject, 'utf8')).config.materialFolderKeys.length, 1);
    picks.push({ title: '打开工程', files: [savedProject] });
    await click('#open-project');
    await wait(el('#notice') + '.textContent.includes("已打开工程") && !!' + el(child), '重开后应恢复拖入的目录');
    await wait(el(segment)+'?.textContent.includes('+JSON.stringify(path.basename(files.music))+')','重开工程后口播仍在第二镜第二轨');
    for (const [i, file] of [files.red, files.still].entries()) assert.deepEqual(await fs.readFile(file), originals[i]);
    assert.ok((await fs.stat(nested)).isDirectory(), '原子目录应留在磁盘');
    assert.deepEqual(picks, []);
    console.log('素材库点播、跨分镜金色高亮、折叠轨道、素材拖放、文件夹重开、缩略图复用及明暗外观通过。');
  } finally {
    wc.debugger.detach();
    win.destroy();
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

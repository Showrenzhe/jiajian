'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { dragLibraryItem } = require('./desktop-input.cjs');
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
        + el('#preview-name') + '.textContent,' + el('#still-preview') + '.hidden,' + el('#still-preview') + '.naturalWidth,document.activeElement.outerHTML.slice(0,110)].join(" / ")'));
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
  async function mouseClick(selector, button = 'left', times = 1, modifiers = 0) {
    const coords = await point(selector);
    for (let clickCount = 1; clickCount <= times; clickCount++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        const buttons = type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1;
        await send('dispatchMouseEvent', { type, ...coords, button, buttons, clickCount, modifiers });
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
      if (type === 'rawKeyDown' && name === 'Enter') await send('dispatchKeyEvent', {type:'char',key:name,code:name,text:'\r',windowsVirtualKeyCode:code,modifiers});
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
    await dragLibraryItem(wc, source, target, 'application/x-jiajian-processed-audio', async () => {
      assert.equal(await read(el(selector)+'.dataset.materialDrop'), 'active', '鼠标所在的口播槽应显示接收状态');
    });
  }
  async function pickFolder() {
    picks.push({ title: '选择素材文件夹', files: [library] });
    await mouseClick('#material-import');
    await mouseClick('#material-import-directory');
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
    await read(el('#material-import') + '.focus()');
    await key('ArrowDown', 40);
    await wait('document.activeElement.id==="material-import-files"', '键盘打开导入菜单应聚焦文件选项');
    await key('ArrowDown', 40);
    await wait('document.activeElement.id==="material-import-directory"', '方向键应切换到整个目录');
    await key('Escape', 27);
    await wait('document.activeElement.id==="material-import" && !'+el('#material-import-menu')+'.matches(":popover-open")', 'Esc 应返回工具栏');
    picks.push({ title: '选择素材文件', files: [files.red] });
    await mouseClick('#material-import');
    await mouseClick('#material-import-files');
    await wait(tracks + '===1 && !!' + el(red), '导入视频应同时显示素材和一个分镜');
    const lock = '[data-control-key="vis0"] [data-track-action="locked"]';
    await click(lock);
    await wait(el(lock)+'.ariaPressed==="true" && document.activeElement==='+el(lock), '锁定反馈并恢复轨头焦点');
    await mouseClick(red); await key('Delete',46);
    await wait(el('#material-message')+'.textContent.includes("请先解锁视频轨 1") && !'+el('#material-remove-dialog')+'.open && !!'+el(red)+' && '+tracks+'===1','锁定轨道中有实例时保留整项并指明需解锁的轨道');
    await click(lock);
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
    await wait(el('#material-remove-dialog') + '.open && document.activeElement.id==="material-remove-cancel"', '右键移除在用视频应默认聚焦取消');
    assert.ok(await read(el('#material-remove-detail') + '.textContent.includes("1 个对应片段")'));
    await key('Enter',13);
    await wait('!' + el('#material-remove-dialog') + '.open && document.activeElement===' + el(red) + ' && ' + tracks + '===1', '默认回车取消并还回素材焦点');
    await rightClick(red); await click(menu); await click('#material-remove-confirm');
    await wait('!' + el(red) + ' && ' + tracks + '===0', '右键确认移除后清除在用片段');
    await undo();
    await wait(el(red) + '?.dataset.used==="true" && ' + tracks + '===1', 'Ctrl+Z 应恢复素材及已用标记');

    await click(red + ' ~ .material-select');
    await click(still + ' ~ .material-select');
    await rightClick(still);
    await click(menu);
    await wait(el('#material-remove-dialog') + '.open && '+ el('#material-remove-detail')+'.textContent.includes("2 项素材")', '多选提示应包含全部选中项');
    await key('Escape',27);
    await wait(count('#material-list input:checked')+'===2 && '+tracks+'===1 && !'+el('#material-remove-dialog')+'.open', 'Esc 取消后保留原多选和片段');
    await rightClick(still); await click(menu); await click('#material-remove-confirm');
    await wait('!' + el(red) + ' && !' + el(still) + ' && ' + tracks + '===0', '右键已勾选项应一起移除已用视频和未用图片');
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
    const back = '#material-breadcrumb .material-back';
    assert.equal(await read(el(back) + '.getAttribute("aria-label")'), '返回上一级');
    assert.equal(await read(el(back + ' use') + '.getAttribute("href")'), '#icon-chevron');
    win.setContentSize(900, 720);
    await wait('window.innerWidth <= 940', '应切换到紧凑布局');
    await point(back);
    assert.ok(await read('(() => { const bounds=' + el(back) + '.getBoundingClientRect();'
      + 'return bounds.width >= 28 && bounds.height >= 26 && ' + el(back + ' + span') + '.clientWidth > 40; })()'),
    '紧凑窗口应保留返回按钮命中区和可读的目录路径');
    for (const theme of ['light', 'dark']) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await wait('document.documentElement.dataset.theme===' + JSON.stringify(theme), '返回按钮应跟随主题');
      await read(el(back) + '.focus()');
      assert.ok(await read(el(back) + '.matches(":focus-visible") && getComputedStyle(' + el(back) + ').outlineWidth === "2px"'),
        '键盘焦点应有独立外框');
    }
    win.setContentSize(1400, 960);
    await wait('window.innerWidth > 940', '恢复标准窗口');
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
    await key('Enter', 13);
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
    await wait(el('#material-remove-dialog')+'.open','素材卡 Delete 应确认使用范围');
    await click('#material-remove-confirm');
    await wait('!' + el(red) + ' && ' + tracks + '===0', '素材卡 Delete 移除素材及对应轨道片段');
    await undo();
    await wait('!!'+el(red)+' && '+tracks+'===1', '一次撤销恢复库条目与轨道');
    picks.push({ title: '选择素材文件', files: [files.red] });
    await click('#material-import');
    await click('#material-import-files');
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
    const accent = 'getComputedStyle(' + el('#timeline-selection-count') + ').color';
    assert.equal(foldedRing, await read(accent));
    await click(fold);
    const green = item('material-tile', files.green);
    await dropFiles('#materials-heading', [files.green, nested]);
    await wait('!!' + el(green) + ' && !!' + el(child) + ' && ' + tracks + '===2', '拖入文件和文件夹只应扩充素材库');
    await wait(el(green + ' img') + '?.naturalWidth > 0 && !!' + el(green + ' .material-duration') + '?.textContent', '素材卡片应有实帧和时长');
    const usedBadge = el(green + ' .material-used');
    assert.equal(await read(usedBadge), null, '未使用的素材没有已用徽标');
    await mouseClick(green);
    await wait(el(green) + '.ariaPressed==="true" && ' + count('#timeline-clock .material-instance') + '===0',
      '选择未用素材应清除所有旧的轨道高亮');
    await wait(el(folder + ' .folder-preview img') + '?.naturalWidth > 0', '素材目录应有实帧封面');
    await read('window.savedTile=' + el(green) + '; window.savedImage=window.savedTile.querySelector("img")');
    await dropFiles('.sequence-video [data-drop-shot="0"]', [files.green]);
    await wait(tracks + '===3 && ' + count('.shot') + '===2', '文件拖到已有分镜应只增加候选');
    assert.ok(await read('window.savedTile===' + el(green) + ' && window.savedImage===' + el(green + ' img')), '添加候选应复用原素材卡片及已解码帧');
    assert.equal(await read(usedBadge + '?.textContent'), '已用', '使用后应立刻显示文字徽标');
    await undo();
    await wait(tracks + '===2 && !' + usedBadge, '撤销使用后应立刻移除徽标');
    await dropFiles('.sequence-video [data-drop-shot="0"]', [files.green]);
    await wait(tracks + '===3', '应可重新加入候选');
    await dropFiles('#new-shot-drop', [files.still, files.blue]);
    await wait(tracks + '===5 && ' + count('.shot') + '===4', '两个文件拖到空白区应建立两个分镜');
    const greenBlock = '.sequence-video [data-move-candidate][data-candidate-index="1"][data-drop-shot="0"]';
    await mouseClick(greenBlock);
    await wait(el(greenBlock) + '.matches(".sequence-marked")', '先选中轨道上的绿色候选');
    await read('window.greenBlock=' + el(greenBlock));
    const cursorPosition = el('.sequence-cursor') + '.style.translate';
    const beforeLocate = await read(cursorPosition);
    await mouseClick(green);
    await wait(count('.sequence-video .material-instance') + '===1', '切换选中素材应清除旧的高亮');
    assert.equal(await read(el(greenBlock) + '===window.greenBlock && window.greenBlock.matches(".material-instance")'), true,
      '定位素材应直接更新现有轨道对象');
    assert.equal(await read('document.activeElement===' + el(green)), true, '定位后焦点应留在素材库');
    assert.equal(await read(cursorPosition), beforeLocate, '定位不应移动播放头');
    await mouseClick(greenBlock, 'left', 1, 2);
    await wait('window.greenBlock.matches(".material-instance.sequence-marked")', 'Ctrl 加选轨道片段可与素材库定位同时显示');
    assert.equal(await read('getComputedStyle(' + el(green + ' .material-duration') + ').color'), 'rgb(255, 255, 255)');
    for (const theme of ['dark', 'light']) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await wait('document.documentElement.dataset.theme===' + JSON.stringify(theme), '素材卡应能切换主题');
      const frame = 'getComputedStyle(window.greenBlock, "::after")';
      const tab = 'getComputedStyle(window.greenBlock.querySelector(".sequence-clip-label"))';
      const edit = 'getComputedStyle(window.greenBlock, "::before")';
      assert.ok(await read('["Top","Right","Bottom","Left"].every(edge => ' + frame + '["border"+edge+"Width"]==="3px" && '
        + frame + '["border"+edge+"Color"]===' + accent + ') && ' + frame + '.pointerEvents==="none"'), '明暗主题都应显示不拦截鼠标的四边系统蓝框');
      assert.equal(await read(tab + '.backgroundColor'), await read(accent), '文件名底色应与轨道高亮一致');
      assert.notEqual(await read(tab + '.color'), await read(accent), '文件名需要可读的对比色');
      assert.ok(await read(edit + '.borderLeftWidth==="3px" && ' + edit + '.borderLeftColor!==' + accent), '编辑选区应保留独立标记');
      assert.equal(await read('getComputedStyle(' + el(green + ' .material-thumbnail') + ').outlineColor'), await read(accent),
        '点选素材缩略图应使用同一系统蓝');
      assert.equal(await read('getComputedStyle(' + usedBadge + ').borderInlineStartColor'), await read(accent),
        '已用徽标侧线应和轨道同源标记采用同一系统蓝');
      if (process.env.JIAJIAN_LIBRARY_CAPTURE) {
        const frame = await read('(() => {const r=' + el('#materials-pane') + '.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()');
        const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { clip: frame });
        const filename = path.parse(process.env.JIAJIAN_LIBRARY_CAPTURE);
        await fs.writeFile(path.join(filename.dir, filename.name + '-' + theme + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }
    const zoom = el('#track-zoom');
    await read(zoom + '.value=' + zoom + '.min;' + zoom + '.dispatchEvent(new Event("input"))');
    await wait('window.greenBlock.offsetWidth<=112 && getComputedStyle(window.greenBlock.querySelector(".sequence-clip-duration")).display==="none"',
      '窄片段应把标签空间留给文件名');
    assert.ok(await read('window.greenBlock.querySelector(".sequence-clip-name").clientWidth>0'), '窄片段的文件名仍有可见空间');
    await click('#timeline-fit');
    await wait(el(greenBlock) + '.matches(".material-instance") && ' + el(greenBlock) + '!==window.greenBlock',
      '适配导致重新绘制后，同源提示应跟随片段');
    await mouseClick(greenBlock);
    await wait(count('#timeline-clock .material-instance') + '===0', '转入轨道预览应清除素材库定位');
    await dropFiles('.sequence-voice [data-voice-row="0"]', [files.music]);
    await wait(el('.sequence-voice [data-voice-row="0"]') + '.textContent.includes(' + JSON.stringify(path.basename(files.music)) + ')', '本地音频应能直接放入口播轨');
    await dropFiles('#inspector-tab-music', [files.otherMusic]);
    await wait(el('.sequence-music .sequence-block') + '?.textContent.includes(' + JSON.stringify(path.basename(files.otherMusic)) + ')', '本地音频应能直接加入配乐');
    await mouseClick('#processed-material-list li strong');
    await wait(playing + ' && ' + el('#preview-name') + '.textContent===' + JSON.stringify(path.basename(files.music)),
      '单击素材库音频应直接试听');
    await wait(count('.sequence-voice .material-instance') + '===1', '口播轨里的同一音频应显示同源标记');
    assert.equal(await read(el('#processed-material-list li[data-used] .processed-used') + '?.textContent'), '已用',
      '已经加入口播的音频卡也应有已用徽标');
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
    const savedDocument = JSON.parse(await fs.readFile(savedProject, 'utf8'));
    const saved = savedDocument.config;
    const roots = saved.libraryFolders.filter(row => row.parentId === null);
    assert.ok(roots.some(row => row.name === path.basename(nested)), '拖入的文件夹应作为独立根目录保存');
    picks.push({ title: '打开工程', files: [savedProject] });
    await click('#open-project');
    await wait(el('#notice') + '.textContent.includes("已打开工程") && !!' + el(child), '重开后应恢复拖入的目录');
    await wait(el(segment)+'?.textContent.includes('+JSON.stringify(path.basename(files.music))+')','重开工程后口播仍在第二镜第二轨');
    // Load an older catalog with repeated declarations for the same source,
    // a rendered edit of that source, and unrelated footage with the same name.
    const duplicateProject = path.join(root, '同源目录.sdworkbench');
    const source = savedDocument.assets.find(a=>a.path===files.red);
    const rendered = path.join(root, '剪辑后.mp4');
    await fs.copyFile(files.red, rendered);
    savedDocument.assets.push({...source,id:'red-copy'}, {...source,id:'red-render',path:rendered});
    const unrelated = savedDocument.assets.find(a=>a.path===files.blue);
    unrelated.path = path.join(root,path.basename(files.red));
    await fs.copyFile(files.blue, unrelated.path);
    const repeated = saved.shots[1][0];
    Object.assign(repeated,{id:'red-copy',videoLane:0,videoStart:1.5,videoDuration:.5,videoFit:'hold',videoGroup:'red-group'});
    saved.shots[1].push({...repeated,id:'red-render',videoStart:2,sourceEdit:{id:'red-copy',ranges:[{start:0,end:repeated.end}]}});
    await fs.writeFile(duplicateProject,JSON.stringify(savedDocument));
    picks.push({title:'打开工程',files:[duplicateProject]});
    await click('#open-project');
    await wait(tracks+'===6 && '+count(red)+'===3', '载入同源不同 ID、同轨重复和同名独立文件');
    await mouseClick(red); await key('Delete',46);
    await wait(el('#material-remove-detail')+'.textContent.includes("3 个对应片段")', '统计含裁切副本的三个同源实例');
    win.setContentSize(840,600);
    for (const theme of ['dark','light']) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]});
      await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme)+' && (()=>{const d='+el('#material-remove-dialog')+',r=d.getBoundingClientRect();return d.open && d.scrollWidth===d.clientWidth && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight && [...d.querySelectorAll("button")].every(b=>{const s=b.getBoundingClientRect();return document.elementFromPoint(s.x+s.width/2,s.y+s.height/2)===b})})()',
        '紧凑窗口中确认文字完整、两个按钮可达 · '+theme);
    }
    await click('#material-remove-confirm');
    await wait(tracks+'===3 && '+count(red)+'===1 && !!'+el(green)+' && '+el(segment)+'?.textContent.includes('+JSON.stringify(path.basename(files.music))+')',
      '移除同源组合片段，保留同名不同源、独立口播及其他画面');
    await undo();
    await wait(tracks+'===6 && '+count(red)+'===3','一次撤销恢复重复片段和素材');
    for (const [i, file] of [files.red, files.still].entries()) assert.deepEqual(await fs.readFile(file), originals[i]);
    assert.ok((await fs.stat(nested)).isDirectory(), '原子目录应留在磁盘');
    assert.deepEqual(picks, []);
    console.log('素材库点播、跨分镜同源标记、折叠轨道、素材拖放、目录返回、缩略图复用及明暗外观通过。');
  } finally {
    wc.debugger.detach();
    win.destroy();
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

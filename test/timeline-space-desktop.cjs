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
const { fixtures, ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-space-'));
  app.setPath('userData', path.join(root, 'electron'));
  const files = await fixtures(root);
  const records = new Map(await Promise.all(['red', 'blue', 'music'].map(async (id) =>
    [id, await inspectAsset(files[id], id==='music' ? 'audio' : 'video')])));
  const simple = path.join(root, '两个分镜.sdworkbench'), complex = path.join(root, '含包装.sdworkbench');
  const config = {
    shots: ['red', 'blue'].map((id) => [{ id, start: 0, end: 1.5 }]),
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: true,
    unordered: false, useOriginal: true, useMirrors: false, count: 1, priority: 'picture', musicIds: [], musicVolume: 50,
  };
  await saveProject(simple, config, records);
  await saveProject(complex, { ...config, musicIds:['music'], packaging: { global: [
    { kind: 'text', start: 0, end: null, text: '成片试播', x: .5, y: .65, color: '#ffffff', fontSize: 40 },
  ] } }, records);
  const narrated = path.join(root, '分段口播优先.sdworkbench');
  await saveProject(narrated, { ...config, priority:'voice', narrationMode:'segmented', voiceAlignment:'fill',
    shots:[[{id:'red',start:0,end:.2},{id:'blue',start:0,end:1.2}],[{id:'red',start:0,end:1.5}]],
    segmentNarrationIds:[['music'],['music']],shotSettings:[{duration:.4},{duration:.4}] }, records);
  const stereoFile = path.join(root,'左右声道.wav'), mixProject=path.join(root,'无声画面与配乐.sdworkbench');
  await ffmpeg(['-f','lavfi','-i','aevalsrc=0.3*sin(2*PI*440*t)*lt(t\\,1)|0.3*sin(2*PI*660*t)*gt(t\\,1.8):s=48000:d=5',stereoFile]);
  records.set('stereo',await inspectAsset(stereoFile,'audio'));
  await saveProject(mixProject,{...config,shots:[[{id:'blue',start:0,end:1.5}],[{id:'blue',start:0,end:1.5}]],
    shotSettings:[{duration:3},{duration:2}],musicIds:['stereo']},records);
  const projects = [simple, complex, narrated, mixProject];
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
  const time = '(((' + q('.sequence-cursor') + '.getBoundingClientRect().left+' + q('.sequence-cursor') + '.offsetWidth/2)-'
    + q('.sequence-ruler .sequence-content') + '.getBoundingClientRect().left)*1.5/parseFloat(' + q('.sequence-video [data-drop-shot="1"]') + '.style.left))';
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
      + "cells:Array.from(document.querySelectorAll('.sequence-video [data-drop-shot]'),e=>e.dataset.candidateIndex),priority:document.getElementById('priority').value,time:" + time + ',previewTime:' + preview + '.currentTime})');
    throw new Error(message + ' ' + JSON.stringify(info));
  }
  async function click(selector, offset, clicks = 1) {
    const point = await read('(() => {const e=' + q(selector) + ';e.scrollIntoView({block:"nearest",inline:"nearest"});'
      + 'const r=e.getBoundingClientRect(), x=r.left+' + (offset || 'r.width*.5') + ',y=r.top+r.height*.45;'
      + 'return {x,y,hit:e.contains(document.elementFromPoint(x,y))};})()');
    assert.ok(point.hit, selector + ' 可点击');
    for (let clickCount = 1; clickCount <= clicks; clickCount++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0, clickCount });
      }
    }
  }
  async function seek(seconds) {
    const px = await read('parseFloat(' + q('.sequence-video [data-drop-shot="1"]') + '.style.left)*' + (seconds / 1.5));
    await click('.sequence-ruler .sequence-content', String(px));
    await wait('Math.abs(' + time + '-' + seconds + ')<.04', '点击时间标尺应设置播放头');
  }
  const videoCell = '.sequence-video [data-drop-shot="0"]';
  async function checkPlayerLayout(width, height) {
    win.setContentSize(width, height);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    const layout = await read(`(() => {
      const rect = node => {
        const {left,right,top,bottom} = node.getBoundingClientRect();
        return {left,right,x:(left+right)/2,y:(top+bottom)/2};
      };
      const ids = ['time','duration','more','play','quality','zoom','ratio','fullscreen'];
      return {row:rect(document.querySelector('.player-control-row')),
        controls:ids.map(id=>rect(document.getElementById('player-'+id)))};
    })()`);
    const {row,controls} = layout, play = controls[3];
    assert.ok(Math.abs(play.x-row.x)<2, '播放图标应位于控制栏正中央');
    for (const [i,control] of controls.entries()) {
      assert.ok(control.right>control.left && control.left>=row.left-1 && control.right<=row.right+1, '播放器控件应完整可见');
      assert.ok(Math.abs(control.y-play.y)<2, '时间码、播放键与右侧控件应位于同一行');
      if (i) assert.ok(control.left>=controls[i-1].right-1, '相邻控件不能重叠');
    }
  }
  async function ensurePaused(input, beforeValue) {
    const before = await read(time);
    await space();
    await delay(230);
    assert.equal(await read(q(input) + '.value'), beforeValue + ' ', '编辑文字时可以输入空格');
    assert.ok(Math.abs(await read(time) - before) < .04, '编辑文字时不移动时间线播放头');
    assert.ok(await read(preview + '.paused && !(' + live + ' && !' + live + '.paused)'), '编辑文字时不播放');
  }
  async function checkControlSpace(selector, property, clickTarget = selector) {
    const state = q(selector) + '.' + property;
    const original = await read(state);
    await click(clickTarget);
    const clicked = await read(state);
    assert.notEqual(clicked, original, '鼠标点击应切换按钮状态');
    assert.ok(await read('document.activeElement===' + q(selector)), '鼠标点击后焦点应在该按钮上');
    await space(true);
    assert.equal(await read(state), clicked, '长按空格到松开后应保留按钮状态 ' + selector);
    await wait('!!' + live + ' && !' + live + '.paused && ' + time + '>.15', '操作 ' + selector + ' 后空格应启动时间线播放');
    await space();
    await wait(live + '.paused', '再次按空格应暂停时间线');
    assert.equal(await read(state), clicked, '暂停不应更改按钮状态 ' + selector);
    await click(clickTarget);
    assert.equal(await read(state), original, '再次点击应恢复按钮状态');
  }
  async function tabBackTo(selector) {
    for (const modifiers of [8, 0]) {
      const tab = {key:'Tab', code:'Tab', windowsVirtualKeyCode:9, modifiers};
      await send('dispatchKeyEvent', {...tab, type:'keyDown'});
      await send('dispatchKeyEvent', {...tab, type:'keyUp'});
    }
    await wait('document.activeElement===' + q(selector), 'Tab 应回到 ' + selector);
  }
  try {
    await read(q('#home-open-project') + '.click()');
    await wait('!!' + q(videoCell), '打开双分镜工程');
    await click(videoCell);
    const duration = q('#player-duration') + '.textContent';
    await wait(duration + '==="00:00:01:15"', '单条 1.5 秒素材应按 30 fps 显示总帧码');
    const trackMute = '[data-control-key="vis0"] [data-track-action="muted"]';
    await read('window.originalMuteButton=' + q(trackMute) + '; void 0');
    await checkControlSpace(trackMute, 'ariaPressed');
    assert.ok(await read('!window.originalMuteButton.isConnected'), '鼠标点击后空格应能处理重绘替换的静音按钮');
    await checkControlSpace('.sequence-video .track-kind', 'ariaExpanded');
    await checkControlSpace('#keep-audio', 'checked', 'label:has(> #keep-audio)');
    await tabBackTo('#keep-audio');
    const keepAudio = q('#keep-audio');
    const stopped = '!(' + live + ' && !' + live + '.paused)';
    await space();
    assert.ok(await read('!' + keepAudio + '.checked && ' + stopped), '键盘导航到开关时，空格仍可切换开关');
    await space();
    assert.ok(await read(keepAudio + '.checked && ' + stopped), '键盘可恢复原声并保持暂停');
    await seek(.08);
    await click('#player-play');
    const meter = 'Array.from(document.querySelectorAll(".stereo-meter i"),e=>Number(e.dataset.level))';
    await wait('!!' + live + ' && !' + live + '.paused && ' + meter + '.every(v=>v>0)', '中央播放按钮应播放轨道混音，左右电平随红色素材原声点亮');
    await click('#player-play');
    await wait(live + '.paused && '+meter+'.every(v=>v===0)', '暂停时电平归零');
    await checkPlayerLayout(1080,780);
    await checkPlayerLayout(1420,1000);
    await click(videoCell);
    await space(true);
    await wait('!!' + live + ' && !' + live + '.paused && ' + time + '>.2', '点击分镜后按住空格应连续播放工程');
    await wait(duration + '==="00:00:03:00" && '+q('#player-play')+'.getAttribute("aria-label")==="暂停"', '全线播放应展示工程总时长并切为暂停按钮');
    assert.equal(await read(q('#preview-batch-list') + '.childElementCount'), 0, '普通分镜不需要生成批量预览');
    assert.ok(await read(focus), '点击素材后空格保留时间线焦点');
    const firstSource = await read(live + '.currentSrc');
    await wait('!!' + live + ' && !!' + live + '.currentSrc && ' + live + '.currentSrc!==' + JSON.stringify(firstSource)
      + ' && ' + time + '>1.65', '连续试播应切换到第二个分镜');
    await wait(meter+'.every(v=>v===0)', '蓝色无声素材播放时电平应归零');
    await space();
    const paused = await read(time);
    const shownFrame = await read('[' + live + '.currentSrc,' + live + '.currentTime]');
    const clockParts = (await read(q('#player-time')+'.textContent')).split(':').map(Number);
    const clockSeconds = clockParts[0]*3600 + clockParts[1]*60 + clockParts[2] + clockParts[3]/24;
    assert.ok(Math.abs(clockSeconds-paused)<1/24+.01, '暂停时当前帧码应与工程播放头对应');
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
    const clock = q('#timeline-clock'), rulerHead = q('.sequence-ruler .sequence-head');
    assert.ok(await read(clock + '.matches(":focus-visible")'), '点击标尺后按空格，时间线获得键盘焦点');
    assert.equal(await read('getComputedStyle(' + clock + ').outlineStyle'), 'none', '播放后时间线上下不应显示整幅焦点边框');
    const rulerFocus = 'getComputedStyle('+q('.sequence-ruler .sequence-head')+', "::after").content';
    assert.equal(await read(rulerHead + '.textContent'), '', '时间尺左侧保留空白轨头');
    assert.equal(await read(q('.sequence-ruler .sequence-content') + '.getAttribute("aria-label")'), '时间标尺');
    assert.equal(await read(q('.sequence-ruler .sequence-content') + '.getBoundingClientRect().left'), await read(q('.sequence-video .sequence-content') + '.getBoundingClientRect().left'), '时间零点与视频轨道对齐');
    assert.equal(await read(rulerFocus),'none','播放中隐藏时间线的导航焦点提示');
    await space();
    assert.notEqual(await read(rulerFocus),'none','暂停后键盘焦点可以在轨头分界处辨认');
    await click('#timeline-play');
    await wait('!!' + live + ' && !' + live + '.paused', '工具栏播放按钮可从暂停位置续播');
    assert.equal(await read('getComputedStyle(' + clock + ').outlineStyle'), 'none', '点击播放按钮不会描边整个时间线');
    await click('#player-play');
    await wait(live + '.paused', '播放器中央按钮应暂停时间线正在播出的画面');
    await click('#material-search');
    await ensurePaused('#material-search', '');
    await click(videoCell, 'r.width*.35', 2);
    const cutPreview = '#player-pane[data-cut-monitor] .video-cut-preview';
    const cutVideo = q(cutPreview + ' video');
    await wait('!!' + cutVideo + ' && ' + cutVideo + '.readyState>=2', '双击片段应进入原片剪辑');
    await click(cutPreview);
    await space();
    await wait('!' + cutVideo + '.paused && ' + cutVideo + '.currentTime>.05', '剪辑预览上的空格应播放当前片段');
    assert.ok(await read('!(' + live + ' && !' + live + '.paused)'), '片段播放独立于时间线播放');
    await space();
    await wait(cutVideo + '.paused', '再次按空格应暂停片段');
    await click('#timeline-cut-editor [data-action="cancel"]');
    await read(q('#open-project') + '.click()');
    const textLayer = '.sequence-layer.kind-text .sequence-block';
    await wait('!!' + q(textLayer), '打开带全局文字包装的工程');
    await read(q(textLayer) + '.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    const textField = '.sequence-dialog[open] textarea';
    await wait('!!' + q(textField), '打开文字包装编辑器');
    await read(q(textField) + '.focus();' + q(textField) + '.setSelectionRange(' + q(textField) + '.value.length,' + q(textField) + '.value.length)');
    await ensurePaused(textField, await read(q(textField) + '.value'));
    await read(q('.sequence-dialog[open]') + '.close()');

    await seek(1.84);
    await space();
    await wait('!!' + live + ' && !' + live + '.paused && ' + time + '>1.84', '含包装且分镜已填满时空格播放时间线');
    await wait(meter+'.every(v=>v>0)', '即使选中的画面没有原声，单独配乐轨也应驱动电平');
    assert.equal(await read(q('#preview-batch-list') + '.childElementCount'), 0, '空格播放不生成批量预览');
    assert.ok(await read(tracks + ' && ' + focus), '时间线试播保留轨道和键盘焦点');
    await space();
    await read(q('#open-project') + '.click()');
    const alternate = '.sequence-video [data-drop-shot="0"][data-candidate-index="1"]';
    await wait('!!'+q(alternate)+' && '+q('#priority')+'.value==="voice"', '载入分段口播优先工程');
    await click(alternate);
    await space();
    const voice = q('.draft-transport-preview:not([hidden]) audio');
    await wait('!!'+live+' && !'+live+'.paused && '+live+'.currentSrc==='+preview+'.currentSrc && Math.abs('+live+'.playbackRate-3)<.01 && !!'+voice+' && !'+voice+'.paused && '+voice+'.playbackRate===1',
      '空格应使用选中的第二候选，三倍速画面对齐原速口播');
    assert.equal(await read(q('#preview-batch-list')+'.childElementCount'),0);
    await read(q('#open-project')+'.click()');
    await wait(q('#notice')+'.textContent.includes("无声画面与配乐")','载入双声道验证工程');
    await click(videoCell);
    await click('#player-play');
    await wait(meter+'[0]>0 && '+meter+'[1]===0','配乐开头只有左声道');
    await wait(meter+'.every(v=>v===0) && '+live+' && !'+live+'.paused','轨道继续播放时，素材的无声段归零');
    await wait(meter+'[0]===0 && '+meter+'[1]>0','右声道信号应单独点亮');
    const mute='[data-control-key="music0"] [data-track-action="muted"]';
    await click(mute);
    await wait(meter+'.every(v=>v===0) && '+live+' && !'+live+'.paused','配乐静音后，播放继续而电平归零');
    await click(mute);
    await wait(meter+'[1]>0','解除静音后电平随声恢复');
    await click('#player-play');
    await wait(live+'.paused','验证键盘命令前应暂停时间线');
    await read(q('#add-shot')+'.focus()');
    await tabBackTo('#add-shot');
    const candidateButtons = 'document.querySelectorAll(".add-candidate").length';
    const beforeAdd = await read(candidateButtons);
    await space();
    await wait(candidateButtons+'==='+ (beforeAdd + 1), 'Tab 到新增分镜后空格应执行一次新增命令');
    assert.ok(await read(stopped), '键盘激活新增分镜时应保持暂停');
    assert.deepEqual(projects, []);
    console.log('轨头静音与折叠、检查器开关、时间线与片段空格播停、文本输入、跨分镜、电平与配乐静音恢复均已通过。');
  } finally {
    win.webContents.debugger.detach();
    win.destroy();
  }
}
check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { fixtures } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-selection-'));
  const library = path.join(root, '素材目录');
  const project = path.join(root, '素材移除.sdworkbench');
  const picks = [];
  const openedPickers = [];
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog(_win, options) {
      openedPickers.push(options.title);
      const next = picks.shift();
      assert.equal(options.title, next?.title);
      return { canceled: false, filePaths: next.files };
    },
    async showSaveDialog(_win, options) {
      assert.equal(options.title, '保存工程');
      return { canceled: false, filePath: project };
    },
  } });
  await fs.mkdir(library);
  const files = await fixtures(library);
  const original = await fs.readFile(files.red);
  win.setContentSize(1400, 960);
  const read = (expression) => win.webContents.executeJavaScript(expression, true);
  const query = (selector) => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const count = (selector) => 'document.querySelectorAll(' + JSON.stringify(selector) + ').length';
  const click = (selector) => read(query(selector) + '.click()');
  async function wait(condition, label) {
    const end = Date.now() + 16000;
    while (Date.now() < end) {
      if (await read(condition)) return;
      await delay(50);
    }
    const state = await read('({notice:document.querySelector("#notice").textContent,focus:document.activeElement.outerHTML.slice(0,240),selected:document.querySelectorAll(".sequence-marked").length})');
    throw new Error(label + ' ' + JSON.stringify(state));
  }
  win.webContents.debugger.attach();
  const send = (method, params) => win.webContents.debugger.sendCommand('Input.' + method, params);
  const mouse = (type, x, y) => send('dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
  async function pressKey(key, code, modifiers = 0) {
    const event = { key, code:key.length === 1 && /[a-z]/i.test(key) ? 'Key'+key.toUpperCase() : key,
      modifiers, windowsVirtualKeyCode:code, nativeVirtualKeyCode:code };
    await send('dispatchKeyEvent', { ...event, type:'rawKeyDown' });
    await send('dispatchKeyEvent', { ...event, type:'keyUp' });
  }
  const pressDelete = () => pressKey('Delete', 46);
  async function pointerPoint(selector) {
    const point = await read('(() => {const el=' + query(selector) + ';el.scrollIntoView({block:"nearest",inline:"nearest"});'
      + 'const r=el.getBoundingClientRect();for (const n of [.5,.25,.65,.85,.12]) {const x=r.left+r.width*n,y=r.top+r.height/2;if(el.contains(document.elementFromPoint(x,y)))return {x,y};}return null;})()');
    assert.ok(point, selector + ' 应可用鼠标点击');
    return point;
  }
  async function actualClick(selector) {
    const point=await pointerPoint(selector);
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  }
  const videoMenu = '#video-track-menu[role="menu"]:popover-open';
  const commands = ['删除','向左插入分镜','向右插入分镜'];
  async function rightClickVideo(point) {
    await read('window.videoRightClickCancelled=false;'
      +'window.addEventListener("contextmenu",e=>{window.videoRightClickCancelled=e.isTrusted && e.defaultPrevented},{once:true})');
    for (const type of ['mousePressed','mouseReleased']) {
      await send('dispatchMouseEvent',{type,...point,button:'right',buttons:type==='mousePressed'?2:0,clickCount:1});
    }
    assert.ok(await read('window.videoRightClickCancelled'),'视频轨右键应接管系统菜单');
  }
  async function openVideoMenu(point, disabled = []) {
    await rightClickVideo(point);
    await wait('!!'+query(videoMenu),'在视频轨打开菜单');
    assert.ok(await read('document.activeElement==='+query(videoMenu)),'鼠标打开时焦点留在菜单本身');
    const items = await read('[...'+query(videoMenu)+'.querySelectorAll(\'[role="menuitem"]\')].map(b=>[b.textContent.trim(),b.disabled])');
    assert.deepEqual(items, commands.map(label => [label, disabled.includes(label)]));
    await wait(`(() => {
      const r=${query(videoMenu)}.getBoundingClientRect(), x=${point.x}, y=${point.y};
      return r.left>=-1 && r.right<=innerWidth+1 && r.top>=-1 && r.bottom<=innerHeight+1
        && x>=r.left-8 && x<=r.right+8 && y>=r.top-8 && y<=r.bottom+8;
    })()`,'菜单应靠近右击处并完整显示在窗口内');
  }
  async function chooseVideoCommand(action) {
    await actualClick(videoMenu+' [data-action="'+action+'"]');
    await wait('!'+query(videoMenu),'执行命令后关闭菜单');
  }
  async function checkSilentVideoPoint(point) {
    await rightClickVideo(point);
    assert.ok(await read('!document.querySelector("dialog[open],:popover-open")'),'轨头、行间空白和锁定视频轨应保持菜单关闭');
  }
  const undo = () => click('#track-undo');
  const video = '.sequence-video .sequence-block[data-selectable]';
  const shotCount=count('.sequence-shots [data-reorder-shot]');
  const music = '.sequence-music .sequence-block[data-selectable]';
  const voice = '.sequence-voice .sequence-block[data-selectable]';
  const layer = '.sequence-layer .sequence-block[data-selectable]';
  const tile = (file) => '.material-tile[title=' + JSON.stringify(path.basename(file)) + ']';
  const slot='.sequence-video .sequence-empty[data-drop-shot="0"]';
  const wholeSlot='.sequence-voice .sequence-empty[data-voice-row="0"]';
  const segmentSlot=wholeSlot+'[data-voice-shot="1"]';
  const setVoiceMode = mode => read(query('#narration-mode')+'.value='+JSON.stringify(mode)+';'+query('#narration-mode')+'.dispatchEvent(new Event("change",{bubbles:true}))');
  async function clickBlank(selector) {
    await actualClick(selector);
    assert.ok(await read(query(selector)+'.textContent==="" && '+query(selector)+'.tabIndex<0 && !'+query(selector)+'.matches("button,[role=button]") && document.activeElement.id==="timeline-clock"'),
      '空轨格应无文字，点击后焦点留在时间线');
  }
  try {
    await clickVisible(win.webContents,'#home-create');
    await wait('!!'+query(slot),'空工程的视频轨道应有素材落点');
    await openVideoMenu(await pointerPoint(slot),['删除']);
    await chooseVideoCommand('right');
    await wait(shotCount+'===1 && '+count(video)+'===0','从空工程占位建立第一个空分镜');
    await undo();
    await wait(shotCount+'===0 && !!'+query(slot),'撤销恢复空工程占位');
    await clickBlank(slot);
    await clickBlank(wholeSlot);
    await pressKey('Enter',13);
    await pressKey(' ',32);
    assert.ok(await read(query(slot)+'.tabIndex<0 && !'+query(slot)+'.matches("button,[role=button]") && document.activeElement.id==="timeline-clock"'),'空位是静态落点，键盘焦点留在时间线');
    assert.deepEqual(openedPickers,[],'点击空工程落点及按回车、空格均不应打开文件框');
    picks.push({ title: '选择素材文件', files: [files.red, files.green, files.blue] });
    await actualClick('#material-import');
    await actualClick('#material-import-files');
    await wait(count(video)+'===3 && '+count('.material-used')+'===3','三个素材均应标记已用');
    await actualClick(video);
    await pressDelete();
    await wait(count(video)+'===2 && !'+query(tile(files.red))+'.dataset.used','删除一个候选应移除它的使用标志并保留源素材');
    await actualClick(video);
    await wait(count(video+'.sequence-marked')+'===1','点选已有候选');
    await clickBlank(slot);
    await wait(count(video+'.sequence-marked')+'===0','点击已建分镜空位应像轨道空白一样清除选区');
    const emptyPoint=await pointerPoint(slot), nextPoint=await pointerPoint(video);
    await mouse('mousePressed',emptyPoint.x,emptyPoint.y);await mouse('mouseMoved',nextPoint.x,nextPoint.y);
    await mouse('mouseReleased',nextPoint.x,nextPoint.y);
    await wait(count(video+'.sequence-marked')+'===1','可从空候选格开始框选相邻素材');
    assert.deepEqual(openedPickers,['选择素材文件'],'只有素材库显式导入打开了文件框');
    await undo();
    await wait(count(video)+'===3 && '+query(tile(files.red))+'.dataset.used==="true"','撤销应恢复视频及使用标志');
    await setVoiceMode('segmented');
    await wait('!!'+query(segmentSlot),'分镜应显示自己的空口播落点');
    await actualClick(video);
    await clickBlank(segmentSlot);
    assert.equal(await read(count(video+'.sequence-marked')),0,'点击空口播格清除选区');
    const fromVoice=await pointerPoint(segmentSlot), toVideo=await pointerPoint(video);
    await mouse('mousePressed',fromVoice.x,fromVoice.y);await mouse('mouseMoved',toVideo.x,toVideo.y);
    await mouse('mouseReleased',toVideo.x,toVideo.y);
    await wait(count(video+'.sequence-marked')+'>0','可从分镜口播空格开始框选素材');
    assert.deepEqual(openedPickers,['选择素材文件'],'从口播空格起拖或松手应保留文件框的关闭状态');
    await setVoiceMode('whole');
    await wait('!!'+query(wholeSlot)+' && !'+query(segmentSlot),'恢复整段口播');

    const box = await read('(() => {const [a,b]=document.querySelectorAll('+JSON.stringify(video)+');a.scrollIntoView({block:"nearest",inline:"nearest"});'
      +'const one=a.getBoundingClientRect(),two=b.getBoundingClientRect(),row=a.closest(".sequence-row").getBoundingClientRect();'
      +'const x=one.left+one.width*.45,y=row.top+1.4;return {x,y,toX:two.left+two.width*.65,toY:two.top+two.height*.62,hit:document.elementFromPoint(x,y)?.className};})()');
    assert.match(box.hit,/sequence-content/,'从轨道空白处框选');
    await actualClick(video);
    const originalSelection = await read(query(video+'.sequence-marked')+'.textContent');
    await checkSilentVideoPoint({x:box.x,y:box.y});
    await mouse('mousePressed',box.x,box.y);
    await mouse('mouseMoved',box.toX,box.toY);
    await wait(count(video+'.sequence-marked')+'===2','拖动中应预览两个候选');
    await pressKey('Escape',27);
    await wait(query('.timeline-marquee')+'.hidden','Esc 应立即收起时间线选框');
    await mouse('mouseReleased',box.toX,box.toY);
    assert.equal(await read(count(video+'.sequence-marked')),1,'取消后松手应保留原来的单选');
    assert.equal(await read(query(video+'.sequence-marked')+'.textContent'),originalSelection);
    await mouse('mousePressed',box.x,box.y);
    await mouse('mouseMoved',(box.x+box.toX)/2,box.toY);
    await mouse('mouseMoved',box.toX,box.toY);
    await mouse('mouseReleased',box.toX,box.toY);
    await wait(count(video+'.sequence-marked')+'===2','鼠标框选两个候选');
    await pressDelete();
    await wait(count(video)+'===1 && '+count('.material-used')+'===1','单次 Del 移除两个候选');
    await undo();
    await wait(count(video)+'===3 && '+count('.material-used')+'===3','一次撤销恢复整个选区');

    picks.push({ title:'选择配乐', files:[files.music] });
    await click('#inspector-tab-music');
    await click('#pick-music');
    await wait(count(music)+'===1','添加配乐');
    picks.push({ title:'选择口播音频', files:[files.otherMusic] });
    await click('#inspector-tab-narration');
    if (!await read(query('#whole-track-settings')+'.open')) await click('#whole-track-summary');
    await click('#pick-narration');
    await wait(count(voice)+'===1','添加口播');
    await actualClick(video);
    await click('#track-more');
    await click('#clip-actions');
    await read('[...document.querySelectorAll(".sequence-dialog[open] button")].find(button=>button.textContent==="候选包装").click()');
    await read('(() => {const d=document.querySelector(".sequence-dialog[open]");d.querySelector("textarea").value="删除验收";d.querySelector("form").requestSubmit()})()');
    await wait(count(layer)+'===1','添加包装文字');
    await actualClick(video);
    await click('#timeline-play');
    const monitor='.draft-transport-preview:not([hidden])', title=monitor+' .draft-text-overlay';
    await wait(query(title)+'?.textContent==="删除验收"','时间线播放器显示当前片段的文字包装');
    await click('#timeline-play');
    await read('window.checkedTrackVideo='+query(monitor+' video'));
    assert.ok(await read('!!window.checkedTrackVideo'));
    const layerEye='.sequence-layer [data-track-action="hidden"]';
    await actualClick(layerEye);
    await wait('!'+query(title)+' && '+query(layerEye)+'.ariaPressed==="true"','关闭眼睛立即隐藏暂停帧上的文字');
    await actualClick(layerEye);
    await wait(query(title)+'?.textContent==="删除验收"','再次打开眼睛在原帧恢复文字');
    assert.ok(await read('window.checkedTrackVideo==='+query(monitor+' video')+' && window.checkedTrackVideo.paused'),'切眼睛保留播放器节点和暂停状态');
    for (const [name, target] of [['配乐',music], ['包装',layer], ['口播',voice]]) {
      await actualClick(target);
      await pressDelete();
      await wait(count(target)+'===0', name+'选中后按 Del');
      await undo();
      await wait(count(target)+'===1',name+'撤销后恢复');
    }

    picks.push({ title:'选择素材文件夹',files:[library] });
    await click('#material-import');
    await click('#material-import-directory');
    await wait('!!'+query('#material-folders .material-folder'),'添加素材目录');
    await read(query('#material-folders .material-folder') + '.dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))');
    await wait(query(tile(files.red))+'?.dataset.used==="true" && !!'+query(tile(files.still))+' && !'+query(tile(files.still))+'.dataset.used','文件夹应区分已用与未用素材');
    await click('#add-shot');
    const emptyShot='.sequence-video .sequence-empty[data-drop-shot="3"]';
    await wait('!!'+query(emptyShot),'新建空分镜保留候选落点');
    const libraryDrop = selector=>'(() => {const source='+query(tile(files.red))+',target='+query(selector)+',dt=new DataTransfer();'
      +'for(const [el,type] of [[source,"dragstart"],[target,"dragover"],[target,"drop"],[source,"dragend"]])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));})()';
    await read(libraryDrop(emptyShot));
    await wait(count(video)+'===4 && '+query(video+'[data-drop-shot="3"]')+'?.title.includes("红色")','从素材库拖入空分镜应落在该格');
    await undo();await wait('!!'+query(emptyShot),'撤销拖入应恢复空位');
    await undo();await wait('!'+query(emptyShot),'撤销新增分镜');
    await read(libraryDrop('.sequence-video [data-drop-shot="1"]'));
    await wait(count(video)+'===4 && '+query(tile(files.red)+' .material-used')+'.title.includes("1、2")','重复源文件用于两个分镜时应标出两个分镜号');
    const pickCount=openedPickers.length;
    const secondRow=slot+'[data-candidate-index="1"]';
    await actualClick(video);
    const cell=(shot,lane)=>video+'[data-drop-shot="'+shot+'"][data-candidate-index="'+lane+'"]';
    const secondUpper=cell(1,0), secondLower=cell(1,1);
    const redName=path.basename(files.red), greenName=path.basename(files.green);
    const owns=(selector,name)=>query(selector+' .sequence-clip-name')+'?.textContent==='+JSON.stringify(name);
    const undoKey=()=>pressKey('z',90,2), redoKey=()=>pressKey('y',89,2);
    const originalOrder=shotCount+'===3 && '+owns(cell(0,0),redName)+' && '+owns(secondUpper,greenName)+' && '+owns(secondLower,redName);
    await wait(originalOrder,'第二镜上下轨应分别为绿色和红色候选');
    await openVideoMenu(await pointerPoint(secondRow),['删除']);
    await pressKey('ArrowDown',40);
    assert.equal(await read('document.activeElement.dataset.action'),'left','从菜单向下跳过空格上禁用的删除命令');
    await pressKey('Escape',27);
    await wait('!'+query(videoMenu)+' && document.activeElement.id==="timeline-clock"','从空格取消菜单后焦点返回时间线');
    await openVideoMenu(await pointerPoint(secondUpper));
    await pressKey('ArrowUp',38);
    assert.equal(await read('document.activeElement.dataset.action'),'right','从菜单向上到最后一项');
    await pressKey('Escape',27);
    await wait('!'+query(videoMenu)+' && document.activeElement==='+query(secondUpper),'取消候选菜单后焦点返回右击的片段');
    await pressKey('F10',121,8);
    await wait('!!'+query(videoMenu),'Shift+F10 对焦点候选显示同一菜单');
    assert.equal(await read('document.activeElement.dataset.action'),'delete','键盘打开时焦点落在首个可用命令');
    await pressKey('Escape',27);
    await actualClick(cell(0,0));
    const cursorPoint=await read(`(() => {
      const target=${query(cell(0,0))}.getBoundingClientRect(), cursor=${query('.sequence-cursor')}.getBoundingClientRect();
      const x=cursor.right-1, y=target.top+target.height/2;
      return document.elementFromPoint(x,y)?.matches('.sequence-cursor') && {x,y};
    })()`);
    assert.ok(cursorPoint,'播放头应覆盖候选起点');
    await openVideoMenu(cursorPoint);
    await pressKey('Escape',27);
    await openVideoMenu(await pointerPoint(secondLower));
    await chooseVideoCommand('delete');
    await wait(count(video)+'===3 && !'+query(secondLower)+' && '+owns(cell(0,0),redName)+' && '+owns(secondUpper,greenName),
      '从第二轨删除只移除右击的候选，保留其他分镜的同源素材及同镜上轨');
    await undoKey(); await wait(originalOrder,'Ctrl+Z 恢复删除的指定候选');
    await openVideoMenu(await pointerPoint(secondLower));
    await chooseVideoCommand('left');
    const leftInserted=shotCount+'===4 && !'+query(video+'[data-drop-shot="1"]')+' && '+owns(cell(2,0),greenName)+' && '+owns(cell(2,1),redName);
    await wait(leftInserted,'在第二镜的下轨向左插入，原上下轨素材一同成为第三镜');
    await undoKey(); await wait(originalOrder,'快捷撤销左插分镜');
    await redoKey(); await wait(leftInserted,'快捷重做左插分镜');
    await undoKey(); await wait(originalOrder,'恢复三镜');
    const lastEmpty='.sequence-video .sequence-empty[data-drop-shot="2"][data-candidate-index="1"]';
    await openVideoMenu(await pointerPoint(lastEmpty),['删除']);
    await chooseVideoCommand('right');
    await wait(shotCount+'===4 && '+owns(cell(2,0),path.basename(files.blue))+' && !'+query(video+'[data-drop-shot="3"]'),
      '从最后一镜下轨的空格向右插入，形成新末镜');
    await undoKey(); await wait(originalOrder,'快捷撤销末镜插入');
    const stripLock='[data-control-key="shot-strip"] [data-track-action="locked"]';
    await actualClick(stripLock);
    await wait(query(stripLock)+'.ariaPressed==="true"','锁定分镜轨');
    await openVideoMenu(await pointerPoint(secondLower),commands.slice(1));
    await pressKey('Escape',27);
    await undoKey();
    await wait(query(stripLock)+'.ariaPressed==="false"','撤销分镜轨锁定');
    await checkSilentVideoPoint(await pointerPoint('.sequence-video .track-kind'));
    assert.equal(openedPickers.length,pickCount,'点选部分填充的候选行应保留系统文件框的关闭状态');
    await actualClick(tile(files.red));
    await pressDelete();
    await wait(count(video)+'===4 && !'+query(tile(files.red)), '从素材库移除后应保留两个分镜中的同源候选');
    assert.deepEqual(await fs.readFile(files.red), original, '删除库素材后原文件的每个字节都应保留');
    await undo();
    await wait(count(video)+'===4 && '+query(tile(files.red))+'?.dataset.used==="true"', '撤销应还原文件夹素材及其使用标记');
    await actualClick(tile(files.red));
    await pressDelete();
    await wait('!' + query(tile(files.red)), '再次移除在用素材');
    const action=(lane,command)=>'[data-control-key="'+lane+'"] [data-track-action="'+command+'"]';
    const lock=action('vis0','locked'), hide=action('vis0','hidden'), solo=action('music0','solo'), mute=action('vis0','muted');
    assert.deepEqual(await read('[...document.querySelectorAll(\'[data-lane-key="vis0"] [data-track-action]\')].map(el=>el.dataset.trackAction)'),
      ['locked','hidden','muted','solo']);
    await actualClick(video);
    await actualClick(lock);
    await wait(query(lock)+'.ariaPressed==="true"','锁定视频轨');
    assert.equal(await read(query(video)+'.closest(".sequence-content").inert'),true);
    const lockedPoint=await read('(() => {const r='+query(video)+'.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
    await checkSilentVideoPoint(lockedPoint);
    await read(query('#timeline-clock')+'.focus()');await pressDelete();
    assert.equal(await read(count(video)),4);
    await undo();await wait(query(lock)+'.ariaPressed==="false"','轨道锁可撤销');
    for(const key of [hide,solo,mute]) {
      await actualClick(key);
      await wait(query(key)+'.ariaPressed==="true"','轨头开关应立即反馈状态');
    }
    const layerHide='.sequence-layer [data-track-action="hidden"]';
    await actualClick(layerHide);
    await wait(query(layerHide)+'.ariaPressed==="true"','旧工程包装轨首次切换绑定持久轨号');
    await click('#save-project');
    await wait(query('#notice') + '.textContent.includes("工程已保存")', '保存素材库移除状态');
    picks.push({title: '打开工程', files: [project]});
    await click('#open-project');
    await wait(query('#notice') + '.textContent.includes("已打开工程")', '重新载入磁盘工程');
    assert.equal(await read(count(video) + '===4 && !' + query(tile(files.red)) + ' && !!' + query(tile(files.green))), true,
      '重开后素材仍已移除，同源轨道片段均可恢复');
    await wait([hide,solo,mute,layerHide].map(selector=>query(selector)+'.ariaPressed==="true"').join(' && '),'重开保留视频、配乐和包装轨操作');
    assert.deepEqual(picks,[]);
    console.log('视频轨右键菜单、左右插入分镜、快捷撤销重做、框选删除和同源标记通过。');
  } finally {
    win.webContents.debugger.detach();
    win.destroy();
  }
}

check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

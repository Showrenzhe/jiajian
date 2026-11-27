'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {app} = require('electron');
const {launchDesktop} = require('../src/desktop.cjs');
const {inspectAsset} = require('../src/media.cjs');
const {saveProject, loadProject} = require('../src/project-format.cjs');
const {ffmpeg} = require('./fixtures.cjs');
const {clickVisible} = require('./desktop-input.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = process.env.JIAJIAN_TIMELINE_TEST_ROOT ?? await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'jiajian-timeline-edits-'));
  app.setPath('userData',path.join(root,'electron'));
  const video = path.join(root,'测试图.mp4'), project = path.join(root,'时间线.jiajian');
  await ffmpeg(['-f','lavfi','-i','testsrc2=s=240x136:r=24:d=3','-c:v','libx264','-threads','2',video]);
  const visual = await inspectAsset(video,'video');
  const clip = {id:'video',start:0,end:3};
  await saveProject(project,{
    ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:false,unordered:false,useOriginal:true,useMirrors:false,
    count:1,priority:'picture',musicVolume:30,musicIds:[],shots:[[clip],[clip]],
    packaging:{global:[{kind:'text',start:0,end:.6,text:'校对',x:.5,y:.65,color:'#ffffff',fontSize:40}]},
  },new Map([['video',visual]]));
  const win = await launchDesktop({show:false,dataDirectory:path.join(root,'run-data'),
    dialogs:{showOpenDialog:async()=>({canceled:false,filePaths:[project]})}});
  win.setContentSize(1366,768);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = js => wc.executeJavaScript(js,true);
  const send = (method,data) => wc.debugger.sendCommand('Input.'+method,data);
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  const click = selector => clickVisible(wc,selector);
  const host = '#timeline-clock', ruler = '.sequence-ruler .sequence-content';
  const mark = '[data-timeline-marker]', band = '[data-timeline-range]', guide = '.timeline-snap-overlay';
  const first = '.sequence-video [data-move-candidate]', status = '#timeline-shuttle-status';
  const edge = '.sequence-layer.kind-text .sequence-block > .sequence-edge:last-child';
  const scale = 'parseFloat('+q(ruler)+'.style.getPropertyValue("--timeline-second"))';
  const cursor = '(('+q('.sequence-cursor')+'.getBoundingClientRect().left+'+q('.sequence-cursor')+'.offsetWidth/2-'+q(ruler)+'.getBoundingClientRect().left)/'+scale+')';
  let stage = '打开工程';
  async function wait(js, label=js) {
    const until = Date.now()+7500;
    while(Date.now()<until) {
      if(await read(js)) return;
      await delay(30);
    }
    const info = await read('({notice:'+q('#notice')+'.textContent,focus:document.activeElement.id||document.activeElement.className,dialog:document.querySelector("dialog:modal")?.className})');
    throw new Error(stage+' / '+label+' '+JSON.stringify(info));
  }
  const keyInfo = {' ':[32,'Space'],Escape:[27,'Escape'],Enter:[13,'Enter'],'.':[190,'Period'],',':[188,'Comma'],Alt:[18,'AltLeft']};
  async function keyEvent(type,key,modifiers=0) {
    const [vk,code] = keyInfo[key] ?? [key.toUpperCase().charCodeAt(0),'Key'+key.toUpperCase()];
    await send('dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers});
  }
  async function key(name,modifiers=0) {
    await keyEvent('rawKeyDown',name,modifiers);
    await keyEvent('keyUp',name,modifiers);
  }
  async function point(selector,offset='r.width/2') {
    return read('(async()=>{const e='+q(selector)+';e.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"});await new Promise(requestAnimationFrame);const r='+q(selector)+'.getBoundingClientRect();return {x:r.left+('+offset+'),y:r.top+r.height*.5}})()');
  }
  async function mouse(type,p,extra={}) {
    await send('dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...extra});
  }
  async function pressAt(selector, offset, double=false) {
    const p = await point(selector,offset);
    for(const clickCount of double ? [1,2] : [1]) {
      await mouse('mousePressed',p,{clickCount});
      await mouse('mouseReleased',p,{clickCount});
    }
  }
  async function seek(seconds) {
    await pressAt(ruler,scale+'*'+seconds);
    await wait('Math.abs('+cursor+'-'+seconds+')<.04','点击标尺 '+seconds+' 秒');
  }
  async function menu(id) {
    await click('#track-more');
    await wait(q('#track-more-options')+'.matches(":popover-open")');
    await click('#timeline-'+id);
  }
  async function snapshot(scheme) {
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
    await wait('document.documentElement.dataset.theme==='+JSON.stringify(scheme)+' && !document.documentElement.hasAttribute("data-theme-changing")');
    await wait(q(mark)+'.getBoundingClientRect().width>0 && '+q('#timeline-snap')+'.checkVisibility()');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    if (process.env.JIAJIAN_TIMELINE_EVIDENCE) {
      const folder = process.env.JIAJIAN_TIMELINE_EVIDENCE;
      await fs.mkdir(folder,{recursive:true});
      await fs.writeFile(path.join(folder,'timeline-'+scheme+'.jpg'),(await wc.capturePage()).toJPEG(88));
    }
  }
  try {
    await click('#home-open-project');
    await wait('!!'+q(first)+' && !!'+q(band)+' && '+scale+'>0');
    stage = '标记录入、命名和跳转';
    await seek(1.27);
    await key('m');
    await wait('!!'+q(mark));
    const markerTime = await read('Number('+q(mark)+'.style.getPropertyValue("--mark-time"))');
    assert.ok(Math.abs(markerTime-1.25)<=1/24+.001);
    await menu('marker-rename');
    await wait(q('dialog.sequence-dialog:modal input')+'===document.activeElement');
    await send('insertText',{text:'换镜'});
    await wait(q('dialog.sequence-dialog:modal input')+'.value==="换镜"');
    await click('dialog.sequence-dialog:modal .sequence-primary');
    await wait(q(mark)+'.title==="换镜" && !document.querySelector("dialog:modal")');
    await seek(.35);
    await menu('marker-next');
    await wait('Math.abs('+cursor+'-'+markerTime+')<.025');
    await seek(2.1);
    await menu('marker-prev');
    await wait('Math.abs('+cursor+'-'+markerTime+')<.025');
    stage = '设置入出点与循环';
    await seek(.53); await key('i');
    await seek(1.02); await key('o');
    await wait(q(band)+'.dataset.in && '+q(band)+'.dataset.out');
    const from = await read('Number('+q(band)+'.dataset.in)'), to = await read('Number('+q(band)+'.dataset.out)');
    assert.ok(from>=.45 && from<=.54 && to>=.95 && to<=1.03);
    await menu('loop');
    await wait(q('#timeline-loop')+'.ariaPressed==="true"');
    await seek(from+.06);
    await key(' ');
    await wait(q('#timeline-play')+'.ariaPressed==="true"');
    const loops = await read('(async()=>{let last='+cursor+',wraps=0,peak=last;const end=performance.now()+2000;while(performance.now()<end){await new Promise(requestAnimationFrame);const t='+cursor+';if(last-t>.18)wraps++;peak=Math.max(peak,t);last=t;}return {wraps,peak};})()');
    assert.ok(loops.wraps>=1 && loops.peak<=to+.07,'循环预览 '+JSON.stringify(loops));
    await key('k');
    await wait(q('#timeline-play')+'.ariaPressed==="false"');
    await seek(.45);
    await key('i',1);
    await wait('!("in" in '+q(band)+'.dataset) && '+q('#timeline-loop')+'.ariaPressed==="false"');
    await key('o',1);
    await wait(q(band)+'.hidden');
    stage = '吸附目标、Alt 和工具栏';
    assert.equal(await read(q('#timeline-snap')+'.ariaPressed'),'true');
    await click('#timeline-snap'); await wait(q('#timeline-snap')+'.ariaPressed==="false"');
    await click('#timeline-snap'); await wait(q('#timeline-snap')+'.ariaPressed==="true"');
    const start = await point(edge);
    const pxPerSecond = await read(scale);
    const target = {x:start.x+(markerTime-.6)*pxPerSecond+3,y:start.y};
    const guideAtTime = (time,y) => `(() => {
      const canvas=${q(guide)}, rect=canvas.getBoundingClientRect();
      if(!rect.width || rect.top>${y} || rect.bottom<${y}) return false;
      const x=${q(ruler)}.getBoundingClientRect().left+${time}*${scale};
      const column=Math.round((x-rect.left)*canvas.width/rect.width);
      const pixels=canvas.getContext('2d').getImageData(column-1,0,3,1).data;
      const swatch=document.createElement('canvas').getContext('2d');
      swatch.fillStyle=getComputedStyle(canvas).color;
      swatch.fillRect(0,0,1,1);
      const expected=swatch.getImageData(0,0,1,1).data;
      return [0,4,8].some(start=>expected.every((value,i)=>pixels[start+i]===value));
    })()`;
    const guideAtMarker = guideAtTime(markerTime,target.y);
    const guideCleared = `(() => {
      const c=${q(guide)}, pixels=c.getContext('2d').getImageData(0,0,c.width,1).data;
      return !pixels.some((v,i)=>i%4===3 && v>0);
    })()`;
    await mouse('mousePressed',start);
    await mouse('mouseMoved',target);
    await wait(guideAtMarker,'靠近标记时在标记的窗口坐标绘出吸附线');
    await keyEvent('rawKeyDown','Alt',1);
    await wait(guideCleared,'按 Alt 清除整条导线');
    await keyEvent('keyUp','Alt',0);
    await wait(guideAtMarker,'松 Alt 后在同一标记处恢复');
    for(const value of ['active','none']) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value}]});
      await wait(guideAtMarker,'强制颜色切换后重绘同一位置');
    }
    await mouse('mouseReleased',target);
    await wait(guideCleared);
    stage = '包装分割的吸附反馈与撤销';
    const textLayer = '.sequence-layer.kind-text .sequence-block';
    const splitButton = 'dialog.sequence-dialog:modal footer button:first-of-type';
    const layerCount = 'document.querySelectorAll('+JSON.stringify(textLayer)+').length';
    for(const undoBeforePaint of [false,true]) {
      await seek(.5);
      const splitTime = await read(cursor);
      await pressAt(textLayer,'r.width*.7',true);
      await wait(q(splitButton)+'?.textContent==="在播放头分割" && !'+q(splitButton)+'.disabled');
      if(undoBeforePaint) {
        // Undo the actual split from its button's click, before the next paint.
        await read(q(splitButton)+'.addEventListener("click",()=>'+q('#track-undo')+'.click(),{once:true})');
      }
      await click(splitButton);
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))');
      if(undoBeforePaint) {
        assert.equal(await read(layerCount),1,'同一帧撤销分割应恢复原包装片段');
        assert.equal(await read(guideCleared),true,'撤销后旧分割的闪线不得在下一帧重现');
      } else {
        assert.equal(await read(layerCount),2,'包装实际分成两个片段');
        assert.equal(await read(guideAtTime(splitTime,target.y)),true,'刷新轨道后切点仍有吸附线');
        await wait(guideCleared,'分割结束后闪线自行消失');
        await click('#track-undo');
        await wait(layerCount+'===1');
      }
    }
    stage = '正反向播放、换向与暂停';
    await seek(1.95);
    await key('l'); await wait(q(status)+'.textContent.includes("1×") && !'+q(status)+'.hidden');
    const forward = await read(cursor);
    await key('l'); await wait(q(status)+'.textContent.includes("2×") && '+cursor+'>'+forward+'+.10');
    await key('j'); await wait(q(status)+'.textContent.includes("倒放") && '+q(status)+'.textContent.includes("1×")');
    const reverse = await read(cursor);
    await key('j'); await wait(q(status)+'.textContent.includes("2×") && '+cursor+'<'+reverse+'-.10');
    await key('k'); await wait(q('#timeline-play')+'.ariaPressed==="false" && '+q(status)+'.hidden');
    await key(' '); await wait(q('#timeline-play')+'.ariaPressed==="true"');
    await key(' '); await wait(q('#timeline-play')+'.ariaPressed==="false"');
    stage = 'W 作用域与逐帧键';
    const shotCount = await read('document.querySelectorAll('+JSON.stringify(first)+').length');
    await key('w'); await wait('!'+q('#timeline-cut-editor[data-mode="cut"]'));
    assert.equal(await read('document.querySelectorAll('+JSON.stringify(first)+').length'),shotCount);
    await pressAt(first,'r.width*.4',true);
    const cut = '#timeline-cut-editor[data-mode="cut"]';
    await wait('!!'+q(cut));
    await pressAt(cut+' .video-cut-ruler','r.width*.5');
    const frame = 'Number('+q('.video-cut-time')+'.textContent.match(/第 (\\d+) 帧/)[1])';
    const current = await read(frame);
    await key('.'); await wait(frame+'==='+String(current+1));
    await key(','); await wait(frame+'==='+current);
    await key('w'); await wait('document.querySelectorAll(".video-cut-segment").length===2');
    await wait(q(cut)+'.textContent.includes("已分割当前素材中播放头所在的片段")');
    await click(cut+' [data-action="cancel"]');
    await wait('!!'+q('dialog:modal [data-cut-leave="discard"]'));
    await click('dialog:modal [data-cut-leave="discard"]');
    await wait('!'+q(cut));
    stage = '固定工程时间与冷重开';
    await click('#inspector-tab-visual');
    await click('#fps');
    await click('#fps option[value="60"]');
    await wait(q('#fps')+'.value==="60"');
    await key('s',2);
    await wait(q('#notice')+'.textContent.includes("工程已保存")');
    const config = (await loadProject(project)).config;
    assert.equal(config.fps,60);
    assert.equal(config.timelineMarkers[0].time,markerTime);
    assert.equal(config.packaging.global[0].end,markerTime,'右边缘应落在命名标记');
    const loaded = new Promise(resolve=>wc.once('did-finish-load',resolve));
    wc.reload(); await loaded;
    await click('#home-open-project'); await wait(q(mark)+'?.title==="换镜"');
    assert.equal(await read('Number('+q(mark)+'.style.getPropertyValue("--mark-time"))'),markerTime);
    await click(mark); await wait('Math.abs('+cursor+'-'+markerTime+')<.025');
    await seek(.53); await key('i');
    await seek(2.13); await key('o');
    await click(mark);
    await wait('Math.abs('+cursor+'-'+markerTime+')<.025');
    for (const scheme of ['light','dark']) await snapshot(scheme);
    stage = '删除和撤销';
    await menu('marker-delete'); await wait('!'+q(mark));
    await key('z',2); await wait(q(mark)+'?.title==="换镜"');
    console.log('时间线吸附、Alt、区间循环、命名标记与 60 fps 重开、JKL、W 和逐帧检查通过。');
  } catch (error) {
    throw new Error(stage,{cause:error});
  } finally {
    wc.debugger.detach();
  }
}

run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

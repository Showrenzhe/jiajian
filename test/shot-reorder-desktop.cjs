'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { exportBatch, inspectAsset } = require('../src/media.cjs');
const { loadProject, saveProject } = require('../src/project-format.cjs');
const { createPreviewBatch, selectPreviewPlans } = require('../src/preview-plans.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-shot-order-'));
  app.setPath('userData',path.join(root,'electron'));
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all(['red','green','blue','music'].map(async (id) =>
    [id,await inspectAsset(files[id],id==='music' ? 'audio' : 'video')])));
  const input = path.join(root,'原顺序.sdworkbench');
  const output = path.join(root,'新顺序.sdworkbench');
  const ready = path.join(root,'可导出.sdworkbench');
  const captions = {name:'台词',cues:[{start:0,end:180,text:'出锅'}]};
  const layer = (text) => ({kind:'text',text,start:0,end:.25});
  const config = {
    ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:true,unordered:false,useOriginal:true,useMirrors:false,
    count:1,priority:'picture',musicVolume:45,musicIds:['music'],musicStartShot:2,wholeStartShots:[2],
    shots:[[{id:'red',start:0,end:1}], [{id:'green',start:0,end:.65}],
      [{id:'blue',start:0,end:1.4,videoSubtitles:captions,layers:[layer('候选文字')]}]],
    shotSettings:[{name:'A',duration:1.2},{name:'B',duration:.65},{name:'C',duration:2.1}],
    shotTransitions:[null,null,{kind:'fade-black',duration:.2}],
    narrationMode:'segmented',segmentNarrationIds:[[],[],['music']],generatedCaptions:{music:captions},
    segmentVoiceCuts:[[],[],[{ranges:[{start:0,end:.25}],offset:.1}]],
    volumeOverrides:[{kind:'segment',id:'music',shot:2,track:0,value:37}],
    script:{title:'食谱',mode:'segmented',tab:'narration',segmented:['A','B','C'].map(dialogue=>({dialogue,note:''})),whole:[],textGroups:[]},
    packaging:{textMode:'segmented',textGroups:[[[],[],[layer('分镜文字')]]],segmentNarration:[[],[],[[layer('口播文字')]]]},
    subprojects:{active:null,main:[],projects:[{id:'alt',name:'子工程',shots:[],voice:{whole:[{id:'music',follow:2}]}}]},
  };
  await saveProject(input,config,catalog);
  const opens=[input,output], saves=[output,ready];
  const win=await launchDesktop({show:false,dataDirectory:path.join(root,'profile'),dialogs:{
    async showOpenDialog(_win,options) {
      assert.equal(options.title,'打开工程');return {canceled:false,filePaths:[opens.shift()]};
    },
    async showSaveDialog(_win,options) {
      assert.equal(options.title,'保存工程');return {canceled:false,filePath:saves.shift()};
    },
  }});
  win.setContentSize(1420,940);
  const wc=win.webContents;
  wc.setBackgroundThrottling(false);wc.debugger.attach();
  const read=(js)=>wc.executeJavaScript(js,true);
  const query=(selector)=>'document.querySelector('+JSON.stringify(selector)+')';
  const click=(selector)=>read(query(selector)+'.click()');
  const order='Array.from(document.querySelectorAll(".sequence-shots [data-reorder-shot]"), e=>e.textContent.split(" · ")[0])';
  const host=query('#timeline-clock'), marker=query('.shot-insert-marker');
  async function wait(expr, label) {
    for(const until=Date.now()+12000;Date.now()<until;) {
      if(await read(expr)) return;
      await delay(30);
    }
    throw Error(label+' '+JSON.stringify(await read('['+order+','+query('#notice')+'.textContent,document.activeElement.outerHTML.slice(0,180),'+host+'.scrollLeft,'+host+'.clientWidth,'+host+'.scrollWidth]')));
  }
  const verify=(names)=>wait('JSON.stringify('+order+')==='+JSON.stringify(JSON.stringify(names)),'分镜顺序应为 '+names);
  const send=(method,params)=>wc.debugger.sendCommand('Input.'+method,params);
  const mouse=(type,{x,y})=>send('dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',
    buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});
  async function key(key,code,modifiers=0) {
    const event={key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers};
    await send('dispatchKeyEvent',{...event,type:'rawKeyDown'});
    await send('dispatchKeyEvent',{...event,type:'keyUp'});
  }
  async function point(index,portion=.5) {
    const selector='.sequence-shots [data-drop-shot="'+index+'"]';
    const p=await read('(()=>{const e='+query(selector)+',r=e.getBoundingClientRect(),x=r.left+r.width*'+portion+',y=r.top+r.height/2;'
      +'return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()');
    assert.ok(p.hit,selector+' 应可直接拖动');return p;
  }
  async function drag(from,to,portion,cancel=false) {
    const start=await point(from), end=await point(to,portion);
    await send('dispatchMouseEvent',{type:'mouseMoved',x:start.x,y:start.y,buttons:0});
    await mouse('mousePressed',start);await mouse('mouseMoved',end);
    await wait('!'+marker+'.hidden','显示插入线');
    const insertedAt=await read('Math.round('+marker+'.getBoundingClientRect().left)');
    const boundary=await read('(()=>{const r='+query('.sequence-shots [data-drop-shot="'+to+'"]')+'.getBoundingClientRect();return '+(portion<.5?'r.left':'r.right')+'})()');
    assert.ok(Math.abs(insertedAt-boundary)<5,'插入线在目标分镜的正确一侧');
    if(cancel) await key('Escape',27);
    await mouse('mouseReleased',end);
    await wait(marker+'.hidden','结束拖动后收起插入线');
  }
  try {
    await click('#home-open-project');await verify(['A','B','C']);
    await click('#add-shot');await verify(['A','B','C','分镜 04']);
    await click('#timeline-fit');await delay(80);
    await drag(3,0,.2);await verify(['分镜 01','A','B','C']);
    await drag(0,3,.8,true);await verify(['分镜 01','A','B','C']);
    await drag(0,3,.8);await verify(['A','B','C','分镜 04']);
    await drag(2,0,.2);await verify(['C','A','B','分镜 04']);
    await wait('document.activeElement.dataset.dropShot==="0" && document.activeElement.getAttribute("aria-pressed")==="true"','移动后焦点及选区保留在原分镜');
    await key('ArrowRight',39,1);await verify(['A','C','B','分镜 04']);
    await key('ArrowLeft',37,1);await verify(['C','A','B','分镜 04']);
    await click('#track-undo');await verify(['A','C','B','分镜 04']);
    await click('#track-redo');await verify(['C','A','B','分镜 04']);

    const changeView=(value)=>read(query('#timeline-view')+'.value='+JSON.stringify(value)+';'+query('#timeline-view')+'.dispatchEvent(new Event("change"))');
    await changeView('cards');await click('#shots .shot .move-down');
    await changeView('time');await verify(['A','C','B','分镜 04']);
    await click('#track-undo');await verify(['C','A','B','分镜 04']);

    await click('#save-project');await wait(query('#notice')+'.textContent.includes("工程已保存")','保存空镜及顺序');
    const disk=(await loadProject(output)).config;
    assert.deepEqual(disk.shotSettings.map(row=>row?.name??null),['C','A','B',null]);
    assert.equal(disk.shots[0][0].videoSubtitles.cues[0].text,'出锅');
    assert.equal(disk.shots[0][0].layers[0].text,'候选文字');
    assert.equal(disk.shots[3].length,0);
    assert.equal(disk.shotTransitions[0].kind,'fade-black');
    assert.deepEqual(disk.script.segmented.map(row=>row.dialogue).slice(0,3),['C','A','B']);
    assert.equal(disk.segmentVoiceCuts[0][0].offset,.1);
    assert.equal(disk.generatedCaptions[disk.segmentNarrationIds[0][0]].cues[0].text,'出锅');
    assert.equal(disk.volumeOverrides[0].shot,0);
    assert.equal(disk.packaging.textGroups[0][0][0].text,'分镜文字');
    assert.equal(disk.packaging.segmentNarration[0][0][0].text,'口播文字');
    assert.equal(disk.musicStartShot,0);assert.equal(disk.wholeStartShots[0],0);
    assert.equal(disk.subprojects.projects[0].voice.whole[0].follow,0);
    await click('#open-project');await wait(query('#notice')+'.textContent.includes("已打开工程")','重新打开保存的工程');
    await verify(['C','A','B','分镜 04']);
    await click('#track-clean');await verify(['C','A','B']);
    await click('#save-project');await wait(query('#notice')+'.textContent.includes("工程已保存")','保存可导出的工程');
    const saved=await loadProject(ready);
    const batch=createPreviewBatch(saved.config,saved.assets);
    const [plan]=selectPreviewPlans(batch,saved.config,{id:batch.id,indices:[0]});
    assert.deepEqual(plan.clips.map(c=>path.basename(c.asset.path)),[files.blue,files.red,files.green].map(f=>path.basename(f)));
    const rendered=await exportBatch([plan],root);
    assert.deepEqual(rendered.failures,[]);
    let elapsed=0;
    const colors=[];
    for (const clip of plan.clips) {
      const duration=clip.outputDuration ?? clip.duration;
      const rgb=await ffmpeg(['-ss',String(elapsed+duration/2),'-i',rendered.results[0].path,'-frames:v','1','-an',
        '-vf','crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
      colors.push(rgb.indexOf(Math.max(...rgb)));
      elapsed+=duration;
    }
    assert.deepEqual(colors,[2,0,1],'成片三个分镜的实际帧应依次为蓝、红、绿');

    // Zoom in, hold at the viewport edge, then drop on the far end without releasing early.
    await read(query('#track-zoom')+'.value='+query('#track-zoom')+'.max;'+query('#track-zoom')+'.dispatchEvent(new Event("input"))');
    for(let i=0;i<7;i++) await click('#add-shot');
    await wait(host+'.scrollWidth>'+host+'.clientWidth+150','横滚测试需要超过一屏');
    await read(host+'.scrollLeft=0');
    const start=await point(0,.2);
    const end={x:await read(host+'.getBoundingClientRect().right-2'),y:start.y};
    // Editing a large project on a slow GPU can deliver fewer than ten animation frames per second.
    const originalRate=wc.getFrameRate();
    wc.setFrameRate(6);
    await mouse('mousePressed',start);await mouse('mouseMoved',end);
    await wait(host+'.scrollLeft>0 && '+host+'.scrollWidth-'+host+'.clientWidth-'+host+'.scrollLeft<3','拖动至右边缘应持续滚到片尾');
    wc.setFrameRate(originalRate);
    await mouse('mouseReleased',end);
    await wait(order+'.at(-1)==="C"','首镜跨屏移到最后');
    const last=await point(9,.8);
    const beginning={x:await read(host+'.getBoundingClientRect().left+'+query('.sequence-shots .sequence-head')+'.offsetWidth+2'),y:last.y};
    await mouse('mousePressed',last);await mouse('mouseMoved',beginning);
    await wait(host+'.scrollLeft===0','拖动至左边缘应持续滚到片头');
    await mouse('mouseReleased',beginning);await wait(order+'[0]==="C"','尾镜跨屏移到最前面');
    const context=selector=>read(query(selector)+'.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
    const action=text=>read('[...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==='+JSON.stringify(text)+').click()');
    const shotCell=i=>'.sequence-shots [data-drop-shot="'+i+'"]';
    const firstVoice='[data-voice-shot="0"][data-voice-row="0"]';
    await context(firstVoice);
    await read('document.querySelector("dialog[open] input[type=number]").value="2"');
    await action('保存');
    await wait('!document.querySelector("dialog[open]")','保存口播速度');
    await context('.sequence-music .sequence-block');
    await read('document.querySelector("dialog[open] input[type=number]").value=".75"');
    await action('保存');

    await context(shotCell(0));await action('在左侧插入分镜');
    await wait(order+'[1]==="C"','在首镜左侧插入');
    await context(shotCell(1));await action('在右侧插入分镜');
    await wait(order+'[3]==="A"','在已有分镜右侧插入');
    const srcVoice='[data-voice-shot="1"][data-voice-row="0"]';
    await context(srcVoice);await action('复制口播');
    await context(shotCell(0));await action('粘贴口播');
    await wait('!'+query(firstVoice)+'.classList.contains("sequence-empty")','口播粘贴到目标分镜');

    const srcVideo='[data-candidate-index="0"][data-drop-shot="1"]';
    await click(srcVideo);await read(query(srcVideo)+'.focus()');await key('c',67,2);
    await click(shotCell(2));await read(query(shotCell(2))+'.focus()');await key('v',86,2);
    await wait('!'+query('[data-candidate-index="0"][data-drop-shot="2"]')+'.classList.contains("sequence-empty")','快捷键粘贴完整视频');
    await context('[data-lane-key="caption0"] .sequence-block');await action('复制字幕');
    await click(shotCell(2));await read(query(shotCell(2))+'.focus()');await key('v',86,2);
    await wait('!!'+query('[data-lane-key="pasted-captions"] .sequence-block'),'独立时间轴字幕');
    await click('#track-undo');await wait('!'+query('[data-lane-key="pasted-captions"]'),'撤销粘贴字幕');
    await click('#track-redo');await wait('!!'+query('[data-lane-key="pasted-captions"]'),'重做粘贴字幕');
    const afterPaste=path.join(root,'粘贴与倍速.sdworkbench');
    saves.push(afterPaste);opens.push(afterPaste);
    await click('#save-project');await wait(query('#notice')+'.textContent.includes("工程已保存")','保存粘贴和倍速');
    const revised=(await loadProject(afterPaste)).config;
    assert.deepEqual(revised.segmentVoiceCuts[0][0],revised.segmentVoiceCuts[1][0]);
    assert.equal(revised.segmentVoiceCuts[0][0].speed,2);
    assert.deepEqual(revised.musicSpeeds,[.75]);
    assert.deepEqual(revised.shots[2][0],revised.shots[1][0]);
    assert.equal(revised.timelineCaptions.cues[0].text,'出锅');
    assert.equal(revised.timelineCaptions.cues[0].end-revised.timelineCaptions.cues[0].start,90);
    await click('#open-project');await wait(query('#notice')+'.textContent.includes("已打开工程")','重开粘贴工程');
    await context(firstVoice);
    assert.equal(await read('document.querySelector("dialog[open] input[type=number]").valueAsNumber'),2);
    await action('关闭');
    assert.deepEqual(opens,[]);assert.deepEqual(saves,[]);
    console.log('分镜拖动、左右插入、倍速、音频字幕视频复制粘贴、撤销重做、保存重开与成片排序通过。');
  } finally {
    wc.debugger.detach();win.destroy();
  }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

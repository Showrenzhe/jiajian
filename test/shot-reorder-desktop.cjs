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
  async function read(js) {
    try {return await wc.executeJavaScript(js,true);}
    catch(error) {throw new Error('执行界面检查失败 '+js,{cause:error});}
  }
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
  const mouse=(type,{x,y})=>send('dispatchMouseEvent',{type,x,y,button:'left',
    buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});
  async function key(key,code,modifiers=0) {
    const event={key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers};
    await send('dispatchKeyEvent',{...event,type:'rawKeyDown'});
    await send('dispatchKeyEvent',{...event,type:'keyUp'});
  }
  async function fitTimeline() {
    // Fit applies its new clip positions in the next animation frame.
    await read('new Promise(done=>{'+query('#timeline-fit')+'.click();requestAnimationFrame(()=>done(true));})');
    await wait(host+'.scrollWidth<='+host+'.clientWidth+1','适配后的分镜应全部进入可视区');
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
    assert.equal(await read('document.querySelector("#insert-shot-left,#insert-shot-right,#timeline-layer-add")'),null);
    await click('#add-shot');await verify(['A','B','C','分镜 04']);
    await fitTimeline();
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

    await fitTimeline();
    await drag(9,0,.2);await wait(order+'[1]==="C"','将空镜移到 C 前');
    await drag(9,2,.2);await wait(order+'[3]==="A"','将空镜移到 A 前');
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
    const cell=(shot,row)=>'[data-drop-shot="'+shot+'"][data-candidate-index="'+row+'"]';
    const filled=(shot,row)=>query(cell(shot,row)+':not(.sequence-empty)');
    await click(cell(2,0));await read(query(cell(2,0))+'.focus()');await key('c',67,2);
    await click(cell(3,0));await read(query(cell(3,0))+'.focus()');await key('v',86,2);
    await wait('!!'+filled(3,1),'粘贴到已有候选的分镜应追加视频');
    await context(shotCell(3));await action('粘贴视频');
    await wait(query('#notice')+'.textContent.includes("已包含")','重复粘贴应提示且不修改工程');

    // B contains a second copy of the blue cut. C has a different width and keeps its own voice and captions.
    const swapFixture=path.join(root,'候选互换原稿.sdworkbench');
    const [red,green,blue]=config.shots.map(group=>group[0]);
    await saveProject(swapFixture,{...config,shots:[[red,blue],[green,blue],[{...green,end:.9}],[]],
      shotSettings:[{name:'A',duration:1},{name:'B',duration:1.3},{name:'C',duration:2.1},{name:'D',duration:1}],
      segmentNarrationIds:[...config.segmentNarrationIds,[]],segmentVoiceCuts:[...config.segmentVoiceCuts,[]],
      shotTransitions:[...config.shotTransitions,null],
      timelineCaptions:captions},catalog);
    opens.push(swapFixture);await click('#open-project');await verify(['A','B','C','D']);
    await fitTimeline();

    async function bounds(selector) {
      return read(query(selector)+'.getBoundingClientRect().toJSON()');
    }
    async function center(selector) {
      const p=await read('(()=>{const e='+query(selector)+';e.scrollIntoView({block:"nearest",inline:"nearest"});'
        +'const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:e.contains(hit),target:hit?.className}})()');
      assert.ok(p.hit,selector+' 应能直接响应指针 '+JSON.stringify(p));return p;
    }
    const atSlot=(selector,r)=>'(()=>{const e='+query(selector)+';if(!e)return false;const r=e.getBoundingClientRect();'
      +'return '+['x','y','width','height'].map(k=>'Math.abs(r.'+k+'-'+r[k]+')<3').join(' && ')+'})()';
    const clips='Array.from(document.querySelectorAll(".sequence-video [data-move-candidate]"), e=>[e.dataset.dropShot,e.dataset.candidateIndex,e.querySelector(".sequence-clip-name").textContent])';
    const restored=()=>wait('!document.querySelector(".candidate-moving,.candidate-displaced,.candidate-vacancy,[data-material-drop],[data-candidate-rejected],[data-drag-rejected]") && !'+query('.candidate-drop-hint')+'.textContent','结束拖动应清除悬浮、预览及反馈');
    const source=cell(0,1),middle=cell(1,0),target=cell(2,0),empty=cell(3,0);
    const clipNamed=(selector,name)=>query(selector+' .sequence-clip-name')+'?.textContent==='+JSON.stringify(path.basename(name));
    const originalClips=await read(clips);
    const sourcePoint=await center(source),middlePoint=await center(middle),targetPoint=await center(target),emptyPoint=await center(empty);
    const sourceBounds=await bounds(source),targetBounds=await bounds(target);
    assert.ok(targetBounds.width>sourceBounds.width*1.5,'不同宽度的源槽和目标槽');
    await mouse('mousePressed',sourcePoint);await mouse('mouseReleased',sourcePoint);
    await wait(query(source)+'.classList.contains("sequence-selected")','单击候选应选择它');
    await restored();

    async function saveAs(name) {
      const file=path.join(root,name+'.sdworkbench');saves.push(file);
      await click('#save-project');
      await wait(query('#notice')+'.textContent.includes('+JSON.stringify('工程已保存：'+name)+')','保存 '+name);
      return file;
    }
    const baseline=(await loadProject(await saveAs('互换前对照'))).config;
    const hint=query('.candidate-drop-hint');
    async function expectRejected(selector,message) {
      const node=query(selector);
      await wait(node+'.hasAttribute("data-candidate-rejected") && !'+node+'.hasAttribute("data-material-drop") && '+hint+'.textContent==='+JSON.stringify(message),'禁放反馈应显示具体原因');
      assert.equal(await read('getComputedStyle('+node+').cursor'),'not-allowed');
      assert.ok(await read('(()=>{const r='+hint+'.getBoundingClientRect(),pane=document.querySelector("#timeline-tracks-panel").getBoundingClientRect();'
        +'return r.width>0 && r.left>=pane.left && r.right<=pane.right && r.top>=pane.top && r.bottom<=pane.bottom})()'),'禁放说明应显示在时间线可见区域');
    }
    async function reject(from,to,selector,message) {
      await mouse('mousePressed',from);await mouse('mouseMoved',to);await expectRejected(selector,message);
      await mouse('mouseReleased',to);await restored();
      await wait(query('#notice')+'.textContent==='+JSON.stringify(message),'取消非法放置后说明原因');
      await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','被拒绝的候选回到原位');
      assert.deepEqual(await read(clips),originalClips,'禁放应保留两端候选');
    }
    await reject(sourcePoint,middlePoint,middle,'目标分镜已包含这段素材。');
    await reject(middlePoint,sourcePoint,source,'原分镜已包含要换回的素材。');

    async function previewSwap() {
      await mouse('mousePressed',sourcePoint);
      await wait('!!'+query('.candidate-moving'),'按下时提起视频');
      await mouse('mouseMoved',targetPoint);
      await wait(atSlot('.candidate-displaced',sourceBounds),'松手前目标视频应填入源候选行，并适配其宽度');
      await wait(clipNamed('.candidate-displaced',files.green)+' && '+clipNamed('.candidate-moving',files.blue),'预览应显示原片段');
      const lifted=await bounds('.candidate-moving');
      assert.ok(Math.abs(lifted.x+lifted.width/2-targetPoint.x)<5 && Math.abs(lifted.y+lifted.height/2-targetPoint.y)<5,'提起的视频应跟随指针');
      const moved={x:targetPoint.x+14,y:targetPoint.y+2};
      await mouse('mouseMoved',moved);
      await wait('Math.abs('+query('.candidate-moving')+'.getBoundingClientRect().x-'+(lifted.x+14)+')<3','目标格内继续移动时视频跟随指针');
    }
    await previewSwap();
    await mouse('mouseMoved',emptyPoint);
    await wait(query(empty)+'.dataset.materialDrop==="active" && '+atSlot(target,targetBounds),'切换至空分镜后先前的预览应回位');
    await mouse('mouseMoved',targetPoint);await wait(atSlot('.candidate-displaced',sourceBounds),'再次进入时恢复互换预览');
    await key('Escape',27);await restored();
    await mouse('mouseReleased',targetPoint);
    await wait(atSlot(source,sourceBounds),'Esc 后原视频回到原行原列');
    assert.deepEqual(await read(clips),originalClips,'Esc 取消互换');

    await mouse('mousePressed',sourcePoint);await mouse('mouseMoved',emptyPoint);await mouse('mouseReleased',emptyPoint);
    await wait(clipNamed(cell(0,0)+'[title*="'+path.basename(files.blue)+'"]',files.blue)+' && !'+filled(0,1),'空白处按鼠标时间接收视频，源分镜可以在同轨分时放置候选');
    await click('#track-undo');await wait(clipNamed(source,files.blue)+' && !'+filled(3,0),'撤销空分镜移动');
    await restored();
    await previewSwap();await mouse('mouseReleased',targetPoint);await restored();
    const exchanged=clipNamed(target,files.blue)+' && '+clipNamed(source,files.green);
    await wait(exchanged,'松手后只交换指定的两个槽位');
    await click('#track-undo');await wait(clipNamed(source,files.blue),'一次撤销互换');
    assert.deepEqual(await read(clips),originalClips);
    await click('#track-redo');await wait(exchanged,'一次重做互换');
    const movedFile=await saveAs('互换后草稿');
    const expected=structuredClone(baseline);
    [expected.shots[0][1],expected.shots[2][0]]=[expected.shots[2][0],expected.shots[0][1]];
    const movedConfig=(await loadProject(movedFile)).config;
    assert.deepEqual(movedConfig,expected,'落盘只应交换两条完整候选，其余分镜及口播、字幕、包装均保持原顺序');
    opens.push(movedFile);await click('#open-project');await wait(query('#notice')+'.textContent.includes("已打开工程") && '+exchanged,'重开后保留两个视频的交换位置');
    await verify(['A','B','C','D']);
    await read(query(cell(0,0))+'.focus()');await key('ArrowRight',39,1);
    await wait(clipNamed(middle,files.red)+' && document.activeElement==='+query(middle),'键盘互换后焦点随视频到相邻分镜');
    await key('ArrowLeft',37,1);
    await wait(clipNamed(cell(0,0),files.red)+' && document.activeElement==='+query(cell(0,0)),'连续反向互换回到原槽位');

    const singleFile=path.join(root,'新增轨道原稿.sdworkbench');
    await saveProject(singleFile,{...config,shots:[[{...red,start:.1,volume:43,layers:[layer('片段包装')]}],[green],[blue]],
      mutedVideoTracks:[0]},catalog);
    opens.push(singleFile);await click('#open-project');await verify(['A','B','C']);await fitTimeline();
    const singleBaseline=(await loadProject(await saveAs('新增轨前'))).config;
    const expectedClips=await read(clips);
    const rows='document.querySelectorAll(".sequence-video[data-lane-key]").length';
    const zone='.candidate-new-lane .sequence-content', placement='.candidate-new-placement';
    const ruler='.sequence-ruler .sequence-content';
    async function hoverNewLane(row) {
      await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','等待上一操作的片段归位');
      const start=await center(cell(0,row));
      const column=await bounds(cell(0,row)),otherColumn=await bounds(shotCell(1));
      await mouse('mousePressed',start);
      await mouse('mouseMoved',{x:start.x+9,y:start.y});
      await wait('!!'+query(zone),'提起已放置的片段后可拖入视频轨下方');
      await center(zone);
      const area=await bounds(zone),end={x:otherColumn.x+otherColumn.width/2,y:area.y+area.height/2};
      await mouse('mouseMoved',end);
      await wait(query(zone)+'.dataset.materialDrop==="active"','指针在另一分镜下方也应可新增原分镜的视频轨');
      const preview=await bounds(placement);
      assert.ok(Math.abs(preview.x-(end.x-column.width/2))<3 && Math.abs(column.width-preview.width)<3,'预览应按抓取偏移跟随指针，保持片段时长');
      await mouse('mouseMoved',{x:end.x+17,y:end.y});
      assert.ok(Math.abs((await bounds(placement)).x-preview.x-17)<2,'同一行内移动时落点持续更新');
      await mouse('mouseMoved',end);
      return end;
    }
    let hover=await hoverNewLane(0);
    const neighbour=await bounds(cell(1,0));
    await mouse('mouseMoved',{x:neighbour.x+neighbour.width/2,y:neighbour.y+neighbour.height/2});
    await wait('!'+query(zone)+'.hasAttribute("data-material-drop")','离开新增区域取消新轨预览');
    await key('Escape',27);await mouse('mouseReleased',hover);await restored();
    assert.deepEqual(await read(clips),expectedClips);
    const cursorBefore=await bounds('.sequence-cursor');
    await send('dispatchMouseEvent',{type:'mouseMoved',x:neighbour.x+10,y:neighbour.y+8,buttons:0});
    assert.equal(await read(query('.sequence-hover')),null,'指针经过轨道时只有真实播放头');
    assert.equal((await bounds('.sequence-cursor')).x,cursorBefore.x);
    assert.equal(await read(rows),1);
    hover=await hoverNewLane(0);
    await key('Escape',27);await mouse('mouseReleased',hover);await restored();
    assert.equal(await read(rows),1,'直接取消新增轨道后仍只有原轨');
    assert.equal(await read(query('#track-undo')+'.disabled'),true,'取消操作不应产生可撤销的编辑');

    let expectedTime;
    async function commitNewLane(from,bottom=false) {
      let end=await hoverNewLane(from);
      if(bottom) {
        const foot=await center('#new-shot-drop');
        end={x:(await bounds(ruler)).x+(await bounds(shotCell(0))).width*.82,y:foot.y};
        await mouse('mouseMoved',end);
        await wait(query(zone)+'.dataset.materialDrop==="active"','轨道底部也接收已放置的片段');
      }
      const ghost=await bounds(placement),axis=await bounds(ruler);
      const scale=((await bounds(shotCell(0))).width+2)/1.2;
      expectedTime=(ghost.x-axis.x)/scale;
      await mouse('mouseReleased',end);await restored();
      await wait(clipNamed(cell(0,from+1),files.red)+' && !'+filled(0,from),'只移动当前分镜的红色视频');
      if(bottom) {
        const destination=query(cell(0,from+1));
        await wait(`(()=>{const e=${destination},r=e.getBoundingClientRect(),panel=${query('#timeline-tracks-panel')}.getBoundingClientRect();
          return r.top>=panel.top+${query('.sequence-ruler')}.offsetHeight-1 && r.bottom<=panel.bottom+1 &&
            e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`,'从底部松手后可直接看到并选中新轨片段');
      }
      assert.deepEqual(await read(clips),[...expectedClips.slice(1),['0',String(from+1),path.basename(files.red)]],
        '其余分镜保留在首行，原素材只出现一次');
    }
    await commitNewLane(0);
    await click('#track-undo');await wait(rows+'===1','一次撤销还原轨数及片段');
    assert.deepEqual(await read(clips),expectedClips);
    await click('#track-redo');await wait(clipNamed(cell(0,1),files.red),'重做恢复新视频轨');
    await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','重做后轨道就绪');
    const placed=await bounds(cell(0,1)),axis=await bounds(ruler);
    const scale=((await bounds(shotCell(0))).width+2)/1.2;
    const grip=24,held={x:placed.x+grip,y:placed.y+placed.height/2};
    const reposition={x:axis.x+.413*scale+grip,y:held.y};
    await mouse('mousePressed',held);await mouse('mouseMoved',reposition);
    assert.ok(Math.abs((await bounds(placement)).x-(reposition.x-grip))<2,'从片段左侧抓取后原抓点仍对准鼠标');
    await mouse('mouseReleased',reposition);await restored();
    const retimed=await loadProject(await saveAs('同轨自由放置'));
    assert.ok(Math.abs(retimed.config.shots[0][0].videoStart-.413)<.006,'已在新轨上的片段可再次落在同轨非整秒处');
    await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','横向移动归位');
    const edge={x:(await bounds('#timeline-clock')).right-7,y:reposition.y};
    await mouse('mousePressed',reposition);await mouse('mouseMoved',edge);
    await wait(host+'.scrollLeft>210','向右边缘持续拖动可以越过原有工程结尾');
    await mouse('mouseReleased',edge);await restored();
    const beyond=await loadProject(await saveAs('拖过时间线末端'));
    assert.ok(beyond.config.shots[0][0].videoStart>3.95,'末端之外可放置片段，工程自动延长');
    await click('#track-undo');await wait(clipNamed(cell(0,1),files.red),'撤销末端移动');
    await read(host+'.scrollLeft=0');await fitTimeline();
    await commitNewLane(1,true);
    const savedLanes=await saveAs('两次新增视频轨');
    const reopened=await loadProject(savedLanes);
    assert.equal(reopened.config.shots[0][0].videoLane,2);
    assert.ok(Math.abs(reopened.config.shots[0][0].videoStart-expectedTime)<.012 && expectedTime>.1 && expectedTime<1,'工程保存的绝对秒与鼠标预览位置一致');
    const comparison=structuredClone(reopened.config);
    delete comparison.shots[0][0].videoLane;
    delete comparison.shots[0][0].videoStart;
    assert.deepEqual(comparison,singleBaseline,'只应改变原分镜下当前候选的视频轨号');
    opens.push(savedLanes);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程") && '+clipNamed(cell(0,2),files.red),'重开后显示两个空位和第三行的原片段');
    assert.equal(await read(rows),3);
    await click(cell(0,2));
    assert.equal(await read(query('#clip-track-muted')+'.checked'),false,'移出静音行的片段应恢复其原音量');
    const [lanePlan]=createPreviewBatch(reopened.config,reopened.assets).plans;
    assert.deepEqual(lanePlan.clips.map(c=>[path.basename(c.asset.path),c.volume]),
      [[files.red,.43],[files.green,0],[files.blue,0]].map(([file,volume])=>[path.basename(file),volume]));
    const laneRender=await exportBatch([lanePlan],root);
    assert.deepEqual(laneRender.failures,[]);
    const renderedFile=laneRender.results[0].path;
    const rgb=await ffmpeg(['-ss','0.5','-i',renderedFile,'-frames:v','1','-an','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    assert.ok(rgb[0]>rgb[1]*3 && rgb[0]>rgb[2]*3,'输出文件的第一镜应保留红色画面');
    const sound=await ffmpeg(['-ss','0.3','-i',renderedFile,'-t','0.2','-vn','-ac','1','-ar','8000','-f','s16le','pipe:1']);
    assert.ok(sound.length>1000 && Array.from({length:sound.length/2},(_,i)=>Math.abs(sound.readInt16LE(i*2))).some(v=>v>100),
      '第一镜移出静音行后，导出文件能读到红色素材的原声');
    await click('#clip-track-muted');
    const muted=(await loadProject(await saveAs('第三行静音')));
    assert.deepEqual(muted.config.mutedVideoTracks,[0,2],'片段检查器应切换当前物理视频行的静音');
    assert.ok(createPreviewBatch(muted.config,muted.assets).plans[0].clips.every(c=>c.volume===0));

    await read(query('#timeline-tracks-panel')+'.scrollTop=0');
    const fromThird=await center(cell(0,2)), firstEmpty=await center(cell(0,0));
    firstEmpty.x+=5;
    await mouse('mousePressed',fromThird);await mouse('mouseMoved',firstEmpty);
    await wait('!!'+query(placement)+' && !'+host+'.hasAttribute("data-drag-rejected")','偏离原槽中心 5 像素仍应预览贴回首个分镜');
    assert.ok(Math.abs((await bounds(placement)).left-(await bounds(ruler)).left)<2,'完整空槽对齐分镜起点');
    await mouse('mouseReleased',firstEmpty);
    await wait(clipNamed(cell(0,0),files.red),'同一分镜的片段可移回原空行');
    assert.deepEqual(await read(clips),expectedClips);
    await click('#track-undo');await wait(clipNamed(cell(0,2),files.red),'撤销回移应恢复稀疏行');
    const fromSecond=await center(cell(1,0)), sparse=await center(cell(0,1));
    await mouse('mousePressed',fromSecond);await mouse('mouseMoved',sparse);await mouse('mouseReleased',sparse);
    await wait(clipNamed(cell(1,1),files.green)+' && '+clipNamed(cell(0,2),files.red)+' && !'+filled(1,0),
      '跨分镜移入中间空行保留两段素材各自的分镜绑定');
    await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','新轨上的片段应落位');
    const greenSource=await center(cell(1,1)), redTarget=await center(cell(0,2));
    await mouse('mousePressed',greenSource);await mouse('mouseMoved',redTarget);await mouse('mouseReleased',redTarget);
    await wait(clipNamed(cell(0,2),files.green)+' && '+clipNamed(cell(1,1),files.red),'已移位的视频按实际覆盖的位置互换');
    await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','交换的片段应归位');
    const swapped=await loadProject(await saveAs('错时换轨'));
    assert.ok(Math.abs(swapped.config.shots[0][0].videoStart-expectedTime)<.012,'互换已移动片段时，新片段应接管目标的绝对时间');

    // The red clip is the only video on row two. The green clip on row one
    // overlaps the dragged footprint, but the voice ending and caption start define a cut.
    const cutFixture=path.join(root,'字幕与声音切点.sdworkbench');
    await saveProject(cutFixture,{...config,
      shots:[[{...red,start:.1,end:1.3,videoLane:1,videoStart:.25}],[green],[blue]],
      segmentNarrationIds:[['music'],[],['music']],segmentVoiceCuts:[[{offset:.3,ranges:[{start:0,end:.4}]}],[],[null]],
      timelineCaptions:{name:'独立字幕',cues:[{start:980,end:1120,text:'保留字幕位置'}]},
    },catalog);
    opens.push(cutFixture);await click('#open-project');
    await wait(clipNamed(cell(0,1),files.red)+' && !!'+query('[data-lane-key="pasted-captions"]'),'打开带独立参考切点的工程');
    await fitTimeline();
    const cutBaseline=await loadProject(await saveAs('参考轨道对照'));
    const beforeCut=await center(cell(0,1)), slotA=await bounds(cell(0,0)), timingAxis=await bounds(ruler);
    const cutScale=parseFloat(await read(query(shotCell(1))+'.style.left'))/1.2;
    const land={x:timingAxis.left+.84*cutScale,y:slotA.y+slotA.height/2};
    await mouse('mousePressed',beforeCut);await mouse('mouseMoved',land);
    await wait('!!'+query(placement)+' && !'+host+'.hasAttribute("data-drag-rejected")','视频拖回时可以按填好的口播结尾和字幕起点裁切');
    await mouse('mouseReleased',land);await restored();
    await wait(clipNamed(cell(0,0),files.red),'裁切后只移动红片到原轨');
    const cutFile=await saveAs('按参考边界裁切后');
    const cutSaved=await loadProject(cutFile), cut=cutSaved.config.shots[0][0];
    assert.ok(Math.abs(cut.videoStart-.7)<.001 && Math.abs(cut.videoDuration-.28)<.001,'裁到 0.70–0.98 秒');
    assert.deepEqual([cut.start,cut.end],[.1,1.3],'保留原素材入出点');
    const {shots:oldShots,...oldReference}=cutBaseline.config,{shots:newShots,...newReference}=cutSaved.config;
    assert.deepEqual(newReference,oldReference,'裁切保持分镜、口播、字幕和其他轨道数据');
    assert.deepEqual(newShots.slice(1),oldShots.slice(1),'未触碰相邻视频片段');
    await click('#track-undo');await wait(clipNamed(cell(0,1),files.red),'撤销一次恢复视频原轨与长度');
    await click('#track-redo');await wait(clipNamed(cell(0,0),files.red),'重做恢复裁切后的原轨');
    opens.push(cutFile);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程") && '+clipNamed(cell(0,0),files.red),'重开后保留时间线裁切');
    const cutPlan=createPreviewBatch(cutSaved.config,cutSaved.assets).plans[0];
    assert.equal(cutPlan.duration,createPreviewBatch(cutBaseline.config,cutBaseline.assets).plans[0].duration);
    const cutExport=await exportBatch([cutPlan],root);
    assert.deepEqual(cutExport.failures,[]);
    for(const [seconds,channel] of [[.54,-1],[.83,0],[1.08,-1],[1.4,1]]) {
      const pixel=await ffmpeg(['-ss',String(seconds),'-i',cutExport.results[0].path,'-frames:v','1','-an',
        '-vf','crop=8:8:iw/2:ih/3,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
      assert.equal(pixel.length,3);
      if(channel<0) assert.ok(Math.max(...pixel)<20,'裁切区间外应是空画面 '+seconds);
      else assert.ok(pixel[channel]>100 && pixel[channel]===Math.max(...pixel),'输出应在指定时间播放正确视频 '+seconds);
    }

    opens.push(singleFile);await click('#open-project');await wait(rows+'===1 && '+clipNamed(cell(1,0),files.green),'重开单轨原稿');
    const switchProject=id=>read(`(()=>{const e=${query('#subproject-select')};e.value=${JSON.stringify(id)};e.dispatchEvent(new Event("change"))})()`);
    await switchProject('alt');await fitTimeline();await commitNewLane(0);
    const branchFile=await saveAs('子工程新增轨');
    opens.push(branchFile);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程") && '+clipNamed(cell(0,1),files.red),'重开子工程的专属轨道');
    await switchProject('');await wait(rows+'===1 && '+clipNamed(cell(0,0),files.red),'主工程的原视频仍留在首行');
    await switchProject('alt');await wait(rows+'===2 && '+clipNamed(cell(0,1),files.red),'再次选择子工程时恢复专属位置');
    await read(query(cell(0,1))+'.focus()');await key('ArrowDown',40,1);
    await wait(rows+'===3 && '+clipNamed(cell(0,2),files.red)+' && document.activeElement==='+query(cell(0,2)),
      'Alt＋下方向键从末行新建视频轨，并将焦点留在移动的片段上');
    await key('ArrowUp',38,1);
    await wait(clipNamed(cell(0,1),files.red)+' && document.activeElement==='+query(cell(0,1)),'Alt＋上方向键移回原来的轨道');

    const fullFile=path.join(root,'候选已满.sdworkbench');
    const fullShot=Array.from({length:100},(_,i)=>({id:'green',start:0,end:.5+i/200}));
    await saveProject(fullFile,{...config,shots:[config.shots[0],fullShot,config.shots[2]]},catalog);
    opens.push(fullFile);await click('#open-project');await wait('!!'+filled(1,99),'打开含 100 条候选的分镜');
    await fitTimeline();
    const fullSource=await center(cell(0,0)),fullTarget=await center(cell(1,0));
    await mouse('mousePressed',fullSource);await mouse('mouseMoved',fullTarget);await mouse('mouseReleased',fullTarget);
    await wait(clipNamed(cell(1,0),files.red)+' && '+clipNamed(cell(0,0),files.green),'满额分镜可一对一互换');
    assert.ok(await read('!!'+filled(1,99)+' && !'+filled(1,100)),'互换不增加候选数');
    const lastSource=await center(cell(2,0));
    await mouse('mousePressed',lastSource);await mouse('mouseMoved',{x:lastSource.x+7,y:lastSource.y});
    // Keep the pointer away from the vertical autoscroll edge while checking rejection.
    await read(query(shotCell(1))+'.scrollIntoView({block:"center",inline:"nearest"})');
    const fullHeader=await center(shotCell(1));
    await mouse('mouseMoved',fullHeader);
    await expectRejected(shotCell(1),'每个分镜最多可添加 100 条候选。');await mouse('mouseReleased',fullHeader);await restored();

    const rulerElement=query(ruler);
    async function openLongTimeline(name,videoStart) {
      const file=path.join(root,name+'.sdworkbench');
      const shots=[...config.shots.slice(0,2),[{...config.shots[2][0],videoLane:1,videoStart}]];
      await saveProject(file,{...config,shots},catalog);
      await wait('!'+query('#open-project')+'.disabled','等待工程切换完成');
      opens.push(file);await click('#open-project');
      await wait(query('#notice')+'.textContent.includes('+JSON.stringify('已打开工程：'+name)+') && '+clipNamed(cell(2,1),files.blue),'打开'+name+'时间轴');
    }
    await openLongTimeline('超过一天',90000);
    await read(query('#track-zoom')+'.value='+query('#track-zoom')+'.max;'+query('#track-zoom')+'.dispatchEvent(new Event("input"))');
    await wait('Number('+rulerElement+'.dataset.width)>1000000','放大查看 25 小时工程');
    const dayWidth=await read('Number('+rulerElement+'.dataset.width)');
    await read(host+'.scrollLeft=0;'+query('#timeline-tracks-panel')+'.scrollTop=0');
    const daySource=await center(cell(0,0));
    await mouse('mousePressed',daySource);await mouse('mouseMoved',{x:daySource.x+8,y:daySource.y});
    await read(host+'.scrollLeft='+host+'.scrollWidth');
    await wait('parseFloat('+rulerElement+'.firstElementChild.style.left)>100000','滚到片尾后只绘制视窗附近的刻度');
    const dayEdge={x:await read(host+'.getBoundingClientRect().right-2'),y:daySource.y};
    await mouse('mouseMoved',dayEdge);
    await wait('Number('+rulerElement+'.dataset.width)>'+dayWidth,'超过一天的时间尺仍可向右延伸');
    await key('Escape',27);await mouse('mouseReleased',dayEdge);
    await wait('Number('+rulerElement+'.dataset.width)==='+dayWidth,'取消后恢复超长工程的原始宽度');
    await openLongTimeline('极远落点',Number.MAX_SAFE_INTEGER);
    await wait('Number('+rulerElement+'.dataset.width)>1e13 && '+rulerElement+'.childElementCount<200','极远落点的时间尺仅绘制有界数量的刻度');
    assert.deepEqual(opens,[]);assert.deepEqual(saves,[]);
    console.log('分镜排序、视频换轨与新建轨道、取消与撤销重做、复制粘贴、子工程重开及成片画面与原声验证通过。');
  } finally {
    wc.debugger.detach();win.destroy();
  }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

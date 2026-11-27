'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { exportBatch, inspectAsset } = require('../src/media.cjs');
const { loadProject, saveProject } = require('../src/project-format.cjs');
const { createPreviewBatch, selectPreviewPlans } = require('../src/preview-plans.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');
const { clickVisible, dragLibraryItem } = require('./desktop-input.cjs');

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
  async function chooseOverflow(choice) {
    const button='#speed-overflow-dialog:modal [data-speed-choice="'+choice+'"]';
    await wait('!!'+query(button),'确认短片段时间窗的超限处理 '+choice);
    await clickVisible(wc,button);
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
  async function shotGrip(index) {
    const selector='.sequence-shots [data-drop-shot="'+index+'"] .shot-reorder-handle';
    const p=await read('(()=>{const e='+query(selector)+';e.scrollIntoView({block:"nearest",inline:"nearest"});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,okay:e.contains(hit),bounds:r.toJSON(),hit:hit?.outerHTML?.slice(0,360)}})()');
    assert.ok(p.okay,JSON.stringify(p));return p;
  }
  async function drag(from,to,portion,cancel=false) {
    const start=await shotGrip(from), end=await point(to,portion);
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
    const start=await shotGrip(0);
    const end={x:await read(host+'.getBoundingClientRect().right-2'),y:start.y};
    // Editing a large project on a slow GPU can deliver fewer than ten animation frames per second.
    const originalRate=wc.getFrameRate();
    wc.setFrameRate(6);
    await mouse('mousePressed',start);await mouse('mouseMoved',end);
    await wait(host+'.scrollLeft>0 && '+host+'.scrollWidth-'+host+'.clientWidth-'+host+'.scrollLeft<3','拖动至右边缘应持续滚到片尾');
    wc.setFrameRate(originalRate);
    await mouse('mouseReleased',end);
    await wait(order+'.at(-1)==="C"','首镜跨屏移到最后');
    const last=await shotGrip(9);
    const beginning={x:await read(host+'.getBoundingClientRect().left+'+query('.sequence-shots .sequence-head')+'.offsetWidth+2'),y:last.y};
    await mouse('mousePressed',last);await mouse('mouseMoved',beginning);
    await wait(host+'.scrollLeft===0','拖动至左边缘应持续滚到片头');
    await mouse('mouseReleased',beginning);await wait(order+'[0]==="C"','尾镜跨屏移到最前面');
    const action=text=>read('[...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==='+JSON.stringify(text)+').click()');
    const shotCell=i=>'.sequence-shots [data-drop-shot="'+i+'"]';
    async function clipboardKey(selector,letter) {
      await click(selector);await read(query(selector)+'.focus()');await key(letter,letter.toUpperCase().charCodeAt(0),2);
    }
    const firstVoice='[data-voice-shot="0"][data-voice-row="0"]';
    await click(firstVoice);await click('#selected-voice-settings');
    await read('document.querySelector("dialog[open] input[type=number]").value="2"');
    await action('保存');
    await wait('!document.querySelector("dialog[open]")','保存口播速度');
    await read(query('.sequence-music .sequence-block')+'.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    await read('document.querySelector("dialog[open] input[type=number]").value=".75"');
    await action('保存');

    await fitTimeline();
    await drag(9,0,.2);await wait(order+'[1]==="C"','将空镜移到 C 前');
    await drag(9,2,.2);await wait(order+'[3]==="A"','将空镜移到 A 前');
    const srcVoice='[data-voice-shot="1"][data-voice-row="0"]';
    await clipboardKey(srcVoice,'c');
    await clipboardKey(shotCell(0),'v');
    await wait('!'+query(firstVoice)+'.classList.contains("sequence-empty")','口播粘贴到目标分镜');

    const srcVideo='[data-candidate-index="0"][data-drop-shot="1"]';
    await click(srcVideo);await read(query(srcVideo)+'.focus()');await key('c',67,2);
    await click(shotCell(2));await read(query(shotCell(2))+'.focus()');await key('v',86,2);
    await wait('!'+query('[data-candidate-index="0"][data-drop-shot="2"]')+'.classList.contains("sequence-empty")','快捷键粘贴完整视频');
    await clipboardKey('[data-lane-key="caption0"] .sequence-block','c');
    await click(shotCell(2));await read(query(shotCell(2))+'.focus()');await key('v',86,2);
    await wait('!!'+query('[data-lane-key="pasted-captions"] .sequence-block'),'独立时间轴字幕');
    for(const lane of ['caption0','pasted-captions']) {
      for(const part of ['.sequence-head','.sequence-content','.sequence-block']) {
        const target=query('[data-lane-key="'+lane+'"] '+part);
        assert.ok(await read('!'+target+'.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true})) && !document.querySelector("dialog[open],:popover-open")'),'字幕右键不打开菜单 '+lane+' '+part);
        if(part==='.sequence-block') {
          await wait(query('.timeline-context-hint[role=status]')+'?.textContent==="此处无菜单，可双击进入编辑"','有双击编辑入口的字幕应给出操作提示');
          await read(target+'.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
          await wait('!!document.querySelector("dialog[open]")','双击字幕应确实进入编辑');
          await key('Escape',27);
          await wait('!document.querySelector("dialog[open]")','Esc 取消字幕编辑');
        }
      }
    }
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
    await click('#open-project');await wait(query('#notice')+'.textContent.includes("已打开工程：粘贴与倍速")','重开粘贴工程');
    await wait('!'+query('#material-clear-selection')+'.disabled && '+query(firstVoice)+'.title.includes("2 倍")','重开后口播和操作状态就绪');
    await read(query(firstVoice)+'.click(); '+query('#selected-voice-settings')+'.click()');
    await wait('!!document.querySelector("dialog:modal input[type=number]")','重开口播设置');
    assert.equal(await read('document.querySelector("dialog[open] input[type=number]").valueAsNumber'),2);
    await action('关闭');
    const cell=(shot,row)=>'[data-drop-shot="'+shot+'"][data-candidate-index="'+row+'"]';
    const filled=(shot,row)=>query(cell(shot,row)+':not(.sequence-empty)');
    await click(cell(2,0));await read(query(cell(2,0))+'.focus()');await key('c',67,2);
    await click(cell(3,0));await read(query(cell(3,0))+'.focus()');await key('v',86,2);
    await wait('!!'+filled(3,1),'粘贴到已有候选的分镜应追加视频');
    await clipboardKey(shotCell(3),'v');
    await wait('!!'+filled(3,2),'再次粘贴同源视频应追加一个独立候选');
    await click('#track-undo');await wait('!'+filled(3,2)+' && !!'+filled(3,1),'撤销只移除本次粘贴');

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
    const dragVisuals='.candidate-moving,.candidate-displaced,.candidate-slot,.candidate-new-lane,[data-candidate-drag],[data-candidate-lifted]';
    const restored=()=>wait('!'+query(dragVisuals+',[data-material-drop],[data-candidate-rejected],[data-drag-rejected]')+' && !'+query('.candidate-drop-hint')+'.textContent','结束拖动应清除悬浮、预览及反馈');
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
      await wait('!'+query('#save-project')+'.disabled','等待工程可保存');
      await click('#save-project');
      await wait(query('#notice')+'.textContent.includes('+JSON.stringify('工程已保存：'+name)+')','保存 '+name);
      return file;
    }
    const baseline=(await loadProject(await saveAs('互换前对照'))).config;
    const configSnapshot=async name=>(await loadProject(await saveAs(name))).config;
    const evidence=process.env.JIAJIAN_DRAG_EVIDENCE;
    async function evidenceViewport(theme,width=1420,height=940) {
      if(!evidence) return;
      win.setContentSize(width,height);
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
      await wait('innerWidth==='+width+' && innerHeight==='+height+' && document.documentElement.dataset.theme==='+JSON.stringify(theme),'切换拖拽截图窗口');
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))))');
      await fitTimeline();
    }
    async function captureDrag(name) {
      if(!evidence) return;
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      assert.ok(await read('!!document.querySelector(".candidate-moving:popover-open")'),'截取正在拖动的片段');
      const frame=await wc.capturePage();
      assert.deepEqual([frame.getSize().width,frame.getSize().height],win.getContentSize());
      await fs.mkdir(evidence,{recursive:true});
      await fs.writeFile(path.join(evidence,name+'.jpg'),frame.toJPEG(88));
    }
    const press={x:Math.round(sourcePoint.x),y:Math.round(sourcePoint.y)};
    for(const [dx,dy] of [[4,0],[5,0],[3,4]]) {
      await read('window.addEventListener("pointerdown",e=>{window.testCandidatePointer=e.pointerId},{once:true})');
      await mouse('mousePressed',press);
      const jitter={x:press.x+dx,y:press.y+dy};
      await mouse('mouseMoved',jitter);
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      assert.ok(await read('!'+query(dragVisuals)+' && !'+host+'.hasPointerCapture(window.testCandidatePointer)'),'5 px 内不抓起、不捕获、不显示落点');
      await mouse('mouseReleased',jitter);
      await wait(query(source)+'.classList.contains("sequence-selected")','死区内松手保留普通点选');
      assert.deepEqual(await read(clips),originalClips);
    }
    for(const clickCount of [1,2]) for(const type of ['mousePressed','mouseReleased']) {
      await send('dispatchMouseEvent',{type,...press,button:'left',buttons:type==='mousePressed'?1:0,clickCount});
    }
    await wait('!!document.querySelector("#timeline-cut-editor[data-mode=cut]:not([hidden])")','双击仍进入视频裁剪');
    assert.ok(await read('!'+query(dragVisuals)),'双击不产生拖拽预览');
    await key('Escape',27);
    await wait(query('#timeline-cut-editor')+'.hidden','取消裁剪');
    assert.deepEqual(await configSnapshot('点击双击后'),baseline);
    assert.ok(await read(query('#track-undo')+'.disabled && '+query('#track-redo')+'.disabled'),'点击、双击和死区移动不产生历史');
    const hint=query('.candidate-drop-hint');
    // Leave one real edit on either side of the history cursor before cancelling a swap.
    const mute='[data-control-key="vis0"] [data-track-action="muted"]';
    assert.equal(await read(query(mute)+'.ariaPressed'),'false');
    await click(mute);await wait(query(mute)+'.ariaPressed==="true"','建立撤销历史');
    const historyMuted=await configSnapshot('历史中的静音状态');
    await click(mute);await wait(query(mute)+'.ariaPressed==="false"','建立重做历史');
    const unmuted=await configSnapshot('候选片段互换示例');
    await click('#track-undo');await wait(query(mute)+'.ariaPressed==="true"','撤回第二个编辑');
    const sameSource=cell(0,0);
    async function sameLaneSwap() {
      const from=await center(sameSource), box=await bounds(middle), to={x:box.x+box.width/2,y:box.y+box.height/2};
      await read('window.addEventListener("pointerdown",e=>{window.testCandidatePointer=e.pointerId},{once:true})');
      await mouse('mousePressed',from);
      await mouse('mouseMoved',{x:from.x+8,y:from.y});
      await mouse('mouseMoved',to);
      await wait(clipNamed('.candidate-displaced',files.green)+' && '+clipNamed('.candidate-moving',files.red),'同轨交换显示目标和手持片段');
      return to;
    }
    await evidenceViewport('light');
    const cancelAt=await sameLaneSwap();
    await captureDrag('light-same-track-swap');
    await key('Escape',27);await restored();
    await mouse('mouseMoved',{x:cancelAt.x+24,y:cancelAt.y});await mouse('mouseReleased',cancelAt);await restored();
    assert.deepEqual(await configSnapshot('互换取消对照'),historyMuted);
    for(const interruption of ['pointercancel','blur']) {
      const to=await sameLaneSwap();
      if(interruption==='pointercancel') {
        await read(host+'.dispatchEvent(new PointerEvent("pointercancel",{pointerId:window.testCandidatePointer,bubbles:true}))');
      } else await read('window.dispatchEvent(new Event("blur"))');
      await restored();
      assert.ok(await read('!'+query(dragVisuals)+' && !'+host+'.hasPointerCapture(window.testCandidatePointer)'),'中断后收起临时轨、悬浮和占位 '+interruption);
      await mouse('mouseReleased',to);
      assert.deepEqual(await read(clips),originalClips);
    }
    await click('#track-undo');await wait(query(mute)+'.ariaPressed==="false"','取消后撤销上一次实际编辑');
    assert.deepEqual(await configSnapshot('取消后原撤销项'),baseline);
    await click('#track-redo');await wait(query(mute)+'.ariaPressed==="true"','重做第一个原有编辑');
    assert.deepEqual(await configSnapshot('取消后原重做一'),historyMuted);
    await click('#track-redo');await wait(query(mute)+'.ariaPressed==="false"','重做第二个原有编辑');
    assert.deepEqual(await configSnapshot('取消后原重做二'),unmuted);
    await click('#track-undo');await wait(query(mute)+'.ariaPressed==="true"','回到第一个编辑');
    await click('#track-undo');await wait(query(mute)+'.ariaPressed==="false"','恢复源工程');
    assert.ok(await read(query('#track-undo')+'.disabled'),'到达真实历史起点');
    const finalPoint=await center(target);
    await sameLaneSwap();
    await mouse('mouseReleased',finalPoint);await restored();
    await wait(clipNamed(sameSource,files.green)+' && '+clipNamed(middle,files.green)+' && '+clipNamed(target,files.red),'用最终松手位置完成同轨交换');
    await click('#track-undo');await wait(clipNamed(sameSource,files.red)+' && '+clipNamed(middle,files.green),'一次撤销恢复同轨两个片段');
    assert.ok(await read(query('#track-undo')+'.disabled'),'一次完成的拖拽只占一个历史位置');
    assert.deepEqual(await configSnapshot('同轨互换撤销对照'),baseline);
    async function expectRejected(selector,message) {
      const node=query(selector);
      await wait(node+'.hasAttribute("data-candidate-rejected") && !'+node+'.hasAttribute("data-material-drop") && '+hint+'.textContent==='+JSON.stringify(message),'禁放反馈应显示具体原因');
      assert.equal(await read('getComputedStyle('+node+').cursor'),'not-allowed');
      assert.ok(await read('(()=>{const r='+hint+'.getBoundingClientRect(),pane=document.querySelector("#timeline-tracks-panel").getBoundingClientRect();'
        +'return r.width>0 && r.left>=pane.left && r.right<=pane.right && r.top>=pane.top && r.bottom<=pane.bottom})()'),'禁放说明应显示在时间线可见区域');
    }
    for(const [from,to] of [[sourcePoint,middlePoint],[middlePoint,sourcePoint]]) {
      await mouse('mousePressed',from);await mouse('mouseMoved',to);
      await wait('!!'+query('.candidate-displaced'),'与已有同源素材的分镜互换应预览对方片段');
      await mouse('mouseReleased',to);await restored();
      await wait(clipNamed(source,files.green)+' && '+clipNamed(middle,files.blue)+' && '+clipNamed(cell(1,1),files.blue),'交换后保留两个蓝色实例');
      await click('#track-undo');await wait(clipNamed(source,files.blue)+' && '+clipNamed(middle,files.green),'一次撤销恢复互换前的候选');
      assert.deepEqual(await read(clips),originalClips);
    }

    async function previewSwap() {
      // A notice above the panel can move the lanes between separate gestures.
      const from=await center(source), to=await center(target), home=await bounds(source);
      await mouse('mousePressed',from);
      assert.ok(await read('!'+query(dragVisuals)),'单独按下没有影子或临时落点');
      await mouse('mouseMoved',{x:from.x+6,y:from.y});
      const active=await read('(()=>{const e=document.querySelector(".candidate-moving:popover-open");return e && [document.querySelector("#timeline-clock").dataset.candidateDrag,Number(getComputedStyle(e).opacity)];})()');
      assert.ok(active && active[0]==='active' && active[1]>0 && active[1]<1,'超过 5 px 在本次指针移动即进入半透明拖拽');
      await mouse('mouseMoved',to);
      await wait(atSlot('.candidate-displaced',home),'松手前目标视频应填入源候选行，并适配其宽度');
      await wait(clipNamed('.candidate-displaced',files.green)+' && '+clipNamed('.candidate-moving',files.blue),'预览应显示原片段');
      const lifted=await bounds('.candidate-moving');
      assert.ok(Math.abs(lifted.x+lifted.width/2-to.x)<5 && Math.abs(lifted.y+lifted.height/2-to.y)<5,'提起的视频应跟随指针');
      const moved={x:to.x+14,y:to.y+2};
      await mouse('mouseMoved',moved);
      await wait('Math.abs('+query('.candidate-moving')+'.getBoundingClientRect().x-'+(lifted.x+14)+')<3','目标格内继续移动时视频跟随指针');
      return moved;
    }
    const titleFilters = () => read('[...document.querySelectorAll(".titlebar .glass")].map(button => getComputedStyle(button).backdropFilter)');
    const restingFilters = await titleFilters();
    await previewSwap();
    assert.deepEqual(await titleFilters(), ['none','none'], '手持视频片段时标题按钮暂停采样');
    await mouse('mouseMoved',emptyPoint);
    await wait(query(empty)+'.dataset.materialDrop==="active" && '+atSlot(target,targetBounds),'切换至空分镜后先前的预览应回位');
    await mouse('mouseMoved',targetPoint);await wait(atSlot('.candidate-displaced',sourceBounds),'再次进入时恢复互换预览');
    await key('Escape',27);await restored();
    assert.deepEqual(await titleFilters(), restingFilters, 'Esc 放下片段后标题按钮恢复原材质');
    await mouse('mouseReleased',targetPoint);
    await wait(atSlot(source,sourceBounds),'Esc 后原视频回到原行原列');
    assert.deepEqual(await read(clips),originalClips,'Esc 取消互换');

    await mouse('mousePressed',sourcePoint);await mouse('mouseMoved',emptyPoint);await mouse('mouseReleased',emptyPoint);
    await wait(clipNamed(cell(0,0)+'[title*="'+path.basename(files.blue)+'"]',files.blue)+' && !'+filled(0,1),'空白处按鼠标时间接收视频，源分镜可以在同轨分时放置候选');
    await click('#track-undo');await wait(clipNamed(source,files.blue)+' && !'+filled(3,0),'撤销空分镜移动');
    await restored();
    await mouse('mouseReleased',await previewSwap());await restored();
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
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    await read(query(cell(0,0))+'.focus()');await key('ArrowRight',39,1);
    await wait(clipNamed(middle,files.red)+' && document.activeElement==='+query(middle),'键盘互换后焦点随视频到相邻分镜');
    await key('ArrowLeft',37,1);
    await wait(clipNamed(cell(0,0),files.red)+' && document.activeElement==='+query(cell(0,0)),'连续反向互换回到原槽位');

    const rows='document.querySelectorAll(".sequence-video[data-lane-key]").length';
    const zone='.candidate-new-lane .sequence-content', placement='.candidate-new-placement';
    const ruler='.sequence-ruler .sequence-content';
    async function checkPlacement(axis,scale,start,duration,label) {
      await wait('!!'+query(placement),label+'应显示落点预览');
      const ghost=await bounds(placement);
      const actualStart=(ghost.x-axis.x)/scale,actualEnd=(ghost.right+2-axis.x)/scale;
      assert.ok(Math.abs(ghost.x-axis.x-start*scale)<2 && Math.abs(ghost.right+2-axis.x-(start+duration)*scale)<2,
        label+'预期 '+start.toFixed(2)+'–'+(start+duration).toFixed(2)+' 秒，实际 '+actualStart.toFixed(2)+'–'+actualEnd.toFixed(2)+' 秒');
    }

    const longVideo=path.join(root,'四秒片段.mp4');
    await ffmpeg(['-f','lavfi','-i','color=red:s=160x90:r=24','-f','lavfi','-i','sine=frequency=440',
      '-t','4','-c:v','libx264','-c:a','aac','-threads','2',longVideo]);
    catalog.set('four',await inspectAsset(longVideo,'video'));
    catalog.set('still',await inspectAsset(files.still,'image'));
    // Two real voice tracks and their captions define the first two cuts in the user's draft.
    const durations=[4.358,4.063,4,4];
    for(const [i,duration] of durations.slice(0,2).entries()) {
      const file=path.join(root,'口播'+i+'.wav');
      await ffmpeg(['-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration='+duration,file]);
      catalog.set('voice'+i,await inspectAsset(file,'audio'));
    }
    const refillFixture=path.join(root,'双段口播回填.sdworkbench');
    const twoCandidates=[{id:'four',start:0,end:4},{id:'still',start:0,end:4}];
    await saveProject(refillFixture,{...config,shots:durations.map(()=>twoCandidates),
      shotSettings:durations.map((_,i)=>({name:'ABCD'[i]})),priority:'voice',voiceAlignment:'fill',
      segmentNarrationIds:[['voice0'],['voice1'],[],[]],segmentVoiceCuts:[[null],[null],[],[]],
      generatedCaptions:Object.fromEntries(durations.slice(0,2).map((duration,i)=>['voice'+i,
        {name:'台词',cues:[{start:0,end:Math.round(duration*1000),text:'口播'+i}]}])),
      shotTransitions:[null,null,null,null],musicIds:[],volumeOverrides:[],packaging:undefined,subprojects:undefined},catalog);
    opens.push(refillFixture);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程：双段口播回填") && '+rows+'===2','打开只有两条视频轨的口播工程');
    await fitTimeline();
    const refillGreen=path.join(root,'回填绿片.mp4');
    await ffmpeg(['-f','lavfi','-i','color=lime:s=160x90:r=24','-f','lavfi','-i','sine=frequency=880',
      '-t','1.5','-c:v','libx264','-c:a','aac','-threads','2',refillGreen]);
    const greenTile='.material-tile[title='+JSON.stringify(path.basename(refillGreen))+']';
    const libraryPoint=await center('#materials-heading');
    const fileDrop={items:[],files:[refillGreen],dragOperationsMask:1};
    for(const type of ['dragEnter','dragOver','drop']) await send('dispatchDragEvent',{type,x:libraryPoint.x,y:libraryPoint.y,data:fileDrop});
    await wait('!!'+query(greenTile),'将新的绿色素材放入素材库');
    const beforeMove=await center(cell(2,0));
    await mouse('mousePressed',beforeMove);await mouse('mouseMoved',{x:beforeMove.x+9,y:beforeMove.y});
    const newLaneY=(await center(zone)).y,secondShot=await bounds(shotCell(1));
    const dropInSecond={x:secondShot.x+secondShot.width/2,y:newLaneY};
    await mouse('mouseMoved',dropInSecond);
    const ghostBounds=await bounds(placement);
    await mouse('mouseReleased',dropInSecond);await restored();
    const occupied=cell(2,2)+'[data-move-candidate]', vacancy=cell(2,2)+'.sequence-empty';
    const thirdRow='[data-lane-key="vis2"] .sequence-content';
    await wait('!!'+query(occupied)+' && '+rows+'===3 && !document.getAnimations().some(a=>a.id==="candidate-arrival")','第三轨应显示挪到第二镜的片段');
    const secondBounds=await bounds(shotCell(1)),thirdBounds=await bounds(shotCell(2));
    const placedBounds=await bounds(occupied);
    const hasVacancy=await read('!!'+query(vacancy));
    assert.ok(hasVacancy && Math.abs(placedBounds.right-secondBounds.right)<1 && Math.abs(ghostBounds.width-secondBounds.width)<1,
      '应从 4.358 秒连续填至 8.421 秒，且第三镜第三轨留有可投放空位。'+JSON.stringify({hasVacancy,ghost:ghostBounds.width,placed:placedBounds.width,expected:secondBounds.width}));
    const vacancyBounds=await bounds(vacancy);
    assert.ok(Math.abs(placedBounds.left-secondBounds.left)<1 && Math.abs(vacancyBounds.left-thirdBounds.left)<1 &&
      Math.abs(vacancyBounds.right-thirdBounds.right)<1,'片段与空位的两侧应分别对齐各自的分镜边界');
    assert.equal(await read('Array.from(document.querySelectorAll('+JSON.stringify(thirdRow+' .sequence-empty')+')).some(e=>{const r=e.getBoundingClientRect();return r.left<'+placedBounds.right+' && r.right>'+placedBounds.left+'})'),false,
      '已覆盖的第二镜不得再叠加空位');
    await click('#track-undo');await wait(rows+'===2 && '+clipNamed(cell(2,0),longVideo),'一次撤销应恢复原轨');
    await click('#track-redo');await wait('!!'+query(vacancy)+' && !!'+query(occupied),'重做后可继续回填');
    const redTile='.material-tile[title='+JSON.stringify(path.basename(longVideo))+']';
    const duplicateTargets='document.querySelectorAll('+JSON.stringify(cell(2,2)+'[data-move-candidate][title*="'+path.basename(longVideo)+'"]')+').length';
    async function dragTileToVacancy(tile) {
      const source=await center(tile),target=await center(vacancy);
      await dragLibraryItem(wc,source,target,'application/x-sd-workbench-material',async()=>{
        assert.equal(await read(query(vacancy)+'.dataset.materialDrop'),'active','原分镜第三轨空位应独立高亮');
      });
    }
    await dragTileToVacancy(redTile);
    await wait(duplicateTargets+'===2 && !'+query(vacancy),'同一素材可在同一轨道连续占用两个不同窗口');
    const repeatedPath=await saveAs('同一红片回填原空位');
    const repeated=await loadProject(repeatedPath);
    const repeatedWindows=repeated.config.shots[2].filter(clip=>clip.videoLane===2);
    assert.equal(repeatedWindows[0].id,repeatedWindows[1].id);
    assert.deepEqual(repeatedWindows.map(clip=>[Number(clip.videoStart.toFixed(3)),Number(clip.videoDuration.toFixed(3))]),[[4.358,4.063],[8.421,4]]);
    await click('#track-undo');await wait(duplicateTargets+'===1 && !!'+query(vacancy),'撤销只移除第二个红片实例');
    await dragTileToVacancy(greenTile);
    const refilled=cell(2,2)+'[data-move-candidate][title*="'+path.basename(refillGreen)+'"]';
    await wait('!!'+query(refilled)+' && !'+query(vacancy),'绿色片段应接替原位空槽');
    const afterFill=await bounds(refilled);
    assert.ok(Math.abs(afterFill.left-thirdBounds.left)<1 && Math.abs(afterFill.right-thirdBounds.right)<1,'回填素材应占满第三镜');
    await click('#track-undo');await wait('!!'+query(vacancy)+' && !'+query(refilled),'一次撤销应只移除回填素材');
    await click('#track-redo');await wait('!!'+query(refilled)+' && !'+query(vacancy),'重做应恢复同轨回填素材');
    const refillPath=await saveAs('两轨变三轨并回填');
    const savedRefill=await loadProject(refillPath);
    const laneThree=savedRefill.config.shots[2].filter(clip=>clip.videoLane===2);
    assert.deepEqual(laneThree.map(clip=>[path.basename(savedRefill.assets.get(clip.id).path),
      Number(clip.videoStart.toFixed(3)),Number(clip.videoDuration.toFixed(3))]),
      [[path.basename(longVideo),4.358,4.063],[path.basename(refillGreen),8.421,4]]);
    // Isolate this row in the rendered combination so underlying candidates cannot mask a missing tail frame.
    const isolated=structuredClone(savedRefill.config);
    isolated.trackControls={vis0:{hidden:true},vis1:{hidden:true}};
    isolated.subtitleStyle={...isolated.subtitleStyle,enabled:false};
    for(const shot of isolated.shots) shot.forEach((clip,i)=>{clip.enabled=shot===isolated.shots[2] ? clip.id===laneThree[0].id : i===0;});
    const alternatives=structuredClone(isolated);
    alternatives.count=2;
    alternatives.shots[2].forEach(clip=>{clip.enabled=clip.videoLane===2;});
    const normalPlans=createPreviewBatch(alternatives,savedRefill.assets).plans;
    const ordinaryChoices=normalPlans.map(plan=>plan.clips.filter(clip=>clip.shotIndex===2 && clip.outputFrames!==0).map(clip=>path.basename(clip.asset.path)));
    assert.deepEqual(ordinaryChoices.sort(),[[path.basename(longVideo)],[path.basename(refillGreen)]].sort(),
      '普通混剪保留两种独立组合，每个组合只抽取第三镜的一个候选');
    const supplement=normalPlans.flatMap(plan=>plan.clips).filter(clip=>clip.shotIndex===2 && clip.outputFrames===0);
    assert.equal(supplement.length,1);
    assert.equal(path.basename(supplement[0].asset.path),path.basename(refillGreen));
    assert.equal(supplement[0].outputDuration,0);
    assert.ok(supplement[0].visibleSpans.length>0);
    const renderedWindow=await exportBatch(createPreviewBatch(isolated,savedRefill.assets).plans,root);
    assert.deepEqual(renderedWindow.failures,[]);
    const boundaryPixels=await ffmpeg(['-i',renderedWindow.results[0].path,'-an','-vf',
      "select='eq(n,104)+eq(n,105)+eq(n,201)+eq(n,202)+eq(n,203)',scale=1:1",'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    assert.equal(boundaryPixels.length,15);
    const redFrames=Array.from({length:5},(_,i)=>boundaryPixels[i*3]>180 && boundaryPixels[i*3+1]<40 && boundaryPixels[i*3+2]<40);
    assert.deepEqual(redFrames,[false,true,true,false,false],'24fps 成片第 105 至 201 帧保留红片，202 帧开始下一个窗口');
    opens.push(refillPath);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程：两轨变三轨并回填") && !!'+query(refilled),'重开后仍在原分镜与物理轨道');
    assert.equal(await read(rows),3);
    assert.equal(await read('document.querySelectorAll(".sequence-shots [data-reorder-shot]").length'),4);
    await click('[data-control-key="vis2"] [data-track-action="solo"]');
    await click('[data-control-key="voice0"] [data-track-action="solo"]');
    const soloProject=await loadProject(await saveAs('第三轨独显和口播独听'));
    const soloPlan=createPreviewBatch(soloProject.config,soloProject.assets).plans[0];
    const soloRender=await exportBatch([soloPlan],root);
    assert.deepEqual(soloRender.failures,[]);
    const soloVideo=soloRender.results[0].path;
    const transition=await ffmpeg(['-i',soloVideo,'-an','-vf',
      "select='eq(n,201)+eq(n,202)+eq(n,295)+eq(n,299)',scale=1:1",'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    assert.equal(transition.length,12);
    const colorAt=i=>[...transition.subarray(i*3,i*3+3)].map(v=>v>130);
    assert.deepEqual([0,1,2,3].map(colorAt),[[true,false,false],[false,true,false],[false,true,false],[false,false,false]],
      '独显第三轨时，第二镜末仍是红片，第三镜第一帧切绿，绿色画面持续至第三镜末尾');
    const pcm=await ffmpeg(['-i',soloVideo,'-vn','-ac','1','-ar','8000','-f','s16le','pipe:1']);
    function amplitude(at,hz) {
      const length=800,first=Math.round(at*8000);let x=0,y=0;
      for(let i=0;i<length;i++) {
        const phase=2*Math.PI*hz*i/8000,value=pcm.readInt16LE(2*(first+i));
        x+=Math.cos(phase)*value;y+=Math.sin(phase)*value;
      }
      return Math.hypot(x,y)*2/length;
    }
    const voiceReference=amplitude(.5,660),secondVoice=amplitude(5.5,660);
    assert.ok(voiceReference>400 && Math.abs(secondVoice/voiceReference-1)<.2,'每个分镜独立口播按原音量只混入一次');
    assert.ok(Math.abs(amplitude(5.5,440)/voiceReference-1)<.2 && amplitude(8.425,440)<50 &&
      Math.abs(amplitude(8.6,880)/voiceReference-1)<.2 &&
      Math.abs(amplitude(10.4,880)/voiceReference-1)<.2 && amplitude(12.6,880)<50 && amplitude(9,660)<50,
      '绿片原声按适配速度延续至第三镜并在边界结束，口播不重复');
    await click('#timeline-play');
    await wait('!!'+query('.draft-transport-preview:not([hidden])'),'播放已独显的视频轨');
    await click('#timeline-play');
    for(const [time,channel] of [[8.40,0],[8.60,1],[11.43,1]]) {
      await read(query('#player-position')+'.value='+time+';'+query('#player-position')+'.dispatchEvent(new Event("input"))');
      const pixelTest='(()=>{const v=document.querySelector(".draft-transport-preview:not([hidden]) video.draft-main:not([hidden])");'+
        'if(!v || v.readyState<2 || v.seeking)return false;const c=document.createElement("canvas");c.width=c.height=1;const p=c.getContext("2d");'+
        'p.drawImage(v,0,0,1,1);const rgb=p.getImageData(0,0,1,1).data;return rgb['+channel+']>180 && rgb['+(1-channel)+']<45;})()';
      await wait(pixelTest,'真实轨道预览在 '+time+' 秒应解码已独显轨道的'+(channel?'绿色':'红色')+'画面');
    }
    opens.push(repeatedPath);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程：同一红片回填原空位") && '+duplicateTargets+'===2','重开后保留两段同源但不重叠的红片');
    await fitTimeline();
    const firstCandidate=cell(0,0)+'[data-move-candidate]';
    const libraryType='application/x-sd-workbench-material',copyBefore=await read(clips);
    const lockThird='[data-control-key="vis2"] [data-track-action="locked"]';
    await dragLibraryItem(wc,await center(redTile),()=>center(firstCandidate),libraryType,async()=>{
      assert.equal(await read(query(cell(0,2)+'.sequence-empty')+'.dataset.materialDrop'),'active','占用格下方首个空位在第三轨');
    });
    await wait(clipNamed(cell(0,2),longVideo)+' && '+clipNamed(firstCandidate,longVideo),'同一素材在同镜可同时放在第一和第三轨');
    await click('#track-undo');await wait('!!'+query(cell(0,2)+'.sequence-empty'),'撤销只移除素材库新加的片段');
    assert.deepEqual(await read(clips),copyBefore);

    await click(lockThird);await wait(query(lockThird)+'.getAttribute("aria-pressed")==="true"','锁定第三轨');
    await dragLibraryItem(wc,await center(redTile),()=>center(firstCandidate),libraryType,async()=>{
      await wait(query(zone)+'.dataset.materialDrop==="active" && !!'+query(zone+' .candidate-new-placement'),'跳过锁定的空轨，在新增第四轨预览');
    });
    await wait(clipNamed(cell(0,3),longVideo)+' && '+rows+'===4','已占用的目标下方没有可用轨时新增一轨');
    await click('#track-undo');await wait(rows+'===3','撤销自动新增的视频轨');
    await click(lockThird);

    // The new row lies between the last video lane and the purple storyboard.
    // Choose the second shot after dragstart, when this temporary row exists.
    async function libraryIntoFourth(cancel) {
      await dragLibraryItem(wc,await center(redTile),async()=>{
        const p=await center(zone),second=await bounds(shotCell(1));
        return {x:second.x+second.width/2,y:p.y};
      },libraryType,async()=>{
        const axis=await bounds(ruler),scale=parseFloat(await read(query(shotCell(1))+'.style.left'))/durations[0];
        await checkPlacement(axis,scale,durations[0],durations[1],'素材库拖入第四轨第二镜');
        assert.equal(await read(query(zone)+'.parentElement.nextElementSibling.classList.contains("sequence-shots")'),true);
        if(cancel) await key('Escape',27);
      },cancel);
      await wait('!'+query(zone)+' && !'+query(placement),'结束素材库拖动后清除临时行和精确预览');
    }
    await libraryIntoFourth(true);
    assert.deepEqual(await read(clips),copyBefore,'Esc 不改变轨道或片段');
    await libraryIntoFourth(false);
    await wait(clipNamed(cell(1,3),longVideo)+' && '+rows+'===4','素材库新建第四轨并保留原片');
    const fourthFile=await saveAs('素材库直拖新视频轨');
    const fourthConfig=(await loadProject(fourthFile)).config;
    const fourth=fourthConfig.shots[1].find(clip=>clip.videoLane===3);
    assert.deepEqual([fourth.videoStart,fourth.videoDuration].map(v=>Number(v.toFixed(3))),durations.slice(0,2));
    assert.equal(fourth.videoFit,'hold');
    assert.deepEqual([fourth.start,fourth.end,fourth.autoFitSpeed],[0,4,true]);
    assert.ok(Math.abs(fourth.speed-4/durations[1])<1e-6,
      '四秒原片拖入新轨后应匀速慢放至第二镜末尾');
    assert.deepEqual(fourthConfig.shots.map(shot=>shot.length),repeated.config.shots.map((shot,i)=>shot.length+(i===1?1:0)));
    await click('#track-undo');await wait(rows+'===3','撤销素材库新建的视频轨');
    assert.deepEqual(await read(clips),copyBefore);
    opens.push(fourthFile);await click('#open-project');
    await wait(clipNamed(cell(1,3),longVideo)+' && '+rows+'===4','保存重开后同源实例仍在指定的视频轨与分镜');
    const boundedFile=path.join(root,'四秒片段与空轨.sdworkbench');
    await saveProject(boundedFile,{...config,
      shots:[[{id:'four',start:0,end:4,videoLane:2},{...red,videoLane:0}],[green],[{id:'still',start:0,end:4,videoStart:15}],[{...blue,end:.7,speed:2,speedMode:'manual',videoSubtitles:undefined}]],
      shotSettings:[null,4,4,.35].map((duration,i)=>({name:'ABCD'[i],duration})),
      shotTransitions:[null,null,null,null],segmentNarrationIds:[[],['music'],[],[]],
      segmentVoiceCuts:[[],[{offset:1.4,ranges:[{start:0,end:.4}]}],[],[]],
      generatedCaptions:{},timelineCaptions:{name:'台词',cues:[{start:6400,end:7000,text:'字幕切点'}]},
      musicIds:['music'],volumeOverrides:[],packaging:undefined,
    },catalog);
    opens.push(boundedFile);await click('#open-project');
    await wait(clipNamed(cell(0,2),longVideo)+' && '+query('#notice')+'.textContent.includes("已打开工程：四秒片段与空轨")','打开含四秒片段的工程');
    await verify(['A','B','C','D']);await fitTimeline();
    const boundedBaseline=(await loadProject(await saveAs('四秒片段对照'))).config;
    await read(query('#track-zoom')+'.value='+query('#track-zoom')+'.max;'+query('#track-zoom')+'.dispatchEvent(new Event("input"))');
    await wait(host+'.scrollWidth>'+host+'.clientWidth+100','放大时间线以检查横向滚动后的素材落点');
    await read(query('#timeline-tracks-panel')+'.scrollTop=0');
    let scrollAxis,scrollScale;
    await dragLibraryItem(wc,await center(redTile),async()=>{
      scrollScale=parseFloat(await read(query(shotCell(1))+'.style.left'))/4;
      await read(host+'.scrollLeft='+5.9*scrollScale+'-'+host+'.clientWidth/3');
      assert.ok(await read(host+'.scrollLeft')>0);
      scrollAxis=await bounds(ruler);
      const row=await bounds(zone);
      return {x:scrollAxis.x+5.9*scrollScale,y:row.y+row.height/2};
    },libraryType,async()=>{
      await checkPlacement(scrollAxis,scrollScale,5.8,.6,'横向滚动后素材库片段吸附口播终点和字幕起点');
    });
    // Four source seconds in this 0.6-second drop exceed the default 4× limit.
    await chooseOverflow('continue');
    await wait(clipNamed(cell(1,3),longVideo),'横向滚动后的新轨落位');
    const cutWindow=(await loadProject(await saveAs('素材库滚动吸附'))).config.shots[1].at(-1);
    assert.deepEqual([cutWindow.speed,cutWindow.speedOverflow],[4,'continue'],'新轨按选择的上限继续');
    assert.deepEqual([cutWindow.videoStart,cutWindow.videoDuration].map(n=>Number(n.toFixed(3))),[5.8,.6]);
    await click('#track-undo');await wait(rows+'===3','撤销滚动后的新视频轨');
    await fitTimeline();
    const secondLane='[data-lane-key="vis1"] .sequence-content';
    async function dragIntoCutWindow(shot,lane,file,destination,at,start,span,{acrossCut=false,choice,speed}={}) {
      await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','等待源片归位');
      await read(query('#timeline-tracks-panel')+'.scrollTop=0');
      const origin=await center(cell(shot,lane));
      await mouse('mousePressed',origin);await mouse('mouseMoved',{x:origin.x+8,y:origin.y});
      const rowPoint=await center(destination),axis=await bounds(ruler);
      const scale=parseFloat(await read(query(shotCell(1))+'.style.left'))/4;
      const point=seconds=>({x:axis.x+seconds*scale,y:rowPoint.y});
      await mouse('mouseMoved',point(at));await checkPlacement(axis,scale,start,span,'指针位于 '+at+' 秒');
      if(acrossCut) {
        await mouse('mouseMoved',point(6.55));await checkPlacement(axis,scale,6.4,.6,'跨过字幕起点');
        await mouse('mouseMoved',point(7.45));await checkPlacement(axis,scale,7,1,'跨过字幕终点后贴到下一分镜');
        await mouse('mouseMoved',point(at));await checkPlacement(axis,scale,start,span,'返回原窗口');
      }
      await mouse('mouseReleased',point(at));await restored();
      if(choice) await chooseOverflow(choice);
      const targetLane=destination===secondLane ? 1 : 3;
      await wait(clipNamed(cell(shot,targetLane),file),'移动后保留素材及所属分镜');
      const after=(await loadProject(await saveAs('窗口落盘-'+shot+'-'+targetLane+'-'+at))).config;
      const original=boundedBaseline.shots[shot][0],result=after.shots[shot][0];
      assert.ok(Math.abs(result.videoStart-start)<.001);
      const defaultDuration=boundedBaseline.shotSettings[shot].duration ?? (original.end-original.start)/(original.speed ?? 1);
      assert.ok(Math.abs((result.videoDuration ?? defaultDuration)-span)<.001);
      assert.deepEqual([result.start,result.end],[original.start,original.end],'移动保留源入出点');
      assert.deepEqual([result.speed,result.speedOverflow],[speed ?? original.speed,choice],'自动片段按新窗口对齐，手动片段保留倍速');
      await click('#track-undo');await wait(clipNamed(cell(shot,lane),file)+' && '+rows+'===3','一次撤销恢复原片和轨数');
      assert.deepEqual((await loadProject(await saveAs('窗口撤销-'+shot+'-'+targetLane+'-'+at))).config,boundedBaseline);
    }
    await dragIntoCutWindow(0,2,longVideo,secondLane,5.9,5.8,.6,{acrossCut:true,choice:'continue',speed:4});
    await dragIntoCutWindow(0,2,longVideo,secondLane,9.9,8,4,{speed:1});
    await dragIntoCutWindow(0,2,longVideo,zone,5.9,5.8,.6,{choice:'continue',speed:4});
    await dragIntoCutWindow(2,0,files.still,'#new-shot-drop',5.9,5.8,.6);
    await dragIntoCutWindow(3,0,files.blue,secondLane,2.65,0,4);
    await dragIntoCutWindow(1,0,files.green,secondLane,2.65,0,4,{choice:'hold',speed:.25});

    const outSource=await center(cell(0,2));
    await mouse('mousePressed',outSource);await mouse('mouseMoved',{x:outSource.x+8,y:outSource.y});
    const outY=(await center(zone)).y,outAxis=await bounds(ruler);
    const pastCuts={x:outAxis.left+14*parseFloat(await read(query(shotCell(1))+'.style.left'))/4,y:outY};
    await mouse('mouseMoved',pastCuts);
    await wait(host+'.hasAttribute("data-drag-rejected") && !'+query(placement)+' && !!'+hint+'.textContent','全部切点之外不能新建视频轨');
    await mouse('mouseReleased',pastCuts);await restored();
    assert.equal(await read(rows),3);
    assert.deepEqual((await loadProject(await saveAs('参考范围外松手'))).config,boundedBaseline);

    const shotBoundary=()=>read('parseFloat('+query(shotCell(1))+'.style.left)');
    const boundaryBefore=await shotBoundary();
    await read(query('#timeline-tracks-panel')+'.scrollTop=0');
    const shortCandidate=await center(cell(0,0));
    await mouse('mousePressed',shortCandidate);await mouse('mouseMoved',{x:shortCandidate.x+9,y:shortCandidate.y});
    const shortTarget=await center(secondLane),shortAxis=await bounds(ruler);
    const shortDrop={x:shortAxis.x+5.9*boundaryBefore/4,y:shortTarget.y};
    await mouse('mouseMoved',shortDrop);await checkPlacement(shortAxis,boundaryBefore/4,5.8,.6,'拖动非首选候选');
    await mouse('mouseReleased',shortDrop);await restored();
    await wait(clipNamed(cell(0,1),files.red),'非首选候选落到第二轨');
    assert.ok(Math.abs(await shotBoundary()-boundaryBefore)<1,'放下 1 秒候选后，下一分镜仍从 4 秒开始');
    const selectedFile=await saveAs('移动非首选候选');
    const shortSaved=(await loadProject(selectedFile)).config.shots[0][1];
    assert.ok(Math.abs(shortSaved.videoStart-5.8)<.001 && Math.abs(shortSaved.videoDuration-.6)<.001);
    await click('#track-undo');await wait(clipNamed(cell(0,0),files.red),'一次撤销还原非首选候选');
    assert.deepEqual((await loadProject(await saveAs('非首选候选撤销'))).config,boundedBaseline);
    opens.push(selectedFile);await click('#open-project');
    await wait(clipNamed(cell(0,1),files.red)+' && '+query('#notice')+'.textContent.includes("已打开工程：移动非首选候选")','重开已移动非首选候选的工程');
    await fitTimeline();
    assert.ok(Math.abs(await shotBoundary()-boundaryBefore)<1,'重开后分镜与预览切点一致');

    const singleFile=path.join(root,'新增轨道原稿.sdworkbench');
    // This fixture checks held tail frames after a lane move at a user-locked source rate.
    await saveProject(singleFile,{...config,shots:[[{...red,start:.1,speed:1,speedMode:'manual',volume:43,layers:[layer('片段包装')]}],[green],[blue]],
      mutedVideoTracks:[0]},catalog);
    opens.push(singleFile);await click('#open-project');await verify(['A','B','C']);await fitTimeline();
    const singleBaseline=(await loadProject(await saveAs('新增轨前'))).config;
    const expectedClips=await read(clips);
    async function hoverNewLane(row) {
      await wait('!document.getAnimations().some(a=>a.id==="candidate-arrival")','等待上一操作的片段归位');
      const start=await center(cell(0,row));
      const otherColumn=await bounds(shotCell(1));
      await mouse('mousePressed',start);
      await mouse('mouseMoved',{x:start.x+9,y:start.y});
      await wait('!!'+query(zone),'提起已放置的片段后可拖入视频轨下方');
      await center(zone);
      const area=await bounds(zone),end={x:otherColumn.x+otherColumn.width/2,y:area.y+area.height/2};
      await mouse('mouseMoved',end);
      await wait(query(zone)+'.dataset.materialDrop==="active"','指针在另一分镜下方也应可新增原分镜的视频轨');
      const axis=await bounds(ruler),scale=parseFloat(await read(query(shotCell(1))+'.style.left'))/1.2;
      await checkPlacement(axis,scale,1.2,.65,'进入第二分镜');
      await mouse('mouseMoved',{x:end.x+17,y:end.y});
      await checkPlacement(axis,scale,1.2,.65,'在同一个分镜内移动');
      const first={x:axis.x+.6*scale,y:end.y};
      await mouse('mouseMoved',first);
      await checkPlacement(axis,scale,0,1.2,'回到第一分镜，覆盖到第一镜末端');
      return first;
    }
    await evidenceViewport('dark');
    let hover=await hoverNewLane(0);
    await captureDrag('dark-new-video-track');
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
    await evidenceViewport('light',1366,768);
    hover=await hoverNewLane(0);
    await captureDrag('compact-new-video-track');
    await key('Escape',27);await mouse('mouseReleased',hover);await restored();
    assert.equal(await read(rows),1,'直接取消新增轨道后仍只有原轨');
    assert.equal(await read(query('#track-undo')+'.disabled'),true,'取消操作不应产生可撤销的编辑');
    assert.deepEqual(await configSnapshot('新增轨取消对照'),singleBaseline);
    await evidenceViewport('light');

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
    const reposition={x:axis.x+1.53*scale,y:held.y};
    await mouse('mousePressed',held);await mouse('mouseMoved',reposition);
    await checkPlacement(axis,scale,1.2,.65,'从片段左侧抓取后拖过分镜边界');
    await mouse('mouseReleased',reposition);await restored();
    const retimed=await loadProject(await saveAs('同轨依分镜放置'));
    assert.ok(Math.abs(retimed.config.shots[0][0].videoStart-1.2)<.001 && Math.abs(retimed.config.shots[0][0].videoDuration-.65)<.001);
    await click('#track-undo');await wait(clipNamed(cell(0,1),files.red),'撤销同轨裁切');
    await read(host+'.scrollLeft=0');await fitTimeline();
    await commitNewLane(1,true);
    const savedLanes=await saveAs('两次新增视频轨');
    const reopened=await loadProject(savedLanes);
    assert.equal(reopened.config.shots[0][0].videoLane,2);
    assert.ok(Math.abs(reopened.config.shots[0][0].videoStart-expectedTime)<.012 && Math.abs(expectedTime)<.012,'工程保存的落点与第一分镜起点一致');
    const comparison=structuredClone(reopened.config);
    assert.ok(Math.abs(comparison.shots[0][0].videoDuration-1.2)<.001,'短视频以原速播放并保持尾帧至 1.2 秒');
    delete comparison.shots[0][0].videoDuration;
    assert.equal(comparison.shots[0][0].videoFit,'hold');
    delete comparison.shots[0][0].videoFit;
    delete comparison.shots[0][0].videoLane;
    delete comparison.shots[0][0].videoStart;
    assert.deepEqual(comparison,singleBaseline,'仅当前候选的时间轴位置和显示时长发生改变');
    opens.push(savedLanes);await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程") && '+clipNamed(cell(0,2),files.red),'重开后显示两个空位和第三行的原片段');
    assert.equal(await read(rows),3);
    await click(cell(0,2));
    const thirdLaneMute='[data-control-key="vis2"] [data-track-action="muted"]';
    assert.equal(await read(query(thirdLaneMute)+'.ariaPressed'),'false','移出静音行的片段应恢复其原音量');
    const draftVideo=query('.draft-transport-preview:not([hidden]) video.draft-main');
    await click('#timeline-play');
    await wait(draftVideo+'?.readyState>=2 && !'+draftVideo+'.paused','轨道预览应播放红色素材');
    await click('#timeline-play');
    await read(query('#player-position')+'.value=1.13;'+query('#player-position')+'.dispatchEvent(new Event("input"))');
    await wait(draftVideo+'?.readyState>=2 && !'+draftVideo+'.seeking && '+draftVideo+'.muted && '+draftVideo+'.paused','源片结束后轨道预览应停在静音的最后一帧');
    const heldPixel=await read('(()=>{const c=document.createElement("canvas");c.width=1;c.height=1;const p=c.getContext("2d");p.drawImage('+draftVideo+',0,0,1,1);return Array.from(p.getImageData(0,0,1,1).data)})()');
    assert.ok(heldPixel[0]>180 && heldPixel[1]<45 && heldPixel[2]<45,'真实播放器的延时区应显示红色尾帧');
    assert.ok(Math.abs(await read(draftVideo+'.currentTime')-1)<.045,'应停在裁选区间尾帧');
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
    await click(thirdLaneMute);
    const muted=(await loadProject(await saveAs('第三行静音')));
    assert.deepEqual(muted.config.mutedVideoTracks,[0,2],'轨道头应切换所在物理视频行的静音');
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
    await chooseOverflow('continue');
    await wait(clipNamed(cell(0,0),files.red),'裁切后只移动红片到原轨');
    const cutFile=await saveAs('按参考边界裁切后');
    const cutSaved=await loadProject(cutFile), cut=cutSaved.config.shots[0][0];
    assert.ok(Math.abs(cut.videoStart-.7)<.001 && Math.abs(cut.videoDuration-.28)<.001,'裁到 0.70–0.98 秒');
    assert.deepEqual([cut.start,cut.end,cut.speed,cut.speedOverflow],[.1,1.3,4,'continue'],'保留原素材入出点和确认的倍速策略');
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
    async function switchProject(id) {
      await wait('!'+query('#subproject-select')+'.disabled','工程打开完成后可以切换子工程');
      await read(`(()=>{const e=${query('#subproject-select')};e.value=${JSON.stringify(id)};e.dispatchEvent(new Event("change"))})()`);
    }
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

    const rulerElement=query(ruler), visibleTicks=rulerElement+'.querySelectorAll(".sequence-tick")';
    async function openLongTimeline(name,videoStart) {
      const file=path.join(root,name+'.sdworkbench');
      const shots=[...config.shots.slice(0,2),[{...config.shots[2][0],videoLane:1,videoStart}]];
      await saveProject(file,{...config,shots,musicIds:[]},catalog);
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
    await wait('parseFloat('+visibleTicks+'[0]?.style.left)>100000','滚到片尾后只绘制视窗附近的刻度');
    const dayEdge={x:await read(host+'.getBoundingClientRect().right-2'),y:daySource.y};
    await mouse('mouseMoved',dayEdge);
    await wait(host+'.hasAttribute("data-drag-rejected") && !'+query(placement),'超长旧工程尾端超过所有参考切点时禁止放置');
    await key('Escape',27);await mouse('mouseReleased',dayEdge);
    await restored();
    await read('new Promise(done=>setTimeout(()=>done(true),0))');
    await wait('Number('+rulerElement+'.dataset.width)==='+dayWidth,'取消后恢复超长工程的原始宽度');
    await openLongTimeline('极远落点',Number.MAX_SAFE_INTEGER);
    await wait('Number('+rulerElement+'.dataset.width)>1e13 && '+visibleTicks+'.length>0 && '+visibleTicks+'.length<200','极远落点的时间尺仅绘制有界数量的刻度');
    const fittedFile=path.join(root,'分镜槽内的自动倍速素材.sdworkbench');
    const reorderedFile=path.join(root,'自动倍速分镜重排.sdworkbench');
    await saveProject(fittedFile,{...config,priority:'picture',
      shotSettings:['A','B','C'].map(name=>({name,duration:1})),
      shots:['red','green','blue'].map((id,videoStart)=>[{id,start:0,end:1,speed:1,
        autoFitSpeed:true,videoStart,videoDuration:1,videoFit:'hold'}])},catalog);
    opens.push(fittedFile);saves.push(reorderedFile);
    await click('#open-project');await verify(['A','B','C']);await fitTimeline();
    await drag(2,0,.2);await verify(['C','A','B']);
    await click('#save-project');await wait(query('#notice')+'.textContent.includes("工程已保存")','保存带槽位的分镜顺序');
    const reordered=await loadProject(reorderedFile);
    assert.deepEqual(reordered.config.shots.map(([clip])=>clip.videoStart),[0,1,2]);
    const fittedBatch=createPreviewBatch(reordered.config,reordered.assets);
    const fittedPlans=selectPreviewPlans(fittedBatch,reordered.config,{id:fittedBatch.id,indices:[0]});
    const fittedRender=await exportBatch(fittedPlans,root);
    assert.deepEqual(fittedRender.failures,[]);
    const fittedColors=[];
    for (const mid of [.5,1.5,2.5]) {
      const rgb=await ffmpeg(['-ss',String(mid),'-i',fittedRender.results[0].path,'-frames:v','1','-an',
        '-vf','crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
      fittedColors.push(rgb.indexOf(Math.max(...rgb)));
    }
    assert.deepEqual(fittedColors,[2,0,1],'自动倍速视频应随分镜一起重排并导出蓝、红、绿三镜');
    assert.deepEqual(opens,[]);assert.deepEqual(saves,[]);
    console.log('分镜排序、视频换轨与新建轨道、取消与撤销重做、复制粘贴、子工程重开及成片画面与原声验证通过。');
  } finally {
    wc.debugger.detach();win.destroy();
  }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

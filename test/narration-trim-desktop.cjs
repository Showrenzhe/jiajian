'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeTheme } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject, loadProject } = require('../src/project-format.cjs');
const { ffmpeg } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { timing, narrationTimeline } = require('../src/ui/draft-transport.js');
const { smartDefaults } = require('../src/ui/narration-trim.js');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

function checkSubframeVoice() {
  const clip={asset:{id:'short',kind:'video'},start:0,end:.1,speed:4};
  const voice={id:'voice',duration:1};
  const state={shots:[[clip],[clip]],settings:[],segments:[[voice],[voice]],whole:[],priority:'picture',segmented:true,
    narrationTrim:smartDefaults,fps:30,voiceDuration:()=>1,voiceOffset:()=>0};
  const layout=timing(state,()=>.025,()=>null),speech=narrationTimeline(state,layout);
  assert.equal(layout.total,2/30);
  assert.equal(speech.track(0,0).map.duration,.025);
  assert.equal(speech.track(1,0).start,1/30);
  assert.equal(speech.track(1,0).map.fadeDuration,.025);
}
async function run(root) {
  checkSubframeVoice();
  app.setPath('userData',path.join(root,'electron'));
  const catalog=new Map();
  for (const [index,id] of ['picture','sentence','pause','hard'].entries()) {
    const video=index===0,file=path.join(root,id+(video ? '.mp4' : '.wav'));
    const source=video ? 'color=c=steelblue:s=320x180:r=30:d=2' : 'sine=frequency='+index*330+':duration=3:sample_rate=48000';
    await ffmpeg(['-f','lavfi','-i',source,...(id==='pause' ? ['-af',"volume=0:enable='between(t,1.58,1.92)'"] : []),
      ...(video ? ['-c:v','libx264','-threads','1'] : []),file]);
    catalog.set(id,await inspectAsset(file,video ? 'video' : 'audio'));
  }
  const file=path.join(root,'口播.jiajian'),saved=path.join(root,'调整后.jiajian');
  const voices=['sentence','pause','hard'];
  const config={ratio:'16:9',resolution:720,fps:30,fit:'fit',keepAudio:false,count:1,unordered:false,useOriginal:true,useMirrors:false,
    priority:'picture',musicIds:[],musicVolume:35,narrationMode:'segmented',segmentNarrationIds:voices.map(id=>[id]),
    generatedCaptions:{sentence:{name:'台词',cues:[{start:100,end:1650,text:'先说第一句。'},{start:1650,end:2800,text:'随后'}]}},
    timelineCaptions:{name:'固定',cues:[{start:1700,end:1900,text:'固定字幕'}]},
    shots:voices.map(()=>[{id:'picture',start:0,end:2}])};
  await saveProject(file,config,catalog);
  const doc=JSON.parse(await fs.readFile(file,'utf8'));
  doc.version=4;delete doc.config.narrationTrim;
  await fs.writeFile(file,JSON.stringify(doc));
  const output=path.join(root,'export');
  await fs.mkdir(output);
  const opens=[file,saved,saved];
  const win=await launchDesktop({show:false,dataDirectory:path.join(root,'profile'),dialogs:{
    async showOpenDialog(_win,{title}){
      if(title==='选择导出目录') return {canceled:false,filePaths:[output]};
      assert.equal(title,'打开工程');
      assert.ok(opens.length);
      return {canceled:false,filePaths:[opens.shift()]};
    },
    async showSaveDialog(){return {canceled:false,filePath:saved};},
  }});
  win.setContentSize(1366,768);win.show();win.focus();
  const wc=win.webContents;
  wc.setBackgroundThrottling(false);
  const read=expr=>wc.executeJavaScript(expr,true);
  async function click(selector) {
    // An inspector disclosure or workspace transition can move the target between two paints.
    const deadline=Date.now()+5000;
    while (true) {
      try {await clickVisible(wc,selector);return;}
      catch (error) {
        if (Date.now()>=deadline || !error.message.startsWith('无法点击可见的控件')) throw error;
        await delay(50);
      }
    }
  }
  const q=selector=>'document.querySelector('+JSON.stringify(selector)+')';
  const selector='#narration-trim-mode',mode=q(selector),fadeSelector='[data-trim-field=fadeMs]',fade=q(fadeSelector);
  async function wait(expr) {
    for (const end=Date.now()+12000;Date.now()<end;) {
      if (await read(expr)) return;
      await delay(30);
    }
    throw Error('等待界面状态超时 '+expr+' / '+await read(q('#notice')+'.textContent'));
  }
  async function key(name,code,virtualKey,modifiers=0) {
    const options={key:name,code,windowsVirtualKeyCode:virtualKey,modifiers};
    for (const type of ['keyDown','keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',{...options,type});
  }
  const marker=i=>'.sequence-voice [data-voice-shot="'+i+'"][data-voice-row="0"]';
  const detail=i=>q(marker(i))+'?.getAttribute("aria-label")';
  wc.debugger.attach();
  await click('#home-open-project');
  await wait(q(marker(0))+'?.checkVisibility()');
  if(await read(q('#editing-tour button')+'?.checkVisibility()')) await click('#editing-tour button');
  await click('#inspector-tab-narration');
  await click('#narration-trim-settings summary');
  assert.equal(await read(mode+'.value'),'legacy');
  assert.match(await read(detail(0)),/结尾 1 秒/);
  await click(selector);
  await key('ArrowUp','ArrowUp',38);
  await key('Enter','Enter',13);
  await wait(mode+'.value==="smart"');
  await wait(detail(0)+'?.includes("结尾 1.35 秒")');
  await wait('Number('+detail(1)+'?.match(/结尾 ([.\\d]+)/)?.[1])>1.2');
  const pauseTrim=Number((await read(detail(1))).match(/结尾 ([.\d]+)/)[1]);
  assert.ok(Math.abs(pauseTrim-1.25)<.025,'取实测停顿中点');
  await click('#track-undo');
  await wait(mode+'.value==="legacy"');
  await click('#track-redo');
  await wait(mode+'.value==="smart"');
  await click(fadeSelector);
  await key('a','KeyA',65,2);
  await wc.debugger.sendCommand('Input.insertText',{text:'150'});
  await key('Tab','Tab',9);
  await wait(fade+'.value==="150"');
  for(const theme of ['light','dark']) {
    nativeTheme.themeSource=theme;
    await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme)+' && !document.documentElement.hasAttribute("data-theme-changing")');
    await read(q('#narration-trim-settings summary')+'.scrollIntoView({block:"start",behavior:"instant"})');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const view=await read('({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,field:'+fade+'.getBoundingClientRect().toJSON()})');
    assert.equal(view.scroll,view.width);assert.ok(view.field.x>=0 && view.field.right<=view.width && view.field.top>=0 && view.field.bottom<=view.height);
    if(process.env.JIAJIAN_NARRATION_EVIDENCE) {
      await fs.mkdir(process.env.JIAJIAN_NARRATION_EVIDENCE,{recursive:true});
      const image=await win.capturePage();
      assert.deepEqual(image.getSize(),{width:1366,height:768});
      await fs.writeFile(path.join(process.env.JIAJIAN_NARRATION_EVIDENCE,'1366x768-'+theme+'.png'),image.toPNG());
    }
  }
  await click('#save-project');
  await wait(q('#notice')+'.textContent.includes("工程已保存")');
  assert.equal((await loadProject(saved)).config.narrationTrim.fadeMs,150);
  await click('#open-project');
  await wait(q('#notice')+'.textContent.includes("已打开工程")');
  assert.equal(await read(fade+'.value'),'150');
  await read(q(marker(0))+'.focus()');
  await wait(q('.timeline-context-hint')+'.textContent.includes("结尾 1.35 秒")');
  await read(q('#timeline-clock')+'.focus()');
  const monitor=read(`new Promise(resolve=>{
    const points=[],begin=performance.now();
    function sample() {
      const state=timeline.draftState();
      if(state?.playing) {
        const audio=document.querySelector('.draft-transport-preview audio');
        points.push([state.time,Boolean(audio),audio?.volume,document.querySelector('.draft-transport-preview')?.innerText.includes('固定字幕')]);
      }
      if(performance.now()-begin>11000 || (points.length && !state?.playing)) resolve(points);
      else requestAnimationFrame(sample);
    }
    sample();
  })`);
  await key(' ','Space',32);
  const points=await monitor;
  const has=(from,to,condition)=>points.some(([t,...rest])=>t>from && t<to && condition(...rest));
  assert.ok(has(1.15,1.55,active=>active) && has(1.7,1.89,(active,_v,fixed)=>!active && fixed),'句末断点后只剩固定轴字幕');
  assert.ok(has(3.35,3.62,active=>active) && has(3.84,3.98,active=>!active),'实测停顿处提前收声');
  assert.ok(has(5.65,5.83,(active,v)=>active && v===1),'进入硬切淡出前保持音量');
  const fadePoints=points.filter(([t,active])=>active && t>5.87 && t<5.985);
  assert.ok(fadePoints.length>=2 && fadePoints.some(([, ,v])=>v>0 && v<.8),'实时硬切按当前淡出时长减小音量');
  for(const [t,,v] of fadePoints) assert.ok(Math.abs(v-(6-t)/.15)<.2,'实时音量对齐播放头');
  console.log('实时口播：句末 1.650 秒，停顿 '+(3-pauseTrim).toFixed(3)+' 秒。硬切倒数 150 ms 音量采样',fadePoints.map(([t,,v])=>[+t.toFixed(3),+v.toFixed(3)]));
  await click('#prepare-preview');
  await wait(q('.preview-composition')+' && !'+q('.preview-composition')+'.disabled');
  await click('.preview-composition');
  await wait(q('#preview-name')+'.textContent==="混剪预览 1" && '+q('#preview')+'.readyState>=2');
  const preview=path.join(root,'preview.mp4');
  const response=await wc.session.fetch(await read(q('#preview')+'.currentSrc'));
  assert.equal(response.status,200);
  await fs.writeFile(preview,Buffer.from(await response.arrayBuffer()));
  // Reopening the saved document drops the generated batch. Export through the independent direct entry.
  await click('#open-project');
  await wait(q('#notice')+'.textContent.includes("已打开工程") && !'+q('.preview-composition')+' && !'+q('#start-export')+'.disabled');
  await click('#start-export');
  await wait(q('#output-status')+'.textContent.includes("已保存 1 条")');
  const exports=(await fs.readdir(output)).filter(name=>name.endsWith('.mp4'));
  assert.equal(exports.length,1);
  const final=path.join(output,exports[0]);
  const decode=file=>ffmpeg(['-i',file,'-map','0:a:0','-ac','1','-ar','48000','-f','s16le','pipe:1']);
  const [previewAudio,finalAudio]=await Promise.all([decode(preview),decode(final)]);
  assert.ok(previewAudio.equals(finalAudio),'生成预览与独立直接导出的完整 PCM 一致');
  assert.ok(Math.abs(finalAudio.length/96000-6)<.025,'末帧仍在画面结束处');
  const rms=(start,end)=>{
    let sum=0;
    const begin=Math.round(start*48000),stop=Math.round(end*48000);
    for(let i=begin;i<stop;i++) sum+=finalAudio.readInt16LE(2*i)**2;
    return Math.sqrt(sum/(stop-begin));
  };
  const base=rms(5.68,5.78);
  assert.ok(rms(1.59,1.64)>base*.8 && rms(1.7,1.89)<base*.01,'句末后口播静音');
  assert.ok(rms(3.4,3.55)>base*.8 && rms(3.84,3.98)<base*.01,'停顿末端的后续话音已裁掉');
  const gains=fadePoints.map(([t,,volume])=>{
    const decoded=rms(t-.003,t+.003)/base;
    assert.ok(Math.abs(decoded-volume)<.20,'编码后的声音与实时播放淡出量对齐');
    return +decoded.toFixed(3);
  });
  console.log('生成预览与独立直接导出相同 PCM 样本数',finalAudio.length/2,'实际归一化 RMS',gains);
  await click('#title-home');
  await wait(q('#home-create')+'?.checkVisibility() && !'+q('#home-create')+'.disabled && !document.getAnimations().some(a=>a.effect?.target?.contains('+q('#home-create')+') && a.playState==="running")');
  await click('#home-create');
  await wait(mode+'.value==="smart" && '+fade+'.value==="100"');
  console.log('旧工程手动启用、参数、撤销重做、保存重开、新工程默认、键盘裁短说明、明暗紧凑窗口均通过。');
}
async function main() {
  const parent=await fs.realpath(os.tmpdir());
  const managed=process.env.JIAJIAN_NARRATION_TEST_ROOT;
  const root=managed || await fs.mkdtemp(path.join(parent,'jiajian-narration-trim-'));
  if (!managed) process.env.TEMP=process.env.TMP=process.env.TMPDIR=root;
  try { await run(root); }
  finally {
    // The desktop runner removes its profile after Chromium closes its files.
    if (!managed) {
      const dir=await fs.realpath(root);
      assert.equal(path.dirname(dir),parent);
      assert.ok(path.basename(dir).startsWith('jiajian-narration-trim-'));
      await fs.rm(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100}).catch(error=>{
        if(!['EBUSY','EPERM','ENOTEMPTY'].includes(error.code)) throw error;
      });
    }
  }
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

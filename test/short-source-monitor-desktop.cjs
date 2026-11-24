'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeImage } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { clickVisible, dragLibraryItem } = require('./desktop-input.cjs');
const { ffmpeg } = require('./fixtures.cjs');

const first = 4.358, second = 4.063, sourceEnd = 2.016, rate = sourceEnd / second;
const shot = i => '.sequence-video [data-drop-shot="' + i + '"][data-move-candidate]';
const empty = '.sequence-video [data-drop-shot="1"].sequence-empty';
const tile = '.material-tile[title="渐亮短片.mp4"]';
const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';

async function fixtures(dir) {
  const sources = [
    ['long', '第一镜.mp4', ['-f','lavfi','-i','color=red:s=432x768:r=25:d=10.68']],
    // At source 1.49 s the visible patch is ~189/255, at 1.89 s ~240/255.
    ['short','渐亮短片.mp4', ['-f','lavfi','-i','color=white:s=432x768:r=50:d=2.02','-vf','fade=in:0:100']],
    ['one','0001.wav', ['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration='+first]],
    ['two','0002.wav', ['-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration='+second]],
  ];
  const catalog = new Map(await Promise.all(sources.map(async ([id, name, args]) => {
    const audio = name.endsWith('.wav'), file = path.join(dir, name);
    await ffmpeg([...args,...(audio ? [] : ['-c:v','libx264','-threads','1']),file]);
    return [id,await inspectAsset(file,audio ? 'audio' : 'video')];
  })));
  const config = {
    ratio:'9:16',resolution:720,fps:30,fit:'fit',keepAudio:true,unordered:false,useOriginal:true,
    useMirrors:false,count:1,priority:'voice',narrationMode:'segmented',proxyEnabled:true,musicIds:[],musicVolume:50,
    segmentNarrationIds:[['one'],['two']], segmentVoiceCuts:[[null],[null]], shotSettings:[null,null],
    generatedCaptions:Object.fromEntries([['one',first,'第一句'],['two',second,'第二句']].map(([id,length,text])=>
      [id,{name:'分镜口播.srt',cues:[{start:0,end:Math.round(length*1000),text}]}])),
    materialBins:[{scope:null,ids:['short'],hidden:[]}],
    shots:[[{id:'long',start:0,end:10.648,videoStart:0,videoDuration:first,videoFit:'hold',autoFitSpeed:true,speed:10.648/first}],[]],
  };
  const blank = path.join(dir,'口播与字幕.sdworkbench'), legacy = path.join(dir,'旧草稿.sdworkbench');
  await saveProject(blank,config,catalog);
  // Model the persisted document itself. Passing the stale speed through today's writer
  // could repair the fixture before the test has exercised opening an old draft.
  const document = JSON.parse(await fs.readFile(blank,'utf8'));
  document.config.shots[1].push({id:'short',start:0,end:sourceEnd,videoStart:first,videoDuration:second,
    videoFit:'hold',volume:100,speed:1,autoFitSpeed:true});
  await fs.writeFile(legacy,JSON.stringify(document));
  return {blank,legacy};
}

async function check() {
  const dir = mkdtempSync(path.join(os.tmpdir(),'jiajian-short-monitor-'));
  app.setPath('userData',dir);
  app.setPath('sessionData',dir);
  const {blank,legacy} = await fixtures(dir);
  let openFile = legacy;
  const win = await launchDesktop({show:process.env.JIAJIAN_MONITOR_FOREGROUND==='1',dataDirectory:path.join(dir,'profile'),dialogs:{
    async showOpenDialog() { return {canceled:false,filePaths:[openFile]}; },
  }});
  win.setContentSize(1440,960);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = js => wc.executeJavaScript(js,true);
  const click = selector => clickVisible(wc,selector);
  const mouse = (type,coords) => wc.debugger.sendCommand('Input.dispatchMouseEvent',{
    type,...coords,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,
  });
  async function point(selector,fraction=.5) {
    return read(`(async()=>{
      const el=${q(selector)};el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      await new Promise(requestAnimationFrame);
      const r=el.getBoundingClientRect();return {x:r.x+r.width*${fraction},y:r.y+r.height*.5};
    })()`);
  }
  const state = `(()=>{
    const get=s=>document.querySelector(s);
    const draft=get('.draft-transport-preview:not([hidden]) video.draft-main:not([hidden])');
    const v=draft || get('#preview');
    const fps=draft ? 30 : (get('#preview-heading').textContent==='素材预览' ? 50 : 30);
    const clock=s=>{const [h,m,t,f]=get(s).textContent.split(':').map(Number);return h*3600+m*60+t+f/fps;};
    return {source:v.currentTime,rate:v.playbackRate,paused:v.paused,ready:v.readyState,seeking:v.seeking,
      clock:clock('#player-time'),duration:clock('#player-duration'),range:get('#player-position').max,
      title:get('#'+get('#player-pane').getAttribute('aria-labelledby')).textContent,
      proxy:get('.player-quality-label').textContent,playing:get('#player-play').ariaPressed==='true'};
  })()`;
  async function until(check,label,timeout=8000) {
    let value;
    for(const end=Date.now()+timeout;Date.now()<end;) {
      value=await check();
      if(value) return value;
      await delay(22);
    }
    throw Error(label+' '+JSON.stringify(await read(state))+' '+await read(q('#notice')+'.textContent'));
  }
  const waitState=(test,label)=>until(async()=>{const s=await read(state);return test(s) && s;},label);
  async function pixel() {
    const clip=await read(`(()=>{const r=${q('.preview-stage')}.getBoundingClientRect();
      return {x:r.x+r.width*.5,y:r.y+r.height*.42,width:2,height:2,scale:1};})()`);
    const {data}=await wc.debugger.sendCommand('Page.captureScreenshot',{clip});
    const [b,g,r]=nativeImage.createFromBuffer(Buffer.from(data,'base64')).toBitmap();
    return [r,g,b];
  }
  const lightAt=t=>Math.min(255,t*127.5);
  const matchesLight=(rgb,t,tolerance=12)=>rgb.every(c=>Math.abs(c-lightAt(t))<tolerance);
  async function picture(local,label) {
    const expected=local*rate;
    const s=await waitState(s=>s.ready>=2 && !s.seeking && Math.abs(s.source-expected)<.074,label+' 源时间');
    let rgb;
    try {
      await until(async()=>{rgb=await pixel();return matchesLight(rgb,expected);},label+' 可见像素');
    } catch (error) {
      const layers=await read(`(()=>{
        const pixel=n=>{if(!n)return null;const c=document.createElement('canvas');c.width=c.height=1;
          const ctx=c.getContext('2d');ctx.drawImage(n,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
        const v=document.querySelector('#preview'),h=document.querySelector('.preview-frame-hold');
        const box=n=>n?.getBoundingClientRect().toJSON(),r=box(document.querySelector('.preview-stage'));
        const stack=document.elementsFromPoint(r.x+r.width*.5,r.y+r.height*.42).slice(0,8).map(e=>[e.tagName,e.className,e.id]);
        return {video:pixel(v),hold:pixel(h),stage:r,videoBox:box(v),holdBox:box(h),scroll:[scrollX,scrollY],stack};
      })()`);
      const raw=await wc.debugger.sendCommand('Page.captureScreenshot');
      const file=path.join(dir,'监视器失败.png');
      await fs.writeFile(file,Buffer.from(raw.data,'base64'));
      throw Error(error.message+' RGB '+rgb+' 可见图层 '+JSON.stringify(layers)+' '+file);
    }
    return {local,source:+s.source.toFixed(3),rgb};
  }
  async function rulerPoint(local) {
    const p=await point(shot(1),local/second);
    const ruler=await point('.sequence-ruler .sequence-content',0);
    return {x:p.x,y:ruler.y};
  }
  async function seekRuler(local) {
    const p=await rulerPoint(local);
    await mouse('mousePressed',p);await mouse('mouseReleased',p);
  }
  try {
    await click('#home-open-project');
    await until(()=>read('!!'+q(shot(1))),'打开带有旧自动倍率的第二镜');
    assert.equal(await read(q('.sequence-caption')+'.innerText.includes("第二句")'),true);
    await click(shot(1));
    const selected=await waitState(s=>s.title==='轨道预览' && s.proxy==='流畅' && s.ready>=2,'选中第二镜的流畅代理');
    console.log('选中第二镜 '+JSON.stringify(selected));
    assert.ok(Math.abs(selected.duration-second)<.04,'轨道监视器总时长应为约 4.06 秒 '+JSON.stringify(selected));
    assert.ok(Math.abs(Number(selected.range)-second)<.01,'主监视器可在整个第二镜内定位');
    assert.match(await read(q('#preview-meta')+'.innerText'),/流畅预览.*4\.06 秒/);
    assert.equal(await read(q(shot(1)+' .sequence-clip-duration')+'.textContent'),'2.02 秒','素材角标显示原片时长');
    await click('#player-more');
    const slider='#player-position';
    await mouse('mousePressed',await point(slider,.25));
    await mouse('mouseMoved',await point(slider,3/second));
    await mouse('mouseReleased',await point(slider,3/second));
    const local=await waitState(s=>s.title==='轨道预览' && Math.abs(s.clock-3)<.15,'选中监视器拖至三秒');
    await picture(local.clock,'监视器进度条');
    await click('#player-more');
    await click(shot(1));
    await click('#player-play');
    const start=await waitState(s=>s.playing,'第二镜开始播放');
    assert.ok(Math.abs(start.clock-first)<.25,'主播放按钮从选中镜头的起点起播 '+JSON.stringify(start));
    const direct=await waitState(s=>s.playing && s.clock>=first+.25,'点选第二镜后由主按钮直接播放');
    assert.ok(Math.abs(direct.source-(direct.clock-first)*rate)<.13,'选中后播放应从第二镜开始 '+JSON.stringify(direct));
    await click('#player-play');
    const paused=[];
    await seekRuler(3);
    paused.push(await picture(3,'第二镜三秒处单击'));
    const tail=await rulerPoint(3.8);
    await mouse('mousePressed',await rulerPoint(3));
    await mouse('mouseMoved',tail);
    paused.push(await picture(3.8,'第二镜拖到 3.80 秒'));
    await mouse('mouseReleased',tail);
    await seekRuler(4.02);
    paused.push(await picture(4.02,'第二镜末尾'));
    console.log('旧草稿点击及拖动 '+JSON.stringify(paused));

    // Start the main play button in the outgoing clip, then let it cross the cut and
    // play to the end without seeking. Inspect the screen itself as well as decoder time.
    await seekRuler(-.35);
    await until(()=>read('!'+q('#player-play')+'.disabled && '+q('#player-play')+'.checkVisibility()'),'跨镜播放按钮就绪');
    await click('#player-play');
    const played=[];
    for (const local of [2.15,3,3.8]) {
      const s=await waitState(s=>s.playing && s.clock>=first+local,'连续播放到第二镜 '+local);
      const rgb=await pixel();
      assert.ok(Math.abs(s.source-(s.clock-first)*rate)<.13,'连续播放按工程时间取源 '+JSON.stringify(s));
      assert.ok(matchesLight(rgb,local*rate,19),'连续播放呈现的画面 '+JSON.stringify({local,s,rgb}));
      played.push({clock:s.clock,source:+s.source.toFixed(3),rgb});
    }
    const ended=await waitState(s=>!s.playing && Math.abs(s.clock-(first+second))<.05,'4.063 秒分镜完整播放');
    assert.ok(ended.source>=sourceEnd-.10 && ended.source<=2.05,'最后一帧应在原片末尾 '+JSON.stringify(ended));
    console.log('跨镜连续播放 '+JSON.stringify(played));
    await click(tile);
    const library=await waitState(s=>s.title==='素材预览' && !s.paused && s.source>.1,'素材库点播原片');
    assert.equal(library.rate,1);
    assert.ok(Math.abs(library.duration-2.02)<.04,'素材库显示原时长');
    openFile=blank;
    await click('#open-project');
    await until(()=>read(q(empty)+'?.checkVisibility() && !!'+q(tile)),'带口播和字幕的空白第二镜');
    await dragLibraryItem(wc,await point(tile),()=>point(empty),'application/x-sd-workbench-material',
      ()=>until(()=>read(q(empty)+'?.dataset.materialDrop==="active"'),'拖入第二镜'));
    await until(()=>read('!!'+q(shot(1))),'短素材已落到视频轨');
    await seekRuler(3);
    await picture(3,'新拖入的第二镜');
    await seekRuler(3.8);
    await picture(3.8,'新拖入的第二镜靠后位置');
    console.log('新拖入第二镜与素材库原速通过。');
  } finally { wc.debugger.detach();win.destroy(); }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

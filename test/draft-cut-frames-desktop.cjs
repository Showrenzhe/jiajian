'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();
const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-cut-frames-'));
app.setPath('userData', root);
app.setPath('sessionData', root);

async function check() {
  const catalog = new Map(await Promise.all(['red', 'blue', 'black','lime'].map(async id => {
    const file = path.join(root, id + '.mp4');
    // Two addressable frames on the blue source distinguish a current seek from
    // a late completion for the same URL, even when both show the right asset.
    const changes={
      red:"drawbox=color=0xb00000:t=fill:enable='gte(t,0.84)'",
      blue:"drawbox=color=0x0000b0:t=fill:enable='gte(t,0.52)'",
    };
    const toneChange=changes[id] ? ['-vf',changes[id]] : [];
    await ffmpeg(['-f', 'lavfi', '-i', 'color=' + id + ':s=320x180:r=30:d=1',
      '-f','lavfi','-i','sine=frequency=440:duration=1',...toneChange,
      '-c:v', 'libx264','-c:a','aac', '-threads', '1', file]);
    return [id, await inspectAsset(file, 'video')];
  })));
  const project = path.join(root, '切点逐帧.sdworkbench');
  const config={
    shots: [[{id:'red',start:0,end:1}],[{id:'blue',start:0,end:1}],[{id:'black',start:0,end:1,videoStart:2.5}]],
    ratio:'16:9', resolution:720, fps:30, fit:'fit', keepAudio:false, unordered:false,
    useOriginal:true, useMirrors:false, count:1, priority:'picture', musicIds:[], musicVolume:50,
  };
  await saveProject(project,config,catalog);
  const plain=path.join(root,'连续分镜.sdworkbench');
  await saveProject(plain,{...config,shots:config.shots.slice(0,2)},catalog);
  const layered=path.join(root,'上下两条视频轨.sdworkbench');
  await saveProject(layered,{...config,keepAudio:true,shotSettings:[{duration:1},{duration:1}],shots:[
    [{id:'red',start:0,end:1}],
    [{id:'red',start:0,end:1,videoLane:0},
      {id:'blue',start:0,end:1,videoLane:1,videoStart:1.15,videoDuration:.5,videoFit:'hold'},
      {id:'lime',start:0,end:1,videoLane:2,videoStart:1.35,videoDuration:.47,videoFit:'hold'},
      {id:'blue',start:0,end:1,videoLane:3,enabled:false}],
  ]},catalog);
  const fastSource = path.join(root,'三色长素材.mp4');
  await ffmpeg(['-f','lavfi','-i',"color=lime:s=320x180:r=30:d=12,drawbox=color=red:t=fill:enable='lt(t,3)',drawbox=color=blue:t=fill:enable='gte(t,10)'",
    '-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-c:a','aac','-threads','1',fastSource]);
  const speech=path.join(root,'半秒口播.wav');
  await ffmpeg(['-f','lavfi','-i','sine=frequency=660:duration=0.5',speech]);
  // These saved pre-v3 placements already have their 24× / 5.67× rates.
  // Test decoder behavior without prompting for a new automatic alignment.
  const fastProject=path.join(root,'自动倍速分镜.sdworkbench');
  await saveProject(fastProject,{...config,priority:'voice',narrationMode:'segmented',segmentNarrationIds:[['voice']],
    shotSettings:[{duration:.5}],shots:[[
    {id:'fast',start:0,end:12,speed:24,speedMode:'legacy',autoFitSpeed:true,videoStart:0,videoDuration:.5,videoFit:'hold'}
  ]]},new Map([['fast',await inspectAsset(fastSource,'video')],['voice',await inspectAsset(speech,'audio')]]));
  const twoSeconds=path.join(root,'两秒口播.wav');
  await ffmpeg(['-f','lavfi','-i','sine=frequency=550:duration=2',twoSeconds]);
  const continuousProject=path.join(root,'倍速画面与连续音轨.sdworkbench');
  await saveProject(continuousProject,{...config,keepAudio:true,priority:'voice',narrationMode:'segmented',segmentNarrationIds:[['speech']],
    musicIds:['speech'],shotSettings:[{duration:2}],shots:[[
      {id:'video',start:0,end:11.34,speed:5.67,speedMode:'legacy',autoFitSpeed:true,videoStart:0,videoDuration:2,videoFit:'hold'}
    ]]},new Map([['video',await inspectAsset(fastSource,'video')],['speech',await inspectAsset(twoSeconds,'audio')]]));
  const projects=[project,plain,layered,fastProject,continuousProject];
  const win = await launchDesktop({show:false, dataDirectory:path.join(root,'profile'), dialogs:{
    async showOpenDialog() { return {canceled:false,filePaths:[projects.shift()]}; },
  }});
  const wc = win.webContents;
  win.setContentSize(1360,900);
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = code => wc.executeJavaScript(code,true);
  const mouse = (type,xy) => wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type,...xy,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,
  });
  let probe, recording = false;
  const samples = [], results = {}, failures = [];
  function colour(r,g,b) {
    if (r>140 && g<85 && b<85) return 'red';
    if (b>140 && r<85 && g<85) return 'blue';
    if (g>140 && r<85 && b<85) return 'green';
    if (Math.max(r,g,b)<10) return 'black';
    if (Math.min(r,g,b)>205) return 'white';
    return 'background';
  }
  async function waitFor(predicate,label) {
    const until = performance.now()+6000;
    while (performance.now()<until) {
      if (await predicate()) return;
      await delay(12);
    }
    throw Error('Timed out waiting for '+label+'; recent pixels '+JSON.stringify(samples.slice(-6)));
  }
  try {
    await read("document.getElementById('home-open-project').click()");
    await waitFor(()=>read("!!document.querySelector('.sequence-video [data-drop-shot=\"2\"]')"),'project');
    await read("document.querySelector('.sequence-video [data-drop-shot=\"0\"]').click()");
    const coords = await read(`(() => {
      const marker=document.createElement('b');
      Object.assign(marker.style,{position:'fixed',top:'1px',left:'1px',width:'4px',height:'4px',zIndex:'2147483647',pointerEvents:'none'});
      document.body.append(marker);
      const draftMarker=marker.cloneNode();
      draftMarker.style.left='7px';
      document.body.append(draftMarker);
      const scale=parseFloat(document.querySelector('.sequence-video [data-drop-shot="1"]').style.left);
      let counter=0;
      function markerFrame() {
        const cursor=document.querySelector('.sequence-cursor');
        const rulerContent=document.querySelector('.sequence-ruler .sequence-content');
        const unit=parseFloat(document.querySelector('.sequence-video [data-drop-shot="1"]')?.style.left);
        const seconds=cursor && unit ? (cursor.getBoundingClientRect().left+cursor.offsetWidth/2-rulerContent.getBoundingClientRect().left)/unit : 0;
        const player=document.querySelector('#preview');
        const flags=(document.querySelector('.preview-frame-hold') ? 1 : 0)
          + (player.seeking ? 2 : 0) + player.readyState*4;
        marker.style.backgroundColor='rgb('+((++counter)%128+64)+','+Math.min(255,Math.max(0,Math.round(seconds*60)))+','+flags+')';
        const draft=document.querySelector('.draft-transport-preview:not([hidden]) video.draft-main:not([hidden])');
        if (draft) {
          const state=draft.readyState*4+(draft.seeking?2:0)+(draft.ended?1:0);
          draftMarker.style.backgroundColor='rgb(100,'+Math.round(draft.currentTime*120)+','+state+')';
        } else draftMarker.style.backgroundColor='rgb(0,0,0)';
        requestAnimationFrame(markerFrame);
      }
      markerFrame();
      const box=document.querySelector('.preview-stage').getBoundingClientRect();
      const ruler=document.querySelector('.sequence-ruler .sequence-content').getBoundingClientRect();
      return {x:box.x+box.width*.53,y:box.y+box.height*.54,left:ruler.x,top:ruler.y+ruler.height*.5,scale};
    })()`);
    // The full frame, including the real composited video and any covering canvas,
    // reaches this callback. The tiny animated marker also requests paused frames.
    wc.beginFrameSubscription(false,image=>{
      const size=image.getSize();
      if (!probe) probe={x:Math.round(coords.x*size.width/1360),y:Math.round(coords.y*size.height/900),width:1,height:1};
      const [b,g,r]=image.crop(probe).toBitmap();
      const marker=image.crop({x:Math.round(2*size.width/1360),y:Math.round(2*size.height/900),width:1,height:1}).toBitmap();
      const draft=image.crop({x:Math.round(8*size.width/1360),y:Math.round(2*size.height/900),width:1,height:1}).toBitmap();
      samples.push({t:Math.round(performance.now()),head:marker[1]/60,cover:Boolean(marker[0]&1),seeking:Boolean(marker[0]&2),
        ready:marker[0]>>2,draft:draft[2]>0 && {time:draft[1]/120,ready:draft[0]>>2,seeking:Boolean(draft[0]&2),ended:Boolean(draft[0]&1)},
        c:colour(r,g,b),rgb:[r,g,b]});
    });
    recording=true;
    const point=t=>({x:coords.left+coords.scale*t,y:coords.top});
    async function seek(t) {
      await mouse('mousePressed',point(t));
      await mouse('mouseReleased',point(t));
    }
    const stable=(color,n=3)=>samples.length>=n && samples.slice(-n).every(s=>s.c===color);
    function record(name,frames,permitted) {
      const sequence=[];
      for (const frame of frames) {
        if (sequence.at(-1)?.color===frame.c) sequence.at(-1).count++;
        else sequence.push({color:frame.c,count:1,rgb:frame.rgb});
      }
      const stray=frames.filter(frame=>!permitted.includes(frame.c));
      assert.ok(frames.length>=2,name+' needs at least two compositor samples');
      results[name]={frames:frames.length,stray:stray.length,sequence,...(stray.length && {unexpected:stray})};
      if (stray.length) failures.push(name+' '+stray.length+' unexpected frames');
    }
    await seek(.25);
    await waitFor(()=>stable('red'),'initial red frame');
    const playbackStart=samples.length;
    await read("document.querySelector('#player-play').click()");
    await waitFor(()=>read("document.querySelector('#player-play').getAttribute('aria-label')==='暂停'"),'playing');
    await waitFor(()=>stable('red'),'playing red');
    await waitFor(()=>samples.at(-1)?.head>=2.88,'playback through the actual gap and black source');
    const playback=samples.slice(playbackStart);
    const interval=(start,end)=>playback.filter(s=>s.head>=start && s.head<end);
    record('playbackStart',interval(.23,.65),['red']);
    const cut=interval(.65,1.50);
    record('playbackCut',cut,['red','blue']);
    record('playbackBlue',interval(1.20,1.85),['blue']);
    record('playbackGap',interval(2.12,2.4),['background','black']);
    record('playbackBlack',interval(2.65,2.88),['black']);
    assert.ok(cut.some(s=>s.c==='red') && cut.some(s=>s.c==='blue'),'sample both sides of the cut');
    assert.ok(cut.some(s=>s.c==='red' && s.rgb[0]<201),'the outgoing clip reaches its darker red tail before the cut');
    results.firstBlueHead=cut.find(s=>s.c==='blue').head;
    if (Math.abs(results.firstBlueHead-1)>.15) failures.push('blue not presented within 150 ms of the cut');
    const gapBoundary=interval(1.80,2.4);
    results.firstGapHead=gapBoundary.find(s=>s.c==='black' || s.c==='background')?.head;
    if (!(results.firstGapHead>=1.92 && results.firstGapHead<=2.12)) failures.push('real gap begins at the wrong time');
    await read("document.querySelector('#player-play').click()");
    await seek(.28);
    await waitFor(()=>stable('red'),'red before drag');
    await mouse('mousePressed',point(.28));
    let from;
    for (const [name,t,color] of [['scrubForward',1.35,'blue'],['scrubReverse',.35,'red']]) {
      from=samples.length;
      await mouse('mouseMoved',point(t));
      await waitFor(()=>stable(color),name);
      record(name,samples.slice(from),['red','blue']);
    }
    from=samples.length;
    for (const t of [1.22,.37,1.29,.45,1.72]) {
      await mouse('mouseMoved',point(t));
      await delay(19);
    }
    await mouse('mouseReleased',point(1.72));
    const isLastBlue=frame=>frame?.c==='blue' && frame.rgb[2]>150 && frame.rgb[2]<201;
    await waitFor(()=>Math.abs(samples.at(-1)?.head-1.72)<.03 && isLastBlue(samples.at(-1)),'later, darker blue frame at latest scrub target');
    const settled=samples.length-1;
    await waitFor(()=>samples.length-settled>=4 && samples.at(-1).t-samples[settled].t>=190,'compositor samples after the final seek');
    record('rapidScrub',samples.slice(from),['red','blue']);
    assert.ok(samples.slice(settled).every(isLastBlue),'latest target remains visible after asynchronous completions: '+JSON.stringify(samples.slice(settled)));
    await read("document.getElementById('timeline-clock').focus()");
    async function shuttleKey(letter) {
      for (const type of ['rawKeyDown','keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',{
        type,key:letter,code:'Key'+letter.toUpperCase(),windowsVirtualKeyCode:letter.toUpperCase().charCodeAt(0),
      });
    }
    from=samples.length;
    await shuttleKey('j');await shuttleKey('j');
    await waitFor(()=>stable('red') && samples.at(-1).head<.82,'2× reverse crosses from blue into red');
    await shuttleKey('k');
    const paused=()=>read("document.querySelector('#timeline-play').ariaPressed==='false'");
    await waitFor(paused,'reverse paused');
    assert.ok(samples.slice(from).some(frame=>frame.c==='blue'),'blue was visible during reverse playback');
    await shuttleKey('l');await shuttleKey('l');
    await waitFor(()=>stable('blue') && samples.at(-1).head>1.20,'2× forward returns to blue');
    await shuttleKey('k');await waitFor(paused,'forward paused');
    const alignment=await read(`(() => {
      const picture=document.querySelector('.draft-transport-preview:not([hidden]) video.draft-main');
      return {rate:picture.playbackRate,paused:picture.paused,drift:Math.abs(picture.currentTime+1-timeline.playheadTime)};
    })()`);
    assert.ok(alignment.rate===1 && alignment.paused && alignment.drift<.03,'pause lands on the visible frame '+JSON.stringify(alignment));
    results.shuttleAcrossCut=alignment;
    from=samples.length;
    await seek(2.24);
    const gapSamples=()=>samples.slice(from).filter(frame=>Math.abs(frame.head-2.24)<.03);
    await waitFor(()=>gapSamples().length>=3,'three compositor frames at the scrubbed gap');
    record('scrubGap',gapSamples().slice(0,3),['background','black','white']);
    await seek(2.74);
    await waitFor(()=>stable('black'),'real black source');
    record('scrubBlack',samples.slice(-3),['black']);
    await read("document.querySelector('#open-project').click()");
    await waitFor(()=>read("document.querySelector('#notice').textContent.includes('连续分镜')"),'plain project');
    await read("document.querySelector('.sequence-video [data-drop-shot=\"0\"]').click()");
    await waitFor(()=>stable('red'),'plain initial red');
    from=samples.length;
    await read("document.querySelector('#player-play').click()");
    await waitFor(()=>samples.length>from && samples.at(-1).head>1.4,'plain sequential cut');
    const plainCut=samples.slice(from).filter(s=>s.head>=.65 && s.head<1.4);
    record('plainCut',plainCut,['red','blue']);
    assert.ok(plainCut.some(s=>s.c==='red') && plainCut.some(s=>s.c==='blue'),'both plain sequential clips render');
    assert.ok(plainCut.some(s=>s.c==='red' && s.rgb[0]<201),'plain playback preserves the outgoing tail');
    const rowButton=(row,action)=>read(`document.querySelector('[data-control-key="vis${row}"] [data-track-action="${action}"]').click()`);
    await rowButton(0,'disabled');
    await waitFor(()=>['background','white','black'].some(color=>stable(color)),'switch off the last track while playing');
    const monitor='.draft-transport-preview:not([hidden])';
    assert.equal(await read(`!!document.querySelector('${monitor}') && !document.querySelector('${monitor} video,${monitor} audio')`),true,
      'empty timeline retains the blank composition without playing the selected source');
    assert.equal(await read("document.querySelector('#player-play').disabled"),true,'empty monitor cannot start source playback');
    await seek(1.5);
    await rowButton(0,'disabled');
    await waitFor(()=>stable('blue'),'restore the last track at the scrubbed position');
    assert.equal(await read("document.querySelector('#player-play').disabled"),false,'restored monitor can play again');
    await read("document.querySelector('#open-project').click()");
    await waitFor(()=>read(`!!document.querySelector('[data-control-key="vis3"] [data-drop-shot="1"][data-move-candidate]')`),'layered project timeline');
    const nowRuler=await read(`(() => {
      const r=document.querySelector('.sequence-ruler .sequence-content').getBoundingClientRect();
      return {left:r.x,top:r.y+r.height*.5,scale:parseFloat(document.querySelector('[data-control-key="vis0"] [data-drop-shot="1"]').style.left)};
    })()`);
    Object.assign(coords,nowRuler);
    await seek(1.30);
    await waitFor(()=>stable('red') && Math.abs(samples.at(-1).head-1.30)<.03,'main track at overlap');
    await rowButton(0,'hidden');
    await waitFor(()=>stable('blue'),'immediate paused reveal of lower track');
    assert.equal(await read(`!!document.querySelector('${monitor} audio.draft-main:not([muted])') &&
      !document.querySelector('${monitor} audio.draft-main').muted && document.querySelector('${monitor} video.draft-main').muted`),
      true,'eye keeps the chosen original sound and reveals the lower picture without double audio');
    await rowButton(0,'muted');
    assert.equal(await read(`document.querySelector('${monitor} audio.draft-main').muted`),true,'muting the hidden main track is independent');
    await rowButton(0,'muted');
    await seek(1.42);
    await waitFor(()=>stable('blue'),'higher visible track wins overlap');
    await seek(1.72);
    await waitFor(()=>stable('green'),'third track revealed in second track gap');
    await seek(1.87);
    await waitFor(()=>['background','white','black'].some(color=>stable(color)),'lower track empty past its end');
    await seek(1.30);
    await waitFor(()=>stable('blue'),'scrub back onto lower track');
    await rowButton(0,'hidden');
    await waitFor(()=>stable('red'),'main track restored at the same time');
    await rowButton(1,'solo');
    await waitFor(()=>stable('blue'),'solo lower video track');
    await rowButton(1,'disabled');
    await waitFor(()=>stable('red'),'disabled solo releases main video');
    await rowButton(1,'disabled');
    await waitFor(()=>stable('blue'),'enabling the soloed take restores it');
    await rowButton(1,'solo');
    await waitFor(()=>stable('red'),'release lower solo');
    await rowButton(0,'disabled');
    await waitFor(()=>stable('blue'),'disable upper take and use the lower picture and its sound');
    assert.equal(await read(`!document.querySelector('${monitor} video.draft-main').muted &&
      !document.querySelector('${monitor} audio.draft-main')`),true,'disabled take contributes neither video nor original audio');
    await rowButton(0,'disabled');
    await waitFor(()=>stable('red'),'restore the main take');
    await seek(1.22);
    await read("document.querySelector('#timeline-play').click()");
    await waitFor(()=>read("document.querySelector('#timeline-play').ariaPressed==='true'"),'layered playback');
    await rowButton(0,'hidden');
    await waitFor(()=>stable('blue'),'hide main track while playing');
    assert.equal(await read("document.querySelector('#timeline-play').ariaPressed"),'true','eye toggle preserves playback');
    await waitFor(()=>['background','white','black'].some(color=>stable(color)),'play across lower clip end');
    results.hiddenVideoTrack='paused / scrub / play / gap / restore / solo';
    results.disabledVideoTrack='playing to empty / scrub / restore / disabled solo / alternate original audio';
    await read("document.querySelector('#open-project').click()");
    // The open notification can arrive a frame before the new timeline replaces the previous project.
    await waitFor(()=>read(`!!document.querySelector('.sequence-video [data-drop-shot="0"][title^="三色长素材.mp4"]')`),'fitted project timeline');
    const fittedRuler=await read(`(() => {
      const ruler=document.querySelector('.sequence-ruler .sequence-content');
      const bounds=ruler.getBoundingClientRect();
      const [first,second]=ruler.querySelectorAll('.sequence-tick');
      const scale=(parseFloat(second.style.left)-parseFloat(first.style.left))/Number(ruler.dataset.step);
      return {left:bounds.x,top:bounds.y+bounds.height*.5,scale};
    })()`);
    Object.assign(coords,fittedRuler);
    await seek(.25);
    await waitFor(()=>stable('green'),'scrub into middle of 24× source');
    await seek(.02);
    await waitFor(()=>stable('red'),'24× source head');
    from=samples.length;
    const startedAt=performance.now();
    await read("document.querySelector('#timeline-play').click()");
    await waitFor(()=>read("document.querySelector('#timeline-play').ariaPressed==='true'"),'24× playing');
    await waitFor(()=>read(`[...document.querySelectorAll('.draft-transport-preview audio')].some(
      audio=>!audio.paused && !audio.muted && audio.playbackRate===1 && audio.currentTime>.1)`),'independent narration at its own rate');
    await waitFor(()=>read("document.querySelector('#timeline-play').ariaPressed==='false'"),'24× slot end');
    const elapsed=performance.now()-startedAt;
    await waitFor(()=>stable('blue'),'24× source tail');
    assert.ok(samples.slice(from).some(s=>s.c==='green'),'middle of long source is presented during playback');
    assert.ok(elapsed>=340 && elapsed<1500,'half-second slot completes near its timeline duration: '+elapsed);
    results.autoFit24x={elapsedMs:Math.round(elapsed),finalColor:'blue'};
    await read("document.querySelector('#open-project').click()");
    await waitFor(()=>read("document.querySelector('#notice').textContent.includes('倍速画面与连续音轨')"),'5.67× project');
    from=samples.length;
    await read("document.querySelector('#timeline-play').click()");
    await waitFor(()=>read(`(() => {
      const overlay=document.querySelector('.draft-transport-preview:not([hidden])');
      const picture=overlay?.querySelector('video');
      return picture?.playbackRate===1 && !picture.muted && picture.currentSrc.includes('/track-proxy/') &&
        picture.videoWidth===320 && Math.abs(picture.duration-12/5.67)<.08 &&
        [...overlay.querySelectorAll('audio')].filter(audio=>!audio.paused && audio.currentTime>.15).length===2;
    })()`),'fitted playback with independent narration and music');
    const continuity=await read(`(async () => {
      const overlay=document.querySelector('.draft-transport-preview:not([hidden])');
      const video=overlay.querySelector('video');
      const sounds=[...overlay.querySelectorAll('audio')], starts=sounds.map(node=>node.currentTime);
      const pauses=[0,0];
      sounds.forEach((node,i)=>node.addEventListener('pause',()=>pauses[i]++));
      const native=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
      let seeks=0;
      // 60 ms of timeline jitter is 340 ms in the original 5.67× source.
      Object.defineProperty(video,'currentTime',{configurable:true,
        get(){return native.get.call(this)-.06*this.playbackRate;},
        set(value){seeks++;native.set.call(this,value);}
      });
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      try {
        await wait(240);
        // One decoder waiting for pictures must not stop the ready sound lanes.
        Object.defineProperty(video,'readyState',{configurable:true,get:()=>1});
        await wait(180);
      } finally {
        delete video.readyState;delete video.currentTime;
      }
      return {pauses,seeks,soundSeconds:sounds.map((node,i)=>node.currentTime-starts[i])};
    })()`);
    assert.deepEqual(continuity.pauses,[0,0],'narration and music keep running while video buffers');
    assert.equal(continuity.seeks,0,'normal frame jitter must not seek a 5.67× clip');
    assert.ok(continuity.soundSeconds.every(seconds=>seconds>.33),'both audio clocks advance through the video wait');
    results.autoFitContinuity=continuity;
    const recovery=await read(`(async () => {
      const overlay=document.querySelector('.draft-transport-preview:not([hidden])');
      const video=overlay.querySelector('video'), sound=overlay.querySelector('audio');
      const native=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
      // A genuine half-second loss needs one seek back to the composition.
      video.currentTime=Math.max(0,video.currentTime-.5*video.playbackRate);
      let corrections=0;
      Object.defineProperty(video,'currentTime',{configurable:true,get(){return native.get.call(this);},
        set(value){corrections++;native.set.call(this,value);}
      });
      const until=performance.now()+650;
      const drift=()=>Math.abs(video.currentTime/video.playbackRate-sound.currentTime);
      try {
        while((!corrections || video.seeking || drift()>.14) && performance.now()<until) {
          await new Promise(requestAnimationFrame);
        }
        return {corrections,drift:drift(),soundPlaying:!sound.paused};
      } finally { delete video.currentTime; }
    })()`);
    assert.equal(recovery.corrections,1,'large drift resynchronizes only the lagging video');
    assert.ok(recovery.drift<=.14 && recovery.soundPlaying,'video catches up with the uninterrupted audio');
    results.autoFitRecovery=recovery;
    await waitFor(()=>read("document.querySelector('#timeline-play').ariaPressed==='false'"),'5.67× slot end');
    await waitFor(()=>stable('blue'),'5.67× source tail');
    for(const expected of ['red','green','blue']) {
      assert.ok(samples.slice(from).some(frame=>frame.c===expected),'presents 5.67× source colour '+expected);
    }
    console.log(JSON.stringify(results));
    assert.deepEqual(failures,[]);
  } finally {
    if (recording) wc.endFrameSubscription();
    wc.debugger.detach();
    win.destroy();
  }
}
check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});

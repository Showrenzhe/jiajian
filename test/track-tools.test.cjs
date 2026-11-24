'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { organizeTracks } = require('../src/ui/track-organizer.js');

test('the five organizer operations keep occupied rows and move only out-of-bounds graphics', () => {
  const original = {
    shots: [[{id:'clip'}], [{id:'clip2'}]], ratio:'16:9', resolution:720, narrationMode:'segmented',
    shotSettings:[{ name:'产品' }, null], segmentNarrationIds:[[null,'a',null],[null,null,'b']],
    segmentVoiceCuts:[[null,{ranges:[{start:1,end:2}],offset:.4},null],[null,null,null]],
    extraWholeTracks:[{ narrationId:null, subtitles:null },{ narrationId:'a', subtitles:null }],
    packaging:{ global:[{kind:'text',text:'默认文本'}, {kind:'sticker',id:'st',x:0,y:.5,scale:.2},
      {kind:'text',text:'实际文案',x:.5,y:.5,scale:.5}], composites:[], textGroups:[], segmentNarration:[], wholeNarration:[[],[],[]] },
  };
  const source = JSON.stringify(original);
  const all = {empty:true,placeholder:true,duration:true,bounds:true,start:true};
  const assets = (id) => id === 'st' ? {width:640,height:360} : {duration:2};
  const fixed = organizeTracks(original, all, assets, () => 100);
  assert.deepEqual(fixed.counts, { empty:2, placeholder:1, duration:2, bounds:1, start:1 });
  assert.deepEqual(fixed.config.segmentNarrationIds, [['a',null],[null,'b']]);
  assert.deepEqual(fixed.config.shotSettings,[{name:'产品',duration:1},{duration:2}]);
  assert.deepEqual(fixed.config.segmentVoiceCuts[0][0],{ranges:[{start:1,end:2}],offset:0});
  assert.equal(fixed.config.packaging.global[0].x,.1);
  assert.equal(fixed.config.packaging.global[1].text,'实际文案');
  assert.equal(JSON.stringify(original), source);
  assert.deepEqual(organizeTracks(fixed.config, all, assets, () => 100).counts,
    { empty:0, placeholder:0, duration:0, bounds:0, start:0 });
  const keepOffset = organizeTracks(original, {duration:true}, assets, () => 100);
  assert.equal(keepOffset.config.shotSettings[0].duration,1.4);
});
const { splitRanges } = require('../src/ui/track-tools.js');

test('legacy video gaps and filled neighbours retain their stored windows and shot clock',()=>{
  const {reservedVideoCells,videoLaneCells}=require('../src/ui/track-tools.js');
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const clip=(name,start,lane=0)=>({asset:{url:name,kind:'video'},start:0,end:1,videoStart:start,videoLane:lane});
  const a=clip('a',0), b=clip('b',2), c=clip('c',3), late=clip('late',5), other=clip('other',1.5,1);
  const shots=[[a],[b,other],[c],[late]];
  const starts=[0,1,2,3], widths=[1,1,1,1];
  b.videoGaps=[{start:1,span:1}];
  b.videoWindow=1;c.videoWindow=1;
  const [pending]=reservedVideoCells(videoLaneCells(shots,starts,widths)[0]);
  assert.deepEqual(pending.gap,{start:1,span:1});
  const resized=videoLaneCells(shots,starts,[1,5,.5,1])[0];
  assert.deepEqual(resized.map(cell=>[cell.start,cell.span]),[[0,1],[2,1],[3,1],[5,1]],'分镜长短变化保留本次实际让位的片段边界');
  const lone={...clip('right',0),videoWindow:2,videoGaps:[{start:2,span:2}]};
  assert.deepEqual(reservedVideoCells(videoLaneCells([[lone]],[0],[2])[0])[0].gap,{start:2,span:2});
  assert.equal(videoLaneCells([[lone]],[0],[5])[0][0].span,2,'延长分镜后，末端空位仍可填入');
  delete b.videoGaps;
  const fill={...clip('fill',1),videoFit:'hold',videoDuration:1,videoGroup:'seq'};
  b.videoGroup='seq';
  shots[1].push(fill);
  const state={shots,settings:shots.map(()=>({duration:1})),whole:[],segments:[],music:[],muted:new Set(),
    pack:{global:[],composites:[],wholeNarration:[]},priority:'picture',timelineCaptions:[{text:'固定字幕',start:1100,end:1400}]};
  const layout=timing(state,()=>1,()=>null,fill);
  assert.deepEqual(layout.starts,starts);
  assert.deepEqual(layout.widths,widths);
  const plan=makePlan(state,layout,()=>null,waveformSource,fill);
  assert.deepEqual(plan.map(entry=>[entry.asset?.url ?? entry.text,entry.start,entry.end]),[
    ['a',0,1],['fill',1,2],['固定字幕',1.1,1.4],['b',2,3],['c',3,4],['late',5,6]]);
});

test('legacy fixed shot widths retain their fractional clock next to a manually sped-up clip',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const clip={asset:{kind:'video',url:'test://video'},start:0,end:4,speed:1};
  const state={shots:[[clip],[{...clip}],[{...clip,speed:2}]],settings:[{duration:1.2},{duration:.65},{duration:1}],
    fps:24,whole:[],segments:[],music:[],muted:new Set(),priority:'picture',pack:{global:[],composites:[],wholeNarration:[]}};
  const clock=timing(state,c=>(c.end-c.start)/c.speed,()=>null);
  assert.deepEqual(clock.widths,[1.2,.65,1]);
  const plan=makePlan(state,clock,()=>null,waveformSource);
  const last=plan.filter(e=>e.asset).at(-1);
  assert.equal(last.rate,2);
  assert.equal(last.end-last.start,1);
});

test('timeline picture tail trims keep draft playback speed and trailing silence',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const clip={asset:{kind:'video',url:'test://video'},start:0,end:2,speed:2,videoDuration:.75,
    layers:[{kind:'text',text:'局部',start:.5,end:2}]};
  const state={shots:[[clip]],settings:[{duration:1}],whole:[],segments:[[]],segmented:true,priority:'picture',
    keepAudio:true,muted:new Set(),music:[],pack:{global:[],composites:[],segmentNarration:[],wholeNarration:[]}};
  const read=()=>makePlan(state,timing(state,()=>1,()=>null),()=>null,waveformSource);
  assert.deepEqual(read().map(e=>[e.start,e.end,e.rate??e.text??'留空']),[[0,.75,2],[.25,.75,'局部'],[.75,1,'留空']]);
  clip.videoStart=1;
  assert.deepEqual(read().map(e=>[e.start,e.end]),[[1,1.75],[1.25,1.75]]);
});

test('a positioned short candidate plays its retained sources at its own speed inside a longer shot',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const long={asset:{kind:'video',url:'test://long'},start:0,end:8};
  const short={asset:{kind:'video',url:'test://short'},start:0,end:6,speed:2,
    ranges:[{start:0,end:2},{start:4,end:6}],videoStart:1,videoDuration:2,
    videoSubtitles:{cues:[{text:'第二段',start:4500,end:5500}]}};
  const state={shots:[[long,short]],settings:[{duration:8}],whole:[],segments:[[]],segmented:true,priority:'picture',
    keepAudio:true,muted:new Set(),music:[],pack:{global:[],composites:[],segmentNarration:[],wholeNarration:[]}};
  for(const priority of ['picture','voice']) {
    state.priority=priority;
    const layout=timing(state,c=>c.end-c.start,()=>null,short);
    const plan=makePlan(state,layout,()=>null,waveformSource,short);
    assert.equal(layout.total,8);
    assert.deepEqual(plan.filter(e=>e.asset).map(e=>[e.asset.url,e.source,e.start,e.end,e.rate]),[
      ['test://short',0,1,2,2],['test://short',4,2,3,2]]);
    assert.deepEqual(plan.filter(e=>e.text).map(e=>[e.text,e.start,e.end]),[['第二段',2.25,2.75]]);
    const extended={...short,videoDuration:3.25,videoFit:'hold'};
    const extendedState={...state,shots:[[long,extended]]};
    const held=makePlan(extendedState,layout,()=>null,waveformSource,extended).filter(entry=>entry.asset).at(-1);
    assert.deepEqual([held.asset.url,held.start,held.end,held.volume],['test://short',3,4.25,0]);
    assert.ok(held.rate===0 && held.source>5.9 && held.source<6,'停在最后保留区间的尾帧，原声不延长');
    const legacy={...short,videoDuration:3.25};
    const legacyPlan=makePlan({...state,shots:[[long,legacy]]},layout,()=>null,waveformSource,legacy);
    assert.equal(legacyPlan.filter(entry=>entry.asset).at(-1).end,3,'读取未标注保持尾帧的旧工程时沿用原来的片尾');
  }
});

test('a fixed picture shot previews the edited rate through its crop and repeats',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const clip={asset:{kind:'video',url:'clip'},start:0,end:4,speed:2};
  const state={shots:[[clip]],settings:[{duration:1}],whole:[],segments:[],segmented:false,priority:'picture',
    keepAudio:true,muted:new Set(),music:[],pack:{global:[],composites:[],wholeNarration:[]}};
  const picture=()=>makePlan(state,timing(state,()=>2,()=>null),()=>null,waveformSource).filter(e=>e.asset);
  assert.deepEqual(picture().map(e=>[e.source,e.end,e.rate]),[[0,1,2]]);
  state.settings[0].duration=4;
  assert.deepEqual(picture().map(e=>[e.source,e.end,e.rate,e.cycle]),[[0,4,2,4]]);
  clip.speed=1;
  state.settings[0].duration=1;
  assert.deepEqual(picture().map(e=>[e.source,e.end,e.rate]),[[0,1,1]]);
});

test('only current rows participate in visual and audio solo, and locking does not mute', () => {
  const {normalize,forLayout,allows}=require('../src/ui/track-controls.js');
  const state=normalize({vis1:{hidden:true},whole1:{solo:true},music2:{solo:true},voice1:{locked:true}});
  const current=forLayout(state,[[{},{}]],[[{},{}]],2,1,true);
  assert.equal(allows(current,'vis1','visual'),false);
  assert.equal(allows(current,'vis1','audio'),true);
  assert.equal(allows(current,'voice1','audio'),true);
  assert.equal(current.voice1.locked,true);
  const whole=forLayout(state,[[{},{}]],[[{},{}]],2,1,false);
  assert.equal(allows(whole,'whole1','audio'),true);
  assert.equal(allows(whole,'music0','audio'),false);
  assert.equal(allows(whole,'vis0','visual'),true);
  assert.equal(state.whole1.solo,true);
});

test('monitoring a lower video row retains its edited rate without moving shot or audio timing',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const upper={asset:{kind:'video',url:'upper'},start:0,end:1};
  const lower={asset:{kind:'video',url:'lower'},start:1,end:5,speed:2};
  const state={shots:[[upper,lower]],settings:[],whole:[],segments:[],segmented:false,priority:'picture',
    trackControls:{vis0:{hidden:true}},keepAudio:true,muted:new Set(),music:[],
    pack:{global:[],composites:[],wholeNarration:[]}};
  function picture() {
    const layout=timing(state,clip=>(clip.end-clip.start)/(clip.speed || 1),()=>null);
    const entries=makePlan(state,layout,()=>null,waveformSource);
    assert.ok(entries.some(e=>e.asset===upper.asset && !e.visual && e.volume===100));
    return entries.filter(e=>e.visual).map(e=>[e.asset.url,e.source,e.end,e.rate,e.cycle,e.volume]);
  }
  assert.deepEqual(picture(),[['lower',1,1,2,undefined,0]]);
  state.settings=[{duration:4}];
  assert.deepEqual(picture(),[['lower',1,4,2,4,0]]);
  lower.ranges=[{start:1,end:2},{start:4,end:5}];
  state.settings=[{duration:1}];
  assert.deepEqual(picture(),[['lower',1,.5,2,undefined,0],['lower',4,1,2,undefined,0]]);
});

test('draft text uses actual clip positions, subtitle tracks, export switch and independent packaging visibility', () => {
  const {makePlan,timing}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const clip={asset:{kind:'video',id:'v',url:'test://v',duration:5},start:1,end:3,videoStart:1.5,
    videoSubtitles:{cues:[{text:'画面字幕',start:1250,end:1500}]}};
  const title={kind:'text',text:'片名',laneId:'title',start:.25,end:.75};
  const state={shots:[[clip]],settings:[],whole:[],segments:[[]],segmented:true,priority:'picture',music:[],
    keepAudio:true,muted:new Set(),pack:{global:[title],composites:[],wholeNarration:[],segmentNarration:[]},
    timelineCaptions:[{text:'粘贴',start:500,end:900}],captions:[{row:0,shot:0,start:.25,duration:.4,name:'口播'}]};
  const read=()=>makePlan(state,timing(state,()=>2,()=>null),()=>null,waveformSource).filter(entry=>entry.text).map(e=>[e.text,e.start,e.end]);
  assert.deepEqual(read(),[['片名',.25,.75],['口播',.25,.65],['粘贴',.5,.9],['画面字幕',1.75,2]]);
  state.trackControls={'caption0':{hidden:true},'layer-text-title':{hidden:true}};
  assert.deepEqual(read().map(([text])=>text),['粘贴','画面字幕']);
  state.subtitleStyle={enabled:false};state.trackControls={};
  assert.deepEqual(read(),[['片名',.25,.75]]);
});

test('legacy candidates fill unreserved video rows without stealing explicitly placed rows', () => {
  const { candidateVideoLanes }=require('../src/ui/track-tools.js');
  const clips=[{id:'first'},{id:'moved',videoLane:3},{id:'second'},{id:'pinned',videoLane:0}];
  assert.deepEqual(candidateVideoLanes(clips,100),[1,3,2,0]);
  assert.deepEqual(candidateVideoLanes([{videoLane:99}],100),[99]);
  for(const invalid of [-1,100,1.5,'2',null]) {
    assert.throws(()=>candidateVideoLanes([{videoLane:invalid}],100),/视频轨/);
  }
  assert.throws(()=>candidateVideoLanes([{videoLane:3},{videoLane:3}],100),/视频轨/);
});

test('disabling timeline rows switches picture and narration takes, caption ownership, and audible music',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const asset=(id,kind,duration)=>({id,kind,duration,url:'test://'+id});
  const clip=id=>({asset:asset(id,'video',2.5),start:0,end:2.5,
    videoSubtitles:{cues:[{text:id+' 字幕',start:0,end:400}]}});
  const text=(title,laneId)=>({kind:'text',text:title,laneId,start:0,end:.4});
  const a=clip('画面 A'), b=clip('画面 B');
  a.layers=[text('A 片段标题','a')]; a.videoStart=60;
  const voices=[asset('口播 A','audio',5),asset('口播 B','audio',1.5)];
  const state={shots:[[a,b]],settings:[],whole:[],segments:[voices],music:[asset('音乐 A','audio',8),asset('音乐 B','audio',4)],
    segmented:true,priority:'voice',voiceRanges:()=>undefined,voiceDuration:(i,row)=>voices[row].duration,
    voiceOffset:()=>0,voiceVolume:()=>100,musicVolume:asset=>asset.duration*10,keepAudio:true,muted:new Set(),
    pack:{global:[],composites:[[text('包装 A','no')],[text('包装 B','yes')]],segmentNarration:[[[text('口播装饰 A','va')],[text('口播装饰 B','vb')]]],wholeNarration:[]},
    captions:voices.map((v,row)=>({shot:0,row,start:0,duration:.4,name:v.id+' 字幕'})),
    timelineCaptions:[{text:'独立字幕',start:0,end:500}],trackControls:{
      vis0:{disabled:true,solo:true,hidden:true},voice0:{disabled:true,solo:true},music0:{disabled:true,solo:true},'layer-text-no':{disabled:true},
    }};
  const plan=()=>{
    const layout=timing(state,c=>c.end,()=>null,a);
    const entries=makePlan(state,layout,()=>null,waveformSource,a);
    return {entries,duration:layout.total,media:entries.filter(e=>e.asset).map(e=>e.asset.id),texts:entries.filter(e=>e.text).map(e=>e.text)};
  };
  let result=plan();
  assert.equal(result.duration,1.5,'disabled selected placement and narration cannot extend the shot');
  assert.deepEqual(result.media,['画面 B','口播 B','音乐 B']);
  assert.ok(result.entries.filter(e=>e.asset).every(e=>e.volume>0),'disabled solos release the other rows');
  assert.deepEqual(result.texts.sort(),['画面 B 字幕','口播 B 字幕','独立字幕','口播装饰 B','包装 B'].sort());
  state.trackControls={...state.trackControls,caption1:{disabled:true},'local-subtitles':{disabled:true},'pasted-captions':{disabled:true}};
  assert.deepEqual(plan().texts.sort(),['包装 B','口播装饰 B'].sort());
  assert.deepEqual(plan().media,result.media,'caption tracks can be switched off while their audio and video play');
  state.trackControls={...state.trackControls,voice1:{disabled:true},music1:{disabled:true}};
  result=plan();
  assert.equal(result.duration,2.5);
  assert.deepEqual(result.media,['画面 B']);
  assert.deepEqual(result.texts,['包装 B']);
  state.trackControls={vis0:{hidden:true},voice0:{disabled:true},music0:{disabled:true}};
  a.videoStart=0;
  result=plan();
  assert.ok(result.entries.some(e=>e.asset===a.asset && !e.visual && e.volume>0),'re-enabled hidden take keeps its audio');
  assert.ok(result.entries.some(e=>e.asset===b.asset && e.visual && !e.volume),'eye reveals the lower picture only');
});

test('ordered audition leaves gaps in a take and whole SRT-only tracks use their own switch',()=>{
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const asset=id=>({id,kind:'audio',duration:2,url:'test://'+id});
  const cue=(name,row,shot)=>({name,row,shot,start:0,duration:.5});
  const state={shots:[[],[]],settings:[{duration:2},{duration:2}],whole:[],music:[],
    segmented:true,priority:'picture',segments:[[asset('A1'),asset('B1')],[asset('A2'),null,asset('C2')]],
    voiceRanges:()=>undefined,voiceDuration:()=>2,voiceOffset:()=>0,voiceVolume:()=>100,
    pack:{global:[],composites:[],segmentNarration:[],wholeNarration:[]},
    captions:[cue('字幕 A',0,1),cue('字幕 B',1,0),cue('字幕 C',2,1)],
    trackControls:{voice0:{disabled:true}},timelineCaptions:[{text:'粘贴',start:0,end:750}]};
  function preview() {
    const layout=timing(state,()=>0,()=>null);
    const entries=makePlan(state,layout,()=>null,waveformSource);
    return [entries.filter(e=>e.asset).map(e=>e.asset.id),entries.filter(e=>e.text).map(e=>e.text)];
  }
  assert.deepEqual(preview(),[['B1'],['字幕 B','粘贴']]);
  state.segmentNarrationSelection='random';
  assert.deepEqual(preview(),[['B1','C2'],['字幕 B','粘贴','字幕 C']]);
  Object.assign(state,{segmented:false,whole:[{asset:asset('A')},{asset:asset('B')},{subtitles:{cues:[]}}],
    captions:[cue('A 台词',0,null),cue('B 台词',1,null),cue('单独 SRT',2,null)],
    trackControls:{whole0:{disabled:true,solo:true},whole1:{disabled:true},whole2:{disabled:true}}});
  assert.deepEqual(preview(),[[],['单独 SRT','粘贴']]);
  state.trackControls={...state.trackControls,caption2:{disabled:true}};
  assert.deepEqual(preview(),[[],['粘贴']]);
  state.trackControls={whole0:{disabled:true},caption1:{disabled:true}};
  assert.deepEqual(preview(),[['B'],['粘贴']]);
  state.trackControls={};
  assert.deepEqual(preview(),[['A'],['A 台词','粘贴']]);
});

test('playhead split preserves the original trimmed boundaries', () => {
  assert.deepEqual(splitRanges(2.2, 3, { point: 2.3 }), [
    { start: 2.2, end: 2.3 },
    { start: 2.3, end: 3 },
  ]);
  assert.throws(() => splitRanges(2.2, 3, { point: 2.25 }), /每段至少 0.1 秒/);
});

test('interval splits keep a long tail and fold a short tail into the previous slice', () => {
  assert.deepEqual(splitRanges(1, 2.25, { interval: 0.5 }), [
    { start: 1, end: 1.5 }, { start: 1.5, end: 2 }, { start: 2, end: 2.25 },
  ]);
  assert.deepEqual(splitRanges(1, 2.05, { interval: 0.5, maxParts: 2 }), [
    { start: 1, end: 1.5 }, { start: 1.5, end: 2.05 },
  ]);
  assert.deepEqual(splitRanges(0, 0.3, { interval: 0.1 }).map(({ end }) => end), [0.1, 0.2, 0.3]);
});

test('slice requests outside the editor capacity or duration are rejected', () => {
  assert.throws(() => splitRanges(0, 1e12, { interval: 0.1, maxParts: 16 }), /最多可切成 16 段/);
  assert.throws(() => splitRanges(1, 1.25, { interval: 0.2 }), /时长不足以.*两段/);
  assert.throws(() => splitRanges(1, 2, { point: 1.5, interval: 0.25 }), /请选择/);
});

test('draft playback maps sliced narration, original sound, looping music and effects to the timeline', () => {
  const { timing, makePlan } = require('../src/ui/draft-transport.js');
  const { waveformSource } = require('../src/ui/waveform.js');
  const media = (id, kind, duration) => ({ id,kind,duration,url:'test://'+id });
  const voice = media('voice','audio',4), music = media('music','audio',.25), effect = media('effect','audio',1);
  const first = {asset:media('video','video',4),ranges:[{start:.4,end:.8},{start:.1,end:.3}],volume:70};
  const sounds = [{kind:'sound',id:'effect',start:.2,end:.55,mediaOffset:.45,volume:65}];
  const state = {shots:[[first],[]],settings:[{duration:.3},null],segments:[[],[null,voice]],whole:[],
    priority:'picture',keepAudio:true,muted:new Set(),segmented:true,music:[music],musicAt:1,
    musicVolume:()=>30,voiceVolume:()=>75,voiceDuration:()=>.7,voiceOffset:()=>.25,
    voiceRanges:()=>[{start:1.1,end:1.4},{start:.2,end:.6}],
    pack:{global:sounds,composites:[],segmentNarration:[],wholeNarration:[]}};
  const library = id => id==='effect' ? effect : null;
  const layout = timing(state,()=>.3,library);
  const plan = makePlan(state,layout,library,waveformSource);
  const value = (n) => Number(n.toFixed(3));
  const pieces = (lane) => plan.filter((item)=>item.lane===lane).map((item)=>
    [item.start,item.end,item.source,item.rate,item.volume].map(value));
  assert.deepEqual(layout.widths,[.3,.95]);
  assert.deepEqual(pieces('picture'),[[0,.2,.4,2,70],[.2,.3,.1,2,70]]);
  assert.deepEqual(pieces('voice'),[[.55,.85,1.1,1,75],[.85,1.25,.2,1,75]]);
  assert.deepEqual(pieces('music'),[[.3,1.25,0,1,30]]);
  assert.equal(plan.find((item)=>item.lane==='music').loop,true);
  assert.deepEqual(pieces(sounds[0]),[[.2,.55,.45,1,65]]);

  const fast={...state,voiceSpeed:()=>2,voiceDuration:()=>.35,musicSpeed:()=>.5};
  const layoutFast=timing(fast,()=>.3,library);
  const planFast=makePlan(fast,layoutFast,library,waveformSource);
  assert.deepEqual(layoutFast.widths,[.3,.6]);
  assert.deepEqual(planFast.filter(e=>e.lane==='voice').map(e=>[e.start,e.end,e.rate].map(value)),[[.55,.7,2],[.7,.9,2]]);
  assert.equal(planFast.find(e=>e.lane==='music').rate,.5);

  // A narration-only project may follow a later, empty shot.
  Object.assign(state,{shots:[[],[],[]],settings:[],segments:[],segmented:false,
    music:[],whole:[{asset:null},{asset:voice,follow:2}]});
  state.pack.global=[];
  const onlyVoice=timing(state,()=>0,library);
  assert.deepEqual(onlyVoice,{widths:[3,3,4],starts:[0,3,6],total:10});
  const [whole]=makePlan(state,onlyVoice,library,waveformSource);
  assert.deepEqual([whole.asset,whole.start,whole.end],[voice,6,10]);
  state.whole=[];
  assert.deepEqual(makePlan(state,timing(state,()=>0,library),library,waveformSource),[]);
});

test('live voice priority fills a short candidate, accelerates a long selection and respects the reference mode', () => {
  const { timing, makePlan } = require('../src/ui/draft-transport.js');
  const { waveformSource } = require('../src/ui/waveform.js');
  const clip = (id,end) => ({asset:{kind:'video',id,url:'test://'+id,duration:end},start:0,end});
  const first=clip('short',.5), second=clip('long',2);
  const voice={kind:'audio',url:'test://voice',duration:1};
  const state={shots:[[first,second]],segments:[[voice]],settings:[],whole:[],segmented:true,priority:'voice',
    voiceVolume:()=>100,voiceRanges:()=>undefined,voiceOffset:()=>0,voiceDuration:()=>1,
    keepAudio:true,muted:new Set(),music:[],pack:{global:[],composites:[],segmentNarration:[],wholeNarration:[]},fps:30};
  const plan=focus=>{
    const layout=timing(state,c=>c.end,()=>null,focus);
    return makePlan(state,layout,()=>null,waveformSource,focus);
  };
  const visuals=focus=>plan(focus).filter(e=>e.lane==='picture');
  assert.deepEqual(visuals(first).map(e=>[e.asset.id,e.start,e.end,e.rate]),[['short',0,.2,2.5],['long',.2,1,2.5]]);
  assert.deepEqual(visuals(second).map(e=>[e.asset.id,e.start,e.end,e.rate]),[['long',0,1,2]]);
  assert.equal(plan(first).find(e=>e.lane==='voice').rate,1);
  state.shots=[[first]];
  assert.equal(visuals(first)[0].cycle,.5);
  assert.equal(visuals(first)[0].end,1);
  state.shots=[[first,second]];
  state.voiceAlignment='reference';
  assert.equal(visuals(first)[0].rate,.5);
  assert.equal(visuals(second)[0].rate,1);
  assert.equal(visuals(second)[0].end,1);
  state.segmented=false;state.whole=[{asset:voice}];state.voiceAlignment='fill';
  assert.deepEqual(visuals(first).map(e=>e.asset.id),['short','long']);
  first.videoStart=0;first.videoDuration=.4;
  for(const segmented of [true,false]) {
    state.segmented=segmented;
    assert.deepEqual(plan(first).filter(e=>e.visual).map(e=>[e.asset.id,e.start,e.end,e.rate]),
      [['short',0,.2,2.5],['long',.2,.4,2.5]],'实际跟随口播时沿用原混剪填充与倍速');
  }
});

test('a saved automatic fit spans the second narrated shot even when its cached speed is 1', () => {
  const {timing,makePlan}=require('../src/ui/draft-transport.js');
  const {waveformSource}=require('../src/ui/waveform.js');
  const first=4.358, second=4.063;
  const media=(id,kind,duration)=>({id,url:'test://'+id,kind,duration});
  const clip={asset:media('second','video',2.016),start:0,end:2.016,videoStart:first,
    videoDuration:second,videoFit:'hold',autoFitSpeed:true,speed:1};
  const voices=[media('first voice','audio',first),media('second voice','audio',second)];
  const state={shots:[[],[clip]],settings:[],whole:[],segmented:true,segments:voices.map(v=>[v]),
    priority:'voice',voiceAlignment:'fill',voiceDuration:i=>voices[i].duration,
    voiceOffset:()=>0,voiceRanges:()=>undefined,voiceVolume:()=>100,keepAudio:false,muted:new Set(),
    captions:[{shot:1,row:0,name:'第二句',start:0,duration:second}],
    music:[],pack:{global:[],composites:[],segmentNarration:[],wholeNarration:[]}};
  function plan() {
    const layout=timing(state,c=>(c.end-c.start)/c.speed,()=>null);
    return makePlan(state,layout,()=>null,waveformSource);
  }
  const entries=plan();
  assert.deepEqual(entries.filter(e=>e.asset===clip.asset).map(e=>[e.start,e.end,e.rate]),
    [[first,first+second,clip.end/second]]);
  assert.deepEqual(entries.filter(e=>e.asset===voices[1] || e.text==='第二句').map(e=>[e.start,e.end]),
    [[first,first+second],[first,first+second]]);
  delete clip.autoFitSpeed;
  assert.deepEqual(plan().filter(e=>e.asset===clip.asset).map(e=>[e.start,e.end,e.rate]),
    [[first,first+clip.end,1],[first+clip.end,first+second,0]]);
});

test('live playback applies mute to physical video rows in both picture and narration timing', () => {
  const { timing, makePlan } = require('../src/ui/draft-transport.js');
  const { waveformSource } = require('../src/ui/waveform.js');
  const media=(id,kind,duration)=>({id,kind,duration,url:'test://'+id});
  const moved={asset:media('moved','video',.5),start:0,end:.5,volume:42,videoLane:3};
  const other={asset:media('other','video',1),start:0,end:1,volume:71,videoLane:0};
  const state={shots:[[moved,other]],settings:[],whole:[],segments:[[media('voice','audio',1)]],
    segmented:true,voiceDuration:()=>1,voiceOffset:()=>0,voiceRanges:()=>undefined,voiceVolume:()=>100,
    keepAudio:true,muted:new Set([0]),music:[],pack:{global:[],composites:[],segmentNarration:[],wholeNarration:[]}};
  function levels(priority,focus) {
    state.priority=priority;
    const layout=timing(state,c=>c.end,()=>null,focus);
    return makePlan(state,layout,()=>null,waveformSource,focus)
      .filter(e=>e.lane==='picture').map(e=>[e.asset.id,e.volume]);
  }
  assert.deepEqual(levels('picture',moved),[['moved',42]]);
  assert.deepEqual(levels('picture',other),[['other',0]]);
  assert.deepEqual(levels('voice',moved),[['moved',42],['other',0]]);
  state.muted=new Set([3]);
  assert.deepEqual(levels('voice',moved),[['moved',0],['other',71]]);
});

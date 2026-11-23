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
  }
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

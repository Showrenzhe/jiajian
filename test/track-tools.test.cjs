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

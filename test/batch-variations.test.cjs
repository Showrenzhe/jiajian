'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const variations = require('../src/ui/batch-variations.js');
const {planMontage} = require('../src/media.cjs');
const {createPreviewBatch, selectPreviewPlans, prepareMontagePlans, prepareSubprojectPlans, createSpeedPlanningSession} = require('../src/preview-plans.cjs');
const {candidatePreferenceOwner} = require('../src/ui/track-tools.js');

const seed = '0123456789abcdef0123456789abcdef';
const settings = {algorithm:1, seed, minDifferentShots:0, avoidSameOpening:false};
function fixture(rows, extra = {}) {
  const shots = rows.map(row => row.map(candidate => ({start:0, end:2, ...(typeof candidate === 'string' ? {id:candidate} : candidate)})));
  const catalog = new Map(shots.flat().map(({id}) => [id,{kind:'video',name:id,duration:2}]));
  for (const id of ['voice-a','voice-b','music-a','music-b']) catalog.set(id,{kind:'audio', name:id,duration:2});
  const config = {shots, ratio:'9:16', resolution:720, fps:30, fit:'fit', keepAudio:false, unordered:false,
    useOriginal:true, useMirrors:false, musicVolume:50, musicIds:[], count:1, batchRandom:settings, ...extra};
  return {config, catalog};
}

test('algorithm 1 has stable namespaced draws, validates persisted data and counts above Number precision', () => {
  assert.deepEqual(variations.normalizeSettings(settings),settings);
  assert.match(variations.newSettings().seed,/^[0-9a-f]{32}$/);
  for (const bad of [{algorithm:2},{seed:'xyz'},{minDifferentShots:-1},{minDifferentShots:1.5},{avoidSameOpening:0}]) {
    assert.throws(()=>variations.normalizeSettings({...settings,...bad}),/批次/);
  }
  assert.throws(()=>variations.normalizePreference(null),/候选/);
  const random = variations.randomFor(seed,'subproject','a');
  assert.deepEqual(Array.from({length:4},()=>random()*2**32),[2454748247,37600333,633364581,343395676]);
  assert.notEqual(variations.randomFor(seed,'main')(),variations.randomFor(seed,'subproject','a')());
  assert.equal(variations.combinationCount(Array(100).fill(10)),10n**100n);
});

test('finite space includes music, narration and mirror, fixed captions count once; selected plans replay after asset relocation', () => {
  const {catalog, config} = fixture([['a','b'],['c']], {count:32,useMirrors:true, musicIds:['music-a','music-b'],
    narrationId:'voice-a',extraWholeTracks:[{narrationId:'voice-b'}],unordered:true,cover:{mode:'random',items:[]},
    subtitleStyle:{size:24},shotSettings:[{duration:1,smartTrim:true},{}]});
  const plans = planMontage(config,catalog);
  assert.deepEqual(plans.batchSummary,{totalSpace:'32',requested:32,actual:32,reason:null});
  const key = plan => [plan.clips.toSorted((a,b)=>a.shotIndex-b.shotIndex).map(c=>[c.batchSlot,Boolean(c.mirror)]),
    plan.music.name,plan.narration.name];
  assert.equal(new Set(plans.map(plan=>JSON.stringify(key(plan)))).size,32);
  assert.deepEqual(planMontage(config,catalog),plans);
  // Opening an old project rebuilds transient IDs, and relocating files changes paths.
  const relocated = new Map([...catalog].map(([id,asset])=>['new-'+id,{...asset,path:'relocated/'+asset.name}]));
  const moved = {...config,shots:config.shots.map(s=>s.map(c=>({...c,id:'new-'+c.id}))),
    musicIds:config.musicIds.map(id=>'new-'+id), narrationId:'new-voice-a',extraWholeTracks:[{narrationId:'new-voice-b'}]};
  function decisions(p) { return [key(p),p.clips.map(c=>[c.shotIndex,c.start]),p.cover]; }
  assert.deepEqual(planMontage(moved,relocated).map(decisions),plans.map(decisions));
  const otherSeed = {...config,batchRandom:{...settings,seed:'4'.repeat(32)}};
  assert.notDeepEqual(planMontage(otherSeed,catalog).map(decisions),plans.map(decisions));
  assert.deepEqual(planMontage({...config,count:33},catalog).batchSummary,
    {totalSpace:'32',requested:33,actual:32,reason:'impossible'});
  assert.throws(()=>planMontage({...config,batchRandom:undefined,count:33},catalog),/生成数量/);
  assert.throws(()=>planMontage({...config,count:1001},catalog),/生成数量/);
});

test('required candidates filter after enabled and solo, while low-frequency candidates get half weight over a batch', () => {
  const required = [{id:'a',batchPreference:'required'},{id:'b',batchPreference:'required'},{id:'c',batchPreference:'low'}];
  const {catalog,config} = fixture([required], {count:2});
  assert.deepEqual(new Set(planMontage(config,catalog).map(p=>p.clips[0].asset.name)),new Set(['a','b']));
  const solo = {...config,count:1,trackControls:{vis2:{solo:true}}};
  assert.equal(planMontage(solo,catalog)[0].clips[0].asset.name,'c');
  const low = {...config,count:15,shots:[[...config.shots[0].map((c,i)=>({...c,batchPreference:i===2?'low':'normal'}))],
    Array.from({length:15},()=>({id:'b',start:0,end:1}))]};
  const frequencies = [0,0,0];
  for (const plan of planMontage(low,catalog)) frequencies[plan.clips[0].batchSlot]++;
  assert.deepEqual(frequencies,[6,6,3]);
});

test('two soundtracks now form two plans; mirror and music cannot satisfy a different-picture constraint', () => {
  const {config,catalog} = fixture([['a']], {count:2,musicIds:['music-a','music-b']});
  const withMusic = planMontage(config,catalog);
  assert.deepEqual(new Set(withMusic.map(p=>p.music.name)),new Set(config.musicIds));
  for (const rules of [{minDifferentShots:1},{avoidSameOpening:true}]) {
    const partial = planMontage({...config,useMirrors:true,count:4,batchRandom:{...settings,...rules}},catalog);
    assert.deepEqual(partial.batchSummary,{totalSpace:'4',requested:4,actual:1,reason:'impossible'});
  }
  const oversubscribed=planMontage({...config,count:5,batchRandom:{...settings,minDifferentShots:2}},catalog);
  assert.deepEqual(oversubscribed.batchSummary,{totalSpace:'2',requested:5,actual:1,reason:'impossible'});
});

test('distance uses original shot slots after shuffling, and consecutive openings compare the actual first source', () => {
  const {config,catalog} = fixture(Array.from({length:4},()=>['a','b','c']),{count:9,unordered:true,
    batchRandom:{...settings,minDifferentShots:2,avoidSameOpening:true}});
  const plans = planMontage(config,catalog);
  assert.equal(plans.length,9);
  const vectors = plans.map(p=>p.clips.toSorted((a,b)=>a.shotIndex-b.shotIndex).map(c=>c.batchSlot));
  for (let i=0;i<plans.length;i++) {
    if (i) assert.notEqual(plans[i].clips[0].asset,plans[i-1].clips[0].asset);
    for (let j=0;j<i;j++) assert.ok(vectors[i].filter((slot,k)=>slot!==vectors[j][k]).length>=2);
  }
});

test('small binary space finds a maximal feasible distance code; bounded larger searches keep a repeatable partial batch', () => {
  function binary(groups, distance) {
    const {config,catalog} = fixture(Array.from({length:groups},()=>['a','b']),{count:2**groups,
      batchRandom:{...settings,minDifferentShots:distance}});
    return planMontage(config,catalog);
  }
  const exact = binary(3,2);
  assert.equal(exact.length,4);
  assert.equal(exact.batchSummary.reason,'impossible');
  const partial = binary(7,4);
  assert.ok(partial.length>0 && partial.length<128);
  assert.equal(partial.batchSummary.reason,'budget');
  assert.deepEqual(binary(7,4),partial);
});

test('1,000 plans draw from a large Cartesian space without expanding that space', () => {
  const shots = Array.from({length:40},()=>[0,1,2,3].map(i=>({batchSlot:i,originalMaterialId:i})));
  const batch=variations.drawBatch({shots,extraSizes:[2],count:1000,random:variations.randomFor(seed),settings});
  assert.equal(batch.summary.totalSpace,String(4n**40n*2n));
  assert.equal(batch.summary.actual,1000);
  assert.equal(new Set(batch.rows.map(row=>row.indices.join(','))).size,1000);
});

test('a joined segment edits the participating group leader on its physical lane', () => {
  const member=(lane,start)=>({videoGroup:'take',videoLane:lane,videoStart:start,videoDuration:1});
  const otherLane=member(0,0), excluded={...member(1,0),enabled:false};
  const leader=member(1,1), follower=member(1,2);
  const shot=[otherLane,excluded,leader,follower];
  assert.equal(candidatePreferenceOwner(shot,follower),leader);
  assert.equal(candidatePreferenceOwner(shot,excluded),leader);
  assert.equal(candidatePreferenceOwner(shot,otherLane),otherLane);
  delete follower.videoGroup;
  assert.equal(candidatePreferenceOwner(shot,follower),follower);
});

const previewCatalog = new Map(['a', 'b', 'c'].map((id) => [id, { kind: 'video', name: id, duration: 1.5 }]));
const previewConfig = {
  shots: [[{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 0.1, end: 1.4 }], [{ id: 'c', start: 0, end: 0.6 }]],
  ratio: '9:16', resolution: 720, fps: 30, fit: 'fit', keepAudio: true, unordered: false,
  useOriginal: true, useMirrors: false, musicIds: [], musicVolume: 35, count: 2,
};

test('v7 seeds replay child plans across reordered scopes, single-child generation and direct export',async()=>{
  const settings = {...previewConfig,count:4,unordered:true,useMirrors:true,
    batchRandom:{algorithm:1,seed:'fabc23456789abcdef0123456789abcd',minDifferentShots:1,avoidSameOpening:true},
    subprojects:{active:null,main:[],projects:[{id:'hz',name:'杭州',shots:[]},{id:'sh',name:'上海',shots:[]}]}};
  const scope = [{id:'hz',count:4},{id:'sh',count:4}];
  const plans = await prepareSubprojectPlans(settings,scope,previewCatalog);
  assert.equal(plans.length,4);
  const childSummary = {totalSpace:'8',requested:4,actual:2,reason:'impossible'};
  assert.deepEqual(plans.batchSummary,{totalSpace:'16',requested:8,actual:4,reason:'impossible',
    subprojects:settings.subprojects.projects.map(({id,name})=>({id,name,...childSummary}))});
  const reversed = await prepareSubprojectPlans(settings,[...scope].reverse(),previewCatalog);
  const prepare = createSpeedPlanningSession();
  for (const child of scope) {
    const expected = plans.filter(plan=>plan.subproject.id===child.id);
    assert.deepEqual(reversed.filter(plan=>plan.subproject.id===child.id),expected);
    assert.deepEqual(await prepareSubprojectPlans(settings,[child],previewCatalog),expected);
    const single = {...settings,subprojects:{...settings.subprojects,active:child.id}};
    const {plans:direct} = await prepare(single,undefined,previewCatalog);
    assert.deepEqual(direct,expected.map(({subproject,...plan})=>plan));
  }
  const batch = createPreviewBatch(settings,previewCatalog,plans);
  assert.deepEqual(batch.batchSummary,plans.batchSummary);
  assert.deepEqual(selectPreviewPlans(batch,settings,{id:batch.id,indices:[3,0]}),[plans[3],plans[0]]);
  assert.throws(()=>selectPreviewPlans(batch,{...settings,batchRandom:{...settings.batchRandom,seed:'0'.repeat(32)}},
    {id:batch.id,indices:[0]}),/设置已变化/);
});

test('scoped speed confirmations replay seeded pictures and the exact single-child export after resolving the dialog',async()=>{
  const assets = new Map([...previewCatalog,['voice',{name:'口播',duration:.1,kind:'audio'}]]);
  const settings = {...previewConfig,count:2,shots:[previewConfig.shots[0]],priority:'voice',narrationId:'voice',
    autoSpeedRange:{min:.25,max:4},batchRandom:{algorithm:1,seed:'0123456789abcdef0123456789abcdef',minDifferentShots:0,avoidSameOpening:false},
    subprojects:{active:'hz',main:[],projects:[{id:'hz',name:'杭州',shots:[]}]}};
  async function confirmed(scope) {
    const prepare = createSpeedPlanningSession();
    const {speedChallenge} = await prepare(settings,scope,assets);
    assert.ok(speedChallenge.items.length);
    const choices = Object.fromEntries(speedChallenge.items.map(item=>[item.key,'trim-start']));
    return (await prepare(settings,scope,assets,{response:{token:speedChallenge.token,choices}})).plans;
  }
  const scoped = await confirmed([{id:'hz',count:2}]);
  const direct = await confirmed(undefined);
  assert.deepEqual(direct,scoped.map(({subproject,...plan})=>plan));
});

test('a measured narration pause changes the cut without redrawing any seeded candidates or covers',async()=>{
  const assets = new Map([...previewCatalog,['voice',{name:'voice',duration:4,kind:'audio',audioIndex:0}]]);
  const settings = {...previewConfig,count:4,shots:[['a','b'].map(id=>({id,start:0,end:1}))],useMirrors:true,
    priority:'picture',narrationId:'voice',narrationTrim:require('../src/ui/narration-trim.js').smartDefaults,
    cover:{mode:'random',items:[]},
    batchRandom:{algorithm:1,seed:'b00b123456789abcdef0123456789abc',minDifferentShots:0,avoidSameOpening:false}};
  const before = await prepareMontagePlans(settings,assets,{analyzePauses:async()=>[]});
  let analyses = 0;
  const measured = await prepareMontagePlans(settings,assets,{analyzePauses:async()=>{
    analyses++;
    return [{start:.6,end:.9}];
  }});
  const choices = plans=>createPreviewBatch(settings,assets,plans).entries.map(entry=>entry.clips);
  assert.equal(analyses,1);
  assert.deepEqual(choices(measured),choices(before));
  assert.deepEqual(measured.map(plan=>plan.cover),before.map(plan=>plan.cover));
  assert.deepEqual(measured.batchSummary,before.batchSummary);
  assert.ok(before.every(plan=>plan.narrationMap.reason==='hard'));
  assert.ok(measured.every(plan=>plan.narrationMap.reason==='pause'));
});

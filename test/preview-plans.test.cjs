'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPreviewBatch, selectPreviewPlans } = require('../src/preview-plans.cjs');
const {projectVoiceConfig,normalizeSubprojects}=require('../src/subprojects.cjs');

test('门店整段口播独占、分段逐镜回退公共池，分类/变量与素材编号可重映射',()=>{
  const primary={shots:[[],[]],narrationId:'visible',segmentNarrationIds:[['visible'],['visible']]};
  const state={active:'hz',main:[],categories:[{index:1,category:'产品'}],mainVoice:{whole:[{id:'main',caption:'欢迎光临'}],segments:[{index:0,items:[{id:'s1'}]},{index:1,items:[{id:'s2'}]}]},
    projects:[{id:'hz',name:'杭州',shots:[],variables:[{key:'店名',text:'拱墅店'}],voice:{whole:[{id:'h'}],segments:[{index:1,items:[{id:'h2'}]}]}},{id:'sh',name:'上海',shots:[]}]};
  const saved=normalizeSubprojects(state,2,(a)=>a,(id)=>'r_'+id);
  assert.deepEqual(saved.categories,state.categories);assert.deepEqual(saved.projects[0].variables,state.projects[0].variables);
  const hz=projectVoiceConfig(primary,saved.projects[0],saved.mainVoice),sh=projectVoiceConfig(primary,saved.projects[1],saved.mainVoice);
  assert.equal(hz.narrationId,'r_h');assert.deepEqual(hz.extraWholeTracks,[]);assert.deepEqual(hz.segmentNarrationIds,[['r_s1'],['r_h2']]);
  assert.equal(sh.narrationId,'r_main');assert.deepEqual(sh.segmentNarrationIds,[['r_s1'],['r_s2']]);assert.equal(sh.generatedCaptions.r_main,'欢迎光临');
});

const catalog = new Map(['a', 'b', 'c'].map((id) => [id, { kind: 'video', name: id, duration: 1.5 }]));
const config = {
  shots: [[{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 0.1, end: 1.4 }], [{ id: 'c', start: 0, end: 0.6 }]],
  ratio: '9:16', resolution: 720, fps: 30, fit: 'fit', keepAudio: true, unordered: false,
  useOriginal: true, useMirrors: false, musicIds: [], musicVolume: 35, count: 2,
};

test('selection exports the same combinations, with the preview choices and order preserved', () => {
  const batch = createPreviewBatch(config, catalog);
  assert.deepEqual(batch.entries.map(({ index }) => index), [0, 1]);
  assert.deepEqual(batch.entries.map(({ clips }) => clips[0].name).sort(), ['a', 'b']);
  assert.deepEqual(batch.entries.map(({ clips }) => clips[1]), [{ name: 'c', mirror: false }, { name: 'c', mirror: false }]);
  const plans = selectPreviewPlans(batch, config, { id: batch.id, indices: [1, 0] });
  assert.strictEqual(plans[0], batch.plans[1]);
  assert.strictEqual(plans[1], batch.plans[0]);
});

test('selection requires the current settings and a valid nonempty set of indices', () => {
  const batch = createPreviewBatch(config, catalog);
  const selection = { id: batch.id, indices: [0] };
  assert.throws(() => selectPreviewPlans(batch, { ...config, ratio: '16:9' }, selection), /设置已变化/);
  assert.throws(() => selectPreviewPlans(batch, config, { ...selection, id: 'previous' }), /设置已变化/);
  for (const indices of [[], [0, 0], [2], [0.5]]) {
    assert.throws(() => selectPreviewPlans(batch, config, { ...selection, indices }), /有效的成片组合/);
  }
});

test('visual reuse is weighted by source intervals and duration, ignores cut order and separates mirrors and covers', () => {
  const { measureBatchReuse } = require('../src/visual-similarity.cjs');
  const clip = (id, start, duration, mirror = false) => ({ asset: catalog.get(id), start, duration, mirror });
  const a = clip('a', 0, 1), b = clip('b', 0, .5);
  const plan = (...clips) => ({ fps: 30, clips });
  const values = measureBatchReuse([plan(a, b), plan(b, a), plan(clip('a', .5, 1)), plan(clip('a', 0, 1, true))], catalog);
  assert.deepEqual(values.map((v) => [v.kind, v.percent]), [['none', 0], ['same', 100], ['partial', 33], ['none', 0]]);
  const covers = [a, b].map((cover) => ({ ...plan({ ...cover, shotIndex: 0 }, { ...clip('c', 0, 1), shotIndex: 1 }), cover: { mode: 'first-shot' } }));
  assert.equal(measureBatchReuse(covers, catalog)[1].kind, 'same');
});

test('a multi-project preview resolves each override against the main project and exports the exact selected plans', async () => {
  const { prepareSubprojectPlans } = require('../src/preview-plans.cjs');
  const rowA = [config.shots[0][0]], rowB = [config.shots[0][1]];
  const root = { ...config, count: 1, shots: [rowB, config.shots[1]], subprojects: { active: 'hz', main: [{ index: 0, clips: rowA }],
    projects: [{ id: 'hz', name: '杭州', shots: [{ index: 0, clips: rowB }] }, { id: 'sh', name: '上海', shots: [] }] } };
  const scope = [{ id: 'hz', count: 1 }, { id: 'sh', count: 1 }];
  const plans = await prepareSubprojectPlans(root, scope, catalog);
  const batch = createPreviewBatch(root, catalog, plans);
  assert.deepEqual(batch.entries.map((entry) => [entry.subproject.name, entry.clips[0].name]), [['杭州', 'b'], ['上海', 'a']]);
  const selected = selectPreviewPlans(batch, root, { id: batch.id, indices: [1] });
  assert.strictEqual(selected[0], plans[1]);
  await assert.rejects(prepareSubprojectPlans(root, [{ id: 'sh', count: 1001 }], catalog), /1000/);
  await assert.rejects(prepareSubprojectPlans(root, [{ id: 'missing', count: 1 }], catalog), /选择/);
});

test('disabled candidates stay out of draws and voice fill, and track mute covers mirrored candidates', () => {
  const voice = { kind: 'audio', name: '旁白', duration: 4 };
  const assets = new Map([...catalog, ['voice', voice]]);
  const settings = { ...config, shots: [[{ ...config.shots[0][0], enabled: false }, { ...config.shots[0][1], volume: 72 }]],
    useMirrors: true, mutedVideoTracks: [1], priority: 'voice', narrationId: 'voice' };
  const { plans } = createPreviewBatch(settings, assets);
  for (const { clips } of plans) {
    assert.ok(clips.every((clip) => clip.asset.name === 'b' && clip.volume === 0));
    assert.ok(clips.flatMap((clip) => clip.visuals).every((visual) => visual.asset.name === 'b' && visual.volume === 0));
  }
  assert.equal(createPreviewBatch({ ...settings, mutedVideoTracks: [] }, assets).plans[0].clips[0].volume, 0.72);
  const disabled = [[{ ...settings.shots[0][0], enabled: false }]];
  assert.throws(() => createPreviewBatch({ ...settings, shots: disabled }, assets), /第 1 组.*参与/);
});

test('samples complete composite and text rows and anchors text and narration to the selected shots', () => {
  const text = (value) => ({ kind: 'text', text: value });
  const settings = { ...config, count: 4, shots: [[{ id: 'a', start: 0, end: .5 }], [{ id: 'b', start: 0, end: 1 }]],
    narrationMode: 'segmented', segmentNarrationIds: [['voice'], ['voice']],
    packaging: { textMode: 'segmented', textSelection: 'ordered',
      composites: [[text('包装一')], [text('包装二')]],
      textGroups: [[[text('A1')], [text('A2')]], [[text('B1')], [text('B2')]]],
      segmentNarration: [[[text('前半口播')]], [[text('后半口播')]]] } };
  const assets = new Map([...catalog, ['voice', { kind: 'audio', name: '配音', duration: .25 }]]);
  const batch = createPreviewBatch(settings, assets);
  const selected = batch.plans.map((plan) => plan.layers.map((layer) => layer.text).join('|'));
  assert.equal(new Set(selected).size, 4);
  for (const { layers } of batch.plans) {
    assert.equal(layers[0].text.charAt(0), layers[2].text.charAt(0));
    assert.deepEqual(layers.slice(0, 4).map(({ start, end }) => [start, end]), [[0, .5], [0, .25], [.5, 1.5], [.5, .75]]);
  }
  const random = { ...settings, count: 8, packaging: { ...settings.packaging, textSelection: 'random' } };
  assert.equal(new Set(createPreviewBatch(random, assets).plans.map((plan) => plan.layers.map((layer) => layer.text).join('|'))).size, 8);
});

test('maps candidate and narration children through retained source cuts, voice offsets and fill footage', () => {
  const assets = new Map([...catalog, ['voice', { kind: 'audio', name: '配音', duration: 1.5 }]]);
  const settings = { ...config, count: 1, shots: [[{ id: 'a', start: 0, end: 1.4,
    ranges: [{ start: 0, end: .4 }, { start: .8, end: 1.2 }],
    layers: [{ kind: 'text', text: '画面后段', start: .9, end: 1.1 }] }]],
    narrationMode: 'segmented', segmentNarrationIds: [['voice']],
    segmentVoiceCuts: [[{ ranges: [{ start: .25, end: .55 }, { start: 1.1, end: 1.4 }], offset: .15 }]],
    packaging: { segmentNarration: [[[{ kind: 'text', text: '保留下来的口播', start: 1.2, end: 1.3 }]]] } };
  const [plan] = createPreviewBatch(settings, assets).plans;
  const near = (value, expected) => assert.ok(Math.abs(value - expected) < .051, `${value} vs ${expected}`);
  near(plan.layers[0].start, .5); near(plan.layers[0].end, .7);
  near(plan.layers[1].start, .55); near(plan.layers[1].end, .65);
  const fill = { ...settings, segmentVoiceCuts: undefined, packaging: {}, priority: 'voice', shots: [[
    { id: 'a', start: 0, end: .4, layers: [{ kind: 'text', text: '画面A', end: .3 }] },
    { id: 'b', start: 0, end: 1.4, layers: [{ kind: 'text', text: '画面B', end: 1.0 }] },
  ]] };
  const plans = createPreviewBatch({ ...fill, count: 2 }, assets).plans;
  const first = plans.find((entry) => entry.clips[0].asset.name === 'a');
  assert.deepEqual(first.layers.map((layer) => layer.text), ['画面A', '画面B']);
  near(first.layers[0].end, .25); near(first.layers[1].start, .4 / 1.2);
});

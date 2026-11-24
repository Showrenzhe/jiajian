'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEditHistory } = require('../src/ui/edit-history.js');
const { createSubprojects } = require('../src/ui/subprojects.js');

test('structurally identical edits are ignored and snapshots do not share mutable references', () => {
  const initial = { clip: { end: 2, start: 0 }, ids: ['a'] };
  const history = createEditHistory(initial);
  assert.equal(history.record({ ids: ['a'], clip: { start: 0, end: 2 } }), false);
  assert.equal(history.canUndo(), false);
  initial.clip.end = 100;
  const changed = { clip: { end: 3, start: 0 }, ids: ['a'] };
  history.record(changed);
  changed.ids.push('b');

  const restored = history.undo();
  assert.deepEqual(restored, { clip: { end: 2, start: 0 }, ids: ['a'] });
  restored.clip.end = 100;
  assert.deepEqual(history.redo(), { clip: { end: 3, start: 0 }, ids: ['a'] });
  assert.equal(history.undo().clip.end, 2);
});

test('numeric groups coalesce until a boundary, then new edits discard redo', () => {
  const history = createEditHistory(0);
  history.record(1, { group: 'start' });
  history.record(2, { group: 'start' });
  history.record(2);
  history.record(3, { group: 'start' });
  assert.equal(history.undo(), 2);
  assert.equal(history.undo(), 0);
  assert.equal(history.redo(), 2);
  history.record(4, { group: 'start' });
  assert.equal(history.canRedo(), false);
  assert.equal(history.undo(), 2);
});

test('returning a group to its initial value does not lose an older undo step', () => {
  const history = createEditHistory(null, { limit: 2 });
  history.record(1);
  history.record(2);
  history.record(3, { group: 'trim' });
  history.record(2, { group: 'trim' });
  assert.equal(history.undo(), 1);
  assert.equal(history.undo(), null);
  assert.equal(history.undo(), undefined);
  assert.equal(history.redo(), 1);
  history.record(2);
  history.record(3);
  assert.equal(history.undo(), 2);
  assert.equal(history.undo(), 1);
  assert.equal(history.undo(), undefined);
  history.reset({ shots: [] });
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});

test('undoing a subproject clip swap preserves inherited captions and leaves the swap available to redo', () => {
  const shots = [[{id:'red'}], [{id:'blue'}]];
  const caption = {name:'台词', cues:[{start:0, end:200, text:'留在第二镜'}]};
  const voiceIO = {
    read: () => ({whole:[], segments:[{index:1, items:[{id:'voice', caption}]}]}),
    write() {},
  };
  const state = createSubprojects({shots, serialize:clip => clip, revive:structuredClone, voiceIO});
  state.create('门店');
  const snapshot = () => ({shots, subprojects:state.pack()});
  const history = createEditHistory(snapshot());
  [shots[0][0], shots[1][0]] = [shots[1][0], shots[0][0]];
  history.record(snapshot());

  const restored = history.undo();
  shots.splice(0, shots.length, ...restored.shots);
  state.restore(restored.subprojects);
  assert.equal(history.record(snapshot()), false);
  assert.deepEqual(state.pack().projects[0].voice.segments, []);
  assert.deepEqual(history.redo().shots, [[{id:'blue'}], [{id:'red'}]]);
});

test('inserting a shot splits legacy reserved gaps and rebases inactive project versions atomically', () => {
  const shots=[[{id:'A',videoGaps:[{start:2.5,span:1}]}],[{id:'B',videoStart:3}]];
  const state=createSubprojects({shots,serialize:clip=>clip,revive:structuredClone});
  state.create('另一版');
  const project=state.active.id;
  shots[1][0].id='C';
  shots[1][0].videoStart=2.75;
  state.select(null);
  const move=()=>state.rebaseVideoTimes(shots,[0,3,6],[0,6,9],[3,3],3,6);
  assert.equal(move(),false,'inactive project has a clip crossing the cut');
  assert.deepEqual(shots[0][0].videoGaps,[{start:2.5,span:1}]);
  assert.equal(shots[1][0].videoStart,3);
  state.select(project);
  shots[1][0].videoStart=3.25;
  assert.equal(move(),true);
  shots.splice(1,0,[]);
  const partialGaps=[{start:2.5,span:.5},{start:6,span:.5}];
  assert.deepEqual(shots[0][0].videoGaps,partialGaps);
  assert.equal(shots[2][0].videoStart,6.25);
  state.select(null);
  assert.deepEqual(shots[0][0].videoGaps,partialGaps);
  assert.equal(shots[2][0].videoStart,6);
  state.select(project);
  assert.equal(shots[2][0].videoStart,6.25);
});

test('shot-bound pictures retain local offsets in every project while absolute placements stay fixed', () => {
  const first=[{id:'local',videoStart:.25,videoFollowsShot:true},
    {id:'free',videoStart:.5,videoGaps:[{start:.8,span:.2}]},
    {id:'early-free',videoStart:1.75,autoFitSpeed:true}];
  const second=[{id:'early-bound',videoStart:1.2,autoFitSpeed:true}];
  const shots=[first,second];
  const state=createSubprojects({shots,serialize:clip=>clip,revive:structuredClone});
  state.create('替代素材');
  const alternate=state.active.id;
  first[0].videoStart=.4;
  const original={starts:[0,1],widths:[1,2]}, swapped={starts:[0,2],widths:[2,1]};
  shots.reverse();
  state.reorderVideoPlacements([first,second],original,swapped);
  assert.deepEqual(first.map(c=>c.videoStart),[2.4,.5,1.75]);
  assert.deepEqual(first[1].videoGaps,[{start:.8,span:.2}]);
  assert.equal(second[0].videoFollowsShot,true);
  assert.equal(first[2].videoFollowsShot,false);
  state.select(null);
  assert.equal(first[0].videoStart,2.25);
  shots.reverse();
  state.reorderVideoPlacements([second,first],swapped,original);
  assert.deepEqual(first.map(c=>c.videoStart),[.25,.5,1.75]);
  state.select(alternate);
  assert.ok(Math.abs(first[0].videoStart-.4)<1e-9);
  assert.ok(Math.abs(second[0].videoStart-1.2)<1e-9);
});

test('a fixed slot collision in a subproject cancels all placement changes', () => {
  const first=[{videoLane:0,videoStart:0,videoFollowsShot:true}], second=[];
  const shots=[first,second];
  const state=createSubprojects({shots,serialize:clip=>clip,revive:structuredClone});
  state.create('含固定视频的版本');
  first.push({videoLane:0,videoStart:1});
  state.select(null);
  shots.reverse();
  const moved=state.reorderVideoPlacements([first,second],
    {starts:[0,1],widths:[1,1]},{starts:[0,1],widths:[1,1]});
  assert.equal(moved,false);
  assert.equal(first[0].videoStart,0);
});

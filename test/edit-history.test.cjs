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

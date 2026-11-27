'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {sorted, nearest, placement} = require('../src/ui/timeline-edit-controls.js');

test('pixel threshold includes its edge, resolves ties to the earlier anchor and skips distant anchors', () => {
  const anchors = sorted([2,1,2,Infinity,NaN]);
  assert.deepEqual(anchors,[1,2]);
  assert.equal(nearest(anchors,1.5,.5),1);
  assert.equal(nearest(anchors,1.5,.49),undefined);
  assert.equal(nearest([],1,.1),undefined);
});

test('moving onto an interior marker preserves the entire source slot when either edge fits', () => {
  const markers = [1.25,3.75];
  assert.deepEqual(placement(markers,0,4,1.5,1.28,.05),{start:1.25,span:1.5,guide:1.25});
  assert.deepEqual(placement(markers,0,4,1.5,2.22,.05),{start:2.25,span:1.5,guide:3.75});
  assert.equal(placement(markers,0,4,1.5,3.73,.05),undefined);
  assert.equal(placement(markers,1,1,1.5,1.26,.05),undefined);
});

test('snapping to slot boundaries retains existing fill or swap semantics', () => {
  assert.deepEqual(placement([1,4],1,3,1.5,1.02,.05),{start:1,span:3,guide:1});
  assert.deepEqual(placement([1,4],1,3,1.5,2.47,.05),{start:1,span:3,guide:4});
});

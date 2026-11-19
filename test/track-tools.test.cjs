'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
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

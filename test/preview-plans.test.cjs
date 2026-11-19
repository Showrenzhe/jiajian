'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPreviewBatch, selectPreviewPlans } = require('../src/preview-plans.cjs');

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

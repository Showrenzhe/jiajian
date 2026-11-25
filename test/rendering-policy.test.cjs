'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRenderingPolicy } = require('../src/rendering-policy.cjs');

test('legacy rendering choice survives upgrades and two GPU exits enable software on next launch', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-rendering-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'performance.json'), JSON.stringify({ gpu: false }));
  const legacy = createRenderingPolicy(dir);
  assert.equal(legacy.active, true);
  legacy.set(false);
  let time = 0;
  const policy = createRenderingPolicy(dir, () => time);
  const crash = () => policy.processGone({ type: 'GPU', reason: 'crashed' });
  assert.equal(policy.active, false);
  crash();
  time += 61000;
  crash();
  policy.processGone({ type: 'GPU', reason: 'clean-exit' });
  assert.equal(policy.software, false);
  time += 3000;
  crash();
  assert.equal(policy.active, false);
  assert.equal(policy.software, true);
  const next = createRenderingPolicy(dir);
  assert.equal(next.active, true);
  assert.equal(next.consumeNotice(), true);
  assert.equal(createRenderingPolicy(dir).consumeNotice(), false);
});

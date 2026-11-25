'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { createDiagnostics, logToolFailure } = require('../src/diagnostics.cjs');

test('media and process diagnostics store only recognized fields, flags and error classifications', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-diagnostics-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const diagnostics = createDiagnostics(dir);
  const privateText = 'private-example-value';
  logToolFailure(
    path.join(dir, 'ffmpeg.exe'),
    ['-i', path.join(dir, privateText), '-f', 'mp4'],
    privateText + ' Permission denied',
    1,
  );
  diagnostics.processExit('GPU', { reason: 'crashed', exitCode: 8 });
  diagnostics.processExit('Renderer', { reason: 'oom', exitCode: 9 });
  const report = await diagnostics.snapshot({
    getVersion: () => '1',
    getGPUInfo: async () => ({ gpuDevice: [{ vendorId: 1, deviceId: 2, privateText }] }),
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
  });
  assert.equal(report.events.length, 3);
  assert.deepEqual(report.events[0].stderr, ['Permission denied']);
  assert.deepEqual(report.events[0].flags, ['-i', '-f']);
  assert.deepEqual(
    report.events.slice(1).map((row) => row.reason),
    ['crashed', 'oom'],
  );
  assert.equal(JSON.stringify(report).includes(privateText), false);
  const log = await fs.readFile(path.join(dir, 'diagnostics.jsonl'), 'utf8');
  assert.equal(log.includes(privateText), false);
  assert.equal(log.includes(os.tmpdir().split(path.sep).at(-1)), false);
});

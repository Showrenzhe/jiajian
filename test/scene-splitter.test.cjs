'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { splitVideos, detectSceneCuts } = require('../src/scene-splitter.cjs');

const execFileAsync = promisify(execFile);
const { mediaTool } = require('../src/media-tool.cjs');
const ffmpeg = mediaTool('ffmpeg');

test('splits a video into content scenes with the bundled PySceneDetect engine', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-scene-split-'));
  const input = path.join(root, '三色测试.mp4');
  const output = path.join(root, '输出');
  await execFileAsync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
  ]);
  const [result] = await splitVideos([input], {
    outputDirectory: output,
    detector: 'content',
    threshold: 10,
    minSceneSeconds: 0.2,
  });
  assert.equal(result.scenes.length, 3);
  assert.equal(result.files.length, 3);
  for (const file of result.files) {
    assert.equal((await fs.stat(file)).isFile(), true);
  }
  assert.ok((await fs.stat(result.csv)).isFile());
  const cuts = await detectSceneCuts(input, { detector: 'content', threshold: 10, minSceneSeconds: 0.2 });
  assert.deepEqual(cuts, [1, 2], '编辑轨道识别返回原片时间，不输出转码片段');
  await fs.rm(root, { recursive: true, force: true });
});


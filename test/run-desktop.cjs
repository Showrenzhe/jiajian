'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const goldenFrames = 'golden-frames-desktop.cjs';
const smoke = [
  'desktop.cjs',
  'draft-delete-desktop.cjs',
  'cut-shortcuts-desktop.cjs',
  'command-palette-desktop.cjs',
  'timeline-edit-controls-desktop.cjs',
  'narration-trim-desktop.cjs',
  'music-mix-desktop.cjs',
  'seed-batch-desktop.cjs',
  'software-update-desktop.cjs',
  goldenFrames,
];

async function run() {
  const all = (await fs.readdir(__dirname))
    .filter((name) => name !== path.basename(__filename) && (name === 'desktop.cjs' || name.endsWith('-desktop.cjs')))
    .sort();
  const isSmoke = process.argv.includes('--smoke');
  const names = isSmoke ? smoke : all;
  const tempDirectory = await fs.realpath(os.tmpdir());
  const parent = path.resolve(process.env.JIAJIAN_TEST_ARTIFACTS || 'run-data/test-artifacts');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'desktop-'));
  const result = [];
  for (const name of names) {
    const log = await fs.open(path.join(root, name + '.log'), 'w');
    const env = {
      ...process.env,
      ...(process.platform === 'win32' ? { TEMP: tempDirectory, TMP: tempDirectory } : {}),
      JIAJIAN_DESKTOP_SCENARIO: name,
      JIAJIAN_GOLDEN_SMOKE: isSmoke && name === goldenFrames ? '1' : '0',
      JIAJIAN_TEST_SCREENSHOT: path.join(root, name + '.png'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let scenarioTemp;
    let status;
    try {
      if (name === goldenFrames) {
        scenarioTemp = await fs.mkdtemp(path.join(tempDirectory, 'jiajian-golden-'));
        Object.assign(env, {
          JIAJIAN_GOLDEN_ROOT: scenarioTemp,
          TEMP: scenarioTemp,
          TMP: scenarioTemp,
          TMPDIR: scenarioTemp,
        });
      } else if (name === 'narration-trim-desktop.cjs') {
        scenarioTemp = await fs.mkdtemp(path.join(tempDirectory, 'jiajian-trim-'));
        Object.assign(env, {JIAJIAN_NARRATION_TEST_ROOT:scenarioTemp, TEMP:scenarioTemp, TMP:scenarioTemp, TMPDIR:scenarioTemp});
      } else if (name === 'music-mix-desktop.cjs') {
        scenarioTemp = await fs.mkdtemp(path.join(tempDirectory, 'jiajian-mix-'));
        Object.assign(env, {JIAJIAN_MUSIC_TEST_ROOT:scenarioTemp, TEMP:scenarioTemp, TMP:scenarioTemp, TMPDIR:scenarioTemp});
      } else if (name === 'seed-batch-desktop.cjs') {
        scenarioTemp = await fs.mkdtemp(path.join(tempDirectory, 'jiajian-seed-'));
        Object.assign(env, { JIAJIAN_BATCH_SEED_TEST_ROOT: scenarioTemp, TEMP: scenarioTemp, TMP: scenarioTemp, TMPDIR: scenarioTemp });
      } else if (name === 'timeline-edit-controls-desktop.cjs') {
        scenarioTemp = await fs.mkdtemp(path.join(tempDirectory, 'jiajian-timeline-edits-'));
        env.JIAJIAN_TIMELINE_TEST_ROOT = scenarioTemp;
      } else if (name === 'interaction-frames-desktop.cjs') {
        scenarioTemp = await fs.mkdtemp(path.join(tempDirectory, 'jiajian-bench-'));
        env.JIAJIAN_FRAME_BENCH_ROOT = scenarioTemp;
      }
      status = await new Promise((resolve) => {
        const child = spawn(require('electron'), [path.join(__dirname, 'desktop-scenario.cjs')], {
          env,
          stdio: ['ignore', log.fd, log.fd],
          windowsHide: true,
        });
        child.once('error', () => resolve(1));
        child.once('close', (code) => resolve(code ?? 1));
      });
    } finally {
      await log.close();
      if (scenarioTemp) await fs.rm(scenarioTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
    result.push({ name, status });
    console.log(status ? '失败' : '通过', name);
  }
  console.table(result);
  console.log('日志与失败截图', root);
  process.exitCode = result.some((row) => row.status) ? 1 : 0;
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

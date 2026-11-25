'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const smoke = ['desktop.cjs', 'draft-delete-desktop.cjs', 'cut-shortcuts-desktop.cjs', 'software-update-desktop.cjs'];

async function run() {
  const all = (await fs.readdir(__dirname))
    .filter((name) => name !== path.basename(__filename) && (name === 'desktop.cjs' || name.endsWith('-desktop.cjs')))
    .sort();
  const names = process.argv.includes('--smoke') ? smoke : all;
  const parent = path.resolve(process.env.JIAJIAN_TEST_ARTIFACTS || 'run-data/test-artifacts');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'desktop-'));
  const result = [];
  for (const name of names) {
    const log = await fs.open(path.join(root, name + '.log'), 'w');
    const env = {
      ...process.env,
      JIAJIAN_DESKTOP_SCENARIO: name,
      JIAJIAN_TEST_SCREENSHOT: path.join(root, name + '.png'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const bench =
      name === 'interaction-frames-desktop.cjs' ? await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-bench-')) : null;
    if (bench) env.JIAJIAN_FRAME_BENCH_ROOT = bench;
    let status;
    try {
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
      if (bench) await fs.rm(bench, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
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

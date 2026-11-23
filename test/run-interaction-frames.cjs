'use strict';

const { spawnSync } = require('node:child_process');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Chromium holds profile files open until Electron exits on Windows.
const temporary = realpathSync(os.tmpdir());
const root = mkdtempSync(path.join(temporary, 'jiajian-interaction-frames-'));
try {
  const env = { ...process.env, JIAJIAN_FRAME_BENCH_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [
    path.join(__dirname, 'interaction-frames-desktop.cjs'), ...process.argv.slice(2),
  ], { stdio: 'inherit', env });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  const target = realpathSync(root);
  if (target !== root || path.dirname(target) !== temporary) throw Error('临时工程路径发生变化 ' + root);
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tools = ['ffmpeg', 'ffprobe'];
const readInChild = `
  const { mediaTool } = require(process.argv[1]);
  const get = tool => mediaTool(tool, process.argv[2] || undefined);
  get('ffmpeg');
  get('ffprobe');
  console.log(JSON.stringify([get('ffmpeg'), get('ffprobe')]));
`;

async function fixture(t) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-media-tool-'));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  const module = path.join(source, 'src', 'media-tool.cjs');
  await fs.mkdir(path.dirname(module));
  await fs.copyFile(require.resolve('../src/media-tool.cjs'), module);
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (/^(JIAJIAN|SUPERDIR_REPLICA)_FF(MPEG|PROBE)$/i.test(key)) delete cleanEnv[key];
  }
  function read(env = {}, resources = '') {
    const result = spawnSync(process.execPath, ['-e', readInChild, module, resources], {
      env: { ...cleanEnv, ...env }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return { paths: JSON.parse(result.stdout), warning: result.stderr.trim() };
  }
  return { source, read };
}

function bundledPaths(root) {
  return tools.map(tool => path.join(root, 'tools', 'ffmpeg-8.0-full_build', 'bin', process.platform === 'win32' ? tool + '.exe' : tool));
}

test('安装版使用 resources，源码按工具选择仓库二进制或 PATH', async t => {
  const { source, read } = await fixture(t);
  assert.deepEqual(read(), { paths: tools, warning: '' });
  const binaries = bundledPaths(source);
  await fs.mkdir(path.dirname(binaries[0]), { recursive: true });
  await fs.writeFile(binaries[0], '');
  assert.deepEqual(read(), { paths: [binaries[0], 'ffprobe'], warning: '' });
  await fs.writeFile(binaries[1], '');
  assert.deepEqual(read(), { paths: binaries, warning: '' });
  const resources = path.join(source, 'resources');
  assert.deepEqual(read({}, resources), { paths: bundledPaths(resources), warning: '' });
});

test('新旧变量逐工具选择，仅实际使用旧变量时每个进程提示一次', async t => {
  const { source, read } = await fixture(t);
  const resources = path.join(source, 'resources');
  const current = { JIAJIAN_FFMPEG: 'current-mpeg', JIAJIAN_FFPROBE: 'current-probe' };
  const legacy = { SUPERDIR_REPLICA_FFMPEG: 'old-mpeg', SUPERDIR_REPLICA_FFPROBE: 'old-probe' };
  const expected = { paths: ['current-mpeg', 'current-probe'], warning: '' };
  assert.deepEqual(read(current, resources), expected);
  assert.deepEqual(read({ ...legacy, ...current }, resources), expected);
  for (const [env, paths] of [
    [legacy, ['old-mpeg', 'old-probe']],
    [{ ...legacy, JIAJIAN_FFMPEG: 'current-mpeg' }, ['current-mpeg', 'old-probe']],
  ]) {
    const result = read(env, resources);
    assert.deepEqual(result.paths, paths);
    assert.equal(result.warning.split(/\r?\n/).length, 1);
    assert.match(result.warning, /已弃用，请改用 JIAJIAN_FFMPEG.*JIAJIAN_FFPROBE/);
    assert.doesNotMatch(result.warning, /old-mpeg|old-probe|current-mpeg/);
  }
});

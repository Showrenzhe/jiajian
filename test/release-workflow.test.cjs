'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { releaseNotes } = require('../scripts/release-notes.cjs');
const { verifyManifest } = require('../scripts/verify-release.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('generate notes from commits since the previous stable tag, or use the edited version', async (t) => {
  const root = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init');
  git('commit', '--allow-empty', '-m', '旧功能');
  git('tag', 'v1.0.0');
  git('commit', '--allow-empty', '-m', '修复导出字幕');
  git('tag', 'v1.0.1-beta.1');
  git('commit', '--allow-empty', '-m', '增加波形预览');
  git('tag', 'v1.0.1');
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.0.1"}');
  assert.equal(releaseNotes(root, 'v1.0.1'), '## 本次更新\n\n- 修复导出字幕\n- 增加波形预览\n');
  await fs.mkdir(path.join(root, 'release-notes'));
  await fs.writeFile(path.join(root, 'release-notes', 'v1.0.1.md'), '人工整理后的说明\n');
  assert.equal(releaseNotes(root, 'v1.0.1'), '人工整理后的说明\n');
  assert.throws(() => releaseNotes(root, 'v1.0.2'), /与 package.json 版本/);
});

test('publishing rejects stale notes, corrupted installers and missing update assets', async (t) => {
  const root = await fixture(t);
  const artifact = 'Jiajian-Setup-1.0.1-x64.exe';
  const content = Buffer.from('installer');
  const manifest = { version: '1.0.1', files: [{ url: artifact, size: content.length,
    sha512: createHash('sha512').update(content).digest('base64') }], releaseNotes: '新功能' };
  await fs.writeFile(path.join(root, 'latest.yml'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, artifact), content);
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /blockmap/);
  const blockmap = { version: '2', files: [{ offset: 0, sizes: [content.length], checksums: ['test'] }] };
  await fs.writeFile(path.join(root, artifact + '.blockmap'), gzipSync(JSON.stringify(blockmap)));
  await verifyManifest(root, '1.0.1', '新功能');
  blockmap.files[0].sizes = [content.length - 1];
  await fs.writeFile(path.join(root, artifact + '.blockmap'), gzipSync(JSON.stringify(blockmap)));
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /差分映射范围/);
  await assert.rejects(verifyManifest(root, '1.0.1', '旧说明'), /说明不一致/);
  await fs.writeFile(path.join(root, artifact), Buffer.alloc(content.length));
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /SHA-512/);
});

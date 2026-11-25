'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { gzipSync } = require('node:zlib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { releaseNotes } = require('../scripts/release-notes.cjs');
const { verifyManifest } = require('../scripts/verify-release.cjs');
const yaml = createRequire(require.resolve('electron-updater/package.json'))('js-yaml');

test('CI runs Windows checks and internal release builds only retain a private artifact', async () => {
  const workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/release-windows.yml'), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.jobs.release.if,'github.event.repository.private');
  assert.equal(workflow.permissions.contents,'read');
  const steps = workflow.jobs.release.steps;
  assert.equal(steps.find(step=>step.uses?.startsWith('actions/checkout@')).with.ref,'refs/tags/${{ inputs.tag }}');
  const commands=steps.map(step=>step.run??'').join('\n');
  assert.match(commands,/prepare-release-tools/);
  assert.match(commands,/verify-release/);
  assert.doesNotMatch(commands,/gh release|publish-release/);
  const ci=yaml.load(await fs.readFile(path.join(__dirname,'../.github/workflows/ci.yml'),'utf8'));
  assert.ok(Object.hasOwn(ci.on,'pull_request'));
  assert.deepEqual(ci.jobs.checks.steps.filter(s=>['npm ci','npm test','npm run test:smoke'].includes(s.run)).map(s=>s.run),
    ['npm ci','npm test','npm run test:smoke']);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('离线安装包检查 asar 版本且拒绝嵌入更新源，在线包检查通道', async t => {
  const root = await fixture(t);
  const source = path.join(root,'source');
  await fs.mkdir(source);
  const asar = require('@electron/asar');
  const archive = path.join(root,'app.asar');
  const {verifyUpdateMode} = require('../scripts/verify-release.cjs');
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({version:'1.0.0'}));
  await asar.createPackage(source,archive);
  await verifyUpdateMode(root,'1.0.0',null);
  const feed = 'https://updates.example.invalid/';
  await fs.writeFile(path.join(root,'app-update.yml'),JSON.stringify({provider:'generic',url:feed,channel:'preview'}));
  await assert.rejects(verifyUpdateMode(root,'1.0.0',null),/离线安装包/);
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({version:'1.0.1-preview.1',jiajianUpdateFeed:feed}));
  asar.uncache(archive);
  await asar.createPackage(source,archive);
  await verifyUpdateMode(root,'1.0.1-preview.1',feed);
});

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

test('internal staging verifies immutable installers and publishes the manifest last', async (t) => {
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
  const destination = path.join(root,'internal');
  const {stageUpdate} = require('../scripts/stage-update.cjs');
  await stageUpdate(root,destination,'1.0.1','新功能');
  await stageUpdate(root,destination,'1.0.1','新功能');
  await verifyManifest(destination,'1.0.1','新功能');
  blockmap.files[0].sizes = [content.length - 1];
  await fs.writeFile(path.join(root, artifact + '.blockmap'), gzipSync(JSON.stringify(blockmap)));
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /差分映射范围/);
  await assert.rejects(verifyManifest(root, '1.0.1', '旧说明'), /说明不一致/);
  await fs.writeFile(path.join(root, artifact), Buffer.alloc(content.length));
  await assert.rejects(verifyManifest(root, '1.0.1', '新功能'), /SHA-512/);
});

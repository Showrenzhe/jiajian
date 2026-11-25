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

test('标签触发 Windows 构建，安装包通过校验后发布到 GitHub 草稿', async () => {
  const workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/release-windows.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.tags, ['v*.*.*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.permissions.contents, 'write');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /inputs.tag .* github.ref_name/);
  const { steps, env } = workflow.jobs.release;
  assert.equal(env.RELEASE_TAG, '${{ inputs.tag || github.ref_name }}');
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'refs/tags/${{ env.RELEASE_TAG }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const commands = steps.map(step => step.run || '').join('\n');
  const sequence = ['merge-base --is-ancestor', 'npm ci', 'release-notes.cjs', 'prepare-release-tools.ps1',
    'npm test', 'npm run test:updates', './test/release-publish.test.ps1', 'npm run dist:win', 'verify-release.cjs', 'publish-release.ps1 -Tag'];
  let last = -1;
  for (const command of sequence) {
    const current = commands.indexOf(command);
    assert.ok(current > last, command);
    last = current;
  }
  assert.equal(steps.filter(step => step.env?.GH_TOKEN).length, 1);
  assert.equal(steps.at(-1).env.GH_TOKEN, '${{ github.token }}');
  const ci = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  const baseline = ci.jobs.benchmark.steps.find(step => step.id === 'baseline').run;
  assert.match(baseline, /actions\/runs["] -f branch=/);
  assert.match(baseline, /\.github\/workflows\/ci\.yml/);
  assert.match(baseline, /artifacts\.artifacts/);
  assert.deepEqual(ci.jobs.checks.steps.filter(s => ['npm ci', 'npm test', 'npm run test:smoke'].includes(s.run)).map(s => s.run),
    ['npm ci', 'npm test', 'npm run test:smoke']);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('安装包的版本、公开仓库和稳定或预览清单必须对应', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const asar = require('@electron/asar');
  const archive = path.join(root, 'app.asar');
  const { verifyUpdateMode } = require('../scripts/verify-release.cjs');
  const { releaseConfig } = require('../src/update-feed.cjs');
  for (const [version, channel, releaseType] of [
    ['1.0.0', 'latest', 'release'], ['1.0.1-preview.1', 'preview', 'prerelease'],
  ]) {
    const config = { provider: 'github', owner: 'Showrenzhe', repo: 'jiajian', channel, releaseType };
    assert.deepEqual(releaseConfig(version), config);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version }));
    asar.uncache(archive);
    await asar.createPackage(source, archive);
    const file = path.join(root, 'app-update.yml');
    await fs.writeFile(file, JSON.stringify({ ...config, updaterCacheDirName: 'jiajian-updater' }));
    await verifyUpdateMode(root, version);
    await fs.writeFile(file, JSON.stringify({ ...config, repo: 'wrong' }));
    await assert.rejects(verifyUpdateMode(root, version), /官方 GitHub/);
  }
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

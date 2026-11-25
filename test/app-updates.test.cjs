'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdates } = require('../src/app-updates.cjs');

const app = { isPackaged: true, getVersion: () => '0.6.3' };
const windows = process.platform === 'win32' && process.arch === 'x64';
function createTestUpdates(updater, options = {}) {
  updater.setFeedURL = config => { updater.feed = config; };
  return createAppUpdates({ app, updater, ...options });
}
const updateInfo = { files: [{url:'Jiajian-Setup-0.7.0-x64.exe'}], version: '0.7.0', tag: 'v0.7.0', releaseNotes: '## 更新说明\n<p>改善导出 &amp; 预览</p><ul><li>保留 `run-data` 草稿</li></ul>' };

test('source mode never contacts GitHub or installs an update', async () => {
  const service = createAppUpdates({ app: { ...app, isPackaged: false } });
  assert.equal(service.getState().canManageInstallation, false);
  assert.equal((await service.check()).status, 'unsupported');
  assert.equal((await service.download()).status, 'unsupported');
  assert.equal(service.install().status, 'unsupported');
});

test('stable release is only downloaded and installed on separate explicit requests', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  const pendingCheck = Promise.withResolvers();
  const pendingDownload = Promise.withResolvers();
  let checks = 0;
  let downloads = 0;
  let installs = 0;
  updater.checkForUpdates = () => { checks++; return pendingCheck.promise; };
  updater.downloadUpdate = () => { downloads++; return pendingDownload.promise; };
  updater.quitAndInstall = () => { installs++; };
  const service = createTestUpdates(updater);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(service.install().status, 'idle');
  const checking = service.check();
  assert.equal((await service.check()).status, 'checking');
  assert.equal(checks, 1);
  pendingCheck.resolve({ isUpdateAvailable: true, updateInfo });
  const offer = await checking;
  assert.equal(offer.status, 'available');
  assert.equal(offer.notes, '更新说明\n改善导出 & 预览\n• 保留 run-data 草稿');
  assert.equal(downloads, 0);
  const downloading = service.download();
  assert.equal((await service.download()).status, 'downloading');
  assert.equal((await service.check()).status, 'downloading');
  assert.equal(downloads, 1);
  updater.emit('download-progress', { percent: 62.5 });
  assert.equal(service.getState().percent, 62);
  assert.equal(service.install().status, 'downloading');
  pendingDownload.resolve(['verified-installer.exe']);
  assert.equal((await downloading).status, 'downloaded');
  assert.equal(installs, 0);
  assert.equal(service.install().status, 'installing');
  service.install();
  assert.equal(installs, 1);
});

test('failed downloads and installer launches can retry without losing version notes', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo });
  updater.downloadUpdate = async () => { throw new Error('hash mismatch'); };
  updater.quitAndInstall = () => updater.emit('error', new Error('failed to start'));
  const service = createTestUpdates(updater);
  await service.check();
  const failed = await service.download();
  assert.equal(failed.status, 'error');
  assert.equal(failed.retry, 'download');
  assert.equal(failed.version, '0.7.0');
  assert.equal(service.install().status, 'error');
  updater.downloadUpdate = async () => ['verified-installer.exe'];
  assert.equal((await service.download()).status, 'downloaded');
  assert.equal(service.install().retry, 'install');
  updater.quitAndInstall = () => {};
  assert.equal(service.install().status, 'installing');
});

test('missing GitHub manifests offer a manual download route', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { throw Object.assign(Error('missing'), {code:'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'}); };
  const service = createTestUpdates(updater);
  assert.match((await service.check()).message, /清单/);
  assert.deepEqual(updater.feed, { provider: 'github', owner: 'Showrenzhe', repo: 'jiajian' });
});

test('channel and frequency persist, and switching removes offers from the previous channel', { skip: !windows }, async t => {
  const fs = require('node:fs/promises'), path = require('node:path');
  const dataDirectory = await fs.mkdtemp(path.join(require('node:os').tmpdir(),'jj-update-'));
  t.after(() => fs.rm(dataDirectory,{recursive:true,force:true}));
  const updater = new EventEmitter();
  const service = createTestUpdates(updater,{dataDirectory});
  const preview = '0.7.0-preview.2';
  updater.checkForUpdates = async () => ({isUpdateAvailable:true,updateInfo:{version:preview,tag:'v'+preview,files:[{url:'Jiajian-Setup-'+preview+'-x64.exe'}]}});
  assert.equal((await service.check()).status,'error');
  service.setPreferences({channel:'preview', intervalHours:0});
  assert.equal(updater.channel,'preview');
  assert.equal((await service.check()).status,'available');
  const next = createTestUpdates(new EventEmitter(),{dataDirectory});
  assert.equal(next.getState().intervalHours,0);
  assert.equal(next.getState().channel,'preview');
  service.setPreferences({channel:'stable',intervalHours:24});
  assert.equal(service.getState().version,'');
  assert.equal((await service.download()).status,'idle');
  assert.equal(updater.channel,'latest');
  assert.throws(()=>service.setPreferences({channel:'other',intervalHours:24}));
});

test('a manifest cannot offer a prerelease, mismatched tag, or downgrade', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  const service = createTestUpdates(updater);
  for (const [version, tag] of [['0.7.0-beta.1', 'v0.7.0-beta.1'], ['0.7.0', 'v0.8.0'], ['0.7.0', undefined], ['0.6.2', 'v0.6.2']]) {
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version, tag, files: [{url: 'Jiajian-Setup-'+version+'-x64.exe'}] } });
    assert.equal((await service.check()).retry, 'check');
    assert.equal((await service.download()).status, 'error');
  }
});

test('rechecks retain the verified offer until a successful check confirms it is gone', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  const service = createTestUpdates(updater);
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await service.check()).version, '', 'A first network error has no verified offer');

  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo });
  const offer = await service.check();
  assert.equal(offer.status, 'available');
  const network = Promise.withResolvers();
  updater.checkForUpdates = () => network.promise;
  const recheck = service.check();
  assert.equal(service.getState().status, 'checking');
  assert.equal(service.getState().version, offer.version);
  network.reject(new Error('offline'));
  const offline = await recheck;
  assert.equal(offline.retry, 'check');
  assert.equal(offline.version, offer.version);
  assert.equal(offline.notes, offer.notes);

  updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  const current = await service.check();
  assert.equal(current.status, 'current');
  assert.equal(current.version, '');
  assert.equal(current.notes, '');
});

test('GitHub provider resolves stable and preview tags to their published manifests and installers', async () => {
  const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
  const { githubRepository } = require('../src/update-feed.cjs');
  const base = '/Showrenzhe/jiajian/releases';
  const stable = '0.9.0';
  const preview = '0.9.1-preview.1';
  const versions = [preview, stable];
  const atom = '<feed>' + versions.map(v =>
    '<entry><title>' + v + '</title><link href="https://github.com' + base + '/tag/v' + v + '"/></entry>'
  ).join('') + '</feed>';
  for (const [channel, target] of [['latest', stable], ['preview', preview]]) {
    const requests = [];
    const artifact = 'Jiajian-Setup-' + target + '-x64.exe';
    const downloadPath = base + '/download/v' + target + '/';
    const executor = { async request({ protocol, hostname, path }) {
      assert.equal(protocol, 'https:');
      assert.equal(hostname, 'github.com');
      requests.push(path);
      if (path === base + '.atom') return atom;
      if (path === base + '/latest') return JSON.stringify({ tag_name: 'v' + stable });
      assert.equal(path, downloadPath + channel + '.yml');
      return JSON.stringify({ version: target, files: [{ url: artifact, sha512: 'fixture' }], releaseNotes: '更新说明' });
    } };
    const updater = { currentVersion: require('semver').parse('0.8.9'), channel, allowPrerelease: channel === 'preview' };
    const provider = new GitHubProvider(githubRepository, updater, { platform: 'win32', executor });
    const info = await provider.getLatestVersion();
    assert.equal(info.tag, 'v' + target);
    assert.equal(info.version, target);
    assert.equal(provider.resolveFiles(info)[0].url.href, 'https://github.com' + downloadPath + artifact);
    assert.equal(requests.includes(base + '/latest'), channel === 'latest');
  }
});

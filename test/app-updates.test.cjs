'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdates } = require('../src/app-updates.cjs');

const app = { isPackaged: true, getVersion: () => '0.6.3' };
const windows = process.platform === 'win32' && process.arch === 'x64';
const updateInfo = { version: '0.7.0', tag: 'v0.7.0', releaseNotes: '## 更新说明\n<p>改善导出 &amp; 预览</p><ul><li>保留 `run-data` 草稿</li></ul>' };

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
  const service = createAppUpdates({ app, updater });
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
  const service = createAppUpdates({ app, updater });
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

test('legacy ZIP-only releases, missing new manifests, and offline errors stay distinct', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  let tag = 'v0.6.2';
  updater.checkForUpdates = async () => {
    const message = 'Cannot find latest.yml in the latest release artifacts (https://github.com/Showrenzhe/jiajian/releases/download/' + tag + '/latest.yml): 404';
    throw Object.assign(new Error(message), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
  };
  const service = createAppUpdates({ app, updater });
  assert.equal((await service.check()).status, 'current');
  tag = 'v0.10.0';
  const missing = await service.check();
  assert.equal(missing.status, 'error');
  assert.match(missing.message, /清单/);
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.match((await service.check()).message, /网络/);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo });
  assert.equal((await service.check()).status, 'current');
});

test('a manifest cannot offer a prerelease, mismatched tag, or downgrade', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  const service = createAppUpdates({ app, updater });
  for (const [version, tag] of [['0.7.0-beta.1', 'v0.7.0-beta.1'], ['0.7.0', 'v0.8.0'], ['0.6.2', 'v0.6.2']]) {
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version, tag } });
    assert.equal((await service.check()).retry, 'check');
    assert.equal((await service.download()).status, 'error');
  }
});

test('rechecks retain the verified offer until a successful check confirms it is gone', { skip: !windows }, async () => {
  const updater = new EventEmitter();
  const service = createAppUpdates({ app, updater });
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

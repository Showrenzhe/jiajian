'use strict';

const { existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const { githubRepository } = require('./update-feed.cjs');
const path = require('node:path');

// GitHub release notes may contain Markdown or HTML. Display plain text.
function releaseNotes(value) {
  const body = Array.isArray(value) ? value.map(entry => entry?.note).filter(Boolean).join('\n\n') : value;
  if (typeof body !== 'string') return '';
  return body.slice(0, 65536)
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>\n]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
    })[entity])
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/`([^`\r\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const failureMessages = {
  check: '无法获取 GitHub 版本信息。请检查网络后重试。',
  download: '下载或校验更新包失败。请检查网络和磁盘空间后重试。',
  install: '无法启动更新安装程序。请重试或前往 GitHub 发布页下载安装包。',
};

function createAppUpdates({ app, onState = () => {}, updater, dataDirectory }) {
  const preferencesFile = dataDirectory && path.join(dataDirectory, 'update-preferences.json');
  const validPreferences = value => value && ['stable','preview'].includes(value.channel)
    && [0,24,72,168].includes(value.intervalHours);
  let preferences = { channel:'stable', intervalHours:24 };
  if (preferencesFile && existsSync(preferencesFile)) {
    try {
      const saved = JSON.parse(readFileSync(preferencesFile, 'utf8'));
      if (validPreferences(saved)) preferences = { channel:saved.channel, intervalHours:saved.intervalHours };
    } catch { /* Use stable defaults after an interrupted or invalid settings file. */ }
  }
  const supported = app.isPackaged && process.platform === 'win32' && process.arch === 'x64';
  let state = {
    status: supported ? 'idle' : 'unsupported', ...preferences, currentVersion: app.getVersion(),
    canManageInstallation: supported && existsSync(path.join(path.dirname(process.execPath), 'Uninstall ' + path.basename(process.execPath))),
    version: '', notes: '', percent: 0, retry: null,
    message: supported ? '' : '自动更新适用于 Windows x64 安装版。可从佳剪的 GitHub 发布页获取安装程序。',
  };
  const getState = () => ({ ...state });
  function setState(status, changes = {}) {
    state = { ...state, status, message: '', retry: null, ...changes };
    onState(getState());
    return getState();
  }
  function fail(action, error, message = failureMessages[action]) {
    console.warn('佳剪更新失败', action, error?.code || error?.name || 'Error');
    return setState('error', { message, retry: action });
  }
  let semver;
  if (supported) {
    // Existing offline launchers can run a source checkout using their own
    // Electron runtime, without the installer's npm dependencies.
    semver = require('semver');
    updater ??= require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.setFeedURL({ ...githubRepository });
    selectChannel(preferences.channel);
    updater.disableWebInstaller = true;
    updater.on('download-progress', ({ percent }) => {
      if (state.status === 'downloading' && Number.isFinite(percent)) {
        const progress = Math.max(0, Math.min(100, Math.floor(percent)));
        if (state.percent !== progress) setState('downloading', { percent: progress });
      }
    });
    // Check/download errors also reject their awaited promises. An installer
    // start error, however, can arrive only as an EventEmitter notification.
    updater.on('error', error => {
      if (state.status === 'installing') fail('install', error);
    });
  }
  function selectChannel(channel) {
    // GitHub selects the Atom entry from updater.channel and the prerelease tag prefix.
    updater.channel = channel === 'preview' ? 'preview' : 'latest';
    updater.allowPrerelease = channel === 'preview';
    // electron-updater enables downgrades as a side effect of setting channel.
    updater.allowDowngrade = false;
  }
  function mayRetry(action) {
    return state.status === 'error' && state.retry === action;
  }
  function markCurrent() {
    return setState('current', { version: '', notes: '', percent: 0 });
  }
  async function check() {
    if (!['idle', 'current', 'available'].includes(state.status) && !mayRetry('check')) return getState();
    // Keep the last verified offer visible until the feed confirms a change.
    setState('checking');
    try {
      const result = await updater.checkForUpdates();
      if (!result) throw new Error('Update checks disabled');
      if (!result.isUpdateAvailable) return markCurrent();
      const { version, releaseNotes: notes } = result.updateInfo;
      // Only the selected channel's versioned installer can be downloaded.
      if (!semver.valid(version) || (state.channel === 'stable' && semver.prerelease(version)) || !semver.gt(version, state.currentVersion)
          || result.updateInfo.tag !== 'v' + version
          || result.updateInfo.files?.length !== 1 || result.updateInfo.files[0].url !== `Jiajian-Setup-${version}-x64.exe`) {
        throw new Error('Invalid GitHub release metadata');
      }
      return setState('available', { version, notes: releaseNotes(notes) });
    } catch (error) {
      if (state.channel === 'preview' && error?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') return markCurrent();
      if (error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
        // Early official releases offered only a ZIP and never published latest.yml.
        const tag = /^Cannot find latest\.yml in the latest release artifacts \(https:\/\/github\.com\/Showrenzhe\/jiajian\/releases\/download\/v(\d+\.\d+\.\d+)\/latest\.yml\)/i.exec(error.message)?.[1];
        if (state.channel === 'stable' && semver.valid(tag) && semver.lte(tag, state.currentVersion)) return markCurrent();
        return fail('check', error, '该 GitHub 版本缺少更新清单，请前往佳剪发布页查看安装包。');
      }
      return fail('check', error);
    }
  }
  async function download() {
    if (state.status !== 'available' && !mayRetry('download')) return getState();
    setState('downloading', { percent: 0 });
    try {
      await updater.downloadUpdate();
      return setState('downloaded', { percent: 100 });
    } catch (error) {
      return fail('download', error);
    }
  }
  function install() {
    if (state.status !== 'downloaded' && !mayRetry('install')) return getState();
    setState('installing');
    try {
      updater.quitAndInstall(false, true);
      return getState();
    } catch (error) {
      return fail('install', error);
    }
  }
  function setPreferences(value) {
    if (!validPreferences(value)) throw Error('更新设置无效。');
    if (['checking','downloading','installing'].includes(state.status)) throw Error('请等待当前更新操作完成。');
    const next = { channel:value.channel, intervalHours:value.intervalHours };
    if (preferencesFile) {
      writeFileSync(preferencesFile + '.tmp', JSON.stringify(next), 'utf8');
      renameSync(preferencesFile + '.tmp', preferencesFile);
    }
    const switched = preferences.channel !== next.channel;
    preferences = next;
    if (switched && supported) {
      selectChannel(next.channel);
      return setState('idle', { ...next, version:'', notes:'', percent:0 });
    }
    state = { ...state, ...next };
    onState(getState());
    return getState();
  }
  return { getState, check, download, install, setPreferences };
}

module.exports = { createAppUpdates };

'use strict';

// GitHub's Atom fallback supplies HTML. The release pipeline also embeds the
// original release notes as text in latest.yml. Send plain text to the window.
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
  check: '无法获取 GitHub 正式版信息。请检查网络后重试。',
  download: '下载或校验更新包失败。请检查网络和磁盘空间后重试。',
  install: '无法启动更新安装程序。请重试或前往正式版下载页。',
};

function createAppUpdates({ app, onState = () => {}, updater }) {
  const supported = app.isPackaged && process.platform === 'win32' && process.arch === 'x64';
  let state = {
    status: supported ? 'idle' : 'unsupported', currentVersion: app.getVersion(),
    version: '', notes: '', percent: 0, retry: null,
    message: supported ? '' : '自动更新适用于 Windows x64 安装版。请到 GitHub 正式版下载页获取安装程序。',
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
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
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
  function mayRetry(action) {
    return state.status === 'error' && state.retry === action;
  }
  async function check() {
    if (!['idle', 'current', 'available'].includes(state.status) && !mayRetry('check')) return getState();
    setState('checking', { version: '', notes: '', percent: 0 });
    try {
      const result = await updater.checkForUpdates();
      if (!result) throw new Error('Update checks disabled');
      if (!result.isUpdateAvailable) return setState('current');
      const { version, releaseNotes: notes } = result.updateInfo;
      // Only accept the matching stable tag from the configured GitHub feed.
      if (!semver.valid(version) || semver.prerelease(version) || !semver.gt(version, state.currentVersion)
          || result.updateInfo.tag !== 'v' + version) {
        throw new Error('Invalid stable release metadata');
      }
      return setState('available', { version, notes: releaseNotes(notes) });
    } catch (error) {
      // Older ZIP-only releases predate latest.yml. Only treat a missing
      // manifest as current when the GitHub provider identified its stable tag.
      if (error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
        const tag = /^Cannot find latest\.yml in the latest release artifacts \(https:\/\/github\.com\/Showrenzhe\/jiajian\/releases\/download\/v(\d+\.\d+\.\d+)\/latest\.yml\)/i.exec(error.message)?.[1];
        if (semver.valid(tag) && semver.lte(tag, state.currentVersion)) return setState('current');
        return fail('check', error, '该正式版尚未提供自动更新清单，请前往 GitHub 正式版下载页。');
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
  return { getState, check, download, install };
}

module.exports = { createAppUpdates };

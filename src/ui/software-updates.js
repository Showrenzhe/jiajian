'use strict';

window.bindSoftwareUpdates = (api) => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('update-dialog');
  const entry = $('software-update-entry');
  const notice = $('update-notice');
  const dismiss = $('update-notice-dismiss');
  const action = $('update-action');
  const error = $('update-error');
  let state;
  let received = 0;
  let dismissed;
  let submitting = false;

  function showError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  function render() {
    const { status = 'idle', currentVersion, version, notes, percent, message, retry } = state || {};
    if (currentVersion) {
      $('app-version').textContent = currentVersion;
      $('app-version').parentElement.title = '佳剪 v' + currentVersion;
    }
    $('update-version').textContent = currentVersion ? '当前版本 ' + currentVersion : '';
    const descriptions = {
      idle: '检查是否有新版本。', checking: '正在检查更新…', current: '已是最新版本。',
      available: '发现新版本 ' + version, downloading: '正在下载 ' + version,
      downloaded: '版本 ' + version + ' 已下载，可以保存草稿并重启。', installing: '正在启动安装程序…',
      unsupported: '本版本使用源码或便携包运行。请到官方发布页获取 Windows 安装版，之后可在佳剪内更新。',
      error: '更新失败，请重试。',
    };
    const progress = $('update-progress');
    const knownPercent = Number.isFinite(percent);
    progress.hidden = status !== 'downloading';
    if (knownPercent) progress.value = Math.min(100, Math.max(0, percent));
    else progress.removeAttribute('value');
    $('update-status').textContent = status === 'error' && message ? message : descriptions[status];
    if (status === 'downloading' && knownPercent) $('update-status').textContent += ' · ' + Math.round(progress.value) + '%';
    $('update-details').hidden = !notes;
    $('update-notes').textContent = notes || '';

    const commands = {
      idle: ['检查更新', 'checkUpdate'], current: ['再次检查', 'checkUpdate'],
      available: ['下载更新', 'downloadUpdate'], downloaded: ['保存并重启更新', 'installUpdate'],
      unsupported: ['打开官方发布页', 'openUpdatePage'],
      error: { download: ['重试下载', 'downloadUpdate'], install: ['重试保存并重启', 'installUpdate'] }[retry] || ['重新检查', 'checkUpdate'],
    };
    const command = commands[status];
    action.hidden = !command;
    action.disabled = submitting || !command;
    action.textContent = command?.[0] || '';
    action.dataset.method = command?.[1] || '';
    notice.hidden = !['available', 'downloaded'].includes(status) || dismissed === version;
    dismiss.hidden = notice.hidden;
    const reminder = status === 'downloaded' ? '更新已就绪' : descriptions.available;
    notice.textContent = notice.hidden ? '' : reminder;
  }

  function open() {
    showError();
    render();
    if (!dialog.open) dialog.showModal();
  }

  api.onUpdate((next) => {
    received++;
    state = next;
    showError();
    render();
  });
  api.getUpdate().then((snapshot) => {
    if (!received) { state = snapshot; render(); }
  }).catch((cause) => { render(); showError(cause.message); });

  entry.addEventListener('click', open);
  dismiss.addEventListener('click', () => {
    dismissed = state?.version;
    render();
    entry.focus();
  });
  $('update-close').addEventListener('click', () => dialog.close());
  action.addEventListener('click', async () => {
    if (action.disabled) return;
    const method = action.dataset.method;
    submitting = true;
    showError();
    render();
    try {
      const before = received;
      const snapshot = await api[method]();
      if (before === received && snapshot?.status) state = snapshot;
    } catch (cause) {
      showError(cause.message);
    } finally {
      submitting = false;
      render();
    }
  });
  render();
};

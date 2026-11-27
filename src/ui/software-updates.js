'use strict';

window.bindSoftwareUpdates = (api) => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('update-dialog');
  const entry = $('software-update-entry');
  const badge = $('update-badge');
  const notice = $('update-notice');
  const dismiss = $('update-notice-dismiss');
  const action = $('update-action');
  const error = $('update-error');
  const registry = window.editorCommands;
  const openId = 'software-update-entry', dismissId = 'update-notice-dismiss';
  presentEditorCommand(entry, openId);
  $('software-update-title').textContent = registry.get(openId).title;
  presentEditorCommand(dismiss, dismissId);
  let state;
  let received = 0;
  let dismissed;
  let submitting = false;

  function showError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  function render() {
    const focused = document.activeElement;
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
      unsupported: message || '可从佳剪的 GitHub 发布页获取安装程序。',
      error: '更新失败，请重试。',
    };
    $('update-channel').value = state?.channel ?? 'stable';
    $('update-interval').value = String(state?.intervalHours ?? 24);
    for (const id of ['update-channel','update-interval']) {
      $(id).disabled = submitting || ['unsupported','checking','downloading','installing'].includes(status);
    }
    const progress = $('update-progress');
    const knownPercent = Number.isFinite(percent);
    progress.hidden = status !== 'downloading';
    if (knownPercent) progress.value = Math.min(100, Math.max(0, percent));
    else progress.removeAttribute('value');
    $('update-status').textContent = status === 'error' && message ? message : descriptions[status];
    if (status === 'downloading' && knownPercent) $('update-status').textContent += ' · ' + Math.round(progress.value) + '%';
    $('update-details').hidden = !notes;
    $('update-notes').textContent = notes || '';
    $('update-manage-installation').hidden = !state?.canManageInstallation;

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
    // The service only supplies a version after verifying a newer release.
    const updateHints = {
      available: '可更新', downloading: '正在下载', downloaded: '已下载，等待安装',
      installing: '正在安装', checking: '可更新，正在重新检查',
      error: { download: '下载失败，可重试', install: '安装失败，可重试', check: '上次检查时可更新' }[retry],
    };
    const hint = version && version !== currentVersion && updateHints[status];
    badge.hidden = !hint;
    const title = registry.get(openId).title;
    entry.title = hint ? '佳剪 v' + version + ' ' + hint : title;
    entry.setAttribute('aria-label', hint ? title + '，' + entry.title : title);
    const reminder = {
      available: descriptions.available, checking: descriptions.available, downloaded: '更新已就绪',
      error: retry === 'check' ? '上次发现 ' + version : '',
    }[status];
    notice.hidden = !hint || !reminder || dismissed === version;
    dismiss.hidden = notice.hidden;
    notice.textContent = notice.hidden ? '' : reminder;
    if (focused === dismiss && dismiss.hidden) entry.focus({ preventScroll: true });
    if (dialog.open && ((focused === action && action.disabled) ||
      (focused === $('update-manage-installation') && focused.hidden))) {
      $('update-close').focus({ preventScroll: true });
    }
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

  for (const id of ['update-channel','update-interval']) $(id).addEventListener('change', async () => {
    const preferences = { channel:$('update-channel').value, intervalHours:Number($('update-interval').value) };
    submitting = true;
    render();
    try { state = await api.setUpdatePreferences(preferences); showError(); }
    catch (cause) { showError(cause.message); }
    finally { submitting = false; render(); }
  });
  registry.bind(openId, {when:() => !dialog.open, run:open});
  document.addEventListener('click', event => { if (event.target.id === 'update-settings-entry') registry.execute(openId); });
  entry.addEventListener('click', () => registry.execute(openId));
  registry.bind(dismissId, {
    palette:false, when:() => !dismiss.hidden,
    run:() => {
      dismissed = state?.version;
      render();
      entry.focus();
    },
  });
  dismiss.addEventListener('click', () => registry.execute(dismissId));
  $('update-close').addEventListener('click', () => dialog.close());
  $('update-manage-installation').addEventListener('click', async () => {
    showError();
    try { await api.openInstalledApps(); }
    catch { showError('请打开 Windows 设置，在「应用」中找到佳剪并选择卸载。'); }
  });
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

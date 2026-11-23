'use strict';

(() => {
  const storageKey = 'jiajian.cut-shortcuts.v1';
  const commands = {
    undo: ['撤销', 'Ctrl+Z'], redo: ['重做', 'Ctrl+Shift+Z'],
    split: ['分割', 'W', 'Ctrl+B'], 'trim-left': ['剪掉左侧', 'Q'], 'trim-right': ['剪掉右侧', 'E'],
    reverse: ['倒放', null], mirror: ['镜像', null], crop: ['裁剪画面', null], rotate: ['旋转', null],
    'quick-save': ['快速保存', 'Ctrl+S'],
  };
  const defaults = () => Object.fromEntries(Object.entries(commands).map(([id, [, ...keys]]) => [id, keys]));
  const reserved = new Set([
    'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+F', 'Ctrl+L', 'Ctrl+\\', '.',
    'Ctrl+R', 'Ctrl+W', 'Ctrl+Shift+I', 'Ctrl+Shift+R', 'Alt+F4', 'F5', 'F10', 'F11',
  ]);
  const punctuation = {
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Minus: '-', Equal: '=', Backquote: String.fromCharCode(96),
  };
  function supported(key) {
    return /^[A-Z0-9]$|^F(?:[1-9]|1[0-2])$/.test(key) || Object.values(punctuation).includes(key);
  }
  function allowed(key) {
    if (typeof key !== 'string' || reserved.has(key)) return false;
    const match = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?([^+]+)$/.exec(key);
    return Boolean(match && supported(match[1]));
  }
  function chord(event) {
    if (event.isComposing || event.getModifierState?.('AltGraph') || (event.metaKey && !navigator.platform.startsWith('Mac'))) return;
    let key = event.key?.toUpperCase();
    if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
    if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
    key = punctuation[event.code] ?? key;
    if (!key || !supported(key)) return;
    return (event.ctrlKey || event.metaKey ? 'Ctrl+' : '') + (event.altKey ? 'Alt+' : '') +
      (event.shiftKey ? 'Shift+' : '') + key;
  }
  function load() {
    const initial = defaults();
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return initial;
      const data = JSON.parse(raw), owned = new Set();
      if (data?.version !== 1) return initial;
      for (const [id, slots] of Object.entries(initial)) {
        const saved = data.bindings?.[id];
        if (id === 'quick-save' && saved === undefined) {
          // Earlier settings could already assign Ctrl+S to a clip command.
          initial[id] = slots.map(key => owned.has(key) ? null : key);
          continue;
        }
        if (!Array.isArray(saved) || saved.length !== slots.length) return defaults();
        for (const key of saved) {
          if (key === null) continue;
          if (!allowed(key) || owned.has(key)) return defaults();
          owned.add(key);
        }
        initial[id] = saved;
      }
    } catch { return defaults(); }
    return initial;
  }
  let bindings = load();
  let activeDialog;
  function actionFor(event) {
    if (event.defaultPrevented || activeDialog?.open) return;
    const key = chord(event);
    return key && Object.keys(commands).find(id => bindings[id].includes(key));
  }
  function labelFor(action) {
    return bindings[action]?.filter(Boolean).join(' / ') || '';
  }
  function persist(next) {
    localStorage.setItem(storageKey, JSON.stringify({version: 1, bindings: next}));
    bindings = next;
    window.dispatchEvent(new Event('cutshortcutschange'));
  }
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) {
      bindings = load();
      window.dispatchEvent(new Event('cutshortcutschange'));
    }
  });
  function openSettings(anchor) {
    if (activeDialog?.open) return;
    document.getElementById('cut-shortcuts-dialog')?.remove();
    const dialog = document.createElement('dialog');
    activeDialog = dialog;
    dialog.id = 'cut-shortcuts-dialog';
    dialog.className = 'cloud-settings-dialog';
    dialog.setAttribute('aria-labelledby', 'cut-shortcuts-title');
    dialog.innerHTML = '<header class="cloud-settings-heading"><h2 id="cut-shortcuts-title" tabindex="-1" autofocus>快捷键</h2></header>' +
      '<div class="cloud-settings-body"><p class="cloud-settings-muted">选中键位后按下新组合键。按 Esc 取消录制。</p>' +
      '<h3>工程</h3><div class="project-shortcut-list"></div><h3>片段剪辑</h3>' +
      '<div class="cut-shortcut-list"></div><output id="cut-shortcuts-status" role="status"></output></div>' +
      '<footer class="cloud-settings-actions"><button type="button" id="cut-shortcuts-reset">恢复默认</button>' +
      '<button type="button" id="cut-shortcuts-close">完成</button></footer>';
    const list = dialog.querySelector('.cut-shortcut-list'), status = dialog.querySelector('output');
    const items = [];
    let recording;
    function paint() {
      for (const item of items) {
        const key = bindings[item.id][item.slot];
        const pending = recording === item;
        item.bind.textContent = pending ? '请按键…' : key || '设置键位';
        item.bind.setAttribute('aria-label', commands[item.id][0] + (item.slot ? '备用' : '') + '快捷键，' + (key || '未设置'));
        item.bind.setAttribute('aria-pressed', String(pending));
        item.clear.disabled = !key;
      }
    }
    function save(next, text) {
      try {
        persist(next);
        recording = undefined;
        status.textContent = text;
      } catch { status.textContent = '快捷键保存失败，请检查本机存储后重试。'; }
      paint();
    }
    for (const [id, [label]] of Object.entries(commands)) {
      const row = document.createElement('div'), title = document.createElement('span'), slots = document.createElement('div');
      row.className = 'cut-shortcut-row';
      slots.className = 'cut-shortcut-slots';
      title.textContent = label;
      row.append(title, slots);
      (id === 'quick-save' ? dialog.querySelector('.project-shortcut-list') : list).append(row);
      bindings[id].forEach((_, slot) => {
        const group = document.createElement('span'), bind = document.createElement('button'), clear = document.createElement('button');
        group.className = 'cut-shortcut-key';
        bind.type = clear.type = 'button';
        bind.dataset.bindAction = clear.dataset.clearAction = id;
        bind.dataset.slot = clear.dataset.slot = String(slot);
        clear.textContent = '×';
        clear.title = '清除' + label + (slot ? '备用' : '') + '快捷键';
        clear.setAttribute('aria-label', clear.title);
        const item = {id, slot, bind, clear};
        items.push(item);
        group.append(bind, clear);
        slots.append(group);
        bind.onclick = () => {
          recording = item;
          status.textContent = '正在为“' + label + '”录制快捷键。';
          paint();
        };
        bind.onblur = () => {
          if (recording === item) { recording = undefined; status.textContent = ''; paint(); }
        };
        clear.onclick = () => {
          const next = structuredClone(bindings);
          next[id][slot] = null;
          save(next, '已清除“' + label + '”的键位。');
          bind.focus();
        };
      });
    }
    function onKey(event) {
      // Keep editing shortcuts out of the key binding dialog.
      if (!recording) { if (event.key !== 'Tab') event.stopPropagation(); return; }
      event.stopImmediatePropagation();
      if (event.key === 'Tab') return;
      event.preventDefault();
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape') {
        recording = undefined;
        status.textContent = '已取消录制。';
        paint();
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      const key = chord(event), {id, slot} = recording;
      if (!key || !allowed(key)) {
        status.textContent = '这个键位用于导航、系统操作或现有命令。请选择其他键位。';
        return;
      }
      const owner = items.find(item => bindings[item.id][item.slot] === key && item !== recording);
      if (owner) { status.textContent = key + ' 已分配给“' + commands[owner.id][0] + '”。请先清除原绑定。'; return; }
      const next = structuredClone(bindings);
      next[id][slot] = key;
      save(next, '已将“' + commands[id][0] + '”设为 ' + key + '。');
    }
    dialog.addEventListener('keydown', onKey);
    dialog.querySelector('#cut-shortcuts-reset').onclick = () => save(defaults(), '已恢复默认快捷键。');
    dialog.querySelector('#cut-shortcuts-close').onclick = () => dialog.close();
    window.addEventListener('cutshortcutschange', paint);
    dialog.addEventListener('close', () => {
      window.removeEventListener('cutshortcutschange', paint);
      if (activeDialog === dialog) activeDialog = undefined;
      if (anchor.isConnected) anchor.focus({preventScroll: true});
      window.afterDialogExit(dialog);
    }, {once: true});
    document.body.append(dialog);
    paint();
    dialog.showModal();
  }
  window.cutShortcuts = {actionFor, labelFor, openSettings};
})();

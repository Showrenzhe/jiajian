'use strict';

(() => {
  const storageKey = 'jiajian.cut-shortcuts.v1';
  const registry = window.editorCommands, text = window.editorMessages.shortcutSettings;
  const commands = registry.list().filter(command => command.customizable);
  const defaults = () => Object.fromEntries(commands.map(({id, shortcut}) => [id, [...shortcut]]));
  const reserved = new Set([
    'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+F', 'Ctrl+L', 'Ctrl+\\', 'Ctrl+/', 'Shift+/',
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
  // Project save and snapping also work inside the trim editor. Other trim and
  // timeline commands may use the same key because their focus domains are disjoint.
  function domainsOverlap(a,b) {
    return a==='quick-save' || b==='quick-save' || a==='timeline-snap' || b==='timeline-snap' ||
      registry.get(a).scope===registry.get(b).scope;
  }
  function load() {
    const initial = defaults();
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return initial;
      const data = JSON.parse(raw), owned = new Map(), missing = [];
      function claim(key,id) {
        const owners=owned.get(key) ?? [];
        if (owners.some(owner=>domainsOverlap(owner,id))) return false;
        owners.push(id);owned.set(key,owners);
        return true;
      }
      if (data?.version !== 1) return initial;
      for (const [id, slots] of Object.entries(initial)) {
        const saved = data.bindings?.[id];
        if (saved === undefined) {
          missing.push(id);
          continue;
        }
        if (!Array.isArray(saved) || saved.length !== slots.length) return defaults();
        const migrated = saved.map(key => registry.fixedOwner(key, id)?.id === 'editing-help' ? null : key);
        for (const key of migrated) {
          if (key === null) continue;
          if (!allowed(key) || !claim(key,id)) return defaults();
        }
        initial[id] = migrated;
      }
      // Preserve previous assignments when a later release adds a command with a default key.
      for (const id of missing) {
        initial[id] = initial[id].map(key => {
          return key && claim(key,id) ? key : null;
        });
      }
    } catch { return defaults(); }
    return initial;
  }
  let bindings = load();
  registry.setBindingReader(id => bindings[id]);
  let activeDialog;
  function actionFor(event) {
    if (event.defaultPrevented || activeDialog?.open) return;
    const key = chord(event);
    if (!key) return;
    const matches=commands.filter(({id}) => bindings[id].includes(key));
    if (matches.length<2) return matches[0]?.id;
    const cut=event.target.closest?.('#timeline-cut-editor[data-mode="cut"], #player-pane[data-cut-monitor]');
    return matches.find(command=>command.scope===(cut ? 'cut' : 'timeline'))?.id;
  }
  function onMainTimeline(event) {
    const target=event.target;
    if (event.defaultPrevented || event.isComposing || target.isContentEditable ||
        target.closest?.('input, textarea, select, [role="textbox"], [role="separator"], [role="menu"], dialog, a') ||
        document.querySelector('dialog[open], :popover-open:not(#player-pane), .app-frame[data-navigation="floating"]') ||
        !document.querySelector('.app-frame[data-mode="montage"] #timeline-cut-editor[hidden]')) return false;
    if (target.closest?.('#player-pane')) {
      const heading=document.getElementById('preview-heading');
      return heading.hidden || heading.textContent==='轨道预览';
    }
    return target===document.body || Boolean(target.closest?.('#timeline-tracks-panel, .track-toolbar, #timeline-view-actions'));
  }
  function ownsPaletteKey(event) {
    const action = actionFor(event);
    if (!action || !registry.keysFor('palette').includes(chord(event)) ||
        !document.querySelector('.app-frame[data-mode="montage"]') || document.querySelector('dialog[open]')) return false;
    if (action === 'quick-save') return true;
    if (registry.get(action).scope === 'timeline' && onMainTimeline(event)) return registry.get(action).when();
    const target = event.target;
    if (target.isContentEditable || target.closest?.('input, textarea, select')) return false;
    return registry.get(action).when({target}) && Boolean(target.closest?.('#timeline-cut-editor[data-mode="cut"]') ||
      (target.closest?.('#player-pane[data-cut-monitor]') && !document.querySelector('#player-more-menu:popover-open')));
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
    dialog.innerHTML = '<header class="cloud-settings-heading"><h2 id="cut-shortcuts-title" tabindex="-1" autofocus>'+text.title+'</h2></header>' +
      '<div class="cloud-settings-body"><p class="cloud-settings-muted">'+text.instructions+'</p>' +
      '<h3>'+text.project+'</h3><div class="project-shortcut-list"></div>' +
      '<h3>'+text.timeline+'</h3><div class="timeline-shortcut-list"></div><h3>'+text.clips+'</h3>' +
      '<div class="cut-shortcut-list"></div><output id="cut-shortcuts-status" role="status"></output></div>' +
      '<footer class="cloud-settings-actions"><button type="button" id="cut-shortcuts-reset">'+text.reset+'</button>' +
      '<button type="button" id="cut-shortcuts-close">'+text.done+'</button></footer>';
    const list = dialog.querySelector('.cut-shortcut-list'), status = dialog.querySelector('output');
    const paletteKey = registry.keysFor('palette')[0];
    const legacyOwner = commands.find(({id}) => bindings[id].includes(paletteKey));
    if (legacyOwner) status.textContent = text.legacyPalette(paletteKey, legacyOwner.title);
    const items = [];
    let recording;
    function paint() {
      for (const item of items) {
        const key = bindings[item.id][item.slot];
        const pending = recording === item;
        item.bind.textContent = pending ? text.recording : key || text.assign;
        item.bind.setAttribute('aria-label', text.bindLabel(registry.get(item.id).title, item.slot, key));
        item.bind.setAttribute('aria-pressed', String(pending));
        item.clear.disabled = !key;
      }
    }
    function save(next, confirmation) {
      try {
        persist(next);
        recording = undefined;
        status.textContent = confirmation;
      } catch { status.textContent = text.savingFailed; }
      paint();
    }
    for (const {id, title: label} of commands) {
      const row = document.createElement('div'), title = document.createElement('span'), slots = document.createElement('div');
      row.className = 'cut-shortcut-row';
      slots.className = 'cut-shortcut-slots';
      title.textContent = label;
      row.append(title, slots);
      const group = registry.get(id).scope;
      const section = group === 'timeline' ? '.timeline-shortcut-list' : group === 'montage' ? '.project-shortcut-list' : null;
      (section ? dialog.querySelector(section) : list).append(row);
      bindings[id].forEach((_, slot) => {
        const group = document.createElement('span'), bind = document.createElement('button'), clear = document.createElement('button');
        group.className = 'cut-shortcut-key';
        bind.type = clear.type = 'button';
        bind.dataset.bindAction = clear.dataset.clearAction = id;
        bind.dataset.slot = clear.dataset.slot = String(slot);
        clear.textContent = '×';
        clear.title = text.clearLabel(label, slot);
        clear.setAttribute('aria-label', clear.title);
        const item = {id, slot, bind, clear};
        items.push(item);
        group.append(bind, clear);
        slots.append(group);
        bind.onclick = () => {
          recording = item;
          status.textContent = text.start(label);
          paint();
        };
        bind.onblur = () => {
          if (recording === item) { recording = undefined; status.textContent = ''; paint(); }
        };
        clear.onclick = () => {
          const next = structuredClone(bindings);
          next[id][slot] = null;
          save(next, text.cleared(label));
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
        status.textContent = text.cancelled;
        paint();
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      const key = chord(event), {id, slot} = recording;
      const fixed = key && registry.fixedOwner(key, id);
      if (fixed) { status.textContent = text.fixedConflict(key, fixed.title); return; }
      if (!key || !allowed(key)) {
        status.textContent = text.reserved;
        return;
      }
      const owner = items.find(item => bindings[item.id][item.slot] === key && item !== recording && domainsOverlap(item.id,id));
      if (owner) { status.textContent = text.conflict(key, registry.get(owner.id).title); return; }
      const next = structuredClone(bindings);
      next[id][slot] = key;
      save(next, text.saved(registry.get(id).title, key));
    }
    dialog.addEventListener('keydown', onKey);
    dialog.querySelector('#cut-shortcuts-reset').onclick = () => save(defaults(), text.restored);
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
  window.cutShortcuts = {actionFor, chordFor: chord, ownsPaletteKey, onMainTimeline, labelFor: registry.labelFor, openSettings,
    entries: () => commands.map(({id,title}) => ({label:title, keys:registry.labelFor(id)}))};
})();

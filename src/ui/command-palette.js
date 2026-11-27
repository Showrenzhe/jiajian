'use strict';

(() => {
  const normalize = text => text.normalize('NFKC').toLowerCase();
  const commandIcons = {
    'add-text':'track-type', 'add-sticker':'image', 'mute-video':'track-mute', 'video-speed':'settings',
    'quick-save':'save-project', 'save-project-as':'save-project', 'open-project':'folderOpen', 'play-timeline':'track-video',
    'edit-clip':'film', 'delete-selection':'track-delete', 'project-undo':'undo-edit', 'project-redo':'redo-edit',
  };

  // Prefer complete and adjacent characters. Ordered matches also accept
  // abbreviated Chinese titles such as “剪助” for “剪辑帮助”.
  function match(text, term) {
    if (text === term) return 100;
    const start = text.indexOf(term);
    if (start >= 0) return (start === 0 ? 80 : 60) + term.length / text.length;
    let first = -1, last = -1;
    for (const character of term) {
      last = text.indexOf(character, last + 1);
      if (last < 0) return 0;
      if (first < 0) first = last;
    }
    return 20 + term.length / (last - first + 1);
  }

  function score(item, terms) {
    let total = 0;
    for (const term of terms) {
      const best = Math.max(match(item.fields[0], term) * 1.1,
        ...item.fields.slice(1).map(field => match(field, term)));
      if (!best) return -1;
      total += best;
    }
    return total;
  }

  function icon(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'), use = document.createElementNS(ns, 'use');
    svg.classList.add('ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#icon-' + id);
    svg.append(use);
    return svg;
  }

  window.mountCommandPalette = ({getRecentProjects, openRecentProject, getContext, onError}) => {
    const registry = window.editorCommands, copy = window.editorMessages.commandPalette;
    const dialog = document.getElementById('command-palette'), query = document.getElementById('palette-query');
    const list = document.getElementById('palette-results'), status = document.getElementById('palette-status');
    const close = document.getElementById('palette-close');
    dialog.setAttribute('aria-label', copy.title);
    query.placeholder = copy.search;
    query.setAttribute('aria-label', copy.search);
    list.setAttribute('aria-label', copy.search);
    close.setAttribute('aria-label', copy.close);
    close.textContent = window.editorMessages.shortcutNames.Escape;
    for (const hint of dialog.querySelectorAll('[data-palette-hint]')) hint.textContent = copy[hint.dataset.paletteHint];
    let items = [], visible = [], options = [], active = -1, request = 0, recentState = '';

    function highlight(index, scroll = false) {
      options[active]?.setAttribute('aria-selected', 'false');
      active = index;
      const row = options[index];
      if (!row) { query.removeAttribute('aria-activedescendant'); return; }
      row.setAttribute('aria-selected', 'true');
      query.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({block: 'nearest'});
    }

    function render(keepSelection = false, feedback = '') {
      const selected = keepSelection && visible[active];
      const terms = normalize(query.value).trim().split(/\s+/).filter(Boolean);
      visible = items.filter(item => !item.available || item.available())
        .map(item => ({item, relevance: score(item, terms)})).filter(result => result.relevance >= 0)
        .sort((a, b) => b.relevance - a.relevance || b.item.priority - a.item.priority ||
          a.item.group.localeCompare(b.item.group)).map(result => result.item);
      const rows = document.createDocumentFragment();
      options = [];
      let section;
      for (const [i, item] of visible.entries()) {
        if (!section || item.group !== visible[i-1].group) {
          section = document.createElement('div');
          section.setAttribute('role', 'group');
          section.setAttribute('aria-label', copy[item.group]);
          const heading = document.createElement('div');
          heading.className = 'palette-group';
          heading.textContent = copy[item.group];
          heading.setAttribute('aria-hidden', 'true');
          section.append(heading);
          rows.append(section);
        }
        const row = document.createElement('div');
        row.id = 'palette-option-' + i;
        row.className = 'palette-option';
        row.dataset.index = String(i);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        const title = document.createElement('span');
        title.className = 'palette-option-title';
        title.textContent = item.title;
        row.append(icon(item.icon), title);
        if (item.shortcut) {
          const shortcut = document.createElement('kbd');
          shortcut.textContent = item.shortcut;
          row.append(shortcut);
        }
        section.append(row);
        options.push(row);
      }
      list.replaceChildren(rows);
      highlight(visible.length ? Math.max(0, visible.indexOf(selected)) : -1);
      if (!keepSelection) list.scrollTop = 0;
      const message = feedback || (recentState === 'error' ? copy.loadFailed : visible.length ? '' :
        recentState === 'loading' ? copy.loading : copy.empty);
      status.textContent = message;
      status.hidden = !message;
    }

    async function choose(index) {
      const item = visible[index];
      if (!dialog.open || !item) return;
      if (item.available && !item.available()) {
        render(false, copy.recentUnavailable);
        query.focus({preventScroll:true});
        return;
      }
      dialog.close();
      try { await item.run(); } catch (error) { onError(error); }
    }

    async function open() {
      if (document.querySelector('dialog:modal')) return;
      const context = getContext(document.activeElement);
      const canOpenRecent = () => registry.get('open-project').when(context);
      // Capture availability before the modal takes focus and makes the editor inert.
      items = registry.list().filter(command => command.id !== 'palette' && command.palette !== false && command.when(context))
        .map(command => {
          const group = command.group === 'settings' || command.id.startsWith('settings.') ? 'settings' : 'commands';
          const title = command.titleFor?.(context) ?? command.title;
          const keys = registry.labelFor(command.id);
          const shortcut = keys && command.scope === 'videoMenu' ? window.editorMessages.shortcutScopes.videoMenu + ' · ' + keys : keys;
          const fields = [title, ...(command.keywords || []), keys, copy[group]];
          return {title, group, shortcut, fields: fields.map(normalize),
            icon: group === 'settings' ? 'settings' : commandIcons[command.id] || 'keyboard',
            priority: typeof command.priority === 'function' ? command.priority(context) : command.priority ?? 0,
            run: () => registry.execute(command.id, context)};
        });
      query.value = '';
      query.setAttribute('aria-expanded', 'true');
      recentState = 'loading';
      render();
      const ticket = ++request;
      dialog.showModal();
      try {
        const projects = await getRecentProjects();
        if (!dialog.open || ticket !== request) return;
        for (const project of projects) {
          items.push({title: project.name, fields: [project.name, copy.recent].map(normalize),
            icon: 'folder', group: 'recent', priority: 0, available: canOpenRecent, run: () => openRecentProject(project)});
        }
        recentState = '';
      } catch {
        if (!dialog.open || ticket !== request) return;
        recentState = 'error';
      }
      render(true);
    }

    query.addEventListener('input', () => render());
    query.addEventListener('keydown', event => {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void choose(active);
      } else if (visible.length && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length, true);
      }
    });
    // Keep the search field as the active combobox while using a pointer.
    list.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
    list.addEventListener('click', event => {
      const row = event.target.closest('[role="option"]');
      if (row) void choose(Number(row.dataset.index));
    });
    list.addEventListener('pointermove', event => {
      const row = event.target.closest('[role="option"]');
      if (row && Number(row.dataset.index) !== active) highlight(Number(row.dataset.index));
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      if (!dialog.open) query.setAttribute('aria-expanded', 'false');
    });
    return {open};
  };
})();

'use strict';

(() => {
  const draftViewKey = 'sd-workbench-draft-view';
  const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

  window.createDraftAutosave = ({ create, save, onState }) => {
    let draft;
    let savedKey;
    let pending;
    let inFlight;
    let timer;

    const keyOf = (name, configKey) => name + '\0' + configKey;

    async function writePending() {
      while (pending) {
        const snapshot = pending;
        if (snapshot.key === savedKey) {
          pending = undefined;
          break;
        }
        onState('saving');
        try {
          const payload = { name: snapshot.name, config: JSON.parse(snapshot.configKey) };
          draft = draft ? await save({ ...payload, id: draft.id, expectedRevision: draft.revision }) : await create(payload);
          savedKey = snapshot.key;
          if (pending === snapshot) pending = undefined;
        } catch (error) {
          if (pending !== snapshot) continue;
          onState('error', error);
          return false;
        }
      }
      onState(draft ? 'saved' : 'idle');
      return true;
    }

    function flush() {
      clearTimeout(timer);
      if (inFlight) return inFlight;
      if (!pending) return Promise.resolve(true);
      inFlight = writePending().finally(() => { inFlight = undefined; });
      return inFlight;
    }

    function reset(metadata, name, configKey) {
      clearTimeout(timer);
      pending = undefined;
      draft = metadata;
      savedKey = keyOf(name, configKey);
      onState(draft ? 'saved' : 'idle');
    }

    function stage(name, configKey) {
      const key = keyOf(name, configKey);
      if (pending?.key === key || (!pending && !inFlight && key === savedKey)) return;
      clearTimeout(timer);
      if (!inFlight && key === savedKey) {
        pending = undefined;
        onState(draft ? 'saved' : 'idle');
        return;
      }
      pending = { key, name, configKey };
      onState('pending');
      timer = setTimeout(flush, 350);
    }

    return { stage, reset, flush };
  };

  window.mountDraftLibrary = (container, { load, open }) => {
    const $ = (selector) => container.querySelector(selector);
    const list = $('#draft-list');
    const search = $('#draft-search');
    const sort = $('#draft-sort');
    const status = $('#draft-list-status');
    let drafts = [];
    let request = 0;
    let loaded = false;
    let busy = false;

    function showStatus(message) {
      status.textContent = message;
      status.hidden = !message;
    }

    function draftCard(draft) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      const cover = document.createElement('span');
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      const time = document.createElement('time');
      row.className = 'draft-card';
      button.type = 'button';
      button.className = 'draft-open';
      button.disabled = busy;
      button.title = draft.name;
      cover.className = 'draft-cover';
      cover.setAttribute('aria-hidden', 'true');
      cover.textContent = '▤';
      if (draft.coverUrl) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('load', () => { cover.firstChild.remove(); }, { once: true });
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = draft.coverUrl;
        cover.append(image);
      }
      copy.className = 'draft-card-copy';
      name.textContent = draft.name;
      time.dateTime = draft.updatedAt;
      time.textContent = formatter.format(new Date(draft.updatedAt));
      if (Number.isFinite(draft.duration)) {
        const seconds = Math.round(draft.duration);
        time.append(` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
      }
      copy.append(name, time);
      button.append(cover, copy);
      button.addEventListener('click', () => open(draft.id));
      row.append(button);
      return row;
    }

    function render() {
      const query = search.value.trim().toLocaleLowerCase();
      const visible = drafts.filter(({ name }) => name.toLocaleLowerCase().includes(query));
      if (sort.value === 'name') visible.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      $('#draft-count').textContent = `(${drafts.length})`;
      list.replaceChildren(...visible.map(draftCard));
      showStatus(visible.length ? '' : query ? '没有匹配的草稿。' : '还没有本地草稿。开始创作后，编辑内容会自动保存在这里。');
    }

    async function refresh() {
      const current = ++request;
      if (!loaded) showStatus('正在读取本地草稿…');
      try {
        const result = await load();
        if (current !== request) return;
        drafts = result;
        loaded = true;
        render();
      } catch (error) {
        if (current === request) showStatus(error.message);
      }
    }

    function setView(view) {
      list.dataset.view = view;
      $('#draft-grid').setAttribute('aria-pressed', String(view === 'grid'));
      $('#draft-rows').setAttribute('aria-pressed', String(view === 'list'));
    }

    try { setView(localStorage.getItem(draftViewKey) === 'list' ? 'list' : 'grid'); } catch {}
    for (const [selector, view] of [['#draft-grid', 'grid'], ['#draft-rows', 'list']]) {
      $(selector).addEventListener('click', () => {
        setView(view);
        try { localStorage.setItem(draftViewKey, view); } catch {}
      });
    }
    search.addEventListener('input', () => { if (loaded) render(); });
    sort.addEventListener('change', () => { if (loaded) render(); });
    return {
      refresh,
      setBusy(value) {
        busy = value;
        for (const button of list.querySelectorAll('.draft-open')) button.disabled = busy;
      },
    };
  };
})();

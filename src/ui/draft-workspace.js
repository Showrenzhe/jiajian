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

  window.mountDraftLibrary = (container, { load, open, importMaterials, showEmptyImport }) => {
    const $ = (selector) => container.querySelector(selector);
    const list = $('#draft-list');
    const search = $('#draft-search');
    const sort = $('#draft-sort');
    const status = $('#draft-list-status');
    const statusAction = $('#draft-status-action');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let coverTransition;
    let drafts = [];
    let request = 0;
    let loaded = false;
    let busy = false;

    const cancelCoverTransition = () => coverTransition?.cancel();
    reduceMotion.addEventListener('change', cancelCoverTransition);
    window.addEventListener('resize', cancelCoverTransition);

    function moveCover(image, source, target) {
      const box = target.getBoundingClientRect();
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      if (!scale || box.bottom <= 0 || box.top >= innerHeight) return;
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      const x = box.left + (box.width - width) / 2, y = box.top + (box.height - height) / 2;
      const cover = image.parentElement;
      // Hero's AppStoreCardExample: move the live, matched cover instead of taking a page snapshot.
      const radius = getComputedStyle(cover).borderRadius;
      document.body.append(image);
      image.className = 'draft-cover-transition';
      const movement = image.animate([
        { transform: `translate(${source.x}px, ${source.y}px)`, width: source.width + 'px', height: source.height + 'px', borderRadius: radius },
        { transform: `translate(${x}px, ${y}px)`, width: width + 'px', height: height + 'px', borderRadius: '0px' },
      ], { duration: 260, easing: 'cubic-bezier(.2,.78,.25,1)', fill: 'both' });
      const dissolve = image.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 80, delay: 180, fill: 'both' });
      coverTransition = movement;
      const release = () => {
        movement.cancel();
        dissolve.cancel();
        image.removeAttribute('class');
        cover.append(image);
        if (coverTransition === movement) coverTransition = undefined;
      };
      movement.finished.then(release, release);
    }

    function showStatus(title, detail = '', action = '') {
      $('#draft-status-title').textContent = title;
      $('#draft-status-detail').textContent = detail;
      $('#draft-status-detail').hidden = !detail;
      status.hidden = !title;
      statusAction.textContent = action;
      statusAction.hidden = !action;
      statusAction.disabled = busy;
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
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const symbol = document.createElementNS(icon.namespaceURI, 'use');
      icon.setAttribute('class', 'ui-icon');
      symbol.setAttribute('href', '#icon-film');
      icon.append(symbol);
      cover.append(icon);
      if (draft.coverUrl) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
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
      button.addEventListener('click', async () => {
        const focused = document.activeElement === button;
        const image = cover.querySelector('img');
        const source = !reduceMotion.matches && image?.naturalWidth ? image.getBoundingClientRect() : null;
        const opened = await open(draft.id);
        if (focused && document.activeElement === document.body) (opened?.focusTarget ?? button).focus({ preventScroll: true });
        if (source?.width && opened?.coverUrl === image.currentSrc && opened.target?.checkVisibility() && !reduceMotion.matches) {
          moveCover(image, source, opened.target);
        }
      });
      row.append(button);
      return row;
    }

    function render() {
      const query = search.value.trim().toLocaleLowerCase();
      const visible = drafts.filter(({ name }) => name.toLocaleLowerCase().includes(query));
      if (sort.value === 'name') visible.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      $('#draft-count').textContent = `${drafts.length} 个`;
      list.replaceChildren(...visible.map(draftCard));
      if (visible.length) showStatus('');
      else if (query) showStatus('没有匹配的草稿', '可以换个名称再试。', '清空搜索');
      else showStatus('还没有本地草稿', '开始剪辑后，草稿会自动保存到本机。', showEmptyImport() ? '导入素材' : '');
    }

    async function refresh() {
      const current = ++request;
      if (!loaded) showStatus('正在读取本地草稿…');
      else if (!drafts.length) render();
      try {
        const result = await load();
        if (current !== request) return;
        drafts = result;
        loaded = true;
        render();
      } catch (error) {
        if (current === request) showStatus('读取本地草稿失败', error.message);
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
    statusAction.addEventListener('click', () => {
      if (search.value.trim()) {
        search.value = '';
        render();
        search.focus();
      } else importMaterials();
    });
    search.addEventListener('input', () => { if (loaded) render(); });
    sort.addEventListener('change', () => { if (loaded) render(); });
    return {
      refresh,
      cancelCoverTransition,
      setBusy(value) {
        busy = value;
        statusAction.disabled = value;
        for (const button of list.querySelectorAll('.draft-open')) button.disabled = busy;
      },
    };
  };
})();

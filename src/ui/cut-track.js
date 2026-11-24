'use strict';

(() => {
  const mime = 'application/x-jiajian-scene-cut';
  const min = 0.1;
  const round = (n) => Math.round(n * 1000000) / 1000000;
  const sameRange = (a, b) => Math.abs(a.start - b.start) < 0.00001 && Math.abs(a.end - b.end) < 0.00001;
  const label = (range) => `${range.start.toFixed(2)} – ${range.end.toFixed(2)} 秒`;

  function trimRetainedRanges(ranges, start, end) {
    if (!Array.isArray(ranges) || !ranges.length || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) return undefined;
    const oldStart = Math.min(...ranges.map((r) => r.start));
    const oldEnd = Math.max(...ranges.map((r) => r.end));
    const kept = ranges.map((r) => ({
      start: r.start === oldStart && start < oldStart ? start : Math.max(start, r.start),
      end: r.end === oldEnd && end > oldEnd ? end : Math.min(end, r.end),
    }))
      .filter((r) => r.end - r.start >= min - 1e-6);
    return kept.length ? kept : undefined;
  }

  function createCutTrackEditor(options) {
    const host = options.container ?? document.getElementById('timeline-cut-editor');
    if (!host) throw new Error('缺少裁剪轨道容器。');
    const waveforms=window.mountWaveforms(host);
    host.hidden = true;
    let current;
    let lastScene;
    let generation = 0;
    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function button(text, action, title = text) {
      const node = element('button', text);
      node.type = 'button';
      node.title = title;
      node.onclick = action;
      return node;
    }
    function close() {
      generation += 1;
      waveforms.clear();
      current?.video.pause();
      current?.destroy?.();
      current = null;
      host.replaceChildren();
      host.hidden = true;
      delete host.dataset.mode;
    }
    function status(message) { if (current) current.message.textContent = message; }
    function sceneRecords() { return options.getSceneCuts?.() ?? []; }
    function recordFor(asset) { return sceneRecords().find((item) => item.assetId === asset.id); }
    function writeRecord(record) {
      const records = sceneRecords().filter((entry) => entry.assetId !== record.assetId);
      options.setSceneCuts([...records, record]);
    }
    function makeView(mode, asset) {
      close();
      const header = element('header');
      const title = element('strong', { cut: '裁剪轨道', voice: '口播裁剪轨道', scene: 'AI 拆分轨道' }[mode]);
      const name = element('span', asset.name, 'cut-track-name');
      header.append(title, name, button('关闭', close));
      const body = element('div', undefined, 'cut-track-body');
      const video = element(mode === 'voice' ? 'audio' : 'video');
      video.src = asset.url;
      video.preload = 'metadata';
      video.controls = true;
      video.setAttribute('aria-label', `预览 ${asset.name}`);
      const work = element('div', undefined, 'cut-track-work');
      const toolbar = element('div', undefined, 'cut-track-toolbar');
      const position = element('input');
      position.type = 'range'; position.min = '0'; position.max = String(asset.duration);
      position.step = String(1 / (asset.fps || 30)); position.value = '0';
      position.setAttribute('aria-label', '裁剪播放头');
      const timer = element('span', '0.00 秒');
      const scrub = element('div', undefined, 'cut-track-scrub');
      const overview=element('div',undefined,'cut-source-overview');
      overview.append(position);
      waveforms.add(overview,asset);
      scrub.append(overview, timer);
      const list = element('div', undefined, 'cut-track-list');
      list.setAttribute('aria-label', '片段');
      const controls = element('div', undefined, 'cut-track-toolbar');
      const message = element('output');
      message.setAttribute('aria-live', 'polite');
      work.append(scrub, toolbar, list, controls, message);
      body.append(video, work);
      host.classList.add('cut-track-editor');
      host.replaceChildren(header, body); host.hidden = false;
      current = { mode, asset, video, position, timer, toolbar, list, controls, message, selected: 0, activePoint: null };
      position.oninput = () => seek(Number(position.value));
      video.ontimeupdate = () => {
        if (current?.video !== video) return;
        position.value = String(video.currentTime); timer.textContent = `${video.currentTime.toFixed(2)} 秒`;
      };
      host.tabIndex = -1;
      host.focus({ preventScroll: true });
      return current;
    }
    function seek(value) {
      if (!current) return;
      const t = Math.max(0, Math.min(current.asset.duration, value));
      current.position.value = String(t);
      current.timer.textContent = `${t.toFixed(2)} 秒`;
      if (current.video.readyState) current.video.currentTime = t;
      else {
        const video = current.video;
        video.onloadedmetadata = () => { video.currentTime = t; };
      }
    }
    function point() { return round(Number(current.position.value)); }
    function cutAt() {
      const s = current;
      const t = point();
      const active = s.ranges[s.selected];
      const index = active && t > active.start && t < active.end ? s.selected : s.ranges.findIndex((r) => t > r.start && t < r.end);
      const range = s.ranges[index];
      if (!range || Math.min(t - range.start, range.end - t) < min - 1e-6) return status('请将播放头移至片段内，切点两侧至少保留 0.1 秒。');
      s.ranges.splice(index, 1, { start: range.start, end: t }, { start: t, end: range.end });
      s.selected = index + 1;
      renderCuts();
    }
    function removeCut() {
      const s = current;
      if (s.ranges.length === 1) return status('至少保留一段画面。');
      s.ranges.splice(s.selected, 1); s.selected = Math.min(s.selected, s.ranges.length - 1);
      seek(s.ranges[s.selected].start); renderCuts();
    }
    function moveCut(delta) {
      const s = current;
      const to = s.selected + delta;
      if (to < 0 || to >= s.ranges.length) return;
      [s.ranges[s.selected], s.ranges[to]] = [s.ranges[to], s.ranges[s.selected]];
      s.selected = to; renderCuts();
    }
    function numberField(text, value, action) {
      const wrap = element('label', text);
      const input = element('input');
      input.type = 'number'; input.step = '0.01'; input.min = '0'; input.value = String(round(value)); input.max = String(current.asset.duration);
      input.onchange = () => action(input.valueAsNumber);
      wrap.append(input);
      return wrap;
    }
    function renderCuts() {
      const s = current;
      const range = s.ranges[s.selected];
      s.list.replaceChildren(...s.ranges.map((r, i) => {
        const chip = button(`${i + 1} · ${label(r)}`, () => { s.selected = i; seek(r.start); renderCuts(); });
        chip.setAttribute('aria-pressed', String(s.selected === i));
        return chip;
      }));
      function change(key, value) {
        const updated = { ...range, [key]: round(value) };
        if (!Number.isFinite(value) || updated.start < 0 || updated.end > s.asset.duration + 1e-6 || updated.end - updated.start < min - 1e-6) {
          status('入点、出点须在原素材范围内，且至少相差 0.1 秒。'); renderCuts(); return;
        }
        s.ranges[s.selected] = updated; seek(value); renderCuts();
      }
      s.controls.replaceChildren(numberField('入点', range.start, (v) => change('start', v)), numberField('出点', range.end, (v) => change('end', v)),
        button('前移', () => moveCut(-1)), button('后移', () => moveCut(1)), button('移除片段', removeCut),
        button('应用裁剪', () => {
          s.commit(s.ranges.map((r) => ({ ...r })));
          close();
        }));
    }
    function openCut(clip) {
      if (clip?.asset?.kind !== 'video') return false;
      const trigger = document.activeElement;
      close();
      const openedAt = generation;
      const isCurrent = () => generation === openedAt;
      current = window.mountVideoCutTimeline(host, clip, {
        sourceRanges: options.sourceRanges?.(clip),
        mountMonitor: options.mountMonitor,
        commit: options.createCommit?.(clip, isCurrent) ?? ((ranges, speed, autoFit) => options.commitRanges(clip, ranges, isCurrent, speed, autoFit)),
        prepareSourceEdit: options.prepareSourceEdit,
        close: () => {
          close();
          const fallback = document.querySelector('#timeline-clock .sequence-selected, #timeline-clock');
          const target = trigger?.isConnected && trigger !== document.body ? trigger : fallback?.querySelector('.sequence-selected') ?? fallback;
          target?.focus({ preventScroll: true });
        },
      });
      return true;
    }
    function openVoice(asset, ranges, commit, initialOffset = 0, speed = 1) {
      if (asset?.kind !== 'audio' || typeof commit !== 'function') return false;
      const s = makeView('voice', asset);
      s.video.defaultPlaybackRate=speed; s.video.playbackRate=speed;
      s.ranges = (ranges ?? [{ start: 0, end: asset.duration }]).map((r) => ({ ...r }));
      s.voiceOffset = initialOffset;
      s.commit = (parts) => commit(parts, s.voiceOffset);
      showRangeTools(s);
      const offset = numberField('分镜内起点（秒）', initialOffset, (value) => {
        if (Number.isFinite(value) && value >= 0 && value <= 86400) s.voiceOffset = value;
        else { offset.querySelector('input').value = String(s.voiceOffset); status('口播起点应在 0 至 86400 秒内。'); }
      });
      offset.querySelector('input').max = '86400'; s.toolbar.append(offset);
      return true;
    }
    function playCuts(s) {
      s.video.pause();
      s.playRun = (s.playRun ?? 0) + 1;
      const token = s.playRun;
      let i = 0;
      function playNext() {
        if (current !== s || s.playRun !== token) return;
        if (!s.ranges[i]) { s.video.pause(); return; }
        const part = s.ranges[i++];
        seek(part.start);
        s.video.play().then(() => {
          function tick() {
            if (current !== s || s.playRun !== token) return;
            if (s.video.currentTime >= part.end - 0.005 || s.video.ended) { playNext(); return; }
            if (!s.video.paused) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }).catch((error) => { if (current === s) status(error.message); });
      }
      playNext();
    }
    function showRangeTools(s) {
      s.toolbar.append(button('在播放头分割', cutAt), button('试听 / 预览裁剪', () => playCuts(s)), button('恢复完整素材', () => {
        s.ranges = [{ start: 0, end: s.asset.duration }]; s.selected = 0; seek(0); renderCuts();
      }));
      renderCuts(); seek(s.ranges[0].start);
    }
    function sceneRanges(record, asset) {
      const ends = [...record.points, asset.duration];
      return ends.map((end, i) => ({ start: ends[i - 1] ?? 0, end }));
    }
    function updatePoints(points, record) {
      const ranges = sceneRanges({ points }, current.asset);
      const kept = (previous) => previous.filter((item) => ranges.some((r) => sameRange(item, r)));
      writeRecord({ ...record, points, used: kept(record.used), ...(record.hidden && {hidden:kept(record.hidden)}) });
      renderScenes();
    }
    function addPoint() {
      const s = current; const record = recordFor(s.asset); if (!record) return;
      const t = point();
      if ([0, ...record.points, s.asset.duration].some((p) => Math.abs(p - t) < min - 1e-6)) return status('切点两侧至少保留 0.1 秒。');
      s.activePoint = t;
      updatePoints([...record.points, t].sort((a,b) => a-b), record);
    }
    function deletePoint() {
      const s = current; const record = recordFor(s.asset);
      if (!record || s.activePoint == null) return status('请选择要移除的切点。');
      const next = record.points.filter((v) => v !== s.activePoint);
      s.activePoint = null; updatePoints(next, record);
    }
    function applyScene(asset, range, shotIndex, targetLane, videoSlot) {
      const record = recordFor(asset);
      if (!record || !sceneRanges(record, asset).some((r) => sameRange(r, range))) return false;
      if (options.addCandidate(shotIndex, asset, { ...range }, targetLane, videoSlot) !== true) return false;
      writeRecord({ ...record, used: record.used.some((r) => sameRange(r, range)) ? record.used : [...record.used, { ...range }] });
      if (current?.mode === 'scene') renderScenes();
      return true;
    }
    function dropScene(event, shotIndex, targetLane, videoSlot) {
      if (!event.dataTransfer?.types.includes(mime)) return false;
      event.preventDefault(); event.stopPropagation();
      try {
        const { assetId, start, end } = JSON.parse(event.dataTransfer.getData(mime));
        const asset = current?.asset?.id === assetId ? current.asset : options.getAsset?.(assetId);
        if (asset) return applyScene(asset, { start, end }, shotIndex, targetLane, videoSlot);
      } catch { status('无法读取拖入的片段。'); }
      return false;
    }
    function renderScenes() {
      const s = current;
      if (!s || s.mode !== 'scene') return;
      const record = recordFor(s.asset);
      if (!record) return;
      const items = sceneRanges(record, s.asset);
      s.selected = Math.max(0, Math.min(s.selected, items.length - 1));
      const visible = items.map((r,i) => ({ r, i, used: record.used.some((u) => sameRange(u,r)), hidden: record.hidden?.some((u) => sameRange(u,r)) }))
        .filter((row) => s.showUsed || !(row.hidden || row.used));
      if (!visible.some(({ i }) => i === s.selected)) s.selected = visible[0]?.i ?? -1;
      const points = element('div', undefined, 'scene-cut-points');
      for (const t of record.points) {
        const marker = button(`✂ ${t.toFixed(2)}`, () => { s.activePoint = t; seek(t); renderScenes(); }, '定位拆分点');
        marker.setAttribute('aria-pressed', String(s.activePoint === t)); points.append(marker);
      }
      const chips = visible.map(({ r,i,used,hidden }) => {
        const chip = button(`${i+1} · ${label(r)}${used ? ' · 已用' : hidden ? ' · 隐藏' : ''}`, () => { s.selected = i; seek(r.start); renderScenes(); });
        chip.draggable = true; chip.setAttribute('aria-pressed', String(s.selected === i));
        chip.ondragstart = (event) => { event.dataTransfer.setData(mime, JSON.stringify({ assetId: s.asset.id, ...r })); event.dataTransfer.effectAllowed = 'copy'; };
        return chip;
      });
      s.list.replaceChildren(points, ...chips);
      const dest = element('select');
      dest.setAttribute('aria-label', '目标分镜');
      dest.append(new Option('新建分镜', '-1'));
      (options.getShots?.() ?? []).forEach((shot, i) => dest.append(new Option(shot?.name || `分镜 ${i+1}`, String(i))));
      dest.value = String(s.destination ?? -1);
      if (dest.selectedIndex < 0) dest.value = '-1';
      dest.onchange = () => { s.destination = Number(dest.value); };
      const add = button('加入分镜', () => { if (!applyScene(s.asset, items[s.selected], Number(dest.value))) status('未能加入该分镜，请检查剩余候选数量。'); });
      add.disabled = s.selected < 0;
      const bulk = button('批量加入', () => {
        const pending = visible.filter((row) => !(row.used || row.hidden));
        const added = pending.filter(({r}) => options.addCandidate(Number(dest.value), s.asset, {...r}) === true).map(({r}) => ({...r}));
        if (added.length) writeRecord({...record,used:[...record.used,...added]});
        renderScenes(); status(`已加入 ${added.length} 个片段，共 ${pending.length} 个待选片段。`);
      });
      bulk.disabled = visible.every((row) => row.used || row.hidden);
      const used = button(s.showUsed ? '只看待选' : '显示全部', () => { s.showUsed = !s.showUsed; renderScenes(); });
      const selected = visible.find((row) => row.i === s.selected);
      const hide = button(selected?.hidden ? '取消隐藏' : '隐藏片段', () => {
        const hidden = record.hidden ?? [];
        writeRecord({...record, hidden:selected.hidden ? hidden.filter((r) => !sameRange(r,selected.r)) : [...hidden,{...selected.r}]});
        renderScenes();
      });
      hide.disabled = !selected;
      s.controls.replaceChildren(dest, add, bulk, used, hide, button('清空拆分轨', () => {
        lastScene = null; options.setSceneCuts(sceneRecords().filter((r) => r.assetId !== s.asset.id)); close();
      }));
    }
    function fixedSlicing(s) {
      if (s.sizeInput) { s.sizeInput.focus(); return; }
      const number = numberField('每段（秒）', Math.min(s.asset.duration, 2), () => {});
      const size = number.querySelector('input'); size.min = '0.5'; size.step = '0.1'; s.sizeInput = size;
      const tail = element('label'); const check = element('input'); check.type = 'checkbox';
      tail.append(check, document.createTextNode('丢弃短尾段'));
      s.toolbar.append(number, tail, button('生成切片', () => {
        const interval = size.valueAsNumber; const total = s.asset.duration;
        if (!(interval >= .5 && interval <= total) || Math.ceil(total/interval-1e-8) > 100) return status('每段至少 0.5 秒，不能长于原片，最多切分 100 段。');
        const points = [];
        for (let i=1; interval*i < total-1e-6; i++) points.push(round(interval*i));
        const record = recordFor(s.asset) ?? {assetId:s.asset.id, points:[], used:[]};
        const ranges = sceneRanges({points},s.asset);
        const last = ranges.at(-1);
        const discarded = check.checked && last.end-last.start < interval - 1e-6;
        writeRecord({...record,points,used:record.used.filter((u)=>ranges.some((r)=>sameRange(r,u))),hidden:discarded?[last]:[]});
        s.activePoint=null; s.selected=0; renderScenes(); status(`生成 ${ranges.length-Number(discarded)} 个待选切片。`);
      }));
    }
    async function openScenes(asset, fixed = false) {
      if (asset?.kind !== 'video') return false;
      const s = makeView('scene', asset);
      lastScene = asset;
      const run = generation;
      s.toolbar.append(button('添加切点', addPoint), button('删除切点', deletePoint), button('等长切片', () => fixedSlicing(s)));
      if (fixed) {
        fixedSlicing(s); renderScenes(); status('设置切片时长后生成。'); return true;
      }
      if (!recordFor(asset)) {
        status('正在识别场景…');
        try {
          const points = await (options.detectSceneCuts ?? window.workbench.detectSceneCuts)(asset.id);
          if (run !== generation) return false;
          if (!Array.isArray(points)) throw new Error('场景识别已取消。');
          writeRecord({ assetId: asset.id, points: points.filter((t) => t >= min && t <= asset.duration-min), used: [] });
        } catch (error) { if (run === generation) status(error.message); return false; }
      }
      status('片段可拖入分镜，或选择目标后加入。'); renderScenes();
      return true;
    }
    host.addEventListener('keydown', (event) => {
      if (!current || current.mode === 'cut' || event.target.closest('input, select, textarea')) return;
      if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); if (current.mode === 'scene') deletePoint(); else removeCut(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'l' || !lastScene || !recordFor(lastScene)) return;
      if (document.querySelector('.app-frame')?.dataset.mode !== 'montage' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (current?.mode === 'scene') close(); else openScenes(lastScene);
    });
    return { openCut, openVoice, openScenes, openSlices: (asset) => openScenes(asset,true), close, dropScene, refresh: renderScenes };
  }
  window.createCutTrackEditor = createCutTrackEditor;
  window.trimRetainedRanges = trimRetainedRanges;
})();

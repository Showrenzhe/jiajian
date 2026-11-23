'use strict';

window.mountVideoCutTimeline = function mountVideoCutTimeline(host, clip, options) {
  const asset = clip.sourceEdit?.asset ?? clip.asset;
  const original = options.sourceRanges ?? clip.sourceEdit?.ranges ?? clip.ranges ?? [{start: clip.start, end: clip.end}];
  const minimum = 0.1;
  const maxRanges = 2000;
  const round = value => Math.round(value * 1e6) / 1e6;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const frame = 1 / (asset.fps > 0 ? asset.fps : 30);
  const abort = new AbortController();
  const watch = (node, type, callback) => node.addEventListener(type, callback, {signal: abort.signal});
  const node = (type, className, text) => {
    const item = document.createElement(type);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  let ranges = structuredClone(original);
  const history = window.createEditHistory(ranges);
  let starts, total, selected = 0, head = 0, drag;
  let disposed = false, applying = false, playing = false, preparing = false, playIndex = 0;
  let renderKey = 0, run = 0, raf, renderedAsset, usingRender = false, pendingSeek, cropDialog, monitor;

  const header = node('header');
  const title = node('strong', '', '片段剪辑');
  const name = node('span', 'cut-track-name', asset.name);
  name.title = asset.name;
  const body = node('div', 'cut-track-body');
  const preview = node('div', 'video-cut-preview');
  preview.tabIndex = -1;
  watch(preview, 'pointerdown', event => {
    if (event.button === 0) preview.focus({preventScroll: true});
  });
  const video = node('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-label', '片段预览 ' + asset.name);
  video.src = asset.url;
  preview.append(video);
  const work = node('div', 'cut-track-work');
  const tools = node('div', 'cut-track-toolbar video-cut-tools');
  const actions = node('div', 'cut-track-toolbar video-cut-actions');
  const timer = node('span', 'video-cut-time');
  const timeline = node('div', 'video-cut-timeline');
  const ruler = node('div', 'video-cut-ruler');
  ruler.setAttribute('aria-hidden', 'true');
  const ticks = Array.from({length: 5}, (_, index) => {
    const tick = node('span');
    tick.style.left = index * 25 + '%';
    ruler.append(tick);
    return tick;
  });
  const lane = node('div', 'video-cut-lane');
  const film = node('div', 'video-cut-filmstrip');
  lane.append(film);
  const playhead = node('div', 'video-cut-playhead');
  playhead.tabIndex = 0;
  playhead.setAttribute('role', 'slider');
  playhead.setAttribute('aria-label', '剪辑播放头');
  playhead.setAttribute('aria-valuemin', '0');
  const guide = node('div', 'video-cut-trim-guide');
  guide.hidden = true;
  timeline.append(ruler, lane, playhead, guide);
  const sourceOverview = node('div', 'video-cut-source-overview');
  const sourceAxis = node('div', 'cut-source-axis');
  const sourceLabel = node('span', 'cut-source-heading', '原片范围');
  const sourceRail = node('div', 'cut-source-rail');
  sourceRail.setAttribute('role', 'img');
  const inMark = node('span', 'cut-source-in', '入');
  const outMark = node('span', 'cut-source-out', '出');
  sourceRail.append(inMark, outMark);
  sourceAxis.append(sourceLabel, node('span', 'cut-source-limit', '0'), sourceRail,
    node('span', 'cut-source-limit', round(asset.duration) + ' 秒'));
  const sourceFields = node('div', 'cut-source-fields');
  sourceOverview.append(sourceAxis, sourceFields);
  const usedBands = [];
  let currentBand, currentSourceRange;
  const message = node('output');
  message.setAttribute('aria-live', 'polite');
  const status = text => { message.textContent = text; };
  const buttons = {};
  function button(action, label, key, callback, parent) {
    const item = node('button', '', label);
    item.type = 'button';
    item.dataset.action = action;
    item.title = label + (key ? '（' + key + '）' : '');
    item.setAttribute('aria-label', label);
    if (key) item.setAttribute('aria-keyshortcuts', key.replace('Ctrl', 'Control'));
    item.onclick = callback;
    window.decorateCutAction?.(item, action);
    parent.append(item);
    buttons[action] = item;
    return item;
  }
  function field(title, key) {
    const wrap = node('label', '', title);
    const input = node('input');
    input.type = 'number';
    input.dataset.edgeField = key;
    input.min = '0';
    input.max = String(asset.duration);
    input.step = 'any';
    input.setAttribute('aria-label', '源' + title);
    input.onfocus = pause;
    input.onchange = () => {
      const range = ranges[selected], value = round(input.valueAsNumber);
      if (!Number.isFinite(value) || value < 0 || value > asset.duration ||
          (key === 'start' ? range.end - value : value - range.start) < minimum - 1e-7) {
        status('入点和出点须在原片内，且至少相差 0.1 秒。');
        input.value = String(range[key]);
        return;
      }
      const index = selected;
      pause();
      ranges = ranges.with(index, {...range, [key]: value});
      measure();
      const atStart = (key === 'start') !== Boolean(range.reverse);
      head = atStart ? starts[index] : starts[index + 1];
      record(atStart ? undefined : lastFrame(ranges[index]));
    };
    wrap.append(input);
    sourceFields.append(wrap);
    return input;
  }
  header.append(title, name);
  button('cancel', '取消', 'Escape', () => { if (!applying) options.close(); }, header);
  button('play', '播放', 'Space', togglePlay, tools);
  button('undo', '撤销', '', () => travel('undo'), tools);
  button('redo', '重做', '', () => travel('redo'), tools);
  button('split', '分割', '', () => cut('split'), tools);
  button('trim-left', '剪掉左侧', '', () => cut('trim-left'), tools);
  button('trim-right', '剪掉右侧', '', () => cut('trim-right'), tools);
  button('reverse', '倒放', '', () => effect('reverse'), tools);
  button('mirror', '镜像', '', () => effect('mirror'), tools);
  button('crop', '裁剪画面', '', openCrop, tools);
  button('rotate', '旋转', '', () => effect('rotation'), tools);
  tools.append(timer);
  const startField = field('入点', 'start'), endField = field('出点', 'end');
  button('move-left', '前移', '', () => move(-1), actions);
  button('move-right', '后移', '', () => move(1), actions);
  button('delete', '移除片段', 'Delete', remove, actions);
  button('reset', '恢复完整素材', '', reset, actions);
  button('apply', '应用裁剪', '', apply, actions);
  work.append(tools, timeline, sourceOverview, actions, message);
  body.append(work);
  host.dataset.mode = 'cut';
  host.classList.add('cut-track-editor');
  host.replaceChildren(header, body);
  host.hidden = false;
  host.tabIndex = -1;
  const filmstrip = window.mountCutFilmstrip(film, asset, ranges);
  const framePreview = window.mountCutFramePreview?.(preview, video);
  const segments = [];
  function measure() {
    starts = [0];
    for (const range of ranges) starts.push(round(starts.at(-1) + range.end - range.start));
    total = starts.at(-1);
  }
  function indexAt(time) {
    let lo = 0, hi = ranges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (time < starts[mid + 1]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
  function lastFrame(range) {
    return range.reverse ? range.start : Math.max(range.start, range.end - Math.min(frame / 2, (range.end - range.start) / 2));
  }
  function sourceAt(index, time) {
    const range = ranges[index], offset = clamp(time - starts[index], 0, range.end - range.start);
    return round(range.reverse ? range.end - offset : range.start + offset);
  }
  // Retained ranges are half open. The last edit position still displays a retained frame.
  function frameAt(index, time) {
    const range = ranges[index];
    return Math.min(sourceAt(index, time), Math.max(range.start, range.end - Math.min(frame / 2, (range.end - range.start) / 2)));
  }
  function setSource(transformed) {
    if (usingRender === transformed) return;
    usingRender = transformed;
    video.src = transformed ? renderedAsset.url : asset.url;
  }
  function flushSeek() {
    if (pendingSeek == null || !video.readyState || video.seeking) return;
    const source = pendingSeek;
    pendingSeek = undefined;
    if (Math.abs(video.currentTime - source) > 0.00001) video.currentTime = source;
  }
  function seekMedia(source) {
    pendingSeek = source;
    flushSeek();
  }
  watch(video, 'loadedmetadata', flushSeek);
  watch(video, 'seeked', flushSeek);
  function previewAt(source) {
    const index = source !== undefined ? selected : indexAt(head);
    framePreview?.update(usingRender ? {} : ranges[index]);
    seekMedia(usingRender ? Math.min(head, Math.max(0, total - frame / 2)) : source ?? frameAt(index, head));
  }
  function showHead() {
    const value = round(head);
    playhead.style.left = (total ? value / total * 100 : 0) + '%';
    playhead.setAttribute('aria-valuenow', String(value));
    playhead.setAttribute('aria-valuetext', value.toFixed(2) + ' 秒');
    timer.textContent = value.toFixed(2) + ' / ' + total.toFixed(2) + ' 秒';
    monitor?.updatePosition();
  }
  function selection(index) {
    segments[selected]?.setAttribute('aria-pressed', 'false');
    if (segments[selected]) segments[selected].tabIndex = -1;
    selected = index;
    const range = ranges[index];
    if (currentBand !== usedBands[index] || currentSourceRange !== range) {
      currentBand?.removeAttribute('data-current');
      currentBand = usedBands[index];
      currentBand?.setAttribute('data-current', '');
      currentSourceRange = range;
      sourceRail.setAttribute('aria-label', '原片共 ' + round(asset.duration) + ' 秒，片段 ' + (index + 1) +
        ' 入点 ' + round(range.start) + ' 秒，出点 ' + round(range.end) + ' 秒');
      inMark.style.setProperty('--at', (range.start / asset.duration * 100) + '%');
      outMark.style.setProperty('--at', (range.end / asset.duration * 100) + '%');
    }
    segments[index]?.setAttribute('aria-pressed', 'true');
    if (segments[index]) segments[index].tabIndex = 0;
    startField.value = String(round(range.start));
    endField.value = String(round(range.end));
    buttons.reverse.setAttribute('aria-pressed', String(Boolean(range.reverse)));
    buttons.mirror.setAttribute('aria-pressed', String(Boolean(range.mirror)));
    buttons.crop.setAttribute('aria-pressed', String(Boolean(range.crop)));
    shortcutTitle('rotate');
    buttons['move-left'].disabled = index === 0;
    buttons['move-right'].disabled = index === ranges.length - 1;
    buttons.delete.disabled = ranges.length < 2;
  }
  function newSegment(index) {
    const segment = node('button', 'video-cut-segment');
    segment.type = 'button';
    segment.dataset.index = String(index);
    const label = node('span', 'video-cut-label');
    const handle = edge => {
      const item = node('span', 'video-cut-handle');
      item.dataset.edge = edge;
      item.title = edge === 'start' ? '拖动片段左边缘' : '拖动片段右边缘';
      return item;
    };
    segment.append(handle('start'), label, handle('end'));
    segment.onclick = event => { if (event.detail === 0) scrub(starts[index]); };
    segments.push(segment);
    lane.append(segment);
  }
  function layout() {
    measure();
    while (segments.length < ranges.length) newSegment(segments.length);
    while (segments.length > ranges.length) segments.pop().remove();
    while (usedBands.length > ranges.length) usedBands.pop().remove();
    ranges.forEach((range, i) => {
      let band = usedBands[i];
      if (!band) {
        band = node('span', 'cut-source-band');
        sourceRail.append(band);
        usedBands.push(band);
      }
      if (band.dataset.start !== String(range.start) || band.dataset.end !== String(range.end)) {
        band.dataset.start = String(range.start);
        band.dataset.end = String(range.end);
        band.style.left = (range.start / asset.duration * 100) + '%';
        band.style.width = ((range.end - range.start) / asset.duration * 100) + '%';
        band.title = '片段 ' + (i + 1) + ' · 原片 ' + round(range.start) + ' – ' + round(range.end) + ' 秒';
      }
      const segment = segments[i], label = String(i + 1);
      segment.style.width = (starts[i + 1] - starts[i]) / total * 100 + '%';
      segment.dataset.sourceStart = String(range.start);
      segment.dataset.sourceEnd = String(range.end);
      segment.querySelector('.video-cut-label').textContent = label;
      segment.title = '片段 ' + label + ' · 原片 ' + range.start.toFixed(2) + ' – ' + range.end.toFixed(2) + ' 秒';
      segment.setAttribute('aria-label', segment.title);
      segment.tabIndex = -1;
      segment.setAttribute('aria-pressed', 'false');
    });
    ticks.forEach((tick, i) => { tick.textContent = (total * i / 4).toFixed(total < 10 ? 2 : 1); });
    playhead.setAttribute('aria-valuemax', String(total));
    selection(clamp(selected, 0, ranges.length - 1));
    buttons.undo.disabled = !history.canUndo();
    buttons.redo.disabled = !history.canRedo();
    head = clamp(head, 0, total);
    showHead();
    filmstrip.update(ranges, Boolean(drag?.edge));
  }
  function invalidate() {
    renderKey++;
    renderedAsset = undefined;
    setSource(false);
  }
  function record(source) {
    invalidate();
    history.record(ranges);
    layout();
    previewAt(source);
    status('');
  }
  function travel(direction) {
    if (applying || drag) return;
    const previous = history[direction]();
    if (!previous) return;
    pause();
    ranges = previous;
    invalidate();
    layout();
    previewAt();
    status(direction === 'undo' ? '已撤销。' : '已重做。');
  }
  function scrub(time) {
    pause();
    head = round(clamp(time, 0, total));
    selection(indexAt(head));
    showHead();
    previewAt();
  }
  function cut(action) {
    if (applying || drag) return;
    pause();
    const i = indexAt(head), range = ranges[i], source = sourceAt(i, head);
    if (head <= starts[i] || head >= starts[i + 1]) return status('请把播放头移到要剪的片段内。');
    const early = {...range, end: source}, late = {...range, start: source};
    const left = range.reverse ? late : early, right = range.reverse ? early : late;
    const retained = action === 'split' ? [left, right] : [action === 'trim-left' ? right : left];
    if (retained.some(part => part.end - part.start < minimum - 1e-7)) return status('每段至少保留 0.1 秒。');
    if (action === 'split' && ranges.length >= maxRanges) return status('每个素材最多保留 2000 段。');
    ranges = ranges.toSpliced(i, 1, ...retained);
    selected = action === 'split' ? i + 1 : i;
    if (action === 'trim-left') head = starts[i];
    record(action === 'trim-right' ? lastFrame(left) : undefined);
  }
  function remove() {
    if (applying || drag || ranges.length === 1) return;
    if (total - (ranges[selected].end - ranges[selected].start) < minimum - 1e-7) return status('剪辑后至少保留 0.1 秒画面。');
    pause();
    head = starts[selected];
    ranges = ranges.toSpliced(selected, 1);
    selected = Math.min(selected, ranges.length - 1);
    measure();
    head = starts[selected];
    record();
  }
  function move(delta) {
    const next = selected + delta;
    if (applying || drag || next < 0 || next >= ranges.length) return;
    pause();
    const offset = clamp(head - starts[selected], 0, ranges[selected].end - ranges[selected].start);
    const moved = ranges.slice();
    [moved[selected], moved[next]] = [moved[next], moved[selected]];
    ranges = moved;
    selected = next;
    measure();
    head = round(starts[next] + offset);
    record();
  }
  function reset() {
    if (applying || drag) return;
    pause();
    ranges = [{start: 0, end: asset.duration}];
    selected = 0;
    head = 0;
    record();
  }
  function effect(key, value) {
    if (applying || drag) return;
    pause();
    const next = {...ranges[selected]};
    if (key === 'rotation') value = ((next.rotation ?? 0) + 90) % 360;
    else if (key !== 'crop') value = !next[key];
    if (value) next[key] = value;
    else delete next[key];
    ranges = ranges.with(selected, next);
    if (indexAt(head) !== selected) head = starts[selected];
    record();
  }
  function openCrop() {
    if (applying || drag) return;
    pause();
    const index = selected;
    cropDialog = window.editCutCrop(buttons.crop, asset, frameAt(index, head), ranges[index].crop,
      value => { if (!disposed && selected === index) effect('crop', value); });
  }
  async function apply() {
    if (applying || drag) return;
    pause();
    if (window.sameEditSnapshot(original, ranges)) { options.close(); return; }
    applying = true;
    monitor?.sync();
    body.inert = true;
    buttons.cancel.disabled = true;
    host.setAttribute('aria-busy', 'true');
    host.focus({preventScroll: true});
    status('正在应用剪辑…');
    try {
      if (await options.commit(structuredClone(ranges)) === false) throw new Error('无法应用，请检查素材和分镜。');
      if (!disposed) options.close();
    } catch (error) {
      if (disposed) return;
      applying = false;
      monitor?.sync();
      body.inert = false;
      buttons.cancel.disabled = false;
      host.removeAttribute('aria-busy');
      status('应用失败，已保留当前剪辑。' + error.message);
      buttons.apply.focus();
    }
  }
  function showTransport() {
    const item = buttons.play;
    const active = String(playing || preparing);
    if (item.dataset.playing === active) return;
    item.dataset.playing = active;
    const label = item.querySelector('.cut-action-label');
    if (label) label.textContent = playing || preparing ? '暂停' : '播放';
    item.setAttribute('aria-pressed', String(playing || preparing));
    item.setAttribute('aria-label', playing || preparing ? '暂停' : '播放');
    item.title = (playing || preparing ? '暂停' : '播放') + '（Space）';
    monitor?.sync();
  }
  function pause() {
    run++;
    cancelAnimationFrame(raf);
    playing = false;
    if (preparing) status('');
    preparing = false;
    video.pause();
    showTransport();
  }
  function follow(time) {
    head = clamp(time, 0, total);
    const index = indexAt(head);
    if (selected !== index) selection(index);
    showHead();
  }
  function playbackError(error, token) {
    if (disposed || run !== token) return;
    pause();
    status('预览失败。' + (error?.message ?? '请检查源视频是否可读。'));
  }
  function startMedia(token) {
    video.play().catch(error => playbackError(error, token));
  }
  function advance() {
    if (!playing || video.seeking || !video.readyState) return;
    const source = video.currentTime;
    if (usingRender) {
      if (video.ended || source >= total) { pause(); follow(total); }
      else follow(source);
      return;
    }
    let range = ranges[playIndex];
    while (source >= range.end || video.ended) {
      if (playIndex + 1 >= ranges.length) {
        pause();
        follow(total);
        previewAt();
        return;
      }
      const previous = range;
      range = ranges[++playIndex];
      framePreview?.update(range);
      if (Math.abs(previous.end - range.start) > 1e-7 || video.ended) {
        follow(starts[playIndex]);
        seekMedia(range.start);
        if (video.paused || video.ended) startMedia(run);
        return;
      }
    }
    follow(starts[playIndex] + clamp(source - range.start, 0, range.end - range.start));
  }
  async function togglePlay() {
    if (applying || drag) return;
    if (playing || preparing) { pause(); return; }
    pause();
    const token = run, revision = renderKey;
    status('');
    if (head >= total) scrubToStart();
    try {
      if (ranges.some(range => range.reverse)) {
        if (!renderedAsset) {
          preparing = true;
          showTransport();
          status('正在准备倒放预览…');
          const rendered = await options.prepareSourceEdit(asset, structuredClone(ranges));
          if (disposed || revision !== renderKey) return;
          if (!rendered?.url) throw new Error('未生成可播放的视频。');
          renderedAsset = rendered;
        }
        if (token !== run) return;
        setSource(true);
      }
      if (token !== run || disposed) return;
      preparing = false;
      playing = true;
      playIndex = indexAt(head);
      selection(playIndex);
      showTransport();
      previewAt();
      status('');
      await video.play();
      if (disposed || token !== run) return;
      function tick() {
        if (!playing || token !== run) return;
        advance();
        if (playing && token === run) raf = requestAnimationFrame(tick);
      }
      raf = requestAnimationFrame(tick);
    } catch (error) { playbackError(error, token); }
  }
  function scrubToStart() {
    head = 0;
    selection(0);
    showHead();
  }
  watch(video, 'ended', advance);
  watch(video, 'timeupdate', advance);
  watch(video, 'error', () => { if (playing) playbackError(video.error, run); });

  function dragAt(event) {
    const {box, duration, index, edge, before, x} = drag;
    if (!edge) {
      scrub((event.clientX - box.left) * duration / box.width);
      return;
    }
    const delta = (event.clientX - x) * duration / box.width;
    const previous = before[index];
    const isStart = (edge === 'start') !== Boolean(previous.reverse);
    const key = isStart ? 'start' : 'end';
    const proposed = previous[key] + (previous.reverse ? -delta : delta);
    // A trim applied to a rendered recipe may already contain a shorter edge fragment.
    const retainedMinimum = Math.min(minimum, previous.end - previous.start);
    const low = isStart ? 0 : previous.start + retainedMinimum;
    const high = isStart ? previous.end - retainedMinimum : asset.duration;
    const value = clamp(round(proposed), low, high);
    const next = delta === 0 ? previous : {...previous, [key]: value};
    ranges = before.with(index, next);
    measure();
    head = starts[edge === 'start' ? index : index + 1];
    setSource(false);
    layout();
    guide.style.left = clamp((event.clientX - box.left) / box.width, 0, 1) * 100 + '%';
    previewAt(edge === 'start' ? frameAt(index, head) : lastFrame(next));
  }
  function finishDrag(cancel) {
    if (!drag) return;
    const {id, before, oldHead, oldSelection, edge, index} = drag;
    drag = undefined;
    delete timeline.dataset.dragging;
    guide.hidden = true;
    if (timeline.hasPointerCapture(id)) timeline.releasePointerCapture(id);
    if (cancel) {
      ranges = before;
      head = oldHead;
      selected = oldSelection;
      layout();
      previewAt();
    } else if (edge && (ranges[index].start !== before[index].start || ranges[index].end !== before[index].end)) {
      record(edge === 'end' ? lastFrame(ranges[index]) : frameAt(index, head));
    } else if (edge) filmstrip.update(ranges);
  }
  watch(timeline, 'pointerdown', event => {
    if (event.button !== 0 || applying || drag) return;
    const box = lane.getBoundingClientRect();
    if (!box.width) return;
    const segment = event.target.closest('.video-cut-segment');
    const edge = event.target.closest('[data-edge]')?.dataset.edge;
    const index = segment ? Number(segment.dataset.index) : indexAt(head);
    const oldHead = head, oldSelection = selected;
    event.preventDefault();
    pause();
    drag = {id: event.pointerId, edge, index, x: event.clientX, box, duration: total, before: ranges, oldHead, oldSelection};
    timeline.dataset.dragging = edge ?? 'playhead';
    timeline.setPointerCapture(event.pointerId);
    if (edge) {
      selection(index);
      guide.hidden = false;
    }
    if (segment) segment.focus({preventScroll: true});
    else playhead.focus({preventScroll: true});
    dragAt(event);
  });
  watch(timeline, 'pointermove', event => { if (drag?.id === event.pointerId) dragAt(event); });
  watch(timeline, 'pointerup', event => {
    if (drag?.id !== event.pointerId) return;
    dragAt(event);
    finishDrag(false);
  });
  watch(timeline, 'pointercancel', event => { if (drag?.id === event.pointerId) finishDrag(true); });
  watch(timeline, 'lostpointercapture', event => { if (drag?.id === event.pointerId) finishDrag(true); });
  watch(window, 'blur', () => { if (drag) finishDrag(true); });
  const shortcuts = ['undo', 'redo', 'split', 'trim-left', 'trim-right', 'reverse', 'mirror', 'crop', 'rotate'];
  function shortcutTitle(action) {
    const item = buttons[action], key = window.cutShortcuts.labelFor(action);
    const title = action === 'rotate' ? '顺时针旋转 90° · 当前 ' + (ranges[selected].rotation ?? 0) + '°' : item.getAttribute('aria-label');
    item.title = title + (key ? '（' + key + '）' : '');
    if (key) item.setAttribute('aria-keyshortcuts', key.replaceAll('Ctrl', 'Control').split(/\s*\/\s*/).join(' '));
    else item.removeAttribute('aria-keyshortcuts');
  }
  function refreshShortcuts() { shortcuts.forEach(shortcutTitle); }
  watch(window, 'cutshortcutschange', refreshShortcuts);
  function onKey(event) {
    if (event.isComposing || applying) { event.stopPropagation(); return; }
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      if (drag) finishDrag(true);
      else options.close();
      return;
    }
    if (event.target.closest('input,textarea,select,[contenteditable=true]') || drag) {
      event.stopPropagation();
      return;
    }
    const action = window.cutShortcuts?.actionFor(event);
    if (shortcuts.includes(action)) {
      event.stopPropagation();
      event.preventDefault();
      if (!event.repeat && !buttons[action].disabled) buttons[action].click();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if ((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    event.stopPropagation();
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!event.repeat) remove();
    } else if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) togglePlay();
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Home') scrub(0);
      else if (event.key === 'End') scrub(total);
      else scrub(head + (event.key === 'ArrowLeft' ? -1 : 1) * frame * (event.shiftKey ? 10 : 1));
      playhead.focus({preventScroll: true});
    }
  }
  watch(host, 'keydown', onKey);
  layout();
  monitor = options.mountMonitor(preview, {
    asset, get time() { return head; }, get end() { return total; },
    get playing() { return playing || preparing; }, get busy() { return applying; },
    togglePlay, pause, seek: time => { if (!applying && !drag) scrub(time); }, onKey,
  });
  refreshShortcuts();
  showTransport();
  previewAt();
  playhead.focus({preventScroll: true});
  return {
    mode: 'cut', video,
    destroy() {
      disposed = true;
      abort.abort();
      pause();
      cropDialog?.close?.();
      filmstrip.destroy();
      framePreview?.destroy();
      host.removeAttribute('aria-busy');
      video.removeAttribute('src');
      video.load();
      monitor.close();
    },
  };
};

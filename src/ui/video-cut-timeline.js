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
  const initialSpeed = clip.speed ?? 1;
  const slotDuration = clip.videoWindow ?? (clip.videoFit === 'hold' ? clip.videoDuration : undefined);
  const initialAutoFit = Boolean(slotDuration && clip.autoFitSpeed);
  let autoFit = initialAutoFit;
  let speed = initialSpeed;
  const history = window.createEditHistory({ranges, speed, autoFit});
  let starts, total, selected = 0, head = 0, drag;
  let disposed = false, pendingApply, playing = false, preparing = false, playIndex = 0;
  let renderKey = 0, run = 0, raf, renderedAsset, usingRender = false, pendingSeek, cropDialog, monitor;
  let proxyUrl, baked, bakeRequest, requestedRate, mediaScale = 1;
  let scanStart, scanHead, scanTimer;

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
  const lane = node('div', 'video-cut-lane cut-source-rail');
  const film = node('div', 'video-cut-filmstrip');
  lane.append(film);
  const playhead = node('div', 'video-cut-playhead');
  playhead.tabIndex = 0;
  playhead.setAttribute('role', 'slider');
  playhead.setAttribute('aria-label', '剪辑播放头');
  playhead.setAttribute('aria-valuemin', '0');
  timeline.append(ruler, lane, playhead);
  lane.setAttribute('role', 'group');
  function marker(key, cssClass, title) {
    const handle = node('button', 'cut-source-marker ' + cssClass);
    handle.type = 'button';
    handle.dataset.sourceEdge = key;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', title);
    handle.title = title + ' · 拖动调整，方向键微调一帧';
    handle.append(node('span', 'cut-source-mark-label'));
    lane.append(handle);
    return handle;
  }
  const markers = {
    start: marker('start', 'cut-source-in', '原片入点'),
    end: marker('end', 'cut-source-out', '原片出点'),
  };
  const sequence = node('div', 'video-cut-sequence');
  sequence.setAttribute('role', 'group');
  sequence.setAttribute('aria-label', '剪后片段顺序');
  const usedBands = [];
  let currentBand, currentSegment, currentSourceRange;
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
  header.append(title, name);
  button('cancel', '取消', 'Escape', cancel, header);
  button('play', '播放', 'Space', togglePlay, tools);
  button('undo', '撤销', '', () => travel('undo'), tools);
  button('redo', '重做', '', () => travel('redo'), tools);
  button('split', '分割', '', () => cut('split'), tools);
  button('trim-left', '剪掉左侧', '', () => cut('trim-left'), tools);
  button('trim-right', '剪掉右侧', '', () => cut('trim-right'), tools);
  const speedLabel = node('label', 'video-cut-speed', '倍速');
  const speedSelect = node('select');
  speedSelect.dataset.action = 'speed';
  speedSelect.setAttribute('aria-label', '片段倍速');
  const autoOption = slotDuration > 0 ? new Option('自动', 'auto') : undefined;
  if (autoOption) speedSelect.add(autoOption);
  const speeds = [...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 3, initialSpeed])].sort((a, b) => a - b);
  const displayRate = rate => Number(rate.toPrecision(4)) + '×';
  for (const rate of speeds) speedSelect.add(new Option(displayRate(rate), String(rate)));
  speedLabel.append(speedSelect);
  tools.append(speedLabel);
  watch(speedSelect, 'change', () => {
    if (pendingApply || drag) return;
    const value = speedSelect.value;
    autoFit = value === 'auto';
    if (autoFit) measure();
    else setSpeed(Number(value));
    history.record({ranges, speed, autoFit});
    layout();
  });
  button('reverse', '倒放', '', () => effect('reverse'), tools);
  button('mirror', '镜像', '', () => effect('mirror'), tools);
  button('crop', '裁剪画面', '', openCrop, tools);
  button('rotate', '旋转', '', () => effect('rotation'), tools);
  tools.append(timer);
  button('move-left', '前移', '', () => move(-1), actions);
  button('move-right', '后移', '', () => move(1), actions);
  button('delete', '移除片段', 'Delete', remove, actions);
  button('reset', '恢复完整素材', '', reset, actions);
  button('apply', '应用裁剪', '', apply, actions);
  work.append(tools, timeline, sequence, actions, message);
  body.append(work);
  host.dataset.mode = 'cut';
  host.classList.add('cut-track-editor');
  host.replaceChildren(header, body);
  host.hidden = false;
  host.tabIndex = -1;
  // Keep source coordinates stable even after a trim, split or reorder.
  const fullSource = [{start: 0, end: asset.duration}];
  const filmstrip = window.mountCutFilmstrip(film, asset, fullSource);
  const framePreview = window.mountCutFramePreview?.(preview, video);
  const segments = [];
  function measure() {
    starts = [0];
    total = 0;
    for (const range of ranges) {
      total += range.end - range.start;
      starts.push(total);
    }
    if (autoOption) {
      const retained = total - (clip.look?.head ?? 0) - (clip.look?.tail ?? 0);
      const next = window.fitVideoSpeed(retained, slotDuration);
      const label = '自动 · ' + displayRate(next);
      if (autoOption.text !== label) autoOption.text = label;
      if (autoFit) setSpeed(next);
    }
  }
  // Head, edit ranges and rendered previews use source seconds. Convert only
  // the transport interface to elapsed playback time so retiming keeps its frame.
  function setSpeed(next) {
    const previous = speed;
    speed = next;
    speedSelect.value = autoFit ? 'auto' : String(next);
    if (previous !== next && preparing) pause();
    if (requestedRate !== next && !drag?.edge) requestSpeedPreview();
    if (mediaScale !== 1 && mediaScale !== speed) {
      setSource(false);
      previewAt();
      if (playing && !window.sampleVideoRate(speed)) startMedia(run);
    }
    const nativeRate = window.sampleVideoRate(next) ? 1 : next / mediaScale;
    if (video.defaultPlaybackRate !== nativeRate) video.defaultPlaybackRate = nativeRate;
    if (video.playbackRate !== nativeRate) video.playbackRate = nativeRate;
    if (playing && previous !== next) {
      if (window.sampleVideoRate(next)) {
        video.pause();
        scanStart = performance.now();
        scanHead = head;
      } else if (window.sampleVideoRate(previous)) {
        playIndex = indexAt(head);
        previewAt();
        startMedia(run);
      }
    }
  }
  function requestSpeedPreview() {
    requestedRate = speed;
    baked = undefined;
    bakeRequest = undefined;
    if (!window.shouldRetimeVideo(asset,speed) || !options.retimedPreview) return;
    const request = Promise.resolve(options.retimedPreview(asset,speed)).catch(() => null);
    bakeRequest = request;
    request.then(result => {
      if (disposed || request !== bakeRequest) return;
      bakeRequest = undefined;
      if (!result || result.rate !== speed) return;
      baked = result;
    });
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
  function playheadIndex() {
    // At a cut, the out marker belongs to the selected clip even though the
    // same edit time is also the next clip's in point.
    return head >= starts[selected] && head <= starts[selected + 1] ? selected : indexAt(head);
  }
  function setSource(transformed, timed = false) {
    const fast = timed && baked?.rate === speed ? baked : undefined;
    const url = transformed ? renderedAsset.url : fast?.url ?? proxyUrl ?? asset.url;
    if (video.getAttribute('src') === url) return;
    usingRender = transformed;
    mediaScale = fast?.rate ?? 1;
    video.defaultPlaybackRate = window.sampleVideoRate(speed) ? 1 : speed / mediaScale;
    video.src = url;
    video.playbackRate = video.defaultPlaybackRate;
  }
  function flushSeek() {
    if (pendingSeek == null || !video.readyState || video.seeking) return;
    const source = pendingSeek / mediaScale;
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
    // Frame edits need the original source cadence even when playback uses a retimed cache.
    if (!playing && !preparing && mediaScale !== 1) setSource(false);
    const index = source !== undefined ? selected : playheadIndex();
    framePreview?.update(usingRender ? {} : ranges[index]);
    seekMedia(usingRender ? Math.min(head, Math.max(0, total - frame / 2)) : source ?? frameAt(index, head));
  }
  function showHead() {
    const value = round(head / speed);
    const source = sourceAt(playheadIndex(), head);
    playhead.style.left = source / asset.duration * 100 + '%';
    playhead.setAttribute('aria-valuenow', String(value));
    playhead.setAttribute('aria-valuetext', '原片 ' + source.toFixed(2) + ' 秒，剪后 ' + value.toFixed(2) + ' 秒');
    timer.textContent = value.toFixed(2) + ' / ' + (total / speed).toFixed(2) + ' 秒';
    monitor?.updatePosition();
  }
  function edgeLimits(range, key) {
    // An older recipe can contain a fragment shorter than the normal minimum.
    const keep = Math.min(minimum, range.end - range.start);
    return key === 'start' ? [0, round(range.end - keep)] : [round(range.start + keep), asset.duration];
  }
  function updateMarker(range, key, name) {
    const item = markers[key], value = range[key], percent = value / asset.duration * 100;
    const [min, max] = edgeLimits(range, key);
    item.style.setProperty('--at', percent + '%');
    lane.style.setProperty(key === 'start' ? '--source-in' : '--source-out', percent + '%');
    item.dataset.labelSide = percent > 50 ? 'left' : 'right';
    item.setAttribute('aria-valuemin', String(min));
    item.setAttribute('aria-valuemax', String(max));
    item.setAttribute('aria-valuenow', String(round(value)));
    item.setAttribute('aria-valuetext', round(value) + ' 秒');
    const precision = frame < .01 ? 3 : 2;
    const units = 10 ** precision, ticks = Math.round(value * units);
    const seconds = ((ticks % (60 * units)) / units).toFixed(precision);
    item.firstChild.textContent = name + ' ' + Math.floor(ticks / (60 * units)) + ':' + seconds.padStart(precision + 3, '0');
  }
  function selection(index) {
    if (currentSegment !== segments[index]) {
      if (currentSegment) {
        currentSegment.setAttribute('aria-pressed', 'false');
        currentSegment.tabIndex = -1;
      }
      currentSegment = segments[index];
      currentSegment.setAttribute('aria-pressed', 'true');
      currentSegment.tabIndex = 0;
    }
    selected = index;
    const range = ranges[index];
    if (currentBand !== usedBands[index] || currentSourceRange !== range) {
      currentBand?.removeAttribute('data-current');
      currentBand = usedBands[index];
      currentBand?.setAttribute('data-current', '');
      currentSourceRange = range;
      lane.setAttribute('aria-label', '原片共 ' + round(asset.duration) + ' 秒，片段 ' + (index + 1) +
        ' 入点 ' + round(range.start) + ' 秒，出点 ' + round(range.end) + ' 秒');
      updateMarker(range, 'start', '入');
      updateMarker(range, 'end', '出');
    }
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
    const label = node('span', 'video-cut-label', String(index + 1));
    segment.append(label);
    segment.tabIndex = -1;
    segment.setAttribute('aria-pressed', 'false');
    segment.onclick = event => { if (event.detail === 0) scrub(starts[index]); };
    segments.push(segment);
    sequence.append(segment);
  }
  function drawRange(range, i) {
    const band = usedBands[i], segment = segments[i];
    const start = String(range.start), end = String(range.end);
    if (band.dataset.start === start && band.dataset.end === end) return;
    band.dataset.start = segment.dataset.sourceStart = start;
    band.dataset.end = segment.dataset.sourceEnd = end;
    const duration = range.end - range.start;
    band.style.left = (range.start / asset.duration * 100) + '%';
    band.style.width = (duration / asset.duration * 100) + '%';
    segment.style.flex = Math.max(1, Math.round(duration * 1e6)) + ' 1 0px';
    segment.title = band.title = '片段 ' + (i + 1) + ' · 原片 ' + start + ' – ' + end + ' 秒';
    segment.setAttribute('aria-label', segment.title);
  }
  function layout() {
    measure();
    sequence.hidden = ranges.length < 2;
    while (segments.length < ranges.length) newSegment(segments.length);
    while (segments.length > ranges.length) segments.pop().remove();
    while (usedBands.length > ranges.length) usedBands.pop().remove();
    while (usedBands.length < ranges.length) {
      const band = node('span', 'cut-source-band');
      lane.insertBefore(band, markers.start);
      usedBands.push(band);
    }
    ranges.forEach(drawRange);
    ticks.forEach((tick, i) => { tick.textContent = (asset.duration * i / 4).toFixed(asset.duration < 10 ? 2 : 1); });
    playhead.setAttribute('aria-valuemax', String(round(total / speed)));
    selected = clamp(selected, 0, ranges.length - 1);
    head = clamp(head, 0, total);
    selection(playheadIndex());
    buttons.undo.disabled = !history.canUndo();
    buttons.redo.disabled = !history.canRedo();
    showHead();
    filmstrip.update(fullSource, Boolean(drag?.edge));
  }
  function invalidate() {
    renderKey++;
    renderedAsset = undefined;
    setSource(false);
  }
  function record(source) {
    invalidate();
    measure();
    history.record({ranges, speed, autoFit});
    layout();
    previewAt(source);
    status('');
  }
  function travel(direction) {
    if (pendingApply || drag) return;
    const previous = history[direction]();
    if (!previous) return;
    pause();
    if (!window.sameEditSnapshot(ranges, previous.ranges)) invalidate();
    ranges = previous.ranges;
    autoFit = previous.autoFit;
    setSpeed(previous.speed);
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
    if (pendingApply || drag) return;
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
    if (pendingApply || drag || ranges.length === 1) return;
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
    if (pendingApply || drag || next < 0 || next >= ranges.length) return;
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
    if (pendingApply || drag) return;
    pause();
    ranges = [{start: 0, end: asset.duration}];
    selected = 0;
    head = 0;
    record();
  }
  function effect(key, value) {
    if (pendingApply || drag) return;
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
    if (pendingApply || drag) return;
    pause();
    const index = selected;
    cropDialog = window.editCutCrop(buttons.crop, asset, frameAt(index, head), ranges[index].crop,
      value => { if (!disposed && selected === index) effect('crop', value); });
  }
  function setApplying(attempt) {
    pendingApply = attempt;
    const busy = Boolean(attempt);
    for (const control of [tools, timeline, sequence, actions]) control.inert = busy;
    if (busy) timeline.setAttribute('aria-busy', 'true');
    else timeline.removeAttribute('aria-busy');
    const label = busy ? '取消应用' : '取消';
    buttons.cancel.textContent = label;
    buttons.cancel.title = label + '（Escape）';
    buttons.cancel.setAttribute('aria-label', label);
    monitor?.sync();
  }
  function cancel() {
    if (!pendingApply) { options.close(); return; }
    pendingApply.abort();
    setApplying(undefined);
    status('已取消应用，当前剪辑已保留。');
    buttons.apply.focus({preventScroll: true});
  }
  async function apply() {
    if (pendingApply || drag) return;
    pause();
    if (autoFit === initialAutoFit && speed === initialSpeed && window.sameEditSnapshot(original, ranges)) { options.close(); return; }
    const attempt = new AbortController();
    setApplying(attempt);
    buttons.cancel.focus({preventScroll: true});
    status(ranges.some(range => range.reverse) ? '正在应用倒放剪辑…' : '正在应用剪辑…');
    try {
      if (await options.commit(structuredClone(ranges), speed, autoFit, attempt.signal) === false) throw new Error('无法应用，请检查素材和分镜。');
      if (!attempt.signal.aborted) options.close();
    } catch (error) {
      if (attempt.signal.aborted) return;
      setApplying(undefined);
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
    clearTimeout(scanTimer);
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
    if (!playing) return;
    if (window.sampleVideoRate(speed)) {
      // Outside Chromium's native rate range, sample frames against the edit clock.
      follow(scanHead + (performance.now() - scanStart) * speed / 1000);
      if (head >= total) pause();
      previewAt();
      return;
    }
    if (video.seeking || !video.readyState) return;
    const source = video.currentTime * mediaScale;
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
    if (pendingApply || drag) return;
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
      } else {
        if (bakeRequest) {
          preparing = true;
          showTransport();
          status('正在准备倍速预览…');
          await bakeRequest;
        }
        if (token !== run || disposed) return;
        setSource(false,true);
      }
      if (token !== run || disposed) return;
      preparing = false;
      playing = true;
      playIndex = indexAt(head);
      selection(playIndex);
      showTransport();
      previewAt();
      status('');
      if (window.sampleVideoRate(speed)) {
        scanStart = performance.now();
        scanHead = head;
      } else {
        try { await video.play(); }
        catch (error) {
          // A rate change can switch to sampled playback before native play resolves.
          if (!window.sampleVideoRate(speed) || error.name !== 'AbortError') throw error;
        }
      }
      if (disposed || token !== run) return;
      function tick() {
        if (!playing || token !== run) return;
        advance();
        if (!playing || token !== run) return;
        if (window.sampleVideoRate(speed)) scanTimer = setTimeout(tick, 1000 / 60);
        else raf = requestAnimationFrame(tick);
      }
      tick();
    } catch (error) { playbackError(error, token); }
  }
  function scrubToStart() {
    head = 0;
    selection(0);
    showHead();
  }
  const advanceNative = () => { if (!window.sampleVideoRate(speed)) advance(); };
  watch(video, 'ended', advanceNative);
  watch(video, 'timeupdate', advanceNative);
  watch(video, 'error', () => {
    if ((baked && video.src === baked.url) || (proxyUrl && video.src === proxyUrl)) {
      if (baked && video.src === baked.url) baked = undefined;
      else proxyUrl = undefined;
      setSource(false);
      previewAt();
      if (playing && !window.sampleVideoRate(speed)) startMedia(run);
    } else if (playing) playbackError(video.error, run);
  });

  function scrubSource(source) {
    // Source intervals may be repeated, out of order, or separated by gaps.
    // Prefer the selected copy in an overlap and the closest retained frame in a gap.
    let index = selected, best = Infinity;
    if (!(source >= ranges[index].start && source < ranges[index].end)) {
      for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        if (source >= range.start && source < range.end) { index = i; break; }
        const distance = Math.abs(source - clamp(source, range.start, range.end));
        if (distance < best || (distance === best && i === selected)) { best = distance; index = i; }
      }
    }
    const range = ranges[index], position = clamp(source, range.start, range.end);
    head = round(starts[index] + (range.reverse ? range.end - position : position - range.start));
    selection(index);
    showHead();
    setSource(false);
    previewAt(frameAt(index, head));
  }
  function editEdge(before, index, edge, proposed) {
    const previous = before[index];
    const [low, high] = edgeLimits(previous, edge);
    const value = clamp(round(proposed), low, high);
    ranges = value === previous[edge] ? before : before.with(index, {...previous, [edge]: value});
    measure();
    const atStart = (edge === 'start') !== Boolean(previous.reverse);
    head = starts[atStart ? index : index + 1];
    setSource(false);
    drawRange(ranges[index], index);
    selection(index);
    playhead.setAttribute('aria-valuemax', String(round(total / speed)));
    filmstrip.update(fullSource, Boolean(drag?.edge));
    showHead();
    previewAt(frameAt(index, head));
  }
  function dragAt(event) {
    const {box, index, edge, before, x, surface} = drag;
    if (!edge) {
      const fraction = clamp((event.clientX - box.left) / box.width, 0, 1);
      if (surface === sequence) scrub(fraction * total);
      else scrubSource(fraction * asset.duration);
      return;
    }
    const delta = (event.clientX - x) * asset.duration / box.width;
    const previous = before[index][edge], proposed = previous + delta;
    let value = previous;
    if (Math.abs(delta) >= frame / 2) {
      if (proposed >= asset.duration - frame / 2) value = asset.duration;
      else value = Math.round(proposed / frame) * frame;
    }
    if (value === drag.lastValue) return;
    drag.lastValue = value;
    editEdge(before, index, edge, value);
  }
  function finishDrag(cancel) {
    if (!drag) return;
    const {id, before, oldHead, oldSelection, edge, index, surface} = drag;
    drag = undefined;
    delete timeline.dataset.dragging;
    if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
    if (cancel) {
      ranges = before;
      head = oldHead;
      selected = oldSelection;
      layout();
      previewAt();
    } else if (edge && (ranges[index].start !== before[index].start || ranges[index].end !== before[index].end)) {
      record(frameAt(index, head));
    } else if (edge) filmstrip.update(fullSource);
  }
  function startDrag(event) {
    if (event.button !== 0 || pendingApply || drag) return;
    const surface = event.currentTarget;
    const box = (surface === sequence ? sequence : lane).getBoundingClientRect();
    if (!box.width) return;
    const segment = event.target.closest('.video-cut-segment');
    const handle = event.target.closest('[data-source-edge]');
    const edge = handle?.dataset.sourceEdge;
    const oldHead = head, oldSelection = selected;
    event.preventDefault();
    pause();
    drag = {id: event.pointerId, edge, index: selected, x: event.clientX, box, surface, before: ranges, oldHead, oldSelection};
    timeline.dataset.dragging = edge ?? 'playhead';
    surface.setPointerCapture(event.pointerId);
    (handle || segment || playhead).focus({preventScroll: true});
    dragAt(event);
  }
  for (const surface of [timeline, sequence]) {
    watch(surface, 'pointerdown', startDrag);
    watch(surface, 'pointermove', event => { if (drag?.id === event.pointerId) dragAt(event); });
    watch(surface, 'pointerup', event => {
      if (drag?.id !== event.pointerId) return;
      dragAt(event);
      finishDrag(false);
    });
    watch(surface, 'pointercancel', event => { if (drag?.id === event.pointerId) finishDrag(true); });
    watch(surface, 'lostpointercapture', event => { if (drag?.id === event.pointerId) finishDrag(true); });
  }
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
    if (event.isComposing) { event.stopPropagation(); return; }
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (speedSelect.matches(':open')) return;
      event.preventDefault();
      if (event.repeat) return;
      if (drag) finishDrag(true);
      else cancel();
      return;
    }
    if (pendingApply) { event.stopPropagation(); return; }
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
      const edge = event.target.closest('[data-source-edge]')?.dataset.sourceEdge;
      if (edge) {
        pause();
        const before = ranges, current = ranges[selected][edge];
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const proposed = event.key === 'Home' ? 0 : event.key === 'End' ? asset.duration :
          current + direction * frame * (event.shiftKey ? 10 : 1);
        editEdge(before, selected, edge, proposed);
        if (ranges !== before) record(frameAt(selected, head));
        return;
      }
      if (event.key === 'Home') scrub(0);
      else if (event.key === 'End') scrub(total);
      else scrub(head + (event.key === 'ArrowLeft' ? -1 : 1) * frame * (event.shiftKey ? 10 : 1));
      playhead.focus({preventScroll: true});
    }
  }
  watch(host, 'keydown', onKey);
  setSpeed(initialSpeed);
  layout();
  monitor = options.mountMonitor(preview, {
    asset, get time() { return head / speed; }, get end() { return total / speed; },
    get proxy() { return video.readyState >= 1 && Boolean((baked && !baked.original && video.currentSrc === baked.url)
      || (proxyUrl && video.currentSrc === proxyUrl)); },
    get playing() { return playing || preparing; }, get busy() { return Boolean(pendingApply); },
    togglePlay, pause, seek: time => { if (!pendingApply && !drag) scrub(time * speed); }, onKey,
  });
  refreshShortcuts();
  showTransport();
  previewAt();
  Promise.resolve(!window.shouldRetimeVideo(asset,speed) && options.previewProxy?.(asset)).then(url => {
    if (!url || disposed) return;
    proxyUrl = url;
    // Keep the current decoder running until the next playback if the proxy arrives mid-shot.
    if (!playing && !preparing && !usingRender && !drag) {
      setSource(false);
      previewAt();
    }
  }).catch(() => {});
  watch(video, 'loadedmetadata', () => monitor?.updatePosition());
  playhead.focus({preventScroll: true});
  return {
    mode: 'cut', video,
    destroy() {
      disposed = true;
      pendingApply?.abort();
      abort.abort();
      pause();
      cropDialog?.close?.();
      filmstrip.destroy();
      framePreview?.destroy();
      video.removeAttribute('src');
      video.load();
      monitor.close();
    },
  };
};

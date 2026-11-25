'use strict';

// Keep the last picture in the monitor until the incoming decoder submits its
// requested frame. Steady playback stays on the native video surface.
function createPreviewFrameHandoff(stage) {
  const canvas = document.createElement('canvas');
  canvas.className = 'preview-frame-hold';
  canvas.setAttribute('aria-hidden', 'true');
  const pixels=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  let pendingFrame, videoCallback, incoming, resumePaused, generation = 0;

  function cancelReveal() {
    generation++;
    cancelAnimationFrame(pendingFrame);
    if (resumePaused) {
      incoming.removeEventListener('play',resumePaused);
      incoming.removeEventListener('seeking',resumePaused);
      resumePaused=undefined;
    }
    if (videoCallback !== undefined) incoming.cancelVideoFrameCallback(videoCallback);
    videoCallback = undefined;
    incoming = undefined;
  }
  function clear(parent) {
    if (parent && canvas.parentElement !== parent) return;
    cancelReveal();
    canvas.remove();
  }
  function copyFrame(source) {
    const width = source.videoWidth || source.naturalWidth, height = source.videoHeight || source.naturalHeight;
    if (!width || !height || (source.tagName === 'VIDEO' && source.readyState < 2)) return false;
    const rect = source.getBoundingClientRect(), fit = getComputedStyle(source).objectFit;
    if (!rect.width || !rect.height) return false;
    const fitScale = fit === 'cover' ? Math.max : Math.min;
    const scale = Math.min(1, 1920 / Math.max(width, height),
      devicePixelRatio * fitScale(rect.width / width, rect.height / height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    try { pixels.drawImage(source, 0, 0, canvas.width, canvas.height); }
    catch { return false; }
    canvas.style.objectFit = fit;
    return true;
  }
  function capture() {
    cancelReveal();
    if (canvas.isConnected) return;
    const draft = stage.querySelector('.draft-transport-preview:not([hidden])');
    const parent = draft || stage.querySelector('.player-picture:not([hidden]):not([data-track-hidden])');
    if (!parent) return;
    // Independently positioned video lanes share the monitor; the highest
    // z-index is the visible source, matching the timeline compositor.
    const source = draft ? [...draft.querySelectorAll('.draft-main:not([hidden])')]
      .sort((a,b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]
      : parent.querySelector('video:not([hidden]), img:not([hidden])');
    if (source?.checkVisibility() && copyFrame(source)) parent.append(canvas);
  }
  function moveTo(parent) {
    if (canvas.isConnected && parent !== canvas.parentElement) {
      cancelReveal();
      parent.append(canvas);
    }
  }
  function retain(source) {
    if (!source.checkVisibility() || !copyFrame(source)) return false;
    cancelReveal();
    source.parentElement.append(canvas);
    return true;
  }
  function revealWhen(source) {
    if (!canvas.isConnected || incoming === source) return;
    cancelReveal();
    const request = generation;
    incoming = source;
    const video = source.tagName === 'VIDEO';
    let presented = !video, copiedSrc, copiedTime;
    function ready() {
      return source.currentSrc === source.src && (video ? source.readyState >= 2 && !source.seeking
        : source.complete && source.naturalWidth > 0);
    }
    function check() {
      if (request !== generation) return;
      if (ready()) {
        const copied = copiedSrc === source.currentSrc;
        // On Windows the decoded target can be ready while the paused native
        // surface still shows an older seek. Keep the sampled target on screen
        // until playback resumes or the user seeks again.
        if (copied && video && source.paused && copiedTime === source.currentTime) {
          if (videoCallback !== undefined) source.cancelVideoFrameCallback(videoCallback);
          videoCallback=undefined;
          resumePaused=()=>{
            source.removeEventListener('play',resumePaused);
            source.removeEventListener('seeking',resumePaused);
            resumePaused=undefined;
            if (request!==generation) return;
            presented=false;
            videoCallback=source.requestVideoFrameCallback(onPresented);
            pendingFrame=requestAnimationFrame(check);
          };
          source.addEventListener('play',resumePaused);
          source.addEventListener('seeking',resumePaused);
          return;
        }
        if (copied && presented && (!video || !source.paused)) { clear(); return; }
        if ((!copied || (video && source.paused && copiedTime !== source.currentTime)) && copyFrame(source)) {
          copiedSrc = source.currentSrc;
          copiedTime = source.currentTime;
        }
      } else {
        copiedSrc = undefined;
        presented = !video;
        if (video && videoCallback === undefined) videoCallback = source.requestVideoFrameCallback(onPresented);
      }
      pendingFrame = requestAnimationFrame(check);
    }
    function onPresented() {
      if (request !== generation) return;
      videoCallback = undefined;
      if (!ready()) { videoCallback = source.requestVideoFrameCallback(onPresented); return; }
      presented = true;
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(check);
    }
    if (video) videoCallback = source.requestVideoFrameCallback(onPresented);
    pendingFrame = requestAnimationFrame(check);
  }
  return { capture, moveTo, revealWhen, retain, clear };
}

function mountStereoMeter(stage, meter) {
  const bars = [...meter.children];
  const sources = new WeakMap();
  const playing = new Set();
  const samples = new Float32Array(1024);
  let context, mix, channels, frame;

  function render() {
    frame = undefined;
    for (const node of playing) if (node.paused || !node.isConnected) playing.delete(node);
    bars.forEach((bar, i) => {
      let peak = 0;
      if (playing.size) {
        channels[i].getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      // Show the top 54 dB of the actual post-mix signal, with six LED steps.
      const level = Math.min(6, Math.max(0, Math.ceil((54 + 20 * Math.log10(peak)) / 9)));
      if (bar.dataset.level !== String(level)) {
        bar.dataset.level = String(level);
        bar.style.setProperty('--level', level * 100 / 6 + '%');
      }
    });
    if (playing.size) frame = requestAnimationFrame(render);
  }
  stage.addEventListener('playing', async event => {
    const node = event.target;
    if (!(node instanceof HTMLMediaElement)) return;
    if (!context) {
      context = new AudioContext();
      mix = context.createGain();
      mix.channelCount = 2;
      mix.channelCountMode = 'explicit';
      mix.connect(context.destination);
      const splitter = context.createChannelSplitter(2);
      mix.connect(splitter);
      channels = bars.map((_, i) => {
        const analyser = context.createAnalyser();
        analyser.fftSize = samples.length;
        splitter.connect(analyser, i);
        return analyser;
      });
    }
    if (context.state !== 'running') await context.resume().catch(() => {});
    if (context.state !== 'running' || node.paused || !node.isConnected) return;
    let source = sources.get(node);
    if (!source) {
      source = context.createMediaElementSource(node);
      sources.set(node, source);
    }
    // Reuses the same connection on resume, including after a panel reattach.
    source.connect(mix);
    playing.add(node);
    if (frame === undefined) render();
  }, true);
  // The transport creates and releases media elements as it crosses edits.
  new MutationObserver(records => {
    for (const record of records) for (const node of record.removedNodes) {
      if (node instanceof HTMLMediaElement && !node.isConnected) {
        sources.get(node)?.disconnect();
        playing.delete(node);
      }
    }
  }).observe(stage, { childList:true, subtree:true });
}

// The decoder and its proxy seek in source seconds. The selected track clip
// has a local clock after trimming, joining retained intervals and retiming.
function createTrackPreviewClock(clip) {
  const rate = window.placedVideoSpeed(clip);
  const retained = window.waveformSource(clip.ranges ?? [clip], clip.look?.head, clip.look?.tail);
  if (!(rate > 0 && retained.duration > 0)) return;
  const parts = [];
  let offset = 0, current = 0;
  retained.visit(0, retained.duration, false, (start, end) => {
    parts.push({start, end, offset});
    offset += end - start;
  });
  const duration = retained.duration / rate;
  function sourceAt(time) {
    const distance = Math.max(0, Math.min(duration, time)) * rate;
    current = parts.findIndex(part => distance < part.offset + part.end - part.start);
    if (current < 0) current = parts.length - 1;
    const part = parts[current];
    return Math.min(part.end, part.start + distance - part.offset);
  }
  function timeAt(source) {
    const contains = part => source >= part.start && source <= part.end;
    // Repeated source intervals keep the occurrence chosen by the last seek.
    if (!contains(parts[current])) {
      const index = parts.findIndex(contains);
      if (index >= 0) current = index;
    }
    const part = parts[current];
    return (part.offset + Math.max(0, Math.min(part.end, source) - part.start)) / rate;
  }
  return {duration, rate, sourceAt, timeAt};
}

window.mountPlayerTools = ({ panel, getClip, getTrackClock, seekTrackSource, isLibraryVideo, isEditor, isTrack, validClip, notify, onImageTime,
  getDraft, getIdleDraft, toggleDraft, seekDraft, canProxy, changeQuality }) => {
  const find = (selector) => panel.querySelector(selector);
  const video = find('#preview');
  const image = find('#still-preview');
  const frame = find('.player-picture');
  const stage = find('.preview-stage');
  mountStereoMeter(stage, find('.stereo-meter'));
  const transport = find('#player-transport');
  const play = find('#player-play');
  const position = find('#player-position');
  const sourceScrubber = find('.player-source-scrubber');
  const seekLabel = find('.player-seek-label');
  const ratio = document.querySelector('#ratio');
  const float = find('#player-float');
  const full = find('#player-fullscreen');
  const more = find('#player-more');
  const menu = find('#player-more-menu');
  const quality = find('#player-quality');
  const qualityLabel = find('.player-quality-label');
  const zoom = find('#player-zoom');
  const clock = find('#player-time');
  const duration = find('#player-duration');
  const seekClock = find('#player-seek-time');
  const row = find('.player-control-row');
  const display = find('.player-display');
  new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    if (!width) return;
    const parent = width < 270 ? menu : row;
    if (display.parentElement !== parent) parent.append(display);
  }).observe(transport);
  let imageTime = 0;
  let imageStart = null;
  let animation = 0;
  let drag;
  let cut;
  let scrub, seekFrame;

  const imagePlaying = () => imageStart !== null;
  const imagePosition = () => imagePlaying() ? imageTime + (performance.now() - imageStart) / 1000 : imageTime;
  function ready(clip) {
    if (!clip || !validClip(clip)) return false;
    return clip.asset.kind === 'image' ? isTrack() && !image.hidden && image.complete && image.naturalWidth > 0
      : !video.hidden && !video.error && video.readyState >= 1 && video.currentSrc === video.getAttribute('src')
        && (video.currentSrc === clip.asset.url || video.dataset.proxyFor === clip.asset.id);
  }
  function fps(clip) { return clip?.asset.fps > 0 ? clip.asset.fps : Number(document.querySelector('#fps').value); }
  function timecode(seconds, rate) {
    const total = Math.max(0, Math.floor(seconds));
    const frames = Math.floor((seconds - total) * rate + 1e-5);
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60, frames]
      .map((part) => String(part).padStart(2, '0')).join(':');
  }
  function updatePosition(draft = cut || getDraft(), idle = draft ? null : getIdleDraft()) {
    const clip = getClip();
    const active = !draft && ready(clip);
    const timeline = draft || (idle?.end ? idle : null);
    const clipTime = clip?.asset.kind === 'image' ? imagePosition() : scrub?.time ?? video.currentTime;
    const trackClock = timeline ? undefined : getTrackClock();
    let seconds = 0;
    if (timeline) seconds = Math.min(timeline.time,timeline.end);
    else if (active) seconds = trackClock?.timeAt(clipTime) ?? Math.max(clip.start,Math.min(clip.end,clipTime));
    const rate = fps(cut || (timeline || (trackClock && clip.autoFitSpeed) ? null : clip));
    const timedClip = !draft && clip && validClip(clip) && (clip.asset.kind !== 'image' || isTrack());
    const length = draft?.end ?? idle?.end ?? trackClock?.duration ?? (timedClip ? clip.end - clip.start : 0);
    const elapsed = timeline || trackClock ? seconds : Math.max(0, seconds - (clip?.start ?? 0));
    const currentText = timecode(elapsed, rate), endText = timecode(length, rate);
    if (clock.textContent !== currentText) {
      clock.textContent = currentText;
      seekClock.textContent = currentText;
    }
    if (duration.textContent !== endText) {
      duration.textContent = endText;
      find('#player-seek-end').textContent = endText;
    }
    const proxy = draft ? draft.proxy : !video.hidden && video.dataset.proxyFor && video.currentSrc === video.getAttribute('src') && video.readyState >= 1;
    const label = proxy ? '流畅' : '原画';
    if (qualityLabel.textContent !== label) qualityLabel.textContent = label;
    if (cut && position.max !== String(cut.end)) position.max = cut.end;
    position.value = seconds;
    if (!sourceScrubber.hidden) {
      const fraction = length > 0 ? Math.max(0, Math.min(1, elapsed / length)) : 0;
      position.style.setProperty('--progress', fraction * 100 + '%');
      position.setAttribute('aria-valuetext', currentText + ' / ' + endText);
    }
    if (!draft && clip?.asset.kind === 'image' && active) onImageTime?.(clip, seconds);
  }
  function tick() {
    cancelAnimationFrame(animation);
    const clip = getClip();
    if (imagePlaying() && clip && imagePosition() >= clip.end) {
      imageStart = null;
      imageTime = clip.end;
      sync();
    } else {
      updatePosition();
      if (imagePlaying() || (!video.paused && !video.ended && !video.hidden)) animation = requestAnimationFrame(tick);
    }
  }
  function sync() {
    const clip = getClip();
    const draft = cut || getDraft();
    const idle = draft ? null : getIdleDraft();
    const timelineView = Boolean(draft || idle?.end);
    const showSourceBar = !timelineView && isEditor() && isLibraryVideo();
    if (scrub && (!showSourceBar || scrub.clip !== clip)) endSourceScrub(false);
    if (sourceScrubber.hidden === showSourceBar) {
      if (showSourceBar) sourceScrubber.append(position);
      else { seekLabel.after(position); position.removeAttribute('aria-valuetext'); }
      sourceScrubber.hidden = !showSourceBar;
      seekLabel.hidden = showSourceBar;
    }
    find('#preview-heading').hidden = timelineView;
    find('#draft-preview-heading').hidden = !timelineView || Boolean(cut);
    find('#cut-preview-heading').hidden = !cut;
    find('#cut-preview-name').hidden = !cut;
    find('#preview-meta').hidden = timelineView;
    panel.setAttribute('aria-labelledby', cut ? 'cut-preview-heading' : timelineView ? 'draft-preview-heading' : 'preview-heading');
    if (!clip && !draft && isEditor()) {
      find('#preview-hint').textContent = idle?.end ? '播放时间线，或选择素材单独预览' : '在素材库或轨道选择一个素材';
    }
    transport.hidden = !isEditor();
    video.controls = !isEditor();
    const active = draft ? draft.end > 0 : ready(clip);
    play.disabled = Boolean(cut?.busy || (!active && !idle?.end));
    for (const button of panel.querySelectorAll('.player-buttons button')) button.disabled = !active || Boolean(cut?.busy);
    position.disabled = !active || Boolean(cut?.busy);
    const trackClock = !draft && getTrackClock();
    position.min = active && !draft && !trackClock ? clip.start : 0;
    position.max = draft?.end ?? trackClock?.duration ?? (active ? clip.end : 1);
    const playing = draft?.playing ?? (active && (clip.asset.kind === 'image' ? imagePlaying() : !video.paused));
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', playing ? '暂停' : '播放');
    play.title = `${play.getAttribute('aria-label')}${cut ? '片段' : timelineView ? '时间线' : ''}（空格）`;
    find('#player-ratio').value = ratio.value;
    find('.player-ratio-label').textContent = ratio.value;
    find('#player-ratio').disabled = Boolean(cut) || ratio.matches(':disabled');
    frame.toggleAttribute('data-project-frame', Boolean(clip && isTrack()));
    const [width, height] = ratio.value.split(':').map(Number);
    stage.style.setProperty('--picture-ratio', width / height);
    stage.style.setProperty('--picture-background', document.querySelector('#background-color').value);
    stage.style.setProperty('--picture-fit', document.querySelector('#fit').value === 'fill' ? 'cover' : 'contain');
    quality.disabled = !(draft ? draft.canProxy : canProxy(clip?.asset));
    zoom.disabled = !cut && !(draft ? draft.visual : clip && !frame.hidden && clip.asset.kind !== 'audio');
    float.disabled = !draft && (!clip || frame.hidden);
    stage.toggleAttribute('data-audio', !draft && clip?.asset.kind === 'audio' && !frame.hidden);
    updatePosition(draft,idle);
  }
  function reset() {
    endSourceScrub(false);
    imageStart = null;
    imageTime = 0;
    cancelAnimationFrame(animation);
    if (!cut && !getClip()) closeFloating();
    sync();
  }
  function seek(value) {
    const clip = getClip();
    if (clip?.asset.kind !== 'image' && !ready(clip)) return;
    const target = Math.min(clip.end, Math.max(clip.start, value));
    if (clip.asset.kind === 'image') {
      imageTime = target;
      if (imagePlaying()) imageStart = performance.now();
    } else video.currentTime = target;
    updatePosition();
  }
  function seekPosition(value) {
    const trackClock = getTrackClock();
    if (trackClock) seekTrackSource(getClip(), trackClock.sourceAt(value));
    else if (!sourceScrubber.hidden) seekTrackSource(getClip(), value, false);
    else seek(value);
  }
  function applySourceScrub() {
    seekFrame = undefined;
    if (scrub && scrub.clip === getClip()) seekTrackSource(scrub.clip, scrub.time, false);
  }
  function endSourceScrub(commit) {
    if (!scrub) return;
    cancelAnimationFrame(seekFrame);
    seekFrame = undefined;
    const {id, clip, resume} = scrub;
    if (commit) applySourceScrub();
    scrub = undefined;
    if (position.hasPointerCapture(id)) position.releasePointerCapture(id);
    if (commit && resume && clip === getClip()) video.play().catch(error => {
      if (clip === getClip() && error.name !== 'AbortError') notify('播放器未能继续播放此素材。');
    });
  }
  function pause() {
    cut?.pause();
    if (imagePlaying()) {
      imageTime = imagePosition();
      imageStart = null;
    }
    video.pause();
    sync();
  }
  function step(direction) {
    if (cut) return cut.seek(cut.time + direction / fps(cut));
    const draft = getDraft();
    if (draft) {
      if (draft.playing) toggleDraft();
      seekDraft(draft.time + direction / fps(null));
      return;
    }
    const clip = getClip();
    if (!ready(clip)) return;
    pause();
    const source = clip.asset.kind === 'image' ? imageTime : video.currentTime;
    const trackClock = getTrackClock();
    const rate = fps(trackClock && clip.autoFitSpeed ? null : clip);
    seekPosition((trackClock?.timeAt(source) ?? source) + direction / rate);
  }
  async function togglePlay() {
    if (cut) return cut.togglePlay();
    if (getDraft() || getIdleDraft()?.end || (isTrack() && isEditor())) return toggleDraft();
    const clip = getClip();
    if (!ready(clip)) return;
    if (clip.asset.kind === 'image') {
      if (imagePlaying()) return pause();
      if (imageTime >= clip.end) imageTime = clip.start;
      imageStart = performance.now();
      sync();
      tick();
    } else if (!video.paused) pause();
    else {
      if (video.currentTime >= clip.end || video.currentTime < clip.start) seek(clip.start);
      try { await video.play(); } catch (error) {
        if (getClip() === clip && error.name !== 'AbortError') notify('播放器未能播放此素材。');
      }
    }
  }
  function dock() {
    endMove();
    if (panel.matches(':popover-open')) panel.hidePopover();
    panel.removeAttribute('popover');
    panel.style.removeProperty('left');
    panel.style.removeProperty('top');
    float.setAttribute('aria-pressed', String(document.pictureInPictureElement === video));
  }
  function closeFloating() {
    dock();
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
  }
  float.addEventListener('click', async () => {
    if (menu.matches(':popover-open')) menu.hidePopover();
    if (panel.matches(':popover-open') || document.pictureInPictureElement === video) return closeFloating();
    if (document.fullscreenElement === panel) await document.exitFullscreen();
    if (!cut && !getDraft() && zoom.value === '1' && getClip()?.asset.kind === 'video' && video.readyState >= 2 && document.pictureInPictureEnabled) {
      try { await video.requestPictureInPicture(); return; } catch { /* Use the floating editor panel when system PiP is unavailable. */ }
    }
    panel.setAttribute('popover', 'manual');
    panel.showPopover();
    float.setAttribute('aria-pressed', 'true');
  });
  video.addEventListener('enterpictureinpicture', () => float.setAttribute('aria-pressed', 'true'));
  video.addEventListener('leavepictureinpicture', () => float.setAttribute('aria-pressed', String(panel.matches(':popover-open'))));
  const heading = find('.panel-heading');
  function endMove(event) {
    if (!drag || (event?.pointerId != null && drag.id !== event.pointerId)) return;
    const {id, left, top} = drag;
    drag = undefined;
    if (event?.type !== 'pointerup') {
      panel.style.left = left;
      panel.style.top = top;
    }
    if (heading.hasPointerCapture(id)) heading.releasePointerCapture(id);
  }
  heading.addEventListener('pointerdown', (event) => {
    if (!panel.matches(':popover-open') || !event.isPrimary || event.button !== 0 || drag) return;
    const bounds = panel.getBoundingClientRect();
    drag = { id:event.pointerId, x:event.clientX - bounds.left, y:event.clientY - bounds.top,
      left:panel.style.left, top:panel.style.top };
    event.preventDefault();
    heading.setPointerCapture(event.pointerId);
  });
  heading.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, event.clientX - drag.x))}px`;
    panel.style.top = `${Math.max(0, Math.min(innerHeight - panel.offsetHeight, event.clientY - drag.y))}px`;
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) heading.addEventListener(type,endMove);
  window.addEventListener('blur', () => endMove());
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !panel.matches(':popover-open')
      || document.querySelector('dialog[open], select:open, [popover]:popover-open:not(#player-pane), .app-frame[data-navigation="floating"]')
      || (!drag && !panel.contains(event.target) && event.target !== document.body)) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag) endMove();
    else { dock(); more.focus({preventScroll:true}); }
  },true);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen();
      else {
        closeFloating();
        await panel.requestFullscreen();
      }
    } catch { notify('当前窗口无法切换全屏。'); }
  }
  full.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === panel;
    full.setAttribute('aria-pressed', String(active));
    full.setAttribute('aria-label', active ? '退出全屏' : '全屏');
    full.title = full.getAttribute('aria-label') + '（.）';
  });
  play.addEventListener('click', togglePlay);
  find('#player-previous').addEventListener('click', () => step(-1));
  find('#player-next').addEventListener('click', () => step(1));
  find('#player-stop').addEventListener('click', () => {
    if (cut) return cut.seek(0);
    const draft = getDraft();
    if (draft) {
      if (draft.playing) toggleDraft();
      seekDraft(0);
    } else if (getClip()) { pause(); seekPosition(getTrackClock() ? 0 : getClip().start); }
  });
  position.addEventListener('input', () => {
    if (scrub) {
      scrub.time = position.valueAsNumber;
      updatePosition();
      if (seekFrame === undefined) seekFrame = requestAnimationFrame(applySourceScrub);
    } else if (cut) cut.seek(position.valueAsNumber);
    else if (getDraft()) seekDraft(position.valueAsNumber);
    else seekPosition(position.valueAsNumber);
  });
  position.addEventListener('pointerdown', event => {
    if (sourceScrubber.hidden || !event.isPrimary || event.button !== 0 || scrub) return;
    scrub = {id:event.pointerId, clip:getClip(), time:position.valueAsNumber, resume:!video.paused && !video.ended};
    video.pause();
    position.setPointerCapture(event.pointerId);
  });
  position.addEventListener('keydown', event => {
    if (sourceScrubber.hidden || (event.code !== 'Space' && event.key !== ' ') || event.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (!event.repeat) togglePlay();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    position.addEventListener(type, event => {
      if (scrub?.id === event.pointerId) endSourceScrub(type === 'pointerup');
    });
  }
  quality.addEventListener('change', changeQuality);
  zoom.addEventListener('change', () => {
    stage.style.setProperty('--player-zoom', zoom.value);
    zoom.parentElement.title = '预览缩放 · ' + zoom.selectedOptions[0].textContent;
  });
  find('#player-ratio').addEventListener('change', (event) => {
    ratio.value = event.target.value;
    ratio.dispatchEvent(new Event('change', { bubbles: true }));
  });
  video.addEventListener('playing', () => { sync(); tick(); });
  for (const name of ['loadedmetadata', 'loadeddata', 'pause', 'ended', 'error', 'seeked']) video.addEventListener(name, sync);
  image.addEventListener('load', sync);
  window.addEventListener('keydown', (event) => {
    const { target, key } = event;
    if (!isEditor() || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
      || event.shiftKey || document.querySelector('dialog[open], :popover-open:not(#player-pane), .app-frame[data-navigation="floating"]')
      || !(target instanceof Element) || target.isContentEditable
      || target.closest('input, textarea, select, [role="textbox"], [role="tab"], [role="separator"]')) return;
    const onPlayer = panel.contains(target) && (!target.closest('button, a') || target === play || target.closest('.player-buttons'));
    const onTimeline = target.matches('#timeline-clock, #timeline-tracks-panel, #timeline-clock .sequence-block:not(.sequence-empty)');
    if (target !== document.body && !onPlayer && !onTimeline) return;
    if (key === '.' && !event.repeat) toggleFullscreen();
    else if (!cut && !getDraft() && !getIdleDraft()?.end && !ready(getClip())) return;
    else if (key === 'ArrowLeft' || key === 'ArrowRight') step(key === 'ArrowRight' ? 1 : -1);
    else return;
    event.preventDefault();
  });
  function mountCutMonitor(preview, controller) {
    pause();
    if (document.pictureInPictureElement === video) closeFloating();
    cut = controller;
    panel.setAttribute('data-cut-monitor', '');
    find('#cut-preview-name').textContent = cut.asset.name;
    stage.append(preview);
    sync();
    const onKey = event => {
      if (menu.matches(':popover-open') || event.target.closest('input, select, textarea') ||
          event.key === '.' || event.key === 'Tab' || event.key === ' ' ||
          (event.key === 'Escape' && (document.fullscreenElement || panel.matches(':popover-open'))) ||
          (event.key === 'Enter' && event.target.closest('button'))) return;
      controller.onKey(event);
    };
    panel.addEventListener('keydown', onKey);
    return {updatePosition, sync, close() {
      panel.removeEventListener('keydown', onKey);
      // Removing the media node in the stage lets the stereo meter disconnect its source.
      preview.querySelector('video')?.remove();
      preview.remove();
      if (cut !== controller) return;
      cut = undefined;
      panel.removeAttribute('data-cut-monitor');
      find('#cut-preview-name').textContent = '';
      sync();
    }};
  }
  return { sync, updatePosition, reset, closeFloating, pause, seek, step, togglePlay, mountCutMonitor, get monitoringCut() { return Boolean(cut); } };
};

'use strict';

window.mountPlayerTools = ({ panel, getClip, isEditor, isTrack, validClip, notify, onImageTime,
  getDraft, getIdleDraft, toggleDraft, seekDraft, canProxy, changeQuality }) => {
  const find = (selector) => panel.querySelector(selector);
  const video = find('#preview');
  const image = find('#still-preview');
  const frame = find('.player-picture');
  const stage = find('.preview-stage');
  const transport = find('#player-transport');
  const play = find('#player-play');
  const position = find('#player-position');
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
  function updatePosition(draft = getDraft(), idle = draft ? null : getIdleDraft()) {
    const clip = getClip();
    const active = ready(clip);
    const timeline = draft || (idle?.end ? idle : null);
    const clipTime = clip?.asset.kind === 'image' ? imagePosition() : video.currentTime;
    const seconds = timeline ? Math.min(timeline.time,timeline.end) : active ? Math.max(clip.start,Math.min(clip.end,clipTime)) : 0;
    const rate = fps(draft ? null : clip);
    const timedClip = clip && validClip(clip) && (clip.asset.kind !== 'image' || isTrack());
    const length = draft?.end ?? idle?.end ?? (timedClip ? clip.end - clip.start : 0);
    const elapsed = draft ? seconds : Math.max(0, seconds - (clip?.start ?? 0));
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
    position.value = seconds;
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
    const draft = getDraft();
    const idle = draft ? null : getIdleDraft();
    const timelineView = Boolean(draft || idle?.end);
    find('#preview-heading').hidden = timelineView;
    find('#draft-preview-heading').hidden = !timelineView;
    find('#preview-meta').hidden = timelineView;
    panel.setAttribute('aria-labelledby', timelineView ? 'draft-preview-heading' : 'preview-heading');
    if (!clip && !draft && isEditor()) {
      find('#preview-hint').textContent = idle?.end ? '播放时间线，或选择素材单独预览' : '在素材库或轨道选择一个素材';
    }
    transport.hidden = !isEditor();
    video.controls = !isEditor();
    const active = Boolean(draft) || ready(clip);
    play.disabled = !active && !idle?.end;
    for (const button of panel.querySelectorAll('.player-buttons button')) button.disabled = !active;
    position.disabled = !active;
    position.min = active && !draft ? clip.start : 0;
    position.max = draft?.end ?? (active ? clip.end : 1);
    const playing = draft?.playing ?? (active && (clip.asset.kind === 'image' ? imagePlaying() : !video.paused));
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', playing ? '暂停' : '播放');
    play.title = `${play.getAttribute('aria-label')}${timelineView ? '时间线' : ''}（空格）`;
    find('#player-ratio').value = ratio.value;
    find('.player-ratio-label').textContent = ratio.value;
    find('#player-ratio').disabled = ratio.matches(':disabled');
    frame.toggleAttribute('data-project-frame', Boolean(clip && isTrack()));
    const [width, height] = ratio.value.split(':').map(Number);
    stage.style.setProperty('--picture-ratio', width / height);
    stage.style.setProperty('--picture-background', document.querySelector('#background-color').value);
    stage.style.setProperty('--picture-fit', document.querySelector('#fit').value === 'fill' ? 'cover' : 'contain');
    quality.disabled = !(draft ? draft.canProxy : canProxy(clip?.asset));
    zoom.disabled = !(draft ? draft.visual : clip && !frame.hidden && clip.asset.kind !== 'audio');
    float.disabled = !draft && (!clip || frame.hidden);
    stage.toggleAttribute('data-audio', !draft && clip?.asset.kind === 'audio' && !frame.hidden);
    updatePosition(draft,idle);
  }
  function reset() {
    imageStart = null;
    imageTime = 0;
    cancelAnimationFrame(animation);
    if (!getClip()) closeFloating();
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
  function pause() {
    if (imagePlaying()) {
      imageTime = imagePosition();
      imageStart = null;
    }
    video.pause();
    sync();
  }
  function step(direction) {
    const draft = getDraft();
    if (draft) {
      if (draft.playing) toggleDraft();
      seekDraft(draft.time + direction / fps(null));
      return;
    }
    const clip = getClip();
    if (!ready(clip)) return;
    pause();
    seek((clip.asset.kind === 'image' ? imageTime : video.currentTime) + direction / fps(clip));
  }
  async function togglePlay() {
    if (getDraft() || getIdleDraft()?.end) return toggleDraft();
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
    if (!getDraft() && zoom.value === '1' && getClip()?.asset.kind === 'video' && video.readyState >= 2 && document.pictureInPictureEnabled) {
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
    const draft = getDraft();
    if (draft) {
      if (draft.playing) toggleDraft();
      seekDraft(0);
    } else if (getClip()) { pause(); seek(getClip().start); }
  });
  position.addEventListener('input', () => getDraft() ? seekDraft(position.valueAsNumber) : seek(position.valueAsNumber));
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
    else if (!getDraft() && !getIdleDraft()?.end && !ready(getClip())) return;
    else if (key === 'ArrowLeft' || key === 'ArrowRight') step(key === 'ArrowRight' ? 1 : -1);
    else if (key === ' ' && !event.repeat && !event.target.closest?.('button, a')) togglePlay();
    else return;
    event.preventDefault();
  });
  return { sync, updatePosition, reset, closeFloating, pause, seek, step, togglePlay };
};

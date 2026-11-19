'use strict';

window.mountPlayerTools = ({ panel, getClip, isEditor, isTrack, validClip, notify, onImageTime }) => {
  const find = (selector) => panel.querySelector(selector);
  const video = find('#preview');
  const image = find('#still-preview');
  const frame = find('.player-picture');
  const transport = find('#player-transport');
  const play = find('#player-play');
  const position = find('#player-position');
  const ratio = document.querySelector('#ratio');
  const float = find('#player-float');
  const full = find('#player-fullscreen');
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
  function updatePosition() {
    const clip = getClip();
    const seconds = ready(clip) ? Math.max(clip.start, Math.min(clip.end,
      clip.asset.kind === 'image' ? imagePosition() : video.currentTime)) : 0;
    find('#player-time').textContent = timecode(seconds, fps(clip));
    position.value = seconds;
    if (clip?.asset.kind === 'image' && ready(clip)) onImageTime?.(clip, seconds);
  }
  function tick() {
    cancelAnimationFrame(animation);
    const clip = getClip();
    if (imagePlaying() && imagePosition() >= clip.end) {
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
    transport.hidden = !isEditor();
    video.controls = !isEditor();
    const active = ready(clip);
    for (const button of panel.querySelectorAll('.player-buttons button')) button.disabled = !active;
    position.disabled = !active;
    position.min = active ? clip.start : 0;
    position.max = active ? clip.end : 1;
    const playing = active && (clip.asset.kind === 'image' ? imagePlaying() : !video.paused);
    play.textContent = playing ? '❚❚' : '▶';
    play.setAttribute('aria-label', playing ? '暂停' : '播放');
    play.title = `${play.getAttribute('aria-label')}（空格）`;
    find('#player-ratio').value = ratio.value;
    find('#player-ratio').disabled = ratio.matches(':disabled');
    frame.toggleAttribute('data-project-frame', Boolean(clip && isTrack()));
    const [width, height] = ratio.value.split(':').map(Number);
    frame.style.setProperty('--picture-ratio', width / height);
    frame.style.setProperty('--picture-background', document.querySelector('#background-color').value);
    frame.style.setProperty('--picture-fit', document.querySelector('#fit').value === 'fill' ? 'cover' : 'contain');
    updatePosition();
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
    const clip = getClip();
    if (!ready(clip)) return;
    pause();
    seek((clip.asset.kind === 'image' ? imageTime : video.currentTime) + direction / fps(clip));
  }
  async function togglePlay() {
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
    if (panel.matches(':popover-open') || document.pictureInPictureElement === video) return closeFloating();
    if (document.fullscreenElement === panel) await document.exitFullscreen();
    if (getClip()?.asset.kind === 'video' && video.readyState >= 2 && document.pictureInPictureEnabled) {
      try { await video.requestPictureInPicture(); return; } catch { /* Use the floating editor panel when system PiP is unavailable. */ }
    }
    panel.setAttribute('popover', 'manual');
    panel.showPopover();
    float.setAttribute('aria-pressed', 'true');
  });
  video.addEventListener('enterpictureinpicture', () => float.setAttribute('aria-pressed', 'true'));
  video.addEventListener('leavepictureinpicture', () => float.setAttribute('aria-pressed', String(panel.matches(':popover-open'))));
  const heading = find('.panel-heading');
  heading.addEventListener('pointerdown', (event) => {
    if (!panel.matches(':popover-open') || event.button !== 0) return;
    const bounds = panel.getBoundingClientRect();
    drag = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    heading.setPointerCapture(event.pointerId);
  });
  heading.addEventListener('pointermove', (event) => {
    if (!drag) return;
    panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, event.clientX - drag.x))}px`;
    panel.style.top = `${Math.max(0, Math.min(innerHeight - panel.offsetHeight, event.clientY - drag.y))}px`;
  });
  heading.addEventListener('lostpointercapture', () => { drag = null; });
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
  document.addEventListener('fullscreenchange', () => full.setAttribute('aria-pressed', String(document.fullscreenElement === panel)));
  play.addEventListener('click', togglePlay);
  find('#player-previous').addEventListener('click', () => step(-1));
  find('#player-next').addEventListener('click', () => step(1));
  find('#player-stop').addEventListener('click', () => { pause(); seek(getClip().start); });
  position.addEventListener('input', () => seek(position.valueAsNumber));
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
      || event.shiftKey || document.querySelector('dialog[open], :popover-open, .app-frame[data-navigation="floating"]')
      || !(target instanceof Element) || target.isContentEditable
      || target.closest('input, textarea, select, [role="textbox"], [role="tab"], [role="separator"]')) return;
    const onPlayer = panel.contains(target) && (!target.closest('button, a') || target.closest('.player-buttons'));
    const onTimeline = target.matches('#timeline-clock, #timeline-tracks-panel, #timeline-clock .sequence-block:not(.sequence-empty)');
    if (target !== document.body && !onPlayer && !onTimeline) return;
    if (key === '.' && !event.repeat) toggleFullscreen();
    else if (!ready(getClip())) return;
    else if (key === 'ArrowLeft' || key === 'ArrowRight') step(key === 'ArrowRight' ? 1 : -1);
    else if (key === ' ' && !event.repeat && !event.target.closest?.('button, a')) togglePlay();
    else return;
    event.preventDefault();
  });
  return { sync, reset, closeFloating, pause, seek, step, togglePlay };
};

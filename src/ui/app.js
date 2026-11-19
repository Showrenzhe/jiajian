'use strict';

const $ = (selector) => document.querySelector(selector);
const api = window.workbench;
const shots = [];
const mutedVideoTracks = new Set();
const audioTargets = [];
const maxShots = 1000;
const maxCandidates = 100;
const maxExports = 50;
const maxExtraWholeTracks = 249;
const minClipSeconds = 0.1;
const maxStillSeconds = 60;
const music = [];
let musicStartFrom = null;
const segmentNarrations = new WeakMap();
const shotTransitions = new WeakMap();
const shotProperties = new WeakMap();
let primaryVoiceFollow=null;
const voiceEdits = new WeakMap();
const packaging = window.createTimelinePackaging();
let sceneCuts = [];
let editCover;
let timeline;
let cutEditor;
const clipRows = new WeakMap();
const trackPreviewButtons = new WeakMap();
const editAssets = new Map();
const materialAliases = new Map();
const materialBins = new Map();
function currentMaterialBin(scope = subprojects.active?.id ?? null) {
  if (!materialBins.has(scope)) materialBins.set(scope, {ids:new Set(), hidden:new Set()});
  return materialBins.get(scope);
}
const sourceNames = new Map();
let volumeOverrides=[];
const processedMaterials = [];
const subprojects = window.createSubprojects({ shots, serialize: serializeClip, revive: (row) => reviveClip(row, editAssets),voiceIO:{read:readScopeVoice,write:writeScopeVoice} });
const narrationCaptions = new Map();
const extraWholeTracks = [];
let narration = null;
let subtitles = null;
let mode = 'home';
let operation = '';
let selected;
let proxyResume;
let pendingTimelineSeek;
let previewBatch;
let timelinePlaybackRequest;
let projectName = '';
let attachedScript = null;
let activeWorkflow = '';
let scriptWorkspace;
let workflowManifest;
let editHistory;
let editBaseline;
let applyingEdit = false;
let selectedTrackRow;
let volumeTarget;
let reviewNarration;
let reviewCaptionText = '';
let cloudTtsDialog;
let cloudTtsSettingsDialog;

const player = $('#preview');
const still = $('#still-preview');
const captionInspector = window.mountCaptionInspector({
  api, player, still,
  sourceCue: () => {
    const segmented = $('#narration-mode').value === 'segmented';
    const voice = segmented
      ? shots.flatMap((shot)=>segmentNarrations.get(shot) ?? []).map((asset)=>narrationCaptions.get(asset?.id)).find(Boolean)
      : subtitles || narrationCaptions.get(narration?.id) || extraWholeTracks.map((row)=>row.subtitles || narrationCaptions.get(row.narration?.id)).find(Boolean);
    const source = selected?.videoSubtitles || voice || shots.flat().find((clip)=>clip.videoSubtitles)?.videoSubtitles;
    return typeof source === 'string' ? {text:source} : source?.cues?.[0];
  },
});
const playerTools = window.mountPlayerTools({
  panel: $('.editor-player'), getClip: () => selected, isEditor: () => mode === 'montage',
  isTrack: () => $('#preview-heading').textContent === '轨道预览', validClip, notify: say,
  onImageTime:(clip,time)=>timeline?.syncPlayer(clip,time),
});
const notice = $('#notice');
const countField = $('#count');

function setupTabs(tablist, onChange) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const segmented = tablist.classList.contains('p-segmented');
  if (segmented) {
    tablist.style.setProperty('--p-seg-count', tabs.length);
    tablist.style.setProperty('--p-seg-index', Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')));
  }
  function activate(tab, focus = false) {
    if (tab.disabled) return;
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    if (segmented) tablist.style.setProperty('--p-seg-index', tabs.indexOf(tab));
    onChange?.();
    if (focus) tab.focus();
  }
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) activate(tab);
  });
  tablist.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = tabs.filter((tab) => !tab.disabled);
    const current = available.indexOf(event.target);
    if (current < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (current + step + available.length) % available.length;
    activate(available[next], true);
  });
  return activate;
}

const activateInspectorTab = setupTabs($('#inspector-tabs'));
const activateTimelineTab = setupTabs($('.timeline-header [role="tablist"]'), updateTrackScrollbar);
const shotViewport = $('#shots');
const visualTrackLane = $('#visual-track-lane');
const narrationTrackLane = $('#narration-track-lane');
const trackScrollbar = $('#track-horizontal-scroll');
const trackExpansion = new WeakMap();
const trackDisclosures = new WeakMap();
let trackPartId = 0;

function bindTrackDisclosure(toggle, body, owner, part, label, initiallyExpanded = true) {
  body.id ||= `track-part-${++trackPartId}`;
  toggle.setAttribute('aria-controls', body.id);
  let parts = trackExpansion.get(owner);
  if (!parts) {
    parts = new Map();
    trackExpansion.set(owner, parts);
  }
  const setExpanded = (expanded) => {
    parts.set(part, expanded);
    body.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = `${expanded ? '折叠' : '展开'}${label}`;
    toggle.setAttribute('aria-label', toggle.title);
  };
  setExpanded(parts.get(part) ?? initiallyExpanded);
  trackDisclosures.set(toggle, setExpanded);
  toggle.addEventListener('click', () => setExpanded(body.hidden));
}

function setAllTrackDisclosures(expanded) {
  timeline?.fold(expanded);
  for (const toggle of document.querySelectorAll('#timeline-tracks-panel .track-disclosure')) {
    if (!toggle.closest('#script-brief[hidden], #narration-track-lane[hidden]')) trackDisclosures.get(toggle)(expanded);
  }
}

const mirroredScroll = new WeakMap();

function mirrorScroll(source, target) {
  if (Math.abs(target.scrollLeft - source.scrollLeft) < 0.5) return;
  target.scrollLeft = source.scrollLeft;
  mirroredScroll.set(target, target.scrollLeft);
}

function onTrackScroll(source, target) {
  const mirrored = mirroredScroll.get(source);
  mirroredScroll.delete(source);
  if (!trackScrollbar.hidden && source.scrollLeft !== mirrored) mirrorScroll(source, target);
}

function updateTrackScrollbar() {
  const viewport = activeTrackViewport();
  const overflow = viewport.scrollWidth - viewport.clientWidth;
  trackScrollbar.hidden = $('#timeline-tracks-panel').hidden || overflow <= 0;
  trackScrollbar.setAttribute('aria-controls', viewport.id);
  if (trackScrollbar.hidden) return;
  const size = `${overflow}px`;
  if (trackScrollbar.style.getPropertyValue('--track-horizontal-overflow') !== size) {
    trackScrollbar.style.setProperty('--track-horizontal-overflow', size);
  }
  mirrorScroll(viewport, trackScrollbar);
}

function activeTrackViewport() {
  return $('#timeline-view').value === 'time' ? $('#timeline-clock') : shotViewport;
}

const trackSizeObserver = new ResizeObserver(updateTrackScrollbar);
for (const viewport of [shotViewport, $('#timeline-clock')]) {
  trackSizeObserver.observe(viewport);
  viewport.addEventListener('scroll', () => {
    if (viewport === activeTrackViewport()) onTrackScroll(viewport, trackScrollbar);
  });
}
trackScrollbar.addEventListener('scroll', () => onTrackScroll(trackScrollbar, activeTrackViewport()));

const panelLayout = window.mountPanelLayout($('#editor-workspace'), { actions: $('#workbench-actions') });
function importFromHome() {
  setMode('montage');
  return importMaterials();
}

const draftLibrary = window.mountDraftLibrary($('#draft-library'), {
  load: api.listDrafts, open: openDraft, importMaterials: importFromHome,
});
const draftAutosave = window.createDraftAutosave({
  create: api.createDraft,
  save: api.saveDraft,
  onState(state, error) {
    const status = $('#draft-save-status');
    status.dataset.state = state;
    status.textContent = {
      idle: '自动保存草稿', pending: '草稿待保存', saving: '正在保存草稿…',
      saved: '草稿已保存', error: '草稿保存失败',
    }[state];
    status.title = error?.message ?? status.textContent;
  },
});
api.onBeforeDraftClose(() => draftAutosave.flush());
const thumbnailQueue = [];
let thumbnailsLoading = 0;
const materialFolders = new Map();
const selectedMaterials = new Map();
const materialPanel = $('.editor-materials');
const libraryWaves = window.mountWaveforms(materialPanel);
const reviewWaveform = window.attachPlayerWaveform($('#narration-review-audio'));
const materialList = $('#material-list');
const materialItems = new WeakMap();
const materialMarquee = document.createElement('div');
materialMarquee.className = 'material-marquee';
materialMarquee.hidden = true;
materialMarquee.setAttribute('aria-hidden', 'true');
materialPanel.append(materialMarquee);
const materialDragType = 'application/x-sd-workbench-material';
let materialFolderPath = [];
let materialBrowseRequest = 0;
let materialPreviewRequest = 0;
let previewedMaterial;
let materialDrag;
let materialDropTarget;
let materialToAdd;
let materialSelectionDrag;
const sceneSplitInputs = [];
let sceneSplitOutput = '';

function loadMaterialThumbnails() {
  while (thumbnailsLoading < 4 && thumbnailQueue.length) {
    const target = thumbnailQueue.shift();
    if (!target.isConnected) continue;
    thumbnailsLoading += 1;
    api.videoThumbnail(target.dataset.materialId).then((url) => {
      if (!url || !target.isConnected) return;
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.addEventListener('load', () => target.querySelector('.material-thumbnail, .shot-poster-image').replaceChildren(image), { once: true });
      image.src = url;
    }).catch(() => {}).finally(() => {
      thumbnailsLoading -= 1;
      loadMaterialThumbnails();
    });
  }
}

function queueVisibleThumbnails(entries, observer) {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting || !target.isConnected) continue;
    observer.unobserve(target);
    thumbnailQueue.push(target);
  }
  loadMaterialThumbnails();
}
const thumbnailObserver = new IntersectionObserver(queueVisibleThumbnails, { root: materialPanel, rootMargin: '100px' });
const shotThumbnailObserver = new IntersectionObserver(queueVisibleThumbnails, { root: shotViewport, rootMargin: '100px' });

function say(message) {
  notice.textContent = message;
  notice.hidden = !message;
}

function candidate(asset) {
  asset=editAssets.get(asset.id)??asset;
  return { asset, start: 0, end: asset.kind === 'image' ? 3 : asset.duration, volume: 100, speed: 1 };
}

function describe(asset) {
  const size = `${asset.width} × ${asset.height}`;
  if (asset.kind === 'image') return `${size} · 图片`;
  return `${size} · ${asset.duration.toFixed(2)} 秒 · ${asset.codec.toUpperCase()}${asset.hasAudio ? '' : ' · 无音轨'}`;
}

function validClip(clip) {
  if (clip.asset.kind === 'image') return clip.end >= minClipSeconds && clip.end <= maxStillSeconds;
  return Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0
    && clip.end <= clip.asset.duration && clip.end - clip.start >= minClipSeconds - 1e-9
    && clip.speed >= 0.5 && clip.speed <= 3;
}

function seekPreview() {
  if (selected?.asset.kind === 'video' && player.readyState >= 1 && validClip(selected)) player.currentTime = selected.start;
}

function seekTimelineVideo(clip, time) {
  const target=Math.max(clip.start,Math.min(clip.end,time));
  if(proxyResume?.clip===clip) proxyResume.time=target;
  if(player.readyState && player.currentSrc===player.getAttribute('src')) {
    pendingTimelineSeek=undefined;
    player.currentTime=target;
  } else pendingTimelineSeek={clip,time:target};
}

function preview(clip, heading, materialId) {
  const request = ++materialPreviewRequest;
  proxyResume = undefined;
  pendingTimelineSeek = undefined;
  previewedMaterial = materialId;
  selected = clip;
  heading ??= mode === 'montage' && trackShot() ? '轨道预览' : '素材预览';
  player.pause();
  const isImage = clip.asset.kind === 'image';
  if (isImage && document.pictureInPictureElement === player) playerTools.closeFloating();
  player.playbackRate = clip.speed >= 0.5 && clip.speed <= 3 ? clip.speed : 1;
  const usingProxy = heading === '轨道预览' && player.dataset.proxyFor === clip.asset.id && !player.error;
  if (!usingProxy) delete player.dataset.proxyFor;
  if (isImage) {
    still.src = clip.asset.url;
    if (still.complete) setPreviewAspect(still.naturalWidth, still.naturalHeight);
  } else if (!usingProxy && (player.getAttribute('src') !== clip.asset.url || player.error)) {
    player.src = clip.asset.url;
  } else {
    setPreviewAspect(player.videoWidth, player.videoHeight);
    seekPreview();
  }
  player.hidden = isImage;
  still.hidden = !isImage;
  $('.player-picture').hidden = false;
  $('#preview-hint').hidden = true;
  $('#preview-heading').textContent = heading;
  $('#preview-meta').textContent = isImage ? '图片' : `${usingProxy ? '流畅预览' : heading === '素材预览' ? '原片' : '视频'} · ${clip.asset.duration.toFixed(2)} 秒`;
  if (!isImage && !clip.asset.alpha && heading === '轨道预览' && !usingProxy && Math.max(clip.asset.width, clip.asset.height) > 640) {
    api.trackProxy(clip.asset.id).then((url) => {
      if (!url || selected !== clip || materialPreviewRequest !== request) return;
      proxyResume = { clip, url, time: pendingTimelineSeek?.time ?? (player.readyState ? player.currentTime : clip.start), playing: !player.paused };
      player.dataset.proxyFor = clip.asset.id;
      player.src = url;
      player.hidden = false;
      $('.player-picture').hidden = false;
      $('#preview-hint').hidden = true;
      $('#preview-meta').textContent = `流畅预览 · ${clip.asset.duration.toFixed(2)} 秒`;
    }).catch(() => {});
  }
  $('#preview-name').textContent = clip.asset.name;
  $('#preview-name').hidden = false;
  $('.preview-readout-name').textContent = clip.asset.name;
  updatePreviewTimecode(isImage ? 0 : clip.start);
  if (mode === 'montage' && heading !== '成片预览') activateInspectorTab($('#inspector-tab-visual'));
  syncClipInspector();
  playerTools.reset();
  timeline?.selectClip(clip);
  updateMaterialSelection();
  updateTrackSelection();
}

function clearPreview() {
  materialPreviewRequest += 1;
  proxyResume = undefined;
  pendingTimelineSeek = undefined;
  delete player.dataset.proxyFor;
  previewedMaterial = undefined;
  selected = undefined;
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
  still.removeAttribute('src');
  still.hidden = true;
  $('.player-picture').hidden = true;
  $('#preview-heading').textContent = '素材预览';
  $('#preview-meta').textContent = '';
  $('#preview-name').hidden = true;
  $('#preview-hint').textContent = mode === 'montage' ? '在素材库或轨道选择一个素材' : '选择素材进行预览';
  $('#preview-hint').hidden = false;
  syncClipInspector();
  playerTools.reset();
  updateMaterialSelection();
  updateTrackSelection();
}

player.addEventListener('loadedmetadata', () => {
  if (!player.hidden) setPreviewAspect(player.videoWidth, player.videoHeight);
  if (selected?.speed >= 0.5 && selected.speed <= 3) player.playbackRate = selected.speed;
  if (pendingTimelineSeek && pendingTimelineSeek.clip === selected) {
    player.currentTime = pendingTimelineSeek.time;
    pendingTimelineSeek = undefined;
    proxyResume = undefined;
  } else if (proxyResume?.clip === selected && proxyResume?.url === player.currentSrc) {
    const resume = proxyResume;
    proxyResume = undefined;
    player.currentTime = Math.max(selected.start, Math.min(selected.end, resume.time));
    if (resume.playing) player.play().catch(() => {});
  } else seekPreview();
  updateTrackSelection();
});
function setPreviewAspect(width, height) {
  if (width && height) player.closest('.preview-stage').style.setProperty('--preview-ratio', width / height);
}
still.addEventListener('load', () => {
  if (!still.hidden) setPreviewAspect(still.naturalWidth, still.naturalHeight);
});
player.addEventListener('seeked', updateTrackSelection);
player.addEventListener('play', () => {
  if (selected && (player.currentTime < selected.start || player.currentTime >= selected.end)) seekPreview();
});
player.addEventListener('timeupdate', () => {
  if (selected?.asset.kind === 'video' && !player.paused && player.currentTime >= selected.end) {
    player.pause();
    if (validClip(selected) && player.currentTime > selected.end) player.currentTime = selected.end;
  }
  if (selected && !player.hidden) updatePreviewTimecode(player.currentTime);
  updateTrackSelection();
});
function updatePreviewTimecode(seconds) {
  const milliseconds = Math.max(0, Math.round((seconds || 0) * 1000));
  const whole = Math.floor(milliseconds / 1000);
  const minutes = String(Math.floor(whole / 60)).padStart(2, '0');
  const remainder = String(whole % 60).padStart(2, '0');
  const fraction = String(milliseconds % 1000).padStart(3, '0');
  $('.preview-timecode').textContent = selected?.asset.kind === 'image' ? '图片' : `${minutes}:${remainder}.${fraction}`;
}
function previewError(kind, element) {
  if (selected?.asset.kind !== kind) return;
  element.hidden = true;
  $('.player-picture').hidden = true;
  $('#preview-hint').textContent = '播放器暂不支持此编码，可继续尝试导出。';
  $('#preview-hint').hidden = false;
}

player.addEventListener('error', () => previewError('video', player));
still.addEventListener('error', () => previewError('image', still));

function template(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}

function bindTrackPreview(button, clip) {
  trackPreviewButtons.set(button, clip);
  if (clip.asset.kind === 'video') {
    const hint = '选中后，空格播放或暂停，左右键微调播放头';
    button.title = `${clip.asset.name} · ${hint}`;
    button.setAttribute('aria-description', hint);
    button.setAttribute('aria-keyshortcuts', 'Space ArrowLeft ArrowRight');
  }
  button.addEventListener('click', () => preview(clip));
}

function syncClipInspector() {
  const inspector = $('#clip-inspector');
  const shot = trackShot();
  inspector.hidden = !shot;
  if (!shot) return;
  const { asset } = selected;
  const image = asset.kind === 'image';
  $('#clip-inspector-name').textContent = asset.name;
  $('#clip-inspector-meta').textContent = describe(asset);
  $('#clip-enabled').checked = selected.enabled !== false;
  $('#clip-track-muted').checked = mutedVideoTracks.has(shot.indexOf(selected));
  $('#clip-end-label').textContent = image ? '停留（秒）' : '出点（秒）';
  for (const input of inspector.querySelectorAll('[data-clip-field]')) {
    const key = input.dataset.clipField;
    input.parentElement.hidden = image && key !== 'end';
    if (key !== 'speed') input.max = image ? maxStillSeconds : asset.duration;
    if (!Object.is(input.valueAsNumber, selected[key])) input.value = Number.isFinite(selected[key]) ? selected[key] : '';
  }
}

function setCandidateEnabled(clip, enabled) {
  if (operation || !shots.some((shot) => shot.includes(clip))) return;
  if (enabled) delete clip.enabled;
  else clip.enabled = false;
  syncClipInspector();
  renderLists();
}

function setVisualTrackMuted(index, muted) {
  if (operation || !Number.isInteger(index) || index < 0 || index >= maxCandidates) return;
  if (muted) mutedVideoTracks.add(index);
  else mutedVideoTracks.delete(index);
  syncClipInspector();
  renderLists();
}

$('#clip-enabled').addEventListener('change', (event) => setCandidateEnabled(selected, event.target.checked));
let foregroundProgress;
async function cutoutAsset(asset) {
  if (operation || !asset) return null;
  operation = 'foreground';
  const modal = document.createElement('dialog');
  modal.className = 'layer-motion-dialog';
  modal.setAttribute('aria-label', 'AI 前景抠像');
  const title = document.createElement('h2'); title.textContent = 'AI 前景抠像';
  const label = document.createElement('p'); label.textContent = '正在识别「' + asset.name + '」中的人物和物品';
  const bar = document.createElement('progress'); bar.max = 1; bar.value = 0; bar.className = 'foreground-progress';
  const close = document.createElement('button'); close.textContent = '取消抠像';
  let cancelling = false;
  const cancel = () => {
    if (cancelling) return;
    cancelling = true; close.disabled = true; label.textContent = '正在取消…'; api.cancel().catch(() => {});
  };
  close.onclick = cancel; modal.oncancel = (event) => { event.preventDefault(); cancel(); };
  foregroundProgress = bar;
  modal.append(title, label, bar, close); document.body.append(modal); modal.showModal(); updateControls();
  try {
    const result = await api.createForeground(asset.id);
    if (cancelling || !result) return null;
    editAssets.set(result.id, result);
    return result;
  } catch (error) {
    if (!cancelling) say(error.message);
    return null;
  } finally {
    foregroundProgress = null; modal.close(); modal.remove(); operation = ''; updateControls();
  }
}
$('#clip-foreground').addEventListener('click', async () => {
  const clip = selected;
  if (!trackShot() || operation) return;
  const asset = await cutoutAsset(clip.asset);
  if (asset && shots.some((shot) => shot.includes(clip))) {
    clip.asset = asset;
    if (asset.kind === 'video') clip.end = Math.min(clip.end, asset.duration);
    preview(clip, '轨道预览'); renderLists(); say('已将当前候选替换为透明前景素材。');
  }
});
$('#clip-motion').addEventListener('click', async()=>{
  const clip=selected;
  if (!trackShot() || operation) return;
  const duration=clip.end-clip.start;
  const changed=await window.editLayerMotion({kind:'candidate',...clip.transform,start:0,end:duration}, {url:clip.asset.url,kind:clip.asset.kind,duration,sourceStart:clip.start});
  if (changed && shots.some((shot)=>shot.includes(clip))) {
    clip.transform=Object.fromEntries(['x','y','scale','rotation','opacity','keyframes','mask'].filter((key)=>changed[key]!=null).map((key)=>[key,changed[key]]));
    renderLists();
  }
});
$('#clip-track-muted').addEventListener('change', (event) => {
  const shot = trackShot();
  if (shot) setVisualTrackMuted(shot.indexOf(selected), event.target.checked);
});

$('#clip-inspector').addEventListener('input', (event) => {
  const key = event.target.dataset.clipField;
  if (!key || !trackShot() || operation) return;
  const input = clipRows.get(selected)?.querySelector(`.${key}`);
  if (!input) return;
  input.value = event.target.value;
  input.dispatchEvent(new Event('input'));
});

function assetRow(clip, list, trim) {
  const row = template('#asset-template');
  row.tabIndex = 0;
  if (trim) clipRows.set(clip, row);
  const label = row.querySelector('.asset-name');
  label.textContent = clip.asset.name;
  label.title = clip.asset.name;
  const meta=row.querySelector('.asset-meta');
  function updateDuration() {
    const seconds=window.candidatePlaybackSeconds(clip);
    meta.textContent=trim && Number.isFinite(seconds) ? '候选 '+seconds.toFixed(2)+' 秒 · '+describe(clip.asset) : describe(clip.asset);
  }
  updateDuration();
  bindTrackPreview(row.querySelector('.preview-asset'), clip);
  row.addEventListener('click', (event) => {
    if (!event.target.closest('button, input, select, textarea, label')) preview(clip);
  });
  row.querySelector('.remove-asset').addEventListener('click', () => {
    list.splice(list.indexOf(clip), 1);
    if (selected === clip) clearPreview();
    renderLists();
  });
  row.querySelector('.trim-fields').hidden = !trim;
  if (trim) {
    const toggle = row.querySelector('.clip-toggle');
    toggle.hidden = false;
    bindTrackDisclosure(toggle, row.querySelector('.trim-fields'), clip, 'trim', `${clip.asset.name} 的参数`, !validClip(clip));
    const isImage = clip.asset.kind === 'image';
    row.querySelector('.speed-field').hidden = isImage;
    if (isImage) {
      row.querySelector('.start').parentElement.hidden = true;
      row.querySelector('.end-label').textContent = '停留（秒）';
    }
    row.classList.toggle('invalid', !validClip(clip));
    for (const field of isImage ? ['end'] : ['start', 'end', 'speed']) {
      const input = row.querySelector(`.${field}`);
      input.value = Number.isFinite(clip[field]) ? clip[field] : '';
      if (field !== 'speed') input.max = isImage ? maxStillSeconds : clip.asset.duration;
      input.disabled = Boolean(operation);
      if (isImage) input.min = minClipSeconds;
      input.addEventListener('input', () => {
        clip[field] = input.valueAsNumber;
        if (clip.ranges && field!=='speed' && validClip(clip)) clip.ranges=window.trimRetainedRanges(clip.ranges,clip.start,clip.end);
        updateDuration();
        if (field === 'speed' && selected === clip && clip.speed >= 0.5 && clip.speed <= 3) player.playbackRate = clip.speed;
        if (selected === clip) syncClipInspector();
        row.classList.toggle('invalid', !validClip(clip));
        updateControls(input);
      });
      input.addEventListener('blur', () => updateControls());
    }
  }
  return row;
}

function swapShot(index, destination) {
  [shots[index], shots[destination]] = [shots[destination], shots[index]];
  renderLists();
}

function captionText(caption) {
  return caption?.cues ? caption.cues.map((cue) => cue.text).join('\n') : caption;
}

function showSegmentCaption(element, assetId) {
  const text = captionText(narrationCaptions.get(assetId)) ?? '';
  element.dataset.captionAsset = assetId;
  element.textContent = text;
  element.title = text;
  element.hidden = !text;
}

function segmentNarrationRow(tracks, index, shotIndex) {
  const row = template('#segment-narration-template');
  row.tabIndex = 0;
  const asset = tracks[index];
  const number = index + 1;
  row.dataset.track = number;
  row.querySelector('.segment-track-number').textContent = `口播轨 ${number}`;
  bindTrackDisclosure(row.querySelector('.segment-track-toggle'), row.querySelector('.segment-track-actions'),
    tracks, index, `口播轨 ${number}`);
  const name = row.querySelector('.segment-narration-name');
  name.textContent = asset ? `${asset.name} · ${asset.duration.toFixed(2)} 秒` : '未添加';
  name.title = asset?.name ?? '';
  if (asset) showSegmentCaption(row.querySelector('.segment-caption'), asset.id);
  const choose = row.querySelector('.pick-segment-narration');
  choose.textContent = asset ? '更换口播' : '添加口播';
  choose.setAttribute('aria-label', `${choose.textContent}，口播轨 ${number}`);
  choose.addEventListener('click', () => pick('narration', 1, ([picked]) => {
    if (picked) tracks[index] = picked;
  }));
  const review = row.querySelector('.review-segment-narration');
  review.hidden = !asset;
  review.setAttribute('aria-label', `${shotLabel(shotIndex)}口播轨 ${number}，试听／字幕`);
  review.addEventListener('click', () => openNarrationReview(asset, attachedScript?.segmented[shotIndex]?.dialogue, false, shotLabel(shotIndex)));
  const remove = row.querySelector('.remove-segment-narration');
  remove.hidden = !asset && index !== tracks.length - 1;
  remove.setAttribute('aria-label', `移除口播轨 ${number} 的音频`);
  remove.addEventListener('click', () => {
    if (operation) return;
    tracks[index] = null;
    while (tracks.at(-1) === null) {
      trackExpansion.get(tracks)?.delete(tracks.length - 1);
      tracks.pop();
    }
    renderLists();
  });
  return row;
}

function shotLabel(index) {
  return shotProperties.get(shots[index])?.name || `分镜 ${String(index + 1).padStart(2, '0')}`;
}

function shotRow(shot, index) {
  const row = template('#shot-template');
  row.dataset.shotIndex = index;
  const shotName = shotLabel(index);
  row.querySelector('.shot-name').textContent = shotName;
  if (shot.length) {
    const first = shot[0];
    const poster = row.querySelector('.shot-poster');
    poster.hidden = false;
    poster.dataset.materialId = first.asset.id;
    poster.setAttribute('aria-label', `预览${shotName} · ${first.asset.name}`);
    poster.title = first.asset.name;
    poster.querySelector('.shot-poster-caption').textContent = first.asset.name;
    if (first.asset.kind === 'image') {
      const image = new Image();
      image.loading = 'lazy';
      image.alt = '';
      image.src = first.asset.url;
      poster.querySelector('.shot-poster-image').append(image);
    } else {
      shotThumbnailObserver.observe(poster);
    }
    bindTrackPreview(poster, first);
  }
  bindTrackDisclosure(row.querySelector('.shot-toggle'), row.querySelector('.shot-body'), shot, 'body', shotName);
  row.querySelector('.shot-size').textContent = `${shot.length} 条候选`;
  row.querySelector('.no-candidates').hidden = shot.length > 0;
  const up = row.querySelector('.move-up');
  up.disabled = index === 0;
  up.addEventListener('click', () => swapShot(index, index - 1));
  const down = row.querySelector('.move-down');
  down.disabled = index === shots.length - 1;
  down.addEventListener('click', () => swapShot(index, index + 1));
  row.querySelector('.remove-shot').addEventListener('click', () => {
    if (shot.includes(selected)) clearPreview();
    shots.splice(index, 1);
    renderLists();
  });
  row.querySelector('.add-candidate').addEventListener('click', () => importCandidates(shot));
  row.querySelector('.candidates').append(...shot.map((clip) => assetRow(clip, shot, true)));
  const transition = shotTransitions.get(shot);
  const kind = row.querySelector('.shot-transition-kind');
  const duration = row.querySelector('.shot-transition-duration');
  const durationField = row.querySelector('.shot-transition-time');
  kind.value = transition?.kind ?? 'none';
  duration.value = transition ? transition.duration ?? '' : 0.4;
  durationField.hidden = kind.value === 'none';
  const transitionSummary = row.querySelector('.shot-transition-summary');
  const updateTransitionSummary = () => { transitionSummary.textContent = `转场 · ${kind.selectedOptions[0].textContent}`; };
  updateTransitionSummary();
  bindTrackDisclosure(row.querySelector('.transition-toggle'), row.querySelector('.shot-transition-fields'), shot, 'transition', `${shotName}的转场`, Boolean(transition));
  kind.addEventListener('change', () => {
    if (kind.value === 'none') shotTransitions.delete(shot);
    else {
      if (!duration.checkValidity() || !duration.value) duration.value = 0.4;
      shotTransitions.set(shot, { kind: kind.value, duration: duration.valueAsNumber });
    }
    durationField.hidden = kind.value === 'none';
    updateTransitionSummary();
    updateControls();
  });
  duration.addEventListener('input', () => {
    shotTransitions.set(shot, { kind: kind.value, duration: duration.valueAsNumber });
    updateControls(duration);
  });
  duration.addEventListener('blur', () => updateControls());
  return row;
}

function segmentNarrationPanel(shot, index) {
  const row = template('#segment-narration-panel-template');
  row.dataset.shotIndex = index;
  const shotName = shotLabel(index);
  const tracks = segmentNarrations.get(shot) ?? [];
  row.querySelector('.segment-narration-title').textContent = `${shotName} · ${tracks.length} 轨`;
  bindTrackDisclosure(row.querySelector('.segment-toggle'), row.querySelector('.segment-narration-body'), shot, 'segments', `${shotName}的分段口播`);
  row.querySelector('.segment-narration-tracks').append(...tracks.map((_, trackIndex) => segmentNarrationRow(tracks, trackIndex, index)));
  const matchVisual = row.querySelector('.match-shot-visual');
  matchVisual.hidden = !tracks.some(Boolean);
  matchVisual.setAttribute('aria-label', `给${shotName}添加画面`);
  matchVisual.addEventListener('click', async () => {
    const heldFocus = document.activeElement === matchVisual;
    const previousCount = shot.length;
    await importCandidates(shot);
    const added = shot[previousCount];
    if (added) preview(added);
    if (heldFocus && mode === 'montage' && document.activeElement === document.body) {
      const next = added ? visualTrackLane.querySelector(`[data-shot-index="${shots.indexOf(shot)}"] .shot-poster`)
        : narrationTrackLane.querySelector(`[data-shot-index="${shots.indexOf(shot)}"] .match-shot-visual`);
      next?.focus();
    }
  });
  row.querySelector('.add-segment-narration').addEventListener('click', () => {
    if (operation || tracks.length > maxExtraWholeTracks) return;
    trackExpansion.get(shot)?.delete('segments');
    tracks.push(null);
    segmentNarrations.set(shot, tracks);
    renderLists();
  });
  return row;
}

function renderLists() {
  subprojects.applyFallbacks();
  renderSubprojectPicker();
  shotViewport.style.setProperty('--shot-count', Math.max(1, shots.length));
  shotThumbnailObserver.disconnect();
  visualTrackLane.replaceChildren(visualTrackLane.firstElementChild, ...shots.map(shotRow));
  narrationTrackLane.replaceChildren(narrationTrackLane.firstElementChild, ...shots.map(segmentNarrationPanel));
  $('#audio-list').replaceChildren(...audioTargets.map((clip) => assetRow(clip, audioTargets, false)));
  $('#shots-empty').hidden = shots.length > 0;
  $('#tracks-expand-all').disabled = $('#tracks-collapse-all').disabled = !shots.length && !attachedScript;
  $('#audio-empty').hidden = audioTargets.length > 0;
  $('#shot-summary').textContent = `${shots.length} 组`;
  $('#audio-summary').textContent = `${audioTargets.length} 条`;
  renderMusicStart();
  renderMaterials();
  updateControls();
  updateTrackScrollbar();
}

function renderSubprojectPicker() {
  const select = $('#subproject-select');
  select.replaceChildren(new Option('主工程 · 公共素材', ''), ...subprojects.projects.map((item) => new Option(item.name, item.id)));
  select.value = subprojects.active?.id ?? '';
  $('#subproject-materials').hidden = !subprojects.active;
  $('#subproject-batch').hidden = !subprojects.projects.length;
  $('#subproject-fill').hidden = !subprojects.projects.length || !shots.length;
  $('#subproject-variables').hidden=!subprojects.active;
}

function selectedSubprojectScope() {
  const scope = [];
  for (const row of $('#subproject-batch-list').children) {
    if (row.querySelector('input[type=checkbox]').checked) scope.push({ id: row.dataset.id, count: row.querySelector('input[type=number]').valueAsNumber });
  }
  return scope;
}
function updateSubprojectScope() {
  const rows = selectedSubprojectScope();
  const total = rows.reduce((sum, item) => sum + item.count, 0);
  const invalid = rows.some((item) => !Number.isInteger(item.count) || item.count < 1);
  $('#subproject-batch-status').textContent = invalid ? '每个已选子工程至少生成一条，数量须为整数。'
    : total > 1000 ? '本批超过 1000 条，请减少数量。' : `已选 ${rows.length} 个子工程，共 ${total} 条`;
  $('#subproject-batch-confirm').disabled = invalid || !rows.length || total > 1000;
}
$('#subproject-batch').addEventListener('click', () => {
  if (operation) return;
  subprojects.pack();
  const list = $('#subproject-batch-list');
  list.replaceChildren(...subprojects.projects.map((project) => {
    const row = document.createElement('label');
    row.className = 'subproject-batch-item';
    row.dataset.id = project.id;
    const check = document.createElement('input'), count = document.createElement('input'), name = document.createElement('span');
    const ready = subprojects.ready(project);
    check.type = 'checkbox'; check.checked = ready && project.participates !== false; check.disabled = !ready;
    check.setAttribute('aria-label', `${project.name} 参与批量混剪`);
    name.textContent = ready ? project.name : `${project.name} · 分镜缺少可用素材`;
    count.type = 'number'; count.min = '1'; count.max = '1000'; count.step = '1'; count.value = project.count ?? 1;
    count.disabled = !ready;
    count.setAttribute('aria-label', `${project.name} 成片数量`);
    row.append(check, name, count);
    return row;
  }));
  updateSubprojectScope();
  $('#subproject-batch-dialog').showModal();
});
$('#subproject-batch-list').addEventListener('input', updateSubprojectScope);
$('#subproject-batch-close').addEventListener('click', () => $('#subproject-batch-dialog').close());
$('#subproject-apply-count').addEventListener('click', () => {
  const field = $('#subproject-common-count');
  if (!field.reportValidity() || !field.value) return;
  for (const row of $('#subproject-batch-list').children) {
    if (row.querySelector('input[type=checkbox]').checked) row.querySelector('input[type=number]').value = field.value;
  }
  updateSubprojectScope();
});
$('#subproject-batch-confirm').addEventListener('click', () => {
  if (operation) return;
  const scope = selectedSubprojectScope();
  for (const row of $('#subproject-batch-list').children) {
    const item = subprojects.projects.find((project) => project.id === row.dataset.id);
    const check = row.querySelector('input[type=checkbox]');
    if (!check.disabled) item.participates = check.checked;
    if (check.checked) item.count = row.querySelector('input[type=number]').valueAsNumber;
  }
  $('#subproject-batch-dialog').close();
  updateControls();
  preparePreview(scope);
});

function changedSubproject() {
  clearPreview();
  selectedMaterials.clear();
  materialBrowseRequest += 1;
  materialFolderPath = [];
  $('#material-search').value = '';
  cutEditor?.close();
  timeline?.reset();
  renderNarration();renderSubtitles();renderWholeTracks();renderScriptBrief();
  renderLists();
}
function readScopeVoice() {
  const voice=(asset)=>asset?{id:asset.id,...(narrationCaptions.has(asset.id)&&{caption:narrationCaptions.get(asset.id)})}:{id:null};
  const whole=[{narration,subtitles,follow:primaryVoiceFollow},...extraWholeTracks].map((t)=>({...voice(t.narration),...(t.subtitles&&{srt:t.subtitles}),...(shots.includes(t.follow)&&{follow:shots.indexOf(t.follow)})}));
  const segments=shots.map((shot,index)=>({index,items:(segmentNarrations.get(shot)??[]).map((asset,j)=>{
    if(!asset)return null;
    const edit=voiceEdits.get(shot)?.[j], cut=edit?.id===asset.id?{ranges:edit.ranges,...(edit.offset&&{offset:edit.offset})}:null;
    return {...voice(asset),...(cut&&{cut})};
  })}));
  return {whole,segments};
}
function writeScopeVoice(scope) {
  function resolve(row) {
    if(!row?.id)return null;
    if(row.caption)narrationCaptions.set(row.id,row.caption);else narrationCaptions.delete(row.id);
    return editAssets.get(row.id)??null;
  }
  const [first,...extra]=scope.whole;
  narration=resolve(first);subtitles=first?.srt??null;primaryVoiceFollow=shots[first?.follow]??null;
  extraWholeTracks.splice(0,extraWholeTracks.length,...extra.map((r)=>({narration:resolve(r),subtitles:r?.srt??null,follow:shots[r?.follow]??null})));
  for(const {index,items} of scope.segments) {
    const shot=shots[index];segmentNarrations.set(shot,items.map(resolve));
    voiceEdits.set(shot,items.map((r)=>r?.cut?{id:r.id,...r.cut}:null));
  }
}
function resolveScriptText(text) {
  const project=subprojects.active;
  if(!project)return text;
  const values=new Map([['子工程',project.name],...(project.variables??[]).map(({key,text})=>[key,text])]);
  return String(text??'').replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(token,key)=>values.get(key.trim())??token);
}
$('#subproject-variables').onclick=()=>{
  const project=subprojects.active;if(operation || !project)return;
  $('#subproject-variable-text').value=(project.variables??[]).map(({key,text})=>key+'='+text).join('\n');
  $('#subproject-template-text').value=project.scriptOverride??'';
  $('#subproject-variable-status').textContent='';$('#subproject-variable-dialog').showModal();
};
$('#subproject-variable-close').onclick=()=>$('#subproject-variable-dialog').close();
$('#subproject-variable-save').onclick=()=>{
  const project=subprojects.active;if(!project)return;
  const variables=[],seen=new Set();
  for(const line of $('#subproject-variable-text').value.split(/\r?\n/).filter((s)=>s.trim())) {
    const pos=line.indexOf('='),key=line.slice(0,pos).trim(),text=line.slice(pos+1).trim();
    if(pos<1 || !key || key==='子工程'||key.length>50||/[{}]/.test(key)||seen.has(key)||text.length>300 || variables.length>=100){
      $('#subproject-variable-status').textContent='每行填写一个「变量名=值」，变量名不可重复；「子工程」自动取门店名称。';return;}
    variables.push({key,text});seen.add(key);
  }
  project.variables=variables;project.scriptOverride=$('#subproject-template-text').value.trim();
  $('#subproject-variable-dialog').close();renderScriptBrief();updateControls();
};
window.mountSubprojectFill({api,shots,subprojects,shotName:(s,i)=>shotProperties.get(s)?.name ?? shotLabel(i),
  begin:(busy)=>{operation=busy?'subproject-fill':'';updateControls();},busy:()=>Boolean(operation),maxCandidates,
  apply:(assignments,mapping)=>{
    const updates=assignments.map(({project,shot,assets})=>({project,shot,clips:assets.map(candidate)}));
    for(const {assets} of assignments) for(const asset of assets) editAssets.set(asset.id,asset);
    subprojects.fill(updates,mapping);changedSubproject();
  },
});

$('#subproject-select').addEventListener('change', (event) => {
  if (operation) return;
  subprojects.select(event.target.value || null);
  changedSubproject();
});
$('#subproject-new').addEventListener('click', () => {
  $('#subproject-name').value = '';
  $('#subproject-error').hidden = true;
  $('#subproject-new-dialog').showModal();
  $('#subproject-name').focus();
});
$('#subproject-cancel').addEventListener('click', () => $('#subproject-new-dialog').close());
$('#subproject-new-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (operation) return;
  try {
    subprojects.create($('#subproject-name').value);
    $('#subproject-new-dialog').close();
    changedSubproject();
  } catch (error) {
    $('#subproject-error').textContent = error.message;
    $('#subproject-error').hidden = false;
  }
});
function describeSubprojectShot() {
  const shot = shots[Number($('#subproject-shot').value)];
  const overridden = subprojects.overridden(shot);
  $('#subproject-current').textContent = `${overridden ? '专属素材' : '公共素材'} · ${shot?.map((clip) => clip.asset.name).join('、') || '此分镜为空'}`;
  $('#subproject-revert').disabled = !overridden;
}
$('#subproject-materials').addEventListener('click', () => {
  if (!subprojects.active || !shots.length) return;
  const select = $('#subproject-shot');
  select.replaceChildren(...shots.map((shot, index) => new Option(shotProperties.get(shot)?.name || shotLabel(index), String(index))));
  select.value = String(Math.max(0, shots.indexOf(trackShot())));
  describeSubprojectShot();
  $('#subproject-material-dialog').showModal();
});
$('#subproject-shot').addEventListener('change', describeSubprojectShot);
$('#subproject-close').addEventListener('click', () => $('#subproject-material-dialog').close());
$('#subproject-revert').addEventListener('click', () => {
  const shot = shots[Number($('#subproject-shot').value)];
  if (operation || !subprojects.active || !shot) return;
  subprojects.revert(shot);
  $('#subproject-material-dialog').close();
  changedSubproject();
});
$('#subproject-replace').addEventListener('click', () => {
  const shot = shots[Number($('#subproject-shot').value)];
  if (operation || !subprojects.active || !shot) return;
  $('#subproject-material-dialog').close();
  pick('visual', Math.min(maxCandidates, maxExports), (assets) => {
    const unique = [...new Map(assets.map((asset) => [asset.id, asset])).values()];
    if (!unique.length) return;
    shot.splice(0, shot.length, ...unique.map(candidate));
    preview(shot[0], '轨道预览');
  });
});

function renderMaterials() {
  cancelMaterialMarquee();
  const query = $('#material-search').value.trim().toLocaleLowerCase();
  const folder = materialFolderPath.at(-1);
  const catalog = new Map();
  const usage = new Map();
  const bin = currentMaterialBin();
  const excluded = bin.hidden;
  for (const [index,shot] of shots.entries()) {
    for (const clip of shot) {
      const { id, name, kind, sourceKey } = clip.asset;
      if (!usage.has(sourceKey ?? id)) usage.set(sourceKey ?? id,new Set());
      usage.get(sourceKey ?? id).add(index + 1);
      if (!catalog.has(id)) catalog.set(id, { id, name, kind, sourceKey, clip });
      bin.ids.add(id);
      excluded.delete(sourceKey);
    }
  }
  renderProcessedMaterials(usage);
  for (const id of bin.ids) {
    const asset=editAssets.get(id);
    if (asset && !catalog.has(id)) catalog.set(id, {id,name:asset.name,kind:asset.kind,sourceKey:asset.sourceKey,clip:candidate(asset)});
  }
  for(const [id,entry] of materialAliases)if(!catalog.has(id)&&editAssets.has(id))catalog.set(id,{...entry,clip:candidate(editAssets.get(id))});
  for (const [id, item] of selectedMaterials) {
    if (item.clip && !catalog.has(id)) selectedMaterials.delete(id);
  }
  const files = folder?.files.map((item)=>({...item,name:materialAliases.get(item.assetId)?.name??item.name})) ?? [...catalog.values()];
  const folders = folder?.folders ?? [...materialFolders.values()];
  const matches = ({ name }) => name.toLocaleLowerCase().includes(query);
  const availableFiles = files.filter((item)=>!excluded.has(item.sourceKey ?? item.clip?.asset.sourceKey));
  const visibleFiles = availableFiles.filter(matches);
  const visibleFolders = folders.filter(matches);
  const folderCount = visibleFolders.length ? ` · ${visibleFolders.length} 个文件夹` : '';
  $('#material-status').textContent = (query ? `${visibleFiles.length} / ${availableFiles.length} 个素材` : `${availableFiles.length} 个素材`) + folderCount;
  $('#material-empty').hidden = visibleFiles.length > 0 || visibleFolders.length > 0;
  $('#material-empty-title').textContent = query ? '没有匹配的素材' : folder ? '这个文件夹没有可用素材' : '暂无素材';
  $('#material-empty-hint').textContent = query ? '试试搜索其他文件名。' : folder
    ? '请选择包含视频或图片的文件夹。' : '添加文件夹后，可以打开并拖入需要的素材。';
  renderMaterialFolders(folder, visibleFolders);
  thumbnailObserver.disconnect();
  const canPlace = canPlaceMaterial();
  materialList.replaceChildren(...visibleFiles.map((item) => {
    const { id, name: fileName, kind, clip, previewUrl } = item;
    const row = document.createElement('li');
    const button = document.createElement('button');
    const check = document.createElement('input');
    const add = document.createElement('button');
    const thumbnail = document.createElement('span');
    const name = document.createElement('strong');
    const detail = document.createElement('span');
    button.type = 'button';
    button.className = 'material-tile';
    button.dataset.materialId = id;
    materialItems.set(button, item);
    button.dataset.kind = kind;
    button.title = fileName;
    const browsingHint = kind === 'video' ? '方向键浏览素材，选中后按空格播放或暂停' : '方向键浏览素材';
    button.setAttribute('aria-description', browsingHint);
    button.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End' + (kind === 'video' ? ' Space' : ''));
    button.draggable = true;
    thumbnail.className = 'material-thumbnail';
    thumbnail.title = `${fileName} · ${browsingHint}`;
    thumbnail.setAttribute('aria-hidden', 'true');
    name.textContent = fileName;
    detail.textContent = kind === 'image' ? '图片' : clip ? `${clip.asset.duration.toFixed(2)} 秒` : '视频';
    const imageUrl = kind === 'image' ? clip?.asset.url ?? previewUrl : undefined;
    if (imageUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.draggable = false;
      image.src = imageUrl;
      thumbnail.append(image);
    } else thumbnail.textContent = kind === 'video' ? '▶' : '▧';
    button.append(thumbnail, name, detail);
    const used = usage.get(item.sourceKey ?? clip?.asset.sourceKey ?? item.assetId ?? id);
    if (used) {
      button.dataset.used = 'true';
      const badge = document.createElement('span');
      badge.className = 'material-used';
      badge.textContent = '已用';
      badge.title = '已用于分镜 ' + [...used].join('、');
      button.setAttribute('aria-label', fileName + '，' + badge.title);
      button.append(badge);
    }
    button.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) selectMaterial(item, !selectedMaterials.has(id));
      else {
        selectedMaterials.clear();
        updateMaterialBatchControls();
        previewLibraryMaterial(item);
      }
    });
    button.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer || operation) {
        event.preventDefault();
        return;
      }
      materialDrag = { id, items: selectedMaterials.has(id) ? [...selectedMaterials.values()] : [item] };
      event.dataTransfer.setData(materialDragType, id);
      event.dataTransfer.effectAllowed = 'copy';
      activateTimelineTab($('#timeline-tracks-tab'));
    });
    button.addEventListener('dragend', clearMaterialDrag);
    if (kind==='video') button.addEventListener('contextmenu', (event)=>{
      event.preventDefault(); openMaterialAudio(selectedMaterials.has(id)?[...selectedMaterials.values()]:[item]);
    });
    check.type = 'checkbox';
    check.className = 'material-select';
    check.title = '多选素材';
    check.setAttribute('aria-label', `选择 ${fileName}`);
    check.addEventListener('change', () => selectMaterial(item, check.checked));
    add.type = 'button';
    add.className = 'material-quick-add';
    add.textContent = '＋';
    add.disabled = !canPlace;
    add.title = '添加到分镜';
    add.setAttribute('aria-label', `添加 ${fileName} 到分镜`);
    add.addEventListener('click', () => chooseMaterialTarget([item]));
    row.append(button, check, add);
    return row;
  }));
  for (const tile of document.querySelectorAll('.material-tile[data-kind="video"]')) thumbnailObserver.observe(tile);
  updateMaterialSelection();
  updateMaterialBatchControls();
}

function updateMaterialSelection() {
  for (const tile of document.querySelectorAll('.material-tile')) {
    tile.setAttribute('aria-pressed', String(tile.dataset.materialId === (previewedMaterial ?? selected?.asset.id)));
  }
}

function updateMaterialBatchControls() {
  const count = selectedMaterials.size;
  $('#material-selection-actions').hidden = count === 0;
  $('#material-selected-count').textContent = `已选 ${count} 项`;
  $('#material-add-selected').disabled = !canPlaceMaterial();
  $('#material-clear-selection').disabled = Boolean(operation);
  for (const check of document.querySelectorAll('#material-list .material-select')) {
    const tile = check.previousElementSibling;
    check.checked = selectedMaterials.has(tile.dataset.materialId);
    check.disabled = Boolean(operation);
    tile.dataset.materialSelected = String(check.checked);
  }
}

function selectMaterial(item, checked) {
  if (operation) return;
  if (!checked) selectedMaterials.delete(item.id);
  else if (selectedMaterials.size >= maxCandidates && !selectedMaterials.has(item.id)) {
    materialMessage(`一个分镜最多添加 ${maxCandidates} 项候选。`);
    updateMaterialBatchControls();
    return;
  } else selectedMaterials.set(item.id, item);
  materialMessage();
  updateMaterialBatchControls();
}

function browseMaterial(tile, key) {
  const rows = materialList.children;
  const index = Array.prototype.indexOf.call(rows, tile.parentElement);
  const columns = getComputedStyle(materialList).gridTemplateColumns.split(' ').length;
  let next;
  switch (key) {
    case 'Home': next = 0; break;
    case 'End': next = rows.length - 1; break;
    case 'ArrowLeft': next = index - 1; break;
    case 'ArrowRight': next = index + 1; break;
    case 'ArrowUp': next = index - columns; break;
    case 'ArrowDown':
      if (Math.floor(index / columns) === Math.floor((rows.length - 1) / columns)) return;
      next = Math.min(index + columns, rows.length - 1);
      break;
    default: return;
  }
  const neighbor = rows[next]?.querySelector('.material-tile');
  if (!neighbor || (neighbor === tile && tile.getAttribute('aria-pressed') === 'true')) return;
  neighbor.focus();
  previewLibraryMaterial(materialItems.get(neighbor), neighbor);
}

function handlePreviewKey(event) {
  if (!['montage', 'audio'].includes(mode) || operation || event.defaultPrevented || event.isComposing
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const { target, key } = event;
  if (![' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)
      || target.isContentEditable || $('dialog[open], :popover-open, .app-frame[data-navigation="floating"]')) return;
  const material = materialItems.get(target);
  if (material && key !== ' ') {
    event.preventDefault();
    browseMaterial(target, key);
    return;
  }
  if (!selected || selected.asset.kind !== 'video' || !validClip(selected) || player.hidden || player.error) return;
  if (!(mode === 'audio' && target === document.body) && trackPreviewButtons.get(target) !== selected
      && (!material || material.id !== (previewedMaterial ?? selected.asset.id))) return;
  if (key === ' ') {
    event.preventDefault();
    if (!event.repeat) void playerTools.togglePlay();
  } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    event.preventDefault();
    playerTools.step(key === 'ArrowLeft' ? -1 : 1);
  }
}

function materialPoint(clientX, clientY) {
  const panel = materialPanel.getBoundingClientRect();
  const x = clientX - panel.left - materialPanel.clientLeft;
  const y = clientY - panel.top - materialPanel.clientTop;
  return {
    x: materialPanel.scrollLeft + Math.max(0, Math.min(x, materialPanel.clientWidth)),
    y: materialPanel.scrollTop + Math.max(0, Math.min(y, materialPanel.clientHeight)),
  };
}

function startMaterialMarquee(event) {
  if (event.button !== 0 || event.pointerType !== 'mouse' || operation || materialSelectionDrag || !materialList.childElementCount) return;
  const { target, clientX, clientY, pointerId, ctrlKey, metaKey } = event;
  if (target !== materialPanel && (!materialList.contains(target) || target.closest('button, input'))) return;
  if (clientY < materialList.getBoundingClientRect().top) return;
  event.preventDefault();
  materialSelectionDrag = {
    pointerId, clientX, clientY, start: materialPoint(clientX, clientY), append: ctrlKey || metaKey,
  };
  materialPanel.setPointerCapture(pointerId);
}

function drawMaterialMarquee() {
  const { start, clientX, clientY } = materialSelectionDrag;
  const end = materialPoint(clientX, clientY);
  if (materialMarquee.hidden && Math.hypot(end.x - start.x, end.y - start.y) < 4) return;
  Object.assign(materialMarquee.style, {
    left: `${Math.min(start.x, end.x)}px`,
    top: `${Math.min(start.y, end.y)}px`,
    width: `${Math.abs(start.x - end.x)}px`,
    height: `${Math.abs(start.y - end.y)}px`,
  });
  materialMarquee.hidden = false;
}

function moveMaterialMarquee(event) {
  if (materialSelectionDrag?.pointerId !== event.pointerId) return;
  materialSelectionDrag.clientX = event.clientX;
  materialSelectionDrag.clientY = event.clientY;
  drawMaterialMarquee();
}

function cancelMaterialMarquee() {
  if (!materialSelectionDrag) return;
  const { pointerId } = materialSelectionDrag;
  materialSelectionDrag = undefined;
  materialMarquee.hidden = true;
  if (materialPanel.hasPointerCapture(pointerId)) materialPanel.releasePointerCapture(pointerId);
}

function finishMaterialMarquee(event) {
  if (materialSelectionDrag?.pointerId !== event.pointerId) return;
  moveMaterialMarquee(event);
  const { append } = materialSelectionDrag;
  const area = !materialMarquee.hidden && materialMarquee.getBoundingClientRect();
  cancelMaterialMarquee();
  if (!area || operation) return;

  if (!append) selectedMaterials.clear();
  let overflow = false;
  for (const tile of materialList.querySelectorAll('.material-tile')) {
    const bounds = tile.getBoundingClientRect();
    if (bounds.right <= area.left || bounds.left >= area.right || bounds.bottom <= area.top || bounds.top >= area.bottom) continue;
    const item = materialItems.get(tile);
    if (selectedMaterials.has(item.id)) continue;
    if (selectedMaterials.size === maxCandidates) {
      overflow = true;
      break;
    }
    selectedMaterials.set(item.id, item);
  }
  materialMessage(overflow ? `一个分镜最多添加 ${maxCandidates} 项候选。` : '');
  updateMaterialBatchControls();
  materialPanel.focus({preventScroll:true});
}

function deleteLibrarySelection(event) {
  if (event.key !== 'Delete' || operation || mode !== 'montage' || event.isComposing
      || event.target.closest('dialog,[contenteditable="true"],textarea,input:not([type=checkbox]),select')) return;
  const processed = event.target.closest('[data-processed-id]');
  const row=event.target.closest('#material-list li');
  const tile=row?.querySelector('.material-tile');
  const item=tile && materialItems.get(tile);
  const items=processed ? processedMaterials.filter((asset)=>asset.id===processed.dataset.processedId)
    : selectedMaterials.size ? [...selectedMaterials.values()] : item ? [item] : [];
  if (!items.length) return;
  event.preventDefault();event.stopPropagation();
  const ids=new Set();
  const sourceKeys=new Set();
  for (const item of items) {
    const asset=item.clip?.asset ?? editAssets.get(item.assetId ?? item.id);
    if (asset) ids.add(asset.id);
    const key=item.sourceKey ?? asset?.sourceKey;
    if (key) sourceKeys.add(key);
  }
  for (const asset of editAssets.values()) if (sourceKeys.has(asset.sourceKey)) ids.add(asset.id);
  for (const id of ids) {
    currentMaterialBin().ids.delete(id);
    if (!subprojects.projects.length) materialAliases.delete(id);
  }
  for (const key of sourceKeys) currentMaterialBin().hidden.add(key);
  subprojects.removeMaterialReferences(ids);
  if (items.some((entry)=>entry.kind==='audio')) {
    for (let i=music.length-1;i>=0;i--) if (ids.has(music[i].id)) music.splice(i,1);
    if (ids.has(narration?.id)) narration=null;
    for (const track of extraWholeTracks) if(ids.has(track.narration?.id)) track.narration=null;
    for (const shot of shots) {
      const tracks=segmentNarrations.get(shot);
      tracks?.forEach((asset,i)=>{if(ids.has(asset?.id)) tracks[i]=null;});
    }
  }
  for (let i=processedMaterials.length-1;i>=0;i--) if (ids.has(processedMaterials[i].id)) processedMaterials.splice(i,1);
  if (selected && (ids.has(selected.asset.id) || sourceKeys.has(selected.asset.sourceKey))) clearPreview();
  selectedMaterials.clear();
  renderNarration();renderWholeTracks();renderMusic();
  renderLists();
  materialPanel.focus({preventScroll:true});
  materialMessage(`已从素材库和分镜移除 ${items.length} 项素材，可按 Ctrl+Z 撤销。`);
}

materialPanel.tabIndex = -1;
materialPanel.addEventListener('keydown',deleteLibrarySelection);

function materialMessage(message = '') {
  const status = $('#material-message');
  status.textContent = message;
  status.hidden = !message;
}

function renderMaterialFolders(current, folders) {
  const breadcrumb = $('#material-breadcrumb');
  breadcrumb.hidden = !current;
  breadcrumb.replaceChildren();
  if (current) {
    const back = document.createElement('button');
    const path = document.createElement('span');
    back.type = 'button';
    back.className = 'secondary material-back';
    back.textContent = '‹ 上一级';
    back.addEventListener('click', () => {
      materialBrowseRequest += 1;
      materialFolderPath.pop();
      materialMessage();
      $('#material-search').value = '';
      renderMaterials();
      ($('#material-breadcrumb .material-back') ?? $('#material-folders .material-folder'))?.focus();
    });
    path.textContent = ['素材库', ...materialFolderPath.map(({ name }) => name)].join(' / ');
    path.title = path.textContent;
    breadcrumb.append(back, path);
  }
  const list = $('#material-folders');
  list.replaceChildren(...folders.map((folder) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'material-folder';
    button.title = folder.name;
    button.textContent = folder.name;
    button.addEventListener('click', () => openMaterialFolder(folder.id));
    row.append(button);
    return row;
  }));
  list.hidden = folders.length === 0;
  $('#material-browse').hidden = !current && !folders.length;
}

async function openMaterialFolder(id) {
  const request = ++materialBrowseRequest;
  materialMessage('正在读取文件夹…');
  try {
    const listing = await api.browseMaterialFolder(id);
    if (request !== materialBrowseRequest) return;
    materialFolderPath.push(listing);
    $('#material-search').value = '';
    renderMaterials();
    materialMessage(listing.warnings?.join(' · '));
    $('#material-breadcrumb .material-back').focus();
  } catch (error) {
    if (request === materialBrowseRequest) materialMessage(error.message);
  }
}

async function addMaterialFolder() {
  if (operation) return;
  operation = 'import';
  updateControls();
  try {
    const folder = await api.pickMaterialFolder();
    if (!folder) return;
    materialBrowseRequest += 1;
    materialFolderPath = [];
    materialFolders.set(folder.id, { id: folder.id, name: folder.name });
    $('#material-search').value = '';
    renderMaterials();
    materialMessage(`已添加「${folder.name}」，点击文件夹查看素材。`);
  } catch (error) {
    materialMessage(error.message);
  } finally {
    operation = '';
    updateControls();
  }
}

async function previewLibraryMaterial(item, focusedTile) {
  if (item.clip) {
    preview(candidate(item.clip.asset), '素材预览', item.id);
    return;
  }
  const request = ++materialPreviewRequest;
  player.pause();
  try {
    // Holding an arrow key should probe only the folder item the user settles on.
    if (focusedTile) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (request !== materialPreviewRequest || document.activeElement !== focusedTile) return;
    }
    const asset = await api.loadMaterialFile(item.id);
    if (request === materialPreviewRequest && mode === 'montage') {
      preview(candidate(asset), '素材预览', item.id);
    }
  } catch (error) {
    if (request === materialPreviewRequest) materialMessage(error.message);
  }
}

function canPlaceMaterial() {
  return !operation && (shots.length < maxShots || shots.some((shot) => shot.length < maxCandidates));
}

async function addLibraryMaterials(items, shot, targetIndex) {
  if (operation || mode !== 'montage' || !items.length || (shot ? shot.length >= maxCandidates : shots.length >= maxShots)) return;
  operation = 'import';
  materialPreviewRequest += 1;
  say('');
  updateControls();
  try {
    const resolved = await Promise.allSettled(items.map(async (item) => item.clip?.asset ?? await api.loadMaterialFile(item.id)));
    const existing = new Set(shot?.map(({ asset }) => asset.id));
    const additions = [];
    for (const [index, result] of resolved.entries()) {
      const item = items[index];
      if (result.status === 'rejected') throw new Error(`无法添加「${item.name}」。${result.reason.message}`);
      const asset = result.value;
      if (!existing.has(asset.id)) {
        existing.add(asset.id);
        additions.push({ clip: candidate(asset), materialId: item.id });
      }
    }
    const remaining = maxCandidates - (shot?.length ?? 0);
    if (additions.length > remaining) throw new Error(`该分镜还可添加 ${remaining} 条候选，请减少所选素材。`);
    if (!additions.length) {
      say(items.length === 1 ? `${items[0].name} 已在本组。` : '所选素材已在本组。');
      return;
    }
    const clips = additions.map(({ clip }) => clip);
    for (const { asset } of clips) editAssets.set(asset.id, asset);
    if (shot) {
      trackExpansion.get(shot)?.delete('body');
      shot.push(...clips);
    } else {
      while(Number.isInteger(targetIndex) && shots.length<targetIndex && shots.length<maxShots-1) shots.push([]);
      shots.push(clips);
    }
    for (const { id } of items) selectedMaterials.delete(id);
    const duplicates = items.length - additions.length;
    if (duplicates) say(`已添加 ${additions.length} 条候选，跳过 ${duplicates} 项重复素材。`);
    activateTimelineTab($('#timeline-tracks-tab'));
    preview(clips[0], '轨道预览', additions[0].materialId);
  } catch (error) {
    say(error.message);
  } finally {
    operation = '';
    renderLists();
  }
}

function chooseMaterialTarget(items) {
  if (operation || !items.length) return;
  const target = $('#material-add-target');
  const options = [new Option('新建分镜', 'new'), ...shots.map((shot, index) => new Option(
    `${shotLabel(index)} · ${shot.length} 条候选`, String(index),
  ))];
  options[0].disabled = shots.length >= maxShots;
  shots.forEach((shot, index) => { options[index + 1].disabled = shot.length >= maxCandidates; });
  const firstAvailable = options.findIndex((option) => !option.disabled);
  if (firstAvailable < 0) return;
  target.replaceChildren(...options);
  target.selectedIndex = firstAvailable;
  materialToAdd = items;
  $('#material-add-name').textContent = items.length === 1 ? items[0].name : `${items.length} 项素材将加入同一个分镜。`;
  $('#material-add-dialog').showModal();
  target.focus();
}

function highlightMaterialDrop(target) {
  if (target === materialDropTarget) return;
  if (materialDropTarget) delete materialDropTarget.dataset.materialDrop;
  materialDropTarget = target;
  if (target) target.dataset.materialDrop = 'active';
}

function clearMaterialDrag() {
  materialDrag = undefined;
  highlightMaterialDrop(undefined);
}

function materialDropAt(event) {
  if (!materialDrag || operation || !Array.from(event.dataTransfer?.types ?? []).includes(materialDragType)
      || event.target.closest('.track-toolbar, #track-playhead-row, #script-brief, .narration-lane, .timeline-lane-label')) return;
  const row = event.target.closest('.shot, [data-drop-shot]');
  const shot = row ? shots[Number(row.dataset.shotIndex ?? row.dataset.dropShot)] : undefined;
  if (!row && event.target.closest('#timeline-clock, #timeline-cut-editor')) return;
  if (shot ? shot.length >= maxCandidates : shots.length >= maxShots) return;
  return { target: row ?? event.target.closest('#shots-empty') ?? $('#new-shot-drop'), shot, targetIndex:row?.dataset.dropShot==null ? undefined : Number(row.dataset.dropShot) };
}

function trackShot() {
  return mode === 'montage' ? shots.find((shot) => shot.includes(selected)) : undefined;
}

function canRemoveEmptyShot(shot) {
  return !shot.length && !(segmentNarrations.get(shot) ?? []).some(Boolean);
}

function updateTrackSelection() {
  const shot = trackShot();
  const row = shot ? clipRows.get(selected) : undefined;
  if (row !== selectedTrackRow) {
    selectedTrackRow?.classList.remove('track-selected');
    row?.classList.add('track-selected');
    selectedTrackRow = row;
  }
  const video = shot && selected.asset.kind === 'video' && validClip(selected);
  const ready = video && player.readyState >= 1 && !player.error;
  const busy = Boolean(operation);
  const canSlice = video && shot.length === 1 && shots.length < maxShots;
  const playhead = $('#track-playhead');
  const time = ready ? Math.max(selected.start, Math.min(selected.end, player.currentTime)) : 0;
  $('#track-selection-info').textContent = shot ? `分镜 ${shots.indexOf(shot) + 1} · ${selected.asset.name}${video && shot.length > 1 ? ' · 分割和定时切片适用于单候选分镜' : ''}` : '选择轨道上的素材进行编辑。';
  $('#track-playhead-row').hidden = !video || !$('#track-preview-axis').checked;
  playhead.disabled = busy || !ready;
  if (ready) {
    playhead.min = selected.start;
    playhead.max = selected.end;
    playhead.value = time;
  }
  $('#track-playhead-time').textContent = `${time.toFixed(3)} 秒`;
  $('#track-split').disabled = busy || !canSlice || !ready || time - selected.start < minClipSeconds - 1e-9
    || selected.end - time < minClipSeconds - 1e-9;
  const interval = $('#track-slice-interval').valueAsNumber;
  $('#track-slice').disabled = busy || !canSlice || !(interval >= minClipSeconds && selected.end - selected.start > interval + 1e-9);
  $('#track-delete').disabled = busy || (!shot && !timeline?.selectionCount);
  const keepAudio = $('#keep-audio').checked;
  $('#track-toggle-audio').setAttribute('aria-pressed', String(keepAudio));
  $('#track-toggle-audio').disabled = busy;
  const target = shot && selected.asset.kind === 'video' && selected.asset.hasAudio ? selected : null;
  const volume = $('#track-volume');
  $('#track-volume-panel').hidden = !target;
  $('#track-volume-panel').disabled = busy;
  if (target !== volumeTarget) {
    volumeTarget = target;
    volume.value = target?.volume ?? 100;
    $('#track-volume-name').textContent = target?.asset.name ?? '';
  }
  player.volume = target ? (keepAudio && !mutedVideoTracks.has(shot.indexOf(target)) ? target.volume / 100 : 0) : 1;
  $('#track-volume-apply').disabled = busy || !target || !(volume.valueAsNumber >= 0 && volume.valueAsNumber <= 100);
}

function applyTrackVolume() {
  const shot = trackShot();
  const volume = $('#track-volume').valueAsNumber;
  if (operation || !shot || !selected.asset.hasAudio || !(volume >= 0 && volume <= 100)) return;
  const scope = $('#track-volume-scope').value;
  const clips = scope === 'all' ? shots.flat() : scope === 'shot' ? shot : [selected];
  for (const clip of clips) if (clip.asset.kind === 'video' && clip.asset.hasAudio) clip.volume = volume;
  updateControls();
}

function splitTrack(fixed) {
  const shot = trackShot();
  if (operation || !shot || shot.length !== 1 || selected.asset.kind !== 'video' || !validClip(selected)) return;
  try {
    const index = shots.indexOf(shot);
    const parameters = fixed ? { interval: $('#track-slice-interval').valueAsNumber } : { point: player.currentTime };
    const ranges = window.splitRanges(selected.start, selected.end, { ...parameters, minDuration: minClipSeconds, maxParts: maxShots - shots.length + 1 });
    if (ranges.length < 2) {
      say('当前片段不足以按该间隔拆成两段。');
      return;
    }
    const outgoing = shotTransitions.get(shot);
    shotTransitions.delete(shot);
    const [first, ...rest] = ranges;
    const original = { ...selected };
    Object.assign(selected, first);
    const additions = rest.map((range) => [{ ...original, ...range }]);
    if (outgoing) shotTransitions.set(additions.at(-1), outgoing);
    shots.splice(index + 1, 0, ...additions);
    preview(selected);
    renderLists();
    say(`已拆成 ${ranges.length} 组连续分镜。`);
  } catch (error) {
    say(error.message);
  }
}

function removeSelectedTrack() {
  if (!operation && timeline?.removeSelected()) return;
  const shot = trackShot();
  if (operation || !shot) return;
  shot.splice(shot.indexOf(selected), 1);
  clearPreview();
  renderLists();
}

function cleanEmptyShots() {
  if (operation) return;
  const populated = shots.filter((shot) => !canRemoveEmptyShot(shot));
  const removed = shots.length - populated.length;
  if (!removed) return;
  shots.splice(0, shots.length, ...populated);
  renderLists();
  say(`已清理 ${removed} 组空分镜。`);
}

function changeHistory(action) {
  if (mode !== 'montage' || operation) return;
  const config = action === 'reset' ? editBaseline : editHistory[action]();
  if (!config) return;
  restoreProject({ name: projectName, config }, { retainHistory: true });
  if (action === 'reset') editHistory.record(montageConfig());
  updateControls();
}

function segmentVariants(rows, selection) {
  const active = rows.map((row) => row.flatMap((asset, index) => asset ? [index] : []));
  if (selection === 'ordered') return Math.max(1, new Set(active.flat()).size);
  return active.reduce((count, row) => Math.min(maxExports, count * Math.max(1, row.length)), 1);
}

function subtitleBatchCapacity() {
  return maxExtraWholeTracks - extraWholeTracks.length + Number(!subtitles);
}

function draftTitle() {
  const first = shots.find((shot) => shot.length)?.[0].asset.name;
  return (projectName || attachedScript?.title?.trim() || first?.replace(/\.[^.]+$/, '') || '未命名草稿').slice(0, 100);
}

async function flushCurrentDraft() {
  if (await draftAutosave.flush()) return true;
  sayProject(`草稿保存失败，请返回编辑处理。${$('#draft-save-status').title}`);
  return false;
}

function updateControls(group) {
  if (applyingEdit) return;
  const variants = Number($('#use-original').checked) + Number($('#use-mirrors').checked);
  const segmented = $('#narration-mode').value === 'segmented';
  const segmentSelection = $('#segment-narration-selection').value;
  const trackRows = shots.map((shot) => segmentNarrations.get(shot) ?? []);
  const hasNarration = segmented ? trackRows.some((tracks) => tracks.some(Boolean))
    : Boolean(narration || extraWholeTracks.some((track) => track.narration));
  const narrationChoices = segmented ? segmentVariants(trackRows, segmentSelection) : 1 + extraWholeTracks.length;
  const noEnabled = shots.findIndex((shot) => shot.length && shot.every((clip) => clip.enabled === false));
  const combinations = shots.length
    ? shots.reduce((total, shot, i) => {
      const size = shot.filter((clip) => clip.enabled !== false).length * variants;
      return Math.min(maxExports, total * (i === 0 && editCover?.mode === 'first-shot' ? Math.min(1,size) : size));
    }, narrationChoices * packaging.choices(shots)) : 0;
  const invalidTrim = shots.some((shot) => shot.some((clip) => clip.enabled !== false && !validClip(clip)));
  const audioMode = mode === 'audio';
  countField.max = Math.max(1, combinations);
  if (countField.valueAsNumber > Number(countField.max)) countField.value = countField.max;
  $('#combinations').textContent = variants === 0 ? '至少选择一种参与混剪的素材。'
    : noEnabled >= 0 ? `分镜 ${noEnabled + 1} 未勾选任何候选，请至少启用一条画面参与混剪。` : invalidTrim ? '请检查素材的裁切、停留时长或速度。'
    : combinations === 0 ? '每组分镜至少添加一条候选。' : `本批最多生成 ${combinations} 条。`;
  const count = countField.valueAsNumber;
  const musicVolume = $('#music-volume').valueAsNumber;
  const narrationVolumeField = $('#narration-volume');
  if (!hasNarration && !(narrationVolumeField.valueAsNumber >= 0 && narrationVolumeField.valueAsNumber <= 100)) {
    narrationVolumeField.value = 100;
  }
  const narrationVolume = narrationVolumeField.valueAsNumber;
  const invalidTransition = shots.some((shot) => {
    const item = shotTransitions.get(shot);
    return item && !(item.duration >= 0.1 && item.duration <= 2);
  });
  const validMontage = combinations > 0 && !invalidTrim && Number.isInteger(count) && count >= 1 && count <= combinations
    && !invalidTransition && narrationVolume >= 0 && narrationVolume <= 100
    && (!$('#caption-enabled').checked || [...$('#subtitle-style-settings').querySelectorAll('input[type="number"]')].every((node)=>node.value !== '' && node.validity.valid))
    && (!music.length || (musicVolume >= 0 && musicVolume <= 100));
  const busy = Boolean(operation);
  const config = mode === 'montage' || previewBatch || projectName ? montageConfig() : null;
  if(busy && !timelinePlaybackRequest) timeline?.stopDraftPlayback();
  const configKey = config ? JSON.stringify(config) : '';
  if (mode === 'montage') timeline?.refresh(configKey);
  if (mode === 'montage' && !busy) {
    editHistory?.record(config, group ? { group } : undefined);
    draftAutosave.stage(draftTitle(), configKey);
  }
  if (previewBatch && previewBatch.configKey !== configKey) discardPreviewBatch();
  const projectStatus = $('#project-status');
  projectStatus.textContent = draftTitle();
  projectStatus.title = projectStatus.textContent;

  $('#add-shot').disabled = busy || shots.length >= maxShots;
  $('#import-materials').disabled = busy || (audioMode ? audioTargets.length >= maxExports : shots.length >= maxShots);
  for (const [index, button] of [...document.querySelectorAll('.add-candidate')].entries()) {
    button.disabled = busy || shots[index].length >= maxCandidates;
  }
  narrationTrackLane.hidden = !segmented;
  for (const [index, panel] of [...narrationTrackLane.querySelectorAll('.segment-narration-panel')].entries()) {
    panel.querySelector('.add-segment-narration').disabled = busy || trackRows[index].length > maxExtraWholeTracks;
    panel.querySelector('.match-shot-visual').disabled = busy || shots[index].length >= maxCandidates;
  }
  for (const control of document.querySelectorAll('.pick-segment-narration, .remove-segment-narration, .review-segment-narration')) control.disabled = busy;
  for (const control of document.querySelectorAll('.remove-asset, .remove-shot, .trim-fields input')) control.disabled = busy;
  for (const [index, button] of [...document.querySelectorAll('.move-up')].entries()) button.disabled = busy || index === 0;
  for (const [index, button] of [...document.querySelectorAll('.move-down')].entries()) button.disabled = busy || index === shots.length - 1;
  for (const id of ['tab-montage', 'tab-scene-split', 'tab-audio', 'tab-home', 'tab-drafts', 'home-create', 'home-import', 'home-open-project', 'open-project', 'save-project']) {
    $(`#${id}`).disabled = busy;
  }
  draftLibrary.setBusy(busy);
  for (const control of document.querySelectorAll('#title-home, #app-settings, #tab-script, [data-workflow], #project-new, #project-open-file, #project-continue, .project-reopen, #service-actions button')) {
    control.disabled = busy;
  }
  $('#montage-settings').disabled = busy;
  $('#background-color-row').hidden = $('#fit').value !== 'fit';
  for (const control of document.querySelectorAll('.shot-transition select, .shot-transition input')) control.disabled = busy;
  $('#material-import').disabled = busy || shots.length >= maxShots;
  $('#empty-import-visual').disabled = $('#material-import').disabled;
  $('#subproject-select').disabled = busy;
  $('#subproject-new').disabled = busy;
  $('#subproject-batch').disabled = busy;
  $('#subproject-materials').disabled = busy || !shots.length;
  $('#material-folder-import').disabled = busy;
  const newShotDrop = $('#new-shot-drop');
  newShotDrop.setAttribute('aria-disabled', String(busy || shots.length >= maxShots));
  newShotDrop.textContent = shots.length >= maxShots ? '分镜数已达上限，可拖到已有分镜添加候选'
    : '＋ 拖到这里新建分镜，拖到已有分镜添加候选';
  const canPlace = canPlaceMaterial();
  for (const button of document.querySelectorAll('.material-quick-add')) button.disabled = !canPlace;
  updateMaterialBatchControls();
  $('#pick-music').disabled = music.length >= maxCandidates;
  $('#whole-narration').hidden = segmented;
  $('#whole-subtitles').hidden = segmented;
  $('#segment-subtitles-help').hidden = !segmented;
  if (!$('#inspector-panel-subtitles').hidden) captionInspector.refresh();
  $('#whole-track-settings').hidden = segmented;
  $('#whole-track-summary').textContent = `管理整段口播轨 · ${1 + extraWholeTracks.length} 轨`;
  const scriptCount = attachedScript?.[segmented ? 'segmented' : 'whole'].filter(({ dialogue }) => dialogue.trim()).length ?? 0;
  $('#narration-source-summary').textContent = scriptCount ? `已载入脚本的 ${scriptCount} 条台词，一次设置，整批生成。`
    : segmented ? '可在批量配音窗口填入各分镜台词。'
      : '可在批量配音窗口输入台词或音频提示词。';
  $('#whole-track-help').hidden = !extraWholeTracks.length;
  $('#add-whole-track').disabled = extraWholeTracks.length >= maxExtraWholeTracks;
  $('#subs2srs-split').disabled = busy;
  $('#empty-split-narration').disabled = busy;
  $('#pick-subtitle-batch').disabled = subtitleBatchCapacity() === 0;
  $('#segment-narration-settings').hidden = !segmented;
  $('#narration-timing').hidden = !hasNarration;
  $('#voice-follow-settings').hidden=segmented || $('#priority').value!=='picture';
  if(!$('#voice-follow-settings').hidden) syncVoiceFollow();
  $('#segment-narration-help').textContent = segmentSelection === 'ordered'
    ? '每条成片在各分镜使用同一轨号，空轨保持无口播。'
    : '每组分镜随机抽一条已添加的口播。';
  $('#priority-help').textContent = $('#priority').value === 'voice'
    ? (segmented ? '对白保持原速，裁短相邻口播接缝的静音。画面不足先补同组候选，仍不足则复用同组素材，再统一加速对齐。'
      : '整段口播保持原速。画面不足先从各自分镜补候选，仍不足则复用同组素材，画面较长时统一加速对齐。')
    : `${segmented ? '每组分镜' : ''}保留完整画面，超出的口播会被裁剪。`;
  $('#prepare-preview').disabled = busy || !validMontage;
  $('#timeline-play').disabled=(busy && !timelinePlaybackRequest) || !(validMontage || timeline?.canPlayDraft() || timelinePlaybackRequest);
  syncTimelinePlayButton();
  $('#voice-alignment-row').hidden = $('#priority').value !== 'voice';
  if (!$('#voice-alignment-row').hidden && $('#voice-alignment').value === 'reference') {
    $('#priority-help').textContent = '口播保持原速。画面比口播长时裁短，画面比口播短时慢放至口播结束。';
  }
  $('#prepare-preview').hidden = audioMode;
  $('#prepare-preview').textContent = operation === 'prepare-preview' ? '正在生成…' : previewBatch ? '重新生成预览' : '生成预览';
  $('#start-export').disabled = busy || (audioMode ? audioTargets.length === 0 : previewBatch ? previewBatch.selected.size === 0 : !validMontage);
  $('#start-export').textContent = audioMode ? '开始提取' : previewBatch ? '导出已选' : '导出';
  $('#cancel-export').hidden = operation !== 'export';
  playerTools.sync();
  updateTrackSelection();
  $('#track-undo').disabled = busy || !editHistory?.canUndo();
  $('#track-redo').disabled = busy || !editHistory?.canRedo();
  $('#track-reset').disabled = busy || !editBaseline || configKey === JSON.stringify(editBaseline);
  $('#track-clean').disabled = busy || !shots.some(canRemoveEmptyShot);
  if (previewBatch) {
    const { entries, selected: selectedEntries } = previewBatch;
    const visible = entries.filter(matchesPreviewFilters);
    $('#preview-batch-summary').textContent = `已选 ${selectedEntries.size} / ${entries.length} 条 · 当前显示 ${visible.length} 条`;
    $('#select-all-previews').disabled = busy || !visible.length || (visible.length === selectedEntries.size && visible.every((item) => selectedEntries.has(item.index)));
    $('#clear-preview-selection').disabled = busy || selectedEntries.size === 0;
    for (const control of document.querySelectorAll('.batch-select, .preview-composition')) control.disabled = busy;
  }
  updateSceneSplitControls();
}

function setMode(value) {
  if (value === mode) return;
  draftLibrary.cancelCoverTransition();
  timeline?.stopDraftPlayback();
  if(timelinePlaybackRequest) timelinePlaybackRequest.autoplay=false;
  cancelMaterialMarquee();
  const selectionOrigin = workspaceNavigation.selectionBounds();
  const savingDraft = mode === 'montage' ? draftAutosave.flush() : null;
  mode = value;
  const home = mode === 'home' || mode === 'drafts';
  const audio = mode === 'audio';
  const editor = audio || mode === 'montage';
  const project = mode === 'project';
  const script = mode === 'script';
  const service = mode === 'workflow';
  const scene = mode === 'scene-split';
  $('.app-frame').dataset.mode = mode;
  workspaceNavigation.changeMode();
  const activeNav = scene ? $('#tab-scene-split') : mode === 'workflow' ? [...document.querySelectorAll('.tabs [data-workflow]')]
    .find((button) => button.dataset.workflow === activeWorkflow) : $(`#tab-${project ? 'montage' : mode}`);
  const moreTools = activeNav?.closest('.nav-more');
  if (moreTools) moreTools.open = true;
  for (const button of document.querySelectorAll('.tabs button')) {
    if (button === activeNav) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  workspaceNavigation.moveSelection(selectionOrigin, activeNav);
  const titleTab = $('#title-tab');
  titleTab.textContent = activeNav?.textContent.trim() || '';
  titleTab.hidden = !titleTab.textContent;
  $('#home').hidden = !home;
  if (home) {
    $('#home').setAttribute('aria-label', mode === 'drafts' ? '本地草稿' : '首页工作台');
    $('#home-heading').textContent = mode === 'drafts' ? '本地草稿' : '剪辑工作台';
    $('#draft-heading-label').textContent = mode === 'drafts' ? '全部草稿' : '最近草稿';
  }
  $('#editor-workspace').hidden = !editor;
  $('#project-workspace').hidden = !project;
  $('#scene-split-workspace').hidden = !scene;
  $('#script-workspace').hidden = !script;
  $('#workflow-workspace').hidden = !service;
  if (window.scrollY) window.scrollTo(0, 0);
  clearPreview();
  say('');
  if (home) {
    $('.home-content').append($('#recent-work'));
    if (mode === 'home') refreshHistory();
    if (savingDraft) {
      savingDraft.then((ok) => {
        if (mode !== 'home' && mode !== 'drafts') return;
        if (!ok) sayProject(`草稿保存失败，请返回编辑处理。${$('#draft-save-status').title}`);
        draftLibrary.refresh();
      });
    } else draftLibrary.refresh();
  }
  if (project) refreshProjects();
  if (scene) {
    renderSceneSplitInputs();
    updateSceneSplitControls();
    return;
  }
  if (!editor) return;
  $('#workflow-title').textContent = audio ? '音频提取' : '分镜混剪';
  $('#workflow-description').textContent = audio ? '从一条或多条视频中提取原声音轨。' : '每组分镜随机抽取一条候选，再拼接成片。';
  $('#workflow-eyebrow').hidden = !audio;
  $('#workflow-description').hidden = !audio;
  $('#workbench-project-label').hidden = audio;
  $('#workbench-actions').hidden = audio;
  $('#audio-toolbar').hidden = !audio;
  const exportActions = $('.export-actions');
  if (audio) $('.editor-output').prepend(exportActions);
  else $('#workbench-actions').append(exportActions);
  $('#import-materials').textContent = audio ? '导入视频' : '导入素材';
  $('#montage-pane').hidden = audio;
  $('#audio-pane').hidden = !audio;
  $('.editor-materials').hidden = audio;
  $('#montage-settings').hidden = audio;
  $('#inspector-tabs').hidden = audio;
  $('#audio-settings').hidden = !audio;
  $('#output-format').textContent = audio ? 'MP3' : 'MP4';
  $('#export-heading').textContent = audio ? '导出设置' : '混剪设置';
  panelLayout.sync();
  updateControls();
}

async function refreshProjects() {
  const status = $('#project-list-status');
  const list = $('#project-list');
  $('#project-continue').hidden = !(projectName || attachedScript || shots.length || music.length || narration || subtitles || extraWholeTracks.length);
  try {
    const projects = await api.projects();
    status.textContent = projects.length ? '' : '还没有本地项目。新建剪辑并保存工程后会出现在这里。';
    const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
    list.replaceChildren(...projects.map((project) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      const name = document.createElement('strong');
      const date = document.createElement('time');
      button.type = 'button';
      button.className = 'project-reopen';
      button.disabled = Boolean(operation);
      button.addEventListener('click', () => openProject(project.id));
      name.textContent = project.name;
      date.dateTime = project.openedAt;
      date.textContent = formatter.format(new Date(project.openedAt));
      button.append(name, date);
      row.append(button);
      return row;
    }));
  } catch (error) {
    status.textContent = error.message;
  }
}

function showScript(model) {
  if (operation) return;
  scriptWorkspace ??= window.mountScriptWorkspace($('#script-workspace'), {
    onMontage: attachScript,
    onBack: () => setMode('home'),
    onNarrate: openScriptSpeech,
  });
  if (model) scriptWorkspace.restore(model);
  setMode('script');
}

function renderScriptBrief() {
  const panel = $('#script-brief');
  panel.hidden = !attachedScript;
  const list = $('#script-brief-rows');
  list.replaceChildren();
  if (!attachedScript) return;
  const { title, mode: scriptMode, tab } = attachedScript;
  const rows = tab === 'textGroups' ? attachedScript.textGroups : attachedScript[scriptMode];
  $('#script-brief-title').textContent = title || '未命名创意';
  for (const [index, row] of rows.entries()) {
    if (!row.dialogue.trim() && !row.note.trim()) continue;
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${tab === 'textGroups' ? '文字组' : scriptMode === 'segmented' ? '分镜' : '脚本'} ${index + 1}`;
    const dialogue = document.createElement('p');
    dialogue.textContent = resolveScriptText(row.dialogue);
    const note = document.createElement('p');
    note.textContent = row.note;
    note.className = 'muted';
    item.append(label, dialogue, note);
    list.append(item);
  }
}

function attachScript(model) {
  attachedScript = model;
  if (model.tab === 'narration') $('#narration-mode').value = model.mode;
  if (model.tab === 'narration' && model.mode === 'segmented') {
    const count = model.segmented.findLastIndex(({ dialogue, note }) => dialogue.trim() || note.trim()) + 1;
    while (shots.length < Math.min(count, maxShots)) shots.push([]);
  }
  setMode('montage');
  renderScriptBrief();
  renderLists();
}

async function newProject() {
  if (operation) return;
  operation = 'project';
  updateControls();
  try {
    if (!await flushCurrentDraft()) return;
    restoreProject({ name: '', assets: [], config: {
      shots: [], ratio: '16:9', resolution: 720, fps: 30, fit: 'fit', keepAudio: true, unordered: false,
      useOriginal: true, useMirrors: false, musicIds: [], musicVolume: 35, count: 1,
    } });
  } finally {
    operation = '';
    updateControls();
  }
}

function renderSceneSplitInputs() {
  const summary = $('#scene-input-summary');
  const list = $('#scene-input-list');
  summary.textContent = sceneSplitInputs.length
    ? `已选择 ${sceneSplitInputs.length} 个视频。`
    : '尚未选择视频。';
  list.replaceChildren(...sceneSplitInputs.map((file) => {
    const item = document.createElement('li');
    item.textContent = file;
    item.title = file;
    return item;
  }));
  $('#scene-split-submit').disabled = Boolean(operation) || !sceneSplitInputs.length || !sceneSplitOutput;
}

function updateSceneSplitControls() {
  $('#scene-pick-files').disabled = Boolean(operation);
  $('#scene-pick-folder').disabled = Boolean(operation);
  $('#scene-pick-output').disabled = Boolean(operation);
  $('#scene-detector').disabled = Boolean(operation);
  $('#scene-threshold').disabled = Boolean(operation);
  $('#scene-min-length').disabled = Boolean(operation);
  $('#scene-split-submit').disabled = Boolean(operation) || !sceneSplitInputs.length || !sceneSplitOutput;
  $('#scene-split-cancel').hidden = operation !== 'scene-split';
}

async function pickSceneInputs(kind) {
  if (operation) return;
  try {
    const result = await api.pickSceneInput(kind);
    if (!result) return;
    sceneSplitInputs.splice(0, sceneSplitInputs.length, ...result.files);
    $('#scene-progress-status').textContent = `已载入「${result.label}」`;
    renderSceneSplitInputs();
  } catch (error) {
    $('#scene-progress-status').textContent = error.message;
  }
}

async function pickSceneOutput() {
  if (operation) return;
  try {
    const output = await api.pickSceneOutput();
    if (!output) return;
    sceneSplitOutput = output;
    $('#scene-output-path').textContent = output;
    $('#scene-output-path').title = output;
    renderSceneSplitInputs();
  } catch (error) {
    $('#scene-progress-status').textContent = error.message;
  }
}

function renderSceneResults(results) {
  const table = $('#scene-results');
  const empty = $('#scene-results-empty');
  const body = table.querySelector('tbody');
  body.replaceChildren(...results.map((result, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${index + 1}</td><td></td><td>${result.scenes.length}</td><td></td><td>完成</td>`;
    row.children[1].textContent = result.input;
    row.children[3].textContent = result.outputDirectory;
    row.children[1].title = result.input;
    row.children[3].title = result.outputDirectory;
    return row;
  }));
  table.hidden = !results.length;
  empty.hidden = Boolean(results.length);
}

async function runSceneSplit() {
  if (operation || !sceneSplitInputs.length || !sceneSplitOutput) return;
  operation = 'scene-split';
  $('#scene-progress').value = 0;
  $('#scene-progress-status').textContent = `准备处理 ${sceneSplitInputs.length} 个视频…`;
  updateSceneSplitControls();
  updateControls();
  try {
    const results = await api.sceneSplit({
      inputs: [...sceneSplitInputs],
      outputDirectory: sceneSplitOutput,
      detector: $('#scene-detector').value,
      threshold: Number($('#scene-threshold').value),
      minSceneSeconds: Number($('#scene-min-length').value),
    });
    if (!results) return;
    renderSceneResults(results);
    $('#scene-progress').value = 1;
    $('#scene-progress-status').textContent = `完成，共输出 ${results.reduce((total, result) => total + result.scenes.length, 0)} 个场景。`;
  } catch (error) {
    $('#scene-progress-status').textContent = error.message;
  } finally {
    operation = '';
    updateSceneSplitControls();
    updateControls();
  }
}

async function showWorkflow(id) {
  if (operation) return;
  try {
    const creative = id === 'digital-avatar' || id === 'replicate';
    if (creative && (await api.creativeSettings()).baseUrl) {
      await creativeWorkspace.open(id === 'replicate' ? 'replicate' : 'avatar');
      return;
    }
    workflowManifest ??= await api.workflows();
    const flow = workflowManifest.find((item) => item.id === id);
    if (!flow) return;
    activeWorkflow = id;
    $('#service-title').textContent = flow.title;
    $('#service-summary').textContent = flow.summary;
    $('#service-status').textContent = flow.status === 'partial' ? '本地部分可用' : flow.status === 'local' ? '本地可用' : '待接入 API';
    for (const [selector, labels] of [['#service-steps', flow.steps], ['#service-requirements', flow.requirements.map((item) => item.label)]]) {
      $(selector).replaceChildren(...labels.map((label) => {
        const item = document.createElement('li');
        item.textContent = label;
        return item;
      }));
    }
    $('#service-requirements-panel').hidden = !flow.requirements.length;
    $('#creative-workflow-settings')?.remove();
    if (creative) {
      const button = document.createElement('button');
      button.id = 'creative-workflow-settings'; button.type = 'button'; button.textContent = '设置云端创作服务';
      button.onclick = () => creativeWorkspace.settings();
      $('#service-requirements-panel').append(button);
    }
    const localActions = {
      'montage.open': () => setMode('project'),
      'montage.import': () => { setMode('montage'); importMaterials(); },
      'script.edit': () => showScript(),
      'audio.open': () => setMode('audio'),
      'scene-split.open': () => setMode('scene-split'),
      'tasks.recent': () => $('#recent-work').scrollIntoView(),
    };
    $('#service-actions').replaceChildren(...flow.localActions.filter((action) => localActions[action.id]).map((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blue-button';
      button.textContent = action.label;
      button.addEventListener('click', localActions[action.id]);
      return button;
    }));
    if (id === 'tasks') {
      $('#service-history').append($('#recent-work'));
      refreshHistory();
    } else $('.home-content').append($('#recent-work'));
    if (mode === 'workflow') mode = '';
    setMode('workflow');
  } catch (error) {
    sayProject(error.message);
  }
}

async function refreshHistory() {
  const list = $('#history-list');
  const status = $('#history-status');
  try {
    const items = await api.history();
    $('#rename-outputs').disabled=true;
    status.textContent = items.length ? '' : '完成导出后，作品会出现在这里。';
    const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      const date = document.createElement('time');
      const reveal = document.createElement('button');
      const check=document.createElement('input');check.type='checkbox';check.value=item.path;check.setAttribute('aria-label','选择 '+item.name);
      check.onchange=()=>{$('#rename-outputs').disabled=!list.querySelector('input:checked');};
      name.textContent = item.name;
      name.title = item.name;
      date.dateTime = item.createdAt;
      date.textContent = formatter.format(new Date(item.createdAt));
      reveal.type = 'button';
      reveal.className = 'home-link';
      reveal.textContent = '在文件夹中显示';
      reveal.addEventListener('click', () => api.reveal(item.path).catch((error) => { status.textContent = error.message; }));
      row.append(check,name, date, reveal);
      return row;
    }));
  } catch (error) {
    status.textContent = error.message;
  }
}

async function pick(kind, limit, apply) {
  if (operation || limit < 1) return;
  operation = 'import';
  say('');
  updateControls();
  try {
    const reply = await api.pick(kind, limit);
    if (!reply) return;
    const warnings = [...reply.warnings];
    for (const asset of reply.assets) {if(materialAliases.has(asset.id))asset.name=materialAliases.get(asset.id).name;editAssets.set(asset.id, asset);}
    apply(reply.assets, warnings);
    if (warnings.length > 0) say(warnings.slice(0, 4).join(' · ') + (warnings.length > 4 ? ` · 另有 ${warnings.length - 4} 条提示` : ''));
  } catch (error) {
    say(error.message);
  } finally {
    operation = '';
    renderLists();
  }
}

function importCandidates(shot) {
  return pick('visual', maxCandidates - shot.length, (assets, warnings) => {
    for (const asset of assets) {
      if (shot.some((clip) => clip.asset.id === asset.id)) warnings.push(`${asset.name} 已在本组。`);
      else {
        trackExpansion.get(shot)?.delete('body');
        shot.push(candidate(asset));
      }
    }
    if (!selected && shot.length) preview(shot[0]);
  });
}

function importMaterials() {
  if (mode === 'audio') {
    return pick('video', maxExports - audioTargets.length, (assets, warnings) => {
      for (const asset of assets) {
        if (!asset.hasAudio) warnings.push(`${asset.name} 没有可提取的音轨。`);
        else if (!audioTargets.some((clip) => clip.asset.id === asset.id)) audioTargets.push(candidate(asset));
      }
      if (!selected && audioTargets.length) preview(audioTargets[0]);
    });
  }
  return pick('visual', Math.min(maxExports, maxShots - shots.length), (assets) => {
    const imported = assets.map((asset) => [candidate(asset)]);
    shots.push(...imported);
    if (!selected && imported.length) preview(imported[0][0]);
  });
}

function renderMusic() {
  const list = $('#music-list');
  $('#music-summary').textContent = music.length ? `${music.length} 首 · 每条成片随机选一首` : '未添加';
  $('#music-volume-field').hidden = !music.length;
  $('#music-start-field').hidden = !music.length;
  list.hidden = !music.length;
  list.replaceChildren(...music.map((asset, index) => {
    const row = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.className = 'quiet';
    remove.addEventListener('click', () => { music.splice(index, 1); renderMusic(); });
    row.append(asset.name, remove);
    return row;
  }));
  updateControls();
}

function renderMusicStart() {
  const control = $('#music-start-shot');
  const index = shots.indexOf(musicStartFrom);
  if (index < 0) musicStartFrom = null;
  control.replaceChildren(new Option('从成片开头', ''), ...shots.map((_, i) => new Option(`从分镜 ${i + 1} 开始`, String(i))));
  control.value = index < 0 ? '' : String(index);
}

function importMusic() {
  return pick('audio', maxCandidates - music.length, (assets, warnings) => {
    for (const asset of assets) {
      if (music.some((entry) => entry.id === asset.id)) warnings.push(`${asset.name} 已在配乐库。`);
      else music.push(asset);
    }
    renderMusic();
  });
}

function renderNarration() {
  const name = $('#narration-name');
  name.textContent = narration ? `${narration.name} · ${narration.duration.toFixed(2)} 秒` : '未添加';
  name.title = name.textContent;
  $('#pick-narration').textContent = narration ? '更换口播' : '添加口播';
  $('#remove-narration').hidden = !narration;
  $('#review-narration').hidden = !narration;
}

function openCloudTtsSettings() {
  if (operation) return;
  cloudTtsSettingsDialog ??= window.mountCloudTtsSettings($('#cloud-tts-settings-workspace'), {
    load: api.cloudTtsSettings,
    save: api.saveCloudTtsSettings,
    verify: api.verifyBreezeAccess,
    openKeys: api.openBreezeKeys,
    onSaved: () => cloudTtsDialog?.refreshVoices(),
  });
  cloudTtsSettingsDialog.open();
}

function openCloudTts(options) {
  if (operation) return;
  cloudTtsDialog ??= window.mountCloudTtsDialog($('#cloud-tts-workspace'), {
    listVoices: api.cloudTtsVoices,
    sample: api.cloudTtsSample,
    openSettings: openCloudTtsSettings,
    cancel: api.cancel,
    synthesize: async (value) => {
      if (operation) throw new Error('请先完成当前操作。');
      operation = 'cloud-tts';
      updateControls();
      try {
        return await api.cloudTtsSynthesize(value);
      } finally {
        operation = '';
        updateControls();
      }
    },
  });
  cloudTtsDialog.open(options);
}

function keepCloudAudio({ asset }, { withCaptions }) {
  editAssets.set(asset.id, asset);
  if (withCaptions && asset.timedCaptions?.length) {
    narrationCaptions.set(asset.id, { name: '云端口播字幕', cues: asset.timedCaptions });
  } else if (withCaptions && asset.scriptText) narrationCaptions.set(asset.id, asset.scriptText);
  return asset;
}

function wholeRoom() {
  return maxExtraWholeTracks - extraWholeTracks.length
    + extraWholeTracks.filter((track) => !track.narration && !track.subtitles).length + Number(!narration && !subtitles);
}

function addWholeAudio(asset) {
  if (!narration && !subtitles) narration = asset;
  else {
    const empty = extraWholeTracks.find((track) => !track.narration && !track.subtitles);
    if (empty) empty.narration = asset;
    else extraWholeTracks.push({ narration: asset, subtitles: null });
  }
}

function refreshAppliedSpeech(count) {
  renderNarration();
  renderWholeTracks();
  renderLists();
  say(`已将 ${count} 条云端配音应用到口播轨。`);
}

function scriptSpeechItems(model, trackMode) {
  return model?.[trackMode].flatMap(({ dialogue }, index) => dialogue.trim() ? [{
    index, text: dialogue, label: `${trackMode === 'segmented' ? '分镜' : '脚本'} ${index + 1}`,
  }] : []) ?? [];
}

function openSpeechBatch(trackMode, items, model) {
  const segmented = trackMode === 'segmented';
  items=items.map((item)=>({...item,text:resolveScriptText(item.text)}));
  if(subprojects.active && items.some((item)=>/\{\{[^{}]+\}\}/.test(item.text))) {say('请先在子工程「口播变量」中填写脚本所用的变量。');return;}
  openCloudTts({
    items,
    onUse(results, settings) {
      if (!results.length) return;
      let slot;
      if (segmented) {
        if (results.some(({ index }) => index >= maxShots)) throw new Error('分段口播超出分镜上限。');
        slot = Array.from({ length: maxExtraWholeTracks+1 }, (_, index) => index).find((index) => results.every((result) =>
          !shots[result.index] || subprojects.inheritsVoice(shots[result.index]) || !segmentNarrations.get(shots[result.index])?.[index]));
        if (slot === undefined) throw new Error('这些分镜没有共同的空口播轨，请清理轨道后再应用。');
      } else if (results.length > (subprojects.inheritsVoice()?maxExtraWholeTracks+1:wholeRoom())) throw new Error('整段口播轨数量不足，请减少任务。');

      applyingEdit = true;
      try {
        if (model) attachScript({ ...model, mode: trackMode, tab: 'narration' });
        if(!segmented && subprojects.inheritsVoice()) {narration=null;subtitles=null;primaryVoiceFollow=null;extraWholeTracks.length=0;}
        for (const result of results) {
          const audio = keepCloudAudio(result, settings);
          if (segmented) {
            const shot = shots[result.index];
            const tracks = subprojects.inheritsVoice(shot)?[]:segmentNarrations.get(shot) ?? [];
            while (tracks.length <= slot) tracks.push(null);
            tracks[slot] = audio;
            segmentNarrations.set(shot, tracks);
          } else addWholeAudio(audio);
        }
      } finally {
        applyingEdit = false;
      }
      activateInspectorTab($('#inspector-tab-narration'));
      refreshAppliedSpeech(results.length);
    },
  });
}

function openMontageSpeech() {
  const trackMode = $('#narration-mode').value;
  const specific=subprojects.active?.scriptOverride;
  if(specific){
    const lines=trackMode==='whole'?[specific]:specific.split(/\r?\n/).filter((s)=>s.trim());
    if(trackMode==='segmented' && lines.length>shots.length){say('专属台词的行数超过分镜数量。');return;}
    openSpeechBatch(trackMode,lines.map((text,index)=>({index,text,label:trackMode==='whole'?subprojects.active.name:shotLabel(index)})));
    return;
  }
  const items = scriptSpeechItems(attachedScript, trackMode);
  if (items.length) {
    openSpeechBatch(trackMode, items, attachedScript);
  } else if (trackMode === 'whole') {
    openSpeechBatch(trackMode, [{ index: 0, text: '', label: '整段口播' }]);
  } else if (shots.length) {
    openSpeechBatch(trackMode, shots.map((_, index) => ({ index, text: '', label: `分镜 ${index + 1}` })));
  } else {
    say('请先导入分镜素材，或从脚本创作载入分段台词。');
  }
}

function openScriptSpeech(model) {
  const items = scriptSpeechItems(model, model.mode);
  if (items.length) openSpeechBatch(model.mode, items, model);
  else window.alert('请先填写需要朗读的台词。');
}

function openNarrationReview(asset, scriptText, hasSrt = false, shotName) {
  if (operation || !asset) return;
  const dialog = $('#narration-review');
  if (dialog.open) return;
  reviewNarration = asset;
  $('#narration-review-name').textContent = [shotName, asset.name, `${asset.duration.toFixed(2)} 秒`].filter(Boolean).join(' · ');
  $('#narration-review-audio').src = asset.url;
  reviewWaveform(asset);
  const existing = narrationCaptions.get(asset.id);
  const text = captionText(existing) ?? scriptText ?? '';
  reviewCaptionText = text.length <= 500 ? text : '';
  $('#narration-review-caption').value = reviewCaptionText;
  const notes = ['字幕按音频时长显示。需要精确的逐句时间码时，请在整段式口播导入 SRT。'];
  if (hasSrt) notes.push('当前轨的 SRT 优先显示。');
  if (existing?.cues) notes.push('当前台词含时间码。修改后将按音频时长显示。');
  if (text.length > 500) notes.push('该条脚本超过 500 字，请粘贴需要显示的部分。');
  $('#narration-review-note').textContent = notes.join(' ');
  dialog.showModal();
}

function applyNarrationCaption() {
  if (!reviewNarration) return;
  if (narrationCaptions.get(reviewNarration.id)?.cues && $('#narration-review-caption').value === reviewCaptionText) {
    $('#narration-review').close();
    return;
  }
  const text = $('#narration-review-caption').value.toWellFormed().replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '').replace(/\n(?:[ \t]*\n)+/g, '\n').trim();
  if (text.length > 500) return;
  if (text) narrationCaptions.set(reviewNarration.id, text);
  else narrationCaptions.delete(reviewNarration.id);
  for (const element of narrationTrackLane.querySelectorAll(`[data-caption-asset="${CSS.escape(reviewNarration.id)}"]`)) {
    showSegmentCaption(element, reviewNarration.id);
  }
  $('#narration-review').close();
  updateControls();
  say(text ? '已应用台词字幕。' : '已清除该口播的台词字幕。');
}

function importNarration() {
  return pick('narration', 1, ([asset]) => {
    if (!asset) return;
    narration = asset;
    renderNarration();
  });
}

async function splitNarrationWithSubs2srs(event) {
  if (operation || mode !== 'montage') return;
  const trigger = event?.currentTarget;
  const heldFocus = trigger && trigger === document.activeElement;
  let firstReview;
  operation = 'subs2srs';
  say('请选择 SRT 字幕和整段 MP3。');
  updateControls();
  try {
    const inputs = await api.pickSubs2srsInputs();
    if (!inputs) {
      say('');
      return;
    }
    say('正在按 SRT 时间码分割 MP3…');
    const result = await api.splitSubs2srs(inputs);
    const segments = Array.isArray(result?.segments) ? result.segments : [];
    if (!segments.length) throw new Error('没有生成可用的分段口播。');
    if (segments.length > maxShots) throw new Error(`分段数量超过工程容量 ${maxShots} 组。`);
    const targetShots = segments.map((_, index) => shots[index] ?? []);
    const slot = Array.from({ length: maxExtraWholeTracks + 1 }, (_, index) => index)
      .find((index) => targetShots.every((shot) => !(segmentNarrations.get(shot) ?? [])[index]));
    if (slot === undefined) throw new Error('这些分镜没有共同的空口播轨，请先清理已有轨道。');
    shots.push(...targetShots.slice(shots.length));
    for (const [index, segment] of segments.entries()) {
      const asset = segment;
      editAssets.set(asset.id, asset);
      const tracks = segmentNarrations.get(targetShots[index]) ?? [];
      while (tracks.length <= slot) tracks.push(null);
      tracks[slot] = asset;
      segmentNarrations.set(targetShots[index], tracks);
      narrationCaptions.set(asset.id, {
        name: result.subtitleName || '口播字幕',
        cues: [{ start: 0, end: Math.max(1, Math.round(asset.duration * 1000)), text: segment.text }],
      });
    }
    $('#narration-mode').value = 'segmented';
    $('#segment-narration-selection').value = 'ordered';
    trackExpansion.get(targetShots[0])?.delete('segments');
    trackExpansion.get(segmentNarrations.get(targetShots[0]))?.delete(slot);
    renderLists();
    activateTimelineTab($('#timeline-tracks-tab'));
    activateInspectorTab($('#inspector-tab-narration'));
    if ($('#timeline-view').value !== 'cards') {
      $('#timeline-view').value = 'cards';
      setTrackView();
    }
    firstReview = narrationTrackLane.querySelector(`[data-shot-index="0"] [data-track="${slot + 1}"] .review-segment-narration`);
    say(`已切分 ${segments.length} 段口播，依次放入各分镜的口播轨 ${slot + 1}。可在台词下试听或添加画面。`);
  } catch (error) {
    say(error.message);
  } finally {
    operation = '';
    updateControls();
    if (heldFocus && [document.body, trigger].includes(document.activeElement)) (firstReview ?? trigger).focus();
  }
}

function removeNarration() {
  if (operation) return;
  narration = null;
  renderNarration();
  updateControls();
}

function renderSubtitles() {
  const name = $('#subtitle-name');
  const count = $('#subtitle-count');
  name.textContent = subtitles?.name ?? '未添加';
  name.title = subtitles?.name ?? '';
  count.textContent = subtitles ? `${subtitles.cues.length} 条` : '';
  count.hidden = !subtitles;
  $('#pick-subtitles').textContent = subtitles ? '更换字幕' : '导入 SRT';
  $('#remove-subtitles').hidden = !subtitles;
}

async function chooseSubtitles(load, apply) {
  if (operation) return;
  operation = 'import';
  say('');
  updateControls();
  try {
    const reply = await load();
    if (reply) apply(reply);
  } catch (error) {
    say(error.message);
  } finally {
    operation = '';
    updateControls();
  }
}

function importSubtitles() {
  return chooseSubtitles(() => api.pickSubtitles(), (track) => {
    subtitles = track;
    renderSubtitles();
  });
}

function removeSubtitles() {
  if (operation) return;
  subtitles = null;
  renderSubtitles();
  updateControls();
}

function wholeTrackRow(track, index) {
  const row = template('#whole-track-template');
  const number = index + 2;
  row.dataset.track = number;
  row.querySelector('.whole-track-number').textContent = `整段口播轨 ${number}`;
  const voice = row.querySelector('.whole-track-narration-name');
  voice.textContent = track.narration ? `${track.narration.name} · ${track.narration.duration.toFixed(2)} 秒` : '未添加口播';
  voice.title = voice.textContent;
  const captions = row.querySelector('.whole-track-subtitle-name');
  captions.textContent = track.subtitles ? `${track.subtitles.name} · ${track.subtitles.cues.length} 条` : '未添加字幕';
  captions.title = captions.textContent;

  const pickNarration = row.querySelector('.whole-track-pick-narration');
  pickNarration.textContent = track.narration ? '更换口播' : '添加口播';
  pickNarration.addEventListener('click', () => pick('narration', 1, ([asset]) => {
    if (!asset) return;
    track.narration = asset;
    renderWholeTracks();
  }));
  const review = row.querySelector('.whole-track-review-narration');
  review.hidden = !track.narration;
  review.addEventListener('click', () => openNarrationReview(track.narration, attachedScript?.whole[index + 1]?.dialogue, Boolean(track.subtitles)));
  const pickSubtitles = row.querySelector('.whole-track-pick-subtitles');
  pickSubtitles.textContent = track.subtitles ? '更换字幕' : '导入 SRT';
  pickSubtitles.addEventListener('click', () => chooseSubtitles(() => api.pickSubtitles(), (captions) => {
    track.subtitles = captions;
    renderWholeTracks();
  }));

  for (const [key, label] of [['narration', '口播'], ['subtitles', '字幕']]) {
    const remove = row.querySelector(`.whole-track-remove-${key}`);
    remove.hidden = !track[key];
    remove.setAttribute('aria-label', `移除第 ${number} 轨${label}`);
    remove.addEventListener('click', () => {
      if (operation) return;
      track[key] = null;
      renderWholeTracks();
      updateControls();
    });
  }
  const removeTrack = row.querySelector('.whole-track-remove');
  removeTrack.setAttribute('aria-label', `删除第 ${number} 条整段口播轨`);
  removeTrack.addEventListener('click', () => {
    if (operation) return;
    extraWholeTracks.splice(index, 1);
    renderWholeTracks();
    updateControls();
  });
  return row;
}

function renderWholeTracks() {
  $('#whole-track-list').replaceChildren(...extraWholeTracks.map(wholeTrackRow));
}

function addWholeTrack() {
  if (operation || extraWholeTracks.length >= maxExtraWholeTracks) return;
  extraWholeTracks.push({ narration: null, subtitles: null });
  renderWholeTracks();
  updateControls();
  $('#whole-track-list').lastElementChild.querySelector('.whole-track-pick-narration').focus();
}

function importSubtitleBatch() {
  const limit = subtitleBatchCapacity();
  if (limit < 1) return;
  return chooseSubtitles(() => api.pickSubtitleBatch(limit), ({ tracks, warnings }) => {
    let start = 0;
    if (!subtitles && tracks.length) {
      subtitles = tracks[0];
      start = 1;
      renderSubtitles();
    }
    extraWholeTracks.push(...tracks.slice(start).map((subtitles) => ({ narration: null, subtitles })));
    renderWholeTracks();
    const report = $('#subtitle-batch-report');
    report.hidden = warnings.length <= 4;
    report.open = false;
    $('#subtitle-batch-warnings').replaceChildren(...(report.hidden ? [] : warnings.map((warning) => {
      const item = document.createElement('li');
      item.textContent = warning;
      return item;
    })));
    say([`已导入 ${tracks.length} 个字幕文件。`, ...warnings.slice(0, 4),
      ...(warnings.length > 4 ? [`另有 ${warnings.length - 4} 条提示。`] : []),
    ].join(' · '));
  });
}

function renderResults({ results, failures }, complete) {
  const items = results.map((item) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '在文件夹中显示';
    button.className = 'quiet';
    button.disabled = !complete;
    row.dataset.file=item.path;
    button.addEventListener('click', () => api.reveal(row.dataset.file).catch((error) => say(error.message)));
    row.append(item.name, button);
    return row;
  });
  for (const failure of failures) {
    const row = document.createElement('li');
    row.textContent = `第 ${failure.index + 1} 条失败：${failure.message}`;
    items.push(row);
  }
  $('#results').replaceChildren(...items);
}

function serializeClip({ asset, start, end, volume, speed, enabled, ranges, layers, transform, videoSubtitles, look }) {
  return { id: asset.id, start, end, volume, speed, ...(enabled === false && { enabled: false }),
    ...(ranges && { ranges }), ...(layers?.length && { layers }), ...(transform && { transform }), ...(videoSubtitles && {videoSubtitles}), ...(look && {look}) };
}

function reviveClip({ id, start, end, volume, speed, enabled, ranges, layers, transform, videoSubtitles, look }, assets) {
  const asset = assets.get(id);
  if (!asset) throw new Error('打开的工程缺少画面素材。');
  return { asset, start: start ?? NaN, end: end ?? NaN, volume: volume ?? 100,
    ...(enabled === false && { enabled: false }), ...(ranges && { ranges: structuredClone(ranges) }),
    ...(layers?.length && { layers: structuredClone(layers) }), ...(transform && { transform: structuredClone(transform) }),
    ...(videoSubtitles && {videoSubtitles:structuredClone(videoSubtitles)}),
    ...(look && {look:structuredClone(look)}),
    speed: speed === undefined ? 1 : speed ?? NaN };
}

function montageConfig() {
  subprojects.syncVoices();
  const segments = shots.map((shot) => (segmentNarrations.get(shot) ?? []).map((asset) => asset?.id ?? null));
  const extras = extraWholeTracks.map(({ narration, subtitles }) => ({ narrationId: narration?.id ?? null, subtitles }));
  const captionIds = new Set([narration?.id, ...extras.map((track) => track.narrationId), ...segments.flat()]);
  return {
    shots: shots.map((shot) => shot.map(serializeClip)),
    ...([...materialBins.values()].some((bin)=>bin.ids.size || bin.hidden.size) && {
      materialBins:[...materialBins].filter(([,bin])=>bin.ids.size || bin.hidden.size).map(([scope,bin])=>({scope,ids:[...bin.ids],hidden:[...bin.hidden]})),
    }),
    ...(materialAliases.size && {assetAliases:[...materialAliases.values()]}),
    ...(volumeOverrides.length && {volumeOverrides:serializeLevels()}),
    ...(processedMaterials.length && {processedLibrary:processedMaterials.map(({id,kind})=>({id,kind}))}),
    ...(subprojects.projects.length && { subprojects: subprojects.pack() }),
    shotSettings: shots.map((shot) => shotProperties.get(shot) ?? null),
    wholeStartShots: [primaryVoiceFollow,...extraWholeTracks.map((track)=>track.follow)].map((shot)=>shots.includes(shot) ? shots.indexOf(shot) : null),
    voiceAlignment: $('#voice-alignment').value,
    ...(editCover && {cover:editCover}),
    filterLibrary:[...editAssets.values()].filter((a)=>a.kind==='lut').map((a)=>a.id),
    packaging: packaging.forShots(shots),
    sceneCuts,
    segmentVoiceCuts: shots.map((shot) => (segmentNarrations.get(shot) ?? []).map((asset, i) => {
      const edit = voiceEdits.get(shot)?.[i];
      return asset && edit?.id === asset.id ? {ranges: edit.ranges,...(edit.offset && {offset:edit.offset})} : null;
    })),
    ...(mutedVideoTracks.size && { mutedVideoTracks: [...mutedVideoTracks].sort((a, b) => a - b) }),
    shotTransitions: shots.map((shot) => shotTransitions.get(shot) ?? null),
    ratio: $('#ratio').value,
    resolution: Number($('#resolution').value),
    fps: Number($('#fps').value),
    fit: $('#fit').value,
    backgroundColor: $('#background-color').value,
    keepAudio: $('#keep-audio').checked,
    unordered: $('#unordered').checked,
    useOriginal: $('#use-original').checked,
    useMirrors: $('#use-mirrors').checked,
    musicIds: music.map((asset) => asset.id),
    musicStartShot: musicStartFrom ? shots.indexOf(musicStartFrom) : null,
    musicVolume: $('#music-volume').valueAsNumber,
    narrationId: narration?.id ?? null,
    narrationVolume: $('#narration-volume').valueAsNumber,
    narrationMode: $('#narration-mode').value,
    segmentNarrationSelection: $('#segment-narration-selection').value,
    segmentNarrationIds: segments,
    extraWholeTracks: extras,
    generatedCaptions: Object.fromEntries([...captionIds].filter((id) => narrationCaptions.has(id)).map((id) => [id, narrationCaptions.get(id)])),
    priority: $('#priority').value,
    subtitles,
    subtitleStyle: captionInspector.read(),
    script: attachedScript,
    count: countField.valueAsNumber,
  };
}

function discardPreviewBatch() {
  if (previewBatch?.current?.clip === selected && selected) clearPreview();
  const batchTab = $('#timeline-batch-tab');
  const batchPanel = $('#preview-batch');
  const returnFocus = document.activeElement === batchTab || batchPanel.contains(document.activeElement);
  previewBatch = undefined;
  $('#preview-batch-list').replaceChildren();
  batchTab.disabled = true;
  activateTimelineTab($('#timeline-tracks-tab'), returnFocus);
}

function matchesPreviewFilters(entry) {
  const project = $('#batch-project-filter').value;
  if (project && entry.subproject?.id !== project) return false;
  const { percent, kind } = entry.reuse;
  switch ($('#batch-reuse-filter').value) {
    case 'none': return kind === 'none';
    case 'low': return percent <= 70;
    case 'medium': return percent > 70 && percent < 95;
    case 'high': return percent >= 95 && percent < 100;
    case 'same': return kind === 'same';
    default: return true;
  }
}

function filterPreviews() {
  if (!previewBatch) return;
  for (const row of $('#preview-batch-list').children) row.hidden = !matchesPreviewFilters(previewBatch.entries[Number(row.dataset.index)]);
  updateControls();
}
$('#batch-reuse-filter').addEventListener('change', filterPreviews);
$('#batch-project-filter').addEventListener('change', filterPreviews);

function renderPreviewBatch(showBatch = true) {
  const batch = previewBatch;
  const segmented = $('#narration-mode').value === 'segmented';
  const rows = batch.entries.map((entry) => {
    const row = template('#preview-batch-template');
    const number = entry.index + 1;
    row.dataset.index = entry.index;
    row.hidden = !matchesPreviewFilters(entry);
    const checkbox = row.querySelector('.batch-select');
    checkbox.checked = batch.selected.has(entry.index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) batch.selected.add(entry.index);
      else batch.selected.delete(entry.index);
      updateControls();
    });
    row.querySelector('.batch-title').textContent = `${entry.subproject ? entry.subproject.name + ' · ' : ''}第 ${number} 条`;
    row.querySelector('.batch-reuse').textContent = entry.reuse.kind === 'none' ? '素材重复估值 0%'
      : `${entry.reuse.kind === 'same' ? '画面素材完全相同' : '部分画面素材重合'} · ${entry.reuse.percent}% · 对比第 ${entry.reuse.peer + 1} 条`;
    row.querySelector('.batch-duration').textContent = `${entry.duration.toFixed(2)} 秒`;
    if (entry.wholeTrack) {
      const track = row.querySelector('.batch-whole-track');
      track.textContent = `整段口播轨 ${entry.wholeTrack}`;
      track.hidden = false;
    }
    row.querySelector('.batch-clips').textContent = entry.clips.map(({ name, mirror, narration, visuals }) => {
      const visual = (visuals ?? [{ name, mirror }]).map((clip) => clip.name
        + (clip.mirror ? '（镜像）' : '') + (clip.repeat > 1 ? ` ×${clip.repeat}` : '')).join(' + ');
      if (!segmented) return visual;
      return visual + (narration ? `（口播：${narration}）` : '（无口播）');
    }).join(' → ');
    row.querySelector('.batch-music').textContent = entry.music ? `配乐：${entry.music}` : '无配乐';
    if (entry.narration) {
      const narrationLabel = row.querySelector('.batch-narration');
      narrationLabel.textContent = `口播：${entry.narration}`;
      narrationLabel.hidden = false;
    }
    if (entry.subtitles) {
      const subtitleLabel = row.querySelector('.batch-subtitles');
      subtitleLabel.textContent = `字幕：${entry.subtitles}`;
      subtitleLabel.hidden = false;
    }
    const button = row.querySelector('.preview-composition');
    button.setAttribute('aria-label', `播放第 ${number} 条预览`);
    button.addEventListener('click', () => playComposition(entry.index));
    return row;
  });
  $('#preview-batch-list').replaceChildren(...rows);
  const tab = $('#timeline-batch-tab');
  tab.disabled = false;
  if (showBatch) activateTimelineTab(tab, document.activeElement === document.body);
}

function selectPreviews(selectAll) {
  if (operation || !previewBatch) return;
  previewBatch.selected = new Set(selectAll ? previewBatch.entries.filter(matchesPreviewFilters).map(({ index }) => index) : []);
  for (const row of $('#preview-batch-list').children) row.querySelector('.batch-select').checked = previewBatch.selected.has(Number(row.dataset.index));
  updateControls();
}

async function preparePreview(scope, showBatch = true) {
  if (operation || (!scope && $('#prepare-preview').disabled)) return;
  const config = montageConfig();
  operation = 'prepare-preview';
  say('');
  const analyzeSeams = config.priority === 'voice' && config.narrationMode === 'segmented';
  if (analyzeSeams) {
    $('#batch-job').hidden = false;
    $('#batch-job-status').textContent = '正在检查口播接缝并生成预览组合…';
    $('#batch-progress').removeAttribute('value');
    $('#cancel-preview').disabled = false;
  }
  updateControls();
  try {
    const result = await api.preparePreview(config, scope);
    if (!result) {
      say('已取消生成预览组合。');
      return;
    }
    discardPreviewBatch();
    $('#batch-reuse-filter').value = scope ? 'all' : 'low';
    const projectFilter = $('#batch-project-filter');
    const projects = new Map(result.entries.filter((entry) => entry.subproject).map((entry) => [entry.subproject.id, entry.subproject.name]));
    projectFilter.replaceChildren(new Option('全部子工程', ''), ...[...projects].map(([id, name]) => new Option(name, id)));
    projectFilter.hidden = !projects.size;
    previewBatch = {
      ...result,
      configKey: JSON.stringify(config),
      selected: new Set(result.entries.filter(matchesPreviewFilters).map(({ index }) => index)),
    };
    renderPreviewBatch(showBatch);
  } catch (error) {
    say(error.message);
  } finally {
    if (analyzeSeams) $('#batch-job').hidden = true;
    operation = '';
    updateControls();
  }
}

function playRenderedClip(clip, request) {
  if(request && (!request.autoplay || mode!=='montage')) return;
  const start=request ? timeline.playheadTime : 0;
  preview(clip, '成片预览');
  if(request) seekTimelineVideo(clip, start>=clip.end-.01 ? 0 : start);
  player.play().catch(() => {
    if (selected === clip && !player.error) say('成片预览已就绪，可以在播放器中点击播放。');
  });
}

async function playComposition(index, request) {
  if (operation || !previewBatch) return;
  timeline.stopDraftPlayback();
  const batch = previewBatch;
  if (batch.current?.index === index) {
    say('');
    playRenderedClip(batch.current.clip, request);
    return;
  }
  if (batch.current?.clip === selected && selected) clearPreview();
  batch.current = undefined;
  operation = 'preview';
  say('');
  $('#batch-job').hidden = false;
  $('#batch-job-status').textContent = `正在生成第 ${index + 1} 条成片预览…`;
  $('#batch-progress').value = 0;
  $('#cancel-preview').disabled = false;
  updateControls();
  try {
    const asset = await api.renderPreview({ id: batch.id, index, config: montageConfig() });
    if (!asset) {
      say('预览已取消。');
      return;
    }
    const clip = candidate(asset);
    batch.current = { index, clip };
    playRenderedClip(clip, request);
  } catch (error) {
    say(error.message);
  } finally {
    $('#batch-job').hidden = true;
    operation = '';
    updateControls();
  }
}

function sayProject(message) {
  if (mode === 'project') {
    $('#project-list-status').textContent = message;
    return;
  }
  if (mode !== 'home' && mode !== 'drafts') {
    say(message);
    return;
  }
  const status = $('#home-project-status');
  status.textContent = message;
  status.hidden = !message;
}

async function saveProject() {
  if (operation || mode !== 'montage') return;
  const config = montageConfig();
  operation = 'project';
  sayProject('');
  updateControls();
  try {
    const result = await api.saveProject(config);
    if (result) {
      projectName = result.name;
      sayProject([`工程已保存：${result.name}`, result.libraryWarning].filter(Boolean).join(' · '));
    }
  } catch (error) {
    sayProject(error.message);
  } finally {
    operation = '';
    updateControls();
  }
}

function restoreProject({ name, config, assets = [] }, { retainHistory = false, draft } = {}) {
  const byId = retainHistory ? editAssets : new Map(assets.map((asset) => [asset.id, asset]));
  if(!retainHistory)sourceNames.clear();
  for(const [id,asset] of byId){if(!sourceNames.has(id))sourceNames.set(id,asset.name);asset.name=sourceNames.get(id);}
  materialAliases.clear();
  materialBins.clear();
  for (const {scope,ids,hidden} of config.materialBins ?? []) materialBins.set(scope,{ids:new Set(ids),hidden:new Set(hidden)});
  for(const item of config.assetAliases??[]){if(byId.has(item.id)){materialAliases.set(item.id,{...item});byId.get(item.id).name=item.name;}}
  const findAsset = (id) => {
    if (!byId.has(id)) throw new Error('打开的工程缺少素材。');
    return byId.get(id);
  };
  const restoredShots = config.shots.map((shot) => shot.map((clip) => reviveClip(clip, byId)));
  const restoredMusic = config.musicIds.map(findAsset);
  const restoredNarration = config.narrationId ? findAsset(config.narrationId) : null;
  const restoredTracks = restoredShots.map((_, index) =>
    (config.segmentNarrationIds?.[index] ?? []).map((id) => id === null ? null : findAsset(id)));
  const restoredWholeTracks = (config.extraWholeTracks ?? []).map(({ narrationId, subtitles }) => ({
    narration: narrationId == null ? null : findAsset(narrationId),
    subtitles: subtitles ?? null,
  }));
  discardPreviewBatch();
  clearPreview();
  if (!retainHistory) {
    audioTargets.length = 0;
    selectedMaterials.clear();
    materialBrowseRequest += 1;
    materialFolderPath = [];
    materialFolders.clear();
    materialMessage();
    editAssets.clear();
    for (const [id, asset] of byId) editAssets.set(id, asset);
  }
  applyingEdit = true;
  shots.splice(0, shots.length, ...restoredShots);
  processedMaterials.splice(0,processedMaterials.length,...(config.processedLibrary??[]).map(({id})=>findAsset(id)));
  subprojects.restore(config.subprojects);
  packaging.load(config.packaging, shots);
  sceneCuts = structuredClone(config.sceneCuts ?? []);
  editCover = config.cover && structuredClone(config.cover);
  cutEditor?.close();
  timeline?.reset();
  mutedVideoTracks.clear();
  for (const index of config.mutedVideoTracks ?? []) mutedVideoTracks.add(index);
  for (const [index, shot] of shots.entries()) {
    if (!retainHistory && shot.length && shot.every(validClip)) trackExpansion.set(shot, new Map([['body', false]]));
    segmentNarrations.set(shot, restoredTracks[index]);
    if (config.shotSettings?.[index]) shotProperties.set(shot, structuredClone(config.shotSettings[index]));
    voiceEdits.set(shot, (config.segmentVoiceCuts?.[index] ?? []).map((edit,j) => edit && restoredTracks[index][j] ?
      {id:restoredTracks[index][j].id,ranges:structuredClone(edit.ranges),offset:edit.offset ?? 0} : null));
    if (config.shotTransitions?.[index]) shotTransitions.set(shot, config.shotTransitions[index]);
  }
  music.splice(0, music.length, ...restoredMusic);
  musicStartFrom = config.musicStartShot == null ? null : shots[config.musicStartShot] ?? null;
  narration = restoredNarration;
  narrationCaptions.clear();
  for (const [id, caption] of Object.entries(config.generatedCaptions ?? {})) narrationCaptions.set(id, caption);
  subtitles = config.subtitles ?? null;
  attachedScript = config.script ?? null;
  extraWholeTracks.splice(0, extraWholeTracks.length, ...restoredWholeTracks);
  volumeOverrides=(config.volumeOverrides??[]).map(row=>({...row,...(row.kind==='segment'&&{owner:shots[row.shot]}),...(row.kind==='whole'&&row.track>0&&{owner:extraWholeTracks[row.track-1]})}));
  primaryVoiceFollow=shots[config.wholeStartShots?.[0]] ?? null;
  extraWholeTracks.forEach((track,i)=>{track.follow=shots[config.wholeStartShots?.[i+1]] ?? null;});
  $('#ratio').value = config.ratio;
  $('#resolution').value = config.resolution;
  $('#fps').value = config.fps;
  $('#fit').value = config.fit;
  $('#background-color').value = config.backgroundColor ?? '#000000';
  $('#keep-audio').checked = config.keepAudio;
  $('#unordered').checked = config.unordered;
  $('#use-original').checked = config.useOriginal;
  $('#use-mirrors').checked = config.useMirrors;
  $('#music-volume').value = config.musicVolume;
  $('#narration-volume').value = config.narrationVolume === undefined ? 100 : config.narrationVolume;
  $('#narration-mode').value = config.narrationMode ?? 'whole';
  $('#segment-narration-selection').value = config.segmentNarrationSelection ?? 'ordered';
  $('#priority').value = config.priority ?? 'picture';
  $('#voice-alignment').value = config.voiceAlignment ?? 'fill';
  captionInspector.restore(config.subtitleStyle);
  countField.value = config.count;
  if (!retainHistory) {
    $('#output').hidden = true;
    $('#results').replaceChildren();
    $('#material-search').value = '';
  }
  projectName = name;
  setMode('montage');
  if (!retainHistory) activateInspectorTab($('#inspector-tab-visual'));
  renderNarration();
  renderSubtitles();
  renderWholeTracks();
  $('#subtitle-batch-report').hidden = true;
  renderMusic();
  renderScriptBrief();
  renderLists();
  if (!retainHistory) {
    editBaseline = structuredClone(montageConfig());
    draftAutosave.reset(draft && { id: draft.id, revision: draft.revision }, draftTitle(), JSON.stringify(editBaseline));
    editHistory.reset(editBaseline);
  }
  applyingEdit = false;
  if (!retainHistory) updateControls();
}

async function openEditorProject(load, { fromDraft = false } = {}) {
  if (operation) return;
  operation = 'project';
  sayProject(fromDraft ? '正在打开草稿并检查素材…' : '正在打开工程并检查素材…');
  updateControls();
  try {
    if (!await flushCurrentDraft()) return;
    const result = await load();
    sayProject('');
    if (result) {
      restoreProject(result, { draft: fromDraft ? result : undefined });
      const firstShot = shots.findIndex((shot) => shot.length);
      if (firstShot >= 0) preview(shots[firstShot][0]);
      sayProject([`已打开${fromDraft ? '草稿' : '工程'}：${result.name}`, result.libraryWarning].filter(Boolean).join(' · '));
      return result;
    }
  } catch (error) {
    sayProject(error.message);
  } finally {
    operation = '';
    updateControls();
  }
}

function openProject(id) {
  return openEditorProject(() => api.openProject(id));
}

async function openDraft(id) {
  const result = await openEditorProject(() => api.openDraft(id), { fromDraft: true });
  if (!result) return;
  const clip = selected?.asset;
  const cover = result.config.cover;
  const customCover = cover?.mode === 'library' && cover.items?.[cover.active ?? 0];
  const matchesCover = !customCover || (customCover.id === clip?.id && (clip.kind === 'image' || customCover.time === selected.start));
  const firstPoster = $('.shot-poster:not([hidden])');
  return {
    coverUrl: result.coverUrl,
    target: clip && matchesCover && (clip.kind === 'image' ? still : player),
    focusTarget: firstPoster?.checkVisibility() ? firstPoster : clip && $('#timeline-clock').checkVisibility() ? $('#timeline-clock') : $('#open-project'),
  };
}

async function startExport() {
  if (operation || $('#start-export').disabled) return;
  const config = mode === 'audio' ? audioTargets.map((clip) => clip.asset.id) : montageConfig();
  const selection = mode === 'montage' && previewBatch ? {
    id: previewBatch.id,
    indices: previewBatch.entries.map(({ index }) => index).filter((index) => previewBatch.selected.has(index)),
  } : null;
  operation = 'export';
  say('');
  $('#output').hidden = false;
  $('#output-status').textContent = !selection && config.priority === 'voice' && config.narrationMode === 'segmented'
    ? '正在检查口播接缝…' : '请选择输出目录。';
  $('#progress').value = 0;
  $('#results').replaceChildren();
  $('#cancel-export').disabled = false;
  updateControls();
  try {
    const result = await api.export(mode, config, selection);
    if (!result) {
      $('#output').hidden = true;
      return;
    }
    const status = result.cancelled ? '已取消' : result.failures.length ? '导出结束' : '导出完成';
    $('#output-status').textContent = `${status} · 已保存 ${result.results.length} 条${result.failures.length ? ` · 失败 ${result.failures.length} 条` : ''}`;
    if (!result.cancelled) $('#progress').value = 1;
    renderResults(result, true);
    if (result.historyWarning) say(result.historyWarning);
  } catch (error) {
    $('#output-status').textContent = '无法开始导出。';
    say(error.message);
  } finally {
    operation = '';
    updateControls();
  }
}

api.onProgress((data) => {
  if (data.kind === 'foreground') {
    if (foregroundProgress) foregroundProgress.value = data.fraction;
    return;
  }
  if (data.kind === 'cloud-tts') {
    if (operation === 'cloud-tts') cloudTtsDialog?.onProgress(data);
    return;
  }
  if (data.kind === 'preview') {
    if (operation === 'preview' && Number.isFinite(data.fraction)) $('#batch-progress').value = data.fraction;
    return;
  }
  if (data.kind === 'scene-split') {
    if (operation === 'scene-split' && Number.isFinite(data.fraction)) {
      $('#scene-progress').value = (data.index + data.fraction) / data.count;
      $('#scene-progress-status').textContent = `正在处理第 ${data.index + 1} / ${data.count} 个视频…`;
    }
    return;
  }
  if (data.kind === 'subs2srs') {
    if (operation === 'subs2srs' && Number.isFinite(data.fraction)) {
      say(`正在分割口播… ${Math.round(data.fraction * 100)}%`);
    }
    return;
  }
  if (operation !== 'export') return;
  $('#progress').value = (data.index + data.fraction) / data.count;
  $('#output-status').textContent = `处理第 ${data.index + 1} / ${data.count} 条 · 已保存 ${data.results.length} 条`;
  renderResults(data, false);
});

function showHome() {
  setMode('home');
  window.scrollTo(0, 0);
}
const workspaceNavigation = (() => {
  const frame = $('.app-frame');
  const navigation = $('#workspace-navigation');
  const toggle = $('#nav-toggle');
  const highlight = navigation.querySelector('.nav-selection-travel');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active)');
  let motion;
  let collapsed = false;
  let drawerOpen = false;
  try { collapsed = localStorage.getItem('jiajian.sidebar.collapsed') === 'true'; } catch {}
  const isEditor = () => ['montage', 'script'].includes(frame.dataset.mode);

  function stopMotion() {
    if (motion) {
      motion.onfinish = null;
      motion.cancel();
    }
    motion = undefined;
    highlight.hidden = true;
  }
  function selectionBounds() {
    if (frame.dataset.navigation !== 'docked' || reduceMotion.matches) return;
    const current = motion ? highlight : navigation.querySelector('button[aria-current="page"]');
    if (current?.checkVisibility()) return current.getBoundingClientRect();
  }
  function moveSelection(from, target) {
    stopMotion();
    if (!from || !target?.checkVisibility() || frame.dataset.navigation !== 'docked' || reduceMotion.matches) return;
    const to = target.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    const shell = navigation.getBoundingClientRect();
    Object.assign(highlight.style, {
      top: (to.top - shell.top + navigation.scrollTop - navigation.clientTop) + 'px',
      left: (to.left - shell.left + navigation.scrollLeft - navigation.clientLeft) + 'px',
      width: to.width + 'px', height: to.height + 'px',
    });
    highlight.hidden = false;
    motion = highlight.animate([
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + from.width / to.width + ',' + from.height / to.height + ')' },
      { transform: 'none' },
    ], { duration: 300, easing: 'cubic-bezier(.22,.88,.28,1.05)' });
    motion.onfinish = stopMotion;
  }
  reduceMotion.addEventListener('change', stopMotion);
  window.addEventListener('resize', stopMotion);

  function sync() {
    const visible = isEditor() ? drawerOpen : !collapsed;
    navigation.hidden = !visible;
    frame.dataset.navigation = visible ? (isEditor() ? 'floating' : 'docked') : 'closed';
    if (frame.dataset.navigation !== 'docked') stopMotion();
    toggle.setAttribute('aria-expanded', String(visible));
    const label = visible ? '收起侧栏' : '展开侧栏';
    toggle.setAttribute('aria-label', label);
    toggle.title = label + '（Ctrl+\\）';
    if (!visible && navigation.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  }

  function toggleNavigation() {
    if (isEditor()) drawerOpen = !drawerOpen;
    else {
      collapsed = !collapsed;
      try { localStorage.setItem('jiajian.sidebar.collapsed', String(collapsed)); } catch {}
    }
    sync();
    if (drawerOpen) {
      const first = navigation.querySelector('button[aria-current="page"]:enabled') ?? navigation.querySelector('button:enabled');
      first?.focus({ preventScroll: true });
    }
  }

  function closeDrawer() {
    drawerOpen = false;
    sync();
  }

  toggle.addEventListener('click', toggleNavigation);
  navigation.addEventListener('click', (event) => {
    if (drawerOpen && event.target.closest('button:enabled')) closeDrawer();
  });
  document.addEventListener('pointerdown', (event) => {
    if (drawerOpen && !navigation.contains(event.target) && !toggle.contains(event.target)) closeDrawer();
  });
  document.addEventListener('focusin', (event) => {
    if (drawerOpen && !navigation.contains(event.target) && event.target !== toggle) closeDrawer();
  });
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]') || event.isComposing || event.repeat) return;
    if (event.key === 'Escape' && drawerOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDrawer();
      toggle.focus({ preventScroll: true });
    } else if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'Backslash') {
      event.preventDefault();
      toggleNavigation();
    }
  }, true);
  sync();
  return { changeMode: closeDrawer, selectionBounds, moveSelection };
})();
$('#tab-home').addEventListener('click', showHome);
$('#tab-drafts').addEventListener('click', () => {
  setMode('drafts');
  $('#draft-heading').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
$('#home-create').addEventListener('click', newProject);
$('#title-home').addEventListener('click', showHome);
$('#app-settings').addEventListener('click', openCloudTtsSettings);
const creativeWorkspace = window.createCreativeWorkspace({
  api,
  ratio: () => $('#ratio').value,
  selection: () => ({ visual: ['image', 'video'].includes(selected?.asset.kind) ? selected.asset : null, voice: narration }),
  pick: async (kind) => {
    let chosen;
    await pick(kind, 1, ([asset]) => { chosen = asset; });
    return chosen;
  },
  busy: (value) => { operation = value ? 'creative' : ''; updateControls(); },
  apply: (action, result) => {
    if (result.asset) editAssets.set(result.asset.id, result.asset);
    if (action === 'cover') {
      const items = [...(editCover?.items ?? [])];
      if (items.length >= 100) throw new Error('封面库已满，请移除一张后重试。');
      items.push({ id: result.asset.id, time: 0 });
      editCover = { mode: 'library', active: items.length - 1, items };
    } else if (action === 'avatar') {
      if (shots.length >= maxShots) throw new Error('分镜数量已达到工程上限。');
      shots.push([candidate(result.asset)]);
    } else {
      const asset = result.asset ?? editAssets.get(result.sourceId);
      if (!asset || shots.length + result.shots.length > maxShots) throw new Error('参考素材不存在或追加后分镜超过工程上限。');
      const begin = shots.length;
      const script = structuredClone(attachedScript ?? { title: result.title, mode: 'segmented', tab: 'narration', segmented: [], whole: [], textGroups: [] });
      while (script.segmented.length < begin) script.segmented.push({ dialogue: '', note: '' });
      for (const [i, item] of result.shots.entries()) {
        const row = [{ ...candidate(asset), start: item.start, end: item.end }];
        shotProperties.set(row, { name: item.name, description: item.description });
        shots.push(row);
        script.segmented[begin + i] = { dialogue: item.dialogue, note: item.description };
      }
      attachedScript = script;
    }
    setMode('montage'); renderLists(); renderScriptBrief();
    if (action === 'cover') coverEditor.open();
    else preview(shots.at(-1)[0], '轨道预览');
    say(action === 'cover' ? 'AI 封面已加入工程。' : action === 'avatar' ? '数字人口播视频已添加为新分镜。' : '已追加参考分镜和对应台词。');
  },
});
document.addEventListener('click', (event) => { if (event.target.closest('#creative-settings-entry')) creativeWorkspace.settings(); });
$('#creative-cover').addEventListener('click', () => { if (!operation) creativeWorkspace.open('cover'); });
$('#creative-avatar').addEventListener('click', () => { if (!operation) creativeWorkspace.open('avatar'); });
$('#tab-montage').addEventListener('click', () => setMode('project'));
$('#tab-audio').addEventListener('click', () => setMode('audio'));
$('#tab-script').addEventListener('click', () => showScript());
$('#edit-attached-script').addEventListener('click', () => showScript(attachedScript));
$('#home-import').addEventListener('click', importFromHome);
$('#home-open-project').addEventListener('click', () => openProject());
$('#tab-scene-split').addEventListener('click', () => setMode('scene-split'));
$('#project-new').addEventListener('click', newProject);
$('#project-open-file').addEventListener('click', () => openProject());
$('#project-continue').addEventListener('click', () => setMode('montage'));
$('#scene-pick-files').addEventListener('click', () => pickSceneInputs('files'));
$('#scene-pick-folder').addEventListener('click', () => pickSceneInputs('folder'));
$('#scene-pick-output').addEventListener('click', pickSceneOutput);
$('#scene-split-submit').addEventListener('click', runSceneSplit);
$('#scene-split-cancel').addEventListener('click', () => api.cancel());
$('#material-import').addEventListener('click', importMaterials);
$('#empty-import-visual').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const heldFocus = document.activeElement === button;
  await importMaterials();
  if (heldFocus && mode === 'montage' && [document.body, button].includes(document.activeElement)) {
    const next = $('#timeline-view').value === 'time' && shots.length ? $('#timeline-clock') : visualTrackLane.querySelector('.shot-toggle');
    (next ?? button).focus();
  }
});
$('#empty-split-narration').addEventListener('click', splitNarrationWithSubs2srs);
$('#material-folder-import').addEventListener('click', addMaterialFolder);
$('#material-search').addEventListener('input', renderMaterials);
document.addEventListener('keydown', handlePreviewKey);
const materialAudio = window.mountAudioTools({
  api,
  onBusy:(busy)=>{operation=busy?'audio-tools':'';updateControls();},
  onGenerated:(assets)=>{
    for (const asset of assets) {
      editAssets.set(asset.id,asset);processedMaterials.push(asset);
    }
    renderMaterials();
  },
});
async function openMaterialAudio(items) {
  if (operation) return;
  try {
    if (items.length) {
      const sources = await Promise.all(items.map((item)=>item.clip?.asset ?? api.loadMaterialFile(item.id)));
      materialAudio.open(sources);
    } else if (selected?.asset && selected.asset.hasAudio && $('#preview-heading').textContent!=='成片预览') {
      materialAudio.open([selected.asset]);
    } else await pick('narration',maxCandidates,(assets)=>{if(assets.length) materialAudio.open(assets);});
  } catch (error) {materialMessage(error.message);}
}
$('#material-audio-open').onclick=()=>openMaterialAudio([...selectedMaterials.values()]);
$('#review-audio-tools').onclick=()=>{if(reviewNarration){$('#narration-review-audio').pause();materialAudio.open([reviewNarration]);}};
function applyProcessedAudio(asset,role,shot,track) {
  if (role==='music') {
    if(music.some((a)=>a.id===asset.id)) {say('该素材已在配乐轨。');return;}
    if(music.length>=maxCandidates) {say('配乐轨已满。');return;}
    music.push(asset);renderMusic();renderLists();return;
  }
  if($('#narration-mode').value==='segmented') {
    shot??=shots.find((s)=>s.includes(selected));
    if(!shot){say('请先选择目标分镜，或拖入对应的口播轨。');return;}
    const tracks=segmentNarrations.get(shot)??[];
    const vacancy=track??tracks.findIndex((a)=>!a);
    if(vacancy>=0) {
      while(tracks.length<vacancy) tracks.push(null);
      tracks[vacancy]=asset;
    }
    else if(tracks.length<=maxExtraWholeTracks) tracks.push(asset);
    else {say('分段口播轨道已满。');return;}
    segmentNarrations.set(shot,tracks);
  } else if(track===0) narration=asset;
  else if(track>0 && extraWholeTracks[track-1]) extraWholeTracks[track-1].narration=asset;
  else if(wholeRoom()>0) addWholeAudio(asset);
  else {say('整段口播轨道已满。');return;}
  renderNarration();renderWholeTracks();renderLists();
}
const processedAudioDrag = 'application/x-jiajian-processed-audio';
function processedDropTarget(target) {
  return target.closest('[data-voice-row], .segment-narration-panel, #inspector-panel-narration, #inspector-tab-narration, .sequence-music, #inspector-panel-music, #inspector-tab-music');
}
document.addEventListener('dragover',(event)=>{
  if(!operation && event.dataTransfer?.types.includes(processedAudioDrag) && processedDropTarget(event.target)) {
    event.preventDefault();event.dataTransfer.dropEffect='copy';
  }
});
document.addEventListener('drop',(event)=>{
  if(operation || !event.dataTransfer?.types.includes(processedAudioDrag)) return;
  const target=processedDropTarget(event.target);
  const asset=processedMaterials.find((a)=>a.id===event.dataTransfer.getData(processedAudioDrag));
  if(!target || asset?.kind!=='audio')return;
  event.preventDefault();
  const isMusic=target.matches('.sequence-music,#inspector-panel-music,#inspector-tab-music');
  const shotIndex=target.dataset.voiceShot ?? target.dataset.shotIndex;
  applyProcessedAudio(asset,isMusic?'music':'voice',shots[shotIndex],target.dataset.voiceRow===undefined?undefined:Number(target.dataset.voiceRow));
});
function renderProcessedMaterials(usage) {
  const section=$('#processed-materials');
  libraryWaves.clear();
  const filter=$('#material-search').value.trim().toLocaleLowerCase();
  const matches=processedMaterials.filter((asset)=>asset.name.toLocaleLowerCase().includes(filter));
  section.hidden=!matches.length;
  $('#processed-material-list').replaceChildren(...matches.map((asset)=>{
    const li=document.createElement('li'), name=document.createElement('strong');
    name.textContent=asset.name;li.append(name);
    li.tabIndex=0;li.dataset.processedId=asset.id;
    if(usage?.has(asset.sourceKey ?? asset.id)) {
      const badge=document.createElement('span');badge.className='processed-used';badge.textContent='已用';li.append(badge);
    }
    function action(label,fn) {
      const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=label;
      button.onclick=()=>{if(!operation)fn();};li.append(button);
    }
    if(asset.kind==='video') {
      action('预览',()=>preview(candidate(asset),'素材预览'));
      action('添加到分镜',()=>chooseMaterialTarget([{id:asset.id,kind:asset.kind,name:asset.name,clip:candidate(asset)}]));
    } else {
      action('试听',()=>openNarrationReview(asset));
      libraryWaves.add(li,asset);
      li.draggable=true;li.title='拖入口播轨或配乐面板';
      li.ondragstart=(event)=>{event.dataTransfer.setData(processedAudioDrag,asset.id);event.dataTransfer.effectAllowed='copy';};
      action('加入口播',()=>applyProcessedAudio(asset,'voice'));
      action('加入配乐',()=>applyProcessedAudio(asset,'music'));
      action('音频处理',()=>materialAudio.open([asset]));
    }
    return li;
  }));
}
materialPanel.addEventListener('pointerdown', startMaterialMarquee);
materialPanel.addEventListener('pointermove', moveMaterialMarquee);
materialPanel.addEventListener('pointerup', finishMaterialMarquee);
materialPanel.addEventListener('lostpointercapture', (event) => {
  if (materialSelectionDrag?.pointerId === event.pointerId) cancelMaterialMarquee();
});
materialPanel.addEventListener('scroll', () => {
  if (materialSelectionDrag) drawMaterialMarquee();
});
window.addEventListener('blur', cancelMaterialMarquee);
$('#material-add-selected').addEventListener('click', () => chooseMaterialTarget([...selectedMaterials.values()]));
$('#material-clear-selection').addEventListener('click', () => {
  selectedMaterials.clear();
  updateMaterialBatchControls();
});
$('#material-add-cancel').addEventListener('click', () => $('#material-add-dialog').close());
$('#material-add-dialog').addEventListener('close', () => { materialToAdd = undefined; });
$('#material-add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const items = materialToAdd;
  const value = $('#material-add-target').value;
  const shot = value === 'new' ? undefined : shots[Number(value)];
  $('#material-add-dialog').close();
  if (items && (value === 'new' || shot)) addLibraryMaterials(items, shot);
});
const tracksPanel = $('#timeline-tracks-panel');
tracksPanel.addEventListener('dragover', (event) => {
  const place = materialDropAt(event);
  highlightMaterialDrop(place?.target);
  if (!place) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
tracksPanel.addEventListener('dragleave', (event) => {
  if (!tracksPanel.contains(event.relatedTarget)) highlightMaterialDrop(undefined);
});
tracksPanel.addEventListener('drop', (event) => {
  const place = materialDropAt(event);
  const drag = materialDrag;
  clearMaterialDrag();
  if (!place || event.dataTransfer.getData(materialDragType) !== drag.id) return;
  event.preventDefault();
  addLibraryMaterials(drag.items, place.shot,place.targetIndex);
});
for (const button of document.querySelectorAll('[data-workflow]')) {
  button.addEventListener('click', () => showWorkflow(button.dataset.workflow));
}
$('#import-materials').addEventListener('click', importMaterials);
$('#add-shot').addEventListener('click', () => {
  shots.push([]);
  renderLists();
  visualTrackLane.lastElementChild.querySelector('.add-candidate').focus();
});
$('#pick-music').addEventListener('click', importMusic);
$('#music-start-shot').addEventListener('change', (event) => {
  musicStartFrom = event.target.value === '' ? null : shots[Number(event.target.value)] ?? null;
  updateControls();
});
$('#pick-narration').addEventListener('click', importNarration);
$('#cloud-narration').addEventListener('click', openMontageSpeech);
$('#subs2srs-split').addEventListener('click', splitNarrationWithSubs2srs);
$('#review-narration').addEventListener('click', () => openNarrationReview(narration, attachedScript?.whole[0]?.dialogue, Boolean(subtitles)));
$('#narration-review-close').addEventListener('click', () => $('#narration-review').close());
$('#narration-review-save').addEventListener('click', applyNarrationCaption);
$('#narration-review').addEventListener('close', () => {
  const audio = $('#narration-review-audio');
  reviewWaveform();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  reviewNarration = undefined;
});
$('#remove-narration').addEventListener('click', removeNarration);
$('#pick-subtitles').addEventListener('click', importSubtitles);
$('#remove-subtitles').addEventListener('click', removeSubtitles);
$('#add-whole-track').addEventListener('click', addWholeTrack);
$('#pick-subtitle-batch').addEventListener('click', importSubtitleBatch);
$('#open-project').addEventListener('click', () => openProject());
$('#save-project').addEventListener('click', saveProject);
$('#prepare-preview').addEventListener('click', () => preparePreview());
$('#select-all-previews').addEventListener('click', () => selectPreviews(true));
$('#clear-preview-selection').addEventListener('click', () => selectPreviews(false));
$('#start-export').addEventListener('click', startExport);
for (const action of ['reset', 'undo', 'redo']) $(`#track-${action}`).addEventListener('click', () => changeHistory(action));
$('#track-split').addEventListener('click', () => splitTrack(false));
$('#track-slice').addEventListener('click', () => splitTrack(true));
$('#track-slice-interval').addEventListener('input', updateTrackSelection);
$('#track-delete').addEventListener('click', removeSelectedTrack);
$('#track-clean').addEventListener('click', cleanEmptyShots);
$('#track-playhead').addEventListener('input', (event) => { player.currentTime = event.target.valueAsNumber; });
$('#track-preview-axis').addEventListener('change', updateTrackSelection);
$('#tracks-expand-all').addEventListener('click', () => setAllTrackDisclosures(true));
$('#tracks-collapse-all').addEventListener('click', () => setAllTrackDisclosures(false));
$('#track-height').addEventListener('change', (event) => { $('#shots').dataset.height = event.target.value; });
$('#track-zoom').addEventListener('input', (event) => {
  shotViewport.dataset.zoom = event.target.value;
  updateTrackScrollbar();
});
$('#track-volume').addEventListener('input', updateTrackSelection);
$('#track-volume-apply').addEventListener('click', applyTrackVolume);
$('#track-toggle-audio').addEventListener('click', () => {
  $('#keep-audio').checked = !$('#keep-audio').checked;
  updateControls();
});
window.addEventListener('keydown', (event) => {
  if (mode !== 'montage' || operation || event.defaultPrevented || event.isComposing
      || !(event.ctrlKey || event.metaKey) || event.altKey || $('dialog[open]')
      || event.target.isContentEditable || event.target.closest?.('input, textarea, select')) return;
  const key = event.key.toLowerCase();
  if (key === 'z' || key === 'y') {
    event.preventDefault();
    changeHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
  }
});
for (const id of ['cancel-export', 'cancel-preview']) {
  $(`#${id}`).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api.cancel();
    } catch (error) {
      say(error.message);
      if (operation) button.disabled = false;
    }
  });
}
$('#montage-settings').addEventListener('input', (event) => {
  if(!event.target.closest('#voice-follow-settings')) updateControls(event.target.type === 'number' ? event.target : undefined);
}, true);
$('#montage-settings').addEventListener('change', (event) => {
  if(!event.target.closest('#voice-follow-settings')) updateControls();
}, true);
$('#montage-settings').addEventListener('focusout', () => updateControls());
function openTimelineVoice(voice) {
  const {shot, row, asset} = voice;
  if (!asset) return;
  if (!shot) {
    openNarrationReview(asset, attachedScript?.whole[row]?.dialogue, Boolean(voice.subtitles));
    return;
  }
  const existing = voiceEdits.get(shot)?.[row];
  cutEditor.openVoice(asset, existing?.id === asset.id ? existing.ranges : undefined, (ranges,offset=0) => {
    if (segmentNarrations.get(shot)?.[row]?.id !== asset.id) return;
    const edits = voiceEdits.get(shot) ?? [];
    edits[row] = {id:asset.id,ranges,offset};
    voiceEdits.set(shot, edits);
    renderLists();
  },existing?.id===asset.id ? existing.offset : 0);
}

function timelineState() {
  const segments = shots.map((shot) => segmentNarrations.get(shot) ?? []);
  const whole = [{asset:narration,subtitles,follow:shots.indexOf(primaryVoiceFollow)}, ...extraWholeTracks.map((t)=>({asset:t.narration,subtitles:t.subtitles,follow:shots.indexOf(t.follow)}))];
  const segmented = $('#narration-mode').value === 'segmented';
  const captions = [];
  function appendCaptions(asset, imported, row, shot) {
    const entry = imported ?? narrationCaptions.get(asset?.id);
    if (!entry) return;
    const open = () => asset ? openNarrationReview(asset,undefined,Boolean(imported)) : activateInspectorTab($('#inspector-tab-subtitles'));
    let cues = typeof entry === 'string' ? [{start:0,end:(asset?.duration ?? 3)*1000,text:entry,original:null}]
      : entry.cues.map((cue)=>({...cue,original:cue}));
    const edit = shot != null && voiceEdits.get(shots[shot])?.[row];
    if (edit && edit.id === asset?.id && cues) {
      let offset=0;
      cues=edit.ranges.flatMap(({start,end})=>{
        const shift=offset-start*1000;
        offset+=(end-start)*1000;
        return cues.filter((cue)=>cue.start<end*1000 && cue.end>start*1000).map((cue)=>({...cue,start:Math.max(cue.start,start*1000)+shift,end:Math.min(cue.end,end*1000)+shift}));
      });
    }
    const voiceOffset=edit && edit.id===asset?.id ? edit.offset || 0 : 0;
    const follow=shot==null && $('#priority').value==='picture' ? whole[row]?.follow : -1;
    for (const cue of cues) {
      const original=cue.original;
      function remove() {
        if (original) {
          const index=entry.cues.indexOf(original);
          if(index>=0) entry.cues.splice(index,1);
          if(entry.cues.length) return;
        }
        if(!imported) narrationCaptions.delete(asset.id);
        else if(row===0) subtitles=null;
        else if(extraWholeTracks[row-1]) extraWholeTracks[row-1].subtitles=null;
      }
      captions.push({row,shot,follow,start:cue.start/1000+voiceOffset,duration:(cue.end-cue.start)/1000,
        name:cue.text,key:original ?? 'subtitle:'+asset?.id,remove,open});
    }
  }
  if(segmented) segments.forEach((tracks,i)=>tracks.forEach((asset,j)=>appendCaptions(asset,null,j,i)));
  else whole.forEach((track,j)=>appendCaptions(track.asset,track.subtitles,j,null));
  return {shots, segments, whole, music, musicAt:shots.indexOf(musicStartFrom), segmented, captions,
    keepAudio:$('#keep-audio').checked,
    musicVolume:(asset)=>volumeOverrides.find((r)=>r.kind==='music' && r.id===asset.id)?.value ?? $('#music-volume').valueAsNumber,
    voiceVolume:(asset,shot,row)=>{
      const override=volumeOverrides.find((r)=>r.id===asset.id && (shot ? r.kind==='segment' && r.owner===shot && r.track===row
        : r.kind==='whole' && r.owner===(row ? extraWholeTracks[row-1] : undefined)));
      return override?.value ?? $('#narration-volume').valueAsNumber;
    },
    voiceRanges:(shot,row)=>{const edit=voiceEdits.get(shot)?.[row];return edit?.id===segmentNarrations.get(shot)?.[row]?.id ? edit?.ranges : undefined;},
    settings:shots.map((shot)=>shotProperties.get(shot)), muted:mutedVideoTracks, priority:$('#priority').value, selected, pack:packaging.forShots(shots),
    voiceOffset:(i,j)=>{const e=voiceEdits.get(shots[i])?.[j];return e && e.id===segments[i]?.[j]?.id ? e.offset || 0 : 0;},
    voiceDuration:(i,j)=>{const asset=segments[i]?.[j];const edit=voiceEdits.get(shots[i])?.[j];return asset && edit?.id===asset.id ? edit.ranges.reduce((sum,r)=>sum+r.end-r.start,0) : asset?.duration;}};
}
function appearanceOptions(asset) {
  return {asset,ratio:$('#ratio').value,assetFor:(id)=>editAssets.get(id),
    luts:()=>[...editAssets.values()].filter((a)=>a.kind==='lut'),
    pickLut:async()=>{const item=await api.pickLut();if(item)editAssets.set(item.id,item);return item;},
    pickBackground:(done)=>pick('visual',maxCandidates,(assets)=>done(assets)),
    generateBackground:async(prompt,reference)=>{const result=await api.runCreative({action:'cover',prompt,ratio:$('#ratio').value,...(reference&&{imageId:reference})});if(result.asset)editAssets.set(result.asset.id,result.asset);return result.asset;}};
}
function serializeLevels(){
  return volumeOverrides.flatMap(({owner,kind,id,track,value})=>{
    if(kind==='music')return music.some(a=>a.id===id)?[{kind,id,value}]:[];
    if(kind==='segment'){
      const shot=shots.indexOf(owner);
      return shot>=0&&segmentNarrations.get(owner)?.[track]?.id===id?[{kind,id,track,shot,value}]:[];
    }
    const index=owner?extraWholeTracks.indexOf(owner)+1:0;
    const asset=owner?owner.narration:narration;
    return (!owner||index>0)&&asset?.id===id?[{kind,id,track:index,value}]:[];
  });
}
function batchLevelRows(kind){
  const rows=[];
  const audioRow=(category,owner,track,asset,shot,lane,title,base)=>{
    if(!asset)return;
    const matches=r=>r.kind===category&&r.id===asset.id&&r.owner===owner&&(category!=='segment'||r.track===track);
    rows.push({title:title+' · '+asset.name,lane,shot,value:volumeOverrides.find(matches)?.value??base,
      set(value){volumeOverrides=volumeOverrides.filter(r=>!matches(r));volumeOverrides.push({kind:category,id:asset.id,owner,track,value});}});
  };
  if(kind==='video')shots.forEach((shot,i)=>shot.forEach((clip,j)=>{if(clip.asset.kind==='video'&&clip.asset.hasAudio)rows.push({title:shotLabel(i)+' · '+clip.asset.name,lane:'video'+j,shot,active:clip===selected,value:clip.volume??100,set:v=>{clip.volume=v;}});}));
  if(kind==='music')music.forEach((asset,i)=>audioRow('music',undefined,undefined,asset,null,'music'+i,'音乐 '+(i+1),$('#music-volume').valueAsNumber));
  if(kind==='voice'){
    const base=$('#narration-volume').valueAsNumber;
    if($('#narration-mode').value==='segmented')shots.forEach((shot,i)=>(segmentNarrations.get(shot)??[]).forEach((asset,j)=>audioRow('segment',shot,j,asset,shot,'voice'+j,shotLabel(i)+' / 口播 '+(j+1),base)));
    else [undefined,...extraWholeTracks].forEach((track,i)=>audioRow('whole',track,i,track?track.narration:narration,null,'voice'+i,'整段口播 '+(i+1),base));
  }
  if(kind==='sound'){
    const pack=packaging.forShots(shots);
    function visit(items,title,shot){
      (items??[]).forEach((item,i)=>{
        if(Array.isArray(item)){visit(item,title+' '+(i+1),shot);return;}
        if(item?.kind==='sound')rows.push({title:title+' · '+(editAssets.get(item.id)?.name??'音效'),shot,lane:title+' / '+(item.laneId??i),value:item.volume??100,set:v=>{item.volume=v;}});
      });
    }
    visit(pack.global,'全局');visit(pack.composites,'复合');visit(pack.wholeNarration,'整段口播');
    shots.forEach((shot,i)=>{visit(pack.segmentNarration[i],shotLabel(i)+' / 口播',shot);shot.forEach((clip,j)=>visit(clip.layers,shotLabel(i)+' / 候选 '+(j+1),shot));});
  }
  return rows;
}
window.mountBatchEdit({
  material:$('#rename-materials'),outputs:$('#rename-outputs'),volume:$('#batch-levels'),warn:materialMessage,changed:renderLists,levels:batchLevelRows,
  async materials(){
    if(operation)return [];const items=[...selectedMaterials.values()];
    const assets=await Promise.all(items.map(item=>item.clip?.asset??api.loadMaterialFile(item.id)));
    for(const [i,asset] of assets.entries()){
      if(!sourceNames.has(asset.id))sourceNames.set(asset.id,asset.name);
      if(!editAssets.has(asset.id))editAssets.set(asset.id,asset);
      for(const folder of materialFolderPath){const file=folder.files.find(f=>f.id===items[i].id);if(file)file.assetId=asset.id;}
    }
    return [...new Set(assets.map(a=>a.id))].map(id=>editAssets.get(id));
  },
  alias(items,names){
    items.forEach((asset,i)=>{asset.name=names[i];materialAliases.set(asset.id,{id:asset.id,kind:asset.kind,name:asset.name});});
    renderLists();
  },
  works:()=>[...$('#history-list').querySelectorAll('input:checked')].map(check=>({path:check.value,name:check.parentElement.querySelector('strong').textContent})),
  async renameWorks(items,prefix){
    const result=await api.renameOutputs(items.map(i=>i.path),prefix);
    await refreshHistory();
    for(const change of result.changes)for(const li of document.querySelectorAll('#results li'))if(li.dataset.file===change.from){
      li.dataset.file=change.to;li.firstChild.textContent=change.name;
    }
    if(result.retained.length)$('#history-status').textContent='新名称已保存，部分旧文件正在使用，仍保留在原目录。';
  },
});
$('#music-volume').addEventListener('input',()=>{volumeOverrides=volumeOverrides.filter(r=>r.kind!=='music');updateControls();});
$('#narration-volume').addEventListener('input',()=>{volumeOverrides=volumeOverrides.filter(r=>r.kind==='music');updateControls();});
function editAppearance(clip) {
  if(!clip || operation)return;
  const shot=shots.find((row)=>row.includes(clip)); if(!shot)return;
  window.editVisualStyle({...appearanceOptions(clip.asset),initial:clip.look??{},start:clip.start,end:clip.end,
    trim:clip.asset.kind==='video',scopes:{clip:'当前片段',shot:'当前分镜',all:'全部分镜'},
    apply:(style,scope,keys)=>{
      const targets=scope==='clip'?[clip]:scope==='shot'?shot:shots.flat();
      const updates=targets.map((item)=>{
        const next={...(item.look??{})};
        for(const key of keys){
          if((key==='head'||key==='tail') && item.asset.kind!=='video')continue;
          if(style[key]===undefined)delete next[key];else next[key]=structuredClone(style[key]);
        }
        if(next.background?.kind==='media' && !next.background.ids.length)throw Error('请选择至少一个背景素材。');
        if(next.effects?.some((e)=>e.end!==null && e.end<=e.start))throw Error('特效出点须晚于入点。');
        const seconds=item.ranges?.reduce((s,r)=>s+r.end-r.start,0)??item.end-item.start;
        if((next.head??0)+(next.tail??0)>seconds-.1+1e-7)throw Error(item.asset.name+' 去除片头片尾后不足 0.1 秒。');
        return next;
      });
      targets.forEach((item,i)=>{item.look=updates[i];});
      renderLists();
    }});
}
$('#timeline-appearance').addEventListener('click',()=>{const clip=shots.find((s)=>s.includes(selected)) ? selected : shots[0]?.[0];if(clip)editAppearance(clip);else say('请先在轨道中添加视频或图片。');});
const coverEditor = window.createCoverEditor({
  get:()=>editCover, set:(value)=>{editCover=value;renderLists();}, assetFor:(id)=>editAssets.get(id),
  selection:()=>{
    const clip = selected && editAssets.has(selected.asset.id) ? selected : shots[0]?.[0];
    return clip ? {asset:clip.asset,time:clip===selected && Number.isFinite(player.currentTime) ? player.currentTime : clip.start} : null;
  },
  detect:(id)=>api.detectSceneCuts(id),
  pickImage:(onPick)=>pick('image',1,([asset])=>{if(asset){editAssets.set(asset.id,asset);onPick(asset);}}),
});
$('#timeline-cover').addEventListener('click',()=>{if(!operation)coverEditor.open();});
cutEditor = window.createCutTrackEditor({
  container: $('#timeline-cut-editor'), getSceneCuts:()=>sceneCuts, getShots:()=>shots.map((_,i)=>({name:shotLabel(i)})),
  setSceneCuts:(records)=>{sceneCuts=records;renderLists();},
  commitRanges:(clip,ranges)=>{
    if (!shots.some((shot)=>shot.includes(clip))) return;
    clip.start=Math.min(...ranges.map((r)=>r.start)); clip.end=Math.max(...ranges.map((r)=>r.end)); clip.ranges=ranges;
    preview(clip,'轨道预览');renderLists();
  },
  addCandidate:(index,asset,range)=>{
    if(operation || (index<0 || !shots[index] ? shots.length>=maxShots : shots[index].length>=maxCandidates)) return false;
    const shot=shots[index] ?? [];
    if(shot.some((clip)=>clip.asset.id===asset.id && !clip.ranges && Math.abs(clip.start-range.start)<.00001 && Math.abs(clip.end-range.end)<.00001)) return false;
    if(!shots[index]) shots.push(shot);
    editAssets.set(asset.id,asset); shot.push({...candidate(asset),...range});
    return true;
  },
});
timeline = window.mountEditTimeline($('#timeline-clock'), {
  draftPlaybackChanged:syncTimelinePlayButton,
  removeClip:subprojects.removeCandidate,
  selectionChanged:(count)=>{
    const summary=$('#timeline-selection-count');
    summary.hidden=!count;summary.textContent=count ? `已选 ${count} 项` : '';
    $('#track-delete').disabled=Boolean(operation) || (!count && !trackShot());
  },
  removeVoice:({asset,shot,row})=>{
    if(shot) {
      const tracks=segmentNarrations.get(shot);
      if(tracks?.[row]===asset) tracks[row]=null;
      const edits=voiceEdits.get(shot);
      if(edits) delete edits[row];
    } else if(row===0 && narration===asset) narration=null;
    else if(extraWholeTracks[row-1]?.narration===asset) extraWholeTracks[row-1].narration=null;
  },
  afterRemove:()=>{
    if(selected && !trackShot()) clearPreview();
    renderNarration();renderSubtitles();renderWholeTracks();renderMusic();renderLists();
    $('#timeline-clock').focus({preventScroll:true});
  },
  pause:playerTools.pause, seekPending:()=>Boolean(pendingTimelineSeek || proxyResume || player.seeking),
  isComposition:(clip)=>Boolean(clip && previewBatch?.current?.clip===clip),
  seekComposition:(time)=>{
    if(!selected || selected!==previewBatch?.current?.clip) return false;
    seekTimelineVideo(selected,time);
    return true;
  },
  appearance:editAppearance,layerAppearance:(asset,look,apply)=>window.editVisualStyle({...appearanceOptions(asset),initial:look??{},apply}),
  captureCover:(clip)=>coverEditor.capture(clip.asset,selected===clip && Number.isFinite(player.currentTime)?player.currentTime:clip.start),
  firstCover:()=>coverEditor.firstShot(),
  recognize:(asset)=>api.recognizeSpeech(asset.id),importSrt:()=>api.pickSubtitles(),cancelRecognition:()=>api.cancel(),
  captions:editVideoCaptions,slices:(asset)=>cutEditor.openSlices(asset),
  state:timelineState, busy:()=>Boolean(operation), thumbnail:(id,time)=>api.clipThumbnail(id,time), asset:(id)=>editAssets.get(id),
  change:renderLists, scroll:updateTrackScrollbar, zoom:()=>$('#track-zoom').value, showAxis:()=>$('#track-preview-axis').checked,
  shotSettings:(shot,value)=>shotProperties.set(shot,value), newShot:()=>$('#add-shot').click(),
  createAt:(i)=>{if(!operation && i>=0 && i<maxShots){while(shots.length<=i) shots.push([]);renderLists();}},
  move:(shot,to)=>{const from=shots.indexOf(shot);if(operation || from<0 || to===from || !shots[to]) return; shots.splice(from,1);shots.splice(to,0,shot);renderLists();},
  importShot:(shot,i)=>shot ? importCandidates(shot) : pick('visual',maxCandidates,(assets)=>{
    if(!assets.length) return;
    while(shots.length<=i) shots.push([]);
    shots[i].push(...assets.map(candidate));preview(shots[i][0],'轨道预览');
  }), preview:(clip)=>preview(clip,'轨道预览'),
  cut:(clip)=>cutEditor.openCut(clip), scenes:(asset)=>cutEditor.openScenes(asset), dropScene:(event,i)=>cutEditor.dropScene(event,shots[i] ? i : -1),
  mute:setVisualTrackMuted, toggleClip:(clip)=>setCandidateEnabled(clip,clip.enabled===false),
  clear:()=>{clearPreview();activateInspectorTab($('#inspector-tab-visual'));},
  pick:(kind,done)=>pick(kind,1,([asset])=>{if(asset) done(asset);}),
  cutout:cutoutAsset,
  voice:(voice)=>{activateInspectorTab($('#inspector-tab-narration'));if(!voice.shot){$('#voice-follow-track').value=String(voice.row);syncVoiceFollow();}}, editVoice:openTimelineVoice,
  addVoice:({shot,row})=>pick('narration',1,([asset])=>{
    if(!asset) return;
    if(shot){const tracks=segmentNarrations.get(shot) ?? []; while(tracks.length<=row) tracks.push(null); tracks[row]=asset; segmentNarrations.set(shot,tracks);}
    else if(row===0){narration=asset;renderNarration();} else {extraWholeTracks[row-1].narration=asset;renderWholeTracks();}
  }),
  music:()=>activateInspectorTab($('#inspector-tab-music')),
  seek:(clip,time)=>{
    const relative=(clip.look?.head??0)+time*(clip.speed || 1);
    let source=clip.start+relative;
    if(clip.ranges?.length){let left=relative;source=clip.ranges.at(-1).end;for(const r of clip.ranges){if(left<=r.end-r.start){source=r.start+left;break;}left-=r.end-r.start;}}
    if(selected!==clip || $('#preview-heading').textContent!=='轨道预览') preview(clip,'轨道预览');
    if(clip.asset.kind==='video') seekTimelineVideo(clip,source);
    else playerTools.seek(source);
  },
});
function setTrackView() {
  if($('#timeline-view').value!=='time') timeline.clearSelection();
  $('#timeline-tracks-panel').dataset.view=$('#timeline-view').value;
  $('#timeline-clock').hidden=$('#timeline-view').value!=='time';
  timeline.refresh();updateTrackScrollbar();
}
$('#timeline-view').addEventListener('change',setTrackView);
document.addEventListener('pointerdown',(event)=>{
  if(timeline.selectionCount && !event.target.closest('#timeline-clock,.track-toolbar,#timeline-view-actions')) timeline.clearSelection();
},true);
$('#shots').addEventListener('keydown',(event)=>{
  if (event.key !== 'Delete' || operation || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
  const row=event.target.closest('.asset,.segment-narration-track');
  const remove=row?.querySelector('.remove-asset,.remove-segment-narration');
  if(remove && !remove.hidden && !remove.disabled) {event.preventDefault();remove.click();}
});
function syncTimelinePlayButton() {
  const button=$('#timeline-play');
  const playing=Boolean(timeline?.isDraftPlaying() || (selected && selected===previewBatch?.current?.clip && !player.paused));
  button.setAttribute('aria-pressed',String(playing));
  button.textContent=timelinePlaybackRequest?.autoplay && !playing ? '取消待播' : playing ? '⏸ 暂停' : '▶ 时间线播放';
}

function needsRenderedPlayback(config) {
  const clips=config.shots.flat().filter((clip)=>clip.enabled!==false);
  const packaging=config.packaging;
  const layers=[...packaging.global,...packaging.composites.flat(),...packaging.textGroups.flat(2),
    ...packaging.wholeNarration.flat(),...packaging.segmentNarration.flat(2),...clips.flatMap((clip)=>clip.layers ?? [])];
  const voices=config.narrationMode==='segmented' ? config.segmentNarrationIds.flat().filter(Boolean)
    : [config.narrationId,...config.extraWholeTracks.map((track)=>track.narrationId)].filter(Boolean);
  const hasCaptions=config.subtitleStyle.enabled && (clips.some((clip)=>clip.videoSubtitles) ||
    voices.some((id)=>config.generatedCaptions[id]) || (config.narrationMode==='whole' && (config.subtitles || config.extraWholeTracks.some((track)=>track.subtitles))));
  return config.fit==='fill' || config.backgroundColor.toLowerCase()!=='#000000' || config.unordered || config.useMirrors || config.cover ||
    hasCaptions || (voices.length && config.priority==='voice') || config.shotTransitions.some(Boolean) ||
    config.shotSettings.some((shot)=>shot?.duration || shot?.smartTrim) || clips.some((clip)=>clip.look || clip.transform) ||
    config.shots.some((shot)=>shot.filter((clip)=>clip.enabled!==false).length>1) || config.musicIds.length>1 ||
    (config.narrationMode==='whole' ? voices.length>1 : config.segmentNarrationIds.some((row)=>row.filter(Boolean).length>1)) ||
    layers.some((layer)=>layer.kind!=='sound') || packaging.composites.some((row)=>row.length);
}

async function toggleTimelinePlayback() {
  if(timelinePlaybackRequest) {
    timelinePlaybackRequest.autoplay=!timelinePlaybackRequest.autoplay;
    syncTimelinePlayButton();
    return;
  }
  if(operation || mode!=='montage') return;
  if(timeline.isDraftPlaying()) {timeline.toggleDraftPlayback();return;}
  if(selected && selected===previewBatch?.current?.clip) {
    if(!player.paused) player.pause();
    else {
      if(player.ended || player.currentTime>=selected.end-.01) seekTimelineVideo(selected,0);
      await player.play().catch(()=>say('无法播放此预览，请重新生成。'));
    }
    return;
  }
  playerTools.pause();
  const readyToRender=!$('#prepare-preview').disabled;
  if(!readyToRender || (!previewBatch && !needsRenderedPlayback(montageConfig()))) {
    if(timeline.toggleDraftPlayback() || !readyToRender) return;
  }
  const request={autoplay:true};
  timelinePlaybackRequest=request;
  syncTimelinePlayButton();
  try {
    if(!previewBatch) await preparePreview(undefined,false);
    if(!request.autoplay || !previewBatch || mode!=='montage') return;
    const index=previewBatch.current?.index ?? [...previewBatch.selected][0] ?? previewBatch.entries[0]?.index;
    if(index!==undefined) await playComposition(index,request);
  } finally {
    timelinePlaybackRequest=undefined;
    updateControls();
  }
}

$('#timeline-play').addEventListener('click',()=>void toggleTimelinePlayback());
player.addEventListener('play',()=>{timeline?.stopDraftPlayback();syncTimelinePlayButton();});
player.addEventListener('pause',syncTimelinePlayButton);
const timelineKeys=$('#timeline-tracks-panel');
timelineKeys.addEventListener('keydown',(event)=>{
  if(event.key!==' ' || mode!=='montage' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.isContentEditable || event.target.closest('input,textarea,select,[role="textbox"],[role="separator"],dialog,#timeline-cut-editor,.track-toolbar') ||
      (event.target.closest('button,a') && !event.target.closest('#timeline-clock .sequence-block:not(.sequence-empty)')) ||
      document.querySelector('dialog[open], :popover-open, .app-frame[data-navigation="floating"]')) return;
  event.preventDefault();
  event.stopPropagation();
  if(!event.repeat) void toggleTimelinePlayback();
});
$('#timeline-clock').addEventListener('pointerdown',(event)=>{
  if(event.button===0 && !event.target.closest('button,input,select,textarea')) $('#timeline-clock').focus({preventScroll:true});
},true);
$('#timeline-more-menu').addEventListener('click',(event)=>{if(event.target.closest('button') && $('#timeline-more-menu').matches(':popover-open')) $('#timeline-more-menu').hidePopover();});
$('#timeline-layer-add').addEventListener('click',()=>timeline.editLayer());
$('#timeline-text-groups').addEventListener('click',()=>timeline.textSettings());
$('#timeline-scenes').addEventListener('click',()=>{
  if (selected?.asset.kind==='video' && $('#preview-heading').textContent!=='成片预览') {
    editAssets.set(selected.asset.id,selected.asset);cutEditor.openScenes(selected.asset);
  } else pick('video',1,([asset])=>{if(asset) cutEditor.openScenes(asset);});
});
$('#track-zoom').addEventListener('input',()=>timeline.zoom());
$('#timeline-fit').addEventListener('click',()=>timeline.fit());
$('#track-height').addEventListener('change',()=>timeline.setHeight($('#track-height').value));
$('#track-preview-axis').addEventListener('change',()=>timeline.refresh());
player.addEventListener('timeupdate',()=>{if(selected?.asset.kind!=='image') timeline.syncPlayer(selected,player.currentTime);});
setTrackView();
function bringScriptTextGroups() {
  const pack=packaging.forShots(shots);
  let count=0;
  const signatures=new Set(pack.textGroups.map((group)=>JSON.stringify((group[0] ?? []).map((layer)=>layer.text))));
  for(const row of attachedScript?.textGroups ?? []) {
    const lines=row.dialogue.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
    for(let i=0;i<lines.length && pack.textGroups.length<250;i+=8) {
      const group=lines.slice(i,i+8),key=JSON.stringify(group);
      if(signatures.has(key)) continue;
      signatures.add(key);count++;
      pack.textGroups.push([group.map((text,j)=>({kind:'text',text,start:0,end:null,x:.5,y:.28+.55*(j+1)/(group.length+1),scale:1,fontSize:48,color:'#ffffff'}))]);
    }
  }
  if(count) renderLists();
  return count;
}
const editorTextTools=window.mountEditorTextTools({
  busy:()=>Boolean(operation),editingScript:()=>mode==='script',getConfig:()=>mode==='script' ? {script:scriptWorkspace.getModel()} : montageConfig(),
  currentShotIndex:()=>shots.indexOf(trackShot()),
  apply:(config)=>{if(mode==='script') scriptWorkspace.restore(config.script);else {restoreProject({name:projectName,config},{retainHistory:true});updateControls();}},
  importGroups:bringScriptTextGroups,
});
$('#timeline-text-tools').addEventListener('click',editorTextTools.open);
window.addEventListener('keydown',(e)=>{if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='f' && ['script','montage'].includes(mode)){e.preventDefault();editorTextTools.open();}});
function syncVoiceFollow() {
  const current=$('#voice-follow-track'),target=$('#voice-follow-shot');
  const row=Math.min(extraWholeTracks.length,Math.max(0,Number(current.value)||0));
  current.replaceChildren(...Array.from({length:extraWholeTracks.length+1},(_,i)=>new Option('整段口播 '+(i+1),i)));
  current.value=String(row);
  target.replaceChildren(new Option('从片头开始',''),...shots.map((_,i)=>new Option(shotLabel(i),i)));
  const shot=row>0 ? extraWholeTracks[row-1].follow : primaryVoiceFollow;
  const index=shots.indexOf(shot);target.value=index===-1 ? '' : String(index);
}
$('#voice-follow-track').addEventListener('change',syncVoiceFollow);
$('#voice-follow-shot').addEventListener('change',(event)=>{
  const index=Number($('#voice-follow-track').value),shot=event.target.value==='' ? null : shots[Number(event.target.value)];
  if(index>0) extraWholeTracks[index-1].follow=shot;else primaryVoiceFollow=shot;
  updateControls();
});
window.mountTrackOrganizer({trigger:$('#organize-tracks'),getConfig:montageConfig,getAsset:(id)=>editAssets.get(id),
  apply:(config)=>{restoreProject({name:projectName,config},{retainHistory:true});updateControls();},busy:()=>Boolean(operation),notify:say});
async function editVideoCaptions(clip) {
  if(operation || clip?.asset.kind!=='video') return;
  const track=await timeline.editCaptions(clip.asset,clip.videoSubtitles);
  if(track!==undefined && shots.some((shot)=>shot.includes(clip))) {
    if(track) clip.videoSubtitles=track;else delete clip.videoSubtitles;
    renderLists();
  }
}
$('#clip-captions').addEventListener('click',()=>editVideoCaptions(selected));
$('#recognize-voice-captions').addEventListener('click',async()=>{
  const asset=reviewNarration;
  if(!asset) return;
  const existing=narrationCaptions.get(asset.id);
  const track=await timeline.editCaptions(asset,typeof existing==='string' ? {cues:[{start:0,end:Math.round(asset.duration*1000),text:existing}]} : existing);
  if(track!==undefined) {
    if(track) narrationCaptions.set(asset.id,track);else narrationCaptions.delete(asset.id);
    $('#narration-review').close();renderLists();
  }
});
editBaseline = structuredClone(montageConfig());
editHistory = window.createEditHistory(editBaseline);
draftAutosave.reset(undefined, draftTitle(), JSON.stringify(editBaseline));
bindTrackDisclosure($('.script-brief-toggle'), $('#script-brief-rows'), $('#script-brief'), 'script', '脚本摘要');
renderLists();
refreshHistory();
draftLibrary.refresh();

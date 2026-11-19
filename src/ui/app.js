'use strict';

const $ = (selector) => document.querySelector(selector);
const api = window.workbench;
const shots = [];
const audioTargets = [];
const maxShots = 1000;
const maxCandidates = 20;
const maxExports = 50;
const maxExtraWholeTracks = 249;
const minClipSeconds = 0.1;
const maxStillSeconds = 60;
const music = [];
let musicStartFrom = null;
const segmentNarrations = new WeakMap();
const shotTransitions = new WeakMap();
const clipRows = new WeakMap();
const trackPreviewButtons = new WeakMap();
const editAssets = new Map();
const narrationCaptions = new Map();
const extraWholeTracks = [];
let narration = null;
let subtitles = null;
let mode = 'home';
let operation = '';
let selected;
let previewBatch;
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
const notice = $('#notice');
const countField = $('#count');

function setupTabs(tablist) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  function activate(tab, focus = false) {
    if (tab.disabled) return;
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
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
const activateTimelineTab = setupTabs($('.timeline-header [role="tablist"]'));
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
  const overflow = shotViewport.scrollWidth - shotViewport.clientWidth;
  const wasHidden = trackScrollbar.hidden;
  trackScrollbar.hidden = overflow <= 0;
  if (trackScrollbar.hidden) return;
  const size = `${overflow}px`;
  if (!wasHidden && trackScrollbar.style.getPropertyValue('--track-horizontal-overflow') === size) return;
  trackScrollbar.style.setProperty('--track-horizontal-overflow', size);
  mirrorScroll(shotViewport, trackScrollbar);
}

new ResizeObserver(updateTrackScrollbar).observe(shotViewport);
shotViewport.addEventListener('scroll', () => onTrackScroll(shotViewport, trackScrollbar));
trackScrollbar.addEventListener('scroll', () => onTrackScroll(trackScrollbar, shotViewport));

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

function preview(clip, heading = '素材预览', materialId) {
  materialPreviewRequest += 1;
  previewedMaterial = materialId;
  selected = clip;
  player.pause();
  const isImage = clip.asset.kind === 'image';
  player.playbackRate = clip.speed >= 0.5 && clip.speed <= 3 ? clip.speed : 1;
  if (isImage) {
    still.src = clip.asset.url;
    if (still.complete) setPreviewAspect(still.naturalWidth, still.naturalHeight);
  } else if (player.getAttribute('src') !== clip.asset.url || player.error) {
    player.src = clip.asset.url;
  } else {
    setPreviewAspect(player.videoWidth, player.videoHeight);
    seekPreview();
  }
  player.hidden = isImage;
  still.hidden = !isImage;
  $('#preview-hint').hidden = true;
  $('#preview-heading').textContent = heading;
  $('#preview-meta').textContent = isImage ? '图片' : `${clip.asset.duration.toFixed(2)} 秒`;
  $('#preview-name').textContent = clip.asset.name;
  $('#preview-name').hidden = false;
  $('.preview-readout-name').textContent = clip.asset.name;
  updatePreviewTimecode(isImage ? 0 : clip.start);
  updateMaterialSelection();
  updateTrackSelection();
}

function clearPreview() {
  materialPreviewRequest += 1;
  previewedMaterial = undefined;
  selected = undefined;
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
  still.removeAttribute('src');
  still.hidden = true;
  $('#preview-heading').textContent = '素材预览';
  $('#preview-meta').textContent = '';
  $('#preview-name').hidden = true;
  $('#preview-hint').textContent = mode === 'montage' ? '在素材库或轨道选择一个素材' : '选择素材进行预览';
  $('#preview-hint').hidden = false;
  updateMaterialSelection();
  updateTrackSelection();
}

player.addEventListener('loadedmetadata', () => {
  if (!player.hidden) setPreviewAspect(player.videoWidth, player.videoHeight);
  if (selected?.speed >= 0.5 && selected.speed <= 3) player.playbackRate = selected.speed;
  seekPreview();
  updateTrackSelection();
});
function setPreviewAspect(width, height) {
  if (width && height) player.parentElement.style.setProperty('--preview-ratio', width / height);
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
  $('#preview-hint').textContent = '播放器暂不支持此编码，可继续尝试导出。';
  $('#preview-hint').hidden = false;
}

player.addEventListener('error', () => previewError('video', player));
still.addEventListener('error', () => previewError('image', still));

function template(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}

function bindTrackPreview(button, clip, heading) {
  trackPreviewButtons.set(button, clip);
  if (clip.asset.kind === 'video') {
    const hint = '选中后，空格播放或暂停，左右键微调播放头';
    button.title = `${clip.asset.name} · ${hint}`;
    button.setAttribute('aria-description', hint);
    button.setAttribute('aria-keyshortcuts', 'Space ArrowLeft ArrowRight');
  }
  button.addEventListener('click', () => preview(clip, heading));
}

function assetRow(clip, list, trim) {
  const row = template('#asset-template');
  if (trim) clipRows.set(clip, row);
  const label = row.querySelector('.asset-name');
  label.textContent = clip.asset.name;
  label.title = clip.asset.name;
  row.querySelector('.asset-meta').textContent = describe(clip.asset);
  bindTrackPreview(row.querySelector('.preview-asset'), clip);
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
        if (field === 'speed' && selected === clip && clip.speed >= 0.5 && clip.speed <= 3) player.playbackRate = clip.speed;
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
  return `分镜 ${String(index + 1).padStart(2, '0')}`;
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
    bindTrackPreview(poster, first, `${shotName} · 画面预览`);
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
    if (added) preview(added, `${shotName} · 画面预览`);
    if (heldFocus && mode === 'montage' && document.activeElement === document.body) {
      const next = added ? clipRows.get(added)?.querySelector('.preview-asset')
        : narrationTrackLane.querySelector(`[data-shot-index="${shots.indexOf(shot)}"] .match-shot-visual`);
      next?.focus();
    }
  });
  row.querySelector('.add-segment-narration').addEventListener('click', () => {
    if (operation || tracks.length >= maxCandidates) return;
    trackExpansion.get(shot)?.delete('segments');
    tracks.push(null);
    segmentNarrations.set(shot, tracks);
    renderLists();
  });
  return row;
}

function renderLists() {
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

function renderMaterials() {
  cancelMaterialMarquee();
  const query = $('#material-search').value.trim().toLocaleLowerCase();
  const folder = materialFolderPath.at(-1);
  const catalog = new Map();
  for (const shot of shots) {
    for (const clip of shot) {
      const { id, name, kind } = clip.asset;
      if (!catalog.has(id)) catalog.set(id, { id, name, kind, clip });
    }
  }
  for (const [id, item] of selectedMaterials) {
    if (item.clip && !catalog.has(id)) selectedMaterials.delete(id);
  }
  const files = folder?.files ?? [...catalog.values()];
  const folders = folder?.folders ?? [...materialFolders.values()];
  const matches = ({ name }) => name.toLocaleLowerCase().includes(query);
  const visibleFiles = files.filter(matches);
  const visibleFolders = folders.filter(matches);
  const folderCount = visibleFolders.length ? ` · ${visibleFolders.length} 个文件夹` : '';
  $('#material-status').textContent = (query ? `${visibleFiles.length} / ${files.length} 个素材` : `${files.length} 个素材`) + folderCount;
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
    button.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) selectMaterial(item, !selectedMaterials.has(id));
      else previewLibraryMaterial(item);
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
  if (target !== document.body && target.id !== 'timeline-tracks-panel' && trackPreviewButtons.get(target) !== selected
      && (!material || material.id !== (previewedMaterial ?? selected.asset.id))) return;
  if (key === ' ') {
    event.preventDefault();
    if (event.repeat) return;
    if (!player.paused) player.pause();
    else {
      if (player.currentTime < selected.start || player.currentTime >= selected.end) seekPreview();
      const clip = selected;
      player.play().catch((error) => {
        if (selected === clip && error.name !== 'AbortError') say(`无法播放预览：${error.message}`);
      });
    }
  } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && player.readyState >= 1) {
    event.preventDefault();
    player.pause();
    const fps = selected.asset.fps > 0 ? selected.asset.fps : Number($('#fps').value);
    const time = Math.max(selected.start, Math.min(selected.end, player.currentTime));
    const step = (key === 'ArrowLeft' ? -1 : 1) / fps;
    player.currentTime = Math.max(selected.start, Math.min(selected.end, time + step));
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
}

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
    preview(item.clip);
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

async function addLibraryMaterials(items, shot) {
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
    } else shots.push(clips);
    for (const { id } of items) selectedMaterials.delete(id);
    const duplicates = items.length - additions.length;
    if (duplicates) say(`已添加 ${additions.length} 条候选，跳过 ${duplicates} 项重复素材。`);
    activateTimelineTab($('#timeline-tracks-tab'));
    preview(clips[0], '素材预览', additions[0].materialId);
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
  const row = event.target.closest('.shot');
  const shot = row ? shots[Number(row.dataset.shotIndex)] : undefined;
  if (shot ? shot.length >= maxCandidates : shots.length >= maxShots) return;
  return { target: row ?? event.target.closest('#shots-empty') ?? $('#new-shot-drop'), shot };
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
  $('#track-delete').disabled = busy || !shot;
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
    player.volume = target ? (keepAudio ? target.volume / 100 : 0) : 1;
  }
  $('#track-volume-apply').disabled = busy || !target || !(volume.valueAsNumber >= 0 && volume.valueAsNumber <= 100);
}

function applyTrackVolume() {
  const shot = trackShot();
  const volume = $('#track-volume').valueAsNumber;
  if (operation || !shot || !selected.asset.hasAudio || !(volume >= 0 && volume <= 100)) return;
  const scope = $('#track-volume-scope').value;
  const clips = scope === 'all' ? shots.flat() : scope === 'shot' ? shot : [selected];
  for (const clip of clips) if (clip.asset.kind === 'video' && clip.asset.hasAudio) clip.volume = volume;
  player.volume = $('#keep-audio').checked ? volume / 100 : 0;
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
  const voiceCaptions = segmented ? trackRows.some((row) => row.some((asset) => narrationCaptions.has(asset?.id)))
    : narrationCaptions.has(narration?.id) || extraWholeTracks.some((track) => narrationCaptions.has(track.narration?.id));
  const hasSubtitles = voiceCaptions || (!segmented && Boolean(subtitles || extraWholeTracks.some((track) => track.subtitles)));
  const narrationChoices = segmented ? segmentVariants(trackRows, segmentSelection) : 1 + extraWholeTracks.length;
  const combinations = shots.length
    ? shots.reduce((total, shot) => Math.min(maxExports, total * shot.length * variants), narrationChoices) : 0;
  const invalidTrim = shots.some((shot) => shot.some((clip) => !validClip(clip)));
  const audioMode = mode === 'audio';
  countField.max = Math.max(1, combinations);
  if (countField.valueAsNumber > Number(countField.max)) countField.value = countField.max;
  $('#combinations').textContent = variants === 0 ? '至少选择一种参与混剪的素材。' : invalidTrim ? '请检查素材的裁切、停留时长或速度。'
    : combinations === 0 ? '每组分镜至少添加一条候选。' : `本批最多生成 ${combinations} 条。`;
  const count = countField.valueAsNumber;
  const musicVolume = $('#music-volume').valueAsNumber;
  const narrationVolumeField = $('#narration-volume');
  const captionSizeField = $('#caption-size');
  if (!hasNarration && !(narrationVolumeField.valueAsNumber >= 0 && narrationVolumeField.valueAsNumber <= 100)) {
    narrationVolumeField.value = 100;
  }
  if (!hasSubtitles && (!Number.isInteger(captionSizeField.valueAsNumber) || captionSizeField.valueAsNumber < 12 || captionSizeField.valueAsNumber > 36)) {
    captionSizeField.value = 18;
  }
  const narrationVolume = narrationVolumeField.valueAsNumber;
  const captionSize = captionSizeField.valueAsNumber;
  const invalidTransition = shots.some((shot) => {
    const item = shotTransitions.get(shot);
    return item && !(item.duration >= 0.1 && item.duration <= 2);
  });
  const validMontage = combinations > 0 && !invalidTrim && Number.isInteger(count) && count >= 1 && count <= combinations
    && !invalidTransition && narrationVolume >= 0 && narrationVolume <= 100
    && Number.isInteger(captionSize) && captionSize >= 12 && captionSize <= 36
    && (!music.length || (musicVolume >= 0 && musicVolume <= 100));
  const busy = Boolean(operation);
  const config = mode === 'montage' || previewBatch || projectName ? montageConfig() : null;
  const configKey = config ? JSON.stringify(config) : '';
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
    panel.querySelector('.add-segment-narration').disabled = busy || trackRows[index].length >= maxCandidates;
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
  $('#subtitle-style-settings').hidden = !hasSubtitles;
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
  $('#segment-narration-help').textContent = segmentSelection === 'ordered'
    ? '每条成片在各分镜使用同一轨号，空轨保持无口播。'
    : '每组分镜随机抽一条已添加的口播。';
  $('#priority-help').textContent = $('#priority').value === 'voice'
    ? (segmented ? '对白保持原速，裁短相邻口播接缝的静音。画面不足先补同组候选，仍不足则复用同组素材，再统一加速对齐。'
      : '整段口播保持原速。画面不足先从各自分镜补候选，仍不足则复用同组素材，画面较长时统一加速对齐。')
    : `${segmented ? '每组分镜' : ''}保留完整画面，超出的口播会被裁剪。`;
  $('#prepare-preview').disabled = busy || !validMontage;
  $('#prepare-preview').hidden = audioMode;
  $('#prepare-preview').textContent = operation === 'prepare-preview' ? '正在生成…' : previewBatch ? '重新生成预览' : '生成预览';
  $('#start-export').disabled = busy || (audioMode ? audioTargets.length === 0 : !validMontage || previewBatch?.selected.size === 0);
  $('#start-export').textContent = audioMode ? '开始提取' : previewBatch ? '导出已选' : '导出';
  $('#cancel-export').hidden = operation !== 'export';
  updateTrackSelection();
  $('#track-undo').disabled = busy || !editHistory?.canUndo();
  $('#track-redo').disabled = busy || !editHistory?.canRedo();
  $('#track-reset').disabled = busy || !editBaseline || configKey === JSON.stringify(editBaseline);
  $('#track-clean').disabled = busy || !shots.some(canRemoveEmptyShot);
  if (previewBatch) {
    const { entries, selected: selectedEntries } = previewBatch;
    $('#preview-batch-summary').textContent = `已选 ${selectedEntries.size} / ${entries.length} 条`;
    $('#select-all-previews').disabled = busy || selectedEntries.size === entries.length;
    $('#clear-preview-selection').disabled = busy || selectedEntries.size === 0;
    for (const control of document.querySelectorAll('.batch-select, .preview-composition')) control.disabled = busy;
  }
  updateSceneSplitControls();
}

function setMode(value) {
  if (value === mode) return;
  draftLibrary.cancelCoverTransition();
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
    dialogue.textContent = row.dialogue;
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
    status.textContent = items.length ? '' : '完成导出后，作品会出现在这里。';
    const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      const date = document.createElement('time');
      const reveal = document.createElement('button');
      name.textContent = item.name;
      name.title = item.name;
      date.dateTime = item.createdAt;
      date.textContent = formatter.format(new Date(item.createdAt));
      reveal.type = 'button';
      reveal.className = 'home-link';
      reveal.textContent = '在文件夹中显示';
      reveal.addEventListener('click', () => api.reveal(item.path).catch((error) => { status.textContent = error.message; }));
      row.append(name, date, reveal);
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
    for (const asset of reply.assets) editAssets.set(asset.id, asset);
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
  openCloudTts({
    items,
    onUse(results, settings) {
      if (!results.length) return;
      let slot;
      if (segmented) {
        if (results.some(({ index }) => index >= maxShots)) throw new Error('分段口播超出分镜上限。');
        slot = Array.from({ length: maxCandidates }, (_, index) => index).find((index) => results.every((result) =>
          !shots[result.index] || !segmentNarrations.get(shots[result.index])?.[index]));
        if (slot === undefined) throw new Error('这些分镜没有共同的空口播轨，请清理轨道后再应用。');
      } else if (results.length > wholeRoom()) throw new Error('整段口播轨数量不足，请减少任务。');

      applyingEdit = true;
      try {
        if (model) attachScript({ ...model, mode: trackMode, tab: 'narration' });
        for (const result of results) {
          const audio = keepCloudAudio(result, settings);
          if (segmented) {
            const shot = shots[result.index];
            const tracks = segmentNarrations.get(shot) ?? [];
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
    const slot = Array.from({ length: maxCandidates }, (_, index) => index)
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
    button.addEventListener('click', () => api.reveal(item.path).catch((error) => say(error.message)));
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

function montageConfig() {
  const segments = shots.map((shot) => (segmentNarrations.get(shot) ?? []).map((asset) => asset?.id ?? null));
  const extras = extraWholeTracks.map(({ narration, subtitles }) => ({ narrationId: narration?.id ?? null, subtitles }));
  const captionIds = new Set([narration?.id, ...extras.map((track) => track.narrationId), ...segments.flat()]);
  return {
    shots: shots.map((shot) => shot.map(({ asset, start, end, volume, speed }) => ({ id: asset.id, start, end, volume, speed }))),
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
    subtitleStyle: {
      size: $('#caption-size').valueAsNumber,
      position: $('#caption-position').value,
      textColor: $('#caption-color').value,
      outlineColor: $('#caption-outline').value,
    },
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

function renderPreviewBatch() {
  const batch = previewBatch;
  const segmented = $('#narration-mode').value === 'segmented';
  const rows = batch.entries.map((entry) => {
    const row = template('#preview-batch-template');
    const number = entry.index + 1;
    const checkbox = row.querySelector('.batch-select');
    checkbox.checked = batch.selected.has(entry.index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) batch.selected.add(entry.index);
      else batch.selected.delete(entry.index);
      updateControls();
    });
    row.querySelector('.batch-title').textContent = `第 ${number} 条`;
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
  activateTimelineTab(tab, document.activeElement === document.body);
}

function selectPreviews(selectAll) {
  if (operation || !previewBatch) return;
  previewBatch.selected = new Set(selectAll ? previewBatch.entries.map(({ index }) => index) : []);
  for (const checkbox of document.querySelectorAll('.batch-select')) checkbox.checked = selectAll;
  updateControls();
}

async function preparePreview() {
  if (operation || $('#prepare-preview').disabled) return;
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
    const result = await api.preparePreview(config);
    if (!result) {
      say('已取消生成预览组合。');
      return;
    }
    discardPreviewBatch();
    previewBatch = {
      ...result,
      configKey: JSON.stringify(config),
      selected: new Set(result.entries.map(({ index }) => index)),
    };
    renderPreviewBatch();
  } catch (error) {
    say(error.message);
  } finally {
    if (analyzeSeams) $('#batch-job').hidden = true;
    operation = '';
    updateControls();
  }
}

function playRenderedClip(clip) {
  preview(clip, '成片预览');
  player.play().catch(() => {
    if (selected === clip && !player.error) say('成片预览已就绪，可以在播放器中点击播放。');
  });
}

async function playComposition(index) {
  if (operation || !previewBatch) return;
  const batch = previewBatch;
  if (batch.current?.index === index) {
    say('');
    playRenderedClip(batch.current.clip);
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
    playRenderedClip(clip);
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
  const findAsset = (id) => {
    if (!byId.has(id)) throw new Error('打开的工程缺少素材。');
    return byId.get(id);
  };
  const restoredShots = config.shots.map((shot) => shot.map(({ id, start, end, volume, speed }) => ({
    asset: findAsset(id), start: start ?? NaN, end: end ?? NaN, volume: volume ?? 100,
    speed: speed === undefined ? 1 : speed ?? NaN,
  })));
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
    editAssets.clear();
    for (const [id, asset] of byId) editAssets.set(id, asset);
  }
  applyingEdit = true;
  shots.splice(0, shots.length, ...restoredShots);
  for (const [index, shot] of shots.entries()) {
    if (!retainHistory && shot.length && shot.every(validClip)) trackExpansion.set(shot, new Map([['body', false]]));
    segmentNarrations.set(shot, restoredTracks[index]);
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
  $('#caption-size').value = config.subtitleStyle?.size === undefined ? 18 : config.subtitleStyle.size;
  $('#caption-position').value = config.subtitleStyle?.position ?? 'bottom';
  $('#caption-color').value = config.subtitleStyle?.textColor ?? '#ffffff';
  $('#caption-outline').value = config.subtitleStyle?.outlineColor ?? '#000000';
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
    editBaseline = montageConfig();
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
      if (firstShot >= 0) preview(shots[firstShot][0], `${shotLabel(firstShot)} · 画面预览`);
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
  const firstPoster = $('.shot-poster:not([hidden])');
  return {
    coverUrl: result.coverUrl,
    target: clip && (clip.kind === 'image' ? still : player),
    focusTarget: firstPoster?.checkVisibility() ? firstPoster : $('#open-project'),
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
    (visualTrackLane.querySelector('.shot-toggle') ?? button).focus();
  }
});
$('#empty-split-narration').addEventListener('click', splitNarrationWithSubs2srs);
$('#material-folder-import').addEventListener('click', addMaterialFolder);
$('#material-search').addEventListener('input', renderMaterials);
window.addEventListener('keydown', handlePreviewKey);
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
  addLibraryMaterials(drag.items, place.shot);
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
$('#prepare-preview').addEventListener('click', preparePreview);
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
  if (volumeTarget) player.volume = $('#keep-audio').checked ? volumeTarget.volume / 100 : 0;
  updateControls();
});
$('#keep-audio').addEventListener('change', () => {
  if (volumeTarget) player.volume = $('#keep-audio').checked ? volumeTarget.volume / 100 : 0;
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
$('#montage-settings').addEventListener('input', (event) => updateControls(event.target.type === 'number' ? event.target : undefined), true);
$('#montage-settings').addEventListener('change', () => updateControls(), true);
$('#montage-settings').addEventListener('focusout', () => updateControls());
editBaseline = montageConfig();
editHistory = window.createEditHistory(editBaseline);
draftAutosave.reset(undefined, draftTitle(), JSON.stringify(editBaseline));
bindTrackDisclosure($('.script-brief-toggle'), $('#script-brief-rows'), $('#script-brief'), 'script', '脚本摘要');
renderLists();
refreshHistory();
draftLibrary.refresh();

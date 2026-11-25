'use strict';

function libraryTime(duration) {
  const seconds = Math.max(0, Math.round(duration));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function updateMaterialUsage(button, used) {
  const old = button.querySelector('.material-used');
  if (!used) {
    old?.remove();
    delete button.dataset.used;
    button.removeAttribute('aria-label');
    return;
  }
  const shotNumbers = [...used].filter(Number.isInteger);
  const labels = [...used].filter(label => typeof label === 'string');
  if (shotNumbers.length) labels.unshift('分镜 ' + shotNumbers.join('、'));
  const description = '已用于' + labels.join('、');
  if (old?.title === description) return;
  const badge = old ?? document.createElement('span');
  badge.className = 'material-used';
  badge.textContent = '已用';
  badge.title = description;
  button.dataset.used = 'true';
  button.setAttribute('aria-label', button.title + '，' + badge.title);
  if (!old) button.append(badge);
}

function reconcileMaterialRows(list, rows) {
  const next = new Set(rows);
  for (const old of [...list.children]) {
    if (next.has(old)) continue;
    thumbnailObserver.unobserve(old.firstElementChild);
    old.remove();
  }
  rows.forEach((row, index) => {
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
}

function materialUsage() {
  const usage = new Map();
  function mark(asset, label) {
    if (!asset) return;
    const key = asset.sourceKey ?? asset.id;
    if (!usage.has(key)) usage.set(key, new Set());
    usage.get(key).add(label);
  }
  function layers(items, label) {
    for (const item of items ?? []) {
      if (Array.isArray(item)) layers(item, label);
      else if (item?.id) mark(editAssets.get(item.id), label);
    }
  }
  const segmented = $('#narration-mode').value === 'segmented';
  shots.forEach((shot, i) => {
    const label = '分镜 ' + (i + 1);
    for (const clip of shot) { mark(originalMaterial(clip), i+1); layers(clip.layers, i+1); }
    if (segmented) segmentNarrations.get(shot)?.forEach(asset => mark(asset, label + '口播'));
  });
  if (!segmented) {
    mark(narration, '整段口播');
    extraWholeTracks.forEach(track => mark(track.narration, '整段口播'));
  }
  music.forEach(asset => mark(asset, '配乐'));
  if (editCover?.mode === 'library') {
    for (const item of editCover.items ?? []) mark(editAssets.get(item.id), '封面');
  }
  const pack = packaging.forShots(shots);
  layers(pack.global, '全局轨道');
  layers(pack.composites, '复合轨道');
  layers(pack.textGroups, '文字组');
  layers(segmented ? pack.segmentNarration : pack.wholeNarration, '口播轨道');
  return usage;
}

function renderMaterials() {
  cancelMaterialMarquee();
  if (materialMenu.matches(':popover-open')) materialMenu.hidePopover();
  const query = $('#material-search').value.trim().toLocaleLowerCase();
  const catalog = new Map();
  const usage = materialUsage();
  const bin = currentMaterialBin();
  const excluded = bin.hidden;
  const hiddenFolder = materialFolderPath.findIndex((entry) => excluded.has(entry.sourceKey));
  if (hiddenFolder !== -1) materialFolderPath.splice(hiddenFolder);
  const folder = currentLibraryFolder();
  const organization = folderTree.rows.get(folder?.id);
  // Older projects and direct track imports can introduce a source through its first placement.
  for (const shot of shots) {
    for (const clip of shot) {
      const source = originalMaterial(clip);
      if (excluded.has(source.sourceKey)) continue;
      if (!editAssets.has(source.id)) editAssets.set(source.id, source);
      bin.ids.add(source.id);
    }
  }
  for (const id of bin.ids) {
    const asset=editAssets.get(id);
    if (asset) catalog.set(id, {id,name:asset.name,kind:asset.kind,sourceKey:asset.sourceKey,clip:candidate(asset)});
  }
  for(const [id,entry] of materialAliases)if(!catalog.has(id)&&editAssets.has(id))catalog.set(id,{...entry,clip:candidate(editAssets.get(id))});
  for (const [id, item] of selectedMaterials) {
    if (item.clip && !catalog.has(id)) selectedMaterials.delete(id);
  }
  const assigned = new Set();
  for (const row of folderTree.rows.values()) if (row.scope === libraryScope()) for (const id of row.assetIds) assigned.add(id);
  renderProcessedMaterials(usage, assigned);
  const assignedKeys = new Set([...assigned].map(id => editAssets.get(id)?.sourceKey).filter(Boolean));
  const linkedFiles = organization ? folderTree.files.get(organization.id) ?? [] : folder?.files ?? [];
  const files = linkedFiles.filter(item => !organization?.hiddenKeys?.includes(item.sourceKey) && !assignedKeys.has(item.sourceKey))
    .map(item => ({...item, name: materialAliases.get(item.assetId)?.name ?? item.name}));
  if (organization) {
    for (const id of organization.assetIds) if (catalog.has(id)) files.push(catalog.get(id));
  } else if (!folder) {
    for (const [id,item] of catalog) if (!assigned.has(id)) files.push(item);
  }
  const folders = visibleLibraryFolders();
  const matches = ({ name }) => name.toLocaleLowerCase().includes(query);
  const availableFiles = files.filter((item)=>!excluded.has(item.sourceKey ?? item.clip?.asset.sourceKey));
  const visibleFiles = availableFiles.filter(matches);
  const visibleFolders = folders.filter((entry) => !excluded.has(entry.sourceKey) && matches(entry));
  const folderCount = visibleFolders.length ? ` · ${visibleFolders.length} 个文件夹` : '';
  $('#material-status').textContent = (query ? `${visibleFiles.length} / ${availableFiles.length} 个素材` : `${availableFiles.length} 个素材`) + folderCount;
  $('#material-empty').hidden = visibleFiles.length > 0 || visibleFolders.length > 0;
  $('#material-empty-title').textContent = query ? '没有匹配的素材' : folder ? '这个文件夹没有可用素材' : '暂无素材';
  $('#material-empty-hint').textContent = query ? '试试搜索其他文件名。' : folder
    ? '请选择包含视频或图片的文件夹。' : '从本机或局域网共享文件夹拖入视频、图片、音频或文件夹。';
  renderMaterialFolders(folder, visibleFolders);
  const previous = new Map([...materialList.children].map((row) => [row.firstElementChild.dataset.materialId, row]));
  const canPlace = canPlaceMaterial();
  reconcileMaterialRows(materialList, visibleFiles.map((item) => {
    const { id, name: fileName, kind, clip, previewUrl } = item;
    const old = previous.get(id);
    const used = usage.get(item.sourceKey ?? clip?.asset.sourceKey ?? item.assetId ?? id);
    const missing=Boolean(clip?.asset.missing);
    if (old?.firstElementChild.title === fileName && (old.firstElementChild.dataset.missing==='true')===missing) {
      materialItems.set(old.firstElementChild, item);
      updateMaterialUsage(old.firstElementChild, used);
      return old;
    }
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
    if (missing) button.dataset.missing='true';
    const browsingHint = missing ? '素材缺失，打开缺失清单可重新定位' : kind === 'image' ? '方向键浏览素材' : '点击播放，空格暂停或继续，方向键浏览素材';
    button.setAttribute('aria-description', browsingHint);
    button.setAttribute('aria-keyshortcuts', 'Delete Shift+F10 ArrowLeft ArrowRight ArrowUp ArrowDown Home End' + (kind === 'video' ? ' Space' : ''));
    button.setAttribute('aria-haspopup', 'menu');
    button.draggable = true;
    thumbnail.className = 'material-thumbnail';
    if (clip) setMaterialAspect(thumbnail, clip.asset.width, clip.asset.height);
    thumbnail.title = `${fileName} · ${browsingHint}`;
    thumbnail.setAttribute('aria-hidden', 'true');
    name.textContent = fileName;
    detail.className = 'material-duration';
    detail.textContent = missing ? '素材缺失' : kind === 'image' ? '图片' : clip ? libraryTime(clip.asset.duration) : '';
    const imageUrl = kind === 'image' ? clip?.asset.url ?? previewUrl : undefined;
    if (imageUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.draggable = false;
      image.addEventListener('load', () => setMaterialAspect(thumbnail, image.naturalWidth, image.naturalHeight), { once: true });
      image.src = imageUrl;
      thumbnail.append(image);
    } else thumbnail.textContent = missing ? '⚠' : kind === 'video' ? '▶' : kind === 'audio' ? '♫' : '▧';
    button.append(thumbnail, name, detail);
    updateMaterialUsage(button, used);
    button.addEventListener('click', (event) => {
      const item = materialItems.get(button);
      if (missing && !event.ctrlKey && !event.metaKey) {
        const box=$('#missing-materials'); box.open=true; box.querySelector('summary').focus();
      } else if (event.ctrlKey || event.metaKey) selectMaterial(item, !selectedMaterials.has(id));
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
      const items=selectedMaterials.has(id) ? [...selectedMaterials.values()] : [materialItems.get(button)];
      const firstTile=items[0].id===id ? button : materialList.querySelector('[data-material-id="'+CSS.escape(items[0].id)+'"]');
      materialDrag = {id,items,visual:items.every(item=>item.kind==='video' || item.kind==='image'),
        sourceDuration:Number(firstTile?.querySelector('.material-duration')?.dataset.sourceSeconds),
        thumbnail:button.querySelector('.material-thumbnail img')?.currentSrc};
      event.dataTransfer.setData(materialDragType, id);
      if (items.length === 1 && items[0].kind === 'audio') event.dataTransfer.setData(processedAudioDrag, items[0].clip?.asset.id ?? items[0].id);
      event.dataTransfer.effectAllowed = 'copyMove';
      activateTimelineTab($('#timeline-tracks-tab'));
      if(materialDrag.visual) timeline.showLibraryLane(materialDrag,maxCandidates);
    });
    button.addEventListener('dragend', clearMaterialDrag);
    check.type = 'checkbox';
    check.className = 'material-select';
    check.title = '多选素材';
    check.setAttribute('aria-label', `选择 ${fileName}`);
    check.addEventListener('change', () => selectMaterial(materialItems.get(button), check.checked));
    add.type = 'button';
    add.className = 'material-quick-add';
    add.hidden = kind === 'audio';
    add.textContent = '＋';
    add.disabled = !canPlace;
    add.title = '添加到分镜';
    add.setAttribute('aria-label', `添加 ${fileName} 到分镜`);
    add.addEventListener('click', () => chooseMaterialTarget([materialItems.get(button)]));
    row.append(button, check, add);
    if (kind === 'video' && !missing) thumbnailObserver.observe(button);
    return row;
  }));
  updateMaterialSelection();
  updateMaterialBatchControls();
}

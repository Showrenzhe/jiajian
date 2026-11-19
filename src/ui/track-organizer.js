'use strict';

(() => {
  const actions = [
    ['empty', '删除空轨道'], ['placeholder', '清理默认文字和空白文本框'],
    ['duration', '分镜时长对齐最长口播'], ['bounds', '修正画布外的元素'], ['start', '口播及关联轨道对齐分镜起点'],
  ];

  function organizeTracks(input, selected, getAsset, measureText) {
    const config = structuredClone(input);
    const counts = Object.fromEntries(actions.map(([key]) => [key, 0]));
    const pack = config.packaging ?? {};
    const [rw, rh] = config.ratio.split(':').map(Number);
    const width = config.resolution * Math.max(1, rw / rh);
    const height = config.resolution * Math.max(1, rh / rw);
    const placeholders = new Set(['', '默认文本', '请在此处输入文字']);

    function contain(layer) {
      if (layer.kind === 'sound') return;
      const asset = getAsset(layer.id);
      const angle = Math.PI / 180;
      const initial = { x: layer.x ?? .5, y: layer.y ?? .5, scale: layer.scale ?? (layer.kind === 'text' ? 1 : .35), rotation: layer.rotation ?? 0 };
      let previous = initial;
      let changed = false;
      for (const frame of [layer, ...(layer.keyframes ?? [])]) {
        const values = { ...previous, ...frame };
        let w, h;
        if (layer.kind === 'text') {
          const size = (layer.fontSize ?? 48) * width / 1080;
          const lines = (layer.text ?? '').split('\n');
          w = Math.max(1, ...lines.map((line) => measureText(line, size) + 2));
          h = Math.max(1, lines.length) * size * 1.15 + 2;
        } else {
          if (!(asset?.width > 0 && asset.height > 0)) continue;
          w = width; h = width * asset.height / asset.width;
        }
        const cos = Math.abs(Math.cos(values.rotation * angle));
        const sin = Math.abs(Math.sin(values.rotation * angle));
        const bw = Math.max(1, w * cos + h * sin), bh = Math.max(1, w * sin + h * cos);
        const scale = Math.max(.05, Math.min(values.scale, width / bw, height / bh));
        const halfX = Math.min(.5, bw * scale / (2*width)), halfY = Math.min(.5, bh * scale / (2*height));
        const fixed = { x: Math.max(halfX, Math.min(1 - halfX, values.x)), y: Math.max(halfY, Math.min(1 - halfY, values.y)), scale };
        for (const [key, value] of Object.entries(fixed)) {
          if (Math.abs(values[key] - value) <= 1e-7) continue;
          frame[key] = value; changed = true;
        }
        previous = { ...values, ...fixed };
      }
      if (changed) counts.bounds++;
    }

    function cleanLayers(items) {
      if (!Array.isArray(items)) return;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (Array.isArray(item)) { cleanLayers(item); continue; }
        if (!item?.kind) continue;
        if (selected.placeholder && item.kind === 'text' && placeholders.has((item.text ?? '').trim())) {
          items.splice(i, 1); counts.placeholder++;
        } else if (selected.bounds) contain(item);
      }
    }
    for (const value of Object.values(pack)) if (Array.isArray(value)) cleanLayers(value);
    for (const shot of config.shots) for (const clip of shot) cleanLayers(clip.layers);

    const rows = config.segmentNarrationIds ?? [];
    if (config.narrationMode === 'segmented') {
      for (let i = 0; i < rows.length; i++) {
        let longest = 0;
        for (const [j, id] of rows[i].entries()) {
          if (!id) continue;
          const edit = config.segmentVoiceCuts?.[i]?.[j];
          if (selected.start && edit?.offset > 0) { edit.offset = 0; counts.start++; }
          const duration = edit?.ranges?.reduce((sum, r) => sum + r.end - r.start, 0) ?? getAsset(id)?.duration;
          if (Number.isFinite(duration)) longest = Math.max(longest, duration + (edit?.offset ?? 0));
        }
        if (selected.duration && longest >= .1) {
          config.shotSettings ??= config.shots.map(() => null);
          const settings = config.shotSettings[i] ?? {};
          if (Math.abs((settings.duration ?? 0) - longest) > 1e-6) {
            config.shotSettings[i] = { ...settings, duration: Math.round(longest * 1000000) / 1000000 };
            counts.duration++;
          }
        }
      }
    }

    if (selected.empty) {
      const width = Math.max(0, ...rows.map((row) => row.length), ...(pack.segmentNarration ?? []).map((row) => row.length));
      for (let col = width - 1; col >= 0; col--) {
        if (rows.some((row) => row[col]) || pack.segmentNarration?.some((row) => row[col]?.length)) continue;
        for (const grid of [rows, config.segmentVoiceCuts ?? [], pack.segmentNarration ?? []]) for (const row of grid) row.splice(col, 1);
        counts.empty++;
      }
      // A blank cell in an occupied row is meaningful for ordered narration. Preserve the whole row.
      for (let i = (config.extraWholeTracks?.length ?? 0) - 1; i >= 0; i--) {
        const track = config.extraWholeTracks[i], script = config.script?.whole?.[i+1];
        if (track.narrationId || track.subtitles?.cues?.length || pack.wholeNarration?.[i+1]?.length || script?.dialogue || script?.note) continue;
        config.extraWholeTracks.splice(i, 1); pack.wholeNarration?.splice(i+1, 1);
        config.script?.whole?.splice(i+1, 1); counts.empty++;
      }
      for (const [key, populated] of [['composites', (items) => items.length], ['textGroups', (row) => row.some((items) => items.length)]]) {
        const groups = pack[key] ?? [];
        for (let i = groups.length - 1; i >= 0; i--) {
          if (populated(groups[i])) continue;
          groups.splice(i, 1); counts.empty++;
        }
      }
      // The fixed visual track remains. Discard mute flags for rows that no longer contain video.
      if (config.mutedVideoTracks) {
        const max = Math.max(0, ...config.shots.map((shot) => shot.length));
        const kept = config.mutedVideoTracks.filter((i) => i < max);
        counts.empty += config.mutedVideoTracks.length - kept.length;
        config.mutedVideoTracks = kept;
      }
    }
    return { config, counts };
  }

  function mountTrackOrganizer({ trigger, getConfig, getAsset, apply, busy, notify }) {
    const dialog = document.createElement('dialog'); dialog.className = 'track-organizer';
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h3'); title.textContent = '轨道一键整理';
    form.append(title);
    const inputs = actions.map(([key, description]) => {
      const label = document.createElement('label'); const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = true; label.append(input, document.createTextNode(description));
      form.append(label); return { key, input };
    });
    const buttons = document.createElement('footer');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.onclick = () => dialog.close();
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = '整理轨道'; buttons.append(cancel, save);
    form.append(buttons); dialog.append(form); document.body.append(dialog);
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (line, px) => { ctx.font = px + 'px "Microsoft YaHei", sans-serif'; return ctx.measureText(line).width; };
    function open() { if (!busy?.() && !dialog.open) dialog.showModal(); }
    trigger?.addEventListener('click', open);
    form.onsubmit = (event) => {
      event.preventDefault(); if (busy?.()) return;
      const options = Object.fromEntries(inputs.map(({ key, input }) => [key, input.checked]));
      const { config, counts } = organizeTracks(getConfig(), options, getAsset, measure);
      const changed = actions.filter(([key]) => counts[key]);
      if (changed.length) apply(config);
      dialog.close(); notify?.(changed.length ? changed.map(([key, text]) => text + ' ' + counts[key] + ' 项').join(' · ') : '轨道已整齐，当前工程无需调整。');
    };
    return { open };
  }
  if (typeof module === 'object' && module.exports) module.exports = { organizeTracks };
  else window.mountTrackOrganizer = mountTrackOrganizer;
})();

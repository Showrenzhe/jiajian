'use strict';

(() => {
  const visualFields = [
    ['x', '水平位置', 0, 100, 100, '%'], ['y', '垂直位置', 0, 100, 100, '%'],
    ['scale', '缩放', 5, 100, 100, '%'], ['rotation', '旋转', -3600, 3600, 1, '°'],
    ['opacity', '不透明度', 0, 100, 100, '%'],
  ];
  const defaults = { x: .5, y: .5, scale: .35, rotation: 0, opacity: 1 };
  const make = (tag, content, className) => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  function atTime(layer, key, time) {
    let value = layer[key] ?? (key === 'scale' && ['text', 'candidate'].includes(layer.kind) ? 1 : defaults[key]);
    let previous = 0;
    for (const frame of layer.keyframes) {
      if (frame[key] === undefined) continue;
      if (time < frame.time) return value + (frame[key] - value) * (time - previous) / (frame.time - previous);
      value = frame[key];
      previous = frame.time;
    }
    return value;
  }

  window.editLayerMotion = (original, options = {}) => new Promise((resolve) => {
    const layer = structuredClone(original);
    const candidate = layer.kind === 'candidate';
    const fields = visualFields.map((row) => row[0] === 'scale' && candidate ? [row[0], row[1], row[2], 400, row[4], row[5]] : row);
    layer.keyframes = (layer.keyframes ?? []).sort((a, b) => a.time - b.time);
    const dialog = make('dialog', undefined, 'layer-motion-dialog');
    const heading = make('h2', candidate ? '画面变换与蒙版' : '变换与关键帧');
    dialog.setAttribute('aria-label', heading.textContent);
    const upper = make('div', undefined, 'layer-motion-columns');
    const stage = make('div', undefined, 'layer-motion-stage');
    const preview = make('div', undefined, 'layer-motion-sprite');
    let moveMaskHandles = () => {};
    let showMaskFrame = () => {};
    let time = 0;
    let ticking = 0;
    let video;
    if (layer.kind !== 'text' && options.url?.startsWith('sd-workbench://asset/')) {
      const media = make(options.kind === 'video' ? 'video' : 'img');
      media.src = options.url;
      if (media.tagName === 'VIDEO') { video = media; video.muted = true; video.preload = 'auto'; }
      else media.alt = '所选图层';
      preview.append(media);
    } else {
      preview.textContent = layer.text || (layer.kind === 'pip' ? '画中画' : '贴纸');
      if (layer.kind === 'text') window.previewTextAppearance(preview, layer.textStyle, layer.color ?? '#fff');
    }
    stage.append(preview);
    const controls = make('div', undefined, 'layer-motion-values');
    upper.append(stage, controls);
    const timeline = make('div', undefined, 'layer-motion-time');
    const play = make('button', '播放');
    const range = make('input');
    range.type = 'range'; range.min = '0'; range.step = '.01'; range.setAttribute('aria-label', '关键帧时间');
    const timeBox = make('input');
    timeBox.type = 'number'; timeBox.min = '0'; timeBox.step = '.01'; timeBox.setAttribute('aria-label', '时间（秒）');
    const length = Math.max(.01, layer.end != null ? layer.end - (layer.start ?? 0) : options.duration || 5,
      ...layer.keyframes.map((frame) => frame.time));
    timeBox.max = range.max = String(length);
    timeline.append(play, range, timeBox, make('span', '秒'));
    const actions = make('div', undefined, 'layer-motion-actions');
    const add = make('button', '添加关键帧');
    const drop = make('button', '删除当前帧');
    const keys = make('div', undefined, 'layer-motion-keys');
    actions.append(add, drop);
    const footer = make('footer');
    const cancel = make('button', '取消');
    const save = make('button', '应用', 'layer-motion-primary');
    footer.append(cancel, save);
    dialog.append(heading, upper, timeline, actions, keys, footer);
    if (candidate) {
      const maskMenu = make('details', undefined, 'layer-motion-mask');
      maskMenu.append(make('summary', '几何蒙版'));
      maskMenu.open = !!layer.mask;
      const select = make('select');
      for (const [value, label] of [['', '无蒙版'], ['rectangle', '矩形'], ['ellipse', '椭圆']]) {
        const option = make('option', label); option.value = value; select.append(option);
      }
      select.setAttribute('aria-label', '蒙版形状');
      const values = make('div', undefined, 'layer-motion-mask-values');
      const reference = { x: .5, y: .5, width: .7, height: .7, rotation: 0, feather: 0, invert: false, keyframes: [], ...layer.mask };
      const maskKeys = ['x', 'y', 'width', 'height', 'rotation', 'feather'];
      const present = () => Object.fromEntries(maskKeys.map((key) => [key, atTime(reference, key, time)]));
      const pointAt = () => reference.keyframes.find((frame) => Math.abs(frame.time - time) < .00001);
      function setMask(values, forceFrame = false) {
        let target = reference;
        if (time > 0 || forceFrame || pointAt()) {
          target = pointAt();
          if (!target) {
            if (reference.keyframes.length >= 250) return;
            target = { time };
            reference.keyframes.push(target); reference.keyframes.sort((a, b) => a.time - b.time);
          }
        }
        Object.assign(target, values);
        redraw(); drawKeys(); showMaskFrame(); moveMaskHandles();
      }
      const svgTag = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);
      const svg = svgTag('svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      const defs = svgTag('defs'); const mask = svgTag('mask'); mask.id = 'motion-mask-' + crypto.randomUUID();
      mask.setAttribute('maskContentUnits', 'objectBoundingBox'); defs.append(mask); svg.append(defs); dialog.append(svg);
      let signature;
      function redraw() {
        values.hidden = !select.value;
        if (!select.value) { delete layer.mask; preview.style.mask = ''; signature = undefined; return; }
        layer.mask = { ...reference, shape: select.value };
        const valuesAtTime = present();
        const state = JSON.stringify([select.value, valuesAtTime, reference.invert, preview.offsetWidth, preview.offsetHeight]);
        if (state === signature) return;
        signature = state;
        const shapes = [];
        function shape(name, attrs, shade) {
          const elem = svgTag(name);
          for (const [key, value] of Object.entries(attrs)) elem.setAttribute(key, value);
          const amount = reference.invert ? 255 - shade : shade;
          elem.setAttribute('fill', `rgb(${amount},${amount},${amount})`);
          shapes.push(elem);
        }
        shape('rect', { x: 0, y: 0, width: 1, height: 1 }, 0);
        const { x: mx, y: my, width: mw, height: mh, rotation, feather } = valuesAtTime;
        const rad = rotation * Math.PI / 180;
        const a = Math.cos(rad), b = Math.sin(rad) * preview.offsetWidth / Math.max(1, preview.offsetHeight);
        const c = -Math.sin(rad) * preview.offsetHeight / Math.max(1, preview.offsetWidth);
        const transform = `matrix(${a} ${b} ${c} ${a} ${mx-a*mx-c*my} ${my-b*mx-a*my})`;
        const steps = feather ? 26 : 1;
        for (let i = 1; i <= steps; i++) {
          const factor = 1 - feather * (i - 1) / steps;
          const width = mw * factor, height = mh * factor;
          if (select.value === 'rectangle') shape('rect', { x: mx - width / 2, y: my - height / 2, width, height, transform }, Math.round(255 * i / steps));
          else shape('ellipse', { cx: mx, cy: my, rx: width / 2, ry: height / 2, transform }, Math.round(255 * i / steps));
        }
        mask.replaceChildren(...shapes);
        preview.style.mask = `url(#${mask.id})`;
      }
      const boxes = new Map();
      for (const [key, label, min] of [['x', '蒙版中心 X', 0], ['y', '蒙版中心 Y', 0], ['width', '宽度', 1], ['height', '高度', 1], ['rotation', '蒙版旋转', -3600], ['feather', '羽化', 0]]) {
        const row = make('label'); const field = make('input');
        const multiplier = key === 'rotation' ? 1 : 100;
        field.type = 'number'; field.min = String(min); field.max = key === 'rotation' ? '3600' : '100'; field.step = '1';
        field.value = String(Math.round(reference[key] * multiplier));
        boxes.set(key, field);
        field.onchange = () => setMask({ [key]: Math.max(min, Math.min(Number(field.max), Number(field.value))) / multiplier });
        row.append(make('span', label + (key === 'rotation' ? ' °' : ' %')), field); values.append(row);
      }
      const inverted = make('label'), toggle = make('input'); toggle.type = 'checkbox'; toggle.checked = reference.invert;
      toggle.onchange = () => { reference.invert = toggle.checked; redraw(); };
      inverted.append(toggle, make('span', '反转蒙版')); values.append(inverted);
      const maskRecord = make('button', '添加蒙版关键帧'), maskDelete = make('button', '删除蒙版关键帧');
      maskRecord.onclick = () => setMask(present(), true);
      maskDelete.onclick = () => { reference.keyframes = reference.keyframes.filter((frame) => frame !== pointAt()); redraw(); drawKeys(); display(); };
      values.append(maskRecord, maskDelete);
      showMaskFrame = () => {
        if (!select.value) return;
        const point = present();
        for (const [key, field] of boxes) field.value = String(Number((point[key] * (key === 'rotation' ? 1 : 100)).toFixed(2)));
        maskDelete.disabled = !pointAt(); redraw();
      };
      select.value = layer.mask?.shape || ''; select.onchange = redraw; redraw();
      maskMenu.append(select, values);
      dialog.insertBefore(maskMenu, footer);
      const grips = ['移动蒙版', '缩放蒙版'].map((label, i) => {
        const grip = make('button', i ? '↘' : '✥', 'layer-motion-mask-grip');
        grip.type = 'button'; grip.title = label; grip.setAttribute('aria-label', label);
        stage.append(grip);
        return grip;
      });
      function geometry() {
        const rect = preview.getBoundingClientRect();
        const angle = atTime(layer, 'rotation', time) * Math.PI / 180;
        const scale = atTime(layer, 'scale', time);
        return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, w: Math.max(1, preview.offsetWidth * scale),
          h: Math.max(1, preview.offsetHeight * scale), cos: Math.cos(angle), sin: Math.sin(angle) };
      }
      moveMaskHandles = () => {
        const bounds = stage.getBoundingClientRect(), g = geometry();
        for (const [i, grip] of grips.entries()) {
          grip.hidden = !maskMenu.open || !select.value;
          const point = present();
          const maskAngle = point.rotation * Math.PI / 180;
          const sx = i * point.width * g.w / 2, sy = i * point.height * g.h / 2;
          const dx = (point.x - .5) * g.w + sx * Math.cos(maskAngle) - sy * Math.sin(maskAngle);
          const dy = (point.y - .5) * g.h + sx * Math.sin(maskAngle) + sy * Math.cos(maskAngle);
          grip.style.left = `${g.cx - bounds.left + dx * g.cos - dy * g.sin}px`;
          grip.style.top = `${g.cy - bounds.top + dx * g.sin + dy * g.cos}px`;
        }
      };
      for (const [i, grip] of grips.entries()) {
        grip.onpointerdown = (event) => { event.preventDefault(); stop(); grip.setPointerCapture(event.pointerId); };
        grip.onpointermove = (event) => {
          if (!grip.hasPointerCapture(event.pointerId)) return;
          const g = geometry(), dx = event.clientX - g.cx, dy = event.clientY - g.cy;
          const x = .5 + (dx * g.cos + dy * g.sin) / g.w, y = .5 + (-dx * g.sin + dy * g.cos) / g.h;
          const point = present(), a = point.rotation * Math.PI / 180;
          const sx = (x - point.x) * g.w, sy = (y - point.y) * g.h;
          const updates = i ? { width: Math.min(1, Math.max(.01, 2 * Math.abs(sx * Math.cos(a) + sy * Math.sin(a)) / g.w)),
            height: Math.min(1, Math.max(.01, 2 * Math.abs(-sx * Math.sin(a) + sy * Math.cos(a)) / g.h)) } :
            { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
          setMask(updates);
        };
      }
      maskMenu.addEventListener('change', moveMaskHandles);
      maskMenu.ontoggle = moveMaskHandles;
      preview.querySelector('img')?.addEventListener('load', moveMaskHandles);
      video?.addEventListener('loadedmetadata', moveMaskHandles);
    }
    const inputs = new Map();
    let result = null;
    const selected = () => layer.keyframes.find((frame) => Math.abs(frame.time - time) < .00001);
    function stop() { cancelAnimationFrame(ticking); ticking = 0; play.textContent = '播放'; video?.pause(); }
    function display(syncMedia = true) {
      const values = {};
      for (const [key, , , , multiplier] of fields) {
        values[key] = atTime(layer, key, time);
        inputs.get(key).value = String(Number((values[key] * multiplier).toFixed(2)));
      }
      preview.style.left = `${values.x * 100}%`;
      preview.style.top = `${values.y * 100}%`;
      preview.style.transform = `translate(-50%, -50%) rotate(${values.rotation}deg) scale(${values.scale})`;
      preview.style.opacity = String(values.opacity);
      showMaskFrame();
      moveMaskHandles();
      if (video && syncMedia && !ticking) {
        const pos = time + (options.sourceStart ?? 0);
        try { video.currentTime = Math.max(0, Math.min(pos, Number.isFinite(video.duration) ? video.duration : pos)); } catch { /* Metadata may still be loading. */ }
      }
      timeBox.value = range.value = String(Number(time.toFixed(2)));
      drop.disabled = !selected();
      add.disabled = !selected() && layer.keyframes.length >= 250;
      keys.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(Math.abs(Number(button.value) - time) < .00001)));
    }
    function drawKeys() {
      keys.replaceChildren();
      const times = [...new Set([...layer.keyframes, ...(layer.mask?.keyframes ?? [])].map((frame) => frame.time))].sort((a,b) => a-b);
      for (const at of times) {
        const button = make('button', `◆ ${Number(at.toFixed(2))} 秒`);
        button.value = String(at);
        button.onclick = () => { stop(); time = at; display(); };
        keys.append(button);
      }
    }
    function ensureFrame() {
      const existing = selected();
      if (existing) return existing;
      if (layer.keyframes.length >= 250) return null;
      const frame = { time };
      layer.keyframes.push(frame);
      layer.keyframes.sort((a, b) => a.time - b.time);
      drawKeys();
      return frame;
    }
    for (const [key, label, min, max, multiplier, unit] of fields) {
      const row = make('label');
      const input = make('input'); input.type = 'number'; input.min = min; input.max = max; input.step = '.1';
      row.append(make('span', label), input, make('span', unit));
      controls.append(row); inputs.set(key, input);
      input.onchange = () => {
        stop();
        if (!input.value || !Number.isFinite(input.valueAsNumber)) { display(); return; }
        const target = time > 0 || selected() ? ensureFrame() : layer;
        if (!target) { display(); return; }
        target[key] = Math.min(max, Math.max(min, input.valueAsNumber)) / multiplier;
        display();
      };
    }
    const seek = (input) => { stop(); time = Math.max(0, Math.min(length, Number(input.value) || 0)); display(); };
    range.oninput = () => seek(range); timeBox.onchange = () => seek(timeBox);
    add.onclick = () => {
      stop();
      const values = Object.fromEntries(fields.map(([key]) => [key, atTime(layer, key, time)]));
      Object.assign(ensureFrame(), values); display();
    };
    drop.onclick = () => { stop(); layer.keyframes = layer.keyframes.filter((frame) => frame !== selected()); drawKeys(); display(); };
    play.onclick = () => {
      if (ticking) { stop(); return; }
      if (time >= length) time = 0;
      display();
      if (video) video.play().catch(() => {});
      play.textContent = '暂停';
      const origin = performance.now() - time * 1000;
      const tick = (now) => {
        time = Math.min(length, (now - origin) / 1000);
        display(false);
        if (time >= length) stop(); else ticking = requestAnimationFrame(tick);
      };
      ticking = requestAnimationFrame(tick);
    };
    cancel.onclick = () => dialog.close();
    save.onclick = () => { result = layer; dialog.close(); };
    dialog.onclose = () => { stop(); dialog.remove(); resolve(result); };
    document.body.append(dialog); drawKeys(); dialog.showModal(); display();
  });
})();

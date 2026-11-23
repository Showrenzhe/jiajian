'use strict';

(() => {
  const full = { x: 0, y: 0, width: 1, height: 1 };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  // Keep the original display aperture when cropping, mirroring and rotating.
  // Both the live preview and the filmstrip use the export pipeline's order.
  window.drawCutPicture = function drawCutPicture(canvas, source, range, w, h) {
    const iw = source.videoWidth || source.naturalWidth, ih = source.videoHeight || source.naturalHeight;
    if (!iw || !ih || !w || !h) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const crop = range.crop || full;
    const sw = crop.width * iw, sh = crop.height * ih;
    const quarterTurn = range.rotation === 90 || range.rotation === 270;
    const fitSource = Math.min(w / iw, h / ih);
    const scale = fitSource * Math.min(iw / (quarterTurn ? sh : sw), ih / (quarterTurn ? sw : sh));
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((range.rotation || 0) * Math.PI / 180);
    ctx.scale(range.mirror ? -scale : scale, scale);
    ctx.drawImage(source, crop.x * iw, crop.y * ih, sw, sh, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
    return true;
  };

  window.mountCutFramePreview = function mountCutFramePreview(container, video) {
    const canvas = document.createElement('canvas');
    canvas.hidden = true;
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);
    let range = {};
    let frame;
    function paint() {
      if (!(range.crop || range.mirror || range.rotation) || video.readyState < 2) {
        canvas.hidden = true;
        return;
      }
      const w = Math.round(container.clientWidth * devicePixelRatio);
      const h = Math.round(container.clientHeight * devicePixelRatio);
      canvas.hidden = !window.drawCutPicture(canvas, video, range, w, h);
    }
    function watch() {
      if (frame != null) video.cancelVideoFrameCallback(frame);
      frame = null;
      paint();
      if ((range.crop || range.mirror || range.rotation) && !video.paused && !video.ended)
        frame = video.requestVideoFrameCallback(watch);
    }
    const events = ['loadeddata', 'seeked', 'play', 'pause', 'emptied', 'resize'];
    events.forEach((name) => video.addEventListener(name, watch));
    const resize = new ResizeObserver(paint);
    resize.observe(container);
    return {
      update(next = {}) {
        const changed = range.crop !== next.crop || range.mirror !== next.mirror || range.rotation !== next.rotation;
        range = next;
        if (changed) watch();
      },
      destroy() {
        if (frame != null) video.cancelVideoFrameCallback(frame);
        events.forEach((name) => video.removeEventListener(name, watch));
        resize.disconnect();
        canvas.remove();
      },
    };
  };

  const paths = {
    play: 'M7 4.5 17 11 7 17.5Z',
    split: 'M8 7a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm0 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM7.5 8.5 18 17m-10.5-3.5L18 5',
    'trim-left': 'M5 4v14m5-10-3.5 3L10 14m-3.5-3H19',
    'trim-right': 'M17 4v14m-5-10 3.5 3-3.5 3m3.5-3H3',
    undo: 'm9 5-5 4.5 5 4.5m-5-4.5h9a5 5 0 0 1 5 5V17',
    redo: 'm13 5 5 4.5-5 4.5m5-4.5H9a5 5 0 0 0-5 5V17',
    reverse: 'm10.5 5.5-6.5 5.5 6.5 5.5zm7.5 0L11.5 11l6.5 5.5z',
    mirror: 'M11 2v3m0 3v6m0 3v3M8 6l-5 10h5zm6 0 5 10h-5z',
    rotate: 'M6 8a6 6 0 0 1 9-2l2 2m0-4v4h-4M6 12h7v7H6z',
    crop: 'M6 2v13a1 1 0 0 0 1 1h13M2 6h13a1 1 0 0 1 1 1v13',
    delete: 'M4 6h14M8 6V4h6v2M6 7l1 11h8l1-11M9 9v6m4-6v6',
  };
  window.decorateCutAction = function decorateCutAction(button, action) {
    if (!paths[action] || button.querySelector('svg')) return;
    const label = document.createElement('span');
    label.className = 'cut-action-label';
    label.textContent = button.textContent;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('class', 'ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    path.setAttribute('d', paths[action]);
    svg.append(path);
    button.replaceChildren(svg, label);
  };

  window.editCutCrop = function editCutCrop(anchor, asset, sourceTime, initialCrop, onApply) {
    const dialog = document.createElement('dialog');
    dialog.className = 'cut-crop-dialog';
    dialog.setAttribute('aria-label', '裁剪画面');
    dialog.innerHTML = `<h2>裁剪画面</h2>
      <p>拖动四角调整范围，拖动框内移动选区。</p>
      <div class="cut-crop-stage"><div class="cut-crop-image"><img alt=""><div class="cut-crop-box" tabindex="0" aria-label="移动裁剪框"></div></div></div>
      <output class="cut-crop-status" role="status">正在读取原片画面…</output>
      <div class="cut-crop-fields"></div>
      <footer><button type="button" data-action="reset">恢复完整画面</button><button type="button" data-action="cancel">取消</button><button type="button" class="primary" data-action="apply">应用裁剪</button></footer>`;
    const box = dialog.querySelector('.cut-crop-box');
    const image = dialog.querySelector('img');
    const viewport = image.parentElement;
    const stage = viewport.parentElement;
    const status = dialog.querySelector('output');
    const fields = dialog.querySelector('.cut-crop-fields');
    const inputs = {};
    const minW = Math.min(1, Math.max(.01, 2 / (asset.width || 320)));
    const minH = Math.min(1, Math.max(.01, 2 / (asset.height || 180)));
    let crop = { ...(initialCrop || full) };
    let drag;
    let aspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9;

    function fit() {
      const width = Math.min(stage.clientWidth, stage.clientHeight * aspect);
      viewport.style.width = width + 'px';
      viewport.style.height = width / aspect + 'px';
    }
    function draw() {
      box.style.left = crop.x * 100 + '%';
      box.style.top = crop.y * 100 + '%';
      box.style.width = crop.width * 100 + '%';
      box.style.height = crop.height * 100 + '%';
      for (const [key, input] of Object.entries(inputs)) input.value = String(Number((crop[key] * 100).toFixed(2)));
    }
    function change(edge, original, dx, dy) {
      let { x, y, width, height } = original;
      const right = x + width, bottom = y + height;
      if (!edge) {
        x = clamp(x + dx, 0, 1 - width);
        y = clamp(y + dy, 0, 1 - height);
      } else {
        if (edge.includes('w')) { x = clamp(x + dx, 0, right - minW); width = right - x; }
        if (edge.includes('e')) width = clamp(width + dx, minW, 1 - x);
        if (edge.includes('n')) { y = clamp(y + dy, 0, bottom - minH); height = bottom - y; }
        if (edge.includes('s')) height = clamp(height + dy, minH, 1 - y);
      }
      crop = { x, y, width, height };
      draw();
    }
    for (const [edge, title] of Object.entries({ nw: '左上角', ne: '右上角', se: '右下角', sw: '左下角' })) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.dataset.corner = edge;
      handle.setAttribute('aria-label', '调整' + title);
      box.append(handle);
    }
    for (const [key, title] of Object.entries({ x: '左', y: '上', width: '宽', height: '高' })) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      inputs[key] = input;
      input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '0.1';
      input.onchange = () => {
        const value = input.valueAsNumber / 100;
        if (Number.isFinite(value)) {
          if (key === 'width') crop.width = clamp(value, minW, 1 - crop.x);
          if (key === 'height') crop.height = clamp(value, minH, 1 - crop.y);
          if (key === 'x') crop.x = clamp(value, 0, 1 - crop.width);
          if (key === 'y') crop.y = clamp(value, 0, 1 - crop.height);
        }
        draw();
      };
      label.append(title + '（%）', input);
      fields.append(label);
    }
    box.onpointerdown = (event) => {
      if (event.button !== 0 || drag) return;
      const bounds = viewport.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      drag = { edge: event.target.dataset.corner, original: { ...crop }, x: event.clientX, y: event.clientY, bounds, id: event.pointerId };
      event.preventDefault();
      event.target.focus({ preventScroll: true });
      box.setPointerCapture(event.pointerId);
    };
    box.onpointermove = (event) => {
      if (drag?.id === event.pointerId)
        change(drag.edge, drag.original, (event.clientX - drag.x) / drag.bounds.width, (event.clientY - drag.y) / drag.bounds.height);
    };
    box.onpointerup = (event) => { if (drag?.id === event.pointerId) drag = undefined; };
    box.onpointercancel = box.onlostpointercapture = (event) => {
      if (drag?.id === event.pointerId) { crop = drag.original; drag = undefined; draw(); }
    };
    box.onkeydown = (event) => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? .05 : .01;
      change(event.target.dataset.corner, crop, delta[0] * step, delta[1] * step);
    };
    const resize = new ResizeObserver(fit);
    resize.observe(stage);
    dialog.querySelector('[data-action="reset"]').onclick = () => { crop = { ...full }; draw(); };
    dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.close();
    dialog.querySelector('[data-action="apply"]').onclick = () => {
      dialog.close();
      onApply(Object.keys(full).every((key) => Math.abs(crop[key] - full[key]) < 1e-7) ? undefined : { ...crop });
    };
    dialog.addEventListener('close', () => {
      resize.disconnect();
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
      window.afterDialogExit(dialog);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    fit(); draw();
    image.onload = () => {
      if (!(asset.width > 0 && asset.height > 0)) aspect = image.naturalWidth / image.naturalHeight;
      status.hidden = true; fit();
    };
    const unavailable = () => { status.textContent = '此帧预览不可用，仍可按比例调整裁剪范围。'; };
    image.onerror = unavailable;
    window.workbench.clipThumbnail(asset.id, sourceTime).then((url) => {
      if (!dialog.open) return;
      if (url) image.src = url;
      else unavailable();
    }).catch(unavailable);
    return { close: () => { if (dialog.open) dialog.close(); } };
  };
})();

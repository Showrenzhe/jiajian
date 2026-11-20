'use strict';

(() => {
  const storageKey = 'sd-workbench-panel-layout-v1';
  const definitions = [
    ['player', '.editor-player', '播放器', 190, 135],
    ['materials', '.editor-materials', '素材库', 175, 145],
    ['inspector', '.montage-inspector', '属性面板', 235, 175],
    ['timeline', '#montage-pane', '分镜轨道', 290, 165],
  ];
  const edges = { n: '上边', ne: '右上角', e: '右边', se: '右下角', s: '下边', sw: '左下角', w: '左边', nw: '左上角' };
  const sharedEdges = {
    materials: { e: 'materials', s: 'timeline' },
    player: { w: 'materials', e: 'inspector', s: 'timeline' },
    inspector: { w: 'inspector', s: 'timeline' },
    timeline: { n: 'timeline' },
  };
  const clamp = (number, min, max) => Math.min(max, Math.max(min, number));

  function readLayout() {
    try {
      const state = JSON.parse(window.localStorage.getItem(storageKey));
      const ids = definitions.map(([id]) => id);
      if (state?.version !== 1 || !Array.isArray(state.order) || new Set(state.order).size !== ids.length
          || state.order.length !== ids.length || ids.some((id) => !state.order.includes(id))) return null;
      for (const id of ids) {
        const box = state.boxes?.[id];
        if (!box || [box.x, box.y, box.width, box.height].some((number) => !Number.isFinite(number) || number < 0 || number > 1)
            || !box.width || !box.height) return null;
      }
      return state;
    } catch { return null; }
  }

  // Older versions saved even a docked edge resize as four independent rectangles.
  // Only recover the grid when all outer anchors and the timeline still line up.
  function splitFromBoxes({ materials, player, inspector, timeline }) {
    const near = (a, b) => Math.abs(a - b) < .0005;
    const playerRight = player.x + player.width;
    if (!near(materials.x, 0) || !near(inspector.x + inspector.width, 1)
        || !near(timeline.x, 0) || !near(timeline.width, 1) || !near(timeline.y + timeline.height, 1)
        || ![materials, player, inspector].every(box => near(box.y, 0) && near(box.y + box.height, timeline.y))
        || materials.x + materials.width > player.x + .0005 || playerRight > inspector.x + .0005) return null;
    return { materials: player.x, inspector: 1 - playerRight, timeline: timeline.height };
  }

  function create(tag, properties) { return Object.assign(document.createElement(tag), properties); }

  function putBox(element, box) {
    for (const [field, value] of Object.entries({ left: box.x, top: box.y, width: box.width, height: box.height })) {
      element.style.setProperty(`--panel-layout-${field}`, `${value}px`);
    }
  }

  function pointerBox(box, edge, dx, dy, bounds, pane) {
    if (edge === 'move') {
      return { ...box, x: clamp(box.x + dx, 0, bounds.width - box.width), y: clamp(box.y + dy, 0, bounds.height - box.height) };
    }
    const minWidth = Math.min(bounds.width, pane.minWidth);
    const minHeight = Math.min(bounds.height, pane.minHeight);
    let { x, y } = box;
    let right = x + box.width;
    let bottom = y + box.height;
    if (edge.includes('w')) x = clamp(x + dx, 0, right - minWidth);
    if (edge.includes('e')) right = clamp(right + dx, x + minWidth, bounds.width);
    if (edge.includes('n')) y = clamp(y + dy, 0, bottom - minHeight);
    if (edge.includes('s')) bottom = clamp(bottom + dy, y + minHeight, bounds.height);
    return { x, y, width: right - x, height: bottom - y };
  }

  function normalize(box, bounds) {
    return { x: box.x / bounds.width, y: box.y / bounds.height, width: box.width / bounds.width, height: box.height / bounds.height };
  }

  function fit(box, bounds, pane) {
    const width = clamp(box.width, Math.min(bounds.width, pane.minWidth), bounds.width);
    const height = clamp(box.height, Math.min(bounds.height, pane.minHeight), bounds.height);
    return { width, height, x: clamp(box.x, 0, bounds.width - width), y: clamp(box.y, 0, bounds.height - height) };
  }

  window.mountPanelLayout = (workspace, { actions = workspace.querySelector('#workbench-actions') } = {}) => {
    const frame = workspace.closest('.app-frame');
    const toolbar = workspace.querySelector('.editor-heading');
    const notice = workspace.querySelector('#notice');
    const controls = create('div', { className: 'panel-layout-controls' });
    const toggle = create('button', { id: 'panel-layout-toggle', type: 'button', className: 'secondary', textContent: '调整布局' });
    const resetButton = create('button', { id: 'panel-layout-reset', type: 'button', className: 'secondary', textContent: '恢复默认布局' });
    const choose = create('select', { id: 'panel-layout-target', title: '将选定面板置顶' });
    choose.setAttribute('aria-label', '选择要置顶的面板');
    const live = create('span', { id: 'panel-layout-status', className: 'panel-layout-status' });
    live.setAttribute('role', 'status');
    controls.append(toggle, choose, resetButton, live);
    actions.append(controls);

    const layer = create('div', { id: 'panel-layout-layer' });
    layer.hidden = true;
    workspace.append(layer);
    const panes = new Map(definitions.map(([id, selector, label, minWidth, minHeight]) => {
      const element = workspace.querySelector(selector);
      const overlay = create('div', { className: 'panel-layout-box' });
      overlay.dataset.pane = id;
      choose.append(new Option(label, id));
      layer.append(overlay);
      element.classList.add('panel-layout-pane');
      return [id, { id, label, minWidth, minHeight, element, overlay }];
    }));
    const defaultOrder = [...panes.keys()];
    const splitView = window.mountSplitView(workspace, bounds);
    let state = readLayout();
    let editing = false;
    let beforeEdit;
    let active = state?.order.at(-1) ?? defaultOrder[0];
    let drag;
    let scheduled = 0;

    const legacySplit = state && splitFromBoxes(state.boxes);
    if (legacySplit) {
      splitView.restore(legacySplit);
      state = null;
      save();
    }

    function save() {
      splitView.save();
      try {
        if (state) window.localStorage.setItem(storageKey, JSON.stringify(state));
        else window.localStorage.removeItem(storageKey);
      } catch { /* The layout still works when local storage is unavailable. */ }
    }

    function bounds() {
      const outer = workspace.getBoundingClientRect();
      const style = getComputedStyle(workspace);
      const horizontal = Number.parseFloat(style.paddingLeft) || 0;
      const vertical = Number.parseFloat(style.paddingBottom) || 0;
      const last = notice.hidden ? toolbar : notice;
      const y = last.getBoundingClientRect().bottom - outer.top + workspace.scrollTop + parseFloat(getComputedStyle(last).marginBottom);
      return { outer, x: horizontal, y, width: Math.max(1, workspace.clientWidth - horizontal * 2),
        height: Math.max(1, workspace.clientHeight - y - vertical),
        gutter: Number.parseFloat(style.columnGap) || 0 };
    }

    function currentBox(pane, canvas) {
      if (state) {
        const box = state.boxes[pane.id];
        return fit({ x: box.x * canvas.width, y: box.y * canvas.height,
          width: box.width * canvas.width, height: box.height * canvas.height }, canvas, pane);
      }
      const rect = pane.element.getBoundingClientRect();
      return { x: rect.left - canvas.outer.left + workspace.scrollLeft - canvas.x,
        y: rect.top - canvas.outer.top + workspace.scrollTop - canvas.y, width: rect.width, height: rect.height };
    }

    function refreshControls() {
      toggle.setAttribute('aria-pressed', String(editing));
      toggle.textContent = editing ? '完成布局' : '调整布局';
      toggle.title = editing ? '保留本次调整并退出。按 Esc 可取消本次调整。' : '拖动面板顶端移动，拖动边缘或角调整大小。方向键也可操作。';
      choose.hidden = !editing && !state;
      choose.value = active;
      resetButton.hidden = !state && !(editing && splitView.modified);
      layer.hidden = !editing;
    }

    function layout() {
      scheduled = 0;
      const visible = frame?.dataset.mode === 'montage' && !workspace.hidden && workspace.clientWidth > 0;
      if (!visible) { layer.hidden = true; splitView.sync(false); return; }
      refreshControls();
      workspace.toggleAttribute('data-layout-editing', editing);
      if (state) workspace.dataset.panelLayout = 'custom';
      else delete workspace.dataset.panelLayout;
      // Entering free layout takes its initial geometry from the current split view.
      splitView.sync(!state);
      const canvas = bounds();
      for (const pane of panes.values()) {
        const box = currentBox(pane, canvas);
        const absolute = { ...box, x: box.x + canvas.x, y: box.y + canvas.y };
        const order = (state?.order ?? defaultOrder).indexOf(pane.id) + 1;
        if (state) {
          putBox(pane.element, absolute);
          pane.element.style.setProperty('--panel-layout-order', order);
        }
        if (editing) {
          putBox(pane.overlay, absolute);
          pane.overlay.classList.toggle('panel-layout-active', pane.id === active);
          pane.overlay.style.setProperty('--panel-layout-order', order);
        }
      }
    }

    function sync() {
      if (!scheduled) scheduled = requestAnimationFrame(layout);
    }

    function raise(pane) {
      active = pane.id;
      if (state && state.order.at(-1) !== pane.id) state.order = state.order.filter((id) => id !== pane.id).concat(pane.id);
    }

    function startCustom() {
      if (state) return;
      const canvas = bounds();
      const boxes = Object.fromEntries([...panes].map(([id, pane]) => [id, normalize(fit(currentBox(pane, canvas), canvas, pane), canvas)]));
      state = { version: 1, boxes, order: [...defaultOrder] };
    }

    function resizeDocked(id, edge, size, dx, dy) {
      const displacement = { materials: dx, inspector: -dx, timeline: -dy };
      for (const direction of edge) {
        const split = sharedEdges[id][direction];
        if (split) splitView.resize(split, size[split] + displacement[split]);
      }
    }

    function nudge(pane, edge, event) {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!editing || !direction || event.altKey || event.ctrlKey || event.metaKey) return;
      if (edge !== 'move' && ((direction[0] && /^[ns]$/.test(edge)) || (direction[1] && /^[ew]$/.test(edge)))) return;
      event.preventDefault();
      const step = event.shiftKey ? 24 : 8;
      const dx = direction[0] * step, dy = direction[1] * step;
      if (edge === 'move') startCustom();
      raise(pane);
      if (state) {
        const canvas = bounds();
        state.boxes[pane.id] = normalize(pointerBox(currentBox(pane, canvas), edge, dx, dy, canvas, pane), canvas);
      } else {
        resizeDocked(pane.id, edge, splitView.sizes(), dx, dy);
      }
      save();
      sync();
    }

    function startDrag(pane, edge, handle, event) {
      if (!editing || drag || event.button !== 0) return;
      event.preventDefault();
      raise(pane);
      const canvas = bounds();
      drag = { pane, edge, handle, split: !state && edge !== 'move' ? splitView.sizes() : null,
        pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        box: fit(currentBox(pane, canvas), canvas, pane), changed: false };
      handle.dataset.pointerFocus = '';
      handle.focus({ preventScroll: true });
      try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners also handle uncaptured drags. */ }
      workspace.classList.add('panel-layout-dragging');
      sync();
    }

    function move(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const { pane, edge, box, x, y } = drag;
      const dx = event.clientX - x;
      const dy = event.clientY - y;
      if (!drag.changed && !dx && !dy) return;
      if (drag.split) {
        resizeDocked(pane.id, edge, drag.split, dx, dy);
      } else {
        startCustom();
        raise(pane);
        const canvas = bounds();
        state.boxes[pane.id] = normalize(pointerBox(fit(box, canvas, pane), edge, dx, dy, canvas, pane), canvas);
      }
      drag.changed = true;
      sync();
    }

    function finish(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.changed) {
        live.textContent = `已调整${drag.pane.label}。`;
        save();
      }
      releaseDrag();
      sync();
    }

    function releaseDrag() {
      if (!drag) return;
      const { handle, pointerId } = drag;
      drag = undefined;
      workspace.classList.remove('panel-layout-dragging');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    }

    for (const pane of panes.values()) {
      for (const [edge, direction] of Object.entries({ move: '', ...edges })) {
        const label = edge === 'move' ? `移动${pane.label}` : `调整${pane.label}${direction}`;
        const handle = create('button', { type: 'button', className: 'panel-layout-handle', title: `${label}（可用方向键）` });
        handle.dataset.edge = edge;
        if (edge !== 'move') {
          const axes = [...edge].filter(direction => sharedEdges[pane.id][direction])
            .map(direction => 'ns'.includes(direction) ? 'y' : 'x');
          handle.dataset.splitAxes = axes.join('') || 'none';
        }
        handle.setAttribute('aria-label', label);
        handle.addEventListener('pointerdown', (event) => startDrag(pane, edge, handle, event));
        handle.addEventListener('lostpointercapture', finish);
        handle.addEventListener('blur', () => handle.removeAttribute('data-pointer-focus'));
        handle.addEventListener('keydown', (event) => {
          if (!drag) handle.removeAttribute('data-pointer-focus');
          nudge(pane, edge, event);
        });
        pane.overlay.append(handle);
      }
      const bringForward = () => {
        if (frame?.dataset.mode !== 'montage' || !state || state.order.at(-1) === pane.id) return;
        raise(pane);
        sync();
      };
      pane.element.addEventListener('pointerdown', bringForward);
      pane.element.addEventListener('focusin', bringForward);
    }

    function reset() {
      releaseDrag();
      state = null;
      editing = false;
      beforeEdit = undefined;
      splitView.reset();
      delete workspace.dataset.panelLayout;
      save();
      live.textContent = '已恢复默认布局。';
      sync();
    }

    function endEditing(cancel) {
      releaseDrag();
      if (cancel) {
        state = beforeEdit.state;
        active = beforeEdit.active;
        splitView.restore(beforeEdit.split);
      }
      editing = false;
      beforeEdit = undefined;
      save();
      toggle.focus({ preventScroll: true });
      live.textContent = cancel ? '已取消本次布局调整。' : '已完成布局调整。';
      sync();
    }

    toggle.addEventListener('click', () => {
      if (editing) return endEditing(false);
      beforeEdit = { state: structuredClone(state), active, split: splitView.snapshot() };
      editing = true;
      live.textContent = '拖动面板顶端移动，拖动边缘或角调整大小。按 Esc 取消本次调整。';
      sync();
    });
    document.addEventListener('keydown', (event) => {
      if (!editing || frame?.dataset.mode !== 'montage' || event.key !== 'Escape' || event.defaultPrevented
          || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (frame.dataset.navigation === 'floating' || document.fullscreenElement
          || document.querySelector('dialog[open], :popover-open:not([popover="manual"]), select:open')
          || (event.target.closest?.('#timeline-cut-editor') && !event.target.closest('input, select, textarea'))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      endEditing(true);
    }, true);
    choose.addEventListener('change', () => {
      const pane = panes.get(choose.value);
      if (!pane) return;
      raise(pane);
      save();
      live.textContent = `${pane.label}已置顶。`;
      sync();
    });
    resetButton.addEventListener('click', () => { reset(); toggle.focus({ preventScroll: true }); });
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    const observer = new ResizeObserver(sync);
    for (const target of [workspace, toolbar, notice]) observer.observe(target);
    sync();
    return { sync, reset };
  };
})();

'use strict';

(() => {
  const storageKey = 'sd-workbench-panel-layout-v1';
  const definitions = [
    ['materials', '.editor-materials', '素材库'],
    ['player', '.editor-player', '播放器'],
    ['inspector', '.montage-inspector', '属性面板'],
    ['timeline', '#montage-pane', '分镜轨道'],
  ];
  const slotIds = definitions.map(([id]) => id);
  const defaultSlots = Object.fromEntries(slotIds.map(id => [id, id]));
  const edges = { n: '上边', ne: '右上角', e: '右边', se: '右下角', s: '下边', sw: '左下角', w: '左边', nw: '左上角' };
  const sharedEdges = {
    materials: { e: 'materials', s: 'timeline' },
    player: { w: 'materials', e: 'inspector', s: 'timeline' },
    inspector: { w: 'inspector', s: 'timeline' },
    timeline: { n: 'timeline' },
  };

  function isPermutation(values) {
    return values.length === slotIds.length && slotIds.every(id => values.includes(id));
  }

  function readLayout() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey));
      if (saved?.version === 2 && saved.slots && isPermutation(slotIds.map(id => saved.slots[id]))) {
        return { slots: Object.fromEntries(slotIds.map(id => [id, saved.slots[id]])) };
      }
      if (saved?.version !== 1 || !Array.isArray(saved.order) || !isPermutation(saved.order)) return {};
      for (const id of slotIds) {
        const box = saved.boxes?.[id];
        if (!box || [box.x, box.y, box.width, box.height].some(value => !Number.isFinite(value) || value < 0 || value > 1)
            || !box.width || !box.height) return {};
      }
      return migrateBoxes(saved.boxes);
    } catch { return {}; }
  }

  function migrateBoxes(boxes) {
    // Even the old docked layout could have a narrow empty strip at a seam.
    // Recover its exact proportions before approximating genuinely free layouts.
    const near = (a, b) => Math.abs(a - b) < .0005;
    const horizontalCenter = id => boxes[id].x + boxes[id].width / 2;
    for (const lower of slotIds) {
      const bottom = boxes[lower];
      if (!near(bottom.x, 0) || !near(bottom.width, 1) || !near(bottom.y + bottom.height, 1)) continue;
      const top = slotIds.filter(id => id !== lower).sort((a, b) => horizontalCenter(a) - horizontalCenter(b));
      const [left, middle, right] = top.map(id => boxes[id]);
      if (!top.every(id => near(boxes[id].y, 0) && near(boxes[id].height, bottom.y))
          || !near(left.x, 0) || !near(right.x + right.width, 1)
          || left.x + left.width > middle.x + .0005 || middle.x + middle.width > right.x + .0005) continue;
      return { slots: Object.fromEntries([...top, lower].map((id, i) => [id, slotIds[i]])),
        split: { materials: middle.x, inspector: 1 - middle.x - middle.width, timeline: bottom.height } };
    }

    // Try each pane as the full-width lower track. The other three retain
    // their left-to-right order, with default placement breaking exact ties.
    const reference = [[.10, .30, .20], [.49, .30, .58], [.89, .30, .22], [.50, .80, 1]];
    let best;
    for (const lower of slotIds) {
      const top = slotIds.filter(id => id !== lower).sort((a, b) => horizontalCenter(a) - horizontalCenter(b));
      const order = [...top, lower];
      let score = 0;
      for (const [i, id] of order.entries()) {
        const box = boxes[id], [x, y, width] = reference[i];
        score += (horizontalCenter(id) - x) ** 2 + (box.y + box.height / 2 - y) ** 2 + (box.width - width) ** 2;
      }
      const retained = order.filter((id, i) => id === slotIds[i]).length;
      if (!best || score < best.score - 1e-8 || (Math.abs(score - best.score) <= 1e-8 && retained > best.retained)) {
        best = { score, retained, order };
      }
    }
    const [left, , right, bottom] = best.order;
    return { slots: Object.fromEntries(best.order.map((id, i) => [id, slotIds[i]])),
      split: { materials: boxes[left].width, inspector: boxes[right].width, timeline: boxes[bottom].height } };
  }

  function create(tag, properties) { return Object.assign(document.createElement(tag), properties); }

  window.mountPanelLayout = (workspace, { actions = workspace.querySelector('#workbench-actions') } = {}) => {
    const frame = workspace.closest('.app-frame');
    const toolbar = workspace.querySelector('.editor-heading');
    const notice = workspace.querySelector('#notice');
    const controls = create('div', { className: 'panel-layout-controls' });
    const toggle = create('button', { id: 'panel-layout-toggle', type: 'button', className: 'secondary', textContent: '调整布局' });
    const resetButton = create('button', { id: 'panel-layout-reset', type: 'button', className: 'secondary', textContent: '恢复默认布局' });
    const choose = create('select', { id: 'panel-layout-target', title: '选择要移动的面板' });
    choose.setAttribute('aria-label', '选择要移动的面板');
    const live = create('span', { id: 'panel-layout-status', className: 'panel-layout-status' });
    live.setAttribute('role', 'status');
    controls.append(toggle, choose, resetButton, live);
    actions.append(controls);

    const layer = create('div', { id: 'panel-layout-layer' });
    layer.hidden = true;
    workspace.append(layer);
    const panes = new Map(definitions.map(([id, selector, label]) => {
      const element = workspace.querySelector(selector);
      const overlay = create('div', { className: 'panel-layout-box' });
      overlay.dataset.pane = id;
      choose.append(new Option(label, id));
      layer.append(overlay);
      element.classList.add('panel-layout-pane');
      return [id, { id, label, element, overlay }];
    }));
    const splitView = window.mountSplitView(workspace, bounds);
    const dividers = [...workspace.querySelectorAll('.workspace-divider')];
    const saved = readLayout();
    let slots = saved.slots ?? { ...defaultSlots };
    let editing = false;
    let beforeEdit;
    let active = 'player';
    let drag;
    let scheduled = 0;

    if (saved.split) {
      splitView.restore(saved.split);
      save();
    }

    function swapped() {
      return slotIds.some(id => slots[id] !== id);
    }

    function save() {
      splitView.save();
      try {
        if (swapped()) window.localStorage.setItem(storageKey, JSON.stringify({ version: 2, slots }));
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
      return { width: Math.max(1, workspace.clientWidth - horizontal * 2),
        height: Math.max(1, workspace.clientHeight - y - vertical),
        gutter: Number.parseFloat(style.columnGap) || 0 };
    }

    function applySlots() {
      if (swapped()) workspace.dataset.panelLayout = 'swapped';
      else delete workspace.dataset.panelLayout;
      for (const pane of panes.values()) {
        const slot = slots[pane.id];
        const area = slot === 'inspector' ? 'properties' : slot;
        pane.element.style.setProperty('--panel-grid-area', area);
        pane.overlay.style.setProperty('--panel-grid-area', area);
        for (const handle of pane.overlay.querySelectorAll('button:not([data-edge="move"])')) {
          const axes = [...handle.dataset.edge].filter(direction => sharedEdges[slot][direction])
            .map(direction => 'ns'.includes(direction) ? 'y' : 'x');
          handle.dataset.splitAxes = axes.join('') || 'none';
        }
      }
      for (const divider of dividers) {
        const split = divider.dataset.split;
        const pane = panes.get(slotIds.find(id => slots[id] === split));
        const measure = split === 'timeline' ? '高度' : '宽度';
        const label = pane.label + measure;
        divider.setAttribute('aria-label', label);
        divider.setAttribute('aria-controls', pane.element.id);
        divider.title = `拖动调整${label}，按 Esc 取消拖动，双击恢复默认${measure}`;
      }
    }

    function swapPanes(sourceId, targetId) {
      if (sourceId === targetId || !panes.has(sourceId) || !panes.has(targetId)) return;
      [slots[sourceId], slots[targetId]] = [slots[targetId], slots[sourceId]];
      applySlots();
    }

    function refreshControls() {
      toggle.setAttribute('aria-pressed', String(editing));
      toggle.textContent = editing ? '完成布局' : '调整布局';
      toggle.title = editing ? '保留本次调整并退出。按 Esc 可取消本次调整。' : '拖动面板到另一块面板上松开即可交换，拖动边缘调整大小。';
      choose.hidden = !editing;
      choose.value = active;
      const modified = swapped() || splitView.modified;
      resetButton.hidden = !editing && !swapped();
      resetButton.disabled = !modified;
      layer.hidden = !editing;
    }

    function layout() {
      scheduled = 0;
      if (frame?.dataset.mode !== 'montage' || workspace.hidden || !workspace.clientWidth) {
        releaseDrag();
        if (frame?.dataset.mode !== 'montage' || workspace.hidden) {
          editing = false;
          beforeEdit = undefined;
          workspace.removeAttribute('data-layout-editing');
        }
        layer.hidden = true;
        splitView.sync(false);
        return;
      }
      refreshControls();
      workspace.toggleAttribute('data-layout-editing', editing);
      splitView.sync(true);
    }

    function sync() {
      if (!scheduled) scheduled = requestAnimationFrame(layout);
    }

    function resizeDocked(id, edge, size, dx, dy) {
      const displacement = { materials: dx, inspector: -dx, timeline: -dy };
      for (const direction of edge) {
        const split = sharedEdges[slots[id]][direction];
        if (split) splitView.resize(split, size[split] + displacement[split]);
      }
    }

    function targetAt(source, x, y) {
      for (const pane of panes.values()) {
        if (pane === source) continue;
        const rect = pane.overlay.getBoundingClientRect();
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return pane;
      }
    }

    function neighbor(pane, dx, dy) {
      const start = pane.overlay.getBoundingClientRect();
      const horizontal = Boolean(dx);
      const near = horizontal ? 'left' : 'top';
      const far = horizontal ? 'right' : 'bottom';
      const crossNear = horizontal ? 'top' : 'left';
      const crossFar = horizontal ? 'bottom' : 'right';
      const center = (start[crossNear] + start[crossFar]) / 2;
      let nearest;
      let bestGap = Infinity;
      let bestOffset = Infinity;
      for (const candidate of panes.values()) {
        if (candidate === pane) continue;
        const rect = candidate.overlay.getBoundingClientRect();
        if (rect[crossFar] <= start[crossNear] || rect[crossNear] >= start[crossFar]) continue;
        const gap = (dx || dy) > 0 ? rect[near] - start[far] : start[near] - rect[far];
        const offset = Math.max(0, rect[crossNear] - center, center - rect[crossFar]);
        if (gap >= 0 && (gap < bestGap || (gap === bestGap && offset < bestOffset))) {
          nearest = candidate;
          bestGap = gap;
          bestOffset = offset;
        }
      }
      return nearest;
    }

    function animateArrival(pane, dx, dy) {
      // Move the contents inside their destination. The slots and pointer targets stay put.
      const distance = Math.hypot(dx, dy);
      const fraction = Math.min(.3, 40 / (distance || 1));
      const style = getComputedStyle(pane.element);
      // Keep translated content inside a scrolling pane's trailing padding to avoid flashing scrollbars.
      const x = Math.min(dx * fraction, style.overflowX === 'auto' ? parseFloat(style.paddingRight) : Infinity);
      const y = Math.min(dy * fraction, style.overflowY === 'auto' ? parseFloat(style.paddingBottom) : Infinity);
      const from = { translate: `${x}px ${y}px`, opacity: .55 };
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      for (const child of pane.element.children) {
        for (const animation of child.getAnimations()) {
          if (animation.id === 'panel-slot-arrival') animation.cancel();
        }
        if (!reducedMotion && child.checkVisibility()) {
          child.animate([from, { translate: '0 0', opacity: 1 }], {
            id: 'panel-slot-arrival', duration: 230, easing: 'cubic-bezier(.2,.75,.25,1)',
          });
        }
      }
    }

    function exchange(source, target) {
      const from = source.overlay.getBoundingClientRect();
      const to = target.overlay.getBoundingClientRect();
      const dx = (from.left + from.right - to.left - to.right) / 2;
      const dy = (from.top + from.bottom - to.top - to.bottom) / 2;
      swapPanes(source.id, target.id);
      animateArrival(source, dx, dy);
      animateArrival(target, -dx, -dy);
      live.textContent = `${source.label}与${target.label}已交换位置。`;
      save();
    }

    function nudge(pane, edge, event) {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!editing || drag || !direction || event.altKey || event.ctrlKey || event.metaKey) return;
      const [dx, dy] = direction;
      if (edge !== 'move' && !event.currentTarget.dataset.splitAxes?.includes(dx ? 'x' : 'y')) return;
      event.preventDefault();
      event.stopPropagation();
      active = pane.id;
      if (edge === 'move') {
        const target = neighbor(pane, dx, dy);
        if (target) exchange(pane, target);
      } else {
        const step = event.shiftKey ? 24 : 8;
        resizeDocked(pane.id, edge, splitView.sizes(), dx * step, dy * step);
        save();
      }
      sync();
    }

    function startDrag(pane, edge, handle, event) {
      if (!editing || drag || event.button !== 0) return;
      event.preventDefault();
      active = pane.id;
      drag = { pane, edge, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, changed: false };
      if (edge !== 'move') {
        drag.split = splitView.sizes();
        drag.before = splitView.snapshot();
      }
      handle.dataset.pointerFocus = '';
      handle.focus({ preventScroll: true });
      try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners also handle uncaptured drags. */ }
      workspace.classList.add('panel-layout-dragging');
      sync();
    }

    function updateDrag(x, y) {
      const dx = x - drag.x, dy = y - drag.y;
      if (drag.edge === 'move') {
        if (!drag.changed && Math.hypot(dx, dy) < 4) return;
        drag.pane.overlay.dataset.dragSource = '';
        const target = targetAt(drag.pane, x, y);
        if (target !== drag.target) {
          if (drag.target) delete drag.target.overlay.dataset.dropTarget;
          if (target) target.overlay.dataset.dropTarget = '';
          drag.target = target;
        }
      } else {
        if (!drag.changed && !dx && !dy) return;
        resizeDocked(drag.pane.id, drag.edge, drag.split, dx, dy);
        sync();
      }
      drag.changed = true;
    }

    function move(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) return releaseDrag();
      event.preventDefault();
      updateDrag(event.clientX, event.clientY);
    }

    function finish(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.type !== 'pointerup') return releaseDrag();
      updateDrag(event.clientX, event.clientY);
      const { pane, target, edge, changed } = drag;
      releaseDrag(true);
      if (target) exchange(pane, target);
      if (changed && edge !== 'move') {
        live.textContent = `已调整${pane.label}的大小。`;
        save();
      }
      sync();
    }

    function releaseDrag(commit = false) {
      if (!drag) return;
      const { pane, target, handle, pointerId, before, changed } = drag;
      drag = undefined;
      if (before && changed && !commit) {
        splitView.restore(before);
        sync();
      }
      delete pane.overlay.dataset.dragSource;
      if (target) delete target.overlay.dataset.dropTarget;
      workspace.classList.remove('panel-layout-dragging');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    }

    for (const pane of panes.values()) {
      for (const [edge, direction] of Object.entries({ move: '', ...edges })) {
        const label = edge === 'move' ? `交换${pane.label}的位置` : `调整${pane.label}${direction}`;
        const title = edge === 'move' ? '拖到另一块面板上松开，或按方向键直接交换' : `${label}（可用方向键）`;
        const handle = create('button', { type: 'button', className: 'panel-layout-handle', title });
        handle.dataset.edge = edge;
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
    }

    function reset() {
      releaseDrag();
      slots = { ...defaultSlots };
      active = 'player';
      editing = false;
      beforeEdit = undefined;
      splitView.reset();
      applySlots();
      save();
      live.textContent = '已恢复默认布局。';
      sync();
    }

    function endEditing(cancel) {
      releaseDrag();
      if (cancel) {
        slots = beforeEdit.slots;
        applySlots();
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
      beforeEdit = { slots: { ...slots }, active, split: splitView.snapshot() };
      editing = true;
      live.textContent = '拖动面板到另一块面板上松开即可交换，方向键也可交换。拖动边缘调整大小，按 Esc 取消本次调整。';
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
      active = pane.id;
      pane.overlay.querySelector('[data-edge="move"]').focus({ preventScroll: true });
      live.textContent = `已选择${pane.label}，按方向键与相邻面板交换。`;
      sync();
    });
    resetButton.addEventListener('click', () => { reset(); toggle.focus({ preventScroll: true }); });
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', () => releaseDrag());
    applySlots();
    const observer = new ResizeObserver(sync);
    for (const target of [workspace, toolbar, notice]) observer.observe(target);
    sync();
    return { sync, reset };
  };
})();

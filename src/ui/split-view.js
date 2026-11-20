'use strict';

(() => {
  const key = 'sd-workbench-split-view-v1';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const ids = ['materials', 'inspector', 'timeline'];

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      return Object.fromEntries(ids.filter((id) => Number.isFinite(saved?.[id]) && saved[id] > 0 && saved[id] < 1)
        .map((id) => [id, saved[id]]));
    } catch { return {}; }
  }

  window.mountSplitView = (workspace, bounds) => {
    const handles = [...workspace.querySelectorAll('.workspace-divider')];
    let preferred = read();
    let drag;

    function save() {
      if (drag) return;
      try {
        if (Object.keys(preferred).length) localStorage.setItem(key, JSON.stringify(preferred));
        else localStorage.removeItem(key);
      } catch { /* Resizing remains available without persistent storage. */ }
    }

    function measure({ width, height, gutter } = bounds()) {
      // At small window sizes reserve usable space for each pane first.
      const panelWidth = width - 2 * gutter;
      const panelHeight = height - gutter;
      const scale = Math.min(1, panelWidth / (158 + 210 + 202));
      const min = { materials: 158 * scale, inspector: 210 * scale, timeline: Math.min(160, panelHeight * .46) };
      const sideBudget = panelWidth - 202 * scale;
      const materials = preferred.materials ? width * preferred.materials : clamp(width * .19, 176, 295);
      const inspector = preferred.inspector ? width * preferred.inspector : clamp(width * .215, 216, 336);
      const extraLeft = Math.max(0, materials - min.materials);
      const extraRight = Math.max(0, inspector - min.inspector);
      const extraScale = Math.min(1, Math.max(0, sideBudget - min.materials - min.inspector) / (extraLeft + extraRight || 1));
      const left = min.materials + extraLeft * extraScale;
      const right = min.inspector + extraRight * extraScale;
      const max = { materials: sideBudget - right, inspector: sideBudget - left, timeline: panelHeight - Math.min(165, panelHeight * .5) };
      const defaultTimeline = Math.max(205, height * (matchMedia('(max-width: 940px)').matches ? .47 : .405));
      const timeline = clamp(preferred.timeline ? height * preferred.timeline : defaultTimeline, min.timeline, max.timeline);
      return { width, height, gutter, min, max, wanted: { materials, inspector }, size: { materials: left, inspector: right, timeline } };
    }

    function render(layout = measure()) {
      for (const handle of handles) {
        const id = handle.dataset.split;
        const value = layout.size[id];
        workspace.style.setProperty(`--split-${id}`, `${value}px`);
        handle.setAttribute('aria-valuenow', Math.round(value));
        handle.setAttribute('aria-valuetext', `${Math.round(value)} 像素`);
        handle.setAttribute('aria-valuemin', Math.round(layout.min[id]));
        handle.setAttribute('aria-valuemax', Math.round(layout.max[id]));
      }
    }

    function update(id, value, layout = measure()) {
      const size = clamp(value, layout.min[id], layout.max[id]);
      if (Math.abs(size - layout.size[id]) < .01) return;
      if (id !== 'timeline') {
        // A previously larger window may have stored two very wide side panes.
        // Pin the visible opposite edge while dragging out of this constraint.
        const other = id === 'materials' ? 'inspector' : 'materials';
        if (Math.abs(layout.wanted[other] - layout.size[other]) > 1) preferred[other] = layout.size[other] / layout.width;
      }
      preferred[id] = size / (id === 'timeline' ? layout.height : layout.width);
      render(measure(layout));
    }

    function finish(event) {
      if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
      const { handle, pointerId, before } = drag;
      drag = null;
      handle.removeAttribute('data-dragging');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (event?.type === 'pointerup') save();
      else { preferred = before; render(); }
    }

    for (const handle of handles) {
      const id = handle.dataset.split;
      const axis = id === 'timeline' ? 'clientY' : 'clientX';
      // Framework7 handleTouchMove uses initial width + signed displacement, clamped to the available space:
      // https://github.com/framework7io/framework7/blob/master/src/core/components/panel/resizable-panel.js#L73-L84
      const sign = id === 'materials' ? 1 : -1;
      handle.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button !== 0 || drag) return;
        // Keep an editor's caret while resizing. Otherwise let Chromium choose the focus modality.
        const focused = document.activeElement;
        if (focused?.matches('input, select, textarea') || focused?.isContentEditable) event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch { return; }
        handle.dataset.pointerFocus = '';
        drag = { handle, id, axis, sign, pointerId: event.pointerId, start: event[axis], size: measure().size[id], before: { ...preferred } };
        handle.dataset.dragging = '';
      });
      handle.addEventListener('focus', () => {
        if (drag?.handle !== handle) handle.removeAttribute('data-pointer-focus');
      });
      handle.addEventListener('blur', () => {
        handle.removeAttribute('data-pointer-focus');
        if (drag?.handle === handle) finish();
      });
      handle.addEventListener('lostpointercapture', (event) => { if (drag?.handle === handle) finish(event); });
      handle.addEventListener('dblclick', () => {
        delete preferred[id];
        render();
        save();
      });
      handle.addEventListener('keydown', (event) => {
        if (drag || event.altKey || event.ctrlKey || event.metaKey) return;
        const layout = measure();
        const decrease = id === 'timeline' ? 'ArrowUp' : 'ArrowLeft';
        const increase = id === 'timeline' ? 'ArrowDown' : 'ArrowRight';
        const step = (event.shiftKey ? 32 : 8) * sign;
        const values = { [decrease]: layout.size[id] - step, [increase]: layout.size[id] + step, Home: layout.min[id], End: layout.max[id] };
        if (!Object.hasOwn(values, event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        handle.removeAttribute('data-pointer-focus');
        update(id, values[event.key], layout);
        save();
      });
    }
    window.addEventListener('keydown', (event) => {
      if (!drag || event.key !== 'Escape' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish();
    }, true);
    window.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) return finish();
      update(drag.id, drag.size + (event[drag.axis] - drag.start) * drag.sign);
    });
    for (const name of ['pointerup', 'pointercancel']) window.addEventListener(name, finish);
    window.addEventListener('blur', () => finish());
    return {
      sync(enabled) {
        if (!enabled || workspace.hasAttribute('data-layout-editing')) finish();
        if (enabled) render();
      },
      sizes() { return measure().size; },
      resize: update,
      save,
      snapshot() { return { ...(drag?.before ?? preferred) }; },
      restore(saved) { finish(); preferred = { ...saved }; save(); },
      get modified() { return Object.keys(preferred).length > 0; },
      reset() { finish(); preferred = {}; save(); },
    };
  };
})();

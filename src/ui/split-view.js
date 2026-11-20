'use strict';

(() => {
  const key = 'sd-workbench-split-view-v1';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const ids = ['materials', 'inspector', 'timeline'];
  const sides = ['materials', 'inspector'];
  const dockKey = side => 'dock-' + side;

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      const preferred = Object.fromEntries(ids.filter((id) => Number.isFinite(saved?.[id]) && saved[id] > 0 && saved[id] <= 1)
        .map((id) => [id, saved[id]]));
      for (const side of sides) if (saved?.[dockKey(side)] === true) preferred[dockKey(side)] = true;
      return preferred;
    } catch { return {}; }
  }

  window.mountSplitView = (workspace, bounds) => {
    const dividers = [...workspace.querySelectorAll('.workspace-divider')];
    const handles = [...dividers];
    const guides = new Map();
    for (const side of sides) {
      const guide = document.createElement('div');
      guide.className = 'workspace-dock-guide';
      guide.dataset.side = side;
      guide.setAttribute('aria-hidden', 'true');
      workspace.append(guide);
      guides.set(side, guide);
      for (const kind of ['dock', 'junction']) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'workspace-area-handle';
        handle.dataset.areaHandle = kind;
        handle.dataset.side = side;
        workspace.append(handle);
        handles.push(handle);
      }
    }
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
      // Compact panes remain visible and their boundaries remain reachable.
      const minColumn = Math.min(76, panelWidth / 3);
      const minRow = Math.min(52, panelHeight / 2);
      const min = { materials: minColumn, inspector: minColumn, timeline: minRow };
      const sideBudget = panelWidth - minColumn;
      const materials = preferred.materials ? width * preferred.materials : clamp(width * .19, 176, 295);
      const inspector = preferred.inspector ? width * preferred.inspector : clamp(width * .215, 216, 336);
      const extraLeft = Math.max(0, materials - min.materials);
      const extraRight = Math.max(0, inspector - min.inspector);
      const extraScale = Math.min(1, Math.max(0, sideBudget - min.materials - min.inspector) / (extraLeft + extraRight || 1));
      const left = min.materials + extraLeft * extraScale;
      const right = min.inspector + extraRight * extraScale;
      const max = { materials: sideBudget - right, inspector: sideBudget - left, timeline: panelHeight - minRow };
      const defaultTimeline = Math.max(205, height * (matchMedia('(max-width: 940px)').matches ? .47 : .405));
      const timeline = clamp(preferred.timeline ? height * preferred.timeline : defaultTimeline, min.timeline, max.timeline);
      return { width, height, gutter, min, max, wanted: { materials, inspector }, size: { materials: left, inspector: right, timeline } };
    }

    function render(layout = measure()) {
      for (const side of sides) workspace.toggleAttribute('data-' + dockKey(side), Boolean(preferred[dockKey(side)]));
      for (const handle of handles.filter(el => el.dataset.areaHandle === 'dock')) {
        handle.setAttribute('aria-pressed', String(Boolean(preferred[dockKey(handle.dataset.side)])));
      }
      for (const handle of dividers) {
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

    function dock(side, fullHeight) {
      if (Boolean(preferred[dockKey(side)]) === fullHeight) return;
      if (fullHeight) preferred[dockKey(side)] = true;
      else delete preferred[dockKey(side)];
      render();
      const guide = guides.get(side);
      delete guide.dataset.preview;
      guide.getAnimations().forEach(animation => animation.cancel());
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        // Only the guide moves. Editor controls, hit targets and scroll ranges
        // already belong to the new rectangles, even on a rapid reversal.
        guide.animate([
          { opacity: .85, clipPath: 'inset(0 0 0 0)' },
          { opacity: 0, clipPath: fullHeight ? 'inset(95% 0 0 0)' : 'inset(0 0 95% 0)' },
        ], { duration: 145, easing: 'ease-out' });
      }
    }

    // A continuous border moves pixel for pixel. A side crossing the lower
    // area changes the T junction between two complete rectangular tilings.
    // Track the furthest point so a deliberate reversal also works mid-drag.
    function gesture(horizontal, vertical, event) {
      const { size } = measure();
      const startX = event.clientX, startY = event.clientY;
      let anchorY = startY;
      return (x, y) => {
        if (horizontal) update(horizontal, size[horizontal] + (x - startX) * (horizontal === 'materials' ? 1 : -1));
        if (vertical === 'timeline') update('timeline', size.timeline - (y - startY));
        else if (vertical) {
          const extended = Boolean(preferred[dockKey(vertical)]);
          anchorY = extended ? Math.max(anchorY, y) : Math.min(anchorY, y);
          const distance = (y - anchorY) * (extended ? -1 : 1);
          guides.get(vertical).toggleAttribute('data-preview', distance > 3 && distance < 18);
          if (distance >= 18) {
            dock(vertical, !extended);
            anchorY = y;
          }
        }
      };
    }

    function clearGuides() {
      for (const guide of guides.values()) guide.removeAttribute('data-preview');
    }

    function finish(event) {
      if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
      const { handle, pointerId, before } = drag;
      if (event?.type === 'pointerup') drag.move(event.clientX, event.clientY);
      clearGuides();
      drag = null;
      handle.removeAttribute('data-dragging');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (event?.type === 'pointerup') save();
      else { preferred = before; render(); }
    }

    for (const handle of handles) {
      const { split: id, areaHandle, side } = handle.dataset;
      const horizontal = areaHandle === 'junction' ? side : sides.includes(id) ? id : undefined;
      const vertical = areaHandle === 'dock' ? side : (id === 'timeline' || areaHandle === 'junction') ? 'timeline' : undefined;
      handle.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button !== 0 || drag || workspace.classList.contains('panel-layout-dragging')) return;
        // Keep an editor's caret while resizing. Otherwise let Chromium choose the focus modality.
        const focused = document.activeElement;
        if (focused?.matches('input, select, textarea') || focused?.isContentEditable) event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch { return; }
        handle.dataset.pointerFocus = '';
        drag = { handle, pointerId: event.pointerId, move: gesture(horizontal, vertical, event), before: { ...preferred } };
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
      if (areaHandle === 'dock') handle.addEventListener('click', event => {
        if (event.detail) return;
        dock(side, !preferred[dockKey(side)]);
        save();
      });
      handle.addEventListener('dblclick', () => {
        if (areaHandle === 'dock') delete preferred[dockKey(side)];
        else {
          if (horizontal) delete preferred[horizontal];
          if (vertical) delete preferred[vertical];
        }
        render();
        save();
      });
      handle.addEventListener('keydown', (event) => {
        if (drag || event.altKey || event.ctrlKey || event.metaKey) return;
        const layout = measure();
        if (areaHandle === 'dock') {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
          const extended = Boolean(preferred[dockKey(side)]);
          dock(side, ['Enter', ' '].includes(event.key) ? !extended : ['ArrowDown', 'End'].includes(event.key));
        } else {
          const split = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? horizontal
            : ['ArrowUp', 'ArrowDown'].includes(event.key) ? vertical : id;
          if (!split) return;
          const step = (event.shiftKey ? 32 : 8) * (split === 'materials' ? 1 : -1);
          const values = { ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step };
          if (Object.hasOwn(values, event.key)) update(split, layout.size[split] + values[event.key], layout);
          else if (event.key === 'Home' || event.key === 'End') update(split, layout[event.key === 'Home' ? 'min' : 'max'][split], layout);
          else return;
        }
        event.preventDefault();
        event.stopPropagation();
        handle.removeAttribute('data-pointer-focus');
        save();
      });
    }
    window.addEventListener('keydown', (event) => {
      if (!drag || event.key !== 'Escape' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (workspace.hasAttribute('data-layout-editing')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish();
    }, true);
    window.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) return finish();
      drag.move(event.clientX, event.clientY);
    });
    for (const name of ['pointerup', 'pointercancel']) window.addEventListener(name, finish);
    window.addEventListener('blur', () => finish());
    window.addEventListener('resize', () => finish());
    return {
      sync(enabled) {
        if (!enabled) finish();
        if (enabled) render();
      },
      sizes() { return measure().size; },
      resize: update,
      gesture, dock, clearGuides,
      docked(side) { return Boolean(preferred[dockKey(side)]); },
      get dragging() { return Boolean(drag); },
      save,
      snapshot() { return { ...(drag?.before ?? preferred) }; },
      restore(saved) { finish(); preferred = { ...saved }; save(); },
      get modified() { return Object.keys(preferred).length > 0; },
      reset() { finish(); preferred = {}; save(); },
    };
  };
})();

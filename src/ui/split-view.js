'use strict';

(() => {
  const key = 'sd-workbench-split-view-v1';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const ids = ['materials', 'inspector', 'timeline'];
  const sides = ['materials', 'inspector'];
  const dockKey = side => 'dock-' + side;
  const belowKey = side => 'below-' + side;
  const returnKey = side => 'return-' + side;
  const spanPosition = { player: 'below', timeline: 'above', dock: 'full' };
  const collapsedPosition = { player: 'above', timeline: 'full', dock: 'above' };

  // Panels and dividers share a single pending sample per gesture. Release uses
  // the pointerup coordinates synchronously, even between two display frames.
  function queuePointer(drag, x, y, move) {
    drag.xPending = x;
    drag.yPending = y;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      move(drag.xPending, drag.yPending);
    });
  }

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      const preferred = Object.fromEntries(ids.filter((id) => Number.isFinite(saved?.[id]) && saved[id] > 0 && saved[id] <= 1)
        .map((id) => [id, saved[id]]));
      for (const side of sides) {
        if (saved?.[dockKey(side)] === true) preferred[dockKey(side)] = true;
        else if (saved?.[belowKey(side)] === true) preferred[belowKey(side)] = true;
        if (['above', 'below', 'full'].includes(saved?.[returnKey(side)])) preferred[returnKey(side)] = saved[returnKey(side)];
      }
      return preferred;
    } catch { return {}; }
  }

  window.mountSplitView = (workspace, bounds, topologyChanged) => {
    const compactWindow = matchMedia('(max-width: 940px)');
    const dividers = [...workspace.querySelectorAll('.workspace-divider')];
    const handles = [...dividers];
    const guides = new Map();
    const cursorSurface = document.createElement('div');
    cursorSurface.className = 'workspace-resize-cursor';
    cursorSurface.hidden = true;
    workspace.append(cursorSurface);
    for (const side of sides) {
      const guide = document.createElement('div');
      guide.className = 'workspace-dock-guide';
      guide.dataset.side = side;
      guide.setAttribute('aria-hidden', 'true');
      workspace.append(guide);
      guides.set(side, guide);
      for (const kind of ['dock', 'junction', 'player', 'timeline']) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'workspace-area-handle';
        handle.dataset.areaHandle = kind;
        handle.dataset.side = side;
        if (kind === 'player' || kind === 'timeline') handle.classList.add('workspace-span-handle');
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
      const defaultTimeline = Math.max(205, height * (compactWindow.matches ? .47 : .405));
      const timeline = clamp(preferred.timeline ? height * preferred.timeline : defaultTimeline, min.timeline, max.timeline);
      return { width, height, gutter, min, max, wanted: { materials, inspector }, size: { materials: left, inspector: right, timeline } };
    }

    function position(side) {
      return preferred[dockKey(side)] ? 'full' : preferred[belowKey(side)] ? 'below' : 'above';
    }

    function lowerSide(side) {
      return position(side) === 'below' || (position(side) === 'full' && preferred[returnKey(side)] === 'below');
    }

    let lastTopology, lastLayout;
    function render(layout = measure()) {
      const topology = sides.map(side => position(side) + (lowerSide(side) ? '-lower' : '')).join('/');
      if (topology !== lastTopology) {
        lastTopology = topology;
        const rows = [['materials', 'player', 'properties'], ['.', '.', '.'], ['timeline', 'timeline', 'timeline']];
        for (const [index, side] of sides.entries()) {
          const column = index * 2, name = rows[0][column], state = position(side);
          if (state === 'full') rows[1][column] = rows[2][column] = name;
          if (state === 'below') { rows[0][column] = 'player'; rows[2][column] = name; }
          workspace.toggleAttribute('data-' + dockKey(side), state === 'full');
          workspace.toggleAttribute('data-' + belowKey(side), state === 'below');
          workspace.toggleAttribute('data-lower-' + side, lowerSide(side));
        }
        workspace.style.setProperty('--split-areas', rows.map(row => '"' + row.join(' ') + '"').join(' '));
        for (const handle of handles) {
          const { areaHandle: kind, side } = handle.dataset;
          if (spanPosition[kind]) handle.setAttribute('aria-pressed', String(position(side) === spanPosition[kind]));
        }
        topologyChanged();
      }
      for (const handle of dividers) {
        const id = handle.dataset.split;
        const value = layout.size[id];
        if (value !== lastLayout?.size[id]) workspace.style.setProperty(`--split-${id}`, `${value}px`);
        if (Math.round(value) !== Math.round(lastLayout?.size[id])) {
          handle.setAttribute('aria-valuenow', Math.round(value));
          handle.setAttribute('aria-valuetext', `${Math.round(value)} 像素`);
        }
        for (const limit of ['min', 'max']) {
          if (Math.round(layout[limit][id]) !== Math.round(lastLayout?.[limit][id])) {
            handle.setAttribute('aria-value' + limit, Math.round(layout[limit][id]));
          }
        }
      }
      lastLayout = layout;
    }

    function setSize(id, value, layout) {
      const size = clamp(value, layout.min[id], layout.max[id]);
      if (Math.abs(size - layout.size[id]) < .01) return;
      if (id !== 'timeline') {
        // A previously larger window may have stored two very wide side panes.
        // Pin the visible opposite edge while dragging out of this constraint.
        const other = id === 'materials' ? 'inspector' : 'materials';
        if (Math.abs(layout.wanted[other] - layout.size[other]) > 1) preferred[other] = layout.size[other] / layout.width;
      }
      preferred[id] = size / (id === 'timeline' ? layout.height : layout.width);
      return true;
    }

    function update(id, value, layout = measure()) {
      if (setSize(id, value, layout)) render(measure(layout));
    }

    function setSpan(kind, side, expand) {
      const previous = position(side), target = spanPosition[kind], fallback = collapsedPosition[kind];
      if ((previous === target) === expand) return;
      const next = expand ? target : preferred[returnKey(side)] || fallback;
      delete preferred[returnKey(side)];
      if (expand && previous !== fallback) preferred[returnKey(side)] = previous;
      delete preferred[dockKey(side)];
      delete preferred[belowKey(side)];
      if (next === 'full') preferred[dockKey(side)] = true;
      if (next === 'below') preferred[belowKey(side)] = true;
      render();
      const guide = guides.get(side);
      delete guide.dataset.preview;
      guide.getAnimations().forEach(animation => animation.cancel());
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        // Only the guide moves. Editor controls, hit targets and scroll ranges
        // already belong to the new rectangles, even on a rapid reversal.
        guide.animate([
          { opacity: .85, clipPath: 'inset(0 0 0 0)' },
          { opacity: 0 },
        ], { duration: 145, easing: 'ease-out' });
      }
    }

    // Use the furthest point as the anchor so reversing the same gesture
    // restores the previous tiling without crossing a relocated handle.
    function spanGesture(kind, side, event) {
      const isVertical = kind === 'dock';
      const sign = isVertical ? (lowerSide(side) ? -1 : 1) : (side === 'materials' ? -1 : 1);
      let anchor = sign * (isVertical ? event.clientY : event.clientX);
      return (x, y) => {
        const coord = sign * (isVertical ? y : x), expanded = position(side) === spanPosition[kind];
        anchor = expanded ? Math.max(anchor, coord) : Math.min(anchor, coord);
        const distance = (coord - anchor) * (expanded ? -1 : 1);
        guides.get(side).toggleAttribute('data-preview', distance > 3 && distance < 18);
        if (distance >= 18) {
          setSpan(kind, side, !expanded);
          anchor = coord;
        }
      };
    }

    function gesture(horizontal, vertical, event) {
      const initial = measure();
      const { size } = initial;
      const startX = event.clientX, startY = event.clientY;
      const moveDock = sides.includes(vertical) ? spanGesture('dock', vertical, event) : undefined;
      return (x, y) => {
        if (horizontal || vertical === 'timeline') {
          // Resizing the tracks does not change the outer workspace bounds.
          // Its ResizeObserver remeasures independently when those bounds change.
          const layout = measure(lastLayout ?? initial);
          const widthChanged = horizontal && setSize(horizontal, size[horizontal] + (x - startX) * (horizontal === 'materials' ? 1 : -1), layout);
          const heightChanged = vertical === 'timeline' && setSize('timeline', size.timeline - (y - startY), layout);
          if (widthChanged || heightChanged) render(measure(layout));
        }
        moveDock?.(x, y);
      };
    }

    function clearGuides() {
      for (const guide of guides.values()) guide.removeAttribute('data-preview');
    }

    function finish(event) {
      if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
      const { handle, pointerId, before } = drag;
      cancelAnimationFrame(drag.frame);
      if (event?.type === 'pointerup') {
        drag.move(event.clientX, event.clientY);
        if (drag.tapped && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 3) {
          const { areaHandle: kind, side } = drag.primary.dataset;
          setSpan(kind, side, position(side) !== spanPosition[kind]);
        }
      }
      clearGuides();
      drag = null;
      cursorSurface.hidden = true;
      handle.removeAttribute('data-dragging');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (event?.type === 'pointerup') save();
      else { preferred = before; render(); }
    }

    function bindHandle(handle,primary) {
      const { split: id, areaHandle, side } = primary.dataset;
      const horizontal = areaHandle === 'junction' ? side : sides.includes(id) ? id : undefined;
      const vertical = areaHandle === 'dock' ? side : (id === 'timeline' || areaHandle === 'junction') ? 'timeline' : undefined;
      handle.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button !== 0 || drag || workspace.classList.contains('panel-layout-dragging')) return;
        // Keep an editor's caret while resizing. Otherwise let Chromium choose the focus modality.
        const focused = document.activeElement;
        if (focused?.matches('input, select, textarea') || focused?.isContentEditable) event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch { return; }
        cursorSurface.style.cursor = getComputedStyle(handle).cursor;
        handle.dataset.pointerFocus = '';
        const move = spanPosition[areaHandle] ? spanGesture(areaHandle, side, event) : gesture(horizontal, vertical, event);
        drag = { handle, primary, pointerId: event.pointerId, before: { ...preferred },
          tapped: primary.classList.contains('workspace-span-handle'),
          startX: event.clientX, startY: event.clientY, move };
        handle.dataset.dragging = '';
        cursorSurface.hidden = false;
      });
      handle.addEventListener('focus', () => {
        if (drag?.handle !== handle) handle.removeAttribute('data-pointer-focus');
      });
      handle.addEventListener('blur', () => {
        handle.removeAttribute('data-pointer-focus');
        if (drag?.handle === handle) finish();
      });
      handle.addEventListener('lostpointercapture', (event) => { if (drag?.handle === handle) finish(event); });
      if (spanPosition[areaHandle]) handle.addEventListener('click', event => {
        if (event.detail) return;
        setSpan(areaHandle, side, position(side) !== spanPosition[areaHandle]);
        save();
      });
      handle.addEventListener('dblclick', () => {
        if (spanPosition[areaHandle]) {
          delete preferred[dockKey(side)];
          delete preferred[belowKey(side)];
          delete preferred[returnKey(side)];
        }
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
        if (spanPosition[areaHandle]) {
          const arrows = areaHandle === 'dock' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
          if (![...arrows, 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
          const expanded = position(side) === spanPosition[areaHandle];
          const outward = areaHandle === 'dock' ? (lowerSide(side) ? 'ArrowUp' : 'ArrowDown') : (side === 'materials' ? 'ArrowLeft' : 'ArrowRight');
          setSpan(areaHandle, side, ['Enter', ' '].includes(event.key) ? !expanded : [outward, 'End'].includes(event.key));
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
      if (workspace.hasAttribute('data-layout-editing') && drag.handle===drag.primary) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish();
    }, true);
    const accessMenu=document.getElementById('accessible-layout-controls');
    const choice=document.getElementById('accessible-split-choice');
    const gripList=document.getElementById('accessible-split-grips');
    for (const [index,primary] of handles.entries()) {
      bindHandle(primary,primary);
      const grip=document.createElement('button');
      grip.type='button';
      grip.textContent='拖动调整';
      grip.dataset.grip=String(index);
      bindHandle(grip,primary);
      gripList.append(grip);
      choice.append(new Option('',String(index)));
    }
    function syncAccessible() {
      const item=handles[choice.selectedIndex];
      for(const [i,handle] of handles.entries()) {
        choice.options[i].textContent=handle.getAttribute('aria-label') || handle.title;
        const grip=gripList.children[i];
        grip.hidden=item!==handle;
        if(!grip.hidden) {
          grip.setAttribute('aria-label','拖动调整：'+choice.options[i].textContent);
          grip.style.cursor=getComputedStyle(handle).cursor;
        }
      }
    }
    choice.addEventListener('change',syncAccessible);
    accessMenu.addEventListener('beforetoggle',event=>{if(event.newState==='open') syncAccessible();});
    window.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) return finish();
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.tapped = false;
      queuePointer(drag, event.clientX, event.clientY, drag.move);
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
      gesture, spanGesture, setSpan, lowerSide, position, clearGuides, queuePointer,
      get dragging() { return Boolean(drag); },
      save,
      snapshot() { return { ...(drag?.before ?? preferred) }; },
      restore(saved) { finish(); preferred = { ...saved }; save(); },
      get modified() { return Object.keys(preferred).length > 0; },
      reset() { finish(); preferred = {}; save(); },
    };
  };
})();

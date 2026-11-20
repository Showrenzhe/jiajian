'use strict';

(() => {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const radians = Math.PI / 180;
  const innerRadius = .88; // The outer six percent on each side is the solid hue ring.
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  function fromHex(hex, previousHue = 0) {
    const [r, g, b] = hex.slice(1).match(/../g).map(byte => parseInt(byte, 16) / 255);
    const v = Math.max(r, g, b), delta = v - Math.min(r, g, b);
    let h = previousHue;
    if (delta) {
      const sector = v === r ? (g - b) / delta : v === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      h = (sector * 60 + 360) % 360;
    }
    return { h, s: v ? delta / v : 0, v };
  }

  function toHex({ h, s, v }) {
    const byte = offset => {
      const k = (offset + h / 60) % 6;
      const channel = v * (1 - s * clamp(Math.min(k, 4 - k), 0, 1));
      return Math.round(255 * channel).toString(16).padStart(2, '0');
    };
    return '#' + byte(5) + byte(3) + byte(1);
  }

  function open(source) {
    // A quick reopen can arrive while the previous wheel is fading away.
    document.querySelector('.color-wheel-panel:not([open])')?.remove();
    const panel = document.createElement('dialog');
    panel.className = 'color-wheel-panel';
    panel.setAttribute('aria-labelledby', 'color-wheel-title');
    panel.innerHTML = `
      <div class="color-wheel-heading">
        <h2 id="color-wheel-title"></h2>
        <button type="button" data-close aria-label="关闭色轮" title="关闭色轮">×</button>
      </div>
      <div class="color-wheel-adjust">
        <label class="color-wheel-axis">
          <input type="range" data-axis="s" min="0" max="100" step="1" aria-label="饱和度">
          <span>饱和度</span><output data-readout="s"></output>
        </label>
        <div class="color-wheel-disc" role="slider" tabindex="0" aria-label="色轮" aria-valuemin="0" aria-valuemax="360"
          aria-description="方向键移动选色点，按住 Alt 微调。">
          <span class="color-wheel-face"></span><span class="color-wheel-point"></span>
        </div>
        <label class="color-wheel-axis">
          <input type="range" data-axis="v" min="0" max="100" step="1" aria-label="亮度">
          <span>亮度</span><output data-readout="v"></output>
        </label>
      </div>
      <div class="color-wheel-values">
        <span class="color-wheel-sample" aria-hidden="true"></span>
        <label class="color-wheel-code">HEX<input data-hex maxlength="7" spellcheck="false" autocomplete="off" aria-label="十六进制颜色值"></label>
        <button type="button" data-dropper aria-label="屏幕取色" title="屏幕取色">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 7 3-3a2 2 0 0 1 3 3l-3 3m-5-4 6 6M13 8l-8 8-1 4 4-1 8-8"/></svg>
        </button>
      </div>
      <div class="color-wheel-rgb" role="group" aria-label="RGB 通道">
        <label>R<input type="number" data-channel="0" aria-label="红色通道" min="0" max="255" step="1"></label>
        <label>G<input type="number" data-channel="1" aria-label="绿色通道" min="0" max="255" step="1"></label>
        <label>B<input type="number" data-channel="2" aria-label="蓝色通道" min="0" max="255" step="1"></label>
      </div>
    `;
    const find = selector => panel.querySelector(selector);
    const disc = find('.color-wheel-disc'), hex = find('[data-hex]'), dropper = find('[data-dropper]');
    const axes = [...panel.querySelectorAll('[data-axis]')];
    const channels = [...panel.querySelectorAll('[data-channel]')];
    const title = source.getAttribute('aria-label') || source.labels?.[0]?.textContent.trim() || '颜色';
    find('h2').textContent = title;
    let color = fromHex(source.value);
    let committed = source.value;
    let pickController;
    const session = new AbortController();

    // The ring stays chromatic even when the original color is pure black.
    function point() {
      const angle = (-30 - color.h) * radians;
      return [Math.sin(angle) * color.s, -Math.cos(angle) * color.s];
    }

    function render(updateSource = true, editingChannel) {
      const value = toHex(color), [x, y] = point();
      panel.style.setProperty('--wheel-x', (50 + 50 * innerRadius * x) + '%');
      panel.style.setProperty('--wheel-y', (50 + 50 * innerRadius * y) + '%');
      panel.style.setProperty('--wheel-color', value);
      panel.style.setProperty('--wheel-hue', toHex({ ...color, s: 1, v: 1 }));
      panel.style.setProperty('--wheel-light', toHex({ ...color, v: 1 }));
      for (const axis of axes) {
        const key = axis.dataset.axis;
        axis.value = Math.round(100 * color[key]);
        find('[data-readout="' + key + '"]').textContent = axis.value + '%';
      }
      disc.setAttribute('aria-valuenow', Math.round(color.h));
      disc.setAttribute('aria-valuetext', '色相 ' + Math.round(color.h) + ' 度，饱和度 ' + Math.round(color.s * 100) + '%');
      hex.value = value.toUpperCase();
      channels.forEach((field, index) => {
        if (field !== editingChannel) field.value = parseInt(value.slice(1 + index * 2, 3 + index * 2), 16);
      });
      if (updateSource && value !== source.value) {
        source.value = value;
        source.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function commit() {
      if (committed !== source.value) {
        committed = source.value;
        source.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function selectPoint(x, y) {
      const radius = Math.hypot(x, y);
      if (radius > .001) color.h = (330 - Math.atan2(x, -y) / radians + 360) % 360;
      color.s = Math.min(1, radius);
      if (color.s > .001 && color.v === 0) color.v = 1;
      render();
    }

    function localPoint(event) {
      const rect = disc.getBoundingClientRect();
      return [(2 * (event.clientX - rect.left) / rect.width - 1) / innerRadius,
        (2 * (event.clientY - rect.top) / rect.height - 1) / innerRadius];
    }

    let drag;
    function move(event) {
      const [x, y] = localPoint(event);
      if (event.altKey) {
        const [oldX, oldY] = point();
        selectPoint(oldX + (x - drag.x) / 5, oldY + (y - drag.y) / 5);
      } else selectPoint(x, y);
      drag = { x, y };
    }
    disc.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      disc.focus();
      disc.setPointerCapture(event.pointerId);
      const [x, y] = localPoint(event);
      drag = { x, y };
      move(event);
    };
    disc.onpointermove = event => {
      if (drag && disc.hasPointerCapture(event.pointerId)) move(event);
    };
    disc.onlostpointercapture = () => { drag = undefined; commit(); };
    disc.onkeydown = event => {
      const step = directions[event.key];
      if (!step) return;
      event.preventDefault();
      const [x, y] = point(), distance = event.altKey ? .004 : .025;
      selectPoint(x + step[0] * distance, y + step[1] * distance);
      commit();
    };
    for (const axis of axes) {
      axis.oninput = () => {
        color[axis.dataset.axis] = axis.valueAsNumber / 100;
        render();
      };
      axis.onchange = commit;
    }
    function acceptHex() {
      const match = /^#?([0-9a-f]{6})$/i.exec(hex.value.trim());
      if (match) color = fromHex('#' + match[1], color.h);
      render();
      commit();
    }
    hex.onchange = acceptHex;
    hex.onkeydown = event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        acceptHex();
        hex.select();
      }
    };
    for (const field of channels) {
      field.oninput = () => {
        if (field.value === '' || !field.validity.valid) return;
        const offset = 1 + Number(field.dataset.channel) * 2;
        const value = toHex(color);
        const byte = field.valueAsNumber.toString(16).padStart(2, '0');
        color = fromHex(value.slice(0, offset) + byte + value.slice(offset + 2), color.h);
        render(true, field);
      };
      field.onchange = () => { render(); commit(); };
      field.onkeydown = event => {
        if (event.key === 'Enter') { event.preventDefault(); render(); commit(); field.select(); }
      };
    }
    dropper.hidden = typeof window.EyeDropper !== 'function';
    dropper.onclick = async () => {
      pickController = new AbortController();
      try {
        const result = await new EyeDropper().open({ signal: pickController.signal });
        if (panel.open) {
          color = fromHex(result.sRGBHex, color.h);
          render();
          commit();
        }
      } catch (error) {
        if (error.name !== 'AbortError') console.warn('屏幕取色不可用', error);
      } finally { pickController = undefined; }
    };
    find('[data-close]').onclick = () => panel.close();
    panel.onpointerdown = event => {
      const box = panel.getBoundingClientRect();
      if (event.target === panel && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) panel.close();
    };
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') event.stopPropagation();
    });
    panel.onclose = () => {
      session.abort();
      pickController?.abort();
      commit();
      if (!panel.isConnected) return;
      panel.inert = true;
      if (source.isConnected) source.focus({ preventScroll: true });
      const transitions = panel.getAnimations();
      if (transitions.length) Promise.allSettled(transitions.map(item => item.finished)).then(() => panel.remove());
      else panel.remove();
    };
    function position() {
      const anchor = source.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
      const gap = 8;
      const left = anchor.left >= width + 2 * gap ? anchor.left - width - gap : anchor.right + gap;
      const x = clamp(left, gap, innerWidth - width - gap);
      const y = clamp(anchor.top - 12, gap, innerHeight - height - gap);
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.transformOrigin = clamp(anchor.left + anchor.width / 2 - x, 0, width) + 'px '
        + clamp(anchor.top + anchor.height / 2 - y, 0, height) + 'px';
      panel.style.setProperty('--menu-shift-x', x < anchor.left ? '3px' : '-3px');
      panel.style.setProperty('--menu-shift-y', '0px');
    }
    document.body.append(panel);
    render(false);
    panel.showModal();
    position();
    window.addEventListener('resize', position, { signal: session.signal });
    disc.focus({ preventScroll: true });
  }

  // Keep each original form control, label, and its preview/save event pipeline.
  // Delegation also covers controls built after startup inside editing dialogs.
  function activate(event) {
    const source = event.target;
    if (!source.matches?.('input[type="color"]:enabled')) return;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.type === 'keydown') event.stopPropagation();
    if (!document.querySelector('.color-wheel-panel[open]')) open(source);
  }
  document.addEventListener('click', activate, true);
  document.addEventListener('keydown', activate, true);
})();

'use strict';

(() => {
  const key = 'jiajian.appearance';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const motion = matchMedia('(prefers-reduced-motion: no-preference) and (forced-colors: none)');
  const midpointTint = 98;
  let preference = 'system';
  let picker;
  let surfaceAnimation;
  let requestedTheme;

  function supported(value) {
    return value === 'light' || value === 'dark' || value === 'system';
  }

  function paint(theme) {
    root.dataset.theme = theme;
    window.workbench?.setWindowAppearance?.(theme).catch(() => {});
  }

  async function easeTint(from, to) {
    surfaceAnimation?.cancel();
    const animation = root.animate([
      { '--appearance-tint': from + '%' }, { '--appearance-tint': to + '%' },
    ], {
      duration: 125 * Math.abs(to - from) / midpointTint,
      easing: 'ease-in-out',
      fill: 'both',
    });
    surfaceAnimation = animation;
    try {
      await animation.finished;
      return surfaceAnimation === animation;
    } catch { return false; } // A newer preference interrupted this leg.
  }

  async function changeTheme(theme) {
    root.setAttribute('data-theme-changing', '');
    if (motion.matches) {
      let tint = parseFloat(getComputedStyle(root).getPropertyValue('--appearance-tint')) || 0;
      if (theme !== root.dataset.theme) {
        if (!await easeTint(tint, midpointTint)) return;
        paint(theme);
        tint = midpointTint;
      }
      if (!await easeTint(tint, 0)) return;
    } else {
      surfaceAnimation?.cancel();
      paint(theme);
      // Resolve pending hover styles with their transitions suppressed.
      void root.offsetWidth;
    }
    surfaceAnimation?.cancel();
    surfaceAnimation = undefined;
    root.removeAttribute('data-theme-changing');
  }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.appearance = preference;
    if (picker) picker.querySelector(`input[value="${preference}"]`).checked = true;
    if (requestedTheme === theme) return;
    requestedTheme = theme;
    if (root.hasAttribute('data-theme')) changeTheme(theme);
    else paint(theme); // Cold start sets the palette before CSS loads.
  }

  try {
    const saved = localStorage.getItem(key);
    if (supported(saved)) preference = saved;
  } catch { /* A session can still change appearance when storage is unavailable. */ }
  apply();
  motion.addEventListener('change', () => {
    if (!motion.matches && surfaceAnimation) changeTheme(requestedTheme);
  });
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return;
    preference = supported(event.newValue) ? event.newValue : 'system';
    apply();
  });

  window.bindAppearancePicker = (group) => {
    picker = group;
    apply();
    group.addEventListener('change', (event) => {
      if (!supported(event.target.value)) return;
      preference = event.target.value;
      try { localStorage.setItem(key, preference); } catch { /* Keep the session preference. */ }
      apply();
    });
  };
})();

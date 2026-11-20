'use strict';

(() => {
  const key = 'jiajian.appearance';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const motion = matchMedia('(prefers-reduced-motion: no-preference) and (forced-colors: none)');
  let preference = 'system';
  let picker;
  let transition;
  let chromeFrame;
  let requestedTheme;

  function supported(value) {
    return value === 'light' || value === 'dark' || value === 'system';
  }

  function paint(theme) {
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    window.workbench?.setWindowAppearance?.(theme).catch(() => {});
  }

  function finish() {
    cancelAnimationFrame(chromeFrame);
    paint(requestedTheme);
    transition?.cancel();
    transition = undefined;
    // Resolve the resting palette before ordinary button hover transitions resume.
    void root.offsetWidth;
    root.removeAttribute('data-theme-changing');
  }

  function changeTheme() {
    if (!root.hasAttribute('data-theme') || !motion.matches) {
      finish();
      return;
    }
    if (transition) {
      transition.reverse();
      return;
    }
    const fromDark = root.dataset.theme === 'dark';
    root.setAttribute('data-theme-changing', '');
    transition = root.animate([
      { '--appearance-mix': fromDark ? '100%' : '0%' },
      { '--appearance-mix': fromDark ? '0%' : '100%' },
    ], { duration: 300, easing: 'cubic-bezier(.42, 0, .3, 1)', fill: 'both' });
    // Only the OS caption buttons and the browser's built-in controls have a
    // discrete appearance. Switch them as their chrome crosses middle gray.
    function syncChrome() {
      const progress = transition.effect.getComputedTiming().progress ?? 0;
      paint((fromDark ? 1 - progress : progress) >= .6 ? 'dark' : 'light');
      chromeFrame = requestAnimationFrame(syncChrome);
    }
    syncChrome();
    const active = transition;
    active.onfinish = () => {
      if (transition === active && active.playState === 'finished') finish();
    };
  }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.appearance = preference;
    if (picker) picker.querySelector(`input[value="${preference}"]`).checked = true;
    if (requestedTheme === theme) return;
    requestedTheme = theme;
    changeTheme();
  }

  try {
    const saved = localStorage.getItem(key);
    if (supported(saved)) preference = saved;
  } catch { /* A session can still change appearance when storage is unavailable. */ }
  apply();
  motion.addEventListener('change', () => {
    if (!motion.matches && transition) finish();
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

'use strict';

(() => {
  const key = 'jiajian.appearance';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  let picker;
  let transitionTimer;

  function supported(value) {
    return value === 'light' || value === 'dark' || value === 'system';
  }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.appearance = preference;
    if (picker) picker.querySelector(`input[value="${preference}"]`).checked = true;
    if (theme === root.dataset.theme) return;

    // Only animate subsequent changes. The first theme is set before CSS loads.
    if (root.hasAttribute('data-theme')) {
      root.setAttribute('data-theme-changing', '');
      clearTimeout(transitionTimer);
      transitionTimer = setTimeout(() => root.removeAttribute('data-theme-changing'), 300);
    }
    root.dataset.theme = theme;
    window.workbench?.setWindowAppearance?.(theme).catch(() => {});
  }

  try {
    const saved = localStorage.getItem(key);
    if (supported(saved)) preference = saved;
  } catch { /* A session can still change appearance when storage is unavailable. */ }
  apply();
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

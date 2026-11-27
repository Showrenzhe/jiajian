'use strict';

(() => {
  const key = 'jiajian.glass';
  const supported = value => ['full', 'lite', 'off'].includes(value);
  const software = window.workbench?.softwareRenderingActive === true;
  let preference = 'full';
  try {
    const saved = localStorage.getItem(key);
    if (supported(saved)) preference = saved;
  } catch { /* Keep the default when local storage cannot be read. */ }

  function apply() {
    document.documentElement.dataset.glass = software ? 'off' : preference;
  }
  apply();

  window.bindGlassEffectPicker = (picker, note) => {
    const messages = window.editorMessages.glassEffect;
    picker.value = document.documentElement.dataset.glass;
    picker.disabled = software;
    note.textContent = software ? messages.compatibility : '';
    note.hidden = !software;
    if (software) return;
    picker.addEventListener('change', () => {
      if (!supported(picker.value)) return;
      try {
        localStorage.setItem(key, picker.value);
        preference = picker.value;
        apply();
        note.textContent = '';
        note.hidden = true;
      } catch {
        picker.value = preference;
        note.textContent = messages.storageError;
        note.hidden = false;
      }
    });
  };
})();

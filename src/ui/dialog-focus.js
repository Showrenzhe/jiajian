'use strict';

// Electron can hand focus to the window at either end of a modal's tab order.
// Only the foremost native modal can receive a trusted keyboard event.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const dialog = event.target.closest?.('dialog:modal');
  if (!dialog) return;

  const controls = [...dialog.querySelectorAll('button, input, select, textarea, summary, audio[controls], video[controls], a[href], [tabindex]')]
    .filter((control) => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[inert]')
      && control.checkVisibility({ visibilityProperty: true }));
  const first = controls[0];
  const last = controls.at(-1);
  const fromHeading = event.target.matches('[tabindex="-1"]');
  if (!first || (event.shiftKey ? event.target === first || fromHeading : event.target === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
});

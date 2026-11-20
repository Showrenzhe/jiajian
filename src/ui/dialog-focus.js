'use strict';

const dialogInvokers = new WeakMap();
const pendingDialogExits = new WeakMap();

document.addEventListener('beforetoggle', event => {
  const dialog = event.target;
  if (event.newState !== 'open' || !dialog.matches('dialog:not(.color-wheel-panel)')) return;
  pendingDialogExits.delete(dialog);
  const source = event.source || document.activeElement;
  const anchor = source?.getBoundingClientRect();
  const menu = source?.closest('[popover][id]');
  const fallback = menu && document.querySelector('[popovertarget="' + CSS.escape(menu.id) + '"]');
  dialogInvokers.set(dialog, fallback || source);
  queueMicrotask(() => {
    if (!dialog.open) return;
    if (source === document.body || !anchor?.width || !anchor.height) {
      dialog.style.removeProperty('transform-origin');
      return;
    }
    const x = Math.max(0, Math.min(dialog.offsetWidth, anchor.left + anchor.width / 2 - dialog.offsetLeft));
    const y = Math.max(0, Math.min(dialog.offsetHeight, anchor.top + anchor.height / 2 - dialog.offsetTop));
    dialog.style.transformOrigin = x + 'px ' + y + 'px';
  });
}, true);

document.addEventListener('close', event => {
  const dialog = event.target;
  if (dialog.open) return;
  // A menu action can disappear as its dialog opens. After native close,
  // repair focus only if the browser left it on a disappearing surface.
  const active = document.activeElement, invoker = dialogInvokers.get(dialog);
  if (invoker?.isConnected && (active === document.body || dialog.contains(active) ||
      active.closest('[popover]:not(:popover-open)'))) invoker.focus({preventScroll:true});
}, true);

// Release resources in the ordinary close event. Only defer destructive DOM
// cleanup while the native display transition is keeping those pixels visible.
window.afterDialogExit = function (dialog, cleanup = () => dialog.remove()) {
  if (dialog.open) return;
  const exit = dialog.getAnimations().find(animation => animation.transitionProperty === 'display');
  if (!exit) { cleanup(); return; }
  pendingDialogExits.set(dialog, exit);
  exit.finished.catch(() => {}).then(() => {
    if (pendingDialogExits.get(dialog) !== exit || dialog.open) return;
    pendingDialogExits.delete(dialog);
    cleanup();
  });
};

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

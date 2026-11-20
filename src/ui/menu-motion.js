'use strict';

// CSS anchor positioning may flip a menu near the window edge. Use its final
// layout box (unaffected by the transition) to choose the point of origin.
document.addEventListener('beforetoggle', event => {
  const menu = event.target, button = event.source;
  if (event.newState !== 'open' || !button || !menu.matches('[popover]:not([popover="manual"])')) return;
  queueMicrotask(() => {
    if (!menu.matches(':popover-open')) return;
    const anchor = button.getBoundingClientRect();
    const x = Math.max(0, Math.min(menu.offsetWidth, anchor.left + anchor.width / 2 - menu.offsetLeft));
    const above = menu.offsetTop < anchor.top;
    menu.style.transformOrigin = x + 'px ' + (above ? 'bottom' : 'top');
    menu.style.setProperty('--menu-shift-y', above ? '3px' : '-3px');
  });
}, true);

// A customizable native select moves focus into its real option even when
// opened with the keyboard. Its picker can sit above a trigger near the bottom.
document.addEventListener('focusin', event => {
  const option = event.target;
  if (!option.matches('option')) return;
  const select = option.closest('select:open');
  if (!select) return;
  const above = option.getBoundingClientRect().top < select.getBoundingClientRect().top;
  select.style.setProperty('--picker-origin', above ? 'bottom' : 'top');
  select.style.setProperty('--picker-shift', above ? '3px' : '-3px');
});

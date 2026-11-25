'use strict';

// Discrete wheel notches and precision touchpad deltas drive the same zoom controls.
function bindWheelZoom(element, onZoom) {
  const isMac = navigator.platform.startsWith('Mac');
  let pending = 0, previousTime = -Infinity, frame;
  let steps = [], pointer;
  function queue(amount,event) {
    steps.push(amount);
    pointer={clientX:event.clientX,clientY:event.clientY};
    if(frame!==undefined) return;
    frame=requestAnimationFrame(()=>{
      frame=undefined;
      const batch=steps;
      steps=[];
      // Clamp each notch in order so reversing at a limit still moves one step.
      const levelAfter=(current,min,max,direction=1)=>batch.reduce(
        (level,amount)=>Math.max(min,Math.min(max,level+direction*amount)),current);
      if(element.clientWidth) onZoom(levelAfter,pointer);
    });
  }
  element.addEventListener('wheel', (event) => {
    const mode = event.deltaMode;
    if (!(event.ctrlKey || (isMac && event.metaKey)) || event.altKey || event.shiftKey
        || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      pending = 0;
      return;
    }
    event.preventDefault();
    const unit = mode === WheelEvent.DOM_DELTA_PAGE ? 100 : mode === WheelEvent.DOM_DELTA_LINE ? 100 / 3 : 1;
    const distance = -event.deltaY * unit;
    if (Math.abs(distance) >= 80 || (mode !== WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) >= 1)) {
      pending = 0;
      queue(Math.sign(distance) * Math.max(1, Math.round(Math.abs(distance) / 100)), event);
    } else {
      if (event.timeStamp - previousTime > 220 || pending * distance < 0) pending = 0;
      pending += distance;
      const steps = Math.trunc(pending / 48);
      if (steps) {
        pending -= steps * 48;
        queue(steps, event);
      }
    }
    previousTime = event.timeStamp;
  }, { passive: false });
}

function setupTabs(tablist, onChange) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const segmented = tablist.classList.contains('p-segmented');
  if (segmented) {
    tablist.style.setProperty('--p-seg-count', tabs.length);
    tablist.style.setProperty('--p-seg-index', Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')));
  }
  function activate(tab, focus = false) {
    if (tab.disabled) return;
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    if (segmented) tablist.style.setProperty('--p-seg-index', tabs.indexOf(tab));
    onChange?.();
    if (focus) tab.focus();
  }
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) activate(tab);
  });
  tablist.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = tabs.filter((tab) => !tab.disabled);
    const current = available.indexOf(event.target);
    if (current < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (current + step + available.length) % available.length;
    activate(available[next], true);
  });
  return activate;
}

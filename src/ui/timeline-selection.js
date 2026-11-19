'use strict';

window.mountTimelineSelection = function (host, {busy, changed, removed}) {
  const entries = new WeakMap();
  const scroller = host.closest('#timeline-tracks-panel');
  const frame = document.createElement('div');
  frame.className = 'timeline-marquee';
  frame.hidden = true;
  let selected = new Set(), visible = [], gesture, scrollFrame, suppressClick = false;

  function bind(node, key, remove, boxed = true) {
    entries.set(node, {key, remove, boxed});
    node.dataset.selectable = 'true';
  }
  function paint() {
    host.toggleAttribute('data-group-selected', selected.size > 0);
    for (const node of visible) {
      const on = selected.has(entries.get(node).key);
      node.classList.toggle('sequence-marked', on);
      node.setAttribute('aria-pressed', String(on));
    }
    changed(selected.size);
  }
  function attach(canvas) {
    visible = [...canvas.querySelectorAll('[data-selectable]')];
    const current = new Set(visible.map((node) => entries.get(node).key));
    selected = new Set([...selected].filter((key) => current.has(key)));
    canvas.append(frame);
    paint();
  }
  function removeSelection() {
    if (busy() || !selected.size) return false;
    const actions = new Map();
    for (const node of visible) {
      const entry = entries.get(node);
      if (selected.has(entry.key)) actions.set(entry.key,entry.remove);
    }
    selected.clear();
    for (const remove of actions.values()) remove();
    paint();
    if (actions.size) removed();
    return actions.size > 0;
  }
  function point(x, y) {
    const canvas = frame.parentElement.getBoundingClientRect();
    const viewport = host.getBoundingClientRect(), pane = scroller.getBoundingClientRect();
    const left = viewport.left + (host.querySelector('.sequence-head')?.offsetWidth ?? 0);
    return {x:Math.max(left, Math.min(viewport.right,x))-canvas.left,
      y:Math.max(Math.max(canvas.top,pane.top), Math.min(canvas.bottom,pane.bottom,y))-canvas.top};
  }
  function update() {
    if (!gesture?.active || !frame.parentElement) return;
    const end = point(gesture.x,gesture.y), start = gesture.start;
    const x = Math.min(start.x,end.x), y = Math.min(start.y,end.y);
    Object.assign(frame.style, {left:x+'px', top:y+'px', width:Math.abs(end.x-start.x)+'px', height:Math.abs(end.y-start.y)+'px'});
    frame.hidden = false;
    const box = frame.getBoundingClientRect();
    selected = new Set(gesture.base);
    for (const node of visible) {
      if (!entries.get(node).boxed) continue;
      const r = node.getBoundingClientRect();
      if (r.width && r.height && r.right>box.left && r.left<box.right && r.bottom>box.top && r.top<box.bottom) selected.add(entries.get(node).key);
    }
    paint();
  }
  function autoScroll() {
    if (!gesture?.active) return;
    const bounds = host.getBoundingClientRect(), pane = scroller.getBoundingClientRect();
    const step = (value,low,high) => value<low+15 ? -12 : value>high-15 ? 12 : 0;
    const left = host.scrollLeft, top = scroller.scrollTop;
    host.scrollLeft += step(gesture.x,bounds.left+90,bounds.right);
    scroller.scrollTop += step(gesture.y,pane.top,pane.bottom);
    if (left!==host.scrollLeft || top!==scroller.scrollTop) update();
    scrollFrame=requestAnimationFrame(autoScroll);
  }
  function finish(cancelled) {
    if (!gesture) return;
    const {active,id,before} = gesture;
    gesture = undefined;
    cancelAnimationFrame(scrollFrame);
    if (host.hasPointerCapture(id)) host.releasePointerCapture(id);
    frame.hidden = true;
    if (active && cancelled) { selected=before;paint(); }
    if (active && !cancelled) {
      suppressClick=true;
      setTimeout(()=>{suppressClick=false;},0);
      host.focus({preventScroll:true});
    }
  }
  host.addEventListener('pointerdown',(event)=>{
    const target=event.target;
    if (busy() || event.button!==0 || !event.isPrimary || !frame.parentElement
      || target.closest('.sequence-ruler,.sequence-cursor,.sequence-height-handle,.sequence-head,.sequence-edge')
      || !target.closest('.sequence-canvas')) return;
    const node=target.closest('.sequence-block');
    const additive=event.ctrlKey || event.metaKey || event.shiftKey;
    if (node && (node.draggable || node.closest('.sequence-layer')) && !additive) return;
    gesture={id:event.pointerId,start:point(event.clientX,event.clientY),initialX:event.clientX,initialY:event.clientY,
      x:event.clientX,y:event.clientY,before:new Set(selected),base:additive?new Set(selected):new Set(),active:false};
    if (node && additive) {event.stopPropagation();event.preventDefault();}
  },true);
  window.addEventListener('pointermove',(event)=>{
    if (gesture?.id!==event.pointerId) return;
    gesture.x=event.clientX;gesture.y=event.clientY;
    if (!gesture.active) {
      if (Math.hypot(gesture.x-gesture.initialX,gesture.y-gesture.initialY)<4) return;
      gesture.active=true;host.setPointerCapture(event.pointerId);
      scrollFrame=requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    update();
  },true);
  window.addEventListener('pointerup',(event)=>{if(gesture?.id===event.pointerId) {gesture.x=event.clientX;gesture.y=event.clientY;update();finish(false);}},true);
  host.addEventListener('pointercancel',()=>finish(true));
  window.addEventListener('blur',()=>finish(true));
  host.addEventListener('click',(event)=>{
    if (suppressClick) {event.preventDefault();event.stopPropagation();return;}
    const node=event.target.closest('[data-selectable]');
    if (!node) {
      if (event.target.closest('.sequence-content:not(.sequence-ruler .sequence-content)') && !event.target.closest('.sequence-block')) {selected.clear();paint();}
      return;
    }
    const key=entries.get(node).key;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (selected.has(key)) selected.delete(key);else selected.add(key);
      event.preventDefault();event.stopPropagation();
      host.focus({preventScroll:true});
    } else selected=new Set([key]);
    paint();
  },true);
  host.addEventListener('keydown',(event)=>{
    if (event.key==='Delete' && removeSelection()) {event.preventDefault();event.stopPropagation();}
    if (event.key==='Escape' && selected.size) {selected.clear();paint();event.preventDefault();}
  });
  return {bind,attach,removeSelection,get size(){return selected.size;},
    clear(){finish(true);selected.clear();paint();}};
};

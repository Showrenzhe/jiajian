'use strict';

// All positions are absolute seconds. Build the sorted list once per gesture.
function nearestTimelineAnchor(anchors, position, tolerance) {
  let left = 0, right = anchors.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (anchors[mid] < position) left = mid + 1;
    else right = mid;
  }
  const before = anchors[left - 1] ?? -Infinity, after = anchors[left] ?? Infinity;
  const nearest = position - before <= after - position ? before : after;
  return Math.abs(nearest - position) <= tolerance ? nearest : undefined;
}

// A move may align either edge within the available slot. Interior anchors
// must accommodate the full segment, including its original retained duration.
function snapTimelinePlacement(anchors, slotStart, slotSpan, length, leading, tolerance) {
  const slotEnd=slotStart+slotSpan, trailing=leading+length;
  const first=nearestTimelineAnchor(anchors,leading,tolerance);
  const last=nearestTimelineAnchor(anchors,trailing,tolerance);
  const epsilon=1e-7;
  if(first!==undefined && Math.abs(first-slotStart)<epsilon) return {start:slotStart,span:slotSpan,guide:slotStart};
  if(last!==undefined && Math.abs(last-slotEnd)<epsilon) return {start:slotStart,span:slotSpan,guide:slotEnd};
  const fitsStart=first!==undefined && first>=slotStart-epsilon && first+length<=slotEnd+epsilon;
  const fitsEnd=last!==undefined && last-length>=slotStart-epsilon && last<=slotEnd+epsilon;
  if(!fitsStart && !fitsEnd) return;
  const alignStart=fitsStart && (!fitsEnd || Math.abs(first-leading)<=Math.abs(last-trailing));
  return {start:Math.max(slotStart,alignStart ? first : last-length),span:length,guide:alignStart ? first : last};
}

const timelineSnapTools = {
  placement: snapTimelinePlacement,
  enabled: true,
  nearest: nearestTimelineAnchor,
  sorted: values => [...new Set(values.filter(Number.isFinite))].sort((a,b) => a-b),
};

function mountTimelineEditControls({ctx, dialog, time, duration, fps, seek, sourceSnap}) {
  const registry = window.editorCommands, labels = window.editorMessages.timelineEdits;
  const menu = document.getElementById('track-more-options');
  let inPoint, outPoint, selected, loop = false, ruler;
  const buttons = new Map();
  const marks = ctx.getTimelineMarkers;
  const active = () => marks().find(marker => marker.id === selected);
  function can(id) {
    if (ctx.busy()) return false;
    switch (id) {
      case 'timeline-snap': return true;
      case 'timeline-marker-rename':
      case 'timeline-marker-delete': return Boolean(active());
      case 'timeline-marker-prev':
      case 'timeline-marker-next': return Boolean(neighbor(id));
      case 'timeline-clear-in': return inPoint !== undefined;
      case 'timeline-clear-out': return outPoint !== undefined;
      case 'timeline-loop': return outPoint > inPoint && inPoint < duration();
      default: return duration() > 0;
    }
  }
  function button(id, parent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'secondary';
    button.textContent = id === 'timeline-snap' ? labels.snap : registry.get(id).title;
    button.addEventListener('click', () => {
      if (menu.matches(':popover-open')) menu.hidePopover();
      registry.execute(id, {target:button});
    });
    parent.append(button);
    buttons.set(id, button);
    return button;
  }
  const snap = button('timeline-snap', document.querySelector('.track-edit-actions'));
  snap.dataset.timelineSnap = '';
  const group = document.createElement('div');
  group.className = 'timeline-edit-commands';
  group.setAttribute('role','group');
  group.setAttribute('aria-label', labels.tools);
  for (const name of ['in','out','clear-in','clear-out','loop','marker-add','marker-prev','marker-next','marker-rename','marker-delete']) {
    button('timeline-' + name, group);
  }
  menu.append(group);
  function neighbor(id) {
    const next = id === 'timeline-marker-next';
    let best;
    for (const marker of marks()) {
      if (marker.time > duration() + 1e-7 || (next ? marker.time <= time()+1e-7 : marker.time >= time()-1e-7)) continue;
      if (!best || (next ? marker.time < best.time : marker.time > best.time)) best = marker;
    }
    return best;
  }
  function syncButtons() {
    for (const [id, button] of buttons) {
      button.disabled = !can(id);
      const keys = registry.labelFor(id);
      button.title = registry.get(id).title + (keys ? '（'+keys+'）' : '');
    }
    for (const button of document.querySelectorAll('[data-timeline-snap]')) {
      button.setAttribute('aria-pressed', String(window.timelineSnapping.enabled));
    }
    buttons.get('timeline-loop').setAttribute('aria-pressed', String(loop));
  }
  menu.addEventListener('beforetoggle', event => {if (event.newState === 'open') syncButtons();});
  window.addEventListener('cutshortcutschange',syncButtons);
  const overlay = document.createElement('div');
  overlay.className = 'timeline-ruler-edits';
  const rangeBand = document.createElement('div');
  rangeBand.dataset.timelineRange = '';
  overlay.append(rangeBand);
  let previousMarkers, previousDuration, previousSelection;
  const flags = new Map();
  function paint() {
    const current = marks();
    const extent = duration(), changed = current !== previousMarkers;
    if (changed) {
      const ids = new Set(current.map(marker => marker.id));
      for (const [id,flag] of flags) {
        if (!ids.has(id)) {flag.remove();flags.delete(id);}
      }
      for (const marker of current) {
        let flag = flags.get(marker.id);
        if (!flag) {
          flag = document.createElement('button');
          flag.type = 'button';
          flag.dataset.timelineMarker = marker.id;
          flag.addEventListener('click',() => jump(marker.id));
          flag.addEventListener('dblclick',() => registry.execute('timeline-marker-rename',{target:flag}));
          overlay.append(flag);
          flag.setAttribute('aria-pressed','false');
          flags.set(marker.id,flag);
        }
        flag.title = marker.name;
        flag.setAttribute('aria-label',marker.name);
        flag.style.setProperty('--mark-time',String(marker.time));
      }
      previousMarkers = current;
    }
    if (changed || extent !== previousDuration) {
      for (const marker of current) {
        const flag = flags.get(marker.id);
        flag.hidden = marker.time > extent+1e-7;
        flag.toggleAttribute('data-end',extent>0 && Math.abs(marker.time-extent)<1e-7);
      }
      previousDuration = extent;
    }
    if (changed || selected !== previousSelection) {
      flags.get(previousSelection)?.setAttribute('aria-pressed','false');
      flags.get(selected)?.setAttribute('aria-pressed','true');
      previousSelection = selected;
    }
    for (const [key,value] of [['in',inPoint],['out',outPoint]]) {
      if (value === undefined) delete rangeBand.dataset[key];
      else rangeBand.dataset[key] = String(value);
    }
    rangeBand.hidden = inPoint === undefined && outPoint === undefined;
    rangeBand.style.setProperty('--range-start', String(Math.min(inPoint ?? 0,duration())));
    rangeBand.style.setProperty('--range-end',String(Math.min(outPoint ?? duration(),duration())));
    syncButtons();
  }
  function jump(id) {
    const marker = marks().find(m => m.id === id);
    if (!marker || marker.time > duration()+1e-7) return false;
    selected = marker.id;
    seek(marker.time);
    paint();
    return true;
  }
  function rename() {
    const marker = active();
    const d = dialog(labels.rename);
    const field = document.createElement('input');
    field.type = 'text';
    field.required = true;
    field.maxLength = 100;
    field.value = marker.name;
    d.field(labels.name,field);
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'sequence-primary';
    save.textContent = labels.save;
    d.foot.append(save);
    d.form.addEventListener('submit',event => {
      event.preventDefault();
      if (ctx.setTimelineMarkers(marks().map(m => m.id === marker.id ? {...m,name:field.value} : m))) {
        paint();
        d.wrapper.close();
      }
    });
    d.wrapper.showModal();
    field.focus();
    field.select();
  }
  function run(id) {
    if (!can(id)) return false;
    const at = Math.min(duration(),Math.floor(time()*fps()+1e-5)/fps());
    switch (id) {
      case 'timeline-snap': window.timelineSnapping.enabled = !window.timelineSnapping.enabled; break;
      case 'timeline-in':
        inPoint = at;
        if (outPoint <= at) {outPoint = undefined;loop = false;}
        break;
      case 'timeline-out':
        outPoint = at;
        if (inPoint >= at) {inPoint = undefined;loop = false;}
        break;
      case 'timeline-clear-in': inPoint = undefined;loop = false;break;
      case 'timeline-clear-out': outPoint = undefined;loop = false;break;
      case 'timeline-loop': loop = !loop;break;
      case 'timeline-marker-add': {
        const marker = {id:crypto.randomUUID(), name:labels.marker(marks().length+1), time:at};
        if (!ctx.setTimelineMarkers([...marks(),marker])) return false;
        selected = marker.id;
        break;
      }
      case 'timeline-marker-rename': rename();return true;
      case 'timeline-marker-delete':
        if (!ctx.setTimelineMarkers(marks().filter(m => m.id !== selected))) return false;
        selected = undefined;
        break;
      case 'timeline-marker-prev':
      case 'timeline-marker-next': return jump(neighbor(id).id);
      default: return false;
    }
    paint();
    return true;
  }
  return {can,run,sourceSnap,snapEnabled:() => window.timelineSnapping.enabled,
    range:() => ({inPoint,outPoint,loop}),
    attach(node,scale) {
      ruler = node;
      ruler.style.setProperty('--timeline-second',scale+'px');
      ruler.append(overlay);
      paint();
    },
    scale(value) {ruler?.style.setProperty('--timeline-second',value+'px');},
    reset() {inPoint = outPoint = selected = undefined;loop = false;},
  };
}

if (typeof window !== 'undefined') {
  window.timelineSnapping = timelineSnapTools;
  window.mountTimelineEditControls = mountTimelineEditControls;
}
if (typeof module === 'object' && module.exports) module.exports = timelineSnapTools;

'use strict';

function candidateSourceSeconds(clip) {
  const retained = clip.ranges?.reduce((sum, range) => sum + range.end - range.start, 0) ?? (clip.end - clip.start);
  return Math.max(.1, retained - (clip.look?.head ?? 0) - (clip.look?.tail ?? 0)) / (clip.speed || 1);
}

window.candidatePlaybackSeconds = clip => clip.matchedDuration || candidateSourceSeconds(clip);

window.mountEditTimeline = function (host, ctx) {
  const waveforms=window.mountWaveforms(host);
  const voiceBlocks=new WeakMap();
  const voiceSettings=document.querySelector('#selected-voice-settings');
  const selection=window.mountTimelineSelection(host,{busy:ctx.busy,removed:ctx.afterRemove,changed(count) {
    voiceSettings.hidden=!voiceBlocks.has(selection.single());
    ctx.selectionChanged(count);
  }});
  function removeItem(list,item) {
    const at=list.indexOf(item);
    if(at>=0) list.splice(at,1);
  }
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const btn = (text, fn, title) => {
    const node = el('button', '', text);
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', fn);
    return node;
  };
  const choice = (pairs, value) => {
    const field = el('select');
    for (const [id, name] of pairs) field.add(new Option(name, id));
    if (value != null) field.value = value;
    return field;
  };
  const input = (type, value, min, max, step) => {
    const node = el('input');
    node.type = type;
    node.value = value ?? '';
    if (min != null) node.min = min;
    if (max != null) node.max = max;
    if (step != null) node.step = step;
    return node;
  };
  function dialog(title) {
    const wrapper = el('dialog', 'sequence-dialog');
    const form = el('form');
    const head = el('header');
    head.append(el('h2', '', title), btn('关闭', () => wrapper.close()));
    const body = el('div', 'sequence-fields'), foot = el('footer');
    const message = el('output', 'sequence-message');
    foot.append(message);
    form.append(head, body, foot);
    wrapper.append(form);
    document.body.append(wrapper);
    wrapper.addEventListener('close', () => window.afterDialogExit(wrapper), {once: true});
    function field(name, control) {
      const label = el('label');
      label.append(el('span', '', name), control);
      body.append(label);
      return label;
    }
    function save(fn) {
      const button = el('button', 'sequence-primary', '保存');
      button.type = 'submit';
      foot.append(button);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if(button.disabled) return;
        button.disabled=true;
        try { if(await fn()!==false) {wrapper.close(); ctx.change();} } catch(error) {message.textContent=error.message;}
        finally {button.disabled=false;}
      });
    }
    return {wrapper, form, field, body, foot, save, message};
  }
  let playTime = 0, fit = null, refreshFrame, lastState, lastKey;
  let cachedDraftDuration;
  let focusShot, focusClip, voiceTarget, shotDrag, refocusShot;
  let clipboard, pastePosition;
  let draggedCandidate, candidateLandings, resizeAfterCandidate=false;
  let libraryDrag;
  const candidateSlots=new WeakMap(), laneCells=new WeakMap();
  const candidateNodes=new WeakMap();
  const arrivalAnimations=new WeakMap();
  let cutReferences=[],materialWindows;
  const candidateMotion=matchMedia('(prefers-reduced-motion: no-preference) and (forced-colors: none)');
  const dropHint=el('div','candidate-drop-hint');
  dropHint.setAttribute('role','status');
  document.body.append(dropHint);
  const copySources=new WeakMap();
  let timeScale = 60, totalTime = 0, shotTimes = [], widths = [];
  let scrubBounds=[], layoutFocus, scrubWithDraftPlan=false;
  let headWidth;
  const standardScales = [16, 32, 60, 100, 180];
  let zoomScales = standardScales, manualScale = 60, zoomAnchor, zoomFrame, relayoutZoom;
  let filmstripTimer,filmstripFrame;
  function scalesAround(scale) {
    // Fit can be far outside the editing presets. Bridge the two with individual wheel stops.
    const scales=[...standardScales];
    while (scales[0] > scale / 1.5) scales.unshift(scales[0] / 2);
    while (scales.at(-1) < scale * 1.8) scales.push(scales.at(-1) * 1.8);
    const near=scales.findIndex(value=>Math.max(value/scale,scale/value)<1.15);
    if (near<0) scales.push(scale);
    else scales[near]=scale;
    return scales.sort((a,b)=>a-b);
  }
  const draftTransport=window.draftTimeline.transport(document.querySelector('.preview-stage'),{
    musicBus:ctx.musicBus, musicError:()=>ctx.narrationStatus(window.editorMessages.musicMix.playbackFailed),
    previewSource:ctx.previewSource, handoff:ctx.previewHandoff, getRange:()=>editControls.range(),
    tick:(time)=>{playTime=time;syncCursor();ctx.draftTick?.();}, changed:(playing)=>ctx.draftPlaybackChanged?.(playing),
  });
  let confirmedDraftSpeed, choosingDraftSpeed=false;
  function draftPlan(report,pauseJobs) {
    const state=ctx.state(), focus=focusClip ?? state.selected;
    if(confirmedDraftSpeed && confirmedDraftSpeed.key===lastKey && confirmedDraftSpeed.focus===focus
        && confirmedDraftSpeed.min===state.autoSpeedRange.min && confirmedDraftSpeed.max===state.autoSpeedRange.max) {
      state.draftSpeedChoices=confirmedDraftSpeed.choices;
    }
    state.onSpeedChallenge=report;
    state.pauseJobs=pauseJobs;
    const layout=window.draftTimeline.timing(state,clipSpan,ctx.asset,focus);
    return window.draftTimeline.makePlan(state,layout,ctx.asset,window.waveformSource,focus);
  }
  let playbackRequest=0, waitingForNarration=false;
  function cancelNarrationPlayback() {
    ++playbackRequest;
    if (!waitingForNarration) return false;
    waitingForNarration=false;
    ctx.narrationStatus('');
    return true;
  }
  async function toggleDraftPlayback(direction) {
    if (cancelNarrationPlayback() && direction==null) return;
    const request=playbackRequest;
    if(direction===0) {draftTransport.pause();return;}
    if(draftTransport.playing()) {
      if(direction) draftTransport.shuttle(direction);
      else draftTransport.pause();
      return;
    }
    if(choosingDraftSpeed) return;
    const issues=new Map();
    const jobs=new Set();
    const report=issue=>{
      const previous=issues.get(issue.key), count=(previous?.count ?? 0)+1;
      const extreme=!previous || (issue.direction==='high' ? issue.required>previous.required : issue.required<previous.required);
      issues.set(issue.key,{...(extreme ? issue : previous),count});
    };
    let proposed=draftPlan(report,jobs);
    if (jobs.size) {
      const key=lastKey, focus=focusClip;
      waitingForNarration=true;
      ctx.narrationStatus(proposed.some(entry=>entry.smartMusic) ? window.editorMessages.musicMix.preparing : window.editorMessages.narrationTrim.measuring);
      const ready=await Promise.all(jobs);
      if (request!==playbackRequest) return;
      waitingForNarration=false;
      ctx.narrationStatus('');
      if (key!==lastKey || focus!==focusClip || ctx.busy()) return;
      if (ready.includes(false)) {ctx.narrationStatus(window.editorMessages.narrationTrim.unavailable);return;}
      issues.clear();
      proposed=draftPlan(report);
    }
    if(!issues.size) {draftTransport.toggle(proposed,playTime,direction);return;}
    const key=lastKey, focus=focusClip ?? ctx.state().selected, limits=window.videoSpeedControls.range;
    choosingDraftSpeed=true;
    try {
      const choices=await window.videoSpeedControls.collectChoices(issues.values(),limits);
      if(!choices || key!==lastKey || focus!==(focusClip ?? ctx.state().selected)) return;
      confirmedDraftSpeed={key,focus,...limits,choices};
      draftTransport.toggle(draftPlan(),playTime,direction);
    } finally {choosingDraftSpeed=false;}
  }
  function draftDuration() {
    cachedDraftDuration ??= draftPlan().reduce((max,entry)=>Math.max(max,entry.end),0);
    return cachedDraftDuration;
  }
  const folded = new Set();
  const heights = new Map();
  const cursor=el('i','sequence-cursor');
  const cursorClock=el('span','sequence-cursor-clock');
  cursorClock.setAttribute('aria-hidden','true');
  cursor.append(cursorClock);
  let scrubPointer, scrubX, scrubFrame, activeSeek;
  let resizeDrag,layerDrag;
  let locatedMaterial, snapGeometry = [];
  // Draw a single scanline stretched over the visible tracks. Crossing a snap
  // boundary then touches pixels only, even with a software compositor.
  const snapPanel=host.closest('#timeline-tracks-panel');
  const snapGuide=el('canvas','timeline-snap-overlay');
  snapGuide.setAttribute('aria-hidden','true');
  snapGuide.width=snapGuide.height=1;
  document.body.append(snapGuide);
  const guideInk=snapGuide.getContext('2d');
  let guideTimer, guideFrame, guideTime, guideColumn, guideWidth, guideColor, guideBox;
  function clearGuide() {
    if(guideColumn!==undefined) guideInk.clearRect(guideColumn-1,0,guideWidth+2,1);
    guideColumn=undefined;
  }
  function paintGuide() {
    if(guideTime===undefined) return;
    const area=host.getBoundingClientRect(), panel=snapPanel.getBoundingClientRect();
    const origin=area.left+host.clientLeft, panelLeft=panel.left+snapPanel.clientLeft;
    const left=Math.max(0,origin+headWidth,panelLeft);
    const top=Math.max(0,area.top+host.clientTop,panel.top+snapPanel.clientTop);
    const right=Math.min(innerWidth,origin+host.clientWidth,panelLeft+snapPanel.clientWidth);
    const bottom=Math.min(innerHeight,area.bottom,panel.top+snapPanel.clientTop+snapPanel.clientHeight);
    const width=right-left,height=bottom-top;
    const x=origin+headWidth+guideTime*timeScale-host.scrollLeft-left;
    if(width<=0 || height<=0 || x<0 || x>width) {clearGuide();return;}
    const ratio=devicePixelRatio, box=[left,top,width,height,ratio].join(',');
    if(box!==guideBox) {
      guideBox=box;
      snapGuide.width=Math.ceil(width*ratio);
      snapGuide.style.cssText='left:'+left+'px;top:'+top+'px;width:'+width+'px;height:'+height+'px';
      guideWidth=Math.max(1,Math.round(2*ratio));
      guideColor=getComputedStyle(snapGuide).color;
      guideColumn=undefined;
    }
    const column=Math.min(snapGuide.width-1,Math.round(x*snapGuide.width/width));
    if(column===guideColumn) return;
    clearGuide();
    guideColumn=column;
    guideInk.fillStyle='rgba(60,46,0,.45)';
    guideInk.fillRect(column-1,0,guideWidth+2,1);
    guideInk.fillStyle=guideColor;
    guideInk.fillRect(column,0,guideWidth,1);
  }
  function showSnap(at,flash=false) {
    if(at===guideTime && !flash && guideTimer===undefined) return;
    if(guideTimer!==undefined) {clearTimeout(guideTimer);guideTimer=undefined;}
    guideTime=at;
    if(at===undefined) clearGuide(); else paintGuide();
    if(flash) guideTimer=setTimeout(()=>{guideTimer=undefined;showSnap();},320);
  }
  function dismissSnap() {
    cancelAnimationFrame(guideFrame);
    guideFrame=undefined;
    showSnap();
  }
  function flashSplit(at) {
    dismissSnap();
    if(at===undefined) return;
    // The pending timeline draw clears the old guide before painting this cut.
    guideFrame=requestAnimationFrame(()=>{guideFrame=undefined;showSnap(at,true);});
  }
  window.addEventListener('scroll',paintGuide,{capture:true,passive:true});
  window.addEventListener('resize',paintGuide);
  matchMedia('(forced-colors: active)').addEventListener('change',()=>{guideBox=undefined;paintGuide();});
  document.addEventListener('fullscreenchange',dismissSnap);
  function snapAnchors(exclude) {
    const times=[...shotTimes,0,totalTime,playTime];
    for(const marker of ctx.getTimelineMarkers()) if(marker.time<=totalTime) times.push(marker.time);
    for(const part of snapGeometry) if(part.node!==exclude) times.push(part.from,part.from+part.duration);
    return window.timelineSnapping.sorted(times);
  }
  const editControls=window.mountTimelineEditControls({
    ctx,dialog,time:()=>playTime,duration:()=>totalTime,fps:()=>lastState?.fps || 30,
    seek(time) {
      ctx.pause();
      const left=time*timeScale, visible=host.clientWidth-headWidth;
      if(left<host.scrollLeft || left>host.scrollLeft+visible) host.scrollLeft=Math.max(0,left-visible/2);
      scrubTime(time);
    },
    sourceSnap(clip) {
      const state=ctx.state(), index=state.shots.findIndex(shot=>shot.includes(clip));
      if(index<0 || shotTimes[index]===undefined) return [];
      const start=clip.videoStart ?? shotTimes[index], span=window.pictureSpan(clip,widths[index]);
      return snapAnchors(candidateNodes.get(clip)).filter(at=>at>=start && at<=start+span).map(at=>at-start);
    },
  });
  function matchTime(anchors,at,alt) {
    return !alt && window.timelineSnapping.enabled ? window.timelineSnapping.nearest(anchors,at,6/timeScale) : undefined;
  }
  const blocksBySource = new Map();
  const thumbQueue=[];
  let thumbWorkers=0;
  function loadVisibleFrames() {
    while(thumbWorkers<3 && thumbQueue.length) {
      const node=thumbQueue.shift();
      if(!node.isConnected) continue;
      thumbWorkers++;
      ctx.thumbnail(node.dataset.thumb,Number(node.dataset.time)).then((url)=>{if(url && node.isConnected) node.src=url;})
        .catch(()=>{}).finally(()=>{thumbWorkers--;loadVisibleFrames();});
    }
  }
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const {target, isIntersecting} of entries) {
      if (!isIntersecting) continue;
      thumbObserver.unobserve(target);
      thumbQueue.push(target);
    }
    loadVisibleFrames();
  }, {root: host, rootMargin: '80px'});
  const clipSpan = window.candidatePlaybackSeconds;
  function holdsPicture(clip,index) {
    return clip.videoFit==='hold' || window.soloLaneSequence(lastState.shots[index],clip,lastState.trackControls,widths[index]).length>0;
  }
  function pictureClockSpan(clip,index) {
    if(holdsPicture(clip,index)) return candidateSourceSeconds(clip);
    const hasVoice=lastState.segmented ? lastState.segments[index]?.some(Boolean) : lastState.whole.some(item=>item.asset);
    return window.usesPlacedVideoSource(clip,lastState.priority==='voice' && hasVoice) ? clipSpan(clip) : widths[index];
  }
  const stamp = (s) => [Math.floor(s / 60), String(Math.floor(s % 60)).padStart(2, '0')].join(':');
  const summary = (s) => String(Number(s.toFixed(2))) + ' 秒';
  function icon(id) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    const use=document.createElementNS(svg.namespaceURI,'use');
    svg.setAttribute('class','ui-icon');
    svg.setAttribute('aria-hidden','true');
    use.setAttribute('href','#icon-'+id);
    svg.append(use);
    return svg;
  }
  function clipHeader(name,kind,sourceSeconds,detail,muted=false,speed) {
    const label=el('span','sequence-clip-label');
    if(muted && kind==='video') label.append(icon('track-mute'));
    label.append(el('span','sequence-clip-name',name));
    if(kind!=='video') {
      label.append(el('span','sequence-clip-duration',detail));
      return label;
    }
    const header=el('span','sequence-clip-header');
    const duration=Number.isFinite(sourceSeconds) ? sourceSeconds.toFixed(2)+' 秒' : '—';
    const badge=el('span','sequence-clip-duration sequence-source-duration',duration);
    badge.title='原片时长 '+duration;
    if(speed!==undefined) {
      const extreme=speed>2 || speed<.5;
      badge.dataset.speedBadge=(extreme ? '⚠ ' : '')+window.videoSpeedControls.rateLabel(speed);
      badge.toggleAttribute('data-extreme',extreme);
    }
    header.append(label,badge);
    return header;
  }
  const kinds = {text:'文字', pip:'画中画', sticker:'贴纸', sound:'音效'};
  function within(row, i) {
    while (row.length <= i) row.push([]);
    return row[i];
  }
  function targets(s, shotIndex, clip, voice) {
    const p = s.pack;
    const list = [];
    const add = (key, label, items, ensure, offset = 0, span = totalTime) =>
      list.push({key, label, items: items ?? [], ensure, offset, span});
    add('global', '全局轨道', p.global, () => p.global);
    p.composites.forEach((items,i) => add('comp'+i,'复合组 '+(i+1),items,()=>items));
    if (p.composites.length < 50) add('compNew','＋ 新建复合组',[],()=>within(p.composites,p.composites.length));
    const col = p.textMode === 'whole' ? 0 : Math.max(0,shotIndex);
    const groupLabel = p.textMode === 'whole' ? '整段文字组' : '分段文字组';
    const offset = p.textMode === 'whole' ? 0 : shotTimes[col] || 0;
    const span = p.textMode === 'whole' ? totalTime : widths[col];
    if (p.textMode === 'whole' || shotIndex >= 0) {
      p.textGroups.forEach((row,i)=>add('text'+i,groupLabel+' '+(i+1),row[col],()=>within(row,col),offset,span));
      if (p.textGroups.length < 250) add('textNew','＋ 新建'+groupLabel,[],()=>within(within(p.textGroups,p.textGroups.length),col),offset,span);
    }
    if (clip && s.shots[shotIndex]?.includes(clip)) add('local','当前候选 · '+clip.asset.name,clip.layers,()=>clip.layers ??= [],clip.videoStart ?? shotTimes[shotIndex],clipSpan(clip));
    if (voice?.asset) {
      const seg = voice.shot != null;
      const vi = s.shots.indexOf(voice.shot), ri = voice.row;
      if ((!seg && s.whole[ri]?.asset === voice.asset) || (seg && vi >= 0 && s.segments[vi]?.[ri] === voice.asset)) {
        add('voice','当前口播 · '+voice.asset.name,seg ? p.segmentNarration[vi]?.[ri] : p.wholeNarration[ri],
          ()=>seg ? within(within(p.segmentNarration,vi),ri) : within(p.wholeNarration,ri),seg ? shotTimes[vi] : 0,voice.asset.duration);
      }
    }
    return list;
  }
  function editLayer(initialTarget, existing, splitAtPlayhead, focusSpeed=false) {
    if (ctx.busy()) return;
    const s = ctx.state();
    if (!host.clientWidth) {
      // Card view can edit a candidate before the timeline has drawn its shot positions.
      ({widths,starts:shotTimes,total:totalTime}=window.draftTimeline.timing(s,clipSpan,ctx.asset,focusClip));
    }
    const ti = s.shots.indexOf(focusShot);
    const available=targets(s,ti,focusClip,voiceTarget);
    const groups = existing ? [initialTarget,...available.filter((g)=>g.key!==initialTarget.key && (existing.kind==='text' || !g.key.startsWith('text')))] : available;
    const selectedKey = initialTarget.key;
    const d = dialog(existing ? '编辑包装片段' : '添加包装片段');
    const scope = choice(groups.map((g)=>[g.key,g.label]), groups.some((g)=>g.key===selectedKey) ? selectedKey : 'global');
    const type = choice(Object.entries(kinds), existing?.kind ?? initialTarget.kind ?? 'text');
    const content = el('textarea'); content.maxLength = 4096; content.value = existing?.text ?? '';
    const begin = input('number',existing?.start ?? 0,0,null,.001), end = input('number',existing?.end,0,null,.001);
    end.placeholder = '随所属轨道结束';
    const x = input('number',(existing?.x ?? .5)*100,0,100,.1), y = input('number',(existing?.y ?? .5)*100,0,100,.1);
    const scale = input('number',(existing?.scale ?? (type.value === 'text' ? 1 : .35))*100,5,100,.1);
    const speed = input('number',existing?.speed ?? 1,.5,3,'any');
    const volume = input('number',existing?.volume ?? (type.value === 'pip' ? 0 : 100),0,100,1);
    const font = input('number',existing?.fontSize ?? 48,1,600,1), color = input('color',existing?.color ?? '#ffffff');
    let media = existing?.id ? ctx.asset(existing.id) : null;
    let motion = {};
    let look = existing?.look;
    const chooseAsset = btn(media?.name ?? '选择文件', async () => {
      await ctx.pick(type.value === 'sound' ? 'audio' : 'visual', (asset) => {
        if (type.value === 'sticker' && asset.kind !== 'image') {d.message.textContent='贴纸请选择图片。'; return;}
        media=asset; chooseAsset.textContent=asset.name; d.message.textContent='';
      });
    });
    d.field('所属轨道',scope); d.field('类型',type);
    const words = d.field('文字',content), file = d.field('素材',chooseAsset);
    const removeBackdrop = d.field('前景', btn('AI 前景抠像', async () => {
      if (!media) { d.message.textContent='请先选择画中画素材。'; return; }
      const result = await ctx.cutout(media);
      if (result) { media = result; chooseAsset.textContent = result.name; d.message.textContent='已生成透明前景。'; }
    }));
    d.field('入点（秒）',begin); d.field('出点（秒）',end);
    const visuals=[d.field('水平位置（%）',x),d.field('垂直位置（%）',y),d.field('缩放（%）',scale)];
    const fontFields=[d.field('字号',font),d.field('颜色',color)];
    const textStyles=window.createTextPresets(existing?.textStyle,{fontSize:font,color,x,y,scale,text:content});
    d.body.append(textStyles.element); fontFields.push(textStyles.element);
    const sound=d.field('音量（%）',volume);
    const speedControl=d.field('播放速度（倍）',speed);
    let previousSpeed=speed.valueAsNumber;
    speed.addEventListener('change',()=>{
      const value=speed.valueAsNumber;
      if(!speed.checkValidity() || !Number.isFinite(value)) return;
      if(end.value && end.valueAsNumber>begin.valueAsNumber) {
        const duration=(end.valueAsNumber-begin.valueAsNumber)*previousSpeed/value;
        end.value=String(Math.round((begin.valueAsNumber+duration)*1000)/1000);
      }
      previousSpeed=value;
    });
    const motionButton=btn('调整关键帧',async()=>{
      const layer=await window.editLayerMotion({...existing,...motion,kind:type.value,text:content.value,textStyle:textStyles.read(),fontSize:font.valueAsNumber,color:color.value,x:x.valueAsNumber/100,y:y.valueAsNumber/100,scale:scale.valueAsNumber/100,start:begin.valueAsNumber,end:end.value ? end.valueAsNumber : null}, {url:media?.url,kind:media?.kind,duration:media?.duration || groups.find((g)=>g.key===scope.value)?.span || 3});
      if (layer) {
        motion={opacity:layer.opacity,rotation:layer.rotation,keyframes:layer.keyframes};
        x.value=layer.x*100; y.value=layer.y*100; scale.value=layer.scale*100;
      }
    });
    visuals.push(d.field('动画与变换',motionButton));
    const appearance=d.field('画面处理',btn('调色 / 滤镜 / 特效',()=>{
      if(!media){d.message.textContent='请先选择画中画素材。';return;}
      ctx.layerAppearance(media,look,(value)=>{look=value;});
    }));
    function setKind() {
      if (scope.value.startsWith('text')) type.value='text';
      type.disabled=!!existing || scope.value.startsWith('text');
      const text=type.value==='text', audio=type.value==='sound';
      words.hidden=!text; content.required=text; file.hidden=text; sound.hidden=!(audio || type.value==='pip');
      speedControl.hidden=!audio;speed.disabled=!audio;speed.required=audio;
      removeBackdrop.hidden = type.value !== 'pip';
      appearance.hidden=type.value!=='pip';
      for (const f of visuals) f.hidden=audio;
      for (const f of fontFields) f.hidden=!text;
    }
    type.onchange=()=>{speed.value='1';previousSpeed=1;media=null; chooseAsset.textContent='选择文件'; scale.value=type.value==='text' ? 100 : 35; volume.value=type.value==='pip' ? 0 : 100; setKind();};
    scope.onchange=setKind; setKind();
    if (existing) {
      if(splitAtPlayhead) d.foot.append(splitAtPlayhead(d));
      d.foot.append(btn('移除片段',()=>{initialTarget.items.splice(initialTarget.items.indexOf(existing),1); d.wrapper.close(); ctx.change();}));
    }
    d.save(()=>{
      const target=groups.find((g)=>g.key===scope.value), kind=type.value;
      const start=begin.valueAsNumber, stop=end.value ? end.valueAsNumber : null;
      if (!Number.isFinite(start) || (stop != null && stop<=start)) throw Error('出点须晚于入点。');
      if (kind!=='text' && !media) throw Error('请选择素材文件。');
      if (kind==='text' && !content.value.trim()) throw Error('请输入文字。');
      const max=target.key.startsWith('comp') ? ({text:3,pip:3,sticker:2,sound:2})[kind] : target.key.startsWith('text') ? 8 : target.key==='global' ? 10 : 1000;
      if ((!existing || target!==initialTarget) && new Set(target.items.filter((item)=>item.kind===kind).map((item)=>item.laneId ?? item)).size>=max) throw Error('该组此类轨道已达 '+max+' 条。');
      const layer={...existing,...motion,kind,start,end:stop};
      if(kind==='pip'&&look)layer.look=look;
      if (kind==='text') Object.assign(layer,{text:content.value.trim(),fontSize:font.valueAsNumber,color:color.value,textStyle:textStyles.read()});
      else layer.id=media.id;
      if (kind!=='sound') Object.assign(layer,{x:x.valueAsNumber/100,y:y.valueAsNumber/100,scale:scale.valueAsNumber/100});
      if (kind==='sound') layer.speed=speed.valueAsNumber;
      if (kind==='sound' || kind==='pip') layer.volume=volume.valueAsNumber;
      const items=target.ensure();
      if (existing && target===initialTarget) items.splice(items.indexOf(existing),1,layer);
      else {
        if(existing) initialTarget.items.splice(initialTarget.items.indexOf(existing),1);
        items.push(layer);
      }
    });
    d.wrapper.showModal();
    if(focusSpeed) speed.focus();
  }
  function positionAt(time) {
    const at=Math.max(0,Math.min(totalTime,time));
    return {time:at,index:Math.max(0,shotTimes.findLastIndex(start=>start<=at))};
  }
  function scaleForWidth(contentWidth) {
    const fitted=Math.max(.002,(contentWidth-6)/totalTime);
    return fit===false ? manualScale : fit===true ? fitted : Math.max(60,Math.min(180,fitted));
  }
  function bindCopy(node,kind,snapshot) {
    copySources.set(node,{kind,snapshot});
    node.setAttribute('aria-keyshortcuts','Control+C Control+V');
    if(kind==='字幕') node.title+=' · 选中后 Ctrl+C 复制、Delete 删除，轨道左侧可隐藏字幕';
  }
  function copyItem(node) {
    const entry=copySources.get(node);
    if (!entry) {ctx.notify('请选择一个视频、口播或字幕片段。');return;}
    clipboard={kind:entry.kind,data:entry.snapshot()};
    ctx.notify('已复制'+entry.kind+'。');
  }
  async function pasteItem(position=pastePosition ?? positionAt(playTime)) {
    if (!clipboard || ctx.busy()) return;
    const s=ctx.state(),shot=s.shots[position.index];
    try {
      const destination=clipboard.kind==='字幕'?'pasted-captions':clipboard.kind==='视频' && position.videoLane!==undefined ? 'vis'+position.videoLane : undefined;
      if(s.trackControls?.[destination]?.locked) throw Error('目标轨道已锁定，请先解锁。');
      if(clipboard.kind==='视频') {
        const clip=ctx.pasteClip(clipboard.data);
        if(shot) {
          if(!await ctx.placeCandidate(clip,shot,undefined,undefined,position.videoLane,undefined,undefined,undefined,position.videoSlot)) return;
        } else {
          if(position.videoLane>0) clip.videoLane=position.videoLane;
          if(!ctx.insertShot(s.shots.length,[clip])) throw Error('已达到分镜上限或此处无法插入。');
        }
        ctx.preview(clip);
        selection.selectOnly(clip);
        ctx.notify('已粘贴至分镜 '+(shot ? position.index+1 : s.shots.length)+'。');
        return;
      } else if(clipboard.kind==='口播') {
        const row=ctx.pasteVoice(clipboard.data,shot,position.row);
        ctx.notify('已粘贴至'+(s.segmented ? '分镜 '+(position.index+1)+' · ' : '')+'口播轨 '+(row+1)+'。');
        return;
      } else {
        if(s.timelineCaptions.length>=2000) throw Error('时间轴字幕最多支持 2000 句。');
        const {duration,...cue}=structuredClone(clipboard.data);
        const start=Math.round(position.time*1000);
        if(position.time>=totalTime) throw Error('请将播放头移到时间轴结束前。');
        s.timelineCaptions.push({...cue,start,end:start+duration});
        ctx.change();
      }
      ctx.notify('已粘贴'+clipboard.kind+'。');
    } catch(error) {ctx.notify(error.message);}
  }
  const registry = window.editorCommands;
  function copyNode(context) {
    return context?.node ?? selection.single();
  }
  registry.bind('timeline-copy',{
    titleFor:context => registry.get('timeline-copy').title + (copySources.get(copyNode(context))?.kind ?? ''),
    when:context => !ctx.busy() && host.clientWidth > 0 && (context?.source === 'keyboard' || copySources.has(copyNode(context))),
    run:context => copyItem(copyNode(context)),
  });
  registry.bind('timeline-paste',{
    titleFor:() => registry.get('timeline-paste').title + (clipboard?.kind ?? ''),
    when:() => !ctx.busy() && host.clientWidth > 0 && Boolean(clipboard),
    run:context => pasteItem(context?.position),
  });
  function clipboardButtons(d,node,position) {
    for (const id of ['timeline-copy','timeline-paste']) {
      const command=registry.get(id), context={node,position};
      const enabled=command.when(context);
      if (!enabled && id === 'timeline-copy') continue;
      const title=command.titleFor(context);
      const button=btn(title,()=>{d.wrapper.close();registry.execute(id,context);});
      presentEditorCommand(button,id,{title});
      button.disabled=!enabled;
      d.body.append(button);
    }
  }
  function speedField(d,current,apply) {
    const field=input('number',current,.5,3,'any');
    field.required=true;
    d.field('播放速度（倍）',field);
    d.save(()=>{const value=field.valueAsNumber;if(!(value>=.5 && value<=3)) throw Error('请输入 0.5 到 3 之间的倍速。');apply(value);});
  }
  function openVoiceSettings(voice) {
    if(!voice || ctx.busy()) return;
    const {asset,shot,row}=voice;
    const d=dialog('口播 · '+asset.name);
    speedField(d,ctx.state().voiceSpeed(asset,shot,row),value=>ctx.setVoiceSpeed(asset,shot,row,value));
    d.body.append(btn('口播包装',()=>{
      d.wrapper.close();
      voiceTarget=voice;focusShot=shot;focusClip=undefined;
      editLayer({key:'voice'});
    }));
    d.wrapper.showModal();
  }
  voiceSettings.addEventListener('click',()=>openVoiceSettings(voiceBlocks.get(selection.single())));
  function matchDurationButton(d,state,index,clip) {
    if (!state.segmented) return;
    const shot=state.shots[index], target=ctx.segmentVoiceMatchTarget(state,index);
    const action=btn(clip ? '匹配口播时长' : '匹配本分镜全部候选',()=>{
      d.wrapper.close();
      ctx.matchNarrationDuration(shot,clip);
    });
    action.disabled=ctx.busy() || !target || !shot?.length;
    const hint=!target ? '本分镜还没有分段口播' : !shot?.length ? '本分镜还没有候选素材'
      : `口播轨 ${target.row+1} · 目标 ${target.seconds.toFixed(2)} 秒`;
    d.body.append(action,el('small','muted',hint));
  }
  function openCardMatchMenu(shot,clip) {
    const state=ctx.state(), index=state.shots.indexOf(shot);
    if (!state.segmented || index<0 || ctx.busy()) return;
    const d=dialog(clip ? '候选 · '+clip.asset.name : '分镜 '+(index+1));
    matchDurationButton(d,state,index,clip);
    d.wrapper.showModal();
  }
  function addCandidateLayer(shot, clip, kind) {
    focusShot=shot; focusClip=clip; voiceTarget=undefined;
    editLayer({key:'local', kind});
  }
  function openCandidateActions(shot,clip) {
    const state=ctx.state(), index=state.shots.indexOf(shot);
    if (ctx.busy() || index<0 || !shot.includes(clip)) return;
    const lane=window.candidateVideoLanes(shot)[shot.indexOf(clip)];
    if (state.trackControls?.['vis'+lane]?.locked) return;
    focusShot=shot;focusClip=clip;voiceTarget=undefined;
    const d=dialog('候选 · '+clip.asset.name);
    matchDurationButton(d,state,index,clip);
    if (host.clientWidth) clipboardButtons(d,candidateNodes.get(clip),{index,time:clip.videoStart ?? shotTimes[index]});
    d.body.append(btn(clip.enabled===false ? '参与混剪' : '排除此候选',()=>{ctx.toggleClip(clip);d.wrapper.close();}),
      btn('候选包装',()=>{d.wrapper.close();editLayer({key:'local'});}),
      btn('变换、蒙版与关键帧',()=>{d.wrapper.close();ctx.editCandidateMotion(clip);}),
      btn('AI 前景抠像',()=>{d.wrapper.close();ctx.cutoutCandidate(clip);}),
      btn('截取封面帧',()=>{d.wrapper.close();ctx.captureCover(clip);}),
      btn('画面处理 · 调色 / 滤镜 / 特效',()=>{d.wrapper.close();ctx.appearance(clip);}));
    if(clip.asset.kind==='video') d.body.append(btn('裁剪素材',()=>{d.wrapper.close();ctx.cut(clip);}),btn('AI 拆分',()=>{d.wrapper.close();ctx.scenes(clip.asset);}),
      btn('自动切片',()=>{d.wrapper.close();ctx.slices(clip.asset);}),btn('视频字幕',()=>{d.wrapper.close();ctx.captions(clip);}));
    d.wrapper.showModal();
  }
  const videoMenu=document.querySelector('#video-track-menu');
  const videoItems=[...videoMenu.children];
  const videoMenuLabel=videoMenu.getAttribute('aria-label');
  const clipMenus=new WeakMap(), itemActions=new WeakMap();
  const menuText=window.editorMessages.timelineMenu;
  const menuCommands={mute:'mute-video', delete:'delete-selection', left:'insert-shot-left', right:'insert-shot-right'};
  const contextHint=el('div','timeline-context-hint');
  contextHint.setAttribute('role','status');
  document.body.append(contextHint);
  let menuCell,keyboardCell,hintTimer;
  function clearContextHint() {
    if(hintTimer===undefined) return;
    clearTimeout(hintTimer);
    hintTimer=undefined;
    contextHint.textContent='';
  }
  function bindClipMenu(cell,actions) {
    clipMenus.set(cell,actions);
    cell.setAttribute('aria-haspopup','menu');
    const shortcuts=cell.getAttribute('aria-keyshortcuts');
    cell.setAttribute('aria-keyshortcuts',shortcuts ? shortcuts+' Shift+F10' : 'Shift+F10');
  }
  function closeVideoMenu() {
    if(videoMenu.matches(':popover-open')) videoMenu.hidePopover();
  }
  videoMenu.addEventListener('toggle',()=>{if(!videoMenu.matches(':popover-open')) menuCell?.removeAttribute('data-menu-anchor');});
  function setVideoItems(slot) {
    const state=ctx.state();
    const index=state.shots.indexOf(slot.shot);
    if(index<0 || !slot.shot.includes(slot.clip)) return false;
    videoMenu.replaceChildren(...videoItems);
    videoMenu.setAttribute('aria-label',videoMenuLabel);
    for(const button of videoMenu.querySelectorAll('button')) {
      const action=button.dataset.action;
      const id=menuCommands[action];
      const title=action==='mute' && slot.clip.sourceMuted ? window.editorMessages.commandTitles['unmute-video'] : window.editorCommands.get(id).title;
      presentEditorCommand(button,id,{title,visible:true});
      button.dataset.menuKey=window.editorCommands.keysFor(id)[0];
      const insert=action==='left' || action==='right';
      if(action==='mute') {
        button.querySelector('use').setAttribute('href',slot.clip?.sourceMuted ? '#icon-track-sound' : '#icon-track-mute');
      }
      const reason=action==='mute' && (slot.clip.asset.kind!=='video' || !slot.clip.asset.hasAudio) ? '这个片段没有原声音轨。'
        : insert ? ctx.insertShotError(index+(action==='right' ? 1 : 0)) : '';
      button.disabled=Boolean(reason);
      if(reason) button.title=reason;
    }
    return true;
  }
  function setClipItems(cell,entry,x,alt) {
    videoMenu.replaceChildren();
    videoMenu.setAttribute('aria-label',menuText.label);
    function add(action,id,image,run) {
      const button=el('button');
      button.type='button';
      button.setAttribute('role','menuitem');
      button.dataset.action=action;
      button.append(icon(image),el('span','',registry.get(id).title));
      presentEditorCommand(button,id);
      const key=registry.keysFor(id)[0];
      if(key) button.dataset.menuKey=key;
      itemActions.set(button,()=>registry.execute(id,{timelineSelection:true, cell, menuAction:run}));
      videoMenu.append(button);
      return button;
    }
    add('delete','delete-selection','track-delete');
    const mute=cell.closest('.sequence-row').querySelector('.sequence-head [data-track-action="muted"]');
    if(mute) {
      const muted=mute.getAttribute('aria-pressed')==='true';
      add('mute',muted ? 'track-unmute' : 'track-mute',muted ? 'track-sound' : 'track-mute',()=>{
        mute.click();
        selection.single()?.focus({preventScroll:true});
      });
    }
    if(entry.speed) add('speed','clip-speed','settings',entry.speed);
    if(entry.split) {
      const split=entry.split(x,alt);
      add('split','split-here','scene',split.run).disabled=!split.enabled;
    }
    if(entry.edit) add('edit','edit-track-clip','settings',entry.edit);
  }
  for (const id of ['track-mute','track-unmute','clip-speed','split-here','edit-track-clip']) {
    window.editorCommands.bind(id,{palette:false, when:context => !ctx.busy() && context?.cell?.isConnected &&
      !context.cell.closest('[data-track-locked]') && typeof context.menuAction === 'function', run:context => context.menuAction()});
  }
  function showCellMenu(cell,x,y,alt=false) {
    clearContextHint();
    contextHint.textContent='';
    closeVideoMenu();
    if(!cell || ctx.busy() || cell.closest('[data-track-locked]')) return;
    const slot=candidateSlots.get(cell), entry=clipMenus.get(cell);
    if(entry) setClipItems(cell,entry,x,alt);
    else if(slot?.clip) {
      if(!setVideoItems(slot)) return;
    } else {
      if(cell.ondblclick) {
        selection.selectNode(cell);
        cell.focus({preventScroll:true});
        contextHint.textContent=menuText.doubleClick;
        hintTimer=setTimeout(clearContextHint,2200);
      }
      return;
    }
    menuCell?.removeAttribute('data-menu-anchor');
    menuCell=keyboardCell=cell;
    cell.dataset.menuAnchor='';
    selection.selectNode(cell);
    cell.focus({preventScroll:true});
    const fromPointer=x!==undefined;
    videoMenu.toggleAttribute('data-pointer-open',fromPointer);
    videoMenu.showPopover();
    const bounds=cell.getBoundingClientRect();
    x ??= bounds.left;
    y ??= bounds.bottom;
    const width=videoMenu.offsetWidth,height=videoMenu.offsetHeight;
    const left=Math.max(4,x+width+4<=innerWidth ? x : x-width);
    const top=Math.max(4,y+height+4<=innerHeight ? y : (fromPointer ? y : bounds.top)-height);
    videoMenu.style.left=left+'px';
    videoMenu.style.top=top+'px';
    videoMenu.style.transformOrigin=(x-left)+'px '+(y-top)+'px';
    videoMenu.style.setProperty('--menu-shift-y',y-top>videoMenu.offsetHeight/2 ? '3px' : '-3px');
    const initialFocus=fromPointer ? videoMenu : videoMenu.querySelector('button:enabled') ?? videoMenu;
    initialFocus.focus({preventScroll:true});
  }
  host.addEventListener('contextmenu',event=>{
    let target=event.target;
    if(target.closest('.sequence-cursor')) {
      target=document.elementsFromPoint(event.clientX,event.clientY).find(node=>node.closest('.sequence-row'));
    }
    if(!target?.closest('.sequence-row:not(.sequence-ruler)')) return;
    keyboardCell=target.closest('button.sequence-block');
    if(!keyboardCell && clipboard && target.closest('.kind-pip .sequence-content,.kind-sticker .sequence-content') && !target.closest('[data-track-locked]')) return;
    event.preventDefault();
    showCellMenu(keyboardCell,event.clientX,event.clientY,event.altKey);
  },true);
  host.addEventListener('click',event=>{clearContextHint();keyboardCell=event.target.closest('button.sequence-block');},true);
  host.addEventListener('keydown',event=>{
    if(event.key==='Escape') clearContextHint();
    if(event.key!=='ContextMenu' && !(event.key==='F10' && event.shiftKey)) return;
    const cell=event.target.closest('button.sequence-block') ?? (event.target===host && keyboardCell?.isConnected ? keyboardCell : null);
    event.preventDefault();
    showCellMenu(cell);
  });
  videoMenu.addEventListener('click',event=>{
    const button=event.target.closest('button:enabled');
    if(!button) return;
    const cell=menuCell, slot=candidateSlots.get(cell);
    closeVideoMenu();
    if(!cell?.isConnected || ctx.busy() || cell.closest('[data-track-locked]')) return;
    const action=itemActions.get(button);
    if(action) {
      cell.focus({preventScroll:true});
      action();
      return;
    }
    if(slot) window.editorCommands.execute(menuCommands[button.dataset.action],{slot});
  });
  function toggleCandidateMute(clip) {
    ctx.toggleClipMute(clip);
    finishControlEdit();
    candidateNodes.get(clip)?.focus({preventScroll:true});
  }
  function insertBesideCandidate(index) {
    const monitor=ctx.isMonitoringTimeline();
    const shot=ctx.insertShot(index,[],{starts:shotTimes,widths,focus:layoutFocus});
    if(!shot) return;
    finishControlEdit();
    playTime=shotTimes[index];
    pastePosition=positionAt(playTime);
    if(monitor) draftTransport.scrub(draftPlan,playTime);
    syncCursor();
    const strip=host.querySelector('.sequence-shots [data-drop-shot="'+index+'"]');
    strip?.focus({preventScroll:true});
    strip?.scrollIntoView({block:'nearest',inline:'nearest'});
    ctx.notify('已插入空分镜 '+(index+1)+'，可从素材库拖入画面。');
  }
  videoMenu.addEventListener('keydown',event=>{
    const command=[...videoMenu.querySelectorAll('button:enabled[data-menu-key]')].find(b=>b.dataset.menuKey.toLowerCase()===event.key.toLowerCase());
    if(command && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault();event.stopPropagation();command.click();return; }
    if(event.key==='Escape' || event.key==='Tab') {
      closeVideoMenu();
      (menuCell?.isConnected && menuCell.matches('button') ? menuCell : host).focus({preventScroll:true});
      if(event.key==='Tab') return;
    } else {
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      const buttons=[...videoMenu.querySelectorAll('button:enabled')];
      const index=buttons.indexOf(document.activeElement);
      if(buttons.length) {
        let next;
        if(event.key==='Home') next=0;
        else if(event.key==='End') next=buttons.length-1;
        else if(event.key==='ArrowDown') next=(index+1)%buttons.length;
        else next=index<=0 ? buttons.length-1 : index-1;
        buttons[next].focus({preventScroll:true});
      }
    }
    event.preventDefault();
    event.stopPropagation();
  });
  host.addEventListener('keydown',event=>{
    if(!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.isComposing || ctx.busy() ||
        event.target.closest('input,textarea,select,[contenteditable="true"],dialog')) return;
    const key=event.key.toLowerCase();
    if(key!=='c' && key!=='v') return;
    if(key==='v' && !clipboard) return;
    event.preventDefault();event.stopPropagation();
    if(key==='c') registry.execute('timeline-copy',{source:'keyboard'});
    else {
      const target=event.target.closest('[data-drop-shot]');
      if(clipboard?.kind==='视频' && target) {
        const place=materialVideoDrop(event);
        registry.execute('timeline-paste',{position:{index:place?.targetIndex ?? Number(target.dataset.dropShot),videoLane:place?.targetLane,videoSlot:place?.videoSlot}});
      }
      else registry.execute('timeline-paste');
    }
  });

  function editShot(s,index) {
    if (ctx.busy()) return;
    const shot=s.shots[index], config=s.settings[index] ?? {};
    if (!shot) {ctx.createAt(index); return;}
    const d=dialog('分镜属性 · '+(index+1));
    const name=input('text',config.name); name.maxLength=120;
    const desc=el('textarea'); desc.maxLength=2000; desc.value=config.description ?? '';
    const duration=input('number',config.duration,.1,86400,.001); duration.placeholder='跟随候选素材';
    const smart=input('checkbox'); smart.checked=!!config.smartTrim;
    d.field('名称',name); d.field('分镜说明',desc); d.field('指定时长（秒）',duration); d.field('随机选择素材起点',smart);
    matchDurationButton(d,s,index);
    if(index===0) d.body.append(btn('首分镜封面',()=>{d.wrapper.close();ctx.firstCover();}));
    d.foot.append(btn('添加候选',()=>{d.wrapper.close();ctx.importShot(shot);}));
    d.save(()=>ctx.shotSettings(shot,{name:name.value.trim(),description:desc.value,duration:duration.value ? duration.valueAsNumber : null,smartTrim:smart.checked}));
    d.wrapper.showModal();
  }
  function textSettings(s) {
    const d=dialog('文字组设置');
    const mode=choice([['whole','整段文字组'],['segmented','分段文字组']],s.pack.textMode);
    const selection=choice([['ordered','整条使用同一组'],['random','各分镜独立抽取']],s.pack.textSelection);
    d.field('显示方式',mode); d.field('分段抽取',selection);
    d.save(()=>{s.pack.textMode=mode.value; s.pack.textSelection=selection.value;});
    d.wrapper.showModal();
  }
  function updateShotDrop() {
    const drag=shotDrag;
    if (!drag?.active) return;
    if(drag.ghost) drag.ghost.style.transform='translate3d('+(drag.x+8)+'px,'+(drag.y+8)+'px,0)';
    const viewport=host.getBoundingClientRect(), bounds=drag.strip.getBoundingClientRect();
    const inside=drag.y>=bounds.top && drag.y<=bounds.bottom && drag.x>=viewport.left && drag.x<=viewport.right;
    drag.marker.hidden=!inside;
    drag.slot=undefined;
    if (!inside) return;
    const left=viewport.left+drag.strip.previousElementSibling.offsetWidth;
    const time=(Math.max(left,drag.x)-bounds.left)/timeScale;
    const index=shotTimes.findIndex((start,i)=>time<start+widths[i]/2);
    drag.slot=index<0 ? widths.length : index;
    const edge=(shotTimes[drag.slot] ?? totalTime)*timeScale;
    drag.marker.style.left=Math.max(0,Math.min(bounds.width-3,edge-1))+'px';
  }
  function scrollShotDrag(now) {
    const drag=shotDrag;
    if (!drag?.active) return;
    drag.frame=undefined;
    const elapsed=Math.max(0,Math.min(.25,(now-drag.lastScrollTime)/1000));
    drag.lastScrollTime=now;
    const bounds=host.getBoundingClientRect(), strip=drag.strip.getBoundingClientRect();
    if (drag.y>=strip.top && drag.y<=strip.bottom) {
      const left=bounds.left+drag.strip.previousElementSibling.offsetWidth;
      const step=drag.x<left+20 ? drag.x-left-20 : Math.max(0,drag.x-bounds.right+20);
      if (step) {
        const pixelsPerSecond=Math.sign(step)*Math.min(2160,Math.abs(step)*108);
        const before=host.scrollLeft;
        host.scrollLeft+=Math.sign(step)*Math.max(1,Math.abs(pixelsPerSecond*elapsed));
        if (before!==host.scrollLeft) drag.frame=requestAnimationFrame(scrollShotDrag);
      }
    }
    updateShotDrop();
  }
  function finishShotDrag(commit=false) {
    const drag=shotDrag;
    if (!drag) return;
    shotDrag=undefined;
    cancelAnimationFrame(drag.frame);
    drag.marker.hidden=true;
    drag.strip.classList.remove('reordering');
    drag.button.classList.remove('shot-drag-source');
    drag.ghost?.remove();
    if (drag.button.hasPointerCapture(drag.id)) drag.button.releasePointerCapture(drag.id);
    if (commit && drag.active && drag.slot!==undefined) {
      const to=drag.slot>drag.from ? drag.slot-1 : drag.slot;
      if (ctx.move(drag.shot,to)) refocusShot=drag.shot;
    }
  }
  function suppressDragClick() {
    const ignore=click=>{
      if(!click.isTrusted || !click.detail) return;
      click.preventDefault();click.stopPropagation();
    };
    window.addEventListener('click',ignore,true);
    setTimeout(()=>window.removeEventListener('click',ignore,true),0);
  }
  window.addEventListener('keydown',(event)=>{
    if (event.key==='Escape' && resizeDrag && !event.isComposing) {
      event.preventDefault();event.stopPropagation();
      endResize(false);
      return;
    }
    if (event.key==='Escape' && shotDrag) {
      event.preventDefault();event.stopPropagation();
      shotDrag.cancelled=true;shotDrag.active=false;
      shotDrag.marker.hidden=true;shotDrag.strip.classList.remove('reordering');
      shotDrag.button.classList.remove('shot-drag-source');
      shotDrag.ghost?.remove();
      cancelAnimationFrame(shotDrag.frame);
    }
  },true);
  window.addEventListener('blur',()=>finishShotDrag());
  function bindShotStrip(strip, order) {
    const marker=el('i','shot-insert-marker');
    marker.hidden=true;marker.setAttribute('aria-hidden','true');strip.prepend(marker);
    strip.onpointerdown=(event)=>{
      const button=event.target.closest('[data-reorder-shot]');
      if (!event.target.closest('.shot-reorder-handle') || !button || order.length<2 || ctx.busy() || event.button!==0 || !event.isPrimary
          || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const from=Number(button.dataset.dropShot);
      shotDrag={strip,marker,button,from,shot:order[from],id:event.pointerId,startX:event.clientX};
      button.setPointerCapture(event.pointerId);
    };
    strip.onkeydown=(event)=>{
      const button=event.target.closest('[data-reorder-shot]');
      if (!button || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();event.stopPropagation();
      const index=Number(button.dataset.dropShot), shot=order[index];
      const id=event.key==='ArrowLeft' ? 'move-shot-left' : 'move-shot-right';
      if (window.editorCommands.execute(id,{shot})) refocusShot=shot;
    };
  }
  window.addEventListener('pointermove',(event)=>{
    const drag=shotDrag;
    if (!drag || drag.cancelled || drag.id!==event.pointerId) return;
    if (!(event.buttons&1)) {finishShotDrag();return;}
    drag.x=event.clientX;drag.y=event.clientY;
    if (!drag.active) {
      if (Math.abs(drag.x-drag.startX)<5) return;
      drag.active=true;drag.strip.classList.add('reordering');drag.button.classList.add('shot-drag-source');
      drag.ghost=el('span','shot-reorder-ghost',drag.button.textContent);drag.ghost.setAttribute('aria-hidden','true');document.body.append(drag.ghost);
      draftTransport.stop();ctx.pause();
    }
    if (drag.frame===undefined) {
      drag.lastScrollTime=performance.now();
      drag.frame=requestAnimationFrame(scrollShotDrag);
    }
  },true);
  window.addEventListener('pointerup',(event)=>{
    if (shotDrag?.id!==event.pointerId) return;
    shotDrag.x=event.clientX;shotDrag.y=event.clientY;updateShotDrop();
    if (shotDrag.active || shotDrag.cancelled) {
      suppressDragClick();
    }
    finishShotDrag(true);
  },true);
  window.addEventListener('pointercancel',(event)=>{if (shotDrag?.id===event.pointerId) finishShotDrag();},true);
  function draw() {
    refreshFrame=undefined;
    cancelFilmstripUpdate();
    clearContextHint();
    contextHint.textContent='';
    closeVideoMenu();
    if (!host.clientWidth) {relayoutZoom=undefined;return;}
    layerDrag?.cancel();
    finishShotDrag();
    finishCandidateDrag(false);
    endResize(false);
    const s=ctx.state();
    lastState=s;
    const index=s.shots.indexOf(focusShot);
    if (index<0) {focusShot=undefined;focusClip=undefined;}
    const columns=s.shots.length || 3;
    layoutFocus=focusClip ?? s.selected;
    const layout=window.draftTimeline.timing(s,clipSpan,ctx.asset,layoutFocus);
    const speech=window.draftTimeline.narrationTimeline(s,layout);
    scrubWithDraftPlan=s.shots.some(group=>group.some(clip=>clip.speedOverflow))
      || Object.entries(s.trackControls ?? {}).some(([id,flags])=>flags.disabled || /^vis\d+$/.test(id) && (flags.hidden || flags.solo))
      || layout.aligned?.some((part,i)=>part?.clip?.speed !== undefined && s.settings[i]?.duration
        && !window.usesPlacedVideoSource(part.clip,false) && Math.abs(candidateSourceSeconds(part.clip)-layout.widths[i])>1e-6);
    ({widths,starts:shotTimes,total:totalTime}=layout);
    headWidth=parseFloat(getComputedStyle(host).getPropertyValue('--track-head-width'));
    const viewportWidth=host.clientWidth, currentScroll=host.scrollLeft;
    const contentWidth=viewportWidth-headWidth;
    timeScale=scaleForWidth(contentWidth);
    if (fit!==false) zoomScales=scalesAround(timeScale);
    ctx.showZoom(zoomScales.indexOf(timeScale)+1,zoomScales.length);
    const timelineWidth=Math.max(contentWidth-2,totalTime*timeScale);
    const oldFrames = new Map();
    for (const image of host.querySelectorAll('img[data-thumb][src]')) {
      const key = image.dataset.thumb + '/' + image.dataset.time;
      if (!oldFrames.has(key)) oldFrames.set(key, []);
      oldFrames.get(key).push(image);
    }
    const canvas=el('div','sequence-canvas');
    const blocks=[], filmstrips=[];
    showSnap();
    blocksBySource.clear();
    waveforms.clear();
    canvas.style.width=(timelineWidth+headWidth)+'px';
    function row(label, cls, key, layer) {
      const node=el('div','sequence-row '+cls), head=el('div','sequence-head');
      const track=el('div','sequence-content');
      if (cls==='sequence-voice') track.dataset.emptyHint=window.editorMessages.emptyVoice;
      if (key) {
        node.dataset.laneKey=key;
        const toggle=btn(label,()=>{setFold(node,key,!folded.has(key),true);ctx.scroll();});
        toggle.setAttribute('aria-expanded',String(!folded.has(key)));
        toggle.setAttribute('aria-label',label+'，折叠或展开轨道');
        toggle.title=label+' · 折叠或展开轨道';
        const kind=layer?.kind;
        const typeIcon=cls==='sequence-video'?'track-video':cls==='sequence-voice'?'audio':
          cls==='sequence-music'||kind==='sound'?'track-music':cls==='sequence-caption'||kind==='text'?'track-type':
          kind==='pip'||kind==='sticker'?'image':cls==='sequence-shots'?'track-shot':'tracks';
        toggle.classList.add('track-kind');toggle.replaceChildren(icon(typeIcon));
        head.append(toggle);
        const controlKey=layer ? window.trackControls.layerKey(layer) : key;
        const flags=s.trackControls?.[controlKey] ?? {};
        node.toggleAttribute('data-track-locked',Boolean(flags.locked));
        node.toggleAttribute('data-track-hidden',Boolean(flags.hidden));
        node.toggleAttribute('data-track-disabled',Boolean(flags.disabled));
        track.inert=Boolean(flags.locked);
        const names={disabled:'禁用轨道',locked:'锁定轨道',hidden:'隐藏轨道',muted:'静音',solo:cls==='sequence-video'?'独显':'独听'};
        for(const action of window.trackControls.actions(controlKey ?? 'layer-'+kind+'-unassigned')) {
          const on=action==='muted' && cls==='sequence-video' ? s.muted.has(Number(key.slice(3))) : Boolean(flags[action]);
          const button=btn('',()=>{
            if(ctx.busy()) return;
            if(layer && !layer.laneId) layer.laneId=crypto.randomUUID();
            const id=layer ? window.trackControls.layerKey(layer) : key;
            ctx.toggleTrackControl(id,action,!on);
            finishControlEdit();
            host.querySelector('[data-control-key="'+CSS.escape(id)+'"] [data-track-action="'+action+'"]')?.focus({preventScroll:true});
          },label+' · '+names[action]);
          button.setAttribute('aria-label',label+' · '+names[action]);
          button.setAttribute('aria-pressed',String(on));
          button.dataset.trackAction=action;
          if(action==='solo') button.textContent=on ? 'S✓' : 'S';
          else if(action==='disabled') {
            button.title=label+(on ? ' · 启用轨道，加入预览和生成' : ' · 禁用轨道，从预览和生成中排除');
            button.append(icon('track-power'));
          }
          else button.append(icon(action==='locked' ? (on?'track-lock':'track-unlock')
            : action==='hidden' ? (on?'track-eye-off':'track-eye') : (on?'track-mute':'track-sound')));
          head.append(button);
        }
        if(controlKey) node.dataset.controlKey=controlKey;
        if (folded.has(key)) node.classList.add('sequence-folded');
        const handle=el('span','sequence-height-handle');
        handle.tabIndex=0;
        handle.setAttribute('role','separator');
        handle.setAttribute('aria-orientation','horizontal');
        handle.setAttribute('aria-label',label+'轨道高度');
        handle.title='上下拖动或按方向键调整轨高，Esc 取消拖动，双击或按 Home 恢复默认';
        handle.onpointerdown=(event)=>{
          if(event.button!==0 || resizeDrag || scrubPointer!=null) return;
          event.preventDefault();
          resizeDrag={key,node,handle,y:event.clientY,height:node.offsetHeight,id:event.pointerId,
            savedHeight:heights.get(key),wasFolded:folded.has(key)};
          if(node.getAnimations().some((animation)=>animation.transitionProperty==='height')) {
            resizeLane(node,key,resizeDrag.height);
          }
          handle.setPointerCapture(event.pointerId);
        };
        handle.ondblclick=()=>{heights.delete(key);node.style.removeProperty('--lane-height');setFold(node,key,false);ctx.scroll();};
        handle.onkeydown=(event)=>{
          if(!['ArrowUp','ArrowDown','Home'].includes(event.key)) return;
          event.preventDefault();event.stopPropagation();
          if(event.key==='Home') handle.ondblclick();
          else resizeLane(node,key,node.offsetHeight+(event.key==='ArrowUp'?-4:4));
        };
        head.append(handle);
        if(heights.has(key)) node.style.setProperty('--lane-height',heights.get(key)+'px');
      } else {
        track.setAttribute('role','group');
        track.setAttribute('aria-label',label);
      }
      node.append(head,track);canvas.append(node);
      return track;
    }
    function eventPosition(event,row) {
      const bounds=canvas.querySelector('.sequence-ruler .sequence-content').getBoundingClientRect();
      const node=event.target.closest('[data-drop-shot],[data-voice-shot]');
      const position=positionAt(event.clientX ? (event.clientX-bounds.left)/timeScale : playTime);
      if(node) {
        position.index=Number(node.dataset.dropShot ?? node.dataset.voiceShot);
        if(node.matches('.sequence-empty[data-candidate-index]')) {
          const place=materialVideoDrop(event);
          position.videoLane=place?.targetLane;
          position.videoSlot=place?.videoSlot;
        }
        if(!event.clientX || position.time<shotTimes[position.index] || position.time>=shotTimes[position.index]+widths[position.index]) position.time=shotTimes[position.index];
      }
      if(row!==undefined) position.row=row;
      return position;
    }
    canvas.addEventListener('click',event=>{
      if(!event.target.closest('.sequence-block,.sequence-content')) return;
      const voice=event.target.closest('[data-voice-row]');
      pastePosition=eventPosition(event,voice ? Number(voice.dataset.voiceRow) : undefined);
    },true);
    canvas.addEventListener('contextmenu',event=>{
      if(event.defaultPrevented || ctx.busy() || !event.target.closest('.sequence-content')) return;
      event.preventDefault();
      const node=event.target.closest('.sequence-block');
      if(!clipboard && !copySources.has(node)) return;
      const position=eventPosition(event,node?.hasAttribute('data-voice-row') ? Number(node.dataset.voiceRow) : undefined);
      const d=dialog('时间轴');
      clipboardButtons(d,node,position);
      d.wrapper.showModal();
    });
    function block(track,from,duration,text,action,title) {
      const b=action ? btn(text,action,title ?? text) : el('span','',text);
      b.classList.add('sequence-block');
      const position={node:b,from,duration};
      blocks.push(position);
      sizeBlock(position);
      track.append(b);return b;
    }
    // Store exact edit times, independent of the two-pixel gap painted between blocks.
    cutReferences=[];materialWindows=undefined;
    function reference(from,duration,owner) {
      if(duration>0) cutReferences.push({start:from,end:from+duration,owner});
    }
    function pictureRanges(clip,index) {
      const retained=window.waveformSource(clip.ranges ?? [{start:clip.start,end:clip.end}],clip.look?.head,clip.look?.tail);
      const span=window.pictureSpan(clip,widths[index]);
      const rate=clip.speedOverflow ? clip.speed ?? 1 : retained.duration/pictureClockSpan(clip,index), ranges=[];
      const begin=clip.speedOverflow==='trim-end' ? Math.max(0,retained.duration-span*rate) : 0;
      retained.visit(begin,begin+span*rate,false,(start,end)=>ranges.push({start,end}));
      return {ranges,rate};
    }
    const ruler=row('时间标尺','sequence-ruler');
    scaleRuler(ruler,timelineWidth,viewportWidth,currentScroll);
    const videoCells=window.videoLaneCells(s.shots,shotTimes,widths);
    scrubBounds=s.shots.map(()=>({start:Infinity,end:-Infinity}));
    for(const lane of videoCells) for(const cell of lane ?? []) {
      const bounds=scrubBounds[cell.index];
      bounds.start=Math.min(bounds.start,cell.start);
      bounds.end=Math.max(bounds.end,cell.start+cell.span);
    }
    const depth=Math.max(1,videoCells.length);
    for(let j=0;j<depth;j++) {
      const lane=row('视频 '+(j+1),'sequence-video','vis'+j);
      candidateSlots.set(lane,{lane:j,track:lane});
      const cells=[];
      laneCells.set(lane,cells);
      const filled=videoCells[j] ?? [];
      const reserved=window.reservedVideoCells(filled);
      const occupied=filled.concat(reserved);
      if (!filled.length) lane.dataset.emptyHint=window.editorMessages.emptyVideo;
      const gaps=window.emptyVideoCells(occupied,shotTimes,widths).filter(cell=>cell.span>=1/(s.fps || 30)-1e-7);
      for(const {index:i,clip,start,span,gap,anchor} of occupied.concat(gaps)) {
        const b=block(lane,start,span,clip?.asset.name ?? '',clip ? (event)=>{
          focusShot=s.shots[i];focusClip=clip;voiceTarget=undefined;
          playTime=start;syncCursor();ctx.preview(clip);
          host.querySelector('.sequence-selected')?.classList.remove('sequence-selected');
          event.currentTarget.classList.add('sequence-selected');
        } : undefined);
        b.dataset.dropShot=String(i);
        b.dataset.candidateIndex=String(j);
        const slot={shot:s.shots[i],index:i,clip,lane:j,start,span,track:lane,gap,anchor};
        candidateSlots.set(b,slot);
        cells.push({node:b,slot});
        if (!clip) {
          b.classList.add('sequence-empty');
          if(gap) {
            b.dataset.insertedGap='';
            b.textContent='拖入画面';
          }
          b.title=gap ? '从素材库拖入画面，填入视频 '+(j+1)+' 的 '+summary(span)+'空位' : '从素材库拖入画面，添加到分镜 '+(i+1);
          continue;
        }
        bindMaterialSource(b, clip.sourceEdit?.asset ?? clip.asset);
        candidateNodes.set(clip,b);
        const owner=s.shots[i];
        selection.bind(b,clip,()=>ctx.removeClip(owner,clip));
        bindCopy(b,'视频',()=>ctx.copyClip(clip));
        b.dataset.moveCandidate='';
        b.onpointerdown=event=>{
          if(draggedCandidate || ctx.busy() || !event.isPrimary || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          draggedCandidate={button:b,clip,owner,id:event.pointerId,startX:event.clientX,startY:event.clientY};
        };
        b.onkeydown=event=>nudgeCandidate(event,b,clip,owner);
        if (clip.enabled===false) b.classList.add('sequence-disabled');
        if (clip===s.selected) b.classList.add('sequence-selected');
        const seconds=clipSpan(clip);
        b.dataset.playbackDuration=String(seconds);
        b.dataset.timelineDuration=String(span);
        const duration=Number.isFinite(seconds) ? (clip.videoDuration===undefined && clip.videoWindow===undefined ? seconds : span).toFixed(2)+' 秒' : '—';
        const match=clip.videoWindow===undefined && clip.videoDuration===undefined && Number.isFinite(clip.matchedDuration) ? clip.matchedDuration.toFixed(2)+' 秒 · 已匹配' : '';
        const detail=(match || duration)+(clip.sourceMuted ? ' · 已静音' : '');
        const source=clip.sourceEdit?.asset ?? clip.asset;
        const label=clipHeader(clip.asset.name,clip.asset.kind,source.duration,detail,clip.sourceMuted,clip.speed ?? 1);
        b.replaceChildren(label);
        const original=source.kind==='video' && Number.isFinite(source.duration) ? ' · 原片 '+source.duration.toFixed(2)+' 秒' : '';
        b.title=clip.asset.name+original+(clip.asset.kind==='video' ? ' · '+window.videoSpeedControls.describe(clip) : '')+' · 双击进入裁剪 · 轨道占用 '+summary(span)+' · '+(match ? detail : '候选时长 '+detail)+' · 拖至视频轨下方新建轨道，Alt＋上下键换轨，Alt＋左右键移动分镜中的候选';
        b.setAttribute('aria-label',b.title);
        b.setAttribute('aria-haspopup','menu');
        b.setAttribute('aria-keyshortcuts','Shift+F10 Control+C Control+V Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
        const frames=el('span','sequence-frames');
        const {ranges,rate}=pictureRanges(clip,i);
        const retained=ranges.reduce((sum,r)=>sum+r.end-r.start,0);
        const strip={frames,clip,ranges,rate,span,retained};
        filmstrips.push(strip);
        sizeFilmstrip(strip,oldFrames);
        b.prepend(frames);
        waveforms.add(b,clip.asset,{ranges,span:span*rate,loop:clip.speedOverflow==='loop',
          volume:clip.volume,muted:clip.sourceMuted || !s.keepAudio || s.muted.has(j) || !window.trackControls.allows(s.trackControls,'vis'+j,'audio')});
        b.ondblclick=()=>{if (clip.asset.kind==='video') window.editorCommands.execute('edit-clip',{slot:{shot:owner,clip}}); else editShot(s,i);};
      }
    }
    const strip=row('分镜','sequence-shots','shot-strip');
    for(let i=0;i<columns;i++) {
      const shot=s.shots[i], cfg=s.settings[i] ?? {};
      if(shot) reference(shotTimes[i],widths[i]);
      const openShot=()=>{
        focusShot=shot;focusClip=shot?.includes(focusClip) ? focusClip : shot?.[0];voiceTarget=undefined;editShot(s,i);
      };
      const b=block(strip,shotTimes[i],widths[i],(cfg.name || '分镜 '+String(i+1).padStart(2,'0'))+' · '+summary(widths[i]),()=>{
        if(!shot) openShot();
      },[cfg.description,shot ? '拖动左侧把手或按 Alt＋左右方向键调整顺序，双击编辑分镜' : '添加分镜'].filter(Boolean).join(' · '));
      if(shot) {
        selection.bind(b,shot,()=>removeItem(s.shots,shot),false);
        b.ondblclick=openShot;
        b.dataset.reorderShot='';
        const handle=el('span','shot-reorder-handle');handle.title='拖动把手调整分镜顺序';handle.setAttribute('aria-hidden','true');b.prepend(handle);
        b.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');
      }
      b.dataset.dropShot=String(i);
      candidateSlots.set(b,{shot});
    }
    bindShotStrip(strip,[...s.shots]);
    function voiceBlock(lane,voice,from,span) {
      const asset=voice.asset;
      const si=s.shots.indexOf(voice.shot), delay=si>=0 ? s.voiceOffset(si,voice.row) : 0;
      const speed=asset ? s.voiceSpeed(asset,voice.shot,voice.row) : 1;
      const track=asset && speech.track(si<0 ? null : si,voice.row);
      if (track) from=track.start-delay;
      const displayed=track?.map?.duration ?? Math.max(0,span-delay);
      if(asset) reference(from+delay,displayed);
      const b=block(lane,from+delay,displayed,asset?.name ?? '',asset ? ()=>{
        voiceTarget=voice;focusShot=voice.shot;focusClip=undefined;ctx.voice(voice);
      } : undefined);
      if(asset) b.title=asset.name+' · '+speed+' 倍 · 双击编辑，选中后 Delete 删除、Ctrl+C 复制，轨道左侧可静音';
      if(asset) delete lane.dataset.emptyHint;
      b.dataset.voiceRow=String(voice.row);
      if(si>=0) b.dataset.voiceShot=String(si);
      if (!asset) b.classList.add('sequence-empty');
      else {
        bindMaterialSource(b, asset);
        const map=track.map;
        if (map.trimStart || map.trimEnd) {
          if (track.active && s.narrationTrim?.mode==='smart') scrubWithDraftPlan=true;
          const labels=window.editorMessages.narrationTrim;
          const detail=labels.detail(Number(map.trimStart.toFixed(3)),Number(map.trimEnd.toFixed(3)));
          b.title+=' · '+detail;
          b.setAttribute('aria-label',asset.name+' · '+detail);
          b.append(el('span','narration-trim-marker',labels.marker));
          const show=()=>{contextHint.textContent=detail;};
          const hide=()=>{if(contextHint.textContent===detail) contextHint.textContent='';};
          b.addEventListener('focus',show); b.addEventListener('blur',hide);
          b.addEventListener('pointerenter',show); b.addEventListener('pointerleave',()=>{if(!b.matches(':focus-visible')) hide();});
        }
        waveforms.add(b,asset,{ranges:map.parts,span:displayed*speed,fadeTail:map.fadeDuration*speed,volume:s.voiceVolume(asset,voice.shot,voice.row),
          muted:!window.trackControls.allows(s.trackControls,(si>=0?'voice':'whole')+voice.row,'audio')});
        selection.bind(b,'voice:'+si+'/'+voice.row+'/'+asset.id,()=>ctx.removeVoice(voice));
        voiceBlocks.set(b,voice);
        b.ondblclick=()=>ctx.editVoice(voice);
        bindCopy(b,'口播',()=>ctx.copyVoice(voice));
        bindClipMenu(b,{speed:()=>openVoiceSettings(voice)});
      }
    }
    if(s.segmented) {
      const count=Math.max(1,...s.segments.map((a)=>a.length));
      for(let j=0;j<count;j++) {
        const lane=row('口播 '+(j+1),'sequence-voice','voice'+j);
        s.shots.forEach((shot,i)=>voiceBlock(lane,{asset:s.segments[i]?.[j],shot,row:j},shotTimes[i],widths[i]));
      }
    } else s.whole.forEach((voice,j)=>{
      const at=s.priority==='picture' ? shotTimes[voice.follow] ?? 0 : 0;
      voiceBlock(row('整段口播 '+(j+1),'sequence-voice','whole'+j),{...voice,row:j},at,totalTime-at);
    });
    for(const [i,asset] of s.music.entries()) {
      const start=shotTimes[s.musicAt] ?? 0;
      // Looping music has an edit point at its start. Its painted end follows the
      // canvas (including old freely positioned pictures), not an audio edit.
      cutReferences.push({start,end:start});
      const cell=block(row('音乐 '+(i+1),'sequence-music','music'+i),start,totalTime-start,asset.name,()=>ctx.music(asset));
      bindMaterialSource(cell, asset);
      cell.title=asset.name+' · '+s.musicSpeed(asset)+' 倍 · 双击调整倍速，选中后 Delete 删除，轨道左侧可静音';
      waveforms.add(cell,asset,{span:(totalTime-start)*s.musicSpeed(asset),loop:true,volume:s.musicVolume(asset),
        muted:!window.trackControls.allows(s.trackControls,'music'+i,'audio')});
      selection.bind(cell,asset,()=>ctx.removeMusic(asset));
      cell.ondblclick=()=>{if(ctx.busy()) return;const d=dialog('配乐 · '+asset.name);speedField(d,s.musicSpeed(asset),speed=>ctx.setMusicSpeed(asset,speed));d.wrapper.showModal();};
      bindClipMenu(cell,{speed:cell.ondblclick});
    }
    const localCaptionLane=s.shots.some(shot=>shot.some(clip=>clip.videoSubtitles))
      ? row('视频字幕','sequence-caption','local-subtitles') : null;
    const captionShot=localCaptionLane && s.selected?.videoSubtitles ? s.shots.findIndex(shot=>shot.includes(s.selected)) : -1;
    if(captionShot>=0) {
      const clip=s.selected, i=captionShot;
      const {ranges,rate}=pictureRanges(clip,i);
      let elapsed=0;
      for(const range of ranges) {
        for(const cue of clip.videoSubtitles.cues) {
          const begin=Math.max(range.start,cue.start/1000),end=Math.min(range.end,cue.end/1000);
          const beginAt=elapsed+(begin-range.start)/rate;
          const length=(end-begin)/rate;
          if(length>0) {
            const start=(clip.videoStart ?? shotTimes[i])+beginAt;
            reference(start,length,clip);
            const cell=block(localCaptionLane,start,length,cue.text,()=>{},'双击编辑字幕');
            bindCopy(cell,'字幕',()=>({text:cue.text,highlights:structuredClone(cue.highlights),duration:Math.max(1,Math.round(length*1000))}));
            selection.bind(cell,cue,()=>{
              if(!clip.videoSubtitles) return;
              removeItem(clip.videoSubtitles.cues,cue);
              if(!clip.videoSubtitles.cues.length) delete clip.videoSubtitles;
            });
            cell.ondblclick=()=>ctx.captions(clip);
          }
        }
        elapsed+=(range.end-range.start)/rate;
      }
    }
    const captions=speech.captions();
    if(captions.length) {
      const lanes=new Map();
      for (const caption of captions) {
        if(!lanes.has(caption.row)) lanes.set(caption.row,row('口播字幕 '+(caption.row+1),'sequence-caption','caption'+caption.row));
        const {start,end}=caption, duration=end-start;
        if(duration>0) {
          reference(start,duration);
          const cell=block(lanes.get(caption.row),start,duration,caption.name,()=>{},'双击编辑口播字幕');
          bindCopy(cell,'字幕',()=>({text:caption.name,highlights:structuredClone(caption.highlights),duration:Math.max(1,Math.round(duration*1000))}));
          selection.bind(cell,caption.key,caption.remove);
          cell.ondblclick=caption.open;
        }
      }
    }
    if(s.timelineCaptions.length) {
      const lane=row('时间轴字幕','sequence-caption','pasted-captions');
      for(const cue of s.timelineCaptions) {
        const start=cue.start/1000, length=(cue.end-cue.start)/1000;
        if(start>=totalTime) continue;
        reference(start,Math.min(length,totalTime-start));
        const cell=block(lane,start,Math.min(length,totalTime-start),cue.text,()=>{},'双击编辑字幕');
        selection.bind(cell,cue,()=>removeItem(s.timelineCaptions,cue));
        bindCopy(cell,'字幕',()=>({text:cue.text,highlights:structuredClone(cue.highlights),duration:cue.end-cue.start}));
        cell.ondblclick=()=>{
          const d=dialog('编辑时间轴字幕'), words=el('textarea');
          words.value=cue.text;words.required=true;d.field('字幕内容',words);
          const begin=input('number',start,0,null,.001),end=input('number',cue.end/1000,0,null,.001);
          d.field('入点（秒）',begin);d.field('出点（秒）',end);
          d.save(()=>{if(!words.value.trim() || !(end.valueAsNumber>begin.valueAsNumber)) throw Error('请填写字幕并检查起止时间。');
            Object.assign(cue,{text:words.value.trim(),start:Math.round(begin.valueAsNumber*1000),end:Math.round(end.valueAsNumber*1000)});});
          d.wrapper.showModal();
        };
      }
    }
    function layerRow(target,items,start,span,mapping) {
      const lanes=new Map();
      for(const [i,layer] of (items ?? []).entries()) {
        if (mapping) {
          for (const part of mapping.parts) paintLayer(i,layer,part);
        } else paintLayer(i,layer);
      }
      function paintLayer(i,layer,part) {
        const rate=part ? (part.end-part.start)/(part.outEnd-part.outStart) : 1;
        const toTime=value=>part ? start+part.outStart+(value-part.start)/rate : start+value;
        const toSource=value=>part ? part.start+(value-start-part.outStart)*rate : value-start;

        const asset=ctx.asset(layer.id), limit=asset?.duration;
        const speed=layer.speed ?? 1;
        const sourceSpan=limit>0 ? (limit-(layer.mediaOffset ?? 0))/speed : Infinity;
        const length=Math.min(layer.end ?? Infinity,span,layer.start+sourceSpan)-layer.start;
        const leftAt=Math.max(layer.start,part?.start ?? 0);
        const rightAt=Math.min(layer.start+length,part?.end ?? Infinity);
        if (part && rightAt<=leftAt) return;
        if(layer.kind==='sound' && asset && target.key!=='local' && target.key!=='voice') reference(start+layer.start,length);
        const id=layer.kind+'-'+(layer.laneId ?? i);
        if(!lanes.has(id)) lanes.set(id,row(target.label+' · '+kinds[layer.kind],'sequence-layer kind-'+layer.kind,target.label+'/'+(target.column ?? 0)+'/'+id,layer));
        const lane=lanes.get(id);
        const title=layer.kind==='text' ? layer.text : asset?.name ?? kinds[layer.kind];
        let dragged=false;
        const cell=block(lane,toTime(leftAt),part ? (rightAt-leftAt)/rate : Math.max(.1,length),title,()=>{},title+' · 双击编辑');
        if (asset) bindMaterialSource(cell, asset);
        if (length>0 && (layer.kind==='sound' || layer.kind==='pip')) {
          const offset=(layer.mediaOffset ?? 0)+(leftAt-layer.start)*speed;
          waveforms.add(cell,asset,{ranges:[{start:offset,end:offset+(rightAt-leftAt)*speed}],volume:layer.volume ?? (layer.kind==='pip'?0:100),
            muted:!window.trackControls.allows(s.trackControls,window.trackControls.layerKey(layer),'audio')});
        }
        selection.bind(cell,layer,()=>removeItem(items,layer));
        const splitInEditor=layer.kind==='sound' || layer.kind==='text';
        function splitAt(at,alt=false) {
          const absolute=toTime(layer.start+at);
          const snap=matchTime(snapAnchors(cell),absolute,alt);
          if(snap!==undefined && toSource(snap)-layer.start>=.05 && layer.start+length-toSource(snap)>=.05) at=toSource(snap)-layer.start;
          return {enabled:at>=.05 && length-at>=.05,run(){
            const offset=at;
            const cut=layer.start+offset;
            layer.laneId ??= crypto.randomUUID();
            const after={...structuredClone(layer),start:cut,mediaOffset:(layer.mediaOffset ?? 0)+offset*speed};
            layer.end=cut;items.splice(i+1,0,after);ctx.change();
            flashSplit(snap!==undefined && Math.abs(toTime(cut)-snap)<1e-7 ? snap : undefined);
          }};
        }
        function openLayer(focusSpeed=false) {
          editLayer({...target,items,ensure:()=>items},layer,splitInEditor ? d=>{
            const split=splitAt(toSource(playTime)-layer.start);
            const button=btn('在播放头分割',()=>{d.wrapper.close();split.run();});
            button.disabled=!split.enabled;
            return button;
          } : undefined,focusSpeed);
        }
        cell.ondblclick=()=>{if(!dragged) openLayer();};
        bindClipMenu(cell,{
          speed:layer.kind==='sound' ? ()=>openLayer(true) : undefined,
          edit:splitInEditor ? undefined : ()=>openLayer(),
          split:splitInEditor ? undefined : (x,alt)=>splitAt(x===undefined ? toSource(playTime)-layer.start : leftAt-layer.start+(x-cell.getBoundingClientRect().left)/timeScale*rate,alt),
        });
        const left=el('span','sequence-edge'),right=el('span','sequence-edge');
        left.title='调整入点';right.title='调整出点';cell.prepend(left);cell.append(right);
        cell.onpointerdown=(e)=>{
          if(e.button!==0 || !e.isPrimary || layerDrag || ctx.busy() || length<=0) return;
          dragged=false;
          const edge=e.target===left ? 'left' : e.target===right ? 'right' : 'move';
          const x=e.clientX, original=layer.start, oldEnd=original+length;
          let a=original,b=oldEnd,latestX=x,alt=e.altKey,frame;
          const anchors=snapAnchors(cell);
          const snap=(v)=>Math.round(v*1000)/1000;
          cell.setPointerCapture(e.pointerId);
          function finishLayer() {
            cancelAnimationFrame(frame);
            showSnap();
            cell.onpointermove=cell.onpointerup=cell.onpointercancel=cell.onlostpointercapture=null;
            const resizePending=layerDrag?.resizePending;
            layerDrag=undefined;
            if(cell.hasPointerCapture(e.pointerId)) cell.releasePointerCapture(e.pointerId);
            if(resizePending && refreshFrame===undefined) queueZoomLayout();
          }
          function cancelLayer() {
            finishLayer();
            cell.style.left=toTime(leftAt)*timeScale+'px';
            cell.style.width=Math.max(2,(rightAt-leftAt)/rate*timeScale-2)+'px';
          }
          layerDrag={cancel:cancelLayer,alt(value) {alt=value;if(dragged) moveLayer(latestX);}};
          function moveLayer(clientX) {
            const delta=(clientX-x)/timeScale*rate;
            if(edge==='left') a=snap(Math.max(Math.max(0,original-(layer.mediaOffset ?? 0)/speed),Math.min(b-.05,original+delta)));
            else if(edge==='right') b=snap(Math.min(span,original+sourceSpan,Math.max(a+.05,oldEnd+delta)));
            else {
              a=snap(Math.max(0,Math.min(span-.05,original+delta)));
              b=snap(a+length);
            }
            const first=edge==='right' ? undefined : matchTime(anchors,toTime(a),alt);
            const last=edge==='left' ? undefined : matchTime(anchors,toTime(b),alt);
            const firstDelta=first===undefined ? Infinity : toSource(first)-a;
            const lastDelta=last===undefined ? Infinity : toSource(last)-b;
            const adjustStart=Math.abs(firstDelta)<=Math.abs(lastDelta);
            const deltaSnap=adjustStart ? firstDelta : lastDelta;
            const toA=edge==='right' ? a : a+deltaSnap, toB=edge==='left' ? b : b+deltaSnap;
            let guide;
            if(Number.isFinite(deltaSnap) && toA>=-1e-7 && toB-toA>=.05-1e-7 &&
              (edge==='move' ? toA<=span-.05+1e-7 :
                toA>=original-(layer.mediaOffset ?? 0)/speed-1e-7 && toB<=Math.min(span,original+sourceSpan)+1e-7)) {
              a=Math.max(0,toA);b=toB;guide=adjustStart ? first : last;
            }
            showSnap(guide);
            const from=Math.max(a,part?.start ?? 0),until=Math.min(b,part?.end ?? Infinity);
            cell.style.left=toTime(from)*timeScale+'px';cell.style.width=Math.max(2,(until-from)/rate*timeScale-2)+'px';
          }
          cell.onpointermove=(event)=>{
            if(event.pointerId!==e.pointerId || (Math.abs(event.clientX-x)<5 && !dragged)) return;
            dragged=true;
            latestX=event.clientX;alt=event.altKey;
            if(frame===undefined) frame=requestAnimationFrame(()=>{frame=undefined;moveLayer(latestX);});
          };
          cell.onpointerup=(event)=>{
            if(event.pointerId!==e.pointerId) return;
            if(!dragged) {finishLayer();return;}
            alt=event.altKey;
            moveLayer(event.clientX);
            finishLayer();
            if(edge==='left') layer.mediaOffset=snap((layer.mediaOffset ?? 0)+(a-original)*speed);
            layer.start=a;layer.end=edge==='move' && layer.end==null ? null : b;
            ctx.change();
          };
          cell.onpointercancel=cell.onlostpointercapture=(event)=>{
            if(event.pointerId!==e.pointerId) return;
            cancelLayer();
          };
        };
      }
    }
    const p=s.pack;
    p.composites.forEach((items,i)=>layerRow({key:'comp'+i,label:'复合 '+(i+1)},items,0,totalTime));
    p.textGroups.forEach((cols,i)=>cols.forEach((items,j)=>{if(p.textMode==='segmented' || j===0) layerRow({key:'text'+i,label:'文字组 '+(i+1),column:j},items,shotTimes[j] ?? 0,p.textMode==='segmented' ? widths[j] : totalTime);}));
    layerRow({key:'global',label:'全局'},p.global,0,totalTime);
    s.shots.forEach((shot,i)=>shot.forEach((clip,j)=>layerRow({key:'local',label:'候选 '+(i+1)+'-'+(j+1),clip},clip.layers,clip.videoStart ?? shotTimes[i],window.pictureSpan(clip,widths[i]))));
    function voiceLayerRow(shot,row,items,label) {
      if (!items?.length) return;
      const {start,map}=speech.track(shot,row);
      const asset=shot==null ? s.whole[row]?.asset : s.segments[shot]?.[row];
      if (asset && map) layerRow({key:'voice',label},items,start,asset.duration,map);
    }
    if(s.segmented) p.segmentNarration.forEach((tracks,i)=>tracks.forEach((items,j)=>voiceLayerRow(i,j,items,'口播 '+(i+1)+'-'+(j+1))));
    else p.wholeNarration.forEach((items,i)=>voiceLayerRow(null,i,items,'整段口播 '+(i+1)));
    snapGeometry=blocks.filter(({node})=>!node.classList.contains('sequence-empty'));
    editControls.attach(ruler,timeScale);
    canvas.append(cursor);
    canvas.onpointerdown=(e)=>{
      if(e.button!==0 || scrubPointer!=null || resizeDrag || e.target.closest('[data-timeline-marker]') || (!ruler.contains(e.target) && e.target!==cursor)) return;
      e.preventDefault();
      scrubPointer=e.pointerId;scrubX=e.clientX;
      host.setPointerCapture(e.pointerId);
      ctx.pause();
      scrubAt(scrubX);
    };
    canvas.addEventListener('click',(e)=>{if(e.target.classList.contains('sequence-content') && e.target!==ruler) {voiceTarget=undefined;focusClip=undefined;ctx.clear();}});
    const restoreFocus=host.contains(document.activeElement);
    thumbObserver.disconnect();thumbQueue.length=0;host.replaceChildren(canvas);
    if(libraryDrag) showLibraryLane(libraryDrag.material,libraryDrag.maxLanes);
    if(restoreFocus && document.activeElement===document.body) host.focus({preventScroll:true});
    selection.attach(canvas);
    if (refocusShot) {
      const moved=strip.querySelector('[data-drop-shot="'+s.shots.indexOf(refocusShot)+'"]');
      moved?.focus({preventScroll:true});
      if (moved) {
        selection.selectOnly(refocusShot);
        const r=moved.getBoundingClientRect(), bounds=host.getBoundingClientRect(), left=bounds.left+strip.previousElementSibling.offsetWidth;
        if (r.left<left) host.scrollLeft+=r.left-left;
        else if (r.right>bounds.right) host.scrollLeft+=Math.min(r.left-left,r.right-bounds.right);
      }
      refocusShot=undefined;
    }
    for (const thumb of canvas.querySelectorAll('[data-thumb]:not([src])')) thumbObserver.observe(thumb);
    finishZoomLayout();
    let lastViewportWidth=viewportWidth;
    relayoutZoom=()=>{
      const viewportWidth=host.clientWidth;
      if(!viewportWidth) return;
      const previousHeadWidth=headWidth;
      headWidth=parseFloat(getComputedStyle(host).getPropertyValue('--track-head-width'));
      const nextScale=scaleForWidth(viewportWidth-headWidth), scaleChanged=nextScale!==timeScale;
      if(scaleChanged || viewportWidth!==lastViewportWidth || headWidth!==previousHeadWidth) closeVideoMenu();
      lastViewportWidth=viewportWidth;
      timeScale=nextScale;
      if(fit!==false) zoomScales=scalesAround(timeScale);
      const width=Math.max(viewportWidth-headWidth-2,totalTime*timeScale);
      const desired=zoomAnchor ? zoomAnchor.time*timeScale-zoomAnchor.offset : host.scrollLeft;
      const scroll=Math.max(0,Math.min(desired,width+headWidth-viewportWidth));
      // Establish the scroll range and pointer anchor before dirtying all clip widths.
      canvas.style.width=(width+headWidth)+'px';
      if(zoomAnchor) {host.scrollLeft=scroll;zoomAnchor=undefined;}
      ctx.zoomScroll(host,Math.max(0,width+headWidth-viewportWidth),scroll);
      if(scaleChanged) {
        for(const block of blocks) sizeBlock(block);
        queueFilmstripUpdate(filmstrips);
      }
      scaleRuler(ruler,width,viewportWidth,scroll);
      editControls.scale(timeScale);
      paintGuide();
      ctx.showZoom(zoomScales.indexOf(timeScale)+1,zoomScales.length);
      syncCursor(scroll);
    };
    if(candidateLandings) {
      for(const {clip,from,reveal} of candidateLandings) {
        const node=candidateNodes.get(clip);
        if(!node) continue;
        if(reveal) revealCandidateLane(node);
        animateCandidateFrom(node,from);
      }
      candidateLandings=undefined;
    }
  }
  function sizeBlock({node,from,duration}) {
    node.style.left=(from*timeScale)+'px';
    node.style.width=Math.max(2,duration*timeScale-2)+'px';
  }
  function cancelFilmstripUpdate() {
    clearTimeout(filmstripTimer);
    cancelAnimationFrame(filmstripFrame);
  }
  function queueFilmstripUpdate(strips) {
    cancelFilmstripUpdate();
    // Existing frames stretch with the block immediately. Resample only once the
    // zoom settles, over small batches so a large project can still accept input.
    let index=0;
    function update() {
      const deadline=performance.now()+2;
      do {sizeFilmstrip(strips[index++]);}
      while(index<strips.length && performance.now()<deadline);
      if(index<strips.length) filmstripFrame=requestAnimationFrame(update);
    }
    if(strips.length) filmstripTimer=setTimeout(()=>{filmstripFrame=requestAnimationFrame(update);},120);
  }
  function sizeFilmstrip({frames,clip,ranges,rate,span,retained},oldFrames) {
    const count=Math.max(1,Math.min(6,Math.ceil(span*timeScale/76)));
    if(frames.childElementCount===count) return;
    for(const img of frames.children) thumbObserver.unobserve(img);
    const images=document.createDocumentFragment();
    for(let n=0;n<count;n++) {
      let img=el('img','sequence-thumb');img.alt='';img.draggable=false;
      if(clip.asset.kind==='image') img.src=clip.asset.url;
      else {
        const at=span*rate*(n+.5)/count;
        let remaining=clip.speedOverflow==='loop' && retained>0 ? at%retained : Math.min(Math.max(0,retained-1e-6),at);
        let seconds=clip.start;
        for(const r of ranges){seconds=r.start+remaining;if(seconds<r.end) break;remaining-=r.end-r.start;}
        img.dataset.thumb=clip.asset.id;img.dataset.time=String(Math.max(0,seconds));
        img=oldFrames?.get(img.dataset.thumb+'/'+img.dataset.time)?.pop() ?? img;
        if(!oldFrames) thumbObserver.observe(img);
      }
      images.append(img);
    }
    frames.replaceChildren(images);
  }
  function scaleRuler(ruler,width,viewportWidth,scroll) {
    const step=[.25,.5,1,2,5,10,30,60,120,300,600,1800,3600].find(v=>v*timeScale>=55) ?? 7200;
    ruler.dataset.step=step;
    ruler.style.setProperty('--minor-tick-spacing',(step*timeScale/5)+'px');
    delete ruler.dataset.tickRange;
    drawRuler(ruler,width,viewportWidth,scroll);
  }
  function finishZoomLayout() {
    if(zoomAnchor) {
      host.scrollLeft=zoomAnchor.time*timeScale-zoomAnchor.offset;
      zoomAnchor=undefined;
    }
    syncCursor();ctx.scroll();
  }
  function zoom(level, clientX, inAnimationFrame=false) {
    const next=zoomScales[level-1];
    if (!next) return;
    manualScale=next;
    const nearest=standardScales.reduce((best,scale)=>Math.abs(Math.log(scale/next))<Math.abs(Math.log(best/next)) ? scale : best);
    ctx.setCardZoom(standardScales.indexOf(nearest)+1);
    fit=false;
    zoomAnchor=undefined;
    if (clientX!==undefined && host.clientWidth) {
      const offset=Math.max(0,clientX-host.getBoundingClientRect().left-headWidth);
      zoomAnchor={offset,time:(host.scrollLeft+offset)/timeScale};
    }
    if(refreshFrame!==undefined) return;
    if(layerDrag) {layerDrag.resizePending=true;return;}
    if(!relayoutZoom || shotDrag || draggedCandidate || libraryDrag || resizeDrag) {refresh();return;}
    if(inAnimationFrame) {
      cancelAnimationFrame(zoomFrame);zoomFrame=undefined;
      relayoutZoom();
      return;
    }
    queueZoomLayout();
  }
  function queueZoomLayout() {
    if(zoomFrame===undefined) zoomFrame=requestAnimationFrame(()=>{
      zoomFrame=undefined;
      if(layerDrag) layerDrag.resizePending=true;
      else relayoutZoom?.();
    });
  }
  function syncCursor(scroll=host.scrollLeft) {
    if(!lastState) return;
    const time=Math.min(totalTime,playTime);
    const x=time*timeScale;
    const visibleWidth=(observedWidth ?? host.clientWidth)-headWidth;
    const hidden=!ctx.showAxis() || x<scroll || x-scroll>visibleWidth;
    if(cursor.hidden!==hidden) cursor.hidden=hidden;
    cursor.style.translate=(headWidth+x)+'px 0';
    if(hidden) return;
    const rate=lastState.fps || 30;
    const frame=Math.floor(time*rate+1e-5);
    const clock=window.playbackTimecode(frame/rate,rate);
    const label=scrubPointer==null ? clock : clock+' · '+window.editorMessages.timelineFrame(frame);
    if(cursorClock.textContent!==label) cursorClock.textContent=label;
    // Keep the label on the roomy side without measuring its width while scrubbing.
    cursorClock.toggleAttribute('data-before',x-scroll>visibleWidth/2);
  }
  host.addEventListener('scroll',()=>{
    syncCursor();
    const ruler=host.querySelector('.sequence-ruler .sequence-content');
    if(ruler) drawRuler(ruler,Number(ruler.dataset.width));
  },{passive:true});
  function setFold(node,key,value,animate=false) {
    if(value) folded.add(key); else folded.delete(key);
    node.classList.toggle('animate-lane-fold',animate);
    node.classList.toggle('sequence-folded',value);
    node.querySelector('[aria-expanded]').setAttribute('aria-expanded',String(!value));
  }
  const accessMenu=document.getElementById('accessible-layout-controls');
  const trackChoice=document.getElementById('accessible-track-choice');
  const trackHeight=document.getElementById('accessible-track-value');
  function chosenTrack() {
    return host.querySelector('[data-lane-key="'+CSS.escape(trackChoice.value)+'"]');
  }
  function showTrackHeight() { const row=chosenTrack(); if (row) trackHeight.value=row.offsetHeight; }
  accessMenu.addEventListener('beforetoggle',event=>{
    if (event.newState!=='open') return;
    const previous=trackChoice.value;
    trackChoice.replaceChildren(...Array.from(host.querySelectorAll('[data-lane-key]'),row=>
      new Option(row.querySelector('.sequence-head [aria-expanded]').title.split(' · ')[0],row.dataset.laneKey)));
    if ([...trackChoice.options].some(option=>option.value===previous)) trackChoice.value=previous;
    document.getElementById('accessible-track-height').hidden=!trackChoice.options.length;
    showTrackHeight();
  });
  trackChoice.addEventListener('change',showTrackHeight);
  document.getElementById('accessible-track-apply').onclick=()=>{
    if(!trackHeight.reportValidity() || !Number.isFinite(trackHeight.valueAsNumber)) return;
    const row=chosenTrack();
    if(row) resizeLane(row,row.dataset.laneKey,trackHeight.valueAsNumber);
    showTrackHeight();
  };
  document.getElementById('accessible-track-reset').onclick=()=>{
    const row=chosenTrack();
    if(row) row.querySelector('.sequence-height-handle').ondblclick();
    showTrackHeight();
  };
  function resizeLane(node,key,size) {
    const compact=size<=17;
    if(!compact) {
      heights.set(key,Math.round(size));
      node.style.setProperty('--lane-height',heights.get(key)+'px');
    }
    setFold(node,key,compact);
    ctx.scroll();
  }
  function applyResize(drag,clientY) {
    if(clientY===drag.appliedY) return;
    drag.appliedY=clientY;
    resizeLane(drag.node,drag.key,drag.height+clientY-drag.y);
  }
  function endResize(commit,clientY) {
    if (!resizeDrag) return;
    const {node,key,handle,id,savedHeight,wasFolded}=resizeDrag;
    cancelAnimationFrame(resizeDrag.frame);
    if(commit && (clientY!==resizeDrag.y || resizeDrag.appliedY!==undefined)) applyResize(resizeDrag,clientY);
    resizeDrag=undefined;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    if (commit) return;
    if (savedHeight===undefined) {
      heights.delete(key);
      node.style.removeProperty('--lane-height');
    } else {
      heights.set(key,savedHeight);
      node.style.setProperty('--lane-height',savedHeight+'px');
    }
    setFold(node,key,wasFolded);
    ctx.scroll();
  }
  function scrubAt(x,viewport=host.getBoundingClientRect(),scroll=host.scrollLeft) {
    const origin=viewport.left+headWidth+host.clientLeft;
    const visibleX=Math.max(origin,Math.min(viewport.right,x));
    scrubTime((visibleX-origin+scroll)/timeScale,scroll);
  }
  function scrubTime(time,scroll=host.scrollLeft) {
    playTime=Math.max(0,Math.min(totalTime,time));
    pastePosition=positionAt(playTime);
    syncCursor(scroll);
    if(scrubWithDraftPlan) {
      draftTransport.scrub(draftPlan,playTime);
      return;
    }
    draftTransport.stopForScrub();
    if(ctx.seekComposition(playTime)) return;
    let index,clip,bestLane=Infinity;
    for(const [i,shot] of (lastState?.shots ?? []).entries()) {
      const bounds=scrubBounds[i];
      if(!bounds || playTime<bounds.start || playTime>bounds.end) continue;
      const first=window.draftTimeline.chosen(shot,focusClip,lastState);
      if(!first) continue;
      const solo=window.soloLaneSequence(shot,first,lastState.trackControls,widths[i]);
      const sequence=solo.length ? solo : window.joinedVideoSequence(shot,first);
      const lanes=window.candidateVideoLanes(shot);
      for(const candidate of sequence.length ? sequence : [first]) {
        const start=candidate.videoStart ?? shotTimes[i],end=start+window.pictureSpan(candidate,widths[i]);
        if(playTime<start || (playTime>=end && !(playTime===totalTime && playTime===end))) continue;
        const lane=lanes[shot.indexOf(candidate)];
        if(lane>bestLane || !window.trackControls.allows(lastState.trackControls,'vis'+lane,'visual')) continue;
        bestLane=lane;index=i;clip=candidate;
      }
    }
    if(!clip) {
      if(activeSeek!==null) ctx.clear();
      activeSeek=null;
      return;
    }
    focusShot=lastState.shots[index];focusClip=clip;
    const elapsed=playTime-(clip.videoStart ?? shotTimes[index]);
    const offset=holdsPicture(clip,index) ? Math.min(elapsed,Math.max(0,candidateSourceSeconds(clip)-1e-6/(clip.speed || 1)))
      : elapsed*clipSpan(clip)/pictureClockSpan(clip,index);
    ctx.seek(clip,offset);
    activeSeek=clip;
  }
  function frameScrub() {
    scrubFrame=undefined;
    if(scrubPointer==null) return;
    const bounds=host.getBoundingClientRect();
    const overflow=scrubX-(bounds.right-14);
    const underflow=scrubX-(bounds.left+headWidth+14);
    const step=overflow>0 ? Math.ceil(overflow/3) : underflow<0 ? Math.floor(underflow/3) : 0;
    const before=host.scrollLeft;
    if(step) host.scrollLeft+=Math.max(-36,Math.min(step,36));
    const scroll=step ? host.scrollLeft : before;
    scrubAt(scrubX,bounds,scroll);
    if(scroll!==before) scrubFrame=requestAnimationFrame(frameScrub);
  }
  window.addEventListener('pointermove',(event)=>{
    if(event.pointerType==='mouse' && !(event.buttons&1)) {
      if(resizeDrag?.id===event.pointerId || event.pointerId===scrubPointer) endDrag(event);
      return;
    }
    if(resizeDrag?.id===event.pointerId) {
      const drag=resizeDrag;
      drag.latestY=event.clientY;
      if(drag.frame===undefined) drag.frame=requestAnimationFrame(()=>{
        drag.frame=undefined;
        applyResize(drag,drag.latestY);
      });
    } else if(event.pointerId===scrubPointer) {
      scrubX=event.clientX;
      if(scrubFrame===undefined) scrubFrame=requestAnimationFrame(frameScrub);
    }
  },true);
  function endDrag(event) {
    if(event.pointerId!==scrubPointer && event.pointerId!==resizeDrag?.id) return;
    if(event.pointerId===scrubPointer) {
      if(event.type==='pointerup') scrubAt(event.clientX);
      scrubPointer=undefined;
      cancelAnimationFrame(scrubFrame);scrubFrame=undefined;
      syncCursor();
    }
    if(resizeDrag?.id===event.pointerId) endResize(event.type==='pointerup',event.clientY);
    if(host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  }
  for(const type of ['pointerup','pointercancel']) window.addEventListener(type,endDrag,true);
  host.addEventListener('lostpointercapture',event=>{
    // Chromium can drop capture before dispatching a still-pressed pointermove
    // over another clip. Continue scrubbing via the window listeners.
    if(event.target===host && !(event.buttons&1)) endDrag(event);
  });
  window.addEventListener('blur',()=>{
    if(scrubPointer!=null) {
      scrubPointer=undefined;
      cancelAnimationFrame(scrubFrame);scrubFrame=undefined;
      syncCursor();
    }
    endResize(false);
  });
  function syncPlayer(clip,sourceTime) {
    if(draftTransport.state()) return;
    if (!lastState || !clip || scrubPointer!=null || host.hidden || (clip.asset.kind==='video' && ctx.seekPending())) return;
    if(ctx.isComposition(clip)){playTime=sourceTime;syncCursor();return;}
    const index=lastState.shots.findIndex((shot)=>shot.includes(clip));
    if(index<0) return;
    const start=clip.videoStart ?? shotTimes[index];
    let elapsed=Math.max(0,sourceTime-clip.start);
    if(clip.ranges?.length) {
      let amount=0;
      for(const range of clip.ranges) {
        if(sourceTime>=range.start && sourceTime<=range.end) {elapsed=amount+sourceTime-range.start; break;}
        amount+=range.end-range.start;
      }
    }
    const hold=holdsPicture(clip,index),sourceSeconds=hold ? candidateSourceSeconds(clip) : clipSpan(clip);
    if(clip.speedOverflow==='trim-end') {
      const span=window.pictureSpan(clip,widths[index]);
      const skip=Math.max(0,candidateSourceSeconds(clip)-span);
      playTime=start+Math.max(0,Math.min(span,(elapsed-(clip.look?.head ?? 0))/(clip.speed || 1)-skip));
      syncCursor();
      return;
    }
    const relative=Math.max(0,elapsed-(clip.look?.head??0))/(clip.speed||1);
    if(activeSeek===clip && hold && playTime>=start+sourceSeconds
      && playTime<=start+window.pictureSpan(clip,widths[index]) && Math.abs(relative-sourceSeconds)<.001) return;
    activeSeek=undefined;
    const ratio=Math.min(1,relative/sourceSeconds);
    playTime=(clip.videoStart ?? shotTimes[index])+Math.min(pictureClockSpan(clip,index)*ratio,clip.videoDuration ?? Infinity); syncCursor();
  }
  function refresh(key,keepDraftPlayback=false) {
    if(!keepDraftPlayback && key!==undefined && lastKey!==undefined && key!==lastKey) draftTransport.stop();
    if(key!==undefined && key===lastKey) return;
    cancelAnimationFrame(zoomFrame);zoomFrame=undefined;
    cachedDraftDuration=undefined;
    if (key!==undefined) lastKey=key;
    if(refreshFrame===undefined) refreshFrame=requestAnimationFrame(draw);
  }
  // These discrete commands replace their own controls. Restore focus before the next input.
  function finishControlEdit() {
    if(refreshFrame===undefined) return;
    cancelAnimationFrame(refreshFrame);
    draw();
  }
  function stopCandidateMotion(node) {
    arrivalAnimations.get(node)?.cancel();
  }
  function revealCandidateLane(node) {
    const panel=host.closest('#timeline-tracks-panel');
    const viewport=panel.getBoundingClientRect(), timeline=host.getBoundingClientRect();
    const rect=node.getBoundingClientRect();
    // Account for the frozen track labels and ruler without scrolling the editor window.
    const left=timeline.left+node.closest('.sequence-row').firstElementChild.offsetWidth;
    const top=viewport.top+panel.clientTop;
    const rulerHeight=host.querySelector('.sequence-ruler').offsetHeight;
    function nearest(start,end,low,high) {
      if(start<low && end<high) return Math.max(start-low,end-high);
      if(start>low && end>high) return Math.min(start-low,end-high);
      return 0;
    }
    host.scrollLeft+=nearest(rect.left,rect.right,left,timeline.right);
    panel.scrollTop+=nearest(rect.top,rect.bottom,top+rulerHeight,top+panel.clientHeight);
  }
  function animateCandidateFrom(node,from,destination) {
    if(!from || !candidateMotion.matches) return;
    const to=destination ?? node.getBoundingClientRect();
    if(!to.width || !to.height) return;
    const start='translate('+(from.left-to.left)+'px,'+(from.top-to.top)+'px) scale('+from.width/to.width+','+from.height/to.height+')';
    const motion=node.animate([{transform:start},{transform:'none'}],{
      id:'candidate-arrival',duration:200,easing:'cubic-bezier(.2,.75,.25,1)',
    });
    arrivalAnimations.set(node,motion);
  }
  function slotMarker(button) {
    const marker=el('i','candidate-slot candidate-vacancy');
    marker.setAttribute('aria-hidden','true');
    marker.style.left=button.style.left;marker.style.width=button.style.width;
    button.parentElement.append(marker);
    return marker;
  }
  function liftCandidate(drag) {
    const {button,startX,startY}=drag;
    const from=button.getBoundingClientRect();
    drag.grabOffset=(startX-from.left)/timeScale;
    stopCandidateMotion(button);
    drag.home=slotMarker(button);
    drag.panel=host.closest('#timeline-tracks-panel');
    drag.canvas=drag.home.closest('.sequence-canvas');
    // A manual popover puts the actual frames and waveform above the scrolling pane.
    // Keep the normal slot and its inline timeline coordinates intact for hit testing.
    button.style.setProperty('--lift-left',from.left+'px');
    button.style.setProperty('--lift-top',from.top+'px');
    button.style.setProperty('--lift-width',from.width+'px');
    button.style.setProperty('--lift-height',from.height+'px');
    button.style.transformOrigin=(startX-from.left)+'px '+(startY-from.top)+'px';
    button.classList.add('candidate-moving');
    button.popover='manual';button.showPopover();
    showNewCandidateLane(drag);
    host.dataset.candidateDrag='active';
    document.body.toggleAttribute('data-candidate-lifted',true);
    drag.active=true;
  }
  function newVideoLane(lane,reason,shot) {
    const row=el('div','sequence-row candidate-new-lane');
    const track=el('div','sequence-content');
    row.append(el('div','sequence-head',reason || '新建视频 '+(lane+1)),track);
    host.querySelector('.sequence-shots').before(row);
    candidateSlots.set(track,{shot,lane,newLane:true,track});
    return track;
  }
  function showNewCandidateLane(drag) {
    const lane=host.querySelectorAll('.sequence-video').length;
    const reason=ctx.candidatePlacementError(drag.clip,drag.owner,drag.owner,undefined,lane);
    const placement=el('div','candidate-slot candidate-new-placement');
    placement.style.width=drag.home.style.width;
    placement.append(drag.button.querySelector('.sequence-frames').cloneNode(true),
      drag.button.querySelector('.sequence-clip-header, .sequence-clip-label').cloneNode(true));
    drag.placement=placement;
    drag.newLane=newVideoLane(lane,reason && '视频轨已满',drag.owner);
    const bottom=host.parentElement.querySelector('#new-shot-drop');
    drag.bottom={node:bottom,text:bottom.textContent,label:bottom.ariaLabel,disabled:bottom.ariaDisabled};
    bottom.textContent=reason || '拖到这里新建视频 '+(lane+1)+' 轨道';
    bottom.ariaLabel=bottom.textContent;
    bottom.ariaDisabled=String(Boolean(reason));
  }
  function displacement(button,home) {
    const track=button.parentElement.getBoundingClientRect();
    const origin={left:track.left+button.offsetLeft,top:track.top+button.offsetTop,
      width:button.offsetWidth,height:button.offsetHeight};
    return {button,from:button.getBoundingClientRect(),origin,to:home?.getBoundingClientRect()};
  }
  function setDisplaced({button,from,origin,to}) {
    stopCandidateMotion(button);
    if(to) {
      button.style.setProperty('--slot-offset',(to.left-origin.left)+'px '+(to.top-origin.top)+'px');
      button.style.setProperty('--slot-width',to.width+'px');
      button.style.setProperty('--slot-height',to.height+'px');
    } else {
      button.style.removeProperty('--slot-offset');
      button.style.removeProperty('--slot-width');
      button.style.removeProperty('--slot-height');
    }
    button.classList.toggle('candidate-displaced',Boolean(to));
    animateCandidateFrom(button,from,to ?? origin);
  }
  function referenceWindows(clip) {
    // Sweep once per drag. Keep internal cuts, but never bridge a gap between
    // two references or use the moving picture's own attached edits as anchors.
    const changes=new Map();
    for(const {start,end,owner} of cutReferences) {
      if(owner===clip) continue;
      changes.set(start,(changes.get(start) ?? 0)+1);
      changes.set(end,(changes.get(end) ?? 0)-1);
    }
    const windows=[];
    let previous=0,active=0;
    for(const [time,delta] of [...changes].sort((a,b)=>a[0]-b[0])) {
      if(active>0 && time>previous+1e-7) windows.push({start:previous,end:time});
      active+=delta;
      previous=time;
    }
    return windows;
  }
  function referenceWindowAt(windows,pointer) {
    let lo=0,hi=windows.length;
    while(lo<hi) {
      const middle=Math.floor((lo+hi)/2);
      if(windows[middle].end<=pointer+1e-7) lo=middle+1; else hi=middle;
    }
    const interval=windows[lo];
    return interval && pointer>=interval.start-1e-7 ? interval : undefined;
  }
  function freeVideoSlot(target,source,owner,pointer,windows) {
    const slot={...target,clip:undefined,shot:owner};
    const epsilon=1e-7;
    const cells=laneCells.get(target.track) ?? [];
    for(const {slot:gap} of cells) {
      if(gap.gap && pointer>=gap.start-epsilon && pointer<gap.start+gap.span-epsilon)
        return {...gap,videoStart:gap.start,videoDuration:gap.span};
    }
    const interval=referenceWindowAt(windows,pointer);
    if(!interval) {
      slot.rejection='请拖到分镜、音频或字幕的时间范围内。';
      return slot;
    }

    let start=interval.start,end=interval.end;
    for(const {slot:other} of cells) {
      if((!other.gap && !other.clip) || (other.clip && other.clip===source?.clip)) continue;
      if(other.start+other.span<=pointer+epsilon) start=Math.max(start,other.start+other.span);
      else if(other.start>pointer+epsilon) end=Math.min(end,other.start);
      else {
        slot.rejection='这个切点区间已被占用。可拖到片段上交换。';
        return slot;
      }
    }
    slot.videoStart=start;
    slot.videoDuration=slot.span=end-start;
    if(slot.span<1/(lastState.fps || 30)-epsilon) slot.rejection='这个切点区间不足一帧，请选择相邻区间。';
    return slot;
  }
  function occupiedGuide(target,pointer,drag) {
    if(!target?.clip || drag.alt || !window.timelineSnapping.enabled) return;
    if(Math.abs(pointer-target.start)*timeScale<=6) return target.start;
    const end=target.start+target.span;
    if(Math.abs(pointer-end)*timeScale<=6) return end;
  }
  function markCandidateDrop(drag,node,pointer) {
    const target=candidateSlots.get(node);
    const free=target?.lane!==undefined && !target.clip;
    if(node===drag.target && !free) {
      showSnap(drag.rejection ? undefined : occupiedGuide(target,pointer,drag));
      return;
    }
    let slot=target;
    if(free) {
      const cached=drag.baseSlot;
      if(node!==drag.target || !cached || !(pointer>=cached.videoStart && pointer<cached.videoStart+cached.span)) {
        drag.windows ??= referenceWindows(drag.clip);
        drag.baseSlot=freeVideoSlot(target,candidateSlots.get(drag.button),drag.owner,pointer,drag.windows);
      }
      slot=drag.baseSlot;
    }
    let guide;
    if(free && !slot.rejection && !slot.gap && !drag.alt && window.timelineSnapping.enabled) {
      const length=candidateSlots.get(drag.button).span;
      drag.anchors ??= snapAnchors(drag.button);
      const placement=window.timelineSnapping.placement(drag.anchors,slot.videoStart,slot.span,length,
        pointer-drag.grabOffset,6/timeScale);
      if(placement) {
        slot={...slot,videoStart:placement.start,videoDuration:placement.span,span:placement.span};
        guide=placement.guide;
      }
    }
    if(free && node===drag.target && slot.rejection===drag.slot?.rejection &&
       slot.videoStart===drag.slot?.videoStart && slot.span===drag.slot?.span) {
      showSnap(drag.rejection ? undefined : guide);
      return;
    }
    const reason=slot ? slot.rejection || ctx.candidatePlacementError(drag.clip,slot.shot,drag.owner,slot.clip,slot.lane,slot.videoStart,slot.gap ? slot : undefined) : '';
    if(!free) guide=occupiedGuide(target,pointer,drag);
    // Read both motions before changing either slot; a second forced layout here
    // makes crossing a row of short clips substantially more expensive.
    const restore=drag.target?.classList.contains('candidate-displaced') && node!==drag.target
      ? {button:drag.target,from:drag.target.getBoundingClientRect(),origin:drag.vacancy.getBoundingClientRect()} : null;
    const displace=slot?.clip && !reason ? displacement(node,drag.home) : null;
    showSnap(reason ? undefined : guide);
    if(drag.target && node!==drag.target) {
      delete drag.target.dataset.materialDrop;
      delete drag.target.dataset.candidateRejected;
      if(restore) setDisplaced(restore);
      drag.vacancy?.remove();
      drag.vacancy=undefined;
    }
    if(node!==drag.target) drag.placement?.remove();
    drag.target=node;
    drag.slot=slot;
    drag.rejection=reason;
    dropHint.toggleAttribute('data-new-lane',Boolean(free && !reason));
    dropHint.textContent=reason || (free ? '视频 '+(slot.lane+1)+' · '+summary(slot.videoStart)+' · 时长 '+summary(slot.span) : '');
    host.toggleAttribute('data-drag-rejected',Boolean(reason));
    drag.home.classList.toggle('candidate-vacancy',!slot || Boolean(reason) || !slot.clip);
    if(!slot) return;
    if(reason) {
      delete node.dataset.materialDrop;
      drag.placement?.remove();
      node.dataset.candidateRejected='';
    }
    else {
      delete node.dataset.candidateRejected;
      node.dataset.materialDrop='active';
      if(free) {
        drag.placement.style.left=(slot.videoStart*timeScale)+'px';
        drag.placement.style.width=Math.max(2,slot.span*timeScale-2)+'px';
        if(drag.clip.asset.kind!=='video') drag.placement.querySelector('.sequence-clip-duration').textContent=summary(slot.span);
        if(drag.placement.parentElement!==slot.track) slot.track.append(drag.placement);
      } else if(slot.clip) {
        drag.vacancy=slotMarker(node);
        setDisplaced(displace);
      }
    }
  }
  function candidateUnderPointer(drag,x,y,time,area,bounds) {
    if(ctx.busy()) return;
    const hit=document.elementFromPoint(x,y);
    if(drag.newLane?.parentElement.contains(hit) || hit===drag.bottom?.node) return drag.newLane;
    const canvas=drag.canvas, panel=drag.panel;
    if(hit===canvas || hit===host || hit===panel) {
      if(x>=area.left+headWidth && x<Math.min(area.right,bounds.left+panel.clientLeft+panel.clientWidth) &&
         (hit===canvas || y>=area.bottom) && y<bounds.top+panel.clientTop+panel.clientHeight) return drag.newLane;
    }
    if(!hit || !host.contains(hit)) return;
    const track=hit.closest('.sequence-video .sequence-content');
    let node;
    if(track) {
      // Only track geometry participates. A clip sliding across another slot must
      // never become the destination simply because its animation crosses the mouse.
      if(time<0) return;
      let empty=track;
      for(const {node:button,slot:cell} of laneCells.get(track)) {
        if(time<cell.start || time>=cell.start+cell.span) continue;
        if(cell.clip && cell.clip!==drag.clip) return button;
        if(!cell.clip) empty=button;
      }
      return empty;
    } else node=hit.closest('.sequence-shots [data-drop-shot]');
    const slot=candidateSlots.get(node);
    if(slot?.shot && (slot.shot!==drag.owner || (slot.lane!==undefined && slot.clip!==drag.clip))) return node;
  }
  function showLibraryLane(material,maxLanes) {
    if(!host.clientWidth || !host.querySelector('.sequence-shots')) return;
    if(libraryDrag?.track.isConnected && libraryDrag.material===material) return;
    clearLibraryLane();
    const tracks=[...host.querySelectorAll('.sequence-video .sequence-content')];
    let lane=tracks.length;
    while(lane<maxLanes && lastState.trackControls?.['vis'+lane]?.locked) lane++;
    const track=newVideoLane(lane,lane>=maxLanes && '视频轨已满');
    track.parentElement.toggleAttribute('data-track-locked',lane>=maxLanes);
    const placement=el('div','candidate-slot candidate-new-placement');
    placement.setAttribute('aria-hidden','true');
    if(material.thumbnail) {
      const frames=el('span','sequence-frames'),image=el('img','sequence-thumb');
      image.src=material.thumbnail;image.alt='';frames.append(image);placement.append(frames);
    }
    const item=material.items[0],source=item.clip?.sourceEdit?.asset ?? item.clip?.asset;
    const label=clipHeader(item.name,item.kind,source?.duration ?? material.sourceDuration,'');
    placement.append(label);
    libraryDrag={material,maxLanes,tracks,track,placement};
    return true;
  }
  function clearLibraryLane() {
    if(!libraryDrag) return;
    libraryDrag.track.parentElement.remove();
    libraryDrag.placement.remove();
    dropHint.textContent='';
    dropHint.removeAttribute('data-new-lane');
    libraryDrag=undefined;
  }
  function previewLibrarySlot(place) {
    if(!libraryDrag) return;
    const {placement}=libraryDrag,slot=place?.videoSlot;
    if(!slot) {
      placement.remove();
      dropHint.textContent='';
      dropHint.removeAttribute('data-new-lane');
      return;
    }
    const track=place.target.closest('.sequence-content');
    placement.style.left=slot.start*timeScale+'px';
    placement.style.width=Math.max(2,slot.span*timeScale-2)+'px';
    if(libraryDrag.material.items[0].kind!=='video') placement.querySelector('.sequence-clip-duration').textContent=summary(slot.span);
    if(placement.parentElement!==track) track.append(placement);
    dropHint.dataset.newLane='';
    dropHint.textContent='视频 '+(place.targetLane+1)+' · '+summary(slot.start)+' · 时长 '+summary(slot.span);
  }
  function materialVideoDrop(event,fromLibrary=false) {
    const track=event.target.closest('.sequence-video .sequence-content, .candidate-new-lane .sequence-content');
    if(!track) return;
    let node=event.target.closest('[data-drop-shot]');
    let cell=candidateSlots.get(node);
    const time=event.clientX ? (event.clientX-track.getBoundingClientRect().left)/timeScale : cell?.start;
    if(!Number.isFinite(time) || time<0) return;
    const covers=cell=>cell && cell.start<=time && time<cell.start+cell.span;
    // Use edit intervals even in the two-pixel gap between painted buttons.
    const nodeAt=track=>Array.from(track.children).find(child=>covers(candidateSlots.get(child)));
    if(!covers(cell)) {
      node=nodeAt(track);
      cell=candidateSlots.get(node);
    }
    const interval=referenceWindowAt(materialWindows ??= referenceWindows(null),time);
    let destination=track;
    if(fromLibrary && libraryDrag) {
      if(cell?.clip) {
        // Copy onto the first free lane below the pointer, keeping every existing clip in place.
        destination=libraryDrag.tracks.slice(cell.lane+1).find(lower=>
          !lower.parentElement.hasAttribute('data-track-locked') && !candidateSlots.get(nodeAt(lower))?.clip
        ) ?? libraryDrag.track;
        node=nodeAt(destination);
        cell=candidateSlots.get(node);
      }
      if(destination.parentElement.hasAttribute('data-track-locked')) return;
      if(!cell && interval) {
        const slot=freeVideoSlot(candidateSlots.get(destination),undefined,undefined,time,[interval]);
        if(slot.rejection) return;
        const index=positionAt(time).index;
        return {target:destination,shot:lastState.shots[index],targetIndex:index,targetLane:slot.lane,
          videoSlot:{start:slot.videoStart,span:slot.span,widths,starts:shotTimes}};
      }
    }
    if(!cell) return;
    const index=positionAt(time).index;
    if(cell.clip) return {target:node,shot:lastState.shots[index],targetIndex:index};
    const start=cell.gap ? cell.start : Math.max(cell.start,interval?.start ?? cell.start);
    const end=cell.gap ? cell.start+cell.span : Math.min(cell.start+cell.span,interval?.end ?? cell.start+cell.span);
    if(end-start<1/(lastState.fps || 30)-1e-7) return;
    return {target:node,shot:cell.shot,targetIndex:cell.index,targetLane:cell.lane,
      videoSlot:{start,span:end-start,widths,starts:shotTimes,...(cell.gap && {gap:cell.gap,anchor:cell.anchor})},
      highlight:{left:(start-cell.start)*timeScale,width:Math.max(2,(end-start)*timeScale-2)}};
  }
  function drawRuler(ruler,width,viewportWidth=host.clientWidth,scroll=host.scrollLeft) {
    const step=Number(ruler.dataset.step);
    ruler.dataset.width=width;
    // Keep one viewport on either side so scrolling usually reuses its ticks.
    const pixels=step*timeScale, pageSize=Math.max(1,Math.ceil(viewportWidth/pixels));
    const page=Math.floor(scroll/(pageSize*pixels));
    const first=Math.max(0,(page-1)*pageSize);
    const last=Math.min(Math.floor(width/pixels),(page+2)*pageSize);
    const range=first+','+last;
    if(ruler.dataset.tickRange===range) return;
    ruler.dataset.tickRange=range;
    const ticks=document.createDocumentFragment();
    for(let index=first;index<=last;index++) {
      const t=index*step;
      const tick=el('span','sequence-tick',stamp(t)+(step<1 && t%1 ? '.'+String(Math.round((t%1)*100)).padStart(2,'0') : ''));
      tick.style.left=(t*timeScale)+'px';ticks.append(tick);
    }
    let tickLayer=ruler.querySelector('.timeline-ticks');
    if(!tickLayer) {tickLayer=el('div','timeline-ticks');ruler.prepend(tickLayer);}
    tickLayer.replaceChildren(ticks);
  }
  function scrollCandidateDrag(now) {
    const drag=draggedCandidate;
    if(!drag?.active || drag.cancelled) return;
    drag.frame=undefined;
    const view=drag.panel;
    const area=host.getBoundingClientRect(), bounds=view.getBoundingClientRect();
    const elapsed=Math.max(.001,Math.min(.05,(now-drag.lastScroll)/1000));
    drag.lastScroll=now;
    if(drag.x>=area.left && drag.x<=area.right && drag.y>=bounds.top && drag.y<=bounds.bottom) {
      const step=(p,low,high)=>p<low+16 ? Math.max(-20,p-low-16) : Math.max(0,Math.min(20,p-high+16));
      const dx=step(drag.x,area.left+headWidth,area.right), dy=step(drag.y,bounds.top,bounds.bottom);
      const left=host.scrollLeft,top=view.scrollTop;
      if(dx) host.scrollLeft+=Math.sign(dx)*Math.max(1,Math.abs(dx)*90*elapsed);
      if(dy) view.scrollTop+=Math.sign(dy)*Math.max(1,Math.abs(dy)*45*elapsed);
      if(left!==host.scrollLeft || top!==view.scrollTop) drag.frame=requestAnimationFrame(scrollCandidateDrag);
    }
    paintCandidate(drag,area,bounds);
  }
  function queueCandidateFrame(drag) {
    if(drag.frame!==undefined) return;
    drag.lastScroll=performance.now();
    drag.frame=requestAnimationFrame(scrollCandidateDrag);
  }
  window.addEventListener('scroll',()=>{
    const drag=draggedCandidate;
    if(drag?.active && !drag.cancelled) queueCandidateFrame(drag);
  },{capture:true,passive:true});
  function paintCandidate(drag,area=host.getBoundingClientRect(),bounds=drag.panel.getBoundingClientRect()) {
    const {x,y}=drag;
    const time=(x-area.left-host.clientLeft-headWidth+host.scrollLeft)/timeScale;
    markCandidateDrop(drag,candidateUnderPointer(drag,x,y,time,area,bounds),time);
    if(drag.paintedX!==x || drag.paintedY!==y) {
      drag.button.style.translate=(x-drag.startX)+'px '+(y-drag.startY)+'px';
      drag.paintedX=x;drag.paintedY=y;
    }
  }
  function updateCandidate(drag,x,y,releasing=false) {
    drag.x=x;drag.y=y;
    if(!drag.active) {
      if(Math.hypot(x-drag.startX,y-drag.startY)<=5) return;
      liftCandidate(drag);
      if(!releasing) host.setPointerCapture(drag.id);
    }
    if(releasing) paintCandidate(drag);
    else queueCandidateFrame(drag);
  }
  function dockCandidate(drag) {
    cancelAnimationFrame(drag.frame);
    markCandidateDrop(drag,undefined);
    drag.newLane?.parentElement.remove();
    if(drag.bottom) {
      const {node,text,label,disabled}=drag.bottom;
      node.textContent=text;
      node.ariaLabel=label;
      node.ariaDisabled=disabled;
    }
    drag.home.remove();
    const b=drag.button;
    b.removeAttribute('popover');
    b.classList.remove('candidate-moving');
    for(const property of ['translate','transform-origin','--lift-left','--lift-top','--lift-width','--lift-height']) b.style.removeProperty(property);
    delete host.dataset.candidateDrag;
    document.body.removeAttribute('data-candidate-lifted');
  }
  async function placeAtSlot(clip,owner,slot) {
    if(!slot || ctx.busy()) return false;
    const i=ctx.state().shots.indexOf(slot.shot);
    const videoSlot=slot.gap ? {...slot,widths,starts:shotTimes} : undefined;
    if(!await ctx.placeCandidate(clip,slot.shot,owner,slot.clip,slot.lane,slot.videoStart,slot.videoDuration,widths,videoSlot)) return false;
    focusShot=slot.shot;focusClip=clip;voiceTarget=undefined;
    ctx.preview(clip);
    selection.selectOnly(clip);
    pastePosition={index:i,time:clip.videoStart ?? shotTimes[i]};
    if(slot.videoStart!==undefined) ctx.notify((slot.newLane ? '已新建视频 ' : '已移至视频 ')+(slot.lane+1)+' 轨道 · '+summary(slot.videoStart));
    else if(slot.newLane) ctx.notify('已新建视频 '+(slot.lane+1)+' 轨道。');
    else if(slot.shot===owner) ctx.notify('候选已移至视频 '+(slot.lane+1)+' 轨道。');
    else ctx.notify(slot.clip ? '已与分镜 '+(i+1)+' 的候选交换。' : '已移动至分镜 '+(i+1)+'。');
    return true;
  }
  async function nudgeCandidate(event,button,clip,owner) {
    if(draggedCandidate || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey ||
      !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || ctx.busy()) return;
    event.preventDefault();event.stopPropagation();
    const source=candidateSlots.get(button);
    let slot;
    let lane=source.lane,track=button.parentElement;
    let pointer=source.start+source.span/2;
    if(event.key==='ArrowUp' || event.key==='ArrowDown') {
      const rows=host.querySelectorAll('.sequence-video');
      lane+=event.key==='ArrowUp'?-1:1;
      if(lane<0) return;
      track=rows[lane]?.querySelector('.sequence-content');
    } else {
      const i=positionAt(source.start).index+(event.key==='ArrowLeft'?-1:1);
      if(i<0 || i>=lastState.shots.length) return;
      pointer=shotTimes[i]+widths[i]/2;
    }
    for(const other of track?.querySelectorAll('[data-move-candidate]') ?? []) {
      const candidate=candidateSlots.get(other);
      if(candidate.clip!==clip && candidate.start<=pointer && pointer<candidate.start+candidate.span) {slot=candidate;break;}
    }
    slot ??= freeVideoSlot({lane,track,newLane:!track},source,owner,pointer,referenceWindows(clip));
    if(slot.rejection) {ctx.notify(slot.rejection);return;}
    try {
      if(await placeAtSlot(clip,owner,slot)) {
        requestAnimationFrame(()=>candidateNodes.get(clip)?.focus());
      }
    } catch(error) {ctx.notify(error.message);}
  }
  async function finishCandidateDrag(commit) {
    const drag=draggedCandidate;
    if(!drag) return;
    const target=drag.target,slot=drag.slot,rejection=drag.rejection,displaced=slot?.clip;
    const from=drag.active && !drag.cancelled ? drag.button.getBoundingClientRect() : null;
    const otherFrom=target?.classList.contains('candidate-displaced') && target.getBoundingClientRect();
    draggedCandidate=undefined;
    if(drag.active && !drag.cancelled) dockCandidate(drag);
    if(host.hasPointerCapture(drag.id)) host.releasePointerCapture(drag.id);
    if(resizeAfterCandidate) {resizeAfterCandidate=false;refresh();}
    if(commit && from && target) {
      try {
        const origin=candidateSlots.get(drag.button);
        if(rejection) ctx.notify(rejection);
        else if(!(slot.lane===origin.lane && Math.abs(slot.videoStart-origin.start)<1e-7 && Math.abs(slot.span-origin.span)<1e-7) && await placeAtSlot(drag.clip,drag.owner,slot)) {
          candidateLandings=[{clip:drag.clip,from,reveal:slot.newLane || slot.videoStart!==undefined}];
          if(otherFrom) candidateLandings.push({clip:displaced,from:otherFrom});
          host.focus({preventScroll:true});
          return;
        }
      } catch(error) {ctx.notify(error.message);}
    }
    animateCandidateFrom(drag.button,from);
  }
  window.addEventListener('pointermove',event=>{
    const drag=draggedCandidate;
    if(!drag || event.pointerId!==drag.id || drag.cancelled) return;
    if(!(event.buttons&1)) {finishCandidateDrag(false);return;}
    drag.alt=event.altKey;
    updateCandidate(drag,event.clientX,event.clientY);
  },true);
  window.addEventListener('pointerup',event=>{
    const drag=draggedCandidate;
    if(!drag || event.pointerId!==drag.id) return;
    drag.alt=event.altKey;
    if(!drag.cancelled) updateCandidate(drag,event.clientX,event.clientY,true);
    if(drag.active || drag.cancelled) suppressDragClick();
    finishCandidateDrag(!drag.cancelled);
  },true);
  window.addEventListener('keydown',event=>{
    const drag=draggedCandidate;
    if(event.key!=='Escape' || !drag || drag.cancelled) return;
    event.preventDefault();event.stopPropagation();
    if(drag.active) {
      const from=drag.button.getBoundingClientRect();
      dockCandidate(drag);
      animateCandidateFrom(drag.button,from);
    }
    drag.cancelled=true;
  },true);
  host.addEventListener('lostpointercapture',event=>{
    // Chromium can relinquish capture while the primary button is still down.
    // The window listeners continue tracking that press through release or cancellation.
    if(event.target===host && draggedCandidate?.id===event.pointerId && !(event.buttons&1)) finishCandidateDrag(false);
  });
  window.addEventListener('pointercancel',event=>{if(draggedCandidate?.id===event.pointerId) finishCandidateDrag(false);},true);
  function toggleDragAlt(event) {
    if(event.key!=='Alt') return;
    const held=event.type==='keydown';
    layerDrag?.alt(held);
    if(draggedCandidate?.active && !draggedCandidate.cancelled) {
      draggedCandidate.alt=held;
      queueCandidateFrame(draggedCandidate);
    }
  }
  window.addEventListener('keydown',toggleDragAlt,true);
  window.addEventListener('keyup',toggleDragAlt,true);
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape' && layerDrag) {event.preventDefault();layerDrag.cancel();}
  },true);
  window.addEventListener('blur',()=>{layerDrag?.cancel();finishCandidateDrag(false);dismissSnap();});
  host.ondragover=(e)=>{
    if(e.target.closest('[data-track-locked]')) return;
    const b=e.target.closest('[data-drop-shot]');
    if (b && e.dataTransfer.types.includes('application/x-jiajian-scene-cut')) {
      e.stopPropagation(); e.preventDefault();e.dataTransfer.dropEffect='copy';
    }
  };
  host.ondrop=(e)=>{
    if(e.target.closest('[data-track-locked]')) return;
    const b=e.target.closest('[data-drop-shot]');
    if(!b) return;
    const index=Number(b.dataset.dropShot);
    if(e.dataTransfer.types.includes('application/x-jiajian-scene-cut')) {
      e.preventDefault();e.stopPropagation();
      const place=materialVideoDrop(e);
      ctx.dropScene(e,place?.targetIndex ?? index,place?.targetLane,place?.videoSlot);
    }
  };
  let observedWidth;
  new ResizeObserver(([entry])=>{
    paintGuide();
    if(observedWidth===entry.contentRect.width) return;
    observedWidth=entry.contentRect.width;
    // A temporary drop row can make the panel scrollbar appear during the gesture.
    if(layerDrag) layerDrag.resizePending=true;
    else if(draggedCandidate?.active) resizeAfterCandidate=true;
    else if(relayoutZoom && !shotDrag && !resizeDrag && !libraryDrag) {
      if(refreshFrame===undefined) queueZoomLayout();
    } else refresh();
  }).observe(host);
  async function editCaptions(asset, original, focusCue=0) {
    const d=dialog('字幕 · '+asset.name);
    const duration=asset.duration || 3;
    let cues=structuredClone(original?.cues ?? []), cursor=focusCue, outcome;
    const picker=el('select');picker.size=5;picker.setAttribute('aria-label','字幕列表');
    const start=input('number',0,0,null,.001),end=input('number',duration,0,null,.001),words=el('textarea');
    const marked=el('input'),markColor=input('color','#ffd152');
    marked.placeholder='多个重点词用逗号分隔';
    const controls=el('div','sequence-caption-tools');
    d.body.append(controls,picker);
    d.field('入点（秒）',start);d.field('出点（秒）',end);d.field('字幕内容',words);
    d.field('重点词',marked);d.field('重点字颜色',markColor);
    const media=el(asset.kind==='video' ? 'video' : 'audio');media.controls=true;media.src=asset.url;media.preload='metadata';d.body.append(media);
    function read() {
      if(cues[cursor]) {
        const old=cues[cursor].highlights ?? [];
        const highlights=[...new Set(marked.value.split(/[,，、]/).map((word)=>word.trim()).filter(Boolean))].map((word)=>({
          word,color:old.find((m)=>m.word===word)?.color ?? markColor.value,
        }));
        cues[cursor]={start:Math.round(start.valueAsNumber*1000),end:Math.round(end.valueAsNumber*1000),text:words.value,...(highlights.length && {highlights})};
      }
    }
    function display() {
      picker.replaceChildren(...cues.map((cue,i)=>new Option((i+1)+'  '+(cue.start/1000).toFixed(2)+'s   '+cue.text,i)));
      cursor=Math.min(cues.length-1,Math.max(0,cursor));picker.selectedIndex=cursor;
      const cue=cues[cursor];
      start.value=(cue?.start ?? 0)/1000;end.value=(cue?.end ?? duration*1000)/1000;words.value=cue?.text ?? '';
      start.disabled=end.disabled=words.disabled=!cue;
      marked.value=cue?.highlights?.map((v)=>v.word).join('，') ?? '';
      marked.disabled=!cue;
      if(cue && media.readyState) media.currentTime=cue.start/1000;
    }
    picker.onchange=()=>{const index=picker.selectedIndex;read();cursor=index;display();};
    const add=btn('添加一句',()=>{read();const at=Math.min(Math.max(0,duration-.1),media.currentTime || 0);cues.push({start:Math.round(at*1000),end:Math.round(Math.min(duration,at+2)*1000),text:''});cursor=cues.length-1;display();words.focus();});
    const remove=btn('移除本句',()=>{if(cues[cursor]) cues.splice(cursor,1);display();});
    let processing=false;
    async function loadTrack(recognize) {
      if(processing) return;
      processing=true;controls.inert=true;d.foot.inert=true;
      d.message.textContent=recognize ? '正在本机识别人声…' : '正在读取 SRT…';
      try {
        const result=await (recognize ? ctx.recognize(asset) : ctx.importSrt());
        if(result && d.wrapper.open) {cues=result.cues;cursor=0;display();}
        d.message.textContent='';
      } catch(error){d.message.textContent=error.message;}
      finally {processing=false;controls.inert=false;d.foot.inert=false;}
    }
    controls.append(btn('识别人声',()=>loadTrack(true)),btn('导入 SRT',()=>loadTrack(false)),add,remove);
    const markTools=el('div','sequence-caption-tools');
    markTools.append(btn('标记选中文字',()=>{
      const word=words.value.slice(words.selectionStart,words.selectionEnd).trim();
      if(!word || !cues[cursor]) {d.message.textContent='请先在字幕内容中选中文字。';return;}
      read();const cue=cues[cursor];cue.highlights=[...(cue.highlights ?? []).filter((m)=>m.word!==word),{word,color:markColor.value}];display();
    }),btn('自动标记数字与关键词',()=>{
      read();
      const stop=new Set('一个 这个 那个 可以 我们 他们 然后 还是 现在 就是 这里 因为 什么 这样 已经'.split(' '));
      const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
      const counts=new Map();
      for(const cue of cues) for(const {segment,isWordLike} of segmenter.segment(cue.text)) {
        if(isWordLike && segment.length>=2 && !stop.has(segment)) counts.set(segment,(counts.get(segment) ?? 0)+1);
      }
      for(const cue of cues) {
        const numbers=cue.text.match(/\d+(?:[.,]\d+)?(?:[%％折元块天年月秒斤升件倍度克毫升]*)/g) ?? [];
        const terms=[...counts].filter(([term,n])=>n>=2 && cue.text.includes(term)).sort((a,b)=>b[1]-a[1]).map(([word])=>word);
        const highlights=[...new Set([...numbers,...terms])].slice(0,3).map((word)=>({word,color:markColor.value}));
        if(highlights.length) cue.highlights=highlights;
      }
      display();d.message.textContent='已按数字与重复关键词标记，可逐句调整。';
    }),btn('统一重点字颜色',()=>{read();for(const cue of cues) for(const m of cue.highlights ?? []) m.color=markColor.value;display();}));
    d.body.append(markTools);
    d.save(()=>{
      read();
      for(const [i,cue] of cues.entries()) {
        if(!cue.text.trim() || !Number.isInteger(cue.start) || !Number.isInteger(cue.end) || cue.start<0 || cue.end<=cue.start) throw Error('第 '+(i+1)+' 句的文字或时间无效。');
      }
      outcome=cues.length ? {name:original?.name ?? '字幕 · '+asset.name.slice(0,180),cues} : null;
    });
    const closed=new Promise((resolve)=>d.wrapper.addEventListener('close',()=>{media.pause();media.removeAttribute('src');if(processing) ctx.cancelRecognition();resolve(outcome);},{once:true}));
    display();d.wrapper.showModal();return closed;
  }
  function bindMaterialSource(block, asset) {
    const source = asset.sourceKey ?? asset.id;
    block.dataset.clipSource = source;
    if (!blocksBySource.has(source)) blocksBySource.set(source, []);
    blocksBySource.get(source).push(block);
    block.classList.toggle('material-instance', source === locatedMaterial);
  }
  function locateMaterial(source, reveal = false) {
    const matches = blocksBySource.get(source);
    if (source !== locatedMaterial) {
      for (const block of blocksBySource.get(locatedMaterial) ?? []) block.classList.remove('material-instance');
      for (const block of matches ?? []) block.classList.add('material-instance');
      locatedMaterial = source;
    }
    if (!reveal || !matches?.length || !host.clientWidth) return;
    const panel = host.closest('#timeline-tracks-panel');
    const area = host.getBoundingClientRect(), viewport = panel.getBoundingClientRect();
    const left = area.left + headWidth;
    const top = viewport.top + panel.clientTop + host.querySelector('.sequence-ruler').offsetHeight;
    let first = matches[0];
    for (const block of matches) {
      const bounds = block.getBoundingClientRect();
      if (bounds.right > left && bounds.left < area.right && bounds.top >= top && bounds.bottom <= viewport.bottom) return;
      if (block.offsetLeft < first.offsetLeft) first = block;
    }
    revealCandidateLane(first);
  }
  function selectClip(clip) {
    cachedDraftDuration=undefined;
    draftTransport.stop();
    activeSeek=undefined;
    if(!lastState || host.hidden) return;
    const i=lastState.shots.findIndex((shot)=>shot.includes(clip));
    host.querySelector('.sequence-selected')?.classList.remove('sequence-selected');
    if(i>=0) {
      focusShot=lastState.shots[i];focusClip=clip;voiceTarget=undefined;
      candidateNodes.get(clip)?.classList.add('sequence-selected');
    }
    const previousShot=candidateSlots.get(candidateNodes.get(layoutFocus))?.shot;
    const choiceChanges=shot=>shot?.length>1 && window.draftTimeline.chosen(shot,layoutFocus,lastState)!==window.draftTimeline.chosen(shot,clip,lastState);
    if(i>=0 && lastState.selected!==clip && (choiceChanges(lastState.shots[i]) || choiceChanges(previousShot))) {
      const layout=window.draftTimeline.timing(lastState,clipSpan,ctx.asset,clip);
      if(layout.widths.some((width,index)=>Math.abs(width-widths[index])>.001)) {
        if(scrubPointer==null) playTime=clip.videoStart ?? layout.starts[i];
        refresh();
      }
    }
    if(lastState.selected!==clip && (clip?.videoSubtitles || lastState.selected?.videoSubtitles)) refresh();
  }
  function refreshMonitoring(videoVisibility=false) {
    if(draftTransport.state()) draftTransport.updatePlan(draftPlan());
    else if(videoVisibility) draftTransport.scrub(draftPlan,playTime);
  }
  function focusCandidate(clip) {
    finishControlEdit();
    const node = candidateNodes.get(clip);
    if (!node?.isConnected) return;
    selection.selectOnly(clip);
    node.focus({preventScroll:true});
    revealCandidateLane(node);
  }
  return {editControls,refresh,refreshMonitoring,syncPlayer,selectClip,addCandidateLayer,toggleCandidateMute,insertBesideCandidate,focusCandidate,locateMaterial,editCaptions,openCardMatchMenu,openCandidateActions,materialVideoDrop,showLibraryLane,clearLibraryLane,previewLibrarySlot,removeSelected:selection.removeSelection,clearSelection:selection.clear,get selectionCount(){return selection.size;},
    get selectedShot(){return candidateSlots.get(selection.single())?.shot;},
    get selectedCandidate(){return candidateSlots.get(selection.single())?.clip;},textSettings:()=>textSettings(ctx.state()),
    toggleDraftPlayback,
    seekDraft:draftTransport.seek,draftState:draftTransport.state,
    stopDraftPlayback:()=>{cancelNarrationPlayback();draftTransport.stop();},isDraftPlaying:draftTransport.playing,
    canPlayDraft:()=>draftDuration()>0,draftDuration,get playheadTime(){return playTime;},
    zoom,zoomFromCards(level) {
      const scale=standardScales[level-1];
      zoomScales=scalesAround(scale);
      zoom(zoomScales.indexOf(scale)+1);
    },fit:()=>{zoomAnchor=undefined;fit=true;refresh();},
    setHeight(value) {
      host.dataset.height=value;
      heights.clear();
      for(const node of host.querySelectorAll('[data-lane-key]')) {
        node.classList.remove('animate-lane-fold');
        node.style.removeProperty('--lane-height');
      }
      ctx.scroll();
    },
    fold(expanded){folded.clear();for(const node of host.querySelectorAll('[data-lane-key]')) setFold(node,node.dataset.laneKey,!expanded);ctx.scroll();},
    reset(newProject=false) {
      dismissSnap();
      finishCandidateDrag(false);
      pastePosition=undefined;
      if(newProject) {clipboard=undefined;editControls.reset();}
      draftTransport.stop();selection.clear();focusShot=focusClip=voiceTarget=activeSeek=undefined;
      folded.clear();heights.clear();playTime=0;zoomAnchor=undefined;
      if (newProject && fit===false) {
        // An extreme close-up of a short clip should not carry into another project's timeline.
        if (manualScale<standardScales[0] || manualScale>standardScales.at(-1)) {
          fit=null;
          ctx.setCardZoom(3);
        } else zoomScales=scalesAround(manualScale);
      }
      refresh();
    }};
};

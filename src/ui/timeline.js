'use strict';

// Track ownership follows shot objects when the user inserts, reorders or removes shots.
window.createTimelinePackaging = function () {
  const fresh = () => ({global: [], composites: [], textGroups: [], wholeNarration: [], segmentNarration: [], textMode: 'whole', textSelection: 'ordered'});
  let data = fresh();
  let order = [];
  function forShots(shots) {
    if (order.length !== shots.length || shots.some((shot, i) => shot !== order[i])) {
      const indices = new Map(order.map((shot, i) => [shot, i]));
      const align = (row) => shots.map((shot) => row[indices.get(shot)] ?? []);
      if (data.segmentNarration.length) data.segmentNarration = align(data.segmentNarration);
      if (data.textMode === 'segmented') data.textGroups = data.textGroups.map(align);
      order = [...shots];
    }
    return data;
  }
  function load(value, shots) {
    data = Object.assign(fresh(), structuredClone(value ?? {}));
    order = [...shots];
  }
  function choices(shots) {
    forShots(shots);
    const alternatives = (groups) => BigInt(Math.max(1, groups.filter(Boolean).length));
    let total = alternatives(data.composites.map((row) => row.length));
    if (data.textMode === 'segmented' && data.textSelection === 'random') {
      for (let i = 0; i < shots.length; i++) total *= alternatives(data.textGroups.map((row) => row[i]?.length));
    } else total *= alternatives(data.textGroups.map((row) => data.textMode === 'whole' ? row[0]?.length : row.some((col) => col.length)));
    return total;
  }
  return {forShots, load, choices};
};

window.candidatePlaybackSeconds = function (clip) {
  if(clip.matchedDuration>0) return clip.matchedDuration;
  const retained = clip.ranges?.reduce((sum, range) => sum + range.end - range.start, 0) ?? (clip.end - clip.start);
  return Math.max(.1, retained - (clip.look?.head ?? 0) - (clip.look?.tail ?? 0)) / (clip.speed || 1);
};

window.mountEditTimeline = function (host, ctx) {
  const waveforms=window.mountWaveforms(host);
  const selection=window.mountTimelineSelection(host,{busy:ctx.busy,changed:ctx.selectionChanged,removed:ctx.afterRemove});
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
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        try { fn(); wrapper.close(); ctx.change(); } catch (error) { message.textContent = error.message; }
      });
    }
    return {wrapper, form, field, body, foot, save, message};
  }
  let playTime = 0, fit = null, refreshFrame, lastState, lastKey;
  let cachedDraftDuration;
  let focusShot, focusClip, voiceTarget, shotDrag, refocusShot;
  let clipboard, pastePosition;
  let draggedCandidate, candidateLandings, resizeAfterCandidate=false;
  const candidateSlots=new WeakMap();
  const candidateMotion=matchMedia('(prefers-reduced-motion: no-preference) and (forced-colors: none)');
  const dropHint=el('div','candidate-drop-hint');
  dropHint.setAttribute('role','status');
  document.body.append(dropHint);
  const copySources=new WeakMap();
  let timeScale = 60, totalTime = 0, shotTimes = [], widths = [];
  const standardScales = [16, 32, 60, 100, 180];
  let zoomScales = standardScales, manualScale = 60, zoomAnchor;
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
    previewSource:ctx.previewSource,
    tick:(time)=>{playTime=time;syncCursor();ctx.draftTick?.();}, changed:(playing)=>ctx.draftPlaybackChanged?.(playing),
  });
  function draftPlan() {
    const state=ctx.state();
    const layout=window.draftTimeline.timing(state,clipSpan,ctx.asset,focusClip ?? state.selected);
    return window.draftTimeline.makePlan(state,layout,ctx.asset,window.waveformSource,focusClip ?? state.selected);
  }
  function draftDuration() {
    cachedDraftDuration ??= draftPlan().reduce((max,entry)=>Math.max(max,entry.end),0);
    return cachedDraftDuration;
  }
  const folded = new Set();
  const heights = new Map();
  let scrubPointer, scrubX, scrubFrame, activeSeek;
  let resizeDrag;
  let locatedMaterial;
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
  const stamp = (s) => [Math.floor(s / 60), String(Math.floor(s % 60)).padStart(2, '0')].join(':');
  const summary = (s) => String(Number(s.toFixed(2))) + ' 秒';
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
    if (clip && s.shots[shotIndex]?.includes(clip)) add('local','当前候选 · '+clip.asset.name,clip.layers,()=>clip.layers ??= [],shotTimes[shotIndex],clipSpan(clip));
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
  function editLayer(initialTarget, existing) {
    if (ctx.busy()) return;
    const s = ctx.state();
    const ti = s.shots.indexOf(focusShot);
    const available=targets(s,ti,focusClip,voiceTarget);
    const groups = existing ? [initialTarget,...available.filter((g)=>g.key!==initialTarget.key && (existing.kind==='text' || !g.key.startsWith('text')))] : available;
    const selectedKey = initialTarget.key;
    const d = dialog(existing ? '编辑包装片段' : '添加包装片段');
    const scope = choice(groups.map((g)=>[g.key,g.label]), groups.some((g)=>g.key===selectedKey) ? selectedKey : 'global');
    const type = choice(Object.entries(kinds), existing?.kind ?? 'text');
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
  }
  function positionAt(time) {
    const at=Math.max(0,Math.min(totalTime,time));
    return {time:at,index:Math.max(0,shotTimes.findLastIndex(start=>start<=at))};
  }
  function bindCopy(node,kind,snapshot) {
    copySources.set(node,{kind,snapshot});
    node.setAttribute('aria-keyshortcuts','Control+C Control+V');
  }
  function copyItem(node) {
    const entry=copySources.get(node);
    if (!entry) {ctx.notify('请选择一个视频、口播或字幕片段。');return;}
    clipboard={kind:entry.kind,data:entry.snapshot()};
    ctx.notify('已复制'+entry.kind+'。');
  }
  function pasteItem(position=pastePosition ?? positionAt(playTime)) {
    if (!clipboard || ctx.busy()) return;
    const s=ctx.state(),shot=s.shots[position.index];
    try {
      if(clipboard.kind==='视频') {
        const clip=ctx.pasteClip(clipboard.data);
        if(shot) {
          if(!ctx.placeCandidate(clip,shot,undefined,undefined,position.videoLane)) return;
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
  function clipboardButtons(d,node,position) {
    if(copySources.has(node)) d.body.append(btn('复制'+copySources.get(node).kind,()=>{copyItem(node);d.wrapper.close();}));
    const paste=btn(clipboard ? '粘贴'+clipboard.kind : '粘贴',()=>{d.wrapper.close();pasteItem(position);});
    paste.disabled=!clipboard;
    d.body.append(paste);
  }
  function speedField(d,current,apply) {
    const field=input('number',current,.5,3,'any');
    field.required=true;
    d.field('播放速度（倍）',field);
    d.save(()=>{const value=field.valueAsNumber;if(!(value>=.5 && value<=3)) throw Error('请输入 0.5 到 3 之间的倍速。');apply(value);});
  }
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
  host.addEventListener('keydown',event=>{
    if(!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.isComposing || ctx.busy() ||
        event.target.closest('input,textarea,select,[contenteditable="true"],dialog')) return;
    const key=event.key.toLowerCase();
    if(key!=='c' && key!=='v') return;
    if(key==='v' && !clipboard) return;
    event.preventDefault();event.stopPropagation();
    if(key==='c') copyItem(selection.single());
    else {
      const target=event.target.closest('[data-drop-shot]');
      if(clipboard?.kind==='视频' && target) pasteItem({index:Number(target.dataset.dropShot)});
      else pasteItem();
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
    const elapsed=Math.max(0,Math.min(.25,(now-drag.lastScrollTime)/1000));
    drag.lastScrollTime=now;
    const bounds=host.getBoundingClientRect(), strip=drag.strip.getBoundingClientRect();
    if (drag.y>=strip.top && drag.y<=strip.bottom) {
      const left=bounds.left+drag.strip.previousElementSibling.offsetWidth;
      const step=drag.x<left+20 ? drag.x-left-20 : Math.max(0,drag.x-bounds.right+20);
      if (step) {
        const pixelsPerSecond=Math.sign(step)*Math.min(2160,Math.abs(step)*108);
        host.scrollLeft+=pixelsPerSecond*elapsed;
        updateShotDrop();
      }
    }
    drag.frame=requestAnimationFrame(scrollShotDrag);
  }
  function finishShotDrag(commit=false) {
    const drag=shotDrag;
    if (!drag) return;
    shotDrag=undefined;
    cancelAnimationFrame(drag.frame);
    drag.marker.hidden=true;
    drag.strip.classList.remove('reordering');
    drag.button.classList.remove('shot-drag-source');
    if (drag.button.hasPointerCapture(drag.id)) drag.button.releasePointerCapture(drag.id);
    if (commit && drag.active && drag.slot!==undefined) {
      const to=drag.slot>drag.from ? drag.slot-1 : drag.slot;
      if (ctx.move(drag.shot,to)) refocusShot=drag.shot;
    }
  }
  function suppressDragClick() {
    const ignore=click=>{click.preventDefault();click.stopPropagation();};
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
      cancelAnimationFrame(shotDrag.frame);
    }
  },true);
  window.addEventListener('blur',()=>finishShotDrag());
  function bindShotStrip(strip, order) {
    const marker=el('i','shot-insert-marker');
    marker.hidden=true;marker.setAttribute('aria-hidden','true');strip.prepend(marker);
    strip.onpointerdown=(event)=>{
      const button=event.target.closest('[data-reorder-shot]');
      if (!button || order.length<2 || ctx.busy() || event.button!==0 || !event.isPrimary
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
      if (ctx.move(shot,index+(event.key==='ArrowLeft' ? -1 : 1))) refocusShot=shot;
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
      draftTransport.stop();ctx.pause();
      drag.lastScrollTime=performance.now();
      drag.frame=requestAnimationFrame(scrollShotDrag);
    }
    updateShotDrop();
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
    if (!host.clientWidth) return;
    finishShotDrag();
    finishCandidateDrag(false);
    endResize(false);
    const s=ctx.state();
    lastState=s;
    const index=s.shots.indexOf(focusShot);
    if (index<0) {focusShot=undefined;focusClip=undefined;}
    const columns=s.shots.length || 3;
    ({widths,starts:shotTimes,total:totalTime}=window.draftTimeline.timing(s,clipSpan,ctx.asset,focusClip ?? s.selected));
    const fitted=Math.max(.002,(host.clientWidth-102)/totalTime);
    timeScale=fit===false ? manualScale : fit===true ? fitted : Math.max(60,Math.min(180,fitted));
    if (fit!==false) zoomScales=scalesAround(timeScale);
    ctx.showZoom(zoomScales.indexOf(timeScale)+1,zoomScales.length);
    const timelineWidth=Math.max(host.clientWidth-98,totalTime*timeScale);
    const oldFrames = new Map();
    for (const image of host.querySelectorAll('img[data-thumb][src]')) {
      const key = image.dataset.thumb + '/' + image.dataset.time;
      if (!oldFrames.has(key)) oldFrames.set(key, []);
      oldFrames.get(key).push(image);
    }
    const canvas=el('div','sequence-canvas');
    waveforms.clear();
    canvas.style.setProperty('--sequence-width',timelineWidth+'px');
    function row(label, cls, key, tools) {
      const node=el('div','sequence-row '+cls), head=el('div','sequence-head');
      const track=el('div','sequence-content');
      if (key) {
        node.dataset.laneKey=key;
        const toggle=btn(label,()=>{setFold(node,key,!folded.has(key),true);ctx.scroll();});
        toggle.setAttribute('aria-expanded',String(!folded.has(key)));
        head.append(toggle);
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
      } else head.append(el('span','',label));
      if (tools) head.append(tools);
      node.append(head,track);canvas.append(node);
      return track;
    }
    function eventPosition(event,row) {
      const bounds=canvas.querySelector('.sequence-ruler .sequence-content').getBoundingClientRect();
      const node=event.target.closest('[data-drop-shot],[data-voice-shot]');
      const position=positionAt(event.clientX ? (event.clientX-bounds.left)/timeScale : playTime);
      if(node) {
        position.index=Number(node.dataset.dropShot ?? node.dataset.voiceShot);
        if(node.matches('.sequence-empty[data-candidate-index]')) position.videoLane=Number(node.dataset.candidateIndex);
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
      const position=eventPosition(event,node?.hasAttribute('data-voice-row') ? Number(node.dataset.voiceRow) : undefined);
      const d=dialog('时间轴');
      clipboardButtons(d,node,position);
      d.wrapper.showModal();
    });
    function block(track,from,duration,text,action,title) {
      const b=action ? btn(text,action,title ?? text) : el('span','',text);
      b.classList.add('sequence-block');
      b.style.left=(from*timeScale)+'px';
      b.style.width=Math.max(2,duration*timeScale-2)+'px';
      track.append(b);return b;
    }
    const ruler=row('时间','sequence-ruler');
    const step=[.25,.5,1,2,5,10,30,60,120,300,600,1800,3600].find((v)=>v*timeScale>=55) ?? 7200;
    for(let t=0;t<=timelineWidth/timeScale;t+=step) {
      const tick=el('span','sequence-tick',stamp(t)+(step<1 && t%1 ? '.'+String(Math.round((t%1)*100)).padStart(2,'0') : ''));
      tick.style.left=(t*timeScale)+'px';ruler.append(tick);
    }
    const videoCells=s.shots.map(shot=>{
      const cells=[];
      window.candidateVideoLanes(shot).forEach((lane,index)=>{cells[lane]=shot[index];});
      return cells;
    });
    const depth=Math.max(1,...videoCells.map(cells=>cells.length));
    for(let j=0;j<depth;j++) {
      const mute=btn(s.muted.has(j) ? '静' : '声',()=>ctx.mute(j,!s.muted.has(j)), '切换整行视频原声');
      const lane=row('视频 '+(j+1),'sequence-video','vis'+j,mute);
      for(let i=0;i<columns;i++) {
        const clip=videoCells[i]?.[j];
        const b=block(lane,shotTimes[i],widths[i],clip?.asset.name ?? '',clip ? (event)=>{
          focusShot=s.shots[i];focusClip=clip;voiceTarget=undefined;
          playTime=shotTimes[i];syncCursor();ctx.preview(clip);
          host.querySelector('.sequence-selected')?.classList.remove('sequence-selected');
          event.currentTarget.classList.add('sequence-selected');
        } : undefined);
        b.dataset.dropShot=String(i);
        b.dataset.candidateIndex=String(j);
        candidateSlots.set(b,{shot:s.shots[i],clip,lane:j});
        if (!clip) {
          b.classList.add('sequence-empty');
          b.title='从素材库拖入画面，添加到分镜 '+(i+1);
          continue;
        }
        bindMaterialSource(b, clip.asset);
        const owner=s.shots[i];
        selection.bind(b,clip,()=>ctx.removeClip(owner,clip));
        bindCopy(b,'视频',()=>ctx.copyClip(clip));
        b.dataset.moveCandidate='';
        b.onpointerdown=event=>{
          if(draggedCandidate || ctx.busy() || !event.isPrimary || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          liftCandidate(b,clip,owner,event);
        };
        b.onkeydown=event=>nudgeCandidate(event,b,clip,owner);
        if (clip.enabled===false) b.classList.add('sequence-disabled');
        if (clip===s.selected) b.classList.add('sequence-selected');
        const seconds=clipSpan(clip);
        const duration=Number.isFinite(seconds) ? seconds.toFixed(2)+' 秒' : '—';
        const name=el('span','sequence-clip-name',clip.asset.name);
        const label=el('span','sequence-clip-label');
        const match=Number.isFinite(clip.matchedDuration) ? clip.matchedDuration.toFixed(2)+' 秒 · 已匹配' : '';
        label.append(name,el('span','sequence-clip-duration',match || duration));
        b.replaceChildren(label);
        b.title=clip.asset.name+' · '+(match || '候选时长 '+duration)+(clip.asset.kind==='video' ? ' · 原片 '+clip.asset.duration.toFixed(2)+' 秒' : '')+' · 拖至视频轨下方新建轨道，Alt＋上下键换轨，Alt＋左右键移动分镜中的候选';
        b.setAttribute('aria-keyshortcuts','Control+C Control+V Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
        const frames=el('span','sequence-frames');
        const count=Math.max(1,Math.min(6,Math.ceil(widths[i]*timeScale/76)));
        const ranges=clip.ranges ?? [{start:clip.start,end:clip.end}];
        const retained=ranges.reduce((sum,r)=>sum+r.end-r.start,0);
        for(let n=0;n<count;n++) {
          let img=el('img','sequence-thumb');img.alt='';img.draggable=false;
          if(clip.asset.kind==='image') img.src=clip.asset.url;
          else {
            let remaining=retained*(n+.5)/count;
            let seconds=clip.start;
            for(const r of ranges){seconds=r.start+remaining;if(seconds<r.end) break;remaining-=r.end-r.start;}
            img.dataset.thumb=clip.asset.id;img.dataset.time=String(Math.max(0,seconds));
            img = oldFrames.get(img.dataset.thumb + '/' + img.dataset.time)?.pop() ?? img;
          }
          frames.append(img);
        }
        b.prepend(frames);
        waveforms.add(b,clip.asset,{ranges,head:clip.look?.head,tail:clip.look?.tail,
          volume:clip.volume,muted:!s.keepAudio || s.muted.has(j)});
        b.ondblclick=()=>{if (clip.asset.kind==='video') ctx.cut(clip); else editShot(s,i);};
        b.oncontextmenu=(e)=>{
          e.preventDefault();focusShot=s.shots[i];focusClip=clip;voiceTarget=undefined;
          const d=dialog('候选 · '+clip.asset.name);
          matchDurationButton(d,s,i,clip);
          clipboardButtons(d,b,eventPosition(e));
          d.body.append(btn(clip.enabled===false ? '参与混剪' : '排除此候选',()=>{ctx.toggleClip(clip); d.wrapper.close();}),
            btn('候选包装',()=>{d.wrapper.close();editLayer({key:'local'});}));
          d.body.append(btn('截取封面帧',()=>{d.wrapper.close();ctx.captureCover(clip);}));
          d.body.append(btn('画面处理 · 调色 / 滤镜 / 特效',()=>{d.wrapper.close();ctx.appearance(clip);}));
          if(clip.asset.kind==='video') d.body.append(btn('裁剪素材',()=>{d.wrapper.close();ctx.cut(clip);}),btn('AI 拆分',()=>{d.wrapper.close();ctx.scenes(clip.asset);}),
            btn('自动切片',()=>{d.wrapper.close();ctx.slices(clip.asset);}),btn('视频字幕',()=>{d.wrapper.close();ctx.captions(clip);}));
          d.wrapper.showModal();
        };
      }
    }
    const strip=row('分镜','sequence-shots','shot-strip');
    for(let i=0;i<columns;i++) {
      const shot=s.shots[i], cfg=s.settings[i] ?? {};
      const openShot=()=>{
        focusShot=shot;focusClip=shot?.includes(focusClip) ? focusClip : shot?.[0];voiceTarget=undefined;editShot(s,i);
      };
      const b=block(strip,shotTimes[i],widths[i],(cfg.name || '分镜 '+String(i+1).padStart(2,'0'))+' · '+summary(widths[i]),()=>{
        if(!shot) openShot();
      },[cfg.description,shot ? '左右拖动调整顺序，Alt＋左右方向键移动，双击编辑分镜' : '添加分镜'].filter(Boolean).join(' · '));
      if(shot) {
        selection.bind(b,shot,()=>removeItem(s.shots,shot),false);
        b.ondblclick=openShot;
        b.dataset.reorderShot='';
        b.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');
      }
      b.dataset.dropShot=String(i);
      candidateSlots.set(b,{shot});
      if(shot) b.oncontextmenu=(event)=>{
        event.preventDefault();const d=dialog('分镜 '+(i+1));
        matchDurationButton(d,s,i);
        clipboardButtons(d,b,eventPosition(event));
        if(i===0) d.body.append(btn('首分镜封面',()=>{d.wrapper.close();ctx.firstCover();}));
        d.wrapper.showModal();
      };
    }
    bindShotStrip(strip,[...s.shots]);
    function voiceBlock(lane,voice,from,span) {
      const asset=voice.asset;
      const si=s.shots.indexOf(voice.shot), delay=si>=0 ? s.voiceOffset(si,voice.row) : 0;
      const speed=asset ? s.voiceSpeed(asset,voice.shot,voice.row) : 1;
      const duration=!asset ? undefined : si>=0 ? s.voiceDuration(si,voice.row) : asset.duration/speed;
      const displayed=Math.min(Math.max(.1,span-delay),duration ?? span);
      const b=block(lane,from+delay,displayed,asset?.name ?? '',asset ? ()=>{
        voiceTarget=voice;focusShot=voice.shot;focusClip=undefined;ctx.voice(voice);
      } : undefined);
      if(asset) b.title=asset.name+' · '+speed+' 倍 · 右键调整倍速或复制口播';
      b.dataset.voiceRow=String(voice.row);
      if(si>=0) b.dataset.voiceShot=String(si);
      if (!asset) b.classList.add('sequence-empty');
      else {
        bindMaterialSource(b, asset);
        waveforms.add(b,asset,{ranges:voice.shot && s.voiceRanges(voice.shot,voice.row),span:displayed*speed,volume:s.voiceVolume(asset,voice.shot,voice.row)});
        selection.bind(b,'voice:'+si+'/'+voice.row+'/'+asset.id,()=>ctx.removeVoice(voice));
        b.ondblclick=()=>ctx.editVoice(voice);
        bindCopy(b,'口播',()=>ctx.copyVoice(voice));
        b.oncontextmenu=(e)=>{
          e.preventDefault();voiceTarget=voice;focusShot=voice.shot;focusClip=undefined;
          const d=dialog('口播 · '+asset.name);
          clipboardButtons(d,b,eventPosition(e,voice.row));
          d.body.append(btn('口播包装',()=>{d.wrapper.close();editLayer({key:'voice'});}));
          speedField(d,speed,value=>ctx.setVoiceSpeed(asset,voice.shot,voice.row,value));
          d.wrapper.showModal();
        };
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
      const cell=block(row('音乐 '+(i+1),'sequence-music','music'+i),start,totalTime-start,asset.name,()=>ctx.music(asset));
      bindMaterialSource(cell, asset);
      cell.title=asset.name+' · '+s.musicSpeed(asset)+' 倍 · 右键调整倍速';
      waveforms.add(cell,asset,{span:(totalTime-start)*s.musicSpeed(asset),loop:true,volume:s.musicVolume(asset)});
      selection.bind(cell,asset,()=>removeItem(s.music,asset));
      cell.oncontextmenu=(e)=>{e.preventDefault();const d=dialog('配乐 · '+asset.name);speedField(d,s.musicSpeed(asset),speed=>ctx.setMusicSpeed(asset,speed));d.wrapper.showModal();};
    }
    if(s.selected?.videoSubtitles && s.shots.some((shot)=>shot.includes(s.selected))) {
      const clip=s.selected, i=s.shots.findIndex((shot)=>shot.includes(clip));
      const lane=row('视频字幕','sequence-caption','local-subtitles');
      let elapsed=0;
      for(const range of clip.ranges ?? [{start:clip.start,end:clip.end}]) {
        for(const cue of clip.videoSubtitles.cues) {
          const begin=Math.max(range.start,cue.start/1000),end=Math.min(range.end,cue.end/1000);
          if(end>begin) {
            const cell=block(lane,shotTimes[i]+elapsed+(begin-range.start)/clip.speed,(end-begin)/clip.speed,cue.text,()=>{},'双击编辑字幕');
            bindCopy(cell,'字幕',()=>({text:cue.text,highlights:structuredClone(cue.highlights),duration:Math.max(1,Math.round((end-begin)/clip.speed*1000))}));
            selection.bind(cell,cue,()=>{
              if(!clip.videoSubtitles) return;
              removeItem(clip.videoSubtitles.cues,cue);
              if(!clip.videoSubtitles.cues.length) delete clip.videoSubtitles;
            });
            cell.ondblclick=()=>ctx.captions(clip);
          }
        }
        elapsed+=(range.end-range.start)/clip.speed;
      }
    }
    if(s.captions.length) {
      const lanes=new Map();
      for (const caption of s.captions) {
        if(!lanes.has(caption.row)) lanes.set(caption.row,row('口播字幕 '+(caption.row+1),'sequence-caption','caption'+caption.row));
        const offset=shotTimes[caption.shot] ?? shotTimes[caption.follow] ?? 0;
        const span=caption.shot==null ? totalTime-offset : widths[caption.shot];
        if(span>caption.start) {
          const cell=block(lanes.get(caption.row),offset+caption.start,Math.min(span-caption.start,caption.duration),caption.name,()=>{},'双击编辑口播字幕');
          bindCopy(cell,'字幕',()=>({text:caption.name,highlights:structuredClone(caption.highlights),duration:Math.max(1,Math.round(caption.duration*1000))}));
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
    function layerRow(target,items,start,span) {
      const lanes=new Map();
      for(const [i,layer] of (items ?? []).entries()) {
        const asset=ctx.asset(layer.id), limit=asset?.duration;
        const speed=layer.speed ?? 1;
        const sourceSpan=limit>0 ? (limit-(layer.mediaOffset ?? 0))/speed : Infinity;
        const length=Math.min(layer.end ?? Infinity,span,layer.start+sourceSpan)-layer.start;
        const id=layer.kind+'-'+(layer.laneId ?? i);
        if(!lanes.has(id)) lanes.set(id,row(target.label+' · '+kinds[layer.kind],'sequence-layer kind-'+layer.kind,target.label+'/'+(target.column ?? 0)+'/'+id));
        const lane=lanes.get(id);
        const title=layer.kind==='text' ? layer.text : asset?.name ?? kinds[layer.kind];
        let dragged=false;
        const cell=block(lane,start+layer.start,Math.max(.1,length),title,()=>{},title+' · 双击编辑');
        if (asset) bindMaterialSource(cell, asset);
        if (length>0 && (layer.kind==='sound' || layer.kind==='pip')) {
          const offset=layer.mediaOffset ?? 0;
          waveforms.add(cell,asset,{ranges:[{start:offset,end:offset+length*speed}],volume:layer.volume ?? (layer.kind==='pip'?0:100)});
        }
        selection.bind(cell,layer,()=>removeItem(items,layer));
        cell.ondblclick=()=>{
          if(!dragged) editLayer({...target,items,ensure:()=>items},layer);
        };
        const left=el('span','sequence-edge'),right=el('span','sequence-edge');
        left.title='调整入点';right.title='调整出点';cell.prepend(left);cell.append(right);
        cell.onpointerdown=(e)=>{
          if(e.button!==0 || ctx.busy() || length<=0) return;
          dragged=false;
          const edge=e.target===left ? 'left' : e.target===right ? 'right' : 'move';
          const x=e.clientX, original=layer.start, oldEnd=original+length;
          let a=original,b=oldEnd;
          const snap=(v)=>Math.round(v*1000)/1000;
          cell.setPointerCapture(e.pointerId);
          cell.onpointermove=(event)=>{
            if(Math.abs(event.clientX-x)<3 && !dragged) return;
            dragged=true;
            const delta=(event.clientX-x)/timeScale;
            if(edge==='left') a=snap(Math.max(Math.max(0,original-(layer.mediaOffset ?? 0)/speed),Math.min(b-.05,original+delta)));
            else if(edge==='right') b=snap(Math.min(span,original+sourceSpan,Math.max(a+.05,oldEnd+delta)));
            else {
              a=snap(Math.max(0,Math.min(span-.05,original+delta)));
              b=snap(a+length);
            }
            cell.style.left=(start+a)*timeScale+'px';cell.style.width=Math.max(2,(b-a)*timeScale-2)+'px';
          };
          cell.onpointerup=()=>{
            cell.onpointermove=cell.onpointerup=cell.onpointercancel=null;
            if(!dragged) return;
            if(edge==='left') layer.mediaOffset=snap((layer.mediaOffset ?? 0)+(a-original)*speed);
            layer.start=a;layer.end=edge==='move' && layer.end==null ? null : b;
            ctx.change();
          };
          cell.onpointercancel=()=>{cell.onpointermove=cell.onpointerup=cell.onpointercancel=null;refresh();};
        };
        cell.oncontextmenu=(e)=>{
          e.preventDefault();
          if(ctx.busy()) return;
          const at=(e.clientX-cell.getBoundingClientRect().left)/timeScale;
          const d=dialog('包装片段 · '+kinds[layer.kind]);
          const split=btn('在此处分割',()=>{
            const offset=Math.round(at*1000)/1000;
            const cut=layer.start+offset;
            layer.laneId ??= crypto.randomUUID();
            const after={...structuredClone(layer),start:cut,mediaOffset:(layer.mediaOffset ?? 0)+offset*speed};
            layer.end=cut;items.splice(i+1,0,after);d.wrapper.close();ctx.change();
          });
          split.disabled=at<.05 || length-at<.05;
          d.body.append(split,btn('编辑片段',()=>{d.wrapper.close();editLayer({...target,items,ensure:()=>items},layer);}));
          d.wrapper.showModal();
        };
      }
    }
    const p=s.pack;
    p.composites.forEach((items,i)=>layerRow({key:'comp'+i,label:'复合 '+(i+1)},items,0,totalTime));
    p.textGroups.forEach((cols,i)=>cols.forEach((items,j)=>{if(p.textMode==='segmented' || j===0) layerRow({key:'text'+i,label:'文字组 '+(i+1),column:j},items,shotTimes[j] ?? 0,p.textMode==='segmented' ? widths[j] : totalTime);}));
    layerRow({key:'global',label:'全局'},p.global,0,totalTime);
    s.shots.forEach((shot,i)=>shot.forEach((clip,j)=>layerRow({key:'local',label:'候选 '+(i+1)+'-'+(j+1)},clip.layers,shotTimes[i],widths[i])));
    if(s.segmented) p.segmentNarration.forEach((tracks,i)=>tracks.forEach((items,j)=>layerRow({key:'voice',label:'口播 '+(i+1)+'-'+(j+1)},items,shotTimes[i] ?? 0,widths[i] ?? 0)));
    else p.wholeNarration.forEach((items,i)=>layerRow({key:'voice',label:'整段口播 '+(i+1)},items,0,totalTime));
    const cursor=el('i','sequence-cursor');canvas.append(cursor);
    const hover=el('i','sequence-hover');hover.hidden=true;canvas.append(hover);
    function eventTime(e) {return Math.max(0,Math.min(totalTime,(e.clientX-ruler.getBoundingClientRect().left)/timeScale));}
    canvas.onpointermove=(e)=>{hover.hidden=Boolean(draggedCandidate) || shotDrag?.active || scrubPointer!=null || resizeDrag!=null || !ctx.showAxis();hover.style.left=(96+eventTime(e)*timeScale)+'px';};
    canvas.onpointerleave=()=>{hover.hidden=true;};
    canvas.onpointerdown=(e)=>{
      if(e.button!==0 || scrubPointer!=null || resizeDrag || (!ruler.contains(e.target) && e.target!==cursor)) return;
      e.preventDefault();
      scrubPointer=e.pointerId;scrubX=e.clientX;hover.hidden=true;
      host.setPointerCapture(e.pointerId);
      ctx.pause();
      scrubAt(scrubX);
    };
    canvas.addEventListener('click',(e)=>{if(e.target.classList.contains('sequence-content') && e.target!==ruler) {voiceTarget=undefined;focusClip=undefined;ctx.clear();}});
    const restoreFocus=host.contains(document.activeElement);
    thumbObserver.disconnect();thumbQueue.length=0;host.replaceChildren(canvas);
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
    if (zoomAnchor) {
      host.scrollLeft=zoomAnchor.time*timeScale-zoomAnchor.offset;
      zoomAnchor=undefined;
    }
    syncCursor();ctx.scroll();
    if(candidateLandings) {
      for(const {clip,from,newLane} of candidateLandings) {
        const node=candidateButton(s.shots,clip);
        if(!node) continue;
        if(newLane) revealCandidateLane(node);
        animateCandidateFrom(node,from);
      }
      candidateLandings=undefined;
    }
  }
  function zoom(level, clientX) {
    const next=zoomScales[level-1];
    if (!next) return;
    manualScale=next;
    const nearest=standardScales.reduce((best,scale)=>Math.abs(Math.log(scale/next))<Math.abs(Math.log(best/next)) ? scale : best);
    ctx.setCardZoom(standardScales.indexOf(nearest)+1);
    fit=false;
    zoomAnchor=undefined;
    if (clientX!==undefined && host.clientWidth) {
      const offset=Math.max(0,clientX-host.getBoundingClientRect().left-96);
      zoomAnchor={offset,time:(host.scrollLeft+offset)/timeScale};
    }
    refresh();
  }
  function syncCursor() {
    const cursor=host.querySelector('.sequence-cursor');
    if(!cursor) return;
    const time=Math.min(totalTime,playTime);
    cursor.hidden=!ctx.showAxis() || time<host.scrollLeft/timeScale;
    cursor.style.left=(96+time*timeScale)+'px';
  }
  host.addEventListener('scroll',syncCursor,{passive:true});
  function setFold(node,key,value,animate=false) {
    if(value) folded.add(key); else folded.delete(key);
    node.classList.toggle('animate-lane-fold',animate);
    node.classList.toggle('sequence-folded',value);
    node.querySelector('[aria-expanded]').setAttribute('aria-expanded',String(!value));
  }
  function resizeLane(node,key,size) {
    const compact=size<=17;
    if(!compact) {
      heights.set(key,Math.round(size));
      node.style.setProperty('--lane-height',heights.get(key)+'px');
    }
    setFold(node,key,compact);
    ctx.scroll();
  }
  function endResize(commit) {
    if (!resizeDrag) return;
    const {node,key,handle,id,savedHeight,wasFolded}=resizeDrag;
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
  function scrubAt(x) {
    draftTransport.stop();
    const ruler=host.querySelector('.sequence-ruler .sequence-content');
    if(!ruler) return;
    const viewport=host.getBoundingClientRect();
    const visibleX=Math.max(viewport.left+96,Math.min(viewport.right,x));
    playTime=Math.max(0,Math.min(totalTime,(visibleX-ruler.getBoundingClientRect().left)/timeScale));
    pastePosition=positionAt(playTime);
    syncCursor();
    if(ctx.seekComposition(playTime)) return;
    const index=shotTimes.findLastIndex((t)=>t<=playTime);
    const shot=lastState?.shots[index];
    const clip=shot?.includes(focusClip) ? focusClip : shot?.find((c)=>c.enabled!==false);
    if(!clip) {
      if(activeSeek!==null) ctx.clear();
      activeSeek=null;
      return;
    }
    focusShot=shot;focusClip=clip;
    const offset=(playTime-shotTimes[index])*clipSpan(clip)/widths[index];
    ctx.seek(clip,offset);
    activeSeek=clip;
  }
  function frameScrub() {
    scrubFrame=undefined;
    if(scrubPointer==null) return;
    const bounds=host.getBoundingClientRect();
    const overflow=scrubX-(bounds.right-14);
    const underflow=scrubX-(bounds.left+96+14);
    const step=overflow>0 ? Math.ceil(overflow/3) : underflow<0 ? Math.floor(underflow/3) : 0;
    const before=host.scrollLeft;
    if(step) host.scrollLeft+=Math.max(-36,Math.min(step,36));
    scrubAt(scrubX);
    if(host.scrollLeft!==before) scrubFrame=requestAnimationFrame(frameScrub);
  }
  window.addEventListener('pointermove',(event)=>{
    if(event.pointerType==='mouse' && !(event.buttons&1)) {
      if(resizeDrag?.id===event.pointerId || event.pointerId===scrubPointer) endDrag(event);
      return;
    }
    if(resizeDrag?.id===event.pointerId) {
      const {node,key,height,y}=resizeDrag;
      resizeLane(node,key,height+event.clientY-y);
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
    }
    if(resizeDrag?.id===event.pointerId) endResize(event.type==='pointerup');
    if(host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  }
  for(const type of ['pointerup','pointercancel']) window.addEventListener(type,endDrag,true);
  window.addEventListener('blur',()=>{
    scrubPointer=undefined;endResize(false);cancelAnimationFrame(scrubFrame);scrubFrame=undefined;
  });
  function syncPlayer(clip,sourceTime) {
    if(draftTransport.state()) return;
    if (!lastState || !clip || !host.clientWidth || scrubPointer!=null || (clip.asset.kind==='video' && ctx.seekPending())) return;
    activeSeek=undefined;
    if(ctx.isComposition(clip)){playTime=sourceTime;syncCursor();return;}
    const index=lastState.shots.findIndex((shot)=>shot.includes(clip));
    if(index<0) return;
    let elapsed=Math.max(0,sourceTime-clip.start);
    if(clip.ranges?.length) {
      let amount=0;
      for(const range of clip.ranges) {
        if(sourceTime>=range.start && sourceTime<=range.end) {elapsed=amount+sourceTime-range.start; break;}
        amount+=range.end-range.start;
      }
    }
    const ratio=Math.min(1,Math.max(0,elapsed-(clip.look?.head??0))/(clip.speed||1)/clipSpan(clip));
    playTime=shotTimes[index]+widths[index]*ratio; syncCursor();
  }
  function refresh(key,keepDraftPlayback=false) {
    if(!keepDraftPlayback && key!==undefined && lastKey!==undefined && key!==lastKey) draftTransport.stop();
    if(key!==undefined && key===lastKey) return;
    cachedDraftDuration=undefined;
    if (key!==undefined) lastKey=key;
    if(refreshFrame===undefined) refreshFrame=requestAnimationFrame(draw);
  }
  function stopCandidateMotion(node) {
    for(const motion of node.getAnimations()) if(motion.id==='candidate-arrival') motion.cancel();
  }
  function candidateButton(shots,clip) {
    const i=shots.findIndex(shot=>shot.includes(clip));
    if(i<0) return;
    const lane=window.candidateVideoLanes(shots[i])[shots[i].indexOf(clip)];
    return host.querySelector('[data-drop-shot="'+i+'"][data-candidate-index="'+lane+'"]');
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
  function animateCandidateFrom(node,from) {
    if(!from || !candidateMotion.matches) return;
    const to=node.getBoundingClientRect();
    if(!to.width || !to.height) return;
    const start='translate('+(from.left-to.left)+'px,'+(from.top-to.top)+'px) scale('+from.width/to.width+','+from.height/to.height+')';
    node.animate([{transform:start},{transform:'none'}],{
      id:'candidate-arrival',duration:200,easing:'cubic-bezier(.2,.75,.25,1)',
    });
  }
  function slotMarker(button) {
    const marker=el('i','candidate-slot candidate-vacancy');
    marker.setAttribute('aria-hidden','true');
    marker.style.left=button.style.left;marker.style.width=button.style.width;
    button.parentElement.append(marker);
    return marker;
  }
  function liftCandidate(button,clip,owner,event) {
    const from=button.getBoundingClientRect();
    stopCandidateMotion(button);
    const home=slotMarker(button), x=event.clientX, y=event.clientY;
    draggedCandidate={button,clip,owner,home,id:event.pointerId,startX:x,startY:y,x,y};
    // A manual popover puts the actual frames and waveform above the scrolling pane.
    // Keep the normal slot and its inline timeline coordinates intact for hit testing.
    button.style.setProperty('--lift-left',from.left+'px');
    button.style.setProperty('--lift-top',from.top+'px');
    button.style.setProperty('--lift-width',from.width+'px');
    button.style.setProperty('--lift-height',from.height+'px');
    button.style.transformOrigin=(x-from.left)+'px '+(y-from.top)+'px';
    button.classList.add('candidate-moving');
    host.dataset.candidateDrag='pressed';
  }
  function showNewCandidateLane(drag) {
    const lane=host.querySelectorAll('.sequence-video').length;
    const reason=ctx.candidatePlacementError(drag.clip,drag.owner,drag.owner,undefined,lane);
    const row=el('div','sequence-row candidate-new-lane');
    const track=el('div','sequence-content');
    const placement=el('div','candidate-slot candidate-new-placement');
    placement.style.left=drag.home.style.left;
    placement.style.width=drag.home.style.width;
    placement.append(drag.button.querySelector('.sequence-frames').cloneNode(true),
      drag.button.querySelector('.sequence-clip-label').cloneNode(true));
    track.append(placement);
    row.append(el('div','sequence-head',reason ? '视频轨已满' : '新建视频 '+(lane+1)),track);
    host.querySelector('.sequence-shots').before(row);
    candidateSlots.set(track,{shot:drag.owner,lane,newLane:true});
    drag.newLane=track;
    const bottom=host.parentElement.querySelector('#new-shot-drop');
    drag.bottom={node:bottom,text:bottom.textContent,label:bottom.ariaLabel,disabled:bottom.ariaDisabled};
    bottom.textContent=reason || '拖到这里新建视频 '+(lane+1)+' 轨道';
    bottom.ariaLabel=bottom.textContent;
    bottom.ariaDisabled=String(Boolean(reason));
  }
  function setDisplaced(button,home) {
    const from=button.getBoundingClientRect();
    stopCandidateMotion(button);
    button.classList.remove('candidate-displaced');
    button.style.removeProperty('--slot-offset');
    button.style.removeProperty('--slot-width');
    button.style.removeProperty('--slot-height');
    if(home) {
      const here=button.getBoundingClientRect(), to=home.getBoundingClientRect();
      button.style.setProperty('--slot-offset',(to.left-here.left)+'px '+(to.top-here.top)+'px');
      button.style.setProperty('--slot-width',to.width+'px');
      button.style.setProperty('--slot-height',to.height+'px');
      button.classList.add('candidate-displaced');
    }
    animateCandidateFrom(button,from);
  }
  function markCandidateDrop(drag,node) {
    if(node===drag.target) return;
    if(drag.target) {
      delete drag.target.dataset.materialDrop;
      delete drag.target.dataset.candidateRejected;
      if(drag.target.classList.contains('candidate-displaced')) setDisplaced(drag.target);
      drag.vacancy?.remove();
      drag.vacancy=undefined;
    }
    drag.target=node;
    const slot=candidateSlots.get(node);
    const reason=slot ? ctx.candidatePlacementError(drag.clip,slot.shot,drag.owner,slot.clip,slot.lane) : '';
    dropHint.toggleAttribute('data-new-lane',Boolean(slot?.newLane && !reason));
    dropHint.textContent=reason || (slot?.newLane ? '松开以移至视频 '+(slot.lane+1)+' · 分镜 '+(Number(drag.button.dataset.dropShot)+1) : '');
    host.toggleAttribute('data-drag-rejected',Boolean(reason));
    drag.home.classList.toggle('candidate-vacancy',!slot || Boolean(reason) || !slot.clip);
    if(!slot) return;
    if(reason) node.dataset.candidateRejected='';
    else {
      node.dataset.materialDrop='active';
      if(slot.clip) {
        drag.vacancy=slotMarker(node);
        setDisplaced(node,drag.home);
      }
    }
  }
  function candidateUnderPointer(drag,x,y) {
    if(ctx.busy()) return;
    const hit=document.elementFromPoint(x,y);
    if(drag.newLane?.parentElement.contains(hit) || hit===drag.bottom?.node) return drag.newLane;
    const canvas=drag.home.closest('.sequence-canvas'), panel=host.closest('#timeline-tracks-panel');
    if(hit===canvas || hit===host || hit===panel) {
      const bounds=host.getBoundingClientRect(), view=panel.getBoundingClientRect();
      if(x>=bounds.left+96 && x<Math.min(bounds.right,view.left+panel.clientLeft+panel.clientWidth) &&
         (hit===canvas || y>=bounds.bottom) && y<view.top+panel.clientTop+panel.clientHeight) return drag.newLane;
    }
    if(!hit || !host.contains(hit)) return;
    const track=hit.closest('.sequence-video .sequence-content');
    let node;
    if(track) {
      // Only track geometry participates. A clip sliding across another slot must
      // never become the destination simply because its animation crosses the mouse.
      const time=(x-track.getBoundingClientRect().left)/timeScale;
      if(time<0 || time>=totalTime) return;
      node=track.children[positionAt(time).index];
    } else node=hit.closest('.sequence-shots [data-drop-shot]');
    const slot=candidateSlots.get(node);
    if(slot?.shot && (slot.shot!==drag.owner || (slot.lane!==undefined && slot.clip!==drag.clip))) return node;
  }
  function scrollCandidateDrag(now) {
    const drag=draggedCandidate;
    if(!drag?.active || drag.cancelled) return;
    drag.frame=undefined;
    const view=host.closest('#timeline-tracks-panel');
    const area=host.getBoundingClientRect(), bounds=view.getBoundingClientRect();
    const elapsed=Math.max(.001,Math.min(.05,(now-drag.lastScroll)/1000));
    drag.lastScroll=now;
    if(drag.x>=area.left && drag.x<=area.right && drag.y>=bounds.top && drag.y<=bounds.bottom) {
      const step=(p,low,high)=>p<low+16 ? Math.max(-20,p-low-16) : Math.max(0,Math.min(20,p-high+16));
      const dx=step(drag.x,area.left+96,area.right), dy=step(drag.y,bounds.top,bounds.bottom);
      const left=host.scrollLeft,top=view.scrollTop;
      if(dx) host.scrollLeft+=Math.sign(dx)*Math.max(1,Math.abs(dx)*90*elapsed);
      if(dy) view.scrollTop+=Math.sign(dy)*Math.max(1,Math.abs(dy)*45*elapsed);
      if(left!==host.scrollLeft || top!==view.scrollTop) drag.frame=requestAnimationFrame(scrollCandidateDrag);
    }
  }
  window.addEventListener('scroll',()=>{
    const drag=draggedCandidate;
    if(drag?.active && !drag.cancelled) markCandidateDrop(drag,candidateUnderPointer(drag,drag.x,drag.y));
  },{capture:true,passive:true});
  function updateCandidate(drag,x,y) {
    const dx=x-drag.startX,dy=y-drag.startY;
    drag.button.style.translate=dx+'px '+dy+'px';
    drag.x=x;drag.y=y;
    if(!drag.active) {
      if(Math.hypot(dx,dy)<5) return;
      drag.active=true;
      drag.button.popover='manual';drag.button.showPopover();
      showNewCandidateLane(drag);
      host.dataset.candidateDrag='active';
      host.setPointerCapture(drag.id);
    }
    if(drag.frame===undefined) {
      drag.lastScroll=performance.now()-16;
      drag.frame=requestAnimationFrame(scrollCandidateDrag);
    }
    markCandidateDrop(drag,candidateUnderPointer(drag,x,y));
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
  }
  function placeAtSlot(clip,owner,slot) {
    if(!slot || ctx.busy()) return false;
    const i=ctx.state().shots.indexOf(slot.shot);
    if(!ctx.placeCandidate(clip,slot.shot,owner,slot.clip,slot.lane)) return false;
    focusShot=slot.shot;focusClip=clip;voiceTarget=undefined;
    ctx.preview(clip);
    selection.selectOnly(clip);
    pastePosition={index:i,time:shotTimes[i]};
    if(slot.newLane) ctx.notify('已新建视频 '+(slot.lane+1)+' 轨道，片段保留在分镜 '+(i+1)+'。');
    else if(slot.shot===owner) ctx.notify('候选已移至视频 '+(slot.lane+1)+' 轨道。');
    else ctx.notify(slot.clip ? '已与分镜 '+(i+1)+' 的候选交换。' : '已移动至分镜 '+(i+1)+'。');
    return true;
  }
  function nudgeCandidate(event,button,clip,owner) {
    if(draggedCandidate || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey ||
      !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || ctx.busy()) return;
    event.preventDefault();event.stopPropagation();
    const i=Number(button.dataset.dropShot);
    let slot;
    if(event.key==='ArrowUp' || event.key==='ArrowDown') {
      const rows=host.querySelectorAll('.sequence-video');
      const lane=candidateSlots.get(button).lane+(event.key==='ArrowUp'?-1:1);
      slot=lane===rows.length ? {shot:owner,lane,newLane:true}
        : candidateSlots.get(rows[lane]?.querySelector('[data-drop-shot="'+i+'"]'));
    } else slot=candidateSlots.get(button.parentElement.children[i+(event.key==='ArrowLeft'?-1:1)]);
    if(!slot?.shot) return;
    try {
      if(placeAtSlot(clip,owner,slot)) {
        requestAnimationFrame(()=>candidateButton(ctx.state().shots,clip)?.focus());
      }
    } catch(error) {ctx.notify(error.message);}
  }
  function finishCandidateDrag(commit) {
    const drag=draggedCandidate;
    if(!drag) return;
    const target=drag.target, displaced=candidateSlots.get(target)?.clip;
    const from=drag.active && !drag.cancelled ? drag.button.getBoundingClientRect() : null;
    const otherFrom=target?.classList.contains('candidate-displaced') && target.getBoundingClientRect();
    draggedCandidate=undefined;
    if(!drag.cancelled) dockCandidate(drag);
    if(host.hasPointerCapture(drag.id)) host.releasePointerCapture(drag.id);
    if(resizeAfterCandidate) {resizeAfterCandidate=false;refresh();}
    if(commit && from && target) {
      try {
        const slot=candidateSlots.get(target);
        if(placeAtSlot(drag.clip,drag.owner,slot)) {
          candidateLandings=[{clip:drag.clip,from,newLane:slot.newLane}];
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
    updateCandidate(drag,event.clientX,event.clientY);
  },true);
  window.addEventListener('pointerup',event=>{
    const drag=draggedCandidate;
    if(!drag || event.pointerId!==drag.id) return;
    if(drag.active && !drag.cancelled) updateCandidate(drag,event.clientX,event.clientY);
    if(drag.active || drag.cancelled) suppressDragClick();
    finishCandidateDrag(!drag.cancelled);
  },true);
  window.addEventListener('keydown',event=>{
    const drag=draggedCandidate;
    if(event.key!=='Escape' || !drag || drag.cancelled) return;
    event.preventDefault();event.stopPropagation();
    const from=drag.active && drag.button.getBoundingClientRect();
    dockCandidate(drag);
    animateCandidateFrom(drag.button,from);
    drag.cancelled=true;
  },true);
  host.addEventListener('lostpointercapture',event=>{
    // Chromium can relinquish capture while the primary button is still down.
    // The window listeners continue tracking that press through release or cancellation.
    if(event.target===host && draggedCandidate?.id===event.pointerId && !(event.buttons&1)) finishCandidateDrag(false);
  });
  window.addEventListener('pointercancel',event=>{if(draggedCandidate?.id===event.pointerId) finishCandidateDrag(false);},true);
  window.addEventListener('blur',()=>finishCandidateDrag(false));
  host.ondragover=(e)=>{
    const b=e.target.closest('[data-drop-shot]');
    if (b && e.dataTransfer.types.includes('application/x-jiajian-scene-cut')) {
      e.stopPropagation(); e.preventDefault();e.dataTransfer.dropEffect='copy';
    }
  };
  host.ondrop=(e)=>{
    const b=e.target.closest('[data-drop-shot]');
    if(!b) return;
    const index=Number(b.dataset.dropShot);
    if(e.dataTransfer.types.includes('application/x-jiajian-scene-cut')) {
      e.preventDefault();e.stopPropagation();
      const lane=b.matches('.sequence-empty[data-candidate-index]') ? Number(b.dataset.candidateIndex) : undefined;
      ctx.dropScene(e,index,lane);
    }
  };
  let observedWidth;
  new ResizeObserver(([entry])=>{
    if(observedWidth===entry.contentRect.width) return;
    observedWidth=entry.contentRect.width;
    // A temporary drop row can make the panel scrollbar appear during the gesture.
    if(draggedCandidate?.active) resizeAfterCandidate=true;
    else refresh();
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
    block.dataset.clipSource = asset.sourceKey ?? asset.id;
    block.classList.toggle('material-instance', block.dataset.clipSource === locatedMaterial);
  }
  function locateMaterial(source, reveal = false) {
    locatedMaterial = source;
    let first;
    for (const block of host.querySelectorAll('[data-clip-source]')) {
      const match = block.dataset.clipSource === source;
      block.classList.toggle('material-instance', match);
      if (match && (!first || Number(block.dataset.dropShot) < Number(first.dataset.dropShot))) first = block;
    }
    if (reveal && first && host.clientWidth) {
      const panel = host.closest('#timeline-tracks-panel');
      const area = host.getBoundingClientRect(), rect = first.getBoundingClientRect();
      const left = area.left + (first.closest('.sequence-row')?.firstElementChild.offsetWidth ?? 0);
      const viewport = panel.getBoundingClientRect();
      const visible = Array.from(host.querySelectorAll('.material-instance')).some(block => {
        const bounds = block.getBoundingClientRect();
        return bounds.left >= left && bounds.left < area.right && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
      });
      if (visible) return;
      if (rect.left < left || rect.left >= area.right) host.scrollLeft += rect.left - left;
      if (rect.top < viewport.top) panel.scrollTop += rect.top - viewport.top;
      else if (rect.bottom > viewport.bottom) panel.scrollTop += rect.bottom - viewport.bottom;
    }
  }
  function selectClip(clip) {
    cachedDraftDuration=undefined;
    draftTransport.stop();
    activeSeek=undefined;
    if(!lastState || !host.clientWidth) return;
    const i=lastState.shots.findIndex((shot)=>shot.includes(clip));
    host.querySelector('.sequence-selected')?.classList.remove('sequence-selected');
    if(i>=0) {
      focusShot=lastState.shots[i];focusClip=clip;voiceTarget=undefined;
      candidateButton(lastState.shots,clip)?.classList.add('sequence-selected');
    }
    if(i>=0 && lastState.selected!==clip && lastState.shots[i].length>1) {
      const layout=window.draftTimeline.timing(lastState,clipSpan,ctx.asset,clip);
      if(layout.widths.some((width,index)=>Math.abs(width-widths[index])>.001)) {
        if(scrubPointer==null) playTime=layout.starts[i];
        refresh();
      }
    }
    if(lastState.selected!==clip && (clip?.videoSubtitles || lastState.selected?.videoSubtitles)) refresh();
  }
  return {refresh,syncPlayer,selectClip,locateMaterial,editCaptions,openCardMatchMenu,removeSelected:selection.removeSelection,clearSelection:selection.clear,get selectionCount(){return selection.size;},textSettings:()=>textSettings(ctx.state()),
    toggleDraftPlayback:()=>draftTransport.toggle(draftTransport.playing()?[]:draftPlan(),playTime),
    seekDraft:draftTransport.seek,draftState:draftTransport.state,
    stopDraftPlayback:draftTransport.stop,isDraftPlaying:draftTransport.playing,
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
      finishCandidateDrag(false);
      pastePosition=undefined;
      if(newProject) clipboard=undefined;
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

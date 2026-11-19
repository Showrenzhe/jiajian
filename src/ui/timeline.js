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
    const alternatives = (groups) => Math.max(1, groups.filter(Boolean).length);
    let total = alternatives(data.composites.map((row) => row.length));
    if (data.textMode === 'segmented' && data.textSelection === 'random') {
      for (let i = 0; i < shots.length; i++) total = Math.min(50, total * alternatives(data.textGroups.map((row) => row[i]?.length)));
    } else total *= alternatives(data.textGroups.map((row) => data.textMode === 'whole' ? row[0]?.length : row.some((col) => col.length)));
    return total;
  }
  return {forShots, load, choices};
};

window.candidatePlaybackSeconds = function (clip) {
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
    wrapper.addEventListener('close', () => wrapper.remove(), {once: true});
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
  let focusShot, focusClip, voiceTarget, rowDrag;
  let timeScale = 55, totalTime = 0, shotTimes = [], widths = [];
  const draftTransport=window.draftTimeline.transport(document.querySelector('.preview-stage'),{
    tick:(time)=>{playTime=time;syncCursor();}, changed:(playing)=>ctx.draftPlaybackChanged?.(playing),
  });
  function draftPlan() {
    const state=ctx.state();
    const layout=window.draftTimeline.timing(state,clipSpan,ctx.asset);
    return window.draftTimeline.makePlan(state,layout,ctx.asset,window.waveformSource,focusClip ?? state.selected);
  }
  const folded = new Set();
  const heights = new Map();
  let scrubPointer, scrubX, scrubFrame, activeSeek;
  let resizeDrag;
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
  function editLayer(initialTarget, existing, initialKind) {
    if (ctx.busy()) return;
    const s = ctx.state();
    const ti = s.shots.indexOf(focusShot);
    const available=targets(s,ti,focusClip,voiceTarget);
    const groups = existing ? [initialTarget,...available.filter((g)=>g.key!==initialTarget.key && (existing.kind==='text' || !g.key.startsWith('text')))] : available;
    const selectedKey = initialTarget?.key ?? (voiceTarget ? 'voice' : 'global');
    const d = dialog(existing ? '编辑包装片段' : '添加包装轨道');
    const scope = choice(groups.map((g)=>[g.key,g.label]), groups.some((g)=>g.key===selectedKey) ? selectedKey : 'global');
    const type = choice(Object.entries(kinds), existing?.kind ?? initialKind ?? 'text');
    const content = el('textarea'); content.maxLength = 4096; content.value = existing?.text ?? '';
    const begin = input('number',existing?.start ?? 0,0,null,.001), end = input('number',existing?.end,0,null,.001);
    end.placeholder = '随所属轨道结束';
    const x = input('number',(existing?.x ?? .5)*100,0,100,.1), y = input('number',(existing?.y ?? .5)*100,0,100,.1);
    const scale = input('number',(existing?.scale ?? (type.value === 'text' ? 1 : .35))*100,5,100,.1);
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
      removeBackdrop.hidden = type.value !== 'pip';
      appearance.hidden=type.value!=='pip';
      for (const f of visuals) f.hidden=audio;
      for (const f of fontFields) f.hidden=!text;
    }
    type.onchange=()=>{media=null; chooseAsset.textContent='选择文件'; scale.value=type.value==='text' ? 100 : 35; volume.value=type.value==='pip' ? 0 : 100; setKind();};
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
  function draw() {
    refreshFrame=undefined;
    if (!host.clientWidth) return;
    const s=ctx.state();
    lastState=s;
    const index=s.shots.indexOf(focusShot);
    if (index<0) {focusShot=undefined;focusClip=undefined;}
    const columns=s.shots.length || 3;
    ({widths,starts:shotTimes,total:totalTime}=window.draftTimeline.timing(s,clipSpan,ctx.asset));
    const fitted=Math.max(.002,(host.clientWidth-102)/totalTime);
    timeScale=fit===true ? fitted : fit===null ? Math.max(60,Math.min(180,fitted)) : [16,32,60,100,180][Number(ctx.zoom())-1];
    const timelineWidth=Math.max(host.clientWidth-98,totalTime*timeScale);
    const canvas=el('div','sequence-canvas');
    waveforms.clear();
    canvas.style.setProperty('--sequence-width',timelineWidth+'px');
    function row(label, cls, key, tools) {
      const node=el('div','sequence-row '+cls), head=el('div','sequence-head');
      const track=el('div','sequence-content');
      if (key) {
        node.dataset.laneKey=key;
        const toggle=btn(label,()=>{setFold(node,key,!folded.has(key));ctx.scroll();});
        toggle.setAttribute('aria-expanded',String(!folded.has(key)));
        head.append(toggle);
        if (folded.has(key)) node.classList.add('sequence-folded');
        const handle=el('span','sequence-height-handle');
        handle.tabIndex=0;
        handle.setAttribute('role','separator');
        handle.setAttribute('aria-orientation','horizontal');
        handle.setAttribute('aria-label',label+'轨道高度');
        handle.title='上下拖动调整轨高，双击恢复默认';
        handle.onpointerdown=(event)=>{
          if(event.button!==0 || resizeDrag || scrubPointer!=null) return;
          event.preventDefault();
          resizeDrag={key,node,y:event.clientY,height:node.offsetHeight,id:event.pointerId};
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
    function block(track,from,duration,text,action,title) {
      const b=btn(text,action,title ?? text);
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
    const depth=Math.max(1,...s.shots.map((shot)=>shot.length));
    for(let j=0;j<depth;j++) {
      const mute=btn(s.muted.has(j) ? '静' : '声',()=>ctx.mute(j,!s.muted.has(j)), '切换整行视频原声');
      const lane=row('视频 '+(j+1),'sequence-video','vis'+j,mute);
      for(let i=0;i<columns;i++) {
        const clip=s.shots[i]?.[j];
        const b=block(lane,shotTimes[i],widths[i],clip ? clip.asset.name : '＋ 候选',(event)=>{
          if (!clip) {ctx.importShot(s.shots[i],i);return;}
          focusShot=s.shots[i];focusClip=clip;voiceTarget=undefined;ctx.preview(clip);
          host.querySelector('.sequence-selected')?.classList.remove('sequence-selected');
          event.currentTarget.classList.add('sequence-selected');
        });
        b.dataset.dropShot=String(i);
        b.dataset.candidateIndex=String(j);
        if (!clip) {b.classList.add('sequence-empty');continue;}
        const owner=s.shots[i];
        selection.bind(b,clip,()=>ctx.removeClip(owner,clip));
        if (clip.enabled===false) b.classList.add('sequence-disabled');
        if (clip===s.selected) b.classList.add('sequence-selected');
        const seconds=clipSpan(clip);
        const duration=Number.isFinite(seconds) ? seconds.toFixed(2)+' 秒' : '—';
        const name=el('span','sequence-clip-name',clip.asset.name);
        const label=el('span','sequence-clip-label');
        label.append(name,el('span','sequence-clip-duration',duration));
        b.replaceChildren(label);
        b.title=clip.asset.name+' · 候选时长 '+duration+(clip.asset.kind==='video' ? ' · 原片 '+clip.asset.duration.toFixed(2)+' 秒' : '');
        const frames=el('span','sequence-frames');
        const count=Math.max(1,Math.min(6,Math.ceil(widths[i]*timeScale/76)));
        const ranges=clip.ranges ?? [{start:clip.start,end:clip.end}];
        const retained=ranges.reduce((sum,r)=>sum+r.end-r.start,0);
        for(let n=0;n<count;n++) {
          const img=el('img','sequence-thumb');img.alt='';img.draggable=false;
          if(clip.asset.kind==='image') img.src=clip.asset.url;
          else {
            let remaining=retained*(n+.5)/count;
            let seconds=clip.start;
            for(const r of ranges){seconds=r.start+remaining;if(seconds<r.end) break;remaining-=r.end-r.start;}
            img.dataset.thumb=clip.asset.id;img.dataset.time=String(Math.max(0,seconds));
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
      },cfg.description || '双击编辑分镜，拖动调整顺序');
      if(shot) {
        selection.bind(b,shot,()=>removeItem(s.shots,shot),false);
        b.ondblclick=openShot;
      }
      b.dataset.dropShot=String(i);b.draggable=!!shot;
      if(i===0 && shot) b.oncontextmenu=(event)=>{event.preventDefault();ctx.firstCover();};
      b.ondragstart=(e)=>{rowDrag=shot;e.dataTransfer.setData('application/x-jiajian-shot',String(i)); e.dataTransfer.effectAllowed='move';};
      b.ondragend=()=>{rowDrag=undefined;};
    }
    function voiceBlock(lane,voice,from,span) {
      const asset=voice.asset;
      const si=s.shots.indexOf(voice.shot), delay=si>=0 ? s.voiceOffset(si,voice.row) : 0;
      const duration=si>=0 ? s.voiceDuration(si,voice.row) : asset?.duration;
      const displayed=Math.min(Math.max(.1,span-delay),duration ?? span);
      const b=block(lane,from+delay,displayed,asset?.name ?? '＋ 添加口播',()=>{
        if (asset) {voiceTarget=voice;focusShot=voice.shot;focusClip=undefined;ctx.voice(voice);}
        else ctx.addVoice(voice);
      });
      b.dataset.voiceRow=String(voice.row);
      if(si>=0) b.dataset.voiceShot=String(si);
      if (!asset) b.classList.add('sequence-empty');
      else {
        waveforms.add(b,asset,{ranges:voice.shot && s.voiceRanges(voice.shot,voice.row),span:displayed,volume:s.voiceVolume(asset,voice.shot,voice.row)});
        selection.bind(b,'voice:'+si+'/'+voice.row+'/'+asset.id,()=>ctx.removeVoice(voice));
        b.ondblclick=()=>ctx.editVoice(voice);
        b.oncontextmenu=(e)=>{e.preventDefault();voiceTarget=voice;focusShot=voice.shot;focusClip=undefined;editLayer({key:'voice'});};
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
      waveforms.add(cell,asset,{span:totalTime-start,loop:true,volume:s.musicVolume(asset)});
      selection.bind(cell,asset,()=>removeItem(s.music,asset));
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
          selection.bind(cell,caption.key,caption.remove);
          cell.ondblclick=caption.open;
        }
      }
    }
    function layerRow(target,items,start,span) {
      const lanes=new Map();
      for(const [i,layer] of (items ?? []).entries()) {
        const limit=ctx.asset(layer.id)?.duration;
        const sourceSpan=limit>0 ? limit-(layer.mediaOffset ?? 0) : Infinity;
        const length=Math.min(layer.end ?? Infinity,span,layer.start+sourceSpan)-layer.start;
        const id=layer.kind+'-'+(layer.laneId ?? i);
        if(!lanes.has(id)) lanes.set(id,row(target.label+' · '+kinds[layer.kind],'sequence-layer kind-'+layer.kind,target.label+'/'+(target.column ?? 0)+'/'+id));
        const lane=lanes.get(id);
        const title=layer.kind==='text' ? layer.text : ctx.asset(layer.id)?.name ?? kinds[layer.kind];
        let dragged=false;
        const cell=block(lane,start+layer.start,Math.max(.1,length),title,()=>{},title+' · 双击编辑');
        if (length>0 && (layer.kind==='sound' || layer.kind==='pip')) {
          const offset=layer.mediaOffset ?? 0;
          waveforms.add(cell,ctx.asset(layer.id),{ranges:[{start:offset,end:offset+length}],volume:layer.volume ?? (layer.kind==='pip'?0:100)});
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
            if(edge==='left') a=snap(Math.max(Math.max(0,original-(layer.mediaOffset ?? 0)),Math.min(b-.05,original+delta)));
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
            if(edge==='left') layer.mediaOffset=snap((layer.mediaOffset ?? 0)+a-original);
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
            const after={...structuredClone(layer),start:cut,mediaOffset:(layer.mediaOffset ?? 0)+offset};
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
    const cursor=el('i','sequence-cursor');cursor.hidden=!ctx.showAxis();canvas.append(cursor);
    const hover=el('i','sequence-hover');hover.hidden=true;canvas.append(hover);
    function eventTime(e) {return Math.max(0,Math.min(totalTime,(e.clientX-ruler.getBoundingClientRect().left)/timeScale));}
    canvas.onpointermove=(e)=>{hover.hidden=scrubPointer!=null || resizeDrag!=null || !ctx.showAxis();hover.style.left=(96+eventTime(e)*timeScale)+'px';};
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
    for (const thumb of canvas.querySelectorAll('[data-thumb]')) thumbObserver.observe(thumb);
    syncCursor();ctx.scroll();
  }
  function syncCursor() {
    const cursor=host.querySelector('.sequence-cursor');
    if(cursor) cursor.style.left=(96+Math.min(totalTime,playTime)*timeScale)+'px';
  }
  function setFold(node,key,value) {
    if(value) folded.add(key); else folded.delete(key);
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
  function scrubAt(x) {
    draftTransport.stop();
    const ruler=host.querySelector('.sequence-ruler .sequence-content');
    if(!ruler) return;
    const viewport=host.getBoundingClientRect();
    const visibleX=Math.max(viewport.left+96,Math.min(viewport.right,x));
    playTime=Math.max(0,Math.min(totalTime,(visibleX-ruler.getBoundingClientRect().left)/timeScale));
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
      if(event.clientY!==y) resizeLane(node,key,height+event.clientY-y);
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
    if(resizeDrag?.id===event.pointerId) resizeDrag=undefined;
    if(host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  }
  for(const type of ['pointerup','pointercancel']) window.addEventListener(type,endDrag,true);
  window.addEventListener('blur',()=>{
    scrubPointer=undefined;resizeDrag=undefined;cancelAnimationFrame(scrubFrame);scrubFrame=undefined;
  });
  function syncPlayer(clip,sourceTime) {
    if(draftTransport.playing()) return;
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
  function refresh(key) {
    if(key!==undefined && lastKey!==undefined && key!==lastKey) draftTransport.stop();
    if(key!==undefined && key===lastKey) return;
    lastKey=key;
    if(refreshFrame===undefined) refreshFrame=requestAnimationFrame(draw);
  }
  host.ondragover=(e)=>{
    const b=e.target.closest('[data-drop-shot]');
    if (b && (rowDrag || e.dataTransfer.types.includes('application/x-jiajian-scene-cut'))) {
      e.stopPropagation(); e.preventDefault();e.dataTransfer.dropEffect=rowDrag?'move':'copy';
    }
  };
  host.ondrop=(e)=>{
    const b=e.target.closest('[data-drop-shot]');
    if(!b) return;
    const index=Number(b.dataset.dropShot);
    if(rowDrag) {e.preventDefault();e.stopPropagation();ctx.move(rowDrag,index);rowDrag=undefined;}
    else if(e.dataTransfer.types.includes('application/x-jiajian-scene-cut')) {e.preventDefault();e.stopPropagation();ctx.dropScene(e,index);}
  };
  let observedWidth;
  new ResizeObserver(([entry])=>{
    if(observedWidth===entry.contentRect.width) return;
    observedWidth=entry.contentRect.width;refresh();
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
  function selectClip(clip) {
    draftTransport.stop();
    activeSeek=undefined;
    if(!lastState || !host.clientWidth) return;
    const i=lastState.shots.findIndex((shot)=>shot.includes(clip));
    host.querySelector('.sequence-selected')?.classList.remove('sequence-selected');
    if(i>=0) {
      focusShot=lastState.shots[i];focusClip=clip;voiceTarget=undefined;
      host.querySelector('[data-drop-shot="'+i+'"][data-candidate-index="'+focusShot.indexOf(clip)+'"]')?.classList.add('sequence-selected');
    }
    if(lastState.selected!==clip && (clip?.videoSubtitles || lastState.selected?.videoSubtitles)) refresh();
  }
  return {refresh,syncPlayer,selectClip,editCaptions,removeSelected:selection.removeSelection,clearSelection:selection.clear,get selectionCount(){return selection.size;},editLayer:()=>editLayer(),textSettings:()=>textSettings(ctx.state()),
    toggleDraftPlayback:()=>draftTransport.toggle(draftTransport.playing()?[]:draftPlan(),playTime),
    stopDraftPlayback:draftTransport.stop,isDraftPlaying:draftTransport.playing,
    canPlayDraft:()=>draftPlan().length>0,get playheadTime(){return playTime;},
    zoom:()=>{fit=false;refresh();},fit:()=>{fit=true;refresh();},
    setHeight(value){host.dataset.height=value;heights.clear();for(const node of host.querySelectorAll('[data-lane-key]')) node.style.removeProperty('--lane-height');ctx.scroll();},
    fold(expanded){folded.clear();for(const node of host.querySelectorAll('[data-lane-key]')) setFold(node,node.dataset.laneKey,!expanded);ctx.scroll();},
    reset(){draftTransport.stop();selection.clear();focusShot=focusClip=voiceTarget=activeSeek=undefined;folded.clear();heights.clear();playTime=0;refresh();}};
};

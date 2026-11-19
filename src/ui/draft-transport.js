'use strict';

(() => {
  function timing(state,clipSpan,assetFor) {
    const {shots,segments,settings,whole,segmented,priority}=state;
    let widths=Array.from({length:shots.length || 3},(_,i)=>{
      const clip=shots[i]?.find((c)=>c.enabled!==false);
      const row=segments[i]?.findIndex(Boolean) ?? -1;
      const speech=row<0 || !segmented ? 0 : state.voiceDuration(i,row)+state.voiceOffset(i,row);
      return Math.max(.1,(priority==='voice' && speech) || settings[i]?.duration || (clip && clipSpan(clip)) || speech || 3);
    });
    const wholeVoice=whole.find((entry)=>entry.asset);
    let target=!segmented && priority==='voice' ? wholeVoice?.asset.duration : 0;
    let preserve=0;
    if (!shots.some((shot)=>shot.some((c)=>c.enabled!==false)) && !settings.some((row)=>row?.duration)
        && !(segmented && segments.some((row)=>row.some(Boolean)))) {
      const sounds=[...state.pack.global,...(state.pack.composites.find((row)=>row.length) ?? [])];
      const lengths=sounds.filter((layer)=>['sound','pip'].includes(layer.kind)).map((layer)=>
        layer.end ?? layer.start + Math.max(0,(assetFor(layer.id)?.duration ?? 0)-(layer.mediaOffset ?? 0)));
      function audioEnd(index,duration) {
        if(!(duration>0)) return 0;
        const follow=Math.max(0,Math.min(widths.length-1,index ?? 0));
        preserve=Math.max(preserve,follow);
        return widths.slice(0,follow).reduce((sum,width)=>sum+width,0)+duration;
      }
      target=Math.max(target || 0,segmented ? 0 : audioEnd(priority==='picture'?wholeVoice?.follow:0,wholeVoice?.asset.duration),
        audioEnd(state.musicAt,state.music[0]?.duration),...lengths);
    }
    if (target>0) {
      const prefix=widths.slice(0,preserve).reduce((sum,width)=>sum+width,0);
      const factor=(target-prefix)/widths.slice(preserve).reduce((sum,width)=>sum+width,0);
      widths=widths.map((width,index)=>index<preserve ? width : width*factor);
    }
    let total=0;
    const starts=widths.map((width)=>{const from=total;total+=width;return from;});
    return {widths,starts,total};
  }

  function makePlan(s,{starts,widths,total},assetFor,sourceRanges,focus) {
    const entries=[];
    function add(lane,asset,start,span,{ranges,head,tail,volume=100,visual=false,fit=false,loop=false,layer}={}) {
      if(!asset?.url || !(span>0) || (!visual && !(volume>0))) return;
      const stop=Math.min(total,start+span);
      const base={lane,asset,volume,visual,layer};
      if(asset.kind==='image') {
        if(visual && stop>start) entries.push({...base,start,end:stop,source:0,rate:1});
        return;
      }
      const source=sourceRanges(ranges ?? [{start:0,end:asset.duration}],head,tail);
      if(!(source.duration>0)) return;
      if(loop) {entries.push({...base,start,end:stop,source:0,rate:1,loop:true});return;}
      const rate=fit ? source.duration/span : 1;
      let at=start;
      source.visit(0,source.duration,false,(begin,end)=>{
        const next=at+(end-begin)/rate;
        if(at<stop) entries.push({...base,start:at,end:Math.min(stop,next),source:begin,rate});
        at=next;
      });
    }
    function layers(items,start,span) {
      for(const layer of items ?? []) {
        if(layer.kind!=='sound' && layer.kind!=='pip') continue;
        const asset=assetFor(layer.id);
        const source=layer.mediaOffset ?? 0;
        const available=asset?.duration>0 ? asset.duration-source : Infinity;
        const length=Math.min(span-layer.start,(layer.end ?? Infinity)-layer.start,available);
        add(layer,asset,start+layer.start,length,{ranges:[{start:source,end:source+length}],
          volume:layer.volume ?? (layer.kind==='sound'?100:0),visual:layer.kind==='pip',layer});
      }
    }
    s.shots.forEach((shot,i)=>{
      const at=starts[i],span=widths[i];
      const clip=shot.includes(focus) && focus.enabled!==false ? focus : shot.find((item)=>item.enabled!==false);
      if(clip) {
        const volume=s.keepAudio && !s.muted.has(shot.indexOf(clip)) ? (clip.volume ?? 100) : 0;
        add('picture',clip.asset,at,span,{ranges:clip.ranges ?? [{start:clip.start,end:clip.end}],
          head:clip.look?.head,tail:clip.look?.tail,visual:true,volume,fit:true});
        layers(clip.layers,at,span);
      }
      if(s.segmented) {
        const row=s.segments[i]?.findIndex(Boolean) ?? -1;
        if(row<0) return;
        const asset=s.segments[i][row], delay=s.voiceOffset(i,row);
        add('voice',asset,at+delay,span-delay,{ranges:s.voiceRanges(shot,row),volume:s.voiceVolume(asset,shot,row)});
        layers(s.pack.segmentNarration[i]?.[row],at,span);
      }
    });
    if(!s.segmented) {
      const row=s.whole.findIndex((track)=>track.asset);
      if(row>=0) {
        const {asset,follow}=s.whole[row], at=s.priority==='picture' ? starts[follow] ?? 0 : 0;
        add('voice',asset,at,total-at,{volume:s.voiceVolume(asset,null,row)});
        layers(s.pack.wholeNarration[row],0,total);
      }
    }
    if(s.music.length) {
      const at=starts[s.musicAt] ?? 0, asset=s.music[0];
      add('music',asset,at,total-at,{volume:s.musicVolume(asset),loop:true});
    }
    layers(s.pack.global,0,total);
    layers(s.pack.composites.find((items)=>items.length),0,total);
    return entries.sort((a,b)=>a.start-b.start);
  }

  function transport(stage,{tick,changed}) {
    const overlay=document.createElement('div');
    overlay.className='draft-transport-preview';overlay.hidden=true;
    const label=document.createElement('span');
    overlay.append(label);stage.append(overlay);
    let playing=false, media=new Map(), entries=[], active=[], next=0, time=0, end=0, stamp, frame;
    const failed=new Set();
    function release(node) {
      if(node.tagName!=='IMG') {node.pause();node.removeAttribute('src');node.load();}
      node.remove();
    }
    function halt(keepFrame=false) {
      cancelAnimationFrame(frame);
      if(playing) {playing=false;changed(false);}
      for(const item of media.values()) {
        if(keepFrame && item.node.tagName!=='IMG') item.node.pause();
        else if(!keepFrame) release(item.node);
      }
      if(!keepFrame) {media.clear();overlay.hidden=true;}
    }
    function show(entry) {
      const node=document.createElement(entry.asset.kind==='image'?'img':entry.visual?'video':'audio');
      node.className=entry.layer?'draft-layer':'draft-main';
      if(entry.layer) {
        node.style.left=(entry.layer.x ?? .5)*100+'%';node.style.top=(entry.layer.y ?? .5)*100+'%';
        node.style.width=(entry.layer.scale ?? .35)*100+'%';node.style.opacity=String(entry.layer.opacity ?? 1);
      }
      if(node.tagName!=='IMG'){
        node.preload='auto';node.playsInline=true;node.loop=!!entry.loop;
        node.volume=Math.max(0,Math.min(1,entry.volume/100));node.muted=!node.volume;
      }
      node.src=entry.asset.url;
      overlay.append(node);
      return {node,asset:entry.asset,entry:null,targetSet:false,waitingSince:0};
    }
    function render() {
      active=active.filter((entry)=>entry.end>time);
      while(next<entries.length && entries[next].start<=time) {
        const entry=entries[next++];if(entry.end>time)active.push(entry);
      }
      const live=new Set();let ready=true;
      for(const entry of active) {
        if(failed.has(entry.asset)) continue;
        live.add(entry.lane);
        let item=media.get(entry.lane);
        if(item?.asset!==entry.asset) {
          if(item) release(item.node);item=show(entry);media.set(entry.lane,item);
        }
        const node=item.node;
        const now=performance.now();
        if(node.tagName!=='IMG' && (node.readyState<2 || node.seeking)) item.waitingSince ||= now;
        else item.waitingSince=0;
        if(node.error || (item.waitingSince && now-item.waitingSince>10000)) {
          failed.add(entry.asset);continue;
        }
        if(node.tagName==='IMG') continue;
        if(item.entry!==entry) {item.entry=entry;item.targetSet=false;node.volume=Math.max(0,Math.min(1,entry.volume/100));node.muted=!node.volume;}
        if(node.readyState<1) {ready=false;continue;}
        let source=entry.source+(time-entry.start)*entry.rate;
        if(entry.loop)source%=entry.asset.duration;
        const rate=Math.max(.0625,Math.min(16,entry.rate));
        if(node.playbackRate!==rate)node.playbackRate=rate;
        if(!item.targetSet || (!node.seeking && Math.abs(node.currentTime-source)>.20)) {
          if(Math.abs(node.currentTime-source)>.015)node.currentTime=source;
          item.targetSet=true;
        }
        if(node.readyState<2 || node.seeking) {ready=false;continue;}
      }
      for(const [lane,item] of media) if(!live.has(lane) || failed.has(item.asset)) {release(item.node);media.delete(lane);}
      const visuals=active.some((e)=>e.visual && !failed.has(e.asset));
      label.hidden=visuals;
      if(!visuals) label.textContent=active.filter((e)=>!failed.has(e.asset)).map((e)=>e.asset.name).join(' · ') || '轨道试听';
      for(const {node,asset} of media.values()) {
        if(node.tagName==='IMG')continue;
        if(!ready) {if(!node.paused)node.pause();continue;}
        if(node.paused && !node.ended) node.play().catch((error)=>{if(error.name!=='AbortError')failed.add(asset);});
      }
      return ready;
    }
    function step(now) {
      if(!playing) return;
      if(render())time=Math.min(end,time+Math.min(.1,(now-stamp)/1000));
      stamp=now;tick(time);
      if(time>=end || (failed.size && entries.every((e)=>failed.has(e.asset)))) {halt(true);return;}
      frame=requestAnimationFrame(step);
    }
    function toggle(plan,from) {
      if(playing){halt(true);return true;}
      if(!plan.length){halt();return false;}
      halt();entries=plan;failed.clear();active=[];next=0;
      end=entries.reduce((max,entry)=>Math.max(max,entry.end),0);
      time=from>=end-.001 ? 0 : Math.max(0,from);
      document.getElementById('preview')?.pause();
      overlay.hidden=false;playing=true;changed(true);tick(time);
      stamp=performance.now();frame=requestAnimationFrame(step);return true;
    }
    return {toggle,stop:()=>halt(),playing:()=>playing};
  }
  const api={timing,makePlan,transport};
  if(typeof module==='object' && module.exports) module.exports=api;
  else window.draftTimeline=api;
})();

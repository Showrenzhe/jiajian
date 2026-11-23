'use strict';

(() => {
  const alignment = typeof module === 'object' && module.exports ? require('./voice-alignment.js') : window.voiceAlignment;
  const waveformSource = typeof module === 'object' && module.exports ? require('./waveform.js').waveformSource : window.waveformSource;

  function chosen(shot,focus) {
    return shot?.includes(focus) && focus.enabled!==false ? focus : shot?.find(clip=>clip.enabled!==false);
  }

  // Supply the same retained source intervals and candidate order used by the export planner.
  function voicePictures(state,widths,focus,wholeDuration) {
    const pools=state.shots.map((shot,index)=>{
      const first=chosen(shot,focus);
      const fixed=state.settings[index]?.duration;
      const hasVoice=state.segmented ? state.segments[index]?.some(Boolean) : wholeDuration>0;
      const useFullSource=state.priority==='voice' && state.voiceAlignment!=='reference' && hasVoice;
      if(!first) return [{duration:widths[index],start:0}];
      return [first,...shot.filter(clip=>clip!==first && clip.enabled!==false)].map(clip=>{
        const shotDuration=clip.matchedDuration ?? fixed;
        if(clip.asset.kind==='image') return {clip,start:0,duration:shotDuration ?? clip.end,shotDuration};
        const retained=waveformSource(clip.ranges ?? [{start:clip.start,end:clip.end}],clip.look?.head,clip.look?.tail);
        const speed=clip.speed || 1;
        const length=Math.min(retained.duration,!useFullSource && !clip.matchedDuration && shotDuration ? shotDuration*speed : Infinity);
        const ranges=[];
        retained.visit(0,length,false,(start,end)=>ranges.push({start,end}));
        return {clip,speed,matchedDuration:clip.matchedDuration,start:ranges[0]?.start ?? clip.start,sourceDuration:length,duration:length/speed,
          candidateStart:clip.start,retainedRanges:ranges.length>1 ? ranges : undefined,shotDuration};
      });
    });
    const clips=pools.map(([picture],i)=>{
      const row=state.segmented ? state.segments[i]?.findIndex(Boolean) ?? -1 : -1;
      if(row<0) return picture;
      const narration=state.segments[i][row], shot=state.shots[i];
      return {...picture,narration,narrationRanges:state.voiceRanges(shot,row),
        narrationSpeed:state.voiceSpeed?.(narration,shot,row),voiceOffset:state.voiceOffset(i,row)};
    });
    const fps=state.fps || 30;
    if(state.priority!=='voice' || (!state.segmented && !wholeDuration)) {
      return pools.map(pool=>pool[0].clip?.matchedDuration ?
        alignment.fitSegmentedVoice([pool[0]],[pool],fps,'fill')[0] : null);
    }
    if(state.segmented) return alignment.fitSegmentedVoice(clips,pools,fps,state.voiceAlignment ?? 'fill');
    if(state.voiceAlignment==='reference') return alignment.fitReferenceWhole(clips,wholeDuration,fps);
    return alignment.fitWholeVoice(clips,pools,wholeDuration,fps);
  }

  function timing(state,clipSpan,assetFor,focus) {
    const {shots,segments,settings,whole,segmented,priority}=state;
    let widths=Array.from({length:shots.length || 3},(_,i)=>{
      const clip=chosen(shots[i],focus);
      const row=segments[i]?.findIndex(Boolean) ?? -1;
      const speech=row<0 || !segmented ? 0 : state.voiceDuration(i,row)+state.voiceOffset(i,row);
      return Math.max(.1,(priority==='voice' && speech) || clip?.matchedDuration || settings[i]?.duration || (clip && clipSpan(clip)) || speech || 3);
    });
    const wholeVoice=whole.find((entry)=>entry.asset);
    const wholeDuration=wholeVoice ? wholeVoice.asset.duration/(state.voiceSpeed?.(wholeVoice.asset,null,whole.indexOf(wholeVoice)) ?? 1) : 0;
    let target=!segmented && priority==='voice' ? wholeDuration : 0;
    let preserve=0;
    if (!shots.some((shot)=>shot.some((c)=>c.enabled!==false)) && !settings.some((row)=>row?.duration)
        && !(segmented && segments.some((row)=>row.some(Boolean)))) {
      const sounds=[...state.pack.global,...(state.pack.composites.find((row)=>row.length) ?? [])];
      const lengths=sounds.filter((layer)=>['sound','pip'].includes(layer.kind)).map((layer)=>
        layer.end ?? layer.start + Math.max(0,(assetFor(layer.id)?.duration ?? 0)-(layer.mediaOffset ?? 0))/(layer.speed ?? 1));
      function audioEnd(index,duration) {
        if(!(duration>0)) return 0;
        const follow=Math.max(0,Math.min(widths.length-1,index ?? 0));
        preserve=Math.max(preserve,follow);
        return widths.slice(0,follow).reduce((sum,width)=>sum+width,0)+duration;
      }
      target=Math.max(target || 0,segmented ? 0 : audioEnd(priority==='picture'?wholeVoice?.follow:0,wholeDuration),
        audioEnd(state.musicAt,state.music[0]?.duration/(state.musicSpeed?.(state.music[0]) ?? 1)),...lengths);
    }
    let aligned;
    if((priority==='voice' && (segmented || wholeDuration) && shots.some(shot=>chosen(shot,focus))) ||
        shots.some(shot=>chosen(shot,focus)?.matchedDuration)) {
      aligned=voicePictures(state,widths,focus,wholeDuration);
      widths=widths.map((width,i)=>aligned[i]?.timelineDuration ?? aligned[i]?.outputDuration ?? width);
    } else if (target>0) {
      const prefix=widths.slice(0,preserve).reduce((sum,width)=>sum+width,0);
      const factor=(target-prefix)/widths.slice(preserve).reduce((sum,width)=>sum+width,0);
      widths=widths.map((width,index)=>index<preserve ? width : width*factor);
    }
    let total=0;
    const starts=widths.map((width)=>{const from=total;total+=width;return from;});
    return aligned ? {widths,starts,total,aligned} : {widths,starts,total};
  }

  function makePlan(s,{starts,widths,total,aligned},assetFor,sourceRanges,focus) {
    const entries=[];
    if(aligned && !s.segmented && s.priority==='voice') {
      const whole=s.whole.find(track=>track.asset);
      if(whole) total=Math.min(total,whole.asset.duration/(s.voiceSpeed?.(whole.asset,null,s.whole.indexOf(whole)) ?? 1));
    }
    function add(lane,asset,start,span,{ranges,head,tail,volume=100,visual=false,fit=false,loop=false,layer,speed=1,cycle}={}) {
      if(!asset?.url || !(span>0) || start>=total || (!visual && !(volume>0))) return;
      const stop=Math.min(total,start+span);
      const base={lane,asset,volume,visual,layer};
      if(cycle) { entries.push({...base,start,end:stop,source:ranges[0].start,rate:speed,cycle}); return; }
      if(asset.kind==='image') {
        if(visual && stop>start) entries.push({...base,start,end:stop,source:0,rate:1});
        return;
      }
      const source=sourceRanges(ranges ?? [{start:0,end:asset.duration}],head,tail);
      if(!(source.duration>0)) return;
      if(loop) {entries.push({...base,start,end:stop,source:0,rate:speed,loop:true});return;}
      const rate=fit ? source.duration/span : speed;
      let at=start;
      source.visit(0,source.duration,false,(begin,end)=>{
        const next=at+(end-begin)/rate;
        if(at<stop) entries.push({...base,start:at,end:Math.min(stop,next),source:begin,rate});
        at=next;
      });
    }
    function layers(items,start,span,seek=0,ownerSpeed=1) {
      for(const layer of items ?? []) {
        if(layer.kind!=='sound' && layer.kind!=='pip') continue;
        const asset=assetFor(layer.id);
        const speed=layer.speed ?? 1;
        const begin=Math.max(seek,layer.start);
        const source=(layer.mediaOffset ?? 0)+(begin-layer.start)*speed;
        const available=asset?.duration>0 ? (asset.duration-source)/speed : Infinity;
        const length=Math.min(seek+span*ownerSpeed-begin,(layer.end ?? Infinity)-begin,available);
        add(layer,asset,start+(begin-seek)/ownerSpeed,length/ownerSpeed,{ranges:[{start:source,end:source+length*speed}],speed:speed*ownerSpeed,
          volume:layer.volume ?? (layer.kind==='sound'?100:0),visual:layer.kind==='pip',layer});
      }
    }
    s.shots.forEach((shot,i)=>{
      const at=starts[i],span=widths[i];
      const clip=chosen(shot,focus);
      const timed=aligned?.[i];
      if(aligned && !timed && s.priority==='voice' && !s.segmented && s.whole.some(track=>track.asset)) return;
      if(timed && clip) {
        const parts=timed.visuals ?? [timed];
        let offset=at;
        for(const part of parts) {
          const owner=part.clip;
          const length=Math.min(at+span-offset,part.outputDuration);
          if(!owner || !(length>0)) continue;
          const speed=part.speed || 1, repeats=part.repeat || 1;
          const source=part.sourceDuration ?? part.duration*speed;
          const volume=s.keepAudio && !s.muted.has(shot.indexOf(owner)) ? (owner.volume ?? 100) : 0;
          add('picture',owner.asset,offset,length,{ranges:[{start:part.start,end:part.start+source}],
            speed,visual:true,volume,cycle:repeats>1 ? source : 0});
          if(owner.layers?.length) {
            for(let n=0;n<repeats;n++) {
              const elapsed=n*source/speed;
              const segment=Math.min(source/speed,length-elapsed);
              if(segment>0) layers(owner.layers,offset+elapsed,segment,part.start-owner.start,speed);
            }
          }
          offset+=length;
        }
      } else if(clip) {
        const volume=s.keepAudio && !s.muted.has(shot.indexOf(clip)) ? (clip.volume ?? 100) : 0;
        add('picture',clip.asset,at,span,{ranges:clip.ranges ?? [{start:clip.start,end:clip.end}],
          head:clip.look?.head,tail:clip.look?.tail,visual:true,volume,fit:true});
        const ranges=clip.ranges ?? [{start:clip.start,end:clip.end}];
        const source=sourceRanges(ranges,clip.look?.head,clip.look?.tail);
        const speed=source.duration/span;
        let offset=at;
        source.visit(0,source.duration,false,(begin,end)=>{
          const length=(end-begin)/speed;
          layers(clip.layers,offset,length,begin-(clip.start ?? 0),speed);
          offset+=length;
        });
      }
      if(s.segmented) {
        const row=s.segments[i]?.findIndex(Boolean) ?? -1;
        if(row<0) return;
        const asset=s.segments[i][row], delay=s.voiceOffset(i,row);
        const speed=s.voiceSpeed?.(asset,shot,row) ?? 1;
        const ranges=s.voiceRanges(shot,row) ?? [{start:0,end:asset.duration}];
        const trim=(timed?.narrationStart ?? 0)*speed;
        const speech=sourceRanges(ranges,trim);
        const playbackRanges=[];
        speech.visit(0,Math.min(speech.duration,(span-delay)*speed),false,(start,end)=>playbackRanges.push({start,end}));
        add('voice',asset,at+delay,span-delay,{ranges:playbackRanges,speed,volume:s.voiceVolume(asset,shot,row)});
        let offset=at+delay;
        for(const {start,end} of playbackRanges) {
          const length=Math.min((end-start)/speed,at+span-offset);
          if(length<=0) break;
          layers(s.pack.segmentNarration[i]?.[row],offset,length,start,speed);
          offset+=length;
        }
      }
    });
    if(!s.segmented) {
      const row=s.whole.findIndex((track)=>track.asset);
      if(row>=0) {
        const {asset,follow}=s.whole[row], at=s.priority==='picture' ? starts[follow] ?? 0 : 0;
        const speed=s.voiceSpeed?.(asset,null,row) ?? 1;
        add('voice',asset,at,total-at,{volume:s.voiceVolume(asset,null,row),speed});
        layers(s.pack.wholeNarration[row],at,Math.min(total-at,asset.duration/speed),0,speed);
      }
    }
    if(s.music.length) {
      const at=starts[s.musicAt] ?? 0, asset=s.music[0];
      add('music',asset,at,total-at,{volume:s.musicVolume(asset),loop:true,speed:s.musicSpeed?.(asset) ?? 1});
    }
    layers(s.pack.global,0,total);
    layers(s.pack.composites.find((items)=>items.length),0,total);
    return entries.sort((a,b)=>a.start-b.start);
  }

  function transport(stage,{tick,changed,previewSource}) {
    const overlay=document.createElement('div');
    overlay.className='draft-transport-preview';overlay.hidden=true;
    const label=document.createElement('span');
    overlay.append(label);stage.append(overlay);
    let playing=false, media=new Map(), entries=[], active=[], next=0, time=0, end=0, stamp, frame;
    let visual=false, canProxy=false;
    const failed=new Set();
    function release(node) {
      if(node.tagName!=='IMG') {node.pause();node.removeAttribute('src');node.load();}
      node.remove();
    }
    function halt(keepFrame=false) {
      cancelAnimationFrame(frame);
      const visible=!overlay.hidden;
      playing=false;
      for(const item of media.values()) {
        if(keepFrame && item.node.tagName!=='IMG') item.node.pause();
        else if(!keepFrame) release(item.node);
      }
      if(!keepFrame) {media.clear();overlay.hidden=true;}
      if(visible) changed(false);
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
      overlay.append(node);
      const proxy=previewSource?.(entry.asset);
      const item={node,asset:entry.asset,entry:null,targetSet:false,waitingSince:0,mayUseProxy:Boolean(proxy)};
      if (proxy) Promise.resolve(proxy).catch(()=>null).then(url=>{
        if (!node.isConnected || !item.mayUseProxy) return;
        item.mayUseProxy=Boolean(url);
        node.src=url || entry.asset.url;
      });
      else node.src=entry.asset.url;
      return item;
    }
    function retryOriginal(item) {
      if (!item.mayUseProxy) return false;
      item.mayUseProxy=false;
      item.waitingSince=0;
      item.targetSet=false;
      item.node.src=item.asset.url;
      return true;
    }
    function render() {
      const at=Math.max(0,Math.min(time,end-1e-6));
      active=active.filter((entry)=>entry.end>at);
      while(next<entries.length && entries[next].start<=at) {
        const entry=entries[next++];if(entry.end>at)active.push(entry);
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
          if(retryOriginal(item)) ready=false;
          else failed.add(entry.asset);
          continue;
        }
        if(node.tagName==='IMG') continue;
        if(item.entry!==entry) {item.entry=entry;item.targetSet=false;item.cycleIndex=undefined;node.volume=Math.max(0,Math.min(1,entry.volume/100));node.muted=!node.volume;}
        if(node.readyState<1) {ready=false;continue;}
        let source=entry.source+(at-entry.start)*entry.rate;
        if(entry.loop)source%=entry.asset.duration;
        if(entry.cycle) {
          const cycleIndex=Math.floor((source-entry.source)/entry.cycle);
          if(cycleIndex!==item.cycleIndex) item.targetSet=false;
          item.cycleIndex=cycleIndex;
          source=entry.source+(source-entry.source)%entry.cycle;
        }
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
      for(const item of media.values()) {
        const {node,asset}=item;
        if(node.tagName==='IMG')continue;
        if(!playing || !ready) {if(!node.paused)node.pause();continue;}
        if(node.paused && !node.ended) {
          const src=node.src;
          node.play().catch(error=>{
            if(error.name!=='AbortError' && node.isConnected && node.src===src && !retryOriginal(item)) failed.add(asset);
          });
        }
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
      visual=entries.some(entry=>entry.visual);
      canProxy=entries.some(({asset})=>asset.kind==='video' && !asset.alpha && Math.max(asset.width,asset.height)>480);
      time=from>=end-.001 ? 0 : Math.max(0,from);
      document.getElementById('preview')?.pause();
      overlay.hidden=false;playing=true;changed(true);tick(time);
      stamp=performance.now();frame=requestAnimationFrame(step);return true;
    }
    function seek(seconds,reloadSources=false) {
      if(overlay.hidden) return;
      cancelAnimationFrame(frame);
      if(reloadSources) {
        for(const item of media.values()) release(item.node);
        media.clear();failed.clear();
      }
      active=[];next=0;time=Math.max(0,Math.min(end,seconds));
      for(const item of media.values()) item.targetSet=false;
      stamp=performance.now();
      function paint() {
        const ready=render();
        tick(time);
        if(playing) frame=requestAnimationFrame(step);
        else if(!ready) frame=requestAnimationFrame(paint);
      }
      paint();
    }
    function state() {
      if(overlay.hidden) return null;
      let proxy=false;
      for(const item of media.values()) {
        if(item.mayUseProxy && item.node.tagName==='VIDEO' && item.node.readyState>=1 && item.node.currentSrc!==item.asset.url) {
          proxy=true;
          break;
        }
      }
      return {time,end,playing,visual,canProxy,proxy};
    }
    return {toggle,seek,state,stop:()=>halt(),playing:()=>playing};
  }
  const api={timing,makePlan,transport};
  if(typeof module==='object' && module.exports) module.exports=api;
  else window.draftTimeline=api;
})();

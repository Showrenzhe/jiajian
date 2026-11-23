'use strict';

(() => {
  const alignment = typeof module === 'object' && module.exports ? require('./voice-alignment.js') : window.voiceAlignment;
  const waveformSource = typeof module === 'object' && module.exports ? require('./waveform.js').waveformSource : window.waveformSource;
  const { candidateVideoLanes, pictureSpan, soloLaneSequence, usesPlacedVideoSource } = typeof module === 'object' && module.exports ? require('./track-tools.js') : window;
  const controls = typeof module === 'object' && module.exports ? require('./track-controls.js') : window.trackControls;

  function chosen(shot,focus,state) {
    if (shot?.length && state?.trackControls) {
      const lanes = candidateVideoLanes(shot);
      const solo = shot.filter((clip,i)=>clip.enabled!==false && state.trackControls['vis'+lanes[i]]?.solo);
      if (solo.length) return solo.includes(focus) ? focus : solo[0];
    }
    return shot?.includes(focus) && focus.enabled!==false ? focus : shot?.find(clip=>clip.enabled!==false);
  }
  function audioRow(items, prefix, state) {
    if (!items) return -1;
    const present = (item) => prefix==='whole' ? Boolean(item?.asset) : Boolean(item);
    const solo = items.findIndex((item,i)=>present(item) && state.trackControls?.[prefix+i]?.solo);
    return solo >= 0 ? solo : items.findIndex(present);
  }

  // Supply the same retained source intervals and candidate order used by the export planner.
  function voicePictures(state,widths,focus,wholeDuration) {
    const pools=state.shots.map((shot,index)=>{
      const first=chosen(shot,focus,state);
      const fixed=state.settings[index]?.duration;
      const hasVoice=state.segmented ? state.segments[index]?.some(Boolean) : wholeDuration>0;
      const useFullSource=state.priority==='voice' && state.voiceAlignment!=='reference' && hasVoice;
      if(!first) return [{duration:widths[index],start:0}];
      const lanes=candidateVideoLanes(shot);
      const eligible=controls.preferSolo(shot.filter(clip=>clip.enabled!==false),
        clip=>state.trackControls?.['vis'+lanes[shot.indexOf(clip)]]?.solo);
      return [first,...eligible.filter(clip=>clip!==first)].map(clip=>{
        const shotDuration=clip.videoFit==='hold' ? fixed ?? clip.matchedDuration : clip.matchedDuration ?? fixed;
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
      const row=state.segmented ? audioRow(state.segments[i],'voice',state) : -1;
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
      const clip=chosen(shots[i],focus,state);
      const row=audioRow(segments[i],'voice',state);
      const speech=row<0 || !segmented ? 0 : state.voiceDuration(i,row)+state.voiceOffset(i,row);
      const fixed=settings[i]?.duration;
      const duration=clip?.videoFit==='hold' ? fixed ?? clip.matchedDuration : clip?.matchedDuration ?? fixed;
      return Math.max(.1,(priority==='voice' && speech) || duration || (clip && clipSpan(clip)) || speech || 3);
    });
    const wholeVoice=whole[audioRow(whole,'whole',state)];
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
      const music=state.music[audioRow(state.music,'music',state)];
      target=Math.max(target || 0,segmented ? 0 : audioEnd(priority==='picture'?wholeVoice?.follow:0,wholeDuration),
        audioEnd(state.musicAt,music?.duration/(state.musicSpeed?.(music) ?? 1)),...lengths);
    }
    let aligned;
    if((priority==='voice' && (segmented || wholeDuration) && shots.some(shot=>chosen(shot,focus,state))) ||
        shots.some(shot=>chosen(shot,focus,state)?.matchedDuration)) {
      aligned=voicePictures(state,widths,focus,wholeDuration);
      widths=widths.map((width,i)=>aligned[i]?.timelineDuration ?? aligned[i]?.outputDuration ?? width);
    } else if (target>0) {
      const prefix=widths.slice(0,preserve).reduce((sum,width)=>sum+width,0);
      const factor=(target-prefix)/widths.slice(preserve).reduce((sum,width)=>sum+width,0);
      widths=widths.map((width,index)=>index<preserve ? width : width*factor);
    }
    let total=0;
    const starts=widths.map((width)=>{const from=total;total+=width;return from;});
    shots.forEach((shot,i)=>{
      for(const clip of shot) if(clip.videoStart!==undefined) total=Math.max(total,clip.videoStart+pictureSpan(clip,widths[i]));
    });
    return aligned ? {widths,starts,total,aligned} : {widths,starts,total};
  }

  function makePlan(s,{starts,widths,total,aligned},assetFor,sourceRanges,focus) {
    const entries=[];
    let trimmedShotEnd=0;
    const freePictures=s.shots.some(shot=>shot.some(clip=>clip.videoStart!==undefined));
    if(!freePictures && aligned && !s.segmented && s.priority==='voice') {
      const whole=s.whole[audioRow(s.whole,'whole',s)];
      if(whole) total=Math.min(total,whole.asset.duration/(s.voiceSpeed?.(whole.asset,null,s.whole.indexOf(whole)) ?? 1));
    }
    function addText(text,start,end,appearance,key,highlights) {
      if(!text || end<=start || start>=total || !controls.allows(s.trackControls,key,'visual')) return;
      entries.push({text,start,end:Math.min(end,total),appearance,highlights,visual:true});
    }
    function add(lane,asset,start,span,{ranges,head,tail,volume=100,visual=false,loop=false,layer,speed=1,cycle,trackKey,hold=false}={}) {
      if(!asset?.url || !(span>0) || start>=total || (!visual && !(volume>0))) return;
      const key=trackKey ?? controls.layerKey(layer);
      if (!controls.allows(s.trackControls,key,'visual')) visual=false;
      if (!controls.allows(s.trackControls,key,'audio')) volume=0;
      const stop=Math.min(total,start+span);
      const base={lane,asset,volume,visual,layer};
      if(cycle) { entries.push({...base,start,end:stop,source:ranges[0].start,rate:speed,cycle}); return; }
      if(asset.kind==='image') {
        if(stop>start) entries.push({...base,start,end:stop,source:0,rate:1});
        return;
      }
      const source=sourceRanges(ranges ?? [{start:0,end:asset.duration}],head,tail);
      if(!(source.duration>0)) return;
      if(loop) {entries.push({...base,start,end:stop,source:0,rate:speed,loop:true});return;}
      let at=start, lastFrame;
      source.visit(0,source.duration,false,(begin,end)=>{
        const next=at+(end-begin)/speed;
        if(at<stop) entries.push({...base,start:at,end:Math.min(stop,next),source:begin,rate:speed});
        at=next;
        lastFrame=Math.max(begin,end-1e-6);
      });
      if(hold && visual && at<stop-1e-7) entries.push({...base,start:at,end:stop,source:lastFrame,rate:0,volume:0});
    }
    function layers(items,start,span,seek=0,ownerSpeed=1) {
      for(const layer of items ?? []) {
        const asset=layer.id && assetFor(layer.id);
        const speed=layer.speed ?? 1;
        const begin=Math.max(seek,layer.start);
        const source=(layer.mediaOffset ?? 0)+(begin-layer.start)*speed;
        const available=asset?.duration>0 ? (asset.duration-source)/speed : Infinity;
        const length=Math.min(seek+span*ownerSpeed-begin,(layer.end ?? Infinity)-begin,available);
        const at=start+(begin-seek)/ownerSpeed;
        if(layer.kind==='text') addText(layer.text,at,at+length/ownerSpeed,layer,controls.layerKey(layer));
        else add(layer,asset,at,length/ownerSpeed,{ranges:[{start:source,end:source+length*speed}],speed:speed*ownerSpeed,
          volume:layer.volume ?? (layer.kind==='sound'?100:0),visual:layer.kind==='pip' || layer.kind==='sticker',layer});
      }
    }
    const style=s.subtitleStyle ?? {};
    function pictureCaptions(clip,at,span,begin,speed) {
      if(style.enabled===false || !clip.videoSubtitles) return;
      for(const cue of clip.videoSubtitles.cues) {
        const start=at+Math.max(0,(cue.start/1000-begin)/speed);
        const end=at+Math.min(span,(cue.end/1000-begin)/speed);
        addText(cue.text,start,end,style,'local-subtitles',cue.highlights);
      }
    }
    const textGroups=s.pack.textGroups ?? [];
    const firstTextGroup=textGroups.find(row=>row.some(items=>items?.length));
    s.shots.forEach((shot,i)=>{
      const at=starts[i],span=widths[i];
      if(s.pack.textMode==='segmented') {
        const group=s.pack.textSelection==='random' ? textGroups.find(row=>row[i]?.length) : firstTextGroup;
        layers(group?.[i],at,span);
      }
      const selected=chosen(shot,focus,s);
      const voicePriority=s.priority==='voice' && (s.segmented ? s.segments[i]?.some(Boolean) : s.whole.some(track=>track.asset));
      const lanes=candidateVideoLanes(shot), timed=aligned?.[i];
      const sequence=soloLaneSequence(shot,selected,s.trackControls,span);
      for(const clip of sequence.length ? sequence : [selected]) {
        const hold=clip?.videoFit==='hold' || sequence.length>0;
        const placedSource=hold || usesPlacedVideoSource(clip,voicePriority);
        const pictureAt=clip?.videoStart ?? at;
        const visibleSpan=pictureSpan(clip,span);
        if(hold) trimmedShotEnd=total;
        if(visibleSpan<span) trimmedShotEnd=Math.max(trimmedShotEnd,Math.min(total,at+span));
        // Independently placed pictures can overlap. Keep a separate media element per physical row.
        const pictureLane=freePictures ? 'picture:'+lanes[shot.indexOf(clip)]+':'+i : 'picture';
        if(!placedSource && aligned && !timed && s.priority==='voice' && !s.segmented && s.whole.some(track=>track.asset)) continue;
        if(timed && clip && !placedSource) {
          const parts=timed.visuals ?? [timed];
          let offset=pictureAt;
          for(const part of parts) {
            const owner=part.clip;
            const length=Math.min(pictureAt+visibleSpan-offset,part.outputDuration);
            if(!owner || !(length>0)) continue;
            const speed=part.speed || 1, repeats=part.repeat || 1;
            const source=part.sourceDuration ?? part.duration*speed;
            const volume=s.keepAudio && !s.muted.has(lanes[shot.indexOf(owner)]) ? (owner.volume ?? 100) : 0;
            add(pictureLane,owner.asset,offset,length,{ranges:[{start:part.start,end:part.start+source}],
              speed,visual:true,volume,trackKey:'vis'+lanes[shot.indexOf(owner)],cycle:repeats>1 ? source : 0});
            if(owner.layers?.length || owner.videoSubtitles) {
              for(let n=0;n<repeats;n++) {
                const elapsed=n*source/speed;
                const segment=Math.min(source/speed,length-elapsed);
                if(segment>0) {
                  layers(owner.layers,offset+elapsed,segment,part.start-owner.start,speed);
                  pictureCaptions(owner,offset+elapsed,segment,part.start,speed);
                }
              }
            }
            offset+=length;
          }
        } else if(clip) {
          const volume=s.keepAudio && !s.muted.has(lanes[shot.indexOf(clip)]) ? (clip.volume ?? 100) : 0;
          const ranges=clip.ranges ?? [{start:clip.start,end:clip.end}];
          const source=sourceRanges(ranges,clip.look?.head,clip.look?.tail);
          const speed=placedSource ? clip.speed ?? 1 : source.duration/span;
          add(pictureLane,clip.asset,pictureAt,visibleSpan,{ranges,head:clip.look?.head,tail:clip.look?.tail,
            visual:true,volume,trackKey:'vis'+lanes[shot.indexOf(clip)],speed,hold});
          let offset=pictureAt;
          source.visit(0,Math.min(source.duration,visibleSpan*speed),false,(begin,end)=>{
            const length=(end-begin)/speed;
            layers(clip.layers,offset,length,begin-(clip.start ?? 0),speed);
            pictureCaptions(clip,offset,length,begin,speed);
            offset+=length;
          });
        }
      }
      if(s.segmented) {
        const row=audioRow(s.segments[i],'voice',s);
        if(row<0) return;
        const asset=s.segments[i][row], delay=s.voiceOffset(i,row);
        const speed=s.voiceSpeed?.(asset,shot,row) ?? 1;
        const ranges=s.voiceRanges(shot,row) ?? [{start:0,end:asset.duration}];
        const trim=(timed?.narrationStart ?? 0)*speed;
        const speech=sourceRanges(ranges,trim);
        const playbackRanges=[];
        speech.visit(0,Math.min(speech.duration,(span-delay)*speed),false,(start,end)=>playbackRanges.push({start,end}));
        add('voice',asset,at+delay,span-delay,{ranges:playbackRanges,speed,volume:s.voiceVolume(asset,shot,row),trackKey:'voice'+row});
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
      const row=audioRow(s.whole,'whole',s);
      if(row>=0) {
        const {asset,follow}=s.whole[row], at=s.priority==='picture' ? starts[follow] ?? 0 : 0;
        const speed=s.voiceSpeed?.(asset,null,row) ?? 1;
        add('voice',asset,at,total-at,{volume:s.voiceVolume(asset,null,row),speed,trackKey:'whole'+row});
        layers(s.pack.wholeNarration[row],at,Math.min(total-at,asset.duration/speed),0,speed);
      }
    }
    if(s.music.length) {
      const row=audioRow(s.music,'music',s), at=starts[s.musicAt] ?? 0, asset=s.music[row];
      add('music',asset,at,total-at,{volume:s.musicVolume(asset),loop:true,speed:s.musicSpeed?.(asset) ?? 1,trackKey:'music'+row});
    }
    layers(s.pack.global,0,total);
    layers(s.pack.composites.find((items)=>items.length),0,total);
    if(s.pack.textMode==='whole') layers(textGroups.find(row=>row[0]?.length)?.[0],0,total);
    if(style.enabled!==false) {
      for(const caption of s.captions ?? []) {
        const chosen=caption.shot==null ? audioRow(s.whole,'whole',s) : audioRow(s.segments[caption.shot],'voice',s);
        if(chosen>=0 && chosen!==caption.row) continue;
        const offset=starts[caption.shot] ?? starts[caption.follow] ?? 0;
        const trim=aligned?.[caption.shot]?.narrationStart ?? 0;
        const at=offset+caption.start-trim;
        const limit=caption.shot==null ? total : offset+widths[caption.shot];
        addText(caption.name,Math.max(offset,at),Math.min(limit,at+caption.duration),style,'caption'+caption.row,caption.highlights);
      }
      for(const cue of s.timelineCaptions ?? []) addText(cue.text,cue.start/1000,cue.end/1000,style,'pasted-captions',cue.highlights);
    }
    if (trimmedShotEnd) {
      const lastEnd=entries.reduce((end,entry)=>Math.max(end,entry.end),0);
      if(lastEnd>0 && lastEnd<trimmedShotEnd) entries.push({gap:true,start:lastEnd,end:trimmedShotEnd});
    }
    return entries.sort((a,b)=>a.start-b.start);
  }

  function transport(stage,{tick,changed,previewSource}) {
    const overlay=document.createElement('div');
    overlay.className='draft-transport-preview';overlay.hidden=true;
    const label=document.createElement('span');
    overlay.append(label);stage.append(overlay);
    let playing=false, media=new Map(), entries=[], active=[], next=0, time=0, end=0, stamp, frame;
    let visual=false, canProxy=false;
    const textNodes=new Map();
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
      if(!keepFrame) {
        for(const node of textNodes.values()) node.remove();
        textNodes.clear();media.clear();overlay.hidden=true;
      }
      if(visible) changed(false);
    }
    function show(entry) {
      const node=document.createElement(entry.asset.kind==='image'?'img':entry.visual?'video':'audio');
      node.hidden=!entry.visual;
      node.className=entry.layer?'draft-layer':'draft-main';
      if(typeof entry.lane==='string' && entry.lane.startsWith('picture:')) {
        const [,row,shot]=entry.lane.split(':');
        node.style.zIndex=String((100-Number(row))*1000+Number(shot));
      }
      if(entry.layer) {
        node.style.zIndex='101000';
        node.style.left=(entry.layer.x ?? .5)*100+'%';node.style.top=(entry.layer.y ?? .5)*100+'%';
        node.style.width=(entry.layer.scale ?? .35)*100+'%';node.style.opacity=String(entry.layer.opacity ?? 1);
      }
      if(node.tagName!=='IMG'){
        node.crossOrigin='anonymous';node.preload='auto';node.playsInline=true;node.loop=!!entry.loop;
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
        const entry=entries[next++];if(!entry.gap && entry.end>at)active.push(entry);
      }
      const live=new Set();let ready=true;
      for(const entry of active) {
        if(entry.text) {
          live.add(entry);
          if(!textNodes.has(entry)) {
            const node=window.draftTextPreview(entry,overlay);
            overlay.append(node);textNodes.set(entry,node);
          }
          continue;
        }
        if(failed.has(entry.asset)) continue;
        live.add(entry.lane);
        let item=media.get(entry.lane);
        if(item?.asset!==entry.asset || (item && item.node.hidden===entry.visual)) {
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
        const frozen=entry.rate===0;
        if(frozen && !node.paused)node.pause();
        const rate=frozen ? 1 : Math.max(.0625,Math.min(16,entry.rate));
        if(node.playbackRate!==rate)node.playbackRate=rate;
        if(!item.targetSet || (!node.seeking && Math.abs(node.currentTime-source)>.20)) {
          if(Math.abs(node.currentTime-source)>(frozen ? 1e-7 : .015))node.currentTime=source;
          item.targetSet=true;
        }
        if(node.readyState<2 || node.seeking) {ready=false;continue;}
      }
      for(const [lane,item] of media) if(!live.has(lane) || failed.has(item.asset)) {release(item.node);media.delete(lane);}
      for(const [entry,node] of textNodes) if(!live.has(entry)) {node.remove();textNodes.delete(entry);}
      const visuals=active.some((e)=>e.visual && !failed.has(e.asset));
      label.hidden=visuals;
      if(!visuals) label.textContent=active.filter((e)=>!failed.has(e.asset)).map((e)=>e.asset.name).join(' · ') || '轨道试听';
      for(const item of media.values()) {
        const {node,asset}=item;
        if(node.tagName==='IMG')continue;
        if(!playing || !ready || item.entry?.rate===0) {if(!node.paused)node.pause();continue;}
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
      if(time>=end || (failed.size && entries.every((e)=>e.gap || failed.has(e.asset)))) {halt(true);return;}
      frame=requestAnimationFrame(step);
    }
    function setPlan(plan) {
      entries=plan;active=[];next=0;
      end=entries.reduce((max,entry)=>Math.max(max,entry.end),0);
      visual=entries.some(entry=>entry.visual);
      canProxy=entries.some(({asset})=>asset?.kind==='video' && !asset.alpha && Math.max(asset.width,asset.height)>480);
    }
    function updatePlan(plan) {
      if(!plan.length){halt();return;}
      setPlan(plan);seek(time);
    }
    function toggle(plan,from) {
      if(playing){halt(true);return true;}
      if(!plan.length){halt();return false;}
      halt();failed.clear();setPlan(plan);
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
    return {toggle,updatePlan,seek,state,stop:()=>halt(),playing:()=>playing};
  }
  const api={chosen,timing,makePlan,transport};
  if(typeof module==='object' && module.exports) module.exports=api;
  else window.draftTimeline=api;
})();

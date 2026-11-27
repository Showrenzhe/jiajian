'use strict';

(() => {
  const alignment = typeof module === 'object' && module.exports ? require('./voice-alignment.js') : window.voiceAlignment;
  const narrationTrim = typeof module === 'object' && module.exports ? require('./narration-trim.js') : window.narrationTrim;
  const waveformSource = typeof module === 'object' && module.exports ? require('./waveform.js').waveformSource : window.waveformSource;
  const { candidateVideoLanes, pictureSpan, soloLaneSequence, joinedVideoSequence, videoGroupLeaders, usesPlacedVideoSource, placedVideoSpeed, sampleVideoRate, shouldRetimeVideo } = typeof module === 'object' && module.exports ? require('./track-tools.js') : window;
  const controls = typeof module === 'object' && module.exports ? require('./track-controls.js') : window.trackControls;

  function eligiblePictures(shot,state,lanes=candidateVideoLanes(shot)) {
    const active=[],solo=[];
    shot.forEach((clip,i)=>{
      const key='vis'+lanes[i];
      if(clip.enabled===false || !controls.participates(state?.trackControls,key)) return;
      active.push(clip);
      if(state?.trackControls?.[key]?.solo) solo.push(clip);
    });
    return solo.length ? solo : active;
  }
  function chosen(shot,focus,state,eligible=eligiblePictures(shot ?? [],state)) {
    if(shot?.includes(focus) && focus.videoGroup && focus.enabled!==false) {
      const members=joinedVideoSequence(shot,focus);
      focus=shot.find(clip=>members.includes(clip));
    }
    return eligible.includes(focus) ? focus : eligible[0];
  }
  function audioRow(items, prefix, state) {
    if (!items) return -1;
    const present = (item,i) => {
      if(prefix!=='whole') return Boolean(item) && controls.participates(state.trackControls,prefix+i);
      return Boolean(item?.asset || item?.subtitles) && controls.wholeRowParticipates(state.trackControls,i,Boolean(item.asset),Boolean(item.subtitles));
    };
    const solo = items.findIndex((item,i)=>present(item,i) && (prefix!=='whole' || item.asset) && state.trackControls?.[prefix+i]?.solo);
    return solo >= 0 ? solo : items.findIndex(present);
  }

  function segmentVoiceRows(state) {
    if(!state.segmented) return [];
    const rows=state.segments;
    if(state.segmentNarrationSelection==='random') return rows.map(items=>audioRow(items,'voice',state));
    // Ordered takes follow one physical row through every shot, including its gaps.
    const occupied=new Set();
    for(const items of rows) items?.forEach((asset,i)=>{
      if(asset && controls.participates(state.trackControls,'voice'+i)) occupied.add(i);
    });
    const active=[...occupied].sort((a,b)=>a-b);
    const solo=active.find(i=>state.trackControls?.['voice'+i]?.solo);
    const take=solo ?? active[0];
    return rows.map(items=>items?.[take] ? take : solo===undefined ? -1 : audioRow(items,'voice',state));
  }

  function voiceMap(state, shot, row, voiceRows, available=Infinity) {
    const segment=shot!=null;
    const owner=segment ? state.shots[shot] : null;
    const asset=segment ? state.segments[shot]?.[row] : state.whole[row]?.asset;
    if (!asset) return;
    const speed=state.voiceSpeed?.(asset,owner,row) ?? 1;
    const ranges=segment ? state.voiceRanges?.(owner,row) : undefined;
    const picture=state.priority==='picture';
    const seam=segment && !picture && state.voiceAlignment!=='reference';
    const trimHead=seam && voiceRows[shot-1]>=0, trimTail=seam && voiceRows[shot+1]>=0;
    if (state.narrationTrim?.mode!=='smart') {
      const {narrationStart:trimStart,narrationDuration}=alignment.retainedVoiceRange({narration:asset,narrationRanges:ranges,narrationSpeed:speed},trimHead,trimTail);
      const retained=Math.min(narrationDuration,available), parts=[];
      const sources=waveformSource(ranges ?? [{start:0,end:asset.duration}]);
      let outStart=0;
      sources.visit(trimStart*speed,(trimStart+retained)*speed,false,(start,end)=>{
        const outEnd=outStart+(end-start)/speed;
        parts.push({start,end,outStart,outEnd});
        outStart=outEnd;
      });
      return {parts,duration:retained,trimStart,trimEnd:Math.max(0,sources.duration/speed-trimStart-retained),fadeDuration:0};
    }
    const options={asset,caption:state.voiceCaption?.(asset,shot,row),settings:state.narrationTrim,ranges,speed,picture,trimHead,trimTail,available};
    const proposal=narrationTrim.buildMap(options);
    if (!state.measuredNarration || (!trimHead && !trimTail && !(available>0 && picture && proposal.reason==='hard'))) return proposal;
    const measured=state.measuredNarration(asset,state.pauseJobs);
    return measured===asset ? proposal : narrationTrim.buildMap({...options,asset:measured});
  }

  function narrationTimeline(state,{starts,widths,total,aligned,voiceClock},voiceRows=segmentVoiceRows(state)) {
    const windows=voiceClock?.windows;
    const shotStart=i=>windows?.[i]?.start ?? starts[i] ?? 0;
    const tracks=new Map();
    const wholeRow=state.segmented ? -1 : audioRow(state.whole,'whole',state);
    function track(shot,row) {
      const key=(shot ?? 'whole')+'/'+row;
      if (tracks.has(key)) return tracks.get(key);
      const segment=shot!=null;
      const start=segment ? shotStart(shot)+state.voiceOffset(shot,row)
        : state.priority==='picture' ? shotStart(state.whole[row]?.follow) : 0;
      const end=segment ? windows?.[shot]?.end ?? starts[shot]+widths[shot] : voiceClock?.audioDuration ?? total;
      const map=(segment && row===voiceRows[shot] ? aligned?.[shot]?.narrationMap : null)
        ?? voiceMap(state,shot,row,voiceRows,Math.max(0,end-start));
      const value={start,end,map,active:row===(segment ? voiceRows[shot] : wholeRow)};
      tracks.set(key,value);
      return value;
    }
    function captions(activeOnly=false) {
      if (!state.captionTracks) return (state.captions ?? []).map(caption=>{
        const offset=starts[caption.shot] ?? starts[caption.follow] ?? 0;
        const at=offset+caption.start-(aligned?.[caption.shot]?.narrationStart ?? 0);
        return {...caption,start:Math.max(offset,at),end:Math.min(caption.shot==null ? total : offset+widths[caption.shot],at+caption.duration)};
      });
      return state.captionTracks.flatMap(({shot,row,entry,open,remove})=>{
        const selected=shot==null ? wholeRow : voiceRows[shot] ?? -1;
        if (activeOnly && selected!==row && (selected>=0 || state.segments[shot]?.[row])) return [];
        const {start,end,map}=track(shot,row);
        const source=typeof entry==='string' ? entry : {cues:entry.cues.map(cue=>({...cue,original:cue}))};
        let cues=[];
        if (map && state.narrationTrim?.mode==='smart') cues=narrationTrim.mapCaptions(map,source,start,2001);
        else if (map && typeof source!=='string') {
          const asset=shot==null ? state.whole[row]?.asset : state.segments[shot]?.[row];
          const speed=state.voiceSpeed?.(asset,state.shots[shot],row) ?? 1;
          for (const part of map.parts) {
            alignment.appendLegacyCaptionCues(cues,source,start+part.outStart,part.outEnd-part.outStart,part.start,speed);
            if (cues.length>2000) break;
          }
        } else alignment.appendLegacyCaptionCues(cues,source,start,map?.duration ?? end-start);
        return cues.map(cue=>({shot,row,start:cue.start/1000,end:cue.end/1000,name:cue.text,highlights:cue.highlights,
          key:cue.original ?? 'subtitle:'+shot+'/'+row,open,remove:()=>remove(cue.original)}));
      });
    }
    return {track,captions};
  }

  function needsPictureTiming(clip, fixedDuration) {
    return (clip && alignment.fixedSpeedPolicy(clip)) || clip?.matchedDuration || (fixedDuration && clip?.asset?.kind === 'video' && clip.speed !== undefined && !usesPlacedVideoSource(clip,false));
  }

  function retainedPicture(clip,shotDuration,useFullSource=false) {
    const originalMaterialId=clip.sourceEdit?.asset?.id ?? clip.asset.id;
    if(clip.asset.kind==='image') return {clip,originalMaterialId,start:0,duration:shotDuration ?? clip.end,shotDuration};
    const retained=waveformSource(clip.ranges ?? [{start:clip.start,end:clip.end}],clip.look?.head,clip.look?.tail);
    const speed=placedVideoSpeed(clip) || 1;
    const length=Math.min(retained.duration,!useFullSource && !alignment.fixedSpeedPolicy(clip) && !clip.matchedDuration && shotDuration ? shotDuration*speed : Infinity);
    const ranges=[];
    retained.visit(0,length,false,(start,end)=>ranges.push({start,end}));
    return {clip,originalMaterialId,speed,speedMode:clip.speedMode,speedOverflow:clip.speedOverflow,autoFitSpeed:clip.autoFitSpeed,
      videoWindow:clip.videoWindow,videoDuration:clip.videoDuration,
      matchedDuration:clip.matchedDuration,start:ranges[0]?.start ?? clip.start,sourceDuration:length,duration:length/speed,
      candidateStart:clip.start,retainedRanges:ranges.length>1 ? ranges : undefined,shotDuration};
  }

  // Supply the same retained source intervals and candidate order used by the export planner.
  function voicePictures(state,widths,focus,wholeDuration,voiceRows) {
    const pools=state.shots.map((shot,index)=>{
      const lanes=candidateVideoLanes(shot);
      const eligible=eligiblePictures(shot,state,lanes);
      const first=chosen(shot,focus,state,eligible);
      const fixed=state.settings[index]?.duration;
      const hasVoice=state.segmented ? voiceRows[index]>=0 : wholeDuration>0;
      const useFullSource=state.priority==='voice' && state.voiceAlignment!=='reference' && hasVoice;
      if(!first) return [{duration:widths[index],start:0}];
      const leaders=videoGroupLeaders(eligible,eligible.map(clip=>lanes[shot.indexOf(clip)]));
      return [first,...leaders.filter(clip=>clip!==first)].map(clip=>{
        const shotDuration=clip.videoFit==='hold' ? fixed ?? clip.matchedDuration : clip.matchedDuration ?? fixed;
        return {...retainedPicture(clip,shotDuration,useFullSource),shotIndex:index,hiddenVideo:!controls.allows(state.trackControls,'vis'+lanes[shot.indexOf(clip)],'visual')};
      });
    });
    const clips=pools.map(([picture],i)=>{
      const row=voiceRows[i] ?? -1;
      if(row<0) return picture;
      const narration=state.segments[i][row], shot=state.shots[i];
      const narrationMap=state.narrationTrim?.mode==='smart' && state.priority==='voice' && state.voiceAlignment!=='reference' ? voiceMap(state,i,row,voiceRows) : undefined;
      return {...picture,narration,narrationMap,narrationRanges:state.voiceRanges(shot,row),
        narrationSpeed:state.voiceSpeed?.(narration,shot,row),voiceOffset:state.voiceOffset(i,row)};
    });
    const fps=state.fps || 30;
    const options={range:state.autoSpeedRange,choices:state.draftSpeedChoices,report:state.onSpeedChallenge};
    if(state.priority!=='voice' || !(state.segmented ? clips.some(clip=>clip.narration) : wholeDuration)) {
      return pools.map(pool=>needsPictureTiming(pool[0].clip,pool[0].shotDuration) ?
        alignment.fitSegmentedVoice([pool[0]],[pool],fps,'fill',true,options)[0] : null);
    }
    if(state.segmented) return alignment.fitSegmentedVoice(clips,pools,fps,state.voiceAlignment ?? 'fill',false,options);
    if(state.voiceAlignment==='reference') return alignment.fitReferenceWhole(clips,wholeDuration,fps,pools,options);
    return alignment.fitWholeVoice(clips,pools,wholeDuration,fps,options);
  }

  function timing(state,clipSpan,assetFor,focus) {
    const {shots,settings,whole,segmented,priority}=state;
    const voiceRows=segmentVoiceRows(state);
    const fps=state.fps || 30;
    const wholeVoice=whole[audioRow(whole,'whole',state)];
    const wholeDuration=wholeVoice?.asset ? wholeVoice.asset.duration/(state.voiceSpeed?.(wholeVoice.asset,null,whole.indexOf(wholeVoice)) ?? 1) : 0;
    const hasSegmentVoice=voiceRows.some(row=>row>=0);
    const sourceWidths=Array.from({length:shots.length || 3},(_,i)=>{
      const clip=chosen(shots[i],focus,state);
      const row=voiceRows[i] ?? -1;
      const speech=row<0 ? 0 : state.voiceDuration(i,row)+state.voiceOffset(i,row);
      const fixed=settings[i]?.duration;
      const duration=clip?.videoFit==='hold' ? fixed ?? clip.matchedDuration : clip?.matchedDuration ?? fixed;
      return (priority==='voice' && speech) || duration || (clip && clipSpan(clip)) || speech || 3;
    });
    const hasPictures=shots.some(shot=>chosen(shot,focus,state));
    const useVoiceClock=state.narrationTrim && priority==='picture' && hasPictures && (hasSegmentVoice || (!segmented && (wholeDuration || wholeVoice?.subtitles)));
    let widths=sourceWidths.map(width=>Math.max(useVoiceClock ? 1/fps : .1,width));
    let target=!segmented && priority==='voice' ? wholeDuration : 0;
    let preserve=0;
    if (!hasPictures && !settings.some((row)=>row?.duration) && !hasSegmentVoice) {
      const pack=controls.enabledPackaging(state.pack,state.trackControls);
      const sounds=[...pack.global,...(pack.composites.find((row)=>row.length) ?? [])];
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
        audioEnd(state.musicAt,music ? music.duration/(state.musicSpeed?.(music) ?? 1) : 0),...lengths);
    }
    let aligned;
    if((priority==='voice' && (segmented ? hasSegmentVoice : wholeDuration) && hasPictures) ||
        shots.some((shot,i)=>needsPictureTiming(chosen(shot,focus,state),settings[i]?.duration))) {
      aligned=voicePictures(state,widths,focus,wholeDuration,voiceRows);
      widths=widths.map((width,i)=>aligned[i]?.timelineDuration ?? aligned[i]?.outputDuration ?? width);
    } else if (target>0) {
      const prefix=widths.slice(0,preserve).reduce((sum,width)=>sum+width,0);
      const factor=(target-prefix)/widths.slice(preserve).reduce((sum,width)=>sum+width,0);
      widths=widths.map((width,index)=>index<preserve ? width : width*factor);
    }
    let placedEnd=0, total=0;
    const starts=widths.map((width)=>{const from=total;total+=width;return from;});
    shots.forEach((shot,i)=>{
      const lanes=candidateVideoLanes(shot);
      for(const [j,clip] of shot.entries()) {
        if(!controls.participates(state.trackControls,'vis'+lanes[j])) continue;
        if(clip.videoStart!==undefined) placedEnd=Math.max(placedEnd,clip.videoStart+pictureSpan(clip,widths[i]));
        for(const gap of clip.videoGaps ?? []) placedEnd=Math.max(placedEnd,gap.start+gap.span);
      }
    });
    total=Math.max(total,placedEnd);
    let voiceClock;
    if (useVoiceClock) {
      // Picture edits share frame boundaries, but their voice can stop inside the last frame.
      const audioDuration=Math.max(placedEnd,sourceWidths.reduce((sum,width)=>sum+Math.max(1/fps,width),0));
      let frames=0;
      const windows=alignment.pictureFrames(sourceWidths,fps).map((count,i)=>{
        const start=frames/fps;
        frames+=count;
        return {start,end:Math.min(audioDuration,start+Math.min(count/fps,sourceWidths[i]))};
      });
      voiceClock={windows,audioDuration};
      if (state.narrationTrim.mode==='smart') total=Math.max(frames/fps,Math.ceil(audioDuration*fps-1e-7)/fps);
    }
    return {widths,starts,total,...(aligned && {aligned}),...(voiceClock && {voiceClock})};
  }

  function makePlan(s,{starts,widths,total,aligned,voiceClock},assetFor,sourceRanges,focus) {
    const entries=[];
    const voiceRows=segmentVoiceRows(s);
    const pack=controls.enabledPackaging(s.pack,s.trackControls);
    const placed=s.shots.flatMap(shot=>{
      const lanes=candidateVideoLanes(shot);
      return shot.filter((clip,i)=>controls.participates(s.trackControls,'vis'+lanes[i]));
    });
    let trimmedShotEnd=s.shots.at(-1)?.length===0 || placed.some(clip=>clip.videoGaps?.length) ? total : 0;
    const freePictures=placed.some(clip=>clip.videoStart!==undefined);
    const wholeRow=s.segmented ? -1 : audioRow(s.whole,'whole',s), whole=s.whole[wholeRow];
    if(!freePictures && aligned && whole?.asset && s.priority==='voice') {
      total=Math.min(total,whole.asset.duration/(s.voiceSpeed?.(whole.asset,null,wholeRow) ?? 1));
    }
    const speech=narrationTimeline(s,{starts,widths,total,aligned,voiceClock},voiceRows);
    function addText(text,start,end,appearance,key,highlights) {
      if(!text || end<=start || start>=total || !controls.allows(s.trackControls,key,'visual')) return;
      entries.push({text,start,end:Math.min(end,total),appearance,highlights,visual:true});
    }
    function add(lane,asset,start,span,{ranges,head,tail,volume=100,visual=false,loop=false,layer,speed=1,cycle,cycleParts,trackKey,hold=false}={}) {
      if(!asset?.url || !(span>0) || start>=total || (!visual && !(volume>0))) return;
      const key=trackKey ?? controls.layerKey(layer);
      if (!controls.participates(s.trackControls,key)) return;
      if (!controls.allows(s.trackControls,key,'visual')) visual=false;
      if (!controls.allows(s.trackControls,key,'audio')) volume=0;
      const stop=Math.min(total,start+span);
      const base={lane,asset,volume,visual,layer};
      if(cycle) { entries.push({...base,start,end:stop,source:ranges[0].start,rate:speed,cycle,...(cycleParts && {cycleParts})}); return; }
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
        if(!controls.participates(s.trackControls,controls.layerKey(layer))) continue;
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
    const textGroups=pack.textGroups ?? [];
    const firstTextGroup=textGroups.find(row=>row.some(items=>items?.length));
    s.shots.forEach((shot,i)=>{
      const at=starts[i],span=widths[i];
      if(pack.textMode==='segmented') {
        const group=pack.textSelection==='random' ? textGroups.find(row=>row[i]?.length) : firstTextGroup;
        layers(group?.[i],at,span);
      }
      const selected=chosen(shot,focus,s);
      const voicePriority=s.priority==='voice' && (s.segmented ? voiceRows[i]>=0 : Boolean(whole?.asset));
      const lanes=candidateVideoLanes(shot), timed=aligned?.[i];
      const soloSequence=soloLaneSequence(shot,selected,s.trackControls,span);
      const joined=soloSequence.length ? soloSequence : joinedVideoSequence(shot,selected);
      const sequence=joined.length ? joined : [selected];
      // An eye toggle changes only the picture. Keep the chosen candidate's
      // audio and shot clock, and reveal visible lanes in their actual windows.
      const revealLower=selected && s.trackControls?.['vis'+lanes[shot.indexOf(selected)]]?.hidden;
      const pictures=revealLower ? sequence.concat(shot.filter((clip,j)=>clip.enabled!==false
        && controls.allows(s.trackControls,'vis'+lanes[j],'visual') && !sequence.includes(clip))) : sequence;
      for(const [position,clip] of pictures.entries()) {
        const fallback=position>=sequence.length;
        // Reference speech can end before the shot. Its independently placed pictures
        // still play through their stored windows, as in the export plan.
        const beyondVoice=aligned && !timed && !s.segmented && s.priority==='voice';
        const heldWindow=clip?.videoWindow!==undefined && (timed?.outputDuration ?? span)<clip.videoWindow-1e-7;
        const hold=clip?.videoFit==='hold' || soloSequence.length>0 || heldWindow ||
          (beyondVoice && (clip?.videoGroup || clip?.videoGaps?.length || clip?.videoWindow!==undefined));
        const placedSource=hold || usesPlacedVideoSource(clip,voicePriority);
        const pictureAt=clip?.videoStart ?? at;
        const visibleSpan=pictureSpan(clip,span);
        if(hold) trimmedShotEnd=total;
        if(visibleSpan<span) trimmedShotEnd=Math.max(trimmedShotEnd,Math.min(total,at+span));
        // Independently placed pictures can overlap. Keep a separate media element per physical row.
        const pictureLane=freePictures || fallback ? 'picture:'+lanes[shot.indexOf(clip)]+':'+i : 'picture';
        if(!fallback && !placedSource && aligned && !timed && voicePriority && !s.segmented) continue;
        let pictureTiming=fallback ? undefined : timed;
        if(fallback && !placedSource && needsPictureTiming(clip,visibleSpan)) {
          const picture=retainedPicture(clip,visibleSpan);
          pictureTiming=alignment.fitSegmentedVoice([picture],[[picture]],s.fps || 30,'fill',true)[0];
        }
        const chosenPolicy=pictureTiming?.clip===clip && pictureTiming?.speedOverflow ? pictureTiming : clip;
        const fixedPicture=Boolean(chosenPolicy && alignment.fixedSpeedPolicy(chosenPolicy));
        if(clip && placedSource && fixedPicture) {
          const pool=[clip,...eligiblePictures(shot,s).filter(c=>c!==clip && controls.allows(s.trackControls,'vis'+lanes[shot.indexOf(c)],'visual'))]
            .map(c=>retainedPicture(c,undefined,true));
          const primary=chosenPolicy===clip ? pool[0] : {...pool[0],speed:chosenPolicy.speed,speedOverflow:chosenPolicy.speedOverflow,
            duration:pool[0].sourceDuration/chosenPolicy.speed};
          pictureTiming=alignment.fixedSpeedVisuals(primary,pool,visibleSpan,Math.max(1,Math.round(visibleSpan*(s.fps || 30))),s.fps || 30);
        }
        if(pictureTiming && clip && (!placedSource || fixedPicture)) {
          const parts=pictureTiming.visuals ?? [pictureTiming];
          let offset=pictureAt;
          for(const part of parts) {
            const owner=part.clip;
            const length=Math.min(pictureAt+visibleSpan-offset,part.outputDuration);
            if(!owner || !(length>0)) continue;
            const speed=part.speed || 1, repeats=part.repeat || 1;
            const source=part.sourceDuration ?? part.duration*speed;
            const volume=!fallback && s.keepAudio && !owner.sourceMuted && !s.muted.has(lanes[shot.indexOf(owner)]) ? (owner.volume ?? 100) : 0;
            add(pictureLane,owner.asset,offset,length,{ranges:[{start:part.start,end:part.start+source}],
              speed,visual:true,volume,trackKey:'vis'+lanes[shot.indexOf(owner)],hold:part.holdLast,
              cycle:repeats>1 ? (part.cycleParts ? part.duration*speed : source) : 0,cycleParts:part.cycleParts});
            if(!fallback && (owner.layers?.length || owner.videoSubtitles)) {
              alignment.visitVisualIntervals(part,length,(piece,elapsed,segment,rate)=>{
                layers(owner.layers,offset+elapsed,segment,piece.start-owner.start,rate);
                pictureCaptions(owner,offset+elapsed,segment,piece.start,rate);
              });
            }
            offset+=length;
          }
        } else if(clip) {
          const volume=!fallback && s.keepAudio && !clip.sourceMuted && !s.muted.has(lanes[shot.indexOf(clip)]) ? (clip.volume ?? 100) : 0;
          const ranges=clip.ranges ?? [{start:clip.start,end:clip.end}];
          const source=sourceRanges(ranges,clip.look?.head,clip.look?.tail);
          const speed=placedSource ? placedVideoSpeed(clip) : source.duration/span;
          add(pictureLane,clip.asset,pictureAt,visibleSpan,{ranges,head:clip.look?.head,tail:clip.look?.tail,
            visual:true,volume,trackKey:'vis'+lanes[shot.indexOf(clip)],speed,hold});
          if(fallback) continue;
          let offset=pictureAt;
          source.visit(0,Math.min(source.duration,visibleSpan*speed),false,(begin,end)=>{
            const length=(end-begin)/speed;
            layers(clip.layers,offset,length,begin-(clip.start ?? 0),speed);
            pictureCaptions(clip,offset,length,begin,speed);
            offset+=length;
          });
        }
      }
      if(s.segmented && voiceRows[i]>=0) appendVoice(i,voiceRows[i],s.segments[i][voiceRows[i]],pack.segmentNarration[i]?.[voiceRows[i]]);
    });
    function appendVoice(shot,row,asset,items) {
      const {start,map}=speech.track(shot,row);
      const volume=s.voiceVolume(asset,shot==null ? null : s.shots[shot],row);
      const key=(shot==null ? 'whole' : 'voice')+row;
      const speed=s.voiceSpeed?.(asset,shot==null ? null : s.shots[shot],row) ?? 1;
      const fadeEnd=start+map.duration;
      for (const part of map.parts) {
        const at=start+part.outStart, length=part.outEnd-part.outStart;
        if (asset.url && volume>0 && controls.participates(s.trackControls,key)) entries.push({
          lane:'voice',asset,start:at,end:at+length,source:part.start,rate:speed,volume:controls.allows(s.trackControls,key,'audio') ? volume : 0,visual:false,
          ...(map.fadeDuration && at+length>fadeEnd-map.fadeDuration && {fadeEnd,fadeDuration:map.fadeDuration}),
        });
        layers(items,at,length,part.start,speed);
      }
    }
    if(whole?.asset) appendVoice(null,wholeRow,whole.asset,pack.wholeNarration[wholeRow]);
    const musicRow=audioRow(s.music,'music',s);
    if(musicRow>=0) {
      const at=starts[s.musicAt] ?? 0, asset=s.music[musicRow];
      add('music',asset,at,total-at,{volume:s.musicVolume(asset),loop:true,speed:s.musicSpeed?.(asset) ?? 1,trackKey:'music'+musicRow});
    }
    layers(pack.global,0,total);
    layers(pack.composites.find((items)=>items.length),0,total);
    if(pack.textMode==='whole') layers(textGroups.find(row=>row[0]?.length)?.[0],0,total);
    if(style.enabled!==false) {
      for(const caption of speech.captions(true)) {
        const ownerActive=caption.shot==null
          ? controls.wholeRowParticipates(s.trackControls,caption.row,Boolean(s.whole[caption.row]?.asset),true)
          : controls.participates(s.trackControls,'voice'+caption.row);
        if(!ownerActive) continue;
        const chosen=caption.shot==null ? wholeRow : voiceRows[caption.shot] ?? -1;
        if(chosen!==caption.row && (chosen>=0 || s.segments[caption.shot]?.[caption.row])) continue;
        addText(caption.name,caption.start,caption.end,style,'caption'+caption.row,caption.highlights);
      }
      for(const cue of s.timelineCaptions ?? []) addText(cue.text,cue.start/1000,cue.end/1000,style,'pasted-captions',cue.highlights);
    }
    if (s.narrationTrim?.mode==='smart' && s.priority==='picture' && (whole?.asset || voiceRows.some(i=>i>=0))) trimmedShotEnd=total;
    if (trimmedShotEnd) {
      const lastEnd=entries.reduce((end,entry)=>Math.max(end,entry.end),0);
      if(lastEnd>0 && lastEnd<trimmedShotEnd) entries.push({gap:true,start:lastEnd,end:trimmedShotEnd});
    }
    return entries.sort((a,b)=>a.start-b.start);
  }

  function transport(stage,{tick,changed,previewSource,handoff,getRange}) {
    const overlay=document.createElement('div');
    overlay.className='draft-transport-preview';overlay.hidden=true;
    const label=document.createElement('span');
    overlay.append(label);stage.append(overlay);
    let playing=false, media=new Map(), entries=[], active=[], next=0, time=0, end=0, stamp, frame;
    let visual=false, canProxy=false, priming=false;
    let currentPicture, preloadQueues=[], reverseEntries;
    let shuttleRate=1, shuttling=false;
    function bounds() {
      const range=getRange?.();
      const start=Math.max(0,range?.inPoint ?? 0), stop=Math.min(end,range?.outPoint ?? end);
      return range?.loop && range.inPoint!=null && range.outPoint!=null && stop>start
        ? {start,stop,loop:true} : {start:0,stop:end,loop:false};
    }
    function playbackStart(from) {
      const {start,stop}=bounds();
      if(shuttleRate<0) return from<=start || from>stop ? stop : from;
      return from<start || from>=stop-.001 ? start : from;
    }
    const warmed=new Map();
    const textNodes=new Map();
    const failed=new Set();
    function release(item) {
      item.released=true;
      const {node}=item;
      if(item.endFrameCallback!==undefined) node.cancelVideoFrameCallback(item.endFrameCallback);
      const wasOnStage=node.isConnected;
      node.remove();
      if(node.tagName==='IMG') return;
      node.pause();
      const unload=()=>{node.removeAttribute('src');node.load();};
      // Clearing an attached video's decoder can blank the old compositor
      // surface even before Chromium commits the canvas/new video above it.
      if(wasOnStage && node.tagName==='VIDEO') requestAnimationFrame(()=>requestAnimationFrame(unload));
      else unload();
    }
    function discardWarm() {
      for(const item of warmed.values()) release(item);
      warmed.clear();
    }
    function halt(keepFrame=false, keepCover=false) {
      cancelAnimationFrame(frame);
      discardWarm();
      const visible=!overlay.hidden;
      playing=false;shuttling=false;shuttleRate=1;
      for(const item of media.values()) {
        if(keepFrame && item.node.tagName!=='IMG') item.node.pause();
        else if(!keepFrame) release(item);
      }
      if(!keepFrame) {
        if(!keepCover) handoff.clear(overlay);
        currentPicture=undefined;
        for(const node of textNodes.values()) node.remove();
        textNodes.clear();media.clear();overlay.hidden=true;
      }
      if(visible) changed(false);
    }
    function preparedRate(entry) {
      return (entry.visual || entry.volume>0) && shouldRetimeVideo(entry.asset,entry.rate) ? entry.rate : 1;
    }
    function createItem(entry) {
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
      const retimeRate=preparedRate(entry);
      const proxy=previewSource?.(entry.asset,retimeRate,playing);
      const item={node,asset:entry.asset,entry:null,targetSet:false,waitingSince:0,mayUseProxy:Boolean(proxy),
        retimeRate,sourceScale:1,preparingSince:playing && proxy && retimeRate>1 ? performance.now() : 0};
      if (proxy) Promise.resolve(proxy).catch(()=>null).then(source=>{
        if (item.released || !item.mayUseProxy) return;
        item.mayUseProxy=Boolean(source);
        item.reduced=Boolean(source?.reduced);
        item.sourceScale=source?.sourceScale ?? 1;
        item.mediaFps=source?.fps;
        item.preparingSince=0;
        node.src=source?.url || entry.asset.url;
      });
      else node.src=entry.asset.url;
      return item;
    }
    function prepareNextMedia(at) {
      for(const [entry,item] of warmed) {
        if(entry.start>at) continue;
        release(item);warmed.delete(entry);
      }
      if(!playing || shuttleRate<0) return;
      for(const queue of preloadQueues) {
        while(queue.index<queue.entries.length && queue.entries[queue.index].start<=at) queue.index++;
        const entry=queue.entries[queue.index];
        if(!entry || warmed.has(entry) || failed.has(entry.asset)) continue;
        const rate=preparedRate(entry), current=media.get(entry.lane);
        if(entry.start-at>(rate>1 ? 4 : 1) || (current?.asset===entry.asset && current.retimeRate===rate)) continue;
        const item=createItem(entry);
        warmed.set(entry,item);
        if(item.node.tagName!=='IMG' && entry.source>0) {
          item.node.addEventListener('loadedmetadata',()=>{
            if(warmed.has(entry)) item.node.currentTime=entry.source/item.sourceScale;
          },{once:true});
        }
      }
    }
    function retryOriginal(item) {
      if (!item.mayUseProxy) return false;
      item.mayUseProxy=false;
      item.preparingSince=0;item.sourceScale=1;item.reduced=false;item.mediaFps=undefined;
      item.waitingSince=0;
      item.targetSet=false;
      item.node.src=item.asset.url;
      return true;
    }
    function protectLastFrame(item,entry,sourceTime) {
      const node=item.node;
      const remaining=node.duration-sourceTime;
      if(!playing || !Number.isFinite(remaining) || remaining>.3 || node.seeking) {
        item.heldEnd=false;
        return;
      }
      if(item.endFrameCallback!==undefined || item.heldEnd) return;
      // Some decoders withdraw their presentation surface at native EOS,
      // before the timeline's next animation tick. Retain the last actual
      // source frame while its audio plays to the edit point.
      function presented(_now,{mediaTime}) {
        item.endFrameCallback=undefined;
        if(item.released || !playing || currentPicture!==entry || node.seeking || node.duration-node.currentTime>.3) return;
        if(node.duration-mediaTime <= 1/(item.mediaFps || entry.asset.fps || 30)+.002) {
          item.heldEnd=handoff.retain(node);
        } else item.endFrameCallback=node.requestVideoFrameCallback(presented);
      }
      item.endFrameCallback=node.requestVideoFrameCallback(presented);
    }
    function render() {
      // Only visit newly crossed boundaries and the currently visible lanes.
      const stop=playing && shuttleRate<0 ? bounds().stop : end;
      const at=Math.max(0,Math.min(time,stop-1e-6));
      if(shuttleRate<0) {
        reverseEntries ??= [...entries].sort((a,b)=>b.end-a.end);
        active=active.filter(entry=>entry.start<=at);
        while(next<reverseEntries.length && reverseEntries[next].end>at) {
          const entry=reverseEntries[next++];
          if(!entry.gap && entry.start<=at) active.push(entry);
        }
      } else {
        active=active.filter(entry=>entry.end>at);
        while(next<entries.length && entries[next].start<=at) {
          const entry=entries[next++];if(!entry.gap && entry.end>at)active.push(entry);
        }
      }
      // Sort order mirrors the rendered z-index across independently placed lanes.
      let picture, pictureOrder=-Infinity;
      for(const entry of active) {
        if(!entry.visual || !entry.asset || entry.layer || failed.has(entry.asset)) continue;
        let order=0;
        if(entry.lane.startsWith('picture:')) {
          const [,row,shot]=entry.lane.split(':');
          order=(100-Number(row))*1000+Number(shot);
        }
        if(order>=pictureOrder) {picture=entry;pictureOrder=order;}
      }
      if(picture!==currentPicture) {
        if(picture) {handoff.capture();handoff.moveTo(overlay);}
        currentPicture=picture;
      }
      if(!picture) handoff.clear(overlay);
      const live=new Set();let ready=true,preparing=false;
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
        if(item?.asset!==entry.asset || item.retimeRate!==preparedRate(entry) || item.node.hidden===entry.visual) {
          if(item) release(item);
          item=warmed.get(entry) ?? createItem(entry);
          warmed.delete(entry);
          media.set(entry.lane,item);
          overlay.append(item.node);
        }
        const node=item.node;
        const now=performance.now();
        item.activeSince??=now;
        // At a running cut, keep the original playable if the upcoming cache
        // missed its deadline. A late completion is used on the next playback.
        if(item.preparingSince && now-item.activeSince>(priming ? 10000 : 100)) retryOriginal(item);
        if(item.preparingSince && now-item.preparingSince>200) preparing=true;
        if(node.tagName!=='IMG' && !item.preparingSince && (node.readyState<2 || node.seeking)) item.waitingSince ||= now;
        else item.waitingSince=0;
        if(node.error || (item.waitingSince && now-item.waitingSince>10000)) {
          if(retryOriginal(item)) ready=false;
          else failed.add(entry.asset);
          continue;
        }
        if(node.tagName==='IMG') {
          if(node.complete && !node.naturalWidth && node.src) failed.add(entry.asset);
          else if(!node.complete || !node.naturalWidth) ready=false;
          if(entry===picture) handoff.revealWhen(node);
          continue;
        }
        if(item.entry!==entry) {
          item.entry=entry;item.heldEnd=false;item.targetSet=false;item.sampleReady=false;
          item.lastSample=undefined;item.cycleIndex=undefined;
          node.volume=Math.max(0,Math.min(1,entry.volume/100));node.muted=!node.volume;
        }
        if (entry.fadeDuration) {
          const envelope=Math.max(0,Math.min(1,(entry.fadeEnd-at)/entry.fadeDuration));
          const gain=Math.max(0,Math.min(1,entry.volume/100))*envelope;
          if (node.volume!==gain) node.volume=gain;
        }
        if(node.readyState<1) {ready=false;continue;}
        let source=entry.source+(at-entry.start)*entry.rate;
        if(entry.loop)source%=entry.asset.duration;
        if(entry.cycle) {
          let cycleIndex=Math.floor((source-entry.source)/entry.cycle);
          let offset=(source-entry.source)%entry.cycle;
          if (entry.cycleParts) {
            let index=0;
            while (index+1<entry.cycleParts.length && offset>=entry.cycleParts[index].sourceDuration) {
              offset-=entry.cycleParts[index++].sourceDuration;
            }
            source=entry.cycleParts[index].start+offset;
            cycleIndex=cycleIndex*entry.cycleParts.length+index;
          } else source=entry.source+offset;
          if(cycleIndex!==item.cycleIndex) item.targetSet=false;
          item.cycleIndex=cycleIndex;
        }
        // Outside Chromium's native rate range, sample on the composition
        // clock, allowing one outstanding seek while the other lanes continue playing.
        const effectiveRate=entry.rate*shuttleRate/item.sourceScale;
        item.sampled=shuttleRate<0 || sampleVideoRate(effectiveRate);
        if(item.sampled) {
          if(!node.paused) node.pause();
          // Chromium has no backwards media clock. Keep audio silent while
          // shuttling backwards and seek each visible decoder independently.
          if(!entry.visual) continue;
          const halfFrame=.5/(item.mediaFps || entry.asset.fps || 30);
          const sourceEnd=entry.loop || entry.cycleParts ? entry.asset.duration : entry.source+(entry.cycle || (entry.end-entry.start)*entry.rate);
          const first=entry.cycleParts || entry.loop ? 0 : entry.source/item.sourceScale;
          const last=Math.min(entry.asset.duration,sourceEnd)/item.sourceScale-halfFrame;
          const target=Math.min(source/item.sourceScale,Math.max(first,last));
          if(!node.seeking) {
            if(item.targetSet && node.readyState>=2) {
              item.sampleReady=true;
              if(item.lastSample!==node.currentTime && entry===picture && handoff.retain(node)) {
                item.lastSample=node.currentTime;
              }
            }
            if(Math.abs(node.currentTime-target)>halfFrame) node.currentTime=target;
            item.targetSet=true;
          }
          if(!item.sampleReady || (!playing && (node.seeking || node.readyState<2))) ready=false;
          continue;
        }
        const frozen=entry.rate===0;
        if(frozen && !node.paused)node.pause();
        source/=item.sourceScale;
        const rate=frozen ? 1 : Math.max(.0625,Math.min(16,effectiveRate));
        if(node.playbackRate!==rate)node.playbackRate=rate;
        // Media time is measured in source seconds. A 5.67× source moves
        // 0.28 seconds in just 50 ms of timeline time.
        const drift=Math.abs(node.currentTime-source);
        const outOfSync=playing && !priming && node.readyState>=2 && !node.seeking && !frozen &&
          now>=item.nextSync && drift>.20*Math.max(1,rate);
        if(!item.targetSet || outOfSync) {
          if(drift>(frozen ? 1e-7 : .015))node.currentTime=source;
          // Give a decoder time to present after a seek before correcting again.
          item.nextSync=now+400;
          item.targetSet=true;
        }
        if(entry===picture) {
          protectLastFrame(item,entry,source);
          if(!item.heldEnd) handoff.revealWhen(node);
        }
        if(node.readyState<2 || node.seeking) {ready=false;continue;}
      }
      if(picture && failed.has(picture.asset)) handoff.clear(overlay);
      for(const [lane,item] of media) if(!live.has(lane) || failed.has(item.asset)) {release(item);media.delete(lane);}
      for(const [entry,node] of textNodes) if(!live.has(entry)) {node.remove();textNodes.delete(entry);}
      const visuals=active.some((e)=>e.visual && !failed.has(e.asset));
      label.hidden=!entries.length || (visuals && !preparing);
      label.classList.toggle('draft-preparing',preparing);
      if(!label.hidden) {
        const message=preparing ? '正在准备倍速预览…' : active.filter(e=>e.asset && !failed.has(e.asset)).map(e=>e.asset.name).join(' · ') || '轨道试听';
        if(label.textContent!==message) label.textContent=message;
      }
      // Start (or seek) the composition together. Once rolling, a decoding
      // video must not repeatedly stop narration, music or the timeline clock.
      if(ready) priming=false;
      for(const item of media.values()) {
        const {node,asset}=item;
        if(node.tagName==='IMG')continue;
        if(!playing || priming || item.entry?.rate===0 || item.sampled) {if(!node.paused)node.pause();continue;}
        if(node.paused && !node.ended && !node.seeking && node.readyState>=2) {
          const src=node.src;
          node.play().catch(error=>{
            if(error.name!=='AbortError' && node.isConnected && node.src===src && !retryOriginal(item)) failed.add(asset);
          });
        }
      }
      prepareNextMedia(at);
      return ready;
    }
    function step(now) {
      if(!playing) return;
      const {start,stop,loop}=bounds();
      const target=priming ? time : time+Math.max(0,(now-stamp)/1000)*shuttleRate;
      const finished=shuttleRate>0 ? target>=stop : target<=start;
      if(loop && (finished || target<start || target>stop)) {
        const span=stop-start;
        const offset=((target-start)%span+span)%span;
        seek(shuttleRate<0 && offset===0 ? stop : start+offset);
        return;
      }
      time=Math.max(start,Math.min(stop,target));stamp=now;
      render();tick(time);
      if(finished || (failed.size && entries.every((e)=>e.gap || failed.has(e.asset)))) {
        pause();
        return;
      }
      frame=requestAnimationFrame(step);
    }
    function setPlan(plan) {
      discardWarm();
      entries=plan;reverseEntries=undefined;active=[];next=0;
      // Preload the next picture and independently timed sounds before a cut.
      preloadQueues=[
        plan.filter(entry=>entry.asset && entry.visual && !entry.layer),
        plan.filter(entry=>entry.asset?.kind==='video' && !entry.visual && entry.volume>0 && !entry.layer),
        plan.filter(entry=>entry.lane==='voice'),
        plan.filter(entry=>entry.lane==='music'),
      ].filter(entries=>entries.length).map(entries=>({entries,index:0}));
      end=entries.reduce((max,entry)=>Math.max(max,entry.end),0);
      visual=entries.some(entry=>entry.visual);
      canProxy=entries.some(({asset})=>asset?.kind==='video' && !asset.alpha && Math.max(asset.width,asset.height)>480);
    }
    function updatePlan(plan) {
      setPlan(plan);seek(time);
      changed(playing);
    }
    function scrub(getPlan,seconds) {
      if(overlay.hidden) {
        const plan=getPlan();
        if(plan.length) {handoff.capture();handoff.moveTo(overlay);}
        document.getElementById('preview')?.pause();
        failed.clear();setPlan(plan);overlay.hidden=false;changed(false);
      } else if(playing) halt(true);
      seek(seconds);
    }
    function pause() {
      if(!playing) return;
      const align=shuttling || media.get(currentPicture?.lane)?.sampled;
      halt(true);
      if(align) seek(time);
    }
    function shuttle(direction) {
      shuttleRate=shuttling && Math.sign(shuttleRate)===direction ? direction*Math.min(8,Math.abs(shuttleRate)*2) : direction;
      shuttling=true;
      seek(playbackStart(time));
      changed(true);
    }
    function toggle(plan,from,rate) {
      if(playing){pause();return true;}
      if(!plan.length) return false;
      handoff.capture();handoff.moveTo(overlay);
      halt(false,true);failed.clear();setPlan(plan);
      shuttleRate=rate ?? 1;shuttling=rate!==undefined;
      time=playbackStart(from);
      document.getElementById('preview')?.pause();
      overlay.hidden=false;playing=true;priming=true;changed(true);tick(time);
      stamp=performance.now();render();frame=requestAnimationFrame(step);return true;
    }
    function seek(seconds,reloadSources=false) {
      if(overlay.hidden) return;
      cancelAnimationFrame(frame);
      if(reloadSources) {
        handoff.capture();
        for(const item of media.values()) release(item);
        media.clear();failed.clear();
      }
      // An empty composition stays on the monitor. Preserve its playhead so
      // re-enabling a take can reveal the same position without loading a source preview.
      if(!entries.length) playing=false;
      discardWarm();
      for(const queue of preloadQueues) queue.index=0;
      const {start,stop}=playing ? bounds() : {start:0,stop:end};
      active=[];next=0;time=Math.max(start,entries.length ? Math.min(stop,seconds) : seconds);
      for(const item of media.values()) {
        item.targetSet=false;item.heldEnd=false;item.sampleReady=false;
        if(item.endFrameCallback!==undefined) {
          item.node.cancelVideoFrameCallback(item.endFrameCallback);
          item.endFrameCallback=undefined;
        }
      }
      priming=playing;stamp=performance.now();
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
        if(item.reduced && item.node.tagName==='VIDEO' && item.node.readyState>=1 && item.node.currentSrc!==item.asset.url) {
          proxy=true;
          break;
        }
      }
      return {time,end,playing,visual,canProxy,proxy,shuttling:playing && shuttling,rate:playing ? shuttleRate : 0};
    }
    function stopForScrub() {
      if(overlay.hidden) return;
      handoff.capture();handoff.moveTo(stage.querySelector('.player-picture'));
      halt();
    }
    return {toggle,shuttle,pause,updatePlan,scrub,seek,state,stop:()=>halt(),stopForScrub,playing:()=>playing};
  }
  const api={chosen,timing,narrationTimeline,makePlan,transport};
  if(typeof module==='object' && module.exports) module.exports=api;
  else window.draftTimeline=api;
})();

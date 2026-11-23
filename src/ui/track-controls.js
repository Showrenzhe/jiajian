'use strict';

(() => {
  const video = /^vis\d+$/;
  const audio = /^(voice|whole|music)\d+$/;
  const captions = /^(caption\d+|local-subtitles|pasted-captions)$/;
  const layer = /^layer-(text|pip|sound|sticker)-[a-zA-Z0-9_-]{1,80}$/;
  const soloCache = new WeakMap();
  const {candidateVideoLanes}=typeof module==='object' && module.exports ? require('./track-tools.js') : window;

  function layerKey(item) {
    return item?.laneId ? 'layer-'+item.kind+'-'+item.laneId : undefined;
  }
  function actions(key) {
    if (video.test(key)) return ['locked','hidden','muted','solo'];
    if (audio.test(key)) return ['locked','muted','solo'];
    if (captions.test(key)) return ['locked','hidden'];
    if (key==='shot-strip') return ['locked'];
    const kind = layer.exec(key)?.[1];
    if (kind==='sound') return ['locked','muted'];
    if (kind==='pip') return ['locked','hidden','muted'];
    return kind ? ['locked','hidden'] : [];
  }
  function normalize(value) {
    if (value===undefined) return {};
    if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('轨道控制状态无效。');
    const result={};
    for (const [key,flags] of Object.entries(value)) {
      const choices=actions(key);
      if (!choices.length || !flags || typeof flags!=='object' || Array.isArray(flags)) throw Error('轨道控制状态无效。');
      const row={};
      for (const [action,on] of Object.entries(flags)) {
        if (!choices.includes(action) || typeof on!=='boolean' || (video.test(key) && action==='muted')) throw Error('轨道控制状态无效。');
        if (on) row[action]=true;
      }
      if(Object.keys(row).length) result[key]=row;
    }
    return result;
  }
  // Track state is replaced on every edit and restore; audio and visual solos act independently.
  function allows(state,key,channel) {
    if (!state) return true;
    if (state[key]?.[channel==='audio'?'muted':'hidden']) return false;
    let solo=soloCache.get(state);
    if (!solo) {
      solo={audio:false,visual:false};
      for(const [id,flags] of Object.entries(state)) {
        if(!flags.solo) continue;
        if(video.test(id)) solo.visual=true;
        if(video.test(id) || audio.test(id)) solo.audio=true;
      }
      soloCache.set(state,solo);
    }
    return !solo[channel] || state[key]?.solo===true;
  }
  function forLayout(state,shots,segments,wholeCount,musicCount,segmented) {
    const solo=Object.entries(state ?? {}).filter(([,flags])=>flags.solo);
    if(!solo.length) return state;
    let videoDepth=1, voiceDepth=1, result=state;
    for(const shot of shots) for(const lane of candidateVideoLanes(shot)) videoDepth=Math.max(videoDepth,lane+1);
    for(const row of segments ?? []) voiceDepth=Math.max(voiceDepth,row?.length ?? 0);
    const limits={vis:videoDepth,voice:segmented?voiceDepth:0,whole:segmented?0:Math.max(1,wholeCount),music:musicCount};
    for(const [key,flags] of solo) {
      const [,kind,index]=/^(vis|voice|whole|music)(\d+)$/.exec(key) ?? [];
      if(kind && Number(index)>=limits[kind]) {
        if(result===state) result={...state};
        result[key]={...flags,solo:false};
      }
    }
    return result;
  }
  // A group without a soloed source retains its candidates and duration; channel
  // masks control what can be seen or heard in the composition.
  function preferSolo(items,isSolo) {
    const solo=items.filter(isSolo);
    return solo.length ? solo : items;
  }
  const tools={actions,layerKey,normalize,allows,forLayout,preferSolo};
  if(typeof module==='object' && module.exports) module.exports=tools;
  else window.trackControls=tools;
})();

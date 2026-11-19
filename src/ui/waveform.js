'use strict';

(() => {
  // Keep the edit order, including repeated or non-contiguous source intervals.
  function waveformSource(ranges, head = 0, tail = 0) {
    const parts = [];
    let length = 0;
    for (const {start,end} of ranges) {
      if (!(end > start)) continue;
      parts.push({start, offset:length, stop:length + end - start});
      length += end - start;
    }
    const begin = Math.max(0,head), stop = Math.max(begin,length - Math.max(0,tail));
    const duration = Math.max(0,stop - begin);
    function visit(a,b,loop,callback) {
      if (!(duration > 0 && b > a)) return;
      if (loop) {
        const span = Math.min(b-a,duration);
        a %= duration;
        b = a + span;
      } else b = Math.min(b,duration);
      while (b > a) {
        const from = begin + a, to = begin + Math.min(b,duration);
        let lo = 0, hi = parts.length;
        while (lo < hi) {
          const mid = (lo+hi) >>> 1;
          if (parts[mid].stop <= from) lo = mid+1; else hi = mid;
        }
        for (let i=lo; i<parts.length && parts[i].offset<to; i++) {
          const part=parts[i];
          callback(part.start+Math.max(0,from-part.offset),part.start+Math.min(part.stop,to)-part.offset);
        }
        b -= duration;
        a = 0;
        if (!loop) break;
      }
    }
    return {duration,visit};
  }

  const cache = new Map(), waiting = new Map();
  const queue = [];
  let workers = 0;
  function drain() {
    while (workers < 3 && queue.length) {
      const task=queue.shift();
      if (!task.clients.some((live)=>live())) {
        waiting.delete(task.key);task.resolve(null);continue;
      }
      workers++;
      window.workbench.audioWaveform(task.id,{start:task.start,end:task.end}).then((result)=>{
        if (result?.peaks?.length) cache.set(task.key,result);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
        task.resolve(result);
      },()=>task.resolve(null)).finally(()=>{
        workers--;waiting.delete(task.key);drain();
      });
    }
  }
  function read(id,start,end,live) {
    const key = [id,start,end].join(':');
    if (cache.has(key)) {
      const value=cache.get(key);cache.delete(key);cache.set(key,value);
      return value;
    }
    const pending=waiting.get(key);
    if (pending) {pending.clients.push(live);return pending.promise;}
    const task={key,id,start,end,clients:[live]};
    task.promise=new Promise((resolve)=>{task.resolve=resolve;});
    waiting.set(key,task);queue.push(task);drain();
    return task.promise;
  }

  function mountWaveforms(viewport) {
    const views = new Map(), visible = new Set();
    let raf;
    function schedule() {
      if (raf !== undefined) return;
      raf=requestAnimationFrame(()=>{
        raf=undefined;
        const bounds=viewport.getBoundingClientRect();
        for(const strip of visible) paint(strip,bounds);
      });
    }
    const observe = new IntersectionObserver((changes)=>{
      for (const {target,isIntersecting} of changes) {
        if (isIntersecting && views.has(target)) visible.add(target); else visible.delete(target);
      }
      schedule();
    },{root:viewport});
    const resize = new ResizeObserver(schedule);
    viewport.addEventListener('scroll',schedule,{passive:true});

    async function paint(strip,bounds) {
      const view=views.get(strip);
      if (!view || !strip.isConnected) return;
      const rect=strip.getBoundingClientRect();
      const left=Math.max(0,Math.floor(bounds.left-rect.left));
      const right=Math.min(Math.ceil(rect.width),Math.ceil(bounds.right-rect.left));
      const width=right-left, height=Math.round(rect.height);
      if (!(width>0 && height>0 && rect.width>0)) return;
      const signature=[left,right,height,rect.width].join('/');
      if (view.signature===signature) return;
      view.signature=signature;
      const {canvas,asset,source,span,loop,gain}=view;
      const live=()=>strip.isConnected && views.get(strip)?.signature===signature && visible.has(strip);
      // Decode only the currently visible section of a long source; tile boundaries are shared on scroll.
      const unit=span/rect.width;
      const tileSeconds = 2 ** Math.ceil(Math.log2(Math.max(32,width*unit)));
      const eachTile=(from,to,callback)=>{
        for(let i=Math.floor(from/tileSeconds);i*tileSeconds<to;i++){
          const start=i*tileSeconds, end=Math.min(asset.duration,start+tileSeconds);
          if(end>start) callback(i,Math.max(start,from),Math.min(end,to),start,end);
        }
      };
      const tiles=new Map();
      source.visit(left*unit,right*unit,loop,(from,to)=>eachTile(from,to,(i,a,b,start,end)=>{
        if(!tiles.has(i)) tiles.set(i,read(asset.id,start,end,live));
      }));
      await Promise.all([...tiles].map(async ([i,result])=>tiles.set(i,await result)));
      if(!live()) {if(view.signature===signature) view.signature='';return;}
      const drawing=canvas.getContext('2d');
      canvas.width=width;canvas.height=height;
      canvas.style.width=width+'px';canvas.style.left=left+'px';
      if (![...tiles.values()].some((tile)=>tile?.peaks?.length)) {
        strip.dataset.state='unavailable'; strip.title='未能读取音频波形';return;
      }
      strip.dataset.state='ready';
      const amplitudes=new Float32Array(width);
      let fullPeak;
      for(let x=0;x<width;x++){
        if (fullPeak!==undefined) {amplitudes[x]=fullPeak;continue;}
        let peak=0;
        source.visit((left+x)*unit,(left+x+1)*unit,loop,(from,to)=>eachTile(from,to,(i,a,b)=>{
          const tile=tiles.get(i);
          if (!tile?.peaks?.length) return;
          const first=Math.max(0,Math.floor((a-tile.start)/tile.step));
          const last=Math.min(tile.peaks.length,Math.ceil((b-tile.start)/tile.step));
          for(let j=first;j<last;j++) peak=Math.max(peak,tile.peaks[j]);
        }));
        amplitudes[x]=peak;
        if(loop && unit>=source.duration) fullPeak=peak;
      }
      drawing.fillStyle='#229ac2';
      for(let x=0;x<width;x++){
        const h=Math.min(height,Math.sqrt(amplitudes[x]*gain)*(height-1));
        drawing.fillRect(x,height-Math.max(1,h),1,Math.max(1,h));
      }
      drawing.fillStyle='#f2ad57';
      for(let x=0;x<width;x++){
        const level=amplitudes[x]*gain;
        if(level>.85) drawing.fillRect(x,height-Math.min(height,Math.sqrt(level)*(height-1)),1,1);
      }
    }
    function add(parent,asset,{ranges,head,tail,span,loop=false,volume=100,muted=false}={}) {
      if (!asset?.id || !(asset.duration>0) || !(asset.kind==='audio' || (asset.kind==='video' && asset.hasAudio))) return;
      const source=waveformSource(ranges ?? [{start:0,end:asset.duration}],head,tail);
      if (!(source.duration>0)) return;
      const strip=document.createElement('span'), canvas=document.createElement('canvas');
      parent.classList.add('has-waveform');
      if (parent.classList.contains('sequence-block') && parent.firstChild?.nodeType===Node.TEXT_NODE) {
        const title=document.createElement('span');
        title.className='wave-clip-title';
        title.textContent=parent.firstChild.textContent;
        parent.firstChild.replaceWith(title);
      }
      strip.className='audio-waveform';
      strip.classList.toggle('waveform-muted',muted || volume===0);
      strip.setAttribute('role','img');
      strip.setAttribute('aria-label',asset.name+' 音频波形'+(muted || volume===0 ? '（已静音）':''));
      strip.dataset.state='loading';
      strip.append(canvas);parent.append(strip);
      views.set(strip,{asset,source,span:span ?? source.duration,loop,canvas,gain:volume>0?volume/100:1});
      observe.observe(strip);resize.observe(strip);
      return strip;
    }
    function clear() {
      observe.disconnect();resize.disconnect();visible.clear();views.clear();
    }
    return {add,clear};
  }
  function playerWaveform(player) {
    const holder=document.createElement('div');
    holder.className='player-waveform';holder.hidden=true;
    player.after(holder);
    const waves=mountWaveforms(player.closest('dialog') ?? player.parentElement);
    return (asset)=>{
      waves.clear();holder.replaceChildren();
      holder.hidden=!waves.add(holder,asset);
    };
  }
  if (typeof module==='object' && module.exports) module.exports={waveformSource};
  else {
    window.waveformSource=waveformSource;
    window.mountWaveforms=mountWaveforms;
    window.attachPlayerWaveform=playerWaveform;
  }
})();

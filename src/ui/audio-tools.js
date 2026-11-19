'use strict';

window.mountAudioTools = function({ api, onBusy, onGenerated }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('audio-tools-dialog'), modes = get('audio-tool-mode'), picker = get('audio-tool-source');
  const player = get('audio-tool-player'), list = get('audio-pauses'), status = get('audio-tool-status');
  const showWaveform=window.attachPlayerWaveform(player);
  const settings = get('audio-pause-settings'), generate = get('audio-tool-generate'), close = get('audio-tool-close');
  let assets = [], working = false, cancelled = false;
  const proposals = new Map();
  const current = () => assets[picker.selectedIndex];
  const number = (id) => get(id).valueAsNumber;
  function rows() {
    return [...list.children].map((row) => ({label:row.dataset.label,checked:row.querySelector('input').checked,
      start:row.querySelector('[data-edge=start]').valueAsNumber, end:row.querySelector('[data-edge=end]').valueAsNumber}));
  }
  function display() {
    settings.hidden = modes.value !== 'trim';
    get('audio-replace-label').hidden=!assets.some((a)=>a.kind==='video') || !['vocals','bed','both'].includes(modes.value);
    get('audio-with-video').disabled=working;
    generate.disabled = working || !current() || (!settings.hidden && ![...proposals.values()].some((items)=>items.some((r)=>r.checked!==false)));
    generate.textContent = assets.length > 1 ? '处理全部素材' : '生成素材';
    get('audio-detect').disabled = working;
    modes.disabled = picker.disabled = working;
    close.textContent = working ? '取消处理' : '关闭';
    for (const input of settings.querySelectorAll('input')) input.disabled = working;
  }
  function getProposals() { return proposals.get(current()?.id) ?? []; }
  function showRows() {
    list.replaceChildren(...getProposals().map(({start,end,checked=true,label=''},i) => {
      const row=document.createElement('div'); row.className='audio-pause-row';
      row.dataset.label=label;
      const flag=document.createElement('label'), box=document.createElement('input');
      box.type='checkbox';box.checked=checked;flag.append(box,label || '停顿 ' + (i+1));row.append(flag);
      for (const [edge,text,val] of [['start','从',start],['end','到',end]]) {
        const label=document.createElement('label'), input=document.createElement('input');
        input.type='number';input.min='0';input.max=String(current().duration);input.step='0.001';
        input.dataset.edge=edge;input.value=String(Math.round(val*1000)/1000);
        label.append(text,input,'秒');row.append(label);
      }
      const audition=document.createElement('button');audition.type='button';audition.textContent='试听';
      audition.onclick=()=>{player.currentTime=Math.max(0,Number(row.querySelector('[data-edge=start]').value)-0.45);player.play().catch((e)=>{status.textContent=e.message;});};
      row.append(audition);return row;
    }));
    display();
  }
  function setSource() {
    const asset=current();
    if (!asset) return;
    player.src=asset.url;player.classList.toggle('audio-only',asset.kind==='audio');
    showWaveform(asset);
    showRows();
  }
  async function execute(action) {
    if (working) return;
    working=true; cancelled=false; onBusy(true); display();
    try { await action(); }
    catch (error) {status.textContent=error.message;}
    finally {working=false;onBusy(false);display();}
  }
  function config() {return {threshold:number('audio-threshold'),minimum:number('audio-minimum'),padding:number('audio-padding'),fillers:get('audio-fillers').checked};}
  get('audio-detect').onclick=()=>execute(async()=>{
    status.textContent='正在检测音轨中的停顿…';
    for (const asset of assets) {
      if (cancelled) throw new Error('已取消检测。');
      proposals.set(asset.id,await api.detectPauses({id:asset.id,...config()}));
    }
    showRows();
    const count=[...proposals.values()].reduce((sum,items)=>sum+items.length,0);
    status.textContent='检测到 '+count+' 处停顿。可切换来源，调整每处起止时间。';
  });
  generate.onclick=()=>execute(async()=>{
    player.pause(); let count=0;
    for (const [i,asset] of assets.entries()) {
      if (cancelled) throw new Error('已取消后续处理。');
      const intervals=(proposals.get(asset.id)??[]).filter((r)=>r.checked!==false);
      if (modes.value==='trim' && !intervals.length) continue;
      status.textContent='正在处理 '+(i+1)+' / '+assets.length+' · '+asset.name;
      const withVideo=asset.kind==='video' && !get('audio-replace-label').hidden && get('audio-with-video').checked;
      const results=await api.processAudio({id:asset.id,mode:modes.value,intervals,withVideo});
      onGenerated(results);count+=results.length;
    }
    status.textContent='已添加 '+count+' 项到素材库的「已处理素材」。';
  });
  close.onclick=()=>{if(working){cancelled=true;api.cancel().catch((error)=>{status.textContent=error.message;});}else dialog.close();};
  dialog.addEventListener('cancel',(event)=>{if(working){event.preventDefault();close.click();}});
  dialog.addEventListener('close',()=>{player.pause();player.removeAttribute('src');player.load();showWaveform();assets=[];proposals.clear();});
  picker.onchange=setSource; modes.onchange=display;
  for (const id of ['audio-threshold','audio-minimum','audio-padding','audio-fillers']) get(id).oninput=()=>{proposals.clear();showRows();status.textContent='参数已更改，请重新检测。';};
  list.oninput=()=>{proposals.set(current().id,rows());display();};
  function skipSelectedPause() {
    if (!dialog.open || player.paused || !get('audio-skip').checked || modes.value!=='trim') return;
    const t=player.currentTime;
    const gap=getProposals().find((r)=>r.checked!==false && t>=r.start && t<r.end-0.003);
    if(gap) player.currentTime=Math.min(player.duration,gap.end);
  }
  let animation;
  function auditionLoop(){skipSelectedPause();if(!player.paused && dialog.open) animation=requestAnimationFrame(auditionLoop);}
  player.addEventListener('play',()=>{cancelAnimationFrame(animation);auditionLoop();});
  player.addEventListener('pause',()=>cancelAnimationFrame(animation));
  return {
    open(sources) {
      assets=sources.filter((a)=>a?.kind==='audio'||(a?.kind==='video' && a.hasAudio));
      if(!assets.length) throw new Error('所选素材均没有音轨。');
      picker.replaceChildren(...assets.map((a)=>new Option(a.name,a.id)));proposals.clear();status.textContent='';get('audio-with-video').checked=false;
      setSource();dialog.showModal();
    },
  };
};

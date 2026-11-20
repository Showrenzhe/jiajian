'use strict';

window.createCoverEditor = function ({get, set, assetFor, selection, pickImage, detect}) {
  const make = (tag,text) => { const el=document.createElement(tag); if(text!==undefined) el.textContent=text; return el; };
  const button = (text, click) => { const b=make('button',text); b.type='button'; b.onclick=click; return b; };
  const dialog=make('dialog'); dialog.className='jj-cover-editor'; document.body.append(dialog);
  let draft, index, job=0;
  function status(text){const node=dialog.querySelector('output');if(node)node.textContent=text;}
  function current() {return draft.items[index];}
  function stage(asset,time) {
    const box=make('div');box.className='jj-cover-stage';
    if(!asset) return box;
    const media=make(asset.kind==='image'?'img':'video');media.src=asset.url;
    if(asset.kind==='video'){media.muted=true;media.preload='auto';media.onloadedmetadata=()=>{media.currentTime=Math.min(time,Math.max(0,media.duration-.001));};}
    box.append(media);return box;
  }
  function add(asset, time) {
    if(!asset || !['video','image'].includes(asset.kind))return;
    const t=asset.kind==='image'?0:Math.round(Math.max(0,Math.min(time,asset.duration-1/(asset.fps||30)))*1e6)/1e6;
    const found=draft.items.findIndex((item)=>item.id===asset.id && Math.abs(item.time-t)<.0001);
    if(found>=0) index=found;
    else {
      if(draft.items.length>=100){status('我的封面最多保存 100 张。');return;}
      index=draft.items.push({id:asset.id,time:t})-1;
    }
    draft.mode='library';draft.active=index;paint();
  }
  function paint() {
    const header=make('header');header.append(make('h3','设置封面'),button('关闭',()=>dialog.close()));
    const mode=make('select');mode.setAttribute('aria-label','封面方式');
    const modes=[['none','使用默认画面'],['library','我的封面'],['first-shot','第一分镜作为封面'],['random','随机片头']];
    for(const [value,label] of modes)mode.append(new Option(label,value));mode.value=draft.mode;
    mode.onchange=()=>{draft.mode=mode.value;paint();};
    const actions=make('div');actions.className='jj-cover-actions';
    actions.append(button('上传图片',()=>pickImage((asset)=>{if(dialog.open)add(asset,0);})),
      button('截取播放头',()=>{
        const frame=selection();if(!frame)return status('请先选中轨道或素材库中的视频或图片。');
        add(frame.asset,frame.time);
      }),button('智能选帧',async()=>{
        const frame=selection();if(frame?.asset.kind!=='video')return status('请先选择一条视频素材。');
        const token=++job;status('正在识别画面变化…');
        try{
          const a=frame.asset;const raw=await detect(a.id);
          if(!dialog.open||token!==job)return;
          if(!Array.isArray(raw))return status('场景识别已取消。');
          const points=[0,...raw,a.duration];
          let spans=points.slice(1).map((end,i)=>({start:points[i],end}));
          if(spans.length===1)spans=[.15,.5,.85].map((f)=>({start:a.duration*f,end:a.duration*f}));
          spans=spans.sort((a,b)=>(b.end-b.start)-(a.end-a.start)).slice(0,6).sort((a,b)=>a.start-b.start);
          for(const {start,end} of spans)add(a,(start+end)/2);
          status('候选帧已加入我的封面，可选择或移除。');
        }catch(error){if(token===job)status(error.message);}
      }));
    const grid=make('div');grid.className='jj-cover-grid';
    draft.items.forEach((item,i)=>{
      const asset=assetFor(item.id);
      const b=button('',()=>{index=i;draft.mode='library';if(draft.active!==-1)draft.active=i;paint();});
      b.setAttribute('aria-pressed',String(index===i));b.title=asset?.name||'素材缺失';
      b.append(stage(asset,item.time),make('span',item.title||asset?.name||'素材缺失'));grid.append(b);
    });
    const panel=make('div');panel.className='jj-cover-panel';
    const selected=current();
    if(draft.mode==='library'&&selected) {
      const preview=stage(assetFor(selected.id),selected.time);preview.classList.add('jj-cover-large');
      const overlay=make('strong',selected.title||'');overlay.dataset.style=selected.style||'simple';preview.append(overlay);
      const inputs=make('div');const title=make('textarea');title.maxLength=200;title.rows=3;title.placeholder='封面标题（可选）';title.setAttribute('aria-label','封面标题');title.value=selected.title||'';
      title.oninput=()=>{selected.title=title.value;overlay.textContent=title.value;grid.children[index].lastElementChild.textContent=title.value||assetFor(selected.id)?.name||'';};
      const style=make('select');style.setAttribute('aria-label','标题样式');
      for(const [v,text] of [['simple','简约'],['bold','醒目'],['accent','暖黄']])style.append(new Option(text,v));
      style.value=selected.style||'simple';style.onchange=()=>{selected.style=style.value;overlay.dataset.style=style.value;};
      const random=make('label');const check=make('input');check.type='checkbox';check.checked=draft.active===-1;
      check.onchange=()=>{draft.active=check.checked?-1:index;};random.append(check,document.createTextNode('每条成片随机选一张'));
      inputs.append(title,style,random,button('移除这张',()=>{
        draft.items.splice(index,1);index=Math.max(0,Math.min(index,draft.items.length-1));
        draft.active=draft.active===-1?-1:index;if(!draft.items.length)draft.mode='none';paint();
      }));
      panel.append(preview,inputs);
    }else panel.append(make('p',({library:'上传图片，或截取视频中的一帧。','first-shot':'第一分镜始终位于开头，时长计入成片。它的候选独立抽取，不增加可生成的组合数。',random:'从成片中抽取 7 至 10 帧，轻微放大、位移后复制到开头。',none:'使用成片本身的默认画面。'})[draft.mode]));
    const foot=make('footer');const report=make('output');
    const save=button('应用封面',()=>{
      if(draft.mode==='library'&&!draft.items.length)return status('请先添加封面。');
      set(structuredClone(draft));dialog.close();
    });
    foot.append(report,save);dialog.replaceChildren(header,mode,actions,grid,panel,foot);
  }
  dialog.addEventListener('close',()=>{if(dialog.open)return;job++;window.afterDialogExit(dialog,()=>dialog.replaceChildren());});
  function open(){draft=structuredClone(get()??{mode:'none',items:[],active:0});index=Math.max(0,draft.active);paint();if(!dialog.open)dialog.showModal();}
  return {open,capture(asset,time){open();add(asset,time);},firstShot(){open();draft.mode='first-shot';paint();}};
};

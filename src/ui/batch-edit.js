'use strict';

window.mountBatchEdit = function(ctx) {
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const button=(text,action)=>{const b=el('button',text);b.type='button';b.onclick=action;return b;};
  function modal(title){
    const d=el('dialog');d.className='jj-batch-editor';
    const heading=el('header');heading.append(el('h3',title),button('关闭',()=>d.close()));
    const body=el('section'),foot=el('footer'),status=el('output');
    d.append(heading,body,foot);foot.append(status);document.body.append(d);d.showModal();d.onclose=()=>window.afterDialogExit(d);
    return {d,body,foot,status};
  }
  function rename(items,isOutput,apply){
    if(!items.length)return;
    const {d,body,foot,status}=modal(isOutput?'重命名作品文件':'重命名素材');
    const label=el('label','新名称'),entry=el('input');entry.maxLength=115;entry.placeholder='输入名称';label.append(entry);
    const sample=el('ol');
    body.append(label,el('p',isOutput?'作品文件将在原目录改名。':'名称保存在当前工程，原始素材文件路径继续有效。'),sample);
    const names=()=>items.map(({name},i)=>(entry.value.trim()||'新名称')+(items.length>1?'-'+String(i+1).padStart(2,'0'):'')+(name.match(/\.[^.]+$/)?.[0]??''));
    const paint=()=>{sample.replaceChildren(...names().map((name,i)=>el('li',items[i].name+' → '+name)));};entry.oninput=paint;paint();entry.focus();
    const save=button('确认重命名',async()=>{
      const prefix=entry.value.trim();
      if(!prefix||/[\\/:*?"<>|\x00-\x1f]/.test(prefix)||/[ .]$/.test(prefix)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(prefix)){status.textContent='请输入有效名称，不能含文件路径或系统保留字符。';return;}
      save.disabled=true;
      try{await apply(prefix,names());d.close();}catch(error){status.textContent=error.message;}finally{save.disabled=false;}
    });foot.append(save);
  }
  ctx.material.onclick=async()=>{try{const items=await ctx.materials();rename(items,false,(_,names)=>ctx.alias(items,names));}catch(error){ctx.warn(error.message);}};
  ctx.outputs.onclick=()=>{const items=ctx.works();rename(items,true,async(prefix)=>ctx.renameWorks(items,prefix));};
  function openVolume() {
    const {d,body,foot,status}=modal('批量设置音量');
    const picker=el('select');for(const [key,title] of [['video','视频原声'],['voice','口播'],['sound','音效'],['music','背景音乐']])picker.append(new Option(title,key));
    const entries=el('div');entries.className='jj-level-list';const scope=el('select'),slider=el('input'),amount=el('output');
    slider.type='range';slider.min=0;slider.max=100;slider.step=1;slider.oninput=()=>{amount.value=slider.value+'%';};
    const label=el('label','音量');label.append(slider,amount);const grouping=el('label','应用范围');grouping.append(scope);
    function paint(){
      const rows=ctx.levels(picker.value), chosen=rows.find(r=>r.active)??rows[0];
      slider.value=chosen?.value??100;slider.oninput();scope.replaceChildren();
      for(const [key,name] of [['selected','勾选的片段'],['track','所选片段的同一轨道'],['shot','所选片段的同一分镜'],['all','全部']]){
        if(key==='shot'&&!rows.some(r=>r.shot!=null))continue;
        scope.append(new Option(name,key));
      }
      entries.replaceChildren(...rows.map(row=>{const line=el('label'),check=el('input');check.type='checkbox';check.checked=row===chosen;check.track=row;line.append(check,el('span',row.title),el('small',row.value+'%'));return line;}));
      status.textContent=rows.length?'':'当前工程没有这类音轨。';
    }
    picker.onchange=paint;
    const all=button('全选',()=>entries.querySelectorAll('input').forEach(c=>{c.checked=true;}));
    body.append(picker,all,entries,grouping,label);paint();
    foot.append(button('应用音量',()=>{
      const rows=[...entries.querySelectorAll('input')],selected=rows.filter(c=>c.checked).map(c=>c.track);
      const match=(r)=>scope.value==='all'||selected.includes(r)||scope.value==='track'&&selected.some(s=>s.lane===r.lane)||scope.value==='shot'&&r.shot!=null&&selected.some(s=>s.shot===r.shot);
      const targets=rows.map(c=>c.track).filter(match);
      if(!targets.length){status.textContent='请至少选择一个片段。';return;}
      targets.forEach(row=>row.set(Number(slider.value)));ctx.changed();d.close();
    }));
  }
  return {openVolume};
};

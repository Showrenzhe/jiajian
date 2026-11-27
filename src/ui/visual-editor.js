'use strict';

window.editVisualStyle = function (options) {
  const {asset,initial={},ratio='9:16',start=0,end=asset.duration??3} = options;
  const draft=structuredClone(initial), dialog=document.createElement('dialog');
  dialog.className='jj-visual-editor';
  const tabs=['调色','滤镜','特效','背景',...(options.trim ? ['去片头片尾'] : [])];
  const gradeNames={temperature:'色温',tint:'色调',saturation:'饱和度',lightness:'明度',brightness:'亮度',contrast:'对比度',highlights:'高光',glow:'光感'};
  const colorNames={red:'红',orange:'橙',yellow:'黄',green:'绿',cyan:'青',blue:'蓝',purple:'紫',magenta:'洋红'};
  const fx={blur:'模糊',sharpen:'锐化',grain:'胶片颗粒',vignette:'暗角',chromatic:'色差',negative:'反色'};
  const make=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(text,run)=>{const e=make('button',text);e.type='button';e.onclick=run;return e;};
  function select(items,value,change){
    const el=make('select');for(const [v,t] of Object.entries(items))el.append(new Option(t,v));el.value=String(value);
    el.onchange=()=>change(el.value);return el;
  }
  function label(text,control){const e=make('label',text);e.append(control);return e;}
  let tab=tabs[0], currentColor='red',time=start,timer,version=0,scope='clip',live=true,backgroundPrompt='',backgroundReference;
  const head=make('header');head.append(make('h3','画面处理'),make('span',asset.name),button('关闭',()=>dialog.close()));
  const nav=make('nav'); const canvas=make('canvas');canvas.width=320;canvas.height=180;
  const scrub=make('input');scrub.type='range';scrub.min=String(start);scrub.max=String(end);scrub.step=String(1/(asset.fps||30));scrub.value=String(start);
  scrub.oninput=()=>{time=scrub.valueAsNumber;preview();};
  const visual=make('section');visual.className='jj-look-preview';visual.append(canvas);
  if(asset.kind==='video')visual.append(label('预览位置',scrub));
  const controls=make('section');controls.className='jj-look-controls';
  const body=make('div');body.className='jj-look-body';body.append(visual,controls);
  const report=make('output');
  const scopeControl=select(options.scopes??{clip:'当前片段'},scope,(v)=>{scope=v;});
  const foot=make('footer');foot.append(report,label('应用到',scopeControl),button('应用设置',async()=>{
    try{
      const groups={'调色':['grade','hsl'],'滤镜':['filter','lut'],'特效':['effects'],'背景':['background'],'去片头片尾':['head','tail']};
      const keys=[...new Set([...groups[tab],...Object.values(groups).flat().filter((k)=>JSON.stringify(initial[k])!==JSON.stringify(draft[k]))])];
      if(await options.apply(structuredClone(draft),scope,keys)!==false) dialog.close();
    }catch(error){report.textContent=error.message;}
  }));
  dialog.append(head,nav,body,foot);document.body.append(dialog);dialog.showModal();
  dialog.onclose=()=>{live=false;version++;clearTimeout(timer);window.afterDialogExit(dialog);};
  function preview(){
    const token=++version;clearTimeout(timer);
    timer=setTimeout(async()=>{
      if(!live)return;
      try{
        const bytes=await window.workbench.previewLook({id:asset.id,time,origin:start,ratio,look:draft});
        if(!live||token!==version||!bytes?.length)return;
        const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
        if(live&&token===version){canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);report.textContent='';}
        image.close();
      }catch(error){if(live&&token===version)report.textContent=error.message;}
    },160);
  }
  function numeric(title,value,min,max,step,onChange){
    const el=make('input');el.type='number';el.min=min;el.max=max;el.step=step;el.value=value;
    el.onchange=()=>{if(el.value!==''&&!el.validity.valid){el.reportValidity();return;}onChange(el.value===''?0:el.valueAsNumber);preview();};
    return label(title,el);
  }
  function slider(title,value,max,write){
    const el=make('input');el.type='range';el.min=-max;el.max=max;el.step=1;el.value=value;
    const out=make('output',String(value));el.oninput=()=>{write(Number(el.value));out.textContent=el.value;preview();};
    const row=label(title,el);row.append(out);return row;
  }
  function grade(){
    const g=draft.grade??{};
    for(const [key,name] of Object.entries(gradeNames))controls.append(slider(name,g[key]??0,100,(v)=>{g[key]=v;draft.grade=g;}));
    controls.append(label('HSL 单独调色',select(colorNames,currentColor,(v)=>{currentColor=v;paint();})));
    for(const [key,name,max] of [['h','色相',180],['s','饱和',100],['l','明度',100]])controls.append(slider(name,draft.hsl?.[currentColor]?.[key]??0,max,(v)=>{
      ((draft.hsl??={})[currentColor]??={})[key]=v;
    }));
    let presets={};try{presets=JSON.parse(localStorage.getItem('jiajian.visual-presets')??'{}');}catch{}
    const names=Object.keys(presets);const list=select(Object.fromEntries(names.map((n)=>[n,n])),names[0],()=>{});
    const name=make('input');name.placeholder='预设名称';name.maxLength=40;
    controls.append(label('我的预设',list),button('套用预设',()=>{const p=presets[list.value];if(p){draft.grade=structuredClone(p.grade);draft.hsl=structuredClone(p.hsl);paint();}}),
      name,button('保存预设',()=>{const title=name.value.trim();if(!title)return;presets[title]={grade:g,hsl:draft.hsl??{}};localStorage.setItem('jiajian.visual-presets',JSON.stringify(presets));paint();}),
      button('重置调色',()=>{delete draft.grade;delete draft.hsl;paint();}));
  }
  function filter(){
    controls.append(label('风格',select({none:'无',portrait:'人像 · 柔光',food:'美食 · 暖色',landscape:'风景 · 清透',retro:'复古 · 褪色',mono:'风格化 · 黑白'},
      draft.filter??'none',(v)=>{draft.filter=v;preview();})));
    const library=options.luts();
    controls.append(label('我的 LUT',select({'':'不使用 LUT',...Object.fromEntries(library.map((a)=>[a.id,a.name]))},draft.lut??'',(v)=>{
      if(v)draft.lut=v;else delete draft.lut;preview();
    })),button('导入 .cube 滤镜',async()=>{try{const lut=await options.pickLut();if(lut&&live){draft.lut=lut.id;paint();}}catch(e){report.textContent=e.message;}}));
  }
  function effects(){
    const rows=draft.effects??=[];
    const type=select(fx,'blur',()=>{});
    controls.append(type,button('添加特效',()=>{if(rows.length>=10){report.textContent='每个片段最多添加 10 个特效。';return;}rows.push({kind:type.value,start:0,end:null,strength:50});paint();}));
    for(const [i,e] of rows.entries()){
      const box=make('fieldset');box.append(make('legend',(i+1)+' · '+fx[e.kind]),
        numeric('入点（秒）',e.start,0,86400,.01,(v)=>{e.start=v;}),
        numeric('出点（秒）',e.end??'',0,86400,.01,(v)=>{e.end=v||null;}),
        numeric('强度',e.strength,0,100,1,(v)=>{e.strength=v;}));
      const random=make('details');random.append(make('summary','参与随机的特效'));
      for(const [key,t] of Object.entries(fx)){
        const check=make('input');check.type='checkbox';check.checked=e.pool?.includes(key)??false;
        check.onchange=()=>{e.pool=check.checked?[...(e.pool??[]),key]:(e.pool??[]).filter((v)=>v!==key);preview();};random.append(label(t,check));
      }
      box.append(random,button('移除',()=>{rows.splice(i,1);paint();}));controls.append(box);
    }
  }
  function background(){
    const bg=draft.background??={kind:'none'};
    controls.append(label('素材背景',select({none:'沿用工程背景',blur:'模糊原画',color:'纯色',pattern:'样式背景',media:'自定义图片 / 视频'},bg.kind,(v)=>{
      draft.background={kind:v,...(v==='color'?{color:'#26384a'}:v==='pattern'?{pattern:'grid'}:v==='media'?{ids:[]}:v==='blur'?{strength:40}:{})};paint();
    })));
    if(bg.kind==='color'){const input=make('input');input.type='color';input.value=bg.color;input.oninput=()=>{bg.color=input.value;preview();};controls.append(label('颜色',input));}
    if(bg.kind==='blur')controls.append(numeric('模糊强度',bg.strength,1,100,1,(v)=>{bg.strength=v;}));
    if(bg.kind==='pattern')controls.append(label('样式',select({grid:'网格',dots:'细纹',gradient:'渐变'},bg.pattern,(v)=>{bg.pattern=v;preview();})));
    if(bg.kind==='media'){
      controls.append(button('选择背景素材',()=>options.pickBackground((items)=>{if(live){bg.ids=items.map((a)=>a.id);paint();}})));
      for(const id of bg.ids)controls.append(make('span',options.assetFor(id)?.name??'素材'));
      if(bg.ids.length>1)controls.append(make('p','每条成片从所选背景中抽取一个。'));
    }
    const ai=make('details');ai.append(make('summary','AI 生成背景'));
    const prompt=make('textarea');prompt.value=backgroundPrompt;prompt.maxLength=4096;prompt.placeholder='描述背景或选择参考图';prompt.oninput=()=>{backgroundPrompt=prompt.value;};
    const generate=button('生成并应用',async()=>{generate.disabled=true;
      try{const result=await options.generateBackground(backgroundPrompt,backgroundReference?.id);if(live&&result){draft.background={kind:'media',ids:[result.id]};paint();}}
      catch(error){report.textContent=error.message;}finally{generate.disabled=false;}
    });
    ai.append(label('背景描述',prompt),button(backgroundReference?.name??'选择参考素材（可选）',()=>options.pickBackground((items)=>{backgroundReference=items[0];paint();})),generate);
    controls.append(ai);
  }
  function trim(){
    controls.append(numeric('去片头（秒）',draft.head??0,0,86400,.01,(v)=>{draft.head=v;}),
      numeric('去片尾（秒）',draft.tail??0,0,86400,.01,(v)=>{draft.tail=v;}));
  }
  function paint(){
    nav.replaceChildren(...tabs.map((title)=>{const b=button(title,()=>{tab=title;paint();});b.setAttribute('aria-pressed',String(tab===title));return b;}));
    controls.replaceChildren();({'调色':grade,'滤镜':filter,'特效':effects,'背景':background,'去片头片尾':trim})[tab]();preview();
  }
  paint();
};

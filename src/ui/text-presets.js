'use strict';

(() => {
  const key = 'jiajian.text-presets.v1';
  const base = {font:'yahei', outlineWidth:1, outlineColor:'#000000', background:false, backgroundColor:'#000000',
    backgroundOpacity:.55, shadow:false, shadowColor:'#000000', shadowX:2, shadowY:3};
  const fonts = {yahei:['微软雅黑','Microsoft YaHei'],bold:['微软雅黑粗体','Microsoft YaHei'],heiti:['黑体','SimHei'],
    song:['宋体','SimSun'],kai:['楷体','KaiTi'],fang:['仿宋','FangSong'],arial:['Arial','Arial']};
  const builtIn = [
    {name:'简洁白字', style:base, color:'#ffffff', fontSize:48},
    {name:'描边标题', style:{...base,font:'bold',outlineWidth:5}, color:'#ffda57', fontSize:72},
    {name:'深底字幕', style:{...base,outlineWidth:0,background:true,backgroundOpacity:.72},color:'#ffffff',fontSize:48},
    {name:'投影文字', style:{...base,font:'bold',outlineWidth:0,shadow:true,shadowX:5,shadowY:5},color:'#ffffff',fontSize:56},
  ];
  function el(tag, txt) {
    const node = document.createElement(tag);
    if (txt !== undefined) node.textContent = txt;
    return node;
  }
  function saved() {
    try { const items = JSON.parse(localStorage.getItem(key)); return Array.isArray(items) ? items.filter((v)=>v?.name && v.style) : []; }
    catch { return []; }
  }
  window.previewTextAppearance = (node, style, color, factor = .4) => {
    const s = {...base,...style};
    const [,family] = fonts[s.font] ?? fonts.yahei;
    node.style.fontFamily = '"'+family+'","Microsoft YaHei",sans-serif';
    node.style.fontWeight = s.font==='bold' ? '700' : '400';
    node.style.color = color;
    node.style.webkitTextStroke = (s.outlineWidth*factor)+'px '+s.outlineColor;
    node.style.paintOrder = 'stroke fill';
    node.style.backgroundColor = s.background ? s.backgroundColor+Math.round(s.backgroundOpacity*255).toString(16).padStart(2,'0') : 'transparent';
    node.style.textShadow = s.shadow ? (s.shadowX*factor)+'px '+(s.shadowY*factor)+'px 0 '+s.shadowColor : 'none';
  };

  window.createTextPresets = (initial, bindings = {}) => {
    const root = el('details'); root.className = 'text-presets';
    root.append(el('summary','字体、描边与样式预设'));
    const body = el('div'); root.append(body);
    const controls = {};
    function field(label, input, parent=body) {
      const row = el('label'); row.append(el('span',label), input); parent.append(row);
      return input;
    }
    function control(id, name, type, min, max, step) {
      const node = el(type==='select'?'select':'input'); node.dataset.textStyle = id;
      if (type !== 'select') node.type = type;
      for (const [attr,val] of Object.entries({min,max,step})) if (val!==undefined) node[attr]=val;
      controls[id] = field(name,node);
      return node;
    }
    const font = control('font','字体','select');
    for (const [id,[label]] of Object.entries(fonts)) font.add(new Option(label,id));
    control('outlineWidth','描边宽度','number',0,24,1);
    control('outlineColor','描边颜色','color');
    control('background','显示底色','checkbox');
    control('backgroundColor','底色','color');
    control('backgroundOpacity','底色不透明度','number',0,1,.01);
    control('shadow','显示阴影','checkbox');
    control('shadowColor','阴影颜色','color');
    control('shadowX','阴影水平偏移','number',-40,40,1);
    control('shadowY','阴影垂直偏移','number',-40,40,1);
    const sampleArea = el('div'); sampleArea.className='text-preset-sample';
    const sample = el('span'); sampleArea.append(sample); body.append(sampleArea);
    function read() {
      return Object.fromEntries(Object.entries(controls).map(([id,node])=>[id,
        node.type==='checkbox' ? node.checked : node.type==='number' ? node.valueAsNumber : node.value]));
    }
    function refresh() {
      const style = read();
      for (const id of ['backgroundColor','backgroundOpacity']) controls[id].disabled = !style.background;
      for (const id of ['shadowColor','shadowX','shadowY']) controls[id].disabled = !style.shadow;
      sample.textContent = bindings.text?.value.trim().slice(0,90) || '佳剪 · 文字样式';
      sample.style.fontSize=Math.max(10,Math.min(54,Number(bindings.fontSize?.value || 48)*.5))+'px';
      window.previewTextAppearance(sample,style,bindings.color?.value || '#ffffff');
    }
    function setStyle(value) {
      for (const [id,val] of Object.entries({...base,...value})) {
        const node=controls[id]; if (!node) continue;
        if (node.type==='checkbox') node.checked=val; else node.value=val;
      }
      refresh();
    }
    setStyle(initial);
    for (const node of Object.values(controls)) node.addEventListener('input',refresh);
    for (const node of Object.values(bindings)) node?.addEventListener('input',refresh);
    const select = field('应用预设',el('select'));
    const name = field('自定义预设名',el('input')); name.maxLength=48;
    name.placeholder='输入名称以保存当前样式与位置';
    const actions=el('div'); actions.className='sequence-caption-tools'; body.append(actions);
    const save=el('button','保存为预设'), remove=el('button','删除所选预设'), message=el('output');
    save.type=remove.type='button'; actions.append(save,remove); body.append(message);
    function populate(active='') {
      select.replaceChildren(new Option('选择预设',''));
      for(const [i,p] of builtIn.entries()) select.add(new Option(p.name,'built-'+i));
      for(const p of saved()) select.add(new Option('我的 · '+p.name,'user-'+p.name));
      select.value=active; remove.disabled=!active.startsWith('user-');
    }
    function update(items,selection,feedback) {
      try { localStorage.setItem(key,JSON.stringify(items)); populate(selection); message.textContent=feedback; }
      catch { message.textContent='本机无法保存预设，请检查可用存储空间。'; }
    }
    populate();
    select.onchange=()=>{
      const custom=select.value.startsWith('user-');
      const p=custom ? saved().find((item)=>item.name===select.value.slice(5)) : builtIn[select.value.slice(6)];
      remove.disabled=!custom;
      if (!p) return;
      name.value=custom ? p.name : '';
      for(const id of ['fontSize','color','x','y','scale']) if (p[id]!==undefined && bindings[id]) bindings[id].value=p[id];
      setStyle(p.style); message.textContent='';
    };
    save.onclick=()=>{
      if(!name.value.trim()) { name.focus(); message.textContent='请先填写预设名称。'; return; }
      if (!Object.values(controls).every((node)=>node.reportValidity())) return;
      const label=name.value.trim(), style=read();
      const preset={name:label,style};
      for(const id of ['fontSize','color','x','y','scale']) if (bindings[id]) {
        if (!bindings[id].reportValidity()) return;
        preset[id]=bindings[id].value;
      }
      const other=saved().filter((p)=>p.name!==label);
      update([...other,preset],'user-'+label,'已保存到本机。');
    };
    remove.onclick=()=>{
      if (!select.value.startsWith('user-')) return;
      update(saved().filter((p)=>p.name!==select.value.slice(5)),'','已删除预设。'); name.value='';
    };
    return {element:root,read};
  };
})();

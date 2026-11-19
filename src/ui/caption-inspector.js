'use strict';

window.mountCaptionInspector = ({ api, sourceCue, player, still }) => {
  const get = (id) => document.getElementById(id);
  const fields = { size:'size', font:'font', textColor:'color', outlineColor:'outline', position:'position', align:'align',
    bold:'bold', italic:'italic', underline:'underline', outlineWidth:'outline-width', spacing:'spacing', margin:'margin', x:'x', y:'y', enabled:'enabled' };
  const defaults = {size:18,font:'yahei',textColor:'#ffffff',outlineColor:'#000000',position:'bottom',align:'center',
    bold:false,italic:false,underline:false,outlineWidth:2,spacing:0,margin:16,x:50,y:85,enabled:true};
  const looks = [
    ['经典白字',{}],
    ['醒目黄字',{textColor:'#ffe25a',bold:true,outlineWidth:3}],
    ['蓝色描边',{textColor:'#ffffff',outlineColor:'#216ab7',bold:true,outlineWidth:3}],
    ['粉彩字幕',{textColor:'#ff94cb',outlineColor:'#4d2441',bold:true}],
    ['宋体细字',{font:'song',outlineWidth:1,spacing:1}],
    ['黑白反色',{textColor:'#10141a',outlineColor:'#ffffff',bold:true}],
  ];
  const styleKeys = ['font','textColor','outlineColor','bold','italic','underline','outlineWidth','spacing'];
  const storageKey = 'jiajian.subtitle-presets.v1';
  const panel = get('inspector-panel-subtitles'), pane = get('caption-preview-pane');
  const canvas = get('caption-preview-canvas'), text = get('caption-preview-text'), feedback = get('caption-feedback');
  const ctx = canvas.getContext('2d');
  const zoom = get('caption-zoom-dialog'), largeCanvas = get('caption-zoom-canvas');
  let moving = false;
  let schedule, loading = false, lastKey = '', queuedKey = '', bitmap;
  let previous = {...defaults};
  let saved = [];
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(data)) saved = data.filter((p) => typeof p?.name === 'string' && p.style).slice(0,32);
  } catch { /* Built-in presets are available without local storage. */ }
  function read() {
    const result = {};
    for (const [key,id] of Object.entries(fields)) {
      const node = get('caption-'+id);
      if (node.type === 'checkbox') result[key] = node.checked;
      else if (node.type === 'number') result[key] = node.value !== '' && node.validity.valid ? node.valueAsNumber : previous[key];
      else result[key] = node.value;
    }
    previous = result;
    return result;
  }
  function set(style) {
    for (const [key,value] of Object.entries(style)) {
      if (!Object.hasOwn(fields,key)) continue;
      const node = get('caption-'+fields[key]);
      if (node.type === 'checkbox') node.checked = value;
      else node.value = value;
    }
    read();
  }
  function status(value) { feedback.textContent = value; feedback.hidden = !value; }
  function draw() {
    const ratio = get('ratio').value;
    const [width,height] = ratio === '9:16' ? [720,1280] : ratio === '1:1' ? [720,720] : [1280,720];
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    get('caption-sample-stage').dataset.ratio = ratio;
    ctx.fillStyle = '#252b32'; ctx.fillRect(0,0,width,height);
    const source = !still.hidden && still.naturalWidth ? still : !player.hidden && player.readyState >= 2 ? player : null;
    if (source) {
      const w = source.videoWidth || source.naturalWidth, h = source.videoHeight || source.naturalHeight;
      const scale = (get('fit').value === 'fill' ? Math.max : Math.min)(width/w,height/h);
      ctx.drawImage(source,(width-w*scale)/2,(height-h*scale)/2,w*scale,h*scale);
    }
    if (bitmap && get('caption-enabled').checked) ctx.drawImage(bitmap,0,0,width,height);
    if (moving) {
      const x = width*get('caption-x').valueAsNumber/100, y = height*get('caption-y').valueAsNumber/100;
      ctx.strokeStyle = '#60e0e6'; ctx.lineWidth = Math.max(2,width/350);
      ctx.beginPath(); ctx.arc(x,y,width/95,0,2*Math.PI); ctx.stroke();
    }
    if (zoom.open) {
      if (largeCanvas.width !== width || largeCanvas.height !== height) { largeCanvas.width = width; largeCanvas.height = height; }
      largeCanvas.getContext('2d').drawImage(canvas,0,0);
    }
  }
  function request() {
    if (panel.hidden || !pane.open) return null;
    const sample = sourceCue();
    const cue = text.value.trim() ? {text:text.value.trim()} : sample || {text:'在这里预览字幕样式'};
    return {style:read(),ratio:get('ratio').value,cue:{text:cue.text.slice(0,320),highlights:cue.highlights}};
  }
  async function render() {
    const data = request();
    if (!data) return;
    draw();
    if (!data.style.enabled) { status('成片字幕已关闭。'); return; }
    const key = JSON.stringify(data);
    if (lastKey === key || loading) return;
    loading = true;
    try {
      const bytes = await api.previewSubtitleStyle(data);
      const image = await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      if (key === queuedKey) {
        bitmap?.close(); bitmap = image; lastKey = key; draw(); status('');
        canvas.dataset.rendered = 'true';
      } else image.close();
    } catch (error) {
      if (key === queuedKey) { lastKey = key; bitmap?.close(); bitmap = undefined; draw(); status('字幕预览失败，重新展开可重试。'+error.message); }
    } finally {
      loading = false;
      if (queuedKey !== key) refresh();
    }
  }
  function refresh() {
    const style = read();
    get('caption-x-field').hidden = get('caption-y-field').hidden = style.position !== 'custom';
    get('caption-align').disabled = get('caption-margin').disabled = style.position === 'custom';
    const buttons = get('caption-presets').children;
    for (const button of buttons) {
      const exact = Object.entries(button.captionStyle).every(([key,value]) => style[key] === value);
      button.setAttribute('aria-pressed',String(exact));
    }
    clearTimeout(schedule);
    const data = request();
    if (!data) { queuedKey = ''; return; }
    const key = JSON.stringify(data);
    queuedKey = key;
    if (!data.style.enabled) { draw(); status('成片字幕已关闭。'); return; }
    if (lastKey === key) { draw(); if (bitmap) status(''); return; }
    if (bitmap) { bitmap.close(); bitmap = undefined; lastKey = ''; }
    delete canvas.dataset.rendered;
    draw();
    schedule = setTimeout(render,140);
  }
  function renderPresets() {
    const options = looks.map(([name,look]) => ({name,style:Object.fromEntries(styleKeys.map((k)=>[k,look[k] ?? defaults[k]]))})).concat(saved);
    get('caption-presets').replaceChildren(...options.map(({name,style}) => {
      const button = document.createElement('button'), sample = document.createElement('strong'), label = document.createElement('small');
      button.type = 'button'; button.title = name; button.captionStyle = style; sample.textContent = '字'; label.textContent = name;
      sample.style.color = style.textColor; sample.style.webkitTextStroke = (style.outlineWidth*.7)+'px '+style.outlineColor;
      sample.style.paintOrder = 'stroke fill'; sample.style.fontWeight = style.bold ? 'bold' : 'normal';
      button.append(sample,label);
      button.addEventListener('click',() => {
        set(style);
        get('caption-font').dispatchEvent(new Event('input',{bubbles:true}));
      });
      return button;
    }));
    refresh();
  }
  get('caption-save-preset').addEventListener('click',() => {
    get('caption-save-row').hidden = false; get('caption-preset-name').focus();
  });
  get('caption-cancel-preset').addEventListener('click',() => { get('caption-save-row').hidden = true; });
  get('caption-enlarge').addEventListener('click',() => { zoom.showModal(); draw(); refresh(); });
  get('caption-zoom-close').addEventListener('click',() => zoom.close());
  for (const stage of [canvas,largeCanvas]) {
    function move(event) {
      const rect = stage.getBoundingClientRect();
      const coordinate = (offset,span) => Math.max(0,Math.min(100,Math.round(100*offset/span)));
      set({position:'custom', x:coordinate(event.clientX-rect.left,rect.width), y:coordinate(event.clientY-rect.top,rect.height)});
      refresh();
    }
    stage.addEventListener('pointerdown',(event) => {
      if (event.button || !get('caption-enabled').checked || get('montage-settings').disabled) return;
      moving = true; stage.setPointerCapture(event.pointerId); move(event);
    });
    stage.addEventListener('pointermove',(event) => {
      if (stage.hasPointerCapture(event.pointerId)) move(event);
    });
    stage.addEventListener('lostpointercapture',() => {
      moving = false;
      get('caption-position').dispatchEvent(new Event('input',{bubbles:true}));
    });
  }
  get('caption-confirm-preset').addEventListener('click',() => {
    const name = get('caption-preset-name').value.trim();
    if (!name) { status('请输入预设名称。'); return; }
    const style = {...read()}; delete style.enabled;
    const items = saved.filter((preset)=>preset.name !== name);
    if (items.length >= 32) { status('已保存 32 个预设。可输入已有预设名称更新。'); return; }
    items.push({name,style});
    try { localStorage.setItem(storageKey,JSON.stringify(items)); }
    catch { status('预设未保存，当前存储不可用。'); return; }
    saved = items;
    get('caption-preset-name').value = ''; get('caption-save-row').hidden = true;
    renderPresets(); status('已保存「'+name+'」。');
  });
  pane.addEventListener('toggle',() => { lastKey = ''; refresh(); });
  new MutationObserver(refresh).observe(panel,{attributes:true,attributeFilter:['hidden']});
  panel.addEventListener('input',refresh);
  panel.addEventListener('change',refresh);
  get('ratio').addEventListener('change',refresh); get('fit').addEventListener('change',refresh);
  [player,still].forEach((el) => ['seeked','loadeddata','load'].forEach((event) => el.addEventListener(event,() => {
    if (!panel.hidden && pane.open) draw();
  })));
  renderPresets();
  return {
    read, refresh,
    restore(style) { previous = {...defaults}; set({...defaults,...style}); text.value = ''; refresh(); },
  };
};

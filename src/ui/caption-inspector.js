'use strict';

window.mountCaptionInspector = ({ api, sourceCue, player, still }) => {
  const get = (id) => document.getElementById(id);
  const fields = { size:'size', font:'font', textColor:'color', outlineColor:'outline', position:'position',
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
    ['珊瑚红',{textColor:'#ff756e',outlineColor:'#512325',bold:true}],
    ['薄荷绿',{textColor:'#b2f5ce',outlineColor:'#244837',outlineWidth:1,bold:true}],
    ['白字红边',{outlineColor:'#e73b50',outlineWidth:3,bold:true}],
    ['晴空蓝',{textColor:'#66ccff',outlineColor:'#173d68',outlineWidth:3,bold:true}],
    ['黑字金边',{textColor:'#20202a',outlineColor:'#ffcf46',outlineWidth:3,bold:true}],
    ['墨绿描边',{textColor:'#e4ffda',outlineColor:'#307448',outlineWidth:4,bold:true}],
    ['浅紫描边',{textColor:'#d7baff',outlineColor:'#67428c',outlineWidth:2,bold:true}],
    ['橙色重描',{textColor:'#ff9b48',outlineColor:'#663719',outlineWidth:4,bold:true}],
    ['米色楷体',{font:'kai',textColor:'#f1dfbd',outlineColor:'#674f37',outlineWidth:1}],
    ['冰蓝斜体',{textColor:'#abdff3',italic:true,outlineWidth:0}],
    ['青柠粗体',{textColor:'#d4f467',outlineColor:'#415128',bold:true}],
    ['白字下划线',{underline:true,outlineWidth:1}],
  ];
  const styleKeys = ['font','textColor','outlineColor','bold','italic','underline','outlineWidth','spacing'];
  const storageKey = 'jiajian.subtitle-presets.v1';
  const panel = get('inspector-panel-subtitles'), pane = get('caption-preview-pane');
  const grids = [get('caption-presets'), get('caption-personal-presets')];
  const alignments = [...get('caption-align').querySelectorAll('input')];
  const sizeSlider = get('caption-size-slider');
  const canvas = get('caption-preview-canvas'), text = get('caption-preview-text'), feedback = get('caption-feedback');
  const ctx = canvas.getContext('2d');
  const zoom = get('caption-zoom-dialog'), largeCanvas = get('caption-zoom-canvas');
  let drag;
  let schedule, loading = false, lastKey = '', queuedKey = '', bitmap;
  let previous = {...defaults}, preferredPreset;
  let saved = [];
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(data)) saved = data.filter((p) => typeof p?.name === 'string' && p.style).slice(0,32);
  } catch { /* Built-in presets are available without local storage. */ }
  function read() {
    const result = { align: alignments.find(input => input.checked).value };
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
    const align = alignments.find(input => input.value === style.align);
    if (align) align.checked = true;
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
    if (drag) {
      const x = width*drag.position.x/100, y = height*drag.position.y/100;
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
    return {style:{...read(), ...drag?.position},ratio:get('ratio').value,cue:{text:cue.text.slice(0,320),highlights:cue.highlights}};
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
    sizeSlider.value = style.size;
    get('caption-x-field').hidden = get('caption-y-field').hidden = style.position !== 'custom';
    get('caption-align').disabled = get('caption-margin').disabled = style.position === 'custom';
    const matches = button => button && Object.entries(button.captionStyle).every(([key,value]) => style[key] === value);
    // A personal preset includes size and placement. Built-ins only specify the type treatment.
    const selected = matches(preferredPreset) ? preferredPreset :
      [...grids[1].children].find(matches) ?? [...grids[0].children].find(matches);
    get('caption-preset-label').textContent = selected?.title ?? '自定义';
    for (const grid of grids) {
      const tabStop = grid.contains(selected ?? null) ? selected : grid.firstElementChild;
      for (const button of grid.children) {
        button.setAttribute('aria-pressed', String(button === selected));
        button.tabIndex = button === tabStop ? 0 : -1;
      }
    }
    clearTimeout(schedule);
    const data = request();
    if (!style.enabled) { clearPreview(); queuedKey = ''; draw(); status('成片字幕已关闭。'); return; }
    if (!data) { queuedKey = ''; return; }
    const key = JSON.stringify(data);
    queuedKey = key;
    if (lastKey === key) {
      draw();
      if (bitmap) { canvas.dataset.rendered = 'true'; status(''); }
      return;
    }
    // Keep the previous image on screen until the new libass render is ready.
    delete canvas.dataset.rendered;
    draw();
    schedule = setTimeout(render,140);
  }
  function clearPreview() {
    bitmap?.close();
    bitmap = undefined;
    lastKey = '';
    delete canvas.dataset.rendered;
  }
  function paleOnLightTile(hex) {
    if (!/^#[\da-f]{6}$/i.test(hex)) return false;
    const [r,g,b] = hex.slice(1).match(/../g).map(pair => {
      const channel = parseInt(pair,16) / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    // A color lighter than this has less than 3:1 contrast on the light control fill.
    return .2126*r + .7152*g + .0722*b > .25;
  }
  function presetButton({name,style}, personal) {
    const button = document.createElement('button'), sample = document.createElement('strong');
    button.type = 'button';
    button.title = name;
    button.setAttribute('aria-label',name);
    button.captionStyle = style;
    sample.textContent = 'T';
    sample.setAttribute('aria-hidden','true');
    const look = {...defaults, ...style};
    button.classList.toggle('caption-pale-ink', paleOnLightTile(look.textColor) &&
      (!look.outlineWidth || paleOnLightTile(look.outlineColor)));
    window.previewTextAppearance(sample, {font:look.font, outlineWidth:look.outlineWidth, outlineColor:look.outlineColor}, look.textColor, 1.65);
    sample.style.fontWeight = look.bold ? '700' : '400';
    sample.style.fontStyle = look.italic ? 'italic' : 'normal';
    sample.style.textDecoration = look.underline ? 'underline' : 'none';
    button.append(sample);
    if (personal) {
      const label = document.createElement('small');
      label.textContent = name;
      button.append(label);
    }
    button.addEventListener('click',() => {
      preferredPreset = button;
      set(style);
      get('caption-font').dispatchEvent(new Event('input',{bubbles:true}));
    });
    return button;
  }
  function renderPresets(savedName) {
    const options = looks.map(([name,look]) => ({name,style:Object.fromEntries(styleKeys.map(key => [key,look[key] ?? defaults[key]]))}));
    grids[0].replaceChildren(...options.map(preset => presetButton(preset,false)));
    grids[1].replaceChildren(...saved.map(preset => presetButton(preset,true)));
    get('caption-personal-group').hidden = !saved.length;
    preferredPreset = [...grids[1].children].find(button => button.title === savedName);
    refresh();
  }
  for (const grid of grids) {
    grid.addEventListener('keydown',event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const buttons = [...grid.children];
      const index = buttons.indexOf(event.target);
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      const targets = {ArrowRight:index+1, ArrowLeft:index-1, ArrowDown:index+columns, ArrowUp:index-columns, Home:0, End:buttons.length-1};
      if (index < 0 || !Object.hasOwn(targets,event.key)) return;
      event.preventDefault();
      const next = buttons[Math.max(0,Math.min(buttons.length-1,targets[event.key]))];
      if (next !== event.target) { next.focus(); next.click(); }
    });
  }
  for (const eventName of ['input','change']) {
    sizeSlider.addEventListener(eventName,() => { get('caption-size').value = sizeSlider.value; });
  }
  const savePreset = get('caption-save-preset'), saveRow = get('caption-save-row');
  function showPresetForm(open) {
    saveRow.hidden = !open;
    savePreset.setAttribute('aria-expanded',String(open));
    (open ? get('caption-preset-name') : savePreset).focus();
  }
  savePreset.addEventListener('click',() => showPresetForm(saveRow.hidden));
  get('caption-cancel-preset').addEventListener('click',() => showPresetForm(false));
  saveRow.addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === 'Escape') showPresetForm(false);
    else if (event.key === 'Enter' && event.target === get('caption-preset-name')) get('caption-confirm-preset').click();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  get('caption-enlarge').addEventListener('click',() => { zoom.showModal(); draw(); refresh(); });
  get('caption-zoom-close').addEventListener('click',() => zoom.close());
  function pointerPosition(stage,event) {
    const rect = stage.getBoundingClientRect();
    const coordinate = (offset,span) => Math.max(0,Math.min(100,Math.round(100*offset/span)));
    return {position:'custom', x:coordinate(event.clientX-rect.left,rect.width), y:coordinate(event.clientY-rect.top,rect.height)};
  }
  function endDrag(event) {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.id)) return;
    const {stage,id} = drag;
    drag = undefined;
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    if (event?.type === 'pointerup') {
      set(pointerPosition(stage,event));
      get('caption-position').dispatchEvent(new Event('input',{bubbles:true}));
    } else refresh();
  }
  for (const stage of [canvas,largeCanvas]) {
    stage.addEventListener('pointerdown',(event) => {
      if (event.button || !event.isPrimary || drag || !get('caption-enabled').checked || get('montage-settings').disabled) return;
      stage.setPointerCapture(event.pointerId);
      drag = {stage,id:event.pointerId,position:pointerPosition(stage,event)};
      refresh();
    });
    stage.addEventListener('pointermove',(event) => {
      if (drag?.stage !== stage || drag.id !== event.pointerId) return;
      drag.position = pointerPosition(stage,event);
      refresh();
    });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) stage.addEventListener(type,endDrag);
  }
  window.addEventListener('blur', () => endDrag());
  window.addEventListener('keydown',event => {
    if (!drag || event.isComposing || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
  },true);
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
    get('caption-preset-name').value = '';
    renderPresets(name);
    showPresetForm(false);
    status('已保存「'+name+'」。');
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
    restore(style) { clearPreview(); preferredPreset = undefined; previous = {...defaults}; set({...defaults,...style}); text.value = ''; draw(); refresh(); },
  };
};

'use strict';

window.mountEditorTextTools = function (ctx) {
  function open() {
    if(ctx.busy() || document.querySelector('dialog[open]')) return;
    const dialog=document.createElement('dialog');dialog.className='sequence-dialog';
    dialog.innerHTML='<form><header><h2>批量编辑文字</h2><button type="button" data-close>关闭</button></header><div class="sequence-fields"><label>作用范围<select name="scope"><option value="all">全部文字</option><option value="subtitle">口播与视频字幕</option><option value="layers">包装文字与文字组</option><option value="script">脚本台词与备注</option></select></label><label>查找<input name="search" maxlength="500"></label><label>替换为<input name="replacement" maxlength="500"></label><output data-count></output><details><summary>统一包装文字样式</summary><label>字号<input type="number" name="size" min="1" max="600" value="48"></label><label>文字颜色<input type="color" name="color" value="#ffffff"></label><label>水平位置（%）<input name="x" type="number" min="0" max="100" step=".1" value="50"></label><label>垂直位置（%）<input name="y" type="number" min="0" max="100" step=".1" value="75"></label><button type="button" data-style>应用到全部包装文字</button></details><button type="button" data-import>从脚本追加文字组</button></div><footer><output class="sequence-message"></output><button type="submit" class="sequence-primary">全部替换</button></footer></form>';
    const form=dialog.querySelector('form'),f=form.elements,notice=form.querySelector('.sequence-message');
    const applyAll=form.querySelector('[data-style]');
    const scale=document.createElement('input'); scale.type='number'; scale.min=5; scale.max=100; scale.value=100; scale.step=.1;
    const scaleLabel=document.createElement('label');scaleLabel.append('缩放（%）',scale);
    const styles=window.createTextPresets(null,{fontSize:f.size,color:f.color,x:f.x,y:f.y,scale});
    const applyShot=document.createElement('button'); applyShot.type='button'; applyShot.textContent='应用到当前分镜的文字';
    applyShot.disabled=(ctx.currentShotIndex?.() ?? -1)<0; applyAll.before(scaleLabel,styles.element,applyShot);
    if(ctx.editingScript()){f.scope.value='script';f.scope.disabled=true;form.querySelector('details').hidden=true;form.querySelector('[data-import]').hidden=true;}
    function edit(commit,styling=false,singleShot=false) {
      const scope=styling ? 'layers' : f.scope.value;
      const config=structuredClone(ctx.getConfig());
      let count=0;
      const match=(type)=>scope==='all' || scope===type;
      const replace=(text)=>{
        if(!f.search.value) return text;
        const pieces=text.split(f.search.value);count+=pieces.length-1;return commit ? pieces.join(f.replacement.value) : text;
      };
      function captions(track) {
        for(const cue of track?.cues ?? []) {
          cue.text=replace(cue.text);
          if(cue.highlights) cue.highlights=cue.highlights.filter((m)=>cue.text.includes(m.word));
        }
      }
      function layers(items) {
        for(const layer of items ?? []) {
          if(Array.isArray(layer)) layers(layer);
          else if(layer?.kind==='text') {
            if(styling){Object.assign(layer,{fontSize:f.size.valueAsNumber,color:f.color.value,x:f.x.valueAsNumber/100,y:f.y.valueAsNumber/100,scale:scale.valueAsNumber/100,textStyle:styles.read()});count++;}
            else layer.text=replace(layer.text);
          }
        }
      }
      if(match('script')) for(const key of ['whole','segmented','textGroups']) for(const row of config.script?.[key] ?? []) {
        row.dialogue=replace(row.dialogue);row.note=replace(row.note);
      }
      if(match('subtitle')) {
        captions(config.subtitles);for(const t of config.extraWholeTracks ?? []) captions(t.subtitles);
        for(const [id,t] of Object.entries(config.generatedCaptions ?? {})){if(typeof t==='string') config.generatedCaptions[id]=replace(t);else captions(t);}
        for(const shot of config.shots ?? []) for(const clip of shot) captions(clip.videoSubtitles);
      }
      if(singleShot) {
        const i=ctx.currentShotIndex();
        for(const clip of config.shots?.[i] ?? []) layers(clip.layers);
        layers(config.packaging?.segmentNarration?.[i]);
        if(config.packaging?.textMode==='segmented') for(const row of config.packaging.textGroups ?? []) layers(row[i]);
      } else if(match('layers')) {
        for(const shot of config.shots ?? []) for(const clip of shot) layers(clip.layers);
        for(const key of ['global','composites','textGroups','wholeNarration','segmentNarration']) layers(config.packaging?.[key]);
      }
      if(!styling){form.querySelector('[data-count]').textContent='匹配 '+count+' 处';form.querySelector('[type="submit"]').disabled=!count;}
      if(commit && count){ctx.apply(config);dialog.close();}
      else if(styling) notice.textContent=singleShot ? '当前分镜没有包装文字。' : '当前工程没有包装文字。';
    }
    form.oninput=()=>edit(false);form.onsubmit=(e)=>{e.preventDefault();edit(true);};
    form.querySelector('[data-style]').onclick=()=>{if(form.reportValidity()) edit(true,true);};
    applyShot.onclick=()=>{if(form.reportValidity()) edit(true,true,true);};
    form.querySelector('[data-import]').onclick=()=>{const count=ctx.importGroups();notice.textContent=count ? '已追加 '+count+' 组' : '脚本中没有可以追加的文字组。';};
    form.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);edit(false);dialog.showModal();f.search.focus();
  }
  return {open};
};

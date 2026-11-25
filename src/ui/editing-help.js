'use strict';

(() => {
  const get = id => document.getElementById(id);
  const entry = get('editing-help-entry');
  const frame = document.querySelector('.app-frame');
  const steps = window.editorMessages.tourSteps;
  function element(tag, value) {
    const result = document.createElement(tag);
    if (value !== undefined) result.textContent = value;
    return result;
  }
  function button(text, action) {
    const b = element('button',text);
    b.type = 'button';
    b.addEventListener('click',action);
    return b;
  }
  const tour = element('aside');
  tour.id = 'editing-tour';
  tour.setAttribute('aria-label','剪辑入门');
  const heading = element('strong'), copy = element('p'), actions = element('div');
  heading.setAttribute('aria-live','polite');
  let step = 0, target;
  function closeTour() {
    target?.classList.remove('editing-tour-target');
    tour.remove();
  }
  const previous = button('上一步',() => showTour(step-1));
  const next = button('下一步',() => step === steps.length-1 ? closeTour() : showTour(step+1));
  actions.append(button('跳过',closeTour),previous,next);
  tour.append(heading,copy,actions);
  function showTour(index) {
    step = index;
    const [id,name,detail] = steps[step];
    target?.classList.remove('editing-tour-target');
    target = get(id);
    const editor = frame.dataset.mode === 'montage';
    if (editor) {
      get('export-heading').parentElement.after(tour);
      target?.classList.add('editing-tour-target');
    } else document.querySelector('#editing-help-dialog footer').before(tour);
    heading.textContent = (step+1)+' / '+steps.length+'　'+name;
    copy.textContent = detail;
    previous.disabled = step === 0;
    next.textContent = step === steps.length-1 ? '完成' : '下一步';
  }
  function modeChanged() {
    if (frame.dataset.mode !== 'montage') { closeTour(); return; }
    if (!localStorage.getItem('jiajian.editing-tour.v1')) {
      localStorage.setItem('jiajian.editing-tour.v1','seen');
      showTour(0);
    }
  }
  new MutationObserver(modeChanged).observe(frame,{attributes:true,attributeFilter:['data-mode']});
  modeChanged();
  function openHelp() {
    if (document.querySelector('dialog:modal')) return;
    const anchor = document.activeElement;
    const dialog = element('dialog'), body = element('div'), footer = element('footer');
    dialog.id = 'editing-help-dialog';
    dialog.className = 'cloud-settings-dialog';
    body.className = 'cloud-settings-body';
    footer.className = 'cloud-settings-actions';
    const title = element('h2','剪辑帮助');
    title.id = 'editing-help-title';
    dialog.setAttribute('aria-labelledby',title.id);
    const list = element('dl');
    const entries = [['快捷键速查','? / Ctrl+/'],['调整分镜顺序','Alt+← / Alt+→'],['进入片段裁剪','双击视频片段'],['播放或暂停时间线','空格'],
      ['选择素材','方向键 / Home / End'],['打开素材菜单','Shift+F10'],['删除所选素材或时间线片段','Delete'],
      ['取消拖动、关闭菜单','Esc'],['视频片段菜单静音','M'],['视频片段菜单左右插入分镜','[ / ]'],
      ...window.cutShortcuts.entries().map(({label,keys})=>[label,keys || '未绑定'])];
    for (const [name,key] of entries) list.append(element('dt',name),element('dd',key));
    body.append(title,element('h3','快捷键与手势'),list);
    footer.append(button('重看剪辑引导',()=>{
      if (frame.dataset.mode === 'montage') dialog.close();
      showTour(0);
    }),button('关闭',()=>dialog.close()));
    dialog.append(body,footer);
    dialog.addEventListener('close',()=>{
      if (dialog.contains(tour)) closeTour();
      window.afterDialogExit(dialog);
      if (anchor?.isConnected) anchor.focus({preventScroll:true});
    },{once:true});
    document.body.append(dialog);
    dialog.showModal();
  }
  entry.addEventListener('click',openHelp);
  window.addEventListener('keydown',event=>{
    if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat ||
        event.target.closest?.('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog:modal')) return;
    if (!(event.key==='?' || ((event.ctrlKey||event.metaKey) && !event.shiftKey && (event.code==='Slash'||event.key==='/')))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openHelp();
  },true);
})();

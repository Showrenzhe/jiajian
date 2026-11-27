'use strict';

(() => {
  const get = id => document.getElementById(id);
  const entry = get('editing-help-entry');
  const frame = document.querySelector('.app-frame');
  const steps = window.editorMessages.tourSteps;
  const registry = window.editorCommands;
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
    const title = element('h2',registry.get('editing-help').title);
    title.id = 'editing-help-title';
    title.tabIndex = -1;
    title.autofocus = true;
    dialog.setAttribute('aria-labelledby',title.id);
    body.append(title);
    for (const [scope, heading] of Object.entries(window.editorMessages.shortcutScopes)) {
      const list = element('dl');
      for (const command of registry.list().filter(command => command.help && command.scope === scope)) {
        list.append(element('dt', command.title), element('dd', registry.labelFor(command.id) || window.editorMessages.shortcutSettings.unbound));
      }
      body.append(element('h3', heading), list);
    }
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
  registry.bind('editing-help', {when: () => !document.querySelector('dialog:modal:not(#command-palette)'), run: openHelp});
  entry.dataset.commandId = 'editing-help';
  entry.textContent = registry.get('editing-help').title;
  entry.setAttribute('aria-label', entry.textContent);
  entry.setAttribute('aria-keyshortcuts', registry.keysFor('editing-help').map(key => key.replace('Ctrl+', 'Control+')).join(' '));
  entry.title = entry.textContent + '（' + registry.labelFor('editing-help') + '）';
  entry.addEventListener('click',() => registry.execute('editing-help'));
  window.addEventListener('keydown',event=>{
    if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat ||
        event.target.closest?.('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog:modal')) return;
    if (!(event.key==='?' || ((event.ctrlKey||event.metaKey) && !event.shiftKey && (event.code==='Slash'||event.key==='/')))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    registry.execute('editing-help');
  },true);
})();

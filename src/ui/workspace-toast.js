'use strict';

window.mountWorkspaceToast = (toast) => {
  const message = toast.querySelector('[role="status"]');
  const button = toast.querySelector('button');
  const delay = 4500;
  let timer;
  let undo;
  button.textContent = window.editorMessages.keys.undo;

  function dismiss() {
    clearTimeout(timer);
    undo = undefined;
    toast.hidden = true;
    document.body.removeAttribute('data-workspace-toast');
    button.hidden = true;
    message.textContent = '';
  }

  function schedule() {
    clearTimeout(timer);
    if (!toast.hidden && (!undo || !toast.matches(':hover, :focus-within'))) timer = setTimeout(dismiss, delay);
  }
  toast.addEventListener('pointerenter', () => clearTimeout(timer));
  toast.addEventListener('pointerleave', schedule);
  toast.addEventListener('focusin', () => clearTimeout(timer));
  toast.addEventListener('focusout', () => queueMicrotask(schedule));
  button.addEventListener('click', () => {
    const action = undo;
    dismiss();
    action?.();
  });

  return {
    show(text, action) {
      undo = action;
      button.hidden = !action;
      toast.hidden = false;
      document.body.toggleAttribute('data-workspace-toast', true);
      message.textContent = text;
      schedule();
    },
    dismiss,
    dismissUndo() { if (undo) dismiss(); },
  };
};

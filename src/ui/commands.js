'use strict';

// The browser and the shortcut reference tests use the same definitions.
((createRegistry) => {
  if (typeof window !== 'undefined') window.editorCommands = createRegistry(window.editorMessages);
  if (typeof module === 'object' && module.exports) module.exports = createRegistry;
})(function createRegistry(messages) {
  const commands = new Map();
  let currentBindings = () => undefined;

  function register({id, title = messages.commandTitles[id], shortcut = [], when, run, ...options}) {
    if (commands.has(id) || !title) throw Error('Invalid command: ' + id);
    const command = {id, title, shortcut, keywords:messages.commandKeywords[id], ...options,
      when: when ?? (() => typeof run === 'function'), run: run ?? (() => false)};
    commands.set(id, command);
    return command;
  }

  // The editing surface owns its selection, modal state and execution handler.
  function bind(id, handlers) {
    const command = commands.get(id);
    if (!command) throw Error('Unknown command: ' + id);
    if (handlers.run && !handlers.when) command.when = () => true;
    Object.assign(command, handlers);
    return command;
  }

  const list = () => [...commands.values()];
  const keysFor = id => {
    const command = commands.get(id);
    return (command?.customizable ? currentBindings(id) : undefined) ?? command?.shortcut ?? [];
  };
  function labelFor(id) {
    return keysFor(id).filter(Boolean).map(key => messages.shortcutNames[key] ?? key).join(' / ');
  }
  function fixedOwner(key, targetId) {
    const target = commands.get(targetId);
    // Clip shortcuts run only in the trim editor. The montage quick save listener runs in both surfaces.
    return list().find(command => !command.customizable && command.shortcut.includes(key) &&
      (command.scope === 'global' || !target || target.scope === 'montage' ||
        (target.scope === 'timeline' && command.scope === 'montage') || command.scope === target.scope));
  }
  function execute(id, context) {
    const command = commands.get(id);
    if (!command?.when(context)) return false;
    return command.run(context);
  }

  function editable(id, title, ...shortcut) {
    register({id, title, shortcut, customizable: true, help: true, scope: id === 'quick-save' ? 'montage' : 'cut'});
  }
  const keys = messages.keys;
  editable('undo', keys.undo, 'Ctrl+Z');
  editable('redo', keys.redo, 'Ctrl+Shift+Z');
  editable('split', keys.split, 'W', 'Ctrl+B');
  editable('trim-left', keys.trimLeft, 'Q');
  editable('trim-right', keys.trimRight, 'E');
  editable('reverse', keys.reverse, null);
  editable('mirror', keys.mirror, null);
  editable('crop', keys.crop, null);
  editable('rotate', keys.rotate, null);
  editable('quick-save', keys.save, 'Ctrl+S');
  editable('frame-back', keys.back, ',');
  editable('frame-forward', keys.forward, '.');
  editable('frames-back', keys.backTen, 'Shift+,');
  editable('frames-forward', keys.forwardTen, 'Shift+.');

  for (const [id, key] of Object.entries({
    'timeline-in':'I', 'timeline-out':'O', 'timeline-clear-in':'Alt+I', 'timeline-clear-out':'Alt+O',
    'timeline-marker-add':'M', 'timeline-reverse':'J', 'timeline-pause':'K', 'timeline-forward':'L',
    'timeline-snap':null, 'timeline-loop':null, 'timeline-marker-prev':null, 'timeline-marker-next':null,
    'timeline-marker-rename':null, 'timeline-marker-delete':null,
  })) register({id, scope:'timeline', shortcut:[key], customizable:true, help:true});

  function fixed(scope, id, ...shortcut) {
    register({id, scope, shortcut, help: true});
  }
  fixed('global', 'palette', 'Ctrl+K');
  fixed('global', 'editing-help', 'Shift+/', 'Ctrl+/');
  fixed('global', 'dismiss', 'Escape');
  fixed('global', 'nav-toggle', 'Ctrl+\\');
  fixed('editing', 'timeline-text-tools', 'Ctrl+F');
  fixed('montage', 'play-timeline', 'Space');
  fixed('montage', 'move-shot-left', 'Alt+ArrowLeft');
  fixed('montage', 'move-shot-right', 'Alt+ArrowRight');
  fixed('montage', 'edit-clip', 'DoubleClick');
  fixed('montage', 'delete-selection', 'Delete');
  // Montage history keys already work independently from the editable clip history keys.
  fixed('montage', 'project-undo', 'Ctrl+Z');
  fixed('montage', 'project-redo', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Shift+Y');
  fixed('timeline', 'timeline-copy', 'Ctrl+C');
  fixed('timeline', 'timeline-paste', 'Ctrl+V');
  fixed('material', 'navigate-materials', 'ArrowKeys', 'Home', 'End');
  fixed('material', 'open-material-menu', 'Shift+F10');
  fixed('material', 'material-context-rename', 'F2');
  fixed('material', 'material-context-remove', 'Delete');
  fixed('videoMenu', 'mute-video', 'M');
  fixed('videoMenu', 'insert-shot-left', '[');
  fixed('videoMenu', 'insert-shot-right', ']');
  for (const id of [
    'add-text','add-sticker','video-speed','settings.appearance','settings.shortcuts','open-project','add-shot','save-project-as',
    'title-home','update-notice-dismiss','draft-context-delete','material-context-audio','material-import-files',
    'material-import-directory','material-import','material-folder-import','material-audio-open',
    'prepare-preview','start-export','import-materials','timeline-more','track-more',
    'match-all-voice-duration','timeline-scenes','timeline-cover','creative-cover','timeline-appearance','batch-levels',
    'timeline-text-groups','organize-tracks','clip-actions','layout-controls','track-slice','track-clean','track-reset',
    'timeline-fit','tracks-expand-all','tracks-collapse-all',
  ]) register({id});
  register({id:'panel-layout-toggle',title:messages.layoutEdit.start});
  register({id:'panel-layout-reset'});
  register({id:'software-update-entry',group:'settings'});
  const menu = messages.timelineMenu;
  for (const [id, title] of Object.entries({
    'track-mute':menu.muteTrack, 'track-unmute':menu.unmuteTrack, 'clip-speed':menu.speed,
    'split-here':menu.split, 'edit-track-clip':menu.edit,
  })) register({id,title});

  return {register, bind, get: id => commands.get(id), list, keysFor, labelFor, execute, fixedOwner,
    setBindingReader: read => { currentBindings = read; }};
});

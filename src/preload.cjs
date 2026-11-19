'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, value) {
  const response = await ipcRenderer.invoke(channel, value);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

let draftCloseListener;
function onBeforeDraftClose(callback) {
  if (typeof callback !== 'function' || draftCloseListener) throw new Error('草稿关窗回调无效。');
  const listener = async (_event, token) => {
    let ok = false;
    try { ok = await callback() === true; } catch { /* Keep the editor open on save failure. */ }
    await invoke('workbench:complete-draft-close', { token, ok }).catch(() => {});
  };
  draftCloseListener = listener;
  ipcRenderer.on('workbench:before-draft-close', listener);
  return invoke('workbench:draft-close-ready').catch((error) => {
    ipcRenderer.removeListener('workbench:before-draft-close', listener);
    draftCloseListener = undefined;
    throw error;
  });
}

contextBridge.exposeInMainWorld('workbench', {
  history: () => invoke('workbench:history'),
  workflows: () => invoke('workbench:workflows'),
  projects: () => invoke('workbench:projects'),
  listDrafts: () => invoke('workbench:list-drafts'),
  createDraft: (value) => invoke('workbench:create-draft', value),
  saveDraft: (value) => invoke('workbench:save-draft', value),
  openDraft: (id) => invoke('workbench:open-draft', id),
  onBeforeDraftClose,
  cloudTtsVoices: () => invoke('workbench:cloud-tts-voices'),
  cloudTtsSettings: () => invoke('workbench:cloud-tts-settings'),
  saveCloudTtsSettings: (value) => invoke('workbench:cloud-tts-save-settings', value),
  cloudTtsSample: (voiceId) => invoke('workbench:cloud-tts-sample', voiceId),
  cloudTtsSynthesize: (value) => invoke('workbench:cloud-tts-synthesize', value),
  pick: (kind, limit) => invoke('workbench:pick', { kind, limit }),
  pickSceneInput: (kind) => invoke('workbench:pick-scene-input', kind),
  pickSceneOutput: () => invoke('workbench:pick-scene-output'),
  sceneSplit: (value) => invoke('workbench:scene-split', value),
  pickMaterialFolder: () => invoke('workbench:pick-material-folder'),
  browseMaterialFolder: (folderId) => invoke('workbench:browse-material-folder', folderId),
  loadMaterialFile: (fileId) => invoke('workbench:load-material-file', fileId),
  videoThumbnail: (assetId) => invoke('workbench:video-thumbnail', assetId),
  pickSubtitles: () => invoke('workbench:pick-subtitles'),
  pickSubtitleBatch: (limit) => invoke('workbench:pick-subtitles', { limit }),
  pickSubs2srsInputs: () => invoke('workbench:pick-subs2srs-inputs'),
  splitSubs2srs: (value) => invoke('workbench:split-subs2srs', value),
  preparePreview: (config) => invoke('workbench:prepare-preview', config),
  renderPreview: (value) => invoke('workbench:render-preview', value),
  export: (mode, config, selection) => invoke('workbench:export', { mode, config, selection }),
  saveProject: (config) => invoke('workbench:save-project', config),
  openProject: (id) => invoke('workbench:open-project', id),
  cancel: () => invoke('workbench:cancel'),
  reveal: (file) => invoke('workbench:reveal', file),
  onProgress: (callback) => {
    ipcRenderer.on('workbench:progress', (_event, data) => callback(data));
  },
});

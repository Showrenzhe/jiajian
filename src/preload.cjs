'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, value) {
  const response = await ipcRenderer.invoke(channel, value);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

let draftCloseListener;
function onBeforeDraftClose(callback) {
  if (typeof callback !== 'function' || draftCloseListener) throw new Error('草稿关窗回调无效。');
  const listener = async (_event, token, purpose) => {
    let ok = false;
    let reason;
    try { ok = await callback(purpose) === true; } catch (error) { reason = error?.message; }
    await invoke('workbench:complete-draft-close', { token, ok, reason }).catch(() => {});
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
  getUpdate: () => invoke('workbench:get-update'),
  checkUpdate: () => invoke('workbench:check-update'),
  downloadUpdate: () => invoke('workbench:download-update'),
  installUpdate: () => invoke('workbench:install-update'),
  openUpdatePage: () => invoke('workbench:open-update-page'),
  openInstalledApps: () => invoke('workbench:open-installed-apps'),
  onUpdate: (callback) => {
    ipcRenderer.on('workbench:update-state', (_event, state) => callback(state));
  },
  setWindowAppearance: (theme) => invoke('workbench:window-appearance', theme),
  performanceSettings: () => invoke('workbench:performance-settings'),
  savePerformanceSettings: (patch) => invoke('workbench:performance-save', patch),
  chooseProxyFolder: () => invoke('workbench:performance-folder'),
  clearProxyCache: () => invoke('workbench:performance-clear'),
  history: () => invoke('workbench:history'),
  renameOutputs: (files,prefix) => invoke('workbench:rename-outputs',{files,prefix}),
  workflows: () => invoke('workbench:workflows'),
  creativeSettings: () => invoke('workbench:creative-settings'),
  saveCreativeSettings: (value) => invoke('workbench:save-creative-settings', value),
  runCreative: (value) => invoke('workbench:creative-run', value),
  projects: () => invoke('workbench:projects'),
  listDrafts: () => invoke('workbench:list-drafts'),
  deleteDraft: (value) => invoke('workbench:delete-draft', value),
  createDraft: (value) => invoke('workbench:create-draft', value),
  saveDraft: (value) => invoke('workbench:save-draft', value),
  openDraft: (id) => invoke('workbench:open-draft', id),
  onBeforeDraftClose,
  cloudTtsVoices: (options) => invoke('workbench:cloud-tts-voices', options),
  cloudTtsSettings: () => invoke('workbench:cloud-tts-settings'),
  verifyBreezeAccess: (key) => invoke('workbench:verify-breeze-access', key),
  openBreezeKeys: () => invoke('workbench:open-breeze-keys'),
  saveCloudTtsSettings: (value) => invoke('workbench:cloud-tts-save-settings', value),
  cloudTtsSample: (voiceId) => invoke('workbench:cloud-tts-sample', voiceId),
  cloudTtsSynthesize: (value) => invoke('workbench:cloud-tts-synthesize', value),
  pick: (kind, limit) => invoke('workbench:pick', { kind, limit }),
  pickSceneInput: (kind) => invoke('workbench:pick-scene-input', kind),
  pickSceneOutput: () => invoke('workbench:pick-scene-output'),
  sceneSplit: (value) => invoke('workbench:scene-split', value),
  detectSceneCuts: (assetId, options) => invoke('workbench:detect-scene-cuts', { assetId, options }),
  pickLut: () => invoke('workbench:pick-lut'),
  previewLook: (value) => invoke('workbench:preview-look',value),
  importDroppedMaterials: (files, destination) => invoke('workbench:drop-materials', {
    paths: files.map((file) => webUtils.getPathForFile(file)), destination,
  }),
  materialTilePreview: (id) => invoke('workbench:material-tile-preview', id),
  pickMaterialFolder: () => invoke('workbench:pick-material-folder'),
  browseMaterialFolder: (folderId) => invoke('workbench:browse-material-folder', folderId),
  loadMaterialFile: (fileId) => invoke('workbench:load-material-file', fileId),
  videoThumbnail: (assetId) => invoke('workbench:video-thumbnail', assetId),
  clipThumbnail: (id,time)=>invoke('workbench:clip-thumbnail',{id,time}),
  prepareSourceEdit: (id,ranges)=>invoke('workbench:prepare-source-edit',{id,ranges}),
  audioWaveform: (id,range)=>invoke('workbench:audio-waveform',{id,range}),
  previewSubtitleStyle: (value) => invoke('workbench:subtitle-style-preview',value),
  createForeground: (assetId) => invoke('workbench:foreground', assetId),
  detectPauses: (request) => invoke('workbench:detect-pauses',request),
  processAudio: (request) => invoke('workbench:process-audio',request),
  trackProxy: (assetId) => invoke('workbench:track-proxy', assetId),
  playbackProxy: (id) => invoke('workbench:playback-proxy',id),
  proxyDefault: () => invoke('workbench:proxy-default'),
  pickSubtitles: () => invoke('workbench:pick-subtitles'),
  recognizeSpeech: (id) => invoke('workbench:recognize-speech',id),
  pickSubtitleBatch: (limit) => invoke('workbench:pick-subtitles', { limit }),
  pickSubs2srsInputs: () => invoke('workbench:pick-subs2srs-inputs'),
  splitSubs2srs: (value) => invoke('workbench:split-subs2srs', value),
  preparePreview: (config, scope) => invoke('workbench:prepare-preview', scope === undefined ? config : { config, scope }),
  renderPreview: (value) => invoke('workbench:render-preview', value),
  export: (mode, config, selection) => invoke('workbench:export', { mode, config, selection }),
  saveProject: (config) => invoke('workbench:save-project', config),
  quickSaveProject: (token, config) => invoke('workbench:quick-save-project', { token, config }),
  openProject: (id) => invoke('workbench:open-project', id),
  cancel: () => invoke('workbench:cancel'),
  reveal: (file) => invoke('workbench:reveal', file),
  onProgress: (callback) => {
    ipcRenderer.on('workbench:progress', (_event, data) => callback(data));
  },
});

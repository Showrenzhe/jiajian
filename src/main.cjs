'use strict';

const { app } = require('electron');
const path = require('node:path');
const { mediaTool } = require('./media-tool.cjs');

// Media modules read tool locations on require. The installer ships these
// executables outside app.asar so FFmpeg and its child processes can run.
let dataDirectory;
if (app.isPackaged) {
  process.env.JIAJIAN_FFMPEG = mediaTool('ffmpeg', process.resourcesPath);
  process.env.JIAJIAN_FFPROBE = mediaTool('ffprobe', process.resourcesPath);
  dataDirectory = path.join(app.getPath('appData'), '佳剪', 'run-data');
}

const { launchDesktop } = require('./desktop.cjs');
launchDesktop({ dataDirectory }).catch((error) => {
  console.error(error);
  app.exit(1);
});

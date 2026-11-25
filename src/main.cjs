'use strict';

const { app } = require('electron');
const path = require('node:path');

// Media modules read tool locations on require. The installer ships these
// executables outside app.asar so FFmpeg and its child processes can run.
let dataDirectory;
if (app.isPackaged) {
  const tools = path.join(process.resourcesPath, 'tools', 'ffmpeg-8.0-full_build', 'bin');
  process.env.JIAJIAN_FFMPEG ||= process.env.SUPERDIR_REPLICA_FFMPEG || path.join(tools, 'ffmpeg.exe');
  process.env.JIAJIAN_FFPROBE ||= process.env.SUPERDIR_REPLICA_FFPROBE || path.join(tools, 'ffprobe.exe');
  dataDirectory = path.join(app.getPath('appData'), '佳剪', 'run-data');
}

const { launchDesktop } = require('./desktop.cjs');
launchDesktop({ dataDirectory }).catch((error) => {
  console.error(error);
  app.exit(1);
});

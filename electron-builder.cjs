'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ffmpegDirectory = 'tools/ffmpeg-8.0-full_build';
const ffmpegFiles = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'];

module.exports = {
  appId: 'io.github.showrenzhe.jiajian',
  files: ['src/**/*', '!src/native/**/*', 'package.json'],
  extraResources: [
    { from: 'vendor', to: 'vendor' },
    { from: ffmpegDirectory, to: ffmpegDirectory, filter: ffmpegFiles },
  ],
  beforePack: async ({ packager }) => {
    // electron-builder can skip absent extraResources and still produce an installer.
    for (const file of ffmpegFiles) {
      await fs.access(path.join(packager.projectDir, ffmpegDirectory, file));
    }
  },
  win: { target: ['nsis'], icon: 'src/ui/assets/jiajian-logo.ico' },
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    artifactName: 'Jiajian-Setup-${version}-${arch}.${ext}',
  },
  publish: { provider: 'github', owner: 'Showrenzhe', repo: 'jiajian', releaseType: 'release' },
};

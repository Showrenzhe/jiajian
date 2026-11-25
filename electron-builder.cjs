'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { updateFeed } = require('./src/update-feed.cjs');
const feed = updateFeed(process.env.JIAJIAN_UPDATE_URL);
const channel = require('semver').prerelease(require('./package.json').version) ? 'preview' : 'latest';

const ffmpegDirectory = 'tools/ffmpeg-8.0-full_build';
const ffmpegFiles = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'];

module.exports = {
  appId: 'io.github.showrenzhe.jiajian',
  files: ['src/**/*', '!src/native/**/*', 'package.json'],
  extraResources: [
    { from: 'vendor', to: 'vendor' },
    { from: 'tools/project-thumbnail/ProjectThumbnail.dll', to: 'ProjectThumbnail.dll' },
    { from: ffmpegDirectory, to: ffmpegDirectory, filter: ffmpegFiles },
  ],
  beforePack: async ({ packager }) => {
    execFileSync('cmd.exe', ['/d', '/c', 'scripts\\build-thumbnail.cmd'], {cwd: packager.projectDir, stdio: 'inherit'});
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
    include: 'scripts/windows-installer.nsh',
    uninstallDisplayName: '${productName}',
    artifactName: 'Jiajian-Setup-${version}-${arch}.${ext}',
  },
  extraMetadata: { jiajianUpdateFeed: feed },
  publish: feed ? { provider: 'generic', url: feed, channel } : null,
};

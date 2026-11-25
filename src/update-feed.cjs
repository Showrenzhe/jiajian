'use strict';

const githubRepository = Object.freeze({ provider: 'github', owner: 'Showrenzhe', repo: 'jiajian' });

function releaseConfig(version) {
  const prerelease = require('semver').prerelease(version);
  if (prerelease && prerelease[0] !== 'preview') {
    throw new Error('预览版标签应使用 vX.Y.Z-preview.N。');
  }
  return {
    ...githubRepository,
    channel: prerelease ? 'preview' : 'latest',
    releaseType: prerelease ? 'prerelease' : 'release',
  };
}

module.exports = { githubRepository, releaseConfig };

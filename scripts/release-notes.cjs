'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function releaseNotes(root, tag) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) {
    throw new Error(`正式版标签 ${tag} 与 package.json 版本 ${version} 不符`);
  }
  const curated = path.join(root, 'release-notes', `${tag}.md`);
  if (fs.existsSync(curated)) {
    const notes = fs.readFileSync(curated, 'utf8').trim();
    if (!notes) throw new Error(`${curated} 是空文件`);
    return notes + '\n';
  }

  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const previous = git('tag', '--merged', 'HEAD', '--sort=-version:refname').split('\n').find((entry) => {
    if (!stableTag.test(entry)) return false;
    const current = version.split('.').map(Number);
    const parts = entry.slice(1).split('.').map(Number);
    const firstDifference = parts.findIndex((n, index) => n !== current[index]);
    return firstDifference !== -1 && parts[firstDifference] < current[firstDifference];
  });
  const history = git('log', '--no-merges', '--reverse', '--format=%s', previous ? `${previous}..HEAD` : 'HEAD');
  if (!history) throw new Error('两个版本之间没有可汇总的提交，请填写该版更新说明。');
  return ['## 本次更新', '', ...history.split('\n').map((subject) => `- ${subject}`)].join('\n') + '\n';
}

if (require.main === module) {
  const [tag, output] = process.argv.slice(2);
  const notes = releaseNotes(process.cwd(), tag);
  if (output) fs.writeFileSync(output, notes, 'utf8');
  else process.stdout.write(notes);
}

module.exports = { releaseNotes };

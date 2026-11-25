'use strict';

const assert = require('node:assert/strict');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const path = require('node:path');

// Read update metadata with the same YAML parser the pinned updater uses.
const yaml = createRequire(require.resolve('electron-updater/package.json'))('js-yaml');
const { updateFeed } = require('../src/update-feed.cjs');

async function verifyManifest(dist, version, notes, manifestFile = path.join(dist, require('semver').prerelease(version) ? 'preview.yml' : 'latest.yml')) {
  const file = `Jiajian-Setup-${version}-x64.exe`;
  const manifest = yaml.load(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(manifest.version, version, '更新清单版本与标签不符');
  assert.equal(manifest.releaseNotes?.trim(), notes.trim(), '应用与发布页更新说明不一致');
  assert.equal(manifest.files?.length, 1);
  const [asset] = manifest.files;
  assert.equal(asset.url, file, '更新地址与安装包文件名不一致');
  const size = (await fs.stat(path.join(dist, file))).size;
  assert.ok(size > 0);
  assert.equal(asset.size, size, '安装包大小与清单不符');
  const hasher = createHash('sha512');
  for await (const chunk of createReadStream(path.join(dist, file))) hasher.update(chunk);
  assert.equal(asset.sha512, hasher.digest('base64'), '安装包 SHA-512 与清单不符');
  const blockmap = JSON.parse(gunzipSync(await fs.readFile(path.join(dist, file + '.blockmap'))));
  assert.equal(blockmap.version, '2');
  assert.equal(blockmap.files.length, 1);
  const blocks = blockmap.files[0];
  assert.equal(blocks.offset, 0);
  assert.equal(blocks.checksums.length, blocks.sizes.length, '差分映射缺少分块校验值');
  assert.equal(blocks.sizes.reduce((total, length) => total + length, 0), size, '差分映射范围与安装包不符');
}

async function verifyUpdateMode(resources, version, feed) {
  const asar = require('@electron/asar');
  const metadata = JSON.parse(asar.extractFile(path.join(resources,'app.asar'),'package.json'));
  assert.equal(metadata.version, version, '安装包内应用版本不一致');
  assert.equal(metadata.jiajianUpdateFeed ?? null, feed, '安装包内更新源与构建配置不一致');
  const file = path.join(resources,'app-update.yml');
  if (!feed) {
    await assert.rejects(fs.access(file), {code:'ENOENT'}, '离线安装包不可内置在线更新配置');
    return;
  }
  const config = yaml.load(await fs.readFile(file,'utf8'));
  assert.equal(config.provider, 'generic');
  assert.equal(config.url, feed);
  assert.equal(config.channel ?? 'latest', require('semver').prerelease(version) ? 'preview' : 'latest');
}

async function verifyPackagedResources(dist, version = require('../package.json').version, feed = updateFeed(process.env.JIAJIAN_UPDATE_URL)) {
  const resources = path.join(dist, 'win-unpacked', 'resources');
  assert.ok((await fs.stat(path.join(resources,'ProjectThumbnail.dll'))).size > 0, '缺少 Windows 工程缩略图处理器');
  await verifyUpdateMode(resources, version, feed);
  const installer = await fs.open(path.join(dist,`Jiajian-Setup-${version}-x64.exe`), 'r');
  try {
    const signature = Buffer.alloc(2);
    await installer.read(signature,0,2,0);
    assert.equal(signature.toString(),'MZ','安装包不是 Windows 可执行文件');
  } finally { await installer.close(); }
  const bin = path.join(resources, 'tools', 'ffmpeg-8.0-full_build', 'bin');
  const ffmpeg = path.join(bin, 'ffmpeg.exe');
  const run = (executable, args) => execFileSync(executable, args, {
    encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  });
  assert.match(run(ffmpeg, ['-version']), /ffmpeg version 8\.0/);
  assert.match(run(ffmpeg, ['-hide_banner', '-filters']), /\bwhisper\b/);
  assert.match(run(path.join(bin, 'ffprobe.exe'), ['-version']), /ffprobe version 8\.0/);
  const vendor = path.join(resources, 'vendor');
  assert.match(run(path.join(vendor, 'scenedetect', 'scenedetect.exe'), ['version']), /PySceneDetect 0\.7/);
  for (const file of ['foreground/foreground.exe', 'foreground/u2netp.onnx', 'foreground/onnxruntime.dll',
    'vocals/vocals.exe', 'vocals/vocals.onnx', 'whisper/ggml-base-q5_1.bin']) {
    assert.ok((await fs.stat(path.join(vendor, file))).size > 0, `缺少离线资源 ${file}`);
  }
}

if (require.main === module) {
  (async () => {
    const version = require('../package.json').version;
    const dist = path.resolve(process.env.JIAJIAN_DIST_DIR || 'dist');
    const feed = updateFeed(process.env.JIAJIAN_UPDATE_URL);
    if (feed) await verifyManifest(dist, version, await fs.readFile(process.argv[2], 'utf8'));
    await verifyPackagedResources(dist,version,feed);
    console.log(`v${version} ${feed ? '内部更新清单与安装包' : '离线安装包'}、打包资源和本地工具已通过检查。`);
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { verifyManifest, verifyPackagedResources, verifyUpdateMode };

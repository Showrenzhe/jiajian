'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { mediaTool } = require('../src/media-tool.cjs');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function ffmpeg(args) {
  const { stdout } = await execFileAsync(mediaTool('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...args,
  ], { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 20000 });
  return stdout;
}

async function fixtures(directory) {
  const red = path.join(directory, '红色原声.mp4');
  const blue = path.join(directory, '蓝色竖屏无声.mp4');
  const green = path.join(directory, '绿色无声.mp4');
  const music = path.join(directory, '短配乐.wav');
  const otherMusic = path.join(directory, '另一首配乐.wav');
  const still = path.join(directory, '紫色静帧.png');
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=320x240:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1.5', '-c:v', 'libx264', '-c:a', 'aac', '-threads', '2', red]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=240x320:r=30', '-t', '1.5', '-c:v', 'libx264', '-threads', '2', blue]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=green:s=320x240:r=30', '-t', '1.5', '-c:v', 'libx264', '-threads', '2', green]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '0.4', music]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880', '-t', '0.4', otherMusic]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=magenta:s=160x90', '-frames:v', '1', '-threads', '1', '-update', '1', still]),
  ]);
  return { red, blue, green, music, otherMusic, still };
}

async function reversePhoneMovie(directory) {
  const file = path.join(directory, '手机竖屏三色原声.mov');
  const colors = "color=red:s=1080x1920:r=109800/1831,drawbox=c=lime:t=fill:enable='between(t,1,2)',"
    + "drawbox=c=blue:t=fill:enable='gte(t,2)'";
  // Like an iPhone MOV, lay the audio packets ahead of video packets in the container.
  // The portrait frame size also forces reverse to seek and render several chunks.
  await ffmpeg(['-f','lavfi','-i',colors,'-f','lavfi','-i',
    'aevalsrc=0.2*sin(2*PI*(440*t+220*max(0\\,t-1)+220*max(0\\,t-2))):s=44100',
    '-t','3.051667','-c:v','libx264','-threads','2','-preset','ultrafast','-c:a','aac',
    '-video_track_timescale','109800','-audio_preload','1000000',file]);
  return file;
}

// 四角的颜色不同，可区分顺时针、逆时针和镜像。
const corners = 'color=red:s=256x144:r=30:d=1,drawbox=x=128:y=0:w=128:h=72:c=lime:t=fill,'
  + 'drawbox=x=0:y=72:w=128:h=72:c=blue:t=fill,drawbox=x=128:y=72:w=128:h=72:c=yellow:t=fill';

async function normalizationFixture(directory, kind) {
  const file = path.join(directory, kind + (kind === 'exif' ? '.jpg' : '.mp4'));
  const lavfi = (source) => ['-f', 'lavfi', '-i', source];
  const h264 = ['-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast'];
  if (kind === 'vfr') {
    // 音频流迟到 0.25 秒，源时间 0.5 秒同时变蓝并起音；视频丢帧后保留原 PTS。
    await ffmpeg([...lavfi("color=red:s=256x144:r=30:d=1,drawbox=c=blue:t=fill:enable='gte(t,0.5)'"),
      '-itsoffset', '0.25', ...lavfi('aevalsrc=0.25*sin(2*PI*660*t)*gte(t\\,0.25):s=44100:d=0.75'),
      '-vf', "select='not(eq(mod(n,3),1))'", '-fps_mode', 'vfr', ...h264, '-c:a', 'aac', file]);
  } else if (kind === 'rotate90' || kind === 'rotate270') {
    const base = path.join(directory, kind + '-coded.mp4');
    await ffmpeg([...lavfi(corners), ...h264, base]);
    await ffmpeg(['-display_rotation', kind === 'rotate90' ? '90' : '270', '-i', base, '-c', 'copy', file]);
  } else if (kind === 'pq' || kind === 'hlg') {
    // 两个灰块采用已知的 10 位有限范围亮度值。
    const transfer = kind === 'pq' ? 'smpte2084' : 'arib-std-b67';
    const patches = "nullsrc=s=256x144:r=30:d=1,format=yuv420p10le,geq=lum='if(lt(X,W/2),256,560)':cb=512:cr=512";
    await ffmpeg([...lavfi(patches + `,setparams=range=tv:color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`),
      ...h264, '-pix_fmt', 'yuv420p10le', '-color_range', 'tv', '-colorspace', 'bt2020nc',
      '-color_primaries', 'bt2020', '-color_trc', transfer, file]);
  } else if (kind === 'silent') {
    await ffmpeg([...lavfi(corners), ...h264, '-an', file]);
  } else if (kind === 'exif') {
    await ffmpeg([...lavfi(corners), '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-update', '1', file]);
    // 在 JPEG 的 APP1 段写入一个 TIFF SHORT 字段，Orientation=6 表示顺时针显示 90°。
    const orientation = Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000', 'hex');
    const jpeg = await fs.readFile(file);
    await fs.writeFile(file, Buffer.concat([jpeg.subarray(0, 2), orientation, jpeg.subarray(2)]));
  } else {
    throw new Error('未知的规范化夹具 ' + kind);
  }
  return file;
}

module.exports = { ffmpeg, fixtures, reversePhoneMovie, normalizationFixture };

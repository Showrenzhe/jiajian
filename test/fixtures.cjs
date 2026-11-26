'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function ffmpeg(args) {
  const { stdout } = await execFileAsync(process.env.JIAJIAN_FFMPEG || process.env.SUPERDIR_REPLICA_FFMPEG || 'ffmpeg', [
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

module.exports = { ffmpeg, fixtures, reversePhoneMovie };

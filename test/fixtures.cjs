'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function ffmpeg(args) {
  const { stdout } = await execFileAsync(process.env.SUPERDIR_REPLICA_FFMPEG || 'ffmpeg', [
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

module.exports = { ffmpeg, fixtures };

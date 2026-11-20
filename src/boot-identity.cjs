'use strict';

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execute = promisify(execFile);

async function windowsBootEvent() {
  // Kernel-Boot 27 records full (0) and hybrid (1) starts. Read the immutable
  // record identity, excluding hibernation resumes (2) and localized messages.
  const query = "*[System[Provider[@Name='Microsoft-Windows-Kernel-Boot'] and EventID=27]"
    + " and EventData[Data[@Name='BootType']='0' or Data[@Name='BootType']='1']]";
  const executable = path.join(process.env.SystemRoot, 'System32', 'wevtutil.exe');
  const { stdout } = await execute(executable, ['qe', 'System', '/q:' + query, '/rd:true', '/c:1', '/f:xml', '/uni:true'],
    { encoding: 'utf16le', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 });
  const id = /<EventRecordID>(\d+)<\/EventRecordID>/.exec(stdout)?.[1];
  const created = /<TimeCreated\s+SystemTime=['"]([\dT:.Z-]+)['"]/.exec(stdout)?.[1];
  if (id && created && Number.isFinite(Date.parse(created))) return id + '@' + created;
}

async function readBootIdentity({ platform = process.platform, readEvent = windowsBootEvent,
  estimate = () => Date.now() - os.uptime() * 1000 } = {}) {
  const time = estimate();
  if (platform === 'win32') {
    try {
      const event = await readEvent();
      if (event) return { event, time };
    } catch { /* System logs can be unavailable to the current user. */ }
  }
  return time;
}

function sameBoot(previous, current) {
  if (previous?.event && current?.event) return previous.event === current.event;
  const oldTime = previous?.time ?? previous, newTime = current?.time ?? current;
  return Number.isFinite(oldTime) && Number.isFinite(newTime) && Math.abs(oldTime - newTime) < 5000;
}

module.exports = { readBootIdentity, sameBoot };

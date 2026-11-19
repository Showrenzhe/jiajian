'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

const seedEndpoint = new URL('https://openspeech.bytedance.com/api/v3/tts/create');

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fixtureServer(wave, captions, fixtureKey, seed) {
  const submissions = [];
  const seedSubmissions = [];
  const requests = [];
  const errors = [];
  const jobs = new Map();
  const server = http.createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const json = (data) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const audio = async () => {
      const data = await wave;
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length }).end(data);
    };
    try {
      if (request.method === 'POST' && request.url === seedEndpoint.pathname) {
        assert.equal(request.headers['x-api-key'], seed.key);
        assert.equal(request.headers.authorization, undefined);
        assert.match(request.headers['content-type'], /^application\/json\b/);
        assert.match(request.headers['x-api-request-id'], /^[0-9a-f-]{36}$/);
        const payload = await readJson(request);
        seedSubmissions.push(payload);
        const cue = seed.cuesByPrompt.get(payload.text_prompt) ?? seed.cue;
        return json({ audio: (await seed.mp3).toString('base64'), duration: 1.8, original_duration: 1.8,
          subtitle: { text: cue.text, sentences: [{ start_time: cue.start, end_time: cue.end, text: cue.text }] } });
      }
      assert.ok(request.headers.authorization === `Bearer ${fixtureKey}`, '模拟服务应只收到界面输入的测试密钥');
      if (request.method === 'GET' && request.url === '/v1/voices') {
        return json({ voices: [{ id: 'fixture-ok', name: '样片音色', hasSample: true }, { id: 'fixture-fail', name: '失败音色' }] });
      }
      if (request.method === 'GET' && request.url === '/v1/voices/fixture-ok/sample') return await audio();
      if (request.method === 'POST' && request.url === '/v1/speech/jobs') {
        const payload = await readJson(request);
        submissions.push(payload);
        const id = `job-${submissions.length}`;
        jobs.set(id, { payload, polls: 0 });
        return json({ id, status: 'queued', progress: 0 });
      }
      const poll = /^\/v1\/speech\/jobs\/(job-\d+)$/.exec(request.url);
      if (request.method === 'GET' && poll && jobs.has(poll[1])) {
        const job = jobs.get(poll[1]);
        if (job.payload.voiceId === 'fixture-fail') return json({ status: 'failed' });
        job.polls += 1;
        return json(job.polls === 1 ? { status: 'running', progress: 0.5 } : { status: 'succeeded', captions });
      }
      const download = /^\/v1\/speech\/jobs\/(job-\d+)\/audio$/.exec(request.url);
      if (request.method === 'GET' && download && jobs.get(download[1])?.payload.voiceId === 'fixture-ok') return await audio();
      throw new Error(`意外的模拟服务请求 ${request.method} ${request.url}`);
    } catch (error) {
      errors.push(error);
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end();
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  return { server, listening, submissions, seedSubmissions, requests, errors };
}

async function run() {
  const parent = path.resolve(__dirname, '../test-data');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'cloud-desktop-'));
  const profile = path.join(root, 'profile');
  const video = path.join(root, '原画面.mp4');
  const voice = path.join(root, '语音样本.wav');
  const seedVoice = path.join(root, 'Seed音频样本.mp3');
  const project = path.join(root, '云端口播.sdworkbench');
  const seedProject = path.join(root, 'Seed配音.sdworkbench');
  const segmentedProject = path.join(root, 'Seed分段配音.sdworkbench');
  const exportDir = path.join(root, 'export');
  const seedExportDir = path.join(root, 'seed-export');
  const segmentedExportDir = path.join(root, 'segmented-export');
  const subtitle = 'Cloud caption';
  const captions = [{ start: 300, end: 1050, text: subtitle }];
  const text = '请朗读这条测试台词。';
  const fixtureKey = 'fixture-cloud-settings-only';
  const seedKey = 'fixture-seed-audio-settings-only';
  const vivi = 'zh_female_vv_uranus_bigtts';
  const yunzhou = 'zh_male_m191_uranus_bigtts';
  const seedCue = { start: 450, end: 1300, text: '列车即将到站。' };
  const seedPrompt = `开头加入轻柔背景音乐与雨声，再由旁白朗读：${seedCue.text}`;
  const segmentCues = [{ start: 150, end: 700, text: '第一分镜开始。' }, { start: 250, end: 900, text: '第二分镜继续。' }];
  const wave = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '1.8', '-c:a', 'pcm_s16le', voice]).then(() => fs.readFile(voice));
  const mp3 = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000', '-t', '1.8', '-c:a', 'libmp3lame', seedVoice]).then(() => fs.readFile(seedVoice));
  const fixture = fixtureServer(wave, captions, fixtureKey, {
    key: seedKey, mp3, cue: seedCue, cuesByPrompt: new Map(segmentCues.map((cue) => [cue.text, cue])),
  });
  const open = [
    { title: '选择分镜素材', file: video },
    { title: '打开工程', file: project },
    { title: '选择导出目录', file: exportDir },
  ];
  const save = [{ title: '保存工程', file: project }];
  const requestHttps = https.request;
  https.request = (url, options, onResponse) => {
    if (String(url) !== seedEndpoint.href) {
      assert.notEqual(options?.headers?.['X-Api-Key'], seedKey, '测试密钥不能发送到外部地址');
      return requestHttps(url, options, onResponse);
    }
    const local = `http://127.0.0.1:${fixture.server.address().port}${seedEndpoint.pathname}`;
    return http.request(local, options, onResponse);
  };
  let win;
  try {
    // Register the Electron scheme before app ready while the loopback port is being assigned.
    const desktop = launchDesktop({
      show: false, dataDirectory: profile,
      dialogs: {
        async showOpenDialog(_window, options) {
          const next = open.shift();
          assert.equal(options.title, next?.title);
          return { canceled: false, filePaths: [next.file] };
        },
        async showSaveDialog(_window, options) {
          const next = save.shift();
          assert.equal(options.title, next?.title);
          return { canceled: false, filePath: next.file };
        },
      },
    });
    const makeVideo = ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=320x180:r=30', '-t', '1.1', '-c:v', 'libx264', '-threads', '2', video]);
    [win] = await Promise.all([desktop, fixture.listening, wave, mp3, makeVideo, fs.mkdir(exportDir)]);
    const baseUrl = `http://127.0.0.1:${fixture.server.address().port}/`;
    const js = (expression) => win.webContents.executeJavaScript(expression, true);
    const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const voiceChoice = (id) => `.cloud-tts-voice[value="${id}"]`;
    const checkedVoices = () => js('[...document.querySelectorAll(".cloud-tts-voice:checked")].map((input) => input.value)');
    const setFields = (fields) => js(`for (const [selector, value, event = 'input'] of ${JSON.stringify(fields)}) {
      const field = document.querySelector(selector);
      field.value = value;
      field.dispatchEvent(new Event(event, { bubbles: true }));
    }`);
    async function waitFor(expression, message) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (await js(expression)) return;
        await delay(50);
      }
      const state = await js(`(() => {
        const get = (id) => document.getElementById(id)?.textContent;
        const audio = document.querySelector('#cloud-tts-audio');
        return { notice: get('notice'), service: get('cloud-tts-service'), status: get('cloud-tts-status'),
          settings: get('cloud-settings-status'),
          output: get('output-status'), ready: audio?.readyState, audioError: audio?.error?.message };
      })()`);
      throw new Error(`${message}: ${JSON.stringify(state)}`);
    }
    async function play(selector) {
      await waitFor(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('src')`, '播放器应接收真实音频 URL');
      await js(`(() => { const audio = document.querySelector(${JSON.stringify(selector)}); audio.muted = true; return audio.play(); })()`);
      await waitFor(`(() => { const audio = document.querySelector(${JSON.stringify(selector)}); return audio.readyState >= 2 && audio.currentTime > 0.08; })()`, '音频应解码并实际播放');
    }
    async function checkSettings(expectedBase, expectedKey) {
      await waitFor('document.querySelector("#cloud-settings-dialog")?.open && !document.querySelector("#cloud-settings-base-url").disabled', '应打开并加载本机设置');
      assert.equal(await js('document.querySelector("#cloud-settings-base-url").value'), expectedBase);
      assert.ok(await js('document.querySelector("#cloud-settings-api-key").value === "" && document.querySelector("#cloud-settings-api-key").type === "password"'), '设置不应回显 API 密钥');
      assert.equal(await js('document.querySelector("#cloud-settings-key-state").textContent'), expectedKey ? '已保存密钥。' : '未保存密钥。');
      const settings = await js('window.workbench.cloudTtsSettings()');
      assert.equal(settings.baseUrl, expectedBase);
      assert.equal(settings.hasApiKey, expectedKey);
      assert.ok(!Object.hasOwn(settings, 'apiKey') && !Object.hasOwn(settings, 'keyCiphertext'), '公开设置不能包含密钥或密文');
    }
    async function captureScreen(file) {
      await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const paint = once(win.webContents, 'paint', { signal: AbortSignal.timeout(3000) });
      win.webContents.invalidate();
      const [, , screenshot] = await paint.catch(() => []);
      if (screenshot && !screenshot.isEmpty()) await fs.writeFile(path.join(root, file), screenshot.toPNG());
    }

    await click('#app-settings');
    await checkSettings(seedEndpoint.href, false);
    await click('#cloud-settings-cancel');
    await click('#home-import');
    await waitFor('document.querySelectorAll("#shots .asset").length === 1 && document.querySelector("#inspector-panel-visual").getClientRects().length > 0', '应导入测试画面并默认显示画面属性');
    assert.equal(await js('document.querySelector("#cloud-narration").getClientRects().length'), 0, '口播配音应归在口播标签页');
    await click('#inspector-tab-narration');
    await waitFor('document.querySelector("#inspector-panel-visual").hidden && document.querySelector("#cloud-narration").getClientRects().length > 0 && !document.querySelector("#cloud-narration").disabled', '口播标签应显示云端配音入口');
    assert.equal(await js('document.querySelector("#cloud-narration").textContent.trim()'), '生成全部口播');
    assert.equal(await js('document.querySelector("#whole-track-settings").open'), false);
    await click('#cloud-narration');
    await waitFor('document.querySelector("#cloud-tts-dialog").open && document.querySelector("#cloud-tts-service").textContent.includes("填写") && !document.querySelector("#cloud-tts-open-settings").hidden', '未配置时应显示配音窗口内的设置入口');
    assert.deepEqual(fixture.requests, [], '未配置时不应请求模拟服务');
    await click('#cloud-tts-open-settings');
    await checkSettings(seedEndpoint.href, false);
    await setFields([['#cloud-settings-provider', 'gateway', 'change'], ['#cloud-settings-base-url', baseUrl], ['#cloud-settings-api-key', fixtureKey]]);
    await click('#cloud-settings-save');
    await waitFor('!document.querySelector("#cloud-settings-dialog").open && document.querySelector("#cloud-tts-dialog").open && document.querySelectorAll(".cloud-tts-voice").length === 2', '保存后应在原配音窗口立即刷新音色');
    const settingsFile = await fs.readFile(path.join(profile, 'cloud-tts-settings.json'), 'utf8');
    assert.ok(!settingsFile.includes(fixtureKey), '本机设置不能保存明文测试密钥');
    const settingsEnvelope = JSON.parse(settingsFile);
    assert.equal(settingsEnvelope.baseUrl, baseUrl);
    assert.ok(typeof settingsEnvelope.keyCiphertext === 'string' && settingsEnvelope.keyCiphertext.length > 0, '本机设置应包含加密密钥');
    await click('#cloud-tts-open-settings');
    await checkSettings(baseUrl, true);
    await click('#cloud-settings-cancel');
    assert.deepEqual(fixture.submissions, []);
    await click('.cloud-tts-sample');
    await play('#cloud-tts-sample-audio');
    await setFields([['#cloud-tts-text', text], ['#cloud-tts-speed', '1.2'], ['#cloud-tts-volume', '85']]);
    assert.equal(await js('document.querySelector("#cloud-tts-voice-mode").value'), 'fixed');
    await click(voiceChoice('fixture-ok'));
    assert.deepEqual(await checkedVoices(), ['fixture-ok']);
    assert.deepEqual(fixture.submissions, [], '试听与编辑参数时不能发送台词');
    assert.equal(await js('document.querySelector("#narration-name").textContent'), '未添加');
    await click('#cloud-tts-generate');
    await waitFor('!document.querySelector("#cloud-tts-use").disabled', '应使用固定音色完成一次配音');
    assert.deepEqual(fixture.submissions, [{ text, voiceId: 'fixture-ok', speed: 1.2, volume: 85, format: 'wav' }]);
    await play('#cloud-tts-audio');
    assert.equal(await js('document.querySelector("#narration-name").textContent'), '未添加', '试听不会自动应用到轨道');
    await click('#cloud-tts-use');
    await waitFor('!document.querySelector("#cloud-tts-dialog").open && document.querySelector("#narration-name").textContent.includes("配音-")', '只有明确使用才将成功配音应用到轨道');
    await js('(() => { const priority = document.querySelector("#priority"); priority.value = "voice"; priority.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await click('#save-project');
    await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存带云端配音的工程');
    const saved = JSON.parse(await fs.readFile(project, 'utf8'));
    assert.deepEqual(saved.config.generatedCaptions[saved.config.narrationId].cues, captions, '应保存服务返回的精确字幕时间码');
    assert.equal(saved.config.extraWholeTracks.length, 0, '固定音色不能产生额外口播轨');
    const storedVoice = saved.assets.find(({ id }) => id === saved.config.narrationId);
    assert.deepEqual(await fs.readFile(storedVoice.path), await wave);

    await click('#whole-track-summary');
    await click('#remove-narration');
    assert.equal(await js('document.querySelector("#narration-name").textContent'), '未添加');
    await click('#open-project');
    await waitFor('document.querySelector("#notice").textContent.includes("已打开工程") && document.querySelector("#narration-name").textContent.includes("配音-")', '应从磁盘恢复音频和字幕');
    await click('#start-export');
    await waitFor('document.querySelector("#output-status").textContent.includes("已保存 1 条") && document.querySelector("#cancel-export").hidden', '应输出带云端配音的真实 MP4');
    const [mp4] = (await fs.readdir(exportDir)).filter((file) => file.endsWith('.mp4'));
    const output = path.join(exportDir, mp4);
    const info = await inspectAsset(output, 'video');
    assert.notEqual(info.audioIndex, null);
    assert.ok(Math.abs(info.duration - 1.8) < 0.07, `口播优先应沿用配音长度，实际 ${info.duration}`);
    const pcm = await ffmpeg(['-i', output, '-vn', '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1']);
    let peak = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
    assert.ok(pcm.length > 24000 && peak > 800, '成片音轨应包含实际口播声音');
    async function whitePixels(file, at) {
      const bytes = await ffmpeg(['-ss', String(at), '-i', file, '-an', '-vf', 'scale=320:180', '-frames:v', '1',
        '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
      assert.equal(bytes.length, 320 * 180 * 3);
      let white = 0;
      for (let offset = 0; offset < bytes.length; offset += 3) {
        if (bytes[offset] > 165 && bytes[offset + 1] > 165 && bytes[offset + 2] > 165) white += 1;
      }
      return white;
    }
    const [before, during] = await Promise.all([whitePixels(output, 0.12), whitePixels(output, 0.6)]);
    assert.ok(during > before + 15, `字幕应在时间段内烧录，前 ${before}，中 ${during}`);
    assert.deepEqual(open, []);
    assert.deepEqual(save, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.filter((request) => request.endsWith('/sample')).length, 1);
    assert.equal(fixture.requests.filter((request) => request.endsWith('/audio')).length, 1);
    assert.equal(fixture.submissions.length, 1, '工程恢复与导出不应重新提交台词');
    const reloaded = once(win.webContents, 'did-finish-load');
    win.webContents.reload();
    await reloaded;
    await click('#app-settings');
    await checkSettings(baseUrl, true);
    await captureScreen('cloud-settings.png');
    await click('#cloud-settings-cancel');

    await click('#app-settings');
    await checkSettings(baseUrl, true);
    await setFields([['#cloud-settings-provider', 'seed-audio', 'change'], ['#cloud-settings-api-key', seedKey]]);
    assert.equal(await js('document.querySelector("#cloud-settings-base-url").value'), seedEndpoint.href);
    assert.equal(await js('document.querySelector("#cloud-settings-base-url").readOnly'), true);
    await click('#cloud-settings-save');
    await waitFor('!document.querySelector("#cloud-settings-dialog").open', '应保存 Seed Audio 设置');
    const seedSettings = await js('window.workbench.cloudTtsSettings()');
    assert.equal(seedSettings.provider, 'seed-audio');
    assert.equal(seedSettings.hasApiKey, true);
    assert.ok(!(await fs.readFile(path.join(profile, 'cloud-tts-settings.json'), 'utf8')).includes(seedKey));
    await click('#app-settings');
    await checkSettings(seedEndpoint.href, true);
    await captureScreen('seed-settings.png');
    await click('#cloud-settings-cancel');
    open.push({ title: '打开工程', file: project });
    await click('#home-open-project');
    await waitFor('document.querySelector("#notice").textContent.includes("已打开工程")', '应重新打开混剪工程以生成 Seed Audio');
    await click('#inspector-tab-narration');
    await click('#whole-track-summary');
    await click('#remove-narration');
    await click('#cloud-narration');
    await waitFor(`document.querySelector('#cloud-tts-dialog').open && document.querySelector('#cloud-tts-pitch').getClientRects().length > 0 && Boolean(document.querySelector(${JSON.stringify(voiceChoice(vivi))}))`, 'Seed Audio 应显示提示词、音调和官方音色');
    assert.equal(await js('document.querySelector("#cloud-tts-voice-mode").value'), 'fixed');
    assert.equal(await js('document.querySelector("#cloud-tts-voice-1").value'), 'seed-audio');
    await click(voiceChoice('seed-audio'));
    await click(voiceChoice(vivi));
    assert.deepEqual(await checkedVoices(), [vivi]);
    assert.equal(await js('document.querySelector("#cloud-tts-captions").checked'), true);
    await setFields([['#cloud-tts-text', seedPrompt], ['#cloud-tts-speed', '1.2'], ['#cloud-tts-volume', '110'], ['#cloud-tts-pitch', '-2']]);
    assert.deepEqual(fixture.seedSubmissions, [], '编辑提示词不能触发 Seed Audio 请求');
    await click('#cloud-tts-generate');
    await waitFor('!document.querySelector("#cloud-tts-use").disabled', '应从 Seed Audio 生成可应用的音频');
    assert.deepEqual(fixture.seedSubmissions, [{
      model: 'seed-audio-1.0', text_prompt: seedPrompt,
      references: [{ speaker: vivi }],
      audio_config: { format: 'mp3', sample_rate: 48000, speech_rate: 20, loudness_rate: 10, pitch_rate: -2, enable_subtitle: true },
      watermark: {},
    }]);
    await play('#cloud-tts-audio');
    assert.equal(await js('document.querySelector("#narration-name").textContent'), '未添加', '试听 Seed Audio 不应自动应用');
    await click('#cloud-tts-use');
    await waitFor('!document.querySelector("#cloud-tts-dialog").open && document.querySelector("#narration-name").textContent.includes("配音-")', '应将生成的 MP3 应用到口播轨');
    save.push({ title: '保存工程', file: seedProject });
    await click('#save-project');
    await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存包含 Seed Audio 的工程');
    const seeded = JSON.parse(await fs.readFile(seedProject, 'utf8'));
    const seedId = seeded.config.narrationId;
    const seedAsset = seeded.assets.find(({ id }) => id === seedId);
    assert.equal(path.extname(seedAsset.path), '.mp3');
    assert.deepEqual(await fs.readFile(seedAsset.path), await mp3);
    assert.deepEqual(seeded.config.generatedCaptions[seedId].cues, [seedCue], '字幕应只包含接口返回的对白和时间码');
    await fs.mkdir(seedExportDir);
    open.push({ title: '选择导出目录', file: seedExportDir });
    await click('#start-export');
    await waitFor('document.querySelector("#output-status").textContent.includes("已保存 1 条") && document.querySelector("#cancel-export").hidden', '应导出带 Seed Audio 和字幕的真实 MP4');
    const [seedMp4] = (await fs.readdir(seedExportDir)).filter((file) => file.endsWith('.mp4'));
    const seedOutput = path.join(seedExportDir, seedMp4);
    assert.notEqual((await inspectAsset(seedOutput, 'video')).audioIndex, null);
    const [seedBefore, seedDuring] = await Promise.all([whitePixels(seedOutput, 0.12), whitePixels(seedOutput, 0.6)]);
    assert.ok(seedDuring > seedBefore + 15, `Seed 字幕应只在对白时间内烧录，前 ${seedBefore}，中 ${seedDuring}`);

    open.push({ title: '选择分镜素材', file: video });
    await click('#import-materials');
    await waitFor('document.querySelectorAll("#shots .asset").length === 2', '应为分段批次准备两个分镜');
    await click('#tab-script');
    await waitFor('document.querySelectorAll(".script-dialogue").length > 0', '应打开脚本创作工作区');
    await click('#script-mode-segmented');
    await click('#script-import-dialogue');
    await setFields([['#script-import-input', segmentCues.map(({ text }) => text).join('\n')]]);
    await click('#script-import-confirm');
    await click('#script-cloud-read-all');
    await waitFor(`document.querySelector('#cloud-tts-dialog').open && !document.querySelector('#cloud-tts-generate').disabled && Boolean(document.querySelector(${JSON.stringify(voiceChoice(vivi))}))`, '应从脚本载入两条分段台词和上次音色设置');
    assert.equal(await js('document.querySelector("#cloud-tts-voice-mode").value'), 'fixed');
    assert.deepEqual(await checkedVoices(), [vivi]);
    assert.deepEqual(await js('[...document.querySelectorAll(".cloud-tts-text")].map((input) => input.value)'), segmentCues.map(({ text }) => text));
    assert.deepEqual(await js('["speed", "volume", "pitch"].map((field) => document.getElementById(`cloud-tts-${field}`).value)'), ['1.2', '110', '-2']);
    await setFields([['#cloud-tts-voice-mode', 'random', 'change'], ['#cloud-tts-speed', '0.9'], ['#cloud-tts-volume', '95'], ['#cloud-tts-pitch', '3']]);
    assert.equal(await js(`Boolean(document.querySelector(${JSON.stringify(voiceChoice('seed-audio'))}))`), false);
    const pool = [vivi, yunzhou];
    await js(`for (const input of document.querySelectorAll('.cloud-tts-voice')) {
      if (input.checked !== ${JSON.stringify(pool)}.includes(input.value)) input.click();
    }`);
    assert.deepEqual(await checkedVoices(), pool);
    assert.equal(fixture.seedSubmissions.length, 1, '载入脚本和修改音色不能自动提交');
    const draws = await js(`(() => {
      const random = Math.random;
      let count = 0;
      Math.random = () => count++ % 2 === 0 ? 0.99 : 0;
      try { document.querySelector('#cloud-tts-generate').click(); }
      finally { Math.random = random; }
      return count;
    })()`);
    assert.equal(draws, 1, '整批台词只应抽取一次音色');
    await waitFor('!document.querySelector("#cloud-tts-use").disabled && document.querySelector("#cloud-tts-result-choice").options.length === 2', '应使用同一随机音色生成两个分段结果');
    assert.deepEqual(fixture.seedSubmissions.slice(1), segmentCues.map(({ text }) => ({
      model: 'seed-audio-1.0', text_prompt: text, references: [{ speaker: yunzhou }],
      audio_config: { format: 'mp3', sample_rate: 48000, speech_rate: -10, loudness_rate: -5, pitch_rate: 3, enable_subtitle: true },
      watermark: {},
    })));
    await captureScreen('seed-segmented-batch.png');
    await click('#cloud-tts-use');
    const segmentedLanes = `(() => {
      const visual = [...document.querySelectorAll('.timeline-lane.visual-lane .shot')];
      const narration = [...document.querySelectorAll('.timeline-lane.narration-lane .segment-narration-panel')];
      return visual.length === 2 && narration.length === 2 && visual.every((shot, index) => {
        const panel = narration[index];
        return !shot.contains(panel) && panel.getClientRects().length > 0
          && Math.abs(shot.getBoundingClientRect().left - panel.getBoundingClientRect().left) <= 2
          && panel.querySelectorAll('.segment-narration-name').length === 1
          && panel.querySelector('.segment-narration-name').textContent.includes('配音-');
      });
    })()`;
    await waitFor(`!document.querySelector('#cloud-tts-dialog').open && ${segmentedLanes}`, '两条云端音频应出现在各自分镜下方独立的口播轨');
    save.push({ title: '保存工程', file: segmentedProject });
    await click('#save-project');
    await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存含两段口播的工程');
    const segmented = JSON.parse(await fs.readFile(segmentedProject, 'utf8'));
    assert.equal(segmented.config.narrationMode, 'segmented');
    assert.deepEqual(segmented.config.shots.map((shot) => shot.length), [1, 1]);
    assert.deepEqual(segmented.config.segmentNarrationIds.map((track) => track.length), [1, 1]);
    const segmentIds = segmented.config.segmentNarrationIds.flat();
    assert.equal(new Set(segmentIds).size, 2);
    assert.deepEqual(segmentIds.map((id) => segmented.config.generatedCaptions[id].cues), segmentCues.map((cue) => [cue]));
    open.push({ title: '打开工程', file: segmentedProject });
    await click('#open-project');
    await waitFor(`document.querySelector('#notice').textContent.includes('已打开工程') && ${segmentedLanes}`, '重开工程应恢复两个独立口播片段');
    await fs.mkdir(segmentedExportDir);
    open.push({ title: '选择导出目录', file: segmentedExportDir });
    await click('#start-export');
    await waitFor('document.querySelector("#output-status").textContent.includes("已保存 1 条") && document.querySelector("#cancel-export").hidden', '恢复的两个口播片段应可实际导出');
    const [segmentMp4] = (await fs.readdir(segmentedExportDir)).filter((file) => file.endsWith('.mp4'));
    const segmentOutput = path.join(segmentedExportDir, segmentMp4);
    const segmentedInfo = await inspectAsset(segmentOutput, 'video');
    assert.notEqual(segmentedInfo.audioIndex, null);
    assert.ok(Math.abs(segmentedInfo.duration - 3.6) < 0.1, '成片应使用两条口播的长度');
    const [segmentBefore, segmentDuring] = await Promise.all([whitePixels(segmentOutput, 1.95), whitePixels(segmentOutput, 2.3)]);
    assert.ok(segmentDuring > segmentBefore + 15, '第二条口播的字幕应使用对应分镜的成片时间');
    await click('#inspector-tab-narration');
    await click('#cloud-narration');
    await waitFor('document.querySelector("#cloud-tts-dialog").open && !document.querySelector("#cloud-tts-generate").disabled', '重新打开配音时应保留随机音色设置');
    assert.equal(await js('document.querySelector("#cloud-tts-voice-mode").value'), 'random');
    assert.deepEqual(await checkedVoices(), pool);
    await click('#cloud-tts-close');
    assert.deepEqual(open, []);
    assert.deepEqual(save, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.filter((request) => request === `POST ${seedEndpoint.pathname}`).length, 3);
    assert.equal(fixture.submissions.length, 1, '切换 Seed Audio 后不应将提示词交给网关');
    await fs.writeFile(path.join(root, 'passed.json'), JSON.stringify({ cloudJobs: fixture.submissions.length, duration: info.duration, before, during, mp4,
      seed: { requests: fixture.seedSubmissions.length, mp4: seedMp4, before: seedBefore, during: seedDuring, segments: segmentIds.length, segmentMp4 } }, null, 2));
    console.log(`云端配音桌面流程通过。合成样片在 ${root}`);
  } finally {
    https.request = requestHttps;
    await new Promise((resolve) => {
      fixture.server.close(resolve);
      fixture.server.closeAllConnections();
    });
    if (win && !win.isDestroyed()) win.close();
  }
}

run().catch((error) => { console.error(error); app.exit(1); });

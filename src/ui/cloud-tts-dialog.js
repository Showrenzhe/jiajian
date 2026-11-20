'use strict';

(() => {
  const preferenceKey = 'sd-workbench-speech-preferences-v1';
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(preferenceKey)) ?? {}; } catch {}

  const markup = `
    <dialog id="cloud-tts-dialog" class="cloud-tts-dialog" aria-labelledby="cloud-tts-title">
      <header class="cloud-tts-header">
        <div class="cloud-tts-heading-group"><h2 id="cloud-tts-title" tabindex="-1" autofocus>智能配音</h2><span id="cloud-tts-provider" class="cloud-tts-badge">云端服务</span></div>
        <button type="button" id="cloud-tts-open-settings" aria-label="打开云端配音设置" hidden><svg class="ui-icon" aria-hidden="true"><use href="#icon-settings"></use></svg>配音设置</button>
        <button type="button" id="cloud-tts-close" aria-label="关闭配音">×</button>
      </header>
      <div class="cloud-tts-body">
        <fieldset id="cloud-tts-options" class="cloud-tts-options">
          <legend>全局配音设置</legend>
          <p id="cloud-tts-service" class="cloud-tts-muted" role="status"></p>
          <label class="cloud-tts-voice-mode">音色策略
            <select id="cloud-tts-voice-mode"><option value="fixed">固定音色</option><option value="random">随机音色</option></select>
          </label>
          <p id="cloud-tts-voice-hint" class="cloud-tts-muted"></p>
          <div id="cloud-tts-catalog" hidden>
            <input id="cloud-tts-search" type="search" aria-label="搜索全部音色" placeholder="搜索名称、描述或音色 ID" maxlength="256">
            <div id="cloud-tts-filters" role="group" aria-label="音色筛选">
              <button type="button" data-filter="all">全部</button><button type="button" data-filter="zh">中文</button><button type="button" data-filter="female">女声</button><button type="button" data-filter="male">男声</button><button type="button" data-filter="favorites">收藏</button>
            </div>
          </div>
          <div id="cloud-tts-voices"></div>
          <button type="button" id="cloud-tts-more" hidden>加载更多音色</button>
          <audio id="cloud-tts-sample-audio" controls preload="none" aria-label="音色试听" hidden></audio>
          <div class="cloud-tts-parameters">
            <label>语速<input type="number" id="cloud-tts-speed" min="0.5" max="2" step="any" value="1" required></label>
            <label>音量（%）<input type="number" id="cloud-tts-volume" min="0" max="100" step="1" value="100" required></label>
            <label id="cloud-tts-pitch-field" hidden>音调（半音）<input type="number" id="cloud-tts-pitch" min="-12" max="12" step="1" value="0" required></label>
          </div>
        </fieldset>
        <fieldset id="cloud-tts-source" class="cloud-tts-source">
          <legend id="cloud-tts-source-title">待配音台词</legend>
          <p id="cloud-tts-source-hint" class="cloud-tts-muted"></p>
          <details id="cloud-tts-source-details">
            <summary id="cloud-tts-source-summary">查看或编辑台词</summary>
            <div id="cloud-tts-items"></div>
          </details>
        </fieldset>
        <section id="cloud-tts-results" class="cloud-tts-results" aria-labelledby="cloud-tts-results-title" hidden>
          <h3 id="cloud-tts-results-title">成品试听</h3>
          <label>已生成音频 <select id="cloud-tts-result-choice"></select></label>
          <audio id="cloud-tts-audio" controls preload="metadata" aria-label="成品试听"></audio>
        </section>
        <ul id="cloud-tts-failures" aria-label="生成失败条目" hidden></ul>
      </div>
      <footer class="cloud-tts-footer">
        <p id="cloud-tts-disclosure" class="cloud-tts-disclosure">点击生成后，本批台词会发送到已配置的云端语音服务。</p>
        <div id="cloud-tts-progress-row" hidden><span id="cloud-tts-progress-label" role="status"></span><progress id="cloud-tts-progress" aria-label="配音进度"></progress></div>
        <p id="cloud-tts-status" role="status" hidden></p>
        <div class="cloud-tts-actions">
          <label><input id="cloud-tts-captions" type="checkbox" checked>同时添加字幕</label>
          <label><input id="cloud-tts-trim-pauses" type="checkbox">生成时去气口</label>
          <span id="cloud-tts-job-count" class="cloud-tts-muted"></span>
          <button type="button" id="cloud-tts-cancel" hidden>取消生成</button>
          <button type="button" id="cloud-tts-generate" class="cloud-tts-primary">生成配音</button>
          <button type="button" id="cloud-tts-use" class="cloud-tts-primary" disabled>使用配音</button>
        </div>
      </footer>
    </dialog>`;

  function isLocalAudio(asset) {
    if (!asset || typeof asset.url !== 'string') return false;
    try {
      const url = new URL(asset.url);
      return url.protocol === 'sd-workbench:' && url.hostname === 'asset' && /^\/[A-Za-z0-9_-]+$/.test(url.pathname)
        && !url.username && !url.password && !url.port && !url.search && !url.hash;
    } catch { return false; }
  }

  const element = (tag, content) => {
    const value = document.createElement(tag);
    if (content !== undefined) value.textContent = content;
    return value;
  };
  const jobKey = ({ index, voiceId }) => JSON.stringify([index, voiceId]);
  const textLimit = (state) => state.seedAudio ? 3000 : state.breeze ? 1000 : 500;
  const textLength = (_state, text) => [...text.trim()].length;
  const preferenceProfile = (state) => state.seedAudio ? 'seed-audio' : state.breeze ? 'breezeblue' : 'gateway';
  const languageNames = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
  const voiceLanguage = (code) => /^[a-z]{2}$/i.test(code) ? languageNames.of(code) : '';
  const toneNames = { warm:'温暖', calm:'平静', bright:'明亮', gentle:'温柔', energetic:'活力', authoritative:'威严',
    sincere:'真诚', weary:'疲惫', precise:'精准', refined:'优雅', urgent:'急切', friendly:'亲切', articulate:'清晰',
    steady:'沉稳', playful:'俏皮', compassionate:'体贴', reflective:'沉思', measured:'从容', rhythmic:'律动', passionate:'热情' };
  const isPromptVoice = (state, { id }) => state.seedAudio && id === 'seed-audio';

  window.mountCloudTtsDialog = (container, {
    listVoices, sample, synthesize, onUse, cancel, openSettings, maxItems = 1000,
  } = {}) => {
    const template = element('template');
    template.innerHTML = markup;
    container.replaceChildren(template.content);
    const $ = (id) => container.querySelector(`#cloud-tts-${id}`);
    const dialog = $('dialog');
    const samplePlayer = $('sample-audio');
    const player = $('audio');
    const waveforms=new Map([player,samplePlayer].map((audio)=>[audio,window.attachPlayerWaveform(audio)]));
    const speed = $('speed');
    const volume = $('volume');
    const pitch = $('pitch');
    const voiceMode = $('voice-mode');
    let session;

    function say(message, kind = '') {
      $('status').textContent = message;
      $('status').hidden = !message;
      $('status').dataset.kind = kind;
    }

    function clearAudio(audio) {
      waveforms.get(audio)();
      audio.pause();
      if (audio.hasAttribute('src')) { audio.removeAttribute('src'); audio.load(); }
    }

    function voiceChoices(state) {
      if (state.voiceMode === 'random') return [...state.voicePool];
      return state.fixedVoice ? [state.fixedVoice] : [];
    }

    function savePreferences(state) {
      if (!state.configured) return;
      const profile = preferenceProfile(state);
      const saved = {
        ...preferences[profile], voiceMode: state.voiceMode, fixedVoice: state.fixedVoice,
        voicePool: [...state.voicePool], captions: $('captions').checked, trimPauses:$('trim-pauses').checked,
      };
      if (state.breeze) saved.names = Object.fromEntries([...new Set([...state.voicePool, state.fixedVoice])].filter(Boolean)
        .map((id) => [id, state.voices.get(id)?.name || id]));
      for (const input of [speed, volume, pitch]) {
        if (input.validity.valid) saved[input.id.replace('cloud-tts-', '')] = input.valueAsNumber;
      }
      preferences = { ...preferences, [profile]: saved };
      try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch {}
    }

    function restorePreferences(state) {
      const saved = preferences[preferenceProfile(state)];
      if (state.breeze && saved?.names) {
        for (const [id, name] of Object.entries(saved.names)) {
          if (!state.voices.has(id) && typeof name === 'string') state.voices.set(id, { id, name });
        }
      }
      const presets = [...state.voices.values()].filter((voice) => !isPromptVoice(state, voice)).map(({ id }) => id);
      state.voiceMode = saved?.voiceMode === 'random' ? 'random' : 'fixed';
      state.fixedVoice = state.voices.has(saved?.fixedVoice) ? saved.fixedVoice : presets[0] ?? state.voices.keys().next().value;
      state.voicePool = new Set(Array.isArray(saved?.voicePool)
        ? presets.filter((id) => saved.voicePool.includes(id)) : presets);
      voiceMode.value = state.voiceMode;
      $('captions').checked = saved?.captions !== false;
      $('trim-pauses').checked = saved?.trimPauses === true;
      for (const [input, key, fallback] of [[speed, 'speed', 1], [volume, 'volume', 100], [pitch, 'pitch', 0]]) {
        input.value = Number.isFinite(saved?.[key]) ? saved[key] : fallback;
        if (!input.validity.valid) input.value = fallback;
      }
    }

    function update() {
      if (!session) return;
      const state = session;
      const busy = Boolean(state.working || state.applying);
      const count = state.items.filter(({ text }) => text.trim()).length;
      const totalLength = state.segmented ? textLength(state, state.items.map(item => item.text.trim()).filter(Boolean).join('\n')) : 0;
      const valid = state.items.every(({ text }) => textLength(state, text) <= textLimit(state)) && totalLength <= textLimit(state);
      const voices = voiceChoices(state).length;
      $('options').disabled = busy || state.sampling || state.loadingVoices || !state.configured;
      $('source').disabled = busy;
      $('more').hidden = !state.breeze || !state.next;
      $('more').disabled = busy || state.loadingVoices;
      $('more').setAttribute('aria-disabled', String($('more').disabled || Boolean(state.browsing)));
      $('more').textContent = state.browsing ? '正在加载…' : '加载更多音色';
      $('close').disabled = busy;
      $('open-settings').hidden = typeof openSettings !== 'function';
      $('open-settings').disabled = busy || Boolean(state.sampling);
      $('captions').disabled = busy;
      $('trim-pauses').disabled = busy;
      $('source-summary').textContent = !valid ? `检查台词 · ${state.segmented ? '整篇' : '单条'}上限 ${textLimit(state)} 字`
        : count ? `查看或编辑台词 · ${count} 条` : '填写台词或提示词';
      $('source-summary').classList.toggle('cloud-tts-error', !valid);
      $('job-count').textContent = state.segmented ? `整篇 ${totalLength} / ${textLimit(state)} 字 · ${count} 段` : `本批 ${count} 条`;
      $('job-count').classList.toggle('cloud-tts-error', count > maxItems);
      $('generate').disabled = busy || state.sampling || state.loadingVoices || !state.configured || !valid || !count || count > maxItems || !voices
        || !speed.validity.valid || !volume.validity.valid || (state.seedAudio && !pitch.validity.valid) || typeof synthesize !== 'function';
      $('generate').textContent = state.seedAudio ? '生成音频' : '生成配音';
      $('use').disabled = busy || !state.results.length || typeof state.apply !== 'function';
      $('use').textContent = state.results.length > 1 ? `使用 ${state.results.length} 条配音` : '使用配音';
      $('cancel').hidden = !state.working || typeof cancel !== 'function';
      $('cancel').disabled = state.cancelling;
    }

    function renderResults() {
      const state = session;
      const choice = $('result-choice');
      clearAudio(player);
      $('results').hidden = state.results.length === 0;
      choice.replaceChildren(...state.results.map(({ label, asset }, index) => new Option(
        `${label}${Number.isFinite(asset.duration) ? ` · ${asset.duration.toFixed(2)} 秒` : ''}`, String(index),
      )));
      if (state.results[0]) {
        player.src=state.results[0].asset.url;
        waveforms.get(player)(state.results[0].asset);
      }
      $('failures').hidden = state.failures.length === 0;
      $('failures').replaceChildren(...state.failures.map(({ label, message }) => element('li', `${label}：${message}`)));
    }

    function changed() {
      if (session.results.length || session.failures.length) {
        session.results = [];
        session.failures = [];
        renderResults();
      }
      $('progress-row').hidden = true;
      say('');
      update();
    }

    async function playSample(voiceId) {
      const state = session;
      if (!state?.configured || state.sampling || state.working || state.applying || typeof sample !== 'function') return;
      const request = Symbol();
      state.sampleRequest = request;
      state.sampling = true;
      player.pause();
      clearAudio(samplePlayer);
      samplePlayer.hidden = true;
      say('正在加载音色样本…');
      update();
      try {
        const asset = await sample(voiceId);
        if (session !== state || state.sampleRequest !== request || state.working) return;
        if (!isLocalAudio(asset)) throw new Error('服务没有返回可播放的音色样本。');
        samplePlayer.src = asset.url;
        waveforms.get(samplePlayer)(asset);
        samplePlayer.hidden = false;
        say('');
        await samplePlayer.play().catch(() => {});
      } catch (error) {
        if (session === state && state.sampleRequest === request && !state.working) say(error?.message || '无法试听该音色。', 'error');
      } finally {
        if (session === state && state.sampleRequest === request) {
          state.sampling = false;
          update();
        }
      }
    }

    function renderVoices(state) {
      const random = state.voiceMode === 'random';
      $('voice-hint').textContent = random ? '勾选候选音色。每次生成抽取一个，整批台词共用。'
        : '所有整段和分段台词使用所选音色。设置会自动保存。';
      if (state.breeze && state.configured) $('voice-hint').textContent = random ? '本批从已勾选的 ' + state.voicePool.size + ' 个音色中抽取。'
        : '全局音色 · ' + (state.voices.get(state.fixedVoice)?.name || '请选择');
      const shown = state.breeze ? (state.visible || []).map((id) => state.voices.get(id)).filter(Boolean) : [...state.voices.values()];
      const voices = shown.filter((voice) => !random || !isPromptVoice(state, voice));
      $('voices').replaceChildren(...voices.map((voice, position) => {
        const row = element('div');
        row.className = 'cloud-tts-voice-row';
        const label = element('label');
        const input = element('input');
        input.type = random ? 'checkbox' : 'radio';
        input.name = 'cloud-tts-voice';
        input.className = 'cloud-tts-voice';
        input.id = `cloud-tts-voice-${position + 1}`;
        input.value = voice.id;
        input.checked = random ? state.voicePool.has(voice.id) : state.fixedVoice === voice.id;
        input.addEventListener('change', () => {
          if (!random) state.fixedVoice = voice.id;
          else if (input.checked) state.voicePool.add(voice.id);
          else state.voicePool.delete(voice.id);
          savePreferences(state);
          if (state.breeze) $('voice-hint').textContent = random ? '本批从已勾选的 ' + state.voicePool.size + ' 个音色中抽取。' : '全局音色 · ' + voice.name;
          changed();
        });
        const summary = element('span');
        summary.append(element('strong', voice.name));
        if (state.breeze) {
          const tags = [voiceLanguage(voice.language), { male:'男声', female:'女声', neutral:'中性' }[voice.gender], toneNames[voice.tone?.[0]]].filter(Boolean);
          if (tags.length) summary.append(element('small', tags.join(' · ')));
          label.title = voice.description || voice.name;
        }
        label.append(input, summary);
        row.append(label);
        if (voice.hasSample && typeof sample === 'function') {
          const button = element('button', voice.generatedSample ? '生成试听' : '试听');
          button.type = 'button';
          button.className = 'cloud-tts-sample';
          button.setAttribute('aria-label', `试听${voice.name}`);
          button.addEventListener('click', () => playSample(voice.id));
          row.append(button);
        }
        return row;
      }));
      if (state.breeze && state.configured && !voices.length && !state.browsing) $('voices').append(element('p', '没有匹配的音色'));
      for (const button of $('filters').children) button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }

    function renderProvider(state) {
      $('provider').textContent = state.breeze ? 'Breeze Blue · TTS 2 多语言' : state.seedAudio ? '火山引擎 · Seed Audio 1.0' : '云端服务';
      $('catalog').hidden = !state.breeze || !state.configured;
      dialog.classList.toggle('breeze-voices', Boolean(state.breeze));
      $('source-title').textContent = state.segmented ? '分镜台词' : state.seedAudio ? '音频提示词' : '待配音台词';
      $('source-hint').textContent = state.segmented ? '按分镜顺序连续朗读一次，再按台词切分到各分镜。'
        : state.seedAudio ? '每条最多 3000 字。可描述场景、环境声、配乐和对白。'
        : '每条最多 ' + textLimit(state) + ' 字，可在这里修改后提交。';
      $('disclosure').textContent = state.seedAudio ? '生成时会将本批提示词发送到火山引擎。'
        : '点击生成后，本批台词会发送到已配置的云端语音服务。';
      $('pitch-field').hidden = !state.seedAudio;
      volume.min = state.seedAudio ? '50' : state.breeze ? '1' : '0';
      volume.max = state.seedAudio || state.breeze ? '200' : '100';
      if (Number.isFinite(volume.valueAsNumber)) {
        volume.value = Math.max(Number(volume.min), Math.min(Number(volume.max), volume.valueAsNumber));
      }
    }

    function renderItems(state) {
      $('items').replaceChildren(...state.items.map((item, position) => {
        const row = element('div');
        row.className = 'cloud-tts-item';
        const label = element('label', item.label);
        const count = element('span');
        count.className = 'cloud-tts-muted cloud-tts-item-count';
        const text = element('textarea');
        text.className = 'cloud-tts-text';
        text.id = position === 0 ? 'cloud-tts-text' : `cloud-tts-text-${position + 1}`;
        label.htmlFor = text.id;
        text.value = item.text;
        text.maxLength = 10000;
        text.rows = state.items.length === 1 ? 7 : 3;
        if (state.seedAudio && !state.segmented) text.placeholder = '例如，远处传来雨声。男子压低声音说：“快走。”';
        text.setAttribute('aria-label', item.label);
        const updateCount = () => {
          const length = textLength(state, item.text);
          const limit = textLimit(state);
          count.textContent = `${length} / ${limit}`;
          count.classList.toggle('cloud-tts-error', length > limit);
          text.setAttribute('aria-invalid', String(length > limit));
        };
        text.addEventListener('input', () => { item.text = text.value; updateCount(); changed(); });
        updateCount();
        const heading = element('div');
        heading.className = 'cloud-tts-item-heading';
        heading.append(label, count);
        row.append(heading, text);
        return row;
      }));
    }

    async function loadVoices(state) {
      const request = Symbol();
      state.voiceRequest = request;
      state.loadingVoices = true;
      state.browsing = false;
      $('voices').removeAttribute('aria-busy');
      $('service').textContent = '正在检查云端配音设置…';
      update();
      try {
        const reply = typeof listVoices === 'function' ? await listVoices() : null;
        if (session !== state || state.voiceRequest !== request) return;
        state.configured = reply?.configured === true;
        state.seedAudio = reply?.provider === 'seed-audio';
        state.breeze = reply?.provider === 'breezeblue';
        state.filter = 'all';
        $('search').value = '';
        renderProvider(state);
        renderItems(state);
        const nextVoices = new Map();
        const listedVoices = Array.isArray(reply.voices) && (state.configured || state.seedAudio) ? reply.voices : [];
        for (const item of listedVoices) {
          if (typeof item?.id === 'string' && item.id && typeof item.name === 'string') nextVoices.set(item.id, item);
        }
        state.voices = nextVoices;
        state.visible = [...nextVoices.keys()];
        state.next = reply?.next;
        restorePreferences(state);
        $('service').textContent = state.breeze ? state.configured ? '可用音色 · ' + (reply.total ?? nextVoices.size) : '请在云端配音设置中填写 Breeze Blue API Key。' : state.seedAudio
          ? (state.configured ? 'Seed Audio 1.0 已配置 · MP3 / 48 kHz' : '请在云端配音设置中填写火山引擎 API 密钥。')
          : !state.configured ? '云端配音服务尚未配置。请打开云端配音设置。'
          : state.voices.size ? `服务已配置 · ${state.voices.size} 种音色` : '服务已配置，但没有返回可用音色。';
        if(!state.configured && reply?.warning) $('service').textContent=reply.warning;
        renderVoices(state);
      } catch (error) {
        if (session !== state || state.voiceRequest !== request) return;
        state.configured = false;
        state.voices.clear();
        state.fixedVoice = undefined;
        state.voicePool.clear();
        renderVoices(state);
        $('service').textContent = error?.message || '无法读取音色，请检查云端配音设置。';
      } finally {
        if (session === state && state.voiceRequest === request) { state.loadingVoices = false; update(); }
      }
    }

    async function browse(append = false, debounce = false) {
      const state = session;
      if (!state?.configured || !state.breeze || state.working || (append && (!state.next || state.browsing))) return;
      const request = Symbol();
      state.voiceRequest = request;
      state.browsing = true;
      if (!append) {
        state.next = null;
        state.visible = [];
        renderVoices(state);
      }
      $('voices').setAttribute('aria-busy', 'true');
      $('service').textContent = append ? '正在加载更多音色…' : '正在筛选音色…';
      update();
      try {
        if (debounce) {
          await new Promise(resolve => setTimeout(resolve, 300));
          if (session !== state || state.voiceRequest !== request) return;
        }
        const reply = await listVoices({ ...(append ? state.next : {}), search: $('search').value.trim(), filter: state.filter });
        if (session !== state || state.voiceRequest !== request) return;
        const ids = new Set(append ? state.visible : []);
        const previousCount = ids.size;
        const focused = document.activeElement;
        const focusedVoice = focused.closest('.cloud-tts-voice-row')?.querySelector('input').value;
        for (const voice of reply.voices) { state.voices.set(voice.id, voice); ids.add(voice.id); }
        state.visible = [...ids];
        state.next = reply.next;
        state.browsing = false;
        $('service').textContent = '可用音色 · ' + (reply.total ?? ids.size);
        renderVoices(state);
        if (!append) $('voices').scrollTop = 0;
        else if (focused === $('more')) {
          const choices = $('voices').querySelectorAll('input');
          const next = choices[previousCount] || (!state.next ? choices[choices.length - 1] || $('search') : null);
          next?.focus();
        } else if (focusedVoice) {
          const input = Array.from($('voices').querySelectorAll('input')).find(item => item.value === focusedVoice);
          (focused.matches('button') ? input?.closest('.cloud-tts-voice-row').querySelector('button') : input)?.focus();
        }
      } catch (error) {
        if (session === state && state.voiceRequest === request) {
          $('service').textContent = (error.message || '音色加载失败。') + (append ? ' 可再次加载更多音色。' : ' 可重新选择筛选项重试。');
        }
      } finally {
        if (session === state && state.voiceRequest === request) {
          state.browsing = false;
          $('voices').removeAttribute('aria-busy');
          update();
        }
      }
    }
    $('search').addEventListener('input', () => browse(false, true));
    $('filters').addEventListener('click', (event) => {
      if (!event.target.dataset.filter || !session) return;
      session.filter = event.target.dataset.filter;
      browse();
    });
    $('more').addEventListener('click', () => browse(true));

    function refreshVoices() {
      const state = session;
      if (!dialog.open || !state || state.working || state.applying || state.sampling) return;
      clearAudio(samplePlayer);
      samplePlayer.hidden = true;
      return loadVoices(state);
    }

    function open({ items, segmented = false, onUse: apply } = {}) {
      if (session?.working || session?.applying) return;
      const source = Array.isArray(items) && items.length ? items : [{ text: '', index: 0, label: '口播台词' }];
      const prepared = source.map((item, position) => {
        const text = typeof item?.text === 'string' ? item.text : '';
        return {
          index: Number.isSafeInteger(item?.index) && item.index >= 0 ? item.index : position,
          label: item?.label || `第 ${position + 1} 条台词`, text,
        };
      });
      const state = { items: prepared, segmented, seedAudio: false, voiceMode: 'fixed',
        voices: new Map(), voicePool: new Set(), results: [], failures: [], apply: apply ?? onUse };
      session = state;
      clearAudio(samplePlayer);
      samplePlayer.hidden = true;
      $('voices').replaceChildren();
      $('voice-hint').textContent = '';
      $('progress-row').hidden = true;
      $('captions').checked = true;
      $('trim-pauses').checked = false;
      speed.value = '1';
      volume.value = '100';
      pitch.value = '0';
      voiceMode.value = 'fixed';
      $('source-details').open = prepared.some(({ text }) => !text.trim());
      say('');
      renderProvider(state);
      renderItems(state);
      renderResults();
      update();
      if (!dialog.open) dialog.showModal();
      loadVoices(state);
    }

    function onProgress(progress = {}) {
      if (!session?.working) return;
      const total = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : session.total;
      const completed = Number.isFinite(progress.completed) ? progress.completed
        : Number.isFinite(progress.index) ? progress.index : 0;
      const bounded = Math.max(0, Math.min(total, completed));
      const active = Number.isFinite(progress.index) && progress.index >= 0 && progress.index < total && bounded < total;
      $('progress').max = total;
      if (progress.phase) {
        if (bounded) $('progress').value = bounded;
        else $('progress').removeAttribute('value');
        $('progress-label').textContent = progress.phase + (bounded ? ' · ' + bounded + ' / ' + total : '');
        return;
      }
      if (session.seedAudio && (active ? progress.fraction === 0 : bounded === 0)) {
        $('progress').removeAttribute('value');
      } else {
        $('progress').value = active && Number.isFinite(progress.fraction)
          ? Math.min(total, Math.max(bounded, progress.index + Math.min(1, Math.max(0, progress.fraction)))) : bounded;
      }
      $('progress-label').textContent = `已处理 ${Math.floor(bounded)} / ${total} 项${active ? ` · 第 ${progress.index + 1} 项` : ''}`;
    }

    async function generate() {
      const state = session;
      if (!state || $('generate').disabled) return;
      const choices = voiceChoices(state);
      const voiceId = state.voiceMode === 'random' ? choices[Math.floor(Math.random() * choices.length)] : state.fixedVoice;
      const jobs = state.items.filter(({ text }) => text.trim())
        .map(({ index, text }) => ({ index, text: text.trim(), voiceId }));
      const labels = new Map(jobs.map((job) => {
        const item = state.items.find(({ index }) => index === job.index);
        return [jobKey(job), `${item.label} · ${state.voices.get(job.voiceId).name}`];
      }));
      state.total = jobs.length;
      state.working = true;
      state.cancelling = false;
      state.sampleRequest = undefined;
      samplePlayer.pause();
      state.results = [];
      state.failures = [];
      renderResults();
      $('progress-row').hidden = false;
      onProgress();
      say(state.segmented ? '正在生成整篇配音…' : state.seedAudio ? '火山引擎正在生成音频，每项最多等待 5 分钟。' : '正在生成配音…');
      update();
      try {
        const enableSubtitles = $('captions').checked;
        const reply = await synthesize({
          jobs, ...(state.segmented && { segmented: true }), speed: speed.valueAsNumber, volume: volume.valueAsNumber,
          ...($('trim-pauses').checked && {trimPauses:true}),
          ...(state.seedAudio && { pitch: pitch.valueAsNumber }), ...((state.seedAudio || state.breeze) && { enableSubtitles }),
        });
        if (session !== state) return;
        const results = new Map((reply?.results ?? []).filter(({ asset }) => isLocalAudio(asset)).map((item) => [jobKey(item), item]));
        const failures = new Map((reply?.failures ?? []).map((item) => [jobKey(item), item.message]));
        if (state.segmented && (reply?.cancelled || jobs.some(job => !results.has(jobKey(job))))) {
          $('progress-row').hidden = true;
          say(reply?.cancelled ? '已取消整篇配音。' : '分镜配音不完整，请重试。', reply?.cancelled ? '' : 'error');
          return;
        }
        for (const job of jobs) {
          const key = jobKey(job);
          const label = labels.get(key);
          const result = results.get(key);
          if (result) state.results.push({ ...result, label });
          else state.failures.push({ label, message: failures.get(key) || (reply?.cancelled ? '已取消。' : '服务未返回音频。') });
        }
        renderResults();
        if (reply?.cancelled) $('progress-row').hidden = true;
        else onProgress({ completed: jobs.length });
        const missingCaptions = state.seedAudio && enableSubtitles && state.results.some(({ asset }) => !asset.timedCaptions?.length);
        say(`${reply?.cancelled ? '已取消。' : ''}生成 ${state.results.length} 条，未生成 ${state.failures.length} 条。${missingCaptions ? ' 部分音频未返回对白字幕。' : ''}`,
          state.results.length ? '' : 'error');
      } catch (error) {
        if (session === state) {
          $('progress-row').hidden = true;
          say(error?.message || '生成配音失败。', 'error');
        }
      } finally {
        if (session === state) { state.working = false; update(); }
      }
    }

    async function use() {
      const state = session;
      if (!state || $('use').disabled) return;
      state.applying = true;
      update();
      try {
        await state.apply(state.results.map(({ label, ...result }) => result), { withCaptions: $('captions').checked });
        if (session === state) dialog.close();
      } catch (error) {
        if (session === state) say(error?.message || '无法将配音加入轨道。', 'error');
      } finally { if (session === state) { state.applying = false; update(); } }
    }

    $('close').addEventListener('click', () => dialog.close());
    $('open-settings').addEventListener('click', async () => {
      const state = session;
      if (!state || $('open-settings').disabled || typeof openSettings !== 'function') return;
      try { await openSettings(); } catch (error) {
        if (session === state) say(error?.message || '无法打开云端配音设置。', 'error');
      }
    });
    dialog.addEventListener('cancel', (event) => { if (session?.working || session?.applying) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      session = undefined;
      clearAudio(player);
      clearAudio(samplePlayer);
    });
    for (const input of [speed, volume, pitch]) input.addEventListener('input', () => {
      savePreferences(session);
      changed();
    });
    voiceMode.addEventListener('change', () => {
      session.voiceMode = voiceMode.value;
      savePreferences(session);
      renderVoices(session);
      changed();
    });
    $('captions').addEventListener('change', () => savePreferences(session));
    $('trim-pauses').addEventListener('change', () => savePreferences(session));
    player.addEventListener('play', () => samplePlayer.pause());
    samplePlayer.addEventListener('play', () => player.pause());
    player.addEventListener('error', () => {
      if (session?.results.length && player.hasAttribute('src')) say('音频已生成，当前播放器无法试听。', 'error');
    });
    samplePlayer.addEventListener('error', () => {
      if (session && samplePlayer.hasAttribute('src')) say('音色样本无法播放。', 'error');
    });
    $('result-choice').addEventListener('change', () => {
      const asset = session?.results[Number($('result-choice').value)]?.asset;
      if (asset) {player.src=asset.url;waveforms.get(player)(asset);}
    });
    $('generate').addEventListener('click', generate);
    $('use').addEventListener('click', use);
    $('cancel').addEventListener('click', async () => {
      const state = session;
      if (!state?.working || state.cancelling || typeof cancel !== 'function') return;
      state.cancelling = true;
      say(state.seedAudio ? '正在停止等待音频…' : '已请求取消，正在等待任务结束…');
      update();
      try { await cancel(); } catch (error) {
        if (session !== state) return;
        state.cancelling = false;
        say(error?.message || '无法取消配音。', 'error');
        update();
      }
    });
    return { open, onProgress, refreshVoices };
  };
})();

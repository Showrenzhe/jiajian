'use strict';

(() => {
  const seedAudio = 'seed-audio';
  const gateway = 'gateway';
  const breeze = 'breezeblue';
  const breezeEndpoint = 'https://api.breeze.blue/';
  const seedAudioEndpoint = 'https://openspeech.bytedance.com/api/v3/tts/create';
  const fixedAddress = (provider) => provider === breeze ? breezeEndpoint : provider === seedAudio ? seedAudioEndpoint : '';
  const markup = `
    <dialog id="cloud-settings-dialog" class="cloud-settings-dialog" aria-labelledby="cloud-settings-title">
      <form id="cloud-settings-form">
        <header class="cloud-settings-heading">
          <h2 id="cloud-settings-title" tabindex="-1" autofocus>云端配音设置</h2>
          <button type="button" id="creative-settings-entry">云端创作服务</button>
        </header>
        <div class="cloud-settings-body">
          <fieldset id="appearance-settings" hidden>
            <legend>外观</legend>
            <p class="cloud-settings-muted">剪辑台的面板位置、宽度和布局预设保存在本机，对这台电脑上的所有工程生效。</p>
            <div class="appearance-options">
              <label><input type="radio" name="appearance" value="light"><span class="appearance-preview" aria-hidden="true"></span><span>浅色</span></label>
              <label><input type="radio" name="appearance" value="dark"><span class="appearance-preview" aria-hidden="true"></span><span>深色</span></label>
              <label><input type="radio" name="appearance" value="system"><span class="appearance-preview" aria-hidden="true"></span><span>跟随系统</span></label>
            </div>
          </fieldset>
          <button type="button" id="update-settings-entry">软件更新与通道</button>
          <details id="performance-settings" hidden>
            <summary>性能与代理</summary>
            <fieldset id="performance-options" aria-label="性能与代理设置" disabled>
              <div class="cloud-settings-field">
                <label for="performance-optimization">自动优化</label>
                <select id="performance-optimization"><option value="smart">智能</option><option value="smooth">优先流畅</option><option value="quality">优先画质</option></select>
              </div>
              <label class="cloud-settings-check"><input id="performance-default-proxy" type="checkbox">新草稿默认开启代理</label>
              <label class="cloud-settings-check"><input id="performance-software" type="checkbox">兼容模式（软件渲染）</label>
              <small>画面闪烁、黑屏或卡顿时可开启，重启佳剪后生效。</small>
              <div class="cloud-settings-field">
                <strong>代理位置</strong><span id="performance-location"></span>
                <div class="performance-actions"><button id="performance-folder" type="button">选择文件夹…</button></div>
              </div>
              <div class="performance-cache">
                <span>缓存占用 <strong id="performance-size">—</strong></span>
                <button id="performance-clear" type="button">清理缓存</button>
              </div>
              <div id="performance-confirm" hidden>
                <p>清理当前代理、缩略图和素材信息缓存？缓存上限为 2 GiB，再次预览时会重新生成。</p>
                <div class="performance-actions">
                  <button id="performance-keep" type="button">取消</button>
                  <button id="performance-confirm-clear" type="button">确认清理</button>
                </div>
              </div>
            </fieldset>
            <p id="performance-status" role="status" hidden></p>
            <button id="performance-diagnostics" type="button">导出诊断包…</button>
            <button id="performance-retry" type="button" hidden>重新读取</button>
          </details>
          <h3 id="cloud-settings-section" hidden>云端配音</h3>
          <div class="cloud-settings-field">
            <label for="cloud-settings-provider">配音服务</label>
            <select id="cloud-settings-provider">
              <option value="breezeblue">Breeze Blue · TTS 2 多语言（默认）</option>
              <option value="gateway">通用接口</option>
              <option value="seed-audio">火山引擎 Seed Audio 1.0</option>
            </select>
          </div>
          <div class="cloud-settings-field">
            <label for="cloud-settings-base-url">服务地址</label>
            <input id="cloud-settings-base-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://voice.example.com" aria-describedby="cloud-settings-address-help">
            <p id="cloud-settings-address-help" class="cloud-settings-muted">填写服务方提供的接口地址。留空并保存会停用云端配音。</p>
          </div>
          <div class="cloud-settings-field">
            <label for="cloud-settings-api-key" id="cloud-settings-key-label">API 密钥（按服务要求填写）</label>
            <input id="cloud-settings-api-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空保留已保存的密钥" aria-describedby="cloud-settings-key-state cloud-settings-key-help">
            <p id="cloud-settings-key-state" class="cloud-settings-muted"></p>
            <p id="cloud-settings-key-help" class="cloud-settings-muted">同一服务地址留空会保留密钥。换用不同服务时，请填新密钥或清除旧密钥。</p>
            <div class="cloud-settings-breeze-tools" id="cloud-settings-breeze-tools" hidden>
              <button type="button" id="cloud-settings-verify">测试音色连接</button>
              <button type="button" id="cloud-settings-keys">打开 Breeze Blue 密钥管理</button>
            </div>
            <label class="cloud-settings-check"><input id="cloud-settings-clear-key" type="checkbox">清除已保存的密钥</label>
          </div>
          <p id="cloud-settings-warning" class="cloud-settings-warning" role="status" hidden></p>
          <p id="cloud-settings-status" role="status" hidden></p>
        </div>
        <footer class="cloud-settings-actions">
          <button type="button" id="cloud-settings-cancel">取消</button>
          <button type="submit" id="cloud-settings-save" class="cloud-settings-primary" disabled>保存设置</button>
        </footer>
      </form>
    </dialog>`;

  function origin(address) {
    try { return new URL(address).origin; } catch { return ''; }
  }

  function safeSaveError(error, key) {
    const fallback = '无法保存云端配音设置，请检查服务地址后重试。';
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return !message || (key && message.includes(key)) ? fallback : message.slice(0, 500);
  }

  window.mountCloudTtsSettings = (container, { load, save, verify, openKeys, onSaved, performance } = {}) => {
    const template = document.createElement('template');
    template.innerHTML = markup;
    container.replaceChildren(template.content);
    const $ = (id) => container.querySelector(`#cloud-settings-${id}`);
    const dialog = $('dialog');
    const appearance = container.querySelector('#appearance-settings');
    window.bindAppearancePicker(appearance);
    const provider = $('provider');
    const address = $('base-url');
    const password = $('api-key');
    const clearKey = $('clear-key');
    const perf = id => container.querySelector('#performance-' + id);
    let session;

    function showPerformance(data) {
      if (typeof data.softwareRendering === 'boolean') perf('software').checked = data.softwareRendering;
      perf('optimization').value = data.optimization;
      perf('default-proxy').checked = data.defaultProxy;
      perf('location').textContent = data.location;
      const bytes=data.cacheBytes ?? data.bytes;
      const unit = Math.min(3, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
      perf('size').textContent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: unit ? 1 : 0 }).format(bytes / 1024 ** unit)
        + ' ' + ['B', 'KiB', 'MiB', 'GiB'][unit];
      perf('clear').disabled = false;
    }

    async function changePerformance(action, value) {
      const state = session;
      if (!state?.showAppearance || state.performanceBusy) return;
      state.performanceBusy = true;
      perf('retry').hidden = true;
      perf('options').disabled = true;
      perf('confirm').hidden = true;
      perf('status').textContent = action === 'load' ? '正在读取缓存设置…' : action === 'clear' ? '正在清理缓存…' : '';
      perf('status').classList.remove('cloud-settings-error');
      perf('status').hidden = !perf('status').textContent;
      try {
        const data = await performance[action](value);
        if (session !== state) return;
        state.performance = {...state.performance,...data};
        showPerformance(data);
        perf('status').textContent = action === 'rendering' ? '兼容模式已保存，重启佳剪后生效。' : action === 'clear' ? '缓存已清理。' : action === 'save' ? '已保存。' : '';
      } catch (error) {
        if (session !== state) return;
        if (state.performance) showPerformance(state.performance);
        perf('status').textContent = error?.message || '无法读取或保存性能设置。';
        perf('status').classList.add('cloud-settings-error');
        perf('retry').hidden = false;
      } finally {
        if (session === state) {
          state.performanceBusy = false;
          perf('options').disabled = !state.performance;
          perf('status').hidden = !perf('status').textContent;
        }
      }
    }
    perf('settings').addEventListener('toggle', () => { if (perf('settings').open) void changePerformance('load'); });
    perf('retry').addEventListener('click', () => changePerformance('load'));
    perf('diagnostics').addEventListener('click', async () => {
      try {
        if (!await window.workbench.exportDiagnostics()) return;
        perf('status').textContent='诊断包已保存。';
      } catch(error) {perf('status').textContent=error.message;}
      perf('status').hidden=false;
    });
    perf('software').addEventListener('change', () => changePerformance('rendering', perf('software').checked));
    for (const [id, key] of [['default-proxy', 'defaultProxy'], ['optimization', 'optimization']]) {
      perf(id).addEventListener('change', () => changePerformance('save', { [key]: key === 'optimization' ? perf(id).value : perf(id).checked }));
    }
    perf('folder').addEventListener('click', () => changePerformance('folder'));
    perf('clear').addEventListener('click', () => { perf('confirm').hidden = false; perf('keep').focus(); });
    function keepCache() { perf('confirm').hidden = true; perf('clear').focus(); }
    perf('keep').addEventListener('click', keepCache);
    perf('confirm-clear').addEventListener('click', () => changePerformance('clear'));

    function say(message, error = false) {
      $('status').textContent = message;
      $('status').hidden = !message;
      $('status').classList.toggle('cloud-settings-error', error);
    }

    function update() {
      if (!session) return;
      const locked = session.loading || session.saving || session.testing;
      const isSeed = provider.value === seedAudio;
      const isBreeze = provider.value === breeze;
      const managementId = isBreeze && password.value.trim().startsWith('key_');
      const providerChanged = provider.value !== session.provider;
      const nextOrigin = origin(address.value.trim());
      const keyRequired = session.hasApiKey && nextOrigin && (providerChanged || nextOrigin !== origin(session.baseUrl))
        && !clearKey.checked && !password.value.trim();
      provider.disabled = locked || !session.ready;
      address.disabled = locked || !session.ready;
      address.readOnly = isSeed || isBreeze;
      password.disabled = locked || !session.ready || clearKey.checked;
      clearKey.disabled = locked || !session.ready || !session.hasApiKey;
      $('cancel').disabled = Boolean(session.saving);
      $('save').disabled = locked || !session.ready || managementId || !address.validity.valid || Boolean(keyRequired) || typeof save !== 'function';
      $('breeze-tools').hidden = !isBreeze;
      $('verify').disabled = locked || !session.ready || !isBreeze || managementId || clearKey.checked
        || (!password.value.trim() && (providerChanged || !session.hasApiKey));
      $('save').textContent = session.saving ? '正在保存…' : session.showAppearance ? '保存配音设置' : '保存设置';
      $('address-help').textContent = isBreeze ? '已选用 Breeze Blue TTS 2 多语言模型。' : isSeed ? '使用火山引擎固定接口地址。' : '填写服务方提供的接口地址。留空并保存会停用云端配音。';
      $('key-label').textContent = isBreeze ? 'Breeze Blue API Key' : isSeed ? '火山引擎 API Key' : 'API 密钥（按服务要求填写）';
      $('key-state').textContent = session.hasApiKey ? (providerChanged ? '原服务已保存密钥。' : '已保存密钥。') : '未保存密钥。';
      $('key-help').textContent = managementId ? '这里填入的是管理编号。请从 Breeze Blue 密钥管理复制创建时显示的 brz_ 完整密钥。'
        : keyRequired ? '服务已变更，请填写新密钥或勾选清除旧密钥后保存。'
        : isBreeze ? '填写创建时显示的 brz_ 完整密钥。连接测试只读取音色列表。'
        : isSeed ? '生成配音需要火山引擎 API Key。清除密钥后会停用该服务。'
          : '同一服务留空会保留密钥。换用不同服务时，请填新密钥或清除旧密钥。';
      $('key-help').classList.toggle('cloud-settings-error', Boolean(keyRequired || managementId));
      password.setAttribute('aria-invalid',String(managementId));
    }

    async function open({ showAppearance = false } = {}) {
      if (dialog.open) { provider.focus(); return; }
      const state = { showAppearance, loading: true, ready: false, provider: breeze, selection: breeze, gatewayAddress: '', baseUrl: breezeEndpoint, hasApiKey: false };
      session = state;
      appearance.hidden = !showAppearance;
      perf('settings').open = false;
      perf('settings').hidden = !showAppearance;
      perf('options').disabled = true;
      perf('status').hidden = true;
      perf('confirm').hidden = true;
      perf('retry').hidden = true;
      $('section').hidden = !showAppearance;
      $('title').textContent = showAppearance ? '设置' : '云端配音设置';
      $('cancel').textContent = showAppearance ? '关闭' : '取消';
      provider.value = breeze;
      address.value = breezeEndpoint;
      password.value = '';
      clearKey.checked = false;
      $('warning').textContent = '';
      $('warning').hidden = true;
      say('正在读取本机设置…');
      update();
      dialog.showModal();
      if (showAppearance) appearance.querySelector(':checked').focus({ preventScroll: true });
      try {
        if (typeof load !== 'function') throw new Error('unavailable');
        const stored = await load();
        if (session !== state) return;
        state.provider = fixedAddress(stored?.provider) ? stored.provider : gateway;
        state.selection = state.provider;
        state.baseUrl = typeof stored?.baseUrl === 'string' ? stored.baseUrl : '';
        state.gatewayAddress = state.provider === gateway ? state.baseUrl : '';
        state.hasApiKey = stored?.hasApiKey === true;
        provider.value = state.provider;
        address.value = fixedAddress(state.provider) || state.gatewayAddress;
        if (typeof stored?.warning === 'string' && stored.warning) {
          $('warning').textContent = stored.warning;
          $('warning').hidden = false;
        }
        state.ready = true;
        say('');
      } catch {
        if (session === state) say('无法读取本机设置，请关闭后重试。', true);
      } finally {
        if (session === state) {
          state.loading = false;
          update();
          if (state.ready && document.activeElement === $('title')) provider.focus();
        }
      }
    }

    $('keys').addEventListener('click',async()=>{
      try { await openKeys(); } catch { say('无法打开系统浏览器，请访问 breezeblue.ai 的开发者密钥管理页。',true); }
    });
    $('verify').addEventListener('click', async () => {
      if (!session || $('verify').disabled) return;
      const state=session, key=password.value.trim();
      state.testing=true;update();say('正在读取 Breeze Blue 音色列表…');
      try {
        await verify(key);
        if(session===state) say(key ? '音色连接成功。保存后即可使用这把密钥。' : '已保存的密钥可以读取音色。');
      } catch(error) {
        if(session===state) say(safeSaveError(error,key),true);
      } finally {
        if(session===state) {state.testing=false;update();}
      }
    });
    $('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const state = session;
      if (!state || $('save').disabled) return;
      const key = clearKey.checked ? '' : password.value.trim();
      const request = {
        baseUrl: fixedAddress(provider.value) || address.value.trim(), clearKey: clearKey.checked, provider: provider.value,
        ...(key && { apiKey: key }),
      };
      state.saving = true;
      say('正在保存…');
      update();
      try {
        await save(request);
      } catch (error) {
        if (session === state) say(safeSaveError(error, key), true);
        return;
      } finally {
        if (session === state) { state.saving = false; update(); }
      }
      if (session !== state) return;
      password.value = '';
      dialog.close();
      Promise.resolve().then(() => onSaved?.()).catch(() => {});
    });
    $('cancel').addEventListener('click', () => { if (!session?.saving) dialog.close(); });
    dialog.addEventListener('cancel', (event) => {
      if (!perf('confirm').hidden) { event.preventDefault(); keepCache(); }
      else if (session?.saving) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      session = undefined;
      password.value = '';
      clearKey.checked = false;
    });
    for (const input of [address, password]) input.addEventListener('input', () => { say(''); update(); });
    provider.addEventListener('change', () => {
      if (!session) return;
      if (session.selection === gateway) session.gatewayAddress = address.value;
      session.selection = provider.value;
      address.value = fixedAddress(provider.value) || session.gatewayAddress;
      password.value = '';
      clearKey.checked = false;
      say('');
      update();
    });
    clearKey.addEventListener('change', () => {
      if (clearKey.checked) password.value = '';
      say('');
      update();
    });
    function hasUnsavedChanges() {
      return Boolean(dialog.open && session?.ready && (session.saving || session.testing ||
        provider.value !== session.provider || address.value.trim() !== (fixedAddress(session.provider) || session.baseUrl) ||
        password.value.trim() || clearKey.checked));
    }
    return { open, hasUnsavedChanges };
  };
})();

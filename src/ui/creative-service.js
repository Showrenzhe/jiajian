'use strict';

(() => {
  const names = { avatar: '数字人口播', cover: 'AI 封面', replicate: '爆款复刻' };
  const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
  function dialog(title) {
    const box = node('dialog'); box.className = 'layer-motion-dialog creative-service-dialog'; box.setAttribute('aria-label', title);
    const heading = node('h2', title), fields = node('div'), message = node('p'), footer = node('footer');
    message.setAttribute('role', 'status');
    box.append(heading, fields, message, footer);
    box.addEventListener('close', () => box.remove(), { once: true });
    document.body.append(box);
    const field = (caption, el) => { const label = node('label'); label.append(node('span', caption), el); fields.append(label); return el; };
    return { box, message, footer, fields, field };
  }
  window.createCreativeWorkspace = ({ api, pick, apply, busy, ratio, selection }) => {
    async function settings() {
      const d = dialog('云端创作服务');
      const closed = new Promise((resolve) => d.box.addEventListener('close',resolve,{once:true}));
      const base = d.field('服务根地址', node('input')); base.type = 'url'; base.placeholder = 'https://your-service.example/v1/creative/';
      const key = d.field('API Key（可选）', node('input')); key.type = 'password'; key.autocomplete = 'new-password';
      const clear = d.field('清除已保存的 Key', node('input')); clear.type = 'checkbox';
      const close = node('button', '关闭'), save = node('button', '保存');
      close.onclick = () => d.box.close(); save.disabled = true;
      d.footer.append(close, save);
      d.box.showModal();
      try {
        const current = await api.creativeSettings(); base.value = current.baseUrl;
        key.placeholder = current.hasApiKey ? '已保存，留空保留' : '尚未设置';
        d.message.textContent = '数字人口播、AI 封面和爆款复刻使用此服务。';
        save.disabled = false;
      } catch (error) { d.message.textContent = error.message; }
      save.onclick = async () => {
        save.disabled = true;
        try { await api.saveCreativeSettings({baseUrl: base.value.trim(), apiKey: key.value, clearKey: clear.checked}); d.box.close(); }
        catch (error) { d.message.textContent = error.message; save.disabled = false; }
      };
      return closed;
    }
    async function open(action) {
      const d = dialog(names[action]);
      const refs = {};
      function picker(key, label, kind, value) {
        const choose = d.field(label, node('button', value?.name || '选择文件'));
        if (value) refs[key] = value.id;
        choose.onclick = async () => { const asset = await pick(kind); if (asset) { refs[key] = asset.id; choose.textContent = asset.name; } };
      }
      const selected = selection();
      if (action === 'avatar') {
        picker('imageId', '形象图片或视频', 'visual', selected.visual);
        picker('voiceId', '口播音频', 'narration', selected.voice);
      } else if (action === 'cover') {
        picker('imageId', '参考素材（可选）', 'visual', selected.visual);
      } else {
        picker('videoId', '参考视频', 'video', selected.visual?.kind === 'video' ? selected.visual : null);
      }
      const url = node('input');
      if (action === 'replicate') {
        url.type = 'url'; url.placeholder = 'https://…';
        d.field('或使用平台视频链接', url);
      }
      const prompt = d.field(action === 'cover' ? '封面描述' : '创作要求（可选）', node('textarea'));
      prompt.rows = 3; prompt.maxLength = 4096;
      const config = node('button', '服务设置'), close = node('button', '取消'), submit = node('button',
        action === 'avatar' ? '生成并添加到分镜' : action === 'cover' ? '生成并设为封面' : '分析并追加到分镜');
      config.onclick = async () => { await settings(); await hint(); }; d.footer.append(config, close, submit);
      let pending = false, cancelled = false;
      const cancel = () => {
        if (!pending) { d.box.close(); return; }
        cancelled = true; close.disabled = true; d.message.textContent = '正在取消任务…'; api.cancel().catch(() => {});
      };
      close.onclick = cancel;
      d.box.oncancel = (e) => { e.preventDefault(); cancel(); };
      async function hint() {
        try {
          const state = await api.creativeSettings();
          d.message.textContent = state.baseUrl ? '提交后，所选素材和描述将发送至 ' + new URL(state.baseUrl).host + '。' : '请先在服务设置中填写你的创作服务地址。';
        } catch (error) { d.message.textContent = error.message; }
      }
      d.box.showModal(); await hint();
      submit.onclick = async () => {
        if (pending) return;
        try {
          const cfg = await api.creativeSettings();
          if (!cfg.baseUrl) { d.message.textContent = '请先填写创作服务地址。'; return; }
          if (action === 'avatar' && (!refs.imageId || !refs.voiceId)) { d.message.textContent = '请选择形象素材和口播音频。'; return; }
          if (action === 'replicate' && !refs.videoId && !url.value.trim()) { d.message.textContent = '请选择参考视频或填写平台链接。'; return; }
          pending = true; busy(true); submit.disabled = config.disabled = true; d.message.textContent = '正在等待 ' + new URL(cfg.baseUrl).host + ' 返回结果…';
          const request = { ...refs, action, ratio: ratio(), prompt: prompt.value, referenceUrl: url.value.trim() };
          if (request.referenceUrl) delete request.videoId;
          const result = await api.runCreative(request);
          busy(false); pending = false;
          if (!cancelled) apply(action, result);
          d.box.close();
        } catch (error) {
          d.message.textContent = error.message; if (cancelled) d.box.close();
        } finally {
          if (pending) busy(false);
          pending = false; submit.disabled = config.disabled = close.disabled = false;
        }
      };
    }
    return { open, settings };
  };
})();

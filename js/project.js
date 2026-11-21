/**
 * project.js —— 工程文件（.lpaint）与自动草稿
 *
 * 格式：JSON
 *   { format: 'layerpaint', version: 1, savedAt,
 *     doc: { width, height }, layerSeq, activeId,
 *     layers: [{ name, visible, opacity, blendMode, width, height,
 *                pixels: dataURL, text, curves,
 *                mask: { pixels: dataURL, enabled } | null }] }
 *
 * 保存/打开：完整保留图层像素、蒙版、文字源数据、曲线、混合模式。
 * 自动草稿：IndexedDB，每次历史提交后防抖保存；启动时检测并询问恢复。
 */
(function () {
  'use strict';

  const FORMAT = 'layerpaint';
  const VERSION = 1;
  const DRAFT_KEY = 'current';
  const DRAFT_DEBOUNCE = 3000;   // 历史提交后 3 秒无新动作才写草稿

  /* ================= IndexedDB 极简封装 ================= */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('layerpaint', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('draft');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbRun(mode, fn) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('draft', mode);
        const req = fn(tx.objectStore('draft'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[project] IndexedDB 不可用：', e && e.message);
      return undefined;
    }
  }

  const draftPut = (json) => idbRun('readwrite', (s) => s.put(json, DRAFT_KEY));
  const draftGet = () => idbRun('readonly', (s) => s.get(DRAFT_KEY));
  const draftDel = () => idbRun('readwrite', (s) => s.delete(DRAFT_KEY));

  /* ================= 序列化 / 反序列化 ================= */

  function serialize() {
    const s = PL.state;
    return {
      format: FORMAT,
      version: VERSION,
      savedAt: new Date().toISOString(),
      doc: { width: s.doc.width, height: s.doc.height },
      layerSeq: s.layerSeq,
      activeId: s.activeId,
      layers: s.stack.layers.map(l => {
        const m = {
          name: l.name,
          visible: l.visible,
          opacity: l.opacity,
          blendMode: l.blendMode,
          width: l.width,
          height: l.height,
          pixels: l.canvas.toDataURL('image/png'),
          text: l.text ? { ...l.text } : null,
          curves: l.curves ? JSON.parse(JSON.stringify(l.curves)) : null,
          mask: null,
        };
        if (l.mask) {
          m.mask = {
            pixels: l.mask.toDataURL('image/png'),
            enabled: l.maskEnabled !== false,
          };
        }
        return m;
      }),
    };
  }

  function loadImageAsync(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图层像素解码失败'));
      img.src = src;
    });
  }

  /** 用工程数据重建整个文档（异步：需等所有像素图加载） */
  async function loadProject(data) {
    if (!data || data.format !== FORMAT || !Array.isArray(data.layers) || !data.layers.length) {
      throw new Error('不是有效的 LayerPaint 工程文件');
    }
    const s = PL.state;

    // 重建图层（先全部加载像素）
    const rebuilt = [];
    for (const m of data.layers) {
      const img = await loadImageAsync(m.pixels);
      const l = new PL.Layer(m.name || '图层', m.width, m.height);
      l.visible = m.visible !== false;
      l.opacity = typeof m.opacity === 'number' ? m.opacity : 1;
      l.blendMode = m.blendMode || 'source-over';
      l.ctx.drawImage(img, 0, 0);
      if (m.text) {
        l.text = { ...m.text };
        if (l._textBox == null && PL.tools && PL.tools.measureTextBox) {
          l._textBox = PL.tools.measureTextBox(l.text); // 重建命中框
        }
      }
      if (m.curves) l.curves = JSON.parse(JSON.stringify(m.curves));
      if (m.mask && m.mask.pixels) {
        const maskImg = await loadImageAsync(m.mask.pixels);
        l.initMask('#ffffff');
        l.maskCtx.clearRect(0, 0, l.width, l.height);
        l.maskCtx.drawImage(maskImg, 0, 0);
        l.maskEnabled = m.mask.enabled !== false;
      }
      rebuilt.push(l);
    }

    // 应用到全局状态（参照 newDocument 流程）
    s.doc.width = data.doc.width;
    s.doc.height = data.doc.height;
    s.stack = new PL.LayerStack();
    rebuilt.forEach(l => s.stack.layers.push(l));
    s.layerSeq = data.layerSeq || rebuilt.length;
    s.activeId = s.stack.getById(data.activeId) ? data.activeId : (s.stack.top && s.stack.top.id);
    s.previewFilter = '';
    s.previewLayerId = null;
    s.maskEditId = null;
    PL.compositor.resizeCanvas();
    PL.compositor.fit();
    PL.history.reset('打开工程');
    s.pristine = false; // 打开的工程已「编辑过」，导入图片不再重设画布
    PL.refreshAll();
  }

  /* ================= 对外 API ================= */

  PL.project = {
    serialize,
    loadProject,

    /** 导出 .lpaint 工程文件 */
    saveFile() {
      const data = serialize();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      a.href = URL.createObjectURL(blob);
      a.download = `layerpaint-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.lpaint`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      PL.updateStatus && PL.updateStatus();
    },

    /** 打开 .lpaint 文件；返回是否成功 */
    async openFile(file) {
      const text = await file.text();
      try {
        await loadProject(JSON.parse(text));
        return true;
      } catch (e) {
        console.warn('[project] 打开失败：', e && e.message);
        alert('工程文件打开失败：' + (e && e.message));
        return false;
      }
    },

    /* ---------- 自动草稿 ---------- */

    _draftTimer: 0,
    /** 历史提交后调用：防抖写草稿（避免频繁序列化大文档） */
    scheduleDraft() {
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => {
        this._draftTimer = 0;
        draftPut(JSON.stringify(serialize()));
      }, DRAFT_DEBOUNCE);
    },

    clearDraft() {
      clearTimeout(this._draftTimer);
      this._draftTimer = 0;
      draftDel();
    },

    /** 启动时检测草稿并询问恢复（由 main.init 调用） */
    async checkDraftOnStartup() {
      const json = await draftGet();
      if (!json) return;
      let data;
      try { data = JSON.parse(json); } catch (e) { draftDel(); return; }
      if (!data || data.format !== FORMAT) { draftDel(); return; }
      // 与初始空白文档相同（仅 1 层空背景）则不值得恢复
      if ((data.layers || []).length === 1 && !data.layers[0].mask && !data.layers[0].text) {
        const only = data.layers[0];
        if (only.name === '背景' || only.name === '图层 1') { draftDel(); return; }
      }

      const d = new Date(data.savedAt || Date.now());
      const restore = await PL.modal.open({
        title: '发现未保存的草稿',
        fields: [{
          type: 'static',
          html: `<p class="tip">检测到 ${d.toLocaleString()} 的自动草稿（${data.layers.length} 个图层）。</p>
                 <p class="tip">选择「恢复」继续编辑，或「丢弃」删除草稿。</p>`,
        }],
        submitText: '恢复',
        cancelText: '丢弃',
      });
      if (restore) {
        try { await loadProject(data); } catch (e) {
          alert('草稿恢复失败：' + (e && e.message));
        }
      } else {
        draftDel();
      }
    },
  };
})();

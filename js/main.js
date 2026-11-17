/**
 * main.js —— 应用入口：文档管理、图层操作、导入导出、快捷键
 */
(function () {
  'use strict';

  const S = PL.state;

  /* ================= 图层操作 ================= */

  PL.actions = {
    addLayer() {
      const l = new PL.Layer('图层 ' + (++S.layerSeq), S.doc.width, S.doc.height);
      S.stack.add(l);
      S.activeId = l.id;
      PL.history.commit('新建图层');
      PL.refreshAll();
    },

    duplicateLayer() {
      const src = S.stack.getById(S.activeId);
      if (!src) return;
      const l = new PL.Layer(src.name + ' 副本', src.width, src.height);
      l.ctx.drawImage(src.canvas, 0, 0);
      l.visible = src.visible;
      l.opacity = src.opacity;
      l.blendMode = src.blendMode;
      S.stack.add(l, src.id); // 插到原图层之上
      S.activeId = l.id;
      PL.history.commit('复制图层');
      PL.refreshAll();
    },

    deleteLayer() {
      const l = S.stack.getById(S.activeId);
      if (!l) return;
      S.stack.remove(l.id);
      const top = S.stack.top;
      S.activeId = top ? top.id : null;
      PL.history.commit('删除图层');
      PL.refreshAll();
    },

    /** dir: +1 上移 / -1 下移 */
    moveLayer(dir) {
      const l = S.stack.getById(S.activeId);
      if (!l) return;
      if (S.stack.move(l.id, dir)) {
        PL.history.commit(dir > 0 ? '图层上移' : '图层下移');
        PL.refreshAll();
      }
    },

    mergeDown() {
      const i = S.stack.indexOfId(S.activeId);
      if (i <= 0) return; // 已是最底层
      const top = S.stack.layers[i];
      const below = S.stack.layers[i - 1];
      PL.bakeIfText(below); // 合并会向下层写入像素，下层文字需固化
      const c = below.ctx;
      c.save();
      c.globalAlpha = top.opacity;
      c.globalCompositeOperation = top.blendMode;
      if (top.visible) c.drawImage(top.canvas, 0, 0);
      c.restore();
      S.stack.remove(top.id);
      S.activeId = below.id;
      PL.history.commit('向下合并');
      PL.refreshAll();
    },
  };

  /* ================= 文档管理 ================= */

  function newDocument(width, height, bg, label) {
    S.doc.width = width;
    S.doc.height = height;
    S.stack = new PL.LayerStack();
    // 透明背景的初始层即「图层 1」，此后新建从 2 起算；否则从 1 起算
    S.layerSeq = bg == null ? 1 : 0;
    const l = new PL.Layer(bg == null ? '图层 1' : '背景', width, height,
      bg == null ? {} : { fill: bg });
    S.stack.add(l);
    S.activeId = l.id;
    S.previewFilter = '';
    S.previewLayerId = null;
    PL.compositor.resizeCanvas();
    PL.compositor.fit();
    PL.history.reset(label || '新建文档');
    PL.adjust.reset(false);
    PL.refreshAll();
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve({ img, name: file.name }); };
      img.onerror = reject;
      img.src = url;
    });
  }

  /**
   * 导入图片为图层。
   * 若文档尚未编辑过（pristine），用第一张图片的尺寸作为画布尺寸（上限 1800px）。
   */
  async function importFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;

    const loaded = [];
    for (const f of files) {
      try { loaded.push(await loadImageFile(f)); }
      catch (e) { console.warn('图片读取失败：', f.name); }
    }
    if (!loaded.length) return;

    if (S.pristine) {
      const first = loaded[0].img;
      const cap = 1800;
      const sc = Math.min(1, cap / Math.max(first.width, first.height));
      newDocument(
        Math.max(1, Math.round(first.width * sc)),
        Math.max(1, Math.round(first.height * sc)),
        null, '导入图片'
      );
    }

    loaded.forEach(({ img, name }) => {
      const base = name.replace(/\.[^.]+$/, '').slice(0, 24) || '图片';
      const l = PL.Layer.fromImage(base, img, S.doc.width, S.doc.height);
      S.stack.add(l);
      S.activeId = l.id;
    });
    S.pristine = false;
    PL.compositor.fit();
    PL.history.reset('导入图片');
    PL.refreshAll();
  }

  function exportImage(mime, ext, bgColor, quality) {
    const url = PL.compositor.flatten(mime, quality, bgColor);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    a.href = url;
    a.download = `layerpaint-${ts}.${ext}`;
    a.click();
  }

  /* ================= 工具切换 ================= */

  function setTool(tool) {
    if (PL.tools.commitTextIfEditing) PL.tools.commitTextIfEditing(); // 切工具前提交文字编辑
    S.tool = tool;
    document.querySelectorAll('#toolrail .tool').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === tool));
    // 按工具显示对应选项
    document.querySelectorAll('#optionsbar .opt').forEach(o => {
      const show = (o.dataset.show || '').split(/\s+/).includes(tool);
      o.classList.toggle('hidden', !show);
    });
    const stage = PL.compositor.stage();
    stage.style.cursor = { move: 'move', text: 'text', scale: 'default' }[tool] || 'crosshair';
    PL.compositor.clearOverlay();
    if (PL.tools.activate) PL.tools.activate(tool);
  }

  /* ================= 状态刷新 ================= */

  PL.refreshAll = function () {
    if (PL.adjust && PL.state.previewFilter) PL.adjust.onDocChanged();
    PL.compositor.render();
    if (PL.tools && PL.tools.onDocChanged) PL.tools.onDocChanged();
    PL.layerpanel.render();
    PL.updateStatus();
    PL.updateHistoryButtons();
  };

  PL.updateStatus = function () {
    document.getElementById('docInfo').textContent = `${S.doc.width} × ${S.doc.height} px`;
    document.getElementById('zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  };

  PL.updatePos = function (p) {
    document.getElementById('posInfo').textContent =
      p ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '';
  };

  PL.updateHistoryButtons = function () {
    document.getElementById('btnUndo').disabled = !PL.history.canUndo();
    document.getElementById('btnRedo').disabled = !PL.history.canRedo();
  };

  /* ================= 快捷键 ================= */

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function initKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (mod && k === 'z') {
        e.preventDefault();
        e.shiftKey ? PL.history.redo() : PL.history.undo();
        return;
      }
      if (mod && k === 'y') { e.preventDefault(); PL.history.redo(); return; }
      if (mod && k === 's') { e.preventDefault(); exportImage('image/png', 'png'); return; }
      if (mod && k === 'd') { e.preventDefault(); PL.actions.duplicateLayer(); return; }
      if (mod) return;

      if (PL.tools.drawing) return;

      const map = {
        b: 'brush', e: 'eraser', m: 'move', g: 'fill',
        r: 'rect', o: 'ellipse', t: 'text', i: 'picker', s: 'scale',
      };
      if (map[k]) { setTool(map[k]); return; }

      if (e.key === '[' || e.key === ']') {
        const el = document.getElementById('brushSize');
        el.value = Math.max(1, Math.min(300, +el.value + (e.key === ']' ? 4 : -4)));
        el.dispatchEvent(new Event('input'));
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const l = S.stack.getById(S.activeId);
        if (!l) return;
        e.preventDefault();
        PL.bakeIfText(l); // 清空像素后文字数据与像素不再对应，需固化
        l.ctx.clearRect(0, 0, l.width, l.height);
        PL.history.commit('清空图层');
        PL.refreshAll();
      }
    });
  }

  /* ================= 各模块初始化 ================= */

  function initTopbar() {
    document.getElementById('btnOpen').addEventListener('click', () =>
      document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', (e) => {
      importFiles(e.target.files);
      e.target.value = '';
    });
    document.getElementById('btnUndo').addEventListener('click', () => PL.history.undo());
    document.getElementById('btnRedo').addEventListener('click', () => PL.history.redo());
    document.getElementById('btnExportPng').addEventListener('click', () =>
      exportImage('image/png', 'png'));
    document.getElementById('btnExportJpg').addEventListener('click', () =>
      exportImage('image/jpeg', 'jpg', '#ffffff', 0.92));
    document.querySelectorAll('#toolrail .tool').forEach(b =>
      b.addEventListener('click', () => setTool(b.dataset.tool)));
  }

  function initModal() {
    const modal = document.getElementById('modalNewDoc');
    document.getElementById('btnNewDoc').addEventListener('click', () => {
      modal.classList.remove('hidden');
      document.getElementById('ndWidth').focus();
    });
    document.getElementById('ndCancel').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    document.getElementById('ndOk').addEventListener('click', () => {
      const w = Math.min(8000, Math.max(1, parseInt(document.getElementById('ndWidth').value, 10) || 1000));
      const h = Math.min(8000, Math.max(1, parseInt(document.getElementById('ndHeight').value, 10) || 660));
      const sel = document.getElementById('ndBg').value;
      const bg = sel === 'transparent' ? null : sel;
      modal.classList.add('hidden');
      newDocument(w, h, bg, '新建文档');
    });
  }

  function initOptions() {
    const o = S.toolOptions;
    const bind = (id, key, valId, fmt) => {
      const el = document.getElementById(id);
      const val = document.getElementById(valId);
      el.addEventListener('input', () => {
        const div = (key === 'hardness' || key === 'opacity') ? 100 : 1;
        o[key] = +el.value / div;
        val.textContent = fmt ? fmt(el.value) : el.value;
      });
    };
    bind('brushSize', 'size', 'brushSizeVal');
    bind('brushHardness', 'hardness', 'brushHardnessVal', v => v + '%');
    bind('toolOpacity', 'opacity', 'toolOpacityVal', v => v + '%');
    bind('fillTolerance', 'tolerance', 'fillToleranceVal');
    document.getElementById('brushColor').addEventListener('input', (e) => { o.color = e.target.value; });
    document.getElementById('shapeMode').addEventListener('change', (e) => { o.shapeMode = e.target.value; });
    document.getElementById('strokeWidth').addEventListener('input', (e) => { o.strokeWidth = +e.target.value; });
    document.getElementById('fontSize').addEventListener('input', (e) => { o.fontSize = Math.max(8, +e.target.value || 48); });
    // 缩放工具：数值缩放 / 适应画布
    [['xf50', 0.5], ['xf75', 0.75], ['xf125', 1.25], ['xf200', 2]].forEach(([id, f]) =>
      document.getElementById(id).addEventListener('click', () => PL.tools.scaleContent(f)));
    document.getElementById('xfFit').addEventListener('click', () => PL.tools.fitContent());
  }

  function initZoom() {
    document.getElementById('zoomIn').addEventListener('click', () => PL.compositor.zoomIn());
    document.getElementById('zoomOut').addEventListener('click', () => PL.compositor.zoomOut());
    document.getElementById('zoomFit').addEventListener('click', () => PL.compositor.fit());
    document.getElementById('zoom100').addEventListener('click', () => PL.compositor.setZoom(1));
    // Ctrl/⌘ + 滚轮缩放
    PL.compositor.area().addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.deltaY < 0 ? PL.compositor.zoomIn() : PL.compositor.zoomOut();
    }, { passive: false });
  }

  function initDnD() {
    // 拖拽图片文件到画布 → 作为图层导入
    const area = PL.compositor.area();
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragging'); });
    area.addEventListener('dragleave', () => area.classList.remove('dragging'));
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('dragging');
      if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });
    // 防止误拖拽时浏览器直接打开图片
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());
  }

  function init() {
    PL.compositor.init();
    PL.tools.init();
    PL.layerpanel.init();
    PL.adjust.init();

    initTopbar();
    initModal();
    initOptions();
    initZoom();
    initDnD();
    initKeyboard();

    // 初始文档：1000×660 白底
    newDocument(1000, 660, '#ffffff', '新建文档');
    setTool('brush');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

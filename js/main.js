/**
 * main.js —— 应用入口：文档管理、图层操作、导入导出、快捷键
 */
(function () {
  'use strict';

  const S = PL.state;

  /* ================= 图层操作 ================= */

  PL.actions = {
    newDocument,
    resizeDocument,

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
      l.markDirty();
      l.visible = src.visible;
      l.opacity = src.opacity;
      l.blendMode = src.blendMode;
      if (src.curves) l.curves = JSON.parse(JSON.stringify(src.curves)); // 一并复制曲线
      if (src.text) { // 文字层复制后仍是可编辑的文字层
        l.text = { ...src.text };
        l._textBox = src._textBox ? { ...src._textBox } : null;
      }
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
      below.markDirty();
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
    S.pristine = true;   // 新建文档属于「未编辑」状态：首张导入的图片可自适应画布尺寸
    PL.compositor.resizeCanvas();
    PL.compositor.fit();
    PL.history.reset(label || '新建文档');
    PL.adjust.reset(false);
    PL.refreshAll();
  }

  /**
   * 修改画布尺寸：所有图层按新尺寸重建（可等比缩放内容并居中）。
   * bg: 'keep' 保持 / 颜色值 / 'transparent'
   */
  function resizeDocument(width, height, bg, scaleContent) {
    const old = S.doc;
    const s = scaleContent ? Math.min(width / old.width, height / old.height) : 1;
    const dx = (width - old.width * s) / 2;
    const dy = (height - old.height * s) / 2;
    const activeIdx = S.stack.indexOfId(S.activeId); // 记录当前层在栈中的位置（重建后 id 会变）

    const stack = new PL.LayerStack();
    S.stack.layers.forEach(l => {
      const nl = new PL.Layer(l.name, width, height);
      nl.visible = l.visible;
      nl.opacity = l.opacity;
      nl.blendMode = l.blendMode;
      nl.ctx.drawImage(l.canvas, dx, dy, old.width * s, old.height * s);
      nl.markDirty();
      if (l.text) {
        nl.text = { ...l.text, x: l.text.x * s + dx, y: l.text.y * s + dy, fontSize: l.text.fontSize * s };
        nl._textBox = null;
      }
      if (l.curves) nl.curves = JSON.parse(JSON.stringify(l.curves)); // 保留曲线设置
      stack.layers.push(nl);
    });
    // 背景色：作为最底层新建一个背景层
    if (bg && bg !== 'keep') {
      const bgLayer = new PL.Layer('背景', width, height, bg === 'transparent' ? {} : { fill: bg });
      bgLayer.markDirty();
      stack.layers.unshift(bgLayer);
    }
    S.doc.width = width;
    S.doc.height = height;
    S.stack = stack;
    // 保持选中原来的那一层（按位置对应，而非按 id —— 重建后 id 已改变）
    const kept = activeIdx >= 0 ? stack.layers[activeIdx + (bg && bg !== 'keep' ? 1 : 0)] : null;
    S.activeId = kept ? kept.id : (stack.top ? stack.top.id : null);
    PL.compositor.resizeCanvas();
    PL.compositor.fit();
    PL.history.commit('调整文档尺寸');
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
    PL.compositor.fit();
    PL.history.reset('导入图片');
    // 导入后文档已「编辑过」：必须在 history.reset 之后设置，
    // 否则下一次导入会误判为首次导入而重建文档、清空已有图层。
    S.pristine = false;
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
    // 按工具显示对应选项（未标记 data-show 的常驻显示）
    document.querySelectorAll('#optionsbar .opt').forEach(o => {
      const list = o.dataset.show;
      const show = list === undefined ? true : list.split(/\s+/).includes(tool);
      o.classList.toggle('hidden', !show);
    });
    const stage = PL.compositor.stage();
    stage.style.cursor = PL.state.spacePan ? 'grab' : PL.cursorFor(tool);
    PL.compositor.clearOverlay();
    if (PL.tools.activate) PL.tools.activate(tool);
  }

  /* ================= 状态刷新 ================= */

  PL.refreshAll = function () {
    if (PL.adjust && PL.state.previewFilter) PL.adjust.onDocChanged();
    PL.compositor.render();
    if (PL.tools && PL.tools.onDocChanged) PL.tools.onDocChanged();
    PL.layerpanel.render();
    if (PL.curves) PL.curves.refresh(); // 曲线面板跟随图层变化
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
      // 弹框打开时只处理 Esc，避免误触发工具快捷键
      const adjCurOpen = PL.adjCur ? PL.adjCur.isOpen() : false;
      if (adjCurOpen || (PL.modal && PL.modal.isOpen())) {
        if (e.key === 'Escape') {
          if (adjCurOpen) PL.adjCur.close();
          else if (PL.modal) PL.modal.cancel();
        }
        return;
      }
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
        r: 'rect', o: 'ellipse', t: 'text', i: 'picker', s: 'scale', h: 'pan',
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
        l.markDirty();
        PL.history.commit('清空图层');
        PL.refreshAll();
      }
    });

    // 空格 + 拖动 = 临时平移画布（任意工具下）
    const toolCursor = () => PL.cursorFor(S.tool);
    const setSpacePan = (on) => {
      S.spacePan = on;
      if (!PL.tools.drawing) PL.compositor.stage().style.cursor = on ? 'grab' : toolCursor();
    };
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTyping(e)) return;
      if ((PL.modal && PL.modal.isOpen()) || (PL.adjCur && PL.adjCur.isOpen())) return;
      if (PL.tools.drawing) return; // 正在绘制 / 变换时不平移
      if (!S.spacePan) setSpacePan(true);
      e.preventDefault(); // 阻止空格滚动页面 / 触发聚焦的按钮
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (S.spacePan) setSpacePan(false);
    });
    window.addEventListener('blur', () => { if (S.spacePan) setSpacePan(false); });
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
      PL.dialogs.openExport('png'));
    document.getElementById('btnExportJpg').addEventListener('click', () =>
      PL.dialogs.openExport('jpeg'));
    document.querySelectorAll('#toolrail .tool').forEach(b =>
      b.addEventListener('click', () => setTool(b.dataset.tool)));
  }

  function initModal() {
    // 调整 / 曲线 弹框：开关、标签切换，并在打开时屏蔽全局快捷键
    const modal = document.getElementById('adjCurModal');
    const tabAdjust = document.getElementById('tabAdjust');
    const tabCurve = document.getElementById('tabCurve');
    const adjustSection = document.getElementById('adjustpanel');
    const curveSection = document.getElementById('curvepanel');

    const setTab = (which) => {
      const isAdj = which === 'adjust';
      tabAdjust.classList.toggle('active', isAdj);
      tabCurve.classList.toggle('active', !isAdj);
      adjustSection.classList.toggle('hidden', !isAdj);
      curveSection.classList.toggle('hidden', isAdj);
      // 直方图只在曲线页签可见时统计，避免每次提交都读回整幅像素
      if (PL.curves && PL.curves.setVisible) PL.curves.setVisible(!isAdj && !modal.classList.contains('hidden'));
    };
    const open = (tab) => {
      modal.classList.remove('hidden');
      setTab(tab);
      if (tab === 'curve') PL.curves.refresh(); // 曲线画布需可见后再绘（尺寸取 clientWidth）
    };
    const close = () => {
      modal.classList.add('hidden');
      if (PL.curves && PL.curves.setVisible) PL.curves.setVisible(false);
    };

    document.getElementById('btnOpenAdjust').addEventListener('click', () => open('adjust'));
    document.getElementById('btnOpenCurve').addEventListener('click', () => open('curve'));
    tabAdjust.addEventListener('click', () => setTab('adjust'));
    tabCurve.addEventListener('click', () => setTab('curve'));
    document.getElementById('btnCloseAdjCur').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 弹框内按键不回传给全局快捷键
      if (e.key === 'Escape') close();
    });
    // 对外暴露统一接口（避免在 window 上散落全局函数）
    PL.adjCur = {
      isOpen: () => !modal.classList.contains('hidden'),
      open,
      close,
    };
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
    // 滚轮缩放：仅 Ctrl/⌘ + 滚轮触发；目标值累加 + rAF 指数缓动，缩放更慢更丝滑
    const area = PL.compositor.area();
    let targetZoom = 0, anchorX = 0, anchorY = 0, zoomRaf = 0;
    const easeZoom = () => {
      zoomRaf = 0;
      const ratio = targetZoom / PL.state.zoom;
      if (Math.abs(ratio - 1) < 0.002) {           // 足够接近则收尾
        PL.compositor.zoomTo(targetZoom, anchorX, anchorY);
        targetZoom = PL.state.zoom;
        return;
      }
      // 每帧走完剩余差距的 30%，指数逼近，观感更顺滑
      PL.compositor.zoomTo(PL.state.zoom * (1 + (ratio - 1) * 0.30), anchorX, anchorY);
      zoomRaf = requestAnimationFrame(easeZoom);
    };
    area.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;         // 直接滚轮不缩放，仅 Ctrl/⌘ + 滚轮
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // 行→像素
      anchorX = e.clientX; anchorY = e.clientY;
      if (!zoomRaf) targetZoom = PL.state.zoom;     // 新一轮动画从当前值起步
      // 每事件按滚动量连续缩放，系数远小于原来的固定 1.1，滚得慢一点
      const f = Math.exp(-delta * 0.0008);
      targetZoom = Math.min(8, Math.max(0.05, targetZoom * f));
      if (!zoomRaf) zoomRaf = requestAnimationFrame(easeZoom);
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
    PL.curves.init();
    PL.dialogs.init();

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

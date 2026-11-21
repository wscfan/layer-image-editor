/**
 * compositor.js —— 画布渲染 / 缩放 / 坐标映射 / 导出合成
 */
(function () {
  'use strict';

  const els = {};

  /* 画布屏幕矩形缓存：pointermove 中读取 getBoundingClientRect 会强制重排，
     矩形只在画布尺寸 / 缩放 / 平移变化后失效。 */
  let rectCache = null;
  function stageRect() {
    if (!rectCache && els.stage) rectCache = els.stage.getBoundingClientRect();
    return rectCache;
  }
  function invalidateRect() { rectCache = null; }

  /* ================= 蒙版 → alpha 转换与显示源缓存 ================= */

  // 蒙版是「不透明灰度画布」（白=显示/黑=隐藏）。合成需要的是 alpha 遮罩：
  // 把灰度搬到 alpha 通道（destination-in 用源 alpha 参与混合）。
  let maskAlphaCache = { key: null, canvas: null };

  function maskAlpha(layer) {
    const key = layer.id + ':' + (layer._maskVersion || 0);
    if (maskAlphaCache.key === key && maskAlphaCache.canvas) return maskAlphaCache.canvas;
    const c = document.createElement('canvas');
    c.width = layer.width;
    c.height = layer.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(layer.mask, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = d[i];                        // 先取出灰度（蒙版只画灰色，R 即灰度）
      d[i] = d[i + 1] = d[i + 2] = 255;      // 颜色无关紧要，只看 alpha
      d[i + 3] = g;                          // 灰度 → 可见度
    }
    x.putImageData(img, 0, 0);
    maskAlphaCache = { key, canvas: c };
    return c;
  }

  // 「显示源」链：图层像素 →（曲线）→（蒙版）。结果按 id:pxv:curveV:maskV:enabled 缓存。
  let dispCache = { key: null, canvas: null };

  function displayCanvas(l) {
    const hasCurve = PL.curves && PL.curves.hasCurves(l);
    const masked = !!(l.mask && l.maskEnabled !== false);
    if (!masked) return hasCurve ? PL.curves.previewCanvas(l) : l.canvas;
    const key = [l.id, l._pxv || 0, hasCurve ? l._curveVersion || 0 : '-',
      l._maskVersion || 0, l.maskEnabled !== false ? 1 : 0].join(':');
    if (dispCache.key === key && dispCache.canvas) return dispCache.canvas;
    const base = hasCurve ? PL.curves.previewCanvas(l) : l.canvas;
    const c = document.createElement('canvas');
    c.width = l.width;
    c.height = l.height;
    const x = c.getContext('2d');
    x.drawImage(base, 0, 0);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(maskAlpha(l), 0, 0);
    dispCache = { key, canvas: c };
    return c;
  }

  PL.compositor = {
    init() {
      els.stage = document.getElementById('stage');
      els.overlay = document.getElementById('overlay');
      els.area = document.getElementById('canvasarea');
      els.stagewrap = document.getElementById('stagewrap');
      els.stageCtx = els.stage.getContext('2d');
      els.overlayCtx = els.overlay.getContext('2d');
    },

    /** 文档尺寸变化时，重设主画布与覆盖层画布 */
    resizeCanvas() {
      const d = PL.state.doc;
      els.stage.width = d.width;
      els.stage.height = d.height;
      els.overlay.width = d.width;
      els.overlay.height = d.height;
      invalidateRect();
    },

    setZoom(z) {
      PL.state.zoom = Math.min(8, Math.max(0.05, z));
      this.applyZoom();
    },
    zoomIn() { this.setZoom(PL.state.zoom * 1.25); },
    zoomOut() { this.setZoom(PL.state.zoom / 1.25); },

    /** 按当前缩放比设置画布 CSS 尺寸（位图尺寸不变） */
    applyZoom() {
      const z = PL.state.zoom, d = PL.state.doc;
      els.stage.style.width = (d.width * z) + 'px';
      els.stage.style.height = (d.height * z) + 'px';
      els.overlay.style.width = els.stage.style.width;
      els.overlay.style.height = els.stage.style.height;
      invalidateRect();
      this.applyPan();
      if (PL.updateStatus) PL.updateStatus();
      if (PL.tools && PL.tools.onZoomChanged) PL.tools.onZoomChanged();
    },

    /** 应用平移：在居中基础上再平移 pan 像素（transform 承载，两图层一起移动） */
    applyPan() {
      if (!els.stagewrap) return;
      const p = PL.state.pan;
      els.stagewrap.style.transform =
        `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`;
      invalidateRect();
    },

    /** 把缩放设为绝对值 z1，并保持屏幕坐标 (clientX, clientY) 下的画面点不动 */
    zoomTo(z1, clientX, clientY) {
      const d = PL.state.doc;
      const z0 = PL.state.zoom;
      z1 = Math.min(8, Math.max(0.05, z1));
      if (z1 === z0 || !d.width || !d.height) return;
      const r = els.area.getBoundingClientRect();
      const pan = PL.state.pan;
      const areaCx = r.left + r.width / 2;
      const areaCy = r.top + r.height / 2;
      const W0 = d.width * z0, H0 = d.height * z0;
      const W1 = d.width * z1, H1 = d.height * z1;
      // 旧画布左上角（居中 + pan）
      const left0 = areaCx + pan.x - W0 / 2;
      const top0 = areaCy + pan.y - H0 / 2;
      // 光标相对画布的归一化位置
      const u = (clientX - left0) / W0;
      const v = (clientY - top0) / H0;
      // 缩放后让同一归一化点仍停留在光标下
      const left1 = clientX - u * W1;
      const top1 = clientY - v * H1;
      pan.x = left1 - areaCx + W1 / 2;
      pan.y = top1 - areaCy + H1 / 2;
      PL.state.zoom = z1;
      this.applyZoom();
    },

    /** 以当前缩放乘以 factor，并以 (clientX, clientY) 为锚点 */
    zoomAt(factor, clientX, clientY) {
      this.zoomTo(PL.state.zoom * factor, clientX, clientY);
    },

    /** 适应窗口 */
    fit() {
      const d = PL.state.doc;
      const pad = 60;
      const zw = (els.area.clientWidth - pad) / d.width;
      const zh = (els.area.clientHeight - pad) / d.height;
      PL.state.pan.x = 0;
      PL.state.pan.y = 0;
      this.setZoom(Math.max(0.05, Math.min(zw, zh)));
    },

    /** 核心：把所有可见图层按 底→顶 合成到主画布。
     *  普通调用走 rAF 合并：同一帧内多次 render 只合成一次，
     *  避免高频率手势（拖笔画/移动/缩放）每帧全量重绘。
     */
    render() {
      if (this._rafReq) return;   // 本帧已排队
      this._rafReq = requestAnimationFrame(() => {
        this._rafReq = null;
        this.renderSync();
      });
    },

    /** 同步渲染：立即合成到主画布（并清掉未执行的 rAF 队列） */
    renderSync() {
      this._rafReq = null;
      const s = PL.state, ctx = els.stageCtx, d = s.doc;
      ctx.clearRect(0, 0, d.width, d.height);
      for (const l of s.stack.layers) {
        if (!l.visible) continue;
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = l.blendMode;
        // 调整面板的实时预览：只作用于当前图层。
        // ctx.filter 是持久状态，必须逐层显式赋值，否则会「漏」到上方的图层。
        ctx.filter = (s.previewFilter && l.id === s.previewLayerId) ? s.previewFilter : 'none';
        // 显示源 = 像素 →（曲线）→（蒙版）
        ctx.drawImage(displayCanvas(l), 0, 0);
      }
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },

    clearOverlay() {
      els.overlayCtx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    },

    /** 屏幕事件坐标 → 文档坐标（与缩放无关，按比例换算） */
    toDoc(e) {
      // 矩形缓存：高频 pointermove 中读取 getBoundingClientRect 会强制重排，
      // 仅在画布尺寸/缩放/平移变化后失效。
      const r = stageRect() || els.stage.getBoundingClientRect();
      const d = PL.state.doc;
      return {
        x: (e.clientX - r.left) / r.width * d.width,
        y: (e.clientY - r.top) / r.height * d.height,
      };
    },

    /** 拍平可见图层，用于导出（bgColor 用于 JPG 等不支持透明的格式；scale 为输出缩放） */
    flatten(mime, quality, bgColor, scale = 1) {
      const d = PL.state.doc;
      const w = Math.max(1, Math.round(d.width * scale));
      const h = Math.max(1, Math.round(d.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (bgColor) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, w, h);
      }
      for (const l of PL.state.stack.layers) {
        if (!l.visible) continue;
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = l.blendMode;
        ctx.drawImage(displayCanvas(l), 0, 0, w, h);
      }
      return c.toDataURL(mime, quality);
    },

    stage() { return els.stage; },
    overlayCtx() { return els.overlayCtx; },
    area() { return els.area; },
    /** 图层的显示源（像素→曲线→蒙版），供合并等需要取最终外观的场景使用 */
    displayCanvas(l) { return displayCanvas(l); },
    /** 只应用蒙版（不含曲线）的结果 —— 用于把蒙版固化进像素 */
    maskedPixels(l) {
      if (!l.mask) return l.canvas;
      const c = document.createElement('canvas');
      c.width = l.width;
      c.height = l.height;
      const x = c.getContext('2d');
      x.drawImage(l.canvas, 0, 0);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(maskAlpha(l), 0, 0);
      return c;
    },
  };

  PL.render = () => PL.compositor.render();
})();

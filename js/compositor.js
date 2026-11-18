/**
 * compositor.js —— 画布渲染 / 缩放 / 坐标映射 / 导出合成
 */
(function () {
  'use strict';

  const els = {};

  PL.compositor = {
    init() {
      els.stage = document.getElementById('stage');
      els.overlay = document.getElementById('overlay');
      els.area = document.getElementById('canvasarea');
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
      if (PL.updateStatus) PL.updateStatus();
      if (PL.tools && PL.tools.onZoomChanged) PL.tools.onZoomChanged();
    },

    /** 适应窗口 */
    fit() {
      const d = PL.state.doc;
      const pad = 60;
      const zw = (els.area.clientWidth - pad) / d.width;
      const zh = (els.area.clientHeight - pad) / d.height;
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
        // 调整面板的实时预览：只作用于当前图层
        if (s.previewFilter && l.id === s.previewLayerId) ctx.filter = s.previewFilter;
        // 曲线：图层带曲线时用经过 LUT 的画布
        const src = (PL.curves && PL.curves.hasCurves(l))
          ? PL.curves.previewCanvas(l)
          : l.canvas;
        ctx.drawImage(src, 0, 0);
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
      const r = els.stage.getBoundingClientRect();
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
        const src = (PL.curves && PL.curves.hasCurves(l))
          ? PL.curves.previewCanvas(l)
          : l.canvas;
        ctx.drawImage(src, 0, 0, w, h);
      }
      return c.toDataURL(mime, quality);
    },

    stage() { return els.stage; },
    overlayCtx() { return els.overlayCtx; },
    area() { return els.area; },
  };

  PL.render = () => PL.compositor.render();
})();

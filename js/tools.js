/**
 * tools.js —— 绘图工具与指针交互
 *
 * 画笔/橡皮采用「离屏笔迹缓冲」：印章以全不透明度画进缓冲，
 * 每次移动把 缓冲按工具不透明度 一次性合成回图层，
 * 保证单笔不透明度均匀（避免重叠印章反复叠加）。
 */
(function () {
  'use strict';

  /** 进行中的操作状态 */
  const T = {
    drawing: false,
    stroke: null,  // 画笔 / 橡皮
    shape: null,   // 矩形 / 椭圆
    moveOp: null,  // 移动图层
  };

  /* ================= 小工具函数 ================= */

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbaStr(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** 取当前图层；若文档没有任何图层且是绘制类操作，则自动新建一层 */
  function activeLayerForPainting() {
    const s = PL.state;
    let l = s.stack.getById(s.activeId);
    if (!l) {
      l = new PL.Layer('图层 ' + Math.max(1, ++s.layerSeq), s.doc.width, s.doc.height);
      s.stack.add(l);
      s.activeId = l.id;
      PL.history.commit('新建图层');
      PL.layerpanel.render();
    }
    return l;
  }

  /* ================= 画笔 / 橡皮 ================= */

  /** 盖一个印章（径向渐变实现软边） */
  function stamp(ctx, x, y, size, color, hardness) {
    const r = Math.max(0.5, size / 2);
    if (hardness >= 0.98) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgbaStr(color, 1));
    g.addColorStop(Math.max(0.01, hardness), rgbaStr(color, 1));
    g.addColorStop(1, rgbaStr(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 沿路径以固定间距盖章 */
  function stampLine(ctx, from, to, o) {
    stamp(ctx, from.x, from.y, o.size, o.color, o.hardness);
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return;
    const step = Math.max(0.8, o.size * 0.12);
    const n = Math.ceil(dist / step);
    for (let i = 1; i <= n; i++) {
      stamp(ctx, from.x + dx * i / n, from.y + dy * i / n, o.size, o.color, o.hardness);
    }
  }

  function beginStroke(layer, p) {
    const buf = document.createElement('canvas');
    buf.width = layer.width;
    buf.height = layer.height;
    T.stroke = {
      layer,
      erase: PL.state.tool === 'eraser',
      base: layer.clonePixels(), // 笔画开始前的图层基线
      buf,
      bufCtx: buf.getContext('2d'),
      last: p,
    };
    stampLine(T.stroke.bufCtx, p, p, PL.state.toolOptions);
    compositeStroke();
    T.drawing = true;
  }

  function moveStroke(p) {
    stampLine(T.stroke.bufCtx, T.stroke.last, p, PL.state.toolOptions);
    T.stroke.last = p;
    compositeStroke();
  }

  /** 基线 + 笔迹缓冲 → 图层（橡皮用 destination-out 抠除） */
  function compositeStroke() {
    const { layer, base, buf, erase } = T.stroke;
    const o = PL.state.toolOptions;
    const c = layer.ctx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.drawImage(base, 0, 0);
    c.globalAlpha = o.opacity;
    c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    c.drawImage(buf, 0, 0);
    c.restore();
    PL.render();
  }

  function endStroke() {
    const erase = T.stroke.erase;
    T.stroke = null;
    T.drawing = false;
    PL.history.commit(erase ? '橡皮擦' : '画笔');
    PL.refreshAll();
  }

  /* ================= 移动图层 ================= */

  function beginMove(layer, p) {
    T.moveOp = { layer, base: layer.clonePixels(), start: p };
    T.drawing = true;
  }

  function doMove(p) {
    const { layer, base, start } = T.moveOp;
    const dx = Math.round(p.x - start.x);
    const dy = Math.round(p.y - start.y);
    const c = layer.ctx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.drawImage(base, dx, dy);
    c.restore();
    PL.render();
  }

  /* ================= 矩形 / 椭圆 ================= */

  /** 由起点/当前点得到归一化矩形；square 时约束为正方形 */
  function shapeRect(a, b, square) {
    let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    if (square) {
      const s = Math.max(w, h);
      const sx = b.x >= a.x ? 1 : -1, sy = b.y >= a.y ? 1 : -1;
      x = Math.min(a.x, a.x + sx * s);
      y = Math.min(a.y, a.y + sy * s);
      w = h = s;
    }
    return { x, y, w, h };
  }

  /** 在覆盖层上画形状预览（虚线框） */
  function drawShapePreview() {
    const ctx = PL.compositor.overlayCtx();
    PL.compositor.clearOverlay();
    const { start, cur, shift } = T.shape;
    const r = shapeRect(start, cur, shift);
    const z = PL.state.zoom;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 1.2 / z);
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.beginPath();
    if (PL.state.tool === 'rect') ctx.rect(r.x, r.y, r.w, r.h);
    else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function commitShape() {
    const layer = T.shape.layer;
    const r = shapeRect(T.shape.start, T.shape.cur, T.shape.shift);
    PL.compositor.clearOverlay();
    T.shape = null;
    T.drawing = false;
    if (r.w < 1 || r.h < 1) return; // 误点，不产生历史
    const o = PL.state.toolOptions;
    const c = layer.ctx;
    c.save();
    c.globalAlpha = o.opacity;
    c.fillStyle = o.color;
    c.strokeStyle = o.color;
    c.lineWidth = o.strokeWidth;
    c.beginPath();
    if (PL.state.tool === 'rect') c.rect(r.x, r.y, r.w, r.h);
    else c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    if (o.shapeMode === 'stroke') c.stroke();
    else c.fill();
    c.restore();
    PL.history.commit('绘制形状');
    PL.refreshAll();
  }

  /* ================= 油漆桶（扫描线泛洪填充） ================= */

  /**
   * @returns {boolean} 是否实际修改了像素（未修改则不入撤销历史）
   */
  function floodFill(layer, p) {
    const w = layer.width, h = layer.height;
    const sx = Math.floor(p.x), sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
    const o = PL.state.toolOptions;
    const tol = o.tolerance;
    const [fr, fg, fb] = hexToRgb(o.color);
    const ctx = layer.ctx;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const si = (sy * w + sx) * 4;
    const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
    if (tr === fr && tg === fg && tb === fb && ta === 255) return false;
    const visited = new Uint8Array(w * h);
    const stack = [sy * w + sx];
    while (stack.length) {
      const pi = stack.pop();
      if (visited[pi]) continue;
      const i = pi * 4;
      if (Math.abs(d[i] - tr) > tol || Math.abs(d[i + 1] - tg) > tol ||
          Math.abs(d[i + 2] - tb) > tol || Math.abs(d[i + 3] - ta) > tol) continue;
      visited[pi] = 1;
      d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
      const x = pi % w, y = (pi / w) | 0;
      if (x > 0) stack.push(pi - 1);
      if (x < w - 1) stack.push(pi + 1);
      if (y > 0) stack.push(pi - w);
      if (y < h - 1) stack.push(pi + w);
    }
    ctx.putImageData(img, 0, 0);
    return true;
  }

  /* ================= 文字 / 吸管 ================= */

  function drawText(layer, p) {
    const o = PL.state.toolOptions;
    if (!o.text.trim()) return;
    const c = layer.ctx;
    c.save();
    c.globalAlpha = o.opacity;
    c.fillStyle = o.color;
    c.font = `600 ${o.fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.textBaseline = 'top';
    c.fillText(o.text, p.x, p.y);
    c.restore();
    PL.history.commit('添加文字');
    PL.refreshAll();
  }

  /** 从合成结果取色 */
  function pickColor(p) {
    const stage = PL.compositor.stage();
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= stage.width || y >= stage.height) return;
    const d = stage.getContext('2d').getImageData(x, y, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    PL.state.toolOptions.color = hex;
    const el = document.getElementById('brushColor');
    if (el) el.value = hex;
  }

  /* ================= 笔刷光标预览 ================= */

  function drawBrushCursor(p) {
    const ctx = PL.compositor.overlayCtx();
    PL.compositor.clearOverlay();
    const r = Math.max(1, PL.state.toolOptions.size / 2);
    const z = PL.state.zoom;
    ctx.save();
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 1 / z, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* ================= 指针事件 ================= */

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const s = PL.state;
    const p = PL.compositor.toDoc(e);
    const tool = s.tool;

    if (tool === 'picker') { pickColor(p); return; }

    if (tool === 'fill') {
      const layer = activeLayerForPainting();
      if (!floodFill(layer, p)) return;
      PL.history.commit('油漆桶填充');
      PL.refreshAll();
      return;
    }

    if (tool === 'text') {
      drawText(activeLayerForPainting(), p);
      return;
    }

    if (tool === 'move') {
      const layer = s.stack.getById(s.activeId);
      if (!layer) return;
      beginMove(layer, p);
      e.target.setPointerCapture(e.pointerId);
      return;
    }

    if (tool === 'rect' || tool === 'ellipse') {
      T.shape = { layer: activeLayerForPainting(), start: p, cur: p, shift: e.shiftKey };
      T.drawing = true;
      e.target.setPointerCapture(e.pointerId);
      drawShapePreview();
      return;
    }

    if (tool === 'brush' || tool === 'eraser') {
      beginStroke(activeLayerForPainting(), p);
      e.target.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e) {
    const p = PL.compositor.toDoc(e);
    if (PL.updatePos) PL.updatePos(p);
    const s = PL.state;

    if (!T.drawing) {
      if (s.tool === 'brush' || s.tool === 'eraser') drawBrushCursor(p);
      return;
    }
    if (T.stroke) {
      moveStroke(p);
      drawBrushCursor(p);
    } else if (T.shape) {
      T.shape.cur = p;
      T.shape.shift = e.shiftKey;
      drawShapePreview();
    } else if (T.moveOp) {
      doMove(p);
    }
  }

  function onPointerUp() {
    if (T.stroke) {
      endStroke();
    } else if (T.shape) {
      commitShape();
    } else if (T.moveOp) {
      T.moveOp = null;
      T.drawing = false;
      PL.history.commit('移动图层');
      PL.refreshAll();
    }
  }

  /* ================= 导出 ================= */

  PL.tools = {
    get drawing() { return T.drawing; },

    init() {
      const stage = PL.compositor.stage();
      stage.addEventListener('pointerdown', onPointerDown);
      stage.addEventListener('pointermove', onPointerMove);
      stage.addEventListener('pointerup', onPointerUp);
      stage.addEventListener('pointercancel', onPointerUp);
      stage.addEventListener('pointerleave', () => {
        if (!T.drawing) PL.compositor.clearOverlay();
        if (PL.updatePos) PL.updatePos(null);
      });
    },
  };
})();

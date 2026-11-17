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
    xform: null,   // 缩放 / 变换
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

  /**
   * 在覆盖层上实时预览形状：按当前颜色/样式/不透明度绘制真实效果，
   * 叠加虚线边界与尺寸提示（尺寸文字在屏幕上恒定大小，不受缩放影响）。
   */
  function drawShapePreview() {
    const ctx = PL.compositor.overlayCtx();
    PL.compositor.clearOverlay();
    const { start, cur, shift } = T.shape;
    const r = shapeRect(start, cur, shift);
    if (r.w < 0.5 && r.h < 0.5) return; // 尚未拖出形状
    const o = PL.state.toolOptions;
    const z = PL.state.zoom;
    ctx.save();
    // 1) 实际效果：与 commitShape 完全一致的填充/描边
    ctx.globalAlpha = o.opacity;
    ctx.fillStyle = o.color;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = o.strokeWidth;
    ctx.beginPath();
    if (PL.state.tool === 'rect') ctx.rect(r.x, r.y, r.w, r.h);
    else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    if (o.shapeMode === 'stroke') ctx.stroke();
    else ctx.fill();
    // 2) 虚线边界（复用同一路径），便于观察位置与大小
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 1.2 / z);
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.stroke();
    // 3) 尺寸提示
    ctx.setLineDash([]);
    ctx.font = `${12 / z}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.8)';
    ctx.shadowBlur = 2 / z;
    ctx.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}`, r.x, Math.max(14 / z, r.y - 6 / z));
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

  /* ================= 缩放 / 变换（编辑打开图片的大小） ================= */

  const HANDLE_KEYS = ['nw', 'ne', 'sw', 'se'];
  const resizeCursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

  function cornerOf(box, handle) {
    switch (handle) {
      case 'nw': return { x: box.x, y: box.y };
      case 'ne': return { x: box.x + box.w, y: box.y };
      case 'sw': return { x: box.x, y: box.y + box.h };
      default:   return { x: box.x + box.w, y: box.y + box.h };
    }
  }

  function oppositeHandle(h) { return { nw: 'se', se: 'nw', ne: 'sw', sw: 'ne' }[h]; }

  /** 计算图层不透明内容的包围盒（alpha > 0），空图层返回 null */
  function getContentBBox(layer) {
    const w = layer.width, h = layer.height;
    const d = layer.ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  let bboxCache = null; // { layerId, box }，像素变化由 onDocChanged 强制刷新

  function activeLayer() {
    return PL.state.stack ? PL.state.stack.getById(PL.state.activeId) : null;
  }

  /** 取当前图层内容包围盒（按图层缓存） */
  function refreshBBox(force) {
    const l = activeLayer();
    if (!l) { bboxCache = null; return null; }
    if (!force && bboxCache && bboxCache.layerId === l.id) return bboxCache.box;
    const box = getContentBBox(l);
    bboxCache = { layerId: l.id, box };
    return box;
  }

  /** 命中检测：是否点在手柄上（命中半径为屏幕 10px） */
  function hitHandle(p, box) {
    if (!box) return null;
    const r = 10 / PL.state.zoom;
    for (const k of HANDLE_KEYS) {
      const c = cornerOf(box, k);
      if (Math.abs(p.x - c.x) <= r && Math.abs(p.y - c.y) <= r) return k;
    }
    return null;
  }

  /** 把 base 像素以 (ax,ay) 为锚点缩放 fx/fy 倍（可选平移 dx,dy）画回图层 */
  function applyScaleAbout(layer, base, fx, fy, ax, ay, dx = 0, dy = 0) {
    const c = layer.ctx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.setTransform(fx, 0, 0, fy, ax - fx * ax + dx, ay - fy * ay + dy);
    c.drawImage(base, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.restore();
    PL.render();
  }

  function updateXformSizeLabel(box) {
    const el = document.getElementById('xformSize');
    if (el) el.textContent = box ? `${Math.round(box.w)} × ${Math.round(box.h)} px` : '空';
  }

  /** 变换框 + 四角手柄 + 尺寸提示 */
  function drawXformUI(box) {
    const ctx = PL.compositor.overlayCtx();
    PL.compositor.clearOverlay();
    updateXformSizeLabel(box);
    if (!box) return;
    const z = PL.state.zoom;
    ctx.save();
    // 虚线边框
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 1.2 / z);
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    // 四角手柄
    ctx.setLineDash([]);
    ctx.lineWidth = 1 / z;
    const s = 9 / z;
    for (const k of HANDLE_KEYS) {
      const c = cornerOf(box, k);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.fillRect(c.x - s / 2, c.y - s / 2, s, s);
      ctx.strokeRect(c.x - s / 2, c.y - s / 2, s, s);
    }
    // 尺寸提示
    ctx.font = `${12 / z}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.8)';
    ctx.shadowBlur = 2 / z;
    ctx.fillText(`${Math.round(box.w)} × ${Math.round(box.h)}`, box.x, Math.max(16 / z, box.y - 6 / z));
    ctx.restore();
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

    if (tool === 'scale') {
      const layer = s.stack.getById(s.activeId);
      if (!layer) return;
      const box = refreshBBox(true); // 按下时取最新包围盒
      if (!box) return;              // 空图层没有可变换的内容
      T.xform = {
        layer,
        base: layer.clonePixels(),
        startBox: box,
        handle: hitHandle(p, box), // null = 拖内容移动
        start: p,
      };
      T.drawing = true;
      e.target.setPointerCapture(e.pointerId);
      drawXformUI(box);
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
      if (s.tool === 'brush' || s.tool === 'eraser') {
        drawBrushCursor(p);
      } else if (s.tool === 'scale') {
        // 悬停：显示变换框并根据位置切换光标
        const box = refreshBBox();
        drawXformUI(box);
        const h = hitHandle(p, box);
        const stage = PL.compositor.stage();
        if (h) stage.style.cursor = resizeCursors[h];
        else stage.style.cursor = box && p.x >= box.x && p.x <= box.x + box.w &&
          p.y >= box.y && p.y <= box.y + box.h ? 'move' : 'default';
      }
      return;
    }
    if (T.stroke) {
      moveStroke(p);
      drawBrushCursor(p);
    } else if (T.shape) {
      T.shape.cur = p;
      T.shape.shift = e.shiftKey;
      drawShapePreview();
    } else if (T.xform) {
      const xf = T.xform;
      if (!xf.handle) {
        // 拖内容中间：移动
        const dx = Math.round(p.x - xf.start.x);
        const dy = Math.round(p.y - xf.start.y);
        applyScaleAbout(xf.layer, xf.base, 1, 1, 0, 0, dx, dy);
        drawXformUI({ x: xf.startBox.x + dx, y: xf.startBox.y + dy, w: xf.startBox.w, h: xf.startBox.h });
      } else {
        // 拖角：默认等比缩放（以对角为锚点），Shift = 自由拉伸
        const a = cornerOf(xf.startBox, oppositeHandle(xf.handle));
        let fx, fy;
        if (e.shiftKey) {
          fx = Math.max(1, Math.abs(p.x - a.x)) / xf.startBox.w;
          fy = Math.max(1, Math.abs(p.y - a.y)) / xf.startBox.h;
        } else {
          const c0 = cornerOf(xf.startBox, xf.handle);
          const f = Math.hypot(p.x - a.x, p.y - a.y) /
            Math.max(1e-6, Math.hypot(c0.x - a.x, c0.y - a.y));
          fx = fy = Math.max(f, 1 / Math.max(xf.startBox.w, xf.startBox.h)); // 最小缩到 1px
        }
        applyScaleAbout(xf.layer, xf.base, fx, fy, a.x, a.y);
        // 变换后的框（用于 UI 显示）
        const nb = { w: xf.startBox.w * fx, h: xf.startBox.h * fy };
        nb.x = a.x === xf.startBox.x ? a.x : a.x - nb.w;
        nb.y = a.y === xf.startBox.y ? a.y : a.y - nb.h;
        drawXformUI(nb);
      }
    } else if (T.moveOp) {
      doMove(p);
    }
  }

  function onPointerUp() {
    if (T.stroke) {
      endStroke();
    } else if (T.shape) {
      commitShape();
    } else if (T.xform) {
      const label = T.xform.handle ? '缩放图层' : '移动图层';
      T.xform = null;
      T.drawing = false;
      PL.history.commit(label);
      PL.refreshAll(); // onDocChanged 会刷新包围盒与变换框
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

    /** 切换到某工具时由 main.setTool 调用 */
    activate(tool) {
      if (tool === 'scale') drawXformUI(refreshBBox(true));
    },

    /** 文档/图层变化（提交、撤销等）后由 refreshAll 调用 */
    onDocChanged() {
      if (PL.state.tool === 'scale') drawXformUI(refreshBBox(true));
    },

    /** 数值缩放当前图层内容（关于内容中心，立即生效） */
    scaleContent(f) {
      const l = activeLayer();
      if (!l) return;
      const box = refreshBBox(true);
      if (!box) return;
      applyScaleAbout(l, l.clonePixels(), f, f, box.x + box.w / 2, box.y + box.h / 2);
      PL.history.commit('缩放 ' + Math.round(f * 100) + '%');
      PL.refreshAll();
    },

    /** 等比缩放内容并居中铺满画布 */
    fitContent() {
      const l = activeLayer();
      if (!l) return;
      const box = refreshBBox(true);
      if (!box) return;
      const d = PL.state.doc;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const f = Math.min(d.width / box.w, d.height / box.h);
      applyScaleAbout(l, l.clonePixels(), f, f, cx, cy, d.width / 2 - cx, d.height / 2 - cy);
      PL.history.commit('内容适应画布');
      PL.refreshAll();
    },

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

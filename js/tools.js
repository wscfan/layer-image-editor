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
    pan: null,     // 画布平移（抓手工具）
  };

  const STAMP_SPACING_RATIO = 0.12;  // 印章间距 = 笔刷直径 × 该比例

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

  /** 选中图层并刷新面板（供文字编辑等使用） */
  function selectLayerById(id) {
    PL.state.activeId = id;
    PL.layerpanel.render();
  }

  function teLayerId(te) { return te.layer ? te.layer.id : null; }

  /** 颜色 → 等亮度的灰度（蒙版只认灰度：白=显示，黑=隐藏） */
  function grayHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const v = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const h = v.toString(16).padStart(2, '0');
    return '#' + h + h + h;
  }

  /**
   * 当前绘制目标：处于蒙版编辑态（state.maskEditId === 图层 id 且图层有蒙版）时
   * 画笔/橡皮/油漆桶/形状 画进蒙版，否则画进图层像素。
   */
  function paintTarget(layer) {
    const s = PL.state;
    if (layer && layer.mask && s.maskEditId === layer.id) {
      return { ctx: layer.maskCtx, isMask: true };
    }
    return { ctx: layer.ctx, isMask: false };
  }

  /* ================= 画笔 / 橡皮 ================= */

  /**
   * 笔尖预渲染缓存：把「圆形软边笔尖」预渲染成小图，绘制时直接 drawImage。
   * 避免每个印章都 createRadialGradient（长笔画 + 大笔刷时是成千上万次对象分配）。
   */
  let tipCache = { key: null, canvas: null };

  function brushTip(size, hardness, color) {
    const key = size + '|' + hardness.toFixed(3) + '|' + color;
    if (tipCache.key === key) return tipCache.canvas;
    const r = Math.max(0.5, size / 2);
    const s = Math.max(2, Math.ceil(r * 2) + 2);   // 画布边长（含 1px 余量）
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const g = c.getContext('2d');
    const cx = s / 2, cy = s / 2;
    if (hardness >= 0.98) {
      g.fillStyle = color;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    } else {
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, rgbaStr(color, 1));
      grd.addColorStop(Math.max(0.01, hardness), rgbaStr(color, 1));
      grd.addColorStop(1, rgbaStr(color, 0));
      g.fillStyle = grd;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
    tipCache = { key, canvas: c };
    return c;
  }

  /** 盖一个印章（复用预渲染笔尖） */
  function stamp(ctx, x, y, size, color, hardness) {
    const tip = brushTip(size, hardness, color);
    const s = tip.width;
    ctx.drawImage(tip, x - s / 2, y - s / 2);
  }

  /** 沿路径以固定间距盖章 */
  function stampLine(ctx, from, to, o) {
    stamp(ctx, from.x, from.y, o.size, o.color, o.hardness);
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return;
    const step = Math.max(0.8, o.size * STAMP_SPACING_RATIO);
    const n = Math.ceil(dist / step);
    for (let i = 1; i <= n; i++) {
      stamp(ctx, from.x + dx * i / n, from.y + dy * i / n, o.size, o.color, o.hardness);
    }
  }

  function beginStroke(layer, p) {
    const tgt = paintTarget(layer);
    if (!tgt.isMask) PL.bakeIfText(layer); // 画笔/橡皮直接改像素，文字图层需固化（蒙版目标不影响文字）
    const buf = document.createElement('canvas');
    buf.width = layer.width;
    buf.height = layer.height;
    // 蒙版目标：颜色转灰度；橡皮在蒙版上 = 画黑（隐藏）。
    // 蒙版始终用 source-over（保持不透明灰度画布的不变量），
    // destination-out 会把画布擦透明，破坏蒙版语义。
    const o = PL.state.toolOptions;
    const color = tgt.isMask
      ? (PL.state.tool === 'eraser' ? '#000000' : grayHex(o.color))
      : o.color;
    T.stroke = {
      layer,
      erase: PL.state.tool === 'eraser',
      base: tgt.isMask ? layer.cloneMask() : layer.clonePixels(), // 笔画开始前的目标基线
      buf,
      bufCtx: buf.getContext('2d'),
      last: p,
      opacity: o.opacity, // 笔画内不透明度固定，避免中途改动导致区域间浓淡不一
      targetCtx: tgt.ctx,
      isMask: tgt.isMask,
      color,
    };
    stampLine(T.stroke.bufCtx, p, p, { ...o, color });
    compositeStroke();
    T.drawing = true;
  }

  function moveStroke(p) {
    const o = PL.state.toolOptions;
    const from = T.stroke.last;
    stampLine(T.stroke.bufCtx, from, p, { ...o, color: T.stroke.color });
    T.stroke.last = p;
    compositeStroke();
  }

  /**
   * 基线 + 笔迹缓冲 → 绘制目标（图层像素或蒙版；橡皮用 destination-out 抠除）。
   *
   * 实测：曾改为「只重绘脏矩形」，但在 willReadFrequently 的软件渲染画布上，
   * 带源矩形的 drawImage 会走慢路径（1440 次合成 41ms → 333ms）。
   * 因此保留全画布合成（3 次整幅操作走快速内存拷贝路径，约 0.03ms/次）。
   */
  function compositeStroke() {
    const { layer, base, buf, erase, targetCtx, isMask } = T.stroke;
    const c = targetCtx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.drawImage(base, 0, 0);
    c.globalAlpha = T.stroke.opacity;
    // 蒙版目标永远 source-over（橡皮在蒙版上画黑）；图层目标橡皮才用 destination-out
    c.globalCompositeOperation = (erase && !isMask) ? 'destination-out' : 'source-over';
    c.drawImage(buf, 0, 0);
    c.restore();
    if (isMask) layer.markMaskDirty();
    else layer.markDirty();
    PL.render();
  }

  function endStroke() {
    const { erase, isMask } = T.stroke;
    T.stroke = null;
    T.drawing = false;
    PL.history.commit((erase ? '橡皮擦' : '画笔') + (isMask ? '（蒙版）' : ''));
    PL.refreshAll();
  }

  /* ================= 移动图层 ================= */

  function beginMove(layer, p) {
    T.moveOp = {
      layer,
      base: layer.clonePixels(),
      maskBase: layer.mask ? layer.cloneMask() : null, // 蒙版与内容一起移动
      start: p,
    };
    T.drawing = true;
  }

  function doMove(p) {
    const { layer, base, maskBase, start } = T.moveOp;
    const dx = Math.round(p.x - start.x);
    const dy = Math.round(p.y - start.y);
    T.moveOp.d = { dx, dy };
    const c = layer.ctx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.drawImage(base, dx, dy);
    c.restore();
    layer.markDirty();
    if (maskBase && layer.mask) {
      const mc = layer.maskCtx;
      mc.save();
      mc.globalAlpha = 1;
      mc.globalCompositeOperation = 'source-over';
      mc.clearRect(0, 0, layer.width, layer.height);
      mc.drawImage(maskBase, dx, dy);
      mc.restore();
      layer.markMaskDirty();
    }
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
    // 尺寸检查必须放在固化之前：误点时不应把文字图层固化成不可编辑的像素层
    if (r.w < 1 || r.h < 1) return;
    const tgt = paintTarget(layer);
    if (!tgt.isMask) PL.bakeIfText(layer); // 形状直接改像素，文字图层需固化
    const o = PL.state.toolOptions;
    const color = tgt.isMask ? grayHex(o.color) : o.color;
    const c = tgt.ctx;
    c.save();
    c.globalAlpha = o.opacity;
    c.fillStyle = color;
    c.strokeStyle = color;
    c.lineWidth = o.strokeWidth;
    c.beginPath();
    if (PL.state.tool === 'rect') c.rect(r.x, r.y, r.w, r.h);
    else c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    if (o.shapeMode === 'stroke') c.stroke();
    else c.fill();
    c.restore();
    if (tgt.isMask) layer.markMaskDirty();
    else layer.markDirty();
    PL.history.commit('绘制形状' + (tgt.isMask ? '（蒙版）' : ''));
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

  /**
   * 计算图层不透明内容的包围盒（alpha > 0），空图层返回 null。
   * 用 Uint32Array 视图逐像素扫描，比逐字节访问快 3~4 倍。
   */
  function getContentBBox(layer) {
    const w = layer.width, h = layer.height;
    const img = layer.ctx.getImageData(0, 0, w, h);
    const px = new Uint32Array(img.data.buffer);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < px.length; i++) {
      if ((px[i] >>> 24) === 0) continue;   // alpha = 0
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  let bboxCache = null; // { layerId, pxv, box }

  function activeLayer() {
    return PL.state.stack ? PL.state.stack.getById(PL.state.activeId) : null;
  }

  /** 取当前图层内容包围盒（按 图层id@像素版本 缓存，像素未变则不重算） */
  function refreshBBox(force) {
    const l = activeLayer();
    if (!l) { bboxCache = null; return null; }
    const pxv = l._pxv || 0;
    if (!force && bboxCache && bboxCache.layerId === l.id && bboxCache.pxv === pxv) {
      return bboxCache.box;
    }
    const box = getContentBBox(l);
    bboxCache = { layerId: l.id, pxv, box };
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
  /** 把同一变换应用到蒙版（与像素保持对齐） */
  function applyMaskTransform(layer, maskBase, fx, fy, ax, ay, dx = 0, dy = 0) {
    if (!maskBase || !layer.mask) return;
    const mc = layer.maskCtx;
    mc.save();
    mc.globalAlpha = 1;
    mc.globalCompositeOperation = 'source-over';
    mc.clearRect(0, 0, layer.width, layer.height);
    mc.setTransform(fx, 0, 0, fy, ax - fx * ax + dx, ay - fy * ay + dy);
    mc.drawImage(maskBase, 0, 0);
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.restore();
    layer.markMaskDirty();
  }

  function applyScaleAbout(layer, base, fx, fy, ax, ay, dx = 0, dy = 0, maskBase = null) {
    const c = layer.ctx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.setTransform(fx, 0, 0, fy, ax - fx * ax + dx, ay - fy * ay + dy);
    c.drawImage(base, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.restore();
    layer.markDirty();
    applyMaskTransform(layer, maskBase, fx, fy, ax, ay, dx, dy);
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
  /** 泛洪填充（可直接作用于任意 ctx，供图层与蒙版共用） */
  function floodFillOn(ctx, w, h, p, colorHex, tol) {
    const sx = Math.floor(p.x), sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
    const [fr, fg, fb] = hexToRgb(colorHex);
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

  function floodFill(layer, p) {
    const o = PL.state.toolOptions;
    const tgt = paintTarget(layer);
    if (!tgt.isMask) PL.bakeIfText(layer);
    const color = tgt.isMask ? grayHex(o.color) : o.color;
    if (!floodFillOn(tgt.ctx, layer.width, layer.height, p, color, o.tolerance)) return false;
    if (tgt.isMask) layer.markMaskDirty();
    else layer.markDirty();
    return true;
  }

  /* ================= 文字：画布上直接编辑 ================= */

  const TEXT_FONT = `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  const measureCtx = document.createElement('canvas').getContext('2d');

  /** 把文字数据渲染为图层像素，并记录包围盒（用于再次编辑的命中测试） */
  function renderTextLayer(layer) {
    const t = layer.text;
    const lh = t.fontSize * 1.3;
    const c = layer.ctx;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, layer.width, layer.height);
    c.font = `600 ${t.fontSize}px ${TEXT_FONT}`;
    c.textBaseline = 'top';
    c.fillStyle = t.color;
    c.globalAlpha = t.opacity != null ? t.opacity : 1;
    t.content.split('\n').forEach((line, i) => c.fillText(line, t.x, t.y + i * lh));
    c.restore();
    layer.markDirty();
    layer._textBox = measureTextBox(t);
  }

  function measureTextBox(t) {
    measureCtx.font = `600 ${t.fontSize}px ${TEXT_FONT}`;
    const lines = t.content.split('\n');
    let w = 1;
    lines.forEach(line => { w = Math.max(w, measureCtx.measureText(line).width || 1); });
    return { x: t.x, y: t.y, w, h: Math.max(1, lines.length * t.fontSize * 1.3) };
  }

  /** 命中测试：从顶到底找被点中的文字图层 */
  function hitTextLayer(p) {
    const layers = PL.state.stack.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.text) continue;
      if (!l._textBox) l._textBox = measureTextBox(l.text);
      const b = l._textBox;
      const slack = Math.max(6, l.text.fontSize * 0.25);
      if (p.x >= b.x - slack && p.x <= b.x + b.w + slack &&
          p.y >= b.y - slack && p.y <= b.y + b.h + slack) return l;
    }
    return null;
  }

  function applyTextStyle(el, t) {
    const z = PL.state.zoom;
    el.style.left = (t.x * z) + 'px';
    el.style.top = (t.y * z) + 'px';
    el.style.fontSize = (t.fontSize * z) + 'px';
    el.style.color = t.color;
    el.style.fontFamily = TEXT_FONT;
    el.style.lineHeight = '1.3';
  }

  /** 编辑框随内容自动伸缩（换行、加长） */
  function sizeTextEditor() {
    const te = T.textEdit;
    if (!te) return;
    const z = PL.state.zoom;
    const b = measureTextBox({ ...te.data, content: te.el.value });
    te.el.style.width = Math.max(60, b.w * z + 20) + 'px';
    te.el.style.height = (b.h * z + 10) + 'px';
  }

  /** 打开画布编辑框；layer 为空 = 新建文字，否则编辑该图层 */
  function openTextEditor(layer, p) {
    closeTextEditor(true); // 先放弃未提交的编辑
    const o = PL.state.toolOptions;
    let data;
    if (layer) {
      data = { ...layer.text };
      // 同步选项栏，保证提交参数与原文字一致
      o.fontSize = data.fontSize;
      o.color = data.color;
      o.opacity = data.opacity != null ? data.opacity : 1;
      syncTextOptionUI();
    } else {
      data = { content: '', x: p.x, y: p.y, fontSize: o.fontSize, color: o.color, opacity: o.opacity };
    }
    const el = document.createElement('textarea');
    el.id = 'textEditor';
    el.placeholder = '输入文字…（Esc 取消 · Ctrl+Enter 或点空白处完成）';
    applyTextStyle(el, data);
    el.value = data.content;
    document.getElementById('stagewrap').appendChild(el);

    el.addEventListener('input', sizeTextEditor);
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 编辑时不触发全局快捷键
      if (e.key === 'Escape') closeTextEditor(true);
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeTextEditor(false); }
    });
    el.addEventListener('blur', () => closeTextEditor(false));

    T.textEdit = { layer, data, el };
    sizeTextEditor();
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) { /* 忽略 */ }
  }

  /** 关闭编辑框：cancel=true 丢弃，否则提交到文字图层 */
  function closeTextEditor(cancel) {
    const te = T.textEdit;
    if (!te) return;
    T.textEdit = null;
    const content = te.el.value.replace(/\s+$/, '');
    te.el.remove();
    if (cancel) return;

    const o = PL.state.toolOptions;
    if (!content) {
      // 重新编辑时清空内容 = 删除该文字图层
      if (te.layer) {
        PL.state.stack.remove(te.layer.id);
        const top = PL.state.stack.top;
        PL.state.activeId = top ? top.id : null;
        PL.history.commit('删除文字图层');
        PL.refreshAll();
      }
      return;
    }

    const name = content.split('\n')[0].slice(0, 12) || '文字';
    if (te.layer) {
      te.layer.text = { ...te.data, content, fontSize: o.fontSize, color: o.color, opacity: o.opacity };
      te.layer.name = name;
      renderTextLayer(te.layer);
      PL.history.commit('编辑文字');
      PL.refreshAll();
    } else {
      const l = new PL.Layer(name, PL.state.doc.width, PL.state.doc.height);
      l.text = { ...te.data, content, fontSize: o.fontSize, color: o.color, opacity: o.opacity };
      renderTextLayer(l);
      PL.state.stack.add(l);
      PL.state.activeId = l.id;
      PL.history.commit('添加文字');
      PL.refreshAll();
    }
  }

  /** 把选项栏控件同步为当前编辑文字的参数 */
  function syncTextOptionUI() {
    const o = PL.state.toolOptions;
    const fs = document.getElementById('fontSize');
    const color = document.getElementById('brushColor');
    const op = document.getElementById('toolOpacity');
    const opVal = document.getElementById('toolOpacityVal');
    if (fs) fs.value = o.fontSize;
    if (color) color.value = o.color;
    if (op) {
      op.value = Math.round((o.opacity != null ? o.opacity : 1) * 100);
      if (opVal) opVal.textContent = op.value + '%';
    }
  }

  /** 从合成结果取色 */
  function pickColor(p) {
    PL.compositor.renderSync(); // 取色必须读当前合成结果：立即刷新（并清掉未执行的 rAF）
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

    if (s.spacePan || tool === 'pan') {
      T.pan = { sx: e.clientX, sy: e.clientY, px: s.pan.x, py: s.pan.y };
      T.drawing = true;
      e.target.setPointerCapture(e.pointerId);
      PL.compositor.stage().style.cursor = 'grabbing';
      return;
    }

    if (tool === 'picker') { pickColor(p); return; }

    if (tool === 'fill') {
      const layer = activeLayerForPainting();
      const isMask = !!(layer.mask && PL.state.maskEditId === layer.id);
      if (!floodFill(layer, p)) return;
      PL.history.commit('油漆桶填充' + (isMask ? '（蒙版）' : ''));
      PL.refreshAll();
      return;
    }

    if (tool === 'text') {
      if (T.textEdit) {
        const hit = hitTextLayer(p);
        // 点在自己的文字上：继续编辑；否则先提交，命中其它文字则转入编辑
        if (hit && teLayerId(T.textEdit) === hit.id) return;
        closeTextEditor(false);
        if (hit) openTextEditor(hit, p);
        return;
      }
      const hit = hitTextLayer(p);
      if (hit) {
        selectLayerById(hit.id);
        openTextEditor(hit, p);
      } else {
        openTextEditor(null, p);
      }
      return;
    }

    if (tool === 'scale') {
      const layer = s.stack.getById(s.activeId);
      if (!layer) return;
      const box = refreshBBox(true); // 按下时取最新包围盒
      if (!box) return;              // 空图层没有可变换的内容
      const handle = hitHandle(p, box);
      T.xform = {
        layer,
        base: layer.clonePixels(),
        maskBase: layer.mask ? layer.cloneMask() : null, // 蒙版与内容一起变换
        startBox: box,
        handle, // null = 拖内容移动
        start: p,
        textBase: layer.text ? { ...layer.text } : null, // 文字图层缩放改字号+位置，保持可编辑
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

    if (T.pan) {
      PL.state.pan.x = T.pan.px + (e.clientX - T.pan.sx);
      PL.state.pan.y = T.pan.py + (e.clientY - T.pan.sy);
      PL.compositor.applyPan();
      return;
    }

    if (!T.drawing) {
      if (s.tool === 'brush' || s.tool === 'eraser') {
        if (!s.spacePan) drawBrushCursor(p); // 空格平移中不显示笔刷光圈
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
        xf.d = { dx, dy };
        applyScaleAbout(xf.layer, xf.base, 1, 1, 0, 0, dx, dy, xf.maskBase);
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
        // 文字图层等比缩放：改字号 + 位置，保持可再编辑（自由拉伸无法用文字表达，先固化像素）
        if (xf.textBase && !e.shiftKey) {
          const tb = xf.textBase, f = fx;
          xf.layer.text = {
            ...tb,
            fontSize: Math.max(1, tb.fontSize * f),
            x: a.x + (tb.x - a.x) * f,
            y: a.y + (tb.y - a.y) * f,
          };
          renderTextLayer(xf.layer);
          xf.layer.markDirty();
          if (xf.maskBase) applyMaskTransform(xf.layer, xf.maskBase, f, f, a.x, a.y);
          const nb = { w: xf.startBox.w * f, h: xf.startBox.h * f };
          nb.x = a.x === xf.startBox.x ? a.x : a.x - nb.w;
          nb.y = a.y === xf.startBox.y ? a.y : a.y - nb.h;
          drawXformUI(nb);
          return;
        }
        if (xf.textBase) { PL.bakeIfText(xf.layer); xf.textBase = null; }
        applyScaleAbout(xf.layer, xf.base, fx, fy, a.x, a.y, 0, 0, xf.maskBase);
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
    if (T.pan) {
      T.pan = null;
      T.drawing = false;
      PL.compositor.stage().style.cursor = PL.state.spacePan ? 'grab' : PL.cursorFor(PL.state.tool);
      return;
    }
    if (T.stroke) {
      endStroke();
    } else if (T.shape) {
      commitShape();
    } else if (T.xform) {
      const { layer, handle, d } = T.xform;
      if (layer.text && d) { // 拖内容移动：同步文字坐标，保持可再编辑
        layer.text.x += d.dx;
        layer.text.y += d.dy;
        layer._textBox = measureTextBox(layer.text);
      }
      T.xform = null;
      T.drawing = false;
      PL.history.commit(handle ? '缩放图层' : '移动图层');
      PL.refreshAll(); // onDocChanged 会刷新包围盒与变换框
    } else if (T.moveOp) {
      const { layer, d } = T.moveOp;
      T.moveOp = null;
      T.drawing = false;
      if (d && (d.dx || d.dy)) {
        // 移动文字图层：同步文字坐标，保持可再次编辑
        if (layer.text) {
          layer.text.x += d.dx;
          layer.text.y += d.dy;
          layer._textBox = measureTextBox(layer.text);
        }
        PL.history.commit('移动图层');
        PL.refreshAll();
      }
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

    /** 画布缩放时同步文字编辑框的位置与样式 */
    onZoomChanged() {
      if (T.textEdit) {
        applyTextStyle(T.textEdit.el, T.textEdit.data);
        sizeTextEditor();
      }
    },

    /** 编辑文字时，选项栏改字号/颜色/不透明度 → 实时同步到编辑框（提交时写入图层） */
    onTextStyleChanged() {
      const te = T.textEdit;
      if (!te) return;
      const o = PL.state.toolOptions;
      te.data = { ...te.data, fontSize: o.fontSize, color: o.color, opacity: o.opacity };
      applyTextStyle(te.el, te.data);
      sizeTextEditor();
    },

    /** 切换工具前提交进行中的文字编辑 */
    commitTextIfEditing() {
      if (T.textEdit) closeTextEditor(false);
    },

    /** 数值缩放当前图层内容（关于内容中心，立即生效） */
    scaleContent(f) {
      const l = activeLayer();
      if (!l) return;
      const box = refreshBBox(true);
      if (!box) return;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      if (l.text) { // 文字图层：缩放字号与位置，保持可编辑
        const tb = l.text;
        l.text = { ...tb, fontSize: Math.max(1, tb.fontSize * f),
          x: cx + (tb.x - cx) * f, y: cy + (tb.y - cy) * f };
        renderTextLayer(l);
        l.markDirty();
        if (l.mask) applyMaskTransform(l, l.cloneMask(), f, f, cx, cy); // 蒙版同步缩放
      } else {
        PL.bakeIfText(l);
        applyScaleAbout(l, l.clonePixels(), f, f, cx, cy, 0, 0, l.mask ? l.cloneMask() : null);
      }
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
      if (l.text) { // 文字图层：缩放字号与位置，保持可编辑
        const tb = l.text;
        l.text = { ...tb, fontSize: Math.max(1, tb.fontSize * f),
          x: d.width / 2 + (tb.x - cx) * f, y: d.height / 2 + (tb.y - cy) * f };
        renderTextLayer(l);
      } else {
        PL.bakeIfText(l);
        applyScaleAbout(l, l.clonePixels(), f, f, cx, cy, d.width / 2 - cx, d.height / 2 - cy,
          l.mask ? l.cloneMask() : null);
      }
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
      // 双击文字图层：任意工具下直接进入文字编辑
      stage.addEventListener('dblclick', (e) => {
        if (PL.state.spacePan) return;
        const p = PL.compositor.toDoc(e);
        const hit = hitTextLayer(p);
        if (!hit) return;
        if (PL.setTool) PL.setTool('text');
        selectLayerById(hit.id);
        openTextEditor(hit, p);
      });
    },
  };
})();

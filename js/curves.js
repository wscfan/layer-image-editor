/**
 * curves.js —— 曲线（Curves）色调调整
 *
 * 数据结构：每个图层可带一份曲线定义 layer.curves = { rgb, r, g, b }，
 * 每个通道是控制点数组 [{x, y}, ...]（0~255 域）。
 *
 * 渲染管线：曲线先生成 256 级 LUT → 预览时把图层像素过一遍 LUT；
 * 点「应用曲线」则把 LUT 烘焙进图层像素（layer.curves 清空）。
 */
(function () {
  'use strict';

  const CHANNELS = [
    { key: 'rgb', label: 'RGB', color: '#e6e6e6' },
    { key: 'r', label: 'R', color: '#ff6b6b' },
    { key: 'g', label: 'G', color: '#5fd66f' },
    { key: 'b', label: 'B', color: '#5aa9ff' },
  ];
  const PAD = 16;        // 绘图区内边距（CSS px）
  const HIT = 9;         // 控制点命中半径（CSS px）

  let cvs = null, ctx = null;
  let activeCh = 'rgb';
  let drag = null;      // { layerId, ch, index }
  let hist = null;      // 当前图层直方图
  let visible = false;  // 曲线面板是否可见（不可见时跳过直方图统计）
  let previewCache = { key: null, canvas: null };

  /* ==================== 曲线数学 ==================== */

  const defaultCurve = () => [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  const defaultCurves = () => ({
    rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve(),
  });

  function isIdentityCurve(c) {
    return !!c && c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 255 && c[1].y === 255;
  }

  function isIdentityCurves(cs) {
    return !cs || CHANNELS.every(ch => isIdentityCurve(cs[ch.key]));
  }

  /**
   * 单调三次插值（Fritsch–Carlson）生成 256 级查找表。
   * 相比线性插值更平滑，且不会像普通样条那样在控制点之间过冲。
   */
  function buildLUT(points) {
    const lut = new Uint8Array(256);
    const p = points.slice().sort((a, b) => a.x - b.x);
    const n = p.length;
    if (!n) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
    if (n === 1) { for (let i = 0; i < 256; i++) lut[i] = p[0].y; return lut; }

    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) {
      const d = p[i + 1].x - p[i].x;
      dx[i] = d;
      m[i] = d === 0 ? 0 : (p[i + 1].y - p[i].y) / d;
    }
    // 切线
    const t = new Array(n);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) t[i] = 0;
      else {
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
      }
    }
    // 采样
    for (let x = 0; x < 256; x++) {
      let i = 0;
      while (i < n - 2 && x > p[i + 1].x) i++;
      const h = dx[i];
      let y;
      if (h === 0) {
        y = p[i].y;
      } else {
        const s = (x - p[i].x) / h;
        const s2 = s * s, s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1;
        const h10 = s3 - 2 * s2 + s;
        const h01 = -2 * s3 + 3 * s2;
        const h11 = s3 - s2;
        y = h00 * p[i].y + h10 * h * t[i] + h01 * p[i + 1].y + h11 * h * t[i + 1];
      }
      lut[x] = Math.max(0, Math.min(255, Math.round(y)));
    }
    return lut;
  }

  /** 合并主曲线与各通道曲线 → 每通道 256 级 LUT */
  function getLUTs(curves) {
    const cs = curves || defaultCurves();
    const master = buildLUT(cs.rgb);
    const r = buildLUT(cs.r);
    const g = buildLUT(cs.g);
    const b = buildLUT(cs.b);
    const out = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };
    for (let v = 0; v < 256; v++) {
      out.r[v] = r[master[v]];
      out.g[v] = g[master[v]];
      out.b[v] = b[master[v]];
    }
    return out;
  }

  /** 把 LUT 应用到一份 ImageData */
  function applyLUTToData(imgData, luts) {
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = luts.r[d[i]];
      d[i + 1] = luts.g[d[i + 1]];
      d[i + 2] = luts.b[d[i + 2]];
    }
    return imgData;
  }

  /* ==================== 图层数据 ==================== */

  function currentLayer() {
    const s = PL.state;
    return s.stack ? s.stack.getById(s.activeId) : null;
  }

  function getCurves(layer) {
    return (layer && layer.curves) ? layer.curves : defaultCurves();
  }

  function ensureCurves(layer) {
    if (!layer.curves) layer.curves = defaultCurves();
    return layer.curves;
  }

  function hasCurves(layer) {
    return !!(layer && layer.curves && !isIdentityCurves(layer.curves));
  }

  function bumpVersion(layer) {
    layer._curveVersion = (layer._curveVersion || 0) + 1;
  }

  /* ==================== 预览 ==================== */

  /** 返回经过曲线处理的图层画布（带缓存） */
  function previewCanvas(layer) {
    // 键必须包含像素版本 _pxv：画笔等操作只递增 _pxv，
    // 若键里没有它，带曲线的图层上画画后会命中旧缓存，笔迹被整层旧图覆盖。
    const key = layer.id + ':' + (layer._pxv || 0) + ':' + (layer._curveVersion || 0);
    if (previewCache.key === key && previewCache.canvas) return previewCache.canvas;
    const c = document.createElement('canvas');
    c.width = layer.width;
    c.height = layer.height;
    const c2 = c.getContext('2d');
    c2.drawImage(layer.canvas, 0, 0);
    const img = c2.getImageData(0, 0, c.width, c.height);
    applyLUTToData(img, getLUTs(layer.curves));
    c2.putImageData(img, 0, 0);
    previewCache = { key, canvas: c };
    return c;
  }

  /* ==================== 编辑器 UI ==================== */

  function plotBox() {
    const W = cvs.clientWidth || 240;
    const H = cvs.clientHeight || 240;
    return { x: PAD, y: PAD, w: W - PAD * 2, h: H - PAD * 2, W, H };
  }

  const toCanvasX = (v, b) => b.x + (v / 255) * b.w;
  const toCanvasY = (v, b) => b.y + b.h - (v / 255) * b.h;
  const toValueX = (px, b) => Math.max(0, Math.min(255, ((px - b.x) / b.w) * 255));
  const toValueY = (py, b) => Math.max(0, Math.min(255, ((b.y + b.h - py) / b.h) * 255));

  function curveValue(curve, x) {
    const lut = buildLUT(curve);
    return lut[Math.max(0, Math.min(255, Math.round(x)))];
  }

  /**
   * 计算当前图层的直方图（按当前通道）。
   *
   * 优化点：
   * 1) 先把图层缩到 256×256 再统计 —— 读回量从 w*h 降到 65536 像素，
   *    对直方图展示精度无影响，却省掉了整幅 getImageData 的开销；
   * 2) 按 (图层id@像素版本@通道) 缓存，像素没变就不重算。
   */
  const HIST_SAMPLE_PX = 256;   // 缩略图边长
  let histKey = null;

  function computeHistogram(layer) {
    const bins = new Uint32Array(256);
    if (!layer) { histKey = null; return { bins, max: 1 }; }
    const key = layer.id + '@' + (layer._pxv || 0) + '@' + activeCh;
    if (key === histKey && hist) return hist;

    // 在缩略图上统计，避免整幅读回
    const s = Math.min(HIST_SAMPLE_PX / layer.width, HIST_SAMPLE_PX / layer.height, 1);
    const tw = Math.max(1, Math.round(layer.width * s));
    const th = Math.max(1, Math.round(layer.height * s));
    const tmp = document.createElement('canvas');
    tmp.width = tw;
    tmp.height = th;
    const tc = tmp.getContext('2d', { willReadFrequently: true });
    tc.drawImage(layer.canvas, 0, 0, tw, th);
    const d = tc.getImageData(0, 0, tw, th).data;
    for (let i = 0; i < d.length; i += 4) {
      let v;
      switch (activeCh) {
        case 'r': v = d[i]; break;
        case 'g': v = d[i + 1]; break;
        case 'b': v = d[i + 2]; break;
        default: v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      bins[Math.max(0, Math.min(255, Math.round(v)))]++;
    }
    let max = 1;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];
    hist = { bins, max };
    histKey = key;
    return hist;
  }

  function draw() {
    if (!ctx || !cvs) return;
    const dpr = window.devicePixelRatio || 1;
    const b = plotBox();
    const W = Math.max(80, Math.round(b.W * dpr));
    const H = Math.max(80, Math.round(b.H * dpr));
    if (cvs.width !== W || cvs.height !== H) { cvs.width = W; cvs.height = H; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, b.W, b.H);

    // 背景
    ctx.fillStyle = '#16171b';
    ctx.fillRect(0, 0, b.W, b.H);

    const layer = currentLayer();
    const ch = CHANNELS.find(c => c.key === activeCh);

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const gx = b.x + b.w * t, gy = b.y + b.h * (1 - t);
      ctx.beginPath(); ctx.moveTo(gx, b.y); ctx.lineTo(gx, b.y + b.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(b.x, gy); ctx.lineTo(b.x + b.w, gy); ctx.stroke();
    }

    // 直方图
    if (hist) {
      ctx.fillStyle = ch.color;
      ctx.globalAlpha = 0.18;
      for (let i = 0; i < 256; i++) {
        const h = (hist.bins[i] / hist.max) * b.h;
        if (h <= 0) continue;
        ctx.fillRect(b.x + (i / 255) * b.w, b.y + b.h - h, Math.max(1, b.w / 256), h);
      }
      ctx.globalAlpha = 1;
    }

    // 参考对角线
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + b.h);
    ctx.lineTo(b.x + b.w, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!layer) {
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无选中图层', b.x + b.w / 2, b.y + b.h / 2);
      ctx.textAlign = 'left';
      return;
    }

    const curve = getCurves(layer)[activeCh];

    // 曲线本体（按 LUT 采样绘制）
    const lut = buildLUT(curve);
    ctx.strokeStyle = ch.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const px = toCanvasX(i, b), py = toCanvasY(lut[i], b);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 控制点
    curve.forEach((pt, i) => {
      const px = toCanvasX(pt.x, b), py = toCanvasY(pt.y, b);
      const active = drag && drag.index === i && drag.ch === activeCh;
      ctx.fillStyle = active ? '#ffffff' : ch.color;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(px - 3.5, py - 3.5, 7, 7);
      ctx.fill();
      ctx.stroke();
    });

    // 坐标刻度
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('0', b.x + 2, b.y + b.h - 3);
    ctx.fillText('255', b.x + b.w - 20, b.y + b.h - 3);
    ctx.fillText('255', b.x + 2, b.y + 10);
  }

  /* ==================== 交互 ==================== */

  function hitPoint(px, py, curve, b) {
    for (let i = 0; i < curve.length; i++) {
      const cx = toCanvasX(curve[i].x, b), cy = toCanvasY(curve[i].y, b);
      if (Math.abs(cx - px) <= HIT && Math.abs(cy - py) <= HIT) return i;
    }
    return -1;
  }

  function onPointerDown(e) {
    const layer = currentLayer();
    if (!layer) return;
    e.preventDefault();
    const rect = cvs.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const b = plotBox();
    const cs = ensureCurves(layer);
    const curve = cs[activeCh];

    const idx = hitPoint(px, py, curve, b);
    if (idx >= 0) {
      drag = { layerId: layer.id, ch: activeCh, index: idx, moved: false };
      cvs.setPointerCapture(e.pointerId);
      draw();
      return;
    }
    // 单击曲线附近 → 新增控制点
    const vx = toValueX(px, b);
    const vy = toValueY(py, b);
    const onCurve = toCanvasY(curveValue(curve, vx), b);
    if (Math.abs(onCurve - py) <= 12) {
      const pt = { x: vx, y: vy };
      curve.push(pt);
      curve.sort((a, b2) => a.x - b2.x);
      const ni = curve.indexOf(pt);
      drag = { layerId: layer.id, ch: activeCh, index: ni, moved: true };
      bumpVersion(layer);
      PL.render();
      // 不重建图层面板：缩略图画的是原始像素，曲线调整不会改变它，
      // 每帧重建 DOM + 重绘缩略图纯属浪费。
      cvs.setPointerCapture(e.pointerId);
      draw();
    }
  }

  function onPointerMove(e) {
    const layer = currentLayer();
    if (!layer) return;
    const rect = cvs.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const b = plotBox();

    if (!drag) {
      // 悬停：高亮控制点
      const curve = getCurves(layer)[activeCh];
      const idx = hitPoint(px, py, curve, b);
      cvs.style.cursor = idx >= 0 ? 'grab' : 'crosshair';
      return;
    }
    if (drag.layerId !== layer.id || drag.ch !== activeCh) return;
    e.preventDefault();

    const cs = ensureCurves(layer);
    const curve = cs[drag.ch];
    const i = drag.index;
    const pt = curve[i];
    if (!pt) return;

    const prev = curve[i - 1], next = curve[i + 1];
    let vx = toValueX(px, b);
    let vy = toValueY(py, b);
    // x 限制在相邻控制点之间，y 限制在 0~255
    if (prev) vx = Math.max(vx, prev.x + 1);
    if (next) vx = Math.min(vx, next.x - 1);
    pt.x = vx;
    pt.y = vy;
    drag.moved = true;
    bumpVersion(layer);
    PL.render();
    draw();
  }

  function onPointerUp(e) {
    if (!drag) return;
    const layer = currentLayer();
    if (layer && drag.moved) PL.history.commit('调整曲线');
    drag = null;
    try { cvs.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    draw();
  }

  function onDoubleClick(e) {
    const layer = currentLayer();
    if (!layer) return;
    const rect = cvs.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const b = plotBox();
    const curve = getCurves(layer)[activeCh];
    const idx = hitPoint(px, py, curve, b);
    if (idx >= 0 && curve.length > 2) {
      const cs = ensureCurves(layer);
      cs[activeCh].splice(idx, 1);
      bumpVersion(layer);
      PL.render();
      PL.history.commit('删除曲线控制点');
      draw();
    }
  }

  /* ==================== 应用 / 重置 ==================== */

  function applyCurves() {
    const layer = currentLayer();
    if (!layer || !hasCurves(layer)) return;
    PL.bakeIfText(layer); // 曲线直接改像素，文字图层需固化
    const luts = getLUTs(layer.curves);
    const img = layer.ctx.getImageData(0, 0, layer.width, layer.height);
    applyLUTToData(img, luts);
    layer.ctx.putImageData(img, 0, 0);
    layer.markDirty();
    layer.curves = null;
    bumpVersion(layer);
    PL.history.commit('应用曲线');
    PL.refreshAll();
  }

  function resetCurves() {
    const layer = currentLayer();
    if (!layer || !layer.curves) return;
    layer.curves = null;
    bumpVersion(layer);
    PL.history.commit('重置曲线');
    PL.refreshAll();
  }

  /* ==================== 对外接口 ==================== */

  PL.curves = {
    get activeChannel() { return activeCh; },

    init() {
      cvs = document.getElementById('curveEditor');
      ctx = cvs.getContext('2d');
      cvs.addEventListener('pointerdown', onPointerDown);
      cvs.addEventListener('pointermove', onPointerMove);
      cvs.addEventListener('pointerup', onPointerUp);
      cvs.addEventListener('pointercancel', onPointerUp);
      cvs.addEventListener('dblclick', onDoubleClick);
      cvs.addEventListener('pointerleave', () => { if (!drag) draw(); });

      document.querySelectorAll('#curvepanel .ch').forEach(btn => {
        btn.addEventListener('click', () => {
          activeCh = btn.dataset.ch;
          document.querySelectorAll('#curvepanel .ch').forEach(b =>
            b.classList.toggle('active', b === btn));
          this.refresh();
        });
      });
      document.getElementById('btnCurveApply').addEventListener('click', applyCurves);
      document.getElementById('btnCurveReset').addEventListener('click', resetCurves);
    },

    /** 图层/文档变化后刷新：重算直方图并重绘 */
    refresh() {
      if (!visible) return;   // 面板不可见时不统计直方图（避免每次提交都读回像素）
      hist = computeHistogram(currentLayer());
      draw();
    },

    /** 面板可见性：不可见时跳过直方图统计 */
    setVisible(v) {
      visible = !!v;
      if (visible) this.refresh();
      else { hist = null; histKey = null; }
    },

    get visible() { return visible; },

    /** 供合成器使用：图层是否带有效曲线 */
    hasCurves,

    /** 供合成器使用：曲线处理后的画布 */
    previewCanvas,

    /** 供合成器/工具使用：把曲线烘焙进像素 */
    applyCurves,

    /** 供测试与工具使用 */
    _buildLUT: buildLUT,
    _getLUTs: getLUTs,
    _defaultCurves: defaultCurves,
  };
})();

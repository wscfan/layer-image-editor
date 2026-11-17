/**
 * filters.js —— 调整与滤镜
 *
 * 大部分效果基于 Canvas 2D 的 ctx.filter（CSS filter 语法）；
 * 锐化使用 3×3 卷积，像素化使用「缩小再放大」。
 */
(function () {
  'use strict';

  PL.filters = {
    /** 由调整参数（-100~100 等）生成 CSS filter 字符串 */
    buildFilter(v) {
      const parts = [];
      if (v.brightness) parts.push(`brightness(${(100 + v.brightness) / 100})`);
      if (v.contrast) parts.push(`contrast(${(100 + v.contrast) / 100})`);
      if (v.saturation) parts.push(`saturate(${(100 + v.saturation) / 100})`);
      if (v.hue) parts.push(`hue-rotate(${v.hue}deg)`);
      if (v.blur) parts.push(`blur(${(v.blur / 10).toFixed(2)}px)`); // 滑杆 0~100 → 0~10px
      return parts.join(' ');
    },

    /** 把 CSS filter 永久烘焙到图层像素 */
    applyFilter(layer, filterStr) {
      if (!filterStr) return;
      PL.bakeIfText(layer); // 滤镜直接改像素，文字图层需固化
      const tmp = document.createElement('canvas');
      tmp.width = layer.width;
      tmp.height = layer.height;
      const tc = tmp.getContext('2d');
      tc.filter = filterStr;
      tc.drawImage(layer.canvas, 0, 0);
      layer.ctx.clearRect(0, 0, layer.width, layer.height);
      layer.ctx.drawImage(tmp, 0, 0);
    },

    grayscale(layer) { this.applyFilter(layer, 'grayscale(1)'); },
    invert(layer) { this.applyFilter(layer, 'invert(1)'); },
    sepia(layer) { this.applyFilter(layer, 'sepia(0.85)'); },
    blur(layer, px = 4) { this.applyFilter(layer, `blur(${px}px)`); },

    /** 3×3 锐化卷积 */
    sharpen(layer) {
      PL.bakeIfText(layer);
      const w = layer.width, h = layer.height, ctx = layer.ctx;
      const src = ctx.getImageData(0, 0, w, h);
      const out = ctx.createImageData(w, h);
      const k = [0, -1, 0, -1, 5, -1, 0, -1, 0];
      const s = src.data, d = out.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
            d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3];
            continue;
          }
          for (let c = 0; c < 3; c++) {
            let sum = 0, n = 0;
            for (let ky = -1; ky <= 1; ky++) {
              for (let kx = -1; kx <= 1; kx++, n++) {
                sum += s[((y + ky) * w + (x + kx)) * 4 + c] * k[n];
              }
            }
            d[i + c] = Math.max(0, Math.min(255, sum));
          }
          d[i + 3] = s[i + 3];
        }
      }
      ctx.putImageData(out, 0, 0);
    },

    /** 像素化：block 为目标格子边长（px） */
    pixelate(layer, block = 12) {
      PL.bakeIfText(layer);
      const w = layer.width, h = layer.height;
      const sw = Math.max(1, Math.round(w / block));
      const sh = Math.max(1, Math.round(h / block));
      const tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      tmp.getContext('2d').drawImage(layer.canvas, 0, 0, sw, sh);
      layer.ctx.imageSmoothingEnabled = false;
      layer.ctx.clearRect(0, 0, w, h);
      layer.ctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, w, h);
      layer.ctx.imageSmoothingEnabled = true;
    },
  };
})();

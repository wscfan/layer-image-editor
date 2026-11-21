/**
 * layer.js —— 图层数据模型与全局状态
 *
 * 每个图层 = 一个与文档等大的离屏 canvas，
 * 主画布（stage）按「底 → 顶」顺序合成所有可见图层。
 */
(function () {
  'use strict';

  window.PL = window.PL || {};

  /** 全局应用状态（由 main.js 初始化具体文档） */
  PL.state = {
    doc: { width: 0, height: 0 }, // 文档尺寸（即所有图层的尺寸）
    stack: null,                  // LayerStack 实例
    activeId: null,               // 当前选中图层 id
    zoom: 1,
    tool: 'brush',
    layerSeq: 0,                  // 图层命名计数器
    toolOptions: {
      color: '#2563eb',
      size: 18,          // 画笔/橡皮大小（px）
      hardness: 0.8,     // 笔刷硬度 0~1
      opacity: 1,        // 工具不透明度 0~1
      tolerance: 32,     // 油漆桶容差
      shapeMode: 'fill', // fill | stroke
      strokeWidth: 4,
      fontSize: 48,      // 文字字号（内容在画布上直接输入）
    },
    previewFilter: '',   // 调整面板的实时预览滤镜（仅当前图层）
    previewLayerId: null,
    maskEditId: null,    // 蒙版编辑目标（图层 id；null = 编辑图层像素）
    pan: { x: 0, y: 0 }, // 画布平移偏移（屏幕像素，相对居中位置）
    spacePan: false,     // 是否按住空格进入临时平移模式
    pristine: true,      // 文档是否未被编辑（首次导入图片时自适应画布尺寸）
  };

  /** 单个图层 */
  class Layer {
    constructor(name, width, height, options = {}) {
      this.id = ++Layer._seq;
      this.name = name;
      this.width = width;
      this.height = height;
      this.visible = true;
      this.opacity = 1;                     // 图层不透明度 0~1
      this.blendMode = 'source-over';       // 混合模式（globalCompositeOperation）
      this._pxv = 0;                        // 像素版本：像素变更时自增，供历史记录按层去重快照
      this.canvas = document.createElement('canvas');
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (options.fill) {
        this.ctx.fillStyle = options.fill;
        this.ctx.fillRect(0, 0, width, height);
      }
    }

    /** 像素被直接修改后调用，使历史记录能识别「这一层变了」 */
    markDirty() { this._pxv = (this._pxv || 0) + 1; }

    /**
     * 创建图层蒙版：不透明灰度画布（白=显示，黑=隐藏，灰=半透明）。
     * 蒙版在合成时应用，不破坏图层像素。
     */
    initMask(fill = '#ffffff') {
      this.mask = document.createElement('canvas');
      this.mask.width = this.width;
      this.mask.height = this.height;
      this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true });
      this.maskCtx.fillStyle = fill;
      this.maskCtx.fillRect(0, 0, this.width, this.height);
      this.maskEnabled = true;
      this.markMaskDirty();
      return this.mask;
    }

    /** 蒙版像素被修改后调用（使预览缓存与历史快照失效） */
    markMaskDirty() { this._maskVersion = (this._maskVersion || 0) + 1; }

    /** 蒙版像素深拷贝（笔画基线 / 变换基线） */
    cloneMask() {
      if (!this.mask) return null;
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      c.getContext('2d', { willReadFrequently: true }).drawImage(this.mask, 0, 0);
      return c;
    }

    /**
     * 像素深拷贝（撤销快照 / 移动基线 / 笔画基线）。
     * 目标画布使用 willReadFrequently（软件后端）：拷贝留在 CPU 内存，
     * 避免「软件画布 → GPU 画布」的上传开销（实测历史提交耗时下降明显）。
     */
    clonePixels() {
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      c.getContext('2d', { willReadFrequently: true }).drawImage(this.canvas, 0, 0);
      return c;
    }

    /** 从 Image 创建图层：等比缩放并居中放入文档 */
    static fromImage(name, img, docW, docH) {
      const l = new Layer(name, docW, docH);
      const s = Math.min(1, docW / img.width, docH / img.height);
      const w = img.width * s;
      const h = img.height * s;
      l.ctx.drawImage(img, (docW - w) / 2, (docH - h) / 2, w, h);
      return l;
    }
  }
  Layer._seq = 0;

  /** 图层集合（数组序：底 → 顶） */
  class LayerStack {
    constructor() { this.layers = []; }

    get length() { return this.layers.length; }
    get top() { return this.layers[this.layers.length - 1] || null; }

    getById(id) { return this.layers.find(l => l.id === id) || null; }
    indexOfId(id) { return this.layers.findIndex(l => l.id === id); }

    /** 添加到最顶；若给定 insertAboveId 则插入到该图层之上 */
    add(layer, insertAboveId) {
      if (insertAboveId == null) { this.layers.push(layer); return layer; }
      const i = this.indexOfId(insertAboveId);
      this.layers.splice(i === -1 ? this.layers.length : i + 1, 0, layer);
      return layer;
    }

    remove(id) {
      const i = this.indexOfId(id);
      if (i !== -1) this.layers.splice(i, 1);
    }

    /** dir: +1 向顶移动 / -1 向底移动 */
    move(id, dir) {
      const i = this.indexOfId(id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= this.layers.length) return false;
      [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
      return true;
    }

    /** 把 fromIndex 的图层移动到 toIndex（数组坐标） */
    reorder(fromIndex, toIndex) {
      if (fromIndex === toIndex) return;
      const [l] = this.layers.splice(fromIndex, 1);
      this.layers.splice(toIndex, 0, l);
    }
  }

  PL.Layer = Layer;
  PL.LayerStack = LayerStack;

  /** 各工具在画布上的光标（统一维护，避免多处重复定义） */
  const TOOL_CURSOR = {
    move: 'move', text: 'text', scale: 'default', pan: 'grab',
  };
  PL.cursorFor = (tool) => TOOL_CURSOR[tool] || 'crosshair';

  /**
   * 像素将被直接修改（画笔/填充/形状/滤镜/缩放等）时，
   * 把文字图层固化为普通像素图层（文字不再可编辑）。
   * 移动类操作不走这里，文字坐标会被同步更新。
   */
  PL.bakeIfText = function (layer) {
    if (layer && layer.text) {
      layer.text = null;
      layer._textBox = null;
    }
  };
})();

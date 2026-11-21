/**
 * history.js —— 撤销 / 重做
 *
 * 仍是「整档快照」语义：每条历史记录保存全部图层的元数据 + 像素克隆。
 * 但像素改为「按 id@pxv 的共享克隆池」：
 *   - 每个操作只克隆「实际改过像素」的图层（未改的图层复用池中已有克隆）；
 *   - 连续多条历史里同一图层的同一像素版本只存一份（引用计数管理释放），
 *   - 大幅降低多图层 / 连续小改动场景的内存与克隆开销，撤销/重做逻辑不变。
 */
(function () {
  'use strict';

  const LIMIT = 20;                        // 历史条数上限
  const MAX_POOL_BYTES = 128 * 1024 * 1024; // 像素克隆池内存上限（128MB）

  // 像素克隆池：key = "{layerId}@{pxv}" → { canvas, refs, bytes }
  // 池中的 canvas 一经写入永不修改，只会被 drawImage 拷贝走，因此可被多份快照安全共享。
  const pool = new Map();
  let poolBytes = 0;

  function keyOf(layer) { return layer.id + '@' + (layer._pxv || 0); }
  function mkeyOf(layer) { return layer.id + '@' + (layer._pxv || 0) + '@m' + (layer._maskVersion || 0); }

  function cloneCanvas(src) {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    // 软件后端：克隆留在 CPU 内存，避免每次提交都做一次 GPU 上传
    c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
    return c;
  }

  /** 让一份新快照引用一组 key：未入池的当场从实时图层克隆，已入池的仅引用计数 +1 */
  function retain(keys, getSource) {
    keys.forEach(key => {
      const e = pool.get(key);
      if (e) { e.refs++; return; }
      const canvas = cloneCanvas(getSource(key));
      const bytes = canvas.width * canvas.height * 4;
      pool.set(key, { canvas, refs: 1, bytes });
      poolBytes += bytes;
    });
  }

  /** 一份快照被丢弃（LIMIT 逐出 / 重做分支清空 / 重置）时释放其引用 */
  function release(snap) {
    if (!snap || !snap.uses) return;
    snap.uses.forEach(key => {
      const e = pool.get(key);
      if (!e) return;
      if (--e.refs <= 0) {
        poolBytes -= e.bytes;
        pool.delete(key);
      }
    });
  }

  /** 超出内存上限时逐出最旧的历史条目，直到池内存回落 */
  function trimPool() {
    while (poolBytes > MAX_POOL_BYTES) {
      const oldest = PL.history.entries.shift();
      if (!oldest) { pool.clear(); poolBytes = 0; break; }
      release(oldest);
      PL.history.index = Math.max(0, PL.history.index - 1);
    }
  }

  PL.history = {
    entries: [],
    index: -1,

    canUndo() { return this.index > 0; },
    canRedo() { return this.index < this.entries.length - 1; },

    /** 池内存占用（字节），供诊断使用 */
    get poolBytes() { return poolBytes; },

    /** 采集当前文档的完整快照（像素按 id@pxv 引用共享克隆池） */
    snapshot(label) {
      const s = PL.state;
      const layers = s.stack.layers.map(l => {
        const key = keyOf(l);
        const hasMask = !!l.mask;
        return {
          id: l.id,
          name: l.name,
          visible: l.visible,
          opacity: l.opacity,
          blendMode: l.blendMode,
          width: l.width,
          height: l.height,
          key,                       // 池键：定位该层的像素
          pxv: l._pxv || 0,          // 该层当前像素版本
          text: l.text ? { ...l.text } : null,           // 文字源数据（保证撤销后仍可再编辑）
          textBox: l._textBox ? { ...l._textBox } : null,
          curves: l.curves ? JSON.parse(JSON.stringify(l.curves)) : null, // 曲线定义
          hasMask,                                          // 蒙版存在性
          maskEnabled: hasMask ? l.maskEnabled !== false : true,
          mv: l._maskVersion || 0,                          // 蒙版像素版本
          mkey: hasMask ? mkeyOf(l) : null,                 // 池键：定位蒙版像素
        };
      });
      const uses = [];
      layers.forEach(m => { uses.push(m.key); if (m.mkey) uses.push(m.mkey); });
      return { label, activeId: s.activeId, layerSeq: s.layerSeq, layers, uses };
    },

    /** 提交一次操作（在操作完成后调用） */
    commit(label) {
      // 清掉重做分支：被丢弃的快照释放其对克隆池的引用
      while (this.entries.length - 1 > this.index) {
        release(this.entries.pop());
      }
      // 采集新快照；仅新增/变更的像素/蒙版版本才会真正克隆
      const snap = this.snapshot(label);
      const sourceByKey = new Map();
      snap.layers.forEach(m => {
        sourceByKey.set(m.key, m);
        if (m.mkey) sourceByKey.set(m.mkey, m); // 蒙版池键也指向该层元数据
      });
      retain(snap.uses, key => {
        const meta = sourceByKey.get(key);
        const l = meta ? PL.state.stack.getById(meta.id) : null;
        if (!l) return document.createElement('canvas');
        // 蒙版池键（带 @m 后缀）克隆蒙版画布，普通键克隆图层像素
        return key.indexOf('@m') !== -1 && l.mask ? l.mask : l.canvas;
      });
      this.entries.push(snap);
      if (this.entries.length > LIMIT) release(this.entries.shift());
      this.index = this.entries.length - 1;
      trimPool();   // 像素池超内存上限时逐出最旧条目
      PL.state.pristine = false;
      if (PL.updateHistoryButtons) PL.updateHistoryButtons();
    },

    /** 重置历史，把当前状态作为初始状态（新建文档 / 首次导入） */
    reset(label) {
      this.entries.forEach(release);
      const snap = this.snapshot(label);
      // 首次快照的像素需克隆（直接引用实时画布会被后续编辑污染）
      const s = PL.state;
      const sourceByKey = new Map(snap.layers.map(m => [m.key, s.stack.getById(m.id)]));
      retain(snap.uses, key => {
        const meta = sourceByKey.get(key);
        const l = meta ? PL.state.stack.getById(meta.id) : null;
        if (!l) return document.createElement('canvas');
        return key.indexOf('@m') !== -1 && l.mask ? l.mask : l.canvas;
      });
      this.entries = [snap];
      this.index = 0;
      // 注意：这里不设置 pristine —— 该标志由调用方（新建文档 / 导入图片）按语义维护，
      // 否则导入完成后会被误置为「未编辑」，导致下次导入整份文档被清空。
      if (PL.updateHistoryButtons) PL.updateHistoryButtons();
    },

    undo() {
      if (!this.canUndo()) return;
      this.index--;
      this.restore(this.entries[this.index]);
    },

    redo() {
      if (!this.canRedo()) return;
      this.index++;
      this.restore(this.entries[this.index]);
    },

    /** 用快照重建文档 */
    restore(entry) {
      const s = PL.state;
      s.stack = new PL.LayerStack();
      entry.layers.forEach(m => {
        const l = new PL.Layer(m.name, m.width, m.height);
        l.id = m.id;
        l.visible = m.visible;
        l.opacity = m.opacity;
        l.blendMode = m.blendMode;
        l._pxv = m.pxv;
        const pe = pool.get(m.key);
        if (pe) l.ctx.drawImage(pe.canvas, 0, 0);
        l.text = m.text ? { ...m.text } : null;
        l._textBox = m.textBox ? { ...m.textBox } : null;
        l.curves = m.curves ? JSON.parse(JSON.stringify(m.curves)) : null;
        l._curveVersion = (l._curveVersion || 0) + 1; // 使预览缓存失效
        // 蒙版还原：从池中取回蒙版像素
        if (m.hasMask) {
          l.initMask('#ffffff');
          const me = pool.get(m.mkey);
          if (me) {
            l.maskCtx.clearRect(0, 0, l.width, l.height);
            l.maskCtx.drawImage(me.canvas, 0, 0);
          }
          l.maskEnabled = m.maskEnabled;
          l._maskVersion = m.mv;
        } else {
          l.mask = null;
          l.maskCtx = null;
          l.maskEnabled = true;
        }
        s.stack.layers.push(l);
        PL.Layer._seq = Math.max(PL.Layer._seq, m.id);
      });
      s.activeId = s.stack.getById(entry.activeId) ? entry.activeId : (s.stack.top && s.stack.top.id);
      if (entry.layerSeq != null) s.layerSeq = entry.layerSeq; // 还原命名计数，避免撤销后新建图层重名
      if (PL.refreshAll) PL.refreshAll();
    },
  };
})();
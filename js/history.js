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

  const LIMIT = 20;

  // 像素克隆池：key = "{layerId}@{pxv}" → { canvas, refs }
  // 池中的 canvas 一经写入永不修改，只会被 drawImage 拷贝走，因此可被多份快照安全共享。
  const pool = new Map();

  function keyOf(layer) { return layer.id + '@' + (layer._pxv || 0); }

  function cloneCanvas(src) {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  /** 让一份新快照引用一组 key：未入池的当场从实时图层克隆，已入池的仅引用计数 +1 */
  function retain(keys, getSource) {
    keys.forEach(key => {
      const e = pool.get(key);
      if (e) { e.refs++; return; }
      pool.set(key, { canvas: cloneCanvas(getSource(key)), refs: 1 });
    });
  }

  /** 一份快照被丢弃（LIMIT 逐出 / 重做分支清空 / 重置）时释放其引用 */
  function release(snap) {
    if (!snap || !snap.uses) return;
    snap.uses.forEach(key => {
      const e = pool.get(key);
      if (!e) return;
      if (--e.refs <= 0) pool.delete(key);
    });
  }

  PL.history = {
    entries: [],
    index: -1,

    canUndo() { return this.index > 0; },
    canRedo() { return this.index < this.entries.length - 1; },

    /** 采集当前文档的完整快照（像素按 id@pxv 引用共享克隆池） */
    snapshot(label) {
      const s = PL.state;
      const layers = s.stack.layers.map(l => {
        const key = keyOf(l);
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
        };
      });
      return { label, activeId: s.activeId, layers, uses: layers.map(m => m.key) };
    },

    /** 提交一次操作（在操作完成后调用） */
    commit(label) {
      // 清掉重做分支：被丢弃的快照释放其对克隆池的引用
      while (this.entries.length - 1 > this.index) {
        release(this.entries.pop());
      }
      // 采集新快照；仅新增/变更的像素版本才会真正克隆
      const snap = this.snapshot(label);
      const sourceByKey = new Map(snap.layers.map(m => [m.key, m]));
      retain(snap.uses, key => {
        const l = PL.state.stack.getById(sourceByKey.get(key).id);
        return l ? l.canvas : document.createElement('canvas');
      });
      this.entries.push(snap);
      if (this.entries.length > LIMIT) release(this.entries.shift());
      this.index = this.entries.length - 1;
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
        const l = sourceByKey.get(key);
        return l ? l.canvas : document.createElement('canvas');
      });
      this.entries = [snap];
      this.index = 0;
      PL.state.pristine = true;
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
        s.stack.layers.push(l);
        PL.Layer._seq = Math.max(PL.Layer._seq, m.id);
      });
      s.activeId = s.stack.getById(entry.activeId) ? entry.activeId : (s.stack.top && s.stack.top.id);
      if (PL.refreshAll) PL.refreshAll();
    },
  };
})();
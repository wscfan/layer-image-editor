/**
 * history.js —— 撤销 / 重做
 *
 * 采用「整档快照」：每条历史记录保存全部图层的元数据 + 像素克隆。
 * 实现简单且绝对正确，代价是内存（上限 20 条，配合文档尺寸上限使用）。
 */
(function () {
  'use strict';

  const LIMIT = 20;

  PL.history = {
    entries: [],
    index: -1,

    canUndo() { return this.index > 0; },
    canRedo() { return this.index < this.entries.length - 1; },

    /** 采集当前文档的完整快照 */
    snapshot(label) {
      const s = PL.state;
      return {
        label,
        activeId: s.activeId,
        layers: s.stack.layers.map(l => ({
          id: l.id,
          name: l.name,
          visible: l.visible,
          opacity: l.opacity,
          blendMode: l.blendMode,
          width: l.width,
          height: l.height,
          pixels: l.clonePixels(),
          text: l.text ? { ...l.text } : null,           // 文字源数据（保证撤销后仍可再编辑）
          textBox: l._textBox ? { ...l._textBox } : null,
          curves: l.curves ? JSON.parse(JSON.stringify(l.curves)) : null, // 曲线定义
        })),
      };
    },

    /** 提交一次操作（在操作完成后调用） */
    commit(label) {
      this.entries = this.entries.slice(0, this.index + 1);
      this.entries.push(this.snapshot(label));
      if (this.entries.length > LIMIT) this.entries.shift();
      this.index = this.entries.length - 1;
      PL.state.pristine = false;
      if (PL.updateHistoryButtons) PL.updateHistoryButtons();
    },

    /** 重置历史，把当前状态作为初始状态（新建文档 / 首次导入） */
    reset(label) {
      this.entries = [this.snapshot(label)];
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
        l.ctx.drawImage(m.pixels, 0, 0);
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

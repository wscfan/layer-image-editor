/**
 * adjustpanel.js —— 调整面板 UI
 *
 * 滑杆拖动 → 只更新 PL.state.previewFilter，由合成器实时预览；
 * 点「应用」→ 把滤镜烘焙进当前图层像素并写入撤销历史。
 */
(function () {
  'use strict';

  const sliders = [
    { key: 'brightness', id: 'adjBrightness', fmt: v => (v > 0 ? '+' : '') + v },
    { key: 'contrast', id: 'adjContrast', fmt: v => (v > 0 ? '+' : '') + v },
    { key: 'saturation', id: 'adjSaturation', fmt: v => (v > 0 ? '+' : '') + v },
    { key: 'hue', id: 'adjHue', fmt: v => v + '°' },
    { key: 'blur', id: 'adjBlur', fmt: v => (v / 10).toFixed(1) + 'px' },
  ];

  const values = { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0 };

  function activeLayer() {
    const s = PL.state;
    return s.stack ? s.stack.getById(s.activeId) : null;
  }

  function clearPreview() {
    PL.state.previewFilter = '';
    PL.state.previewLayerId = null;
  }

  function updatePreview() {
    const f = PL.filters.buildFilter(values);
    if (f && activeLayer()) {
      PL.state.previewFilter = f;
      PL.state.previewLayerId = PL.state.activeId;
    } else {
      clearPreview();
    }
    PL.render();
  }

  PL.adjust = {
    init() {
      sliders.forEach(({ key, id, fmt }) => {
        const el = document.getElementById(id);
        const val = document.getElementById(id + 'Val');
        el.addEventListener('input', () => {
          values[key] = +el.value;
          val.textContent = fmt(+el.value);
          updatePreview();
        });
      });

      document.getElementById('btnApplyAdjust').addEventListener('click', () => {
        const l = activeLayer();
        if (l) {
          const f = PL.filters.buildFilter(values);
          if (f) {
            PL.filters.applyFilter(l, f);
            PL.history.commit('应用调整');
          }
        }
        PL.adjust.reset(false);
        PL.refreshAll();
      });

      document.getElementById('btnResetAdjust').addEventListener('click', () => PL.adjust.reset(true));

      // 一键滤镜：立即烘焙到当前图层
      document.querySelectorAll('#adjustpanel [data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
          const l = activeLayer();
          if (!l) return;
          PL.filters[btn.dataset.filter](l);
          PL.history.commit(btn.textContent.trim());
          PL.refreshAll();
        });
      });
    },

    /** 清零滑杆并取消预览 */
    reset(rerender) {
      sliders.forEach(({ key, id, fmt }) => {
        values[key] = 0;
        document.getElementById(id).value = 0;
        document.getElementById(id + 'Val').textContent = fmt(0);
      });
      clearPreview();
      if (rerender) PL.render();
    },

    /** 文档/图层被外部改变（撤销、切换等）时由 refreshAll 调用 */
    onDocChanged() {
      if (PL.state.previewFilter) this.reset(true);
    },
  };
})();

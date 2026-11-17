/**
 * dialogs.js —— 复杂配置的弹框
 *
 * 导出设置 / 图层属性 / 工具设置 / 文档设置 / 新建文档
 * 选项栏只保留常用快捷项，完整参数收进这些弹框。
 */
(function () {
  'use strict';

  const BLEND_OPTIONS = [
    ['source-over', '正常'], ['multiply', '正片叠底'], ['screen', '滤色'],
    ['overlay', '叠加'], ['darken', '变暗'], ['lighten', '变亮'],
    ['color-dodge', '颜色减淡'], ['color-burn', '颜色加深'],
    ['hard-light', '强光'], ['soft-light', '柔光'],
    ['difference', '差值'], ['exclusion', '排除'],
    ['hue', '色相'], ['saturation', '饱和度'], ['color', '颜色'], ['luminosity', '明度'],
  ];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function defaultFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `layerpaint-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  /** 把工具参数同步回选项栏控件 */
  function syncToolOptionsUI() {
    const o = PL.state.toolOptions;
    const set = (id, v, valId, fmt) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = v;
      if (valId) {
        const s = document.getElementById(valId);
        if (s) s.textContent = fmt ? fmt(v) : v;
      }
    };
    set('brushColor', o.color);
    set('brushSize', o.size, 'brushSizeVal');
    set('brushHardness', Math.round(o.hardness * 100), 'brushHardnessVal', (v) => v + '%');
    set('toolOpacity', Math.round(o.opacity * 100), 'toolOpacityVal', (v) => v + '%');
    set('fillTolerance', o.tolerance, 'fillToleranceVal');
    set('shapeMode', o.shapeMode);
    set('strokeWidth', o.strokeWidth);
    set('fontSize', o.fontSize);
  }

  PL.dialogs = {
    BLEND_OPTIONS,
    syncToolOptionsUI,

    init() {
      document.getElementById('btnNewDoc').addEventListener('click', () => PL.dialogs.openNewDoc());
      document.getElementById('btnDocSettings').addEventListener('click', () => PL.dialogs.openDocumentSettings());
      document.getElementById('btnToolSettings').addEventListener('click', () => PL.dialogs.openToolSettings());
      document.getElementById('btnLayerProps').addEventListener('click', () => PL.dialogs.openLayerProps());
    },

    /* ---------- 新建文档 ---------- */
    async openNewDoc() {
      const values = await PL.modal.open({
        title: '新建文档',
        fields: [
          { type: 'number', id: 'ndWidth', label: '宽度 (px)', value: 1000, min: 1, max: 8000 },
          { type: 'number', id: 'ndHeight', label: '高度 (px)', value: 660, min: 1, max: 8000 },
          {
            type: 'select', id: 'ndBg', label: '背景', value: '#ffffff',
            options: [['#ffffff', '白色'], ['#000000', '黑色'], ['transparent', '透明']],
          },
        ],
        submitText: '创建',
        submitId: 'ndOk',
      });
      if (!values) return;
      const w = clamp(parseInt(values.ndWidth, 10) || 1000, 1, 8000);
      const h = clamp(parseInt(values.ndHeight, 10) || 660, 1, 8000);
      PL.actions.newDocument(w, h, values.ndBg === 'transparent' ? null : values.ndBg);
    },

    /* ---------- 文档设置（修改画布尺寸） ---------- */
    async openDocumentSettings() {
      const d = PL.state.doc;
      const values = await PL.modal.open({
        title: '文档设置',
        fields: [
          { type: 'number', id: 'dsWidth', label: '宽度 (px)', value: d.width, min: 1, max: 8000 },
          { type: 'number', id: 'dsHeight', label: '高度 (px)', value: d.height, min: 1, max: 8000 },
          {
            type: 'select', id: 'dsBg', label: '背景', value: 'keep',
            options: [['keep', '保持原样'], ['#ffffff', '白色'], ['#000000', '黑色'], ['transparent', '透明']],
          },
          { type: 'checkbox', id: 'dsScale', label: '内容', value: true, text: '等比缩放内容并居中' },
        ],
        submitText: '应用',
      });
      if (!values) return;
      const w = clamp(parseInt(values.dsWidth, 10) || d.width, 1, 8000);
      const h = clamp(parseInt(values.dsHeight, 10) || d.height, 1, 8000);
      PL.actions.resizeDocument(w, h, values.dsBg, values.dsScale);
    },

    /* ---------- 导出设置 ---------- */
    async openExport(presetFormat) {
      const values = await PL.modal.open({
        title: '导出图片',
        wide: true,
        fields: [
          {
            type: 'select', id: 'expFormat', label: '格式', value: presetFormat || 'png',
            options: [['png', 'PNG（支持透明）'], ['jpeg', 'JPG（不支持透明）'], ['webp', 'WebP（不支持透明）']],
          },
          { type: 'range', id: 'expQuality', label: '质量', value: 92, min: 40, max: 100, unit: '%' },
          { type: 'color', id: 'expBg', label: '背景色', value: '#ffffff' },
          {
            type: 'select', id: 'expScale', label: '缩放', value: '1',
            options: [['1', '100%（原始尺寸）'], ['0.75', '75%'], ['0.5', '50%'], ['2', '200%']],
          },
          { type: 'text', id: 'expName', label: '文件名', value: defaultFileName() },
          { type: 'static', html: '<p class="tip">JPG / WebP 不支持透明通道，透明区域会填充为所选背景色；缩放会按比例改变导出像素尺寸。</p>' },
        ],
        submitText: '导出',
        onOpen: (card, api) => {
          const sync = () => {
            const fmt = api.values().expFormat;
            const isPng = fmt === 'png';
            const qRow = api.rowOf('expQuality');
            const bgRow = api.rowOf('expBg');
            if (qRow) qRow.style.display = isPng ? 'none' : '';
            if (bgRow) bgRow.style.display = isPng ? 'none' : '';
          };
          api.field('expFormat').addEventListener('change', sync);
          sync();
        },
      });
      if (!values) return;

      const fmt = values.expFormat;
      const mime = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');
      const ext = fmt === 'png' ? 'png' : (fmt === 'webp' ? 'webp' : 'jpg');
      const quality = fmt === 'png' ? undefined : (+values.expQuality) / 100;
      const bg = fmt === 'png' ? null : values.expBg;
      const scale = +values.expScale || 1;
      const name = (values.expName || defaultFileName()).trim() || defaultFileName();

      const url = PL.compositor.flatten(mime, quality, bg, scale);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.${ext}`;
      a.click();
    },

    /* ---------- 图层属性 ---------- */
    async openLayerProps() {
      const s = PL.state;
      const l = s.stack ? s.stack.getById(s.activeId) : null;
      if (!l) return;
      const values = await PL.modal.open({
        title: '图层属性',
        fields: [
          { type: 'text', id: 'lpName', label: '名称', value: l.name },
          { type: 'checkbox', id: 'lpVisible', label: '可见', value: l.visible, text: '显示该图层' },
          { type: 'range', id: 'lpOpacity', label: '不透明度', value: Math.round(l.opacity * 100), min: 0, max: 100, unit: '%' },
          { type: 'select', id: 'lpBlend', label: '混合模式', value: l.blendMode, options: BLEND_OPTIONS },
        ],
        submitText: '应用',
      });
      if (!values) return;
      const name = (values.lpName || '').trim();
      if (name) l.name = name;
      l.visible = !!values.lpVisible;
      l.opacity = clamp(+values.lpOpacity / 100, 0, 1);
      l.blendMode = values.lpBlend;
      PL.history.commit('图层属性');
      PL.refreshAll();
    },

    /* ---------- 工具设置 ---------- */
    async openToolSettings() {
      const o = PL.state.toolOptions;
      const values = await PL.modal.open({
        title: '工具设置',
        wide: true,
        fields: [
          { type: 'section', label: '画笔 / 橡皮' },
          { type: 'color', id: 'tsColor', label: '颜色', value: o.color },
          { type: 'range', id: 'tsSize', label: '大小', value: o.size, min: 1, max: 300, unit: ' px' },
          { type: 'range', id: 'tsHardness', label: '硬度', value: Math.round(o.hardness * 100), min: 0, max: 100, unit: '%' },
          { type: 'range', id: 'tsOpacity', label: '不透明度', value: Math.round(o.opacity * 100), min: 1, max: 100, unit: '%' },
          { type: 'section', label: '油漆桶' },
          { type: 'range', id: 'tsTolerance', label: '容差', value: o.tolerance, min: 0, max: 255 },
          { type: 'section', label: '矩形 / 椭圆' },
          {
            type: 'select', id: 'tsShapeMode', label: '样式', value: o.shapeMode,
            options: [['fill', '填充'], ['stroke', '描边']],
          },
          { type: 'number', id: 'tsStrokeWidth', label: '描边粗细', value: o.strokeWidth, min: 1, max: 100 },
          { type: 'section', label: '文字' },
          { type: 'number', id: 'tsFontSize', label: '字号', value: o.fontSize, min: 8, max: 400 },
        ],
        submitText: '应用',
      });
      if (!values) return;
      o.color = values.tsColor;
      o.size = clamp(+values.tsSize || 18, 1, 300);
      o.hardness = clamp(+values.tsHardness / 100, 0, 1);
      o.opacity = clamp(+values.tsOpacity / 100, 0.01, 1);
      o.tolerance = clamp(+values.tsTolerance || 0, 0, 255);
      o.shapeMode = values.tsShapeMode;
      o.strokeWidth = clamp(+values.tsStrokeWidth || 4, 1, 100);
      o.fontSize = clamp(+values.tsFontSize || 48, 8, 400);
      syncToolOptionsUI();
      PL.render();
    },
  };
})();

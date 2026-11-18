/**
 * layerpanel.js —— 图层面板 UI
 *
 * 面板自上而下 = 图层自顶向底（数组反向显示）。
 * 支持：选择、显隐、双击重命名、拖拽排序、当前图层不透明度 / 混合模式。
 */
(function () {
  'use strict';

  let listEl;

  function drawThumb(thumb, layer) {
    const c = thumb.getContext('2d');
    c.fillStyle = '#191a1e';
    c.fillRect(0, 0, thumb.width, thumb.height);
    const s = Math.min(thumb.width / layer.width, thumb.height / layer.height);
    const w = layer.width * s, h = layer.height * s;
    c.drawImage(layer.canvas, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
  }

  function startRename(row, nameEl, layer) {
    row.draggable = false;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename';
    input.value = layer.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const done = (apply) => {
      const v = input.value.trim();
      const changed = apply && v && v !== layer.name;
      if (changed) {
        layer.name = v;
        PL.history.commit('重命名图层');
        PL.refreshAll();
      } else {
        PL.layerpanel.render();
      }
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 重命名时不触发全局快捷键
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = layer.name; input.blur(); }
    });
  }

  function buildRow(layer) {
    const row = document.createElement('div');
    row.className = 'lrow' + (layer.id === PL.state.activeId ? ' active' : '') + (layer.visible ? '' : ' off');
    row.dataset.id = layer.id;
    row.draggable = true;
    row.title = '拖拽可调整顺序 · 双击名称可重命名';

    // 显隐切换
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eye';
    eye.textContent = layer.visible ? '👁' : '🙈';
    eye.title = layer.visible ? '隐藏图层' : '显示图层';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      PL.history.commit(layer.visible ? '显示图层' : '隐藏图层');
      PL.refreshAll();
    });

    // 缩略图（2x 尺寸提升清晰度）
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    thumb.width = 96;
    thumb.height = 72;
    drawThumb(thumb, layer);

    // 名称
    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = layer.name;
    name.addEventListener('dblclick', () => startRename(row, name, layer));

    row.append(eye, thumb, name);

    // 选中
    row.addEventListener('click', (e) => {
      if (e.target === eye || row.querySelector('input.rename')) return;
      PL.state.activeId = layer.id;
      PL.layerpanel.render();
    });

    // 拖拽排序：拖到某行上 = 移动到该行的位置
    row.addEventListener('dragstart', (e) => {
      if (row.querySelector('input.rename')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', String(layer.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dragover'); });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('dragover');
      const dragId = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!dragId || dragId === layer.id) return;
      const stack = PL.state.stack;
      const from = stack.indexOfId(dragId);
      const to = stack.indexOfId(layer.id);
      if (from === -1 || to === -1) return;
      stack.reorder(from, to);
      PL.state.activeId = dragId;
      PL.history.commit('调整图层顺序');
      PL.refreshAll();
    });

    return row;
  }

  PL.layerpanel = {
    init() {
      listEl = document.getElementById('layerlist');

      document.getElementById('btnAddLayer').addEventListener('click', () => PL.actions.addLayer());
      document.getElementById('btnDupLayer').addEventListener('click', () => PL.actions.duplicateLayer());
      document.getElementById('btnLayerUp').addEventListener('click', () => PL.actions.moveLayer(1));
      document.getElementById('btnLayerDown').addEventListener('click', () => PL.actions.moveLayer(-1));
      document.getElementById('btnMergeDown').addEventListener('click', () => PL.actions.mergeDown());
      document.getElementById('btnDelLayer').addEventListener('click', () => PL.actions.deleteLayer());

      // 当前图层：不透明度（input 实时预览，change 入历史）
      const op = document.getElementById('layerOpacity');
      const opVal = document.getElementById('layerOpacityVal');
      op.addEventListener('input', () => {
        const l = PL.state.stack && PL.state.stack.getById(PL.state.activeId);
        if (!l) return;
        l.opacity = op.value / 100;
        opVal.textContent = op.value + '%';
        PL.render();
      });
      op.addEventListener('change', () => {
        if (PL.state.stack && PL.state.stack.getById(PL.state.activeId)) {
          PL.history.commit('图层不透明度');
        }
      });
    },

    /** 重建整个列表，并同步当前图层的属性控件 */
    render() {
      const s = PL.state;
      if (!listEl || !s.stack) return;
      listEl.innerHTML = '';
      // 顶 → 底 显示
      [...s.stack.layers].reverse().forEach(l => listEl.appendChild(buildRow(l)));

      const active = s.stack.getById(s.activeId);
      const op = document.getElementById('layerOpacity');
      if (active) {
        op.disabled = false;
        op.value = Math.round(active.opacity * 100);
        document.getElementById('layerOpacityVal').textContent = op.value + '%';
      } else {
        op.disabled = true;
      }
    },
  };
})();

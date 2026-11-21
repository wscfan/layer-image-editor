/**
 * layerpanel.js —— 图层面板 UI
 *
 * 面板自上而下 = 图层自顶向底（数组反向显示）。
 * 支持：选择、显隐、双击重命名、拖拽排序、当前图层不透明度 / 混合模式。
 */
(function () {
  'use strict';

  let listEl;
  let ctxMenu = null;

  function drawThumb(thumb, layer) {
    const c = thumb.getContext('2d');
    c.fillStyle = '#191a1e';
    c.fillRect(0, 0, thumb.width, thumb.height);
    const s = Math.min(thumb.width / layer.width, thumb.height / layer.height);
    const w = layer.width * s, h = layer.height * s;
    c.drawImage(layer.canvas, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
  }

  /** 蒙版缩略图：黑白显示；停用时叠红叉 */
  function drawMaskThumb(thumb, layer) {
    const c = thumb.getContext('2d');
    c.fillStyle = '#191a1e';
    c.fillRect(0, 0, thumb.width, thumb.height);
    const s = Math.min(thumb.width / layer.width, thumb.height / layer.height);
    const w = layer.width * s, h = layer.height * s;
    c.drawImage(layer.mask, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
    if (layer.maskEnabled === false) {
      c.strokeStyle = '#ff5252';
      c.lineWidth = 5;
      c.beginPath();
      c.moveTo(6, 6); c.lineTo(thumb.width - 6, thumb.height - 6);
      c.moveTo(thumb.width - 6, 6); c.lineTo(6, thumb.height - 6);
      c.stroke();
    }
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

  /* ================= 右键菜单 ================= */

  function sep() {
    const d = document.createElement('div');
    d.className = 'sep';
    return d;
  }

  function menuItem(label, opts) {
    opts = opts || {};
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item' + (opts.danger ? ' danger' : '') + (opts.disabled ? ' disabled' : '');
    b.textContent = label;
    if (opts.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener('click', () => { closeContextMenu(); if (opts.onClick) opts.onClick(); });
    }
    return b;
  }

  function onDocPointerDown(e) {
    if (ctxMenu && ctxMenu.contains(e.target)) return;
    closeContextMenu();
  }
  function onDocKeyDown(e) { if (e.key === 'Escape') closeContextMenu(); }

  function closeContextMenu() {
    if (!ctxMenu) return;
    ctxMenu.remove();
    ctxMenu = null;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    document.removeEventListener('scroll', closeContextMenu, true);
    window.removeEventListener('resize', closeContextMenu);
    window.removeEventListener('blur', closeContextMenu);
  }

  function openContextMenu(layer, x, y) {
    closeContextMenu();
    const s = PL.state;
    if (!s.stack || !s.stack.getById(layer.id)) return;
    const idx = s.stack.indexOfId(layer.id);
    const isBottom = idx <= 0;
    const isTop = idx === s.stack.length - 1;

    // 右键即选中该图层
    s.activeId = layer.id;
    PL.layerpanel.render();

    const menu = document.createElement('div');
    menu.className = 'ctxmenu';

    menu.appendChild(menuItem('重命名', {
      onClick: () => {
        const row = listEl && listEl.querySelector('.lrow[data-id="' + layer.id + '"]');
        const nameEl = row && row.querySelector('.lname');
        if (row && nameEl) startRename(row, nameEl, layer);
      },
    }));
    menu.appendChild(menuItem(layer.visible ? '隐藏图层' : '显示图层', {
      onClick: () => {
        layer.visible = !layer.visible;
        PL.history.commit(layer.visible ? '显示图层' : '隐藏图层');
        PL.refreshAll();
      },
    }));
    menu.appendChild(sep());
    menu.appendChild(menuItem('复制图层', { onClick: () => PL.actions.duplicateLayer() }));
    menu.appendChild(menuItem('上移一层', { disabled: isTop, onClick: () => PL.actions.moveLayer(1) }));
    menu.appendChild(menuItem('下移一层', { disabled: isBottom, onClick: () => PL.actions.moveLayer(-1) }));
    menu.appendChild(menuItem('向下合并', { disabled: isBottom, onClick: () => PL.actions.mergeDown() }));
    menu.appendChild(menuItem('旋转 / 翻转…', { onClick: () => PL.dialogs.openRotateFlip() }));
    menu.appendChild(sep());
    // 蒙版操作
    if (layer.mask) {
      menu.appendChild(menuItem('编辑蒙版', {
        onClick: () => {
          PL.state.activeId = layer.id;
          PL.state.maskEditId = layer.id;
          if (PL.updateMaskNotice) PL.updateMaskNotice();
          PL.layerpanel.render();
        },
      }));
      menu.appendChild(menuItem(layer.maskEnabled === false ? '启用蒙版' : '停用蒙版', {
        onClick: () => { PL.state.activeId = layer.id; PL.actions.toggleMaskEnabled(); },
      }));
      menu.appendChild(menuItem('应用蒙版到像素', {
        onClick: () => { PL.state.activeId = layer.id; PL.actions.applyMask(); },
      }));
      menu.appendChild(menuItem('删除蒙版', {
        onClick: () => { PL.state.activeId = layer.id; PL.actions.addMask(false); },
      }));
      menu.appendChild(sep());
    } else {
      menu.appendChild(menuItem('添加图层蒙版', {
        onClick: () => { PL.state.activeId = layer.id; PL.actions.addMask(false); },
      }));
      menu.appendChild(sep());
    }
    menu.appendChild(menuItem('图层属性…', { onClick: () => PL.dialogs.openLayerProps() }));
    menu.appendChild(menuItem('删除图层', { danger: true, onClick: () => PL.actions.deleteLayer() }));

    document.body.appendChild(menu);
    ctxMenu = menu;

    // 定位并防止越界
    const r = menu.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 6) left = window.innerWidth - r.width - 6;
    if (top + r.height > window.innerHeight - 6) top = window.innerHeight - r.height - 6;
    if (left < 6) left = 6;
    if (top < 6) top = 6;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    document.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
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

    // 缩略图（2x 尺寸提升清晰度）：点击 = 回到图层像素编辑
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    thumb.width = 96;
    thumb.height = 72;
    drawThumb(thumb, layer);
    thumb.title = '点击编辑图层内容';
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (PL.state.maskEditId !== null) {
        PL.state.maskEditId = null;
        if (PL.updateMaskNotice) PL.updateMaskNotice();
        PL.layerpanel.render();
      }
    });

    // 蒙版缩略图：点击 = 编辑蒙版；Shift+点击 = 启用/停用
    let mthumb = null;
    if (layer.mask) {
      mthumb = document.createElement('canvas');
      mthumb.className = 'mthumb' + (PL.state.maskEditId === layer.id ? ' active' : '');
      mthumb.width = 64;
      mthumb.height = 64;
      drawMaskThumb(mthumb, layer);
      mthumb.title = '点击编辑蒙版 · Shift+点击 启用/停用（红叉=已停用）';
      mthumb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) { PL.actions.toggleMaskEnabled(); return; }
        PL.state.activeId = layer.id;
        PL.state.maskEditId = layer.id;
        if (PL.updateMaskNotice) PL.updateMaskNotice();
        PL.layerpanel.render();
      });
    }

    // 名称
    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = layer.name;
    name.addEventListener('dblclick', () => startRename(row, name, layer));

    if (mthumb) row.append(eye, thumb, mthumb, name);
    else row.append(eye, thumb, name);

    // 选中（点行 = 选中并回到图层像素编辑）
    row.addEventListener('click', (e) => {
      if (e.target === eye || e.target === mthumb || row.querySelector('input.rename')) return;
      PL.state.activeId = layer.id;
      if (PL.state.maskEditId !== null && PL.state.maskEditId !== layer.id) {
        PL.state.maskEditId = null; // 换图层时退出蒙版编辑
        if (PL.updateMaskNotice) PL.updateMaskNotice();
      }
      PL.layerpanel.render();
    });

    // 右键菜单
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (row.querySelector('input.rename')) return;
      openContextMenu(layer, e.clientX, e.clientY);
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
      // 蒙版：点击 = 添加/删除；Alt+点击 = 应用蒙版到像素
      document.getElementById('btnMask').addEventListener('click', (e) =>
        PL.actions.addMask(e.altKey));

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

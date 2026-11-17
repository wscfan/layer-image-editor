/**
 * modal.js —— 通用模态弹框
 *
 * PL.modal.open({ title, fields, submitText, submitId, wide, onOpen })
 *   → Promise<values | null>   提交返回字段值对象，取消返回 null
 *
 * fields: [{
 *   type: 'number' | 'text' | 'color' | 'range' | 'select' | 'checkbox' | 'static' | 'section',
 *   id, label, value, min, max, step, unit, options:[[value,text]], html, text
 * }]
 */
(function () {
  'use strict';

  let openCount = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtRange(f, v) {
    const val = v != null ? v : f.value;
    return val + (f.unit || '');
  }

  function buildField(f) {
    if (f.type === 'static') {
      const row = el('div', 'form-static');
      row.innerHTML = f.html || '';
      return row;
    }
    if (f.type === 'section') {
      const row = el('div', 'form-section');
      row.textContent = f.label;
      return row;
    }

    const row = el('div', 'form-row');
    const label = el('label', null, f.label);
    if (f.id) label.setAttribute('for', f.id);
    row.appendChild(label);

    const field = el('div', 'field');
    switch (f.type) {
      case 'color': {
        const input = el('input');
        input.type = 'color';
        input.id = f.id;
        input.value = f.value || '#000000';
        const txt = el('span', 'val', (f.value || '').toUpperCase());
        input.addEventListener('input', () => { txt.textContent = input.value.toUpperCase(); });
        field.append(input, txt);
        break;
      }
      case 'range': {
        const input = el('input');
        input.type = 'range';
        input.id = f.id;
        input.min = f.min; input.max = f.max; input.step = f.step || 1;
        input.value = f.value;
        const val = el('span', 'val', fmtRange(f));
        input.addEventListener('input', () => { val.textContent = fmtRange(f, input.value); });
        field.append(input, val);
        break;
      }
      case 'select': {
        const sel = el('select');
        sel.id = f.id;
        (f.options || []).forEach(([v, t]) => {
          const op = el('option', null, t);
          op.value = v;
          sel.appendChild(op);
        });
        sel.value = f.value;
        field.appendChild(sel);
        break;
      }
      case 'checkbox': {
        const box = el('input');
        box.type = 'checkbox';
        box.id = f.id;
        box.checked = !!f.value;
        field.append(box, el('span', 'check-text', f.text || ''));
        break;
      }
      default: {
        const input = el('input');
        input.type = f.type === 'number' ? 'number' : 'text';
        if (f.id) input.id = f.id;
        input.value = f.value != null ? f.value : '';
        if (f.min != null) input.min = f.min;
        if (f.max != null) input.max = f.max;
        if (f.step != null) input.step = f.step;
        field.appendChild(input);
      }
    }
    row.appendChild(field);
    return row;
  }

  PL.modal = {
    /** 当前是否有弹框打开 */
    isOpen() { return openCount > 0; },

    /** 关闭当前弹框（视为取消） */
    cancel() {
      const cur = document.querySelector('.modal');
      if (cur) cur.dispatchEvent(new CustomEvent('modal:cancel'));
    },

    open(options) {
      const {
        title, fields = [], submitText = '确定', cancelText = '取消',
        submitId, wide, onOpen,
      } = options;

      return new Promise((resolve) => {
        const overlay = el('div', 'modal');
        overlay.id = 'modal';
        const card = el('div', 'modal-card' + (wide ? ' wide' : ''));

        card.appendChild(el('h3', null, title));

        const body = el('div', 'form-body');
        fields.forEach(f => body.appendChild(buildField(f)));
        card.appendChild(body);

        const foot = el('div', 'btnrow right');
        const cancelBtn = el('button', null, cancelText);
        cancelBtn.type = 'button';
        const okBtn = el('button', 'primary', submitText);
        okBtn.type = 'button';
        if (submitId) okBtn.id = submitId;
        foot.append(cancelBtn, okBtn);
        card.appendChild(foot);

        overlay.appendChild(card);
        document.body.appendChild(overlay);
        openCount++;

        // 读取当前表单值
        const readValues = () => {
          const values = {};
          fields.forEach(f => {
            if (!f.id || f.type === 'static' || f.type === 'section') return;
            const input = document.getElementById(f.id);
            if (!input) return;
            values[f.id] = f.type === 'checkbox' ? input.checked : input.value;
          });
          return values;
        };

        let closed = false;
        const close = (v) => {
          if (closed) return;
          closed = true;
          openCount = Math.max(0, openCount - 1);
          overlay.remove();
          resolve(v);
        };

        cancelBtn.addEventListener('click', () => close(null));
        okBtn.addEventListener('click', () => close(readValues()));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        overlay.addEventListener('modal:cancel', () => close(null));
        overlay.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close(null); }
          if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' &&
              e.target.type !== 'range' && e.target.type !== 'color') {
            e.preventDefault();
            close(readValues());
          }
        });

        if (onOpen) {
          onOpen(card, {
            values: readValues,
            field: (id) => document.getElementById(id),
            rowOf: (id) => {
              const inp = document.getElementById(id);
              return inp ? inp.closest('.form-row') : null;
            },
          });
        }

        const first = card.querySelector('input:not([type=range]):not([type=color]), select');
        if (first) setTimeout(() => first.focus(), 0);
      });
    },
  };
})();

/* Liquid-glass dropdowns: replaces the native select popup with a custom glass list. */
(() => {
  'use strict';
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openState = null;

  function closeOpen() {
    if (!openState) return;
    const { list, btn } = openState;
    list.classList.remove('show');
    btn.setAttribute('aria-expanded', 'false');
    btn.parentNode.classList.remove('open');
    setTimeout(() => list.remove(), 280);
    openState = null;
  }

  function enhance(sel) {
    if (sel.dataset.gs) return;
    sel.dataset.gs = '1';
    const wrap = document.createElement('span');
    wrap.className = 'gs';
    ['width', 'flex', 'maxWidth', 'minWidth', 'margin', 'marginLeft'].forEach(k => { if (sel.style[k]) wrap.style[k] = sel.style[k]; });
    if (sel.classList.contains('priority-select')) wrap.classList.add('gs-block');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('gs-native');
    sel.tabIndex = -1;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gs-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (sel.title) btn.title = sel.title;
    btn.innerHTML = '<span class="gs-label"></span><svg class="gs-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
    wrap.appendChild(btn);
    const label = btn.querySelector('.gs-label');

    const sync = () => {
      const o = sel.options[indexDesc.get.call(sel)];
      label.textContent = o ? o.textContent : '';
      if (o && o.style.fontFamily) label.style.fontFamily = o.style.fontFamily; else label.style.fontFamily = '';
      btn.disabled = sel.disabled;
    };
    Object.defineProperty(sel, 'value', { configurable: true, get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); sync(); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return indexDesc.get.call(this); }, set(v) { indexDesc.set.call(this, v); sync(); } });
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    sel.addEventListener('change', sync);
    sync();

    const choose = (i) => {
      indexDesc.set.call(sel, i);
      sync();
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const open = () => {
      closeOpen();
      const list = document.createElement('div');
      list.className = 'gs-list';
      list.setAttribute('role', 'listbox');
      const accent = getComputedStyle(btn).getPropertyValue('--panel-accent');
      if (accent) list.style.setProperty('--panel-accent', accent);
      const cur = indexDesc.get.call(sel);
      Array.from(sel.options).forEach((o, i) => {
        if (o.hidden) return;
        const it = document.createElement('div');
        it.className = 'gs-item' + (i === cur ? ' selected' : '') + (o.disabled ? ' disabled' : '');
        it.setAttribute('role', 'option');
        it.textContent = o.textContent;
        if (o.style.fontFamily) it.style.fontFamily = o.style.fontFamily;
        it.dataset.i = i;
        if (!o.disabled) it.addEventListener('click', (e) => { e.stopPropagation(); choose(i); closeOpen(); btn.focus(); });
        list.appendChild(it);
      });
      document.body.appendChild(list);
      const position = () => {
        const r = btn.getBoundingClientRect();
        const w = Math.max(r.width, 150);
        list.style.minWidth = w + 'px';
        const lh = Math.min(list.scrollHeight, 232);
        const below = innerHeight - r.bottom - 10, above = r.top - 10;
        const up = below < lh && above > below;
        list.style.maxHeight = Math.max(110, Math.min(232, up ? above : below)) + 'px';
        const left = Math.min(Math.max(8, r.right - Math.max(w, list.offsetWidth)), innerWidth - Math.max(w, list.offsetWidth) - 8);
        list.style.left = left + 'px';
        if (up) { list.style.top = ''; list.style.bottom = (innerHeight - r.top + 6) + 'px'; list.classList.add('up'); }
        else { list.style.bottom = ''; list.style.top = (r.bottom + 6) + 'px'; list.classList.remove('up'); }
      };
      position();
      requestAnimationFrame(() => list.classList.add('show'));
      const selEl = list.querySelector('.selected');
      if (selEl) selEl.scrollIntoView({ block: 'nearest' });
      btn.setAttribute('aria-expanded', 'true');
      wrap.classList.add('open');
      openState = { list, btn, sel, choose, position, openedAt: Date.now() };
    };

    btn.addEventListener('click', (e) => { e.stopPropagation(); openState && openState.btn === btn ? closeOpen() : open(); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let i = indexDesc.get.call(sel) + dir;
        while (sel.options[i] && sel.options[i].disabled) i += dir;
        if (sel.options[i]) choose(i);
      }
    });
  }

  document.addEventListener('click', (e) => { if (openState && !openState.list.contains(e.target)) closeOpen(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpen(); });
  // Spurious scroll / resize / blur events fire in extension popups (view
  // transitions, popup auto-resize, scrollIntoView aftermath). They used to
  // slam the list shut right after opening. Reposition instead of closing, and
  // ignore anything in the first moments after opening.
  const justOpened = () => openState && Date.now() - openState.openedAt < 450;
  window.addEventListener('blur', () => {
    if (!openState || justOpened()) return;
    setTimeout(() => { if (openState && !document.hasFocus()) closeOpen(); }, 200);
  });
  window.addEventListener('resize', () => { if (openState) openState.position(); });
  document.addEventListener('scroll', (e) => {
    if (!openState || openState.list.contains(e.target) || justOpened()) return;
    const t = e.target;
    // Only react to scrolling of something that actually carries the button.
    if (t === document || (t.contains && t.contains(openState.btn))) openState.position();
  }, true);

  const scan = (root = document) => root.querySelectorAll('select').forEach(enhance);
  scan();
  new MutationObserver((muts) => muts.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType !== 1) return;
    if (n.tagName === 'SELECT') enhance(n); else if (n.querySelectorAll) scan(n);
  }))).observe(document.body, { childList: true, subtree: true });
})();

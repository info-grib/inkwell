// A small right-click menu, styled like the other floating menus (.fmenu).
// Closes on click elsewhere, Esc, scroll, resize; arrow keys and Enter work too.

export interface CtxItem {
  label: string;
  icon?: string;
  hint?: string;
  run?: () => void;
  danger?: boolean;
  /** Shown but not clickable. */
  off?: boolean;
  /** A thin line instead of an item. */
  sep?: boolean;
}

let current: { el: HTMLElement; close: () => void } | null = null;
export const closeCtx = () => current?.close();

export function showCtx(x: number, y: number, items: CtxItem[], title = ''): void {
  closeCtx();
  const menu = document.createElement('div');
  menu.className = 'fx fmenu ctx';
  menu.setAttribute('role', 'menu');
  menu.style.visibility = 'hidden';
  if (title) {
    const l = document.createElement('div');
    l.className = 'fl';
    l.textContent = title;
    menu.append(l);
  }
  const rows: { row: HTMLElement; item: CtxItem }[] = [];
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'fsep'; menu.append(s); continue; }
    const row = document.createElement('div');
    row.className = 'fi' + (it.danger ? ' danger' : '') + (it.off ? ' off' : '');
    row.setAttribute('role', 'menuitem');
    if (it.off) row.setAttribute('aria-disabled', 'true');
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = it.icon ?? '';
    const lb = document.createElement('span'); lb.textContent = it.label;
    row.append(ic, lb);
    if (it.hint) { const h = document.createElement('span'); h.className = 'fhint'; h.textContent = it.hint; row.append(h); }
    if (!it.off) {
      row.onclick = (e) => { e.stopPropagation(); close(); it.run?.(); };
      row.onmouseenter = () => select(rows.findIndex((r) => r.row === row));
    }
    rows.push({ row, item: it });
    menu.append(row);
  }
  document.body.append(menu);

  let index = -1;
  const enabled = () => rows.map((r, i) => (r.item.off ? -1 : i)).filter((i) => i >= 0);
  function select(i: number) {
    index = i;
    rows.forEach((r, k) => r.row.classList.toggle('sel', k === i));
  }
  const ac = new AbortController();
  function close() {
    ac.abort();
    menu.remove();
    if (current?.el === menu) current = null;
  }
  const opt = { signal: ac.signal, capture: true } as const;
  document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target as Node)) close(); }, opt);
  document.addEventListener('contextmenu', (e) => { if (!menu.contains(e.target as Node)) close(); }, opt);
  document.addEventListener('scroll', close, opt);
  window.addEventListener('resize', close, { signal: ac.signal });
  window.addEventListener('blur', close, { signal: ac.signal });
  document.addEventListener('keydown', (e) => {
    const en = enabled();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (!en.length) return;
      const at = en.indexOf(index);
      const next = e.key === 'ArrowDown' ? en[(at + 1) % en.length] : en[(at <= 0 ? en.length : at) - 1];
      select(next);
    } else if (e.key === 'Enter' && index >= 0) {
      e.preventDefault(); e.stopPropagation();
      const it = rows[index].item;
      close();
      it.run?.();
    }
  }, opt);

  // Inside the window, whichever side has room.
  const r = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  const top = Math.max(8, y + r.height + 8 > window.innerHeight ? Math.max(8, window.innerHeight - r.height - 8) : y);
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.visibility = '';
  current = { el: menu, close };
}

// Editing without a toolbar.
//
//   Selection bubble : select words, a small bar appears above them (B I U H " - and "+ remark")
//   Slash menu       : type "/" on an empty line to add a block
//   Line handles     : hover a paragraph, "+" (add a block below) and "::" (menu, or drag to move the block)
//
// All three are plain DOM elements drawn on top of the page. They read and change the document
// only through the TipTap editor they are given, so nothing here knows about files or projects.

import type { Editor } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';

export interface BlockUiHost {
  editor: () => Editor | null;
  /** Add a remark to the current selection (and put the cursor in its note). */
  addRemark: () => void;
  scroller: () => HTMLElement;
}

type Kind = 'text' | 'heading' | 'quote' | 'list' | 'scene';

interface SlashItem { id: string; label: string; icon: string; hint: string; keys: string; accent?: boolean }
const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', icon: 'T', hint: 'plain', keys: 'text plain paragraph' },
  { id: 'heading', label: 'Heading', icon: 'H', hint: '/h', keys: 'heading title h' },
  { id: 'quote', label: 'Quote', icon: '”', hint: '/q', keys: 'quote q' },
  { id: 'list', label: 'List', icon: '-', hint: '/l', keys: 'list bullet l' },
  { id: 'scene', label: 'Scene break', icon: '#', hint: '/s', keys: 'scene break divider s' },
  { id: 'remark', label: 'Remark', icon: '+', hint: 'on line above', keys: 'remark comment note r', accent: true },
];

function div(cls = '', id = ''): HTMLDivElement {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (id) d.id = id;
  return d;
}
function button(label: string, cls = '', aria = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  if (aria) { b.setAttribute('aria-label', aria); b.title = aria; }
  return b;
}
/** Keep the text selection when a floating control is pressed. */
const keepFocus = (e: Event) => e.preventDefault();

function kindOf(node: PMNode): Kind {
  switch (node.type.name) {
    case 'heading': return 'heading';
    case 'blockquote': return 'quote';
    case 'bulletList': case 'orderedList': return 'list';
    case 'horizontalRule': return 'scene';
    default: return 'text';
  }
}

/** A copy of a block without any remark marks (a remark belongs to one place, so a duplicate must not share it). */
function withoutRemarks(node: PMNode): PMNode {
  if (node.isText) {
    return node.marks.some((m) => m.type.name === 'remark') ? node.mark(node.marks.filter((m) => m.type.name !== 'remark')) : node;
  }
  if (node.isLeaf) return node;
  const kids: PMNode[] = [];
  node.content.forEach((c) => kids.push(withoutRemarks(c)));
  return node.copy(Fragment.from(kids));
}

export function initBlockUi(host: BlockUiHost) {
  // ---------------------------------------------------------------- bubble --------
  const bubble = div('fx hidden', 'bubble');
  bubble.setAttribute('role', 'toolbar');
  bubble.setAttribute('aria-label', 'Format the selected text');
  const bub = (cmd: string, label: string, aria: string, style = '') => {
    const b = button(label, style, aria);
    b.dataset.cmd = cmd;
    return b;
  };
  const sep = () => div('sep');
  const bBold = bub('bold', 'B', 'Bold (Ctrl/Cmd+B)'); bBold.style.fontWeight = '700';
  const bItalic = bub('italic', 'I', 'Italic (Ctrl/Cmd+I)'); bItalic.style.fontStyle = 'italic';
  const bUnder = bub('underline', 'U', 'Underline (Ctrl/Cmd+U)'); bUnder.style.textDecoration = 'underline';
  const bHead = bub('h2', 'H', 'Heading');
  const bQuote = bub('quote', '”', 'Quote');
  const bList = bub('bullet', '-', 'List');
  const bRemark = bub('remark', '+ remark', 'Add a remark (Ctrl/Cmd+Alt+M)', 'remark-btn');
  bubble.append(bBold, bItalic, bUnder, sep(), bHead, bQuote, bList, sep(), bRemark);
  bubble.addEventListener('mousedown', keepFocus);
  bubble.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') keepFocus(e); });
  bubble.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
    const ed = host.editor();
    if (!b || !ed) return;
    const c = ed.chain().focus();
    switch (b.dataset.cmd) {
      case 'bold': c.toggleBold().run(); break;
      case 'italic': c.toggleItalic().run(); break;
      case 'underline': c.toggleUnderline().run(); break;
      case 'h2': c.toggleHeading({ level: 2 }).run(); break;
      case 'quote': c.toggleBlockquote().run(); break;
      case 'bullet': c.toggleBulletList().run(); break;
      case 'remark': hideBubble(); host.addRemark(); return;
    }
    updateBubble();
  });

  function hideBubble() { bubble.classList.add('hidden'); }
  function updateBubble() {
    const ed = host.editor();
    if (!ed || dragging || slash.open || !ed.isFocused) return hideBubble();
    const { selection } = ed.state;
    if (selection.empty || !(selection instanceof TextSelection)) return hideBubble();
    bubble.classList.remove('hidden');
    bBold.classList.toggle('on', ed.isActive('bold'));
    bItalic.classList.toggle('on', ed.isActive('italic'));
    bUnder.classList.toggle('on', ed.isActive('underline'));
    bHead.classList.toggle('on', ed.isActive('heading'));
    bQuote.classList.toggle('on', ed.isActive('blockquote'));
    bList.classList.toggle('on', ed.isActive('bulletList'));
    const view = ed.view;
    const a = view.coordsAtPos(selection.from);
    const z = view.coordsAtPos(selection.to);
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const box = host.scroller().getBoundingClientRect();
    let left = Math.max(8, Math.min(a.left - 8, window.innerWidth - w - 8));
    let top = a.top - h - 8;
    if (top < box.top + 4) top = z.bottom + 8; // no room above: go below the selection
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
    left = Math.round(left);
    bubble.style.left = left + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  // ----------------------------------------------------------- slash menu -----------
  const slashEl = div('fx fmenu hidden', 'slashMenu');
  slashEl.setAttribute('role', 'listbox');
  slashEl.addEventListener('mousedown', keepFocus);
  const slash = { open: false, items: [] as SlashItem[], index: 0, dismissed: -1 };

  function closeSlash() {
    slash.open = false;
    slashEl.classList.add('hidden');
  }
  function renderSlash() {
    slashEl.innerHTML = '';
    const label = div('fl'); label.textContent = 'Add a block';
    slashEl.append(label);
    slash.items.forEach((it, i) => {
      const row = div('fi' + (i === slash.index ? ' sel' : '') + (it.accent ? ' accent' : ''));
      row.setAttribute('role', 'option');
      if (it.id === 'remark') {
        const sepEl = div('fsep');
        slashEl.append(sepEl);
      }
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = it.icon;
      const lb = document.createElement('span'); lb.textContent = it.label;
      const hint = document.createElement('span'); hint.className = 'fhint'; hint.textContent = it.hint;
      row.append(ic, lb, hint);
      row.onclick = () => chooseSlash(it);
      row.onmouseenter = () => { slash.index = i; slashEl.querySelectorAll('.fi').forEach((n, k) => n.classList.toggle('sel', k === i)); };
      slashEl.append(row);
    });
  }
  function updateSlash() {
    const ed = host.editor();
    if (!ed || !ed.isFocused) return closeSlash();
    const sel = ed.state.selection;
    const $f = sel.$from;
    const text = $f.parent.textContent;
    const m = text.match(/^\/([a-z]*)$/i);
    if (!sel.empty || $f.depth !== 1 || $f.parent.type.name !== 'paragraph' || !m || $f.parentOffset !== text.length) {
      slash.dismissed = -1;
      return closeSlash();
    }
    if (slash.dismissed === $f.before()) return closeSlash();
    const q = m[1].toLowerCase();
    const items = SLASH_ITEMS.filter((it) => !q || it.label.toLowerCase().startsWith(q) || it.keys.split(' ').some((k) => k.startsWith(q)));
    if (!items.length) return closeSlash();
    const same = slash.open && items.length === slash.items.length && items.every((it, i) => it.id === slash.items[i].id);
    slash.items = items;
    if (!same) slash.index = 0;
    slash.open = true;
    hideBubble();
    renderSlash();
    slashEl.classList.remove('hidden');
    const c = ed.view.coordsAtPos(sel.from);
    const block = ed.view.nodeDOM($f.before()) as HTMLElement | null;
    const left = block ? block.getBoundingClientRect().left : c.left;
    const h = slashEl.offsetHeight;
    let top = c.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, c.top - h - 6);
    slashEl.style.left = Math.round(left) + 'px';
    slashEl.style.top = Math.round(top) + 'px';
  }
  function chooseSlash(it: SlashItem) {
    const ed = host.editor();
    if (!ed) return;
    const $f = ed.state.selection.$from;
    ed.chain().focus().deleteRange({ from: $f.start(), to: $f.pos }).run();
    closeSlash();
    switch (it.id) {
      case 'heading': ed.chain().focus().setHeading({ level: 2 }).run(); break;
      case 'quote': ed.chain().focus().toggleBlockquote().run(); break;
      case 'list': ed.chain().focus().toggleBulletList().run(); break;
      case 'scene': ed.chain().focus().setHorizontalRule().run(); break;
      case 'remark': remarkOnLineAbove(ed); break;
      default: break;
    }
  }
  /** "/" then "Remark": the remark goes on the text of the line above, and the empty line is removed. */
  function remarkOnLineAbove(ed: Editor) {
    const { doc, selection } = ed.state;
    const $f = selection.$from;
    let i = $f.index(0) - 1;
    while (i >= 0 && !doc.child(i).isTextblock) i--;
    if (i < 0) return;
    let start = 0;
    for (let k = 0; k < i; k++) start += doc.child(k).nodeSize;
    const prev = doc.child(i);
    if (!prev.content.size) return;
    const from = start + 1;
    const to = start + prev.nodeSize - 1;
    if ($f.parent.content.size === 0) ed.chain().focus().deleteRange({ from: $f.before(), to: $f.after() }).run();
    ed.chain().focus().setTextSelection({ from, to }).run();
    host.addRemark();
  }

  // -------------------------------------------------------- line handles + menu ------
  const gutter = div('fx hidden', 'gutter');
  const gPlus = button('+', '', 'Add a block below');
  const gGrip = button('::', 'grip', 'Block menu; drag to move the block');
  gutter.append(gPlus, gGrip);
  gutter.addEventListener('mousedown', keepFocus);

  const menuEl = div('fx fmenu hidden', 'blockMenu');
  menuEl.addEventListener('mousedown', keepFocus);
  let menuOpen = false;
  let dragging = false;
  let current: { start: number; node: PMNode; dom: HTMLElement } | null = null;

  function blockAt(pos: number) {
    const ed = host.editor();
    if (!ed) return null;
    const { doc } = ed.state;
    const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    let start: number;
    let node: PMNode;
    if ($p.depth >= 1) { start = $p.before(1); node = doc.child($p.index(0)); }
    else {
      const c = doc.childAfter($p.pos);
      if (!c.node) return null;
      start = c.offset; node = c.node;
    }
    const dom = ed.view.nodeDOM(start) as HTMLElement | null;
    return dom ? { start, node, dom } : null;
  }
  function hideGutter() {
    if (menuOpen || dragging) return;
    gutter.classList.add('hidden');
    current = null;
  }
  function placeGutter() {
    if (!current) return;
    const r = current.dom.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(current.dom).paddingTop) || 0;
    const scr = host.scroller().getBoundingClientRect();
    const top = r.top + pad + 3;
    if (top < scr.top || top > scr.bottom - 24) { gutter.classList.add('hidden'); return; }
    gutter.classList.remove('hidden');
    gutter.style.left = Math.round(r.left - 62) + 'px';
    gutter.style.top = Math.round(top) + 'px';
  }

  let moveRaf = 0;
  function onPointerMove(ev: MouseEvent) {
    if (menuOpen || dragging) return;
    cancelAnimationFrame(moveRaf);
    moveRaf = requestAnimationFrame(() => {
      const ed = host.editor();
      if (!ed) return;
      const dom = ed.view.dom as HTMLElement;
      const r = dom.getBoundingClientRect();
      if (ev.clientX < r.left - 76 || ev.clientX > r.right + 4 || ev.clientY < r.top) return hideGutter();
      const x = Math.min(Math.max(ev.clientX, r.left + 4), r.right - 4);
      const hit = ed.view.posAtCoords({ left: x, top: ev.clientY });
      if (!hit) return hideGutter();
      const b = blockAt(hit.pos);
      if (!b) return hideGutter();
      const br = b.dom.getBoundingClientRect();
      if (ev.clientY < br.top - 2 || ev.clientY > br.bottom + 2) return hideGutter();
      current = b;
      placeGutter();
    });
  }

  function closeMenu() {
    menuOpen = false;
    menuEl.classList.add('hidden');
    gGrip.classList.remove('open');
  }
  function turnInto(kind: Kind) {
    const ed = host.editor();
    if (!ed || !current) return;
    const { start, node } = current;
    const { doc } = ed.state;
    closeMenu();
    const end = start + node.nodeSize;
    if (kind === 'scene') {
      // A scene break never eats text: it replaces an empty line, otherwise it goes below the block.
      if (node.isTextblock && node.content.size === 0) ed.chain().focus().insertContentAt({ from: start, to: end }, { type: 'horizontalRule' }).run();
      else ed.chain().focus().insertContentAt(end, { type: 'horizontalRule' }).run();
      return;
    }
    if (node.type.name === 'horizontalRule' || kindOf(node) === kind) return;
    const from = Selection.near(doc.resolve(start + 1), 1).from;
    const to = Selection.near(doc.resolve(end - 1), -1).to;
    const c = ed.chain().focus().setTextSelection({ from, to }).clearNodes();
    if (kind === 'heading') c.setHeading({ level: 2 });
    else if (kind === 'quote') c.setBlockquote();
    else if (kind === 'list') c.toggleBulletList();
    c.run();
    // The block was selected only to be converted; leave a caret so the formatting bar does not pop up over it.
    ed.commands.setTextSelection(ed.state.selection.to);
  }
  function blockRemark() {
    const ed = host.editor();
    if (!ed || !current) return;
    const { start, node } = current;
    closeMenu();
    if (!node.textContent.trim()) return;
    const { doc } = ed.state;
    const from = Selection.near(doc.resolve(start + 1), 1).from;
    const to = Selection.near(doc.resolve(start + node.nodeSize - 1), -1).to;
    ed.chain().focus().setTextSelection({ from, to }).run();
    host.addRemark();
  }
  function duplicateBlock() {
    const ed = host.editor();
    if (!ed || !current) return;
    const { start, node } = current;
    closeMenu();
    ed.view.dispatch(ed.state.tr.insert(start + node.nodeSize, withoutRemarks(node)).scrollIntoView());
  }
  function deleteBlock() {
    const ed = host.editor();
    if (!ed || !current) return;
    const { start, node } = current;
    closeMenu();
    ed.view.dispatch(ed.state.tr.delete(start, start + node.nodeSize));
    ed.commands.focus();
    hideGutter();
  }
  function openMenu() {
    if (!current) return;
    const kind = kindOf(current.node);
    menuEl.innerHTML = '';
    const row = (icon: string, label: string, run: () => void, cls = '', check = false) => {
      const r = div('fi ' + cls);
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon;
      const lb = document.createElement('span'); lb.textContent = label;
      r.append(ic, lb);
      if (check) { const c = document.createElement('span'); c.className = 'fhint'; c.textContent = '✓'; c.style.opacity = '1'; r.append(c); }
      r.onclick = run;
      menuEl.append(r);
    };
    const label = div('fl'); label.textContent = 'Turn into';
    menuEl.append(label);
    row('T', 'Text', () => turnInto('text'), '', kind === 'text');
    row('H', 'Heading', () => turnInto('heading'), '', kind === 'heading');
    row('”', 'Quote', () => turnInto('quote'), '', kind === 'quote');
    row('-', 'List', () => turnInto('list'), '', kind === 'list');
    row('#', 'Scene break', () => turnInto('scene'));
    row('+', 'Add remark', blockRemark, 'accent');
    row('=', 'Duplicate', duplicateBlock);
    row('x', 'Delete', deleteBlock, 'danger');
    menuOpen = true;
    gGrip.classList.add('open');
    menuEl.classList.remove('hidden');
    const g = gutter.getBoundingClientRect();
    const h = menuEl.offsetHeight;
    let top = g.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, g.top - h - 6);
    menuEl.style.left = Math.round(g.left) + 'px';
    menuEl.style.top = Math.round(top) + 'px';
  }

  gPlus.addEventListener('click', () => {
    const ed = host.editor();
    if (!ed || !current) return;
    const { start, node } = current;
    hideGutterForce();
    if (node.isTextblock && node.content.size === 0) {
      ed.chain().focus().setTextSelection(start + 1).insertContent('/').run();
    } else {
      const end = start + node.nodeSize;
      ed.chain().focus().insertContentAt(end, { type: 'paragraph', content: [{ type: 'text', text: '/' }] }).run();
      ed.commands.setTextSelection(end + 2);
    }
    updateSlash();
  });
  function hideGutterForce() { menuOpen = false; dragging = false; gutter.classList.add('hidden'); closeMenu(); }

  // ---- drag a block by its "::" ----
  const drop = div('fx dropline blockdrop hidden');
  const ghost = div('fx blockghost hidden');
  document.body.append(drop, ghost);
  gGrip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !current) return;
    ev.preventDefault();
    const ed = host.editor();
    if (!ed) return;
    const startY = ev.clientY;
    const startX = ev.clientX;
    const from = current;
    let moved = false;
    let target = -1;
    let raf = 0;
    let lastY = startY;
    gGrip.setPointerCapture(ev.pointerId);

    const blocks = () => {
      const out: { start: number; size: number; dom: HTMLElement }[] = [];
      ed.state.doc.forEach((n, offset) => {
        const dom = ed.view.nodeDOM(offset) as HTMLElement | null;
        if (dom) out.push({ start: offset, size: n.nodeSize, dom });
      });
      return out;
    };
    const aim = (y: number) => {
      const bl = blocks();
      let t = bl.length;
      for (let i = 0; i < bl.length; i++) {
        const r = bl[i].dom.getBoundingClientRect();
        if (y < (r.top + r.bottom) / 2) { t = i; break; }
      }
      target = t;
      const er = (ed.view.dom as HTMLElement).getBoundingClientRect();
      const yy = t < bl.length ? bl[t].dom.getBoundingClientRect().top : bl.length ? bl[bl.length - 1].dom.getBoundingClientRect().bottom : er.top;
      drop.style.left = Math.round(er.left) + 'px';
      drop.style.width = Math.round(er.width) + 'px';
      drop.style.top = Math.round(yy - 1) + 'px';
    };
    const scrollLoop = () => {
      const box = host.scroller().getBoundingClientRect();
      const sc = host.scroller();
      if (lastY < box.top + 40) sc.scrollTop -= 12;
      else if (lastY > box.bottom - 40) sc.scrollTop += 12;
      aim(lastY);
      raf = requestAnimationFrame(scrollLoop);
    };
    const move = (e: PointerEvent) => {
      lastY = e.clientY;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      if (!moved) {
        moved = true;
        dragging = true;
        closeMenu();
        hideBubble();
        const gr = from.dom.getBoundingClientRect();
        ghost.style.cssText = `left:${Math.round(gr.left - 6)}px;top:${Math.round(gr.top - 2)}px;width:${Math.round(gr.width + 12)}px;height:${Math.round(gr.height + 4)}px`;
        ghost.classList.remove('hidden');
        drop.classList.remove('hidden');
        document.body.style.cursor = 'grabbing';
        raf = requestAnimationFrame(scrollLoop);
      }
      aim(e.clientY);
    };
    const up = () => {
      gGrip.removeEventListener('pointermove', move);
      gGrip.removeEventListener('pointerup', up);
      gGrip.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      document.body.style.cursor = '';
      drop.classList.add('hidden');
      ghost.classList.add('hidden');
      dragging = false;
      if (!moved) { if (menuOpen) closeMenu(); else openMenu(); return; }
      const bl = blocks();
      const i = bl.findIndex((b) => b.start === from.start);
      if (i < 0 || target < 0 || target === i || target === i + 1) return;
      const at = target < bl.length ? bl[target].start : ed.state.doc.content.size;
      const tr = ed.state.tr;
      const node = ed.state.doc.nodeAt(from.start)!;
      tr.delete(from.start, from.start + node.nodeSize);
      const insertAt = at > from.start ? at - node.nodeSize : at;
      tr.insert(insertAt, node);
      tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 1), 1));
      ed.view.dispatch(tr.scrollIntoView());
      ed.commands.focus();
      current = blockAt(insertAt);
      placeGutter();
    };
    gGrip.addEventListener('pointermove', move);
    gGrip.addEventListener('pointerup', up);
    gGrip.addEventListener('pointercancel', up);
  });

  // ---------------------------------------------------------------- wiring ----------
  document.body.append(bubble, slashEl, gutter, menuEl);
  const scroller = host.scroller();
  scroller.addEventListener('mousemove', onPointerMove);
  scroller.addEventListener('mouseleave', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && (gutter.contains(to) || menuEl.contains(to))) return;
    hideGutter();
  });
  scroller.addEventListener('scroll', () => {
    if (!dragging) { closeMenu(); hideGutter(); }
    if (!bubble.classList.contains('hidden')) updateBubble();
    if (slash.open) updateSlash();
  }, { passive: true });
  document.addEventListener('mousedown', (e) => {
    const t = e.target as Node;
    if (menuOpen && !menuEl.contains(t) && !gutter.contains(t)) closeMenu();
  }, true);
  window.addEventListener('resize', () => { updateBubble(); if (slash.open) updateSlash(); hideGutterForce(); });

  return {
    /** Call after every (re)mount of the editor: the pieces follow its selection and focus. */
    attach(ed: Editor) {
      const refresh = () => { updateBubble(); updateSlash(); };
      ed.on('selectionUpdate', refresh);
      ed.on('update', refresh);
      ed.on('focus', refresh);
      ed.on('blur', () => { hideBubble(); closeSlash(); });
      hideGutterForce();
      closeSlash();
      hideBubble();
    },
    /** Editor key handler: arrows, Enter and Esc drive the slash list while it is open. */
    handleKey(e: KeyboardEvent): boolean {
      if (menuOpen && e.key === 'Escape') { closeMenu(); return true; }
      if (!slash.open) return false;
      if (e.key === 'ArrowDown') { slash.index = (slash.index + 1) % slash.items.length; renderSlash(); return true; }
      if (e.key === 'ArrowUp') { slash.index = (slash.index - 1 + slash.items.length) % slash.items.length; renderSlash(); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { chooseSlash(slash.items[slash.index]); return true; }
      if (e.key === 'Escape') {
        const ed = host.editor();
        if (ed) slash.dismissed = ed.state.selection.$from.before();
        closeSlash();
        return true;
      }
      return false;
    },
    hideAll() { hideGutterForce(); closeSlash(); hideBubble(); },
    isSlashOpen: () => slash.open,
  };
}

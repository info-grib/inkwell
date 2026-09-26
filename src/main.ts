import './fonts';
import './style.css';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import Typography from '@tiptap/extension-typography';

import { Remark, activeRemarkKey, collectRemarkRanges } from './remark';
import { initBlockUi } from './blocks';
import { makeSortable, wasDragged } from './sortable';
import { applyWindowLook, isMacApp } from './mac';
import {
  ARTIFACT, canPickFolder, forgetLastProject, hasBrowserStorage, lastProject, openBrowserStorage, pickFolder, saveFiles, saveTextFile,
  type Fs,
} from './fs';
import { Project, countWords, newId, type Kind, type Remark as RemarkRec, type SpellSetting, type TrashEntry } from './project';
import { Spellcheck, rescanSpelling, spellWordAt } from './spellcheck';
import { addToDictionary, spellLangName, suggest as spellSuggest, type SpellLang } from './spell';
import { Library, type TrashedBook } from './library';
import { chapterToMarkdown, slug } from './export';
import { chapterFileNames, isMarkdownName, markdownToChapters, naturalCompare, type SplitMode } from './markdown';
import { lsGet, lsSet } from './store';
import { showCtx, closeCtx, type CtxItem } from './ctxmenu';

// ============================================================ helpers ======

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(label: string, cls = '', onclick?: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onclick) b.onclick = onclick;
  return b;
}
const fmt = (n: number) => n.toLocaleString();
const wordsIn = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
// Local calendar date, not UTC — toISOString() would roll "today" over at midnight UTC instead of midnight
// where the person actually is, so the daily-goal counter could reset (or fail to) at the wrong local hour.
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Strip anything active from HTML before showing it as a preview. */
function safeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,img,svg,form').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((n) => {
    for (const a of Array.from(n.attributes)) if (a.name.startsWith('on') || a.name === 'href' || a.name === 'src') n.removeAttribute(a.name);
  });
  return doc.body.innerHTML;
}

let toastTimer: number | undefined;
function toast(msg: string, actionLabel?: string, action?: () => void) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(el('span', '', msg));
  if (actionLabel && action) {
    t.append(btn(actionLabel, '', () => { t.classList.add('hidden'); action(); }));
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), actionLabel ? 8000 : 3500);
}

// ------------------------------------------------------------- modal --------

const modal = $<HTMLDialogElement>('#modal');
$('#modalClose').onclick = () => modal.close();

function showModal(title: string, build: (body: HTMLElement, foot: HTMLElement, close: () => void) => HTMLElement | void) {
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  const foot = $('#modalFoot');
  body.innerHTML = '';
  foot.innerHTML = '';
  const focusEl = build(body, foot, () => modal.close());
  if (!modal.open) modal.showModal();
  if (focusEl) setTimeout(() => { focusEl.focus(); if (focusEl instanceof HTMLInputElement) focusEl.select(); }, 0);
}

function askText(title: string, label: string, value: string, note = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    showModal(title, (body, foot, close) => {
      if (note) body.append(el('p', 'note', note));
      body.append(el('label', 'note', label));
      const input = el('input');
      input.value = value;
      input.style.width = '100%';
      input.style.marginTop = '6px';
      body.append(input);
      const ok = btn('OK', 'primary', () => { result = input.value; close(); });
      foot.append(btn('Cancel', '', close), ok);
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } };
      return input;
    });
    modal.addEventListener('close', () => resolve(result), { once: true });
  });
}

// ============================================================ settings =====

interface Settings {
  theme: 'auto' | 'light' | 'dark';
  /** Font of the text: Courier Prime (default), Source Serif 4, Source Sans 3 or IBM Plex Mono. */
  docFont: 'courier' | 'serif' | 'sans' | 'plex';
  /** Font of the interface around it. */
  uiFont: 'plex' | 'sans' | 'system';
  size: number;
  /** Accent colour as #rrggbb; empty means the default blue. */
  accent: string;
  /** Mac app only: translucent window. */
  translucent: boolean;
  /** Mac app only: how see-through the sidebar is (0-100; 100 = the plain blur of the system) and the page (0-60; 0 = solid). */
  sideTransp: number;
  pageTransp: number;
  quotes: 'english' | 'ukrainian' | 'guillemets' | 'german' | 'off';
  dashes: boolean;
  goal: number;
}
const DEFAULT_ACCENT = '#2b4bd6';
const DEFAULTS: Settings = {
  theme: 'auto', docFont: 'courier', uiFont: 'plex', size: 17, accent: '', translucent: true, sideTransp: 100, pageTransp: 0,
  quotes: 'english', dashes: true, goal: 500,
};
let settings: Settings = { ...DEFAULTS };
try {
  // Settings from version 2.0 used other keys for font and size; only the ones that still mean the same are kept.
  // (Spell-check used to be a free-text "lang" here; it's now the book's own setting — see project.data.spellLang.)
  const stored = JSON.parse(lsGet('inkwell.settings') || '{}') as Record<string, unknown>;
  if (stored.v === 3) settings = { ...DEFAULTS, ...(stored as Partial<Settings>) };
  else {
    for (const k of ['quotes', 'dashes', 'goal'] as const) if (k in stored) (settings as unknown as Record<string, unknown>)[k] = stored[k];
    if (stored.theme === 'light' || stored.theme === 'dark' || stored.theme === 'auto') settings.theme = stored.theme;
    else if (stored.theme === 'sepia') settings.theme = 'light';
  }
} catch { /* keep defaults */ }

const saveSettings = () => { try { lsSet('inkwell.settings', JSON.stringify({ v: 3, ...settings })); } catch { /* ignore */ } };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** Is a #rrggbb colour light enough that text on it should be dark? */
function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}

let layoutRaf = 0;
function applySettings() {
  const root = document.documentElement;
  // "Match system" follows the host page's light/dark choice if it stamps one, else the OS.
  const host = root.getAttribute('data-theme');
  const dark = host ? host === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = settings.theme === 'auto' ? (dark ? 'dark' : 'light') : settings.theme;
  root.dataset.inkTheme = theme;
  root.dataset.docFont = settings.docFont;
  root.dataset.uiFont = settings.uiFont;
  root.style.setProperty('--fs', settings.size + 'px');
  if (/^#[0-9a-f]{6}$/i.test(settings.accent) && settings.accent.toLowerCase() !== DEFAULT_ACCENT) {
    root.style.setProperty('--accent-base', settings.accent);
    if (theme === 'light') root.style.setProperty('--accent-ink', isLight(settings.accent) ? '#101010' : '#ffffff');
    else root.style.removeProperty('--accent-ink');
  } else {
    root.style.removeProperty('--accent-base');
    root.style.removeProperty('--accent-ink');
  }
  root.style.setProperty('--side-veil', 100 - clamp(settings.sideTransp, 0, 100) + '%');
  root.style.setProperty('--page-veil', 100 - clamp(settings.pageTransp, 0, 60) + '%');
  void applyWindowLook(settings.translucent, settings.theme);
  scheduleLayout();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);
new MutationObserver(applySettings).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// =============================================================== state =====

let library: Library | null = null;
let project: Project | null = null;
let bookFolder = '';
let editor: Editor | null = null;

const cur = {
  kind: 'chapters' as Kind,
  id: '',
  remarks: [] as RemarkRec[],
  dirty: false,
  remarksDirty: false,
  rawHtml: null as string | null,
  rawRemarks: null as string | null,
  lastSnapAt: 0,
  lastSnapHtml: '',
  active: null as string | null,
};
const wordCount = new Map<string, number>(); // id -> words
let showResolved = false;

// ============================================================ welcome ======

async function showWelcome(noAuto = false) {
  if (ARTIFACT) {
    // Hosted preview: skip the chooser, open (or create) the sample project kept in this browser.
    await openLibrary(await openBrowserStorage(), true);
    return;
  }
  $('#app').classList.add('hidden');
  $('#welcome').classList.remove('hidden');
  const bContinue = $<HTMLButtonElement>('#btnContinue');
  const bPick = $<HTMLButtonElement>('#btnPick');
  const bOpfs = $<HTMLButtonElement>('#btnOpfs');
  bContinue.classList.add('hidden');
  bPick.classList.toggle('hidden', !canPickFolder());
  bOpfs.classList.toggle('hidden', !hasBrowserStorage());
  if (!canPickFolder()) bOpfs.classList.add('primary');

  $('#welcomeHint').textContent = canPickFolder()
    ? 'Tip: choose a folder inside your Nextcloud sync folder. Each book gets a folder of its own inside it, and your writing follows you between devices.'
    : "This browser can't save into a folder of your choice, so your text would stay inside the browser only. Use Export regularly, or use Chrome/Edge or the desktop app to save to a real folder.";

  const last = await lastProject();
  if (last) {
    bContinue.textContent = `Continue: ${last.label}`;
    bContinue.classList.remove('hidden');
    bContinue.onclick = async () => { const fs = await last.open(); if (fs) await openLibrary(fs); };
    if (last.ready && !noAuto) {
      const fs = await last.open();
      if (fs) { try { await openLibrary(fs); return; } catch (e) { console.warn('auto-open failed', e); } }
    }
  }
  bPick.onclick = async () => { const fs = await pickFolder(); if (fs) await openLibrary(fs); };
  bOpfs.onclick = async () => openLibrary(await openBrowserStorage());
}

async function openLibrary(fs: Fs, demo = false) {
  try {
    const lib = new Library(fs);
    let books = await lib.books();
    if (!books.length) {
      if (demo) {
        await seedDemo(lib);
      } else {
        const title = await askText(
          'Your first book',
          'Title of your novel (or collection of articles)',
          'My Novel',
          'There are no books in this folder yet. Your first one will be created inside it, in a folder of its own.',
        );
        if (title === null) { forgetLastProject(); return; }
        await lib.create(title.trim() || 'Untitled');
      }
      books = await lib.books();
    }
    library = lib;
    const last = lsGet('inkwell.lastBook.' + lib.label);
    await openBook((books.find((b) => b.folder === last) ?? books[0]).folder);
  } catch (e) {
    console.error(e);
    toast('Could not open that folder: ' + ((e as Error).message || e));
  }
}

/** Save what is pending, then make another book of the library the current one. */
async function openBook(folder: string) {
  const lib = library!;
  if (project) { await flushSave(); await flushMeta(); }
  const p = await lib.open(folder);
  if (!p) throw new Error('That book could not be read.');
  project = p;
  bookFolder = folder;
  cur.id = '';
  cur.dirty = false;
  cur.remarksDirty = false;
  cur.active = null;
  clearTimeout(statusTimer);
  lsSet('inkwell.lastBook.' + lib.label, folder);
  await enterApp();
}

/** Sample books for the hosted preview, so the first look shows the app at work. */
async function seedDemo(lib: Library): Promise<void> {
  const { project: p } = await lib.create('Salt and Signal (sample)');
  const ch1 = p.data.chapters[0];
  ch1.title = 'The Last Ferry';
  const ch2 = await p.addDoc('chapters', 'Low Tide');
  const note = await p.addDoc('notes', 'Read me');
  const remarkId = 'demo-remark';
  await p.saveDoc('chapters', ch1.id, ch1.title, [
    '<p>The last ferry left the harbour without her. Maren stood on the quay with a single suitcase and watched the wake fold itself back into the grey water, as if nothing had ever crossed it.</p>',
    `<p>“You’ll want the lamp room,” said the woman at the kiosk — and <span class="remark" data-remark="${remarkId}">she smiled, not unkindly</span>. “Nobody else does.”</p>`,
    '<p>By dusk the wind had found every gap in the keeper’s cottage. Maren lit the stove, counted eleven steps to the door, and decided that eleven was a number she could live with.</p>',
  ].join(''), [{ id: remarkId, text: 'Is the kiosk woman hiding something? Plant a clue in chapter 3.', created: new Date().toISOString(), resolved: false }]);
  await p.saveDoc('chapters', ch2.id, ch2.title, '<p>The tide went out further than the charts allowed. Somewhere beyond the rocks a bell was ringing, and there was no bell on the island.</p>', null);
  await p.saveDoc('notes', note.id, note.title, [
    '<p>This is a sample library so you can try Inkwell. Everything here is stored only in this browser.</p>',
    '<p>Try it: write in a chapter, select some words and press <strong>+ remark</strong> in the little bar that appears, type <strong>/</strong> on an empty line for the block menu, drag chapters (or a paragraph, by its <strong>::</strong> handle) to reorder them, open the book name at the top left to switch to another book or add one, or use <strong>Import</strong> and <strong>Export</strong> for Markdown files.</p>',
    '<p>The desktop app saves the same files into a real folder that Nextcloud can sync.</p>',
  ].join(''), null);
  await p.saveMeta();

  const { project: q } = await lib.create('Harbour Notes (sample articles)');
  const a1 = q.data.chapters[0];
  a1.title = 'Why lighthouses blink';
  await q.saveDoc('chapters', a1.id, a1.title, '<p>A steady light is easy to mistake for a house window. A pattern is not. Every lighthouse has its own rhythm, and sailors learned to read the rhythm long before they trusted the chart.</p>', null);
  await q.saveMeta();
}

// ========================================================== app shell ======

async function enterApp() {
  const p = project!;
  if (p.migrated) { p.migrated = false; void p.saveMeta().catch((e) => console.warn('migration save failed', e)); }
  $('#welcome').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#bookName').textContent = p.data.title;
  wordCount.clear();
  renderLists();

  // Open the chapter you were last in (or the first one).
  const lastId = lsGet('inkwell.lastDoc.' + p.fs.label);
  const target = (lastId && p.find(lastId)) || (p.data.chapters[0] && p.find(p.data.chapters[0].id)) || (p.data.notes[0] && p.find(p.data.notes[0].id));
  if (target) await openDoc(target.kind, target.meta.id);
  else { const m = await p.addDoc('chapters', ''); await openDoc('chapters', m.id); }

  // Count words in everything else in the background, for totals and today's goal.
  for (const kind of ['chapters', 'notes'] as Kind[]) {
    for (const d of p.data[kind]) {
      if (wordCount.has(d.id)) continue;
      try { wordCount.set(d.id, countWords((await p.loadDoc(kind, d.id)).html)); } catch { /* ignore */ }
    }
  }
  const key = 'inkwell.day.' + p.fs.label;
  let day: { date: string; base: number } | null = null;
  try { day = JSON.parse(lsGet(key) || 'null'); } catch { /* ignore */ }
  if (!day || day.date !== today()) {
    day = { date: today(), base: totalWords() };
    lsSet(key, JSON.stringify(day));
  }
  todayBase = day.base;
  renderLists();
  updateStatus();
}
let todayBase = 0;

const totalWords = () => project ? project.data.chapters.reduce((s, d) => s + (wordCount.get(d.id) ?? 0), 0) : 0;

// ---- sidebar -------------------------------------------------------------

/** "01." for chapter 1, "#." when the author is not sure of the number yet (0). */
const numLabel = (n: number) => (n > 0 ? String(n).padStart(2, '0') : '#') + '.';

function renderLists(focusId?: string) {
  if (!project) return;
  for (const kind of ['chapters', 'notes'] as Kind[]) {
    const ul = $(kind === 'chapters' ? '#chapterList' : '#noteList');
    ul.innerHTML = '';
    const docs = project.data[kind];
    if (!docs.length) { ul.append(el('li', 'empty', kind === 'chapters' ? 'No chapters yet' : 'No notes yet')); continue; }
    let dividerShown = false;
    for (const d of docs) {
      if (!dividerShown && !(d.number > 0)) {
        const div = el('li', 'list-divider');
        div.setAttribute('aria-hidden', 'true');
        ul.append(div);
        dividerShown = true;
      }
      const li = el('li');
      li.dataset.id = d.id;
      li.dataset.num = d.number > 0 ? '1' : '0';
      li.tabIndex = 0;
      li.setAttribute('aria-label', `${numLabel(d.number)} ${d.title || 'Untitled'}`);
      if (d.id === cur.id) { li.classList.add('active'); li.setAttribute('aria-current', 'true'); }
      li.title = d.title || 'Untitled';
      li.append(el('span', 'num', numLabel(d.number)), el('span', 't', d.title || 'Untitled'));
      const x = btn('×', 'x');
      x.title = 'Move to Trash';
      x.setAttribute('aria-label', 'Move to Trash');
      x.onclick = (e) => { e.stopPropagation(); void deleteDoc(kind, d.id); };
      const grip = el('span', 'grip', '::');
      grip.setAttribute('aria-hidden', 'true');
      li.append(x, grip);
      li.onclick = () => { if (!wasDragged() && d.id !== cur.id) void openDoc(kind, d.id); };
      li.onkeydown = (e) => {
        if (e.target !== li) return;
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          void moveDocBy(kind, d.id, e.key === 'ArrowUp' ? -1 : 1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (d.id !== cur.id) void openDoc(kind, d.id);
        }
      };
      ul.append(li);
    }
    if (!dividerShown) {
      const div = el('li', 'list-divider');
      div.setAttribute('aria-hidden', 'true');
      ul.append(div);
    }
  }
  if (focusId) document.querySelector<HTMLElement>(`.doclist li[data-id="${focusId}"]`)?.focus();
  updateTopTitle();
  updateDocNav();
}

/** The small title in the top strip: it appears once the big one has scrolled out of sight. */
const topTitle = $('#topTitle');
const scroller = $('#scroll');
function updateTopTitle() {
  const f = project?.find(cur.id);
  const head = $('#docHead');
  const away = !!f && scroller.scrollTop > head.offsetTop + head.offsetHeight - 24;
  topTitle.textContent = f ? `${numLabel(f.meta.number).replace(/\.$/, '')} · ${f.meta.title || 'Untitled'}` : '';
  topTitle.classList.toggle('show', away);
  topTitle.setAttribute('aria-hidden', String(!away));
  topTitle.tabIndex = away ? 0 : -1;
}
scroller.addEventListener('scroll', updateTopTitle, { passive: true });
topTitle.onclick = () => { scroller.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };

/** "Previous" / "Next" links under the text, following the same order as the sidebar. */
const docNav = $('#docNav');
function updateDocNav() {
  docNav.innerHTML = '';
  const f = project?.find(cur.id);
  if (!f) return;
  const list = project!.data[f.kind];
  const i = list.findIndex((d) => d.id === f.meta.id);
  if (i < 0) return;
  const prev = i > 0 ? list[i - 1] : null;
  const next = i < list.length - 1 ? list[i + 1] : null;
  const link = (dir: 'prev' | 'next', d: { id: string; title: string; number: number }) => {
    const b = el('button', `docnav-link docnav-${dir}`);
    b.append(
      el('span', 'docnav-dir', dir === 'prev' ? '‹ Previous' : 'Next ›'),
      el('span', 'docnav-t', `${numLabel(d.number)} ${d.title || 'Untitled'}`),
    );
    b.title = `${dir === 'prev' ? 'Previous' : 'Next'} (Ctrl/Cmd+${dir === 'prev' ? '[' : ']'})`;
    b.onclick = () => void openDoc(f.kind, d.id);
    return b;
  };
  if (prev) docNav.append(link('prev', prev));
  if (next) docNav.append(link('next', next));
}
/** Ctrl/Cmd+[ and Ctrl/Cmd+]: open the previous / next chapter or note, in sidebar order. */
function navigateDoc(delta: -1 | 1) {
  const f = project?.find(cur.id);
  if (!f) return;
  const list = project!.data[f.kind];
  const i = list.findIndex((d) => d.id === f.meta.id);
  const target = list[i + delta];
  if (target) void openDoc(f.kind, target.id);
}
makeSortable([{ el: $('#chapterList'), id: 'chapters' }, { el: $('#noteList'), id: 'notes' }], {
  onMove: (id, from, to, numbered, before) =>
    (from === to ? void moveDoc(from as Kind, id, numbered, before) : void moveAcross(id, to as Kind, numbered, before)),
});

/** After the order or numbers changed: redraw, show the current number, save. */
async function orderChanged(focusId?: string) {
  renderLists(focusId);
  if (document.activeElement !== docNum) showNumber();
  await project!.saveMeta();
}
/** Move a chapter or note before another one, on the numbered or the "Not numbered" side of the divider. */
async function moveDoc(kind: Kind, id: string, numbered: boolean, beforeId: string | null, focus = false) {
  const r = project!.dropBefore(kind, id, numbered, beforeId);
  if (r === 'same') return;
  await orderChanged(focus ? id : undefined);
}
/** A chapter becomes a note or the other way round (dragged into the other list, or the right-click menu). */
async function moveAcross(id: string, toKind: Kind, numbered: boolean, beforeId: string | null) {
  const p = project!;
  const wasCurrent = id === cur.id;
  await flushSave();
  const title = p.find(id)?.meta.title || 'Untitled';
  if (!(await p.moveDocKind(id, toKind, numbered, beforeId))) return;
  if (wasCurrent) cur.kind = toKind;
  await orderChanged(id);
  updateStatus();
  toast(`“${title}” is now ${toKind === 'notes' ? 'a note' : 'a chapter'}.`);
}
/** One step up or down (Alt+Up / Alt+Down, context menu). */
async function moveDocBy(kind: Kind, id: string, delta: -1 | 1) {
  if (!project!.shift(kind, id, delta)) return;
  await orderChanged(id);
}

async function addDoc(kind: Kind, afterId?: string) {
  await flushSave();
  const p = project!;
  const meta = await p.addDoc(kind, '');
  const after = afterId ? p.data[kind].find((d) => d.id === afterId) : undefined;
  if (after && after.number > 0) { p.setNumber(kind, meta.id, after.number + 1); await p.saveMeta(); }
  await openDoc(kind, meta.id);
  const t = $<HTMLTextAreaElement>('#docTitle');
  t.focus();
  t.select();
}

/** A copy of some HTML without the remark highlights (a remark belongs to one place). */
function withoutRemarkMarks(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  body.querySelectorAll('span[data-remark]').forEach((sp) => sp.replaceWith(...Array.from(sp.childNodes)));
  return body.innerHTML;
}
/** "Chapter" -> "Chapter (copy)" -> "Chapter (copy 2)" -> "Chapter (copy 3)" (never "(copy) (copy)"). */
function nextCopyTitle(title: string): string {
  if (!title) return '';
  const m = title.match(/^(.*) \(copy(?: (\d+))?\)$/);
  if (!m) return `${title} (copy)`;
  return `${m[1]} (copy ${m[2] ? parseInt(m[2], 10) + 1 : 2})`;
}
async function duplicateDoc(kind: Kind, id: string) {
  const p = project!;
  const src = p.find(id);
  if (!src) return;
  await flushSave();
  const d = await p.loadDoc(kind, id);
  const title = nextCopyTitle(src.meta.title);
  const meta = await p.addDoc(kind, title);
  await p.saveDoc(kind, meta.id, title, withoutRemarkMarks(d.html), null);
  wordCount.set(meta.id, countWords(d.html));
  if (src.meta.number > 0) p.setNumber(kind, meta.id, src.meta.number + 1);
  else {
    p.setNumber(kind, meta.id, 0);
    const list = p.data[kind];
    const next = list[list.findIndex((x) => x.id === id) + 1];
    p.dropBefore(kind, meta.id, false, next && next.id !== meta.id ? next.id : null);
  }
  await p.saveMeta();
  await openDoc(kind, meta.id);
  toast('Duplicated. Remark highlights are not copied.');
}

/** Rename a chapter or note right in the sidebar. */
function renameInline(kind: Kind, id: string) {
  const li = document.querySelector<HTMLElement>(`.doclist li[data-id="${id}"]`);
  const f = project?.find(id);
  const t = li?.querySelector<HTMLElement>('.t');
  if (!li || !f || !t) return;
  const input = el('input', 'rename');
  input.value = f.meta.title;
  input.placeholder = 'Untitled';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Title');
  t.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.replace(/\s+/g, ' ').trim();
    if (save && v !== f.meta.title) {
      f.meta.title = v;
      if (id === cur.id) { setTitle(v); cur.dirty = true; scheduleSave(); }
      else {
        try { const d = await project!.loadDoc(kind, id); await project!.saveDoc(kind, id, v, d.html, null); } catch { /* project.json is what counts */ }
      }
      saveMetaSoon();
    }
    renderLists(id);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
  };
  input.onblur = () => void finish(true);
  input.onclick = (e) => e.stopPropagation();
}

// ---- right-click menu in the sidebar ------------------------------------------------------
$('#lists').addEventListener('contextmenu', (e) => {
  if (!project) return;
  e.preventDefault();
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('li[data-id]');
  const section = target.closest('section');
  const kind: Kind = row?.closest('#noteList') || (!row && section?.querySelector('#noteList')) ? 'notes' : 'chapters';
  const one = kind === 'chapters' ? 'chapter' : 'note';
  const items: CtxItem[] = [];
  if (row) {
    const id = row.dataset.id!;
    const f = project.find(id);
    items.push(
      { label: 'Rename', icon: 'A', run: () => renameInline(kind, id) },
      { label: 'Duplicate', icon: '=', run: () => void duplicateDoc(kind, id) },
      { sep: true, label: '' },
      { label: 'Move up', icon: '↑', hint: '⌃/⌘+⌥+↑', off: !project.canShift(kind, id, -1), run: () => void moveDocBy(kind, id, -1) },
      { label: 'Move down', icon: '↓', hint: '⌃/⌘+⌥+↓', off: !project.canShift(kind, id, 1), run: () => void moveDocBy(kind, id, 1) },
      { label: kind === 'chapters' ? 'Move to notes' : 'Move to chapters', icon: '→', run: () => void moveAcross(id, kind === 'chapters' ? 'notes' : 'chapters', row.dataset.num === '1', null) },
      { sep: true, label: '' },
      { label: `New ${one} below`, icon: '+', run: () => void addDoc(kind, id) },
      { label: 'Move to Trash', icon: 'x', danger: true, run: () => void deleteDoc(kind, id) },
    );
    showCtx(e.clientX, e.clientY, items, f ? `${numLabel(f.meta.number)} ${f.meta.title || 'Untitled'}`.slice(0, 40) : '');
  } else {
    items.push(
      { label: 'New chapter', icon: '+', run: () => void addDoc('chapters') },
      { label: 'New note', icon: '+', run: () => void addDoc('notes') },
    );
    showCtx(e.clientX, e.clientY, items);
  }
});

async function deleteDoc(kind: Kind, id: string) {
  const p = project!;
  const wasCurrent = id === cur.id;
  if (wasCurrent) await flushSave();
  const idx = p.data[kind].findIndex((d) => d.id === id);
  const entry = await p.trashDoc(kind, id);
  if (!entry) return;
  wordCount.delete(id);
  if (wasCurrent) {
    const next = p.data[kind][Math.max(0, idx - 1)] ?? p.data.chapters[0] ?? p.data.notes[0];
    if (next) await openDoc(p.find(next.id)!.kind, next.id);
    else { const m = await p.addDoc('chapters', ''); await openDoc('chapters', m.id); }
  }
  renderLists();
  showNumber();
  updateStatus();
  toast(`“${entry.title || 'Untitled'}” moved to Trash`, 'Undo', () => void restoreEntry(entry));
}

async function restoreEntry(e: TrashEntry) {
  await project!.restoreFromTrash(e);
  const c = countWords((await project!.loadDoc(e.kind, e.id)).html);
  wordCount.set(e.id, c);
  renderLists();
  showNumber();
  updateStatus();
  toast(`Restored “${e.title || 'Untitled'}”`);
}

// ---- title and number inputs -------------------------------------------------------

let metaTimer: number | undefined;
/** Write a chapter-title change that is still waiting for its timer. */
async function flushMeta() {
  if (metaTimer === undefined) return;
  clearTimeout(metaTimer);
  metaTimer = undefined;
  await project?.saveMeta().catch(saveFailed);
}
function saveMetaSoon() {
  clearTimeout(metaTimer);
  metaTimer = window.setTimeout(() => { metaTimer = undefined; void project?.saveMeta().catch(saveFailed); }, 700);
}
const docTitle = $<HTMLTextAreaElement>('#docTitle');
/** Put a title into the field; it wraps onto several lines instead of being cut off. */
function setTitle(t: string) { docTitle.value = t; autosize(docTitle); }
docTitle.oninput = () => {
  if (docTitle.value.includes('\n')) docTitle.value = docTitle.value.replace(/\s*\n\s*/g, ' ');
  autosize(docTitle);
  if (!project) return;
  const f = project.find(cur.id);
  if (!f) return;
  f.meta.title = docTitle.value;
  renderLists();
  saveMetaSoon();
  cur.dirty = true; // the <title> inside the html file follows
  scheduleSave();
};
docTitle.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus('start'); } };

// A plain text picker in the status bar (en / ua / ru) instead of any kind of dropdown -- see the CSS comment
// above #spellFoot. Clicking the language that's already active turns spell-check off for this chapter/note;
// clicking a different one switches straight to it as an explicit override for this chapter/note. The book's
// own default (Settings > Spell-check) still governs any chapter/note that hasn't been switched here.
const spellFootOpts = Array.from(document.querySelectorAll<HTMLButtonElement>('#spellFoot .spell-opt'));
for (const opt of spellFootOpts) {
  opt.title = spellLangName(opt.dataset.value as SpellLang);
  opt.onclick = () => {
    const f = project?.find(cur.id);
    if (!f || !project) return;
    const value = opt.dataset.value as SpellSetting;
    const effective = currentSpellLang();
    const next: SpellSetting = effective === value ? 'off' : value;
    project.setSpell(f.kind, f.meta.id, next);
    saveMetaSoon();
    rescanSpelling(editor?.view);
    showSpell(next);
  };
}

const docNum = $<HTMLInputElement>('#docNum');
function showNumber() {
  const f = project?.find(cur.id);
  if (!f) return;
  $('#docKind').textContent = f.kind === 'chapters' ? 'Chapter' : 'Note';
  docNum.value = f.meta.number > 0 ? String(f.meta.number) : '#';
  $('#numHint').textContent = f.meta.number === 0 ? 'not sure yet · shown as “#”. Type a number to put it in order.' : NUM_HINT;
  showSpell(f.meta.spell ?? null);
}
/** Highlight whichever of en/ua/ru is in effect right now for the open chapter/note (its own override, or the
    book's default) -- none highlighted means spell-check is off, however it got there. */
function showSpell(_current: SpellSetting | null) {
  const effective = currentSpellLang();
  for (const opt of spellFootOpts) opt.classList.toggle('current', opt.dataset.value === effective);
}
const NUM_HINT = 'type a number and press Enter · # = not sure';
docNum.oninput = () => {
  $('#numHint').textContent = NUM_HINT;
};
/** Enter or leaving the field: the chapter moves to that place and the others follow (no gaps, no duplicates). # or ? or 0 makes it "#". */
async function commitNumber() {
  const f = project?.find(cur.id);
  if (!f) return;
  const t = docNum.value.trim();
  const n = t === '#' || t === '?' ? 0 : /^\d{1,4}$/.test(t) ? parseInt(t, 10) : NaN;
  if (Number.isNaN(n) || n === f.meta.number) { showNumber(); return; }
  project!.setNumber(f.kind, f.meta.id, n);
  await orderChanged();
  showNumber();
}
docNum.onblur = () => { void commitNumber(); };
docNum.onfocus = () => { docNum.select(); $('#numHint').textContent = NUM_HINT; };
docNum.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void commitNumber().then(() => editor?.commands.focus('start')); }
  else if (e.key === 'Escape') { showNumber(); docTitle.focus(); }
};

// ============================================================== editor =====

function typographyExtension() {
  const q = {
    english: ['“', '”', '‘', '’'],
    ukrainian: ['«', '»', '„', '’'],
    guillemets: ['«', '»', '‘', '’'],
    german: ['„', '“', '‚', '‘'],
    off: [false, false, false, false],
  }[settings.quotes] as (string | false)[];
  const d = settings.dashes ? { emDash: '—', ellipsis: '…' } : { emDash: false as const, ellipsis: false as const };
  return Typography.configure({
    openDoubleQuote: q[0], closeDoubleQuote: q[1], openSingleQuote: q[2], closeSingleQuote: q[3], ...d,
    // Symbols that get in the way of prose:
    copyright: false, trademark: false, servicemark: false, registeredTrademark: false, oneHalf: false,
    plusMinus: false, notEqual: false, laquo: false, raquo: false, multiplication: false,
    superscriptTwo: false, superscriptThree: false, oneQuarter: false, threeQuarters: false,
    leftArrow: false, rightArrow: false,
  });
}

const blocksUi = initBlockUi({
  editor: () => editor,
  addRemark: () => addRemark(),
  scroller: () => $('#scroll'),
});

/** The language to spell-check the open chapter/note against right now (its own choice, or the book's). */
function currentSpellLang(): SpellSetting {
  const f = project?.find(cur.id);
  return f ? project!.effectiveSpell(f.kind, f.meta.id) : 'off';
}
function mountEditor(html: string) {
  editor?.destroy();
  const host = $('#editor');
  host.innerHTML = '';
  editor = new Editor({
    element: host,
    content: html,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, code: false, codeBlock: false }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Remark.configure({
        onSelect: (id) => { openRemarksPanel(); setActive(id, true); },
        numberOf: (id) => remarkNums.get(id) ?? null,
      }),
      typographyExtension(),
      // Our own red underlines, drawn the same way on every platform — see src/spellcheck.ts for why.
      Spellcheck.configure({ getLang: () => currentSpellLang() }),
    ],
    editorProps: {
      attributes: {
        // The OS/browser spell-checker is left off on purpose: it can't see our chosen language, and on the
        // Mac app it draws no underlines at all. Ours (above) replaces it everywhere.
        spellcheck: 'false',
        lang: (currentSpellLang() !== 'off' ? currentSpellLang() : navigator.language) || 'en',
        autocorrect: 'on',
        autocapitalize: 'sentences',
      },
      handleKeyDown: (_view, e) => blocksUi.handleKey(e),
    },
    onUpdate: () => {
      cur.dirty = true;
      scheduleSave();
      updateStatusSoon();
      renderRemarksSoon();
      scheduleLayout();
    },
  });
  blocksUi.attach(editor);
  renderRemarks(true);
}

// ---- spell-check: right-click a red-underlined word for suggestions -------

$('#editor').addEventListener('contextmenu', (e) => {
  const lang = currentSpellLang();
  if (!editor || lang === 'off') return;
  const view = editor.view;
  const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
  const word = at ? spellWordAt(view, at.pos) : null;
  if (!word) return;
  e.preventDefault();
  const openId = cur.id;
  void (async () => {
    const items: CtxItem[] = [];
    try {
      const list = await spellSuggest(lang, word.text);
      if (list.length) {
        for (const s of list.slice(0, 6)) {
          items.push({ label: s, run: () => {
            if (cur.id !== openId || !editor) return;
            editor.chain().focus().insertContentAt({ from: word.from, to: word.to }, s).run();
          } });
        }
      } else {
        items.push({ label: 'No suggestions', off: true });
      }
    } catch {
      items.push({ label: 'Dictionary failed to load', off: true });
    }
    items.push(
      { sep: true, label: '' },
      { label: 'Add to dictionary', icon: '+', run: () => {
        void addToDictionary(lang, word.text).then(() => { if (cur.id === openId) rescanSpelling(editor?.view); });
      } },
    );
    if (cur.id === openId) showCtx(e.clientX, e.clientY, items, word.text);
  })();
});

// ----------------------------------------------------------- open / switch --

const snapDate = (name: string) => {
  const m = name.match(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : new Date(0);
};

async function openDoc(kind: Kind, id: string) {
  const p = project!;
  await flushSave();
  // Settle the word count of the text we are leaving before the pending status timer is lost.
  clearTimeout(statusTimer);
  if (editor && cur.id) wordCount.set(cur.id, wordsIn(editor.getText({ blockSeparator: ' ' })));
  const f = p.find(id);
  if (!f) return;
  const doc = await p.loadDoc(kind, id);
  cur.kind = f.kind;
  cur.id = id;
  cur.remarks = doc.remarks;
  cur.dirty = false;
  cur.remarksDirty = false;
  cur.rawHtml = doc.rawHtml;
  cur.rawRemarks = doc.rawRemarks;
  cur.lastSnapAt = Date.now();
  cur.lastSnapHtml = doc.html;
  cur.active = null;
  setTitle(f.meta.title);
  showNumber();
  document.body.classList.remove('nav-open');
  mountEditor(doc.html);
  wordCount.set(id, countWords(doc.html));
  $('#scroll').scrollTop = 0;
  try { lsSet('inkwell.lastDoc.' + p.fs.label, id); } catch { /* ignore */ }
  renderLists();
  updateStatus();
  setSaveText('');

  // Keep a snapshot of how the text looked when you opened it.
  void (async () => {
    try {
      const snaps = await p.listSnapshots(id);
      const newest = snaps[0] ? snapDate(snaps[0]).getTime() : 0;
      if (doc.html.trim() && Date.now() - newest > 30 * 60 * 1000) await p.writeSnapshot(id, f.meta.title, doc.html);
    } catch { /* history is best-effort */ }
  })();
}

// ================================================================ saving ====

let saveTimer: number | undefined;
let saveChain: Promise<void> = Promise.resolve();

function setSaveText(s: string) { $('#stSave').textContent = s; }
function saveFailed(e: unknown) {
  console.error(e);
  setSaveText('⚠ could not save: ' + ((e as Error)?.message || e));
}

function scheduleSave() {
  setSaveText('unsaved…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 800);
}

function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(doSave).catch(saveFailed);
  return saveChain;
}
const flushSave = () => saveNow();

async function doSave() {
  const p = project;
  if (!p || !editor || (!cur.dirty && !cur.remarksDirty)) return;
  const meta = p.find(cur.id)?.meta;
  if (!meta) return;
  const html = editor.getHTML();
  const wasDirty = cur.dirty;
  const wasRemarks = cur.remarksDirty;
  cur.dirty = false;
  cur.remarksDirty = false;
  try {
    const raw = await p.saveDoc(cur.kind, cur.id, meta.title, html, wasRemarks ? cur.remarks : null);
    cur.rawHtml = raw.rawHtml;
    if (raw.rawRemarks !== null) cur.rawRemarks = raw.rawRemarks;
  } catch (e) {
    cur.dirty ||= wasDirty;
    cur.remarksDirty ||= wasRemarks;
    throw e;
  }
  if (Date.now() - cur.lastSnapAt > 10 * 60 * 1000 && html !== cur.lastSnapHtml) {
    try {
      await p.writeSnapshot(cur.id, meta.title, html);
      cur.lastSnapAt = Date.now();
      cur.lastSnapHtml = html;
    } catch { /* history is best-effort */ }
  }
  setSaveText('saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}

window.addEventListener('blur', () => void saveNow());
window.addEventListener('beforeunload', () => void saveNow());

// Pick up changes made elsewhere (e.g. another device via Nextcloud).
async function checkExternal() {
  if (!project || !editor) return;
  try {
    await saveChain; // never compare against a file that is halfway through being saved
    if (!project || !editor) return;
    if (await project.reloadMeta()) {
      $('#bookName').textContent = project.data.title;
      const f = project.find(cur.id);
      if (f) { setTitle(f.meta.title); if (document.activeElement !== docNum) showNumber(); }
      renderLists();
    }
    if (cur.dirty || cur.remarksDirty) return;
    const id = cur.id;
    const doc = await project.loadDoc(cur.kind, id);
    // You may have started typing, or switched texts, while we were reading.
    if (cur.dirty || cur.remarksDirty || cur.id !== id) return;
    if (doc.rawHtml !== null && doc.rawHtml !== cur.rawHtml) {
      cur.rawHtml = doc.rawHtml;
      cur.rawRemarks = doc.rawRemarks;
      cur.remarks = doc.remarks;
      mountEditor(doc.html);
      updateStatus();
      toast('Updated with changes from another device');
    } else if (doc.rawRemarks !== cur.rawRemarks) {
      cur.rawRemarks = doc.rawRemarks;
      cur.remarks = doc.remarks;
      renderRemarks(true);
    }
  } catch { /* try again next time */ }
}
window.addEventListener('focus', () => void checkExternal());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkExternal(); });

// ================================================================ status ====

let statusTimer: number | undefined;
function updateStatusSoon() {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    if (editor) wordCount.set(cur.id, wordsIn(editor.getText({ blockSeparator: ' ' })));
    updateStatus();
    renderLists();
  }, 300);
}

function updateStatus() {
  if (!project) return;
  // A note isn't part of the novel's word count (the "novel" and "today" totals below already only ever sum
  // chapters), so counting words on a note is its own kind of noise -- hide just that one figure there.
  const w = wordCount.get(cur.id) ?? 0;
  $('#stWords').classList.toggle('hidden', cur.kind === 'notes');
  $('#stWords').textContent = `${fmt(w)} word${w === 1 ? '' : 's'}`;
  $('#stTotal').textContent = `novel ${fmt(totalWords())}`;
  const t = Math.max(0, totalWords() - todayBase);
  $('#stToday').textContent = settings.goal > 0 ? `today ${fmt(t)}/${fmt(settings.goal)}` : `today ${fmt(t)}`;
}

// =============================================================== remarks ====

/** From 1080px the notes stand in the margin beside their paragraph; below that they live in a drawer. */
const wideMq = window.matchMedia('(min-width: 1080px)');
const isWide = () => wideMq.matches;
/** Number shown after the marked words and in front of the note (document order, resolved ones hidden). */
const remarkNums = new Map<string, number>();
let hoverId: string | null = null;

function addRemark() {
  if (!editor) return;
  // Make sure ProseMirror has caught up with a selection the browser just made.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const observer = (editor.view as any).domObserver;
  observer?.forceFlush?.();
  observer?.flush?.();
  if (editor.state.selection.empty) { toast('Select some text first, then add a remark.'); return; }
  const id = newId();
  editor.chain().focus().setMark('remark', { id, resolved: false }).run();
  cur.remarks.push({ id, text: '', created: new Date().toISOString(), resolved: false });
  cur.remarksDirty = true;
  cur.dirty = true;
  openRemarksPanel();
  cur.active = id;
  renderRemarks(true);
  setActive(id, false);
  const ta = document.querySelector<HTMLTextAreaElement>(`.rcard[data-id="${id}"] textarea`);
  ta?.focus({ preventScroll: true });
  scheduleSave();
}

function setActive(id: string | null, scrollCard: boolean) {
  cur.active = id;
  if (editor) editor.view.dispatch(editor.state.tr.setMeta(activeRemarkKey, { active: id }));
  document.querySelectorAll<HTMLElement>('.rcard').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
  if (scrollCard && id && !isWide()) document.querySelector(`.rcard[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
/** The note under the pointer tints its words, like the focused one. */
function setHover(id: string | null) {
  if (hoverId === id || !editor) return;
  hoverId = id;
  editor.view.dispatch(editor.state.tr.setMeta(activeRemarkKey, { hover: id }));
}

function updateRemarkMarks(id: string, resolved: boolean | null) {
  // resolved === null → remove the highlight completely
  if (!editor) return;
  const { state } = editor;
  const type = state.schema.marks.remark;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type === type && x.attrs.id === id);
    if (!m) return;
    tr.removeMark(pos, pos + node.nodeSize, m);
    if (resolved !== null) tr.addMark(pos, pos + node.nodeSize, type.create({ id, resolved }));
  });
  editor.view.dispatch(tr);
}

function setResolved(id: string, resolved: boolean) {
  const r = cur.remarks.find((x) => x.id === id);
  if (!r) return;
  r.resolved = resolved;
  updateRemarkMarks(id, resolved);
  cur.remarksDirty = true;
  cur.dirty = true;
  scheduleSave();
  renderRemarks(true);
}

function deleteRemark(id: string) {
  updateRemarkMarks(id, null);
  cur.remarks = cur.remarks.filter((x) => x.id !== id);
  if (cur.active === id) cur.active = null;
  cur.remarksDirty = true;
  cur.dirty = true;
  scheduleSave();
  renderRemarks(true);
}

let remarkSig = '';
let remarkTimer: number | undefined;
function renderRemarksSoon() {
  clearTimeout(remarkTimer);
  remarkTimer = window.setTimeout(() => renderRemarks(false), 200);
}

const autosize = (ta: HTMLTextAreaElement) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };

function renderRemarks(force: boolean) {
  if (!editor) return;
  const ranges = collectRemarkRanges(editor.state.doc);
  // A highlight without a record (e.g. its file has not synced yet) still deserves a card.
  for (const id of ranges.keys()) {
    if (!cur.remarks.some((r) => r.id === id)) cur.remarks.push({ id, text: '', created: new Date().toISOString(), resolved: ranges.get(id)!.resolved });
  }
  const anchored = cur.remarks.filter((r) => ranges.has(r.id)).sort((a, b) => ranges.get(a.id)!.from - ranges.get(b.id)!.from);
  const lost = cur.remarks.filter((r) => !ranges.has(r.id));
  const shown = [...anchored, ...lost].filter((r) => showResolved || !r.resolved);

  // In the margin there is no checkbox: a small "resolved" button in the top strip shows the finished ones.
  const nResolved = cur.remarks.filter((r) => r.resolved).length;
  const rb = $('#btnResolved');
  rb.classList.toggle('hidden', !isWide() || !remarksShown() || nResolved === 0);
  rb.textContent = `${showResolved ? 'hide' : 'show'} resolved (${nResolved})`;

  const sig = JSON.stringify([shown.map((r) => [r.id, r.resolved, ranges.get(r.id)?.text ?? null]), showResolved, cur.id, isWide()]);
  if (!force && sig === remarkSig) { scheduleLayout(); return; }
  remarkSig = sig;

  remarkNums.clear();
  let n = 0;
  for (const r of shown) if (ranges.has(r.id)) remarkNums.set(r.id, ++n);

  const list = $('#remarkList');
  list.innerHTML = '';
  if (!shown.length) list.append(el('p', 'remarks-empty', 'No remarks yet. Select some words and press “+ remark” to leave a note to yourself right where it belongs.'));
  for (const r of shown) {
    const range = ranges.get(r.id);
    const card = el('div', 'rcard');
    card.dataset.id = r.id;
    if (r.resolved) card.classList.add('done');
    if (!range) card.classList.add('lost');
    if (cur.active === r.id) card.classList.add('active');
    card.onmouseenter = () => setHover(r.id);
    card.onmouseleave = () => setHover(null);

    const jump = () => {
      if (!range) return;
      editor!.chain().focus().setTextSelection({ from: range.from, to: range.to }).scrollIntoView().run();
      setActive(r.id, false);
    };
    const num = el('span', 'rnum', remarkNums.has(r.id) ? String(remarkNums.get(r.id)) : '–');
    num.onclick = jump;
    const quote = el('div', 'quote', range ? range.text : 'The highlighted text was deleted.');
    quote.onclick = jump;
    const ta = el('textarea', 'rtext');
    ta.rows = 1;
    ta.value = r.text;
    ta.placeholder = range ? 'Write your remark…' : 'The highlighted text was deleted.';
    ta.setAttribute('aria-label', `Remark ${remarkNums.get(r.id) ?? ''}`.trim());
    ta.oninput = () => { r.text = ta.value; cur.remarksDirty = true; scheduleSave(); autosize(ta); scheduleLayout(); };
    ta.onfocus = () => setActive(r.id, false);

    const acts = el('div', 'acts');
    acts.append(btn(r.resolved ? 'reopen' : 'resolve', '', () => setResolved(r.id, !r.resolved)), btn('delete', '', () => deleteRemark(r.id)));
    const body = el('div', 'rbody');
    body.append(quote, ta, acts);
    card.append(num, body);
    list.append(card);
  }
  // The numbers in the text follow the list.
  editor.view.dispatch(editor.state.tr.setMeta(activeRemarkKey, {}));
  layoutNotes();
}

/** Put each note beside the top of its paragraph; when two would overlap, the later one moves down. */
function scheduleLayout() {
  cancelAnimationFrame(layoutRaf);
  layoutRaf = requestAnimationFrame(layoutNotes);
}
function layoutNotes() {
  autosize(docTitle);
  const list = document.getElementById('remarkList');
  if (!list) return;
  const cards = Array.from(list.querySelectorAll<HTMLElement>('.rcard'));
  cards.forEach((c) => { const t = c.querySelector('textarea'); if (t) autosize(t); });
  if (!isWide() || !remarksShown() || !editor) {
    list.style.minHeight = '';
    cards.forEach((c) => { c.style.top = ''; });
    return;
  }
  const ranges = collectRemarkRanges(editor.state.doc);
  const top0 = list.getBoundingClientRect().top;
  let bottom = 0;
  for (const c of cards) {
    const r = ranges.get(c.dataset.id ?? '');
    let y = bottom > 0 ? bottom + 12 : 0;
    if (r) {
      // Align with the exact line the remark marks, not just the top of its paragraph — a remark anchored
      // partway down a long paragraph used to line up with the paragraph's first line instead of its own.
      const coords = editor.view.coordsAtPos(r.from);
      y = Math.max(y, coords.top - top0);
    }
    c.style.top = Math.round(y) + 'px';
    bottom = y + c.offsetHeight;
  }
  list.style.minHeight = Math.round(bottom) + 'px';
}
if ('ResizeObserver' in window) new ResizeObserver(() => scheduleLayout()).observe($('#docColumn'));
window.addEventListener('resize', scheduleLayout);
void document.fonts?.ready.then(scheduleLayout);

$<HTMLInputElement>('#showResolved').onchange = (e) => { showResolved = (e.target as HTMLInputElement).checked; renderRemarks(true); };
$('#btnResolved').onclick = () => {
  showResolved = !showResolved;
  $<HTMLInputElement>('#showResolved').checked = showResolved;
  renderRemarks(true);
};

/** The list of notes is one element that moves between the margin and the drawer. */
function placeRemarkList() {
  const list = $('#remarkList');
  const target = isWide() ? $('#margin') : $('#remarksPanel');
  if (list.parentElement !== target) target.append(list);
}
placeRemarkList();
wideMq.addEventListener('change', () => {
  placeRemarkList();
  renderRemarks(true);
  scheduleLayout();
});

// The page starts as a single centred column at every width; remarks (the margin column from 1080px up,
// the drawer below it) only show once opened, and that choice is remembered between launches.
const REMARKS_KEY = 'inkwell.remarksOpen';
const remarksShown = () => document.body.classList.contains('remarks-open');
function setRemarksOpen(v: boolean) {
  document.body.classList.toggle('remarks-open', v);
  try { lsSet(REMARKS_KEY, v ? '1' : ''); } catch { /* ignore */ }
  const btn = $('#btnRemarksToggle');
  btn.title = v ? 'Hide remarks' : 'Show remarks';
  btn.setAttribute('aria-pressed', String(v));
  scheduleLayout();
}
function toggleRemarksPanel(open?: boolean) { setRemarksOpen(open ?? !remarksShown()); }
function openRemarksPanel() { if (!remarksShown()) toggleRemarksPanel(true); }
setRemarksOpen(lsGet(REMARKS_KEY) === '1');
$('#btnRemarksToggle').onclick = () => toggleRemarksPanel();

// ============================================================= focus mode ===

function toggleFocus(on?: boolean) {
  document.body.classList.toggle('focus', on ?? !document.body.classList.contains('focus'));
  if (document.body.classList.contains('focus')) editor?.commands.focus();
}
$('#btnFocus').onclick = () => toggleFocus();
$('#remarksClose').onclick = () => toggleRemarksPanel(false);

// ========================================================= sidebar toggle ===

const SIDEBAR_KEY = 'inkwell.sidebarHidden';
let sidebarHidden = lsGet(SIDEBAR_KEY) === '1';
function setSidebarHidden(v: boolean) {
  sidebarHidden = v;
  document.body.classList.toggle('sidebar-hidden', v);
  try { lsSet(SIDEBAR_KEY, v ? '1' : ''); } catch { /* ignore */ }
  const btn = $('#btnSidebarToggle');
  btn.title = v ? 'Show sidebar (Ctrl/Cmd+\\)' : 'Hide sidebar (Ctrl/Cmd+\\)';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(v));
  // A small triangle instead of the word "sidebar": it points the way the sidebar would open (▸ = show it,
  // ◂ = it's open, click to tuck it away).
  btn.textContent = v ? '▸' : '◂';
}
setSidebarHidden(sidebarHidden);
$('#btnSidebarToggle').onclick = () => setSidebarHidden(!sidebarHidden);

// Small screens: the chapter list slides in over the text.
$('#btnNav').onclick = () => document.body.classList.toggle('nav-open');
$('#center').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#btnNav')) return;
  document.body.classList.remove('nav-open');
  if (!isWide() && remarksShown() && !(e.target as HTMLElement).closest('#topstrip, .remark')) toggleRemarksPanel(false);
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.code === 'KeyS') { e.preventDefault(); void saveNow(); }
  else if (mod && e.altKey && e.code === 'KeyM') { e.preventDefault(); addRemark(); }
  else if (mod && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); toggleFocus(); }
  else if (mod && e.code === 'Backslash') { e.preventDefault(); setSidebarHidden(!sidebarHidden); }
  else if (mod && !modal.open && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    navigateDoc(e.code === 'BracketLeft' ? -1 : 1);
  }
  else if (mod && e.altKey && !modal.open && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    // Move the chapter or note you have open, from anywhere (not just a row you Tab-focused in the sidebar).
    const f = project?.find(cur.id);
    if (f) { e.preventDefault(); void moveDocBy(f.kind, f.meta.id, e.code === 'ArrowUp' ? -1 : 1); }
  }
  else if (e.key === 'Escape' && !modal.open && !bookMenu.classList.contains('hidden')) closeBookMenu();
  else if (e.key === 'Escape' && !modal.open && document.body.classList.contains('focus')) toggleFocus(false);
  else if (e.key === 'Escape' && !modal.open) {
    document.body.classList.remove('nav-open');
    if (!isWide()) setRemarksOpen(false); // below 1080px remarks are a drawer overlay, like the chapter list
  }
});

// ============================================================ dialogs ======

$('#addChapter').onclick = () => void addDoc('chapters');
$('#addNote').onclick = () => void addDoc('notes');

// ---- books: the switcher at the top of the sidebar -------------------------------------------
const bookBtn = $<HTMLButtonElement>('#bookBtn');
const bookMenu = $('#bookMenu');

function closeBookMenu() {
  bookMenu.classList.add('hidden');
  bookBtn.setAttribute('aria-expanded', 'false');
}

async function openBookMenu() {
  if (!library || !project) return;
  const lib = library;
  bookMenu.innerHTML = '';
  const item = (label: string, onclick: () => void, cls = '', sub = '') => {
    const b = el('button', 'menu-item ' + cls);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(el('span', 'mi-t', label));
    if (sub) b.append(el('span', 'mi-s', sub));
    b.onclick = () => { closeBookMenu(); onclick(); };
    return b;
  };
  let books = await lib.books();
  if (!books.length) books = [];
  bookMenu.append(el('div', 'menu-label', 'Books'));
  for (const b of books) {
    const current = b.folder === bookFolder;
    const count = `${b.chapters} chapter${b.chapters === 1 ? '' : 's'}`;
    const row = item(b.title, () => { if (!current) void switchBook(b.folder); }, current ? 'current' : '', count);
    if (current) row.setAttribute('aria-current', 'true');
    bookMenu.append(row);
  }
  bookMenu.append(el('div', 'menu-sep'));
  bookMenu.append(
    item('New book…', () => void newBook()),
    item('Rename this book…', () => void renameBook()),
    item('Delete this book…', () => void deleteBook(), 'danger'),
    item('Deleted books…', () => void showDeletedBooks()),
  );
  if (!ARTIFACT) {
    bookMenu.append(el('div', 'menu-sep'), item('Choose another books folder…', () => void leaveLibrary()));
  }
  bookMenu.classList.remove('hidden');
  bookBtn.setAttribute('aria-expanded', 'true');
  bookMenu.querySelector<HTMLElement>('.menu-item.current, .menu-item')?.focus();
}

bookBtn.onclick = () => { if (bookMenu.classList.contains('hidden')) void openBookMenu(); else closeBookMenu(); };
document.addEventListener('click', (e) => {
  if (!bookMenu.classList.contains('hidden') && !(e.target as HTMLElement).closest('.proj-head')) closeBookMenu();
});
bookMenu.addEventListener('keydown', (e) => {
  const items = Array.from(bookMenu.querySelectorAll<HTMLElement>('.menu-item'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeBookMenu(); bookBtn.focus(); }
});

async function switchBook(folder: string) {
  try {
    await openBook(folder);
  } catch (e) {
    console.error(e);
    toast('Could not open that book: ' + ((e as Error).message || e));
  }
}

async function newBook() {
  if (!library) return;
  const title = await askText('New book', 'Title of the book', '', 'A folder of its own is created for it in your library. Your other books are not touched.');
  if (title === null) return;
  try {
    await flushSave();
    await flushMeta();
    const { folder } = await library.create(title.trim() || 'Untitled');
    await openBook(folder);
    toast('Book created.');
  } catch (e) {
    console.error(e);
    toast('Could not create the book: ' + ((e as Error).message || e));
  }
}

async function renameBook() {
  if (!project) return;
  const title = await askText('Rename book', 'Title of the book', project.data.title, 'Only the title changes; the book keeps its folder, so nothing moves on disk or in Nextcloud.');
  if (title === null) return;
  project.data.title = title.trim() || 'Untitled';
  $('#bookName').textContent = project.data.title;
  await project.saveMeta();
}

async function deleteBook() {
  if (!library || !project) return;
  const lib = library;
  const title = project.data.title;
  const count = project.data.chapters.length + project.data.notes.length;
  const go = await new Promise<boolean>((resolve) => {
    let yes = false;
    showModal('Delete this book?', (body, foot, close) => {
      body.append(el('p', '', `“${title}” and its ${count} chapter${count === 1 ? '' : 's'} and notes will be moved to the library's deleted-books folder.`));
      body.append(el('p', 'note', 'Nothing is erased: you can bring the book back from Deleted books in the same menu.'));
      const ok = btn('Move to deleted books', 'primary', () => { yes = true; close(); });
      foot.append(btn('Cancel', '', close), ok);
      return ok;
    });
    modal.addEventListener('close', () => resolve(yes), { once: true });
  });
  if (!go) return;
  try {
    await flushSave();
    await flushMeta();
    const entry = await lib.trash(bookFolder);
    let books = await lib.books();
    if (!books.length) {
      const t = await askText('Your next book', 'Title of the book', 'My Novel', 'That was the last book in this library, so let\'s start a new one.');
      await lib.create((t ?? '').trim() || 'Untitled');
      books = await lib.books();
    }
    editor?.destroy();
    editor = null;
    project = null;
    await openBook(books[0].folder);
    toast(`“${title}” moved to deleted books`, 'Undo', () => void undoDeleteBook(entry));
  } catch (e) {
    console.error(e);
    toast('Could not delete the book: ' + ((e as Error).message || e));
  }
}

async function undoDeleteBook(entry: string) {
  if (!library) return;
  try {
    const t = (await library.trashed()).find((x) => x.entry === entry);
    if (!t) return;
    const b = await library.restore(t);
    await openBook(b.folder);
    toast(`Restored “${b.title}”`);
  } catch (e) {
    toast('Could not restore the book: ' + ((e as Error).message || e));
  }
}

async function showDeletedBooks() {
  if (!library) return;
  const lib = library;
  const items: TrashedBook[] = await lib.trashed();
  showModal('Deleted books', (body, foot, close) => {
    if (!items.length) { body.append(el('p', 'note', 'No deleted books. When you delete a book it waits here; nothing is erased for good.')); foot.append(btn('Close', '', close)); return; }
    const list = el('div', 'list');
    for (const t of items) {
      const row = el('div', 'item');
      const label = el('span', '', `${t.title} `);
      const when = t.deleted ? `, deleted ${t.deleted.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
      label.append(el('span', 'sub', `(${t.chapters} chapter${t.chapters === 1 ? '' : 's'}${when})`));
      row.append(label, btn('Restore', '', async () => { close(); await undoDeleteBook(t.entry); }));
      list.append(row);
    }
    body.append(list);
    foot.append(btn('Close', '', close));
  });
}

async function leaveLibrary() {
  await flushSave();
  await flushMeta();
  editor?.destroy();
  editor = null;
  project = null;
  library = null;
  bookFolder = '';
  cur.id = '';
  await showWelcome(true);
}

$('#btnHistory').onclick = async () => {
  if (!project || !editor) return;
  await flushSave();
  const p = project;
  const snaps = await p.listSnapshots(cur.id);
  showModal('Earlier versions of this text', (body, foot, close) => {
    if (!snaps.length) { body.append(el('p', 'note', 'No earlier versions yet. Inkwell keeps a snapshot when you open a text and every ten minutes or so while you write.')); return; }
    body.append(el('p', 'note', 'Pick a version to preview it. Restoring keeps your current text as a version too, so nothing is lost.'));
    const list = el('div', 'list');
    const preview = el('div', 'preview');
    preview.textContent = 'Select a version above.';
    let chosen: string | null = null;
    const restore = btn('Restore this version', 'primary');
    restore.disabled = true;
    for (const name of snaps) {
      const item = el('div', 'item', snapDate(name).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
      item.onclick = async () => {
        list.querySelectorAll('.item').forEach((n) => n.classList.remove('sel'));
        item.classList.add('sel');
        chosen = name;
        preview.innerHTML = safeHtml(await p.readSnapshot(cur.id, name)) || '(empty)';
        restore.disabled = false;
      };
      list.append(item);
    }
    restore.onclick = async () => {
      if (!chosen) return;
      const old = await p.readSnapshot(cur.id, chosen);
      const title = p.find(cur.id)?.meta.title ?? '';
      await p.writeSnapshot(cur.id, title, editor!.getHTML()); // keep what we have now
      cur.lastSnapAt = Date.now();
      mountEditor(old);
      cur.dirty = true;
      wordCount.set(cur.id, wordsIn(editor!.getText({ blockSeparator: ' ' })));
      updateStatus();
      renderLists();
      scheduleSave();
      close();
      toast('Version restored. Your previous text is still in History.');
    };
    body.append(list, preview);
    foot.append(btn('Close', '', close), restore);
  });
};

$('#btnTrash').onclick = async () => {
  if (!project) return;
  const p = project;
  const items = await p.listTrash();
  showModal('Trash', (body, foot, close) => {
    if (!items.length) { body.append(el('p', 'note', 'The Trash is empty. Chapters and notes you delete wait here; nothing is ever erased for good.')); return; }
    const list = el('div', 'list');
    for (const e of items) {
      const row = el('div', 'item');
      const label = el('span', '', `${e.title || 'Untitled'} `);
      label.append(el('span', 'sub', `(${e.kind === 'chapters' ? 'chapter' : 'note'}, deleted ${new Date(e.deleted).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })})`));
      row.append(label, btn('Restore', '', async () => { await restoreEntry(e); close(); }));
      list.append(row);
    }
    body.append(list);
    foot.append(btn('Close', '', close));
  });
};

async function deliverMarkdown(name: string, text: string): Promise<void> {
  if (!ARTIFACT) {
    if (await saveTextFile(name, text)) toast('Exported.');
    return;
  }
  // The hosted preview cannot save files, so show the Markdown to copy instead.
  showModal('Markdown', (body, foot, close) => {
    body.append(el('p', 'note', 'This preview cannot save files. Copy the text below into a .md file.'));
    const ta = el('textarea');
    ta.readOnly = true;
    ta.value = text;
    ta.style.cssText = 'width:100%;height:40vh;font-family:ui-monospace,Menlo,monospace;font-size:12px';
    body.append(ta);
    const copy = btn('Copy', 'primary', async () => {
      ta.select();
      try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { document.execCommand('copy'); }
    });
    foot.append(btn('Close', '', close), copy);
    return ta;
  });
}

// ---- Markdown: export ------------------------------------------------------------------------

$('#btnExport').onclick = async () => {
  if (!project || !editor) return;
  await flushSave();
  const p = project;
  const isNote = p.find(cur.id)?.kind === 'notes';
  const html = async (kind: Kind, id: string) => (id === cur.id ? editor!.getHTML() : (await p.loadDoc(kind, id)).html);
  showModal('Export to Markdown', (body, foot, close) => {
    body.append(el('p', 'note', 'Creates Markdown (.md) files. Remarks are not included in the export.'));
    const list = el('div', 'choices');
    const choice = (title: string, sub: string, run: () => Promise<void>) => {
      const b = el('button', 'choice');
      b.type = 'button';
      b.append(el('strong', '', title), el('span', 'sub', sub));
      b.onclick = async () => {
        try { await run(); } catch (e) { console.error(e); toast('Export failed: ' + ((e as Error).message || e)); }
      };
      list.append(b);
    };
    choice(isNote ? 'This note' : 'This chapter', 'One .md file', async () => {
      const meta = p.find(cur.id)!.meta;
      await deliverMarkdown(slug(meta.title || 'chapter', 'chapter') + '.md', chapterToMarkdown(meta.title || 'Untitled', editor!.getHTML()));
      if (!ARTIFACT) close();
    });
    choice('Whole book', 'One .md file: the book title, then every chapter under it', async () => {
      const parts: string[] = [`# ${p.data.title}\n`];
      for (const d of p.data.chapters) parts.push(chapterToMarkdown(d.title || 'Untitled', await html('chapters', d.id)).replace(/^# /, '## '));
      await deliverMarkdown(slug(p.data.title, 'book') + '.md', parts.join('\n'));
      if (!ARTIFACT) close();
    });
    if (!ARTIFACT) {
      choice('Every chapter as its own file', 'A new folder with 01-….md, 02-….md and so on', async () => {
        const names = chapterFileNames(p.data.chapters.map((d) => d.title || 'Untitled'), (s) => slug(s, 'chapter'));
        const files: { name: string; text: string }[] = [];
        for (let i = 0; i < p.data.chapters.length; i++) {
          const d = p.data.chapters[i];
          files.push({ name: names[i], text: chapterToMarkdown(d.title || 'Untitled', await html('chapters', d.id)) });
        }
        const where = await saveFiles(slug(p.data.title, 'book') + '-markdown', files);
        if (where) { close(); toast(`Saved ${files.length} file${files.length === 1 ? '' : 's'} to ${where}`); }
      });
    }
    body.append(list);
    foot.append(btn('Cancel', '', close));
  });
};

// ---- Markdown: import ------------------------------------------------------------------------

$('#btnImport').onclick = () => {
  if (!project) return;
  const p = project;
  showModal('Import Markdown', (body, foot, close) => {
    body.append(el('p', 'note', 'Turns Markdown (.md) files into chapters or notes in this book. What you already have is not changed.'));

    let files: { name: string; text: string }[] = [];
    const chosen = el('p', 'note', 'No files chosen yet.');
    const preview = el('div', 'preview import-preview');
    preview.classList.add('hidden');
    const go = btn('Import', 'primary');
    go.disabled = true;

    const makeInput = (dir: boolean) => {
      const inp = el('input');
      inp.type = 'file';
      inp.className = 'visually-hidden';
      inp.tabIndex = -1;
      if (dir) inp.setAttribute('webkitdirectory', '');
      else { inp.multiple = true; inp.accept = '.md,.markdown,.mdown,.txt,text/markdown,text/plain'; }
      inp.onchange = async () => {
        const list = Array.from(inp.files ?? []).filter((f) => isMarkdownName(f.name));
        const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        list.sort((a, b) => naturalCompare(rel(a), rel(b)));
        files = [];
        for (const f of list) files.push({ name: rel(f), text: await f.text() });
        inp.value = '';
        refresh();
      };
      return inp;
    };
    const inFiles = makeInput(false);
    const inDir = makeInput(true);
    const bFiles = btn('Choose .md files…', '', () => inFiles.click());
    const bDir = btn('Choose a folder…', '', () => inDir.click());
    const pickRow = el('div', 'pick-row');
    pickRow.append(bFiles, bDir, inFiles, inDir);
    const row = (label: string, control: HTMLElement) => {
      const r = el('div', 'row');
      r.append(el('label', '', label), control);
      return r;
    };
    const kindSel = el('select');
    for (const [v, t] of [['chapters', 'Chapters'], ['notes', 'Notes']]) { const o = el('option', '', t); o.value = v; kindSel.append(o); }
    const splitSel = el('select');
    for (const [v, t] of [['auto', 'Automatic'], ['none', 'Never: one chapter per file'], ['1', 'At # headings'], ['2', 'At ## headings'], ['3', 'At ### headings']]) {
      const o = el('option', '', t); o.value = v; splitSel.append(o);
    }
    kindSel.onchange = refresh;
    splitSel.onchange = refresh;
    const opts = el('div', 'import-opts');
    opts.append(row('Split long files into chapters', splitSel));
    opts.classList.add('hidden');
    // Where the texts go is asked first, before any file is chosen.
    const kindRow = row('Add to', kindSel);
    kindRow.classList.add('import-kind');
    body.append(kindRow, pickRow, chosen, opts, preview);

    let result: { title: string; html: string }[] = [];
    function refresh() {
      result = [];
      preview.innerHTML = '';
      const mode: SplitMode = splitSel.value === 'auto' ? 'auto' : splitSel.value === 'none' ? 'none' : (Number(splitSel.value) as 1 | 2 | 3);
      for (const f of files) {
        try { result.push(...markdownToChapters(f.name, f.text, mode)); }
        catch (e) { console.warn('could not read', f.name, e); }
      }
      const has = files.length > 0;
      opts.classList.toggle('hidden', !has);
      preview.classList.toggle('hidden', !has);
      chosen.textContent = has ? `${files.length} file${files.length === 1 ? '' : 's'} chosen.` : 'No Markdown files found there. Pick files ending in .md, or a folder that has some.';
      const what = kindSel.value === 'notes' ? 'note' : 'chapter';
      if (has) {
        preview.append(el('div', 'note', `Will add ${result.length} ${what}${result.length === 1 ? '' : 's'}, in this order:`));
        const ol = el('ol');
        for (const c of result.slice(0, 12)) ol.append(el('li', '', `${c.title} — ${fmt(countWords(c.html))} words`));
        if (result.length > 12) ol.append(el('li', 'sub', `…and ${result.length - 12} more`));
        preview.append(ol);
      }
      go.textContent = result.length ? `Import ${result.length} ${what}${result.length === 1 ? '' : 's'}` : 'Import';
      go.disabled = !result.length;
    }

    go.onclick = async () => {
      if (!result.length) return;
      go.disabled = true;
      const kind = kindSel.value as Kind;
      try {
        await flushSave();
        let firstId: string | null = null;
        for (const c of result) {
          const meta = await p.addDoc(kind, c.title || 'Untitled');
          await p.saveDoc(kind, meta.id, meta.title, c.html, null);
          wordCount.set(meta.id, countWords(c.html));
          firstId ??= meta.id;
        }
        const n = result.length;
        close();
        renderLists();
        updateStatus();
        if (firstId) await openDoc(kind, firstId);
        toast(`Imported ${n} ${kind === 'notes' ? 'note' : 'chapter'}${n === 1 ? '' : 's'}.`);
      } catch (e) {
        console.error(e);
        toast('Import failed: ' + ((e as Error).message || e));
        go.disabled = false;
      }
    };
    foot.append(btn('Cancel', '', close), go);
  });
};

$('#btnSettings').onclick = () => {
  showModal('Settings', (body, foot, close) => {
    const row = (label: string, control: HTMLElement, sub = '') => {
      const r = el('div', 'row');
      const l = el('label', '', label);
      if (sub) l.append(el('div', 'sub', sub));
      r.append(l, control);
      body.append(r);
    };
    const select = (opts: [string, string][], val: string, on: (v: string) => void) => {
      const s = el('select');
      for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; s.append(o); }
      s.value = val;
      s.onchange = () => on(s.value);
      return s;
    };
    const commit = (rebuild = false) => {
      saveSettings();
      applySettings();
      updateStatus();
      if (rebuild && editor) mountEditor(editor.getHTML());
    };
    row('Theme', select([['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']], settings.theme, (v) => { settings.theme = v as Settings['theme']; commit(); }));
    const accent = el('input'); accent.type = 'color'; accent.value = settings.accent || DEFAULT_ACCENT; accent.className = 'colorpick';
    const accentReset = btn('Reset', '', () => { settings.accent = ''; accent.value = DEFAULT_ACCENT; commit(); });
    accent.oninput = () => { settings.accent = accent.value.toLowerCase() === DEFAULT_ACCENT ? '' : accent.value; commit(); };
    const accentBox = el('div', 'inline'); accentBox.append(accent, accentReset);
    row('Accent colour', accentBox, 'Remarks, links and the selection.');
    row('Text font', select([['courier', 'Courier Prime (typewriter)'], ['serif', 'Source Serif 4 (book)'], ['sans', 'Source Sans 3'], ['plex', 'IBM Plex Mono']], settings.docFont, (v) => { settings.docFont = v as Settings['docFont']; commit(); }));
    row('Interface font', select([['plex', 'IBM Plex Mono'], ['sans', 'Source Sans 3'], ['system', 'System']], settings.uiFont, (v) => { settings.uiFont = v as Settings['uiFont']; commit(); }));
    const size = el('input'); size.type = 'range'; size.min = '14'; size.max = '26'; size.value = String(settings.size);
    size.oninput = () => { settings.size = Number(size.value); commit(); };
    row('Text size', size);
    if (isMacApp()) {
      const tr = el('input'); tr.type = 'checkbox'; tr.checked = settings.translucent;
      tr.onchange = () => { settings.translucent = tr.checked; commit(); };
      row('Translucent window', tr, 'Lets the desktop show through. macOS turns it off itself when “Reduce transparency” is on.');
      const slider = (val: number, max: number, on: (v: number) => void) => {
        const box = el('div', 'inline');
        const r = el('input'); r.type = 'range'; r.min = '0'; r.max = String(max); r.step = '5'; r.value = String(clamp(val, 0, max));
        const out = el('span', 'sub', r.value + '%');
        r.oninput = () => { out.textContent = r.value + '%'; on(Number(r.value)); };
        box.append(r, out);
        return box;
      };
      row('Sidebar transparency', slider(settings.sideTransp, 100, (v) => { settings.sideTransp = v; commit(); }), '100% is the plain blur of macOS; lower makes the sidebar more solid.');
      row('Page transparency', slider(settings.pageTransp, 60, (v) => { settings.pageTransp = v; commit(); }), '0% keeps the page solid; more lets the desktop show through the text page.');
    }
    row('Quotation marks', select([['english', '“English”'], ['ukrainian', '«Українські»'], ['guillemets', '«Guillemets»'], ['german', '„German“'], ['off', 'Leave straight']], settings.quotes, (v) => { settings.quotes = v as Settings['quotes']; commit(true); }), 'Type a plain " or \' and it becomes this style as you type. Only new typing changes — text you already wrote stays as it is.');
    const dashes = el('input'); dashes.type = 'checkbox'; dashes.checked = settings.dashes;
    dashes.onchange = () => { settings.dashes = dashes.checked; commit(true); };
    row('Dashes and ellipsis', dashes, 'Turns -- into — and ... into …');
    if (project) {
      const spellCommit = async () => {
        await project!.saveMeta();
        if (editor && !project!.find(cur.id)?.meta.spell) rescanSpelling(editor.view);
        showNumber();
      };
      row(
        'Spell-check (this book)',
        select(
          [['off', 'Off'], ['en', 'English'], ['ru', 'Russian'], ['uk', 'Ukrainian']],
          project.data.spellLang ?? 'off',
          (v) => { project!.data.spellLang = v as SpellSetting; void spellCommit(); },
        ),
        'Red underlines, checked entirely offline. A chapter or note can use its own language instead, right above its title. Suggestions and “Add to dictionary” are on right-click.',
      );
    }
    const goal = el('input'); goal.type = 'number'; goal.min = '0'; goal.step = '50'; goal.value = String(settings.goal); goal.style.width = '90px';
    goal.onchange = () => { settings.goal = Math.max(0, Number(goal.value) || 0); commit(); };
    row('Daily word goal', goal, '0 hides the goal.');
    foot.append(btn('Done', 'primary', close));
  });
};

// ================================================================ start ====

applySettings();
void showWelcome();

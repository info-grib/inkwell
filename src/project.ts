// The project model: how a novel is laid out on disk.
//
//   MyNovel/
//     project.json                  title + order of chapters and notes
//     chapters/<id>.html            the text of a chapter (plain HTML, opens in any browser)
//     chapters/<id>.remarks.json    remarks written on that chapter
//     notes/<id>.html               loose notes (same format)
//     _history/<id>/<time>.html     automatic snapshots of every text
//     _trash/<time>__<id>.*         deleted chapters/notes; nothing is ever erased
//
// One file per chapter means that editing two chapters on two devices never
// causes a sync conflict in Nextcloud.

import type { Fs } from './fs';

export type Kind = 'chapters' | 'notes';
/** A dictionary Inkwell can spell-check against, or 'off' to draw no underlines at all. */
export type SpellSetting = 'en' | 'ru' | 'uk' | 'off';
/**
 * number: the position of the chapter (or note) in the book, 1 to x; 0 means "not sure yet" (shown as "?"). The
 * list is always kept in number order, with the "?" ones at the end.
 * spell: this chapter's own spell-check language; null/absent follows the book's default (spellLang below).
 */
export interface DocMeta { id: string; title: string; number: number; spell?: SpellSetting | null }
export interface ProjectData {
  app: 'inkwell';
  version: 1 | 2 | 3;
  title: string;
  chapters: DocMeta[];
  notes: DocMeta[];
  /** The book's default spell-check language; chapters and notes follow it unless they set their own. */
  spellLang?: SpellSetting;
}
export interface Remark {
  id: string;
  text: string;
  created: string;
  resolved?: boolean;
}
export interface LoadedDoc {
  html: string;
  remarks: Remark[];
  /** Raw file contents as found on disk, used to notice outside changes. */
  rawHtml: string | null;
  rawRemarks: string | null;
}
export interface TrashEntry {
  stamp: string;
  id: string;
  kind: Kind;
  title: string;
  deleted: string;
  number?: number;
}

const MAX_SNAPSHOTS = 40;

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function wrapHtml(title: string, body: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${body}\n</body></html>\n`;
}
export function unwrapHtml(text: string): string {
  const m = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (m ? m[1] : text).trim();
}

/** Word count of an HTML fragment. */
export function countWords(html: string): number {
  const spaced = html.replace(/<\/(p|h[1-6]|li|blockquote|div)>|<br\s*\/?>|<hr\s*\/?>/gi, ' ');
  const text = new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

// ---- numbering ------------------------------------------------------------------
// Rule: a list is always ordered by number, 1 to x with no gaps and no duplicates; items with number 0 ("?") wait
// at the end and take no part in the order until they get a number.

/** Keep the given order, move the "?" items to the end (in their order), and number the rest 1 to x. */
export function renumber(list: DocMeta[]): boolean {
  const before = list.map((d) => d.id + ':' + d.number).join();
  const numbered = list.filter((d) => d.number > 0);
  const loose = list.filter((d) => !(d.number > 0));
  loose.forEach((d) => { d.number = 0; });
  numbered.forEach((d, i) => { d.number = i + 1; });
  list.splice(0, list.length, ...numbered, ...loose);
  return before !== list.map((d) => d.id + ':' + d.number).join();
}
/** Sort by number (equal numbers keep their order), "?" last, then close the gaps. */
export function sortByNumber(list: DocMeta[]): boolean {
  const before = list.map((d) => d.id + ':' + d.number).join();
  const numbered = list.filter((d) => d.number > 0).map((d, i) => ({ d, i })).sort((a, b) => a.d.number - b.d.number || a.i - b.i).map((x) => x.d);
  const loose = list.filter((d) => !(d.number > 0));
  list.splice(0, list.length, ...numbered, ...loose);
  renumber(list);
  return before !== list.map((d) => d.id + ':' + d.number).join();
}
/** Put an item at position `index` (0 = first) of the numbered items; it gets a number if it had none. Returns its number. */
export function moveToIndex(list: DocMeta[], id: string, index: number): number {
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return 0;
  const [m] = list.splice(i, 1);
  const numbered = list.filter((d) => d.number > 0);
  const loose = list.filter((d) => !(d.number > 0));
  const at = Math.max(0, Math.min(index, numbered.length));
  numbered.splice(at, 0, m);
  m.number = at + 1; // anything > 0; renumber sets the real values
  list.splice(0, list.length, ...numbered, ...loose);
  renumber(list);
  return m.number;
}
/** Make an item "?": it goes to the end and the others close the gap. */
export function unnumber(list: DocMeta[], id: string): void {
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [m] = list.splice(i, 1);
  m.number = 0;
  list.push(m);
  renumber(list);
}

/** Fill in what an older file lacks and enforce the numbering rule. Returns true when something changed (the caller then saves). */
const SPELL_SETTINGS = ['en', 'ru', 'uk', 'off'] as const;
export function normalize(data: ProjectData): boolean {
  let changed = false;
  if (!Array.isArray(data.chapters)) { data.chapters = []; changed = true; }
  if (!Array.isArray(data.notes)) { data.notes = []; changed = true; }
  // Off by default: a book with no choice yet should not suddenly sprout red underlines everywhere.
  if (!SPELL_SETTINGS.includes(data.spellLang as SpellSetting)) { data.spellLang = 'off'; changed = true; }
  for (const kind of ['chapters', 'notes'] as const) {
    for (const d of data[kind]) {
      if (d.spell != null && !SPELL_SETTINGS.includes(d.spell as SpellSetting)) { d.spell = null; changed = true; }
    }
  }
  const old = data.version !== 3;
  for (const kind of ['chapters', 'notes'] as const) {
    data[kind].forEach((d, i) => {
      if (typeof d.number !== 'number' || !Number.isFinite(d.number) || d.number < 0) { d.number = i + 1; changed = true; }
    });
    // The numbers decide the order (older files: the number the author gave it, or its place if it had none).
    // Equal numbers keep their order; this also repairs two devices that both added "chapter 4".
    if (sortByNumber(data[kind])) changed = true;
  }
  if (old) { data.version = 3; changed = true; }
  return changed;
}

export const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

export class Project {
  data: ProjectData;
  /** Raw text of project.json as last read/written. */
  rawMeta = '';
  /** True when opening the book had to add version 2 fields; the app saves them right away. */
  migrated = false;

  private constructor(public fs: Fs, data: ProjectData) {
    this.data = data;
  }

  // ---- open / create ------------------------------------------------------

  static async open(fs: Fs): Promise<Project | null> {
    const raw = await fs.read('project.json');
    if (raw === null) return null;
    const data = JSON.parse(raw) as ProjectData;
    const migrated = normalize(data);
    const p = new Project(fs, data);
    p.rawMeta = raw;
    p.migrated = migrated;
    return p;
  }

  static async create(fs: Fs, title: string): Promise<Project> {
    const p = new Project(fs, {
      app: 'inkwell',
      version: 3,
      title,
      chapters: [],
      notes: [],
      spellLang: 'off',
    });
    await p.addDoc('chapters', '');
    return p;
  }

  async saveMeta(): Promise<void> {
    const raw = JSON.stringify(this.data, null, 2) + '\n';
    await this.fs.write('project.json', raw);
    this.rawMeta = raw;
  }

  /** Re-read project.json; returns true if it changed on disk. */
  async reloadMeta(): Promise<boolean> {
    const raw = await this.fs.read('project.json');
    if (raw === null || raw === this.rawMeta) return false;
    try {
      const data = JSON.parse(raw) as ProjectData;
      normalize(data);
      this.data = data;
      this.rawMeta = raw;
      return true;
    } catch {
      return false; // half-synced file; try again next time
    }
  }

  // ---- documents ------------------------------------------------------------

  list(kind: Kind): DocMeta[] {
    return this.data[kind];
  }
  find(id: string): { kind: Kind; meta: DocMeta } | null {
    for (const kind of ['chapters', 'notes'] as Kind[]) {
      const meta = this.data[kind].find((d) => d.id === id);
      if (meta) return { kind, meta };
    }
    return null;
  }

  private path(kind: Kind, id: string, ext: 'html' | 'remarks.json') {
    return `${kind}/${id}.${ext}`;
  }

  async loadDoc(kind: Kind, id: string): Promise<LoadedDoc> {
    const rawHtml = await this.fs.read(this.path(kind, id, 'html'));
    const rawRemarks = await this.fs.read(this.path(kind, id, 'remarks.json'));
    let remarks: Remark[] = [];
    if (rawRemarks) {
      try {
        remarks = (JSON.parse(rawRemarks).remarks as Remark[]) ?? [];
      } catch {
        remarks = [];
      }
    }
    return { html: rawHtml ? unwrapHtml(rawHtml) : '', remarks, rawHtml, rawRemarks };
  }

  /** Returns the exact texts written, so callers can detect outside edits later. */
  async saveDoc(
    kind: Kind,
    id: string,
    title: string,
    html: string,
    remarks: Remark[] | null,
  ): Promise<{ rawHtml: string; rawRemarks: string | null }> {
    const rawHtml = wrapHtml(title, html);
    await this.fs.write(this.path(kind, id, 'html'), rawHtml);
    let rawRemarks: string | null = null;
    if (remarks) {
      rawRemarks = JSON.stringify({ remarks }, null, 2) + '\n';
      await this.fs.write(this.path(kind, id, 'remarks.json'), rawRemarks);
    }
    return { rawHtml, rawRemarks };
  }

  /** The number a new chapter or note gets: the next free one. */
  nextNumber(kind: Kind): number {
    return this.data[kind].filter((d) => d.number > 0).length + 1;
  }

  async addDoc(kind: Kind, title: string): Promise<DocMeta> {
    const meta: DocMeta = { id: newId(), title, number: this.nextNumber(kind) };
    const list = this.data[kind];
    list.splice(meta.number - 1, 0, meta); // after the last numbered one, before the "?" ones
    renumber(list);
    await this.fs.write(this.path(kind, meta.id, 'html'), wrapHtml(title, ''));
    await this.saveMeta();
    return meta;
  }

  // ---- order and numbers (the caller saves project.json afterwards) ----------------------

  /** The author typed a number: 0 makes it "?", otherwise the item moves to that place and the others follow. Returns the final number. */
  setNumber(kind: Kind, id: string, n: number): number {
    const list = this.data[kind];
    if (n <= 0) { unnumber(list, id); return 0; }
    return moveToIndex(list, id, n - 1);
  }
  /**
   * An item was dropped in the sidebar: `numbered` says which side of the "Not numbered" divider it landed on,
   * and `beforeId` is the sibling in THAT group it landed before (null = at the end of that group). A numbered
   * item is renumbered into place; dropped among the "?" ones it becomes "?" (and the other way round) — there
   * is no group it can be refused into.
   */
  dropBefore(kind: Kind, id: string, numbered: boolean, beforeId: string | null): 'moved' | 'same' {
    const list = this.data[kind];
    const item = list.find((d) => d.id === id);
    if (!item) return 'same';
    const orderBefore = list.map((d) => d.id + ':' + d.number).join();
    if (numbered) {
      const numberedOthers = list.filter((d) => d.id !== id && d.number > 0);
      const target = beforeId ? numberedOthers.find((d) => d.id === beforeId) : undefined;
      const at = target ? numberedOthers.indexOf(target) : numberedOthers.length;
      moveToIndex(list, id, at);
    } else {
      const numberedRest = list.filter((d) => d.id !== id && d.number > 0);
      const looseOthers = list.filter((d) => d.id !== id && !(d.number > 0));
      const target = beforeId ? looseOthers.find((d) => d.id === beforeId) : undefined;
      const at = target ? looseOthers.indexOf(target) : looseOthers.length;
      looseOthers.splice(at, 0, item);
      item.number = 0;
      list.splice(0, list.length, ...numberedRest, ...looseOthers);
      renumber(list);
    }
    return orderBefore === list.map((d) => d.id + ':' + d.number).join() ? 'same' : 'moved';
  }
  /**
   * A chapter becomes a note or the other way round (dragged into the other list, or "Move to notes").
   * Its files move along, the id stays, and both lists are renumbered. `numbered` and `beforeId` place it
   * exactly as in `dropBefore`. The caller saves project.json afterwards.
   */
  async moveDocKind(id: string, toKind: Kind, numbered: boolean, beforeId: string | null): Promise<boolean> {
    const from = this.find(id);
    if (!from || from.kind === toKind) return false;
    for (const ext of ['html', 'remarks.json'] as const) {
      const text = await this.fs.read(this.path(from.kind, id, ext));
      if (text !== null) {
        await this.fs.write(this.path(toKind, id, ext), text);
        await this.fs.remove(this.path(from.kind, id, ext));
      }
    }
    const item = from.meta;
    const src = this.data[from.kind];
    src.splice(src.indexOf(item), 1);
    renumber(src);
    const dst = this.data[toKind];
    if (numbered) {
      const numberedOthers = dst.filter((d) => d.number > 0);
      const target = beforeId ? numberedOthers.find((d) => d.id === beforeId) : undefined;
      const at = target ? numberedOthers.indexOf(target) : numberedOthers.length;
      dst.push(item);
      moveToIndex(dst, id, at);
    } else {
      const numberedRest = dst.filter((d) => d.number > 0);
      const looseOthers = dst.filter((d) => !(d.number > 0));
      const target = beforeId ? looseOthers.find((d) => d.id === beforeId) : undefined;
      const at = target ? looseOthers.indexOf(target) : looseOthers.length;
      looseOthers.splice(at, 0, item);
      item.number = 0;
      dst.splice(0, dst.length, ...numberedRest, ...looseOthers);
      renumber(dst);
    }
    return true;
  }
  /** Can it move one step up (-1) or down (+1) within its group? */
  canShift(kind: Kind, id: string, delta: -1 | 1): boolean {
    const list = this.data[kind];
    const i = list.findIndex((d) => d.id === id);
    const j = i + delta;
    return i >= 0 && j >= 0 && j < list.length && (list[i].number > 0) === (list[j].number > 0);
  }
  /** One step up (-1) or down (+1) within its group. Returns false at the edge. */
  shift(kind: Kind, id: string, delta: -1 | 1): boolean {
    const list = this.data[kind];
    const i = list.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const j = i + delta;
    if (j < 0 || j >= list.length) return false;
    if ((list[i].number > 0) !== (list[j].number > 0)) return false; // never across the numbered / "?" border
    [list[i], list[j]] = [list[j], list[i]];
    renumber(list);
    return true;
  }

  /** This chapter/note's own spell-check language; null follows the book's default. */
  setSpell(kind: Kind, id: string, spell: SpellSetting | null): void {
    const d = this.data[kind].find((x) => x.id === id);
    if (d) d.spell = spell;
  }
  /** The language actually used for a chapter/note: its own choice, or the book's default. */
  effectiveSpell(kind: Kind, id: string): SpellSetting {
    const d = this.data[kind].find((x) => x.id === id);
    return (d?.spell ?? this.data.spellLang ?? 'off') as SpellSetting;
  }

  // ---- snapshots ------------------------------------------------------------

  async listSnapshots(id: string): Promise<string[]> {
    const names = await this.fs.list(`_history/${id}`);
    return names.filter((n) => n.endsWith('.html')).sort().reverse(); // newest first
  }
  async readSnapshot(id: string, name: string): Promise<string> {
    return unwrapHtml((await this.fs.read(`_history/${id}/${name}`)) ?? '');
  }
  async writeSnapshot(id: string, title: string, html: string): Promise<void> {
    if (!html.trim()) return;
    await this.fs.write(`_history/${id}/${stampNow()}.html`, wrapHtml(title, html));
    const all = await this.listSnapshots(id);
    for (const old of all.slice(MAX_SNAPSHOTS)) await this.fs.remove(`_history/${id}/${old}`);
  }

  // ---- trash ------------------------------------------------------------------

  async trashDoc(kind: Kind, id: string): Promise<TrashEntry | null> {
    const meta = this.data[kind].find((d) => d.id === id);
    if (!meta) return null;
    const stamp = stampNow();
    for (const ext of ['html', 'remarks.json'] as const) {
      const from = this.path(kind, id, ext);
      const text = await this.fs.read(from);
      if (text !== null) {
        await this.fs.write(`_trash/${stamp}__${id}.${ext}`, text);
        await this.fs.remove(from);
      }
    }
    const entry: TrashEntry = { stamp, id, kind, title: meta.title, deleted: new Date().toISOString(), number: meta.number };
    await this.fs.write(`_trash/${stamp}__${id}.meta.json`, JSON.stringify(entry, null, 2) + '\n');
    this.data[kind] = this.data[kind].filter((d) => d.id !== id);
    renumber(this.data[kind]);
    await this.saveMeta();
    return entry;
  }

  async listTrash(): Promise<TrashEntry[]> {
    const names = await this.fs.list('_trash');
    const out: TrashEntry[] = [];
    for (const n of names.filter((x) => x.endsWith('.meta.json'))) {
      const raw = await this.fs.read(`_trash/${n}`);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as TrashEntry);
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => b.deleted.localeCompare(a.deleted));
  }

  async restoreFromTrash(e: TrashEntry): Promise<void> {
    for (const ext of ['html', 'remarks.json'] as const) {
      const from = `_trash/${e.stamp}__${e.id}.${ext}`;
      const text = await this.fs.read(from);
      if (text !== null) {
        await this.fs.write(this.path(e.kind, e.id, ext), text);
        await this.fs.remove(from);
      }
    }
    await this.fs.remove(`_trash/${e.stamp}__${e.id}.meta.json`);
    if (!this.data[e.kind].some((d) => d.id === e.id)) {
      // back to the place it had; the others make room
      const list = this.data[e.kind];
      list.push({ id: e.id, title: e.title, number: 0 });
      if (e.number && e.number > 0) moveToIndex(list, e.id, e.number - 1);
      else unnumber(list, e.id);
    }
    await this.saveMeta();
  }
}

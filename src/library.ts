// The library: a folder that holds your books.
//
//   MyLibrary/
//     salt-and-signal/         one book = one folder, exactly the layout of a version 1 project
//       project.json
//       chapters/  notes/  _history/  _trash/
//     harbour-notes/
//     _trash_books/            deleted books wait here; nothing is ever erased
//       <time>__salt-and-signal/...
//
// A version 1 project folder still works: if the folder you choose has a project.json of its own,
// that book is listed too (as "this folder"), and any books you add live in subfolders of it.
// Nothing is moved or rewritten, and no index file exists that two devices could fight over.

import { SubFs, type Fs } from './fs';
import { Project, stampNow } from './project';
import { slug } from './export';

export const BOOK_TRASH = '_trash_books';
/** Names inside a book that can never be a book folder. */
const RESERVED = new Set(['chapters', 'notes', '_history', '_trash', BOOK_TRASH]);
/** What a book folder consists of, used when the book IS the library folder itself. */
const OWN_ITEMS = ['chapters', 'notes', '_history', '_trash'];

export interface BookInfo {
  /** Folder name inside the library; '' when the library folder itself is a (version 1) book. */
  folder: string;
  title: string;
  chapters: number;
  notes: number;
}
export interface TrashedBook {
  /** Folder name inside _trash_books/. */
  entry: string;
  title: string;
  chapters: number;
  notes: number;
  deleted: Date | null;
}

export function folderName(title: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = slug(title, 'book');
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()) || RESERVED.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  return name;
}

async function readInfo(fs: Fs, folder: string, path: string): Promise<{ title: string; chapters: number; notes: number } | null> {
  const raw = await fs.read(path);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { title?: string; chapters?: unknown[]; notes?: unknown[] };
    if (!Array.isArray(d.chapters)) return null;
    return { title: d.title || folder || 'Untitled', chapters: d.chapters.length, notes: Array.isArray(d.notes) ? d.notes.length : 0 };
  } catch {
    return null;
  }
}

export class Library {
  constructor(public fs: Fs) {}

  get label() { return this.fs.label; }

  bookFs(folder: string): Fs {
    return folder === '' ? this.fs : new SubFs(this.fs, folder, `${this.fs.label}/${folder}`);
  }

  /** All books, this folder first if it is itself a book, then the others by title. */
  async books(): Promise<BookInfo[]> {
    const out: BookInfo[] = [];
    const own = await readInfo(this.fs, '', 'project.json');
    if (own) out.push({ folder: '', ...own });
    const names = await this.fs.list('');
    const found: BookInfo[] = [];
    for (const name of names) {
      if (RESERVED.has(name) || name.startsWith('.')) continue;
      const info = await readInfo(this.fs, name, `${name}/project.json`);
      if (info) found.push({ folder: name, ...info });
    }
    found.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    return [...out, ...found];
  }

  async open(folder: string): Promise<Project | null> {
    return Project.open(this.bookFs(folder));
  }

  /** A new book with one empty chapter. */
  async create(title: string): Promise<{ folder: string; project: Project }> {
    const names = await this.fs.list('');
    const folder = folderName(title, names);
    const project = await Project.create(this.bookFs(folder), title);
    return { folder, project };
  }

  // ---- deleting and restoring --------------------------------------------------------------

  /** Every file that belongs to a book, as paths relative to the book. */
  private async filesOf(folder: string): Promise<{ book: Fs; files: string[] }> {
    const book = this.bookFs(folder);
    if (folder !== '') return { book, files: await book.walk('') };
    // The library folder itself: take only what a book consists of, never the other books.
    const files: string[] = ['project.json'];
    for (const d of OWN_ITEMS) for (const f of await this.fs.walk(d)) files.push(`${d}/${f}`);
    return { book, files };
  }

  /** Move a book to the library's deleted-books folder. Returns the entry name. */
  async trash(folder: string): Promise<string> {
    const { book, files } = await this.filesOf(folder);
    const entry = `${stampNow()}__${folder || 'this-folder'}`;
    let copied = 0;
    for (const f of files) {
      const text = await book.read(f);
      if (text === null) continue;
      await this.fs.write(`${BOOK_TRASH}/${entry}/${f}`, text);
      copied++;
    }
    if (copied === 0) throw new Error('Nothing to move: that book has no files');
    // Only after every file is safely in the trash do we remove the original.
    if (folder !== '') await this.fs.removeTree(folder);
    else {
      await this.fs.remove('project.json');
      for (const d of OWN_ITEMS) if ((await this.fs.list(d)).length) await this.fs.removeTree(d);
    }
    return entry;
  }

  async trashed(): Promise<TrashedBook[]> {
    const out: TrashedBook[] = [];
    for (const entry of await this.fs.list(BOOK_TRASH)) {
      const info = await readInfo(this.fs, entry, `${BOOK_TRASH}/${entry}/project.json`);
      if (!info) continue;
      const m = entry.match(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z__/);
      out.push({ entry, ...info, deleted: m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null });
    }
    return out.sort((a, b) => (b.deleted?.getTime() ?? 0) - (a.deleted?.getTime() ?? 0));
  }

  /** Put a deleted book back as a book of its own (in a fresh folder if the old name is taken). */
  async restore(t: TrashedBook): Promise<BookInfo> {
    const names = await this.fs.list('');
    const wanted = t.entry.replace(/^.*?Z__/, '');
    const folder = folderName(wanted === 'this-folder' ? t.title : wanted, names);
    const from = `${BOOK_TRASH}/${t.entry}`;
    const files = await this.fs.walk(from);
    for (const f of files) {
      const text = await this.fs.read(`${from}/${f}`);
      if (text !== null) await this.fs.write(`${folder}/${f}`, text);
    }
    await this.fs.removeTree(from);
    return { folder, title: t.title, chapters: t.chapters, notes: t.notes };
  }
}

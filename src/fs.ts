// A tiny file-system abstraction so the rest of the app doesn't care whether it
// runs inside Tauri (real folder on disk) or in a browser (folder picker, or storage kept in the browser).

import { lsGet, lsRemove, lsSet } from './store';

export interface Fs {
  /** Human-readable name of the location (folder name). */
  label: string;
  /** Read a text file, or null if it does not exist. */
  read(path: string): Promise<string | null>;
  /** Write a text file, creating parent folders as needed. */
  write(path: string, text: string): Promise<void>;
  /** Names of the entries inside a folder ([] if the folder does not exist). */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  /** Every file below a folder, as paths relative to it (recursive). [] if the folder does not exist. */
  walk(dir: string): Promise<string[]>;
  /** Remove a folder and everything in it. Refuses to remove the root. */
  removeTree(dir: string): Promise<void>;
}

/** A folder inside another Fs, so a book can live in a subfolder of the library. */
export class SubFs implements Fs {
  constructor(private base: Fs, private prefix: string, public label: string) {}
  private p(path: string) { return this.prefix ? (path ? this.prefix + '/' + path : this.prefix) : path; }
  read(path: string) { return this.base.read(this.p(path)); }
  write(path: string, text: string) { return this.base.write(this.p(path), text); }
  list(dir: string) { return this.base.list(this.p(dir)); }
  remove(path: string) { return this.base.remove(this.p(path)); }
  walk(dir: string) { return this.base.walk(this.p(dir)); }
  removeTree(dir: string) {
    if (!dir) return Promise.reject(new Error('Refusing to remove a whole book folder from inside it'));
    return this.base.removeTree(this.p(dir));
  }
}

const isNotFound = (e: unknown) => {
  const n = (e as { name?: string } | null)?.name;
  return n === 'NotFoundError' || n === 'TypeMismatchError';
};

// ---------------------------------------------------------------- browser ----

export class WebFs implements Fs {
  constructor(private root: FileSystemDirectoryHandle, public label: string) {}

  private async dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let h = this.root;
    for (const p of parts) h = await h.getDirectoryHandle(p, { create });
    return h;
  }

  async read(path: string): Promise<string | null> {
    const parts = path.split('/');
    const name = parts.pop()!;
    try {
      const d = await this.dir(parts, false);
      const f = await d.getFileHandle(name);
      return await (await f.getFile()).text();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async write(path: string, text: string): Promise<void> {
    const parts = path.split('/');
    const name = parts.pop()!;
    const d = await this.dir(parts, true);
    const f = await d.getFileHandle(name, { create: true });
    const w = await f.createWritable();
    await w.write(text);
    await w.close();
  }

  async list(dir: string): Promise<string[]> {
    try {
      const d = await this.dir(dir.split('/').filter(Boolean), false);
      const out: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [name] of (d as any).entries()) out.push(name as string);
      return out;
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
  }

  async remove(path: string): Promise<void> {
    const parts = path.split('/');
    const name = parts.pop()!;
    try {
      const d = await this.dir(parts, false);
      await d.removeEntry(name);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async walk(dir: string): Promise<string[]> {
    let root: FileSystemDirectoryHandle;
    try {
      root = await this.dir(dir.split('/').filter(Boolean), false);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const out: string[] = [];
    const rec = async (h: FileSystemDirectoryHandle, prefix: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [name, handle] of (h as any).entries()) {
        if (handle.kind === 'directory') await rec(handle as FileSystemDirectoryHandle, prefix + name + '/');
        else out.push(prefix + name);
      }
    };
    await rec(root, '');
    return out;
  }

  async removeTree(dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error('Refusing to remove the root folder');
    try {
      const d = await this.dir(parts, false);
      await d.removeEntry(name, { recursive: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

// ------------------------------------------------------------------ tauri ----

export class TauriFs implements Fs {
  constructor(private root: string, public label: string) {}

  private full(path: string) {
    return this.root.replace(/[\\/]+$/, '') + '/' + path;
  }

  async read(path: string): Promise<string | null> {
    const fs = await import('@tauri-apps/plugin-fs');
    const p = this.full(path);
    if (!(await fs.exists(p))) return null;
    return fs.readTextFile(p);
  }

  async write(path: string, text: string): Promise<void> {
    const fs = await import('@tauri-apps/plugin-fs');
    const p = this.full(path);
    const slash = p.lastIndexOf('/');
    if (slash > 0) await fs.mkdir(p.slice(0, slash), { recursive: true });
    await fs.writeTextFile(p, text);
  }

  async list(dir: string): Promise<string[]> {
    const fs = await import('@tauri-apps/plugin-fs');
    const p = this.full(dir);
    if (!(await fs.exists(p))) return [];
    return (await fs.readDir(p)).map((e) => e.name);
  }

  async remove(path: string): Promise<void> {
    const fs = await import('@tauri-apps/plugin-fs');
    const p = this.full(path);
    if (await fs.exists(p)) await fs.remove(p);
  }

  async walk(dir: string): Promise<string[]> {
    const fs = await import('@tauri-apps/plugin-fs');
    const out: string[] = [];
    const rec = async (abs: string, prefix: string) => {
      for (const e of await fs.readDir(abs)) {
        if (e.isDirectory) await rec(abs + '/' + e.name, prefix + e.name + '/');
        else if (e.isFile) out.push(prefix + e.name);
      }
    };
    const start = dir ? this.full(dir) : this.root.replace(/[\\/]+$/, '');
    if (!(await fs.exists(start))) return [];
    await rec(start, '');
    return out;
  }

  async removeTree(dir: string): Promise<void> {
    if (!dir) throw new Error('Refusing to remove the root folder');
    const fs = await import('@tauri-apps/plugin-fs');
    const p = this.full(dir);
    if (await fs.exists(p)) await fs.remove(p, { recursive: true });
  }
}

// ---------------------------------------------------- browser storage (IDB) ----

/** Files kept inside the browser (IndexedDB). Works everywhere; does not sync. */
export class IdbFs implements Fs {
  label = 'Browser storage';
  private db: Promise<IDBDatabase>;

  constructor(name = 'inkwell-files') {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async read(path: string): Promise<string | null> {
    const v = await this.run<string | undefined>('readonly', (s) => s.get(path));
    return v ?? null;
  }
  async write(path: string, text: string): Promise<void> {
    await this.run('readwrite', (s) => s.put(text, path));
  }
  async list(dir: string): Promise<string[]> {
    const prefix = dir.replace(/\/+$/, '') + (dir ? '/' : '');
    const keys = await this.run<IDBValidKey[]>('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')));
    const names = new Set<string>();
    for (const k of keys) names.add(String(k).slice(prefix.length).split('/')[0]);
    return [...names];
  }
  async remove(path: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(path));
  }
  async walk(dir: string): Promise<string[]> {
    const prefix = dir.replace(/\/+$/, '') + (dir ? '/' : '');
    const keys = await this.run<IDBValidKey[]>('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')));
    return keys.map((k) => String(k).slice(prefix.length));
  }
  async removeTree(dir: string): Promise<void> {
    if (!dir) throw new Error('Refusing to remove the root folder');
    const prefix = dir.replace(/\/+$/, '') + '/';
    await this.run('readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, prefix + '\uffff')));
  }
}

/** Last-resort store (lives only as long as the page) for when the browser refuses IndexedDB. */
export class MemFs implements Fs {
  label = 'This session only';
  private files = new Map<string, string>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, text: string) { this.files.set(path, text); }
  async list(dir: string) {
    const prefix = dir.replace(/\/+$/, '') + (dir ? '/' : '');
    const names = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
    return [...names];
  }
  async remove(path: string) { this.files.delete(path); }
  async walk(dir: string) {
    const prefix = dir.replace(/\/+$/, '') + (dir ? '/' : '');
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
  async removeTree(dir: string) {
    if (!dir) throw new Error('Refusing to remove the root folder');
    const prefix = dir.replace(/\/+$/, '') + '/';
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
}

// --------------------------------------------------------------- platform ----

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Built for the sandboxed preview page: no folder access, no downloads, sample project. */
export const ARTIFACT = import.meta.env.MODE === 'artifact';

export const canPickFolder = () => !ARTIFACT && (isTauri || 'showDirectoryPicker' in window);
export const hasBrowserStorage = () => 'indexedDB' in window;

const LAST_PATH_KEY = 'inkwell.lastPath';
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// A little IndexedDB helper: browsers can only remember a folder by keeping its handle.
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('inkwell', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Ask the user for a folder. */
export async function pickFolder(): Promise<Fs | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ directory: true, multiple: false, title: 'Choose your project folder' });
    if (!path || typeof path !== 'string') return null;
    lsSet(LAST_PATH_KEY, path);
    return new TauriFs(path, baseName(path));
  }
  if ('showDirectoryPicker' in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      await idbSet('lastDir', handle);
      lsSet(LAST_PATH_KEY, 'web:' + handle.name);
      return new WebFs(handle, handle.name);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return null;
      throw e;
    }
  }
  return null;
}

/** Storage private to this browser (works everywhere, but does not sync). */
export async function openBrowserStorage(): Promise<Fs> {
  lsSet(LAST_PATH_KEY, 'browser');
  try {
    const fs = new IdbFs();
    await fs.list(''); // fails right away if the browser blocks IndexedDB
    return fs;
  } catch {
    return new MemFs();
  }
}

export interface LastProject {
  label: string;
  /** Opens it. Must be called from a click in browsers (permission prompt). */
  open: () => Promise<Fs | null>;
  /** True if it can be opened without any user gesture. */
  ready: boolean;
}

/** What did the user have open last time? */
export async function lastProject(): Promise<LastProject | null> {
  const last = lsGet(LAST_PATH_KEY);
  if (!last) return null;
  try {
    if (isTauri) {
      if (last.startsWith('web:') || last === 'browser') return null;
      return { label: baseName(last), ready: true, open: async () => new TauriFs(last, baseName(last)) };
    }
    if (last === 'browser') {
      return { label: 'Browser storage', ready: true, open: () => openBrowserStorage() };
    }
    if (last.startsWith('web:')) {
      const handle = await idbGet<FileSystemDirectoryHandle>('lastDir');
      if (!handle) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = handle as any;
      const granted = (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
      return {
        label: handle.name,
        ready: granted,
        open: async () => {
          if (!granted && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return null;
          return new WebFs(handle, handle.name);
        },
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function forgetLastProject() {
  lsRemove(LAST_PATH_KEY);
}

/** Save a text file chosen by the user (used for Markdown export). */
export async function saveTextFile(defaultName: string, text: string): Promise<boolean> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }
  if ('showSaveFilePicker' in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = await (window as any).showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/**
 * Save several text files at once (one Markdown file per chapter). The author picks a folder;
 * the files go into a new subfolder of it, so nothing that is already there is touched.
 * Returns where they went, or null if the author cancelled.
 */
export async function saveFiles(subfolder: string, files: { name: string; text: string }[]): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs');
    const dir = await open({ directory: true, multiple: false, title: 'Choose where to save the Markdown files' });
    if (!dir || typeof dir !== 'string') return null;
    const target = dir.replace(/[\\/]+$/, '') + '/' + subfolder;
    await mkdir(target, { recursive: true });
    for (const f of files) await writeTextFile(target + '/' + f.name, f.text);
    return target;
  }
  if ('showDirectoryPicker' in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      const dir = await root.getDirectoryHandle(subfolder, { create: true });
      for (const f of files) {
        const h = await dir.getFileHandle(f.name, { create: true });
        const w = await h.createWritable();
        await w.write(f.text);
        await w.close();
      }
      return root.name + '/' + subfolder;
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return null;
      throw e;
    }
  }
  // Browsers without a folder picker: one download per file.
  for (const f of files) {
    await saveTextFile(f.name, f.text);
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'your Downloads folder';
}

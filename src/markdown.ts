// Markdown in and out.
//
// Export lives in export.ts (HTML → Markdown). This file is the way back: Markdown files → chapters.
//
// The rules, in plain words:
//  * A file becomes one chapter. Its first "# Heading" (if it comes first) is the chapter's title and is
//    not repeated in the text; otherwise the title comes from front matter ("title: ...") or the file name.
//  * A long file can be split into several chapters at headings of one level (# or ## or ###).
//    "Automatic" picks the level for you: several "#" headings means split at "#"; one "#" (the book
//    title, as our own whole-book export writes it) followed by several "##" means split at "##".
//  * Remarks, links, images and tables have no place in the text of a chapter, so they are simplified:
//    links keep their words, images keep their description, tables become lines of text.

import { marked, type Token, type Tokens } from 'marked';

export interface ImportedChapter {
  title: string;
  html: string;
}
export type SplitMode = 'auto' | 'none' | 1 | 2 | 3;

const stem = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.(md|markdown|mdown|txt)$/i, '').replace(/[_]+/g, ' ').trim();

/** Turn inline Markdown in a heading ("The **Last** Ferry") into plain text. */
function plain(inline: string): string {
  const html = marked.parseInline(inline, { async: false }) as string;
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim();
}

function stripFrontMatter(text: string): { body: string; title: string | null } {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { body: text, title: null };
  const t = m[1].match(/^title:\s*(.+)$/im);
  const title = t ? t[1].trim().replace(/^["']|["']$/g, '') : null;
  return { body: text.slice(m[0].length), title };
}

/** Which heading level would "Automatic" split at? 0 = don't split. */
export function suggestSplit(md: string): 0 | 1 | 2 | 3 {
  const { body } = stripFrontMatter(md.replace(/^﻿/, ''));
  const tokens = marked.lexer(body);
  const count = (d: number) => tokens.filter((t) => t.type === 'heading' && (t as Tokens.Heading).depth === d).length;
  if (count(1) >= 2) return 1;
  if (count(1) <= 1 && count(2) >= 2) return 2;
  return 0;
}

/** Make parsed HTML safe and simple enough for the editor. */
function simplify(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,svg,video,audio').forEach((n) => n.remove());
  doc.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt');
    img.replaceWith(doc.createTextNode(alt ? `[${alt}]` : ''));
  });
  doc.querySelectorAll('table').forEach((t) => {
    const frag = doc.createDocumentFragment();
    t.querySelectorAll('tr').forEach((tr) => {
      const p = doc.createElement('p');
      p.textContent = Array.from(tr.children).map((c) => (c.textContent ?? '').trim()).join(' | ');
      frag.append(p);
    });
    t.replaceWith(frag);
  });
  doc.querySelectorAll('pre').forEach((pre) => {
    const p = doc.createElement('p');
    const lines = (pre.textContent ?? '').replace(/\n$/, '').split('\n');
    lines.forEach((line, i) => {
      if (i) p.append(doc.createElement('br'));
      p.append(doc.createTextNode(line));
    });
    pre.replaceWith(p);
  });
  doc.body.querySelectorAll('*').forEach((n) => {
    for (const a of Array.from(n.attributes)) {
      if (a.name.startsWith('on') || a.name === 'style' || a.name === 'class' || a.name === 'id') n.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML.trim();
}

function render(tokens: Token[], links: unknown): string {
  const list = Object.assign([...tokens], { links }) as unknown as Tokens.Generic[] & { links: never };
  return simplify(marked.parser(list as never) as string);
}

const isBlank = (t: Token) => t.type === 'space';
const hasContent = (tokens: Token[]) => tokens.some((t) => !isBlank(t));

/** One Markdown file → one or more chapters. */
export function markdownToChapters(fileName: string, text: string, split: SplitMode = 'auto'): ImportedChapter[] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { body, title: fmTitle } = stripFrontMatter(clean);
  const tokens = marked.lexer(body);
  const links = (tokens as unknown as { links?: unknown }).links ?? {};
  const level = split === 'auto' ? suggestSplit(clean) : split === 'none' ? 0 : split;
  const fallback = fmTitle || stem(fileName) || 'Imported chapter';

  const heading = (t: Token | undefined): t is Tokens.Heading => !!t && t.type === 'heading';

  if (!level) {
    let rest: Token[] = tokens;
    let title = fallback;
    const first = tokens.findIndex((t) => !isBlank(t));
    if (first >= 0 && heading(tokens[first]) && tokens[first].depth === 1) {
      title = plain(tokens[first].text) || fallback;
      rest = tokens.slice(first + 1);
    }
    return [{ title, html: render(rest, links) }];
  }

  const chapters: ImportedChapter[] = [];
  let curTitle: string | null = null;
  let cur: Token[] = [];
  let pre: Token[] = [];
  const flush = () => {
    if (curTitle !== null) chapters.push({ title: curTitle, html: render(cur, links) });
  };
  for (const t of tokens) {
    if (heading(t) && t.depth === level) {
      flush();
      curTitle = plain(t.text) || 'Untitled';
      cur = [];
    } else if (curTitle === null) {
      pre.push(t);
    } else {
      cur.push(t);
    }
  }
  flush();
  // Text before the first chapter heading: headings above the split level are the book's own title and
  // are left out; any other text becomes a chapter of its own so that nothing is lost.
  pre = pre.filter((t) => !(heading(t) && t.depth < level));
  if (hasContent(pre)) chapters.unshift({ title: fallback, html: render(pre, links) });
  if (!chapters.length) chapters.push({ title: fallback, html: render(tokens, links) });
  return chapters;
}

/** Sort file names the way people count: chapter2 before chapter10. */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function isMarkdownName(name: string): boolean {
  const base = name.replace(/^.*[\\/]/, '');
  return !base.startsWith('.') && /\.(md|markdown|mdown|txt)$/i.test(base);
}

/** File names for "one file per chapter": 01-the-last-ferry.md */
export function chapterFileNames(titles: string[], slugFn: (s: string) => string): string[] {
  const width = Math.max(2, String(titles.length).length);
  const seen = new Map<string, number>();
  return titles.map((t, i) => {
    const base = `${String(i + 1).padStart(width, '0')}-${slugFn(t || 'chapter') || 'chapter'}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return (n > 1 ? `${base}-${n}` : base) + '.md';
  });
}

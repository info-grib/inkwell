import TurndownService from 'turndown';

const td = new TurndownService({
  headingStyle: 'atx',
  hr: '* * *',
  emDelimiter: '*',
  strongDelimiter: '**',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});
td.keep(['u']); // Markdown has no underline; keep it as inline HTML

export function htmlToMarkdown(html: string): string {
  return td.turndown(html).trim();
}

/** One chapter → Markdown, with its title as a top-level heading. */
export function chapterToMarkdown(title: string, html: string): string {
  return `# ${title}\n\n${htmlToMarkdown(html)}\n`;
}

// Strips the accent marks NFKD splits off (é → e + ´), leaving the plain letter for a filename. Built from
// character codes rather than written as a regex literal (either the raw combining characters, or even a
// \uXXXX escape) -- a minifier is free to re-emit either of those as literal Unicode text in the compiled
// file, and a page served without its encoding declared (as this one briefly was, mid-testing) then
// misreads those bytes and throws an uncaught "invalid regular expression" before the app can start.
// Building the pattern at runtime from plain numbers sidesteps the whole class of problem.
const COMBINING_MARKS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

export function slug(s: string, fallback = 'novel'): string {
  return (
    s
      .normalize('NFKD')
      .replace(COMBINING_MARKS, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || fallback
  );
}

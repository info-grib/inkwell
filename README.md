# Inkwell

A quiet, open-source writing app for novels and articles. Rich text (no Markdown to read), several books in one library, numbered chapters and notes in a sidebar, remarks attached to passages, automatic history, and Markdown import and export. Your writing lives as ordinary files in a folder, so a Nextcloud sync client can carry it between devices.

Built with web technology (TypeScript + [TipTap](https://tiptap.dev), MIT) and packaged as a desktop app with [Tauri](https://tauri.app) (MIT/Apache). No proprietary tools or languages.

## Run it on your Mac

You need three free things, once:

1. **Xcode Command Line Tools**: open Terminal and run `xcode-select --install`
2. **Node.js** (LTS): https://nodejs.org
3. **Rust**: run `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then restart Terminal

Then, inside this folder:

```bash
npm install            # downloads the libraries (first time only)
npm run tauri dev      # opens the app (first run compiles for a few minutes)
npm run app             # builds Inkwell.app and opens Finder to it
```

Drag `Inkwell.app` into Applications; from then on open it from Launchpad or Spotlight, like any app. Because you built it yourself, macOS will not block it. (`npm run tauri build` does the same build without opening Finder, and also makes a `.dmg`.)

To try just the editor in your browser, without Rust: `npm run dev`, then open http://localhost:1420 in Chrome or Edge. (Safari and Firefox can only keep text inside the browser, not in a folder.)

The same code builds on Windows and Linux with `npm run tauri build`.

The window adapts to its width: from 1360px you see the chapter list, the text (660 to 780px, growing smoothly with the window) and the remark notes in a margin beside it (340 to 380px); from 1080 to 1359px the margin narrows to 260px; from 861 to 1079px the remarks slide in from the right when you need them; at 860px and below (a phone, or a narrow window) the chapter list slides in from the left as well, the line handles are hidden and every button is at least 44px, so the same page is usable on a phone browser. From 861px up, the chapter list can also be collapsed entirely (the *sidebar* button, or Ctrl/Cmd+\\) so the text and margin use the whole window; the choice is remembered.

`npm run preview:page` builds a single self-contained HTML page with a sample project (this is what a hosted preview uses).

## How your writing is stored

When you open Inkwell for the first time, choose a folder for your **library** (for example one inside your Nextcloud sync folder). Every book is a folder inside it:

```
MyLibrary/
  salt-and-signal/                 one book = one folder
    project.json                   title, order and numbers of chapters and notes (schema 3)
    chapters/<id>.html             one file per chapter (plain HTML: opens in any browser)
    chapters/<id>.remarks.json     the remarks written on that chapter
    notes/<id>.html                loose notes, same format
    _history/<id>/<time>.html      automatic snapshots (newest 40 per text)
    _trash/...                     deleted chapters/notes; nothing is erased
  harbour-notes/                   another book, same layout
  _trash_books/                    deleted books wait here; nothing is erased
    <time>__salt-and-signal/...
```

There is deliberately **no index file** for the library: Inkwell simply lists the folders that contain a `project.json`. Two devices adding books at the same time can therefore never conflict in Nextcloud. Renaming a book changes only its title inside `project.json`; the folder keeps its name, so nothing moves.

One file per chapter means editing two chapters on two devices never conflicts either. When you switch back to the window, Inkwell notices if a text changed on disk (and you have no unsaved changes) and reloads it.

The `_history`, `_trash` and `_trash_books` folders are normal visible folders on purpose: Nextcloud clients skip hidden folders by default, and you want your safety net synced too.

**A project from version 1** (a single folder with its own `project.json`) still works. Choose that folder as your library and it appears as a book called after its title; books you add later go into subfolders of it. Nothing is moved; only its `project.json` gets the chapter numbers added (schema 3).

## Features

- **Books**: the name at the top of the sidebar is a menu. Switch between books, add a new one, rename or delete the current one. Deleting moves the book to *Deleted books* (same menu), from where you can bring it back. Inkwell reopens the book you left off in.
- **Markdown import** (the *Import* button): pick one or many `.md` files, or a whole folder. Files are sorted the way people count (chapter2 before chapter10). Each file becomes a chapter; a long file, or a whole-book export, can be split at its `#`, `##` or `###` headings ("Automatic" picks for you, and you see a preview before anything is added). The dialog first asks where the texts go: chapters or notes. Links keep their words, images their description, tables and code become plain lines of text.
- **Markdown export** (the *Export* button): this text, the whole book as one file (`# Book`, then `## Chapter`), or every chapter as its own numbered file (`01-the-last-ferry.md`) into a folder. Remarks are not included.
- **Typewriter look**: paper and ink, Courier Prime for the text, IBM Plex Mono for the interface, one accent colour. Light (a warm, soft paper) and dark themes, or follow the system. All fonts are bundled, nothing is loaded from the internet, and they cover English, Russian and Ukrainian (Courier Prime has no Cyrillic letters, so those come from IBM Plex Mono, which has the same width).
- **No toolbar.** Select words and a small bar appears: bold, italic, underline, heading, quote, list, and **+ remark**. On an empty line, type **/** for the block menu (text, heading, quote, list, scene break, remark). Hover a paragraph and two handles appear in the left margin: **+** adds a block below, **::** opens a menu (turn into, add remark, duplicate, delete) and can be dragged to move the whole block.
- Smart quotes (English, Ukrainian «», guillemets, German, or off), em dash and ellipsis as you type
- **Numbered sidebar**: chapters and notes sit in one list per kind, in number order, under a thin divider for the ones without one yet (shown as `#`). Type a number at the top of the page (then Enter, or `#` for "not sure yet") and the chapter moves to that place while the others shift; a number that is too big puts it last. Dragging a row above the divider gives it a number there; dragging it below unnumbers it — one list, one gesture, in either direction. Cmd/Ctrl+Option+Up/Down moves the open chapter from anywhere (not just a row you tabbed to). You can also drag a row into the other list: a chapter becomes a note, or a note becomes a chapter (its text and remarks go along, and both lists are renumbered). Deleting closes the gap, and Undo puts the chapter back in its place.
- **Right-click menu** in the sidebar: Rename (right in the list), Duplicate (named "(copy)", "(copy 2)", …, never "(copy) (copy)"), Move up / down, Move to notes (or to chapters), New chapter (or note) below, Move to Trash. Right-clicking empty space offers New chapter and New note.
- **Previous and next**: "Previous" and "Next" links under the last paragraph (in sidebar order), plus Ctrl/Cmd+[ and Ctrl/Cmd+] to jump between chapters or notes without leaving the keyboard.
- **A quiet top strip**: a thin strip with *sidebar*, *focus* (and *remarks* on narrow windows). Text fades out softly as it scrolls under it. When the big title has scrolled out of sight, a small `01 · TITLE` appears in the strip; click it to jump back to the top. The sidebar itself can be collapsed (button, or Ctrl/Cmd+\\) so the page uses the whole window; the choice is remembered.
- **Remarks in the margin**: select words, press **+ remark** (or Ctrl/Cmd+Alt+M). A small number appears after the words and the note sits in the margin level with its paragraph. Hovering a note tints its words; clicking the words highlights the note (a remark inside a remark — overlapping highlights — is fine: the newest one activates, and each keeps its own card). Resolve or delete remarks when done (*show resolved* is in the top strip).
- **Spell-check**, built in and entirely offline: red underlines under misspelled words, checked against open-source Hunspell dictionaries for English, Russian and Ukrainian (no OS spell-check involved, so it looks and works the same on every platform). Off by default; turn it on in Settings for the whole book, or per chapter/note right above its title (a mixed-language book can have chapters in different languages). Right-click a red-underlined word for suggestions or "Add to dictionary". The three dictionaries add about 13MB to the built app (mostly Ukrainian and Russian); each is only fetched into memory the first time that language is actually used.
- **Translucent window** (Mac app only): the sidebar shows the desktop through it, like the Zen browser. In Settings you can switch it off and set how transparent the sidebar and the page are (two sliders); macOS turns it off by itself when "Reduce transparency" is on.
- History: browse and restore earlier versions of any text
- Word count per chapter, for the whole book, and a daily word goal
- Focus mode (Ctrl/Cmd+Shift+F, Esc to leave): only the text, centred
- Settings: theme, accent colour, text font, interface font, text size, quotation marks, spell-check (this book), daily goal
- Responsive layout, see above

## Not yet (ideas for later)

- Line handles for touch screens (they are hidden below 860px for now)
- Endless scroll from one chapter into the next, and a compact navigator
- Typewriter scrolling, find and replace
- Export to Word/PDF/EPUB
- Phone: Tauri 2 can also build iOS and Android apps from this same code. File access and syncing on phones needs its own design.

## Code map

- `src/main.ts`: the user interface
- `src/blocks.ts`: selection bar, `/` menu, line handles and block drag
- `src/sortable.ts`: drag to reorder the sidebar lists, and to move a row into the other list
- `src/mac.ts`: translucent window on macOS
- `src/fonts.ts`: the bundled fonts
- `src/library.ts`: the folder of books (list, create, delete to `_trash_books`, restore)
- `src/project.ts`: how one book is laid out on disk (chapters, notes, history, trash)
- `src/fs.ts`: talks to the disk (Tauri, browser folder access, or browser storage); `SubFs` gives each book its own folder
- `src/remark.ts`: the TipTap extension for remarks
- `src/spell.ts`: loads Hunspell dictionaries (English, Russian, Ukrainian) and checks/suggests words, via `nspell`
- `src/spellcheck.ts`: the TipTap extension that draws the red underlines and finds the word under a right-click
- `src/export.ts`: HTML to Markdown (export)
- `src/markdown.ts`: Markdown to chapters (import): splitting, sorting, simplifying
- `scripts/copy-dictionaries.mjs`: copies the dictionary files into `public/dictionaries/` after `npm install`
- `scripts/build-app.mjs`: `npm run app` — builds Inkwell.app and opens the Finder folder that has it
- `src-tauri/`: the small desktop shell (Rust)

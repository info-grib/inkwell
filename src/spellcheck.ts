// Draws the red squiggly underlines. It scans the document's text after a short pause in typing, checks each
// word against the chosen Hunspell dictionary (src/spell.ts), and paints the misspelled ones as ProseMirror
// decorations — never part of the saved HTML, so nothing about this is written to the chapter's file.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import { misspelled, type SpellSetting } from './spell';

export interface SpellcheckOptions {
  /** Read fresh each run: the language to check against right now, or 'off'. */
  getLang: () => SpellSetting;
}

export const spellKey = new PluginKey<DecorationSet>('spellcheck');

/** A word: letters (with accents/combining marks) optionally joined by an apostrophe or hyphen to more letters,
 *  so contractions ("don't") and Ukrainian apostrophes ("п'ять") count as one word, not two. */
const WORD_RE = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;

/** Lets a language change or "Add to dictionary" ask the plugin in `view` to re-check right away. */
const rescanners = new WeakMap<EditorView, () => void>();
export function rescanSpelling(view: EditorView | null | undefined): void {
  if (view) rescanners.get(view)?.();
}

export const Spellcheck = Extension.create<SpellcheckOptions>({
  name: 'spellcheck',

  addOptions() {
    return { getLang: () => 'off' as SpellSetting };
  },

  addProseMirrorPlugins() {
    const { getLang } = this.options;

    return [
      new Plugin({
        key: spellKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const fresh = tr.getMeta(spellKey) as DecorationSet | undefined;
            if (fresh) return fresh;
            return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
          },
        },
        props: {
          decorations(state) {
            return spellKey.getState(state);
          },
        },
        view(view) {
          let timer: number | undefined;
          let generation = 0;

          const run = async () => {
            const lang = getLang();
            const mine = ++generation;
            if (lang === 'off') {
              if (spellKey.getState(view.state)?.find().length) view.dispatch(view.state.tr.setMeta(spellKey, DecorationSet.empty));
              return;
            }
            const words: { from: number; to: number; text: string }[] = [];
            view.state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return;
              const text = node.textContent;
              for (const m of text.matchAll(WORD_RE)) {
                const start = pos + 1 + (m.index ?? 0);
                words.push({ from: start, to: start + m[0].length, text: m[0] });
              }
            });
            const uniq = [...new Set(words.map((w) => w.text))];
            let bad: Set<string>;
            try {
              bad = await misspelled(lang, uniq);
            } catch (e) {
              console.warn('spell-check dictionary failed to load', e);
              return;
            }
            // A newer run started (language changed, or the text moved on) — let that one win.
            if (mine !== generation || view.isDestroyed) return;
            const decos = words.filter((w) => bad.has(w.text)).map((w) => Decoration.inline(w.from, w.to, { class: 'spell-bad' }));
            view.dispatch(view.state.tr.setMeta(spellKey, DecorationSet.create(view.state.doc, decos)));
          };

          const schedule = (delay = 500) => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => void run(), delay);
          };

          rescanners.set(view, () => schedule(0));
          schedule(0);

          return {
            update(_view, prevState) {
              if (!_view.state.doc.eq(prevState.doc)) schedule();
            },
            destroy() {
              window.clearTimeout(timer);
              rescanners.delete(view);
            },
          };
        },
      }),
    ];
  },
});

/** The word under a spell-check decoration at this position, if any. */
export function spellWordAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const set = spellKey.getState(view.state);
  if (!set) return null;
  let found: { from: number; to: number; text: string } | null = null;
  set.find(pos, pos).forEach((d) => {
    found = { from: d.from, to: d.to, text: view.state.doc.textBetween(d.from, d.to) };
  });
  return found;
}

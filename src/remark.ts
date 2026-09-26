// "Remark": a comment attached to a piece of text, like a Word comment.
// The highlight lives in the chapter's HTML as <span data-remark="id">, so it
// moves with the text as you edit. The remark's own text lives in <id>.remarks.json.

import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface RemarkView {
  /** The remark that is focused (its phrase gets the tint). */
  active: string | null;
  /** The remark whose note the pointer is over. */
  hover: string | null;
}
export const activeRemarkKey = new PluginKey<RemarkView>('activeRemark');

export interface RemarkOptions {
  /** Called when the user clicks inside the text; id is null when the click is not on a remark. */
  onSelect: (id: string | null) => void;
  /** The number shown after the marked words (matches the note); null shows none. */
  numberOf: (id: string) => number | null;
}

export const Remark = Mark.create<RemarkOptions>({
  name: 'remark',
  inclusive: false,
  excludes: '', // allow overlapping remarks

  addOptions() {
    return { onSelect: () => {}, numberOf: () => null };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-remark'),
        renderHTML: (a) => (a.id ? { 'data-remark': a.id } : {}),
      },
      resolved: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-resolved') === '1',
        renderHTML: (a) => (a.resolved ? { 'data-resolved': '1' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-remark]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'remark' }, HTMLAttributes), 0];
  },

  addProseMirrorPlugins() {
    const { onSelect, numberOf } = this.options;
    return [
      new Plugin<RemarkView>({
        key: activeRemarkKey,
        state: {
          init: () => ({ active: null, hover: null }),
          apply(tr, value) {
            const meta = tr.getMeta(activeRemarkKey) as Partial<RemarkView> | undefined;
            return meta ? { ...value, ...meta } : value;
          },
        },
        props: {
          decorations(state) {
            const view = activeRemarkKey.getState(state) ?? { active: null, hover: null };
            const decos: Decoration[] = [];
            // The end of each remark's last piece of text gets its number; the focused or hovered one gets a tint.
            const last = new Map<string, number>();
            state.doc.descendants((node, pos) => {
              if (!node.isText) return;
              for (const m of node.marks) {
                if (m.type.name !== 'remark') continue;
                const id = m.attrs.id as string;
                last.set(id, pos + node.nodeSize);
                if (id === view.active || id === view.hover) {
                  decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'remark-active' }));
                }
              }
            });
            for (const [id, end] of last) {
              const n = numberOf(id);
              if (n === null) continue;
              decos.push(Decoration.widget(end, () => {
                const sup = document.createElement('sup');
                sup.className = 'rsup';
                sup.textContent = String(n);
                sup.contentEditable = 'false';
                sup.dataset.for = id;
                return sup;
              }, { side: 1, key: `rn-${id}-${n}` }));
            }
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
          handleClick(view, pos) {
            const node = view.state.doc.nodeAt(pos);
            // Remarks can overlap (a remark inside a remark); the one added last is rendered innermost,
            // closest to the text, so a click on the overlap selects that one — the other stays reachable
            // from its own card in the margin.
            const marks = node?.marks.filter((x) => x.type.name === 'remark') ?? [];
            const m = marks[marks.length - 1];
            onSelect(m ? (m.attrs.id as string) : null);
            return false;
          },
        },
      }),
    ];
  },
});

export interface RemarkRange { from: number; to: number; text: string; resolved: boolean }

/** Where each remark is anchored in the document. */
export function collectRemarkRanges(doc: PMNode): Map<string, RemarkRange> {
  const map = new Map<string, RemarkRange>();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type.name !== 'remark') continue;
      const id = m.attrs.id as string;
      const from = pos;
      const to = pos + node.nodeSize;
      const r = map.get(id);
      if (!r) map.set(id, { from, to, text: node.text ?? '', resolved: !!m.attrs.resolved });
      else {
        r.to = to;
        r.text += node.text ?? '';
      }
    }
  });
  return map;
}

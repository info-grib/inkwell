// Drag-to-reorder for the chapter and note lists in the sidebar, and drag from one list into the other.
//
// Pointer events, so the same code serves mouse and touch. A press on a row only becomes a drag after the
// pointer has moved a few pixels, so plain clicks still open the chapter. On touch screens a row is dragged by
// its "::" grip only, so that swiping the list still scrolls it.
//
// While dragging: the row lifts (soft shadow, follows the pointer), a dashed ghost stays in its old place,
// and an accent line shows where it will land. The list under the pointer is tinted when it is not the row's own.

export interface SortableList {
  el: HTMLElement;
  /** A name for the list, handed back in onMove ('chapters', 'notes'). */
  id: string;
}
export interface SortableOptions {
  /**
   * The item was dropped: into list `to`, on the numbered side of the "Not numbered" divider (or the only
   * group, in a list with no divider) when `numbered` is true, before `beforeId` within that side (last when
   * null). `from` is the list it came from.
   */
  onMove: (id: string, from: string, to: string, numbered: boolean, beforeId: string | null) => void;
}

let justDragged = false;
/** True right after a drag ended, so the click that follows the pointer-up can be ignored. */
export const wasDragged = () => justDragged;

export function makeSortable(lists: SortableList[], opts: SortableOptions) {
  for (const home of lists) attach(home, lists, opts);
}

function attach(home: SortableList, lists: SortableList[], opts: SortableOptions) {
  const list = home.el;
  list.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest('.x, input, textarea')) return;
    const row = (ev.target as HTMLElement).closest<HTMLElement>('li[data-id]');
    if (!row || !list.contains(row)) return;
    if (ev.pointerType !== 'mouse' && !(ev.target as HTMLElement).closest('.grip')) return;

    const id = row.dataset.id!;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const rowRect = row.getBoundingClientRect();
    const grabY = startY - rowRect.top;
    let dragging = false;
    let lift: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    let targetList: SortableList = home;
    let target: string | null | undefined;
    let numbered = row.dataset.num !== '0';
    const homeNumbered = numbered;

    const itemsOf = (l: SortableList) => Array.from(l.el.querySelectorAll<HTMLElement>('li[data-id]'));
    /** The list nearest to the pointer (0 when it is inside one). */
    const listAt = (y: number) => {
      let best = home;
      let bestD = Infinity;
      for (const l of lists) {
        const r = l.el.getBoundingClientRect();
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < bestD) { bestD = d; best = l; }
      }
      return best;
    };
    const aim = (y: number) => {
      targetList = listAt(y);
      for (const l of lists) l.el.classList.toggle('drop-here', l !== home && l === targetList);
      // The "Not numbered" divider splits the list in two; which side the pointer is on decides whether the
      // item keeps (or gets) a number. A list with no divider (or an empty one) counts as all-numbered.
      const divider = targetList.el.querySelector<HTMLElement>('.list-divider');
      numbered = divider ? y < divider.getBoundingClientRect().top + divider.getBoundingClientRect().height / 2 : true;
      const group = itemsOf(targetList).filter((li) => (li.dataset.num !== '0') === numbered);
      let before: HTMLElement | null = null;
      for (const li of group) {
        const r = li.getBoundingClientRect();
        if (y < (r.top + r.bottom) / 2) { before = li; break; }
      }
      target = before ? before.dataset.id! : null;
      const box = targetList.el.getBoundingClientRect();
      let left = box.left;
      let width = box.width;
      let top: number;
      if (group.length === 0) {
        // the numbered or the "Not numbered" side is empty: the line sits right at the divider (or, with no
        // divider at all, at the top of the "No chapters/notes yet" line)
        const e = (divider ?? targetList.el.querySelector<HTMLElement>('li'))?.getBoundingClientRect() ?? box;
        left = e.left; width = e.width; top = (numbered ? e.top : e.bottom) - 2;
      } else {
        const ref = before ?? group[group.length - 1];
        const rr = ref.getBoundingClientRect();
        left = rr.left; width = rr.width;
        top = (before ? rr.top : rr.bottom) - 2;
      }
      line!.style.left = Math.round(left) + 'px';
      line!.style.width = Math.round(width) + 'px';
      line!.style.top = Math.round(top) + 'px';
    };
    const begin = () => {
      dragging = true;
      lift = document.createElement('div');
      lift.className = 'lift';
      lift.style.left = rowRect.left + 'px';
      lift.style.width = rowRect.width + 'px';
      for (const cls of ['num', 't']) {
        const src = row.querySelector('.' + cls);
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = src?.textContent ?? '';
        lift.append(s);
      }
      line = document.createElement('div');
      line.className = 'dropline';
      document.body.append(lift, line);
      row.classList.add('ghost');
      document.body.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        begin();
      }
      e.preventDefault();
      lift!.style.top = Math.round(e.clientY - grabY) + 'px';
      aim(e.clientY);
    };
    const finish = (commit: boolean) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      if (!dragging) return;
      lift?.remove();
      line?.remove();
      row.classList.remove('ghost');
      for (const l of lists) l.el.classList.remove('drop-here');
      document.body.style.cursor = '';
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
      if (!commit || target === undefined) return;
      if (targetList !== home) { opts.onMove(id, home.id, targetList.id, numbered, target); return; }
      if (target === id) return;
      // Dropping just after itself, on the same side of the divider, changes nothing.
      const group = itemsOf(home).filter((li) => (li.dataset.num !== '0') === numbered);
      const i = group.findIndex((li) => li.dataset.id === id);
      const next = group[i + 1]?.dataset.id ?? null;
      if (numbered === homeNumbered && target === next) return;
      opts.onMove(id, home.id, home.id, numbered, target);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  });
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs `update`, keeping the event list pinned to the bottom when it was there, or else to the row at its top as rows
 * above it are evicted.
 */
export function pinListScroll(list: HTMLElement, update: () => void): void {
  const wasAtBottom = isFollowingNewest(list);
  const previousScrollTop = list.scrollTop;
  const anchor = wasAtBottom ? null : findTopRow(list, previousScrollTop);
  const anchorTop = anchor === null ? 0 : getOffsetInList(list, anchor);
  update();
  // A hidden or empty list has no position to keep. `hidden` is typed to allow 'until-found' too.
  if (list.hidden !== false || list.querySelector('[data-seq]') === null) {
    return;
  }
  if (wasAtBottom) {
    list.scrollTop = list.scrollHeight;
  } else if (anchor?.isConnected === true) {
    list.scrollTop = previousScrollTop + getOffsetInList(list, anchor) - anchorTop;
  } else {
    list.scrollTop = previousScrollTop;
  }
}

/** Whether the list shows its newest row, within a few px of the end. */
export function isFollowingNewest(list: HTMLElement): boolean {
  return list.scrollHeight - list.clientHeight - list.scrollTop < 4;
}

/** The row's offset from the list's top, so a bar above the list that changes height in the same update moves neither. */
function getOffsetInList(list: HTMLElement, row: HTMLElement): number {
  return row.offsetTop - list.offsetTop;
}

/** The first row still in view at `scrollTop`, by bisection over offsets relative to the first row. */
function findTopRow(list: HTMLElement, scrollTop: number): HTMLElement | null {
  const rows = list.children;
  const first = rows[0];
  if (!(first instanceof HTMLElement)) {
    return null;
  }
  const target = scrollTop + first.offsetTop;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const row = rows[middle];
    if (row instanceof HTMLElement && row.offsetTop + row.offsetHeight > target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const top = rows[low];
  return top instanceof HTMLElement ? top : null;
}

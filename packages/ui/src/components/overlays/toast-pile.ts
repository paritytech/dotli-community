// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the toast stack piles its cards: which show, how deep each sits, and when a new one scrolls into view.

const MAX_STACK = 3;

/** Every live toast when expanded, else the newest three, oldest first. */
export function visibleToasts<T>(active: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? active : active.slice(-MAX_STACK);
}

/** Depth in the collapsed pile, 0 for the newest and for every card when expanded. A toast missing from the map is hidden behind the pile. */
export function pileDepths(shown: readonly { id: number }[], expanded: boolean): Map<number, number> {
  const map = new Map<number, number>();
  shown.forEach((t, i) => {
    map.set(t.id, expanded ? 0 : shown.length - 1 - i);
  });
  return map;
}

/** Only a new toast in an expanded stack scrolls to the newest card, not a dismissal, the first render or a collapsed pile. */
export function scrollsToNewest(count: number, previous: number | undefined, expanded: boolean): boolean {
  return previous !== undefined && count > previous && expanded;
}

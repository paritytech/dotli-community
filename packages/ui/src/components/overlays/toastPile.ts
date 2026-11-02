// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the toast stack piles its cards: which show, how deep each sits, and when a new one scrolls into view.

type Params = {
  /** How many toasts the store holds now. */
  count: number;
  /** How many it held before, undefined on the first render. */
  previous: number | undefined;
  /** Whether the stack is expanded. */
  expanded: boolean;
};

const MAX_STACK = 3;

/** Every live toast when expanded, else the newest three, oldest first. Never throws. */
export function getVisibleToasts<T>(active: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? active : active.slice(-MAX_STACK);
}

/**
 * Depth in the collapsed pile, 0 for the newest and for every card when expanded. A toast missing from the map is
 * hidden behind the pile. Never throws.
 */
export function getPileDepths(shown: readonly { id: number }[], expanded: boolean): Map<number, number> {
  const map = new Map<number, number>();
  for (const [index, toast] of shown.entries()) {
    map.set(toast.id, expanded ? 0 : shown.length - 1 - index);
  }
  return map;
}

/**
 * Whether the stack scrolls to the newest card: only for a new toast in an expanded stack, not a dismissal, the first
 * render or a collapsed pile. Never throws.
 */
export function isScrollingToNewest({ count, previous, expanded }: Params): boolean {
  return previous !== undefined && count > previous && expanded;
}

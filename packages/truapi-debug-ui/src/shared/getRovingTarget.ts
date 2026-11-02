// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  key: string;
  /** The focused item's position in the strip. */
  index: number;
  /** How many items the strip holds. */
  count: number;
  /** Alt, Ctrl or Meta held. */
  modified?: boolean;
};

/**
 * Where a key moves the focus in a horizontal strip of `count` items from `index`, wrapping at the ends, or `null` for a
 * key the strip leaves to the page. With `modified` every key is left to the browser, whose back and forward shortcuts
 * use the arrows. Never throws.
 */
export function getRovingTarget({ key, index, count, modified = false }: Params): number | null {
  if (count <= 0 || modified) {
    return null;
  }
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

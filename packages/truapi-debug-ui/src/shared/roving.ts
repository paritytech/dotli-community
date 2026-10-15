// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a key moves the focus in a horizontal strip of `count` items from `index`, wrapping at the ends, or `null` for a
 * key the strip leaves to the page. With `modified` (Alt, Ctrl or Meta held) every key is left to the browser, whose back
 * and forward shortcuts use the arrows.
 */
export function rovingTarget(key: string, index: number, count: number, modified = false): number | null {
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

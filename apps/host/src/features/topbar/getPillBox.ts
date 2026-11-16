// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Where the pill ends, in px from the viewport's inline end and top. */
export type PillBox = {
  inlineEnd: number;
  bottom: number;
};

/** Returns where the pill laid out at `rect` ends, or null for a bar that is not laid out, which has no box. */
export function getPillBox(rect: Pick<DOMRect, 'right' | 'bottom' | 'width'>, viewportWidth: number): PillBox | null {
  if (rect.width === 0) {
    return null;
  }
  return { inlineEnd: Math.round(Math.max(0, viewportWidth - rect.right)), bottom: Math.round(rect.bottom) };
}

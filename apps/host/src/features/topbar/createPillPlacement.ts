// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PillBox } from './getPillBox.js';

type Params = {
  /** Writes the pill's box, or null for none. */
  publish: (box: PillBox | null) => void;
};

/**
 * Returns a placement that publishes the pill's box at rest. A folded or morphing bar keeps the box it last published
 * at rest and is not measured, since its box changes every frame. An unchanged box is not written again.
 */
export function createPillPlacement({ publish }: Params): (measure: () => PillBox | null, atRest: boolean) => void {
  // As last published. Undefined until the first one.
  let last: PillBox | null | undefined;

  function place(measure: () => PillBox | null, atRest: boolean): void {
    if (!atRest) {
      return;
    }
    const box = measure();
    if (last !== undefined && isSameBox(box, last)) {
      return;
    }
    last = box;
    publish(box);
  }

  return place;
}

function isSameBox(box: PillBox | null, other: PillBox | null): boolean {
  if (box === null || other === null) {
    return box === other;
  }
  return box.inlineEnd === other.inlineEnd && box.bottom === other.bottom;
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createPillPlacement } from './createPillPlacement.js';
import type { PillBox } from './getPillBox.js';

type RecordingPlacement = {
  /** Places `box`, at rest unless told otherwise. */
  place: (box: PillBox | null, atRest?: boolean) => void;
  /** Every box published, oldest first. */
  published: (PillBox | null)[];
};

describe('pill placement', () => {
  it('As a user opening a menu from the pill, I fold and reveal the bar and the menu reads its box at rest, not a frame of the morph', () => {
    // Given a pill at rest
    const { place, published } = createRecordingPlacement();
    place({ inlineEnd: 340, bottom: 72 });

    // When the bar folds, morphs through other boxes and the reveal ends wider
    place({ inlineEnd: 500, bottom: 38 }, false);
    place({ inlineEnd: 660, bottom: 12 }, false);
    place({ inlineEnd: 300, bottom: 72 });

    // Then
    expect(published).toEqual([
      { inlineEnd: 340, bottom: 72 },
      { inlineEnd: 300, bottom: 72 },
    ]);
  });

  it('As a user, I resize the window without moving the pill and its box is not published again', () => {
    // Given
    const { place, published } = createRecordingPlacement();
    place({ inlineEnd: 340, bottom: 72 });

    // When
    place({ inlineEnd: 340, bottom: 72 });

    // Then
    expect(published).toEqual([{ inlineEnd: 340, bottom: 72 }]);
  });

  it('As a user opening a menu on a page whose bar is not laid out, I see its absence published, not skipped as unchanged', () => {
    // Given a bar not laid out, which has no box
    const { place, published } = createRecordingPlacement();

    // When
    place(null);

    // Then
    expect(published).toEqual([null]);
  });
});

/** Builds a placement that records what it published. */
function createRecordingPlacement(): RecordingPlacement {
  const published: (PillBox | null)[] = [];
  const placement = createPillPlacement({
    publish(box) {
      published.push(box);
    },
  });
  return {
    place(box, atRest = true) {
      placement(() => box, atRest);
    },
    published,
  };
}

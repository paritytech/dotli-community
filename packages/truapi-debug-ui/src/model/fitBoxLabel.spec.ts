// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fitBoxLabel } from './fitBoxLabel.js';
import { BOX_LABEL_CHAR_WIDTH, BOX_LABEL_INSET } from './timelineGeometry.js';

/** A box with room for exactly `chars` characters. */
function widthFor(chars: number): number {
  return chars * BOX_LABEL_CHAR_WIDTH + 2 * BOX_LABEL_INSET;
}

describe('fitBoxLabel()', () => {
  it.each([
    { label: 'sign', chars: 4, expected: 'sign' },
    { label: 'sign.payload', chars: 6, expected: 'sign.…' },
    { label: 'sign.payload', chars: 1, expected: '' },
  ])(
    'As a developer reading the debug timeline, I see a box print its tag whole, cut with an ellipsis, or not at all when it is too narrow ($label in $chars chars)',
    ({ label, chars, expected }) => {
      // When
      const fitted = fitBoxLabel(label, widthFor(chars));

      // Then
      expect(fitted).toBe(expected);
    },
  );
});

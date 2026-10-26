// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { wholeModuleSide } from './qr-size.js';

/** A version 13 code is 69 modules a side, drawn with a 2-module quiet zone, so 73 modules in all. */
const MODULES = 69;
const QUIET_ZONE = 2;

describe('the sign-in QR side', () => {
  it.each([
    [300, 292],
    [260, 219],
  ])('As a user on a layout asking %i px, I get a code of %i px with whole pixels per module', (size, side) => {
    // Given a version 13 code with its quiet zone and the side the layout asks for

    // When the side is fitted to whole pixels per module
    const drawn = wholeModuleSide(size, MODULES, QUIET_ZONE);

    // Then the side is a whole multiple of the 73 modules
    expect(drawn).toBe(side);
    expect(drawn % 73).toBe(0);
  });

  it('As a user on a layout asking exactly a whole multiple, I get that size', () => {
    // Given a layout that asks for 4 pixels per module
    const size = 4 * 73;

    // When the side is fitted to whole pixels per module
    const drawn = wholeModuleSide(size, MODULES, QUIET_ZONE);

    // Then the asked size is kept
    expect(drawn).toBe(292);
  });

  it('As a user on a layout smaller than the code, I still get one pixel per module', () => {
    // Given a layout that asks for fewer pixels than the code has modules
    const size = 50;

    // When the side is fitted to whole pixels per module
    const drawn = wholeModuleSide(size, MODULES, QUIET_ZONE);

    // Then each module still gets one pixel
    expect(drawn).toBe(73);
  });
});

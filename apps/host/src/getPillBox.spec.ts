// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getPillBox } from './getPillBox.js';

describe('getPillBox', () => {
  it('As a user opening a menu from the pill, I lay out the bar and the menu reads where the pill ends', () => {
    // When
    const box = getPillBox({ right: 1100, bottom: 72, width: 760 }, 1440);

    // Then
    expect(box).toEqual({ inlineEnd: 340, bottom: 72 });
  });

  it('As a user on a page whose bar is not laid out, I open a menu and it reads no pill box', () => {
    // When
    const box = getPillBox({ right: 0, bottom: 0, width: 0 }, 1440);

    // Then
    expect(box).toBeNull();
  });
});

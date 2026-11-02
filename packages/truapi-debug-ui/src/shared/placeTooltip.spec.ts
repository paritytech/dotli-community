// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { placeTooltip } from './placeTooltip.js';

describe('hover tooltip position', () => {
  it('As a dotli developer, I hover near the bottom of the screen and the tooltip flips above the pointer', () => {
    // When
    const at = placeTooltip({
      pointer: { x: 100, y: 560 },
      panel: { left: 0, top: 0, right: 1000 },
      size: { width: 200, height: 60 },
      viewportHeight: 600,
    });

    // Then
    expect(at).toEqual({ left: 112, top: 488 });
  });
});

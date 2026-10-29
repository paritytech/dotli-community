// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFrameBox } from './getFrameBox.js';

describe('getFrameBox', () => {
  it('As a dApp user, I open a frame with no chat and no dock and it reserves nothing at its edges', () => {
    // When
    const box = getFrameBox({ topbarOffset: true, chatWidth: 0, docks: {} });

    // Then
    expect(box).toEqual({ belowBar: true, right: 0, bottom: 0 });
  });

  it('As a dotli developer, I open chat and two docks and they add up at the edge they share', () => {
    // When
    const box = getFrameBox({
      topbarOffset: false,
      chatWidth: 360,
      docks: { debug: { right: 400, bottom: 300 }, 'sandbox-checker': { right: 0, bottom: 120 } },
    });

    // Then
    expect(box).toEqual({ belowBar: false, right: 760, bottom: 420 });
  });
});

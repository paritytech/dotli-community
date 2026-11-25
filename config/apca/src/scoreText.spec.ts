// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { scoreText, type Rgb } from './scoreText.js';

describe('scoreText', () => {
  it.each([
    { foreground: '#d4d5db', background: '#34363b', fontSize: 13, lc: 74.54, verdict: 'fails', passes: false },
    { foreground: '#d4d5db', background: '#34363b', fontSize: 16, lc: 74.54, verdict: 'passes', passes: true },
    { foreground: '#a9abb3', background: '#1a1b20', fontSize: 31, lc: 55.4, verdict: 'fails', passes: false },
    { foreground: '#a9abb3', background: '#1a1b20', fontSize: 32, lc: 55.4, verdict: 'passes', passes: true },
    { foreground: '#0b0c0f', background: '#ffffff', fontSize: 12, lc: 105.74, verdict: 'passes', passes: true },
  ])(
    'As a story author, I score $foreground text on $background at $fontSize px and it $verdict Bronze with Lc $lc',
    ({ foreground, background, fontSize, lc, passes }) => {
      // Given
      const pairs = [{ foreground: toRgb(foreground), background: toRgb(background) }];

      // When
      const score = scoreText({ pairs, fontSize });

      // Then
      expect(score?.lc).toBeCloseTo(lc, 1);
      expect(score?.passes).toBe(passes);
    },
  );

  it('As a story author, I score text on a gradient and its worst background decides', () => {
    // Given
    const light = { foreground: toRgb('#d4d5db'), background: toRgb('#34363b') };
    const dark = { foreground: toRgb('#d4d5db'), background: toRgb('#0b0c0f') };

    // When
    const score = scoreText({ pairs: [dark, light], fontSize: 13 });

    // Then
    expect(score?.pair).toBe(light);
    expect(score?.passes).toBe(false);
  });

  it('As a story author, I score text with no known background and get no verdict', () => {
    // Given
    const pairs: [] = [];

    // When
    const score = scoreText({ pairs, fontSize: 13 });

    // Then
    expect(score).toBeNull();
  });
});

function toRgb(hex: string): Rgb {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

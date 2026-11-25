// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseGradientStops } from './parseGradientStops.js';

describe('parseGradientStops', () => {
  it.each([
    { shape: 'no image', backgroundImage: 'none', stops: [] },
    {
      shape: 'a gradient with its default direction',
      backgroundImage: 'linear-gradient(rgba(44, 46, 52, 0.97) 0%, rgba(18, 19, 23, 0.98) 100%)',
      stops: [['rgba(44, 46, 52, 0.97)', 'rgba(18, 19, 23, 0.98)']],
    },
    {
      shape: 'a gradient with an angle',
      backgroundImage: 'linear-gradient(160deg, rgb(88, 91, 98) 0%, rgb(44, 46, 52) 100%)',
      stops: [['rgb(88, 91, 98)', 'rgb(44, 46, 52)']],
    },
    {
      shape: 'several gradients with color functions, hints, a calc() center and two positions on a stop',
      backgroundImage:
        'radial-gradient(circle at calc(50% + 2px) 50%, color(srgb 1 0 0 / 0.5) 0%, 40%, rgb(0, 0, 255) 100%), ' +
        'repeating-conic-gradient(from 90deg at 50% 50%, rgb(1, 2, 3) 0% 25%, rgb(4, 5, 6) calc(25% + 2px) 50%)',
      stops: [
        ['color(srgb 1 0 0 / 0.5)', 'rgb(0, 0, 255)'],
        ['rgb(1, 2, 3)', 'rgb(4, 5, 6)'],
      ],
    },
    {
      shape: 'a gradient interpolated around the hue wheel',
      backgroundImage: 'linear-gradient(in hsl longer hue, rgb(255, 0, 0), rgb(0, 0, 255))',
      stops: null,
    },
    {
      shape: 'a gradient over an image',
      backgroundImage: 'linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255)), url("https://example.com/a.png")',
      stops: null,
    },
    {
      shape: 'a stop whose color it cannot read',
      backgroundImage: 'linear-gradient(rgb(255, 255, 255) 0%, currentcolor 100%)',
      stops: null,
    },
    {
      shape: 'a first stop whose color it cannot read',
      backgroundImage: 'linear-gradient(color-mix(in srgb, rgb(255, 0, 0) 50%, rgb(0, 0, 255)), rgb(0, 0, 0))',
      stops: null,
    },
  ])(
    'As a story author, I read the color stops of $shape and get its stops, or none where I cannot read them',
    ({ backgroundImage, stops }) => {
      // Given
      const image = backgroundImage;

      // When
      const parsed = parseGradientStops(image);

      // Then
      expect(parsed).toEqual(stops);
    },
  );
});

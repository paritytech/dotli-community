// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { APCAcontrast, sRGBtoY } from 'apca-w3';

/** An sRGB color as 0 to 255 channels. */
export type Rgb = readonly [red: number, green: number, blue: number];

type Params = {
  foreground: Rgb;
  background: Rgb;
  /** Computed font size in px. */
  fontSize: number;
};

/** Scores text by its APCA lightness contrast (Lc) against the Bronze minimum for its font size. */
export function scoreText({ foreground, background, fontSize }: Params) {
  // The sign gives only the polarity, which the Bronze minimum ignores.
  const lc = Math.abs(APCAcontrast(sRGBtoY(foreground), sRGBtoY(background)));
  const minimum = getBronzeMinimum(fontSize);
  // The raw Lc is compared, so a rounded score that reaches the minimum can still fail.
  return { lc, minimum, passes: lc >= minimum };
}

function getBronzeMinimum(fontSize: number) {
  if (fontSize >= 32) {
    return 45;
  }
  if (fontSize >= 16) {
    return 60;
  }
  return 75;
}

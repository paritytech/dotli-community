// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { APCAcontrast, sRGBtoY } from 'apca-w3';

/** An sRGB color as 0 to 255 channels. */
export type Rgb = { readonly red: number; readonly green: number; readonly blue: number };

/** A text color and one background the text may sit on. */
type ColorPair = { foreground: Rgb; background: Rgb };

type Params<Pair extends ColorPair> = {
  pairs: readonly Pair[];
  /** Computed font size in px. */
  fontSize: number;
};

/**
 * Scores text by its lowest APCA lightness contrast (Lc) among its color pairs, against the Bronze minimum for its font
 * size. Returns the pair that scored lowest, or null when there is no pair.
 */
export function scoreText<Pair extends ColorPair>({
  pairs,
  fontSize,
}: Params<Pair>): { pair: Pair; lc: number; minimum: number; passes: boolean } | null {
  let worst: { pair: Pair; lc: number } | null = null;
  for (const pair of pairs) {
    // The sign gives only the polarity, which the Bronze minimum ignores.
    const lc = Math.abs(APCAcontrast(toY(pair.foreground), toY(pair.background)));
    if (!worst || lc < worst.lc) {
      worst = { pair, lc };
    }
  }
  if (!worst) {
    return null;
  }
  const minimum = getBronzeMinimum(fontSize);
  // The raw Lc is compared, so a rounded score that reaches the minimum can still fail.
  return { ...worst, minimum, passes: worst.lc >= minimum };
}

function toY({ red, green, blue }: Rgb) {
  return sRGBtoY([red, green, blue]);
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

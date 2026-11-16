// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The colour's perceptual lightness, in percent. */
  lightness: number;
  /** The colour's chroma, about 0.1 for a soft tint. */
  chroma: number;
};

/**
 * The hues a hashed colour may take, in degrees, from orange round through violet. Red and pink are left out, since
 * the panel reads them as an error.
 */
const FIRST_HUE = 55;
const HUE_SPAN = 270;

/**
 * A stable colour for `input`, its hue hashed from the text at the given lightness and chroma. In OKLCH, so every hue
 * at one lightness reads equally bright. Never throws.
 */
export function getHashColor(input: string, { lightness, chroma }: Params): string {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  const hue = FIRST_HUE + (((hash % HUE_SPAN) + HUE_SPAN) % HUE_SPAN);
  return `oklch(${String(lightness)}% ${String(chroma)} ${String(hue)})`;
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The colour's saturation, in percent. */
  saturation: number;
  /** The colour's lightness, in percent. */
  lightness: number;
};

/** A stable colour for `input`, its hue hashed from the text at the given saturation and lightness. Never throws. */
export function getHashColor(input: string, { saturation, lightness }: Params): string {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${String(hue)}, ${String(saturation)}%, ${String(lightness)}%)`;
}

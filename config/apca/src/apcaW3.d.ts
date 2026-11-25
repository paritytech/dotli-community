// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The package ships no types. Only the calls this package makes are declared.
declare module 'apca-w3' {
  /** Signed APCA lightness contrast of text on a background, negative for light text on dark. */
  export function APCAcontrast(textY: number, backgroundY: number): number;
  /** Screen luminance of an sRGB color given as 0 to 255 channels. */
  export function sRGBtoY(rgb: readonly [red: number, green: number, blue: number]): number;
}

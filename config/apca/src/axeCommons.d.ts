// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// axe's color and text helpers are public but untyped. Only the calls this package makes are declared.

/** axe's color, with 0 to 255 channels and an alpha from 0 to 1. */
export type Color = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  /**
   * Reads any CSS color into this color and returns it.
   *
   * Throws an `Error` when the string is no color axe can read.
   */
  parseString(color: string): Color;
  toHexString(): string;
};

declare module 'axe-core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- augmenting axe's Commons needs declaration merging
  interface Commons {
    color: {
      Color: new (red?: number, green?: number, blue?: number, alpha?: number) => Color;
      flattenColors(source: Color, backdrop: Color): Color;
      getBackgroundColor(node: Element, backgroundElements: Element[]): Color | null;
      /** The elements under the text, the text's own element first. */
      getBackgroundStack(node: Element): Element[] | null;
      getForegroundColor(node: Element, noScroll: boolean, background: Color): Color | null;
    };
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- augmenting axe's Dom needs declaration merging
  interface Dom {
    getVisibleChildTextRects(node: Element): DOMRect[];
  }
}

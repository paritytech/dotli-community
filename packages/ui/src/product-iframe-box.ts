// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry for the product iframe.
 *
 * The host viewport covers the whole display, so this box is what keeps the
 * product clear of the status bar, the home indicator and the sensor housing.
 * The host owns the iframe's geometry, so it is the only place that can reserve
 * them. `product-frame-layout.ts` is the only writer and builds every frame
 * position from this box.
 *
 * Every value carries a px fallback because these are set as inline styles.
 * Unlike the rules in `global.css`, they do not ship with the file that defines
 * the tokens, so a stylesheet that has not applied yet must not break layout.
 */

const SAFE_TOP = 'var(--safe-top, 0px)';
const SAFE_BOTTOM = 'var(--safe-bottom, 0px)';
const SAFE_LEFT = 'var(--safe-left, 0px)';
const SAFE_RIGHT = 'var(--safe-right, 0px)';
const CONTENT_TOP = 'var(--content-top, 68px)';
const CONTENT_BOTTOM = 'var(--content-bottom, 0px)';

export interface ProductIframeBox {
  top: string;
  left: string;
  width: string;
  height: string;
}

/** Build the product iframe's box, reserving the space it must not cover. */
export function productIframeBox(opts: { topbarOffset: boolean }): ProductIframeBox {
  // The content edges already include the insets on the bar's side (the top
  // on desktop, the bottom on phones), so one term per edge covers both.
  const top = opts.topbarOffset ? CONTENT_TOP : SAFE_TOP;
  const bottom = opts.topbarOffset ? CONTENT_BOTTOM : SAFE_BOTTOM;
  return {
    top,
    left: SAFE_LEFT,
    width: `calc(100% - ${SAFE_LEFT} - ${SAFE_RIGHT})`,
    height: `calc(100dvh - ${top} - ${bottom})`,
  };
}

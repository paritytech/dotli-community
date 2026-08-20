// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry for the product iframe.
 *
 * The host viewport covers the whole display, so this box is what keeps the
 * product clear of the status bar, the home indicator and the sensor housing.
 * The host owns the iframe's geometry, so it is the only place that can reserve
 * them. The values live here rather than at the two call sites so the full
 * styling in `bridge.ts` and the topbar autohide in the host cannot drift.
 *
 * Every value carries a px fallback because these are set as inline styles.
 * Unlike the rules in `styles.css`, they do not ship with the file that defines
 * the tokens, so a stylesheet that has not applied yet must not break layout.
 */

const SAFE_TOP = "var(--safe-top, 0px)";
const SAFE_BOTTOM = "var(--safe-bottom, 0px)";
const SAFE_LEFT = "var(--safe-left, 0px)";
const SAFE_RIGHT = "var(--safe-right, 0px)";
const TOPBAR_HEIGHT = "var(--topbar-height, 56px)";

export interface ProductIframeBox {
  top: string;
  left: string;
  width: string;
  height: string;
}

/** Build the product iframe's box, reserving the space it must not cover. */
export function productIframeBox(opts: {
  topbarOffset: boolean;
}): ProductIframeBox {
  // `--topbar-height` already includes the top inset, so one term covers both.
  const top = opts.topbarOffset ? TOPBAR_HEIGHT : SAFE_TOP;
  return {
    top,
    left: SAFE_LEFT,
    width: `calc(100% - ${SAFE_LEFT} - ${SAFE_RIGHT})`,
    height: `calc(100vh - ${top} - ${SAFE_BOTTOM})`,
  };
}

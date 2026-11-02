// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host viewport covers the whole display, so this box keeps the product clear of the safe-area insets.
// Values carry px fallbacks because they are inline styles that can apply before the token stylesheet.

export type ProductIframeBox = {
  top: string;
  left: string;
  width: string;
  height: string;
};

type Params = {
  /** Whether the frame sits below the topbar, rather than at the top of the display. */
  topbarOffset: boolean;
};

const SAFE_TOP = 'var(--safe-top, 0px)';
const SAFE_BOTTOM = 'var(--safe-bottom, 0px)';
const SAFE_LEFT = 'var(--safe-left, 0px)';
const SAFE_RIGHT = 'var(--safe-right, 0px)';
const CONTENT_TOP = 'var(--content-top, 68px)';
const CONTENT_BOTTOM = 'var(--content-bottom, 0px)';

/** Returns the frame's CSS box, below the bar when `topbarOffset` is set, else full height. Never throws. */
export function getProductIframeBox({ topbarOffset }: Params): ProductIframeBox {
  // The content edges already include the insets on the bar's side, so one term per edge covers both.
  const top = topbarOffset ? CONTENT_TOP : SAFE_TOP;
  const bottom = topbarOffset ? CONTENT_BOTTOM : SAFE_BOTTOM;
  return {
    top,
    left: SAFE_LEFT,
    width: `calc(100% - ${SAFE_LEFT} - ${SAFE_RIGHT})`,
    height: `calc(100dvh - ${top} - ${bottom})`,
  };
}

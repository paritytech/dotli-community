// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host viewport covers the whole display, so this box keeps the product clear of the safe-area insets.
// Values carry px fallbacks because they are inline styles that can apply before the token stylesheet.

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

export function productIframeBox(opts: { topbarOffset: boolean }): ProductIframeBox {
  // The content edges already include the insets on the bar's side, so one term per edge covers both.
  const top = opts.topbarOffset ? CONTENT_TOP : SAFE_TOP;
  const bottom = opts.topbarOffset ? CONTENT_BOTTOM : SAFE_BOTTOM;
  return {
    top,
    left: SAFE_LEFT,
    width: `calc(100% - ${SAFE_LEFT} - ${SAFE_RIGHT})`,
    height: `calc(100dvh - ${top} - ${bottom})`,
  };
}

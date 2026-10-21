// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Window as HappyWindow } from 'happy-dom';

// happy-dom's default window size.
const DESKTOP = { width: 1024, height: 768 };

// The test environment's window is a happy-dom Window, which the DOM lib's type does not say.
function happyDom(): HappyWindow['happyDOM'] {
  return (window as unknown as HappyWindow).happyDOM;
}

/** Moves the page to `url`, as a navigation would. */
export function setPageUrl(url: string): void {
  happyDom().setURL(url);
}

/** Makes the page phone-wide. Pair with `resetViewport()` in `afterEach`. */
export function setPhoneViewport(): void {
  happyDom().setViewport({ width: 390, height: 844 });
}

/** Back to the desktop default. */
export function resetViewport(): void {
  happyDom().setViewport(DESKTOP);
}

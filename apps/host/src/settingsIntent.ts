// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The way into Settings from outside the bar, such as an error page's button. The settings popover owns whether it
// is open, so this only asks it.

import { registerStoreStateReset } from '@dotli/shared';

let opener: (() => void) | null = null;
/** Asked before the popover mounted, so the popover opens as it registers. */
let asked = false;

registerStoreStateReset(() => {
  asked = false;
});

export function openSettings(): void {
  if (opener === null) {
    asked = true;
    return;
  }
  opener();
}

/** For the settings popover. The returned function unregisters it. */
export function registerSettingsOpener(open: () => void): () => void {
  opener = open;
  if (asked) {
    asked = false;
    open();
  }
  return () => {
    if (opener === open) {
      opener = null;
    }
  };
}

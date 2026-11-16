// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The way into Settings from outside the bar, such as an error page's button. The settings popover owns whether it
// is open, so this only asks it.

import { registerStoreStateReset } from '@dotli/shared';

/** Builds an intent with no popover registered and nothing asked. */
export function createSettingsIntent() {
  let opener: (() => void) | null = null;
  /** Asked before the popover mounted, so the popover opens as it registers. */
  let asked = false;

  registerStoreStateReset(() => {
    asked = false;
  });

  function open(): void {
    if (opener === null) {
      asked = true;
      return;
    }
    opener();
  }

  function registerOpener(next: () => void): () => void {
    opener = next;
    if (asked) {
      asked = false;
      next();
    }
    function unregister(): void {
      if (opener === next) {
        opener = null;
      }
    }
    return unregister;
  }

  return {
    /**
     * Asks the registered popover to open, or the next one to register while none is. Throws what the popover's
     * opener throws.
     */
    open,
    /**
     * Registers the settings popover's opener, calling it at once when settings were asked for meanwhile. Returns the
     * unregister, which leaves a later opener in place. Throws what the opener throws.
     */
    registerOpener,
  };
}

/** The page's way into Settings. */
export const settingsIntent = createSettingsIntent();

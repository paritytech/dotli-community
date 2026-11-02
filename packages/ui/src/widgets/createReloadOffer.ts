// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ShowNotification } from './createNotifier.js';

type Params = {
  /** Shows the offer as a notification. */
  notify: ShowNotification;
  /** Reloads the page, on the offer's Reload button. */
  reload: () => void;
};

/**
 * The page's one reload offer, for any part of it that failed to load, most likely because a new version was
 * deployed. Asked again while it shows, it adds nothing. Once the visitor closes it, the next failure offers again.
 * Returns the offer function, which throws only what `notify` throws.
 */
export function createReloadOffer({ notify, reload }: Params): () => void {
  let showing = false;

  function offerReload(): void {
    if (showing) {
      return;
    }
    showing = true;
    // The user opts into a reload rather than getting a silent one.
    notify({
      label: 'Asset failed to load',
      text: 'A new version may have been deployed. Reload to get the latest.',
      tone: 'err',
      dismissMs: 0,
      action: { label: 'Reload', onClick: reload },
      onDismiss: () => {
        showing = false;
      },
    });
  }

  return offerReload;
}

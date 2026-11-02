// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { showNotification } from '@dotli/ui';

/** Tells the visitor a newer version waits for a reload, with a Reload that reloads the page. Never throws. */
export function offerReloadNotice(): void {
  showNotification({
    label: 'New version available',
    text: `App was updated. Reload to use the latest version.`,
    dismissMs: 0,
    action: {
      label: 'Reload',
      onClick: () => {
        window.location.reload();
      },
    },
  });
}

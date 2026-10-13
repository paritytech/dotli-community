// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import '@dotli/ui/styles.css';
import { ensureOverlayRoot, listenForChunkFailures, mountRoot, Overlays, showNotification } from '@dotli/ui';

/** What a page load starts first: the reload offer for a chunk that fails, and the page's toasts and dialogs. */
export function startPage(): void {
  listenForChunkFailures({
    target: window,
    notify: showNotification,
    reload: () => {
      window.location.reload();
    },
  });
  const root = ensureOverlayRoot();
  // Marked, so a full-page screen keeps it.
  root.dataset['overlays'] = '';
  mountRoot('overlays', root, () => <Overlays />);
}

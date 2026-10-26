// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { listen } from './listen.js';

/** A page's document as far as its visibility goes. */
export type VisibilitySource = EventTarget & { readonly visibilityState: DocumentVisibilityState };

/** Calls `handler` each time the page becomes visible, never as it is hidden, until the returned stop. */
export function listenForDocumentVisible(visibility: VisibilitySource, handler: () => void): () => void {
  return listen({
    target: visibility,
    type: 'visibilitychange',
    handler: () => {
      if (visibility.visibilityState === 'visible') {
        handler();
      }
    },
  });
}

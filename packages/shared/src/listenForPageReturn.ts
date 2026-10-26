// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { listen } from './listen.js';
import { listenForDocumentVisible, type VisibilitySource } from './listenForDocumentVisible.js';

type Params = {
  visibility: VisibilitySource;
  target: EventTarget;
  handler: () => void;
};

/**
 * Calls `handler` each time the user comes back to the page, until the returned stop. A window beside another stays
 * visible while the user works in the other, so coming back to it is its focus, and to a tab its turning visible.
 */
export function listenForPageReturn({ visibility, target, handler }: Params): () => void {
  const stops = [listenForDocumentVisible(visibility, handler), listen({ target, type: 'focus', handler })];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}

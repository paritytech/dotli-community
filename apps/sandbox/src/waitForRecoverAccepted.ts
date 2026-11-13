// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hears the host accept the recover ask a reloaded sandbox posted.

import { parseRecoverAcceptedMessage } from '@dotli/sandbox-wire';
import { realTimers, startActiveTimeout, type Timers } from '@dotli/shared';

type Params = {
  /** The sandbox's own window, where the host's acceptance arrives. */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The host page that framed this sandbox, the only window whose acceptance counts. */
  parent: unknown;
  /** Whether a message from `origin` may come from the host. Never throws. */
  isHostOrigin: (origin: string) => boolean;
  /** How long the host has to accept. */
  ms: number;
  /** The timers the deadline runs on. The page's own unless given. */
  timers?: Timers;
};

/**
 * Waits for the host to accept this sandbox's recover ask. Resolves once `parent`, at an origin `isHostOrigin`
 * accepts, posts the acceptance, rejects once `ms` pass first, and removes its listener either way.
 */
export function waitForRecoverAccepted({
  window: sandboxWindow,
  parent,
  isHostOrigin,
  ms,
  timers = realTimers,
}: Params): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopTimeout = startActiveTimeout({
      ms,
      timers,
      onElapsed: () => {
        sandboxWindow.removeEventListener('message', onMessage);
        reject(new Error(`The host did not accept the recover ask within ${String(ms)}ms`));
      },
    });
    sandboxWindow.addEventListener('message', onMessage);

    function onMessage(event: MessageEvent<unknown>): void {
      if (event.source !== parent || !isHostOrigin(event.origin)) {
        return;
      }
      if (parseRecoverAcceptedMessage(event.data) === null) {
        return;
      }
      sandboxWindow.removeEventListener('message', onMessage);
      stopTimeout();
      resolve();
    }
  });
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hears the host accept the recover ask a reloaded sandbox posted.

import { parseRecoverAcceptedMessage } from '@dotli/sandbox-wire';

type Params = {
  /** The sandbox's own window, where the host's acceptance arrives. */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The host page that framed this sandbox, the only window whose acceptance counts. */
  parent: unknown;
  /** Whether a message from `origin` may come from the host. Never throws. */
  isHostOrigin: (origin: string) => boolean;
  /** Gives up the wait. */
  signal: AbortSignal;
};

/**
 * Waits for the host to accept this sandbox's recover ask. Resolves once `parent`, at an origin `isHostOrigin`
 * accepts, posts the acceptance, rejects with `signal.reason` once `signal` aborts, and removes its listener either
 * way. A signal aborted before the call rejects at once and adds no listener.
 */
export function waitForRecoverAccepted({ window: sandboxWindow, parent, isHostOrigin, signal }: Params): Promise<void> {
  if (signal.aborted) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- an abort rejects with the caller's own reason, whatever it is
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    sandboxWindow.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });

    function onMessage(event: MessageEvent<unknown>): void {
      if (event.source !== parent || !isHostOrigin(event.origin)) {
        return;
      }
      if (parseRecoverAcceptedMessage(event.data) === null) {
        return;
      }
      stopListening();
      resolve();
    }

    function onAbort(): void {
      stopListening();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- an abort rejects with the caller's own reason, whatever it is
      reject(signal.reason);
    }

    function stopListening(): void {
      sandboxWindow.removeEventListener('message', onMessage);
      signal.removeEventListener('abort', onAbort);
    }
  });
}

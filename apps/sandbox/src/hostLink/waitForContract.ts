// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Asks the direct host parent for this sandbox's contract and waits for the authenticated reply.

import { parseHostToSandboxMessage, postToHost, type SandboxContractMessage } from '@dotli/sandbox-wire';
import { realTimers, startActiveTimeout, type Timers } from '@dotli/shared';

type Params = {
  /** The sandbox's own window, where the host's reply arrives. */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The host page that framed this sandbox: the request goes to it, and only its reply counts. */
  parent: Pick<Window, 'postMessage'>;
  /** Whether a message from `origin` may come from the host. Never throws. */
  isHostOrigin: (origin: string) => boolean;
  /** How long the host has to reply before the wait gives up. */
  ms: number;
  /** How often the request is re-posted until a valid reply arrives. */
  intervalMs: number;
  /** The timers the deadline and the re-post run on. The page's own unless given. */
  timers?: Timers;
};

/**
 * Asks the host parent for the sandbox contract and resolves with its reply. Posts the request at once and again every
 * `intervalMs`, since the host drops a request that arrives before its frame is on screen. Resolves once `parent`, at an
 * origin `isHostOrigin`, posts a contract reply, rejects once `ms` pass first, and stops listening and re-posting either
 * way. The reply is accepted on receipt from the authenticated parent, so the request itself goes to any origin.
 */
export function waitForContract({
  window: sandboxWindow,
  parent,
  isHostOrigin,
  ms,
  intervalMs,
  timers = realTimers,
}: Params): Promise<SandboxContractMessage> {
  return new Promise((resolve, reject) => {
    let repost: unknown;
    const stopTimeout = startActiveTimeout({
      ms,
      timers,
      onElapsed: () => {
        stop();
        reject(new Error(`The host did not deliver the sandbox contract within ${String(ms)}ms`));
      },
    });
    sandboxWindow.addEventListener('message', onMessage);
    postRequest();

    function stop(): void {
      sandboxWindow.removeEventListener('message', onMessage);
      timers.clearTimeout(repost);
      stopTimeout();
    }

    function postRequest(): void {
      postToHost(parent, { type: 'dotli:sandbox-contract-request' });
      repost = timers.setTimeout(postRequest, intervalMs);
    }

    function onMessage(event: MessageEvent<unknown>): void {
      if (event.source !== parent || !isHostOrigin(event.origin)) {
        return;
      }
      const reply = parseHostToSandboxMessage(event.data);
      if (reply?.type !== 'dotli:sandbox-contract') {
        return;
      }
      stop();
      resolve(reply);
    }
  });
}

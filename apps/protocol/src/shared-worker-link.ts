// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: relays what the worker says, and waits until it is ready.

import { captureException, m, spans as S } from '@dotli/metrics';
import type { ProtocolEnvelope } from '@dotli/protocol';
import { log } from '@dotli/shared';

import { PROTOCOL_APP_ERRORS } from './errors.js';
import { disconnectOnPageHide, relayFromWorker, type SWOutbound } from './worker-messages.js';

export interface SharedWorkerLinkDeps {
  worker: Pick<SharedWorker, 'port' | 'addEventListener'>;
  /** The iframe's page, whose `pagehide` tells the worker the tab is leaving. */
  window: Pick<EventTarget, 'addEventListener'>;
  /** Hands each envelope from the worker to the host page. */
  relay: (envelope: ProtocolEnvelope) => void;
  readyTimeoutMs: number;
}

/** Resolves with the worker's port once the worker says it is ready, and rejects with why it never will be. */
export function connectSharedWorker(deps: SharedWorkerLinkDeps): Promise<MessagePort> {
  const { worker, relay, readyTimeoutMs } = deps;
  const port = worker.port;
  const startedAt = performance.now();
  let failReadyWait: ((error: Error) => void) | null = null;

  // Fires only when the worker script cannot be fetched or evaluated.
  worker.addEventListener('error', event => {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new Error(`SharedWorker failed to start${detail}`);
    log.error('[dot.li protocol] SharedWorker error event', error);
    if (failReadyWait !== null) {
      // Fails now with the cause instead of at the ready timeout. The host reports the resulting `init-failed`.
      failReadyWait(error);
      return;
    }
    // After ready nothing waits on the worker's start, so the host would never hear of it.
    captureException(error, { flow: 'protocol', step: 'shared_worker_error' });
  });

  // Before the ready wait, because `smoldot-db` arrives during pre-sync and MessagePort events are not replayed.
  relayFromWorker(port, relay);
  // Before the ready wait too, so a frame removed while the worker syncs still frees its port at once.
  disconnectOnPageHide(deps.window, port);

  return new Promise<MessagePort>((resolve, reject) => {
    function settle(outcome: 'ok' | 'error' | 'timeout', error?: Error, reason?: string): void {
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      failReadyWait = null;
      const waitMs = performance.now() - startedAt;
      m.distribution(S.PROTOCOL_SW_READY, waitMs, 'millisecond', {
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (error !== undefined) {
        reject(error);
        return;
      }
      m.measure(S.PROTOCOL_SW_READY, waitMs);
      resolve(port);
    }

    function onMessage(event: MessageEvent): void {
      const data = event.data as SWOutbound | null;
      if (data?.type === 'ready') {
        settle('ok');
      } else if (data?.type === 'error') {
        settle('error', new Error(`SharedWorker error: ${data.message}`), 'worker_reported');
      }
    }

    const timer = setTimeout(() => {
      settle('timeout', new Error(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT));
    }, readyTimeoutMs);
    failReadyWait = error => {
      settle('error', error, 'load_failed');
    };
    port.addEventListener('message', onMessage);
    port.start();
  });
}

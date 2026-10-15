// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: relays what the worker says, and waits until it is ready.

import { captureException, m, spans as S } from '@dotli/metrics';
import type { ProtocolEnvelope } from '@dotli/protocol';
import { log, withTimeout } from '@dotli/shared';

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

  // Why the wait failed, for the metric. A timeout carries none.
  let reason: string | undefined;
  let onMessage = (_event: MessageEvent): void => undefined;
  const ready = new Promise<MessagePort>((resolve, reject) => {
    const fail = (error: Error, why: string): void => {
      reason = why;
      reject(error);
    };
    onMessage = event => {
      const data = event.data as SWOutbound | null;
      if (data?.type === 'ready') {
        resolve(port);
      } else if (data?.type === 'error') {
        fail(new Error(`SharedWorker error: ${data.message}`), 'worker_reported');
      }
    };
    failReadyWait = error => {
      fail(error, 'load_failed');
    };
    port.addEventListener('message', onMessage);
    port.start();
  });

  let timedOut: Error | undefined;
  const record = (outcome: 'ok' | 'error' | 'timeout'): number => {
    port.removeEventListener('message', onMessage);
    failReadyWait = null;
    const waitMs = performance.now() - startedAt;
    m.distribution(S.PROTOCOL_SW_READY, waitMs, 'millisecond', {
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    });
    return waitMs;
  };
  return withTimeout(ready, readyTimeoutMs, () => {
    timedOut = new Error(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT);
    return timedOut;
  }).then(
    readyPort => {
      m.measure(S.PROTOCOL_SW_READY, record('ok'));
      return readyPort;
    },
    (error: unknown) => {
      record(error === timedOut ? 'timeout' : 'error');
      throw error;
    },
  );
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: a transport on the worker's port that waits until the worker is
// ready, answers the worker's beats so it keeps the port, and lets go of the port when the tab leaves.

import { captureException, m, spans as S } from '@dotli/metrics';
import { createConsumerTransport, createPortProvider, type ConsumerTransport } from '@dotli/protocol';
import { log, realTimers, withTimeout, type Timers } from '@dotli/shared';

import { PROTOCOL_APP_ERRORS } from './errors.js';
import { disposeOnPageHide } from './worker-port.js';

/** The one `frameStatus` subscription to the worker. */
export interface WorkerStatus {
  /** Hears its one end: null when the worker ended it cleanly, else why. Called at once if it has ended. */
  onEnd(listener: (error: Error | null) => void): void;
}

export interface SharedWorkerLinkDeps {
  worker: Pick<SharedWorker, 'port' | 'addEventListener'>;
  /** The iframe's page, whose `pagehide` lets go of the worker. */
  window: Pick<EventTarget, 'addEventListener'>;
  /** The page load, which labels the worker's spans for this tab. */
  resolutionId: string | null;
  readyTimeoutMs: number;
  timers?: Timers;
  /**
   * Hands over the transport and the worker's status before the ready wait, so what the worker reports while it syncs
   * reaches the host live, and a worker that fails while it syncs ends the frame with its own error.
   */
  onOpen?: (transport: ConsumerTransport, status: WorkerStatus) => void;
}

/**
 * Answers each of the worker's beats with a heartbeat. The beat arrives as a message event, which a page hidden for
 * long still handles at once, while its own timers are throttled to about one a minute.
 */
function answerBeats(transport: ConsumerTransport): void {
  let answering = true;
  const beats = transport.subscribe('beat', undefined, () => {
    void transport.request('heartbeat', undefined).catch((error: unknown) => {
      // A link that ended has already said why through its status, and its pending heartbeats fail with the same.
      if (!answering) {
        return;
      }
      answering = false;
      beats.unsubscribe();
      captureException(error, { flow: 'protocol', step: 'worker_heartbeat' });
      log.error('[dot.li protocol] Worker heartbeat failed', error);
    });
  });
  beats.onEnd(() => {
    answering = false;
  });
}

/** Resolves with the transport to the worker once the worker says it is ready, and rejects with why it never will be. */
export function connectSharedWorker(deps: SharedWorkerLinkDeps): Promise<ConsumerTransport> {
  const { worker, readyTimeoutMs } = deps;
  const timers = deps.timers ?? realTimers;
  const startedAt = performance.now();
  // A port delivers every message, so one handshake is enough. It has the ready wait's budget, so a worker whose script
  // loads slowly fails no sooner than one that loaded and never synced.
  const transport = createConsumerTransport(createPortProvider(worker.port), {
    side: 'frame',
    timers,
    retryMs: readyTimeoutMs,
    timeoutMs: readyTimeoutMs,
    ...(deps.resolutionId === null ? {} : { resolutionId: deps.resolutionId }),
  });
  let failReadyWait: ((error: Error, why: string) => void) | null = null;

  // Fires only when the worker script cannot be fetched or evaluated.
  worker.addEventListener('error', event => {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new Error(`SharedWorker failed to start${detail}`);
    log.error('[dot.li protocol] SharedWorker error event', error);
    if (failReadyWait !== null) {
      // Fails now with the cause instead of at the ready timeout. The host reports the resulting failed init.
      failReadyWait(error, 'load_failed');
      return;
    }
    // After ready nothing waits on the worker's start, so the host would never hear of it.
    captureException(error, { flow: 'protocol', step: 'shared_worker_error' });
  });

  // Before the ready wait, so a frame removed while the worker syncs still frees its port at once.
  disposeOnPageHide(deps.window, transport, new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
  // Before the ready wait too, since the worker lets go of a silent port while it syncs as well.
  answerBeats(transport);

  // Why the wait failed, for the metric. A timeout carries none.
  let reason: string | undefined;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<ConsumerTransport>((resolve, reject) => {
    resolveReady = () => {
      failReadyWait = null;
      resolve(transport);
    };
    failReadyWait = (error, why) => {
      failReadyWait = null;
      reason = why;
      reject(error);
    };
  });
  // One subscription serves the ready wait and the caller alike, since a dead worker may close once this tab first
  // heard why, and would never answer a second.
  const status = transport.subscribe('frameStatus', undefined, () => {
    resolveReady();
  });

  // Before the ready wait hears the end, so a worker that fails while it syncs ends the caller's calls first, and the
  // frame fails with the worker's own error rather than the failed boot that follows from it.
  deps.onOpen?.(transport, status);
  status.onEnd(error => {
    failReadyWait?.(error ?? new Error(PROTOCOL_APP_ERRORS.WORKER_STATUS_ENDED), 'worker_reported');
  });

  let timedOut: Error | undefined;
  const record = (outcome: 'ok' | 'error' | 'timeout'): number => {
    failReadyWait = null;
    const waitMs = performance.now() - startedAt;
    m.distribution(S.PROTOCOL_SW_READY, waitMs, 'millisecond', {
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    });
    return waitMs;
  };
  // Armed before the handshake starts, so on a tie the ready wait's own timeout is the one heard.
  const waited = withTimeout(
    ready,
    readyTimeoutMs,
    () => {
      timedOut = new Error(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT);
      return timedOut;
    },
    timers,
  ).then(
    readyTransport => {
      m.measure(S.PROTOCOL_SW_READY, record('ok'));
      return readyTransport;
    },
    (error: unknown) => {
      record(error === timedOut ? 'timeout' : 'error');
      throw error;
    },
  );
  transport.connect();
  return waited;
}

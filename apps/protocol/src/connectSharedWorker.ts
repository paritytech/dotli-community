// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: a transport on the worker's port that waits until the worker is
// ready, answers the worker's beats so it keeps the port, and lets go of the port when the tab leaves.

import { createReporter, defineCount, m } from '@dotli/metrics';
import { getFailure, ProtocolInitFailedError, protocolSchema, type ProtocolTransport } from '@dotli/protocol';
import { createDeferred, getErrorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { createPortProvider, createTransport, type TransportIssue } from '@dotli/transport';

import { disposeOnPageHide } from './disposeOnPageHide.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { FRAME_LOG_TAG } from './frameLogTag.js';
import { getWorkerEndError, watchWorkerStatus, type WorkerStatus } from './watchWorkerStatus.js';

const report = createReporter({ flow: 'protocol' });

/** From SharedWorker creation to its ready signal. */
const PROTOCOL_SW_READY = 'protocol.sw_ready';

/**
 * An error event the protocol SharedWorker fired after it was ready. Tagged `outcome` (error) and `reason` (the error's
 * name).
 */
const protocolSharedWorkerErrorMetric = defineCount<'error'>('protocol.shared_worker_error');

/**
 * A heartbeat the protocol frame could not send the SharedWorker, so it stops answering the worker's beats and the
 * worker lets go of its port. Tagged `outcome` (error) and `reason` (the error's name).
 */
const protocolWorkerHeartbeatMetric = defineCount<'error'>('protocol.worker_heartbeat');

/** How a failed wait ended, as the ready wait's metric tags it. */
type WaitFailure = { readonly outcome: 'timeout' } | { readonly outcome: 'error'; readonly reason: string };

/** Where the link's wait for the worker stands. */
type Wait =
  | { readonly name: 'waiting' }
  | { readonly name: 'ready' }
  | { readonly name: 'failed'; readonly failure: WaitFailure };

type Params = {
  /** The protocol SharedWorker, whose port the link speaks on. */
  worker: Pick<SharedWorker, 'port' | 'addEventListener' | 'removeEventListener'>;
  /** The iframe's page, whose `pagehide` lets go of the worker. */
  page: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The page load this tab names in its hello. */
  resolutionId: string | null;
  /** How long the worker has to say it is ready. */
  readyTimeoutMs: number;
  /** The timers the handshake and the ready wait run on. Defaults to the page's own. */
  timers?: Timers;
  /** The monotonic clock the ready wait is timed on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
  /** Hears what the link's transport cannot handle itself. Logged by the transport when unset. */
  onIssue?: (issue: TransportIssue) => void;
};

/** A tab's link to the worker, handed over before the worker is ready so what it reports while it syncs is heard. */
export type SharedWorkerLink = ReturnType<typeof connectSharedWorker>;

/** Links this tab to the worker and starts the handshake. A worker that never gets ready is heard on `ready`. */
export function connectSharedWorker({
  worker,
  page,
  resolutionId,
  readyTimeoutMs,
  timers = realTimers,
  now = () => performance.now(),
  onIssue,
}: Params) {
  const startedAt = now();
  // A port delivers every message, so one handshake is enough. The ready wait is its one deadline, so a worker that
  // never answers counts as a ready timeout, and one whose script loads slowly fails no sooner than one that never
  // synced.
  const transport = createTransport({
    schema: protocolSchema,
    provider: createPortProvider({ port: worker.port }),
    handshake: 'offer',
    hello: { resolutionId },
    timers,
    retryMs: readyTimeoutMs,
    timeoutMs: null,
    onIssue,
  });
  const ready = createDeferred<undefined>();
  // Only a transition from waiting moves it, so the first to settle the wait wins.
  let wait: Wait = { name: 'waiting' };

  worker.addEventListener('error', onWorkerError);

  const waited = withTimeout({
    work: ready.promise,
    ms: readyTimeoutMs,
    timeoutError() {
      if (wait.name === 'waiting') {
        wait = { name: 'failed', failure: { outcome: 'timeout' } };
      }
      return new ProtocolInitFailedError(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT);
    },
    timers,
  }).then(
    () => {
      m.measure(PROTOCOL_SW_READY, recordReadyWait({ outcome: 'ok' }));
    },
    (error: unknown) => {
      // Only a transition from waiting rejects the wait, so it has failed here.
      recordReadyWait(wait.name === 'failed' ? wait.failure : { outcome: 'error' });
      // A link whose wait failed serves nothing more, so its status subscription, its beats and every listener on
      // them go. Whoever was handed the status hears the same error, with its class kept.
      transport.dispose(toError(error));
      throw error;
    },
  );
  // Bound at once, not once ready, so a frame removed while the worker syncs still closes its port at once. The
  // transport posts nothing as it closes, so the closed port alone says the tab left.
  const stopPageHide = disposeOnPageHide({
    target: page,
    dispose: () => {
      transport.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
    },
  });

  // One subscription serves the ready wait and the caller alike, since a second one may never be answered. It is the
  // link's first call, so it starts the handshake.
  const status = watchWorkerStatus({
    transport,
    onReady() {
      if (wait.name !== 'waiting') {
        return;
      }
      wait = { name: 'ready' };
      ready.resolve(undefined);
    },
  });
  // At once too, since beats arrive while the worker syncs as well.
  const stopAnsweringBeats = answerBeats(transport, status);

  status.onEnd(end => {
    failReadyWait(getWorkerEndError(end), 'worker_reported');
  });

  return {
    /** The link's transport, on the worker's port. */
    transport,
    /** The one status subscription to the worker. */
    status,
    /** Resolves once the worker says it is ready, and rejects with why it never will be. */
    ready: waited,
    /**
     * Lets go of the worker as a page hidden for good does, safe to call twice and after the link failed. Every open
     * request and the status hear the port closed, and so does a ready wait still open.
     */
    dispose(): void {
      // The transport goes first, since its close is what ends the status, and an unsubscribe tells no listener.
      transport.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
      status.dispose();
      stopAnsweringBeats();
      worker.removeEventListener('error', onWorkerError);
      stopPageHide();
    },
  };

  /** Fires only when the worker script cannot be fetched or evaluated. */
  function onWorkerError(event: Event): void {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new ProtocolInitFailedError(`SharedWorker failed to start${detail}`);
    log.error(`${FRAME_LOG_TAG} SharedWorker error event`, error);
    switch (wait.name) {
      case 'waiting':
        // Fails now with the cause instead of at the ready timeout. The failure leaves as the ready wait's rejection.
        failReadyWait(error, 'load_failed');
        return;
      case 'ready':
        // After ready nothing waits on the worker's start, so the host would never hear of it.
        report.capture(error, { step: 'shared_worker_error' });
        protocolSharedWorkerErrorMetric.count({ outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
        return;
      case 'failed':
        // The wait already failed with its own error and was counted, so its late cause is only logged.
        return;
    }
  }

  function failReadyWait(error: Error, reason: string): void {
    if (wait.name !== 'waiting') {
      return;
    }
    wait = { name: 'failed', failure: { outcome: 'error', reason } };
    ready.reject(error);
  }

  /** Records how long the wait took and how it ended, and returns that time. */
  function recordReadyWait(attributes: WaitFailure | { readonly outcome: 'ok' | 'error' }): number {
    const waitMs = now() - startedAt;
    m.distribution(PROTOCOL_SW_READY, waitMs, { unit: 'millisecond', attributes });
    return waitMs;
  }
}

/**
 * Answers each of the worker's beats with a heartbeat until the worker's status ends, since a worker that stopped
 * serving this tab has nothing left to keep, and returns the stop that ends it, safe to call twice. The beat arrives
 * as a message event, which a page hidden for long still handles at once, while its own timers are throttled to about
 * one a minute.
 */
function answerBeats(transport: ProtocolTransport, status: WorkerStatus): () => void {
  let answering = true;
  const unsubscribeBeats = transport.subscribe({
    method: protocolSchema.sections.frame.beat,
    start: undefined,
    listeners: {
      receive: () => {
        void transport.request(protocolSchema.sections.frame.heartbeat, undefined).then(
          outcome => {
            if (!outcome.success) {
              failHeartbeat(getFailure(protocolSchema.sections.frame.heartbeat, outcome.value));
            }
          },
          (error: unknown) => {
            failHeartbeat(toError(error));
          },
        );
      },
      interrupt: () => {
        answering = false;
      },
      fail: () => {
        answering = false;
      },
      close: () => {
        answering = false;
      },
    },
  });
  const stopHearingEnd = status.onEnd(stopAnswering);
  return stop;

  function stop(): void {
    stopHearingEnd();
    stopAnswering();
  }

  function stopAnswering(): void {
    answering = false;
    unsubscribeBeats();
  }

  function failHeartbeat(error: Error): void {
    // A link that ended has already said why through its status, and its pending heartbeats fail with the same.
    if (!answering) {
      return;
    }
    stopAnswering();
    report.defect(error, {
      step: 'worker_heartbeat',
      metric: protocolWorkerHeartbeatMetric,
      message: `${FRAME_LOG_TAG} Worker heartbeat failed`,
    });
  }
}

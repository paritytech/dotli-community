// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: a transport on the worker's port that waits until the worker is
// ready, answers the worker's beats so it keeps the port, and lets go of the port when the tab leaves.

import { captureException, m, reportDefect, spans as S } from '@dotli/metrics';
import { getFailure, ProtocolInitFailedError, protocolSchema, type ProtocolTransport } from '@dotli/protocol';
import { createDeferred, getErrorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { createPortProvider, createTransport, type TransportIssue } from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';
import { FRAME_LOG_TAG } from './frameLogTag.js';
import { getWorkerEndError, watchWorkerStatus, type WorkerStatus } from './watchWorkerStatus.js';

type Params = {
  /** The protocol SharedWorker, whose port the link speaks on. */
  worker: Pick<SharedWorker, 'port' | 'addEventListener'>;
  /** The iframe's page, whose `pagehide` lets go of the worker. */
  page: Pick<Window, 'addEventListener'>;
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

type DisposeOnPageHideParams = {
  /** The page whose `pagehide` disposes the transport. */
  target: Pick<Window, 'addEventListener'>;
  /** The link's transport. */
  transport: { dispose: (reason: Error) => void };
  /** What the transport is disposed with. */
  reason: Error;
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
  // Why the wait failed, for the metric. A timeout carries none.
  let reason: string | undefined;
  const ready = createDeferred<undefined>();
  // Until the wait settles, so what is heard after it changes nothing.
  let waiting = true;
  let timedOut: Error | undefined;

  // Fires only when the worker script cannot be fetched or evaluated.
  worker.addEventListener('error', event => {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new ProtocolInitFailedError(`SharedWorker failed to start${detail}`);
    log.error(`${FRAME_LOG_TAG} SharedWorker error event`, error);
    if (waiting) {
      // Fails now with the cause instead of at the ready timeout. The failure leaves as the ready wait's rejection.
      failReadyWait(error, 'load_failed');
      return;
    }
    // After ready nothing waits on the worker's start, so the host would never hear of it.
    captureException(error, { flow: 'protocol', step: 'shared_worker_error' });
    m.count(S.PROTOCOL_SHARED_WORKER_ERROR, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
  });

  const waited = withTimeout({
    work: ready.promise,
    ms: readyTimeoutMs,
    timeoutError() {
      timedOut = new ProtocolInitFailedError(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT);
      return timedOut;
    },
    timers,
  }).then(
    () => {
      m.measure(S.PROTOCOL_SW_READY, recordReadyWait('ok'));
    },
    (error: unknown) => {
      recordReadyWait(error === timedOut ? 'timeout' : 'error');
      // A link whose wait failed serves nothing more, so its status subscription, its beats and every listener on
      // them go. Whoever was handed the status hears the same error, with its class kept.
      transport.dispose(toError(error));
      throw error;
    },
  );
  // Bound at once, not once ready, so a frame removed while the worker syncs still closes its port at once.
  disposeOnPageHide({ target: page, transport, reason: new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED) });

  // One subscription serves the ready wait and the caller alike, since a second one may never be answered. It is the
  // link's first call, so it starts the handshake.
  const status = watchWorkerStatus({
    transport,
    onReady() {
      waiting = false;
      ready.resolve(undefined);
    },
  });
  // At once too, since beats arrive while the worker syncs as well.
  answerBeats(transport, status);

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
  };

  function failReadyWait(error: Error, why: string): void {
    if (waiting) {
      waiting = false;
      reason = why;
      ready.reject(error);
    }
  }

  /** Ends the wait and records how long it took and how it went, and returns that time. */
  function recordReadyWait(outcome: 'ok' | 'error' | 'timeout'): number {
    waiting = false;
    const waitMs = now() - startedAt;
    m.distribution(S.PROTOCOL_SW_READY, waitMs, {
      unit: 'millisecond',
      attributes: { outcome, ...(reason !== undefined ? { reason } : {}) },
    });
    return waitMs;
  }
}

/**
 * Answers each of the worker's beats with a heartbeat until the worker's status ends, since a worker that stopped
 * serving this tab has nothing left to keep. The beat arrives as a message event, which a page hidden for long still
 * handles at once, while its own timers are throttled to about one a minute.
 */
function answerBeats(transport: ProtocolTransport, status: WorkerStatus): void {
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
  status.onEnd(stopAnswering);

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
    reportDefect(error, {
      flow: 'protocol',
      step: 'worker_heartbeat',
      metric: S.PROTOCOL_WORKER_HEARTBEAT,
      message: `${FRAME_LOG_TAG} Worker heartbeat failed`,
    });
  }
}

/**
 * Disposes the iframe's worker transport once its page is hidden for good, which closes its port. The transport posts
 * nothing as it closes, so the closed port alone says the tab left. `pagehide` and not `beforeunload`, because a
 * removed frame fires only the former. A page kept in the back-forward cache may come back, so it keeps its transport.
 */
function disposeOnPageHide({ target, transport, reason }: DisposeOnPageHideParams): void {
  target.addEventListener('pagehide', event => {
    if (!event.persisted) {
      transport.dispose(reason);
    }
  });
}

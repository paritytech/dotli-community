// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: a transport on the worker's port that waits until the worker is
// ready, answers the worker's beats so it keeps the port, and lets go of the port when the tab leaves.

import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import {
  failureOf,
  type FrameFailure,
  fromTransportError,
  ProtocolInitFailedError,
  protocolSchema,
  type ProtocolTransport,
} from '@dotli/protocol';
import { errorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import {
  createPortProvider,
  createTransport,
  type CallError,
  type ResultPayload,
  type TransportIssue,
} from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';
import { disposeOnPageHide } from './worker-port.js';

/**
 * How the worker's status ended for this tab: the worker's own end, which a relay passes on as it is, or the link's
 * transport closing under it.
 */
export type WorkerEnd =
  { kind: 'interrupt'; outcome: ResultPayload<undefined, CallError<FrameFailure>> } | { kind: 'close'; error: Error };

/** The one `frame.status` subscription to the worker. */
export interface WorkerStatus {
  /** Hears its one end. Called at once if it has ended. */
  onEnd(listener: (end: WorkerEnd) => void): void;
}

/**
 * What a worker's end means for this tab, as an error under the name the worker's failure has. A link that closed on
 * the transport's own error, such as a version mismatch, ends under the protocol's class, as the host's link does.
 */
export function workerEndError(end: WorkerEnd): Error {
  if (end.kind === 'close') {
    return fromTransportError(end.error);
  }
  return end.outcome.success
    ? new Error(PROTOCOL_APP_ERRORS.WORKER_STATUS_ENDED)
    : failureOf(protocolSchema.traits.frame.status, end.outcome.value);
}

export interface SharedWorkerLinkDeps {
  worker: Pick<SharedWorker, 'port' | 'addEventListener'>;
  /** The iframe's page, whose `pagehide` lets go of the worker. */
  window: Pick<EventTarget, 'addEventListener'>;
  /** The page load, which labels the worker's spans for this tab. */
  resolutionId: string | null;
  readyTimeoutMs: number;
  timers?: Timers;
  /** Hears what the link's transport cannot handle itself. Logged by the transport when unset. */
  onIssue?: (issue: TransportIssue) => void;
  /**
   * Hands over the transport and the worker's status before the ready wait, so what the worker reports while it syncs
   * reaches the host live, and a worker that fails while it syncs ends the frame with its own end.
   */
  onOpen?: (transport: ProtocolTransport, status: WorkerStatus) => void;
}

/**
 * Subscribes to the worker's status once, and tells each listener its end. `onReady` hears the worker say it is
 * ready.
 */
export function watchWorkerStatus(transport: ProtocolTransport, onReady: () => void): WorkerStatus {
  const report = reportListener('protocol', 'protocol.worker_status');
  const listeners: ((end: WorkerEnd) => void)[] = [];
  let ended: WorkerEnd | null = null;
  const tell = (listener: (end: WorkerEnd) => void, end: WorkerEnd): void => {
    try {
      listener(end);
    } catch (error) {
      report(error);
    }
  };
  const finish = (end: WorkerEnd): void => {
    if (ended !== null) {
      return;
    }
    ended = end;
    for (const listener of listeners.splice(0)) {
      tell(listener, end);
    }
  };
  const handle = transport.subscribe(protocolSchema.traits.frame.status, undefined, {
    receive: onReady,
    interrupt: outcome => {
      finish({ kind: 'interrupt', outcome });
    },
  });
  handle.onClose(error => {
    finish({ kind: 'close', error });
  });
  return {
    onEnd(listener) {
      if (ended === null) {
        listeners.push(listener);
      } else {
        tell(listener, ended);
      }
    },
  };
}

/**
 * Answers each of the worker's beats with a heartbeat until the worker's status ends, since a worker that stopped
 * serving this tab has nothing left to keep. The beat arrives as a message event, which a page hidden for long still
 * handles at once, while its own timers are throttled to about one a minute.
 */
function answerBeats(transport: ProtocolTransport, status: WorkerStatus): void {
  let answering = true;
  const stop = (): void => {
    answering = false;
    beats.stop();
  };
  const failed = (error: Error): void => {
    // A link that ended has already said why through its status, and its pending heartbeats fail with the same.
    if (!answering) {
      return;
    }
    stop();
    captureException(error, { flow: 'protocol', step: 'worker_heartbeat' });
    log.error('[dot.li protocol] Worker heartbeat failed', error);
    m.count(S.PROTOCOL_WORKER_HEARTBEAT, { outcome: 'error', reason: errorName(error) ?? 'unknown' });
  };
  const beats = transport.subscribe(protocolSchema.traits.frame.beat, undefined, {
    receive: () => {
      void transport.request(protocolSchema.traits.frame.heartbeat, undefined).then(
        outcome => {
          if (!outcome.success) {
            failed(failureOf(protocolSchema.traits.frame.heartbeat, outcome.value));
          }
        },
        (error: unknown) => {
          failed(toError(error));
        },
      );
    },
    interrupt: () => {
      answering = false;
    },
  });
  beats.onClose(() => {
    answering = false;
  });
  status.onEnd(stop);
}

/** Resolves with the transport to the worker once the worker says it is ready, and rejects with why it never will be. */
export function connectSharedWorker(deps: SharedWorkerLinkDeps): Promise<ProtocolTransport> {
  const { worker, readyTimeoutMs } = deps;
  const timers = deps.timers ?? realTimers;
  const startedAt = performance.now();
  // A port delivers every message, so one handshake is enough. It has the ready wait's budget, so a worker whose script
  // loads slowly fails no sooner than one that loaded and never synced.
  const transport = createTransport(protocolSchema, createPortProvider(worker.port), {
    handshake: 'open',
    hello: { resolutionId: deps.resolutionId },
    timers,
    retryMs: readyTimeoutMs,
    timeoutMs: readyTimeoutMs,
    ...(deps.onIssue === undefined ? {} : { onIssue: deps.onIssue }),
  });
  let failReadyWait: ((error: Error, why: string) => void) | null = null;

  // Fires only when the worker script cannot be fetched or evaluated.
  worker.addEventListener('error', event => {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new ProtocolInitFailedError(`SharedWorker failed to start${detail}`);
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

  // Why the wait failed, for the metric. A timeout carries none.
  let reason: string | undefined;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<ProtocolTransport>((resolve, reject) => {
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
  const status = watchWorkerStatus(transport, () => {
    resolveReady();
  });
  // Before the ready wait too, since the worker lets go of a silent port while it syncs as well.
  answerBeats(transport, status);

  // Before the ready wait hears the end, so a worker that fails while it syncs ends the caller's calls first, and the
  // frame fails with the worker's own end rather than the failed boot that follows from it.
  deps.onOpen?.(transport, status);
  status.onEnd(end => {
    failReadyWait?.(workerEndError(end), 'worker_reported');
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
      timedOut = new ProtocolInitFailedError(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT);
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
      // Nothing uses a link whose wait failed, so its status subscription, its beats and every listener on them go.
      // Whoever was handed the status hears the same error, which keeps its class for the host.
      transport.dispose(toError(error));
      throw error;
    },
  );
  transport.connect();
  return waited;
}

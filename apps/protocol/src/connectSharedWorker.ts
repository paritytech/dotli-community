// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's link to the protocol SharedWorker: a transport on the worker's port that waits until the worker is
// ready, answers the worker's beats so it keeps the port, and lets go of the port when the tab leaves.

import { createReporter, defineCount, m } from '@dotli/metrics';
import { getFailure, ProtocolInitFailedError, protocolSchema } from '@dotli/protocol';
import {
  createDeferred,
  createStateMachine,
  getErrorName,
  log,
  nest,
  realTimers,
  toError,
  withTimeout,
  type MachineTypes,
  type Timers,
} from '@dotli/shared';
import { createPortProvider, createTransport, type TransportIssue } from '@dotli/transport';

import { disposeOnPageHide } from './disposeOnPageHide.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { FRAME_LOG_TAG } from './frameLogTag.js';
import { getWorkerEndError, watchWorkerStatus } from './watchWorkerStatus.js';

const report = createReporter({ flow: 'protocol' });
const workerLinkTransitionMetric = defineCount<'error'>('protocol.worker_link.transition');

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

/** Where the link's wait for the worker stands. Only `waiting` moves, so the first to settle the wait wins. */
type Wait = { kind: 'waiting' } | { kind: 'ready' } | { kind: 'failed'; failure: WaitFailure; error: Error };

/**
 * Whether the tab answers the worker's beats. A beat arrives as a message event, which a page hidden for long still
 * handles at once, while its own timers are throttled to about one a minute.
 */
type Beats = { kind: 'answering'; unsubscribe: () => void } | { kind: 'stopped' };

type LinkState = { kind: 'linked'; wait: Wait; beats: Beats } | { kind: 'letGo'; wait: Wait };

type LinkEvent =
  | { kind: 'workerReady' }
  | { kind: 'readyFailed'; failure: WaitFailure; error: Error }
  | { kind: 'workerErrored'; error: Error }
  | { kind: 'beatHeard' }
  | { kind: 'heartbeatFailed'; error: Error }
  | { kind: 'beatsEnded' }
  | { kind: 'letGo' };

type LinkEffect =
  | { kind: 'readyWaitEnded'; outcome: WaitFailure | { readonly outcome: 'ok' } }
  | { kind: 'workerErrored'; error: Error }
  | { kind: 'workerFailedAfterReady'; error: Error }
  | { kind: 'heartbeatFailed'; error: Error }
  | { kind: 'transportDisposed' }
  | { kind: 'statusDisposed' }
  | { kind: 'beatsUnsubscribed'; unsubscribe: () => void }
  | { kind: 'workerListenerRemoved' }
  | { kind: 'pageHideStopped' };

type LinkMachine = MachineTypes<LinkState, LinkEvent, LinkEffect>;

type WaitMachine = MachineTypes<Wait, LinkEvent, LinkEffect>;

type BeatsMachine = MachineTypes<Beats, LinkEvent, LinkEffect>;

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
  // The worker's first answer to the ready wait, its ready signal or its end.
  const answer = createDeferred<LinkEvent>();

  // The listeners below send to the machine built after them. None fires while the link is built.
  worker.addEventListener('error', onWorkerError);
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
      answer.resolve({ kind: 'workerReady' });
    },
  });
  // At once too, since beats arrive while the worker syncs as well.
  const unsubscribeBeats = transport.subscribe({
    method: protocolSchema.sections.frame.beat,
    start: undefined,
    listeners: {
      receive: () => {
        machine.update({ kind: 'beatHeard' });
      },
      interrupt: () => {
        machine.update({ kind: 'beatsEnded' });
      },
      fail: () => {
        machine.update({ kind: 'beatsEnded' });
      },
      close: () => {
        machine.update({ kind: 'beatsEnded' });
      },
    },
  });
  status.onEnd(end => {
    answer.resolve({
      kind: 'readyFailed',
      failure: { outcome: 'error', reason: 'worker_reported' },
      error: getWorkerEndError(end),
    });
    // A worker that stopped serving this tab has nothing left to keep.
    machine.update({ kind: 'beatsEnded' });
  });

  const handleWait = nest<
    LinkMachine,
    'linked' | 'letGo',
    WaitMachine,
    'workerReady' | 'readyFailed' | 'workerErrored'
  >({
    find: ({ wait }) => wait,
    store: (state, _event, wait) => ({ ...state, wait }),
    handlers: {
      waiting: {
        workerReady(_wait, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ready' });
          emitSideEffect({ kind: 'readyWaitEnded', outcome: { outcome: 'ok' } });
        },
        readyFailed(_wait, { failure, error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'failed', failure, error });
          emitSideEffect({ kind: 'readyWaitEnded', outcome: failure });
          // A link whose wait failed serves nothing more, so its status subscription, its beats and every listener
          // on them go. Whoever was handed the status hears the same error, with its class kept.
          transport.dispose(error);
        },
        workerErrored(_wait, { error }, { emitState, emitSideEffect }) {
          // Fails now with the cause instead of at the ready timeout.
          const failure = { outcome: 'error', reason: 'load_failed' } as const;
          emitState({ kind: 'failed', failure, error });
          emitSideEffect({ kind: 'workerErrored', error });
          emitSideEffect({ kind: 'readyWaitEnded', outcome: failure });
          transport.dispose(error);
        },
      },
      ready: {
        workerErrored(_wait, { error }, { emitSideEffect }) {
          // After ready nothing waits on the worker's start, so the host would never hear of it.
          emitSideEffect({ kind: 'workerErrored', error });
          emitSideEffect({ kind: 'workerFailedAfterReady', error });
        },
      },
      failed: {
        workerErrored(_wait, { error }, { emitSideEffect }) {
          // The wait already failed with its own error and was counted, so its late cause is only logged.
          emitSideEffect({ kind: 'workerErrored', error });
        },
      },
    },
  });
  const handleBeats = nest<LinkMachine, 'linked', BeatsMachine, 'beatHeard' | 'heartbeatFailed' | 'beatsEnded'>({
    find: ({ beats }) => beats,
    store: (state, _event, beats) => ({ ...state, beats }),
    handlers: {
      answering: {
        beatHeard(_beats, _event, { update }) {
          // Heard from a callback, not as an update's work, so neither `await()` nor `ready` waits on a heartbeat.
          void transport.request(protocolSchema.sections.frame.heartbeat, undefined).then(
            outcome => {
              if (!outcome.success) {
                update({
                  kind: 'heartbeatFailed',
                  error: getFailure(protocolSchema.sections.frame.heartbeat, outcome.value),
                });
              }
            },
            (error: unknown) => {
              update({ kind: 'heartbeatFailed', error: toError(error) });
            },
          );
        },
        heartbeatFailed({ unsubscribe }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'stopped' });
          emitSideEffect({ kind: 'heartbeatFailed', error });
          unsubscribe();
        },
        beatsEnded({ unsubscribe }, _event, { emitState }) {
          emitState({ kind: 'stopped' });
          unsubscribe();
        },
      },
      // A link that ended has already said why through its status, and its pending heartbeats fail with the same.
      stopped: null,
    },
  });
  const machine = createStateMachine<LinkMachine>({
    initial: {
      kind: 'linked',
      wait: { kind: 'waiting' },
      beats: { kind: 'answering', unsubscribe: unsubscribeBeats },
    },
    handlers: {
      linked: {
        workerReady: handleWait,
        readyFailed: handleWait,
        workerErrored: handleWait,
        beatHeard: handleBeats,
        heartbeatFailed: handleBeats,
        beatsEnded: handleBeats,
        letGo({ wait, beats }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'letGo', wait });
          // One effect per call-out, so a throw skips none of the rest. The transport goes first, since its close is
          // what ends the status, and an unsubscribe tells no listener.
          emitSideEffect({ kind: 'transportDisposed' });
          emitSideEffect({ kind: 'statusDisposed' });
          switch (beats.kind) {
            case 'answering':
              emitSideEffect({ kind: 'beatsUnsubscribed', unsubscribe: beats.unsubscribe });
              break;
            case 'stopped':
              break;
          }
          emitSideEffect({ kind: 'workerListenerRemoved' });
          emitSideEffect({ kind: 'pageHideStopped' });
        },
      },
      letGo: {
        workerReady: handleWait,
        readyFailed: handleWait,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'readyWaitEnded': {
          const waitMs = now() - startedAt;
          m.distribution(PROTOCOL_SW_READY, waitMs, { unit: 'millisecond', attributes: effect.outcome });
          if (effect.outcome.outcome === 'ok') {
            m.measure(PROTOCOL_SW_READY, waitMs);
          }
          break;
        }
        case 'workerErrored':
          log.error(`${FRAME_LOG_TAG} SharedWorker error event`, effect.error);
          break;
        case 'workerFailedAfterReady':
          report.capture(effect.error, { step: 'shared_worker_error' });
          protocolSharedWorkerErrorMetric.count({ outcome: 'error', reason: getErrorName(effect.error) ?? 'unknown' });
          break;
        case 'heartbeatFailed':
          report.defect(effect.error, {
            step: 'worker_heartbeat',
            metric: protocolWorkerHeartbeatMetric,
            message: `${FRAME_LOG_TAG} Worker heartbeat failed`,
          });
          break;
        case 'transportDisposed':
          transport.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
          break;
        case 'statusDisposed':
          status.dispose();
          break;
        case 'beatsUnsubscribed':
          effect.unsubscribe();
          break;
        case 'workerListenerRemoved':
          worker.removeEventListener('error', onWorkerError);
          break;
        case 'pageHideStopped':
          stopPageHide();
          break;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: workerLinkTransitionMetric,
        message: `${FRAME_LOG_TAG} A transition of the shared worker link failed:`,
      });
    },
  });

  // The answer's deadline is inside `await()`, since the answer within it settles by itself.
  machine.update(
    withTimeout({
      work: answer.promise,
      ms: readyTimeoutMs,
      timeoutError: () => new ProtocolInitFailedError(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT),
      timers,
    }).catch((error: unknown): LinkEvent => ({
      kind: 'readyFailed',
      failure: { outcome: 'timeout' },
      error: toError(error),
    })),
  );
  const ready = machine.await().then(() => {
    const { wait } = machine.state.get();
    switch (wait.kind) {
      case 'ready':
        return;
      case 'failed':
        throw wait.error;
      case 'waiting':
        throw new Error('connectSharedWorker: the ready wait settled with no answer');
    }
  });

  return {
    /** The link's transport, on the worker's port. */
    transport,
    /** The one status subscription to the worker. */
    status,
    /** Resolves once the worker says it is ready, and rejects with why it never will be. */
    ready,
    /**
     * Lets go of the worker as a page hidden for good does, safe to call twice and after the link failed. Every open
     * request and the status hear the port closed, and so does a ready wait still open.
     */
    dispose(): void {
      machine.update({ kind: 'letGo' });
    },
  };

  /** Fires only when the worker script cannot be fetched or evaluated. */
  function onWorkerError(event: Event): void {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    machine.update({
      kind: 'workerErrored',
      error: new ProtocolInitFailedError(`SharedWorker failed to start${detail}`),
    });
  }
}

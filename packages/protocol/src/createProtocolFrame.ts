// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The hidden protocol iframe: it boots on demand, publishes where it stands, rebuilds itself when it is lost, and hands
// the layers above the transport to the frame there is now. Each iframe gets its own provider and transport, so a
// message from a dropped iframe reaches only that iframe's disposed provider.

import { atom, type WritableAtom } from 'nanostores';
import { countMetric, createReporter, defineCount, m } from '@dotli/metrics';
import {
  createListenerSet,
  createStateMachine,
  nest,
  noop,
  realTimers,
  setErrorName,
  startActiveTimeout,
  toError,
  withTimeout,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { createTransport, createWindowProvider } from '@dotli/transport';
import { createFrameIframe } from './createFrameIframe.js';
import { createWireReport } from './createWireReport.js';
import {
  PROTOCOL_ERRORS,
  ProtocolInitFailedError,
  ProtocolVersionMismatchError,
  fromTransportError,
} from './errors.js';
import type {
  FrameElement,
  ProtocolFrame,
  ProtocolFrameConfig,
  ProtocolFrameParams,
  ProtocolFrameTimeouts,
  ProtocolStatus,
} from './frameTypes.js';
import { protocolIframeReadyMetric, reportBootFailure, type BootPhase } from './reportBootFailure.js';
import { isFrameReleased, reportFrameLost } from './reportFrameLost.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscribe.js';

const report = createReporter({ flow: 'protocol' });

/** A protocol frame transition that threw. Tagged `outcome` (error) and `reason` (the error's name). */
const frameTransitionMetric = defineCount<'error'>('protocol.frame_transition');

/** A caller's wait for a transport. */
type Wait = { resolve: (transport: ProtocolTransport) => void; reject: (error: Error) => void };

/** A caller's ask for the ready frame's transport, or for the transport of the frame there is now. */
type Ask = { kind: 'readyAsked'; wait: Wait } | { kind: 'transportAsked'; wait: Wait };

/** An iframe, and the transport to it once it loaded. */
type Mounted<E> = { iframe: E; transport: ProtocolTransport | null };

/** A frame whose iframe loaded, with its transport and its liveness check. */
type Frame<E> = { iframe: E; transport: ProtocolTransport; check: Check };

/** A frame's liveness check. A check asked while one is in flight joins it. */
type Check = { kind: 'idle' } | { kind: 'asking' };

/**
 * The frames lost since one stayed ready for `stableMs`. `failures` counts them, and the rebuild waits grow with it.
 * `captured` is set once a loss among them was captured, so a frame that keeps dying soon after ready is counted every
 * time but captured once.
 */
type Incident = { failures: number; captured: boolean };

/**
 * Where the frame stands. `held` is a frame whose light client failed to start, kept to answer the shared store until a
 * new frame listens.
 */
type FrameState<E> =
  // Each ask made before the first config comes with the stop of the wait that fails it when no config comes.
  | { kind: 'unconfigured'; waits: readonly (Ask & { stopTimer: () => void })[] }
  | { kind: 'idle'; config: ProtocolFrameConfig; incident: Incident }
  | { kind: 'resetting'; config: ProtocolFrameConfig; incident: Incident }
  | {
      kind: 'loading';
      config: ProtocolFrameConfig;
      iframe: E;
      stopTimer: () => void;
      loads: readonly Wait[];
      readies: readonly Wait[];
      held: Frame<E> | null;
      incident: Incident;
    }
  | {
      kind: 'connecting';
      config: ProtocolFrameConfig;
      frame: Frame<E>;
      readies: readonly Wait[];
      held: Frame<E> | null;
      incident: Incident;
    }
  | {
      kind: 'listening';
      config: ProtocolFrameConfig;
      frame: Frame<E>;
      stopTimer: () => void;
      listenedAt: number;
      readies: readonly Wait[];
      incident: Incident;
    }
  | { kind: 'ready'; config: ProtocolFrameConfig; frame: Frame<E>; readyAt: number; incident: Incident }
  | {
      kind: 'failed';
      config: ProtocolFrameConfig;
      error: Error;
      stopTimer: () => void;
      held: Frame<E> | null;
      incident: Incident;
    }
  | { kind: 'mismatched'; error: ProtocolVersionMismatchError };

/**
 * What moves the frame. A timer's event carries nothing, or only the wait it ends, since every move to another kind stops it. A listener's or a
 * promise's event carries the iframe or the transport it belongs to, and acts only while the state holds that one.
 */
type FrameEvent<E> =
  | Ask
  | { kind: 'configured'; config: ProtocolFrameConfig }
  | { kind: 'configureTimedOut'; wait: Wait }
  | { kind: 'rebuildAsked' }
  | { kind: 'rebuildDue' }
  | { kind: 'loadTimedOut' }
  | { kind: 'readyTimedOut' }
  | { kind: 'iframeLoaded'; iframe: E }
  | { kind: 'handshakeDone'; iframe: E }
  | { kind: 'frameReadied'; iframe: E }
  | { kind: 'frameFailed'; iframe: E; thrown: unknown }
  | { kind: 'aliveAsked'; transport: ProtocolTransport }
  | { kind: 'heartbeatAnswered'; transport: ProtocolTransport }
  | { kind: 'heartbeatFailed'; transport: ProtocolTransport; error: Error }
  | { kind: 'frameUnresponsive'; transport: ProtocolTransport; error: Error };

type FrameEffect<E> =
  | { kind: 'publish'; status: ProtocolStatus; held: boolean }
  | { kind: 'resolve'; waits: readonly Wait[]; transport: ProtocolTransport }
  | { kind: 'reject'; waits: readonly Wait[]; error: Error }
  | { kind: 'stopTimer'; stopTimer: () => void }
  | { kind: 'mount'; iframe: E }
  | { kind: 'connect'; iframe: E; transport: ProtocolTransport }
  | { kind: 'askAlive'; transport: ProtocolTransport }
  | { kind: 'rebuild' }
  /** Lets `frame` go once the transition's reports ran, its calls in flight rejecting with `reason`. */
  | { kind: 'drop'; frame: Mounted<E> | null; reason: Error }
  | ({ kind: 'bootFailed'; phase: BootPhase } & FrameFailure)
  | { kind: 'frameLost'; error: Error; capture: boolean }
  | { kind: 'readyWaited'; ms: number }
  | { kind: 'reconfigured'; config: ProtocolFrameConfig }
  | { kind: 'livenessChecked'; outcome: 'alive' | 'lost' }
  | { kind: 'mismatchMet'; error: ProtocolVersionMismatchError };

type FrameMachine<E> = MachineTypes<FrameState<E>, FrameEvent<E>, FrameEffect<E>>;

/** A frame's failure as the host sees it, and the name it is counted by. */
type FrameFailure = { error: Error; name: string };

/** The states of a frame being booted or up, which a failure of that frame drops. */
type BootedKind = 'loading' | 'connecting' | 'listening' | 'ready';

/** The states that hold a frame or a held one, whose liveness can be checked. */
type HoldingKind = BootedKind | 'failed';

type HoldingState<E> = Extract<FrameState<E>, { kind: HoldingKind }>;

/** The step a boot that fails in each state failed at. */
const BOOT_PHASES = {
  loading: 'load',
  connecting: 'listen',
  listening: 'ready',
} satisfies Record<Exclude<BootedKind, 'ready'>, BootPhase>;

export const DEFAULT_FRAME_TIMEOUTS: ProtocolFrameTimeouts = {
  configureMs: 30_000,
  loadMs: 30_000,
  // Short, so a silent frame has failed before a wallet read gives up, and the read's retry boots anew.
  handshakeMs: 5_000,
  readyMs: 240_000,
  rebuildMs: 2_000,
  maxRebuildMs: 30_000,
  stableMs: 30_000,
};

/** The hidden protocol frame on `document` at `origin`, hearing its messages on `window`. Boots nothing until asked. */
export function createProtocolFrame<E extends FrameElement>({
  origin,
  document: frameDocument,
  window: messages,
  timeouts: timeoutOverrides,
  timers = realTimers,
  count = countMetric,
}: ProtocolFrameParams<E>): ProtocolFrame {
  const timeouts: ProtocolFrameTimeouts = { ...DEFAULT_FRAME_TIMEOUTS, ...timeoutOverrides };
  const wire = createWireReport({ side: 'host', count });

  const status = atom<ProtocolStatus>('idle');
  const storeHeld = atom(false);
  const mismatchListeners = createListenerSet<ProtocolVersionMismatchError>({
    onListenerError: report.listener('protocol.frame_lost'),
  });

  /** Emits `next` and publishes it on the status and the held store, before the effects emitted after it. */
  function enter(next: FrameState<E>, { emitState, emitSideEffect }: Transition<FrameMachine<E>>): void {
    emitState(next);
    emitSideEffect({ kind: 'publish', ...getPublished(next) });
  }

  /**
   * Builds a frame, which answers `loads` once its iframe loaded and `readies` once it is ready, and keeps `held` until
   * it listens. An iframe that cannot be built fails the boot, which waits to rebuild.
   */
  function boot(
    params: Omit<Extract<FrameState<E>, { kind: 'loading' }>, 'kind' | 'iframe' | 'stopTimer'>,
    transition: Transition<FrameMachine<E>>,
  ): void {
    const { config, loads, readies, held, incident } = params;
    let iframe: E;
    try {
      iframe = createFrameIframe({ document: frameDocument, origin, config });
    } catch (thrown: unknown) {
      const failure = toFrameFailure(thrown);
      transition.emitSideEffect({ kind: 'bootFailed', phase: 'load', ...failure });
      waitToRebuild({ config, error: failure.error, held, incident }, transition);
      transition.emitSideEffect({ kind: 'reject', waits: [...loads, ...readies], error: failure.error });
      return;
    }
    const stopTimer = startActiveTimeout({
      ms: timeouts.loadMs,
      onElapsed: () => {
        transition.update({ kind: 'loadTimedOut' });
      },
      timers,
    });
    enter({ kind: 'loading', ...params, iframe, stopTimer }, transition);
    transition.emitSideEffect({ kind: 'mount', iframe });
  }

  /**
   * Moves to `failed` until the rebuild. The first wait is `rebuildMs`, and it doubles with each frame of the incident,
   * up to `maxRebuildMs`.
   */
  function waitToRebuild(
    { incident, ...failed }: Omit<Extract<FrameState<E>, { kind: 'failed' }>, 'kind' | 'stopTimer'>,
    transition: Transition<FrameMachine<E>>,
  ): void {
    const handle = timers.setTimeout(
      () => {
        transition.update({ kind: 'rebuildDue' });
      },
      Math.min(timeouts.rebuildMs * 2 ** incident.failures, timeouts.maxRebuildMs),
    );
    const stopTimer = () => {
      timers.clearTimeout(handle);
    };
    enter(
      { kind: 'failed', ...failed, stopTimer, incident: { ...incident, failures: incident.failures + 1 } },
      transition,
    );
  }

  /**
   * Ends what `state` runs as it is left: its timer, and its ready wait's measure. Returns what it owed and kept. A
   * frame that stayed ready for `stableMs` ends the incident, however it left.
   */
  function leave(
    state: HoldingState<E>,
    { emitSideEffect }: Transition<FrameMachine<E>>,
  ): { waits: readonly Wait[]; frame: Mounted<E> | null; held: Frame<E> | null; incident: Incident } {
    const { incident } = state;
    switch (state.kind) {
      case 'loading':
        emitSideEffect({ kind: 'stopTimer', stopTimer: state.stopTimer });
        return {
          waits: [...state.loads, ...state.readies],
          frame: { iframe: state.iframe, transport: null },
          held: state.held,
          incident,
        };
      case 'connecting':
        return { waits: state.readies, frame: state.frame, held: state.held, incident };
      case 'listening':
        emitSideEffect({ kind: 'stopTimer', stopTimer: state.stopTimer });
        emitSideEffect({ kind: 'readyWaited', ms: timers.now() - state.listenedAt });
        return { waits: state.readies, frame: state.frame, held: null, incident };
      case 'ready': {
        const stable = timers.now() - state.readyAt >= timeouts.stableMs;
        return {
          waits: [],
          frame: state.frame,
          held: null,
          incident: stable ? { failures: 0, captured: false } : incident,
        };
      }
      case 'failed':
        emitSideEffect({ kind: 'stopTimer', stopTimer: state.stopTimer });
        return { waits: [], frame: null, held: state.held, incident };
    }
  }

  /**
   * Drops the frame of `state`, which failed with `thrown`, reported for the step it failed at. A version mismatch is
   * final. A light client that failed to start keeps its frame held for the shared store, and any other failure lets
   * the frame go. Either way the frame waits to rebuild.
   */
  function loseFrame(
    state: Extract<FrameState<E>, { kind: BootedKind }>,
    thrown: unknown,
    transition: Transition<FrameMachine<E>>,
  ): void {
    const { emitSideEffect } = transition;
    const failure = toFrameFailure(thrown);
    const { error } = failure;
    const { waits, frame, held, incident: left } = leave(state, transition);
    let incident = left;
    if (state.kind === 'ready') {
      emitSideEffect({ kind: 'frameLost', error, capture: !left.captured });
      incident = withLoss(left, error);
    } else {
      emitSideEffect({ kind: 'bootFailed', phase: BOOT_PHASES[state.kind], ...failure });
    }
    const { config } = state;
    // Rebuilding cannot fix a frame that refused the host's wire version, and a reload can, so it is final.
    if (error instanceof ProtocolVersionMismatchError) {
      enter({ kind: 'mismatched', error }, transition);
      emitSideEffect({ kind: 'reject', waits, error });
      emitSideEffect({ kind: 'drop', frame, reason: error });
      emitSideEffect({ kind: 'drop', frame: held, reason: error });
      emitSideEffect({ kind: 'mismatchMet', error });
      return;
    }
    if (error instanceof ProtocolInitFailedError && (state.kind === 'connecting' || state.kind === 'listening')) {
      waitToRebuild({ config, error, held: state.frame, incident }, transition);
      emitSideEffect({ kind: 'reject', waits, error });
      emitSideEffect({ kind: 'drop', frame: held, reason: new Error(PROTOCOL_ERRORS.FRAME_RESET) });
      return;
    }
    waitToRebuild({ config, error, held, incident }, transition);
    emitSideEffect({ kind: 'reject', waits, error });
    emitSideEffect({ kind: 'drop', frame, reason: error });
  }

  /** A handler of either ask in the states of `Kind`. */
  type AskHandler<Kind extends FrameState<E>['kind']> = (
    state: Extract<FrameState<E>, { kind: Kind }>,
    ask: Ask,
    transition: Transition<FrameMachine<E>>,
  ) => void;

  const bootOnAsk: AskHandler<'idle' | 'resetting'> = ({ config, incident }, ask, transition) => {
    boot({ config, ...getAskWaits(ask), held: null, incident }, transition);
  };

  // A caller of either ask that finds the frame down cuts its backoff short, unless a frame is held. A held frame
  // answers the shared store, and a light client that failed to start fails a ready wait at once until the next boot,
  // which the backoff starts.
  const bootOnAskWhenDown: AskHandler<'failed'> = (state, ask, transition) => {
    const { config, held, incident, error, stopTimer } = state;
    if (held !== null) {
      switch (ask.kind) {
        case 'readyAsked':
          transition.emitSideEffect({ kind: 'reject', waits: [ask.wait], error });
          return;
        case 'transportAsked':
          transition.emitSideEffect({ kind: 'resolve', waits: [ask.wait], transport: held.transport });
          return;
      }
    }
    transition.emitSideEffect({ kind: 'stopTimer', stopTimer });
    boot({ config, ...getAskWaits(ask), held: null, incident: { ...incident, failures: 0 } }, transition);
  };

  // Each ask waits for the first config, and fails when none comes within `configureMs`.
  const queueAsk: AskHandler<'unconfigured'> = (state, ask, transition) => {
    const stopTimer = startActiveTimeout({
      ms: timeouts.configureMs,
      onElapsed: () => {
        transition.update({ kind: 'configureTimedOut', wait: ask.wait });
      },
      timers,
    });
    enter({ kind: 'unconfigured', waits: [...state.waits, { ...ask, stopTimer }] }, transition);
  };

  const resolveFrameTransport: AskHandler<'listening' | 'ready'> = ({ frame }, { wait }, { emitSideEffect }) => {
    emitSideEffect({ kind: 'resolve', waits: [wait], transport: frame.transport });
  };

  const rejectMismatched: AskHandler<'mismatched'> = ({ error }, { wait }, { emitSideEffect }) => {
    emitSideEffect({ kind: 'reject', waits: [wait], error });
  };

  const changeIdleConfig: HandlerOf<FrameMachine<E>, 'idle' | 'resetting', 'configured'> = (
    state,
    { config },
    transition,
  ) => {
    if (isSameFrameConfig(state.config, config)) {
      return;
    }
    enter({ ...state, config }, transition);
  };

  // A listener that heard `idle` may have asked for the frame or configured again, so the rebuild is asked for after
  // `idle` is published, and the frame is built once, with the latest config. The rebuild starts its waits over.
  const reconfigure: HandlerOf<FrameMachine<E>, HoldingKind, 'configured'> = (state, { config }, transition) => {
    if (isSameFrameConfig(state.config, config)) {
      return;
    }
    const { emitSideEffect } = transition;
    // Told apart from a fatal in the trail, since both drop the frame.
    emitSideEffect({ kind: 'reconfigured', config });
    const { waits, frame, held, incident } = leave(state, transition);
    enter({ kind: 'resetting', config, incident: { ...incident, failures: 0 } }, transition);
    const reason = new Error(PROTOCOL_ERRORS.FRAME_RESET);
    emitSideEffect({ kind: 'reject', waits, error: reason });
    emitSideEffect({ kind: 'drop', frame, reason });
    emitSideEffect({ kind: 'drop', frame: held, reason });
    emitSideEffect({ kind: 'rebuild' });
  };

  const joinReadies: HandlerOf<FrameMachine<E>, 'loading' | 'connecting' | 'listening', 'readyAsked'> = (
    state,
    { wait },
    transition,
  ) => {
    enter({ ...state, readies: [...state.readies, wait] }, transition);
  };

  // A dropped frame's own status ends with its loss, which was reported when it was dropped.
  const failFrame: HandlerOf<FrameMachine<E>, BootedKind, 'frameFailed'> = (state, { iframe, thrown }, transition) => {
    const current = state.kind === 'loading' ? state.iframe : state.frame.iframe;
    if (iframe !== current) {
      return;
    }
    loseFrame(state, thrown, transition);
  };

  // A held frame that stops answering is let go, and the status stays as it is.
  const dropUnresponsiveHeld: HandlerOf<FrameMachine<E>, 'loading' | 'connecting' | 'failed', 'frameUnresponsive'> = (
    state,
    { transport, error },
    transition,
  ) => {
    const { held, incident } = state;
    if (held?.transport !== transport) {
      return;
    }
    enter({ ...state, held: null, incident: withLoss(incident, error) }, transition);
    transition.emitSideEffect({ kind: 'frameLost', error, capture: !incident.captured });
    transition.emitSideEffect({ kind: 'drop', frame: held, reason: error });
  };

  const loseUnresponsive: HandlerOf<FrameMachine<E>, 'connecting' | 'listening' | 'ready', 'frameUnresponsive'> = (
    state,
    event,
    transition,
  ) => {
    if (event.transport === state.frame.transport) {
      loseFrame(state, event.error, transition);
      return;
    }
    if (state.kind === 'connecting') {
      dropUnresponsiveHeld(state, event, transition);
    }
  };

  // A check runs on the current or the held frame whose transport it names, and finds nothing once that frame left.
  const checkFrame = nest<
    FrameMachine<E>,
    HoldingKind,
    MachineTypes<Check, FrameEvent<E>, FrameEffect<E>>,
    'aliveAsked' | 'heartbeatAnswered' | 'heartbeatFailed'
  >({
    find: (state, { transport }) => getFrames(state).find(frame => frame.transport === transport)?.check ?? null,
    store(state, { transport }, check) {
      function withCheck(frame: Frame<E>): Frame<E> {
        return frame.transport === transport ? { ...frame, check } : frame;
      }
      switch (state.kind) {
        case 'loading':
        case 'failed':
          return state.held === null ? state : { ...state, held: withCheck(state.held) };
        case 'connecting':
          return { ...state, frame: withCheck(state.frame), held: state.held === null ? null : withCheck(state.held) };
        case 'listening':
        case 'ready':
          return { ...state, frame: withCheck(state.frame) };
      }
    },
    handlers: {
      idle: {
        aliveAsked(_check, { transport }, { emitState, emitSideEffect }) {
          emitState({ kind: 'asking' });
          emitSideEffect({ kind: 'askAlive', transport });
        },
      },
      asking: {
        heartbeatAnswered(_check, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'idle' });
          emitSideEffect({ kind: 'livenessChecked', outcome: 'alive' });
        },
        heartbeatFailed(_check, { transport, error }, { emitState, emitSideEffect, update }) {
          emitState({ kind: 'idle' });
          emitSideEffect({ kind: 'livenessChecked', outcome: 'lost' });
          update({ kind: 'frameUnresponsive', transport, error });
        },
      },
    },
  });

  const machine = createStateMachine<FrameMachine<E>>({
    initial: { kind: 'unconfigured', waits: [] },
    handlers: {
      unconfigured: {
        readyAsked: queueAsk,
        transportAsked: queueAsk,
        configureTimedOut(state, { wait }, transition) {
          enter({ kind: 'unconfigured', waits: state.waits.filter(queued => queued.wait !== wait) }, transition);
          const error = new Error(PROTOCOL_ERRORS.FRAME_UNCONFIGURED);
          transition.emitSideEffect({ kind: 'reject', waits: [wait], error });
        },
        configured(state, { config }, transition) {
          enter({ kind: 'idle', config, incident: { failures: 0, captured: false } }, transition);
          for (const queued of state.waits) {
            transition.emitSideEffect({ kind: 'stopTimer', stopTimer: queued.stopTimer });
            transition.update({ kind: queued.kind, wait: queued.wait });
          }
        },
      },
      idle: {
        readyAsked: bootOnAsk,
        transportAsked: bootOnAsk,
        configured: changeIdleConfig,
      },
      resetting: {
        readyAsked: bootOnAsk,
        transportAsked: bootOnAsk,
        configured: changeIdleConfig,
        rebuildAsked({ config, incident }, _event, transition) {
          boot({ config, loads: [], readies: [], held: null, incident }, transition);
        },
      },
      loading: {
        readyAsked: joinReadies,
        transportAsked(state, { wait }, transition) {
          // A held frame answers the shared store until a new frame listens.
          if (state.held !== null) {
            transition.emitSideEffect({ kind: 'resolve', waits: [wait], transport: state.held.transport });
            return;
          }
          enter({ ...state, loads: [...state.loads, wait] }, transition);
        },
        configured: reconfigure,
        // The transport is built on `load`, since a post to a frame that has not committed its document is dropped.
        // `load` also fires when the frame's script failed, which the handshake's own timeout then finds.
        iframeLoaded(state, { iframe }, transition) {
          if (iframe !== state.iframe) {
            return;
          }
          const transport = openTransport(iframe);
          const { config, readies, held, incident } = state;
          const frame: Frame<E> = { iframe, transport, check: { kind: 'idle' } };
          enter({ kind: 'connecting', config, frame, readies, held, incident }, transition);
          // First, so the status call starts the handshake ahead of the calls that waited for the load.
          transition.emitSideEffect({ kind: 'connect', iframe, transport });
          transition.emitSideEffect({ kind: 'stopTimer', stopTimer: state.stopTimer });
          transition.emitSideEffect({ kind: 'resolve', waits: state.loads, transport });
        },
        loadTimedOut(state, _event, transition) {
          loseFrame(state, new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT), transition);
        },
        frameFailed: failFrame,
        aliveAsked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: dropUnresponsiveHeld,
      },
      connecting: {
        readyAsked: joinReadies,
        transportAsked(state, { wait }, { emitSideEffect }) {
          emitSideEffect({ kind: 'resolve', waits: [wait], transport: (state.held ?? state.frame).transport });
        },
        configured: reconfigure,
        handshakeDone(state, { iframe }, transition) {
          if (iframe !== state.frame.iframe) {
            return;
          }
          const stopTimer = startActiveTimeout({
            ms: timeouts.readyMs,
            onElapsed: () => {
              transition.update({ kind: 'readyTimedOut' });
            },
            timers,
          });
          const { config, frame, readies, incident } = state;
          const listenedAt = timers.now();
          enter({ kind: 'listening', config, frame, stopTimer, listenedAt, readies, incident }, transition);
          // A held frame answers only while no frame listens, so a listener that asks for a transport on `listening`
          // gets this one, and the held frame goes after.
          const reason = new Error(PROTOCOL_ERRORS.FRAME_RESET);
          transition.emitSideEffect({ kind: 'drop', frame: state.held, reason });
        },
        // A frame ready without a `listening` of its own waited no time for ready.
        frameReadied({ config, frame, readies, held, incident }, { iframe }, transition) {
          if (iframe !== frame.iframe) {
            return;
          }
          enter({ kind: 'ready', config, frame, readyAt: timers.now(), incident }, transition);
          transition.emitSideEffect({ kind: 'resolve', waits: readies, transport: frame.transport });
          transition.emitSideEffect({ kind: 'readyWaited', ms: 0 });
          transition.emitSideEffect({ kind: 'drop', frame: held, reason: new Error(PROTOCOL_ERRORS.FRAME_RESET) });
        },
        frameFailed: failFrame,
        aliveAsked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: loseUnresponsive,
      },
      listening: {
        readyAsked: joinReadies,
        transportAsked: resolveFrameTransport,
        configured: reconfigure,
        readyTimedOut(state, _event, transition) {
          loseFrame(state, new Error(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT), transition);
        },
        frameReadied({ config, frame, stopTimer, listenedAt, readies, incident }, { iframe }, transition) {
          if (iframe !== frame.iframe) {
            return;
          }
          enter({ kind: 'ready', config, frame, readyAt: timers.now(), incident }, transition);
          transition.emitSideEffect({ kind: 'resolve', waits: readies, transport: frame.transport });
          transition.emitSideEffect({ kind: 'readyWaited', ms: timers.now() - listenedAt });
          transition.emitSideEffect({ kind: 'stopTimer', stopTimer });
        },
        frameFailed: failFrame,
        aliveAsked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: loseUnresponsive,
      },
      ready: {
        readyAsked: resolveFrameTransport,
        transportAsked: resolveFrameTransport,
        configured: reconfigure,
        frameFailed: failFrame,
        aliveAsked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: loseUnresponsive,
      },
      failed: {
        readyAsked: bootOnAskWhenDown,
        transportAsked: bootOnAskWhenDown,
        configured: reconfigure,
        rebuildDue({ config, held, incident }, _event, transition) {
          boot({ config, loads: [], readies: [], held, incident }, transition);
        },
        aliveAsked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: dropUnresponsiveHeld,
      },
      mismatched: {
        readyAsked: rejectMismatched,
        transportAsked: rejectMismatched,
      },
    },
    onEffect: runEffect,
    onError: error => {
      report.defect(error, {
        step: 'frame_transition',
        metric: frameTransitionMetric,
        message: '[dot.li protocol] A protocol frame transition threw',
      });
    },
  });

  return {
    status,
    storeHeld,
    configure(config) {
      machine.update({ kind: 'configured', config: { ...config } });
    },
    getTransport() {
      return new Promise<ProtocolTransport>((resolve, reject) => {
        machine.update({ kind: 'transportAsked', wait: { resolve, reject } });
      });
    },
    waitUntilReady() {
      return new Promise<ProtocolTransport>((resolve, reject) => {
        machine.update({ kind: 'readyAsked', wait: { resolve, reject } });
      });
    },
    onVersionMismatch(listener) {
      const state = machine.state.get();
      if (state.kind === 'mismatched') {
        mismatchListeners.deliver(listener, state.error);
        return noop;
      }
      return mismatchListeners.subscribe(listener);
    },
    checkAlive(transport) {
      machine.update({ kind: 'aliveAsked', transport });
    },
  };

  function runEffect(effect: FrameEffect<E>): void {
    switch (effect.kind) {
      case 'publish':
        publish(effect.status, effect.held);
        return;
      case 'resolve':
        for (const wait of effect.waits) {
          wait.resolve(effect.transport);
        }
        return;
      case 'reject':
        for (const wait of effect.waits) {
          wait.reject(effect.error);
        }
        return;
      case 'stopTimer':
        effect.stopTimer();
        return;
      case 'mount':
        mountIframe(effect.iframe);
        return;
      case 'connect':
        connectFrame(effect.iframe, effect.transport);
        return;
      case 'askAlive':
        machine.update(askAlive(effect.transport));
        return;
      case 'rebuild':
        machine.update({ kind: 'rebuildAsked' });
        return;
      case 'drop':
        // The transport posts nothing as it closes, so the frame lets go of what it served once its iframe goes.
        effect.frame?.transport?.dispose(effect.reason);
        effect.frame?.iframe.remove();
        return;
      case 'bootFailed':
        reportBootFailure({ phase: effect.phase, error: effect.error, name: effect.name, count });
        return;
      case 'frameLost':
        reportFrameLost({ error: effect.error, count, capture: effect.capture });
        return;
      case 'readyWaited':
        m.measure(protocolIframeReadyMetric.name, effect.ms);
        m.distribution(protocolIframeReadyMetric.name, effect.ms);
        return;
      case 'reconfigured':
        report.log.event('protocol frame reconfigured', {
          backend: effect.config.backend,
          network: effect.config.network,
          skipWorkerCache: effect.config.skipWorkerCache,
        });
        return;
      case 'livenessChecked':
        report.log.event('protocol frame liveness check', { outcome: effect.outcome });
        return;
      case 'mismatchMet':
        mismatchListeners.emit(effect.error);
        return;
    }
  }

  /** The frames `state` holds: its own, and the one it keeps held. */
  function getFrames(state: HoldingState<E>): Frame<E>[] {
    switch (state.kind) {
      case 'loading':
      case 'failed':
        return state.held === null ? [] : [state.held];
      case 'connecting':
        return state.held === null ? [state.frame] : [state.frame, state.held];
      case 'listening':
      case 'ready':
        return [state.frame];
    }
  }

  /**
   * Sets the status and the held store. The store is held before the status says the frame is down, and let go after
   * a new frame listens, so a reader of both never finds the shared store with nothing to answer it.
   */
  function publish(next: ProtocolStatus, held: boolean): void {
    if (held) {
      setPublished(storeHeld, true);
      setPublished(status, next);
      return;
    }
    setPublished(status, next);
    setPublished(storeHeld, false);
  }

  /** Mounts `iframe` and sends its load or its failure as an event. */
  function mountIframe(iframe: E): void {
    function handleLoad(): void {
      iframe.removeEventListener('error', handleError);
      machine.update({ kind: 'iframeLoaded', iframe });
    }
    function handleError(): void {
      iframe.removeEventListener('load', handleLoad);
      machine.update({ kind: 'frameFailed', iframe, thrown: new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED) });
    }
    iframe.addEventListener('load', handleLoad, { once: true });
    iframe.addEventListener('error', handleError, { once: true });
    try {
      frameDocument.body.appendChild(iframe);
    } catch (thrown: unknown) {
      machine.update({ kind: 'frameFailed', iframe, thrown });
    }
  }

  /** Follows the status of the frame on `transport`, and its handshake, as events. */
  function connectFrame(iframe: E, transport: ProtocolTransport): void {
    try {
      subscribe({
        transport,
        method: protocolSchema.sections.frame.status,
        start: undefined,
        listeners: {
          receive: () => {
            machine.update({ kind: 'frameReadied', iframe });
          },
          end: error => {
            const thrown = error ?? new Error(PROTOCOL_ERRORS.FRAME_STATUS_ENDED);
            machine.update({ kind: 'frameFailed', iframe, thrown });
          },
        },
      });
    } catch (thrown: unknown) {
      machine.update({ kind: 'frameFailed', iframe, thrown });
    }
    machine.update(
      transport.whenConnected().then(
        (): FrameEvent<E> => ({ kind: 'handshakeDone', iframe }),
        (thrown: unknown): FrameEvent<E> => ({ kind: 'frameFailed', iframe, thrown }),
      ),
    );
  }

  /** Sends the frame a heartbeat, answered when it answers within `handshakeMs`, a refusal included. */
  function askAlive(transport: ProtocolTransport): Promise<FrameEvent<E>> {
    const asking = new AbortController();
    return withTimeout({
      work: transport.request(protocolSchema.sections.frame.heartbeat, undefined, { signal: asking.signal }),
      ms: timeouts.handshakeMs,
      timeoutError: () => {
        const error = new Error(`The frame did not answer the heartbeat within ${String(timeouts.handshakeMs)} ms`);
        asking.abort(error);
        return error;
      },
      timers,
    }).then(
      (): FrameEvent<E> => ({ kind: 'heartbeatAnswered', transport }),
      (thrown: unknown): FrameEvent<E> => ({
        kind: 'heartbeatFailed',
        transport,
        error: createUnresponsiveError(thrown),
      }),
    );
  }

  /** The transport to `iframe`, which has loaded. */
  function openTransport(iframe: E): ProtocolTransport {
    return createTransport({
      schema: protocolSchema,
      provider: createWindowProvider({
        listen: messages,
        peer: () => iframe.contentWindow ?? null,
        origin,
      }),
      handshake: 'offer',
      // The frame reads the resolution id from its URL, which it needs before any handshake.
      hello: { resolutionId: null },
      timers,
      timeoutMs: timeouts.handshakeMs,
      onIssue: wire.onIssue,
    });
  }
}

/** A failure as the host sees it: a failed handshake rejects with the transport's own error, known by its class. */
function toFrameFailure(thrown: unknown): FrameFailure {
  const error = fromTransportError(toError(thrown));
  return { error, name: thrown instanceof Error ? error.name : 'unknown' };
}

/** `incident` after a loss, which is captured unless the frame was released. */
function withLoss(incident: Incident, error: Error): Incident {
  return { ...incident, captured: incident.captured || !isFrameReleased(error) };
}

/** The waits a boot answers for `ask`: once its iframe loaded, or once it is ready. */
function getAskWaits({ kind, wait }: Ask): { loads: readonly Wait[]; readies: readonly Wait[] } {
  switch (kind) {
    case 'transportAsked':
      return { loads: [wait], readies: [] };
    case 'readyAsked':
      return { loads: [], readies: [wait] };
  }
}

/** What the status and the held store say of `state`. */
function getPublished(state: FrameState<unknown>): { status: ProtocolStatus; held: boolean } {
  switch (state.kind) {
    case 'unconfigured':
    case 'idle':
    case 'resetting':
      return { status: 'idle', held: false };
    case 'loading':
    case 'connecting':
      return { status: 'booting', held: state.held !== null };
    case 'listening':
      return { status: 'listening', held: false };
    case 'ready':
      return { status: 'ready', held: false };
    case 'failed':
      return { status: 'failed', held: state.held !== null };
    case 'mismatched':
      return { status: 'failed', held: false };
  }
}

/** Sets `store`. A listener's throw is a defect in its subscriber, reported once every listener heard the change. */
function setPublished<T>(store: WritableAtom<T>, value: T): void {
  try {
    store.set(value);
  } catch (thrown: unknown) {
    report.listener('protocol.status')(thrown);
  }
}

/** Why a frame that did not answer the heartbeat is dropped, with what the heartbeat failed with as its cause. */
function createUnresponsiveError(thrown: unknown): Error {
  const reason = new Error(PROTOCOL_ERRORS.FRAME_UNRESPONSIVE, { cause: toError(thrown) });
  return setErrorName(reason, 'ProtocolFrameUnresponsiveError');
}

function isSameFrameConfig(left: ProtocolFrameConfig, right: ProtocolFrameConfig): boolean {
  return (
    left.backend === right.backend && left.network === right.network && left.skipWorkerCache === right.skipWorkerCache
  );
}

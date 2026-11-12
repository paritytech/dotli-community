// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The hidden protocol iframe: it boots on demand, publishes where it stands, rebuilds itself when it is lost, and hands
// the layers above the transport to the frame there is now. Each iframe gets its own provider and transport, so a
// message from a dropped iframe reaches only that iframe's disposed provider.

import { atom, type WritableAtom } from 'nanostores';
import { countMetric, createReporter, defineCount, getResolutionId, m } from '@dotli/metrics';
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
import { FRAME_MODES } from './getBackendOfFrameMode.js';
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
 * Where the frame stands. `held` is a frame whose light client failed to start, kept to answer the shared store until a
 * new frame listens. `failures` counts the frames lost since one stayed ready for `stableMs`, which the rebuild waits
 * grow with. `captured` is set once a ready frame's loss was captured since the last frame that stayed ready for
 * `stableMs`, so a frame that keeps dying soon after ready is counted every time but captured once.
 */
type FrameState<E> =
  // Each ask made before the first config comes with the stop of the wait that fails it when no config comes.
  | { kind: 'unconfigured'; waits: readonly (Ask & { stopWait: () => void })[] }
  | { kind: 'idle'; config: ProtocolFrameConfig; captured: boolean }
  | { kind: 'resetting'; config: ProtocolFrameConfig; captured: boolean }
  | {
      kind: 'loading';
      config: ProtocolFrameConfig;
      iframe: E;
      stopWait: () => void;
      loads: readonly Wait[];
      readies: readonly Wait[];
      held: Frame<E> | null;
      failures: number;
      captured: boolean;
    }
  | {
      kind: 'connecting';
      config: ProtocolFrameConfig;
      frame: Frame<E>;
      readies: readonly Wait[];
      held: Frame<E> | null;
      failures: number;
      captured: boolean;
    }
  | {
      kind: 'listening';
      config: ProtocolFrameConfig;
      frame: Frame<E>;
      stopWait: () => void;
      listenedAt: number;
      readies: readonly Wait[];
      failures: number;
      captured: boolean;
    }
  | {
      kind: 'ready';
      config: ProtocolFrameConfig;
      frame: Frame<E>;
      readyAt: number;
      failures: number;
      captured: boolean;
    }
  | {
      kind: 'failed';
      config: ProtocolFrameConfig;
      error: Error;
      stopWait: () => void;
      held: Frame<E> | null;
      failures: number;
      captured: boolean;
    }
  | { kind: 'mismatched'; error: ProtocolVersionMismatchError };

/**
 * What moves the frame. A wait's event carries nothing, since every move to another kind stops it. A listener's or a
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
  | { kind: 'iframeFailed'; iframe: E }
  | { kind: 'handshakeDone'; iframe: E }
  | { kind: 'frameReadied'; iframe: E }
  | { kind: 'frameFailed'; iframe: E; thrown: unknown }
  | { kind: 'aliveChecked'; transport: ProtocolTransport }
  | { kind: 'heartbeatAnswered'; transport: ProtocolTransport }
  | { kind: 'heartbeatFailed'; transport: ProtocolTransport; error: Error }
  | { kind: 'frameUnresponsive'; transport: ProtocolTransport; error: Error };

type FrameEffect<E> =
  | { kind: 'publish'; status: ProtocolStatus; held: boolean }
  | { kind: 'resolve'; waits: readonly Wait[]; transport: ProtocolTransport }
  | { kind: 'reject'; waits: readonly Wait[]; error: Error }
  | { kind: 'stopWait'; stopWait: () => void }
  | { kind: 'mount'; iframe: E }
  | { kind: 'connect'; iframe: E; transport: ProtocolTransport }
  | { kind: 'askAlive'; transport: ProtocolTransport }
  | { kind: 'rebuild' }
  | ({ kind: 'drop'; reason: Error } & Mounted<E>)
  | { kind: 'bootFailed'; phase: BootPhase; error: Error; name: string }
  | { kind: 'frameLost'; error: Error; capture: boolean }
  | { kind: 'readyWaited'; ms: number }
  | { kind: 'reconfigured'; config: ProtocolFrameConfig }
  | { kind: 'livenessChecked'; outcome: 'alive' | 'lost' }
  | { kind: 'mismatchMet'; error: ProtocolVersionMismatchError };

type FrameMachine<E> = MachineTypes<FrameState<E>, FrameEvent<E>, FrameEffect<E>>;

/** The states of a frame being booted or up, which a failure of that frame drops. */
type BootedKind = 'loading' | 'connecting' | 'listening' | 'ready';

/** The states that hold a frame or a held one, whose liveness can be checked. */
type CheckedKind = BootedKind | 'failed';

type LoadingState<E> = Extract<FrameState<E>, { kind: 'loading' }>;

type FailedState<E> = Extract<FrameState<E>, { kind: 'failed' }>;

export const DEFAULT_FRAME_TIMEOUTS: ProtocolFrameTimeouts = {
  configureMs: 30_000,
  loadMs: 30_000,
  // Below the transport's 10 s, so a silent frame has failed when a wallet read gives up, and the retry boots anew.
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

  /** Lets `frame` go once the transition's reports ran, its calls in flight rejecting with `reason`. */
  function dropFrame(frame: Mounted<E> | null, reason: Error, { emitSideEffect }: Transition<FrameMachine<E>>): void {
    if (frame === null) {
      return;
    }
    emitSideEffect({ kind: 'drop', iframe: frame.iframe, transport: frame.transport, reason });
  }

  /**
   * Builds a frame, which answers `loads` once its iframe loaded and `readies` once it is ready, and keeps `held` until
   * it listens. An iframe that cannot be built fails the boot, which waits to rebuild.
   */
  function boot(
    params: Omit<LoadingState<E>, 'kind' | 'iframe' | 'stopWait'>,
    transition: Transition<FrameMachine<E>>,
  ): void {
    const { config, loads, readies, held, failures, captured } = params;
    let iframe: E;
    try {
      iframe = createIframe(config);
    } catch (thrown: unknown) {
      const error = fromTransportError(toError(thrown));
      const name = thrown instanceof Error ? error.name : 'unknown';
      transition.emitSideEffect({ kind: 'bootFailed', phase: 'load', error, name });
      waitToRebuild({ config, error, held, failures, captured }, false, transition);
      transition.emitSideEffect({ kind: 'reject', waits: [...loads, ...readies], error });
      return;
    }
    const stopWait = startActiveTimeout({
      ms: timeouts.loadMs,
      onElapsed: () => {
        transition.update({ kind: 'loadTimedOut' });
      },
      timers,
    });
    enter({ kind: 'loading', ...params, iframe, stopWait }, transition);
    transition.emitSideEffect({ kind: 'mount', iframe });
  }

  /**
   * Moves to `failed` until the rebuild. The first wait is `rebuildMs`, and it doubles with each frame lost since one
   * stayed ready for `stableMs`, up to `maxRebuildMs`.
   */
  function waitToRebuild(
    { failures, ...failed }: Omit<FailedState<E>, 'kind' | 'stopWait'>,
    stable: boolean,
    transition: Transition<FrameMachine<E>>,
  ): void {
    const before = stable ? 0 : failures;
    const handle = timers.setTimeout(
      () => {
        transition.update({ kind: 'rebuildDue' });
      },
      Math.min(timeouts.rebuildMs * 2 ** before, timeouts.maxRebuildMs),
    );
    const stopWait = () => {
      timers.clearTimeout(handle);
    };
    enter({ kind: 'failed', ...failed, stopWait, failures: before + 1 }, transition);
  }

  /**
   * Ends what `state` runs as it is left: its waits for a timeout, and its ready wait. Returns what it owed and kept.
   * `captured` starts over when it was a frame that stayed ready for `stableMs`, which `stable` tells.
   */
  function leave(
    state: Extract<FrameState<E>, { kind: CheckedKind }>,
    { emitSideEffect }: Transition<FrameMachine<E>>,
  ): { waits: readonly Wait[]; frame: Mounted<E> | null; held: Frame<E> | null; stable: boolean; captured: boolean } {
    const { captured } = state;
    switch (state.kind) {
      case 'loading':
        emitSideEffect({ kind: 'stopWait', stopWait: state.stopWait });
        return {
          waits: [...state.loads, ...state.readies],
          frame: { iframe: state.iframe, transport: null },
          held: state.held,
          stable: false,
          captured,
        };
      case 'connecting':
        return { waits: state.readies, frame: state.frame, held: state.held, stable: false, captured };
      case 'listening':
        emitSideEffect({ kind: 'stopWait', stopWait: state.stopWait });
        emitSideEffect({ kind: 'readyWaited', ms: timers.now() - state.listenedAt });
        return { waits: state.readies, frame: state.frame, held: null, stable: false, captured };
      case 'ready': {
        // A frame that stayed up ends the incident, however it left.
        const stable = timers.now() - state.readyAt >= timeouts.stableMs;
        return { waits: [], frame: state.frame, held: null, stable, captured: captured && !stable };
      }
      case 'failed':
        emitSideEffect({ kind: 'stopWait', stopWait: state.stopWait });
        return { waits: [], frame: null, held: state.held, stable: false, captured };
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
    // A failed handshake rejects with the transport's own error, which the host knows by the protocol's class.
    const error = fromTransportError(toError(thrown));
    const name = thrown instanceof Error ? error.name : 'unknown';
    const { waits, frame, held, stable, captured: left } = leave(state, transition);
    let captured = left;
    switch (state.kind) {
      case 'loading':
        emitSideEffect({ kind: 'bootFailed', phase: 'load', error, name });
        break;
      case 'connecting':
        emitSideEffect({ kind: 'bootFailed', phase: 'listen', error, name });
        break;
      case 'listening':
        emitSideEffect({ kind: 'bootFailed', phase: 'ready', error, name });
        break;
      case 'ready':
        emitSideEffect({ kind: 'frameLost', error, capture: !captured });
        captured ||= !isFrameReleased(error);
        break;
    }
    const { config, failures } = state;
    // Rebuilding cannot fix a frame that refused the host's wire version, and a reload can, so it is final.
    if (error instanceof ProtocolVersionMismatchError) {
      enter({ kind: 'mismatched', error }, transition);
      emitSideEffect({ kind: 'reject', waits, error });
      dropFrame(frame, error, transition);
      dropFrame(held, error, transition);
      emitSideEffect({ kind: 'mismatchMet', error });
      return;
    }
    if (error instanceof ProtocolInitFailedError && (state.kind === 'connecting' || state.kind === 'listening')) {
      waitToRebuild({ config, error, held: state.frame, failures, captured }, stable, transition);
      emitSideEffect({ kind: 'reject', waits, error });
      dropFrame(held, new Error(PROTOCOL_ERRORS.FRAME_RESET), transition);
      return;
    }
    waitToRebuild({ config, error, held, failures, captured }, stable, transition);
    emitSideEffect({ kind: 'reject', waits, error });
    dropFrame(frame, error, transition);
  }

  /** The handler of both asks in the states of `Kind`. */
  type AskHandler<Kind extends FrameState<E>['kind']> = HandlerOf<FrameMachine<E>, Kind, 'readyAsked'> &
    HandlerOf<FrameMachine<E>, Kind, 'transportAsked'>;

  // An intersection of slots gives a handler no contextual type, so the parameters of these are written out.
  const bootOnAsk: AskHandler<'idle' | 'resetting'> = (
    { config, captured }: Extract<FrameState<E>, { kind: 'idle' | 'resetting' }>,
    ask: Ask,
    transition: Transition<FrameMachine<E>>,
  ) => {
    boot({ config, ...getAskWaits(ask), held: null, failures: 0, captured }, transition);
  };

  // Each ask waits for the first config, and fails when none comes within `configureMs`.
  const queueAsk: AskHandler<'unconfigured'> = (
    state: Extract<FrameState<E>, { kind: 'unconfigured' }>,
    ask: Ask,
    transition: Transition<FrameMachine<E>>,
  ) => {
    const stopWait = startActiveTimeout({
      ms: timeouts.configureMs,
      onElapsed: () => {
        transition.update({ kind: 'configureTimedOut', wait: ask.wait });
      },
      timers,
    });
    enter({ kind: 'unconfigured', waits: [...state.waits, { ...ask, stopWait }] }, transition);
  };

  const resolveFrameTransport: HandlerOf<FrameMachine<E>, 'listening' | 'ready', 'transportAsked'> &
    HandlerOf<FrameMachine<E>, 'ready', 'readyAsked'> = (
    { frame }: Extract<FrameState<E>, { kind: 'listening' | 'ready' }>,
    { wait }: Ask,
    { emitSideEffect }: Transition<FrameMachine<E>>,
  ) => {
    emitSideEffect({ kind: 'resolve', waits: [wait], transport: frame.transport });
  };

  const rejectMismatched: AskHandler<'mismatched'> = (
    { error }: Extract<FrameState<E>, { kind: 'mismatched' }>,
    { wait }: Ask,
    { emitSideEffect }: Transition<FrameMachine<E>>,
  ) => {
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
  // `idle` is published, and the frame is built once, with the latest config.
  const reconfigure: HandlerOf<FrameMachine<E>, CheckedKind, 'configured'> = (state, { config }, transition) => {
    if (isSameFrameConfig(state.config, config)) {
      return;
    }
    // Told apart from a fatal in the trail, since both drop the frame.
    transition.emitSideEffect({ kind: 'reconfigured', config });
    const { waits, frame, held, captured } = leave(state, transition);
    enter({ kind: 'resetting', config, captured }, transition);
    const reason = new Error(PROTOCOL_ERRORS.FRAME_RESET);
    transition.emitSideEffect({ kind: 'reject', waits, error: reason });
    dropFrame(frame, reason, transition);
    dropFrame(held, reason, transition);
    transition.emitSideEffect({ kind: 'rebuild' });
  };

  const joinReadies: HandlerOf<FrameMachine<E>, 'loading' | 'connecting' | 'listening', 'readyAsked'> = (
    state,
    { wait },
    transition,
  ) => {
    enter({ ...state, readies: [...state.readies, wait] }, transition);
  };

  // A frame ready without a `listening` of its own waited no time for ready.
  const markReady: HandlerOf<FrameMachine<E>, 'connecting' | 'listening', 'frameReadied'> = (
    state,
    { iframe },
    transition,
  ) => {
    if (iframe !== state.frame.iframe) {
      return;
    }
    const { frame, config, failures, captured, readies } = state;
    const { held } = leave(state, transition);
    enter({ kind: 'ready', config, frame, readyAt: timers.now(), failures, captured }, transition);
    transition.emitSideEffect({ kind: 'resolve', waits: readies, transport: frame.transport });
    if (state.kind === 'connecting') {
      transition.emitSideEffect({ kind: 'readyWaited', ms: 0 });
    }
    dropFrame(held, new Error(PROTOCOL_ERRORS.FRAME_RESET), transition);
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
    const { held, captured } = state;
    if (held?.transport !== transport) {
      return;
    }
    enter({ ...state, held: null, captured: captured || !isFrameReleased(error) }, transition);
    transition.emitSideEffect({ kind: 'frameLost', error, capture: !captured });
    dropFrame(held, error, transition);
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
    CheckedKind,
    MachineTypes<Check, FrameEvent<E>, FrameEffect<E>>,
    'aliveChecked' | 'heartbeatAnswered' | 'heartbeatFailed'
  >({
    find(state, { transport }) {
      switch (state.kind) {
        case 'loading':
        case 'failed':
          return state.held?.transport === transport ? state.held.check : null;
        case 'connecting':
          if (state.frame.transport === transport) {
            return state.frame.check;
          }
          return state.held?.transport === transport ? state.held.check : null;
        case 'listening':
        case 'ready':
          return state.frame.transport === transport ? state.frame.check : null;
      }
    },
    store(state, { transport }, check) {
      function withCheck(frame: Frame<E>): Frame<E> {
        return frame.transport === transport ? { ...frame, check } : frame;
      }
      switch (state.kind) {
        case 'loading':
        case 'failed':
          return state.held === null ? state : { ...state, held: withCheck(state.held) };
        case 'connecting':
          return {
            ...state,
            frame: withCheck(state.frame),
            held: state.held === null ? null : withCheck(state.held),
          };
        case 'listening':
        case 'ready':
          return { ...state, frame: withCheck(state.frame) };
      }
    },
    handlers: {
      idle: {
        aliveChecked(_check, { transport }, { emitState, emitSideEffect }) {
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
          transition.emitSideEffect({
            kind: 'reject',
            waits: [wait],
            error: new Error(PROTOCOL_ERRORS.FRAME_UNCONFIGURED),
          });
        },
        configured(state, { config }, transition) {
          enter({ kind: 'idle', config, captured: false }, transition);
          for (const queued of state.waits) {
            transition.emitSideEffect({ kind: 'stopWait', stopWait: queued.stopWait });
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
        rebuildAsked({ config, captured }, _event, transition) {
          boot({ config, loads: [], readies: [], held: null, failures: 0, captured }, transition);
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
          const { config, readies, held, failures, captured } = state;
          const frame: Frame<E> = { iframe, transport, check: { kind: 'idle' } };
          enter({ kind: 'connecting', config, frame, readies, held, failures, captured }, transition);
          // First, so the status call starts the handshake ahead of the calls that waited for the load.
          transition.emitSideEffect({ kind: 'connect', iframe, transport });
          transition.emitSideEffect({ kind: 'stopWait', stopWait: state.stopWait });
          transition.emitSideEffect({ kind: 'resolve', waits: state.loads, transport });
        },
        iframeFailed(state, { iframe }, transition) {
          if (iframe !== state.iframe) {
            return;
          }
          loseFrame(state, new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED), transition);
        },
        loadTimedOut(state, _event, transition) {
          loseFrame(state, new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT), transition);
        },
        frameFailed: failFrame,
        aliveChecked: checkFrame,
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
          const stopWait = startActiveTimeout({
            ms: timeouts.readyMs,
            onElapsed: () => {
              transition.update({ kind: 'readyTimedOut' });
            },
            timers,
          });
          const { config, frame, readies, failures, captured } = state;
          const listenedAt = timers.now();
          enter({ kind: 'listening', config, frame, stopWait, listenedAt, readies, failures, captured }, transition);
          // A held frame answers only while no frame listens, so a listener that asks for a transport on `listening`
          // gets this one, and the held frame goes after.
          dropFrame(state.held, new Error(PROTOCOL_ERRORS.FRAME_RESET), transition);
        },
        frameReadied: markReady,
        frameFailed: failFrame,
        aliveChecked: checkFrame,
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
        frameReadied: markReady,
        frameFailed: failFrame,
        aliveChecked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: loseUnresponsive,
      },
      ready: {
        readyAsked: resolveFrameTransport,
        transportAsked: resolveFrameTransport,
        configured: reconfigure,
        frameFailed: failFrame,
        aliveChecked: checkFrame,
        heartbeatAnswered: checkFrame,
        heartbeatFailed: checkFrame,
        frameUnresponsive: loseUnresponsive,
      },
      failed: {
        // A caller of either ask that finds the frame down cuts its backoff short, unless a frame is held.
        readyAsked(state, { wait }, transition) {
          // A light client that failed to start fails a wait at once until the next boot, which the backoff starts.
          if (state.held !== null) {
            transition.emitSideEffect({ kind: 'reject', waits: [wait], error: state.error });
            return;
          }
          const { config, captured } = state;
          leave(state, transition);
          boot({ config, loads: [], readies: [wait], held: null, failures: 0, captured }, transition);
        },
        transportAsked(state, { wait }, transition) {
          if (state.held !== null) {
            transition.emitSideEffect({ kind: 'resolve', waits: [wait], transport: state.held.transport });
            return;
          }
          const { config, captured } = state;
          leave(state, transition);
          boot({ config, loads: [wait], readies: [], held: null, failures: 0, captured }, transition);
        },
        configured: reconfigure,
        rebuildDue(state, _event, transition) {
          const { config, held, failures, captured } = state;
          leave(state, transition);
          boot({ config, loads: [], readies: [], held, failures, captured }, transition);
        },
        aliveChecked: checkFrame,
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
        listener(state.error);
        return noop;
      }
      return mismatchListeners.subscribe(listener);
    },
    checkAlive(transport) {
      machine.update({ kind: 'aliveChecked', transport });
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
      case 'stopWait':
        effect.stopWait();
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
        effect.transport?.dispose(effect.reason);
        effect.iframe.remove();
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
      machine.update({ kind: 'iframeFailed', iframe });
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
            machine.update({
              kind: 'frameFailed',
              iframe,
              thrown: error ?? new Error(PROTOCOL_ERRORS.FRAME_STATUS_ENDED),
            });
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
        // The provider drops what is not bytes before the transport sees it, so this is its only count.
        onNotBytes: wire.onNotBytes,
      }),
      handshake: 'offer',
      // The frame reads the resolution id from its URL, which it needs before any handshake.
      hello: { resolutionId: null },
      timers,
      timeoutMs: timeouts.handshakeMs,
      onIssue: wire.onIssue,
    });
  }

  function createIframe(config: ProtocolFrameConfig): E {
    const iframe = frameDocument.createElement('iframe');
    const params = new URLSearchParams();
    params.set('mode', FRAME_MODES[config.backend]);
    params.set('network', config.network);
    if (config.skipWorkerCache) {
      params.set('skipWorkerCache', '1');
    }
    // On the URL, not posted after load, because the iframe's Sentry client emits before any handshake.
    const resolutionId = getResolutionId();
    if (resolutionId !== null) {
      params.set('resolutionId', resolutionId);
    }
    const query = params.toString();
    // The build serves the frame at /p/ on its origin.
    iframe.src = query.length > 0 ? `${origin}/p/?${query}` : `${origin}/p/`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;';
    return iframe;
  }
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

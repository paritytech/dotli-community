// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The worker's ports, its close and whether every served tab asks for a pause. A port is served, released or forgotten
// here, and a dead worker closes here once every port heard why. Releasing a port, hearing one and closing the worker
// change each other, so one machine owns them.

import { createReporter, defineCount, spans as S } from '@dotli/metrics';
import {
  toFrameStatusEnd,
  ProtocolPortReleasedError,
  type FrameStatus,
  type FrameStatusSink,
  type ProtocolTransport,
  type SubscriptionEnd,
} from '@dotli/protocol';
import {
  createStateMachine,
  nest,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { err, type PortLike, type Sink } from '@dotli/transport';

import type { EngineScope } from './createEngine.js';
import { createIntervalTicker, type Ticker } from './createIntervalTicker.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { logWorkerEvent } from './logWorkerEvent.js';
import type { WorkerScope } from './startProtocolWorker.js';
import { WORKER_LOG_TAG } from './workerLogTag.js';

const report = createReporter({ flow: 'protocol' });

/**
 * One flush of buffered telemetry before a context closes. Counted only when the flush threw, tagged `outcome` and
 * `reason` (the error's name).
 */
const telemetryFlushMetric = defineCount<'error'>(S.TELEMETRY_FLUSH);
const workerLifecycleTransitionMetric = defineCount<'error'>('protocol.worker_lifecycle.transition');

/** A tab's port, as much of it as the worker uses. A `MessagePort` is one. */
export type WorkerPort = {
  /** Hears each message the tab posts on the port. Never throws. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Hears the tab's end of the port close, where the engine fires the event. Never throws. */
  addEventListener(type: 'close', listener: () => void): void;
  /** Stops hearing the tab's messages through `listener`. Never throws. */
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Stops hearing the port close through `listener`. Never throws. */
  removeEventListener(type: 'close', listener: () => void): void;
} & PortLike;

/** The worker's ports and close, as its factory builds them. */
export type WorkerLifecycle = ReturnType<typeof createWorkerLifecycle>;

/** A tab's `frame.beat` subscription. */
type BeatSink = Sink<undefined, SubscriptionEnd<undefined>>;

/** One tab's port the worker admitted, which names it to every other call of the lifecycle. */
export type PortSession = Readonly<{
  /** The tab's port. */
  port: WorkerPort;
  /** The port's transport, which serves the tab. */
  transport: ProtocolTransport;
}>;

type ServedPort = {
  kind: 'served';
  transport: ProtocolTransport;
  /** Stops hearing the tab speak and its end of the port close. */
  stopListening: () => void;
  /** Opened by the tab's first chain call. */
  scope: EngineScope | null;
  /** Beats since the port last sent anything. */
  missed: number;
  /** The tab's open `frame.beat` subscriptions, which each beat reaches. */
  beats: ReadonlySet<BeatSink>;
  /** The tab's open `frame.status` subscriptions, which a release ends before the transport goes. */
  statuses: ReadonlySet<FrameStatusSink>;
  /** Whether the tab asks the worker to pause its network. */
  paused: boolean;
  /** It subscribed to its status, so a close no longer waits for it. */
  heard: boolean;
};

/**
 * A frozen page's port queues what it is sent until the page thaws, and a port closed right after a post may drop it.
 * So a released port stays open until the beat after its tab speaks again, or until the worker closes.
 */
type ReleasedPort = {
  kind: 'released';
  stopListening: () => void;
  /** The tab spoke since the release, so the next beat closes the port. */
  spoke: boolean;
};

/** A closed port leaves the map. */
type Port = ServedPort | ReleasedPort | { kind: 'closed' };

type Live = {
  ports: ReadonlyMap<WorkerPort, ServedPort | ReleasedPort>;
  /** Kept as it was while no tab is served, so the last tab leaving changes nothing on the network. */
  everyTabPaused: boolean;
};

/** `reached` is set once a tab connected. The tab that starts the worker connects in a later task. */
type Starting = Live & { reached: boolean };

/** `error` is the first failure, which every later tab hears on subscribe. */
type Failed = Live & { error: Error };

/**
 * `failedAtStart` never closes, so a tab hears why. `awaitingTab` failed before the first tab connected, whose queued
 * connect a close would drop. `awaitingHeard` is flushed and waits for every served port to subscribe to its status.
 */
type LifecycleState =
  | ({ kind: 'syncing' } & Starting)
  | ({ kind: 'ready' } & Starting)
  | ({ kind: 'failedAtStart' } & Failed)
  | ({ kind: 'awaitingTab' } & Failed)
  | ({ kind: 'closeScheduled'; timer: unknown } & Failed)
  | ({ kind: 'flushing' } & Failed)
  | ({ kind: 'awaitingHeard' } & Failed)
  | { kind: 'closed' }
  | { kind: 'disposed' };

type LiveKind = Exclude<LifecycleState, { kind: 'closed' | 'disposed' }>['kind'];

type PortEvent = { port: WorkerPort };

type LifecycleEvent =
  | ({ kind: 'portConnected'; transport: ProtocolTransport } & PortEvent)
  | ({ kind: 'heard' } & PortEvent)
  | ({ kind: 'spoke' } & PortEvent)
  | ({ kind: 'portClosed' } & PortEvent)
  | ({ kind: 'statusSinkAdded'; sink: FrameStatusSink } & PortEvent)
  | ({ kind: 'statusSinkRemoved'; sink: FrameStatusSink } & PortEvent)
  | ({ kind: 'beatSinkAdded'; sink: BeatSink } & PortEvent)
  | ({ kind: 'beatSinkRemoved'; sink: BeatSink } & PortEvent)
  | ({ kind: 'pauseAsked'; paused: boolean } & PortEvent)
  | ({ kind: 'scopeOpened'; scope: EngineScope } & PortEvent)
  | { kind: 'portsChanged' }
  | { kind: 'beat' }
  | { kind: 'markedReady' }
  | { kind: 'failed'; error: Error }
  | { kind: 'closeDue' }
  | { kind: 'flushed' }
  | { kind: 'flushFailed'; error: unknown }
  | { kind: 'disposed' };

/** Each call-out is an effect of its own, so one that throws skips none of the others. */
type LifecycleEffect =
  | { kind: 'portConnected'; engine: 'syncing' | 'ready' | 'failed' }
  | { kind: 'portReleased' }
  | { kind: 'portClosed' }
  | { kind: 'releasedPortClosed' }
  | { kind: 'workerClosing'; ports: number }
  | { kind: 'flushFailed'; error: unknown }
  | { kind: 'everyTabPausedChanged'; paused: boolean }
  | { kind: 'statusReady' }
  | { kind: 'statusFailed'; error: Error }
  | { kind: 'statusEnded'; sink: FrameStatusSink; reason: Error }
  | { kind: 'transportDisposed'; transport: ProtocolTransport; reason: Error }
  | { kind: 'scopeClosed'; scope: EngineScope }
  | { kind: 'listeningStopped'; stopListening: () => void }
  | { kind: 'portShut'; port: WorkerPort }
  | { kind: 'beatSent'; sink: BeatSink }
  | { kind: 'heartbeatStopped' }
  | { kind: 'timerCleared'; timer: unknown }
  | { kind: 'workerClosed' };

type LifecycleMachine = MachineTypes<LifecycleState, LifecycleEvent, LifecycleEffect>;

type PortMachine = MachineTypes<Port, LifecycleEvent, LifecycleEffect>;

type EmitSideEffect = Transition<LifecycleMachine>['emitSideEffect'];

type Params = {
  /** The worker global, closed once a dead worker's ports all heard why. */
  scope: Pick<WorkerScope, 'close'>;
  /** What every port hears through its `frame.status` subscription. */
  status: Pick<FrameStatus, 'markReady' | 'fail'>;
  /**
   * Sends buffered telemetry before the worker closes. May reject. A rejection is captured, logged and counted, and the
   * close goes on.
   */
  flush: () => Promise<void>;
  /** Beats each port. Defaults to a 20 s interval. */
  startHeartbeat?: Ticker | undefined;
  /** Runs the zero-delay close, which a dispose clears. Defaults to the page's own timers. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'> | undefined;
  /** A failure the worker starts with, which every port hears on subscribe. */
  initialFailure: Error | null;
  /** Hears each change in whether every served tab asks for a pause. Never throws. */
  onEveryTabPausedChange: (paused: boolean) => void;
};

/**
 * A closed tab's port neither throws nor tells the worker, so the worker beats each port and lets go of a port it heard
 * nothing from for this many beats. Three beats of 20 s release a dead tab's connections within about a minute, and
 * leave a tab stuck in a long task two beats of slack.
 */
export const HEARTBEAT_MISSED_BEATS = 3;

/**
 * Owns the worker's port sessions and its close, tells whether every served tab asks for a pause, and starts the
 * heartbeat that beats each port.
 */
export function createWorkerLifecycle({
  scope,
  status,
  flush,
  startHeartbeat = createIntervalTicker(20_000),
  timers = realTimers,
  initialFailure,
  onEveryTabPausedChange,
}: Params) {
  /** Serves the port, not yet heard, and hears its tab speak and its end close until it is shut. */
  const connectPort: HandlerOf<LifecycleMachine, LiveKind, 'portConnected'> = (
    state,
    { port, transport },
    transition,
  ) => {
    const ports = new Map(state.ports).set(port, {
      kind: 'served',
      transport,
      stopListening: listenToPort(port, transition.update),
      scope: null,
      missed: 0,
      beats: new Set(),
      statuses: new Set(),
      paused: false,
      heard: false,
    });
    switch (state.kind) {
      case 'syncing':
      case 'ready':
        transition.emitState({ ...state, ports, reached: true });
        transition.emitSideEffect({ kind: 'portConnected', engine: state.kind });
        break;
      case 'awaitingTab':
        scheduleClose({ ...state, ports }, transition);
        transition.emitSideEffect({ kind: 'portConnected', engine: 'failed' });
        break;
      case 'failedAtStart':
      case 'closeScheduled':
      case 'flushing':
      case 'awaitingHeard':
        transition.emitState({ ...state, ports });
        transition.emitSideEffect({ kind: 'portConnected', engine: 'failed' });
        break;
    }
    transition.update({ kind: 'portsChanged' });
  };
  /** Latches the first failure. A later failure is only its symptom, and finds no handler. */
  const failWorker: HandlerOf<LifecycleMachine, 'syncing' | 'ready', 'failed'> = (
    { reached, ports, everyTabPaused },
    { error },
    transition,
  ) => {
    if (!reached) {
      // Closed now, the first tab's queued connect would never be served.
      transition.emitState({ kind: 'awaitingTab', ports, everyTabPaused, error });
    } else {
      scheduleClose({ ports, everyTabPaused, error }, transition);
    }
    transition.emitSideEffect({ kind: 'statusFailed', error });
  };
  /** Recomputes whether every served tab asks for a pause, and tells `onEveryTabPausedChange` when it changed. */
  const updateEveryTabPaused: HandlerOf<LifecycleMachine, LiveKind, 'portsChanged'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    const served = listServed(state.ports);
    if (served.length === 0) {
      return;
    }
    const everyTabPaused = served.every(({ paused }) => paused);
    if (everyTabPaused === state.everyTabPaused) {
      return;
    }
    emitState({ ...state, everyTabPaused });
    emitSideEffect({ kind: 'everyTabPausedChanged', paused: everyTabPaused });
  };
  /** Beats each port from this worker's clock, and lets go of one that sent nothing for too many beats. */
  const beatPorts: HandlerOf<LifecycleMachine, LiveKind, 'beat'> = (
    state,
    _event,
    { emitState, emitSideEffect, update },
  ) => {
    const ports = new Map<WorkerPort, ServedPort | ReleasedPort>();
    const releasing: ServedPort[] = [];
    for (const [port, held] of state.ports) {
      switch (held.kind) {
        case 'released':
          if (held.spoke) {
            shutPort(port, held, emitSideEffect);
          } else {
            ports.set(port, held);
          }
          break;
        case 'served': {
          const missed = held.missed + 1;
          if (missed <= HEARTBEAT_MISSED_BEATS) {
            ports.set(port, { ...held, missed });
            break;
          }
          ports.set(port, { kind: 'released', stopListening: held.stopListening, spoke: false });
          releasing.push(held);
          break;
        }
      }
    }
    emitState({ ...state, ports });
    // Each status ends with why, typed, before its transport goes, which posts nothing as it closes.
    for (const served of releasing) {
      const reason = new ProtocolPortReleasedError(PROTOCOL_APP_ERRORS.PORT_RELEASED);
      endServing(served, reason, emitSideEffect);
      emitSideEffect({ kind: 'portReleased' });
    }
    if (releasing.length > 0) {
      update({ kind: 'portsChanged' });
    }
    for (const { beats } of listServed(ports)) {
      for (const sink of beats) {
        emitSideEffect({ kind: 'beatSent', sink });
      }
    }
  };
  /**
   * Releases every served port and closes every released one at once, stops the heartbeat, and never closes the
   * worker.
   */
  const disposeLifecycle: HandlerOf<LifecycleMachine, LiveKind, 'disposed'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'disposed' });
    letGoOfEveryPort(state.ports, new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED), emitSideEffect);
    emitSideEffect({ kind: 'heartbeatStopped' });
  };
  const handlePort = nest<
    LifecycleMachine,
    LiveKind,
    PortMachine,
    | 'heard'
    | 'spoke'
    | 'portClosed'
    | 'statusSinkAdded'
    | 'statusSinkRemoved'
    | 'beatSinkAdded'
    | 'beatSinkRemoved'
    | 'pauseAsked'
    | 'scopeOpened'
  >({
    find: ({ ports }, { port }) => ports.get(port) ?? null,
    store(state, { port }, next) {
      const ports = new Map(state.ports);
      switch (next.kind) {
        case 'served':
        case 'released':
          ports.set(port, next);
          break;
        case 'closed':
          ports.delete(port);
          break;
      }
      return { ...state, ports };
    },
    handlers: {
      served: {
        heard(served, _event, { emitState, update }) {
          if (served.heard) {
            return;
          }
          emitState({ ...served, heard: true });
          update({ kind: 'portsChanged' });
        },
        spoke(served, _event, { emitState }) {
          if (served.missed === 0) {
            return;
          }
          emitState({ ...served, missed: 0 });
        },
        // The tab left, so nothing it was sent is still waited for, and its port closes at once instead of being held.
        portClosed(served, { port }, { emitState, emitSideEffect, update }) {
          emitState({ kind: 'closed' });
          emitSideEffect({ kind: 'portClosed' });
          update({ kind: 'portsChanged' });
          emitSideEffect({ kind: 'listeningStopped', stopListening: served.stopListening });
          emitSideEffect({
            kind: 'transportDisposed',
            transport: served.transport,
            reason: new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED),
          });
          if (served.scope !== null) {
            emitSideEffect({ kind: 'scopeClosed', scope: served.scope });
          }
          emitSideEffect({ kind: 'portShut', port });
        },
        statusSinkAdded(served, { sink }, { emitState }) {
          emitState({ ...served, statuses: new Set(served.statuses).add(sink) });
        },
        statusSinkRemoved(served, { sink }, { emitState }) {
          emitState({ ...served, statuses: toSetWithout(served.statuses, sink) });
        },
        beatSinkAdded(served, { sink }, { emitState }) {
          emitState({ ...served, beats: new Set(served.beats).add(sink) });
        },
        beatSinkRemoved(served, { sink }, { emitState }) {
          emitState({ ...served, beats: toSetWithout(served.beats, sink) });
        },
        pauseAsked(served, { paused }, { emitState, update }) {
          if (served.paused === paused) {
            return;
          }
          emitState({ ...served, paused });
          update({ kind: 'portsChanged' });
        },
        scopeOpened(served, { scope: opened }, { emitState }) {
          emitState({ ...served, scope: opened });
        },
      },
      released: {
        spoke(released, _event, { emitState }) {
          if (released.spoke) {
            return;
          }
          emitState({ ...released, spoke: true });
        },
        portClosed(released, { port }, { emitState, emitSideEffect }) {
          emitState({ kind: 'closed' });
          shutPort(port, released, emitSideEffect);
        },
        // Nothing else will close it.
        scopeOpened(_released, { scope: opened }, { emitSideEffect }) {
          emitSideEffect({ kind: 'scopeClosed', scope: opened });
        },
      },
      closed: null,
    },
  });
  const machine = createStateMachine<LifecycleMachine>({
    initial:
      initialFailure === null
        ? { kind: 'syncing', ports: new Map(), everyTabPaused: false, reached: false }
        : { kind: 'failedAtStart', ports: new Map(), everyTabPaused: false, error: initialFailure },
    handlers: {
      syncing: {
        markedReady(state, _event, { emitState, emitSideEffect }) {
          emitState({ ...state, kind: 'ready' });
          emitSideEffect({ kind: 'statusReady' });
        },
        failed: failWorker,
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged: updateEveryTabPaused,
        beat: beatPorts,
        disposed: disposeLifecycle,
      },
      ready: {
        failed: failWorker,
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged: updateEveryTabPaused,
        beat: beatPorts,
        disposed: disposeLifecycle,
      },
      failedAtStart: {
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged: updateEveryTabPaused,
        beat: beatPorts,
        disposed: disposeLifecycle,
      },
      awaitingTab: {
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged: updateEveryTabPaused,
        beat: beatPorts,
        disposed: disposeLifecycle,
      },
      closeScheduled: {
        // A worker has no page-hide flush, so the telemetry of the failure goes out before the close drops it.
        closeDue({ ports, everyTabPaused, error }, _event, { emitState, update }) {
          emitState({ kind: 'flushing', ports, everyTabPaused, error });
          update(
            flush().then(
              (): LifecycleEvent => ({ kind: 'flushed' }),
              (flushError: unknown): LifecycleEvent => ({ kind: 'flushFailed', error: flushError }),
            ),
          );
        },
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged: updateEveryTabPaused,
        beat: beatPorts,
        disposed(state, event, transition) {
          disposeLifecycle(state, event, transition);
          transition.emitSideEffect({ kind: 'timerCleared', timer: state.timer });
        },
      },
      flushing: {
        flushed(state, _event, transition) {
          closeOnceHeard(state, transition);
        },
        // A flush that fails still closes, after it is reported.
        flushFailed(state, { error }, transition) {
          transition.emitSideEffect({ kind: 'flushFailed', error });
          closeOnceHeard(state, transition);
        },
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged: updateEveryTabPaused,
        beat: beatPorts,
        disposed: disposeLifecycle,
      },
      awaitingHeard: {
        portConnected: connectPort,
        heard: handlePort,
        spoke: handlePort,
        portClosed: handlePort,
        statusSinkAdded: handlePort,
        statusSinkRemoved: handlePort,
        beatSinkAdded: handlePort,
        beatSinkRemoved: handlePort,
        pauseAsked: handlePort,
        scopeOpened: handlePort,
        portsChanged(state, event, transition) {
          updateEveryTabPaused(state, event, transition);
          if (!hasUnheard(state.ports)) {
            closeWorker(state, transition);
          }
        },
        beat: beatPorts,
        disposed: disposeLifecycle,
      },
      closed: null,
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'portConnected':
          logWorkerEvent('Port connected', { ports: countServed(machine.state.get()), engine: effect.engine });
          break;
        case 'portReleased':
          logWorkerEvent('Port released', { ports: countServed(machine.state.get()) });
          break;
        case 'portClosed':
          logWorkerEvent('Port closed', { ports: countServed(machine.state.get()) });
          break;
        case 'releasedPortClosed':
          logWorkerEvent('Released port closed', {
            released: [...(readLive(machine.state.get())?.ports.values() ?? [])].filter(
              held => held.kind === 'released',
            ).length,
          });
          break;
        case 'workerClosing':
          logWorkerEvent('Worker closing', { ports: effect.ports });
          break;
        case 'flushFailed':
          report.defect(effect.error, {
            step: 'worker_flush',
            metric: telemetryFlushMetric,
            message: `${WORKER_LOG_TAG} Telemetry flush failed`,
          });
          break;
        case 'everyTabPausedChanged':
          onEveryTabPausedChange(effect.paused);
          break;
        case 'statusReady':
          status.markReady();
          break;
        case 'statusFailed':
          status.fail(effect.error);
          break;
        case 'statusEnded':
          effect.sink.interrupt(err(toFrameStatusEnd(effect.reason)));
          break;
        case 'transportDisposed':
          effect.transport.dispose(effect.reason);
          break;
        case 'scopeClosed':
          effect.scope.close();
          break;
        case 'listeningStopped':
          effect.stopListening();
          break;
        case 'portShut':
          effect.port.close();
          break;
        case 'heartbeatStopped':
          stopHeartbeat();
          break;
        case 'timerCleared':
          timers.clearTimeout(effect.timer);
          break;
        case 'beatSent':
          effect.sink.send(undefined);
          break;
        case 'workerClosed':
          scope.close();
          break;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: workerLifecycleTransitionMetric,
        message: `${WORKER_LOG_TAG} A transition of the worker lifecycle failed:`,
      });
    },
  });

  if (initialFailure !== null) {
    status.fail(initialFailure);
  }
  const stopHeartbeat = startHeartbeat(() => {
    machine.update({ kind: 'beat' });
  });

  return {
    /** How many ports the worker serves. Never throws. */
    countPorts: (): number => countServed(machine.state.get()),
    /** Whether the worker is marked ready and has not failed, closed or been disposed since. */
    isReady: (): boolean => machine.state.get().kind === 'ready',
    /**
     * Serves a newly connected port until its tab goes silent or its end closes, and schedules the close of a dead
     * worker that waited for its first tab. Never throws.
     */
    admit({ port, transport }: PortSession): void {
      machine.update({ kind: 'portConnected', port, transport });
    },
    /** The port subscribed to its status, so a dead worker no longer waits for it to hear why. Never throws. */
    hear({ port }: PortSession): void {
      machine.update({ kind: 'heard', port });
    },
    /**
     * Notes whether the port's tab asks for a pause, and tells `onEveryTabPausedChange` when that changes whether every
     * served tab asks for one. Safe to repeat. Never throws.
     */
    markPaused({ port }: PortSession, paused: boolean): void {
      machine.update({ kind: 'pauseAsked', port, paused });
    },
    /**
     * Returns the served port's engine scope, opened through `open` on first use. Throws what `open` throws, and throws
     * when the port is no longer served, without calling `open`.
     */
    getScope({ port }: PortSession, open: () => EngineScope): EngineScope {
      const held = readLive(machine.state.get())?.ports.get(port);
      if (held?.kind !== 'served') {
        throw new Error('The port is no longer served');
      }
      if (held.scope !== null) {
        return held.scope;
      }
      const opened = open();
      machine.update({ kind: 'scopeOpened', port, scope: opened });
      return opened;
    },
    /** Adds a `frame.status` subscription a release ends, and returns its removal. Never throws. */
    addStatusSink({ port }: PortSession, sink: FrameStatusSink): () => void {
      machine.update({ kind: 'statusSinkAdded', port, sink });
      return () => {
        machine.update({ kind: 'statusSinkRemoved', port, sink });
      };
    },
    /** Adds a `frame.beat` subscription each beat reaches, and returns its removal. Never throws. */
    addBeatSink({ port }: PortSession, sink: BeatSink): () => void {
      machine.update({ kind: 'beatSinkAdded', port, sink });
      return () => {
        machine.update({ kind: 'beatSinkRemoved', port, sink });
      };
    },
    /** Marks the worker ready and tells every port. A failed worker stays failed. Never throws. */
    markReady(): void {
      machine.update({ kind: 'markedReady' });
    },
    /** Latches the first failure, tells every port and closes the worker. A later failure does nothing. Never throws. */
    fail(error: Error): void {
      machine.update({ kind: 'failed', error });
    },
    /**
     * Releases every served port and closes every released one at once, stops the heartbeat and clears a scheduled
     * close, and never closes the worker. Safe to call more than once and after the worker failed. Never throws. A
     * tab's status ends with the port closed, an end the port may drop as it closes at once, and nothing else open on
     * the port hears from the worker.
     */
    dispose(): void {
      machine.update({ kind: 'disposed' });
    },
  };

  /**
   * Closes the dead worker in a later task. A worker cannot see the connects queued for it, and a close drops them
   * unserved, so each queued connect runs first.
   */
  function scheduleClose(
    { ports, everyTabPaused, error }: Failed,
    { emitState, update }: Transition<LifecycleMachine>,
  ): void {
    const timer = timers.setTimeout(() => {
      update({ kind: 'closeDue' });
    }, 0);
    emitState({ kind: 'closeScheduled', timer, ports, everyTabPaused, error });
  }

  /**
   * Closes a flushed dead worker once no served port waits to subscribe to its status. A tab hears why only on
   * subscribe, a round trip after it connects, and a closed worker answers nothing.
   */
  function closeOnceHeard(failed: Failed, transition: Transition<LifecycleMachine>): void {
    const { ports, everyTabPaused, error } = failed;
    if (hasUnheard(ports)) {
      transition.emitState({ kind: 'awaitingHeard', ports, everyTabPaused, error });
      return;
    }
    closeWorker(failed, transition);
  }

  /**
   * Ends a worker whose light client is dead. A closing SharedWorker is never matched by name, so a later connect starts
   * a fresh light client instead of hearing this failure again.
   */
  function closeWorker({ ports, error }: Failed, { emitState, emitSideEffect }: Transition<LifecycleMachine>): void {
    emitState({ kind: 'closed' });
    emitSideEffect({ kind: 'workerClosing', ports: listServed(ports).length });
    emitSideEffect({ kind: 'heartbeatStopped' });
    // Each tab hears why everything still open on its port ended, before the worker goes.
    letGoOfEveryPort(ports, error, emitSideEffect);
    emitSideEffect({ kind: 'workerClosed' });
  }
}

/**
 * Hears any message on the port as its tab speaking, and the close of the tab's end, as when its page left for good,
 * crashed or was evicted, which no message tells. Engines that never fire the close fall back to the heartbeat release.
 * Returns the stop of both.
 */
function listenToPort(port: WorkerPort, update: Transition<LifecycleMachine>['update']): () => void {
  port.addEventListener('message', markSpoke);
  port.addEventListener('close', markClosed);
  return () => {
    port.removeEventListener('message', markSpoke);
    port.removeEventListener('close', markClosed);
  };

  function markSpoke(): void {
    update({ kind: 'spoke', port });
  }

  function markClosed(): void {
    update({ kind: 'portClosed', port });
  }
}

/** Releases every served port with `reason` and closes every port, each through its own effects. */
function letGoOfEveryPort(
  ports: ReadonlyMap<WorkerPort, ServedPort | ReleasedPort>,
  reason: Error,
  emitSideEffect: EmitSideEffect,
): void {
  for (const [port, held] of ports) {
    if (held.kind === 'served') {
      endServing(held, reason, emitSideEffect);
    }
    shutPort(port, held, emitSideEffect);
  }
}

/** Ends the status of a served port with `reason`, then disposes its transport and closes its scope. */
function endServing(served: ServedPort, reason: Error, emitSideEffect: EmitSideEffect): void {
  for (const sink of served.statuses) {
    emitSideEffect({ kind: 'statusEnded', sink, reason });
  }
  emitSideEffect({ kind: 'transportDisposed', transport: served.transport, reason });
  if (served.scope !== null) {
    emitSideEffect({ kind: 'scopeClosed', scope: served.scope });
  }
}

/** Stops hearing the port and closes it. */
function shutPort(port: WorkerPort, held: ServedPort | ReleasedPort, emitSideEffect: EmitSideEffect): void {
  emitSideEffect({ kind: 'listeningStopped', stopListening: held.stopListening });
  emitSideEffect({ kind: 'portShut', port });
  emitSideEffect({ kind: 'releasedPortClosed' });
}

function listServed(ports: ReadonlyMap<WorkerPort, ServedPort | ReleasedPort>): ServedPort[] {
  return [...ports.values()].filter(held => held.kind === 'served');
}

/** Whether a served port has not yet subscribed to its status. */
function hasUnheard(ports: ReadonlyMap<WorkerPort, ServedPort | ReleasedPort>): boolean {
  return listServed(ports).some(({ heard }) => !heard);
}

function toSetWithout<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(item);
  return next;
}

/** The ports and pause of a worker still open, or `null` once it closed or was disposed. */
function readLive(state: LifecycleState): Live | null {
  switch (state.kind) {
    case 'syncing':
    case 'ready':
    case 'failedAtStart':
    case 'awaitingTab':
    case 'closeScheduled':
    case 'flushing':
    case 'awaitingHeard':
      return state;
    case 'closed':
    case 'disposed':
      return null;
  }
}

function countServed(state: LifecycleState): number {
  return listServed(readLive(state)?.ports ?? new Map()).length;
}

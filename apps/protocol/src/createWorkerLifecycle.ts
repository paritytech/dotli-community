// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The worker's ports, its close and whether every served tab asks for a pause. A port is served, released or forgotten
// here, and a dead worker closes here once every port heard why. Releasing a port, hearing one and closing the worker
// call each other, so one unit owns them.

import { reportDefect, spans as S } from '@dotli/metrics';
import {
  toFrameStatusEnd,
  ProtocolPortReleasedError,
  type FrameStatus,
  type FrameStatusSink,
  type ProtocolTransport,
  type SubscriptionEnd,
} from '@dotli/protocol';
import { realTimers, type Timers } from '@dotli/shared';
import { err, type PortLike, type Sink } from '@dotli/transport';

import type { EngineScope } from './createEngine.js';
import { createIntervalTicker, type Ticker } from './createIntervalTicker.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { logWorkerEvent } from './logWorkerEvent.js';
import { WORKER_LOG_TAG } from './workerLogTag.js';

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

/** A tab's `frame.beat` subscription. */
type BeatSink = Sink<undefined, SubscriptionEnd<undefined>>;

/** One tab's port the worker serves, and what the tab holds on it, as the lifecycle's actions write it. */
type SessionRecord = {
  /** The tab's port. */
  port: WorkerPort;
  /** The port's transport, which serves the tab. */
  transport: ProtocolTransport;
  /** Opened by the tab's first chain call. */
  scope: EngineScope | null;
  /** Beats since the port last sent anything. */
  missed: number;
  /** The tab's open `frame.beat` subscriptions, which each beat reaches. */
  beats: Set<BeatSink>;
  /** The tab's open `frame.status` subscriptions, which a release ends before the transport goes. */
  statuses: Set<FrameStatusSink>;
  /** Stops hearing the port close. */
  unwatch: () => void;
  /** Whether the tab asks the worker to pause its network. */
  paused: boolean;
};

/**
 * One tab's port the worker serves, read-only to whoever `admit` hands it to. TypeScript lets a read-only object pass
 * where the writable record is taken, so the lifecycle's actions still write it.
 */
export type PortSession = Readonly<SessionRecord>;

type Params = {
  /** The worker global, closed once a dead worker's ports all heard why. */
  scope: { close: () => void };
  /** What every port hears through its `frame.status` subscription. */
  status: FrameStatus;
  /**
   * Sends buffered telemetry before the worker closes. May reject. A rejection is captured, logged and counted, and the
   * close goes on.
   */
  flush: () => Promise<void>;
  /** Beats each port. Defaults to a `HEARTBEAT_INTERVAL_MS` interval. */
  startHeartbeat?: Ticker | undefined;
  /** Runs the zero-delay close, which a dispose clears. Defaults to the page's own timers. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'> | undefined;
  /** A failure the worker starts with, which every port hears on subscribe. */
  initialFailure: Error | null;
  /** Hears each change in whether every served tab asks for a pause. Never throws. */
  onEveryTabPausedChange: (paused: boolean) => void;
};

type AdmitParams = {
  /** A tab's newly connected port. */
  port: WorkerPort;
  /** The port's transport, which serves the tab. */
  transport: ProtocolTransport;
  /** Stops hearing the port close. */
  unwatch: () => void;
  /** Registers the session's handlers on its transport. */
  serve: (session: PortSession) => void;
};

/** Where the worker stands. The first failure is the cause, and every later tab hears it on subscribe. */
type Phase = { readonly name: 'syncing' | 'ready' } | { readonly name: 'failed'; readonly error: Error };

/** A released port the worker still holds open. */
type ReleasedPort = {
  /** Stops listening on the port, closes it and lets go of it. Never throws. */
  close: () => void;
};

/**
 * A closed tab's port neither throws nor tells the worker, so the worker beats each port on this interval and lets go
 * of a port it heard nothing from for this many beats. Three beats of 20 s release a dead tab's connections within
 * about a minute, and leave a tab stuck in a long task two beats of slack.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_MISSED_BEATS = 3;

/**
 * Owns the worker's port sessions and its close, tells whether every served tab asks for a pause, and starts the
 * heartbeat that beats each port.
 */
export function createWorkerLifecycle({
  scope,
  status,
  flush,
  startHeartbeat = createIntervalTicker(HEARTBEAT_INTERVAL_MS),
  timers = realTimers,
  initialFailure,
  onEveryTabPausedChange,
}: Params) {
  const sessions = new Set<SessionRecord>();
  // A frozen page's port queues what it is sent until the page thaws, and a port closed right after a post may drop
  // it. So a released port stays open until the beat after its tab speaks again, or until the worker closes.
  const released = new Map<WorkerPort, ReleasedPort>();
  // Released ports whose tab spoke since the last beat, which the next beat closes.
  const spoke = new Set<WorkerPort>();
  // The tab that starts the worker connects in a later task, so a failure before then waits for it to close.
  let reached = false;
  // Owned by `closeDeadWorker`, `closeOnceHeard` and `dispose` alone, so however many failures ask for it the worker
  // closes once, and a disposed worker never does.
  let closing: 'none' | 'on_connect' | 'scheduled' | 'flushed' | 'closed' | 'disposed' = 'none';
  // The zero-delay close `closeDeadWorker` scheduled, which a dispose clears.
  let closeTimer: unknown = null;
  // Ports that connected and have not yet subscribed to their status.
  const unheard = new Set<SessionRecord>();
  let phase: Phase = { name: 'syncing' };
  // Kept as it was while no tab is served, so the last tab leaving changes nothing on the network.
  let everyTabPaused = false;

  if (initialFailure !== null) {
    phase = { name: 'failed', error: initialFailure };
    status.fail(initialFailure);
  }
  const stopHeartbeat = startHeartbeat(beat);

  return {
    /** The worker's current phase. Never throws. */
    getPhase: (): Phase => phase,
    /** How many ports the worker serves. Never throws. */
    countPorts: (): number => sessions.size,
    /**
     * Builds a newly connected port's session, serves it through `serve` and returns it, and closes a dead worker that
     * waited for its first tab. Throws what `serve` throws.
     */
    admit({ port, transport, unwatch, serve }: AdmitParams): PortSession {
      const session: SessionRecord = {
        port,
        transport,
        scope: null,
        missed: 0,
        beats: new Set(),
        statuses: new Set(),
        unwatch,
        paused: false,
      };
      reached = true;
      sessions.add(session);
      unheard.add(session);
      updateEveryTabPaused();
      serve(session);
      logWorkerEvent('Port connected', { ports: sessions.size, engine: phase.name });
      if (closing === 'on_connect') {
        closeDeadWorker();
      }
      return session;
    },
    /** The port subscribed to its status, so a dead worker no longer waits for it to hear why. Never throws. */
    hear,
    /** Notes that the port's tab sent something, so the heartbeat counts its missed beats from zero. Never throws. */
    markAlive(session: SessionRecord): void {
      session.missed = 0;
    },
    /**
     * Notes whether the port's tab asks for a pause, and tells `onEveryTabPausedChange` when that changes whether every
     * served tab asks for one. Safe to repeat. Never throws.
     */
    markPaused(session: SessionRecord, paused: boolean): void {
      session.paused = paused;
      updateEveryTabPaused();
    },
    /**
     * Whether every served tab asks for a pause, or, with none served, whether every tab did when the last one left.
     * False before any tab asks. Never throws.
     */
    isEveryTabPaused: (): boolean => everyTabPaused,
    /** Returns the session's engine scope, opened through `open` on first use. Throws what `open` throws. */
    getScope(session: SessionRecord, open: () => EngineScope): EngineScope {
      session.scope ??= open();
      return session.scope;
    },
    /** Adds a `frame.status` subscription a release ends, and returns its removal. Never throws. */
    addStatusSink(session: SessionRecord, sink: FrameStatusSink): () => void {
      session.statuses.add(sink);
      return () => {
        session.statuses.delete(sink);
      };
    },
    /** Adds a `frame.beat` subscription each beat reaches, and returns its removal. Never throws. */
    addBeatSink(session: SessionRecord, sink: BeatSink): () => void {
      session.beats.add(sink);
      return () => {
        session.beats.delete(sink);
      };
    },
    /**
     * Lets go of a port whose tab's end closed: forgets it while it is served, or closes it once released. Never
     * throws.
     */
    closePort(session: SessionRecord): void {
      if (sessions.has(session)) {
        forget(session);
      } else {
        released.get(session.port)?.close();
      }
    },
    /** Marks the worker ready and tells every port. A failed worker stays failed. Never throws. */
    markReady(): void {
      if (phase.name === 'failed') {
        return;
      }
      phase = { name: 'ready' };
      status.markReady();
    },
    /** Latches the first failure, tells every port and closes the worker. A later failure does nothing. Never throws. */
    fail,
    /**
     * Releases every served port and closes every released one at once, stops the heartbeat and clears a scheduled
     * close, and never closes the worker. Safe to call more than once and after the worker failed. Never throws. A
     * tab's status ends with the port closed, an end the port may drop as it closes at once, and nothing else open on
     * the port hears from the worker.
     */
    dispose,
  };

  function dispose(): void {
    // First, so neither a release below nor a flush that settles later closes the worker.
    closing = 'disposed';
    letGoOfEveryPort(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
    stopHeartbeat();
    timers.clearTimeout(closeTimer);
  }

  /**
   * Stops serving the port, once. Its status ends with why, typed, before its transport goes, which posts nothing as it
   * closes.
   */
  function release(session: SessionRecord, reason: Error): void {
    if (!sessions.delete(session)) {
      return;
    }
    const end = toFrameStatusEnd(reason);
    for (const sink of [...session.statuses]) {
      sink.interrupt(err(end));
    }
    session.transport.dispose(reason);
    session.scope?.close();
    holdReleased(session);
    hear(session);
    updateEveryTabPaused();
  }

  /**
   * Keeps a released port open until the beat after its tab sends anything, which it is no longer served for. A tab
   * that speaks may have done so before the release reached it, so the end posted at the release gets a beat to arrive.
   */
  function holdReleased({ port, unwatch }: SessionRecord): void {
    released.set(port, { close: closeReleased });
    port.addEventListener('message', markSpoke);

    function markSpoke(): void {
      spoke.add(port);
    }

    function stopListening(): void {
      port.removeEventListener('message', markSpoke);
    }

    function closeReleased(): void {
      stopListening();
      unwatch();
      released.delete(port);
      spoke.delete(port);
      port.close();
      logWorkerEvent('Released port closed', { released: released.size });
    }
  }

  /**
   * Lets go of a port whose tab left, as its port closing tells, so nothing it was sent is still waited for. Its port
   * closes at once instead of being held for a release.
   */
  function forget(session: SessionRecord): void {
    if (!sessions.delete(session)) {
      return;
    }
    session.unwatch();
    session.transport.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
    session.scope?.close();
    session.port.close();
    hear(session);
    logWorkerEvent('Port closed', { ports: sessions.size });
    updateEveryTabPaused();
  }

  /** Recomputes whether every served tab asks for a pause, and tells `onEveryTabPausedChange` when it changed. */
  function updateEveryTabPaused(): void {
    if (sessions.size === 0) {
      return;
    }
    const next = [...sessions].every(s => s.paused);
    if (next === everyTabPaused) {
      return;
    }
    everyTabPaused = next;
    onEveryTabPausedChange(next);
  }

  /** The port subscribed to its status, or is gone, so a close can no longer leave it waiting for why. */
  function hear(session: SessionRecord): void {
    if (unheard.delete(session)) {
      closeOnceHeard();
    }
  }

  /** Beats each port from this worker's clock, and lets go of one that sent nothing for too many beats. */
  function beat(): void {
    for (const port of [...spoke]) {
      released.get(port)?.close();
    }
    for (const session of [...sessions]) {
      session.missed += 1;
      if (session.missed > HEARTBEAT_MISSED_BEATS) {
        release(session, new ProtocolPortReleasedError(PROTOCOL_APP_ERRORS.PORT_RELEASED));
        logWorkerEvent('Port released', { ports: sessions.size });
        continue;
      }
      for (const sink of [...session.beats]) {
        sink.send(undefined);
      }
    }
  }

  /**
   * Ends a worker whose light client is dead, after every port heard why. A closing SharedWorker is never matched by
   * name, so a later connect starts a fresh light client instead of hearing this failure again.
   */
  function closeDeadWorker(): void {
    if (closing !== 'none' && closing !== 'on_connect') {
      return;
    }
    // Closed now, the first tab's queued connect would never be served.
    if (!reached) {
      closing = 'on_connect';
      return;
    }
    closing = 'scheduled';
    // A worker cannot see the connects queued for it, and a close drops them unserved. Closing in a later task lets
    // each queued connect run first. A worker has no page-hide flush, so the telemetry of the failure goes out before
    // the close drops it.
    closeTimer = timers.setTimeout(() => {
      // A flush that fails still closes, after it is reported.
      void flush().then(markFlushed, (error: unknown) => {
        reportDefect(error, {
          flow: 'protocol',
          step: 'worker_flush',
          metric: S.TELEMETRY_FLUSH,
          message: `${WORKER_LOG_TAG} Telemetry flush failed`,
        });
        markFlushed();
      });
    }, 0);

    // A flush that settles after a dispose closes nothing.
    function markFlushed(): void {
      if (closing !== 'scheduled') {
        return;
      }
      closing = 'flushed';
      closeOnceHeard();
    }
  }

  /**
   * Closes a flushed dead worker once no port waits to subscribe to its status. A tab hears why only on subscribe, a
   * round trip after it connects, and a closed worker answers nothing.
   */
  function closeOnceHeard(): void {
    if (closing !== 'flushed' || unheard.size > 0 || phase.name !== 'failed') {
      return;
    }
    closing = 'closed';
    logWorkerEvent('Worker closing', { ports: sessions.size });
    stopHeartbeat();
    // Each tab hears why everything still open on its port ended.
    letGoOfEveryPort(phase.error);
    scope.close();
  }

  /** Releases every served port with `reason` and closes every released one at once. */
  function letGoOfEveryPort(reason: Error): void {
    for (const session of [...sessions]) {
      release(session, reason);
    }
    for (const { close } of [...released.values()]) {
      close();
    }
  }

  /** Latches the first failure, tells every port and closes the worker. A later failure is only its symptom. */
  function fail(error: Error): void {
    if (phase.name === 'failed') {
      return;
    }
    phase = { name: 'failed', error };
    status.fail(error);
    closeDeadWorker();
  }
}

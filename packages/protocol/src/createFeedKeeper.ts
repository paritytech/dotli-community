// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the host holds on the frame there is now, and on each frame that boots or starts listening after it,
// for as long as it listens. The frame ends one only when it fails, so an end is reported and the feed reopened on the
// same transport. A transport that closes under the feed ends it for good, since the frame that owned it was lost and
// reported, and following the next one opens it again.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  getErrorName,
  log,
  nest,
  noop,
  setErrorName,
  toError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import type { FrameSubscriber } from './subscribe.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A feed the protocol frame ended while it stayed up, so the host reopens it after a backoff. Tagged `outcome` (error),
 * `feed` (shared_auth or telemetry) and `reason` (the error's name, `ProtocolFeedEndedError` for an end without one).
 */
const protocolFeedEndMetric = defineCount<'error'>('protocol.feed_end');

/** A feed keeper transition that threw. Tagged `outcome` (error) and `reason` (the error's name). */
const feedTransitionMetric = defineCount<'error'>('protocol.feed_transition');

export type FeedName = 'shared_auth' | 'telemetry';

/** How a held feed hears that the frame ended it, or that its transport closed under it. */
export type FeedEnds = Required<Pick<FrameSubscriber<unknown>, 'end' | 'close'>>;

/**
 * Subscribes the feed on one frame's transport, and returns its `unsubscribe`. Called again for each reopen on the same
 * transport.
 */
export type FeedOpen = (ends: FeedEnds) => () => void;

/** What a feed needs of the frame. */
export type FeedFrame<T> = {
  /** The transport of the frame there is now. Rejects when no frame can be reached. */
  getTransport(): Promise<T>;
} & Pick<ProtocolFrame, 'status'>;

type Params<T> = {
  feed: FeedName;
  frame: FeedFrame<T>;
  /**
   * Called once per transport the feed is held on, so state it keeps lives as long as that transport. Returns how the
   * feed is opened on it.
   */
  opener: (transport: T) => FeedOpen;
  /**
   * Whether `follow` asks for a transport even when the frame is down, which boots one. A feed that does not boot only
   * hears a frame there is.
   */
  boots: boolean;
  /** What a reopen waits on. */
  timers: Timers;
};

/** The feed held on one transport. Its events carry `id`, so those of a hold it replaced find nothing. */
type Hold<T> = { id: symbol; transport: T; reopen: Reopen };

/**
 * A hold's reopen loop. Each kind keeps how the feed is opened, `failures` counts the ends since it was last stable,
 * and `captured` is set once an end of the hold was captured, so a frame that keeps ending it does not flood the error
 * tracker.
 */
type Reopen =
  | { kind: 'open'; open: FeedOpen; unsubscribe: () => void; openedAt: number; failures: number; captured: boolean }
  | { kind: 'backingOff'; open: FeedOpen; timer: unknown; failures: number; captured: boolean };

type FeedState<T> =
  | { kind: 'stopped' }
  | { kind: 'waiting' }
  | { kind: 'asking'; ask: symbol }
  | { kind: 'holding'; hold: Hold<T> }
  | { kind: 'reasking'; hold: Hold<T>; ask: symbol };

type FeedEvent<T> =
  | { kind: 'followed' }
  | { kind: 'stopped' }
  | { kind: 'statusChanged'; status: ProtocolStatus }
  | { kind: 'transportAnswered'; ask: symbol; transport: T }
  | { kind: 'askFailed'; ask: symbol; error: unknown }
  | { kind: 'feedEnded'; holdId: symbol; error: Error | null }
  | { kind: 'feedClosed'; holdId: symbol }
  | { kind: 'reopenDue'; holdId: symbol };

type FeedEffect =
  | { kind: 'ask'; ask: symbol }
  | { kind: 'release'; reopen: Reopen }
  | { kind: 'feedEnded'; error: Error; capture: boolean }
  | { kind: 'askFailed'; error: unknown };

type FeedMachine<T> = MachineTypes<FeedState<T>, FeedEvent<T>, FeedEffect>;

type ReopenMachine<T> = MachineTypes<Reopen, FeedEvent<T>, FeedEffect>;

/** Holds `feed` on the frame there is now once asked to `follow`. Subscribes to the frame's status at once. */
export function createFeedKeeper<T>({ feed, frame, opener, boots, timers }: Params<T>) {
  /** Opens the feed of a hold. A refused open is an end, which waits to reopen. */
  function openFeed(
    holdId: symbol,
    { open, failures, captured }: Pick<Reopen, 'open' | 'failures' | 'captured'>,
    update: Transition<FeedMachine<T>>['update'],
  ): Reopen {
    const openedAt = timers.now();
    // An end or a close that `open` calls at once is queued, and runs once the hold is emitted.
    const ends: FeedEnds = {
      end(error) {
        update({ kind: 'feedEnded', holdId, error });
      },
      close() {
        update({ kind: 'feedClosed', holdId });
      },
    };
    let unsubscribe: () => void = noop;
    try {
      unsubscribe = open(ends);
    } catch (error: unknown) {
      ends.end(toError(error));
    }
    return { kind: 'open', open, unsubscribe, openedAt, failures, captured };
  }

  // A new frame relays nothing to a feed held on the one it replaces. A frame that starts listening may have replaced a
  // held one. An answer that a later ask overtook finds another token and is dropped.
  const followFrame: HandlerOf<FeedMachine<T>, 'waiting' | 'asking' | 'holding' | 'reasking', 'statusChanged'> = (
    state,
    { status },
    { emitState, emitSideEffect },
  ) => {
    if (status !== 'booting' && status !== 'listening') {
      return;
    }
    const ask = Symbol(`${feed} ask`);
    switch (state.kind) {
      case 'waiting':
      case 'asking':
        emitState({ kind: 'asking', ask });
        break;
      case 'holding':
      case 'reasking':
        emitState({ kind: 'reasking', hold: state.hold, ask });
        break;
    }
    emitSideEffect({ kind: 'ask', ask });
  };

  // A feed that already holds the transport it gets is left as it is. An opener that throws leaves the state as it was.
  const takeTransport: HandlerOf<FeedMachine<T>, 'asking' | 'reasking', 'transportAnswered'> = (
    state,
    { ask, transport },
    { emitState, emitSideEffect, update },
  ) => {
    if (ask !== state.ask) {
      return;
    }
    if (state.kind === 'reasking' && state.hold.transport === transport) {
      emitState({ kind: 'holding', hold: state.hold });
      return;
    }
    const id = Symbol(`${feed} hold`);
    const reopen = openFeed(id, { open: opener(transport), failures: 0, captured: false }, update);
    emitState({ kind: 'holding', hold: { id, transport, reopen } });
    // The old hold's late events carry its own id and find nothing, so the brief overlap is safe.
    if (state.kind === 'reasking') {
      emitSideEffect({ kind: 'release', reopen: state.hold.reopen });
    }
  };

  const failAsk: HandlerOf<FeedMachine<T>, 'asking' | 'reasking', 'askFailed'> = (
    state,
    { ask, error },
    { emitState, emitSideEffect },
  ) => {
    if (ask !== state.ask) {
      return;
    }
    emitState(state.kind === 'asking' ? { kind: 'waiting' } : { kind: 'holding', hold: state.hold });
    emitSideEffect({ kind: 'askFailed', error });
  };

  // The feed closed with its transport, so there is nothing to unsubscribe. An ask still out stays out.
  const leaveHold: HandlerOf<FeedMachine<T>, 'holding' | 'reasking', 'feedClosed'> = (
    state,
    { holdId },
    { emitState },
  ) => {
    if (holdId !== state.hold.id) {
      return;
    }
    emitState(state.kind === 'holding' ? { kind: 'waiting' } : { kind: 'asking', ask: state.ask });
  };

  const dropAsk: HandlerOf<FeedMachine<T>, 'waiting' | 'asking', 'stopped'> = (_state, _event, { emitState }) => {
    emitState({ kind: 'stopped' });
  };

  const dropHold: HandlerOf<FeedMachine<T>, 'holding' | 'reasking', 'stopped'> = (
    { hold },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'stopped' });
    emitSideEffect({ kind: 'release', reopen: hold.reopen });
  };

  const handleReopen = nest<FeedMachine<T>, 'holding' | 'reasking', ReopenMachine<T>, 'feedEnded' | 'reopenDue'>({
    find: ({ hold }, { holdId }) => (holdId === hold.id ? hold.reopen : null),
    store: (state, _event, reopen) => ({ ...state, hold: { ...state.hold, reopen } }),
    handlers: {
      open: {
        feedEnded({ open, openedAt, failures, captured }, { holdId, error }, { emitState, emitSideEffect, update }) {
          const ended = error ?? setErrorName(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
          // A feed open this long before it ended had recovered, so the waits start over.
          const before = timers.now() - openedAt >= 30_000 ? 0 : failures;
          const timer = timers.setTimeout(
            () => {
              update({ kind: 'reopenDue', holdId });
            },
            // The first wait is a second, and it doubles after each end on the same frame, up to 30 seconds.
            Math.min(1_000 * 2 ** before, 30_000),
          );
          emitState({ kind: 'backingOff', open, timer, failures: before + 1, captured: true });
          emitSideEffect({ kind: 'feedEnded', error: ended, capture: !captured });
        },
      },
      backingOff: {
        reopenDue(reopen, { holdId }, { emitState, update }) {
          emitState(openFeed(holdId, reopen, update));
        },
      },
    },
  });

  const keeper = createStateMachine<FeedMachine<T>>({
    initial: { kind: 'stopped' },
    handlers: {
      stopped: {
        followed(_state, _event, { emitState, emitSideEffect }) {
          if (!boots && !hasFrame(frame.status.get())) {
            emitState({ kind: 'waiting' });
            return;
          }
          const ask = Symbol(`${feed} ask`);
          emitState({ kind: 'asking', ask });
          emitSideEffect({ kind: 'ask', ask });
        },
      },
      waiting: {
        statusChanged: followFrame,
        stopped: dropAsk,
      },
      asking: {
        statusChanged: followFrame,
        transportAnswered: takeTransport,
        askFailed: failAsk,
        stopped: dropAsk,
      },
      holding: {
        statusChanged: followFrame,
        feedEnded: handleReopen,
        reopenDue: handleReopen,
        feedClosed: leaveHold,
        stopped: dropHold,
      },
      reasking: {
        statusChanged: followFrame,
        transportAnswered: takeTransport,
        askFailed: failAsk,
        feedEnded: handleReopen,
        reopenDue: handleReopen,
        feedClosed: leaveHold,
        stopped: dropHold,
      },
    },
    onEffect: runEffect,
    onError: error => {
      report.defect(error, {
        step: 'feed_transition',
        metric: feedTransitionMetric,
        message: '[dot.li protocol] A feed keeper transition threw',
      });
    },
  });

  frame.status.listen(status => {
    keeper.update({ kind: 'statusChanged', status });
  });

  return {
    /**
     * Holds the feed from now on, on the frame there is now and on each frame that boots or starts listening after it,
     * until `stop`. An answer to an ask for a frame's transport that a later ask overtook is dropped. A call while
     * following asks nothing.
     */
    follow(): void {
      keeper.update({ kind: 'followed' });
    },
    /** Unsubscribes the held feed, and drops a reopen that waits and an ask still out. */
    stop(): void {
      keeper.update({ kind: 'stopped' });
    },
  };

  function runEffect(effect: FeedEffect): void {
    switch (effect.kind) {
      case 'ask': {
        const { ask } = effect;
        keeper.update(
          frame.getTransport().then(
            (transport): FeedEvent<T> => ({ kind: 'transportAnswered', ask, transport }),
            (error: unknown): FeedEvent<T> => ({ kind: 'askFailed', ask, error }),
          ),
        );
        return;
      }
      case 'release':
        if (effect.reopen.kind === 'open') {
          effect.reopen.unsubscribe();
        } else {
          timers.clearTimeout(effect.reopen.timer);
        }
        return;
      case 'feedEnded':
        reportEnd(effect.error, effect.capture);
        return;
      case 'askFailed':
        // The frame reports its own loss and boot failure, and a config change that drops a frame is no failure.
        report.log.event('protocol feed ask failed', { feed, reason: getErrorName(effect.error) ?? 'unknown' });
        return;
    }
  }

  /** Counts and logs an end, and captures it when `capture` says so. */
  function reportEnd(error: Error, capture: boolean): void {
    const message = `[dot.li protocol] The frame ended the ${feed} feed, reopening it:`;
    const attributes = { feed };
    if (capture) {
      report.defect(error, { step: 'feed_end', tags: { feed }, attributes, metric: protocolFeedEndMetric, message });
      return;
    }
    log.error(message, error);
    protocolFeedEndMetric.count({ outcome: 'error', ...attributes, reason: getErrorName(error) ?? 'unknown' });
  }
}

/** A frame that is booting or up has a transport to hear. */
function hasFrame(status: ProtocolStatus): boolean {
  switch (status) {
    case 'booting':
    case 'listening':
    case 'ready':
      return true;
    case 'idle':
    case 'failed':
      return false;
  }
}

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
  nest,
  noop,
  toError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import { reportFeedEnd } from './reportFeedEnd.js';
import type { FrameSubscriber } from './subscribe.js';

const report = createReporter({ flow: 'protocol' });

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
  timers: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>;
};

/** The feed held on one transport. Its events carry `id`, so those of a hold it replaced find nothing. */
type Hold<T> = { id: symbol; transport: T; reopen: Reopen };

/**
 * A hold's reopen loop. Each kind keeps how the feed is opened, the stop of the subscription or of the wait it runs, and
 * `failures`, the ends since it was last stable.
 */
type Reopen =
  | { kind: 'open'; open: FeedOpen; stop: () => void; openedAt: number; failures: number }
  | { kind: 'backingOff'; open: FeedOpen; stop: () => void; failures: number };

type FeedState<T> =
  | { kind: 'stopped' }
  | { kind: 'waiting' }
  | { kind: 'asking'; ask: symbol }
  | { kind: 'holding'; hold: Hold<T> }
  | { kind: 'reasking'; hold: Hold<T>; ask: symbol };

type FeedEvent<T> =
  | { kind: 'followed'; status: ProtocolStatus }
  | { kind: 'stopped' }
  | { kind: 'statusChanged'; status: ProtocolStatus }
  | { kind: 'transportAnswered'; ask: symbol; transport: T }
  | { kind: 'askFailed'; ask: symbol; error: unknown }
  | { kind: 'feedEnded'; holdId: symbol; error: Error | null }
  | { kind: 'feedClosed'; holdId: symbol }
  | { kind: 'reopenDue'; holdId: symbol };

type FeedEffect =
  | { kind: 'ask'; ask: symbol }
  | { kind: 'release'; stop: () => void }
  | { kind: 'reportEnd'; error: Error | null; capture: boolean }
  | { kind: 'reportAskFailure'; error: unknown };

type FeedMachine<T> = MachineTypes<FeedState<T>, FeedEvent<T>, FeedEffect>;

type ReopenMachine<T> = MachineTypes<Reopen, FeedEvent<T>, FeedEffect>;

/** Holds `feed` on the frame there is now once asked to `follow`. Subscribes to the frame's status at once. */
export function createFeedKeeper<T>({ feed, frame, opener, boots, timers }: Params<T>) {
  /** Opens the feed of a hold. A refused open is an end, which waits to reopen. */
  function openFeed(
    holdId: symbol,
    { open, failures }: Pick<Reopen, 'open' | 'failures'>,
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
    try {
      return { kind: 'open', open, stop: open(ends), openedAt, failures };
    } catch (error: unknown) {
      ends.end(toError(error));
      return { kind: 'open', open, stop: noop, openedAt, failures };
    }
  }

  /** Holds the feed on `transport`, on a hold of its own. An opener that throws holds nothing. */
  function holdTransport(transport: T, update: Transition<FeedMachine<T>>['update']): Hold<T> {
    const id = Symbol(`${feed} hold`);
    return { id, transport, reopen: openFeed(id, { open: opener(transport), failures: 0 }, update) };
  }

  /** Asks for the transport of the frame there is now, keeping `hold` while the ask is out. */
  function askTransport(hold: Hold<T> | null, { emitState, emitSideEffect }: Transition<FeedMachine<T>>): void {
    const ask = Symbol(`${feed} ask`);
    emitState(hold === null ? { kind: 'asking', ask } : { kind: 'reasking', hold, ask });
    emitSideEffect({ kind: 'ask', ask });
  }

  // A new frame relays nothing to a feed held on the one it replaces. A frame that starts listening may have replaced a
  // held one.
  const followFrame: HandlerOf<FeedMachine<T>, 'waiting' | 'asking' | 'holding' | 'reasking', 'statusChanged'> = (
    state,
    { status },
    transition,
  ) => {
    if (status !== 'booting' && status !== 'listening') {
      return;
    }
    askTransport(state.kind === 'holding' || state.kind === 'reasking' ? state.hold : null, transition);
  };

  // A failure that a later ask overtook finds another token and is dropped.
  const failAsk: HandlerOf<FeedMachine<T>, 'asking' | 'reasking', 'askFailed'> = (
    state,
    { ask, error },
    { emitState, emitSideEffect },
  ) => {
    if (ask !== state.ask) {
      return;
    }
    emitState(state.kind === 'asking' ? { kind: 'waiting' } : { kind: 'holding', hold: state.hold });
    emitSideEffect({ kind: 'reportAskFailure', error });
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
    emitSideEffect({ kind: 'release', stop: hold.reopen.stop });
  };

  const handleReopen = nest<FeedMachine<T>, 'holding' | 'reasking', ReopenMachine<T>, 'feedEnded' | 'reopenDue'>({
    find: ({ hold }, { holdId }) => (holdId === hold.id ? hold.reopen : null),
    store: (state, _event, reopen) => ({ ...state, hold: { ...state.hold, reopen } }),
    handlers: {
      open: {
        feedEnded({ open, openedAt, failures }, { holdId, error }, { emitState, emitSideEffect, update }) {
          // A feed open this long before it ended had recovered, so the waits start over.
          const before = timers.now() - openedAt >= 30_000 ? 0 : failures;
          const timer = timers.setTimeout(
            () => {
              update({ kind: 'reopenDue', holdId });
            },
            // The first wait is a second, and it doubles after each end on the same frame, up to 30 seconds.
            Math.min(1_000 * 2 ** before, 30_000),
          );
          const stop = () => {
            timers.clearTimeout(timer);
          };
          emitState({ kind: 'backingOff', open, stop, failures: before + 1 });
          // Only a hold's first end is captured, so a frame that keeps ending it does not flood the error tracker.
          emitSideEffect({ kind: 'reportEnd', error, capture: failures === 0 });
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
        followed(_state, { status }, transition) {
          if (!boots && !hasFrame(status)) {
            transition.emitState({ kind: 'waiting' });
            return;
          }
          askTransport(null, transition);
        },
      },
      waiting: {
        statusChanged: followFrame,
        stopped: dropAsk,
      },
      asking: {
        statusChanged: followFrame,
        // An answer that a later ask overtook finds another token and is dropped. An opener that throws leaves the
        // state as it was.
        transportAnswered(state, { ask, transport }, { emitState, update }) {
          if (ask !== state.ask) {
            return;
          }
          emitState({ kind: 'holding', hold: holdTransport(transport, update) });
        },
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
        // A feed that already holds the transport it gets is left as it is.
        transportAnswered({ ask: current, hold }, { ask, transport }, { emitState, emitSideEffect, update }) {
          if (ask !== current) {
            return;
          }
          if (hold.transport === transport) {
            emitState({ kind: 'holding', hold });
            return;
          }
          emitState({ kind: 'holding', hold: holdTransport(transport, update) });
          // The old hold's late events carry its own id and find nothing, so the brief overlap is safe.
          emitSideEffect({ kind: 'release', stop: hold.reopen.stop });
        },
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
      keeper.update({ kind: 'followed', status: frame.status.get() });
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
        effect.stop();
        return;
      case 'reportEnd':
        reportFeedEnd({ feed, error: effect.error, capture: effect.capture });
        return;
      case 'reportAskFailure':
        // The frame reports its own loss and boot failure, and a config change that drops a frame is no failure.
        report.log.event('protocol feed ask failed', { feed, reason: getErrorName(effect.error) ?? 'unknown' });
        return;
    }
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

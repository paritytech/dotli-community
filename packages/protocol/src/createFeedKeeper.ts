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
  setErrorName,
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

type OpenFeedParams = {
  holdId: symbol;
  open: FeedOpen;
  failures: number;
};

type WaitToReopenParams = OpenFeedParams & {
  openedAt: number;
  error: unknown;
};

type ReportEndParams = {
  feed: FeedName;
  error: unknown;
  /** Set for the first end of a held feed only, so a frame that keeps ending it does not flood the error tracker. */
  capture: boolean;
};

/** The feed held on one transport. Its events carry `id`, so those of a hold it replaced find nothing. */
type Hold<T> = { id: symbol; transport: T; reopen: Reopen };

/**
 * A hold's reopen loop. Each kind keeps how the feed is opened, and `failures` counts the ends since it was last
 * stable.
 */
type Reopen =
  | { kind: 'open'; open: FeedOpen; unsubscribe: () => void; openedAt: number; failures: number }
  | { kind: 'backingOff'; open: FeedOpen; timer: unknown; failures: number };

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
  | { kind: 'reopenDue'; holdId: symbol }
  | { kind: 'holdClosed'; holdId: symbol };

type FeedEffect =
  { kind: 'holdStarted' } | { kind: 'feedEnded'; error: unknown } | { kind: 'askFailed'; error: unknown };

type FeedMachine<T> = MachineTypes<FeedState<T>, FeedEvent<T>, FeedEffect>;

type ReopenMachine<T> = MachineTypes<Reopen, FeedEvent<T>, FeedEffect>;

/** What a hold's feed sends through, the same in the keeper's transitions and in those of its reopen loop. */
type FeedSends<T> = Pick<Transition<FeedMachine<T>>, 'emitSideEffect' | 'update'>;

/** Holds `feed` on the frame there is now once asked to `follow`. Subscribes to the frame's status at once. */
export function createFeedKeeper<T>({ feed, frame, opener, boots, timers }: Params<T>) {
  /** Asks for the frame's transport. An answer that a later ask overtook finds another token and is dropped. */
  function askTransport(state: FeedState<T>, { emitState, update }: Transition<FeedMachine<T>>): void {
    const ask = Symbol(`${feed} ask`);
    switch (state.kind) {
      case 'stopped':
      case 'waiting':
      case 'asking':
        emitState({ kind: 'asking', ask });
        break;
      case 'holding':
      case 'reasking':
        emitState({ kind: 'reasking', hold: state.hold, ask });
        break;
    }
    update(
      frame.getTransport().then(
        (transport): FeedEvent<T> => ({ kind: 'transportAnswered', ask, transport }),
        (error: unknown): FeedEvent<T> => ({ kind: 'askFailed', ask, error }),
      ),
    );
  }

  /** Opens the feed of a hold and returns its reopen. A refused open is an end, which waits to reopen. */
  function openFeed(params: OpenFeedParams, sends: FeedSends<T>): Reopen {
    const { holdId, open, failures } = params;
    const openedAt = timers.now();
    try {
      // An end or a close that `open` calls at once is queued, and runs once the hold is emitted.
      const unsubscribe = open({
        end(error) {
          sends.update({ kind: 'feedEnded', holdId, error });
        },
        close() {
          sends.update({ kind: 'feedClosed', holdId });
        },
      });
      return { kind: 'open', open, unsubscribe, openedAt, failures };
    } catch (error: unknown) {
      return waitToReopen({ ...params, openedAt, error }, sends);
    }
  }

  /** Reports an end of a hold's feed, and returns the wait before its reopen, which starts over after a stable span. */
  function waitToReopen(
    { holdId, open, openedAt, failures, error }: WaitToReopenParams,
    { emitSideEffect, update }: FeedSends<T>,
  ): Reopen {
    emitSideEffect({ kind: 'feedEnded', error });
    // A feed open this long before it ended had recovered, so the waits start over.
    const stable = timers.now() - openedAt >= 30_000;
    const timer = timers.setTimeout(
      () => {
        update({ kind: 'reopenDue', holdId });
      },
      // The first wait is a second, and it doubles after each end on the same frame, up to 30 seconds.
      stable ? 1_000 : Math.min(1_000 * 2 ** failures, 30_000),
    );
    return { kind: 'backingOff', open, timer, failures: stable ? 0 : failures + 1 };
  }

  /** Ends a hold's feed, or the wait before it reopens. */
  function releaseHold({ reopen }: Hold<T>): void {
    switch (reopen.kind) {
      case 'open':
        reopen.unsubscribe();
        return;
      case 'backingOff':
        timers.clearTimeout(reopen.timer);
        return;
    }
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
    askTransport(state, transition);
  };

  // A feed that already holds the transport it gets is left as it is. An opener that throws leaves the state as it was.
  const takeTransport: HandlerOf<FeedMachine<T>, 'asking' | 'reasking', 'transportAnswered'> = (
    state,
    { ask, transport },
    transition,
  ) => {
    if (ask !== state.ask) {
      return;
    }
    if (state.kind === 'reasking' && state.hold.transport === transport) {
      transition.emitState({ kind: 'holding', hold: state.hold });
      return;
    }
    const open = opener(transport);
    transition.emitSideEffect({ kind: 'holdStarted' });
    const id = Symbol(`${feed} hold`);
    const reopen = openFeed({ holdId: id, open, failures: 0 }, transition);
    transition.emitState({ kind: 'holding', hold: { id, transport, reopen } });
    // The old hold's late events carry its own id and find nothing, so the brief overlap is safe.
    if (state.kind === 'reasking') {
      releaseHold(state.hold);
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
  const leaveHold: HandlerOf<FeedMachine<T>, 'holding' | 'reasking', 'holdClosed'> = (
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

  const dropHold: HandlerOf<FeedMachine<T>, 'holding' | 'reasking', 'stopped'> = ({ hold }, _event, { emitState }) => {
    emitState({ kind: 'stopped' });
    releaseHold(hold);
  };

  const handleReopen = nest<
    FeedMachine<T>,
    'holding' | 'reasking',
    ReopenMachine<T>,
    'feedEnded' | 'feedClosed' | 'reopenDue'
  >({
    find: ({ hold }, { holdId }) => (holdId === hold.id ? hold.reopen : null),
    store: (state, _event, reopen) => ({ ...state, hold: { ...state.hold, reopen } }),
    handlers: {
      open: {
        feedEnded({ open, openedAt, failures }, { holdId, error }, transition) {
          const ended = error ?? setErrorName(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
          transition.emitState(waitToReopen({ holdId, open, openedAt, failures, error: ended }, transition));
        },
        feedClosed(_reopen, { holdId }, { update }) {
          update({ kind: 'holdClosed', holdId });
        },
      },
      backingOff: {
        reopenDue({ open, failures }, { holdId }, transition) {
          transition.emitState(openFeed({ holdId, open, failures }, transition));
        },
      },
    },
  });

  // Whether the current hold captured an end, so a frame that keeps ending it does not flood the error tracker.
  let captured = false;

  const keeper = createStateMachine<FeedMachine<T>>({
    initial: { kind: 'stopped' },
    handlers: {
      stopped: {
        followed(state, _event, transition) {
          if (!boots && !hasFrame(frame.status.get())) {
            transition.emitState({ kind: 'waiting' });
            return;
          }
          askTransport(state, transition);
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
        feedClosed: handleReopen,
        reopenDue: handleReopen,
        holdClosed: leaveHold,
        stopped: dropHold,
      },
      reasking: {
        statusChanged: followFrame,
        transportAnswered: takeTransport,
        askFailed: failAsk,
        feedEnded: handleReopen,
        feedClosed: handleReopen,
        reopenDue: handleReopen,
        holdClosed: leaveHold,
        stopped: dropHold,
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'holdStarted':
          captured = false;
          return;
        case 'feedEnded':
          reportEnd({ feed, error: effect.error, capture: !captured });
          captured = true;
          return;
        case 'askFailed':
          // The frame reports its own loss and boot failure, and a config change that drops a frame is no failure.
          report.log.event('protocol feed ask failed', { feed, reason: getErrorName(effect.error) ?? 'unknown' });
          return;
      }
    },
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

/** Counts and logs each end, and captures it when `capture` says so. */
function reportEnd({ feed, error, capture }: ReportEndParams): void {
  const message = `[dot.li protocol] The frame ended the ${feed} feed, reopening it:`;
  const attributes = { feed };
  if (capture) {
    report.defect(error, {
      step: 'feed_end',
      tags: { feed },
      attributes,
      metric: protocolFeedEndMetric,
      message,
    });
    return;
  }
  log.error(message, error);
  protocolFeedEndMetric.count({ outcome: 'error', ...attributes, reason: getErrorName(error) ?? 'unknown' });
}

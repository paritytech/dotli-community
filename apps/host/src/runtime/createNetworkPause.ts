// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A hidden page keeps its network for a grace, so a quick look at another tab costs no reconnect. A visible page's
// timers stop while the device sleeps, so a tick that comes late reads as a return too.

import type { ChainPoolControl } from '@dotli/chains';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createListenerSet,
  createSharedRun,
  createStateMachine,
  listen,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
  type VisibilitySource,
} from '@dotli/shared';
import { pagePoll, type Poll } from '../pagePoll.js';

const report = createReporter({ flow: 'protocol' });
const networkPauseTransitionMetric = defineCount<'error'>('network_pause.transition');

type Params = {
  /** The clock and timers the grace runs on. The page's own unless given. */
  timers?: Pick<Timers, 'now' | 'setTimeout'>;
  /** The tick the sleep check runs on. The page's own unless given. */
  poll?: Poll;
};

type FollowedPage = { source: VisibilitySource; stopListening: () => void };

/** `hidden` is a hidden page kept awake by a hold. `grace` and `paused` are a hidden page with no hold. */
type PauseState =
  | { kind: 'unfollowed' }
  | { kind: 'visible'; page: FollowedPage; stopTick: () => void; lastTickAt: number }
  | { kind: 'hidden'; page: FollowedPage }
  | { kind: 'grace'; page: FollowedPage }
  | { kind: 'paused'; page: FollowedPage };

type GraceState = Extract<PauseState, { kind: 'grace' }>;

type PauseEvent =
  | { kind: 'followed'; source: VisibilitySource }
  | { kind: 'unfollowed' }
  | { kind: 'shown' }
  | { kind: 'hid' }
  | { kind: 'holdChanged' }
  | { kind: 'graceEnded'; grace: GraceState }
  | { kind: 'ticked'; at: number };

type PauseEffect = { kind: 'paused' } | { kind: 'resumed' } | { kind: 'returned' };

type PauseMachine = MachineTypes<PauseState, PauseEvent, PauseEffect>;

/** The page's network pause, as its factory builds it. */
export type NetworkPause = ReturnType<typeof createNetworkPause>;

export const NETWORK_PAUSE_GRACE_MS = 60_000;

const SLEEP_TICK_MS = 10_000;

/** The page's network pause: a grace after the page hides, holds that keep it awake, and a check for a sleep. */
export function createNetworkPause({ timers = realTimers, poll = pagePoll }: Params = {}) {
  // Read when a `holdChanged` is handled, not sent, so a hold taken and released while the machine is busy nets out.
  let held = false;
  const targets = new Set<ChainPoolControl>();
  const returns = createListenerSet<undefined>({ onListenerError: report.listener('network_pause.return') });
  /** Moves a hidden page that shows again to `visible`. A paused network resumes before the return is told. */
  const returnToPage: HandlerOf<PauseMachine, 'hidden' | 'grace' | 'paused', 'shown'> = (state, _event, transition) => {
    enterVisible(state.page, transition);
    if (state.kind === 'paused') {
      transition.emitSideEffect({ kind: 'resumed' });
    }
    transition.emitSideEffect({ kind: 'returned' });
  };
  /** Stops following the page, and resumes the network if it is paused. */
  const stopFollowing: HandlerOf<PauseMachine, 'visible' | 'hidden' | 'grace' | 'paused', 'unfollowed'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'unfollowed' });
    state.page.stopListening();
    switch (state.kind) {
      case 'visible':
        state.stopTick();
        return;
      case 'paused':
        emitSideEffect({ kind: 'resumed' });
        return;
      case 'hidden':
      case 'grace':
        return;
    }
  };
  const pause = createStateMachine<PauseMachine>({
    initial: { kind: 'unfollowed' },
    handlers: {
      unfollowed: {
        followed(_state, { source }, transition) {
          const stopListening = listen({
            target: source,
            type: 'visibilitychange',
            handler: () => {
              transition.update({ kind: source.visibilityState === 'visible' ? 'shown' : 'hid' });
            },
          });
          const page = { source, stopListening };
          if (source.visibilityState === 'visible') {
            enterVisible(page, transition);
            return;
          }
          hidePage(page, transition);
        },
      },
      visible: {
        hid({ page, stopTick }, _event, transition) {
          hidePage(page, transition);
          stopTick();
        },
        ticked(state, { at }, { emitState, emitSideEffect }) {
          emitState({ ...state, lastTickAt: at });
          // A busy page's timer runs late without any sleep, so only a tick later than that slack reads as a return.
          if (at - state.lastTickAt > SLEEP_TICK_MS + 30_000) {
            emitSideEffect({ kind: 'returned' });
          }
        },
        unfollowed: stopFollowing,
      },
      hidden: {
        holdChanged({ page }, _event, transition) {
          if (held) {
            return;
          }
          enterGrace(page, transition);
        },
        shown: returnToPage,
        unfollowed: stopFollowing,
      },
      grace: {
        holdChanged({ page }, _event, { emitState }) {
          if (!held) {
            return;
          }
          emitState({ kind: 'hidden', page });
        },
        graceEnded(state, { grace }, transition) {
          // A timer from a grace that was left ends nothing.
          if (grace !== state) {
            return;
          }
          // A frozen page fires its timer late, and may be visible by then with its event still to come.
          if (state.page.source.visibilityState === 'visible') {
            returnToPage(state, { kind: 'shown' }, transition);
            return;
          }
          transition.emitState({ kind: 'paused', page: state.page });
          transition.emitSideEffect({ kind: 'paused' });
        },
        shown: returnToPage,
        unfollowed: stopFollowing,
      },
      paused: {
        holdChanged({ page }, _event, { emitState, emitSideEffect }) {
          if (!held) {
            return;
          }
          emitState({ kind: 'hidden', page });
          emitSideEffect({ kind: 'resumed' });
        },
        shown: returnToPage,
        unfollowed: stopFollowing,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'paused':
          report.log.event('Network paused');
          tellTargets('pause');
          return;
        case 'resumed':
          report.log.event('Network resumed');
          tellTargets('resume');
          return;
        case 'returned':
          returns.emit(undefined);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: networkPauseTransitionMetric,
        message: '[dot.li] A network pause transition threw',
      });
    },
  });
  const following = createSharedRun<VisibilitySource>({
    begin: source => {
      pause.update({ kind: 'followed', source });
      return () => {
        pause.update({ kind: 'unfollowed' });
      };
    },
  });
  const holds = createSharedRun({
    begin: () => {
      held = true;
      pause.update({ kind: 'holdChanged' });
      return () => {
        held = false;
        pause.update({ kind: 'holdChanged' });
      };
    },
  });

  return {
    /**
     * Follows `visibility` for the page's life, from its state now. A second call joins the first. Returns the stop,
     * which resumes the network if it is paused. Never throws.
     */
    start: following.join,
    /** Pauses `target` at once when a pause is in force, and tells it every change after. Returns its removal. Never throws. */
    addTarget,
    /** Keeps the network awake until the returned release, which acts once. Never throws. */
    hold: holds.join,
    /** Hears each return to the page, from hiding or from a sleep. Returns the removal. Never throws. */
    onReturn: returns.subscribe,
  };

  function addTarget(target: ChainPoolControl): () => void {
    targets.add(target);
    // A target runs until told otherwise, so only a pause in force is news to it.
    if (pause.state.get().kind === 'paused') {
      target.pause();
    }
    return () => {
      targets.delete(target);
    };
  }

  /** Starts the sleep check's tick and moves to `visible`. */
  function enterVisible(page: FollowedPage, { emitState, update }: Transition<PauseMachine>): void {
    const stopTick = poll.start(() => {
      update({ kind: 'ticked', at: timers.now() });
    }, SLEEP_TICK_MS);
    emitState({ kind: 'visible', page, stopTick, lastTickAt: timers.now() });
  }

  /** Moves a page that just hid to `hidden` while a hold keeps it awake, and to its grace otherwise. */
  function hidePage(page: FollowedPage, transition: Transition<PauseMachine>): void {
    if (held) {
      transition.emitState({ kind: 'hidden', page });
      return;
    }
    enterGrace(page, transition);
  }

  /** Moves to a new grace, whose timer ends that grace only. */
  function enterGrace(page: FollowedPage, { emitState, update }: Transition<PauseMachine>): void {
    const grace: GraceState = { kind: 'grace', page };
    emitState(grace);
    timers.setTimeout(() => {
      update({ kind: 'graceEnded', grace });
    }, NETWORK_PAUSE_GRACE_MS);
  }

  /**
   * Tells the targets of the moment the change. One removed while an earlier one hears it is told nothing more, and one
   * added then hears only what its addition told it.
   */
  function tellTargets(change: keyof ChainPoolControl): void {
    for (const target of [...targets]) {
      if (targets.has(target)) {
        target[change]();
      }
    }
  }
}

/** The page's. */
export const networkPause = createNetworkPause();

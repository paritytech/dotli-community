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

type StartParams = {
  /** The page whose visibility drives the pause, the browser's document unless given. */
  visibility?: VisibilitySource;
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
  | { kind: 'visibilityChanged' }
  | { kind: 'holdChanged' }
  | { kind: 'graceEnded'; grace: GraceState }
  | { kind: 'ticked' };

type PauseEffect = { kind: 'paused' } | { kind: 'resumed' };

type PauseMachine = MachineTypes<PauseState, PauseEvent, PauseEffect>;

/** The page's network pause, as its factory builds it. */
export type NetworkPause = ReturnType<typeof createNetworkPause>;

export const NETWORK_PAUSE_GRACE_MS = 60_000;

const SLEEP_TICK_MS = 10_000;

/** The page's network pause: a grace after the page hides, holds that keep it awake, and a check for a sleep. */
export function createNetworkPause({ timers = realTimers, poll = pagePoll }: Params = {}) {
  let held = false;
  const targets = new Set<ChainPoolControl>();
  const returns = createListenerSet<undefined>({ onListenerError: report.listener('network_pause.return') });
  /** Hears a hidden page shown again as a return to it. */
  const detectReturn: HandlerOf<PauseMachine, 'hidden' | 'grace' | 'paused', 'visibilityChanged'> = (
    state,
    _event,
    transition,
  ) => {
    if (state.page.source.visibilityState !== 'visible') {
      return;
    }
    returnToPage(state, transition);
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
        tellTargets('resume');
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
              transition.update({ kind: 'visibilityChanged' });
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
        visibilityChanged({ page, stopTick }, _event, transition) {
          // A page whose grace already found it visible hears its late `visibilitychange` as no return.
          if (page.source.visibilityState === 'visible') {
            return;
          }
          stopTick();
          hidePage(page, transition);
        },
        ticked(state, _event, { emitState }) {
          const now = timers.now();
          emitState({ ...state, lastTickAt: now });
          // A busy page's timer runs late without any sleep, so only a tick later than that slack reads as a return.
          if (now - state.lastTickAt > SLEEP_TICK_MS + 30_000) {
            returns.emit(undefined);
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
        visibilityChanged: detectReturn,
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
            returnToPage(state, transition);
            return;
          }
          transition.emitState({ kind: 'paused', page: state.page });
          tellTargets('pause');
          transition.emitSideEffect({ kind: 'paused' });
        },
        visibilityChanged: detectReturn,
        unfollowed: stopFollowing,
      },
      paused: {
        holdChanged({ page }, _event, { emitState, emitSideEffect }) {
          if (!held) {
            return;
          }
          emitState({ kind: 'hidden', page });
          tellTargets('resume');
          emitSideEffect({ kind: 'resumed' });
        },
        visibilityChanged: detectReturn,
        unfollowed: stopFollowing,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'paused':
          report.log.event('Network paused');
          return;
        case 'resumed':
          report.log.event('Network resumed');
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
    start,
    /** Pauses `target` at once when a pause is in force, and tells it every change after. Returns its removal. Never throws. */
    addTarget,
    /** Keeps the network awake until the returned release, which acts once. Never throws. */
    hold,
    /** Hears each return to the page, from hiding or from a sleep. Returns the removal. Never throws. */
    onReturn,
  };

  function start({ visibility = document }: StartParams = {}): () => void {
    return following.join(visibility);
  }

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

  function hold(): () => void {
    return holds.join();
  }

  function onReturn(listener: () => void): () => void {
    return returns.subscribe(listener);
  }

  /** Starts the sleep check's tick and moves to `visible`. */
  function enterVisible(page: FollowedPage, { emitState, update }: Transition<PauseMachine>): void {
    const stopTick = poll.start(() => {
      update({ kind: 'ticked' });
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

  /** Moves a hidden page that shows again to `visible`. A paused network resumes before the return is told. */
  function returnToPage(
    state: Extract<PauseState, { kind: 'hidden' | 'grace' | 'paused' }>,
    transition: Transition<PauseMachine>,
  ): void {
    enterVisible(state.page, transition);
    // A target that throws on resume still leaves the page resumed and the return told. The throw goes on to `onError`.
    try {
      if (state.kind === 'paused') {
        tellTargets('resume');
        transition.emitSideEffect({ kind: 'resumed' });
      }
    } finally {
      returns.emit(undefined);
    }
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

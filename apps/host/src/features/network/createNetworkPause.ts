// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A hidden page keeps its network for a grace, so a quick look at another tab costs no reconnect.

import type { ChainPoolControl } from '@dotli/chains';
import { createReporter, defineCount } from '@dotli/metrics';
import {
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

const report = createReporter({ flow: 'protocol' });
const networkPauseTransitionMetric = defineCount<'error'>('network_pause.transition');

type Params = {
  /** The clock and timers the grace runs on. The page's own unless given. */
  timers?: Pick<Timers, 'now' | 'setTimeout'>;
};

type FollowedPage = { source: VisibilitySource; stopListening: () => void };

/** `hidden` is a hidden page kept awake by a hold. `grace` and `paused` are a hidden page with no hold. */
type PauseState =
  | { kind: 'unfollowed' }
  | { kind: 'visible'; page: FollowedPage }
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
  | { kind: 'graceEnded'; grace: GraceState };

type PauseEffect = { kind: 'paused' } | { kind: 'resumed' };

type PauseMachine = MachineTypes<PauseState, PauseEvent, PauseEffect>;

/** The page's network pause, as its factory builds it. */
export type NetworkPause = ReturnType<typeof createNetworkPause>;

export const NETWORK_PAUSE_GRACE_MS = 60_000;

/** The page's network pause: a grace after the page hides, and holds that keep it awake. */
export function createNetworkPause({ timers = realTimers }: Params = {}) {
  // Read when a `holdChanged` is handled, not sent, so a hold taken and released while the machine is busy nets out.
  let held = false;
  const targets = new Set<ChainPoolControl>();
  /** Moves a hidden page that shows again to `visible`, and resumes a paused network. */
  const returnToPage: HandlerOf<PauseMachine, 'hidden' | 'grace' | 'paused', 'shown'> = (state, _event, transition) => {
    enterVisible(state.page, transition);
    if (state.kind === 'paused') {
      transition.emitSideEffect({ kind: 'resumed' });
    }
  };
  /** Stops following the page, and resumes the network if it is paused. */
  const stopFollowing: HandlerOf<PauseMachine, 'visible' | 'hidden' | 'grace' | 'paused', 'unfollowed'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'unfollowed' });
    state.page.stopListening();
    if (state.kind === 'paused') {
      emitSideEffect({ kind: 'resumed' });
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
        hid({ page }, _event, transition) {
          hidePage(page, transition);
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

  function enterVisible(page: FollowedPage, { emitState }: Transition<PauseMachine>): void {
    emitState({ kind: 'visible', page });
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

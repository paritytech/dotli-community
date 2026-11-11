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
  type MachineTypes,
  type Timers,
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

type PauseState = { kind: 'awake' } | { kind: 'grace' } | { kind: 'paused' };
type GraceState = Extract<PauseState, { kind: 'grace' }>;
type PauseEvent = { kind: 'networkWantChanged' } | { kind: 'graceEnded'; grace: GraceState };

/** The page's network pause, as its factory builds it. */
export type NetworkPause = ReturnType<typeof createNetworkPause>;

export const NETWORK_PAUSE_GRACE_MS = 60_000;

const SLEEP_TICK_MS = 10_000;
/** How late a tick may come before the page counts as having slept. */
const SLEEP_SLACK_MS = 30_000;

/** The page's network pause: a grace after the page hides, holds that keep it awake, and a check for a sleep. */
export function createNetworkPause({ timers = realTimers, poll = pagePoll }: Params = {}) {
  /** The page followed since `start`, none before it. */
  let page: VisibilitySource | null = null;
  let held = false;
  /** Set while the page is followed as visible. */
  let stopTick: (() => void) | null = null;
  let lastTickAt = 0;
  const targets = new Set<ChainPoolControl>();
  const returns = createListenerSet<undefined>({ onListenerError: report.listener('network_pause.return') });
  const pause = createStateMachine<MachineTypes<PauseState, PauseEvent>>({
    initial: { kind: 'awake' },
    handlers: {
      awake: {
        networkWantChanged(_state, _event, { emitState }) {
          if (isNetworkWanted()) {
            return;
          }
          const grace: GraceState = { kind: 'grace' };
          emitState(grace);
          timers.setTimeout(() => {
            pause.update({ kind: 'graceEnded', grace });
          }, NETWORK_PAUSE_GRACE_MS);
        },
      },
      grace: {
        networkWantChanged(_state, _event, { emitState }) {
          if (isNetworkWanted()) {
            emitState({ kind: 'awake' });
          }
        },
        graceEnded(state, event, { emitState }) {
          // A timer from a grace that was left ends nothing.
          if (event.grace !== state) {
            return;
          }
          if (!isNetworkWanted()) {
            emitState({ kind: 'paused' });
            tellTargets('pause');
            report.log.event('Network paused');
            return;
          }
          emitState({ kind: 'awake' });
          // A frozen page fires its timer late, and may be visible by then with its event still to come.
          if (page?.visibilityState === 'visible') {
            returnToPage();
          }
        },
      },
      paused: {
        networkWantChanged(_state, _event, { emitState }) {
          if (!isNetworkWanted()) {
            return;
          }
          emitState({ kind: 'awake' });
          tellTargets('resume');
          report.log.event('Network resumed');
        },
      },
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: networkPauseTransitionMetric,
        message: '[dot.li] A network pause transition threw',
      });
    },
  });
  const following = createSharedRun<VisibilitySource>({ begin: beginFollowing });
  const holds = createSharedRun({ begin: beginHold });

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

  function beginFollowing(visibility: VisibilitySource): () => void {
    page = visibility;
    const stopListening = listen({ target: visibility, type: 'visibilitychange', handler: judgeVisibility });
    if (visibility.visibilityState === 'visible') {
      startTick();
    } else {
      pause.update({ kind: 'networkWantChanged' });
    }
    return stopFollowing;

    function stopFollowing(): void {
      stopListening();
      stopSleepCheck();
      page = null;
      pause.update({ kind: 'networkWantChanged' });
    }
  }

  function judgeVisibility(): void {
    if (page?.visibilityState === 'visible') {
      returnToPage();
      return;
    }
    stopSleepCheck();
    pause.update({ kind: 'networkWantChanged' });
  }

  function returnToPage(): void {
    // A page whose grace already found it visible hears its late `visibilitychange` as no return.
    if (stopTick !== null) {
      return;
    }
    pause.update({ kind: 'networkWantChanged' });
    startTick();
    returns.emit(undefined);
  }

  function beginHold(): () => void {
    held = true;
    pause.update({ kind: 'networkWantChanged' });
    return releaseHolds;
  }

  function releaseHolds(): void {
    held = false;
    pause.update({ kind: 'networkWantChanged' });
  }

  /** Reads the hold and the page afresh. */
  function isNetworkWanted(): boolean {
    return held || page === null || page.visibilityState === 'visible';
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

  function startTick(): void {
    lastTickAt = timers.now();
    stopTick = poll.start(checkSleep, SLEEP_TICK_MS);
  }

  function stopSleepCheck(): void {
    stopTick?.();
    stopTick = null;
  }

  function checkSleep(): void {
    const now = timers.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    if (gap > SLEEP_TICK_MS + SLEEP_SLACK_MS) {
      returns.emit(undefined);
    }
  }
}

/** The page's. */
export const networkPause = createNetworkPause();

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen's behaviour. It writes the loading store and touches no DOM.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createListenerSet,
  createStateMachine,
  noop,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { pageScreen, prefersReducedMotion, type PageContent } from '@dotli/ui';
import { pagePoll, type Poll } from './pagePoll.js';
import { readPageClock } from './readPageClock.js';
import { loadingState, type LoadingState } from './state/loadingState.js';
import { getStageLines } from './getStageLines.js';

/** A loading step owning the `[base, target]` band of the bar, crossed in about `expectedMs`. */
export type LoadingPhase = {
  label: string;
  base: number;
  target: number;
  expectedMs: number;
  stage: LoadingStage;
  /** The step reports a real percentage, so the bar waits instead of crawling past it. */
  reportsProgress?: boolean;
};

export type LoadingStage = 'starting' | 'relay' | 'assetHub' | 'resolving' | 'content' | 'preparing';

export type LoadingController = ReturnType<typeof createLoadingController>;

type Params = {
  /** Returns whether the visitor asked for less motion, which writes the explanation at once. Never throws. */
  prefersReducedMotion: () => boolean;
  /** The animation frames the explanation is typed on, and their clock. */
  frames: {
    /** Asks for `step` on the next frame and returns the frame's handle. Never throws. */
    request: (step: (now: number) => void) => number;
    /** Drops the frame `handle` names, if it is still due. Never throws. */
    cancel: (handle: number) => void;
    /** Returns the milliseconds since the page started, on the frame clock. Never throws. */
    now: () => number;
  };
  /** What fills the page. A full-page screen takes the loading screen down with the page. */
  pageContent: ReadableAtom<PageContent>;
  /** The clock and timers the stall watch, the stage messages and the fade run on. The page's own by default. */
  timers?: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>;
  /** The tick the bar crawls on. The page's interval by default. */
  poll?: Poll;
};

type MoveBarParams = {
  percent: number;
  /** Movement that does not re-arm the stall watch, or the stall warning could never appear. */
  cosmetic?: boolean;
};

/** The bar's numbers. */
type Bar = {
  percent: number;
  /** The rounded number on screen, and when it last changed. */
  shown: number;
  shownAt: number;
  /** The last number reached by real progress rather than by the floor creep. */
  realShown: number;
};

/** The running step's share of the bar, with the crawl that carries the bar across it. */
type Band =
  | { kind: 'unbanded' }
  | {
      kind: 'banded';
      index: number;
      phase: LoadingPhase;
      crawlStep: number;
      creepCeiling: number;
      creepStep: number;
      /** `count` while a real percentage owns the bar, `clock` while the crawl and creep do. */
      owner: 'count' | 'clock';
      crawl: { kind: 'still' } | { kind: 'crawling'; stopTick: () => void };
    };

/** The stall watch on the shown number. */
type StallWatch = { kind: 'idle' } | { kind: 'armed'; percent: number; timer: unknown };

/** The stage's explanations, turned over on a timer. `line` is the one shown last, -1 before the first. */
type Rotation = { kind: 'still' } | { kind: 'rotating'; explanations: readonly string[]; line: number; timer: unknown };

/** The explanation being typed, one animation frame at a time. */
type Typing =
  { kind: 'still' } | { kind: 'typing'; frame: number; from: string; to: string; startedAt: number; eraseMs: number };

/**
 * A crawl tick, stall, rotation, fade or frame is cleared as its state is left, so none fires for a state that moved
 * on.
 */
type ScreenState =
  | {
      kind: 'active';
      stopFollowing: () => void;
      /** The name the step lines show, empty until it is set. */
      domain: string;
      phases: readonly LoadingPhase[];
      bar: Bar;
      band: Band;
      /** Heard a release, possibly before the counting step began. Cleared with the phases. */
      released: boolean;
      stall: StallWatch;
      /** The running stage's place in the story, -1 before the first, which the markup already painted. */
      stageIndex: number;
      rotation: Rotation;
      typing: Typing;
      /** The explanation on screen, part-typed while it turns over. */
      explanation: string;
    }
  | { kind: 'dismissing'; stopFollowing: () => void; fadeTimer: unknown }
  | { kind: 'gone' }
  | { kind: 'disposed' };

type ActiveState = Extract<ScreenState, { kind: 'active' }>;

type ScreenEvent =
  | { kind: 'followed' }
  | { kind: 'phasesSet'; phases: readonly LoadingPhase[] }
  | { kind: 'domainSet'; domain: string }
  | { kind: 'stageSet'; stage: LoadingStage }
  | { kind: 'warningSet'; message: string | null }
  | { kind: 'phaseEntered'; index: number }
  | { kind: 'progressNudged'; fraction: number; stage: LoadingStage }
  | { kind: 'progressReleased' }
  | { kind: 'tickStopped' }
  | { kind: 'hidden' }
  | { kind: 'dismissed' }
  | { kind: 'disposed' }
  | { kind: 'crawled' }
  | { kind: 'stallDue' }
  | { kind: 'explanationDue' }
  | { kind: 'frameDrawn'; now: number };

/** `drawn` writes what the screen draws, and `stalled` tells the stall listener. */
type ScreenEffect = { kind: 'drawn'; view: Partial<LoadingState> } | { kind: 'stalled'; percent: number };

type ScreenMachine = MachineTypes<ScreenState, ScreenEvent, ScreenEffect>;

const CRAWL_TICK_MS = 200;

// A still number reads as a hang, so the shown percentage changes at least this often.
const PROGRESS_FLOOR_MS = 2_500;

// Short of 100, so only a finished load can fill the bar.
const CREEP_CEILING = 99;
const CREEP_MS = 10_000;

// The per-chain watchdog cannot see a bar parked at its ceiling, such as a content chain with no peers.
export const PROGRESS_STALL_MS = 4_000;

// Most of this window is the turnover animation, so the finished sentence is still for only about 4s.
export const MESSAGE_ROTATE_MS = 9_000;

/** In the order they happen. */
const LOADING_STAGES: readonly LoadingStage[] = ['starting', 'relay', 'assetHub', 'resolving', 'content', 'preparing'];

/** How long the screen fades before it is gone. */
export const FADE_MS = 300;

// A fixed budget rather than a per-character delay, so any sentence lands inside the rotation interval.
export const ERASE_MS = 1_400;
export const TYPE_MS = 3_600;

const report = createReporter({ flow: 'boot' });
const loadingScreenTransitionMetric = defineCount<'error'>('loading_screen.transition');

/**
 * The screen is live from first paint, so a full-page screen ends it even before any load started. Once it fades, the
 * bar, its steps and the story stand still, and once it is gone nothing on it moves.
 */
export function createLoadingController({
  prefersReducedMotion,
  frames,
  pageContent,
  timers = realTimers,
  poll = pagePoll,
}: Params) {
  const stalls = createListenerSet<number>({ onListenerError: report.listener('loading_screen.stall') });
  /** Takes the screen down at once, without the fade, for a page that replaces it. */
  const hide: HandlerOf<ScreenMachine, 'active' | 'dismissing', 'hidden'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'gone' });
    // Queued before the stops, so one that throws still takes the screen down. An interrupted fade would otherwise
    // leave the line stranded dim.
    emitSideEffect({ kind: 'drawn', view: { phase: 'gone', explanationOpacity: 1 } });
    stopPhase(state);
    // A screen that is gone has nothing left to hide.
    state.stopFollowing();
  };
  const showWarning: HandlerOf<ScreenMachine, 'active' | 'dismissing', 'warningSet'> = (
    _state,
    { message },
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'drawn', view: { warning: message } });
  };
  /** Stops following the page and everything the phase runs, leaving the screen as it is. */
  const stop: HandlerOf<ScreenMachine, 'active' | 'dismissing', 'disposed'> = (state, _event, { emitState }) => {
    emitState({ kind: 'disposed' });
    stopPhase(state);
    state.stopFollowing();
  };
  const screen = createStateMachine<ScreenMachine>({
    // Follows the page from the next transition, since following needs that transition's `update`.
    initial: {
      kind: 'active',
      stopFollowing: noop,
      domain: '',
      phases: [],
      bar: { percent: 0, shown: -1, shownAt: 0, realShown: -1 },
      band: { kind: 'unbanded' },
      released: false,
      stall: { kind: 'idle' },
      stageIndex: -1,
      rotation: { kind: 'still' },
      typing: { kind: 'still' },
      explanation: '',
    },
    handlers: {
      active: {
        followed(state, _event, { emitState, update }) {
          // A page that cannot be followed keeps its screen, which then misses only the page replacing it.
          const stopFollowing = pageContent.listen(content => {
            if (content === 'screen') {
              update({ kind: 'hidden' });
            }
          });
          emitState({ ...state, stopFollowing });
        },
        phasesSet(state, { phases }, { emitState, update }) {
          emitState({
            ...state,
            phases,
            bar: { percent: 0, shown: -1, shownAt: timers.now(), realShown: -1 },
            band: { kind: 'unbanded' },
            released: false,
            stall: { kind: 'idle' },
            stageIndex: -1,
          });
          stopCrawl(state.band);
          stopStall(state.stall);
          // Not on the first `advancePhase`, seconds later. The markup already shows this stage's step line, so
          // the explanation clock starts now.
          update({ kind: 'stageSet', stage: 'starting' });
        },
        domainSet(state, { domain }, { emitState }) {
          emitState({ ...state, domain });
        },
        warningSet: showWarning,
        stageSet(state, { stage }, { emitState, emitSideEffect, update }) {
          const stageIndex = LOADING_STAGES.indexOf(stage);
          // Only forward, so a late event cannot walk the story backwards or restart a running stage.
          if (stageIndex <= state.stageIndex) {
            return;
          }
          const { step, srText, explanations } = getStageLines(stage, state.domain);
          // The opening step line has been up since first paint, so its first explanation is due from then.
          const firstDelay =
            state.stageIndex === -1 ? Math.max(500, MESSAGE_ROTATE_MS - frames.now()) : MESSAGE_ROTATE_MS;
          emitState({
            ...state,
            stageIndex,
            rotation: { kind: 'rotating', explanations, line: -1, timer: startRotationTimer(firstDelay, update) },
            typing: { kind: 'still' },
            explanation: '',
          });
          stopRotation(state.rotation);
          stopTyping(state.typing);
          emitSideEffect({ kind: 'drawn', view: { step, explanation: '', explanationOpacity: 1, srText } });
        },
        phaseEntered(state, { index }, transition) {
          const { phases, band } = state;
          const phase = phases[index];
          if (phase === undefined || (band.kind === 'banded' && index <= band.index)) {
            return;
          }
          const { base, target, expectedMs, reportsProgress } = phase;
          const stopTick = poll.start(() => {
            transition.update({ kind: 'crawled' });
          }, CRAWL_TICK_MS);
          const creepCeiling = Math.min(getLentCeiling(phases[index + 1]), CREEP_CEILING);
          const next: ActiveState = {
            ...state,
            band: {
              kind: 'banded',
              index,
              phase,
              // A constant slice per tick, so the bar moves steadily through a long sync instead of stalling near the
              // top.
              crawlStep: ((target - base) * CRAWL_TICK_MS) / Math.max(expectedMs, CRAWL_TICK_MS),
              creepCeiling,
              creepStep: (Math.max(creepCeiling - target, 0) * CRAWL_TICK_MS) / CREEP_MS,
              owner: reportsProgress === true && !state.released ? 'count' : 'clock',
              crawl: { kind: 'crawling', stopTick },
            },
          };
          moveBar(next, { percent: base }, transition);
          stopCrawl(band);
          // Enters the step's stage as setLoadingStage does, right after this transition.
          transition.update({ kind: 'stageSet', stage: phase.stage });
        },
        progressNudged(state, { fraction, stage }, transition) {
          const { band } = state;
          if (band.kind !== 'banded' || !Number.isFinite(fraction)) {
            return;
          }
          const { phase } = band;
          if (phase.stage !== stage) {
            return;
          }
          const { base, target } = phase;
          const clamped = Math.max(0, Math.min(1, fraction));
          // Suppresses the crawl only until the work is done, then the creep carries the unreported tail.
          const next: ActiveState =
            phase.reportsProgress === true
              ? { ...state, band: { ...band, owner: clamped < 1 ? 'count' : 'clock' } }
              : state;
          moveBar(next, { percent: base + (target - base) * clamped }, transition);
        },
        progressReleased(state, _event, { emitState }) {
          const { band } = state;
          emitState({ ...state, released: true, band: band.kind === 'banded' ? { ...band, owner: 'clock' } : band });
        },
        tickStopped(state, _event, { emitState, emitSideEffect }) {
          const { band, typing } = state;
          // An explanation cut off mid-type would stay half written, so it is finished at once.
          const explanation = typing.kind === 'typing' ? typing.to : state.explanation;
          emitState({
            ...state,
            band: band.kind === 'banded' ? { ...band, crawl: { kind: 'still' } } : band,
            stall: { kind: 'idle' },
            rotation: { kind: 'still' },
            typing: { kind: 'still' },
            explanation,
          });
          stopPhase(state);
          emitSideEffect({ kind: 'drawn', view: { explanation, explanationOpacity: 1 } });
        },
        crawled(state, _event, transition) {
          const { band, bar } = state;
          if (band.kind !== 'banded') {
            return;
          }
          // A step reporting a real percentage owns the bar, and the guesses must not run past it.
          if (band.owner === 'clock') {
            if (bar.percent < band.phase.target) {
              moveBar(state, { percent: Math.min(bar.percent + band.crawlStep, band.phase.target) }, transition);
              return;
            }
            if (bar.percent < band.creepCeiling) {
              moveBar(state, { percent: Math.min(bar.percent + band.creepStep, band.creepCeiling) }, transition);
              return;
            }
          }
          // Whatever owns the bar, the number still moves, within the current step's band.
          if (timers.now() - bar.shownAt < PROGRESS_FLOOR_MS) {
            return;
          }
          const ceiling = Math.min(band.owner === 'count' ? band.phase.target : band.creepCeiling, CREEP_CEILING);
          moveBar(state, { percent: Math.min(Math.floor(bar.percent) + 1, ceiling), cosmetic: true }, transition);
        },
        stallDue(state, _event, { emitState, emitSideEffect }) {
          const { stall } = state;
          if (stall.kind !== 'armed') {
            return;
          }
          emitState({ ...state, stall: { kind: 'idle' } });
          emitSideEffect({ kind: 'stalled', percent: stall.percent });
        },
        explanationDue(state, _event, { emitState, emitSideEffect, update }) {
          const { rotation, typing, explanation: previous } = state;
          if (rotation.kind !== 'rotating') {
            return;
          }
          const line = (rotation.line + 1) % rotation.explanations.length;
          const explanation = rotation.explanations[line] ?? '';
          const turned: ActiveState = {
            ...state,
            rotation: { ...rotation, line, timer: startRotationTimer(MESSAGE_ROTATE_MS, update) },
          };
          // Screen readers get the whole sentence once, from an element the typing never touches.
          if (explanation === previous || prefersReducedMotion()) {
            emitState({ ...turned, typing: { kind: 'still' }, explanation });
            stopTyping(typing);
            emitSideEffect({ kind: 'drawn', view: { srText: explanation, explanation, explanationOpacity: 1 } });
            return;
          }
          emitState({
            ...turned,
            typing: {
              kind: 'typing',
              frame: requestTypingFrame(update),
              from: previous,
              to: explanation,
              startedAt: frames.now(),
              eraseMs: previous === '' ? 0 : ERASE_MS,
            },
          });
          stopTyping(typing);
          // An interrupted fade would otherwise leave the line stranded dim.
          emitSideEffect({ kind: 'drawn', view: { srText: explanation, explanationOpacity: 1 } });
        },
        frameDrawn(state, { now }, { emitState, emitSideEffect, update }) {
          const { typing } = state;
          if (typing.kind !== 'typing') {
            return;
          }
          const elapsedMs = now - typing.startedAt;
          if (elapsedMs >= typing.eraseMs + TYPE_MS) {
            emitState({ ...state, typing: { kind: 'still' }, explanation: typing.to });
            emitSideEffect({ kind: 'drawn', view: { explanation: typing.to, explanationOpacity: 1 } });
            return;
          }
          const { explanation, opacity } = getTypingFrame(typing, elapsedMs);
          emitState({ ...state, typing: { ...typing, frame: requestTypingFrame(update) }, explanation });
          emitSideEffect({ kind: 'drawn', view: { explanation, explanationOpacity: opacity } });
        },
        hidden: hide,
        dismissed(state, _event, { emitState, emitSideEffect, update }) {
          // The screen is removed only once its fade has finished.
          const fadeTimer = timers.setTimeout(() => {
            update({ kind: 'hidden' });
          }, FADE_MS);
          emitState({ kind: 'dismissing', stopFollowing: state.stopFollowing, fadeTimer });
          emitSideEffect({ kind: 'drawn', view: { progress: 100, explanationOpacity: 1, phase: 'dismissing' } });
          stopPhase(state);
        },
        disposed: stop,
      },
      dismissing: { hidden: hide, warningSet: showWarning, disposed: stop },
      gone: null,
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'drawn':
          loadingState.update(effect.view);
          return;
        case 'stalled':
          stalls.emit(effect.percent);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: loadingScreenTransitionMetric,
        message: '[dot.li] A loading screen transition threw',
      });
    },
  });
  screen.update({ kind: 'followed' });

  return {
    /**
     * Hears each time the bar stops afresh. Returns the removal, safe to call more than once. Never throws: a throw of
     * the listener is reported.
     */
    onProgressStall: stalls.subscribe,
    /** Starts a load's steps. Call it once before resolution begins. Never throws. */
    initPhases: (phases: LoadingPhase[]): void => {
      screen.update({ kind: 'phasesSet', phases });
    },
    /** Sets the name the step lines show. Never throws. */
    setLoadingDomain: (domain: string): void => {
      screen.update({ kind: 'domainSet', domain });
    },
    /** Moves the story to `stage`. Only moves forward, so a late call does nothing. Never throws. */
    setLoadingStage: (stage: LoadingStage): void => {
      screen.update({ kind: 'stageSet', stage });
    },
    /** Enters the step at `index`. Does nothing if that step is already active or past. Never throws. */
    advancePhase: (index: number): void => {
      screen.update({ kind: 'phaseEntered', index });
    },
    /**
     * Moves the bar to `fraction` of the running step's band. Monotonic and clamped, and ignored unless `stage` is
     * the running one. Never throws.
     */
    nudgePhaseProgress: (fraction: number, stage: LoadingStage): void => {
      screen.update({ kind: 'progressNudged', fraction, stage });
    },
    /**
     * Lets the bar crawl through a `reportsProgress` step that will never report, the running one or one that starts
     * later. A real count still takes the bar back. Never throws.
     */
    releasePhaseProgress: (): void => {
      screen.update({ kind: 'progressReleased' });
    },
    /** Stops the crawl, the stage messages and the stall watch. Never throws. */
    stopStatusTick: (): void => {
      screen.update({ kind: 'tickStopped' });
    },
    /** Takes the screen down at once, without the fade, for a page that replaces it. Never throws. */
    hideLoading: (): void => {
      screen.update({ kind: 'hidden' });
    },
    /** Shows `message` under the bar, or hides the warning for null. Never throws. */
    setLoadingWarning: (message: string | null): void => {
      screen.update({ kind: 'warningSet', message });
    },
    /** Fills the bar and fades the screen out. Never throws. */
    dismissLoading: (): void => {
      screen.update({ kind: 'dismissed' });
    },
    /**
     * Stops following the page's content, the crawl, the stage messages, the stall watch and the fade, leaving the
     * screen as it is. Never throws: a throw of the unsubscribe `pageContent` returned is reported.
     */
    dispose: (): void => {
      screen.update({ kind: 'disposed' });
    },
  };

  /**
   * Moves to `state` with the bar at `percent`, and arms the stall watch afresh when real progress moved the shown
   * number. The bar only moves forward, so a `percent` at or behind it moves to `state` with the bar where it was.
   */
  function moveBar(
    state: ActiveState,
    { percent, cosmetic = false }: MoveBarParams,
    { emitState, emitSideEffect, update }: Transition<ScreenMachine>,
  ): void {
    if (percent <= state.bar.percent) {
      emitState(state);
      return;
    }
    const shown = Math.round(percent);
    const moved = !cosmetic && shown !== state.bar.realShown;
    const next: ActiveState = {
      ...state,
      bar: {
        percent,
        shown,
        shownAt: shown === state.bar.shown ? state.bar.shownAt : timers.now(),
        realShown: moved ? shown : state.bar.realShown,
      },
      stall: moved
        ? {
            kind: 'armed',
            percent,
            timer: timers.setTimeout(() => {
              update({ kind: 'stallDue' });
            }, PROGRESS_STALL_MS),
          }
        : state.stall,
    };
    emitState(next);
    if (moved) {
      stopStall(state.stall);
    }
    emitSideEffect({ kind: 'drawn', view: { progress: percent } });
  }

  function startRotationTimer(delayMs: number, update: Transition<ScreenMachine>['update']): unknown {
    return timers.setTimeout(() => {
      update({ kind: 'explanationDue' });
    }, delayMs);
  }

  function requestTypingFrame(update: Transition<ScreenMachine>['update']): number {
    return frames.request(now => {
      update({ kind: 'frameDrawn', now });
    });
  }

  /** Stops every tick, timer and frame the phase `state` holds. */
  function stopPhase(state: Extract<ScreenState, { kind: 'active' | 'dismissing' }>): void {
    switch (state.kind) {
      case 'active':
        stopCrawl(state.band);
        stopStall(state.stall);
        stopRotation(state.rotation);
        stopTyping(state.typing);
        return;
      case 'dismissing':
        timers.clearTimeout(state.fadeTimer);
        return;
    }
  }

  function stopStall(stall: StallWatch): void {
    if (stall.kind === 'armed') {
      timers.clearTimeout(stall.timer);
    }
  }

  function stopRotation(rotation: Rotation): void {
    if (rotation.kind === 'rotating') {
      timers.clearTimeout(rotation.timer);
    }
  }

  function stopTyping(typing: Typing): void {
    if (typing.kind === 'typing') {
      frames.cancel(typing.frame);
    }
  }
}

function stopCrawl(band: Band): void {
  if (band.kind === 'banded' && band.crawl.kind === 'crawling') {
    band.crawl.stopTick();
  }
}

/**
 * An overrunning band creeps into the next one, unless that one reports a real percentage, which the creep would
 * overshoot.
 */
function getLentCeiling(next: LoadingPhase | undefined): number {
  if (next === undefined) {
    return CREEP_CEILING;
  }
  return next.reportsProgress === true ? next.base : next.target;
}

/** The part-typed explanation `elapsedMs` into `typing`, and its opacity. */
function getTypingFrame(
  { from, to, eraseMs }: Extract<Typing, { kind: 'typing' }>,
  elapsedMs: number,
): { explanation: string; opacity: number } {
  // The frame clock can start a little before `startedAt`, so a zero-length erase is skipped, not divided by.
  if (eraseMs > 0 && elapsedMs < eraseMs) {
    const gone = applyEaseInOut(elapsedMs / eraseMs);
    // Only a shallow dip, since deeper opacity once sank this block's contrast below AA.
    return { explanation: from.slice(0, Math.ceil(from.length * (1 - gone))), opacity: 1 - 0.25 * gone };
  }
  const shown = applyEaseInOut((elapsedMs - eraseMs) / TYPE_MS);
  return { explanation: to.slice(0, Math.ceil(to.length * shown)), opacity: 0.75 + 0.25 * shown };
}

function applyEaseInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - (-2 * progress + 2) ** 3 / 2;
}

/** The page's loading screen. It lasts the page's life, so it is never disposed. */
export const pageLoading = createLoadingController({
  prefersReducedMotion,
  frames: {
    request: step => requestAnimationFrame(step),
    cancel(handle) {
      cancelAnimationFrame(handle);
    },
    now: readPageClock,
  },
  pageContent: pageScreen.store,
});

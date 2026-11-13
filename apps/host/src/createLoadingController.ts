// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen's behaviour. It writes the loading store and touches no DOM.

import { getActiveTldSuffix } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
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
import { loadingState, type LoadingState, type StepPart } from './state/loadingState.js';

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

/** Animation frames for the typed explanation, and their clock. */
export type LoadingFrames = {
  /** Asks for `step` on the next frame and returns the frame's handle. Never throws. */
  request: (step: (now: number) => void) => number;
  /** Drops the frame `handle` names, if it is still due. Never throws. */
  cancel: (handle: number) => void;
  /** Returns the frame clock's time in milliseconds. Never throws. */
  now: () => number;
};

export type LoadingController = ReturnType<typeof createLoadingController>;

type Params = {
  /** Returns whether the visitor asked for less motion, which writes the explanation at once. Never throws. */
  prefersReducedMotion: () => boolean;
  /** The animation frames the explanation is typed on. */
  frames: LoadingFrames;
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
  cosmetic?: boolean | undefined;
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
      target: number;
      crawlStep: number;
      creepCeiling: number;
      creepStep: number;
      /** `count` while a real percentage owns the bar, `clock` while the crawl and creep do. */
      owner: 'count' | 'clock';
      crawl: { kind: 'still' } | { kind: 'crawling'; stopTick: () => void };
    };

/** The stall watch on the shown number. Its timer warns only while it is still the watch. */
type StallWatch = { kind: 'idle' } | { kind: 'armed'; percent: number; timer: unknown };

/**
 * The stage's explanations, turned over on a timer. `line` is the one shown last, -1 before the first. Its timer turns
 * the line only while it is still the rotation's.
 */
type Rotation = { kind: 'still' } | { kind: 'rotating'; explanations: readonly string[]; line: number; timer: unknown };

/** The explanation being typed, one animation frame at a time. */
type Typing =
  { kind: 'still' } | { kind: 'typing'; frame: number; from: string; to: string; startedAt: number; eraseMs: number };

type ScreenState =
  | { kind: 'idle' }
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
      /** The running stage's place in the story, -1 before the first. */
      stageIndex: number;
      /** True until the first stage turn, which the markup already painted. */
      opening: boolean;
      rotation: Rotation;
      typing: Typing;
      /** The explanation on screen, part-typed while it turns over. */
      explanation: string;
    }
  | { kind: 'dismissing'; stopFollowing: () => void; fadeTimer: unknown }
  | { kind: 'gone'; stopFollowing: () => void }
  | { kind: 'disposed' };

type ActiveState = Extract<ScreenState, { kind: 'active' }>;

type ScreenEvent =
  | { kind: 'started' }
  | { kind: 'pageContentChanged'; content: PageContent }
  | { kind: 'phasesSet'; phases: readonly LoadingPhase[] }
  | { kind: 'domainSet'; domain: string }
  | { kind: 'stageSet'; stage: LoadingStage }
  | { kind: 'phaseEntered'; index: number }
  | { kind: 'progressNudged'; fraction: number; stage: LoadingStage }
  | { kind: 'progressReleased' }
  | { kind: 'watchStopped' }
  | { kind: 'progressCompleted' }
  | { kind: 'tickStopped' }
  | { kind: 'hidden' }
  | { kind: 'dismissed' }
  | { kind: 'disposed' }
  | { kind: 'crawled' }
  | { kind: 'stallDue'; timer: unknown }
  | { kind: 'explanationDue'; timer: unknown }
  | { kind: 'frameDrawn'; now: number }
  | { kind: 'fadeEnded'; timer: unknown };

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

const DOMAIN_TOKEN = '{domain}';

/** In the order they happen. */
const LOADING_STAGES: readonly LoadingStage[] = ['starting', 'relay', 'assetHub', 'resolving', 'content', 'preparing'];

/**
 * The first line is the step line, up for the whole stage. The rest are explanations only a slow load
 * reaches, as many as the step runs long, so the long ones do not repeat.
 */
const STAGE_MESSAGES: Record<LoadingStage, readonly [string, string, ...string[]]> = {
  starting: [
    'Reaching out',
    'This page comes from a network, with no one in between',
    'That takes a few seconds the first time',
  ],
  relay: [
    'Connecting to Polkadot',
    'Looking for other computers to talk to',
    'Your browser does the checking itself, not a server',
  ],
  assetHub: [
    `Looking up ${DOMAIN_TOKEN}`,
    'Catching up on the newest blocks',
    'The network itself decides where this name points',
    'This is the slow part, and it is faster next time',
  ],
  resolving: ['Found it', 'Reading where the name points', 'The network proved this answer, so it cannot be faked'],
  content: [
    'Downloading the app',
    'The files come from many computers at once',
    'The more of them are nearby, the faster this goes',
    'Every piece is checked against its fingerprint as it lands',
    'No single computer holds the app, so no one can take it down',
    'Bigger apps take longer the first time',
    'Your browser keeps a copy, so the next visit is quick',
  ],
  preparing: ['Got everything', 'Unpacking the files', 'Handing over to the app', 'Almost there'],
};

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
  let stallListener: ((percent: number) => void) | null = null;
  /** Takes the screen down at once, without the fade, for a page that replaces it. */
  const hide: HandlerOf<ScreenMachine, 'active' | 'dismissing', 'hidden'> = (
    state,
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'gone', stopFollowing: state.stopFollowing });
    stopPhase(state);
    // An interrupted fade would otherwise leave the line stranded dim.
    emitSideEffect({ kind: 'drawn', view: { phase: 'gone', explanationOpacity: 1 } });
  };
  const hideBehindScreen: HandlerOf<ScreenMachine, 'active' | 'dismissing', 'pageContentChanged'> = (
    state,
    { content },
    transition,
  ) => {
    if (content !== 'screen') {
      return;
    }
    hide(state, { kind: 'hidden' }, transition);
  };
  /** Stops following the page and everything the phase runs, leaving the screen as it is. */
  const stop: HandlerOf<ScreenMachine, 'active' | 'dismissing' | 'gone', 'disposed'> = (
    state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed' });
    stopPhase(state);
    state.stopFollowing();
  };
  const screen = createStateMachine<ScreenMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, { emitState, update }) {
          const following = (stopFollowing: () => void): ActiveState => ({
            kind: 'active',
            stopFollowing,
            domain: '',
            phases: [],
            bar: { percent: 0, shown: -1, shownAt: 0, realShown: -1 },
            band: { kind: 'unbanded' },
            released: false,
            stall: { kind: 'idle' },
            stageIndex: -1,
            opening: true,
            rotation: { kind: 'still' },
            typing: { kind: 'still' },
            explanation: '',
          });
          let stopFollowing: () => void;
          try {
            stopFollowing = pageContent.listen(content => {
              update({ kind: 'pageContentChanged', content });
            });
          } catch (error) {
            // A page that cannot be followed still gets its screen, which then misses only the page replacing it.
            emitState(following(noop));
            throw error;
          }
          emitState(following(stopFollowing));
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      active: {
        pageContentChanged: hideBehindScreen,
        phasesSet(state, { phases }, transition) {
          const next: ActiveState = {
            ...state,
            phases,
            bar: { percent: 0, shown: -1, shownAt: timers.now(), realShown: -1 },
            band: { kind: 'unbanded' },
            released: false,
            stageIndex: -1,
            opening: true,
          };
          transition.emitState(next);
          stopCrawl(state.band);
          // Not on the first `advancePhase`, seconds later. The markup already shows this stage's step line, so
          // the explanation clock starts now.
          enterStage(next, 'starting', transition);
        },
        domainSet(state, { domain }, { emitState }) {
          emitState({ ...state, domain });
        },
        stageSet(state, { stage }, transition) {
          enterStage(state, stage, transition);
        },
        phaseEntered(state, { index }, transition) {
          const { phases, band } = state;
          const phase = phases[index];
          if (phase === undefined || (band.kind === 'banded' && index <= band.index)) {
            return;
          }
          const { base, target, expectedMs, reportsProgress } = phase;
          const moved = base > state.bar.percent ? moveBar(state, { percent: base }, transition) : state;
          const stopTick = poll.start(() => {
            transition.update({ kind: 'crawled' });
          }, CRAWL_TICK_MS);
          const creepCeiling = Math.min(getLentCeiling(phases[index + 1]), CREEP_CEILING);
          const next: ActiveState = {
            ...moved,
            band: {
              kind: 'banded',
              index,
              target,
              // A constant slice per tick, so the bar moves steadily through a long sync instead of stalling near the
              // top.
              crawlStep: ((target - base) * CRAWL_TICK_MS) / Math.max(expectedMs, CRAWL_TICK_MS),
              creepCeiling,
              creepStep: (Math.max(creepCeiling - target, 0) * CRAWL_TICK_MS) / Math.max(CREEP_MS, CRAWL_TICK_MS),
              owner: reportsProgress === true && !state.released ? 'count' : 'clock',
              crawl: { kind: 'crawling', stopTick },
            },
          };
          transition.emitState(next);
          stopCrawl(band);
          enterStage(next, phase.stage, transition);
        },
        progressNudged(state, { fraction, stage }, transition) {
          const { band } = state;
          if (band.kind !== 'banded' || !Number.isFinite(fraction)) {
            return;
          }
          const phase = state.phases[band.index];
          if (phase?.stage !== stage) {
            return;
          }
          const { base, target } = phase;
          const clamped = Math.max(0, Math.min(1, fraction));
          let next = state;
          // Suppresses the crawl only until the work is done, then the creep carries the unreported tail.
          if (phase.reportsProgress === true) {
            next = { ...state, band: { ...band, owner: clamped < 1 ? 'count' : 'clock' } };
            transition.emitState(next);
          }
          const want = base + (target - base) * clamped;
          if (want > next.bar.percent) {
            moveBar(next, { percent: Math.min(want, target) }, transition);
          }
        },
        progressReleased(state, _event, { emitState }) {
          const { band } = state;
          emitState({ ...state, released: true, band: band.kind === 'banded' ? { ...band, owner: 'clock' } : band });
        },
        watchStopped(state, _event, { emitState }) {
          emitState({ ...state, stall: { kind: 'idle' } });
          stopStall(state.stall);
        },
        progressCompleted(state, _event, transition) {
          moveBar({ ...state, band: toStillCrawl(state.band) }, { percent: 100 }, transition);
          stopCrawl(state.band);
        },
        tickStopped(state, _event, { emitState, emitSideEffect }) {
          emitState({
            ...state,
            band: toStillCrawl(state.band),
            stall: { kind: 'idle' },
            rotation: { kind: 'still' },
            typing: { kind: 'still' },
          });
          stopPhase(state);
          emitSideEffect({ kind: 'drawn', view: { explanationOpacity: 1 } });
        },
        crawled(state, _event, transition) {
          const { band, bar } = state;
          if (band.kind !== 'banded') {
            return;
          }
          // A step reporting a real percentage owns the bar, and the guesses must not run past it.
          if (band.owner === 'clock') {
            if (bar.percent < band.target) {
              moveBar(state, { percent: Math.min(bar.percent + band.crawlStep, band.target) }, transition);
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
          const ceiling = Math.min(band.owner === 'count' ? band.target : band.creepCeiling, CREEP_CEILING);
          const next = Math.min(Math.floor(bar.percent) + 1, ceiling);
          if (next > bar.percent) {
            moveBar(state, { percent: next, cosmetic: true }, transition);
          }
        },
        stallDue(state, { timer }, { emitState, emitSideEffect }) {
          const { stall } = state;
          if (stall.kind !== 'armed' || stall.timer !== timer) {
            return;
          }
          emitState({ ...state, stall: { kind: 'idle' } });
          emitSideEffect({ kind: 'stalled', percent: stall.percent });
        },
        explanationDue(state, { timer }, transition) {
          const { rotation } = state;
          if (rotation.kind !== 'rotating' || rotation.timer !== timer) {
            return;
          }
          const line = (rotation.line + 1) % rotation.explanations.length;
          const turned: ActiveState = {
            ...state,
            rotation: { ...rotation, line, timer: startRotationTimer(MESSAGE_ROTATE_MS, transition) },
          };
          transition.emitState(turned);
          showLine(turned, rotation.explanations[line] ?? '', transition);
        },
        frameDrawn(state, { now }, { emitState, emitSideEffect, update }) {
          const { typing } = state;
          if (typing.kind !== 'typing') {
            return;
          }
          const { from, to, startedAt, eraseMs } = typing;
          const elapsedMs = now - startedAt;
          if (elapsedMs >= eraseMs + TYPE_MS) {
            emitState({ ...state, typing: { kind: 'still' }, explanation: to });
            emitSideEffect({ kind: 'drawn', view: { explanation: to, explanationOpacity: 1 } });
            return;
          }
          const drawing: Typing = { ...typing, frame: requestTypingFrame(update) };
          // The frame clock can start a little before `startedAt`, so a zero-length erase is skipped, not divided by.
          if (eraseMs > 0 && elapsedMs < eraseMs) {
            const gone = applyEaseInOut(elapsedMs / eraseMs);
            const explanation = from.slice(0, Math.ceil(from.length * (1 - gone)));
            emitState({ ...state, typing: drawing, explanation });
            // Only a shallow dip, since deeper opacity once sank this block's contrast below AA.
            emitSideEffect({ kind: 'drawn', view: { explanation, explanationOpacity: 1 - 0.25 * gone } });
            return;
          }
          const shown = applyEaseInOut((elapsedMs - eraseMs) / TYPE_MS);
          const explanation = to.slice(0, Math.ceil(to.length * shown));
          emitState({ ...state, typing: drawing, explanation });
          emitSideEffect({ kind: 'drawn', view: { explanation, explanationOpacity: 0.75 + 0.25 * shown } });
        },
        hidden: hide,
        dismissed(state, _event, { emitState, emitSideEffect, update }) {
          // The screen is removed only once its fade has finished.
          const fadeTimer = timers.setTimeout(() => {
            update({ kind: 'fadeEnded', timer: fadeTimer });
          }, FADE_MS);
          emitState({ kind: 'dismissing', stopFollowing: state.stopFollowing, fadeTimer });
          stopPhase(state);
          emitSideEffect({ kind: 'drawn', view: { progress: 100, explanationOpacity: 1, phase: 'dismissing' } });
        },
        disposed: stop,
      },
      dismissing: {
        pageContentChanged: hideBehindScreen,
        fadeEnded(state, { timer }, transition) {
          if (timer !== state.fadeTimer) {
            return;
          }
          hide(state, { kind: 'hidden' }, transition);
        },
        hidden: hide,
        disposed: stop,
      },
      gone: { disposed: stop },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'drawn':
          loadingState.update(effect.view);
          return;
        case 'stalled':
          stallListener?.(effect.percent);
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
  screen.update({ kind: 'started' });

  return {
    /**
     * Sets the listener that hears each time the bar stops afresh, replacing any previous one. Returns the function
     * that removes it, which does nothing once another listener replaced it. Never throws: a throw of the listener is
     * reported.
     */
    onProgressStall,
    /** Stops watching the bar for a stall. Never throws. */
    stopProgressWatch,
    /** Fills the bar and stops its crawl. Never throws. */
    completeProgress,
    /** Starts a load's steps. Call it once before resolution begins. Never throws. */
    initPhases,
    /** Sets the name the step lines show. Never throws. */
    setLoadingDomain,
    /** Moves the story to `stage`. Only moves forward, so a late call does nothing. Never throws. */
    setLoadingStage,
    /** Enters the step at `index`. Does nothing if that step is already active or past. Never throws. */
    advancePhase,
    /**
     * Moves the bar to `fraction` of the running step's band. Monotonic and clamped, and ignored unless `stage` is
     * the running one. Never throws.
     */
    nudgePhaseProgress,
    /**
     * Lets the bar crawl through a `reportsProgress` step that will never report, the running one or one that starts
     * later. A real count still takes the bar back. Never throws.
     */
    releasePhaseProgress,
    /** Stops the crawl, the stage messages and the stall watch. Never throws. */
    stopStatusTick,
    /** Takes the screen down at once, without the fade, for a page that replaces it. Never throws. */
    hideLoading,
    /** Shows `message` under the bar, or hides the warning for null. Never throws. */
    setLoadingWarning,
    /** Fills the bar and fades the screen out. Never throws. */
    dismissLoading,
    /**
     * Stops following the page's content, the crawl, the stage messages, the stall watch and the fade, leaving the
     * screen as it is. Never throws: a throw of the unsubscribe `pageContent` returned is reported.
     */
    dispose,
  };

  function onProgressStall(listener: (percent: number) => void): () => void {
    stallListener = listener;
    return removeStallListener;

    // A listener that replaced this one stays.
    function removeStallListener(): void {
      if (stallListener === listener) {
        stallListener = null;
      }
    }
  }

  function stopProgressWatch(): void {
    screen.update({ kind: 'watchStopped' });
  }

  function completeProgress(): void {
    screen.update({ kind: 'progressCompleted' });
  }

  function initPhases(phases: LoadingPhase[]): void {
    screen.update({ kind: 'phasesSet', phases });
  }

  function setLoadingDomain(domain: string): void {
    screen.update({ kind: 'domainSet', domain });
  }

  function setLoadingStage(stage: LoadingStage): void {
    screen.update({ kind: 'stageSet', stage });
  }

  function advancePhase(index: number): void {
    screen.update({ kind: 'phaseEntered', index });
  }

  function nudgePhaseProgress(fraction: number, stage: LoadingStage): void {
    screen.update({ kind: 'progressNudged', fraction, stage });
  }

  function releasePhaseProgress(): void {
    screen.update({ kind: 'progressReleased' });
  }

  function stopStatusTick(): void {
    screen.update({ kind: 'tickStopped' });
  }

  function hideLoading(): void {
    screen.update({ kind: 'hidden' });
  }

  function setLoadingWarning(message: string | null): void {
    loadingState.update({ warning: message });
  }

  function dismissLoading(): void {
    screen.update({ kind: 'dismissed' });
  }

  function dispose(): void {
    screen.update({ kind: 'disposed' });
  }

  /** Moves the bar to `percent`, and arms the stall watch afresh when real progress moved the shown number. */
  function moveBar(
    state: ActiveState,
    { percent, cosmetic = false }: MoveBarParams,
    { emitState, emitSideEffect, update }: Transition<ScreenMachine>,
  ): ActiveState {
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
      stall: moved ? armStallWatch(percent, update) : state.stall,
    };
    emitState(next);
    if (moved) {
      stopStall(state.stall);
    }
    emitSideEffect({ kind: 'drawn', view: { progress: percent } });
    return next;
  }

  /** Returns a watch on `percent`, or none for a full bar. The caller stops the watch it replaces. */
  function armStallWatch(percent: number, update: Transition<ScreenMachine>['update']): StallWatch {
    if (percent >= 100) {
      return { kind: 'idle' };
    }
    const timer = timers.setTimeout(() => {
      update({ kind: 'stallDue', timer });
    }, PROGRESS_STALL_MS);
    return { kind: 'armed', percent, timer };
  }

  /** Only moves forward, so a late event cannot walk the story backwards or restart a running stage. */
  function enterStage(state: ActiveState, stage: LoadingStage, transition: Transition<ScreenMachine>): void {
    const stageIndex = LOADING_STAGES.indexOf(stage);
    if (stageIndex <= state.stageIndex) {
      return;
    }
    const [opening, ...explanations] = STAGE_MESSAGES[stage];
    // The opening step line has been up since first paint, so its first explanation is due from then.
    const firstDelay = state.opening ? Math.max(500, MESSAGE_ROTATE_MS - frames.now()) : MESSAGE_ROTATE_MS;
    transition.emitState({
      ...state,
      stageIndex,
      opening: false,
      rotation: { kind: 'rotating', explanations, line: -1, timer: startRotationTimer(firstDelay, transition) },
      typing: { kind: 'still' },
      explanation: '',
    });
    stopRotation(state.rotation);
    stopTyping(state.typing);
    const step = getStepParts(opening, state.domain);
    transition.emitSideEffect({
      kind: 'drawn',
      view: { step, explanation: '', explanationOpacity: 1, srText: toStepSentence(step) },
    });
  }

  /** Turns the explanation over to `explanation`, typed unless it is already up or the visitor asked for less motion. */
  function showLine(
    state: ActiveState,
    explanation: string,
    { emitState, emitSideEffect, update }: Transition<ScreenMachine>,
  ): void {
    const previous = state.explanation;
    // Screen readers get the whole sentence once, from an element the typing never touches.
    if (explanation === previous || prefersReducedMotion()) {
      emitState({ ...state, typing: { kind: 'still' }, explanation });
      stopTyping(state.typing);
      emitSideEffect({ kind: 'drawn', view: { srText: explanation, explanation, explanationOpacity: 1 } });
      return;
    }
    const startedAt = frames.now();
    emitState({
      ...state,
      typing: {
        kind: 'typing',
        frame: requestTypingFrame(update),
        from: previous,
        to: explanation,
        startedAt,
        eraseMs: previous === '' ? 0 : ERASE_MS,
      },
    });
    stopTyping(state.typing);
    // An interrupted fade would otherwise leave the line stranded dim.
    emitSideEffect({ kind: 'drawn', view: { srText: explanation, explanationOpacity: 1 } });
  }

  function startRotationTimer(delayMs: number, { update }: Transition<ScreenMachine>): unknown {
    const timer = timers.setTimeout(() => {
      update({ kind: 'explanationDue', timer });
    }, delayMs);
    return timer;
  }

  function requestTypingFrame(update: Transition<ScreenMachine>['update']): number {
    return frames.request(now => {
      update({ kind: 'frameDrawn', now });
    });
  }

  /** Stops every tick, timer and frame the phase `state` holds. */
  function stopPhase(state: Extract<ScreenState, { kind: 'active' | 'dismissing' | 'gone' }>): void {
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
      case 'gone':
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

/** Falls back to "the name" on the preview and local-target paths, which have no dotNS name. */
function getStepParts(message: string, domain: string): StepPart[] {
  const at = message.indexOf(DOMAIN_TOKEN);
  if (at === -1) {
    return [message];
  }
  const name: StepPart = domain === '' ? 'the name' : { host: domain, tld: getActiveTldSuffix() };
  return [message.slice(0, at), name, message.slice(at + DOMAIN_TOKEN.length)].filter(part => part !== '');
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

/** `band` with its crawl marked still. */
function toStillCrawl(band: Band): Band {
  return band.kind === 'banded' ? { ...band, crawl: { kind: 'still' } } : band;
}

function toStepSentence(parts: readonly StepPart[]): string {
  return parts.map(part => (typeof part === 'string' ? part : `${part.host}${part.tld}`)).join('');
}

function applyEaseInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - (-2 * progress + 2) ** 3 / 2;
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen's behaviour. It writes the loading store and touches no DOM.

import { getActiveTldSuffix } from '@dotli/config';
import type { SandboxChannel } from '@dotli/sandbox-wire';
import { realTimers, type Timers } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { pageScreen, prefersReducedMotion, type PageContent } from '@dotli/ui';
import { pagePoll, type Poll } from './pagePoll.js';
import { readPageClock } from './readPageClock.js';
import { loadingState, type StepPart } from './state/loadingState.js';

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

export type SandboxOutcome = 'loaded' | 'failed';

/** Becomes a Sentry tag from another origin, so anything but a short snake_case token is dropped. */
export type SandboxFailedStep = string | undefined;

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

type SetProgressParams = {
  /** Movement that does not re-arm the stall watch, or the stall warning could never appear. */
  cosmetic?: boolean | undefined;
};

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
const STAGE_MESSAGES: Record<LoadingStage, readonly [string, ...string[]]> = {
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

const FAILED_STEP_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The screen is live from first paint, so a full-page screen ends it even before any load started. */
export function createLoadingController({
  prefersReducedMotion,
  frames,
  pageContent,
  timers = realTimers,
  poll = pagePoll,
}: Params) {
  let phases: LoadingPhase[] = [];
  let currentPhase = -1;

  let currentProgress = 0;
  let targetProgress = 0;
  let crawlStep = 0;
  let stopCrawlTick: (() => void) | null = null;

  let lastShownAt = 0;
  let lastShown = -1;
  /** The last number reached by real progress rather than by the floor creep. */
  let lastRealShown = -1;

  let creepCeiling = 0;
  let creepStep = 0;
  let phaseReportsProgress = false;

  let progressStallTimer: unknown = null;
  let progressStallListener: ((percent: number) => void) | null = null;

  /** Fires each time the bar stops afresh. Replaces any previous listener. */
  function onProgressStall(listener: (percent: number) => void): () => void {
    progressStallListener = listener;
    return removeStallListener;

    // A listener that replaced this one stays.
    function removeStallListener(): void {
      if (progressStallListener === listener) {
        progressStallListener = null;
      }
    }
  }

  function stopProgressWatch(): void {
    if (progressStallTimer !== null) {
      timers.clearTimeout(progressStallTimer);
      progressStallTimer = null;
    }
  }

  function armProgressWatch(percent: number): void {
    stopProgressWatch();
    if (percent >= 100 || !isLive()) {
      return;
    }
    progressStallTimer = timers.setTimeout(() => {
      progressStallListener?.(percent);
    }, PROGRESS_STALL_MS);
  }

  function setProgress(percent: number, { cosmetic = false }: SetProgressParams = {}): void {
    const shown = Math.round(percent);
    if (shown !== lastShown) {
      lastShown = shown;
      lastShownAt = timers.now();
    }
    const moved = !cosmetic && shown !== lastRealShown;
    if (moved) {
      lastRealShown = shown;
    }
    currentProgress = percent;
    if (moved) {
      armProgressWatch(percent);
    }
    loadingState.update({ progress: percent });
  }

  function startProgressCrawl(): void {
    stopProgressCrawl();
    if (!isLive()) {
      return;
    }
    stopCrawlTick = poll.start(() => {
      // A step reporting a real percentage owns the bar, and the guesses must not run past it.
      if (!phaseReportsProgress) {
        if (currentProgress < targetProgress) {
          setProgress(Math.min(currentProgress + crawlStep, targetProgress));
          return;
        }
        if (currentProgress < creepCeiling) {
          setProgress(Math.min(currentProgress + creepStep, creepCeiling));
          return;
        }
      }
      // Whatever owns the bar, the number still moves, within the current step's band.
      if (timers.now() - lastShownAt >= PROGRESS_FLOOR_MS) {
        const ceiling = Math.min(phaseReportsProgress ? targetProgress : creepCeiling, CREEP_CEILING);
        const next = Math.min(Math.floor(currentProgress) + 1, ceiling);
        if (next > currentProgress) {
          setProgress(next, { cosmetic: true });
        }
      }
    }, CRAWL_TICK_MS);
  }

  function stopProgressCrawl(): void {
    if (stopCrawlTick !== null) {
      stopCrawlTick();
      stopCrawlTick = null;
    }
  }

  function completeProgress(): void {
    stopProgressCrawl();
    setProgress(100);
  }

  /** Call once before resolution begins. */
  function initPhases(phaseList: LoadingPhase[]): void {
    phases = phaseList;
    currentPhase = -1;
    currentStageIndex = -1;
    openingLine = true;
    currentProgress = 0;
    targetProgress = 0;
    phaseReportsProgress = false;
    lastShown = -1;
    lastRealShown = -1;
    lastShownAt = timers.now();

    // Not on the first `advancePhase`, seconds later. The markup already shows this stage's step line, so
    // the explanation clock starts now.
    setLoadingStage('starting');
  }

  let stageTimer: unknown = null;
  let currentStageIndex = -1;
  /** True until the first stage turn, which the markup already painted. */
  let openingLine = true;
  let loadingDomain = '';

  function setLoadingDomain(domain: string): void {
    loadingDomain = domain;
  }

  /** Falls back to "the name" on the preview and local-target paths, which have no dotNS name. */
  function getStepParts(message: string): StepPart[] {
    const at = message.indexOf(DOMAIN_TOKEN);
    if (at === -1) {
      return [message];
    }
    const name: StepPart = loadingDomain === '' ? 'the name' : { host: loadingDomain, tld: getActiveTldSuffix() };
    return [message.slice(0, at), name, message.slice(at + DOMAIN_TOKEN.length)].filter(part => part !== '');
  }

  let typingFrame: number | null = null;

  function cancelTyping(): void {
    if (typingFrame !== null) {
      frames.cancel(typingFrame);
      typingFrame = null;
      // An interrupted fade would otherwise leave the line stranded dim.
      loadingState.update({ explanationOpacity: 1 });
    }
  }

  function writeExplanation(next: string): void {
    cancelTyping();
    // Screen readers get the whole sentence once, from an element the typing never touches.
    loadingState.update({ srText: next });
    const previous = loadingState.get().explanation;
    if (next === previous || prefersReducedMotion() || !isLive()) {
      loadingState.update({ explanation: next });
      return;
    }
    const eraseMs = previous === '' ? 0 : ERASE_MS;
    const start = frames.now();
    function drawTypingFrame(now: number): void {
      const elapsedMs = now - start;
      // The frame clock can start a little before `start`, so a zero-length erase is skipped, not divided by.
      if (eraseMs > 0 && elapsedMs < eraseMs) {
        const gone = applyEaseInOut(elapsedMs / eraseMs);
        // Only a shallow dip, since deeper opacity once sank this block's contrast below AA.
        loadingState.update({
          explanation: previous.slice(0, Math.ceil(previous.length * (1 - gone))),
          explanationOpacity: 1 - 0.25 * gone,
        });
      } else if (elapsedMs < eraseMs + TYPE_MS) {
        const shown = applyEaseInOut((elapsedMs - eraseMs) / TYPE_MS);
        loadingState.update({
          explanation: next.slice(0, Math.ceil(next.length * shown)),
          explanationOpacity: 0.75 + 0.25 * shown,
        });
      } else {
        loadingState.update({ explanation: next, explanationOpacity: 1 });
        typingFrame = null;
        return;
      }
      typingFrame = frames.request(drawTypingFrame);
    }
    typingFrame = frames.request(drawTypingFrame);
  }

  /** Only moves forward, so a late event cannot walk the story backwards or restart a running stage. */
  function setLoadingStage(stage: LoadingStage): void {
    const stageIndex = LOADING_STAGES.indexOf(stage);
    if (stageIndex <= currentStageIndex) {
      return;
    }
    currentStageIndex = stageIndex;
    const [opening, ...explanations] = STAGE_MESSAGES[stage];
    stopStageMessages();
    const step = getStepParts(opening);
    loadingState.update({ step, explanation: '', explanationOpacity: 1, srText: toStepSentence(step) });
    // The opening step line has been up since first paint, so its first explanation is due from then.
    const firstDelay = openingLine ? Math.max(500, MESSAGE_ROTATE_MS - frames.now()) : MESSAGE_ROTATE_MS;
    openingLine = false;
    if (explanations.length === 0 || !isLive()) {
      return;
    }
    let line = -1;
    function showNextExplanation(): void {
      line = (line + 1) % explanations.length;
      writeExplanation(explanations[line] ?? '');
      stageTimer = timers.setTimeout(showNextExplanation, MESSAGE_ROTATE_MS);
    }
    stageTimer = timers.setTimeout(showNextExplanation, firstDelay);
  }

  function stopStageTimer(): void {
    if (stageTimer !== null) {
      timers.clearTimeout(stageTimer);
      stageTimer = null;
    }
  }

  function stopStageMessages(): void {
    stopStageTimer();
    cancelTyping();
  }

  /** No-op if the phase is already active or past. */
  function advancePhase(index: number): void {
    const phase = phases[index];
    if (index <= currentPhase || phase === undefined) {
      return;
    }
    currentPhase = index;

    const { base, target, expectedMs, reportsProgress } = phase;
    phaseReportsProgress = reportsProgress === true;
    if (base > currentProgress) {
      setProgress(base);
    }
    targetProgress = target;
    // A constant slice per tick, so the bar moves steadily through a long sync instead of stalling near the top.
    crawlStep = ((target - base) * CRAWL_TICK_MS) / Math.max(expectedMs, CRAWL_TICK_MS);
    creepCeiling = Math.min(getLentCeiling(phases[index + 1]), CREEP_CEILING);
    creepStep = (Math.max(creepCeiling - target, 0) * CRAWL_TICK_MS) / Math.max(CREEP_MS, CRAWL_TICK_MS);
    startProgressCrawl();

    setLoadingStage(phase.stage);
  }

  /**
   * Monotonic and clamped to the band, so a late or noisy signal never rewinds the bar. `stage` must be
   * the running one, so a signal cannot drive a band it does not own.
   */
  function nudgePhaseProgress(fraction: number, stage: LoadingStage): void {
    if (!Number.isFinite(fraction) || currentPhase < 0) {
      return;
    }
    const phase = phases[currentPhase];
    if (phase?.stage !== stage) {
      return;
    }
    const { base, target } = phase;
    const clamped = Math.max(0, Math.min(1, fraction));
    // Suppresses the crawl only until the work is done, then the creep carries the unreported tail.
    if (phase.reportsProgress === true) {
      phaseReportsProgress = clamped < 1;
    }
    const want = base + (target - base) * clamped;
    if (want > currentProgress) {
      setProgress(Math.min(want, target));
    }
  }

  /** For a `reportsProgress` step that will never report. Not a timeout, which fires regardless of progress. */
  function releasePhaseProgress(): void {
    phaseReportsProgress = false;
  }

  function stopStatusTick(): void {
    stopProgressCrawl();
    stopStageMessages();
    stopProgressWatch();
  }

  /** False once the screen is gone for good, so a late signal starts no orphan timer. */
  function isLive(): boolean {
    return loadingState.get().phase !== 'gone';
  }

  /** Without the fade, for a page that replaces the screen. */
  function hideLoading(): void {
    stopStatusTick();
    loadingState.update({ phase: 'gone' });
  }

  const stopFollowingPageContent = pageContent.listen(() => {
    if (pageContent.get() === 'screen') {
      hideLoading();
    }
  });

  /** Null hides it. */
  function setLoadingWarning(message: string | null): void {
    loadingState.update({ warning: message });
  }

  let fadeTimer: unknown = null;

  function dismissLoading(): void {
    completeProgress();
    stopProgressWatch();
    stopStageMessages();
    if (loadingState.get().phase !== 'active') {
      return;
    }
    loadingState.update({ phase: 'dismissing' });
    // The screen is removed only once its fade has finished.
    fadeTimer = timers.setTimeout(() => {
      fadeTimer = null;
      if (loadingState.get().phase === 'dismissing') {
        hideLoading();
      }
    }, FADE_MS);
  }

  function dispose(): void {
    stopFollowingPageContent();
    stopStatusTick();
    if (fadeTimer !== null) {
      timers.clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  // One-shot, for telemetry that must wait until the content fetch has dialled the Bulletin Chain.
  const sandboxDoneCallbacks: ((outcome: SandboxOutcome, failedStep: SandboxFailedStep) => void)[] = [];

  function onSandboxDone(callback: (outcome: SandboxOutcome, failedStep: SandboxFailedStep) => void): () => void {
    sandboxDoneCallbacks.push(callback);
    return removeSandboxDoneCallback;

    // A callback already called is gone, so this does nothing then.
    function removeSandboxDoneCallback(): void {
      const index = sandboxDoneCallbacks.indexOf(callback);
      if (index !== -1) {
        sandboxDoneCallbacks.splice(index, 1);
      }
    }
  }

  /** Returns the unsubscribe. */
  function listenForSandboxStatus(channel: SandboxChannel): () => void {
    return channel.on('dotli:loading-status', ({ done, outcome, failedStep: step }) => {
      // A `done` without an outcome only clears the overlay for an early sandbox prompt such as the
      // archive password, so the callbacks wait for the outcome.
      if (done !== true) {
        return;
      }
      dismissLoading();
      if (outcome === undefined) {
        return;
      }
      const failedStep = outcome === 'failed' && step !== undefined && FAILED_STEP_RE.test(step) ? step : undefined;
      for (const callback of sandboxDoneCallbacks.splice(0)) {
        callback(outcome, failedStep);
      }
    });
  }

  return {
    /**
     * Sets the listener that hears each time the bar stops afresh, replacing any previous one. Returns the function
     * that removes it, which does nothing once another listener replaced it. Never throws.
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
    /** Lets the bar crawl through a `reportsProgress` step that will never report. Never throws. */
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
     * Calls `callback` once, with the sandbox's first outcome on its content. Returns the function that removes it,
     * which does nothing once it was called. Never throws.
     */
    onSandboxDone,
    /** Drives the screen from the sandbox's status on `channel`. Returns the unsubscribe. Throws only as `channel.on` does. */
    listenForSandboxStatus,
    /**
     * Stops following the page's content, the crawl, the stage messages, the stall watch and the fade, leaving the
     * screen as it is. Throws only as the unsubscribe `pageContent` returned does.
     */
    dispose,
  };
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

function toStepSentence(parts: readonly StepPart[]): string {
  return parts.map(part => (typeof part === 'string' ? part : `${part.host}${part.tld}`)).join('');
}

function applyEaseInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - (-2 * progress + 2) ** 3 / 2;
}

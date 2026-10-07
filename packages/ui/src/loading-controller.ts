// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen's behaviour. It writes the loading store and touches no DOM, so it stays on the
// startup path without Solid.

import { getActiveTldSuffix, isSandboxOrigin } from '@dotli/config';

import { disposeAppRoot, registerAppRoot } from './mount/app-roots.js';
import { getLoadingState, updateLoading, type StepPart } from './state/loading.js';

/** A loading step owning the `[base, target]` band of the bar, crossed in about `expectedMs`. */
export interface LoadingPhase {
  label: string;
  base: number;
  target: number;
  expectedMs: number;
  stage: LoadingStage;
  /** The step reports a real percentage, so the bar waits instead of crawling past it. */
  reportsProgress?: boolean;
}
let phases: LoadingPhase[] = [];
let currentPhase = -1;

let currentProgress = 0;
let targetProgress = 0;
let crawlStep = 0;
let progressInterval: ReturnType<typeof setInterval> | null = null;

const CRAWL_TICK_MS = 200;

// A still number reads as a hang, so the shown percentage changes at least this often.
const PROGRESS_FLOOR_MS = 2_500;
let lastShownAt = 0;
let lastShown = -1;
/** The last number reached by real progress rather than by the floor creep. */
let lastRealShown = -1;

// Short of 100, so only a finished load can fill the bar.
const CREEP_CEILING = 99;
const CREEP_MS = 10_000;
let creepCeiling = 0;
let creepStep = 0;
let phaseReportsProgress = false;

// The per-chain watchdog cannot see a bar parked at its ceiling, such as a content chain with no peers.
const PROGRESS_STALL_MS = 4_000;

let progressStallTimer: ReturnType<typeof setTimeout> | null = null;
let progressStallListener: ((pct: number) => void) | null = null;

/** Fires each time the bar stops afresh. Replaces any previous listener. */
export function onProgressStall(listener: (pct: number) => void): void {
  progressStallListener = listener;
}

export function stopProgressWatch(): void {
  if (progressStallTimer !== null) {
    clearTimeout(progressStallTimer);
    progressStallTimer = null;
  }
}

function armProgressWatch(pct: number): void {
  stopProgressWatch();
  if (pct >= 100 || !trackLoadingRoot()) {
    return;
  }
  progressStallTimer = setTimeout(() => {
    progressStallListener?.(pct);
  }, PROGRESS_STALL_MS);
}

/** `cosmetic` movement does not re-arm the stall watch, or the stall warning could never appear. */
function setProgress(pct: number, cosmetic = false): void {
  const shown = Math.round(pct);
  if (shown !== lastShown) {
    lastShown = shown;
    lastShownAt = Date.now();
  }
  const moved = !cosmetic && shown !== lastRealShown;
  if (moved) {
    lastRealShown = shown;
  }
  currentProgress = pct;
  if (moved) {
    armProgressWatch(pct);
  }
  updateLoading({ progress: pct });
}

function startProgressCrawl(): void {
  stopProgressCrawl();
  if (!trackLoadingRoot()) {
    return;
  }
  progressInterval = setInterval(() => {
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
    if (Date.now() - lastShownAt >= PROGRESS_FLOOR_MS) {
      const ceiling = Math.min(phaseReportsProgress ? targetProgress : creepCeiling, CREEP_CEILING);
      const next = Math.min(Math.floor(currentProgress) + 1, ceiling);
      if (next > currentProgress) {
        setProgress(next, true);
      }
    }
  }, CRAWL_TICK_MS);
}

function stopProgressCrawl(): void {
  if (progressInterval !== null) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

export function completeProgress(): void {
  stopProgressCrawl();
  setProgress(100);
}

/** Call once before resolution begins. */
export function initPhases(phaseList: LoadingPhase[]): void {
  phases = phaseList;
  currentPhase = -1;
  currentStageIndex = -1;
  openingLine = true;
  currentProgress = 0;
  targetProgress = 0;
  phaseReportsProgress = false;
  lastShown = -1;
  lastRealShown = -1;
  lastShownAt = Date.now();
  trackLoadingRoot();

  // Not on the first `advancePhase`, seconds later. The markup already shows this stage's step line, so
  // the explanation clock starts now.
  setLoadingStage('starting');
}

// Most of this window is the turnover animation, so the finished sentence is still for only about 4s.
const MESSAGE_ROTATE_MS = 9_000;

const DOMAIN_TOKEN = '{domain}';

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** In the order they happen. */
export const LOADING_STAGES = ['starting', 'relay', 'assetHub', 'resolving', 'content', 'preparing'] as const;
export type LoadingStage = (typeof LOADING_STAGES)[number];

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

let stageTimer: ReturnType<typeof setTimeout> | null = null;
let currentStageIndex = -1;
/** True until the first stage turn, which the markup already painted. */
let openingLine = true;
let loadingDomain = '';

export function setLoadingDomain(domain: string): void {
  loadingDomain = domain;
}

/** Falls back to "the name" on the preview and local-target paths, which have no dotNS name. */
function stepParts(message: string): StepPart[] {
  const at = message.indexOf(DOMAIN_TOKEN);
  if (at === -1) {
    return [message];
  }
  const name: StepPart = loadingDomain === '' ? 'the name' : { host: loadingDomain, tld: getActiveTldSuffix() };
  return [message.slice(0, at), name, message.slice(at + DOMAIN_TOKEN.length)].filter(part => part !== '');
}

function stepSentence(parts: readonly StepPart[]): string {
  return parts.map(part => (typeof part === 'string' ? part : `${part.host}${part.tld}`)).join('');
}

// A fixed budget rather than a per-character delay, so any sentence lands inside the rotation interval.
const ERASE_MS = 1_400;
const TYPE_MS = 3_600;
let typingFrame: number | null = null;

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function cancelTyping(): void {
  if (typingFrame !== null) {
    cancelAnimationFrame(typingFrame);
    typingFrame = null;
    // An interrupted fade would otherwise leave the line stranded dim.
    updateLoading({ explanationOpacity: 1 });
  }
}

function writeExplanation(next: string): void {
  cancelTyping();
  // Screen readers get the whole sentence once, from an element the typing never touches.
  updateLoading({ srText: next });
  const previous = getLoadingState().explanation;
  if (next === previous || prefersReducedMotion() || !trackLoadingRoot()) {
    updateLoading({ explanation: next });
    return;
  }
  const eraseMs = previous === '' ? 0 : ERASE_MS;
  const start = performance.now();
  const step = (now: number): void => {
    const elapsedMs = now - start;
    // The frame clock can start a little before `start`, so a zero-length erase is skipped, not divided by.
    if (eraseMs > 0 && elapsedMs < eraseMs) {
      const gone = easeInOut(elapsedMs / eraseMs);
      // Only a shallow dip, since deeper opacity once sank this block's contrast below AA.
      updateLoading({
        explanation: previous.slice(0, Math.ceil(previous.length * (1 - gone))),
        explanationOpacity: 1 - 0.25 * gone,
      });
    } else if (elapsedMs < eraseMs + TYPE_MS) {
      const shown = easeInOut((elapsedMs - eraseMs) / TYPE_MS);
      updateLoading({
        explanation: next.slice(0, Math.ceil(next.length * shown)),
        explanationOpacity: 0.75 + 0.25 * shown,
      });
    } else {
      updateLoading({ explanation: next, explanationOpacity: 1 });
      typingFrame = null;
      return;
    }
    typingFrame = requestAnimationFrame(step);
  };
  typingFrame = requestAnimationFrame(step);
}

/** Only moves forward, so a late event cannot walk the story backwards or restart a running stage. */
export function setLoadingStage(stage: LoadingStage): void {
  const stageIndex = LOADING_STAGES.indexOf(stage);
  if (stageIndex <= currentStageIndex) {
    return;
  }
  currentStageIndex = stageIndex;
  const [opening, ...explanations] = STAGE_MESSAGES[stage];
  stopStageMessages();
  const step = stepParts(opening);
  updateLoading({ step, explanation: '', explanationOpacity: 1, srText: stepSentence(step) });
  // The opening step line has been up since first paint, so its first explanation is due from then.
  const firstDelay = openingLine ? Math.max(500, MESSAGE_ROTATE_MS - performance.now()) : MESSAGE_ROTATE_MS;
  openingLine = false;
  if (explanations.length === 0 || !trackLoadingRoot()) {
    return;
  }
  let line = -1;
  const turn = (): void => {
    line = (line + 1) % explanations.length;
    writeExplanation(explanations[line] ?? '');
    stageTimer = setTimeout(turn, MESSAGE_ROTATE_MS);
  };
  stageTimer = setTimeout(turn, firstDelay);
}

function stopStageTimer(): void {
  if (stageTimer !== null) {
    clearTimeout(stageTimer);
    stageTimer = null;
  }
}

function stopStageMessages(): void {
  stopStageTimer();
  cancelTyping();
}

/** No-op if the phase is already active or past. */
export function advancePhase(index: number): void {
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
  // An overrunning band creeps into the next one, unless that one reports a real percentage, which the
  // creep would overshoot.
  const next = phases[index + 1];
  const lentCeiling = next === undefined ? CREEP_CEILING : next.reportsProgress === true ? next.base : next.target;
  creepCeiling = Math.min(lentCeiling, CREEP_CEILING);
  creepStep = (Math.max(creepCeiling - target, 0) * CRAWL_TICK_MS) / Math.max(CREEP_MS, CRAWL_TICK_MS);
  startProgressCrawl();

  setLoadingStage(phase.stage);
}

/**
 * Monotonic and clamped to the band, so a late or noisy signal never rewinds the bar. `stage` must be
 * the running one, so a signal cannot drive a band it does not own.
 */
export function nudgePhaseProgress(fraction: number, stage: LoadingStage): void {
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
export function releasePhaseProgress(): void {
  phaseReportsProgress = false;
}

export function stopStatusTick(): void {
  stopProgressCrawl();
  stopStageMessages();
  stopProgressWatch();
}

let loadingRootLive = false;

/**
 * Registers the `"loading"` app root so whatever replaces the screen stops its timers. Called whenever a
 * timer starts. False once the screen is gone for good, so a late signal starts no orphan timer.
 */
function trackLoadingRoot(): boolean {
  if (getLoadingState().phase === 'gone') {
    return false;
  }
  if (loadingRootLive) {
    return true;
  }
  loadingRootLive = true;
  registerAppRoot('loading', () => {
    loadingRootLive = false;
    stopStatusTick();
    updateLoading({ phase: 'gone' });
  });
  return true;
}

// The screen is live from first paint, so it is a root before any timer starts, for whatever replaces it first.
trackLoadingRoot();

/** Without the fade, for a page that replaces the screen. */
export function hideLoading(): void {
  disposeAppRoot('loading');
}

/** Null hides it. */
export function setLoadingWarning(message: string | null): void {
  updateLoading({ warning: message });
}

export function dismissLoading(): void {
  completeProgress();
  stopProgressWatch();
  stopStageMessages();
  if (getLoadingState().phase !== 'active') {
    return;
  }
  // Tracked first, so there is a root to dispose even when no timer ever started. 300ms matches the fade.
  trackLoadingRoot();
  updateLoading({ phase: 'dismissing' });
  setTimeout(() => {
    if (getLoadingState().phase === 'dismissing') {
      disposeAppRoot('loading');
    }
  }, 300);
}

export type SandboxOutcome = 'loaded' | 'failed';

/** Becomes a Sentry tag from another origin, so anything but a short snake_case token is dropped. */
export type SandboxFailedStep = string | undefined;

const FAILED_STEP_RE = /^[a-z][a-z0-9_]{0,39}$/;

// One-shot, for telemetry that must wait until the content fetch has dialled the Bulletin Chain.
const sandboxDoneCallbacks: ((outcome: SandboxOutcome, failedStep: SandboxFailedStep) => void)[] = [];

export function onSandboxDone(cb: (outcome: SandboxOutcome, failedStep: SandboxFailedStep) => void): void {
  sandboxDoneCallbacks.push(cb);
}

export function listenForSandboxStatus(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    // Cheap shape check before the origin parse, since `message` carries all postMessage traffic.
    const data = event.data as Record<string, unknown> | null;
    if (data === null || typeof data !== 'object' || data['type'] !== 'dotli:loading-status') {
      return;
    }
    // Otherwise any frame or extension could spoof the status or dismiss the overlay early.
    if (!isSandboxOrigin(event.origin)) {
      return;
    }
    // A `done` without an outcome only clears the overlay for an early sandbox prompt such as the
    // archive password, so the callbacks wait for the outcome.
    if (data['done'] === true) {
      dismissLoading();
      const outcome = data['outcome'];
      if (outcome === 'loaded' || outcome === 'failed') {
        const step = data['failedStep'];
        const failedStep =
          outcome === 'failed' && typeof step === 'string' && FAILED_STEP_RE.test(step) ? step : undefined;
        for (const cb of sandboxDoneCallbacks.splice(0)) {
          cb(outcome, failedStep);
        }
      }
    }
  });
}

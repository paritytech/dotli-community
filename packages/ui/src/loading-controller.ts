// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen's behaviour: the progress bar, the stage narration, the
// stall watch and the dismiss. It writes the loading store, which the loading
// screen island (components/shell/LoadingScreen.tsx) renders, so it stays on
// the startup path without Solid. The one DOM it touches is the static screen
// from apps/host/index.html, which it removes when the loading root is
// disposed before the island has taken the screen over.

import { isSandboxOrigin, withActiveTld } from "@dotli/config";

import { disposeAppRoot, registerAppRoot } from "./mount/app-roots.js";
import { getLoadingState, updateLoading } from "./state/loading.js";

// Phase-based loading indicator.
//
// Each phase owns a `[base, target]` band of the bar plus an `expectedMs`:
// how long that step typically takes. Two things follow from `expectedMs`,
// and together they make the bar track real work instead of an arbitrary
// easing curve (the Asset Hub finalized-block sync dwarfs every other step,
// so callers size their bands and durations accordingly):
//   - Band WIDTH is sized to the step's share of total load time, so the
//     one dominant sync step owns most of the bar.
//   - Crawl SPEED is paced so the band is crossed in roughly `expectedMs`,
//     advancing steadily across the whole step rather than decelerating and
//     parking near the top (the old asymptotic crawl barely moved during a
//     30s sync, which is exactly the symptom we are fixing).
export interface LoadingPhase {
  label: string;
  base: number;
  target: number;
  expectedMs: number;
  /** Which set of messages narrates this phase. */
  stage: LoadingStage;
  /**
   * This step publishes a true percentage, so the indicator waits for it.
   *
   * Without this the crawl guessed its way to 84% during the first seconds
   * of a download and then had nowhere to go, because the real figure that
   * followed was lower and the indicator never moves backwards.
   */
  reportsProgress?: boolean;
}
let phases: LoadingPhase[] = [];
let currentPhase = -1;

// Progress indicator state
let currentProgress = 0;
let targetProgress = 0;
let crawlStep = 0;
let progressInterval: ReturnType<typeof setInterval> | null = null;

const CRAWL_TICK_MS = 200;

// Where an exhausted band creeps on to, and how long it takes. Stops short
// of 100 so only a finished load can fill the indicator.
/**
 * The displayed whole number must change at least this often.
 *
 * Measured over ten cold loads, the bar sat at 62% for up to 41 seconds while a
 * step waited on bytes that never came. A still number reads as a hang, so it
 * always creeps, capped by the band the step owns.
 */
const PROGRESS_FLOOR_MS = 2_500;
let lastShownAt = 0;
let lastShown = -1;
/** The last number reached by real progress rather than by the floor creep. */
let lastRealShown = -1;

const CREEP_CEILING = 99;
const CREEP_MS = 10_000;
let creepCeiling = 0;
let creepStep = 0;
/** True while the current step owes the indicator a real percentage. */
let phaseReportsProgress = false;

/**
 * How long the bar may sit at one percentage before it owes an explanation.
 *
 * The per-chain watchdog cannot see this. A load whose content chain never
 * finds a peer leaves every chain lifecycle quiet while the bar creeps to its
 * ceiling and parks, measured at over a minute in one run.
 */
const PROGRESS_STALL_MS = 4_000;

let progressStallTimer: ReturnType<typeof setTimeout> | null = null;
let progressStallListener: ((pct: number) => void) | null = null;

/**
 * Report when the bar stops moving, and again each time it stops afresh.
 *
 * The listener is handed the percentage it stalled at, so the caller can say
 * where the load got to. Replaces any previous listener.
 */
export function onProgressStall(listener: (pct: number) => void): void {
  progressStallListener = listener;
}

/** Stop watching, for a load that finished or failed. */
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

/**
 * Move the bar.
 *
 * `cosmetic` marks the movement-floor creep, which exists so the number never
 * stands still. It deliberately does not count as progress: if it did, it would
 * re-arm the stall watch every couple of seconds and the warning explaining the
 * stall could never appear.
 */
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
    // A step that reports a real percentage owns the indicator, so neither the
    // crawl nor the creep may run past what it says. Both are guesses, and a
    // download slower than the estimate would otherwise walk the bar to nearly
    // full while the readout underneath still said 58%.
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
    // Whatever owns the indicator, the number still has to move. Nudge it just
    // past the next whole number, never beyond the band the current step owns.
    if (Date.now() - lastShownAt >= PROGRESS_FLOOR_MS) {
      const ceiling = Math.min(
        phaseReportsProgress ? targetProgress : creepCeiling,
        CREEP_CEILING,
      );
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

/**
 * Snap the progress bar to 100%.
 * Called when loading is done, before the overlay fades out.
 */
export function completeProgress(): void {
  stopProgressCrawl();
  setProgress(100);
}

/**
 * Initialize the loading progress indicator.
 * Call once before resolution/fetching begins.
 */
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

  // Not on the first `advancePhase`, which lands seconds later once the
  // protocol frame is up. The markup already shows this stage's opening line,
  // so the rotation clock has to start from when that line became visible.
  setLoadingStage("starting");
}

// How often the line turns over. Most of this window is the turnover
// animation, so the finished sentence itself is only still for the last ~4s.
const MESSAGE_ROTATE_MS = 9_000;

/** Placeholder swapped for the domain being loaded when a message is shown. */
const DOMAIN_TOKEN = "{domain}";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The steps a load moves through, in the order they happen. */
export const LOADING_STAGES = [
  "starting",
  "relay",
  "assetHub",
  "resolving",
  "content",
  "preparing",
] as const;
export type LoadingStage = (typeof LOADING_STAGES)[number];

/**
 * What the shell is doing, in the user's terms.
 *
 * The first line of each stage names the step. The rest explain what a light
 * client is doing, and only a slow load reaches them. List lengths follow how
 * long each step runs, so the long ones do not repeat.
 */
const STAGE_MESSAGES: Record<LoadingStage, string[]> = {
  starting: [
    "Reaching out",
    "This page comes from a network, with no one in between",
    "That takes a few seconds the first time",
  ],
  relay: [
    "Connecting to Polkadot",
    "Looking for other computers to talk to",
    "Your browser does the checking itself, not a server",
  ],
  assetHub: [
    `Looking up ${DOMAIN_TOKEN}`,
    "Catching up on the newest blocks",
    "The network itself decides where this name points",
    "This is the slow part, and it is faster next time",
  ],
  resolving: [
    "Found it",
    "Reading where the name points",
    "The network proved this answer, so it cannot be faked",
  ],
  content: [
    "Downloading the app",
    "The files come from many computers at once",
    "The more of them are nearby, the faster this goes",
    "Every piece is checked against its fingerprint as it lands",
    "No single computer holds the app, so no one can take it down",
    "Bigger apps take longer the first time",
    "Your browser keeps a copy, so the next visit is quick",
  ],
  preparing: [
    "Got everything",
    "Unpacking the files",
    "Handing over to the app",
    "Almost there",
  ],
};

let stageTimer: ReturnType<typeof setTimeout> | null = null;
let currentStageIndex = -1;
/** True until the first stage turn, which the markup already painted. */
let openingLine = true;
let loadingDomain = "";

/** Name the domain being loaded, for the messages that mention it. */
export function setLoadingDomain(domain: string): void {
  loadingDomain = domain;
}

// A fixed budget rather than a per-character delay, so a long sentence
// animates at the same pace as a short one and always lands inside the
// rotation interval.
const ERASE_MS = 1_400;
const TYPE_MS = 3_600;
let typingFrame: number | null = null;
let pendingMessage: string | null = null;

/** Slow at both ends, quickest in the middle. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function cancelTyping(): void {
  pendingMessage = null;
  if (typingFrame !== null) {
    cancelAnimationFrame(typingFrame);
    typingFrame = null;
    // An interrupted fade would otherwise leave the line stranded dim.
    updateLoading({ statusOpacity: 1 });
  }
}

function writeStatus(message: string): void {
  // Falls back to "the name" when no domain has been set, which is the
  // preview and local-target paths where there is no dotNS name to show.
  const next = message.replace(
    DOMAIN_TOKEN,
    loadingDomain === "" ? "the name" : withActiveTld(loadingDomain),
  );
  // Screen readers get the whole sentence once, from an element the typing
  // never touches.
  updateLoading({ srText: next });
  // A sentence already being typed is left to finish. Stages turn over faster
  // than a line takes to render on a quick load, and cutting one off mid-word
  // meant a step's opening line was never actually read: the screen went
  // straight from "Reaching out" to the download copy. Only the newest
  // waiting sentence is kept, so the queue can never fall behind by more
  // than one.
  if (typingFrame !== null) {
    pendingMessage = next;
    return;
  }
  const previous = getLoadingState().statusText;
  if (next === previous || prefersReducedMotion() || !trackLoadingRoot()) {
    updateLoading({ statusText: next });
    return;
  }
  const start = performance.now();
  const step = (now: number): void => {
    const elapsedMs = now - start;
    if (elapsedMs < ERASE_MS) {
      const gone = easeInOut(elapsedMs / ERASE_MS);
      // Dims as it empties and brightens as the new line arrives, so the
      // turnover reads as one settling motion rather than a text scramble.
      // Only a shallow dip: the contrast of this block is built on solid colours
      // precisely because opacity once sank it below AA, and 0.75 of #d4d4d4
      // is still 7.5:1 against the page.
      updateLoading({
        statusText: previous.slice(0, Math.ceil(previous.length * (1 - gone))),
        statusOpacity: 1 - 0.25 * gone,
      });
    } else if (elapsedMs < ERASE_MS + TYPE_MS) {
      const shown = easeInOut((elapsedMs - ERASE_MS) / TYPE_MS);
      updateLoading({
        statusText: next.slice(0, Math.ceil(next.length * shown)),
        statusOpacity: 0.75 + 0.25 * shown,
      });
    } else {
      updateLoading({ statusText: next, statusOpacity: 1 });
      typingFrame = null;
      if (pendingMessage !== null) {
        const queued = pendingMessage;
        pendingMessage = null;
        writeStatus(queued);
      }
      return;
    }
    typingFrame = requestAnimationFrame(step);
  };
  typingFrame = requestAnimationFrame(step);
}

/**
 * Move to a stage and start cycling its messages.
 *
 * Only ever moves forward. Re-entering the running stage is ignored so the
 * copy does not restart on every signal for a step already underway, and an
 * earlier stage is refused so a late event cannot walk the story backwards.
 */
export function setLoadingStage(stage: LoadingStage): void {
  const stageIndex = LOADING_STAGES.indexOf(stage);
  if (stageIndex <= currentStageIndex) {
    return;
  }
  currentStageIndex = stageIndex;
  const messages = STAGE_MESSAGES[stage];
  let line = 0;
  // Only the rotation clock is stopped here. Cancelling the typing as well
  // would kill the animation this very line was just queued behind and drop
  // the queue with it, stranding the headline on a half-typed word.
  stopStageTimer();
  writeStatus(messages[0]);
  // Cycle back to the second line rather than the first: the opener names
  // the step, and showing it again would read as the load starting over.
  const loopFrom = messages.length > 2 ? 1 : 0;
  // The opening line has been on screen since the page painted, so its turn
  // is due relative to that, not to whenever this ran. Later turns get the
  // full interval.
  const firstDelay = openingLine
    ? Math.max(500, MESSAGE_ROTATE_MS - performance.now())
    : MESSAGE_ROTATE_MS;
  openingLine = false;
  const turn = (): void => {
    line = line + 1 >= messages.length ? loopFrom : line + 1;
    writeStatus(messages[line]);
    stageTimer = setTimeout(turn, MESSAGE_ROTATE_MS);
  };
  if (!trackLoadingRoot()) {
    return;
  }
  stageTimer = setTimeout(turn, firstDelay);
}

function stopStageTimer(): void {
  if (stageTimer !== null) {
    clearTimeout(stageTimer);
    stageTimer = null;
  }
}

/** Stop narrating entirely: no more turns, and no line half-written. */
function stopStageMessages(): void {
  stopStageTimer();
  cancelTyping();
}

/**
 * Advance to a specific phase (0-indexed).
 * Jumps the indicator to the base percentage of the phase and begins crawling
 * toward its target. Updates the headline text.
 * No-ops if the phase is already active or past.
 */
export function advancePhase(index: number): void {
  if (index <= currentPhase || index >= phases.length) {
    return;
  }
  currentPhase = index;

  const { base, target, expectedMs, reportsProgress } = phases[index];
  // Each step has to earn the indicator back: the real progress of the previous step
  // percentage says nothing about this one. A step that publishes its own
  // figure holds the indicator at its band base until the figure arrives,
  // rather than crawling somewhere the real number cannot then reach.
  phaseReportsProgress = reportsProgress === true;
  if (base > currentProgress) {
    setProgress(base);
  }
  targetProgress = target;
  // Pace the crawl so the band is traversed over the typical time of the step
  // duration: each tick advances a constant slice sized to cross from
  // `base` to `target` in `expectedMs`. This is what makes the bar move
  // steadily through a long sync instead of stalling near the top.
  crawlStep =
    ((target - base) * CRAWL_TICK_MS) / Math.max(expectedMs, CRAWL_TICK_MS);
  // Headroom for a band that overruns: the space of the next band, or the ceiling
  // for the last one. A band that reports a real percentage lends nothing,
  // since creeping into it would put the indicator above the figure that step
  // is about to publish.
  const next = phases[index + 1] as LoadingPhase | undefined;
  const lentCeiling =
    next === undefined
      ? CREEP_CEILING
      : next.reportsProgress === true
        ? next.base
        : next.target;
  creepCeiling = Math.min(lentCeiling, CREEP_CEILING);
  creepStep =
    (Math.max(creepCeiling - target, 0) * CRAWL_TICK_MS) /
    Math.max(CREEP_MS, CRAWL_TICK_MS);
  startProgressCrawl();

  // The headline is the stage's, not the phase label's: the label names the
  // step for us, the stage says it in words the visitor can act on. Adjacent
  // phases can share one stage, and re-entering a running stage is a no-op.
  setLoadingStage(phases[index].stage);
}

/**
 * Pull the indicator to a real fraction of the band `stage` owns.
 *
 * Takes the indicator over from the crawl for as long as that step has
 * something to say. Monotonic and clamped to the band, so a late or noisy
 * signal can never rewind it.
 *
 * The `stage` is checked against the running one, so a signal cannot drive a
 * band it does not own. Without it the relay warp fraction arriving mid-sync
 * would both move the Asset Hub band and freeze its crawl.
 */
export function nudgePhaseProgress(
  fraction: number,
  stage: LoadingStage,
): void {
  if (!Number.isFinite(fraction) || currentPhase < 0) {
    return;
  }
  const phase = phases[currentPhase];
  if (phase.stage !== stage) {
    return;
  }
  const { base, target } = phase;
  const clamped = Math.max(0, Math.min(1, fraction));
  // Only a band that asked to be driven this way may suppress the crawl, and
  // only until its own work is done. After that the creep carries the
  // indicator through the tail, which nothing reports on.
  if (phase.reportsProgress === true) {
    phaseReportsProgress = clamped < 1;
  }
  const want = base + (target - base) * clamped;
  if (want > currentProgress) {
    setProgress(Math.min(want, target));
  }
}

/**
 * Give the indicator back to the clock.
 *
 * A step that declared `reportsProgress` holds the indicator until it can say
 * where the work is. This is how it admits it never will.
 *
 * Deliberately not a timeout. A timeout fired whether or not anything was
 * happening, so a load whose content chain never found a peer still crept to
 * 99% and sat there claiming to be nearly done.
 */
export function releasePhaseProgress(): void {
  phaseReportsProgress = false;
}

/** Stop everything the loading screen has running. */
export function stopStatusTick(): void {
  stopProgressCrawl();
  stopStageMessages();
  stopProgressWatch();
}

/** True while the loading screen is registered as the `"loading"` app root. */
let loadingRootLive = false;

/** The static screen apps/host/index.html paints. */
function removeStaticScreen(): void {
  document.getElementById("app-loading")?.remove();
}

/**
 * Takes the loading screen off the page, as part of disposing the loading
 * root. The static screen until the island adopts it, then the island.
 */
let disposeScreen: () => void = removeStaticScreen;

/**
 * Track the loading screen as the `"loading"` app root, so whatever replaces
 * it (the product frame, an error page) stops its timers instead of leaving
 * them running behind the new content.
 *
 * Called whenever a timer starts, so no timer runs without a live root to
 * stop it. Once per root: starting the phases again must not dispose the
 * screen it is about to drive.
 *
 * Returns false once the screen is gone, which is terminal: nothing puts it
 * back, so a late signal (content bytes after `done`, a signal behind an
 * error page) must not start a timer that no root would ever stop.
 */
function trackLoadingRoot(): boolean {
  if (getLoadingState().phase === "gone") {
    return false;
  }
  if (loadingRootLive) {
    return true;
  }
  loadingRootLive = true;
  registerAppRoot("loading", () => {
    loadingRootLive = false;
    // Covers the crawl, the stage messages and the stall watch.
    stopStatusTick();
    updateLoading({ phase: "gone" });
    // Back to the static fallback, so the island is never disposed twice.
    const dispose = disposeScreen;
    disposeScreen = removeStaticScreen;
    dispose();
  });
  return true;
}

/**
 * Hand the loading root's screen over to the island that replaced the static
 * one: disposing the root now runs `dispose` instead of removing the static
 * screen. The root itself, and every timer it tracks, carries on untouched.
 */
export function adoptLoadingScreen(dispose: () => void): void {
  disposeScreen = dispose;
  trackLoadingRoot();
}

// The static screen is live from first paint, so it is a root before any
// timer starts. Whatever replaces it first (the landing page, a preview or
// local-target frame, an error page shown before the phases start) then
// removes it.
if (typeof document !== "undefined" && document.getElementById("app-loading")) {
  trackLoadingRoot();
}

/**
 * Show or clear the stall warning under the sentences.
 *
 * Passing null hides it. The host decides when a chain has stopped moving and
 * what to say, this only renders it.
 */
export function setLoadingWarning(message: string | null): void {
  updateLoading({ warning: message });
}

/**
 * Remove the loading overlay (logo, progress bar, log).
 * Called when the app is fully loaded and the iframe is ready.
 */
export function dismissLoading(): void {
  completeProgress();
  stopProgressWatch();
  stopStageMessages();
  if (getLoadingState().phase !== "active") {
    return;
  }
  // The fade is a 0.3s opacity transition, so the screen goes once it ends,
  // with its root. Tracked first, so there is a root to dispose even for a
  // screen whose load never started a timer.
  trackLoadingRoot();
  updateLoading({ phase: "dismissing" });
  setTimeout(() => {
    if (getLoadingState().phase === "dismissing") {
      disposeAppRoot("loading");
    }
  }, 300);
}

/**
 * Listen for status messages from the sandbox iframe.
 * The sandbox posts { type: "dotli:loading-status", message } in relay mode.
 *
 * Only messages from a sandbox origin (`<label>.app.<root>`) may drive the
 * host loading overlay. Without this gate any frame on the page (e.g. a
 * nested cross-origin frame or browser extension) could spoof the status
 * text or prematurely dismiss the overlay while content is still loading.
 */
// One-shot subscribers for the sandbox's terminal `done` signal. The host
// uses it to time telemetry that must not be captured before the content
// fetch has run (the bulletin chain is only dialed during that fetch).
const sandboxDoneCallbacks: (() => void)[] = [];

export function onSandboxDone(cb: () => void): void {
  sandboxDoneCallbacks.push(cb);
}

export function listenForSandboxStatus(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    // Cheap shape check first — `message` fires for all postMessage traffic
    // (bridge, bitswap relay, extensions); only parse the origin once a message
    // is actually a loading-status candidate. The origin gate still runs before
    // any side effect. Mirrors `listenForSandboxBitswap`'s check ordering.
    const data = event.data as Record<string, unknown> | null;
    if (
      data === null ||
      typeof data !== "object" ||
      data["type"] !== "dotli:loading-status"
    ) {
      return;
    }
    if (!isSandboxOrigin(event.origin)) {
      return;
    }
    // The progress prose the sandbox writes is written for a developer reading
    // the console, so it is left there. The stage messages narrate this step
    // to the user, and `done` is the part the loading screen acts on.
    if (data["done"] === true) {
      dismissLoading();
      for (const cb of sandboxDoneCallbacks.splice(0)) {
        cb();
      }
    }
  });
}

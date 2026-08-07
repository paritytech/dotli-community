// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Pure DOM UI helpers
//
// Status messages, error states, and landing page.
// No heavy dependencies, kept in the eager bundle.

import { loadRecentLabels, forgetRecentLabel } from "./recent-labels";
import { BASE_DOMAIN, isSandboxOrigin } from "@dotli/config/config";
import { escapeHtml, validateDotLabel } from "@dotli/shared/html";
import type { DotLabelResult } from "@dotli/shared/html";

const app = document.getElementById("app") ?? document.body;

function dotUrl(label: string): string {
  const host = window.location.hostname;
  if (host.endsWith(".localhost") || host === "localhost") {
    return `${window.location.protocol}//${label}.localhost:${window.location.port}`;
  }
  return `https://${label}.${BASE_DOMAIN}`;
}

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
let progressFillEl: HTMLElement | null = null;
let progressLogoEl: HTMLElement | null = null;
let statusBlockEl: HTMLElement | null = null;
let metricAssetHubPeersEl: HTMLElement | null = null;
let metricBulletinPeersEl: HTMLElement | null = null;
let metricSpeedEl: HTMLElement | null = null;
let metricCompletedEl: HTMLElement | null = null;
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let currentProgress = 0;
let targetProgress = 0;
let crawlStep = 0;
let progressInterval: ReturnType<typeof setInterval> | null = null;

const CRAWL_TICK_MS = 200;

// A band that runs longer than its estimate used to leave the bar frozen at
// the band top: the worst case was the last one, which reached 95% and sat
// there for up to 6s while the sandbox unpacked and painted. When a band is
// exhausted the bar creeps on into the next band's space, which is free
// because the step that owns it has not started. The creep is slow enough to
// read as waiting rather than as a second, faster load, and it stops short
// of 100 so only a finished load can fill the bar. Paced so the displayed
// whole number keeps changing every few seconds rather than twice in total.
const CREEP_CEILING = 99;
const CREEP_MS = 10_000;
let creepCeiling = 0;
let creepStep = 0;
/** True while the current step is reporting a real percentage of its own. */
let phaseReportsProgress = false;
let progressGraceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long a step that promised a real percentage gets to deliver one.
 *
 * If it stays silent past this the crawl takes over, so a missing byte total
 * leaves the indicator parked rather than guessing.
 */
const PROGRESS_GRACE_MS = 3_000;

function clearProgressGrace(): void {
  if (progressGraceTimer !== null) {
    clearTimeout(progressGraceTimer);
    progressGraceTimer = null;
  }
}

function setProgress(pct: number): void {
  currentProgress = pct;
  if (progressFillEl !== null) {
    // Clip away the right, so the colour sweeps in from the left edge.
    progressFillEl.style.clipPath = `inset(0 ${String(100 - pct)}% 0 0)`;
  }
  // The bar carried no percentage for a screen reader to announce. Now that
  // the logo is the indicator, it says the number out loud.
  progressLogoEl?.setAttribute("aria-valuenow", String(Math.round(pct)));
}

function startProgressCrawl(): void {
  stopProgressCrawl();
  progressInterval = setInterval(() => {
    // A step that reports a real percentage owns the indicator outright. The
    // crawl and the creep are both guesses at how long a step takes, and on a
    // download slower than the estimate they ran the logo to nearly full
    // while the readout underneath still said 58%. Nothing that guesses may
    // move the indicator past something that knows.
    if (phaseReportsProgress) {
      return;
    }
    if (currentProgress < targetProgress) {
      setProgress(Math.min(currentProgress + crawlStep, targetProgress));
      return;
    }
    if (currentProgress < creepCeiling) {
      setProgress(Math.min(currentProgress + creepStep, creepCeiling));
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
 * Fill the logo completely.
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
  clearProgressGrace();

  progressFillEl = document.getElementById("loading-logo-fill");
  progressLogoEl = document.getElementById("loading-logo");
  statusBlockEl = document.getElementById("loading-status");
  metricAssetHubPeersEl = document.getElementById("metric-peers-assethub");
  metricBulletinPeersEl = document.getElementById("metric-peers-bulletin");
  metricSpeedEl = document.getElementById("metric-speed");
  metricCompletedEl = document.getElementById("metric-completed");

  // A load that finishes quickly should never explain itself. Only once it
  // has run long enough to feel slow does the status block appear.
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
  }
  revealTimer = setTimeout(() => {
    statusBlockEl?.classList.add("visible");
  }, STATUS_REVEAL_MS);

  // Start narrating here rather than waiting for the first `advancePhase`,
  // which lands a couple of seconds later once the protocol frame is up. The
  // markup already shows this stage's opening line, so nothing moves on
  // screen; what matters is that the rotation clock starts when the line
  // first becomes visible, not when the resolver gets going. Without this the
  // opener sat for over five seconds on a cold load.
  setLoadingStage("starting");
}

/** How long a load may run before it owes the user an explanation. */
export const STATUS_REVEAL_MS = 3_000;

// How often the line turns over. Longer than the three seconds a *static*
// message is allowed, because most of this window is the turnover animation
// rather than a still sentence: 3s of characters moving, then ~1.5s at rest.
// A slower, calmer type-in cannot fit inside a 3s cycle and still leave the
// finished sentence up long enough to read.
const MESSAGE_ROTATE_MS = 4_500;

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
 * The headline used to print the resolver's own prose, which is where
 * "Walking dag-pb via bitswap..." came from. These say the same thing in
 * plain words. Each stage carries several lines because a step can run for
 * half a minute, and one frozen sentence reads as a hang. The first line of
 * each stage names the step. The rest explain what a light client is doing
 * and why it takes the time it does, so a slow load teaches something
 * instead of just apologising.
 *
 * The lists are sized to how long each step actually runs, measured over ten
 * cold loads: content is the long pole at a 13s median and 89s worst case,
 * while every other step finishes inside 1.5s and rarely shows more than its
 * opener. Content and preparing therefore carry enough lines to cover a slow
 * load without repeating.
 */
const STAGE_MESSAGES: Record<LoadingStage, string[]> = {
  starting: [
    "Reaching out",
    "This page is verified by a network, with no one in between",
    "That takes a few seconds the first time",
  ],
  relay: [
    "Connecting to Polkadot",
    "Looking for other computers on the network to talk to",
    "Your browser does the checking itself, not a server",
  ],
  assetHub: [
    `Looking up ${DOMAIN_TOKEN}`,
    "Catching up with the latest blocks",
    "The name and its address come from the network itself",
    "This is the slow part, and it is faster next time",
  ],
  resolving: [
    "I found it",
    "Reading the address it points at",
    "The network proved this answer, so it cannot be faked",
  ],
  content: [
    "Downloading the app",
    "The files come from multiple peers across the network",
    "Speed depends on how many are nearby",
    "Every piece is checked against its fingerprint as it lands",
    "No single machine is serving this, so there is nothing to take down",
    "Bigger apps take longer the first time",
    "Your browser keeps a copy, so the next visit is quick",
  ],
  preparing: [
    "Download complete. We are preparing your app.",
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

// The old line is deleted a character at a time and the new one typed in.
// Both get a fixed budget rather than a per-character delay, so a long
// sentence animates at the same pace as a short one and always lands inside
// the rotation interval. At these durations a full-length sentence types at
// roughly 24 characters a second, which reads as deliberate rather than
// frantic, and clears away faster than it arrives.
const ERASE_MS = 800;
const TYPE_MS = 2_200;
let typingFrame: number | null = null;
let pendingMessage: string | null = null;

/**
 * Slow at both ends, quickest in the middle.
 *
 * A constant character rate is what made the change feel frantic: characters
 * appeared and vanished at full speed the instant a sentence turned over.
 * Easing means each sentence starts and finishes gently, and only the
 * unremarkable middle runs fast.
 */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function cancelTyping(): void {
  pendingMessage = null;
  if (typingFrame !== null) {
    cancelAnimationFrame(typingFrame);
    typingFrame = null;
    // An interrupted fade would otherwise leave the line stranded dim.
    const status = document.getElementById("status");
    if (status !== null) {
      status.style.opacity = "1";
    }
  }
}

function writeStatus(message: string): void {
  const status = document.getElementById("status");
  if (status === null) {
    return;
  }
  // Falls back to "the name" when no domain has been set, which is the
  // preview and local-target paths where there is no `.dot` to name.
  const next = message.replace(
    DOMAIN_TOKEN,
    loadingDomain === "" ? "the name" : `${loadingDomain}.dot`,
  );
  // Screen readers get the whole sentence once, from an element the typing
  // never touches.
  const announce = document.getElementById("status-sr");
  if (announce !== null) {
    announce.textContent = next;
  }
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
  const previous = status.textContent;
  if (next === previous || prefersReducedMotion()) {
    status.textContent = next;
    return;
  }
  const start = performance.now();
  const step = (now: number): void => {
    const elapsedMs = now - start;
    if (elapsedMs < ERASE_MS) {
      const gone = easeInOut(elapsedMs / ERASE_MS);
      status.textContent = previous.slice(
        0,
        Math.ceil(previous.length * (1 - gone)),
      );
      // Dims as it empties and brightens as the new line arrives, so the
      // turnover reads as one settling motion rather than a text scramble.
      // Only a shallow dip: this block's contrast is built on solid colours
      // precisely because opacity once sank it below AA, and 0.75 of #d4d4d4
      // is still 7.5:1 against the page.
      status.style.opacity = String(1 - 0.25 * gone);
    } else if (elapsedMs < ERASE_MS + TYPE_MS) {
      const shown = easeInOut((elapsedMs - ERASE_MS) / TYPE_MS);
      status.textContent = next.slice(0, Math.ceil(next.length * shown));
      status.style.opacity = String(0.75 + 0.25 * shown);
    } else {
      status.textContent = next;
      status.style.opacity = "1";
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
  // The opening line is in the markup, so it has been on screen since the
  // page painted while this code waited on the protocol frame. Its turn is
  // therefore due three seconds after the page appeared, not three seconds
  // from here. Measured cold, that gap was 2.8s, and charging it to the
  // first message left it up for 5.6s. Later turns get the full interval.
  const firstDelay = openingLine
    ? Math.max(500, MESSAGE_ROTATE_MS - performance.now())
    : MESSAGE_ROTATE_MS;
  openingLine = false;
  const turn = (): void => {
    line = line + 1 >= messages.length ? loopFrom : line + 1;
    writeStatus(messages[line]);
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

/** Stop narrating entirely: no more turns, and no line half-written. */
function stopStageMessages(): void {
  stopStageTimer();
  cancelTyping();
}

/** Report what the light client itself is doing, e.g. "AssetHub ready". */
export function setLifecycleStatus(text: string): void {
  const el = document.getElementById("metric-lifecycle");
  if (el !== null) {
    el.textContent = text;
  }
}

/**
 * Live counters under the status line.
 *
 * Each is written only when supplied, and each starts as an em dash rather
 * than a zero: before the download begins there is no speed to report, and
 * "0 MB/s" reads as broken where "not yet" reads as honest. Peers are per
 * chain because one shared figure had to be blanked at every handover,
 * which put a zero on screen at the moments the load looked slowest.
 */
export function setLoadingMetrics(metrics: {
  assetHubPeers?: number;
  bulletinPeers?: number;
  bytesPerSecond?: number;
  completedFraction?: number;
}): void {
  if (metrics.assetHubPeers !== undefined && metricAssetHubPeersEl !== null) {
    metricAssetHubPeersEl.textContent = String(metrics.assetHubPeers);
  }
  if (metrics.bulletinPeers !== undefined && metricBulletinPeersEl !== null) {
    metricBulletinPeersEl.textContent = String(metrics.bulletinPeers);
  }
  if (metrics.bytesPerSecond !== undefined && metricSpeedEl !== null) {
    metricSpeedEl.textContent = `${(metrics.bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
  }
  if (metrics.completedFraction !== undefined && metricCompletedEl !== null) {
    const pct = Math.min(100, Math.max(0, metrics.completedFraction * 100));
    metricCompletedEl.textContent = `${String(Math.round(pct))} %`;
  }
}

/**
 * Advance to a specific phase (0-indexed).
 * Jumps the indicator to the phase's base percentage and begins crawling
 * toward its target. Updates the headline text.
 * No-ops if the phase is already active or past.
 */
export function advancePhase(index: number): void {
  if (index <= currentPhase || index >= phases.length) {
    return;
  }
  currentPhase = index;

  // Update progress bar
  const { base, target, label, expectedMs, reportsProgress } = phases[index];
  // Each step has to earn the indicator back: the previous step's real
  // percentage says nothing about this one. A step that publishes its own
  // figure holds the indicator at its band base until the figure arrives,
  // rather than crawling somewhere the real number cannot then reach.
  clearProgressGrace();
  phaseReportsProgress = reportsProgress === true;
  if (phaseReportsProgress) {
    progressGraceTimer = setTimeout(() => {
      phaseReportsProgress = false;
      progressGraceTimer = null;
    }, PROGRESS_GRACE_MS);
  }
  if (base > currentProgress) {
    setProgress(base);
  }
  targetProgress = target;
  // Pace the crawl so the band is traversed over the step's typical
  // duration: each tick advances a constant slice sized to cross from
  // `base` to `target` in `expectedMs`. This is what makes the bar move
  // steadily through a long sync instead of stalling near the top.
  crawlStep =
    ((target - base) * CRAWL_TICK_MS) / Math.max(expectedMs, CRAWL_TICK_MS);
  // Headroom for a band that overruns: the next band's space, or the ceiling
  // for the last one. Borrowing at most one band keeps a single slow step
  // from eating the whole bar, and `advancePhase` never moves the bar
  // backwards, so the next step simply carries on from wherever the creep
  // reached. A band that reports a real percentage lends nothing: creeping
  // into it would leave the indicator sitting above the figure that step is
  // about to publish, which is how the logo came to look full at 58%.
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
  // band for whoever reads this table, the stage speaks to the user. Several
  // phases can share one stage, and re-entering a running stage is a no-op.
  void label;
  setLoadingStage(phases[index].stage);
}

/**
 * Pull the indicator to a real fraction of the current phase's band.
 *
 * The crawl paces the band on a guess at how long the step takes. A step that
 * reports true progress takes the indicator over for as long as it has
 * something to say, so the logo tracks the download rather than the clock.
 * Monotonic and clamped to the band, so a late or noisy signal can never
 * rewind the indicator.
 */
export function nudgePhaseProgress(fraction: number): void {
  if (!Number.isFinite(fraction) || currentPhase < 0) {
    return;
  }
  const { base, target } = phases[currentPhase];
  const clamped = Math.max(0, Math.min(1, fraction));
  clearProgressGrace();
  // Once the step's own work is finished there is no true number left to
  // respect, so the creep takes over again and carries the indicator through
  // the tail. That tail is the sandbox unpacking, which reports nothing.
  phaseReportsProgress = clamped < 1;
  const want = base + (target - base) * clamped;
  if (want > currentProgress) {
    setProgress(Math.min(want, target));
  }
}

export const GATEWAY_ESCAPE_DELAY_MS = 10_000;

/**
 * One-click "Use Trusted Provider" escape hatch on the loading screen.
 * Renders at most once per page lifetime after `delayMs` of slow loading.
 * Returns a cancel function that clears the pending timer.
 */
export function showGatewayEscape(
  onClick: () => void,
  delayMs: number = GATEWAY_ESCAPE_DELAY_MS,
): () => void {
  const timer = setTimeout(() => {
    const hint = document.getElementById("loading-hint");
    if (hint === null) {
      return;
    }
    if (hint.querySelector(".loading-gateway-btn") !== null) {
      return;
    }
    const btn = document.createElement("button");
    btn.className = "loading-gateway-btn";
    btn.type = "button";
    const icon = document.createElement("span");
    icon.className = "loading-gateway-btn-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
    const text = document.createElement("span");
    text.className = "loading-gateway-btn-text";
    const label = document.createElement("span");
    label.className = "loading-gateway-btn-label";
    label.textContent = "Use Trusted Provider";
    const sub = document.createElement("span");
    sub.className = "loading-gateway-btn-sub";
    sub.textContent = "Faster but no verification";
    text.append(label, sub);
    btn.append(icon, text);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    hint.appendChild(btn);
    hint.classList.add("visible");
  }, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

// Single-line status. Updates #status in place.

function clearSlowWarning(): void {
  const hint = document.getElementById("loading-hint");
  if (hint !== null) {
    // Remove only the text span, preserve any gateway button
    const textSpan = hint.querySelector(".loading-hint-text");
    if (textSpan !== null) {
      textSpan.remove();
    }
    // Only hide if no gateway button is present
    if (hint.querySelector(".loading-gateway-btn") === null) {
      hint.classList.remove("visible");
    }
  }
}

/**
 * Stop the progress crawl and clear any slow warning (call when loading is done).
 */
export function stopStatusTick(): void {
  stopProgressCrawl();
  clearSlowWarning();
}

/** Cancel the pending status reveal, for a load that finished in time. */
function cancelStatusReveal(): void {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
}

/**
 * Remove the loading overlay (logo, progress bar, log).
 * Called when the app is fully loaded and the iframe is ready.
 */
export function dismissLoading(): void {
  completeProgress();
  clearSlowWarning();
  cancelStatusReveal();
  stopStageMessages();
  const loading = document.querySelector<HTMLElement>("#app > .loading");
  if (loading !== null) {
    loading.style.transition = "opacity 0.3s ease";
    loading.style.opacity = "0";
    loading.style.pointerEvents = "none";
    setTimeout(() => {
      loading.remove();
    }, 300);
  }
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
      data.type !== "dotli:loading-status"
    ) {
      return;
    }
    if (!isSandboxOrigin(event.origin)) {
      return;
    }
    // The sandbox's own progress prose is written for a developer reading
    // the console, so it is left there. The stage messages narrate this step
    // to the user, and `done` is the part the loading screen acts on.
    if (data.done === true) {
      dismissLoading();
    }
  });
}

export interface ErrorAction {
  label: string;
  onClick: () => void;
  // Inline SVG markup for a leading icon. Constant only, never user input.
  icon?: string;
}

/**
 * Show an error state with optional action buttons.
 *
 * `detail` is an optional paragraph below the title. Omit it for a
 * title-only screen (e.g. the generic "Domain can't be reached" with a
 * backend switch). `action` renders one button per entry; pass an `icon` for a
 * leading glyph, otherwise the label gets a trailing arrow. Pass an array to
 * offer several choices; the first keeps `#error-retry-btn`.
 */
export function showError(
  title: string,
  detail?: string,
  action?: ErrorAction | ErrorAction[] | (() => void),
): void {
  if (typeof action === "function") {
    action = { label: "Retry", onClick: action };
  }
  const actions =
    action === undefined ? [] : Array.isArray(action) ? action : [action];
  const idFor = (i: number): string =>
    i === 0 ? "error-retry-btn" : `error-retry-btn-${String(i)}`;
  const renderAction = (a: ErrorAction, i: number): string => {
    const leading =
      a.icon !== undefined
        ? `<span class="error-page-retry-icon" aria-hidden="true">${a.icon}</span>`
        : "";
    const trailing =
      a.icon === undefined ? ` <span aria-hidden="true">→</span>` : "";
    return `<button class="error-page-retry" id="${idFor(i)}">${leading}<span class="error-page-retry-label">${escapeHtml(a.label)}</span>${trailing}</button>`;
  };
  app.innerHTML = `
    <div class="error-page">
      <div class="error-page-inner">
        <h1 class="error-page-title">${escapeHtml(title)}</h1>
        ${detail !== undefined ? `<p class="error-page-detail">${escapeHtml(detail)}</p>` : ""}
        ${actions.map((a, i) => renderAction(a, i)).join("")}
      </div>
    </div>
  `;

  actions.forEach((a, i) => {
    document.getElementById(idFor(i))?.addEventListener("click", a.onClick);
  });

  window.dispatchEvent(new CustomEvent("dotli:product-error"));
}

/**
 * Show the "no content set" error in a Chrome-style "site can't be reached"
 * layout. The domain is highlighted so the user can immediately scan for a
 * typo, and a secondary hint explains the network reason without burying it.
 */
export function showNoContentError(label: string): void {
  const safeLabel = escapeHtml(label);
  app.innerHTML = `
    <div class="error-page">
      <div class="error-page-inner error-page-inner--unreached">
        <div class="error-page-glyph" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9.5"></circle>
            <path d="M3.5 12h17"></path>
            <path d="M12 2.5c2.5 3 3.75 6.2 3.75 9.5s-1.25 6.5-3.75 9.5"></path>
            <path d="M12 2.5c-2.5 3-3.75 6.2-3.75 9.5s1.25 6.5 3.75 9.5"></path>
          </svg>
        </div>
        <h1 class="error-page-title">This app can't be reached</h1>
        <p class="error-page-detail">
          Check if there is a typo in <span class="error-page-domain">${safeLabel}<span class="error-page-domain-tld">.dot</span></span>.
        </p>
      </div>
    </div>
  `;

  window.dispatchEvent(new CustomEvent("dotli:product-error"));
}

const LANDING_PLACEHOLDER_NAMES = ["browse", "mark3t", "playground"] as const;

const LANDING_PLACEHOLDER_TYPE_MS = 95;
const LANDING_PLACEHOLDER_ERASE_MS = 45;
const LANDING_PLACEHOLDER_HOLD_MS = 1400;

function animateLandingPlaceholder(input: HTMLInputElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    input.placeholder = LANDING_PLACEHOLDER_NAMES[0];
    return;
  }
  let wordIdx = 0;
  let charIdx = 0;
  let mode: "typing" | "holding" | "erasing" = "typing";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    timer = setTimeout(tick, delayMs);
  };
  const tick = (): void => {
    timer = null;
    if (!input.isConnected || input.value !== "") {
      return;
    }
    const word = LANDING_PLACEHOLDER_NAMES[wordIdx];
    if (mode === "typing") {
      charIdx++;
      input.placeholder = word.slice(0, charIdx);
      if (charIdx >= word.length) {
        mode = "holding";
        schedule(LANDING_PLACEHOLDER_HOLD_MS);
      } else {
        schedule(LANDING_PLACEHOLDER_TYPE_MS);
      }
    } else if (mode === "holding") {
      mode = "erasing";
      schedule(LANDING_PLACEHOLDER_ERASE_MS);
    } else {
      charIdx--;
      input.placeholder = word.slice(0, Math.max(0, charIdx));
      if (charIdx <= 0) {
        wordIdx = (wordIdx + 1) % LANDING_PLACEHOLDER_NAMES.length;
        charIdx = 0;
        mode = "typing";
        schedule(LANDING_PLACEHOLDER_TYPE_MS);
      } else {
        schedule(LANDING_PLACEHOLDER_ERASE_MS);
      }
    }
  };
  // Resume the cycle when the user clears the input. Pause is implicit
  // because tick early-returns and never reschedules while value is set.
  input.addEventListener("input", () => {
    if (input.value === "" && timer === null && input.isConnected) {
      schedule(LANDING_PLACEHOLDER_TYPE_MS);
    }
  });
  input.placeholder = LANDING_PLACEHOLDER_NAMES[0];
  charIdx = LANDING_PLACEHOLDER_NAMES[0].length;
  mode = "holding";
  schedule(LANDING_PLACEHOLDER_HOLD_MS);
}

const LANDING_NAME_ERROR_COPY: Record<
  Exclude<DotLabelResult, { ok: true }>["reason"],
  string
> = {
  empty: "Enter a name to browse",
  "too-long": "Names can be at most 63 characters",
  uppercase: "Names can only contain a-z, 0-9 and hyphens",
  "leading-hyphen": "Names can't start or end with a hyphen",
  "trailing-hyphen": "Names can't start or end with a hyphen",
  "invalid-char": "Names can only contain a-z, 0-9 and hyphens",
  "non-ascii": "Names can only contain a-z, 0-9 and hyphens",
};

/**
 * Show the landing page (no subdomain detected).
 */
export function showLanding(): void {
  // Hide the topbar on the landing page
  const topbar = document.getElementById("topbar");
  if (topbar) {
    topbar.style.display = "none";
  }

  app.style.marginTop = "0";
  app.style.minHeight = "100dvh";
  app.innerHTML = `
    <div class="landing">
      <div class="landing-auth" id="landing-auth"></div>
      <div class="landing-center">
      <div class="landing-content">
        <div class="landing-logo">
          <svg width="48" height="54" viewBox="0 0 16 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.9873 14.1348C10.8273 14.1348 11.462 14.3911 11.6113 14.8604C11.8447 15.6051 10.7691 16.609 9.20801 17.1016C7.64706 17.5964 6.1908 17.3912 5.95508 16.6465C5.7363 15.9482 6.6685 15.0218 8.07227 14.5029L8.3584 14.4023C8.93466 14.2203 9.49501 14.1348 9.9873 14.1348ZM2.23828 9.9248C2.99193 9.9248 3.82268 10.226 4.52734 10.8213C5.85738 11.9442 6.23288 13.6886 5.36719 14.7158C4.50142 15.7428 2.71861 15.6629 1.38867 14.54C0.100568 13.4522 -0.291878 11.7823 0.47168 10.7451L0.551758 10.6465C0.957761 10.1634 1.5687 9.92482 2.23828 9.9248ZM15.1748 9.47949C15.2096 9.4795 15.2397 9.48415 15.2676 9.49805C15.6409 9.67081 15.4174 10.9618 14.7617 12.3789C14.1085 13.7956 13.2732 14.8041 12.8975 14.6318C12.5218 14.4591 12.7481 13.168 13.4014 11.751C14.0057 10.4413 14.7665 9.47949 15.1748 9.47949ZM3.42578 2.46387C3.9998 2.46387 4.55096 2.64366 4.9873 3.01953C6.10236 3.97675 6.07202 5.84169 4.92188 7.18164C3.76917 8.52404 1.93275 8.83452 0.817383 7.875C-0.297896 6.91782 -0.267461 5.05292 0.882812 3.71289C1.58276 2.8982 2.5345 2.46396 3.42578 2.46387ZM13.1631 2.80957C13.6391 2.80957 14.4071 3.79925 14.9531 5.15332C15.5458 6.62173 15.6526 7.96206 15.1953 8.14648C14.7355 8.33003 13.8845 7.29114 13.292 5.82324C12.6993 4.35719 12.5892 3.01463 13.0488 2.83008C13.0861 2.8161 13.1235 2.8096 13.1631 2.80957ZM7.82422 0C8.30483 0 8.83683 0.0896562 9.37109 0.276367C10.9576 0.829603 11.9799 2.02888 11.6582 2.95801C11.3362 3.88718 9.78886 4.19295 8.20215 3.63965C6.61582 3.08633 5.5943 1.88706 5.91602 0.958008C6.12834 0.341726 6.87931 6.04412e-05 7.82422 0Z" fill="currentColor"/>
          </svg>
        </div>
        <h1 class="landing-title">Polkadot Web</h1>
        <p class="landing-subtitle">The decentralized web, in your browser.</p>
        <form id="dotli-nav-form" class="landing-nav-form" autocomplete="off">
          <div class="landing-search-bar" id="dotli-nav-bar">
            <input id="dotli-nav-input" class="landing-search-input" type="text" placeholder="browse.dot" spellcheck="false" autocomplete="off" aria-label="Search a .dot name" aria-describedby="dotli-nav-error" />
            <span class="landing-dot-label">.dot</span>
            <button type="submit" class="landing-go-btn" aria-label="Go">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
          <p id="dotli-nav-error" class="landing-nav-error" role="alert" hidden></p>
        </form>
        <div id="dotli-recent" class="landing-recent" hidden></div>
      </div>
      </div>
    </div>
  `;

  const form = document.getElementById(
    "dotli-nav-form",
  ) as HTMLFormElement | null;
  const input = document.getElementById(
    "dotli-nav-input",
  ) as HTMLInputElement | null;
  if (!form || !input) {
    return;
  }

  animateLandingPlaceholder(input);

  const bar = document.getElementById("dotli-nav-bar");
  const errorEl = document.getElementById("dotli-nav-error");
  const clearNavError = (): void => {
    bar?.classList.remove("landing-search-bar--error");
    input.removeAttribute("aria-invalid");
    if (errorEl) {
      errorEl.hidden = true;
    }
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value
      .trim()
      .toLowerCase()
      .replace(/\.dot$/, "");
    const result = validateDotLabel(name);
    if (!result.ok) {
      bar?.classList.add("landing-search-bar--error");
      input.setAttribute("aria-invalid", "true");
      if (errorEl) {
        errorEl.textContent = LANDING_NAME_ERROR_COPY[result.reason];
        errorEl.hidden = false;
      }
      input.focus();
      return;
    }
    // Recents are written after the name resolves, not here: a typo used to be
    // persisted as a pill that reproduced the failure on every future click.
    window.location.href = dotUrl(name);
  });

  input.addEventListener("input", clearNavError);

  input.focus();

  // Move auth + theme toggle buttons to the landing page top-right
  const landingAuth = document.getElementById("landing-auth");
  const authButton = document.getElementById("auth-button");
  const themeToggle = document.getElementById("theme-toggle");
  if (landingAuth && authButton) {
    landingAuth.appendChild(authButton);
    if (themeToggle) {
      landingAuth.appendChild(themeToggle);
    }
  }

  // Show recently visited .dot sites. The list is written on the subdomain
  // that resolved, so it comes from the cross-subdomain store, not this
  // origin's localStorage.
  void loadRecentLabels().then((labels) => {
    renderRecentPills(labels);
  });
}

function renderRecentPills(labels: string[]): void {
  const container = document.getElementById("dotli-recent");
  if (container === null || labels.length === 0) {
    return;
  }
  const items = labels
    .map((label) => {
      const safe = escapeHtml(label);
      return `<span class="landing-recent-item" data-label="${safe}">
        <a href="${escapeHtml(dotUrl(label))}" class="landing-recent-pill">
          <span class="landing-recent-label">${safe}<span class="landing-tld">.dot</span></span>
        </a>
        <button type="button" class="landing-recent-remove" aria-label="Remove ${safe}.dot from recently visited" title="Remove">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
        </button>
      </span>`;
    })
    .join("");
  container.innerHTML = `<div class="landing-recent-list">${items}</div>`;
  container.removeAttribute("hidden");
  bindRecentRemoval(container);
}

// Touch has no hover, so a long press on a pill reveals its remove button
// instead of navigating.
const RECENT_LONG_PRESS_MS = 450;

function bindRecentRemoval(container: HTMLElement): void {
  const items = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".landing-recent-item"));
  const clearRevealed = (except?: HTMLElement): void => {
    for (const item of items()) {
      if (item !== except) {
        item.classList.remove("is-removable");
      }
    }
  };

  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>(".landing-recent-item");
    if (!item) {
      return;
    }
    const label = item.dataset.label;
    if (target.closest(".landing-recent-remove") !== null) {
      e.preventDefault();
      if (label !== undefined) {
        void forgetRecentLabel(label);
      }
      item.remove();
      if (items().length === 0) {
        container.hidden = true;
        container.innerHTML = "";
      }
      return;
    }
    // A long press revealed the remove button, so swallow the tap that ends it
    // rather than navigating to the site the user was about to forget.
    if (item.classList.contains("is-removable")) {
      e.preventDefault();
    }
  });

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  container.addEventListener(
    "touchstart",
    (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(
        ".landing-recent-item",
      );
      if (!item || item.classList.contains("is-removable")) {
        return;
      }
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        item.classList.add("is-removable");
        clearRevealed(item);
      }, RECENT_LONG_PRESS_MS);
    },
    { passive: true },
  );
  container.addEventListener("touchmove", cancelPress, { passive: true });
  container.addEventListener("touchend", cancelPress, { passive: true });
  container.addEventListener("touchcancel", cancelPress, { passive: true });

  // Tapping anywhere else puts the revealed pills back.
  document.addEventListener("pointerdown", (e) => {
    if (!container.contains(e.target as Node)) {
      clearRevealed();
    }
  });
}

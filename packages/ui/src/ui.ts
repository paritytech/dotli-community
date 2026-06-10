// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Pure DOM UI helpers
//
// Status messages, error states, and landing page.
// No heavy dependencies, kept in the eager bundle.

import { getRecentLabels, addRecentLabel } from "@dotli/storage/cid-cache";
import { BASE_DOMAIN, isSandboxOrigin } from "@dotli/config/config";
import { getBackend } from "@dotli/config/mode";
import { escapeHtml, isValidDotLabel } from "@dotli/shared/html";

const app = document.getElementById("app") ?? document.body;

function dotUrl(label: string): string {
  const host = window.location.hostname;
  if (host.endsWith(".localhost") || host === "localhost") {
    return `${window.location.protocol}//${label}.localhost:${window.location.port}`;
  }
  return `https://${label}.${BASE_DOMAIN}`;
}

// Phase-based loading indicator.
let phaseLabels: string[] = [];
let currentPhase = -1;

// Progress bar state
let progressFillEl: HTMLElement | null = null;
let progressPctEl: HTMLElement | null = null;
let currentProgress = 0;
let targetProgress = 0;
let progressInterval: ReturnType<typeof setInterval> | null = null;

// Simulated percentage ranges per phase: [base, target].
// The bar jumps to `base` on phase entry, then crawls toward `target`.
const PHASE_PROGRESS: [number, number][] = [
  [2, 15], // Starting
  [18, 35], // Connecting
  [38, 68], // Syncing
  [72, 92], // Resolving
];

function setProgress(pct: number): void {
  currentProgress = pct;
  if (progressFillEl !== null) {
    progressFillEl.style.width = `${String(pct)}%`;
  }
  if (progressPctEl !== null) {
    progressPctEl.textContent = `${String(Math.round(pct))}%`;
  }
}

function startProgressCrawl(): void {
  stopProgressCrawl();
  progressInterval = setInterval(() => {
    if (currentProgress < targetProgress) {
      const remaining = targetProgress - currentProgress;
      const increment = Math.max(0.1, remaining * 0.04);
      setProgress(Math.min(currentProgress + increment, targetProgress));
    }
  }, 200);
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
 * Initialize the loading progress bar.
 * Call once before resolution/fetching begins.
 */
export function initPhases(labels: string[]): void {
  phaseLabels = labels;
  currentPhase = -1;

  progressFillEl = document.getElementById("loading-progress-fill");
  progressPctEl = document.getElementById("loading-progress-pct");
}

/**
 * Advance to a specific phase (0-indexed).
 * Jumps the progress bar to the phase's base percentage and begins
 * crawling toward its target. Updates the headline text.
 * No-ops if the phase is already active or past.
 */
export function advancePhase(index: number): void {
  if (
    index <= currentPhase ||
    index >= phaseLabels.length ||
    index >= PHASE_PROGRESS.length
  ) {
    return;
  }
  currentPhase = index;

  // Update progress bar
  const range = PHASE_PROGRESS[index];
  const [base, target] = range;
  if (base > currentProgress) {
    setProgress(base);
  }
  targetProgress = target;
  startProgressCrawl();

  // Update headline
  const status = document.getElementById("status");
  if (status !== null) {
    status.textContent = phaseLabels[index] ?? "Loading...";
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

// Single-line status. Updates #status in place. Shows a slow-step
// hint when a step exceeds its time threshold.

// Per-step timeout thresholds (seconds). If a step exceeds its
// limit, a contextual hint fades in below the status line.
type SlowHint = string | { smoldot: string; rpc: string };
const SLOW_THRESHOLDS: Record<string, { secs: number; hint: SlowHint }> = {
  "Starting light client": {
    secs: 8,
    hint: "The smoldot light client is slow to initialize — could be a network issue",
  },
  "Adding Paseo relay chain": {
    secs: 10,
    hint: "Paseo relay chain bootstrap is stalled — smoldot may be having trouble reaching bootnodes",
  },
  "Connecting to Asset Hub": {
    secs: 12,
    hint: "Asset Hub parachain connection is taking long — the chain may be congested or peers unavailable",
  },
  Syncing: {
    secs: 15,
    hint: "Asset Hub sync is slow — smoldot is still catching up to the latest finalized block on the Paseo relay chain",
  },
  Resolving: {
    secs: 10,
    hint: {
      smoldot: "Smoldot is still catching up on the Paseo relay chain",
      rpc: "The RPC endpoint is slow to answer the resolver query",
    },
  },
  "Connecting to peers": {
    secs: 10,
    hint: "Helia P2P peer discovery is slow — WebRTC relay nodes may be unreachable",
  },
  "Fetching content via P2P": {
    secs: 15,
    hint: "P2P content transfer is slow — the content may have few seeders on the Bulletin network",
  },
  "Fetching directory via P2P": {
    secs: 15,
    hint: "Directory fetch is slow — multi-file archives take longer over P2P",
  },
  "Initializing P2P client": {
    secs: 8,
    hint: "Helia startup is stalled — WASM or WebRTC initialization may be blocked",
  },
};

function resolveHint(hint: SlowHint): string {
  if (typeof hint === "string") {
    return hint;
  }
  return getBackend() === "rpc-gateway" ? hint.rpc : hint.smoldot;
}

function getSlowThreshold(
  message: string,
): { secs: number; hint: string } | null {
  for (const [key, value] of Object.entries(SLOW_THRESHOLDS)) {
    if (message.startsWith(key) || message.includes(key.toLowerCase())) {
      return { secs: value.secs, hint: resolveHint(value.hint) };
    }
  }
  return { secs: 20, hint: "This is taking longer than expected" };
}

let slowTimer: ReturnType<typeof setTimeout> | null = null;

function clearSlowWarning(): void {
  if (slowTimer !== null) {
    clearTimeout(slowTimer);
    slowTimer = null;
  }
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
 * Update the single status line below the progress bar.
 * Replaces the previous message in place. No new DOM elements are created.
 * Schedules a slow-step hint if the step exceeds its time threshold.
 */
export function showStatus(message: string): void {
  const status = document.getElementById("status");
  if (status !== null) {
    status.textContent = message;
  }

  clearSlowWarning();

  const threshold = getSlowThreshold(message);
  if (threshold !== null) {
    slowTimer = setTimeout(() => {
      const hint = document.getElementById("loading-hint");
      if (hint !== null) {
        // Remove previous text span if any
        const existing = hint.querySelector(".loading-hint-text");
        if (existing !== null) {
          existing.remove();
        }
        // Insert text as a span so it doesn't wipe the gateway button
        const span = document.createElement("span");
        span.className = "loading-hint-text";
        span.textContent = threshold.hint;
        hint.insertBefore(span, hint.firstChild);
        hint.classList.add("visible");
      }
    }, threshold.secs * 1000);
  }
}

/**
 * Stop the progress crawl and clear any slow warning (call when loading is done).
 */
export function stopStatusTick(): void {
  stopProgressCrawl();
  clearSlowWarning();
}

/**
 * Remove the loading overlay (logo, progress bar, log).
 * Called when the app is fully loaded and the iframe is ready.
 */
export function dismissLoading(): void {
  completeProgress();
  clearSlowWarning();
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
    if (typeof data.message === "string") {
      showStatus(data.message);
    }
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
            <input id="dotli-nav-input" class="landing-search-input" type="text" placeholder="browse.dot" spellcheck="false" autocomplete="off" aria-label="Search a .dot name" />
            <span class="landing-dot-label">.dot</span>
            <button type="submit" class="landing-go-btn" aria-label="Go">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
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

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value
      .trim()
      .toLowerCase()
      .replace(/\.dot$/, "");
    if (!name || !isValidDotLabel(name)) {
      return;
    }
    const url = dotUrl(name);
    void addRecentLabel(name).finally(() => {
      window.location.href = url;
    });
  });

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

  // Show recently visited .dot sites
  const labels = getRecentLabels();
  if (labels.length > 0) {
    const container = document.getElementById("dotli-recent");
    if (container) {
      container.removeAttribute("hidden");
      const items = labels
        .map((label) => {
          return `<a href="${escapeHtml(dotUrl(label))}" class="landing-recent-pill">
            <span class="landing-recent-label">${escapeHtml(label)}<span class="landing-tld">.dot</span></span>
          </a>`;
        })
        .join("");
      container.innerHTML = `<div class="landing-recent-list">${items}</div>`;
    }
  }
}

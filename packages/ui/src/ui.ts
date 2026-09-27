// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Pure DOM UI helpers
//
// Error states and the landing page. The loading screen lives in
// loading-controller.ts. No heavy dependencies, kept in the eager bundle.

import { loadRecentLabels, forgetRecentLabel } from "./recent-labels";
import { BASE_DOMAIN } from "@dotli/config/config";
import { escapeHtml, validateDotLabel } from "@dotli/shared/html";
import { getActiveTldSuffix, withActiveTld } from "@dotli/config/network";
import type { DotLabelResult } from "@dotli/shared/html";
import { setProductError } from "./state/product";
import { disposeAppRoots } from "./mount/app-roots";

const app = document.getElementById("app") ?? document.body;

function dotUrl(label: string): string {
  const host = window.location.hostname;
  if (host.endsWith(".localhost") || host === "localhost") {
    return `${window.location.protocol}//${label}.localhost:${window.location.port}`;
  }
  return `https://${label}.${BASE_DOMAIN}`;
}

export interface ErrorAction {
  label: string;
  /**
   * Receives the click so a handler that opens one of the topbar popovers can
   * stop it reaching the document-level close-outside listener, which would
   * otherwise read the button as "outside" and shut the popover immediately.
   */
  onClick: (event: MouseEvent) => void;
  /**
   * The recommended way out. Rendered filled and pushed to the right of the
   * row, whatever its position in the array. Defaults to the first action, so
   * a lone button is always the primary one.
   */
  primary?: boolean;
  /** Inline SVG markup for a leading icon. Constant only, never user input. */
  icon?: string;
}

/**
 * The topbar's own Settings gear, so a button that opens that panel carries the
 * same mark the visitor is being sent to look for. The path data matches the
 * `#mode-button` icon in the host's index.html. Only the 12px box is widened to
 * 15px, so it sits with the button text.
 */
export const SETTINGS_GLYPH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const WARNING_GLYPH = `<div class="error-page-glyph error-page-glyph--warning" aria-hidden="true">
  <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10.3 3.2 1.8 17.5A2 2 0 0 0 3.5 20.5h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z"></path>
    <path fill="#fff" d="M11 8.5h2v5h-2zM11 15.5h2v2h-2z"></path>
  </svg>
</div>`;

/**
 * A sentence, optionally with parts picked out in bold. Spelled as segments
 * rather than markup so every piece still goes through `escapeHtml`.
 */
export type ErrorText = string | readonly (string | { strong: string })[];

function renderErrorText(text: ErrorText): string {
  if (typeof text === "string") {
    return escapeHtml(text);
  }
  return text
    .map((part) =>
      typeof part === "string"
        ? escapeHtml(part)
        : `<strong>${escapeHtml(part.strong)}</strong>`,
    )
    .join("");
}

export interface ErrorPage {
  title: string;
  /** Paragraph below the title. Omit for a title-only screen. */
  detail?: ErrorText;
  /** Things worth checking before retrying, listed under a "Try:" heading. */
  tips?: readonly string[];
  /**
   * One button per entry. The first keeps `#error-retry-btn` regardless of
   * which one is `primary`.
   */
  actions?: readonly ErrorAction[];
  /** Leading glyph. Only the warning interstitial carries one today. */
  glyph?: "warning";
}

/** Render a full-page error state, replacing whatever `#app` holds. */
export function showErrorPage(page: ErrorPage): void {
  // The markup below replaces the loading screen and any page, so they are
  // disposed first and their timers stop with them.
  disposeAppRoots();
  const { title, detail, glyph } = page;
  const tips = page.tips ?? [];
  const actions = page.actions ?? [];
  const idFor = (i: number): string =>
    i === 0 ? "error-retry-btn" : `error-retry-btn-${String(i)}`;
  const declaredPrimary = actions.findIndex((a) => a.primary === true);
  const primaryIndex = declaredPrimary === -1 ? 0 : declaredPrimary;
  // Rendered with the primary last so reading order, DOM order and tab order
  // all agree. The id still comes from the array position, so `#error-retry-btn`
  // is the first action whichever one is recommended.
  const rendered = actions
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) => Number(x.i === primaryIndex) - Number(y.i === primaryIndex),
    );
  const renderAction = (a: ErrorAction, i: number): string => {
    const cls =
      i === primaryIndex
        ? "error-page-retry error-page-retry--primary"
        : "error-page-retry";
    const leading =
      a.icon === undefined
        ? ""
        : `<span class="error-page-retry-icon" aria-hidden="true">${a.icon}</span>`;
    return `<button class="${cls}" id="${idFor(i)}">${leading}<span class="error-page-retry-label">${escapeHtml(a.label)}</span></button>`;
  };
  app.innerHTML = `
    <div class="error-page">
      <div class="error-page-inner">
        ${glyph === "warning" ? WARNING_GLYPH : ""}
        <h1 class="error-page-title" tabindex="-1">${escapeHtml(title)}</h1>
        ${detail !== undefined ? `<p class="error-page-detail">${renderErrorText(detail)}</p>` : ""}
        ${
          tips.length === 0
            ? ""
            : `<div class="error-page-tips">
          <p class="error-page-tips-label">Try:</p>
          <ul class="error-page-tips-list">${tips.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
        </div>`
        }
        ${actions.length === 0 ? "" : `<div class="error-page-actions">${rendered.map(({ a, i }) => renderAction(a, i)).join("")}</div>`}
      </div>
    </div>
  `;

  actions.forEach((a, i) => {
    document.getElementById(idFor(i))?.addEventListener("click", a.onClick);
  });

  // The button that triggered this render is gone, so focus would otherwise
  // fall to `body` and a screen reader would announce nothing. Moving it to the
  // title both names the new screen and puts the actions next in tab order.
  // Matters most on the failover interstitial, which replaces one error screen
  // with another in place.
  app.querySelector<HTMLElement>(".error-page-title")?.focus();

  setProductError();
}

/**
 * Positional shorthand for {@link showErrorPage}, kept because most callers
 * only ever need a title, a line of detail and a retry.
 */
export function showError(
  title: string,
  detail?: string,
  action?: ErrorAction | ErrorAction[] | (() => void),
  tips: readonly string[] = [],
): void {
  if (typeof action === "function") {
    action = { label: "Retry", onClick: action };
  }
  showErrorPage({
    title,
    detail,
    tips,
    actions:
      action === undefined ? [] : Array.isArray(action) ? action : [action],
  });
}

/**
 * Show the "no content set" error in a Chrome-style "site can't be reached"
 * layout. The domain is highlighted so the user can immediately scan for a
 * typo, and a secondary hint explains the network reason without burying it.
 */
export function showNoContentError(label: string): void {
  // Replaces the loading screen mid-load, so its timers are stopped here too.
  disposeAppRoots();
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
          Check if there is a typo in <span class="error-page-domain">${safeLabel}<span class="error-page-domain-tld">${escapeHtml(getActiveTldSuffix())}</span></span>.
        </p>
      </div>
    </div>
  `;

  setProductError();
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
            <input id="dotli-nav-input" class="landing-search-input" type="text" placeholder="${escapeHtml(withActiveTld("browse"))}" spellcheck="false" autocomplete="off" aria-label="Search a ${escapeHtml(getActiveTldSuffix())} name" aria-describedby="dotli-nav-error" />
            <span class="landing-dot-label">${escapeHtml(getActiveTldSuffix())}</span>
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
    // The placeholder shows the active TLD, and `validateDotLabel` rejects any
    // dot, so a name typed with the suffix has to lose it here.
    const typed = input.value.trim().toLowerCase();
    const suffix = getActiveTldSuffix();
    const name = typed.endsWith(suffix)
      ? typed.slice(0, -suffix.length)
      : typed;
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
    // Recents are written after the name resolves, not here, so a typo is not
    // persisted as a pill that reproduces the failure on every future click.
    window.location.href = dotUrl(name);
  });

  input.addEventListener("input", clearNavError);

  // Not focused on load: that hijacks screen reader order and pops the mobile
  // keyboard over the recents before anything has been read.

  // Move the auth and theme buttons to the landing page top-right.
  const landingAuth = document.getElementById("landing-auth");
  const authButton = document.getElementById("auth-button");
  const themeToggle = document.getElementById("theme-toggle");
  const themePopover = document.getElementById("theme-popover");
  if (landingAuth && authButton) {
    landingAuth.appendChild(authButton);
    if (themeToggle) {
      landingAuth.appendChild(themeToggle);
      if (themePopover) {
        landingAuth.appendChild(themePopover);
      }
    }
  }

  // Show recently visited dotNS sites. The list is written on the subdomain
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
          <span class="landing-recent-label">${safe}<span class="landing-tld">${escapeHtml(getActiveTldSuffix())}</span></span>
        </a>
        <button type="button" class="landing-recent-remove" aria-label="Remove ${safe}${escapeHtml(getActiveTldSuffix())} from recently visited" title="Remove">
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

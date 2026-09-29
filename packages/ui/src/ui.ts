// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Pure DOM UI helpers
//
// Error states. The loading screen lives in loading-controller.ts and the
// landing page in components/landing/ (loaded by landing/load.ts). No heavy
// dependencies and no Solid (the sandbox imports this), kept in the eager
// bundle.

import { escapeHtml } from "@dotli/shared";
import { getActiveTldSuffix } from "@dotli/config";
import { setProductError } from "./state/product.js";
import { disposeAppRoots } from "./mount/app-roots.js";

const app = document.getElementById("app") ?? document.body;

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
  detail?: ErrorText | undefined;
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

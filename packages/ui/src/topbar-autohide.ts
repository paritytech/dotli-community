// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li top bar auto-hide
//
// The bar slides away a few seconds into a verified desktop session and
// returns on pointer hover, on keyboard focus, and on the reveal shortcut,
// so home, settings, permissions and login never become mouse-only.
//
import { isMobileDevice } from "@dotli/shared/device";

const TOPBAR_HEIGHT = "56px";
const HIDE_DELAY_MS = 5000;
const SLIDE_TRANSITION = "transform 0.3s ease";
const HOVER_STRIP_HEIGHT = "6px";
const FIRST_CONTROL_SELECTOR = "a[href], button:not([disabled])";

/** Keyboard reveal, advertised on the bar via aria-keyshortcuts. */
export const TOPBAR_REVEAL_SHORTCUT = "Alt+Shift+T";

/** The always-reachable reveal control, one Tab past the app frame. */
export const TOPBAR_REVEAL_BUTTON_ID = "topbar-reveal";

// Popovers and the pairing modal belong to the bar but render outside
// #topbar, so focus or an open state in one of them counts as "in the bar".
const TOPBAR_SURFACE_IDS = [
  "user-popover",
  "mode-popover",
  "permissions-popover",
  "auth-modal-backdrop",
];

// The mobile "more" flyout lives inside #topbar, so it only matters here.
const OPEN_SURFACE_IDS = [...TOPBAR_SURFACE_IDS, "more-popover"];

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: AbortController | null = null;
let hoverStrip: HTMLElement | null = null;
let revealButton: HTMLButtonElement | null = null;
let armed = false;
let visible = true;
let appFrameTracking = false;

function getTopbar(): HTMLElement | null {
  return document.getElementById("topbar");
}

/** The product frame. The 0x0 protocol iframe is aria-hidden, so skip it. */
function getAppFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(
    'iframe:not([aria-hidden="true"])',
  );
}

function isLoggedIn(): boolean {
  return document.querySelector(".user-badge") !== null;
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
}

function applySlideTransition(): void {
  const topbar = getTopbar();
  if (topbar === null) {
    return;
  }
  // The transform is an inline style, so the reduced-motion block in
  // topbar.css cannot gate it for us.
  topbar.style.transition =
    reducedMotionQuery()?.matches === true ? "none" : SLIDE_TRANSITION;
}

/**
 * While auto-hide is active the frame keeps a constant 100vh layout box and
 * a transform tracks the bar. Revealing shifts the frame down below the bar,
 * so the app's top is never covered and, because only the transform changes,
 * the product document never relayouts. Cost: the app's bottom strip sits
 * off-screen for the moment the bar is revealed.
 */
function applyAppFrameGeometry(): void {
  const frame = getAppFrame();
  if (frame === null) {
    return;
  }
  if (appFrameTracking) {
    frame.style.top = "0";
    frame.style.height = "100vh";
    frame.style.transition =
      reducedMotionQuery()?.matches === true ? "none" : SLIDE_TRANSITION;
    frame.style.transform = visible
      ? `translateY(${TOPBAR_HEIGHT})`
      : "translateY(0)";
  } else {
    frame.style.top = TOPBAR_HEIGHT;
    frame.style.height = `calc(100vh - ${TOPBAR_HEIGHT})`;
    frame.style.transition = "";
    frame.style.transform = "";
  }
}

function setVisible(next: boolean): void {
  const topbar = getTopbar();
  if (topbar === null) {
    return;
  }
  visible = next;
  applySlideTransition();
  topbar.style.transform = next ? "translateY(0)" : "translateY(-100%)";
  // The hidden bar keeps its tab stops on purpose: tabbing into it is what
  // reveals it again for keyboard users.
  if (!next) {
    appFrameTracking = true;
  }
  if (appFrameTracking) {
    applyAppFrameGeometry();
  }
  window.dispatchEvent(
    new CustomEvent<boolean>("topbar:visibility", { detail: next }),
  );
}

function cancelHide(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function topbarHoldsFocus(): boolean {
  const active = focusedElement();
  if (active === null) {
    return false;
  }
  if (getTopbar()?.contains(active) === true || active === revealButton) {
    return true;
  }
  return TOPBAR_SURFACE_IDS.some(
    (id) => document.getElementById(id)?.contains(active) === true,
  );
}

function hasOpenSurface(): boolean {
  return OPEN_SURFACE_IDS.some(
    (id) => document.getElementById(id)?.classList.contains("open") === true,
  );
}

/** True while the user is working in the bar, so it must stay on screen. */
function isBusy(): boolean {
  return topbarHoldsFocus() || hasOpenSurface();
}

function canAutoHide(): boolean {
  return armed && !isMobileDevice() && isLoggedIn();
}

function scheduleHide(): void {
  cancelHide();
  if (!canAutoHide()) {
    return;
  }
  hideTimer = setTimeout(() => {
    hideTimer = null;
    // Focus or an open popover during the delay defers the hide rather than
    // pulling the controls out from under the user.
    if (isBusy()) {
      scheduleHide();
      return;
    }
    setVisible(false);
  }, HIDE_DELAY_MS);
}

function reveal(): void {
  cancelHide();
  setVisible(true);
}

function focusFirstControl(): void {
  getTopbar()?.querySelector<HTMLElement>(FIRST_CONTROL_SELECTOR)?.focus();
}

/** Hand focus back to the app so it never parks on an offscreen control. */
function releaseFocusToApp(): void {
  const frame = getAppFrame();
  if (frame !== null) {
    frame.focus();
    return;
  }
  focusedElement()?.blur();
}

function isRevealShortcut(event: KeyboardEvent): boolean {
  // `code` carries the physical key, which matters because macOS turns
  // Option+Shift+T into a dead key. Fall back to `key` when it is missing.
  const isT = event.code === "KeyT" || event.key.toLowerCase() === "t";
  return (
    event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && isT
  );
}

function onKeyDown(event: KeyboardEvent): void {
  if (!isRevealShortcut(event)) {
    return;
  }
  event.preventDefault();
  if (!visible) {
    reveal();
    focusFirstControl();
    return;
  }
  // Nothing to toggle while the bar is pinned, and an open popover owns
  // Escape for its own dismissal, so leave both alone.
  if (!canAutoHide() || hasOpenSurface()) {
    return;
  }
  if (topbarHoldsFocus()) {
    releaseFocusToApp();
  }
  cancelHide();
  setVisible(false);
}

function syncFocus(): void {
  if (!armed) {
    return;
  }
  if (isBusy()) {
    reveal();
  } else {
    scheduleHide();
  }
}

/**
 * A skip-link style control appended after the app frame, so one forward Tab
 * out of the dApp reaches the bar. Keys pressed inside the cross-origin frame
 * never reach this document, which rules out a shortcut-only recovery.
 */
function createRevealButton(signal: AbortSignal): void {
  revealButton = document.createElement("button");
  revealButton.type = "button";
  revealButton.id = TOPBAR_REVEAL_BUTTON_ID;
  revealButton.className = "topbar-reveal";
  revealButton.textContent = "Show browser bar";
  revealButton.setAttribute("aria-keyshortcuts", TOPBAR_REVEAL_SHORTCUT);
  revealButton.setAttribute("aria-controls", "topbar");
  // Directly after the app container, so tabbing out of the dApp reaches it
  // before the toasts and debug chrome that also live at the end of body.
  const appContainer = document.getElementById("app");
  if (appContainer !== null) {
    appContainer.after(revealButton);
  } else {
    document.body.appendChild(revealButton);
  }

  // Focus alone reveals the bar, so a passing Tab already shows what the
  // control does. Activating it hands focus to the bar's first control.
  revealButton.addEventListener("focus", reveal, { signal });
  revealButton.addEventListener(
    "click",
    () => {
      reveal();
      focusFirstControl();
    },
    { signal },
  );
}

function bindListeners(): void {
  const topbar = getTopbar();
  if (listeners !== null || topbar === null) {
    return;
  }
  listeners = new AbortController();
  const { signal } = listeners;

  // Invisible strip at the very top, so hover reaches the host document even
  // when the pointer is over the product frame.
  hoverStrip = document.createElement("div");
  hoverStrip.setAttribute("aria-hidden", "true");
  hoverStrip.style.cssText = `position:fixed;top:0;left:0;right:0;height:${HOVER_STRIP_HEIGHT};z-index:999;`;
  document.body.appendChild(hoverStrip);
  hoverStrip.addEventListener("mouseenter", reveal, { signal });

  createRevealButton(signal);

  topbar.addEventListener("mouseenter", reveal, { signal });
  topbar.addEventListener(
    "mouseleave",
    () => {
      scheduleHide();
    },
    { signal },
  );

  // Tabbing into the offscreen bar reveals it, leaving it re-arms the timer.
  document.addEventListener("focusin", syncFocus, { signal });
  document.addEventListener(
    "focusout",
    () => {
      // activeElement only settles after focusout, so check on the next tick.
      setTimeout(syncFocus, 0);
    },
    { signal },
  );
  document.addEventListener("keydown", onKeyDown, { signal });

  // Rendering a product restyles the frame, so restate the geometry.
  window.addEventListener("dotli:product-loaded", applyAppFrameGeometry, {
    signal,
  });

  const reducedMotion = reducedMotionQuery();
  if (typeof reducedMotion?.addEventListener === "function") {
    reducedMotion.addEventListener(
      "change",
      () => {
        applySlideTransition();
        applyAppFrameGeometry();
      },
      { signal },
    );
  }
}

/**
 * Start auto-hiding the bar. Safe to call repeatedly: listeners bind once
 * and the hide timer restarts. No-op on touch devices, which have no hover
 * to bring the bar back.
 */
export function armTopbarAutoHide(): void {
  const topbar = getTopbar();
  if (isMobileDevice() || topbar === null) {
    return;
  }
  armed = true;
  topbar.setAttribute("aria-keyshortcuts", TOPBAR_REVEAL_SHORTCUT);
  applySlideTransition();
  bindListeners();
  if (revealButton !== null) {
    revealButton.hidden = false;
  }
  scheduleHide();
}

/** Pin the bar on screen and stop auto-hiding, e.g. after logout. */
export function pinTopbarVisible(): void {
  armed = false;
  cancelHide();
  getTopbar()?.removeAttribute("aria-keyshortcuts");
  // A pinned bar needs no reveal control, and a stray tab stop would just
  // sit in the way.
  if (revealButton !== null) {
    revealButton.hidden = true;
  }
  if (appFrameTracking) {
    appFrameTracking = false;
    applyAppFrameGeometry();
  }
  setVisible(true);
}

/**
 * Drop every listener and reset the state. The host arms once per session and
 * never needs this, tests do.
 */
export function disposeTopbarAutoHide(): void {
  pinTopbarVisible();
  listeners?.abort();
  listeners = null;
  hoverStrip?.remove();
  hoverStrip = null;
  revealButton?.remove();
  revealButton = null;
  visible = true;
}

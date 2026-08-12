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
let armed = false;
let visible = true;
let appFrameOverlaid = false;

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
 * Give the product frame the full viewport from the first hide onward.
 * Resizing it on every reveal relayouts the product document underneath and
 * jumps its content, while sliding the bar over it is compositor only.
 */
function applyAppFrameGeometry(): void {
  const frame = getAppFrame();
  if (frame === null) {
    return;
  }
  frame.style.top = appFrameOverlaid ? "0" : TOPBAR_HEIGHT;
  frame.style.height = appFrameOverlaid
    ? "100vh"
    : `calc(100vh - ${TOPBAR_HEIGHT})`;
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
  if (!next && !appFrameOverlaid) {
    appFrameOverlaid = true;
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
  if (getTopbar()?.contains(active) === true) {
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
    reducedMotion.addEventListener("change", applySlideTransition, { signal });
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
  scheduleHide();
}

/** Pin the bar on screen and stop auto-hiding, e.g. after logout. */
export function pinTopbarVisible(): void {
  armed = false;
  cancelHide();
  getTopbar()?.removeAttribute("aria-keyshortcuts");
  if (appFrameOverlaid) {
    appFrameOverlaid = false;
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
  visible = true;
}

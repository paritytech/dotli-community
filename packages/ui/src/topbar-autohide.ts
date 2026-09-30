// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li top bar auto-hide
//
// The bar slides away a few seconds into a verified desktop session and
// returns on pointer hover, on keyboard focus, and on the reveal shortcut,
// so home, settings, permissions and login never become mouse-only.
//
// The timing and the input handling live here, framework-free; what shows
// is the topbar store's: the bar's script (apps/host/src/components/
// Topbar.astro) sets its slide and shortcut from `visible` and `autoHide`,
// and the TopbarReveal island renders the reveal control and the hover
// strip. The bar registers its element (registerTopbarElement) and the
// popovers theirs (state/topbar-surfaces.ts), for the focus and open checks.
//
import { isMobileDevice } from '@dotli/shared';
import { focusables } from './components/focus.js';
import { currentProductFrame, setTopbarLayout } from './product-frame-layout.js';
import { getLoggedIn } from './state/auth.js';
import { getTopbarState, setTopbarAutoHide, setTopbarVisible } from './state/topbar.js';
import { anyTopbarSurfaceOpen, topbarSurfaceContains } from './state/topbar-surfaces.js';

const HIDE_DELAY_MS = 5000;

/** The bar's slide, unless the user asks for reduced motion. */
export const SLIDE_TRANSITION = 'transform 0.3s ease';

/** Keyboard reveal, advertised on the bar via aria-keyshortcuts. */
export const TOPBAR_REVEAL_SHORTCUT = 'Alt+Shift+T';

/** The always-reachable reveal control, one Tab past the app frame. */
export const TOPBAR_REVEAL_BUTTON_ID = 'topbar-reveal';

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let focusoutTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: AbortController | null = null;
let appFrameTracking = false;
/** The bar (the host page's `#topbar`), while bound. */
let bar: HTMLElement | undefined;
/** The reveal control (the TopbarReveal island's), while mounted. */
let revealButton: HTMLElement | undefined;

/** Register the bar's element; returns the unregister. */
export function registerTopbarElement(el: HTMLElement): () => void {
  bar = el;
  return () => {
    if (bar === el) {
      bar = undefined;
    }
  };
}

/** Register the reveal control; returns the unregister. */
export function registerTopbarRevealButton(el: HTMLElement): () => void {
  revealButton = el;
  return () => {
    if (revealButton === el) {
      revealButton = undefined;
    }
  };
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
}

/** The bar's transition now: none under reduced motion. */
export function topbarTransition(): string {
  return reducedMotionQuery()?.matches === true ? 'none' : SLIDE_TRANSITION;
}

/**
 * While auto-hide is active the frame keeps a constant hidden-bar layout box
 * and a transform tracks the bar. Revealing shifts the frame down below the bar,
 * so the app's top is never covered and, because only the transform changes,
 * the product document never relayouts. Cost: the app's bottom strip sits
 * off-screen for the moment the bar is revealed.
 */
function syncFrameLayout(): void {
  setTopbarLayout(
    appFrameTracking
      ? { offset: false, shown: getTopbarState().visible, transition: topbarTransition() }
      : { offset: true, shown: true, transition: '' },
  );
}

function setVisible(next: boolean): void {
  // The hidden bar keeps its tab stops on purpose: tabbing into it is what
  // reveals it again for keyboard users.
  if (!next) {
    appFrameTracking = true;
  }
  setTopbarVisible(next);
  if (appFrameTracking) {
    syncFrameLayout();
  }
}

function cancelHide(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function topbarHoldsFocus(): boolean {
  const active = focusedElement();
  if (active === null) {
    return false;
  }
  return bar?.contains(active) === true || active === revealButton || topbarSurfaceContains(active);
}

/** True while the user is working in the bar, so it must stay on screen. */
function isBusy(): boolean {
  return topbarHoldsFocus() || anyTopbarSurfaceOpen();
}

function canAutoHide(): boolean {
  return getTopbarState().autoHide && !isMobileDevice() && getLoggedIn();
}

/** Hide the bar after the delay, unless it is pinned or in use then. */
export function scheduleTopbarHide(): void {
  cancelHide();
  if (!canAutoHide()) {
    return;
  }
  hideTimer = setTimeout(() => {
    hideTimer = null;
    // Focus or an open popover during the delay defers the hide rather than
    // pulling the controls out from under the user.
    if (isBusy()) {
      scheduleTopbarHide();
      return;
    }
    setVisible(false);
  }, HIDE_DELAY_MS);
}

/** Show the bar (a hover, a focus in it). */
export function revealTopbar(): void {
  cancelHide();
  setVisible(true);
}

/** Show the bar and focus its first control (the reveal shortcut or control). */
export function revealTopbarAndFocus(): void {
  revealTopbar();
  if (bar !== undefined) {
    focusables(bar)[0]?.focus();
  }
}

/** Hand focus back to the app so it never parks on an offscreen control. */
function releaseFocusToApp(): void {
  const frame = currentProductFrame();
  if (frame !== null) {
    frame.focus();
    return;
  }
  focusedElement()?.blur();
}

function isRevealShortcut(event: KeyboardEvent): boolean {
  // `code` carries the physical key, which matters because macOS turns
  // Option+Shift+T into a dead key. Fall back to `key` when it is missing.
  const isT = event.code === 'KeyT' || event.key.toLowerCase() === 't';
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && isT;
}

function onKeyDown(event: KeyboardEvent): void {
  if (!isRevealShortcut(event)) {
    return;
  }
  event.preventDefault();
  if (!getTopbarState().visible) {
    revealTopbarAndFocus();
    return;
  }
  // Nothing to toggle while the bar is pinned, and an open popover owns
  // Escape for its own dismissal, so leave both alone.
  if (!canAutoHide() || anyTopbarSurfaceOpen()) {
    return;
  }
  if (topbarHoldsFocus()) {
    releaseFocusToApp();
  }
  cancelHide();
  setVisible(false);
}

function syncFocus(): void {
  if (!getTopbarState().autoHide) {
    return;
  }
  if (isBusy()) {
    revealTopbar();
  } else {
    scheduleTopbarHide();
  }
}

function bindListeners(): void {
  if (listeners !== null) {
    return;
  }
  listeners = new AbortController();
  const { signal } = listeners;

  // Tabbing into the offscreen bar reveals it, leaving it re-arms the timer.
  document.addEventListener('focusin', syncFocus, { signal });
  document.addEventListener(
    'focusout',
    () => {
      // activeElement only settles after focusout, so check on the next tick.
      if (focusoutTimer !== null) {
        clearTimeout(focusoutTimer);
      }
      focusoutTimer = setTimeout(() => {
        focusoutTimer = null;
        syncFocus();
      }, 0);
    },
    { signal },
  );
  document.addEventListener('keydown', onKeyDown, { signal });

  const reducedMotion = reducedMotionQuery();
  if (typeof reducedMotion?.addEventListener === 'function') {
    reducedMotion.addEventListener('change', syncFrameLayout, { signal });
  }
}

/**
 * Start auto-hiding the bar. Safe to call repeatedly: listeners bind once
 * and the hide timer restarts. No-op on touch devices, which have no hover
 * to bring the bar back, and on a page without the bar.
 */
export function armTopbarAutoHide(): void {
  if (isMobileDevice() || !getTopbarState().present) {
    return;
  }
  setTopbarAutoHide(true);
  bindListeners();
  scheduleTopbarHide();
}

/** Pin the bar on screen and stop auto-hiding, e.g. after logout. */
export function pinTopbarVisible(): void {
  setTopbarAutoHide(false);
  cancelHide();
  // A focus check queued by focusout must not run against a pinned or
  // disposed bar.
  if (focusoutTimer !== null) {
    clearTimeout(focusoutTimer);
    focusoutTimer = null;
  }
  if (appFrameTracking) {
    appFrameTracking = false;
    syncFrameLayout();
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
}

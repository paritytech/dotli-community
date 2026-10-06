// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li top bar auto-hide
//
// The bar folds into its status capsule a moment after the product's content
// shows on desktop, signed in or not (never over the loading screen or an
// error page), and at once when the user presses or tabs into the app. It
// never folds at a phone's width (PHONE_QUERY), where it is the phone header,
// and returns on pointer hover, on keyboard focus, and on the reveal
// shortcut, so home, settings, permissions and login never become
// mouse-only.
//
// The timing and the input handling live here, framework-free; what shows
// is the topbar store's: the bar's script (apps/host/src/components/
// Topbar.astro) folds it and sets its shortcut from `visible` and
// `autoHide`, and the TopbarReveal island renders the reveal control and the
// hover target over the capsule. The bar registers its element
// (registerTopbarElement) and the popovers theirs (state/topbar-surfaces.ts),
// for the focus and open checks.
//
import { isMobileDevice } from '@dotli/shared';
import { focusables } from './components/focus.js';
import { currentProductFrame, setTopbarLayout } from './product-frame-layout.js';
import { isPhoneViewport, watchPhoneViewport } from './phone-viewport.js';
import { productStore } from './state/product.js';
import { getTopbarState, setTopbarAutoHide, setTopbarVisible } from './state/topbar.js';
import { anyTopbarSurfaceOpen, topbarSurfaceContains } from './state/topbar-surfaces.js';

/** The board's auto-hide delay. */
const HIDE_DELAY_MS = 2000;

/** Keyboard reveal, advertised on the bar via aria-keyshortcuts. */
export const TOPBAR_REVEAL_SHORTCUT = 'Alt+Shift+T';

/** The always-reachable reveal control, one Tab past the app frame. */
export const TOPBAR_REVEAL_BUTTON_ID = 'topbar-reveal';

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let focusoutTimer: ReturnType<typeof setTimeout> | null = null;
let blurTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: AbortController | null = null;
/** The product's own content is on screen, as the host reports it. */
let contentShown = false;
/** The bar (the host page's `#topbar`), while bound. */
let bar: HTMLElement | undefined;
/** The reveal control (the TopbarReveal island's), while mounted. */
let revealButton: HTMLElement | undefined;

/**
 * Register the bar's element; returns the unregister. From here on the bar
 * lays the frame out for the viewport it is in.
 */
export function registerTopbarElement(el: HTMLElement): () => void {
  bar = el;
  syncFrameLayout();
  const unwatch = watchPhoneViewport(syncFrameLayout);
  return () => {
    unwatch();
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

/**
 * On desktop the pill and the capsule float over a full-height frame, as the
 * board draws them, so the product never relayouts on a fold or a reveal.
 * The phone header sits in the page flow, with the frame below it, and so
 * does a touch device's bar, which never folds (armTopbarAutoHide) and would
 * otherwise cover the app's top for good.
 */
function syncFrameLayout(): void {
  setTopbarLayout({ offset: isPhoneViewport() || isMobileDevice() });
}

function setVisible(next: boolean): void {
  // The hidden bar keeps its tab stops on purpose: tabbing into it is what
  // reveals it again for keyboard users.
  setTopbarVisible(next);
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
  return getTopbarState().autoHide && contentShown && !isMobileDevice() && !isPhoneViewport();
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

/**
 * The window crossed the phone width: as the phone header the bar comes back
 * and stays, with the frame below it, and as the pill it folds away again
 * after the delay, floating over the full-height frame.
 */
function onViewportChange(): void {
  if (isPhoneViewport()) {
    revealTopbar();
  } else {
    scheduleTopbarHide();
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

/**
 * The user pressed or tabbed into the app: the bar folds at once, as it does
 * for the shortcut. With a popover of the bar still open it waits for it, as
 * the timer does.
 */
function foldForApp(): void {
  if (!canAutoHide()) {
    return;
  }
  if (isBusy()) {
    scheduleTopbarHide();
    return;
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

  // Every error page marks the product failed (state/product.ts).
  const unsubscribe = productStore.subscribe(() => {
    if (productStore.get().status === 'error') {
      setProductContentShown(false);
    }
  });
  signal.addEventListener('abort', unsubscribe);

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
  // A press or a Tab into the cross-origin app frame is seen here only as
  // focus leaving this window for the frame, which is how the popovers and
  // the toasts read it too. Checked on the next tick, after the popovers that
  // close on blur have closed.
  window.addEventListener(
    'blur',
    () => {
      if (blurTimer !== null) {
        clearTimeout(blurTimer);
      }
      blurTimer = setTimeout(() => {
        blurTimer = null;
        const frame = currentProductFrame();
        if (frame !== null && document.activeElement === frame) {
          foldForApp();
        }
      }, 0);
    },
    { signal },
  );
  signal.addEventListener('abort', watchPhoneViewport(onViewportChange));
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

/**
 * Report whether the product's content is on screen: once the sandbox has
 * loaded it, or a local or preview frame has rendered. The bar folds only
 * over it, and comes back and stays for a loading screen or a failure.
 */
export function setProductContentShown(shown: boolean): void {
  contentShown = shown;
  if (shown) {
    scheduleTopbarHide();
  } else {
    revealTopbar();
  }
}

/**
 * Drop every listener and reset the state. The host arms once per session and
 * never needs this, tests do.
 */
export function disposeTopbarAutoHide(): void {
  setTopbarAutoHide(false);
  cancelHide();
  // A focus check queued by focusout must not run against a disposed bar.
  if (focusoutTimer !== null) {
    clearTimeout(focusoutTimer);
    focusoutTimer = null;
  }
  if (blurTimer !== null) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
  setVisible(true);
  listeners?.abort();
  listeners = null;
  contentShown = false;
}

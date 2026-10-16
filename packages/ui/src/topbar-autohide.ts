// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// On desktop the bar folds into its capsule once product content shows, and returns on hover, focus and
// the reveal shortcut so its controls never become mouse-only. Timing and input only, the store drives what shows.

import { isMobileDevice } from '@dotli/shared';
import { focusables } from './components/focus.js';
import { currentProductFrame, setTopbarLayout } from './product-frame-layout.js';
import { isPhoneViewport, watchPhoneViewport } from './phone-viewport.js';
import { productStore } from './state/product.js';
import { getTopbarState, setTopbarAutoHide, setTopbarVisible } from './state/topbar.js';
import { anyTopbarSurfaceOpen, topbarSurfaceContains } from './state/topbar-surfaces.js';

const HIDE_DELAY_MS = 2000;

/** Advertised on the bar via aria-keyshortcuts. */
export const TOPBAR_REVEAL_SHORTCUT = 'Alt+Shift+T';

/** The always-reachable reveal control, one Tab past the app frame. */
export const TOPBAR_REVEAL_BUTTON_ID = 'topbar-reveal';

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let focusoutTimer: ReturnType<typeof setTimeout> | null = null;
let blurTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: AbortController | null = null;
let contentShown = false;
let bar: HTMLElement | undefined;
let revealButton: HTMLElement | undefined;

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

export function registerTopbarRevealButton(el: HTMLElement): () => void {
  revealButton = el;
  return () => {
    if (revealButton === el) {
      revealButton = undefined;
    }
  };
}

/** Bars that never fold keep the frame clear of them, rather than sitting over it for good. */
function syncFrameLayout(): void {
  setTopbarLayout({ offset: isPhoneViewport() || isMobileDevice() });
}

function setVisible(next: boolean): void {
  // The hidden bar keeps its tab stops, since tabbing into it is what reveals it for keyboard users.
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

function isBusy(): boolean {
  return topbarHoldsFocus() || anyTopbarSurfaceOpen();
}

function canAutoHide(): boolean {
  return getTopbarState().autoHide && contentShown && !isMobileDevice() && !isPhoneViewport();
}

export function scheduleTopbarHide(): void {
  cancelHide();
  if (!canAutoHide()) {
    return;
  }
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (isBusy()) {
      scheduleTopbarHide();
      return;
    }
    setVisible(false);
  }, HIDE_DELAY_MS);
}

export function revealTopbar(): void {
  cancelHide();
  setVisible(true);
}

export function revealTopbarAndFocus(): void {
  revealTopbar();
  if (bar !== undefined) {
    focusables(bar)[0]?.focus();
  }
}

function onViewportChange(): void {
  if (isPhoneViewport()) {
    revealTopbar();
  } else {
    scheduleTopbarHide();
  }
}

/** So focus never parks on an offscreen control. */
function releaseFocusToApp(): void {
  const frame = currentProductFrame();
  if (frame !== null) {
    frame.focus();
    return;
  }
  focusedElement()?.blur();
}

function isRevealShortcut(event: KeyboardEvent): boolean {
  // `code` first, because macOS turns Option+Shift+T into a dead key.
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
  // An open popover owns its own dismissal.
  if (!canAutoHide() || anyTopbarSurfaceOpen()) {
    return;
  }
  if (topbarHoldsFocus()) {
    releaseFocusToApp();
  }
  cancelHide();
  setVisible(false);
}

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

  const unsubscribe = productStore.subscribe(() => {
    if (productStore.get().status === 'error') {
      setProductContentShown(false);
    }
  });
  signal.addEventListener('abort', unsubscribe);

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
  // A press or Tab into the cross-origin frame shows only as this window's blur. Checked on the next
  // tick, after popovers that close on blur have closed.
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

/** Safe to call repeatedly. A no-op on touch devices, which have no hover to bring the bar back. */
export function armTopbarAutoHide(): void {
  if (isMobileDevice() || !getTopbarState().present) {
    return;
  }
  setTopbarAutoHide(true);
  bindListeners();
  scheduleTopbarHide();
}

/** The bar folds only over product content, never a loading screen or failure. */
export function setProductContentShown(shown: boolean): void {
  contentShown = shown;
  if (shown) {
    scheduleTopbarHide();
  } else {
    revealTopbar();
  }
}

/** Tests only, the host arms once per session. */
export function disposeTopbarAutoHide(): void {
  setTopbarAutoHide(false);
  cancelHide();
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

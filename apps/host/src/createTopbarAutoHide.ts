// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// On desktop the bar folds into its capsule once product content shows, and returns on hover, focus and
// the reveal shortcut so its controls never become mouse-only. Timing and input only, the store drives what shows.

import { isMobileDevice } from './isMobileDevice.js';
import { productState } from './runtime/state/productState.js';
import { realTimers, type Timers } from '@dotli/shared';
import { focusables, isPhoneViewport, watchPhoneViewport } from '@dotli/ui';
import { productFrameLayout, type ProductFrameLayout } from './createProductFrameLayout.js';
import { topbarState } from './state/topbarState.js';
import { topbarSurfaces } from './state/topbarSurfaces.js';

/** The page's focus and the events that move it. */
export type TopbarAutoHidePage = {
  /** Fires focusin, focusout and keydown. */
  document: Pick<Document, 'addEventListener'>;
  /** Fires blur, which is all a press or Tab into the cross-origin frame shows. */
  window: Pick<Window, 'addEventListener'>;
  /** Returns the focused element, or null when no HTML element has focus. Never throws. */
  activeElement: () => HTMLElement | null;
  /** Moves focus to the bar's first control, and does nothing when it has none. Never throws. */
  focusFirst: (bar: HTMLElement) => void;
};

type Params = {
  /** Touch devices have no hover to bring the bar back. */
  isMobile: () => boolean;
  isPhone: () => boolean;
  /** Returns the unwatch. */
  watchPhone: (onChange: () => void) => () => void;
  layout: Pick<ProductFrameLayout, 'setTopbarLayout' | 'getFrame'>;
  /** Reached as the auto-hide starts and acts, so making one reads no browser global. */
  page: () => TopbarAutoHidePage;
  /** The timers the fold and the focus checks wait on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

export type TopbarAutoHide = ReturnType<typeof createTopbarAutoHide>;

export const HIDE_DELAY_MS = 2000;

/** Builds the bar's auto-hide. Reads nothing from the page until it starts or acts. Never throws. */
export function createTopbarAutoHide({
  isMobile,
  isPhone,
  watchPhone,
  layout,
  page: getPage,
  timers = realTimers,
}: Params) {
  let hideTimer: unknown = null;
  let focusoutTimer: unknown = null;
  let blurTimer: unknown = null;
  let listeners: AbortController | null = null;
  let contentShown = false;
  let bar: HTMLElement | undefined;
  let revealButton: HTMLElement | undefined;

  /** Bars that never fold keep the frame clear of them, rather than sitting over it for good. */
  function syncFrameLayout(): void {
    layout.setTopbarLayout({ offset: isPhone() || isMobile() });
  }

  function setVisible(next: boolean): void {
    // The hidden bar keeps its tab stops, since tabbing into it is what reveals it for keyboard users.
    topbarState.setVisible(next);
  }

  function cancelHide(): void {
    if (hideTimer !== null) {
      timers.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function getFocusedElement(): HTMLElement | null {
    return getPage().activeElement();
  }

  function isTopbarFocused(): boolean {
    const active = getFocusedElement();
    if (active === null) {
      return false;
    }
    return bar?.contains(active) === true || active === revealButton || topbarSurfaces.contains(active);
  }

  function isBusy(): boolean {
    return isTopbarFocused() || topbarSurfaces.isAnyOpen();
  }

  function canAutoHide(): boolean {
    return topbarState.get().autoHide && contentShown && !isMobile() && !isPhone();
  }

  function scheduleHide(): void {
    cancelHide();
    if (!canAutoHide()) {
      return;
    }
    hideTimer = timers.setTimeout(() => {
      hideTimer = null;
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

  function revealAndFocus(): void {
    reveal();
    if (bar !== undefined) {
      getPage().focusFirst(bar);
    }
  }

  function onViewportChange(): void {
    if (isPhone()) {
      reveal();
    } else {
      scheduleHide();
    }
  }

  /** So focus never parks on an offscreen control. */
  function releaseFocusToApp(): void {
    const frame = layout.getFrame();
    if (frame !== null) {
      frame.focus();
      return;
    }
    getFocusedElement()?.blur();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Bound from shell start, so before arm and on touch devices the key belongs to the page.
    if (!topbarState.get().autoHide || !isRevealShortcut(event)) {
      return;
    }
    event.preventDefault();
    if (!topbarState.get().visible) {
      revealAndFocus();
      return;
    }
    // An open popover owns its own dismissal.
    if (!canAutoHide() || topbarSurfaces.isAnyOpen()) {
      return;
    }
    if (isTopbarFocused()) {
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
      scheduleHide();
      return;
    }
    cancelHide();
    setVisible(false);
  }

  function syncFocus(): void {
    if (!topbarState.get().autoHide) {
      return;
    }
    if (isBusy()) {
      reveal();
    } else {
      scheduleHide();
    }
  }

  function setContentShown(shown: boolean): void {
    contentShown = shown;
    if (shown) {
      scheduleHide();
    } else {
      reveal();
    }
  }

  function stop(): void {
    topbarState.setAutoHide(false);
    cancelHide();
    if (focusoutTimer !== null) {
      timers.clearTimeout(focusoutTimer);
      focusoutTimer = null;
    }
    if (blurTimer !== null) {
      timers.clearTimeout(blurTimer);
      blurTimer = null;
    }
    setVisible(true);
    listeners?.abort();
    listeners = null;
    contentShown = false;
  }

  function start(): () => void {
    if (listeners !== null) {
      return stop;
    }
    listeners = new AbortController();
    const { signal } = listeners;
    const page = getPage();

    const unsubscribe = productState.store.listen(() => {
      if (productState.get().status === 'error') {
        setContentShown(false);
      }
    });
    signal.addEventListener('abort', unsubscribe);

    page.document.addEventListener('focusin', syncFocus, { signal });
    page.document.addEventListener(
      'focusout',
      () => {
        // activeElement only settles after focusout, so check on the next tick.
        if (focusoutTimer !== null) {
          timers.clearTimeout(focusoutTimer);
        }
        focusoutTimer = timers.setTimeout(() => {
          focusoutTimer = null;
          syncFocus();
        }, 0);
      },
      { signal },
    );
    page.document.addEventListener('keydown', onKeyDown, { signal });
    // A press or Tab into the cross-origin frame shows only as this window's blur. Checked on the next
    // tick, after popovers that close on blur have closed.
    page.window.addEventListener(
      'blur',
      () => {
        if (blurTimer !== null) {
          timers.clearTimeout(blurTimer);
        }
        blurTimer = timers.setTimeout(() => {
          blurTimer = null;
          const frame = layout.getFrame();
          if (frame !== null && page.activeElement() === frame) {
            foldForApp();
          }
        }, 0);
      },
      { signal },
    );
    signal.addEventListener('abort', watchPhone(onViewportChange));
    return stop;
  }

  function arm(): void {
    if (isMobile() || !topbarState.get().present) {
      return;
    }
    topbarState.setAutoHide(true);
    scheduleHide();
  }

  function registerBar(element: HTMLElement): () => void {
    bar = element;
    syncFrameLayout();
    const unwatch = watchPhone(syncFrameLayout);
    function release(): void {
      unwatch();
      if (bar === element) {
        bar = undefined;
      }
    }
    return release;
  }

  function registerRevealButton(element: HTMLElement): () => void {
    revealButton = element;
    function release(): void {
      if (revealButton === element) {
        revealButton = undefined;
      }
    }
    return release;
  }

  return {
    /**
     * Listens for focus, keys, blur, the viewport and a failed product until the returned stop, which shows the bar.
     * A second start returns the same stop. Throws only as `page` or `watchPhone` does.
     */
    start,
    /** Lets the bar fold. Safe to call repeatedly. A no-op on touch devices, which have no hover to bring the bar back. */
    arm,
    /** Records whether product content shows. The bar folds only over it, never a loading screen or failure. */
    setContentShown,
    /** Folds the bar after a delay, unless it holds focus or an open surface by then. Never throws. */
    scheduleHide,
    /** Shows the bar and cancels a pending fold. Never throws. */
    reveal,
    /** Shows the bar and focuses its first control. Throws only as `page` does. */
    revealAndFocus,
    /** Registers the bar the auto-hide folds. Returns its release. Throws only as `watchPhone` does. */
    registerBar,
    /** Registers the reveal button, which holds the bar open while it has focus. Returns its release. Never throws. */
    registerRevealButton,
  };
}

/** Returns the browser's document and window as the auto-hide reads them. Reads them on the call, never at import. */
export function getBrowserTopbarPage(): TopbarAutoHidePage {
  return {
    document,
    window,
    activeElement: () => (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    focusFirst(bar) {
      focusables(bar)[0]?.focus();
    },
  };
}

/** The page's, which the shell state starts and the bar, its reveal island and the host share. */
export const pageTopbarAutoHide = createTopbarAutoHide({
  isMobile: isMobileDevice,
  isPhone: isPhoneViewport,
  watchPhone: watchPhoneViewport,
  layout: productFrameLayout,
  page: getBrowserTopbarPage,
});

function isRevealShortcut(event: KeyboardEvent): boolean {
  // `code` first, because macOS turns Option+Shift+T into a dead key.
  const isKeyT = event.code === 'KeyT' || event.key.toLowerCase() === 't';
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && isKeyT;
}

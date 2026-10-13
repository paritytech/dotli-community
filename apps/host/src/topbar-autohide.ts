// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// On desktop the bar folds into its capsule once product content shows, and returns on hover, focus and
// the reveal shortcut so its controls never become mouse-only. Timing and input only, the store drives what shows.

import { isMobileDevice } from './device.js';
import { productStore } from './runtime/state/product.js';
import { focusables, isPhoneViewport, watchPhoneViewport } from '@dotli/ui';
import { currentProductFrame, setTopbarLayout, type TopbarLayout } from './product-frame-layout.js';
import { getTopbarState, setTopbarAutoHide, setTopbarVisible } from './state/topbar.js';
import { anyTopbarSurfaceOpen, topbarSurfaceContains } from './state/topbar-surfaces.js';

const HIDE_DELAY_MS = 2000;

/** Advertised on the bar via aria-keyshortcuts. */
export const TOPBAR_REVEAL_SHORTCUT = 'Alt+Shift+T';

export interface TopbarAutoHideDeps {
  /** Touch devices have no hover to bring the bar back. */
  isMobile: () => boolean;
  isPhone: () => boolean;
  /** Returns the unwatch. */
  watchPhone: (onChange: () => void) => () => void;
  layout: {
    setTopbarLayout: (layout: TopbarLayout) => void;
    currentProductFrame: () => HTMLIFrameElement | null;
  };
  /** Reached as the auto-hide starts and acts, so making one reads no browser global. */
  page: () => TopbarAutoHidePage;
}

/** The page's focus and the events that move it. */
export interface TopbarAutoHidePage {
  /** Fires focusin, focusout and keydown. */
  document: EventTarget;
  /** Fires blur, which is all a press or Tab into the cross-origin frame shows. */
  window: EventTarget;
  activeElement: () => HTMLElement | null;
  /** Moves focus to the bar's first control. */
  focusFirst: (bar: HTMLElement) => void;
}

/** The browser's document and window. */
export function browserTopbarPage(): TopbarAutoHidePage {
  return {
    document,
    window,
    activeElement: () => (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    focusFirst: bar => {
      focusables(bar)[0]?.focus();
    },
  };
}

export interface TopbarAutoHide {
  /** Listens for focus, keys, blur, the viewport and a failed product until the returned stop, which shows the bar. */
  start: () => () => void;
  /** Safe to call repeatedly. A no-op on touch devices, which have no hover to bring the bar back. */
  arm: () => void;
  /** The bar folds only over product content, never a loading screen or failure. */
  setContentShown: (shown: boolean) => void;
  scheduleHide: () => void;
  reveal: () => void;
  revealAndFocus: () => void;
  registerBar: (el: HTMLElement) => () => void;
  registerRevealButton: (el: HTMLElement) => () => void;
}

export function createTopbarAutoHide(deps: TopbarAutoHideDeps): TopbarAutoHide {
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let focusoutTimer: ReturnType<typeof setTimeout> | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let listeners: AbortController | null = null;
  let contentShown = false;
  let bar: HTMLElement | undefined;
  let revealButton: HTMLElement | undefined;

  /** Bars that never fold keep the frame clear of them, rather than sitting over it for good. */
  function syncFrameLayout(): void {
    deps.layout.setTopbarLayout({ offset: deps.isPhone() || deps.isMobile() });
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
    return deps.page().activeElement();
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
    return getTopbarState().autoHide && contentShown && !deps.isMobile() && !deps.isPhone();
  }

  function scheduleHide(): void {
    cancelHide();
    if (!canAutoHide()) {
      return;
    }
    hideTimer = setTimeout(() => {
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
      deps.page().focusFirst(bar);
    }
  }

  function onViewportChange(): void {
    if (deps.isPhone()) {
      reveal();
    } else {
      scheduleHide();
    }
  }

  /** So focus never parks on an offscreen control. */
  function releaseFocusToApp(): void {
    const frame = deps.layout.currentProductFrame();
    if (frame !== null) {
      frame.focus();
      return;
    }
    focusedElement()?.blur();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Bound from shell start, so before arm and on touch devices the key belongs to the page.
    if (!getTopbarState().autoHide || !isRevealShortcut(event)) {
      return;
    }
    event.preventDefault();
    if (!getTopbarState().visible) {
      revealAndFocus();
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
      scheduleHide();
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

  function start(): () => void {
    if (listeners !== null) {
      return stop;
    }
    listeners = new AbortController();
    const { signal } = listeners;
    const page = deps.page();

    const unsubscribe = productStore.subscribe(() => {
      if (productStore.get().status === 'error') {
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
          clearTimeout(focusoutTimer);
        }
        focusoutTimer = setTimeout(() => {
          focusoutTimer = null;
          syncFocus();
        }, 0);
      },
      { signal },
    );
    page.document.addEventListener(
      'keydown',
      event => {
        onKeyDown(event as KeyboardEvent);
      },
      { signal },
    );
    // A press or Tab into the cross-origin frame shows only as this window's blur. Checked on the next
    // tick, after popovers that close on blur have closed.
    page.window.addEventListener(
      'blur',
      () => {
        if (blurTimer !== null) {
          clearTimeout(blurTimer);
        }
        blurTimer = setTimeout(() => {
          blurTimer = null;
          const frame = deps.layout.currentProductFrame();
          if (frame !== null && page.activeElement() === frame) {
            foldForApp();
          }
        }, 0);
      },
      { signal },
    );
    signal.addEventListener('abort', deps.watchPhone(onViewportChange));
    return stop;
  }

  return {
    start,
    arm() {
      if (deps.isMobile() || !getTopbarState().present) {
        return;
      }
      setTopbarAutoHide(true);
      scheduleHide();
    },
    setContentShown,
    scheduleHide,
    reveal,
    revealAndFocus,
    registerBar(el) {
      bar = el;
      syncFrameLayout();
      const unwatch = deps.watchPhone(syncFrameLayout);
      return () => {
        unwatch();
        if (bar === el) {
          bar = undefined;
        }
      };
    },
    registerRevealButton(el) {
      revealButton = el;
      return () => {
        if (revealButton === el) {
          revealButton = undefined;
        }
      };
    },
  };
}

function isRevealShortcut(event: KeyboardEvent): boolean {
  // `code` first, because macOS turns Option+Shift+T into a dead key.
  const isT = event.code === 'KeyT' || event.key.toLowerCase() === 't';
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && isT;
}

/** The page's, which the shell state starts and the bar, its reveal island and the host share. */
export const pageTopbarAutoHide: TopbarAutoHide = createTopbarAutoHide({
  isMobile: isMobileDevice,
  isPhone: isPhoneViewport,
  watchPhone: watchPhoneViewport,
  layout: { setTopbarLayout, currentProductFrame },
  page: browserTopbarPage,
});

export const {
  start: startTopbarAutoHide,
  arm: armTopbarAutoHide,
  setContentShown: setProductContentShown,
  scheduleHide: scheduleTopbarHide,
  reveal: revealTopbar,
  registerBar: registerTopbarElement,
} = pageTopbarAutoHide;

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// On desktop the bar folds into its capsule once product content shows, and returns on hover, focus and
// the reveal shortcut so its controls never become mouse-only. Timing and input only, the store drives what shows.

import { isMobileDevice } from './isMobileDevice.js';
import { productState } from './runtime/state/productState.js';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { focusables, isPhoneViewport, watchPhoneViewport } from '@dotli/ui';
import { productFrameLayout, type ProductFrameLayout } from './createProductFrameLayout.js';
import { topbarState } from './state/topbarState.js';
import { topbarSurfaces } from './state/topbarSurfaces.js';

const report = createReporter({ flow: 'ui' });
const autoHideTransitionMetric = defineCount<'error'>('topbar.auto_hide_transition');

/** The page's focus and pointer, and the events that move them. */
export type TopbarAutoHidePage = {
  /** Fires focusin, focusout and keydown. */
  document: Pick<Document, 'addEventListener'>;
  /** Fires blur, which is all a press or Tab into the cross-origin frame shows. */
  window: Pick<Window, 'addEventListener'>;
  /** Returns the focused element, or null when no HTML element has focus. */
  activeElement: () => HTMLElement | null;
  /** Moves focus to the bar's first control, and does nothing when it has none. */
  focusFirst: (bar: HTMLElement) => void;
  /** Whether the pointer rests on `element`. */
  isHovered: (element: HTMLElement) => boolean;
};

type Params = {
  /** Touch devices have no hover to bring the bar back. */
  isMobile: () => boolean;
  isPhone: () => boolean;
  /** Returns the unwatch. */
  watchPhone: (onChange: () => void) => () => void;
  layout: Pick<ProductFrameLayout, 'getFrame'>;
  /** Reached only once the auto-hide starts or a reveal focuses the bar, so making one reads no browser global. */
  page: () => TopbarAutoHidePage;
  /** The timers the fold and the focus checks wait on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout'>;
};

/**
 * `listeners` stops what the started auto-hide listens to. `contentShown` is whether product content shows, which a fold
 * needs. The bar shows in every state but `folded`, and auto-hide is on in `up`, `folding` and `folded`.
 */
type AutoHideState =
  | { kind: 'stopped' }
  /** Started, bar up, and not armed, so it never folds. */
  | { kind: 'unarmed'; listeners: AbortController; contentShown: boolean }
  /** Armed, bar up, no fold pending. */
  | { kind: 'up'; listeners: AbortController; contentShown: boolean }
  /** Armed over shown content, the fold's timer running. */
  | { kind: 'folding'; listeners: AbortController; contentShown: true }
  /** Armed over shown content, bar folded. */
  | { kind: 'folded'; listeners: AbortController; contentShown: true };

type FoldingState = Extract<AutoHideState, { kind: 'folding' }>;

type AutoHideEvent =
  | { kind: 'started' }
  | { kind: 'stopped' }
  | { kind: 'armed' }
  | { kind: 'contentChanged'; shown: boolean }
  | { kind: 'hideAsked' }
  | { kind: 'revealAsked' }
  | { kind: 'revealFocusAsked' }
  | { kind: 'focusChanged' }
  | { kind: 'windowBlurred' }
  | { kind: 'shortcutPressed'; press: KeyboardEvent }
  | { kind: 'viewportChanged' }
  | { kind: 'hideDue'; folding: FoldingState };

type AutoHideEffect =
  | { kind: 'barFocused' }
  /** Moves focus off a folded bar, so it never parks on an offscreen control. */
  | { kind: 'focusReleased' }
  | { kind: 'shortcutTaken'; press: KeyboardEvent };

type AutoHideMachine = MachineTypes<AutoHideState, AutoHideEvent, AutoHideEffect>;

export type TopbarAutoHide = ReturnType<typeof createTopbarAutoHide>;

export const HIDE_DELAY_MS = 2000;

/**
 * Builds the bar's auto-hide. Until it starts, every method but `revealAndFocus` and the registrations does nothing,
 * and only `revealAndFocus` reads the page.
 */
export function createTopbarAutoHide({
  isMobile,
  isPhone,
  watchPhone,
  layout,
  page: getPage,
  timers = realTimers,
}: Params) {
  let bar: HTMLElement | undefined;
  let revealButton: HTMLElement | undefined;

  const stopAutoHide: HandlerOf<AutoHideMachine, 'unarmed' | 'up' | 'folding' | 'folded', 'stopped'> = (
    { listeners },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'stopped' });
    listeners.abort();
  };
  const focusBar: HandlerOf<AutoHideMachine, 'stopped' | 'unarmed', 'revealFocusAsked'> = (
    _state,
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'barFocused' });
  };
  /** Restarts the wait for the fold of an armed bar that is up. */
  const restartFold = (
    state: Extract<AutoHideState, { kind: 'up' | 'folding' }>,
    _event: unknown,
    transition: Transition<AutoHideMachine>,
  ): void => {
    scheduleFold(state.listeners, state.contentShown, transition);
  };
  const changeContent: HandlerOf<AutoHideMachine, 'up' | 'folding', 'contentChanged'> = (
    { listeners },
    { shown },
    transition,
  ) => {
    scheduleFold(listeners, shown, transition);
  };
  /** Shows a bar that holds focus or an open surface, and restarts the wait for the fold of one that does not. */
  const followFocus: HandlerOf<AutoHideMachine, 'up' | 'folding', 'focusChanged'> = (
    { listeners, contentShown },
    _event,
    transition,
  ) => {
    if (isBusy()) {
      transition.emitState({ kind: 'up', listeners, contentShown });
      return;
    }
    scheduleFold(listeners, contentShown, transition);
  };
  /** Folds the bar at once when a press or Tab moved focus into the product's frame. */
  const foldForApp: HandlerOf<AutoHideMachine, 'up' | 'folding', 'windowBlurred'> = (
    { listeners, contentShown },
    _event,
    transition,
  ) => {
    const frame = layout.getFrame();
    if (frame === null || getPage().activeElement() !== frame || !canFold(contentShown)) {
      return;
    }
    foldUnlessBusy(listeners, transition);
  };
  const foldNow: HandlerOf<AutoHideMachine, 'up' | 'folding', 'shortcutPressed'> = (
    state,
    { press },
    { emitState, emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'shortcutTaken', press });
    // An open popover owns its own dismissal.
    if (!canFold(state.contentShown) || topbarSurfaces.isAnyOpen()) {
      return;
    }
    emitState({ kind: 'folded', listeners: state.listeners, contentShown: true });
    emitSideEffect({ kind: 'focusReleased' });
  };
  const revealBar: HandlerOf<AutoHideMachine, 'folding' | 'folded', 'revealAsked'> = (
    { listeners },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'up', listeners, contentShown: true });
  };
  const revealAndFocusBar: HandlerOf<AutoHideMachine, 'up' | 'folding' | 'folded', 'revealFocusAsked'> = (
    { listeners, contentShown },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'up', listeners, contentShown });
    emitSideEffect({ kind: 'barFocused' });
  };
  const autoHide = createStateMachine<AutoHideMachine>({
    initial: { kind: 'stopped' },
    handlers: {
      stopped: {
        started(_state, _event, { emitState, update }) {
          const listeners = new AbortController();
          // Started before any listener is added, so a stop releases those added before one threw.
          emitState({ kind: 'unarmed', listeners, contentShown: false });
          listenToPage(listeners.signal, update);
        },
        revealFocusAsked: focusBar,
      },
      unarmed: {
        stopped: stopAutoHide,
        armed(state, _event, transition) {
          if (isMobile()) {
            return;
          }
          scheduleFold(state.listeners, state.contentShown, transition);
        },
        contentChanged(state, { shown }, { emitState }) {
          emitState({ ...state, contentShown: shown });
        },
        revealFocusAsked: focusBar,
      },
      up: {
        stopped: stopAutoHide,
        armed: restartFold,
        contentChanged: changeContent,
        hideAsked: restartFold,
        revealFocusAsked: revealAndFocusBar,
        focusChanged: followFocus,
        windowBlurred: foldForApp,
        shortcutPressed: foldNow,
        viewportChanged: restartFold,
      },
      folding: {
        stopped: stopAutoHide,
        armed: restartFold,
        contentChanged: changeContent,
        hideAsked: restartFold,
        revealAsked: revealBar,
        revealFocusAsked: revealAndFocusBar,
        focusChanged: followFocus,
        windowBlurred: foldForApp,
        shortcutPressed: foldNow,
        viewportChanged: restartFold,
        hideDue(state, { folding }, transition) {
          // A timer from a wait that was left or restarted folds nothing.
          if (folding !== state) {
            return;
          }
          foldUnlessBusy(state.listeners, transition);
        },
      },
      folded: {
        stopped: stopAutoHide,
        contentChanged({ listeners }, { shown }, { emitState }) {
          if (shown) {
            return;
          }
          emitState({ kind: 'up', listeners, contentShown: false });
        },
        revealAsked: revealBar,
        revealFocusAsked: revealAndFocusBar,
        focusChanged({ listeners }, _event, { emitState }) {
          if (!isBusy()) {
            return;
          }
          emitState({ kind: 'up', listeners, contentShown: true });
        },
        shortcutPressed({ listeners }, { press }, { emitState, emitSideEffect }) {
          emitSideEffect({ kind: 'shortcutTaken', press });
          emitState({ kind: 'up', listeners, contentShown: true });
          emitSideEffect({ kind: 'barFocused' });
        },
        viewportChanged({ listeners }, _event, { emitState }) {
          if (isPhone()) {
            emitState({ kind: 'up', listeners, contentShown: true });
          }
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'barFocused':
          if (bar !== undefined) {
            getPage().focusFirst(bar);
          }
          return;
        case 'focusReleased':
          releaseFocusToApp();
          return;
        case 'shortcutTaken':
          effect.press.preventDefault();
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: autoHideTransitionMetric,
        message: '[dot.li] A topbar auto-hide transition threw',
      });
    },
  });
  // The bar's look follows the state alone. The hidden bar keeps its tab stops, since tabbing into it is what reveals
  // it for keyboard users.
  autoHide.state.listen(state => {
    topbarState.setVisible(state.kind !== 'folded');
    topbarState.setAutoHide(state.kind === 'up' || state.kind === 'folding' || state.kind === 'folded');
  });

  return {
    /**
     * Listens for focus, keys, blur, the viewport and a failed product until the returned stop, which shows the bar.
     * A second start returns the same stop.
     */
    start: (): (() => void) => {
      autoHide.update({ kind: 'started' });
      return stop;
    },
    /**
     * Lets the bar fold. Safe to call repeatedly. A no-op on touch devices, which have no hover to
     * bring the bar back.
     */
    arm: (): void => {
      autoHide.update({ kind: 'armed' });
    },
    /** Records whether product content shows. The bar folds only over it, never a loading screen or failure. */
    setContentShown: (shown: boolean): void => {
      autoHide.update({ kind: 'contentChanged', shown });
    },
    /** Folds the bar after a delay, unless it holds focus or the pointer, or a surface of it is open, by then. */
    scheduleHide: (): void => {
      autoHide.update({ kind: 'hideAsked' });
    },
    /** Shows the bar and cancels a pending fold. */
    reveal: (): void => {
      autoHide.update({ kind: 'revealAsked' });
    },
    /** Shows the bar and focuses its first control. */
    revealAndFocus: (): void => {
      autoHide.update({ kind: 'revealFocusAsked' });
    },
    /** Registers the bar the auto-hide folds. Returns its release. */
    registerBar,
    /** Registers the reveal button, which holds the bar open while it has focus. Returns its release. */
    registerRevealButton,
  };

  function stop(): void {
    autoHide.update({ kind: 'stopped' });
  }

  function registerBar(element: HTMLElement): () => void {
    bar = element;
    return () => {
      if (bar === element) {
        bar = undefined;
      }
    };
  }

  function registerRevealButton(element: HTMLElement): () => void {
    revealButton = element;
    return () => {
      if (revealButton === element) {
        revealButton = undefined;
      }
    };
  }

  /** Sends the machine focus, keys, blur, the viewport and a failed product until `signal` aborts. */
  function listenToPage(signal: AbortSignal, update: Transition<AutoHideMachine>['update']): void {
    const page = getPage();
    /** Sends `event` on the next tick, unless the listeners have stopped by then. */
    function sendNextTick(event: AutoHideEvent): void {
      timers.setTimeout(() => {
        if (!signal.aborted) {
          update(event);
        }
      }, 0);
    }
    signal.addEventListener(
      'abort',
      productState.store.listen(product => {
        if (product.status === 'error') {
          update({ kind: 'contentChanged', shown: false });
        }
      }),
    );
    page.document.addEventListener(
      'focusin',
      () => {
        update({ kind: 'focusChanged' });
      },
      { signal },
    );
    page.document.addEventListener(
      'focusout',
      () => {
        // activeElement only settles after focusout, so check on the next tick.
        sendNextTick({ kind: 'focusChanged' });
      },
      { signal },
    );
    page.document.addEventListener(
      'keydown',
      press => {
        if (isRevealShortcut(press)) {
          update({ kind: 'shortcutPressed', press });
        }
      },
      { signal },
    );
    // A press or Tab into the cross-origin frame shows only as this window's blur. Checked on the next tick, after
    // popovers that close on blur have closed.
    page.window.addEventListener(
      'blur',
      () => {
        sendNextTick({ kind: 'windowBlurred' });
      },
      { signal },
    );
    signal.addEventListener(
      'abort',
      watchPhone(() => {
        update({ kind: 'viewportChanged' });
      }),
    );
  }

  function canFold(contentShown: boolean): boolean {
    // An armed bar is never on a touch device.
    return contentShown && !isPhone();
  }

  function isTopbarFocused(): boolean {
    const active = getPage().activeElement();
    if (active === null) {
      return false;
    }
    return bar?.contains(active) === true || active === revealButton || topbarSurfaces.contains(active);
  }

  /** Whether the bar holds focus or the pointer, or a surface of it is open, any of which keeps it up. */
  function isBusy(): boolean {
    return isTopbarFocused() || (bar !== undefined && getPage().isHovered(bar)) || topbarSurfaces.isAnyOpen();
  }

  function releaseFocusToApp(): void {
    if (!isTopbarFocused()) {
      return;
    }
    const frame = layout.getFrame();
    if (frame !== null) {
      frame.focus();
      return;
    }
    getPage().activeElement()?.blur();
  }

  /** Folds the bar over shown content, or waits again while it is busy. */
  function foldUnlessBusy(listeners: AbortController, transition: Transition<AutoHideMachine>): void {
    if (isBusy()) {
      scheduleFold(listeners, true, transition);
      return;
    }
    transition.emitState({ kind: 'folded', listeners, contentShown: true });
  }

  /** Starts a new wait for the fold when the bar can fold, and keeps it up with no fold pending otherwise. */
  function scheduleFold(
    listeners: AbortController,
    contentShown: boolean,
    { emitState, update }: Transition<AutoHideMachine>,
  ): void {
    if (!canFold(contentShown)) {
      emitState({ kind: 'up', listeners, contentShown });
      return;
    }
    const folding: FoldingState = { kind: 'folding', listeners, contentShown: true };
    emitState(folding);
    timers.setTimeout(() => {
      update({ kind: 'hideDue', folding });
    }, HIDE_DELAY_MS);
  }
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
    isHovered: element => element.matches(':hover'),
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

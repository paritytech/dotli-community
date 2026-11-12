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

/** The page's focus and the events that move it. */
export type TopbarAutoHidePage = {
  /** Fires focusin, focusout and keydown. */
  document: Pick<Document, 'addEventListener'>;
  /** Fires blur, which is all a press or Tab into the cross-origin frame shows. */
  window: Pick<Window, 'addEventListener'>;
  /** Returns the focused element, or null when no HTML element has focus. */
  activeElement: () => HTMLElement | null;
  /** Moves focus to the bar's first control, and does nothing when it has none. */
  focusFirst: (bar: HTMLElement) => void;
};

type Params = {
  /** Touch devices have no hover to bring the bar back. */
  isMobile: () => boolean;
  isPhone: () => boolean;
  /** Returns the unwatch. */
  watchPhone: (onChange: () => void) => () => void;
  layout: Pick<ProductFrameLayout, 'setTopbarLayout' | 'getFrame'>;
  /**
   * Reached as the auto-hide starts, or as a reveal before that focuses the bar, so making one reads no browser
   * global.
   */
  page: () => TopbarAutoHidePage;
  /** The timers the fold and the focus checks wait on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout'>;
};

/** The started auto-hide's page and its listeners' stop. One per start, so a stale focus check is told apart. */
type AutoHideRun = { page: TopbarAutoHidePage; stopListening: () => void };

type AutoHideState =
  | { kind: 'stopped' }
  /** Started, bar up, and not armed, so it never folds. */
  | { kind: 'unarmed'; run: AutoHideRun; contentShown: boolean }
  /** Armed, bar up, no fold pending. */
  | { kind: 'up'; run: AutoHideRun; contentShown: boolean }
  /** Armed over shown content, the fold's timer running. */
  | { kind: 'folding'; run: AutoHideRun }
  /** Armed over shown content, bar folded. */
  | { kind: 'folded'; run: AutoHideRun };

type ArmedState = Extract<AutoHideState, { kind: 'up' | 'folding' | 'folded' }>;

type FoldingState = Extract<AutoHideState, { kind: 'folding' }>;

type AutoHideEvent =
  | { kind: 'started' }
  | { kind: 'stopped' }
  | { kind: 'armed' }
  | { kind: 'contentChanged'; shown: boolean }
  | { kind: 'hideAsked' }
  | { kind: 'revealAsked' }
  | { kind: 'revealFocusAsked' }
  /** `run` is null for a focusin, and the starting run for a check queued after a focusout. */
  | { kind: 'focusChanged'; run: AutoHideRun | null }
  | { kind: 'windowBlurred'; run: AutoHideRun }
  | { kind: 'keyPressed'; event: KeyboardEvent }
  | { kind: 'viewportChanged' }
  | { kind: 'hideDue'; folding: FoldingState };

type AutoHideMachine = MachineTypes<AutoHideState, AutoHideEvent>;

export type TopbarAutoHide = ReturnType<typeof createTopbarAutoHide>;

export const HIDE_DELAY_MS = 2000;

/**
 * Builds the bar's auto-hide. Until it starts, every method but `reveal`, `revealAndFocus` and the registrations does
 * nothing, and only `revealAndFocus` reads the page.
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

  /** Shows the bar and drops listening. */
  const stopAutoHide: HandlerOf<AutoHideMachine, 'unarmed' | 'up' | 'folding' | 'folded', 'stopped'> = (
    { run },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'stopped' });
    topbarState.setAutoHide(false);
    setVisible(true);
    run.stopListening();
  };
  /** Restarts the fold's wait of an armed bar that is up. */
  const rearm: HandlerOf<AutoHideMachine, 'up' | 'folding', 'armed'> = (state, _event, transition) => {
    if (!canArm()) {
      return;
    }
    scheduleFold(state.run, isContentShown(state), transition);
  };
  const askHide: HandlerOf<AutoHideMachine, 'up' | 'folding', 'hideAsked'> = (state, _event, transition) => {
    scheduleFold(state.run, isContentShown(state), transition);
  };
  const changeContent: HandlerOf<AutoHideMachine, 'up' | 'folding', 'contentChanged'> = (
    { run },
    { shown },
    transition,
  ) => {
    if (shown) {
      scheduleFold(run, true, transition);
      return;
    }
    showBar(run, false, transition);
  };
  /** Shows a bar that holds focus or an open surface, and restarts the wait for the fold of one that does not. */
  const followFocus: HandlerOf<AutoHideMachine, 'up' | 'folding' | 'folded', 'focusChanged'> = (
    state,
    { run },
    transition,
  ) => {
    // A check queued by an earlier start finds a run that is not its own.
    if (run !== null && run !== state.run) {
      return;
    }
    if (isBusy(state.run.page)) {
      showBar(state.run, isContentShown(state), transition);
      return;
    }
    refold(state, transition);
  };
  /** Folds the bar at once when a press or Tab moved focus into the product's frame. */
  const foldForApp: HandlerOf<AutoHideMachine, 'up' | 'folding', 'windowBlurred'> = (state, { run }, transition) => {
    if (run !== state.run) {
      return;
    }
    const frame = layout.getFrame();
    if (frame === null || run.page.activeElement() !== frame || !canFold(isContentShown(state))) {
      return;
    }
    if (isBusy(run.page)) {
      scheduleFold(run, true, transition);
      return;
    }
    fold(run, transition);
  };
  const pressKey: HandlerOf<AutoHideMachine, 'up' | 'folding' | 'folded', 'keyPressed'> = (
    state,
    { event },
    transition,
  ) => {
    if (!isRevealShortcut(event)) {
      return;
    }
    event.preventDefault();
    const { run } = state;
    switch (state.kind) {
      case 'folded':
        showBar(run, true, transition);
        focusBar(() => run.page);
        return;
      case 'up':
      case 'folding':
        // An open popover owns its own dismissal.
        if (!canFold(isContentShown(state)) || topbarSurfaces.isAnyOpen()) {
          return;
        }
        transition.emitState({ kind: 'folded', run });
        if (isTopbarFocused(run.page)) {
          releaseFocusToApp(run.page);
        }
        setVisible(false);
        return;
    }
  };
  const followViewport: HandlerOf<AutoHideMachine, 'up' | 'folding' | 'folded', 'viewportChanged'> = (
    state,
    _event,
    transition,
  ) => {
    if (isPhone()) {
      showBar(state.run, isContentShown(state), transition);
      return;
    }
    refold(state, transition);
  };
  const revealBar: HandlerOf<AutoHideMachine, 'folding' | 'folded', 'revealAsked'> = ({ run }, _event, transition) => {
    showBar(run, true, transition);
  };
  const revealAndFocusBar: HandlerOf<AutoHideMachine, 'up' | 'folding' | 'folded', 'revealFocusAsked'> = (
    state,
    _event,
    transition,
  ) => {
    showBar(state.run, isContentShown(state), transition);
    const { run } = state;
    focusBar(() => run.page);
  };
  /** Shows a bar that is not armed, since a reveal shows it even before the auto-hide starts. */
  const revealUnarmed: HandlerOf<AutoHideMachine, 'stopped' | 'unarmed', 'revealAsked'> = () => {
    setVisible(true);
  };
  const autoHide = createStateMachine<AutoHideMachine>({
    initial: { kind: 'stopped' },
    handlers: {
      stopped: {
        revealAsked: revealUnarmed,
        revealFocusAsked() {
          setVisible(true);
          // A stopped auto-hide holds no page, so the page is reached here.
          focusBar(getPage);
        },
        started(_state, _event, { emitState, update }) {
          const page = getPage();
          const listeners = new AbortController();
          const { signal } = listeners;
          const run: AutoHideRun = {
            page,
            stopListening: () => {
              listeners.abort();
            },
          };
          // Started before any listener is added, so a stop releases those added before one threw.
          emitState({ kind: 'unarmed', run, contentShown: false });
          const unlisten = productState.store.listen(() => {
            if (productState.store.get().status === 'error') {
              update({ kind: 'contentChanged', shown: false });
            }
          });
          signal.addEventListener('abort', unlisten);
          page.document.addEventListener(
            'focusin',
            () => {
              update({ kind: 'focusChanged', run: null });
            },
            { signal },
          );
          page.document.addEventListener(
            'focusout',
            () => {
              // activeElement only settles after focusout, so check on the next tick.
              timers.setTimeout(() => {
                update({ kind: 'focusChanged', run });
              }, 0);
            },
            { signal },
          );
          page.document.addEventListener(
            'keydown',
            event => {
              update({ kind: 'keyPressed', event });
            },
            { signal },
          );
          // A press or Tab into the cross-origin frame shows only as this window's blur. Checked on the next
          // tick, after popovers that close on blur have closed.
          page.window.addEventListener(
            'blur',
            () => {
              timers.setTimeout(() => {
                update({ kind: 'windowBlurred', run });
              }, 0);
            },
            { signal },
          );
          signal.addEventListener(
            'abort',
            watchPhone(() => {
              update({ kind: 'viewportChanged' });
            }),
          );
        },
      },
      unarmed: {
        stopped: stopAutoHide,
        armed(state, _event, transition) {
          if (!canArm()) {
            return;
          }
          scheduleFold(state.run, state.contentShown, transition);
          topbarState.setAutoHide(true);
        },
        contentChanged(state, { shown }, { emitState }) {
          emitState({ ...state, contentShown: shown });
        },
        revealAsked: revealUnarmed,
        revealFocusAsked({ run }) {
          setVisible(true);
          focusBar(() => run.page);
        },
        viewportChanged() {
          if (isPhone()) {
            setVisible(true);
          }
        },
      },
      up: {
        stopped: stopAutoHide,
        armed: rearm,
        contentChanged: changeContent,
        hideAsked: askHide,
        revealFocusAsked: revealAndFocusBar,
        focusChanged: followFocus,
        windowBlurred: foldForApp,
        keyPressed: pressKey,
        viewportChanged: followViewport,
      },
      folding: {
        stopped: stopAutoHide,
        armed: rearm,
        contentChanged: changeContent,
        hideAsked: askHide,
        revealAsked: revealBar,
        revealFocusAsked: revealAndFocusBar,
        focusChanged: followFocus,
        windowBlurred: foldForApp,
        keyPressed: pressKey,
        viewportChanged: followViewport,
        hideDue(state, { folding }, transition) {
          // A timer from a wait that was left or restarted folds nothing.
          if (folding !== state) {
            return;
          }
          if (isBusy(state.run.page)) {
            scheduleFold(state.run, true, transition);
            return;
          }
          fold(state.run, transition);
        },
      },
      folded: {
        stopped: stopAutoHide,
        contentChanged({ run }, { shown }, transition) {
          if (shown) {
            return;
          }
          showBar(run, false, transition);
        },
        revealAsked: revealBar,
        revealFocusAsked: revealAndFocusBar,
        focusChanged: followFocus,
        keyPressed: pressKey,
        viewportChanged: followViewport,
      },
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: autoHideTransitionMetric,
        message: '[dot.li] A topbar auto-hide transition threw',
      });
    },
  });

  return {
    /**
     * Listens for focus, keys, blur, the viewport and a failed product until the returned stop, which shows the bar.
     * A second start returns the same stop.
     */
    start,
    /**
     * Lets the bar fold. Safe to call repeatedly. A no-op on touch devices, which have no hover to
     * bring the bar back.
     */
    arm,
    /** Records whether product content shows. The bar folds only over it, never a loading screen or failure. */
    setContentShown,
    /** Folds the bar after a delay, unless it holds focus or an open surface by then. */
    scheduleHide,
    /** Shows the bar and cancels a pending fold. */
    reveal,
    /** Shows the bar and focuses its first control. */
    revealAndFocus,
    /** Registers the bar the auto-hide folds. Returns its release. Throws only as `watchPhone` does. */
    registerBar,
    /** Registers the reveal button, which holds the bar open while it has focus. Returns its release. */
    registerRevealButton,
  };

  function start(): () => void {
    autoHide.update({ kind: 'started' });
    return stop;
  }

  function stop(): void {
    autoHide.update({ kind: 'stopped' });
  }

  function arm(): void {
    autoHide.update({ kind: 'armed' });
  }

  function setContentShown(shown: boolean): void {
    autoHide.update({ kind: 'contentChanged', shown });
  }

  function scheduleHide(): void {
    autoHide.update({ kind: 'hideAsked' });
  }

  function reveal(): void {
    autoHide.update({ kind: 'revealAsked' });
  }

  function revealAndFocus(): void {
    autoHide.update({ kind: 'revealFocusAsked' });
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

  /** Bars that never fold keep the frame clear of them, rather than sitting over it for good. */
  function syncFrameLayout(): void {
    layout.setTopbarLayout({ offset: isPhone() || isMobile() });
  }

  function setVisible(next: boolean): void {
    // The hidden bar keeps its tab stops, since tabbing into it is what reveals it for keyboard users.
    topbarState.setVisible(next);
  }

  function canArm(): boolean {
    return !isMobile() && topbarState.get().present;
  }

  function canFold(contentShown: boolean): boolean {
    return contentShown && !isMobile() && !isPhone();
  }

  function isTopbarFocused(page: TopbarAutoHidePage): boolean {
    const active = page.activeElement();
    if (active === null) {
      return false;
    }
    return bar?.contains(active) === true || active === revealButton || topbarSurfaces.contains(active);
  }

  function isBusy(page: TopbarAutoHidePage): boolean {
    return isTopbarFocused(page) || topbarSurfaces.isAnyOpen();
  }

  /** Takes the page as a getter so it is read only when there is a bar to focus. */
  function focusBar(page: () => TopbarAutoHidePage): void {
    if (bar !== undefined) {
      page().focusFirst(bar);
    }
  }

  /** So focus never parks on an offscreen control. */
  function releaseFocusToApp(page: TopbarAutoHidePage): void {
    const frame = layout.getFrame();
    if (frame !== null) {
      frame.focus();
      return;
    }
    page.activeElement()?.blur();
  }

  /** Starts a new wait for the fold when the bar can fold, and keeps it up with no fold pending otherwise. */
  function scheduleFold(
    run: AutoHideRun,
    contentShown: boolean,
    { emitState, update }: Transition<AutoHideMachine>,
  ): void {
    if (!canFold(contentShown)) {
      emitState({ kind: 'up', run, contentShown });
      return;
    }
    const folding: FoldingState = { kind: 'folding', run };
    emitState(folding);
    timers.setTimeout(() => {
      update({ kind: 'hideDue', folding });
    }, HIDE_DELAY_MS);
  }

  /** Restarts the wait for the fold of a bar that is up. A folded bar stays folded. */
  function refold(state: ArmedState, transition: Transition<AutoHideMachine>): void {
    switch (state.kind) {
      case 'up':
      case 'folding':
        scheduleFold(state.run, isContentShown(state), transition);
        return;
      case 'folded':
        return;
    }
  }

  function fold(run: AutoHideRun, { emitState }: Transition<AutoHideMachine>): void {
    emitState({ kind: 'folded', run });
    setVisible(false);
  }

  function showBar(run: AutoHideRun, contentShown: boolean, { emitState }: Transition<AutoHideMachine>): void {
    emitState({ kind: 'up', run, contentShown });
    setVisible(true);
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

/** Whether the armed bar is over shown content. A wait or a fold only starts over it. */
function isContentShown(state: ArmedState): boolean {
  switch (state.kind) {
    case 'up':
      return state.contentShown;
    case 'folding':
    case 'folded':
      return true;
  }
}

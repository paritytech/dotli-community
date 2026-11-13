// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { createManualTimers, resetAllStoresForTests } from '@dotli/shared/testing';
import { productState } from './runtime/state/productState.js';
import { topbarState } from './state/topbarState.js';
import { topbarSurfaces } from './state/topbarSurfaces.js';
import { createTopbarAutoHide, HIDE_DELAY_MS, type TopbarAutoHide } from './createTopbarAutoHide.js';

/** An element of the page: where it sits, and focus moving to it. */
type FakeElement = {
  id: string;
  parent: FakeElement | null;
  contains: (other: unknown) => boolean;
  focus: () => void;
  blur: () => void;
};

/** A popover of the bar, open or not. */
type StandInSurface = {
  element: FakeElement;
  open: boolean;
};

type CreateAutoHideParams = {
  /** Watches the window for a phone width, the page's own stand-in unless given. */
  watchPhone?: (onChange: () => void) => () => void;
};

type LoadAutoHideParams = {
  /** Whether the product's content already shows. */
  contentShown?: boolean;
};

/** The page the bar runs on, shaped like the host page, torn down when the case ends. */
type AutoHidePage = {
  document: EventTarget;
  window: EventTarget;
  home: FakeElement;
  frame: FakeElement;
  /** Points focus at `element` without the page hearing it. */
  setActive: (element: FakeElement | null) => void;
  /** Returns the element that has focus. */
  getActive: () => FakeElement | null;
  /** Builds an element of the page under `parent`. */
  createElement: (id: string, parent?: FakeElement | null) => FakeElement;
  /** Builds the auto-hide as the shell state builds it on a page with the bar, not started and with no bar registered. */
  createAutoHide: (params?: CreateAutoHideParams) => TopbarAutoHide;
  /** Starts the auto-hide as the shell state starts it, with the bar registered. */
  loadAutoHide: (params?: LoadAutoHideParams) => TopbarAutoHide & { stop: () => void };
  /** Registers a stand-in surface, rendered outside the bar like a portal. */
  openSurface: (open: boolean) => StandInSurface;
  /** Moves focus to `element`, and the page hears it come in. */
  focusElement: (element: FakeElement) => void;
  /** Presses or tabs into the cross-origin frame: focus moves to it and this window blurs. */
  pressIntoApp: () => void;
  /** Turns the window into a phone width or back. */
  setPhone: (phone: boolean) => void;
  /** Rests the pointer on the bar, or takes it off. */
  setBarHovered: (hovered: boolean) => void;
  /** Moves the page's timers. */
  advance: (ms: number) => Promise<void>;
  /** Runs `dispose` when the case ends, before the stores reset. */
  addCleanup: (dispose: () => void) => void;
};

type Params = {
  /** A touch device. */
  mobile?: boolean;
  /** A phone-width window. */
  phone?: boolean;
};

describe('topbar auto-hide reveal', () => {
  it('As a keyboard user, I open the settings popover and the bar stays up while it is open', async () => {
    // Given
    const { loadAutoHide, openSurface, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    const settings = openSurface(true);
    await advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the popover closes, the bar hides again
    settings.open = false;
    await advance(HIDE_DELAY_MS - 1);

    // Then it is still up a millisecond short of the delay
    expect(isHidden()).toBe(false);

    // When
    await advance(1);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, I read the open chains popover and the bar stays up until it closes', async () => {
    // Given
    const { loadAutoHide, openSurface, createElement, focusElement, frame, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    const chains = openSurface(true);
    const row = createElement('chains-row', chains.element);

    // When focus sits inside it, outside #topbar
    focusElement(row);
    await advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When it closes and focus returns to the app, the bar hides again
    chains.open = false;
    focusElement(frame);
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, I focus the reveal button and the folded bar comes back and holds while it has focus', async () => {
    // Given
    const { loadAutoHide, createElement, focusElement, advance, addCleanup } = setupAutoHidePage();
    const { arm: armTopbarAutoHide, registerRevealButton } = loadAutoHide();
    const revealButton = createElement('topbar-reveal');
    addCleanup(registerRevealButton(toPageElement(revealButton)));
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS);
    const hiddenBefore = isHidden();

    // When
    focusElement(revealButton);
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(hiddenBefore).toBe(true);
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user, I press Alt+Shift+T under an open chains popover and the bar stays', () => {
    // Given the bar is up and the chains popover is open
    const { loadAutoHide, openSurface, document } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    openSurface(true);

    // When
    document.dispatchEvent(createShortcut());

    // Then the popover owns the moment, so the bar stays
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user typing in a host field outside the bar, I press Alt+Shift+T and the bar folds with focus left in the field', () => {
    // Given
    const { loadAutoHide, createElement, focusElement, getActive, document } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    const field = createElement('host-field');
    focusElement(field);

    // When
    document.dispatchEvent(createShortcut());

    // Then
    expect(isHidden()).toBe(true);
    expect(getActive()).toBe(field);
  });

  it('As a dotli integrator, I dispose the auto-hide with a focus check queued and the check does not outlive it', async () => {
    // Given a focusout has queued its next-tick focus check
    const { loadAutoHide, document, home, setActive, advance, addCleanup } = setupAutoHidePage();
    const autoHide = loadAutoHide();
    autoHide.arm();
    document.dispatchEvent(new Event('focusout'));

    // When the auto-hide is disposed and started again, focus sits in the bar as the next tick passes, then leaves it
    // unseen
    autoHide.stop();
    addCleanup(autoHide.start());
    autoHide.arm();
    autoHide.setContentShown(true);
    setActive(home);
    await advance(0);
    setActive(null);
    await advance(HIDE_DELAY_MS);

    // Then only the new hide timer ran, so the bar folds
    expect(isHidden()).toBe(true);
  });
});

describe('topbar auto-hide start and stop', () => {
  it('As a page that never started the auto-hide, I arm it over shown content and the bar never folds', async () => {
    // Given an auto-hide on a page with the bar, never started
    const { createAutoHide, advance } = setupAutoHidePage();
    const autoHide = createAutoHide();

    // When
    autoHide.arm();
    autoHide.setContentShown(true);
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(topbarState.get().autoHide).toBe(false);
  });

  it('As a page whose viewport watch fails, I start the auto-hide and the failure is reported while the bar still folds and stop brings it back', async () => {
    // Given an auto-hide whose viewport watch throws, with no bar registered
    const reports = recordReports({ onFinished: onTestFinished });
    const { createAutoHide, advance } = setupAutoHidePage();
    const autoHide = createAutoHide({
      watchPhone() {
        throw new Error('watch broke');
      },
    });

    // When
    const stop = autoHide.start();
    autoHide.arm();
    autoHide.setContentShown(true);
    await advance(HIDE_DELAY_MS);
    const hiddenWhileStarted = isHidden();
    stop();

    // Then
    expect(hiddenWhileStarted).toBe(true);
    expect(isHidden()).toBe(false);
    expect(topbarState.get().autoHide).toBe(false);
    expect(reports.exceptions.map(report => report.step)).toEqual(['transition']);
  });
});

describe('topbar auto-hide fold', () => {
  it('As a dApp user, I rest the pointer on the bar as it arms and it stays up until I leave it', async () => {
    // Given
    const { loadAutoHide, setBarHovered, advance } = setupAutoHidePage();
    const autoHide = loadAutoHide();
    setBarHovered(true);

    // When
    autoHide.arm();
    await advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the pointer leaves the bar
    setBarHovered(false);
    autoHide.scheduleHide();
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a dApp user, I let the bar fold into the capsule and focusing it brings it back', async () => {
    // Given
    const { loadAutoHide, focusElement, home, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);

    // When
    focusElement(home);
    await advance(300);

    // Then
    expect(isHidden()).toBe(false);
  });

  it("As a logged-out user, I let the bar fold and it folds into the capsule as anyone else's does", async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });
});

describe('topbar auto-hide over the product', () => {
  it("As a user on the loading screen, I wait for the app's content and the bar stays up until it shows and then folds", async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide, setContentShown: setProductContentShown } = loadAutoHide({ contentShown: false });
    armTopbarAutoHide();

    // When
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);

    // When
    setProductContentShown(true);
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a user whose app fails to load, I see the error page and the folded bar comes back and stays', async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS);
    const hiddenBefore = isHidden();

    // When
    productState.setError();
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(hiddenBefore).toBe(true);
    expect(isHidden()).toBe(false);
  });

  it('As a user whose app reports its own failure in the frame, I see it and the folded bar comes back and stays', async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide, setContentShown: setProductContentShown } = loadAutoHide();
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS);
    const hiddenBefore = isHidden();

    // When
    setProductContentShown(false);
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(hiddenBefore).toBe(true);
    expect(isHidden()).toBe(false);
  });
});

describe('topbar auto-hide on use of the app', () => {
  it('As a dApp user, I press into the app and the bar folds at once', async () => {
    // Given
    const { loadAutoHide, pressIntoApp, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    pressIntoApp();
    await advance(0);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a dApp user, I press into the app while a popover of the bar is open and the bar stays up until it closes', async () => {
    // Given
    const { loadAutoHide, openSurface, pressIntoApp, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    const settings = openSurface(true);

    // When
    pressIntoApp();
    await advance(0);

    // Then
    expect(isHidden()).toBe(false);

    // When
    settings.open = false;
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a user on the loading screen, I press into the frame and the bar stays up', async () => {
    // Given
    const { loadAutoHide, pressIntoApp, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide({ contentShown: false });
    armTopbarAutoHide();

    // When
    pressIntoApp();
    await advance(0);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a user, I switch to another window and the bar folds only after the usual delay', async () => {
    // Given
    const { loadAutoHide, window, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    window.dispatchEvent(new Event('blur'));
    await advance(0);

    // Then
    expect(isHidden()).toBe(false);

    // When
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });
});

describe('topbar auto-hide on a phone', () => {
  it('As a tablet user, I wait on a desktop-width page and the bar never folds', async () => {
    // Given: a touch device at a desktop width, where auto-hide never arms
    const { loadAutoHide, advance } = setupAutoHidePage({ mobile: true });
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a phone user, I wait and the bar never folds away', async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage({ phone: true });
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a user, I narrow the window to a phone width and the folded bar comes back as the phone bar, and widening folds it again', async () => {
    // Given
    const { loadAutoHide, setPhone, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    await advance(HIDE_DELAY_MS);
    const hiddenBefore = isHidden();

    // When
    setPhone(true);
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(hiddenBefore).toBe(true);
    expect(isHidden()).toBe(false);

    // When
    setPhone(false);
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a tablet user with a keyboard, I press Alt+Shift+T and it reaches the page, since the bar never folds', () => {
    // Given a touch device, where arming leaves auto-hide off
    const { loadAutoHide, document } = setupAutoHidePage({ mobile: true });
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    const press = createShortcut();

    // When
    document.dispatchEvent(press);

    // Then
    expect(press.defaultPrevented).toBe(false);
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user on a phone-width window, I press Alt+Shift+T and the header stays where it is', async () => {
    // Given
    const { loadAutoHide, document, advance } = setupAutoHidePage({ phone: true });
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    document.dispatchEvent(createShortcut());
    await advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(false);
  });
});

/** Builds the page the bar runs on, with fresh timers, and tears it down with the stores when the case ends. */
function setupAutoHidePage({ mobile = false, phone = false }: Params = {}): AutoHidePage {
  const timers = createManualTimers();
  const document = new EventTarget();
  const window = new EventTarget();
  const device = { mobile, phone };
  const phoneWatchers = new Set<() => void>();
  const elements = new Set<FakeElement>();
  const cleanups: (() => void)[] = [];
  let active: FakeElement | null = null;
  let barHovered = false;
  onTestFinished(() => {
    for (const dispose of cleanups.splice(0).reverse()) {
      dispose();
    }
    resetAllStoresForTests();
  });

  // Shaped like the host page.
  const bar = createElement('topbar');
  const home = createElement('topbar-home', bar);
  const app = createElement('app');
  const frame = createElement('app-frame', app);

  return {
    document,
    window,
    home,
    frame,
    setActive(element) {
      active = element;
    },
    getActive: () => active,
    createElement,
    createAutoHide,
    loadAutoHide,
    openSurface(open) {
      const stand: StandInSurface = { element: createElement('surface'), open };
      cleanups.push(topbarSurfaces.register({ element: () => toPageElement(stand.element), open: () => stand.open }));
      return stand;
    },
    focusElement,
    pressIntoApp() {
      frame.focus();
      window.dispatchEvent(new Event('blur'));
    },
    setPhone(next) {
      device.phone = next;
      for (const watcher of [...phoneWatchers]) {
        watcher();
      }
    },
    setBarHovered(hovered) {
      barHovered = hovered;
    },
    advance: ms => timers.advance(ms),
    addCleanup(dispose) {
      cleanups.push(dispose);
    },
  };

  function createElement(id: string, parent: FakeElement | null = null): FakeElement {
    const element: FakeElement = {
      id,
      parent,
      contains(other) {
        const start = [...elements].find(candidate => candidate === other) ?? null;
        for (let node = start; node !== null; node = node.parent) {
          if (node === element) {
            return true;
          }
        }
        return false;
      },
      focus() {
        active = element;
      },
      blur() {
        if (active === element) {
          active = null;
        }
      },
    };
    elements.add(element);
    return element;
  }

  function focusElement(element: FakeElement): void {
    element.focus();
    document.dispatchEvent(new Event('focusin'));
  }

  function createAutoHide({ watchPhone = watchPhoneWidth }: CreateAutoHideParams = {}): TopbarAutoHide {
    topbarState.setPresent();
    return createTopbarAutoHide({
      isMobile: () => device.mobile,
      isPhone: () => device.phone,
      watchPhone,
      layout: { getFrame: () => toFrameElement(frame) },
      page: () => ({
        document,
        window,
        activeElement: () => (active === null ? null : toPageElement(active)),
        focusFirst() {
          home.focus();
        },
        isHovered: element => barHovered && element === toPageElement(bar),
      }),
      timers,
    });
  }

  function watchPhoneWidth(listener: () => void): () => void {
    phoneWatchers.add(listener);
    return () => {
      phoneWatchers.delete(listener);
    };
  }

  function loadAutoHide({ contentShown = true }: LoadAutoHideParams = {}): TopbarAutoHide & { stop: () => void } {
    const autoHide = createAutoHide();
    const stop = autoHide.start();
    cleanups.push(stop);
    if (contentShown) {
      autoHide.setContentShown(true);
    }
    cleanups.push(autoHide.registerBar(toPageElement(bar)));
    return { ...autoHide, stop };
  }
}

function isHidden(): boolean {
  return !topbarState.get().visible;
}

function createShortcut(): Event {
  return Object.assign(new Event('keydown', { cancelable: true }), {
    code: 'KeyT',
    key: 'T',
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
  });
}

function toPageElement(element: FakeElement): HTMLElement {
  // The auto-hide only compares page elements, asks whether one contains another and moves focus.
  return element as unknown as HTMLElement;
}

function toFrameElement(element: FakeElement): HTMLIFrameElement {
  // The auto-hide only compares the frame with the focused element.
  return element as unknown as HTMLIFrameElement;
}

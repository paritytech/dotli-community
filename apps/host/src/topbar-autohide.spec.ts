// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { setProductError } from '@dotli/host-runtime';
import { getTopbarState, setTopbarPresent } from './state/topbar.js';
import { registerTopbarSurface } from './state/topbar-surfaces.js';
import { createTopbarAutoHide, type TopbarAutoHide } from './topbar-autohide.js';

const HIDE_DELAY_MS = 2500;

/** An element of the page: where it sits, and focus moving to it. */
interface FakeElement {
  id: string;
  parent: FakeElement | null;
  contains: (other: unknown) => boolean;
  focus: () => void;
  blur: () => void;
}

/** The page's focus and the events that move it. */
const page = { document: new EventTarget(), window: new EventTarget(), active: null as FakeElement | null };

function element(id: string, parent: FakeElement | null = null): FakeElement {
  const el: FakeElement = {
    id,
    parent,
    contains: other => {
      for (let node = other as FakeElement | null; node !== null; node = node.parent) {
        if (node === el) {
          return true;
        }
      }
      return false;
    },
    focus: () => {
      page.active = el;
    },
    blur: () => {
      if (page.active === el) {
        page.active = null;
      }
    },
  };
  return el;
}

// Shaped like the host page (apps/host/src/pages/index.astro).
const bar = element('topbar');
const home = element('topbar-home', bar);
const app = element('app');
const frame = element('app-frame', app);

function isHidden(): boolean {
  return !getTopbarState().visible;
}

/** Focus moves to `el`, and the page hears it come in. */
function focusElement(el: FakeElement): void {
  el.focus();
  page.document.dispatchEvent(new Event('focusin'));
}

function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

function shortcut(): Event {
  return Object.assign(new Event('keydown', { cancelable: true }), {
    code: 'KeyT',
    key: 'T',
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
  });
}

function pressShortcut(): void {
  page.document.dispatchEvent(shortcut());
}

/** A press or a Tab into the cross-origin frame: focus moves to it and this window blurs. */
function pressIntoApp(): void {
  frame.focus();
  page.window.dispatchEvent(new Event('blur'));
}

/** The device and window the bar runs on, which a test turns into a touch device or a phone. */
const device = { mobile: false, phone: false };
const phoneWatchers = new Set<() => void>();

function setPhone(phone: boolean): void {
  device.phone = phone;
  for (const watcher of [...phoneWatchers]) {
    watcher();
  }
}

/** Whether the frame layout keeps the app clear of the bar, as the auto-hide last asked. */
let offset: boolean | null = null;

/** A popover of the bar, as FloatingLayer registers it, open or not. */
interface StandInSurface {
  element: FakeElement;
  open: boolean;
}

const disposers: (() => void)[] = [];

/** Register a stand-in surface, rendered outside the bar like a portal. */
function surface(open = false): StandInSurface {
  const stand: StandInSurface = { element: element('surface'), open };
  disposers.push(
    registerTopbarSurface({ element: () => stand.element as unknown as HTMLElement, open: () => stand.open }),
  );
  return stand;
}

/** The page's auto-hide, started as the shell state starts it, with the bar registered. */
function loadAutoHide(contentShown = true): TopbarAutoHide & { stop: () => void } {
  setTopbarPresent();
  const autoHide = createTopbarAutoHide({
    isMobile: () => device.mobile,
    isPhone: () => device.phone,
    watchPhone: listener => {
      phoneWatchers.add(listener);
      return () => {
        phoneWatchers.delete(listener);
      };
    },
    layout: {
      setTopbarLayout: layout => {
        offset = layout.offset;
      },
      currentProductFrame: () => frame as unknown as HTMLIFrameElement,
    },
    page: () => ({
      document: page.document,
      window: page.window,
      activeElement: () => page.active as unknown as HTMLElement | null,
      focusFirst: () => {
        home.focus();
      },
    }),
  });
  const stop = autoHide.start();
  disposers.push(stop);
  if (contentShown) {
    autoHide.setContentShown(true);
  }
  disposers.push(autoHide.registerBar(bar as unknown as HTMLElement));
  return { ...autoHide, stop };
}

beforeEach(() => {
  device.mobile = false;
  device.phone = false;
  offset = null;
  page.active = null;
  vi.useFakeTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) {
    dispose();
  }
  resetAllStoresForTests();
  vi.useRealTimers();
});

describe('topbar auto-hide reveal', () => {
  it('As a user who just logged in, the bar arms from the session before the badge renders', () => {
    // Given: the account button renders no badge here; the session store
    // alone says the user is in.
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the bar stays up while its settings popover is open', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    const settings = surface(true);
    advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the popover closes, the bar hides again
    settings.open = false;
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the bar stays up while the shield explainer is open', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    const explainer = surface(true);
    advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When the explainer closes, the bar hides again
    explainer.open = false;
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the bar stays up while I read the open chains popover', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    const chains = surface(true);
    const row = element('chains-row', chains.element);

    // When focus sits inside it, outside #topbar
    focusElement(row);
    advance(HIDE_DELAY_MS * 3);

    // Then
    expect(isHidden()).toBe(false);

    // When it closes and focus returns to the app, the bar hides again
    chains.open = false;
    focusElement(frame);
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user, the reveal button brings the folded bar back and holds it while it has focus', () => {
    // Given
    const { arm: armTopbarAutoHide, registerRevealButton } = loadAutoHide();
    const revealButton = element('topbar-reveal');
    disposers.push(registerRevealButton(revealButton as unknown as HTMLElement));
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    focusElement(revealButton);
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user, Alt+Shift+T leaves the bar under an open chains popover', () => {
    // Given the bar is up and the chains popover is open
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    surface(true);

    // When
    pressShortcut();

    // Then the popover owns the moment, so the bar stays
    expect(isHidden()).toBe(false);
  });

  it('As a dotli integrator, disposing the auto-hide drops a queued focus check', () => {
    // Given a focusout has queued its next-tick focus check
    const { arm: armTopbarAutoHide, stop: disposeTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    // Armed: the hide timer is pending, alongside timers owned by other modules.
    const armedTimers = vi.getTimerCount();
    page.document.dispatchEvent(new Event('focusout'));
    expect(vi.getTimerCount()).toBe(armedTimers + 1);

    // When
    disposeTopbarAutoHide();

    // Then both the hide timer and the queued focus check are gone
    expect(vi.getTimerCount()).toBe(armedTimers - 1);
  });
});

describe('topbar auto-hide layout', () => {
  it('As a dApp user, once the bar folds into the capsule the app takes the full height and stays there when the pill comes back', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(offset).toBe(false);

    // When
    focusElement(home);
    advance(300);

    // Then: the pill floats over the app, which does not move
    expect(isHidden()).toBe(false);
    expect(offset).toBe(false);
  });

  it("As a logged-out user, the bar folds into the capsule as anyone else's does, over the full-height app", () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(offset).toBe(false);
  });

  it('As a dApp user, the app takes the full height under the pill before the bar first folds', () => {
    // Given: the bar is up and not armed yet (the shield still settling)
    loadAutoHide();

    // Then
    expect(isHidden()).toBe(false);
    expect(offset).toBe(false);
  });
});

describe('topbar auto-hide over the product', () => {
  it("As a user on the loading screen, the bar stays up until the app's content shows, then folds", () => {
    // Given
    const { arm: armTopbarAutoHide, setContentShown: setProductContentShown } = loadAutoHide(false);
    armTopbarAutoHide();

    // When
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);

    // When
    setProductContentShown(true);
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a user whose app fails to load, the folded bar comes back and stays over the error page', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    setProductError();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a user whose app reports its own failure in the frame, the folded bar comes back and stays', () => {
    // Given
    const { arm: armTopbarAutoHide, setContentShown: setProductContentShown } = loadAutoHide();
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    setProductContentShown(false);
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });
});

describe('topbar auto-hide on use of the app', () => {
  it('As a dApp user, pressing into the app folds the bar at once', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    pressIntoApp();
    advance(0);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a dApp user, pressing into the app while a popover of the bar is open leaves the bar up until it closes', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    const settings = surface(true);

    // When
    pressIntoApp();
    advance(0);

    // Then
    expect(isHidden()).toBe(false);

    // When
    settings.open = false;
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a user on the loading screen, pressing into the frame leaves the bar up', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide(false);
    armTopbarAutoHide();

    // When
    pressIntoApp();
    advance(0);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a user switching to another window, the bar folds only after the usual delay', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    page.window.dispatchEvent(new Event('blur'));
    advance(0);

    // Then
    expect(isHidden()).toBe(false);

    // When
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });
});

describe('topbar auto-hide on a phone', () => {
  it('As a tablet user, the bar never folds and the app starts below it, so the bar never covers the app', () => {
    // Given: a touch device at a desktop width, where auto-hide never arms
    device.mobile = true;
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(offset).toBe(true);
  });

  it('As a phone user, the bar never folds away, and the app keeps clear of it', () => {
    // Given
    device.phone = true;
    const { arm: armTopbarAutoHide } = loadAutoHide();

    // When
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(offset).toBe(true);
  });

  it('As a user narrowing the window to a phone width, the folded bar comes back as the phone bar, the app keeps clear of it, and widening folds it again', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);
    expect(offset).toBe(false);

    // When
    setPhone(true);
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
    expect(offset).toBe(true);

    // When
    setPhone(false);
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
    expect(offset).toBe(false);
  });

  it('As a tablet user with a keyboard, Alt+Shift+T reaches the page, since the bar never folds', () => {
    // Given a touch device, where arming leaves auto-hide off
    device.mobile = true;
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    const press = shortcut();
    page.document.dispatchEvent(press);

    // Then
    expect(press.defaultPrevented).toBe(false);
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user on a phone-width window, Alt+Shift+T leaves the header where it is', () => {
    // Given
    device.phone = true;
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();

    // When
    pressShortcut();
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(false);
  });
});

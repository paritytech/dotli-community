// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { getTopbarState, setTopbarPresent } from '../../src/state/topbar.js';
import {
  browserTopbarPage,
  createTopbarAutoHide,
  HIDE_DELAY_MS,
  type TopbarAutoHide,
} from '../../src/topbar-autohide.js';
import { byId } from '@dotli/ui/testing';

const SHORTCUT = { code: 'KeyT', altKey: true, shiftKey: true, bubbles: true };

// The focus and key wiring on a real page. The auto-hide's decisions are unit tested beside topbar-autohide.ts.

// Shaped like the host page (apps/host/src/pages/index.astro).
function installPageDom(): void {
  document.body.innerHTML = `
    <div id="topbar">
      <a id="topbar-home" href="/">Home</a>
      <div id="topbar-url" hidden></div>
      <div id="topbar-actions"><button id="auth-button">Login</button><button id="mode-button">Settings</button></div>
    </div>
    <div id="app">
      <iframe id="app-frame"></iframe>
    </div>
    <a id="toast" href="/">a toast that also lives after the app</a>
  `;
}

function appFrame(): HTMLIFrameElement {
  return byId('app-frame', HTMLIFrameElement);
}

function topbar(): HTMLElement {
  return byId('topbar');
}

function isHidden(): boolean {
  return !getTopbarState().visible;
}

/** happy-dom does not raise focusin from focus(), so drive it explicitly. */
function focusElement(el: HTMLElement): void {
  el.focus();
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  flush();
}

function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
  flush();
}

function pressShortcut(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', SHORTCUT));
  flush();
}

/** A desktop, where the bar auto-hides. */
const device = { mobile: false, phone: false };
const phoneWatchers = new Set<() => void>();

const disposers: (() => void)[] = [];

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
      setTopbarLayout: () => undefined,
      currentProductFrame: appFrame,
    },
    page: browserTopbarPage,
  });
  const stop = autoHide.start();
  disposers.push(stop);
  if (contentShown) {
    autoHide.setContentShown(true);
  }
  disposers.push(autoHide.registerBar(topbar()));
  flush();
  return { ...autoHide, stop };
}

beforeEach(() => {
  device.mobile = false;
  device.phone = false;
  vi.useFakeTimers();
  installPageDom();
});

afterEach(() => {
  // Before the body goes: the bar's popovers are portaled into it.
  for (const dispose of disposers.splice(0).reverse()) {
    dispose();
  }
  resetAllStoresForTests();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('topbar auto-hide on the page', () => {
  it('As a keyboard user, tabbing into the hidden bar brings it back', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    flush();
    advance(HIDE_DELAY_MS);
    expect(isHidden()).toBe(true);

    // When
    focusElement(byId('topbar-home'));

    // Then
    expect(isHidden()).toBe(false);

    // When focus stays in the bar, the hide timer must not fire
    advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user, leaving the bar re-arms the hide timer', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    flush();
    focusElement(byId('mode-button'));
    expect(isHidden()).toBe(false);

    // When
    focusElement(appFrame());
    advance(HIDE_DELAY_MS);

    // Then
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user typing in a host field before the bar arms, Alt+Shift+T reaches the field', () => {
    // Given a started auto-hide that has not armed, and focus in a host field
    loadAutoHide();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    // When
    const press = new KeyboardEvent('keydown', { ...SHORTCUT, cancelable: true });
    field.dispatchEvent(press);
    flush();

    // Then the key is left to the field, and the bar stays up
    expect(press.defaultPrevented).toBe(false);
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user, Alt+Shift+T toggles the bar and moves focus with it', () => {
    // Given
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    flush();
    advance(HIDE_DELAY_MS);

    // When
    pressShortcut();

    // Then
    expect(isHidden()).toBe(false);
    expect(document.activeElement?.id).toBe('topbar-home');

    // When
    pressShortcut();

    // Then focus must not stay parked on the offscreen bar
    expect(isHidden()).toBe(true);
    expect(topbar().contains(document.activeElement)).toBe(false);
  });
});

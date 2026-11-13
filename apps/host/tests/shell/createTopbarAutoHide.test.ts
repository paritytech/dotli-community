// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The focus and key wiring on a real page.

import { describe, expect, it, onTestFinished } from 'vitest';
import { flush } from 'solid-js';
import { createManualTimers, resetAllStoresForTests } from '@dotli/shared/testing';
import { topbarState } from '../../src/state/topbarState.js';
import {
  createTopbarAutoHide,
  getBrowserTopbarPage,
  HIDE_DELAY_MS,
  type TopbarAutoHide,
} from '../../src/createTopbarAutoHide.js';
import { byId } from '@dotli/ui/testing';

const SHORTCUT = { code: 'KeyT', altKey: true, shiftKey: true, bubbles: true };

describe('topbar auto-hide on the page', () => {
  it('As a keyboard user, I tab into the hidden bar and it comes back and stays while focus is in it', async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    flush();
    await advance(HIDE_DELAY_MS);
    const hiddenBefore = isHidden();

    // When
    focusElement(byId('topbar-home'));

    // Then
    expect(hiddenBefore).toBe(true);
    expect(isHidden()).toBe(false);

    // When focus stays in the bar, the hide timer must not fire
    await advance(HIDE_DELAY_MS * 2);

    // Then
    expect(isHidden()).toBe(false);
  });

  it('As a keyboard user, I leave the bar and its hide timer re-arms', async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    flush();
    focusElement(byId('mode-button'));
    const hiddenBefore = isHidden();

    // When
    focusElement(getAppFrame());
    await advance(HIDE_DELAY_MS);

    // Then
    expect(hiddenBefore).toBe(false);
    expect(isHidden()).toBe(true);
  });

  it('As a keyboard user typing in a host field before the bar arms, I press Alt+Shift+T and the key reaches the field', () => {
    // Given a started auto-hide that has not armed, and focus in a host field
    const { loadAutoHide } = setupAutoHidePage();
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

  it('As a keyboard user, I press Alt+Shift+T and the bar toggles with focus moving along', async () => {
    // Given
    const { loadAutoHide, advance } = setupAutoHidePage();
    const { arm: armTopbarAutoHide } = loadAutoHide();
    armTopbarAutoHide();
    flush();
    await advance(HIDE_DELAY_MS);

    // When
    pressShortcut();

    // Then
    expect(isHidden()).toBe(false);
    expect(document.activeElement?.id).toBe('topbar-home');

    // When
    pressShortcut();

    // Then focus must not stay parked on the offscreen bar
    expect(isHidden()).toBe(true);
    expect(getTopbar().contains(document.activeElement)).toBe(false);
  });
});

/** Lays out the host page on fresh timers, and tears down its bindings, the stores and the body when the case ends. */
function setupAutoHidePage() {
  const timers = createManualTimers();
  const disposers: (() => void)[] = [];
  installPageDom();
  onTestFinished(() => {
    // Before the body goes: the bar's popovers are portaled into it.
    for (const dispose of disposers.splice(0).reverse()) {
      dispose();
    }
    resetAllStoresForTests();
    document.body.replaceChildren();
  });
  return {
    /** Starts a desktop auto-hide with the content shown and the bar registered, and returns it. */
    loadAutoHide,
    /** Moves the page's timers, which only the case moves, and lets the bar react. */
    advance,
  };

  function loadAutoHide(): TopbarAutoHide {
    topbarState.setPresent();
    const autoHide = createTopbarAutoHide({
      isMobile: () => false,
      isPhone: () => false,
      watchPhone: () => () => undefined,
      layout: { getFrame: getAppFrame },
      page: getBrowserTopbarPage,
      timers,
    });
    disposers.push(autoHide.start());
    autoHide.setContentShown(true);
    disposers.push(autoHide.registerBar(getTopbar()));
    flush();
    return autoHide;
  }

  async function advance(ms: number): Promise<void> {
    await timers.advance(ms);
    flush();
  }
}

// Shaped like the host page.
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

function getAppFrame(): HTMLIFrameElement {
  return byId('app-frame', HTMLIFrameElement);
}

function getTopbar(): HTMLElement {
  return byId('topbar');
}

function isHidden(): boolean {
  return !topbarState.get().visible;
}

/** happy-dom does not raise focusin from focus(), so drive it explicitly. */
function focusElement(element: HTMLElement): void {
  element.focus();
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  flush();
}

function pressShortcut(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', SHORTCUT));
  flush();
}

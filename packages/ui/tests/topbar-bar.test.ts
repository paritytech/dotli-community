// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's top bar (apps/host/src/components/Topbar.astro) as its
// script drives it (src/topbar-bar.ts): the slide, the reveal shortcut, the
// landing page's mode and the offline banner. The auto-hide's timing and
// input are tests/topbar-autohide.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLandingPage, setTopbarAutoHide, setTopbarVisible } from '../src/state/topbar.js';
import { bindTopbar } from '../src/topbar-bar.js';
import { resetStores } from './helpers/solid.js';
import { byId } from './support.js';

// Topbar.astro's build-time render, the home link, the URL bar and the
// action group's island cut down to their elements.
const TOPBAR = `<div id="topbar" role="banner" aria-label="dot.li browser bar" style="transform: translateY(0); transition: transform 0.3s ease"><a class="topbar-left" id="topbar-home" href="/">Home</a><div class="topbar-url" id="topbar-url" hidden></div><astro-island><div class="topbar-right" id="topbar-actions"><button id="auth-button">Login</button></div></astro-island><div id="offline-banner" role="status" aria-live="polite" style="position: absolute; top: 100%; display: none">You are offline</div></div>`;

let online = true;
let unbind: () => void;

function bar(): HTMLElement {
  return byId('topbar');
}

function banner(): HTMLElement {
  return byId('offline-banner');
}

function setOnline(next: boolean): void {
  online = next;
  window.dispatchEvent(new Event(next ? 'online' : 'offline'));
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  stubReducedMotion(false);
  document.body.innerHTML = TOPBAR;
});

afterEach(() => {
  unbind();
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function bind(): void {
  unbind = bindTopbar(bar());
}

describe('Top bar', () => {
  it('As a user, the bar slides out and back, and carries the reveal shortcut while it auto-hides', () => {
    // Given
    bind();
    expect(bar().style.transform).toBe('translateY(0)');
    expect(bar().hasAttribute('aria-keyshortcuts')).toBe(false);

    // When
    setTopbarAutoHide(true);
    setTopbarVisible(false);

    // Then
    expect(bar().style.transform).toBe('translateY(-100%)');
    expect(bar().getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+T');

    // When
    setTopbarVisible(true);
    setTopbarAutoHide(false);

    // Then
    expect(bar().style.transform).toBe('translateY(0)');
    expect(bar().hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('As a user who asks for reduced motion, the bar does not animate its slide', () => {
    // Given
    stubReducedMotion(true);

    // When
    bind();

    // Then
    expect(bar().style.transition).toBe('none');
  });

  it('As a visitor on the landing page, the bar hides and its action group goes, its island unmounted', () => {
    // Given
    bind();
    const unmount = vi.fn();
    const island = document.querySelector('astro-island');
    island?.addEventListener('astro:unmount', unmount);

    // When
    setLandingPage();

    // Then
    expect(bar().hasAttribute('data-landing')).toBe(true);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(island?.isConnected).toBe(false);
    expect(document.getElementById('auth-button')).toBeNull();
    // The home link and the URL bar stay, hidden with the bar.
    expect(document.getElementById('topbar-home')).not.toBeNull();
    expect(document.getElementById('topbar-url')).not.toBeNull();
  });
});

describe('Offline banner', () => {
  it('As a user online, the banner stays hidden', () => {
    // When
    bind();

    // Then
    expect(banner().style.display).toBe('none');
  });

  it('As a user who is already offline when the page loads, I see it straight away', () => {
    // Given
    online = false;

    // When
    bind();

    // Then
    expect(banner().style.display).toBe('block');
  });

  it("As a user who loses the connection, I see the banner, and it goes away when I'm back", () => {
    // Given
    bind();

    // When
    setOnline(false);

    // Then
    expect(banner().style.display).toBe('block');

    // When
    setOnline(true);

    // Then
    expect(banner().style.display).toBe('none');
  });

  it('As a user offline, the banner hides with the topbar and shows again when the topbar comes back', () => {
    // Given
    bind();
    setOnline(false);

    // When
    setTopbarVisible(false);

    // Then
    expect(banner().style.display).toBe('none');

    // When
    setTopbarVisible(true);

    // Then
    expect(banner().style.display).toBe('block');
  });

  it('As the host, an unbound bar stops following the connection and the store', () => {
    // Given
    bind();

    // When
    unbind();
    setOnline(false);
    setTopbarVisible(false);

    // Then
    expect(banner().style.display).toBe('none');
    expect(bar().style.transform).toBe('translateY(0)');
  });
});

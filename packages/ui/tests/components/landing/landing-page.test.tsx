// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page island (components/landing/LandingPage.tsx), beside `#app`
// as the host page has it: it keeps the loading screen until the landing
// chunk arrives, then shows the page until an error page takes it down, and
// shows the reload error page if the chunk cannot load or the page throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppRootsModule from '../../../src/mount/app-roots.js';
import type * as UiModule from '../../../src/ui.js';
import type * as LoadingModule from '../../../src/state/loading.js';
import type * as TopbarModule from '../../../src/state/topbar.js';
import { must } from '../../support.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);
vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve(['alpha']),
  forgetRecentLabel: () => Promise.resolve(),
}));

const CHUNK = '../../../src/components/landing/Landing.js';

let roots: typeof AppRootsModule;
let ui: typeof UiModule;
let loading: typeof LoadingModule;
let topbar: typeof TopbarModule;
let unmount: (() => void) | undefined;

/**
 * Fresh modules, and the island rendered beside `#app`. The loading
 * controller loads too, over the static screen, as the host's startup bundle
 * loads it on every path: that is what makes the screen a root.
 */
async function mountIsland(): Promise<void> {
  const [solid, web, island] = await Promise.all([
    import('solid-js'),
    import('@solidjs/web'),
    import('../../../src/islands/LandingPage.js'),
  ]);
  [roots, ui, loading, topbar] = await Promise.all([
    import('../../../src/mount/app-roots.js'),
    import('../../../src/ui.js'),
    import('../../../src/state/loading.js'),
    import('../../../src/state/topbar.js'),
    import('../../../src/loading-controller.js'),
  ]);
  unmount = web.render(() => solid.createComponent(island.LandingPage, {}), must(byId('landing-slot'), 'slot'));
  solid.flush();
}

/** Hold the landing chunk back until the returned function is called. */
function gateChunk(): () => void {
  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  vi.doMock(CHUNK, async () => {
    await gate;
    return vi.importActual(CHUNK);
  });
  return release;
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** Let queued microtasks run, Solid's batched updates among them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** Show the landing page, as boot does on the bare host, and wait for it. */
async function showLanding(): Promise<void> {
  topbar.setLandingPage(true);
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="landing"], .error-page')).not.toBeNull();
  });
  await settle();
}

beforeEach(() => {
  vi.resetModules();
  sentry.captureException.mockReset();
  // Shaped like the host page (apps/host/src/pages/index.astro): the
  // loading screen and the island beside `#app`.
  document.body.innerHTML =
    '<div class="loading" id="app-loading"></div><div id="landing-slot"></div><div id="app"></div>';
});

afterEach(() => {
  roots.disposeAppRoots();
  unmount?.();
  unmount = undefined;
  vi.doUnmock(CHUNK);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('landing page island', () => {
  it('As a visitor on another page, it renders nothing', async () => {
    // When
    await mountIsland();
    await settle();

    // Then
    expect(must(byId('landing-slot'), 'slot').childElementCount).toBe(0);
    expect(loading.getLoadingState().phase).toBe('active');
  });

  it('As a visitor, the loading screen stays up until the landing page is ready, then the page replaces it', async () => {
    // Given
    const release = gateChunk();
    await mountIsland();

    // When
    topbar.setLandingPage(true);
    await settle();

    // Then: the topbar is in landing mode, and the screen stays while the
    // chunk downloads.
    expect(topbar.getTopbarState().landing).toBe(true);
    expect(loading.getLoadingState().phase).toBe('active');
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();

    // When
    release();
    await showLanding();

    // Then the loading screen is gone
    expect(loading.getLoadingState().phase).toBe('gone');
    expect(must(byId('landing-slot'), 'slot').firstElementChild?.getAttribute('data-testid')).toBe('landing');
    // The page renders its own auth and theme buttons, whose menus it
    // portals into the body, so every id is there once.
    expect(
      [...must(byId('landing-auth'), '#landing-auth').children].map(el => (el as HTMLElement).dataset['item']),
    ).toEqual(['auth', 'theme']);
    for (const id of ['landing-auth-button', 'landing-theme-toggle', 'landing-theme-popover', 'landing-user-popover']) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a visitor, the landing page shows once however often it is asked for', async () => {
    // Given
    await mountIsland();

    // When
    await showLanding();
    topbar.setLandingPage(true);
    await settle();

    // Then
    expect(document.querySelectorAll('[data-testid="landing"]')).toHaveLength(1);
  });

  it("As a visitor, the landing page renders beside the topbar's build-time buttons, with ids of its own", async () => {
    // Given: the topbar's action group as the build renders it, before it
    // hydrates.
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<header id="topbar"><button id="auth-button"></button><button id="theme-toggle"></button></header>',
    );
    await mountIsland();

    // When
    await showLanding();

    // Then
    expect(document.querySelector('[data-testid="landing"]')).not.toBeNull();
    for (const id of ['auth-button', 'theme-toggle', 'landing-auth-button', 'landing-theme-toggle']) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
  });

  it('As a visitor, an error page disposes the landing page, typing placeholder and all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The account popover's idle preload is not one of the page's timers.
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    try {
      // Given
      await mountIsland();
      await showLanding();
      expect(vi.getTimerCount()).toBe(1);

      // When
      ui.showErrorPage({ title: 'Failed' });
      await settle();

      // Then
      expect(document.querySelector('[data-testid="landing"]')).toBeNull();
      expect(topbar.getTopbarState().landing).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(document.querySelector('.error-page-title')?.textContent).toBe('Failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a visitor, when the landing page cannot load, I see an error page with a reload button, and it is reported once', async () => {
    // Given
    vi.doMock(CHUNK, () => {
      throw new Error('chunk failed');
    });
    await mountIsland();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    // When
    await showLanding();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { root: 'page' });
    expect(loading.getLoadingState().phase).toBe('gone');
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(document.querySelector('.error-page-title')?.textContent).toBe('Something went wrong on our side');
    expect(document.querySelector('.error-page-detail')?.textContent).toBe(
      "This page didn't load properly. Reloading usually fixes it.",
    );
    const button = byId('error-retry-btn') as HTMLButtonElement;
    expect(button.textContent).toBe('Reload');

    // When
    button.click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, when the landing page fails to render, I see an error page with a reload button, and it is reported once', async () => {
    // Given
    const failure = new Error('landing render failed');
    vi.doMock(CHUNK, () => ({
      Landing: () => {
        throw failure;
      },
    }));
    await mountIsland();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    // When
    await showLanding();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, { root: 'page' });
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(document.querySelectorAll('.error-page')).toHaveLength(1);

    // When
    (byId('error-retry-btn') as HTMLButtonElement).click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

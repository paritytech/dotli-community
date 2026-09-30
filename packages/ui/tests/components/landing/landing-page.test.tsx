// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page island (components/landing/LandingPage.tsx), beside `#app`
// as the host page has it: it keeps the loading screen until the landing
// chunk arrives, then shows the page as the "page" app root, and shows the
// error page if the chunk cannot load or the page throws.

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
    expect(document.querySelector('.landing, .error-page')).not.toBeNull();
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
    expect(document.querySelector('.landing')).toBeNull();

    // When
    release();
    await showLanding();

    // Then the loading screen is gone
    expect(loading.getLoadingState().phase).toBe('gone');
    expect(must(byId('landing-slot'), 'slot').firstElementChild?.className).toBe('landing');
    // The page renders its own auth and theme buttons, whose menus it
    // portals into the body, so every id is there once.
    expect(
      [...must(byId('landing-auth'), '#landing-auth').children].map(el => (el as HTMLElement).dataset['item']),
    ).toEqual(['auth', 'theme']);
    for (const id of ['auth-button', 'theme-toggle', 'theme-popover', 'user-popover']) {
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
    expect(document.querySelectorAll('.landing')).toHaveLength(1);
  });

  it('As a visitor, the landing page is the page app root, so whatever replaces the page disposes it', async () => {
    // Given
    await mountIsland();
    const remove = vi.spyOn(document, 'removeEventListener');
    await showLanding();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.landing-recent-item')).toHaveLength(1);
    });

    // When: what activateHost calls for the product frame.
    roots.disposeAppRoot('page');
    await settle();

    // Then
    expect(document.querySelector('.landing')).toBeNull();
    expect(topbar.getTopbarState().landing).toBe(false);
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function));
  });

  it('As a visitor, an error page disposes the landing page, typing placeholder and all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Given
      await mountIsland();
      await showLanding();
      expect(vi.getTimerCount()).toBe(1);

      // When
      ui.showErrorPage({ title: 'Failed' });
      await settle();

      // Then
      expect(document.querySelector('.landing')).toBeNull();
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
    expect(document.querySelector('.landing')).toBeNull();
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
    expect(document.querySelector('.landing')).toBeNull();
    expect(document.querySelectorAll('.error-page')).toHaveLength(1);

    // When
    (byId('error-retry-btn') as HTMLButtonElement).click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

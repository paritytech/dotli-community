// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing loader (landing/load.ts): it keeps the loading screen until the
// landing chunk arrives, then swaps the page in as the "page" app root, and
// shows the error page if the chunk cannot load.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LoadModule from '../../src/landing/load.js';
import type * as AppRootsModule from '../../src/mount/app-roots.js';
import type * as UiModule from '../../src/ui.js';
import type * as LoadingModule from '../../src/state/loading.js';
import type * as TopbarModule from '../../src/state/topbar.js';
import { must } from '../support.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../metrics/src/sentry.js', () => sentry);
vi.mock('../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve(['alpha']),
  forgetRecentLabel: () => Promise.resolve(),
}));

const CHUNK = '../../src/components/landing/mount.js';

type Loader = typeof LoadModule;
type AppRoots = typeof AppRootsModule;
type Ui = typeof UiModule;
type LoadingState = typeof LoadingModule;

let load: Loader;
let roots: AppRoots;
let ui: Ui;
let loading: LoadingState;
let topbar: typeof TopbarModule;

/**
 * Fresh modules, so each test gets its own memoized loader. The loading
 * controller loads too, over the static screen, as the host's startup
 * bundle loads it on every path: that is what makes the screen a root.
 */
async function importFresh(): Promise<void> {
  [load, roots, ui, loading, topbar] = await Promise.all([
    import('../../src/landing/load.js'),
    import('../../src/mount/app-roots.js'),
    import('../../src/ui.js'),
    import('../../src/state/loading.js'),
    import('../../src/state/topbar.js'),
    import('../../src/loading-controller.js'),
  ]);
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

function app(): HTMLElement {
  return must(byId('app'), '#app');
}

/** Let queued microtasks run, Solid's batched updates among them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  sentry.captureException.mockReset();
  // Shaped like the host page (apps/host/src/pages/index.astro): `#app`
  // holding the loading screen island. The topbar is an island that follows
  // the topbar store (tests/components/shell/topbar.test.tsx).
  document.body.innerHTML =
    '<div id="app"><astro-island component-export="LoadingScreen"><div class="loading" id="app-loading"></div></astro-island></div>';
});

afterEach(() => {
  roots.disposeAppRoots();
  vi.doUnmock(CHUNK);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('landing loader', () => {
  it('As a visitor, the loading screen stays up until the landing page is ready, then the page replaces it', async () => {
    // Given
    const release = gateChunk();
    await importFresh();

    // When
    const shown = load.showLanding();
    await settle();

    // Then: nothing changed while the chunk downloads.
    expect(loading.getLoadingState().phase).toBe('active');
    expect(byId('app-loading')).not.toBeNull();
    expect(byId('app-view')).toBeNull();
    expect(topbar.getTopbarState().landing).toBe(false);

    // When
    release();
    await shown;
    await settle();

    // Then the loading screen went, its island with it
    expect(byId('app-loading')).toBeNull();
    expect(document.querySelector('astro-island[component-export="LoadingScreen"]')).toBeNull();
    expect(loading.getLoadingState().phase).toBe('gone');
    // The topbar hides and its actions go (components/shell/Topbar.tsx).
    expect(topbar.getTopbarState().landing).toBe(true);
    expect([...app().children].map(el => el.id)).toEqual(['app-view']);
    const view = must(byId('app-view'), '#app-view');
    expect(view.firstElementChild?.className).toBe('landing');
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

  it('As a visitor, the landing page mounts once however often it is asked for', async () => {
    // Given
    await importFresh();

    // When
    const first = load.showLanding();
    const second = load.showLanding();
    await first;
    await load.showLanding();

    // Then
    expect(second).toBe(first);
    expect(document.querySelectorAll('.landing')).toHaveLength(1);
  });

  it('As a visitor, the landing page is the page app root, so whatever replaces the page disposes it', async () => {
    // Given
    await importFresh();
    const remove = vi.spyOn(document, 'removeEventListener');
    await load.showLanding();
    await settle();
    expect(document.querySelectorAll('.landing-recent-item')).toHaveLength(1);

    // When: what activateHost calls for the product frame.
    roots.disposeAppRoot('page');

    // Then
    expect(document.querySelector('.landing')).toBeNull();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function));
  });

  it('As a visitor, an error page disposes the landing page, typing placeholder and all', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await importFresh();
      await load.showLanding();
      await settle();
      expect(vi.getTimerCount()).toBe(1);

      // When
      ui.showErrorPage({ title: 'Failed' });

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
    await importFresh();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    // When
    await expect(load.showLanding()).resolves.toBeUndefined();
    await load.showLanding();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      kind: 'landing_load_error',
    });
    expect(byId('app-loading')).toBeNull();
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
    vi.doMock('../../src/components/landing/Landing.js', () => ({
      Landing: () => {
        throw failure;
      },
    }));
    await importFresh();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    // When
    await load.showLanding();
    await settle();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      root: 'page',
    });
    expect(document.querySelector('.landing')).toBeNull();
    expect(document.querySelector('.error-page-title')?.textContent).toBe('Something went wrong on our side');
    expect(document.querySelectorAll('.error-page')).toHaveLength(1);

    // When
    (byId('error-retry-btn') as HTMLButtonElement).click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../src/components/landing/Landing.js');
  });
});

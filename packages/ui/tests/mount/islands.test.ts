// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's island failures (mount/islands.ts): an island that fails to
// load or hydrate keeps its build-time markup, and what it would have done is
// stood in for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IslandsModule from '../../src/mount/islands.js';
import type * as LoadingModule from '../../src/state/loading.js';
import type * as TopbarModule from '../../src/state/topbar.js';
import type * as AppRootsModule from '../../src/mount/app-roots.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@dotli/metrics', async original => ({ ...(await original<Record<string, unknown>>()), ...sentry }));

let islands: typeof IslandsModule;
let loading: typeof LoadingModule;
let topbar: typeof TopbarModule;
let roots: typeof AppRootsModule;
/** Stops the test's reportIslandErrors listening. */
let stop: () => void;

/** An island of the page, as the build rendered it. */
function island(component: string): HTMLElement {
  const element = document.createElement('astro-island');
  element.setAttribute('component-export', component);
  element.innerHTML = `<div id="built-${component}">built</div>`;
  document.body.prepend(element);
  return element;
}

/** Astro's event for an island whose module or hydration failed. */
function fail(element: HTMLElement): void {
  element.dispatchEvent(
    new CustomEvent('astro:hydration-error', {
      bubbles: true,
      cancelable: true,
      detail: { error: new Error('chunk failed'), componentUrl: null },
    }),
  );
}

beforeEach(async () => {
  vi.resetModules();
  sentry.captureException.mockReset();
  document.body.innerHTML = '<div id="app"></div>';
  [islands, loading, topbar, roots] = await Promise.all([
    import('../../src/mount/islands.js'),
    import('../../src/state/loading.js'),
    import('../../src/state/topbar.js'),
    import('../../src/mount/app-roots.js'),
    import('../../src/loading-controller.js'),
  ]);
  stop = islands.reportIslandErrors();
});

afterEach(() => {
  stop();
  roots.disposeAppRoots();
  delete window.__dotliIslandErrors;
  document.body.innerHTML = '';
});

describe('island failures', () => {
  it('As the shell, a failed island is reported once, by name', () => {
    // When
    fail(island('ChatDock'));

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      kind: 'island_hydration_error',
      root: 'island:ChatDock',
    });
  });

  it('As a visitor, a loading screen that never hydrated goes when loading ends', () => {
    // Given
    const screen = island('LoadingScreen');
    fail(screen);
    expect(document.getElementById('built-LoadingScreen')).not.toBeNull();

    // When
    roots.disposeAppRoot('loading');

    // Then
    expect(loading.getLoadingState().phase).toBe('gone');
    expect(screen.childElementCount).toBe(0);
  });

  it('As a visitor on the bare host, a landing page that never hydrated shows the reload error page', () => {
    // Given
    fail(island('LandingPage'));
    expect(document.querySelector('[data-testid="error-page"]')).toBeNull();

    // When: boot says it is the landing page.
    topbar.setLandingPage(true);

    // Then
    expect(document.querySelector('[data-testid="error-page-title"]')?.textContent).toBe(
      'Something went wrong on our side',
    );
    expect(topbar.getTopbarState().landing).toBe(false);
    expect(loading.getLoadingState().phase).toBe('gone');
  });

  it('As a visitor on another page, a landing page that never hydrated changes nothing', () => {
    // When
    fail(island('LandingPage'));

    // Then
    expect(document.querySelector('[data-testid="error-page"]')).toBeNull();
    expect(loading.getLoadingState().phase).toBe('active');
  });

  it('As the shell, an island that failed before the host listened is reported and stood in for, and later ones as they happen', () => {
    // Given: the host page's inline script (pages/index.astro) kept a failure
    // from before boot.
    stop();
    const keep = (ev: Event): void => {
      window.__dotliIslandErrors?.push(ev);
    };
    window.__dotliIslandErrors = [];
    window.addEventListener('astro:hydration-error', keep);
    const screen = island('LoadingScreen');
    fail(screen);

    try {
      // When
      stop = islands.reportIslandErrors();

      // Then
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
        kind: 'island_hydration_error',
        root: 'island:LoadingScreen',
      });
      roots.disposeAppRoot('loading');
      expect(screen.childElementCount).toBe(0);

      // When
      fail(island('ChatDock'));

      // Then
      expect(sentry.captureException).toHaveBeenCalledTimes(2);
      expect(window.__dotliIslandErrors).toBeNull();
    } finally {
      window.removeEventListener('astro:hydration-error', keep);
    }
  });
});

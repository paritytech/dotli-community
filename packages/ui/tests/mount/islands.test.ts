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
/** The listeners each test's reportIslandErrors added, removed after it. */
let added: [string, EventListenerOrEventListenerObject][] = [];

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
  const add = vi.spyOn(document, 'addEventListener');
  islands.reportIslandErrors();
  added = add.mock.calls.map(([type, listener]) => [type, listener]);
  add.mockRestore();
});

afterEach(() => {
  roots.disposeAppRoots();
  for (const [type, listener] of added) {
    document.removeEventListener(type, listener);
  }
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
    expect(document.querySelector('.error-page')).toBeNull();

    // When: boot says it is the landing page.
    topbar.setLandingPage(true);

    // Then
    expect(document.querySelector('.error-page-title')?.textContent).toBe('Something went wrong on our side');
    expect(topbar.getTopbarState().landing).toBe(false);
    expect(loading.getLoadingState().phase).toBe('gone');
  });

  it('As a visitor on another page, a landing page that never hydrated changes nothing', () => {
    // When
    fail(island('LandingPage'));

    // Then
    expect(document.querySelector('.error-page')).toBeNull();
    expect(loading.getLoadingState().phase).toBe('active');
  });

  it('As a visitor, the landing page does not wait for an action group that never hydrated', () => {
    // When
    fail(island('TopbarActionsIsland'));

    // Then
    expect(topbar.getTopbarState().actionsLive).toBe(true);
  });
});

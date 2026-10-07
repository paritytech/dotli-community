// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page island, the page's root: an error page disposes it, and it shows the reload error page if it
// throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppRootsModule from '../../../src/mount/app-roots.js';
import type * as UiModule from '../../../src/ui.js';
import { byTestId, must } from '../../support.js';
import { stubIdleBrowser } from '../../helpers/idle.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);
vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve(['alpha']),
  forgetRecentLabel: () => Promise.resolve(),
}));

const LANDING = '../../../src/components/landing/Landing.js';

let roots: typeof AppRootsModule;
let ui: typeof UiModule;
let unmount: (() => void) | undefined;

/** Fresh modules and the island, settled as hydration leaves it. */
async function mountIsland(): Promise<void> {
  const [solid, web, island] = await Promise.all([
    import('solid-js'),
    import('@solidjs/web'),
    import('../../../src/islands/LandingPage.js'),
  ]);
  [roots, ui] = await Promise.all([import('../../../src/mount/app-roots.js'), import('../../../src/ui.js')]);
  unmount = web.render(() => solid.createComponent(island.LandingPage, {}), must(byId('landing-slot'), 'slot'));
  solid.flush();
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="landing"], [data-testid="error-page"]')).not.toBeNull();
  });
  await settle();
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  sentry.captureException.mockReset();
  // Shaped like the landing page (apps/host/src/pages/landing.astro), which has no `#app`.
  document.body.innerHTML = '<div id="landing-slot"></div>';
});

afterEach(() => {
  roots.disposeAppRoots();
  unmount?.();
  unmount = undefined;
  vi.doUnmock(LANDING);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('landing page island', () => {
  it('As a visitor, the landing page shows its own account button', async () => {
    // Given: an idle browser, whose preload puts the account surface in the page.
    stubIdleBrowser();

    // When
    await mountIsland();

    // Then
    expect(must(byId('landing-slot'), 'slot').firstElementChild?.getAttribute('data-testid')).toBe('landing');
    expect(
      [...must(byId('landing-auth'), '#landing-auth').children].map(el => (el as HTMLElement).dataset['item']),
    ).toEqual(['auth']);
    await vi.waitFor(() => must(byId('landing-user-popover'), '#landing-user-popover'));
    for (const id of ['landing-auth-button', 'landing-user-popover']) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a visitor, an error page takes over the landing page and disposes it, typing placeholder and all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The account popover's idle preload is not one of the page's timers.
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    try {
      // Given
      await mountIsland();
      expect(vi.getTimerCount()).toBe(1);

      // When
      ui.showErrorPage({ title: 'Failed' });
      await settle();

      // Then
      expect(document.querySelector('[data-testid="landing"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(byTestId('error-page-title').textContent).toBe('Failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a visitor, when the landing page fails to render, I see an error page with a reload button, and it is reported once', async () => {
    // Given
    const failure = new Error('landing render failed');
    vi.doMock(LANDING, () => ({
      Landing: () => {
        throw failure;
      },
    }));

    // When
    await mountIsland();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'page' },
    });
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="error-page"]')).toHaveLength(1);

    // When
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    (byId('error-retry-btn') as HTMLButtonElement).click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

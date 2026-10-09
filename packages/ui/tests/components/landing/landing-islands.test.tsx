// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's islands share the page root: an error page disposes all of them, and any one throwing shows the
// reload error page.

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

const NAV_FORM = '../../../src/components/landing/NavForm.js';
const SLOTS = { auth: 'landing-auth', nav: 'landing-nav-slot', recents: 'landing-recents-slot' } as const;

let roots: typeof AppRootsModule;
let ui: typeof UiModule;
let unmounts: (() => void)[] = [];

/** Fresh modules and the three islands, settled as hydration leaves them. */
async function mountIslands(): Promise<void> {
  const [solid, web, auth, nav, recents] = await Promise.all([
    import('solid-js'),
    import('@solidjs/web'),
    import('../../../src/islands/LandingAuth.js'),
    import('../../../src/islands/LandingNav.js'),
    import('../../../src/islands/LandingRecents.js'),
  ]);
  [roots, ui] = await Promise.all([import('../../../src/mount/app-roots.js'), import('../../../src/ui.js')]);
  const islands = [
    [auth.LandingAuth, SLOTS.auth],
    [nav.LandingNav, SLOTS.nav],
    [recents.LandingRecents, SLOTS.recents],
  ] as const;
  for (const [island, id] of islands) {
    // As in Astro, an island an error page already removed never hydrates.
    const container = byId(id);
    if (container !== null) {
      unmounts.push(web.render(() => solid.createComponent(island, {}), container));
    }
  }
  solid.flush();
  await vi.waitFor(() => {
    expect(document.querySelector('#dotli-nav-form, [data-testid="error-page"]')).not.toBeNull();
  });
  await settle();
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function slot(id: string): HTMLElement {
  return must(byId(id), `#${id}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  sentry.captureException.mockReset();
  // Shaped like the landing page (apps/host/src/components/Landing.astro), which has no `#app`.
  document.body.innerHTML = `<div data-testid="landing"><div id="${SLOTS.auth}"></div><div id="${SLOTS.nav}"></div><div id="${SLOTS.recents}"></div></div>`;
});

afterEach(() => {
  roots.disposeAppRoots();
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts = [];
  vi.doUnmock(NAV_FORM);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('landing page islands', () => {
  it('As a visitor, the landing page shows its own account button', async () => {
    // Given: an idle browser, whose preload puts the account surface in the page.
    stubIdleBrowser();

    // When
    await mountIslands();

    // Then
    expect([...slot(SLOTS.auth).children].map(el => (el as HTMLElement).dataset['item'])).toEqual(['auth']);
    await vi.waitFor(() => must(byId('landing-user-popover'), '#landing-user-popover'));
    for (const id of ['landing-auth-button', 'landing-user-popover']) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a visitor, an error page takes over the landing page and disposes every island, typing placeholder and all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The account popover's idle preload is not one of the page's timers.
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    try {
      // Given
      await mountIslands();
      expect(vi.getTimerCount()).toBe(1);
      expect(byId('landing-auth-button')).not.toBeNull();
      await vi.waitFor(() => must(document.querySelector('[data-testid="landing-recent-item"]'), 'recent item'));

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

  it('As a visitor, when one landing island fails to render, I see an error page with a reload button, and it is reported once', async () => {
    // Given
    const failure = new Error('landing render failed');
    vi.doMock(NAV_FORM, () => ({
      NavForm: () => {
        throw failure;
      },
    }));

    // When
    await mountIslands();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'page' },
    });
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(byId('landing-auth-button')).toBeNull();
    expect(document.querySelectorAll('[data-testid="error-page"]')).toHaveLength(1);

    // When
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    (byId('error-retry-btn') as HTMLButtonElement).click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

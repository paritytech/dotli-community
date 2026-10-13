// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's islands mounted in their slots: the page's document listener, the corner button, and what
// leaving takes with it. The controls are story plays beside NavForm and RecentList in ui-entities, and the static
// markup is Astro's, which the functional smoke test covers.

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { memorySharedChannel, type MemorySharedChannel } from '@dotli/host-runtime/testing';
import { setAuthState } from '@dotli/host-runtime';
import { createRecentLabels, type RecentLabels } from '../../src/recent-labels.js';
import { mountLandingPage } from '../helpers/landing.js';
import { appears, byId, query } from '@dotli/ui/testing';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

let page: ReturnType<typeof mountLandingPage> | null = null;
/** The cross-subdomain store the recents read and write. */
let shared: MemorySharedChannel;

function mount(recents: RecentLabels = createRecentLabels(shared)): ReturnType<typeof mountLandingPage> {
  page = mountLandingPage(recents);
  return page;
}

function visited(...labels: string[]): void {
  shared.store.set('dotli_recent', JSON.stringify(labels));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('location', {
    hostname: 'localhost',
    protocol: 'http:',
    port: '5173',
    href: 'http://localhost:5173/',
  });
  shared = memorySharedChannel();
  // A visitor not signed in, whose saved session has been read.
  setAuthState({ tag: 'Disconnected' });
  localStorage.clear();
  captures.exception.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  page?.dispose();
  page = null;
  document.body.innerHTML = '';
  resetAllStoresForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('landing page', () => {
  it("As a visitor, the page's document listener goes with it", async () => {
    // Given
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    visited('alpha');
    mount();
    await appears('[data-testid="landing-recent-item"]');
    const added = add.mock.calls.filter(([type]) => type === 'pointerdown');
    expect(added).toHaveLength(1);

    // When
    page?.dispose();
    page = null;

    // Then
    expect(remove).toHaveBeenCalledWith('pointerdown', added[0]?.[1]);
  });

  it("As a visitor, the auth button sits in the page's corner", async () => {
    // When
    mount();
    await appears('#landing-auth-button');

    // Then: the button in its item wrapper, always inline (there is no topbar to collapse it into). The page is always
    // dark, so it has no theme button.
    const corner = byId('landing-auth');
    expect([...corner.children].map(el => (el as HTMLElement).dataset['item'])).toEqual(['auth']);
    expect(query(corner, '[data-item="auth"] > #landing-auth-button', HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('landing-theme-toggle')).toBeNull();
    expect(corner.querySelector('[data-parked]')).toBeNull();
    expect(document.getElementById('more-button')).toBeNull();
    expect(document.querySelectorAll('[id="landing-auth-button"]')).toHaveLength(1);
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a visitor, leaving the landing page takes its corner button and its menu with it', async () => {
    // Given
    mount();
    await appears('#landing-auth-button');

    // When
    page?.dispose();
    page = null;
    flush();

    // Then
    for (const id of ['landing-auth-button', 'landing-user-popover']) {
      expect(document.getElementById(id)).toBeNull();
    }
  });
});

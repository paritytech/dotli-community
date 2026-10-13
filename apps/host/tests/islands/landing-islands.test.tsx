// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A full-page screen ends the landing page's islands together, and any one throwing shows the reload error page.

import { createComponent, flush } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { must, resetAllStoresForTests } from '@dotli/shared/testing';
import { memorySharedChannel } from '@dotli/host-runtime/testing';
import { clearScreen, showErrorPage } from '@dotli/ui-widgets';
import { LandingAuth } from '../../src/islands/LandingAuth.js';
import { LandingNav } from '../../src/islands/LandingNav.js';
import { LandingPart } from '../../src/islands/LandingPart.js';
import { LandingRecents } from '../../src/islands/LandingRecents.js';
import { createRecentLabels } from '../../src/recent-labels.js';
import { appears, byTestId } from '@dotli/ui/testing';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

const SLOTS = { auth: 'landing-auth', nav: 'landing-nav-slot', recents: 'landing-recents-slot' } as const;

let unmounts: (() => void)[] = [];

/**
 * The three islands, settled as hydration leaves them: the name form and the one recent name the shared store holds
 * shown, or the error page. `nav` takes the name form's place.
 */
async function mountIslands({ nav = LandingNav }: { nav?: () => JSX.Element } = {}): Promise<void> {
  const shared = memorySharedChannel({ dotli_recent: '["alpha"]' });
  const islands = [
    [LandingAuth, SLOTS.auth, {}],
    [nav, SLOTS.nav, {}],
    [LandingRecents, SLOTS.recents, { recents: createRecentLabels(shared) }],
  ] as const;
  for (const [island, id, props] of islands) {
    // As in Astro, an island an error page already removed never hydrates.
    const container = byId(id);
    if (container !== null) {
      unmounts.push(render(() => createComponent(island, props), container));
    }
  }
  flush();
  await appears('[data-testid="landing-recent-item"], [data-testid="error-page"]');
  flush();
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function slot(id: string): HTMLElement {
  return must(byId(id), `#${id}`);
}

beforeEach(() => {
  captures.exception.mockReset();
  // Shaped like the landing page (src/components/Landing.astro), which has no `#app`.
  document.body.innerHTML = `<div data-testid="landing"><div id="${SLOTS.auth}"></div><div id="${SLOTS.nav}"></div><div id="${SLOTS.recents}"></div></div>`;
});

afterEach(() => {
  clearScreen();
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts = [];
  resetAllStoresForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('landing page islands', () => {
  it('As a visitor, the landing page shows its own account button', async () => {
    // When
    await mountIslands();

    // Then
    expect([...slot(SLOTS.auth).children].map(el => (el as HTMLElement).dataset['item'])).toEqual(['auth']);
    expect(document.querySelectorAll('[id="landing-auth-button"]')).toHaveLength(1);
    expect(captures.exception).not.toHaveBeenCalled();
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

      // When
      showErrorPage({ title: 'Failed' });
      flush();

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
    const failingNav = (): JSX.Element =>
      LandingPart({
        get children(): JSX.Element {
          throw failure;
        },
      });

    // When
    await mountIslands({ nav: failingNav });
    await appears('[data-testid="error-page"]');

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
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

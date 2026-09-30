// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host's top bar (components/shell/Topbar.tsx): its slots, its landing
// page mode and what it renders from the topbar store. The auto-hide's
// timing and input are tests/topbar-autohide.test.ts.

import { cleanup } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topbar } from '../../../src/components/shell/Topbar.js';
import { setLandingPage, setTopbarAutoHide, setTopbarVisible } from '../../../src/state/topbar.js';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

/**
 * The slots as Astro hands them to the island: elements, here each holding
 * an island element as the client-only URL bar and account button do.
 */
function slot(name: string, island: string, content: string): HTMLElement {
  const el = document.createElement('astro-slot');
  el.setAttribute('name', name);
  el.innerHTML = `<astro-island component-export="${island}">${content}</astro-island>`;
  return el;
}

async function renderBar(): Promise<{ url: HTMLElement; account: HTMLElement }> {
  const url = slot('url', 'UrlPill', '<div class="topbar-url" id="topbar-url"></div>');
  const account = slot('account', 'AuthButton', '<button id="auth-button"></button>');
  const container = document.createElement('div');
  document.body.append(container);
  renderComponent(() => <Topbar url={url} account={account} />, { container });
  await settle();
  return { url, account };
}

beforeEach(() => {
  stubColorScheme('dark');
});

afterEach(() => {
  // Before the body goes: the popovers are portaled into it.
  cleanup();
  resetStores();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Topbar', () => {
  it('As a dotli user, the bar has the home link, the URL bar, then the account button before the action group', async () => {
    // When
    const { url, account } = await renderBar();

    // Then
    const bar = byId('topbar');
    expect(bar.getAttribute('role')).toBe('banner');
    expect(byId('topbar-home').getAttribute('href')).toBe('/');
    expect(url.parentElement).toBe(bar);
    const right = bar.querySelector('.topbar-right');
    expect(right?.firstElementChild).toBe(account);
    expect(right?.contains(byId('topbar-actions'))).toBe(true);
    expect(bar.lastElementChild?.id).toBe('offline-banner');
  });

  it('As a visitor on the landing page, the bar hides and its actions go, the account button island unmounted', async () => {
    // Given
    const { account } = await renderBar();
    const unmount = vi.fn();
    account.querySelector('astro-island')?.addEventListener('astro:unmount', unmount);

    // When
    setLandingPage();
    await settle();

    // Then
    const bar = byId('topbar');
    expect(bar.hasAttribute('data-landing')).toBe(true);
    expect(bar.querySelector('.topbar-right')).toBeNull();
    expect(document.getElementById('topbar-actions')).toBeNull();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(account.isConnected).toBe(false);
    // The home link and the URL bar stay, hidden with the bar.
    expect(document.getElementById('topbar-home')).not.toBeNull();
    expect(document.getElementById('topbar-url')).not.toBeNull();
  });

  it('As a user, the bar slides out and back, and carries the reveal shortcut while it auto-hides', async () => {
    // Given
    await renderBar();
    const bar = byId('topbar');
    expect(bar.style.transform).toBe('translateY(0)');
    expect(bar.hasAttribute('aria-keyshortcuts')).toBe(false);

    // When
    setTopbarAutoHide(true);
    setTopbarVisible(false);
    await settle();

    // Then
    expect(bar.style.transform).toBe('translateY(-100%)');
    expect(bar.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+T');

    // When
    setTopbarVisible(true);
    setTopbarAutoHide(false);
    await settle();

    // Then
    expect(bar.style.transform).toBe('translateY(0)');
    expect(bar.hasAttribute('aria-keyshortcuts')).toBe(false);
  });
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's action group (components/shell/TopbarActions.tsx), with its
// real items: what the More menu's rows open. The group's fitting is covered
// with stand-in items in action-group.test.tsx, and each item on its own in
// its own test.

import { cleanup } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopbarActions } from '../../../src/components/shell/TopbarActions.js';
import { resetAllStoresForTests } from '../../../src/state/create-store.js';
import { initSettingsStore } from '../../../src/state/settings.js';
import { registerPermissionAuthorizationProvider } from '../../../src/permissions.js';
import { setChainsButtonVisible } from '../../../src/topbar.js';
import { setProductLoaded } from '../../../src/state/product.js';
import { initNetworkHealth } from '../../../src/state/network-health.js';
import { setLandingPage } from '../../../src/state/topbar.js';
import { initChatPanelState } from '../../../src/state/chat-panel.js';
import { setLoggedIn } from '../../../src/state/auth.js';
import { CHAT_MESSAGE_EVENT } from '../../../src/chat/service.js';
import { labelToProductId } from '../../../src/runtime-config.js';
import { setChatCapability } from '@dotli/shared';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { pointerPress, renderComponent, settle, waitForContent } from '../../helpers/solid.js';
import { byId, byTestId, must } from '../../support.js';
import { ITEM_WIDTH, moreRow, stubTopbarLayout, tapMoreRow } from './topbar-harness.js';

vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

/** Room for the More button only: every item is in the More menu. */
const MORE_ONLY = ITEM_WIDTH;

/** The items in the More menu, in its order. */
function moreRowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#more-popover [role="menuitem"]')].map(
    el => el.dataset['item'] ?? '',
  );
}

async function renderIsland(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  renderComponent(() => <TopbarActions />, { container });
  await settle();
  await settle();
}

beforeEach(() => {
  stubColorScheme('dark');
  localStorage.clear();
});

afterEach(() => {
  // Before the body goes: the popovers are portaled into it.
  cleanup();
  resetAllStoresForTests();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Topbar actions island', () => {
  it("As a mobile user, the More menu's Permissions row opens the permissions popover, which shows the app's grants", async () => {
    // Given: an app with a grant.
    stubTopbarLayout(MORE_ONLY);
    const unregister = registerPermissionAuthorizationProvider('app.dot', {
      getPermissionAuthorizationStatuses: requests =>
        Promise.resolve(
          requests.map(request =>
            request.tag === 'Device' && request.value === 'Camera' ? 'Authorized' : 'NotDetermined',
          ),
        ),
      setPermissionAuthorizationStatus: async () => {},
    });
    setProductLoaded('app.dot', 'app.dot');

    try {
      await renderIsland();

      // Then
      expect(byId('permissions-button').hasAttribute('data-badge')).toBe(true);

      // When
      await tapMoreRow('permissions');
      await settle();
      await settle();

      // Then
      expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
      expect(byId('permissions-popover').hasAttribute('data-open')).toBe(true);
      expect(byId('permissions-popover-backdrop').hasAttribute('data-open')).toBe(true);
      expect(document.activeElement).toBe(byId('permissions-popover'));
      // The list is the popover's body, its own chunk.
      await waitForContent('permissions-popover');
      await settle();
      const camera = must(
        byId('permissions-popover-name-Camera').closest('[data-testid="permissions-popover-row"]'),
        'the Camera row',
      );
      expect(byTestId('permissions-popover-segment-granted', camera).getAttribute('aria-pressed')).toBe('true');
    } finally {
      unregister();
    }
  });

  it("As a mobile user, the More menu's Appearance and Settings rows open the Appearance menu and the settings popover", async () => {
    // Given
    initSettingsStore();
    stubTopbarLayout(MORE_ONLY);
    await renderIsland();

    // When
    await tapMoreRow('theme');

    // Then
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
    expect(byId('theme-popover').hasAttribute('data-open')).toBe(true);

    // When: the More button's tap is outside the theme menu, a modal menu,
    // so it only closes the menu: its click is swallowed.
    pointerPress(byId('more-button'));
    await settle();

    // Then
    expect(byId('theme-popover').hasAttribute('data-open')).toBe(false);
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);

    // When
    await tapMoreRow('settings');

    // Then
    expect(byId('theme-popover').hasAttribute('data-open')).toBe(false);
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
    expect(byId('mode-popover').hasAttribute('data-open')).toBe(true);
  });

  it("As a mobile user, once a product is on screen the More menu's Network row opens the network panel", async () => {
    // Given
    stubTopbarLayout(MORE_ONLY);
    await renderIsland();
    expect(document.querySelector('#more-popover [role="menuitem"][data-item="network"]')).toBeNull();

    // When
    setChainsButtonVisible(true);
    await settle();

    // Then
    expect(moreRow('network').querySelector('[data-testid="more-row-aside"]')?.textContent).toBe('Syncing');
    expect(moreRow('network').textContent).toBe('NetworkSyncing');

    // When
    await tapMoreRow('network');

    // Then
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
    expect(byId('more-button').getAttribute('aria-expanded')).toBe('false');
    expect(byId('chains-popover').hasAttribute('data-open')).toBe(true);
    expect(byId('chains-button').getAttribute('aria-expanded')).toBe('true');
  });

  it('As a mounted group, it is marked data-collapsible, so the CSS for its build-time render no longer applies', async () => {
    // Given
    stubTopbarLayout(6 * ITEM_WIDTH);

    // When
    await renderIsland();

    // Then
    expect(byId('topbar-actions').hasAttribute('data-collapsible')).toBe(true);
  });

  it("As a visitor on the landing page, the group renders nothing, so the page's own account and appearance buttons are the only ones", async () => {
    // Given
    stubTopbarLayout(6 * ITEM_WIDTH);
    await renderIsland();
    expect(document.getElementById('auth-button')).not.toBeNull();

    // When
    setLandingPage(true);
    await settle();

    // Then
    expect(document.getElementById('topbar-actions')).toBeNull();
    expect(document.getElementById('auth-button')).toBeNull();
    expect(document.getElementById('theme-toggle')).toBeNull();
  });

  it('As a phone user, the header keeps only More and then the account, however much room it measures: every action is in More', async () => {
    // Given: a phone, though the stand-in layout has room for every item
    stubTopbarLayout(6 * ITEM_WIDTH);
    stubPhoneViewport(true);

    // When
    await renderIsland();
    setChainsButtonVisible(true);
    await settle();

    // Then
    expect(moreRowNames()).toEqual(['network', 'permissions', 'theme', 'settings']);
    expect(byId('more-button').hasAttribute('data-idle')).toBe(false);
    const account = must(byId('auth-button').closest<HTMLElement>('[data-testid="topbar-item"]'), 'the account item');
    expect(account.hasAttribute('data-collapsed')).toBe(false);
    expect(byId('more-button').compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('As a phone user, the Network row leads the More menu with its status dot and verdict word, and More carries the health badge', async () => {
    // Given: the chains are still starting
    stubTopbarLayout(6 * ITEM_WIDTH);
    stubPhoneViewport(true);
    await renderIsland();
    setChainsButtonVisible(true);
    await settle();

    // Then
    const more = byId('more-button');
    expect(moreRowNames()[0]).toBe('network');
    expect(byTestId('more-row-aside', moreRow('network')).textContent).toBe('Syncing');
    expect(more.getAttribute('data-badge-tone')).toBe('idle');
    expect(more.getAttribute('aria-label')).toBe('More, network syncing');

    // When
    initNetworkHealth();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await settle();

    // Then
    expect(byTestId('more-row-aside', moreRow('network')).textContent).toBe('Offline');
    expect(more.getAttribute('data-badge-tone')).toBe('err');
    expect(more.getAttribute('aria-label')).toBe('More, network offline');
  });

  it('As a phone user with unread chat, I see More raise its badge and name the chat, and the Chat row show the unread count', async () => {
    // Given: a chat-capable product, a session, and two messages while the panel is closed
    stubTopbarLayout(6 * ITEM_WIDTH);
    stubPhoneViewport(true);
    const stopChat = initChatPanelState();
    try {
      await renderIsland();
      window.dispatchEvent(new CustomEvent('dotli:product-loaded', { detail: { label: 'chatty' } }));
      setChatCapability('chatty', true);
      setLoggedIn(true);

      // When
      for (const _ of [1, 2]) {
        window.dispatchEvent(
          new CustomEvent(CHAT_MESSAGE_EVENT, {
            detail: { productId: labelToProductId('chatty'), roomId: 'support', author: 'product' },
          }),
        );
      }
      await settle();

      // Then
      const more = byId('more-button');
      expect(moreRowNames()).toContain('chat');
      expect(more.hasAttribute('data-badge')).toBe(true);
      expect(more.getAttribute('data-badge-tone')).toBe('info');
      expect(more.getAttribute('aria-label')).toBe('More, chat has unread messages');
      expect(byTestId('more-row-aside', moreRow('chat')).textContent).toBe('2');
    } finally {
      stopChat();
    }
  });
});

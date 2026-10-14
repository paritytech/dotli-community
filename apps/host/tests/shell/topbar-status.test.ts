// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The room arithmetic is unit tested beside topbar-status.ts. These walk the real layout it measures, and the bar it
// binds to the page's state. Finding the row past the island's wrapper is the action group's, pinned by its
// `RowPastIslandWrapper` story.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncStore } from '@dotli/shared';
import { memoryStorage, resetAllStoresForTests, untilDom } from '@dotli/shared/testing';
import { createChatConnections, createChatStore } from '../../src/runtime/chat/store.js';
import { labelToProductId } from '../../src/runtime/runtime-config.js';
import { setAuthState } from '../../src/runtime/state/auth.js';
import { setProductLoaded } from '../../src/runtime/state/product.js';
import { memoryChatRepo } from '../../src/runtime/chat/store.fake.js';
import type { NetworkHealth } from '../../src/network-verdict.js';
import { startChatPanelState } from '../../src/state/chat-panel.js';
import { bindTopbarStatus, topbarActionRoom } from '../../src/topbar-status.js';
import { byId } from '@dotli/ui/testing';
import { stubPhoneViewport } from '../viewport.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('topbarActionRoom', () => {
  it("As the action group on a desktop, my room is the pill's max width less the rest of its row", () => {
    // Given: the group hydrated in a box-less island wrapper, whose row the group hands over
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url"></div><astro-island style="display: contents"><div id="group"></div></astro-island></div></header>`;
    const group = byId('group');
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 44));
    vi.spyOn(byId('row'), 'scrollWidth', 'get').mockReturnValue(600);

    // When
    const room = topbarActionRoom(group, byId('row'));

    // Then
    expect(room).toBe(300);
    document.body.replaceChildren();
  });

  it('As the action group on a phone, my room is my own width, as I fill the bar in place of the address', () => {
    // Given: a pill row with room to spare, on a phone-wide viewport
    stubPhoneViewport(true);
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url"></div><div id="group"></div></div></header>`;
    vi.spyOn(byId('group'), 'clientWidth', 'get').mockReturnValue(310);

    // When
    const room = topbarActionRoom(byId('group'), byId('row'));

    // Then
    expect(room).toBe(310);
    document.body.replaceChildren();
  });
});

describe('bindTopbarStatus', () => {
  it('As a user with unread chat, the bar leads with the action dot once the product posts', async () => {
    // Given a bound bar on a loaded chat product, logged in, with the panel closed
    document.body.innerHTML = '<header id="topbar"></header>';
    const bar = byId('topbar');
    const chat = createChatStore({ repo: memoryChatRepo(), connections: createChatConnections() });
    const local = memoryStorage();
    const stopChat = startChatPanelState(chat, local);
    const product = labelToProductId('chatty');
    setProductLoaded('chatty', product, { chat: true });
    setAuthState({ tag: 'Connected', session: { connected: true } });
    const unbind = bindTopbarStatus(bar, createSyncStore<NetworkHealth>('test_health', 'ok'));
    expect(bar.hasAttribute('data-action')).toBe(false);

    // When
    await chat.postProductMessage(product, 'main', { tag: 'Text', value: { text: 'hi' } });

    // Then
    await untilDom(() => bar.hasAttribute('data-action'));
    expect(bar.hasAttribute('data-action')).toBe(true);
    unbind();
    stopChat();
    resetAllStoresForTests();
    document.body.replaceChildren();
  });
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The room arithmetic is unit tested beside topbarStatus.ts, and finding the row past the island's wrapper is pinned
// by the action group's `RowPastIslandWrapper` story. This is the bar it binds to the page's state.

import { describe, expect, it } from 'vitest';
import { createSyncStore } from '@dotli/shared';
import { createMemoryStorage, resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { createChatConnections } from '../../src/runtime/chat/createChatConnections.js';
import { createChatStore } from '../../src/runtime/chat/createChatStore.js';
import { toProductId } from '../../src/runtime/createTruapiRuntimeConfig.js';
import { authState } from '../../src/runtime/state/authState.js';
import { productState } from '../../src/runtime/state/productState.js';
import { createMemoryChatRepo } from '../../src/runtime/chat/createChatStore.fake.js';
import type { NetworkHealth } from '../../src/networkVerdict.js';
import { startChatPanelState } from '../../src/state/chatPanel.js';
import { bindTopbarStatus } from '../../src/topbarStatus.js';
import { byId } from '@dotli/ui/testing';

describe('bindTopbarStatus', () => {
  it('As a user with unread chat, the bar leads with the action dot once the product posts', async () => {
    // Given a bound bar on a loaded chat product, logged in, with the panel closed
    document.body.innerHTML = '<header id="topbar"></header>';
    const bar = byId('topbar');
    const chat = createChatStore({ repo: createMemoryChatRepo(), connections: createChatConnections() });
    const local = createMemoryStorage();
    const stopChat = startChatPanelState(chat, local);
    const product = toProductId('chatty');
    productState.setLoaded({ label: 'chatty', productId: product, details: { chat: true } });
    authState.set({ tag: 'Connected', session: { connected: true } });
    const unbind = bindTopbarStatus(bar, createSyncStore<NetworkHealth>({ name: 'test_health', initial: 'ok' }));
    expect(bar.hasAttribute('data-action')).toBe(false);

    // When
    await chat.postProductMessage({
      productId: product,
      roomId: 'main',
      content: { tag: 'Text', value: { text: 'hi' } },
    });

    // Then
    await waitForDom(() => bar.hasAttribute('data-action'));
    expect(bar.hasAttribute('data-action')).toBe(true);
    unbind();
    stopChat();
    resetAllStoresForTests();
    document.body.replaceChildren();
  });
});

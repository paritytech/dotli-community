// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The room arithmetic is unit tested beside topbar-status.ts, and finding the row past the island's wrapper is pinned
// by the action group's `RowPastIslandWrapper` story. This is the bar it binds to the page's state.

import { describe, expect, it } from 'vitest';
import { createSyncStore } from '@dotli/shared';
import { memoryStorage, resetAllStoresForTests, untilDom } from '@dotli/shared/testing';
import { createChatConnections, createChatStore } from '../../src/runtime/chat/store.js';
import { labelToProductId } from '../../src/runtime/runtime-config.js';
import { setAuthState } from '../../src/runtime/state/auth.js';
import { setProductLoaded } from '../../src/runtime/state/product.js';
import { memoryChatRepo } from '../../src/runtime/chat/store.fake.js';
import type { NetworkHealth } from '../../src/network-verdict.js';
import { startChatPanelState } from '../../src/state/chat-panel.js';
import { bindTopbarStatus } from '../../src/topbar-status.js';
import { byId } from '@dotli/ui/testing';

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

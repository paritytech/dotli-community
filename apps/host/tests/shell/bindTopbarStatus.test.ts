// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's status bound to the page's chat, sign-in and product state.

import { describe, expect, it, onTestFinished } from 'vitest';
import { atom } from 'nanostores';
import { createMemoryStorage, resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { createChatConnections } from '../../src/runtime/chat/createChatConnections.js';
import { createChatStore } from '../../src/runtime/chat/createChatStore.js';
import { toProductId } from '../../src/runtime/createTruapiRuntimeConfig.js';
import { authState } from '../../src/runtime/state/authState.js';
import { productState } from '../../src/runtime/state/productState.js';
import { createMemoryChatRepo } from '../../src/runtime/chat/createChatStore.fake.js';
import type { NetworkHealth } from '../../src/networkVerdict.js';
import { chatPanelState } from '../../src/state/chatPanelState.js';
import { topbarState } from '../../src/state/topbarState.js';
import { bindTopbarStatus } from '../../src/bindTopbarStatus.js';
import { byId } from '@dotli/ui/testing';

describe('bindTopbarStatus', () => {
  it('As a signed-in user with the chat panel closed, I get a product message and the bar leads with the action dot', async () => {
    // Given a bound bar on a loaded chat product, logged in, with the panel closed
    document.body.innerHTML = '<header id="topbar"></header>';
    const bar = byId('topbar');
    const chat = createChatStore({ repo: createMemoryChatRepo(), connections: createChatConnections() });
    const stopChat = chatPanelState.start({ chat, storage: createMemoryStorage() });
    const product = toProductId('chatty');
    productState.setLoaded({ label: 'chatty', productId: product, details: { chat: true } });
    authState.set({ tag: 'Connected', session: { connected: true } });
    const unbind = bindTopbarStatus(bar, atom<NetworkHealth>('ok'));
    onTestFinished(() => {
      unbind();
      stopChat();
      resetAllStoresForTests();
      document.body.replaceChildren();
    });
    const ledBefore = bar.hasAttribute('data-action');

    // When
    await chat.postProductMessage({
      productId: product,
      roomId: 'main',
      content: { tag: 'Text', value: { text: 'hi' } },
    });
    await waitForDom(() => bar.hasAttribute('data-action'));

    // Then
    expect(ledBefore).toBe(false);
    expect(bar.hasAttribute('data-action')).toBe(true);
  });

  it('As a user with a blocking prompt waiting, I see the bar lead with the action dot', async () => {
    // Given a bound bar with nothing waiting
    document.body.innerHTML = '<header id="topbar"></header>';
    const bar = byId('topbar');
    const unbind = bindTopbarStatus(bar, atom<NetworkHealth>('ok'));
    onTestFinished(() => {
      unbind();
      resetAllStoresForTests();
      document.body.replaceChildren();
    });
    const ledBefore = bar.hasAttribute('data-action');

    // When
    topbarState.reportBlockingModals({ waiting: 1, active: true });
    await waitForDom(() => bar.hasAttribute('data-action'));

    // Then
    expect(ledBefore).toBe(false);
    expect(bar.hasAttribute('data-action')).toBe(true);
  });
});

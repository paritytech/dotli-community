// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { asProductId } from '@parity/truapi';
import { createMemoryStorage, resetAllStoresForTests } from '@dotli/shared/testing';
import { createChatConnections } from './runtime/chat/createChatConnections.js';
import { createChatStore } from './runtime/chat/createChatStore.js';
import { createMemoryChatRepo } from './runtime/chat/createChatStore.fake.js';
import { toProductId } from './runtime/getAskedProductId.js';
import { authState } from './runtime/state/authState.js';
import { productState } from './runtime/state/productState.js';
import { chatPanelState } from './state/chatPanelState.js';
import { pageActionNeeded } from './pageActionNeeded.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('pageActionNeeded', () => {
  it('As a user with the chat panel closed, I get a product message and the capsule leads with the action dot', async () => {
    // Given a loaded chat product, logged in, with the panel closed
    const chat = createChatStore({ repo: createMemoryChatRepo(), connections: createChatConnections() });
    onTestFinished(chatPanelState.start({ chat, storage: createMemoryStorage() }));
    const product = asProductId(toProductId('chatty'));
    productState.setLoaded({ label: 'chatty', productId: product, details: { chat: true } });
    authState.set({ tag: 'Connected', session: { connected: true } });

    // When the product posts
    const before = pageActionNeeded.get();
    await chat.postProductMessage({
      productId: product,
      roomId: 'main',
      content: { tag: 'Text', value: { text: 'hi' } },
    });
    const after = pageActionNeeded.get();

    // Then
    expect({ before, after }).toEqual({ before: false, after: true });
  });
});

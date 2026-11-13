// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ChatDock island against the page's real chat state: the panel element the dock hands over, which a chat button
// needs to take focus back, the topbar it follows and the chat it reads. A missing binding would fail silently, so
// these pin the wiring. The views are tested by the chat story plays.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asProductId } from '@parity/truapi';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { createMemoryStorage, resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { createChatConnections } from '../../src/runtime/chat/createChatConnections.js';
import { createChatStore, type ChatStore } from '../../src/runtime/chat/createChatStore.js';
import { toProductId } from '../../src/runtime/getAskedProductId.js';
import { authState } from '../../src/runtime/state/authState.js';
import { productState } from '../../src/runtime/state/productState.js';
import { createMemoryChatRepo } from '../../src/runtime/chat/createChatStore.fake.js';
import { topbarState } from '../../src/state/topbarState.js';
import { ChatDock } from '../../src/islands/ChatDock.js';
import { chatPanelState } from '../../src/state/chatPanelState.js';
import { appears, byId, byTestId } from '@dotli/ui/testing';

const LABEL = 'chatty';
const PRODUCT = asProductId(toProductId(LABEL));

let chat: ChatStore;
let stopState: () => void = () => undefined;
let unmount: (() => void) | undefined;

/** The dock as Astro hydrates it, on a loaded chat-capable product with a session. */
function mountIsland(): void {
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(() => <ChatDock chat={chat} />, slot);
  flush();
}

beforeEach(() => {
  chat = createChatStore({ repo: createMemoryChatRepo(), connections: createChatConnections() });
  const local = createMemoryStorage();
  stopState = chatPanelState.start({ chat: () => Promise.resolve(chat), storage: local });
  productState.setLoaded({ label: LABEL, productId: PRODUCT, details: { chat: true } });
  authState.set({ tag: 'Connected', session: { connected: true } });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  stopState();
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('ChatDock island', () => {
  it("As a user, the open panel lists the product's rooms from the page's chat", async () => {
    // Given
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    mountIsland();

    // When
    chatPanelState.setOpen(true);

    // Then
    await waitForDom(() => document.querySelector('[data-testid="chat-room-name"]')?.textContent === 'Main');
    expect(byId('chat-panel').hidden).toBe(false);
    expect(byTestId('chat-room-name').textContent).toBe('Main');
  });

  it('As a user, Escape in the panel closes it on the page', async () => {
    // Given
    mountIsland();

    // Then the dock handed its panel to the page, so the button can tell whether focus was inside
    expect(chatPanelState.getElement()).toBe(byId('chat-panel'));

    // When
    chatPanelState.setOpen(true);
    await appears('#chat-panel-close');
    byId('chat-panel-close').focus();
    byId('chat-panel-close').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Then
    await waitForDom(() => byId('chat-panel').hidden === true);
    expect(chatPanelState.store.get().open).toBe(false);
  });

  it('As a user, the panel stretches to the top while the topbar hides', async () => {
    // Given
    mountIsland();

    // When
    topbarState.setVisible(false);

    // Then
    await waitForDom(() => byId('chat-panel').hasAttribute('data-topbar-hidden'));

    // When
    topbarState.setVisible(true);

    // Then
    await waitForDom(() => !byId('chat-panel').hasAttribute('data-topbar-hidden'));
  });
});

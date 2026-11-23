// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ChatDock island against the page's real chat state: the panel element the dock hands over, which a chat button
// needs to take focus back, the close it reports and the chat it reads. A missing binding would fail silently, so
// these pin the wiring. The views are tested by the chat story plays.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asProductId } from '@parity/truapi';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { createChatConnections } from '../../createChatConnections.js';
import { createChatStore, type ChatStore } from '../../createChatStore.js';
import { toProductId } from '../../../../kit/getAskedProductId.js';
import { authState } from '../../../account/session/authState.js';
import { productState } from '../../../page/productState.js';
import { createMemoryChatRepo } from '../../createChatStore.fake.js';
import { ChatDockIsland } from '../../ChatDockIsland.js';
import { chatPanelState } from '../../chatPanelState.js';
import { byId, byTestId } from '@dotli/ui/testing';

const LABEL = 'chatty';
const PRODUCT = asProductId(toProductId(LABEL));

let chat: ChatStore;
let stopState: () => void = () => undefined;
let unmount: (() => void) | undefined;

/** The dock as Astro hydrates it, on a loaded chat-capable product with one room and a session. */
function mountIsland(): void {
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(() => <ChatDockIsland chat={chat} />, slot);
  flush();
}

beforeEach(async () => {
  chat = createChatStore({ repo: createMemoryChatRepo(), connections: createChatConnections() });
  stopState = chatPanelState.start({ chat: () => Promise.resolve(chat) });
  productState.setLoaded({ label: LABEL, productId: PRODUCT, details: { chat: true } });
  authState.set({ tag: 'Connected', session: { connected: true } });
  await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  stopState();
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('ChatDock island', () => {
  it("As a user of a product with one room, the open panel shows that room from the page's chat as open", async () => {
    // Given
    mountIsland();

    // When
    chatPanelState.setOpen(true);

    // Then
    await waitForDom(() => document.getElementById('chat-panel-title')?.textContent === 'Main');
    expect(byId('chat-panel').hasAttribute('data-open')).toBe(true);
    expect(chatPanelState.store.get().activeRoomId).toBe('main');
  });

  it('As a user, Escape in the panel closes it on the page', async () => {
    // Given
    mountIsland();

    // Then the dock handed its panel to the page, so the button can tell whether focus was inside
    expect(chatPanelState.getElement()).toBe(byId('chat-panel'));

    // When
    chatPanelState.setOpen(true);
    await waitForDom(() => byId('chat-panel').hasAttribute('data-open'));
    byTestId('chat-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Then
    await waitForDom(() => !byId('chat-panel').hasAttribute('data-open'));
    expect(chatPanelState.store.get().open).toBe(false);
  });
});

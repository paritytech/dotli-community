// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ChatDock island against the page's real chat state: the panel element the dock hands over, which a chat button
// needs to take focus back, the topbar it follows and the chat it reads. A missing binding would fail silently, so
// these pin the wiring. The views are tested by the chat story plays.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { memoryStorage, resetAllStoresForTests, untilDom } from '@dotli/shared/testing';
import { createChatConnections, createChatStore, type ChatStore } from '../../src/runtime/chat/store.js';
import { labelToProductId } from '../../src/runtime/runtime-config.js';
import { setAuthState } from '../../src/runtime/state/auth.js';
import { setProductLoaded } from '../../src/runtime/state/product.js';
import { memoryChatRepo } from '../../src/runtime/chat/store.fake.js';
import { setTopbarVisible } from '../../src/state/topbar.js';
import { ChatDock } from '../../src/islands/ChatDock.js';
import {
  chatPanelStore,
  getChatPanelElement,
  initChatPanelState,
  resetChatPanelStateForTests,
  setChatPanelOpen,
} from '../../src/state/chat-panel.js';
import { appears, byId, byTestId } from '@dotli/ui/testing';

const LABEL = 'chatty';
const PRODUCT = labelToProductId(LABEL);

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
  chat = createChatStore({ repo: memoryChatRepo(), connections: createChatConnections() });
  const local = memoryStorage();
  stopState = initChatPanelState(chat, () => local);
  setProductLoaded(LABEL, PRODUCT, { chat: true });
  setAuthState({ tag: 'Connected', session: { connected: true } });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  stopState();
  resetAllStoresForTests();
  resetChatPanelStateForTests();
  document.body.replaceChildren();
});

describe('ChatDock island', () => {
  it("As a user, the open panel lists the product's rooms from the page's chat", async () => {
    // Given
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    mountIsland();

    // When
    setChatPanelOpen(true);

    // Then
    await untilDom(() => document.querySelector('[data-testid="chat-room-name"]')?.textContent === 'Main');
    expect(byId('chat-panel').hidden).toBe(false);
    expect(byTestId('chat-room-name').textContent).toBe('Main');
  });

  it('As a user, Escape in the panel closes it on the page', async () => {
    // Given
    mountIsland();

    // Then the dock handed its panel to the page, so the button can tell whether focus was inside
    expect(getChatPanelElement()).toBe(byId('chat-panel'));

    // When
    setChatPanelOpen(true);
    await appears('#chat-panel-close');
    byId('chat-panel-close').focus();
    byId('chat-panel-close').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Then
    await untilDom(() => byId('chat-panel').hidden === true);
    expect(chatPanelStore.get().open).toBe(false);
  });

  it('As a user, the panel stretches to the top while the topbar hides', async () => {
    // Given
    mountIsland();

    // When
    setTopbarVisible(false);

    // Then
    await untilDom(() => byId('chat-panel').hasAttribute('data-topbar-hidden'));

    // When
    setTopbarVisible(true);

    // Then
    await untilDom(() => !byId('chat-panel').hasAttribute('data-topbar-hidden'));
  });
});

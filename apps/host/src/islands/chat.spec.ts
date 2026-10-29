// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, createSignal, flush } from 'solid-js';
import { createMemoryStorage, resetAllStoresForTests } from '@dotli/shared/testing';
import { createChatConnections } from '../runtime/chat/createChatConnections.js';
import { createChatStore, type ChatStore } from '../runtime/chat/createChatStore.js';
import { toProductId } from '../runtime/createTruapiRuntimeConfig.js';
import { authState } from '../runtime/state/authState.js';
import { productState } from '../runtime/state/productState.js';
import { createRecordingConnection } from '../runtime/chat/createChatConnections.fake.js';
import { createMemoryChatRepo } from '../runtime/chat/createChatStore.fake.js';
import { chatPanelState } from '../state/chatPanelState.js';
import { useChatDock } from './chat.js';

const LABEL = 'chatty';
const PRODUCT = toProductId(LABEL);

let chat: ChatStore;
let local: Storage;
let connections: ReturnType<typeof createChatConnections>;
let stopState: () => void = () => undefined;

beforeEach(() => {
  connections = createChatConnections();
  chat = createChatStore({ repo: createMemoryChatRepo(), connections });
  local = createMemoryStorage();
  stopState = chatPanelState.start({ chat, storage: local });
  productState.setLoaded({ label: LABEL, productId: PRODUCT, details: { chat: true } });
  authState.set({ tag: 'Connected', session: { connected: true } });
});

afterEach(() => {
  stopState();
  resetAllStoresForTests();
});

/** The dock's props, read from the page's chat state under a fresh owner, with the room it keeps for the panel. */
function mountDock() {
  const reserved: number[] = [];
  const { dock, dispose } = createRoot(d => ({
    dock: useChatDock(chat, px => {
      reserved.push(px);
    }),
    dispose: d,
  }));
  flush();
  return { dock, dispose, reserved };
}

describe('useChatDock', () => {
  it('As the chat panel, the composer is asked to take focus once after I pick a room', () => {
    // Given
    const { dock, dispose } = mountDock();

    // Then
    expect(dock.conversation.claimComposerFocus()).toBe(false);

    // When
    chatPanelState.openRoom('main');

    // Then
    expect(dock.conversation.claimComposerFocus()).toBe(true);
    expect(dock.conversation.claimComposerFocus()).toBe(false);
    dispose();
  });

  it("As a user, my reply goes to the loaded product's room", async () => {
    // Given
    const connection = createRecordingConnection();
    connections.register(PRODUCT, connection);
    const { dock, dispose } = mountDock();

    // When
    await dock.conversation.send('main', 'hello');

    // Then
    expect(connection.published).toMatchObject([
      { roomId: 'main', payload: { tag: 'MessagePosted', value: { tag: 'Text', value: { text: 'hello' } } } },
    ]);
    dispose();
  });

  it("As a user, the panel's title is the product's published name, else its label", () => {
    // Given
    const { dock, dispose } = mountDock();

    // Then
    expect(dock.conversation.productName()).toBe(LABEL);

    // When
    productState.setLoaded({ label: LABEL, productId: PRODUCT, details: { chat: true, displayName: 'Chatty' } });
    flush();

    // Then
    expect(dock.conversation.productName()).toBe('Chatty');
    dispose();
  });

  it('As the open panel, the feed follows the shown room of the loaded product, and stops as the panel closes', async () => {
    // Given
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    const { dock, dispose } = mountDock();
    const [shown, setShown] = createSignal<string | null>(null);

    // When the panel body opens on the room list
    const body = createRoot(d => {
      dock.conversation.openFeed().follow(shown);
      return d;
    });
    flush();
    await chat.settle();

    // Then
    expect(chat.view.get()).toMatchObject({ productId: PRODUCT, roomId: null });
    expect(chat.view.get().contacts?.rooms.map(room => room.roomId)).toEqual(['main']);

    // When a room shows
    setShown('main');
    flush();
    await chat.settle();

    // Then
    expect(chat.view.get()).toMatchObject({ productId: PRODUCT, roomId: 'main', messages: [] });

    // When the panel body closes
    body();

    // Then
    expect(chat.view.get().productId).toBeNull();
    dispose();
  });

  it('As a user, a room whose messages show while the panel is open is marked seen', async () => {
    // Given
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    chatPanelState.setOpen(true);
    await chat.postProductMessage({
      productId: PRODUCT,
      roomId: 'main',
      content: { tag: 'Text', value: { text: 'hi' } },
    });
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ main: 1 });
    const { dock, dispose } = mountDock();

    // When
    const body = createRoot(d => {
      dock.conversation.openFeed().follow(() => 'main');
      return d;
    });
    flush();
    await chat.settle();

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({});
    body();
    dispose();
  });

  it('As the dock, closing asks the page to close the panel', () => {
    // Given
    chatPanelState.setOpen(true);
    const { dock, dispose } = mountDock();
    expect(dock.open()).toBe(true);

    // When
    dock.onClose();
    flush();

    // Then
    expect(dock.open()).toBe(false);
    dispose();
  });

  it('As a user, the product frame keeps clear of the open panel, as wide as I drag it, and takes the room back as it closes', () => {
    // Given a closed panel
    const { dock, dispose, reserved } = mountDock();

    // Then the frame keeps its whole width
    expect(reserved).toEqual([]);

    // When
    chatPanelState.setOpen(true);
    flush();

    // Then
    expect(reserved).toEqual([360]);

    // When I drag the edge past the widest panel, then let go
    dock.onResize(9999);
    flush();
    dock.onResizeEnd();

    // Then the frame keeps clear of the clamped width, which is kept for the next session
    expect(reserved).toEqual([360, 560]);
    expect(local.getItem('dotli:chat-panel-width')).toBe('560');

    // When
    dock.onClose();
    flush();

    // Then
    expect(reserved).toEqual([360, 560, 0]);
    dispose();
  });

  it('As a user, a product error hides the chat button and closes the panel', () => {
    // Given
    chatPanelState.setOpen(true);
    const { dock, dispose } = mountDock();
    expect(dock.available()).toBe(true);

    // When
    productState.setError();
    flush();

    // Then
    expect(dock.available()).toBe(false);
    expect(dock.open()).toBe(false);
    dispose();
  });
});

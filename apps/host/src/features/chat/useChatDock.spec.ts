// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asProductId } from '@parity/truapi';
import { createRoot, createSignal, flush } from 'solid-js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createChatConnections } from './createChatConnections.js';
import { createChatStore, type ChatStore } from './createChatStore.js';
import { toProductId } from '../../kit/getAskedProductId.js';
import { authState } from '../account/index.js';
import { productState } from '../page/index.js';
import { createRecordingConnection } from './createChatConnections.fake.js';
import { createMemoryChatRepo } from './createChatStore.fake.js';
import { chatPanelState } from './chatPanelState.js';
import { useChatDock } from './useChatDock.js';

const LABEL = 'chatty';
const PRODUCT = asProductId(toProductId(LABEL));

let chat: ChatStore;
let connections: ReturnType<typeof createChatConnections>;
let stopState: () => void = () => undefined;

beforeEach(() => {
  connections = createChatConnections();
  chat = createChatStore({ repo: createMemoryChatRepo(), connections });
  stopState = chatPanelState.start({ chat: () => Promise.resolve(chat) });
  productState.setLoaded({ label: LABEL, productId: PRODUCT });
  authState.set({ tag: 'Connected', session: { connected: true } });
});

afterEach(() => {
  stopState();
  resetAllStoresForTests();
});

/** The dock's props, read from the page's chat state under a fresh owner. */
function mountDock() {
  const { dock, dispose } = createRoot(d => ({ dock: useChatDock(chat), dispose: d }));
  flush();
  return { dock, dispose };
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

  it('As a user whose open room disappeared, I open another room and see no error from the one that went', () => {
    // Given a room whose send failed, then dropped out of the contacts
    const { dock, dispose } = mountDock();
    dock.conversation.openRoom('gone');
    dock.conversation.setComposerError('not delivered');
    dock.conversation.roomGone();

    // When
    dock.conversation.openRoom('next');
    flush();

    // Then
    expect(dock.conversation.composerError()).toBeNull();
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
    productState.setLoaded({
      label: LABEL,
      productId: PRODUCT,
      details: { facts: { displayName: 'Chatty' } },
    });
    flush();

    // Then
    expect(dock.conversation.productName()).toBe('Chatty');
    dispose();
  });

  it("As the dock, I name the open panel's sole room, and no room once the panel closes", async () => {
    // Given
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    const { dock, dispose } = mountDock();

    // When the panel body opens on the product's rooms
    const body = createRoot(d => {
      dock.conversation.openFeed().follow(() => null);
      return d;
    });
    flush();
    await chat.settle();
    flush();

    // Then
    expect(dock.shown()).toMatchObject({ contact: { id: 'main' }, sole: true });

    // When the panel body closes
    body();
    flush();

    // Then
    expect(dock.shown()).toBeNull();
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
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { asProductId } from '@parity/truapi';
import { createRecordingConnection } from '../runtime/chat/createChatConnections.fake.js';
import { createMemoryChatRepo } from '../runtime/chat/createChatStore.fake.js';
import { createChatConnections } from '../runtime/chat/createChatConnections.js';
import { createChatStore, type ChatStore } from '../runtime/chat/createChatStore.js';
import { toProductId } from '../runtime/createTruapiRuntimeConfig.js';
import { productState } from '../runtime/state/productState.js';
import { authState } from '../runtime/state/authState.js';
import { recordNotified } from '../testing/recordNotified.js';
import { topbarState } from './topbarState.js';
import { chatPanelState } from './chatPanelState.js';
import { noop } from '@dotli/shared';
import { createMemoryStorage, resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

let remove: () => void = noop;
let local: Storage;
let chat: ChatStore;
let connections: ReturnType<typeof createChatConnections>;

function showProduct(label: string): void {
  productState.setLoaded({ label, productId: asProductId(toProductId(label)), details: { chat: true } });
  authState.set({ tag: 'Connected', session: { connected: true } });
}

async function postProductMessage(label: string, roomId: string): Promise<void> {
  await chat.postProductMessage({
    productId: toProductId(label),
    roomId,
    content: { tag: 'Text', value: { text: 'hi' } },
  });
}

beforeEach(() => {
  local = createMemoryStorage();
  connections = createChatConnections();
  chat = createChatStore({ repo: createMemoryChatRepo(), connections });
  remove = chatPanelState.start({ chat, storage: local });
});

afterEach(() => {
  remove();
  resetStores();
});

describe('chat panel state', () => {
  it('As a user, I load a product and log in and see the chat button only for a chat-capable product while logged in', () => {
    // When a product that declares no chat loads, then loads again declaring chat, then I log in
    productState.setLoaded({ label: 'first-app', productId: asProductId(toProductId('first-app')) });
    const withoutChat = chatPanelState.isButtonVisible();
    productState.setLoaded({
      label: 'first-app',
      productId: asProductId(toProductId('first-app')),
      details: { chat: true },
    });
    const loggedOut = chatPanelState.isButtonVisible();
    authState.set({ tag: 'Connected', session: { connected: true } });

    // Then
    expect({ withoutChat, loggedOut, loggedIn: chatPanelState.isButtonVisible() }).toEqual({
      withoutChat: false,
      loggedOut: false,
      loggedIn: true,
    });
  });

  it('As a user, I see my product fail to load and the chat button go away', () => {
    // Given
    showProduct('app');

    // When
    productState.setError();

    // Then
    expect(chatPanelState.isButtonVisible()).toBe(false);
    expect(chatPanelState.store.get().available).toBe(false);
  });

  it('As a user, I log out and see the chat panel close', () => {
    // Given
    showProduct('app');
    chatPanelState.setOpen(true);

    // When
    authState.set({ tag: 'Disconnected' });

    // Then
    expect(chatPanelState.isButtonVisible()).toBe(false);
    expect(chatPanelState.store.get().open).toBe(false);
  });

  it('As a user, I get product messages outside the room I am viewing and see them count as unread, per room', async () => {
    // Given
    showProduct('app');

    // When
    await postProductMessage('app', 'a');
    await postProductMessage('app', 'a');
    await postProductMessage('app', 'b');

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ a: 2, b: 1 });
    expect(chatPanelState.getTotalUnread()).toBe(3);
  });

  it('As a user viewing a room, I get a new message there and see it seen at once while other rooms stay unread', async () => {
    // Given
    showProduct('app');
    await postProductMessage('app', 'a');
    await postProductMessage('app', 'a');
    await postProductMessage('app', 'b');

    // When
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');
    chatPanelState.markRoomSeen('a');
    await postProductMessage('app', 'a');

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ b: 1 });
  });

  it('As a user, I send a message and another product gets one, and neither counts as unread', async () => {
    // Given
    showProduct('app');
    connections.register(toProductId('app'), createRecordingConnection());

    // When
    await chat.postUserMessage({ productId: toProductId('app'), roomId: 'a', text: 'hello' });
    await postProductMessage('other', 'a');

    // Then
    expect(chatPanelState.getTotalUnread()).toBe(0);
  });

  it('As a user, I load a different product and see the open room, unread counts and composer error reset', async () => {
    // Given
    showProduct('app');
    await postProductMessage('app', 'a');
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');
    chatPanelState.setComposerError('oops');

    // When
    productState.setLoaded({ label: 'next', productId: asProductId('next.dot') });

    // Then
    expect(chatPanelState.store.get()).toMatchObject({ activeRoomId: null, unreadByRoom: {}, composerError: null });
    expect(chatPanelState.getCurrentProductId()).toBe('next.dot');
  });

  it('As a user, I reload the same product and keep my open room', () => {
    // Given
    showProduct('app');
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');

    // When
    productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')), details: { chat: true } });

    // Then
    expect(chatPanelState.store.get().activeRoomId).toBe('a');
  });

  it('As a user whose product loaded before the chat panel state started, I wait for it to start and see the panel follow that product', () => {
    // Given
    remove();
    productState.setLoaded({ label: 'early', productId: asProductId('early.dot') });

    // When
    remove = chatPanelState.start({ storage: local });

    // Then
    expect(chatPanelState.getCurrentProductId()).toBe('early.dot');
  });

  it('As a user, I go back to the room list and see the composer error cleared', () => {
    // Given
    showProduct('app');
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');
    chatPanelState.setComposerError('oops');

    // When
    chatPanelState.backToRooms();

    // Then
    expect(chatPanelState.store.get()).toMatchObject({ activeRoomId: null, composerError: null });
  });

  it('As a user, I drag the panel width past its bounds and see it clamped, persisted and restored when the panel opens', () => {
    // Given
    showProduct('app');

    // When the panel is dragged wide and saved, then dragged narrow, then opens
    chatPanelState.setWidth(9999);
    chatPanelState.persistWidth();
    const persisted = chatPanelState.store.get().width;
    const stored = local.getItem('dotli:chat-panel-width');
    chatPanelState.setWidth(10);
    const narrowed = chatPanelState.store.get().width;
    chatPanelState.setOpen(true);

    // Then
    expect({ persisted, stored, narrowed, opened: chatPanelState.store.get().width }).toEqual({
      persisted: 560,
      stored: '560',
      narrowed: 280,
      opened: 560,
    });
  });

  it.each([
    { stored: '480', opened: 480 },
    { stored: 'wide', opened: 360 },
    { stored: '100', opened: 360 },
    { stored: '900', opened: 560 },
  ])(
    'As a returning user, I open the panel at the width I saved, a stored width that does not parse opens at the default, a stored width below the minimum opens at the default, and one above the maximum opens at the maximum (stored $stored)',
    ({ stored, opened }) => {
      // Given a width saved in an earlier session and a product with chat
      local.setItem('dotli:chat-panel-width', stored);
      showProduct('app');

      // When
      chatPanelState.setOpen(true);

      // Then
      expect(chatPanelState.store.get().width).toBe(opened);
    },
  );

  it('As the chat panel, I follow the login, topbar, product and chat changes and read each new value at once', async () => {
    // Given each input set from inside the listener of the one before, and every listener reading the panel
    const seen: unknown[] = [];
    onTestFinished(
      authState.loggedInStore.listen(() => {
        seen.push({ loggedIn: chatPanelState.store.get().loggedIn });
        topbarState.setVisible(false);
      }),
    );
    onTestFinished(
      topbarState.store.listen(() => {
        seen.push({ topbarVisible: chatPanelState.store.get().topbarVisible });
        productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')), details: { chat: true } });
      }),
    );
    onTestFinished(
      productState.store.listen(() => {
        seen.push({ label: chatPanelState.store.get().label });
      }),
    );
    onTestFinished(
      chat.subscribe(change => {
        if (change.kind === 'message') {
          seen.push({ unreadByRoom: chatPanelState.store.get().unreadByRoom });
        }
      }),
    );

    // When
    authState.set({ tag: 'Connected', session: { connected: true } });
    await postProductMessage('app', 'a');

    // Then
    expect(seen).toEqual([{ loggedIn: true }, { topbarVisible: false }, { label: 'app' }, { unreadByRoom: { a: 1 } }]);
    expect(chatPanelState.store.get()).toMatchObject({
      loggedIn: true,
      topbarVisible: false,
      label: 'app',
      available: true,
      unreadByRoom: { a: 1 },
    });
  });

  it('As a user, I drag the panel past its clamp, clear no error and keep the topbar, and the panel redraws only for a new width', () => {
    // Given
    productState.setLoaded({ label: 'app', productId: asProductId('app.dot'), details: { chat: true } });
    chatPanelState.setWidth(10_000);
    const notified = recordNotified(chatPanelState.store);

    // When
    chatPanelState.setWidth(10_000);
    chatPanelState.setWidth(900);
    chatPanelState.setComposerError(null);
    topbarState.setVisible(true);
    topbarState.reportBlockingModals({ waiting: 0, active: true });
    chatPanelState.setWidth(400);

    // Then
    expect(notified.map(state => state.width)).toEqual([400]);
  });

  it('As a user whose page stopped its shell state, I hide the topbar and the chat panel no longer follows it', () => {
    // Given the panel state, wired and then stopped
    remove();
    remove = noop;

    // When
    topbarState.setVisible(false);

    // Then
    expect(chatPanelState.store.get().topbarVisible).toBe(true);
  });

  it('As a user whose page started the chat panel state twice, I get a product message and see it count once as unread', async () => {
    // Given
    onTestFinished(chatPanelState.start({ chat, storage: local }));
    showProduct('app');

    // When
    await postProductMessage('app', 'a');

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ a: 1 });
  });

  it('As a user who logged in and hid the topbar early, I wait for the chat panel state to start and see it know both at once', () => {
    // Given
    remove();
    authState.set({ tag: 'Connected', session: { connected: true } });
    topbarState.setVisible(false);

    // When
    remove = chatPanelState.start({ chat, storage: local });

    // Then
    expect(chatPanelState.store.get()).toMatchObject({
      loggedIn: true,
      topbarVisible: false,
    });
  });
});

describe('chat panel state, rooms seen', () => {
  /** A chat store whose conversation reads wait for `release`, wired into the panel state in place of the default. */
  function holdReads(): { release: () => Promise<void> } {
    const repo = createMemoryChatRepo();
    repo.reads.hold.messages = true;
    remove();
    chat = createChatStore({ repo, connections });
    remove = chatPanelState.start({ chat, storage: local });
    return {
      /** Lets the waiting read land, once it has started. */
      async release() {
        await repo.reads.holding(1);
        repo.reads.releaseAll();
      },
    };
  }

  it('As a user, I open a room with unread messages and see it marked seen once its messages show', async () => {
    // Given
    showProduct('app');
    chatPanelState.setOpen(true);
    onTestFinished(chatPanelState.markFollowedRoomSeen(chat.view));

    // When a message lands in a room I do not follow, then I open that room
    await postProductMessage('app', 'r1');
    const unread = chatPanelState.store.get().unreadByRoom;
    chat.follow({ productId: toProductId('app'), roomId: 'r1', loadId: 1 });
    await chat.settle();

    // Then
    expect(unread).toEqual({ r1: 1 });
    expect(chatPanelState.store.get().unreadByRoom).toEqual({});
  });

  it('As a user who closed the panel, I wait for a late conversation read and see nothing marked seen', async () => {
    // Given: an unread message in a room, opened with its read waiting.
    const reads = holdReads();
    showProduct('app');
    chatPanelState.setOpen(true);
    await postProductMessage('app', 'r1');
    onTestFinished(chatPanelState.markFollowedRoomSeen(chat.view));
    chat.follow({ productId: toProductId('app'), roomId: 'r1', loadId: 1 });

    // When: the panel closes, then the read lands.
    chatPanelState.setOpen(false);
    chat.follow(null);
    await reads.release();
    await chat.settle();

    // Then
    expect(chat.view.get()).toMatchObject({ roomId: null, messages: null });
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ r1: 1 });
  });

  it('As a user who went back to the list, I wait for a late conversation read and see nothing marked seen', async () => {
    // Given: a room open, and its read waiting.
    const reads = holdReads();
    showProduct('app');
    chatPanelState.setOpen(true);
    await postProductMessage('app', 'r1');
    onTestFinished(chatPanelState.markFollowedRoomSeen(chat.view));
    chat.follow({ productId: toProductId('app'), roomId: 'r1', loadId: 1 });

    // When: back to the list, then the read lands.
    chat.follow({ productId: toProductId('app'), roomId: null, loadId: 1 });
    await reads.release();
    await chat.settle();

    // Then
    expect(chat.view.get().messages).toBeNull();
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ r1: 1 });
  });
});

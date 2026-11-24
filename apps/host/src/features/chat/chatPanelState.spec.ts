// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { asProductId } from '@parity/truapi';
import { createRecordingConnection } from './createChatConnections.fake.js';
import { createMemoryChatRepo } from './createChatStore.fake.js';
import { createChatConnections } from './createChatConnections.js';
import { createChatStore, type ChatStore } from './createChatStore.js';
import { toProductId } from '../../kit/getAskedProductId.js';
import { productState } from '../page/index.js';
import { authState } from '../account/index.js';
import { recordNotified } from '../../testing/recordNotified.js';
import { chatPanelState } from './chatPanelState.js';
import { createDeferred, noop } from '@dotli/shared';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

let remove: () => void = noop;
let chat: ChatStore;
let connections: ReturnType<typeof createChatConnections>;

/** Shows the product `label` with the rooms `roomIds` and a chat connection, to a logged-in user. */
async function showProduct(label: string, roomIds: string[] = ['main']): Promise<void> {
  connections.register(toProductId(label), createRecordingConnection());
  productState.setLoaded({ label, productId: asProductId(toProductId(label)) });
  authState.set({ tag: 'Connected', session: { connected: true } });
  for (const roomId of roomIds) {
    await chat.createRoom(toProductId(label), { roomId, name: roomId, icon: '' });
  }
}

/** Resolves once the panel state shows the chat button. */
function waitForButton(): Promise<void> {
  const shown = createDeferred<undefined>();
  onTestFinished(
    chatPanelState.store.subscribe(state => {
      if (chatPanelState.isButtonVisible(state)) {
        shown.resolve(undefined);
      }
    }),
  );
  return shown.promise;
}

async function postProductMessage(label: string, roomId: string): Promise<void> {
  await chat.postProductMessage({
    productId: toProductId(label),
    roomId,
    content: { tag: 'Text', value: { text: 'hi' } },
  });
}

beforeEach(() => {
  connections = createChatConnections();
  chat = createChatStore({ repo: createMemoryChatRepo(), connections });
  remove = chatPanelState.start({ chat: () => Promise.resolve(chat), connections });
});

afterEach(() => {
  remove();
  resetStores();
});

describe('chat panel state', () => {
  it('As a logged-in user, I open a product that has a room and see the chat button once its chat connection registers', async () => {
    // Given a product with a room from an earlier visit, shown with no chat connection yet
    authState.set({ tag: 'Connected', session: { connected: true } });
    const productId = asProductId(toProductId('app'));
    await chat.createRoom(productId, { roomId: 'main', name: 'Main', icon: '' });
    productState.setLoaded({ label: 'app', productId });
    const before = chatPanelState.isButtonVisible();
    const shown = waitForButton();

    // When
    connections.register(productId, createRecordingConnection());
    await shown;

    // Then
    expect(before).toBe(false);
    expect(chatPanelState.store.get().available).toBe(true);
  });

  it('As a user, I open a product whose chat connection registered before it showed and see chat available at once', () => {
    // Given
    const productId = asProductId(toProductId('app'));
    connections.register(productId, createRecordingConnection());

    // When
    productState.setLoaded({ label: 'app', productId });

    // Then
    expect(chatPanelState.store.get().available).toBe(true);
  });

  it('As a user with the chat panel open, I see chat stay available and open when its connection ends', async () => {
    // Given
    const productId = asProductId(toProductId('app'));
    const unregister = connections.register(productId, createRecordingConnection());
    productState.setLoaded({ label: 'app', productId });
    authState.set({ tag: 'Connected', session: { connected: true } });
    await chat.createRoom(productId, { roomId: 'main', name: 'Main', icon: '' });
    chatPanelState.setOpen(true);

    // When
    unregister();

    // Then
    expect(chatPanelState.store.get()).toMatchObject({ available: true, open: true });
  });

  it('As a user, I leave a product with chat for one with no chat connection and see chat unavailable', async () => {
    // Given
    await showProduct('app');

    // When
    productState.setLoaded({ label: 'next', productId: asProductId(toProductId('next')) });

    // Then
    expect(chatPanelState.store.get().available).toBe(false);
  });

  it('As a user, I see no chat when a chat connection registers for a product not on show', () => {
    // Given
    productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')) });

    // When
    connections.register(toProductId('other'), createRecordingConnection());

    // Then
    expect(chatPanelState.store.get().available).toBe(false);
  });

  it('As a user who is not logged in, I see no chat button for a product with chat and a room', async () => {
    // Given
    const productId = asProductId(toProductId('app'));
    connections.register(productId, createRecordingConnection());

    // When
    productState.setLoaded({ label: 'app', productId });
    await chat.createRoom(productId, { roomId: 'main', name: 'Main', icon: '' });

    // Then
    expect(chatPanelState.store.get().hasContacts).toBe(true);
    expect(chatPanelState.isButtonVisible()).toBe(false);
  });

  it('As a user, I leave a product before the read of its rooms lands and see no chat button for the next one', async () => {
    // Given a read of the first product's rooms, waiting
    remove();
    const first = asProductId(toProductId('first'));
    const asked = createDeferred<undefined>();
    const check = createDeferred<boolean>();
    function hasContacts(productId: string): Promise<boolean> {
      if (productId !== first) {
        return Promise.resolve(false);
      }
      asked.resolve(undefined);
      return check.promise;
    }
    authState.set({ tag: 'Connected', session: { connected: true } });
    connections.register(first, createRecordingConnection());
    connections.register(toProductId('next'), createRecordingConnection());
    productState.setLoaded({ label: 'first', productId: first });
    remove = chatPanelState.start({
      chat: () => Promise.resolve({ subscribe: chat.subscribe, hasContacts }),
      connections,
    });
    await asked.promise;

    // When the next product loads, then the first read lands
    productState.setLoaded({ label: 'next', productId: asProductId(toProductId('next')) });
    check.resolve(true);
    await check.promise;

    // Then
    expect(chatPanelState.isButtonVisible()).toBe(false);
  });

  it('As a user, I see my product fail to load and the chat button go away', async () => {
    // Given
    await showProduct('app');

    // When
    productState.setError();

    // Then
    expect(chatPanelState.isButtonVisible()).toBe(false);
    expect(chatPanelState.store.get().available).toBe(false);
  });

  it('As a user, I log out and see the chat panel close', async () => {
    // Given
    await showProduct('app');
    chatPanelState.setOpen(true);

    // When
    authState.set({ tag: 'Disconnected' });

    // Then
    expect(chatPanelState.isButtonVisible()).toBe(false);
    expect(chatPanelState.store.get().open).toBe(false);
  });

  it('As a user, I get product messages outside the room I am viewing and see them count as unread, per room', async () => {
    // Given
    await showProduct('app', ['a', 'b']);

    // When
    await postProductMessage('app', 'a');
    await postProductMessage('app', 'a');
    await postProductMessage('app', 'b');

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ a: 2, b: 1 });
    expect(chatPanelState.getTotalUnread()).toBe(3);
  });

  it('As a user, I get a message the product posts to its bot and see nothing unread', async () => {
    // Given
    await showProduct('app');
    await chat.registerBot(toProductId('app'), { botId: 'helper', name: 'Helper', icon: '' });

    // When
    await postProductMessage('app', 'helper');

    // Then
    expect(chatPanelState.getTotalUnread()).toBe(0);
  });

  it('As a user viewing a room, I get a new message there and see it seen at once while other rooms stay unread', async () => {
    // Given
    await showProduct('app', ['a', 'b']);
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
    await showProduct('app');

    // When
    await chat.postUserMessage({ productId: toProductId('app'), roomId: 'a', text: 'hello' });
    await postProductMessage('other', 'a');

    // Then
    expect(chatPanelState.getTotalUnread()).toBe(0);
  });

  it('As a user, I load a different product and see the open room, unread counts and composer error reset', async () => {
    // Given
    await showProduct('app', ['a']);
    await postProductMessage('app', 'a');
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');
    chatPanelState.setComposerError('oops');

    // When
    productState.setLoaded({ label: 'next', productId: asProductId('next.dot') });

    // Then
    expect(chatPanelState.store.get()).toMatchObject({ activeRoomId: null, unreadByRoom: {}, composerError: null });
    expect(chatPanelState.store.get().runtimeProductId).toBe('next.dot');
  });

  it('As a user, I reload the same product and keep my open room', async () => {
    // Given
    await showProduct('app');
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');

    // When
    productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')) });

    // Then
    expect(chatPanelState.store.get().activeRoomId).toBe('a');
  });

  it('As a user whose product loaded before the chat panel state started, I wait for it to start and see the panel follow that product', () => {
    // Given
    remove();
    productState.setLoaded({ label: 'early', productId: asProductId('early.dot') });

    // When
    remove = chatPanelState.start();

    // Then
    expect(chatPanelState.store.get().runtimeProductId).toBe('early.dot');
  });

  it('As a user, I go back to the room list and see the composer error cleared', async () => {
    // Given
    await showProduct('app');
    chatPanelState.setOpen(true);
    chatPanelState.openRoom('a');
    chatPanelState.setComposerError('oops');

    // When
    chatPanelState.backToRooms();

    // Then
    expect(chatPanelState.store.get()).toMatchObject({ activeRoomId: null, composerError: null });
  });

  it('As the chat panel, I follow the login, product and chat changes and read each new value at once', async () => {
    // Given each input set from inside the listener of the one before, and every listener reading the panel
    const seen: unknown[] = [];
    connections.register(toProductId('app'), createRecordingConnection());
    await chat.createRoom(toProductId('app'), { roomId: 'a', name: 'A', icon: '' });
    onTestFinished(
      authState.loggedInStore.listen(() => {
        seen.push({ loggedIn: chatPanelState.store.get().loggedIn });
        productState.setLoaded({ label: 'app', productId: asProductId(toProductId('app')) });
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
    expect(seen).toEqual([{ loggedIn: true }, { label: 'app' }, { unreadByRoom: { a: 1 } }]);
    expect(chatPanelState.store.get()).toMatchObject({
      loggedIn: true,
      label: 'app',
      available: true,
      unreadByRoom: { a: 1 },
    });
  });

  it('As a user, I clear no error, and the panel redraws only for a new error', () => {
    // Given
    productState.setLoaded({ label: 'app', productId: asProductId('app.dot') });
    const notified = recordNotified(chatPanelState.store);

    // When
    chatPanelState.setComposerError(null);
    chatPanelState.setComposerError('oops');

    // Then
    expect(notified.map(state => state.composerError)).toEqual(['oops']);
  });

  it('As a user whose page started the chat panel state twice, I get a product message and see it count once as unread', async () => {
    // Given
    onTestFinished(chatPanelState.start({ chat: () => Promise.resolve(chat) }));
    await showProduct('app', ['a']);

    // When
    await postProductMessage('app', 'a');

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({ a: 1 });
  });

  it('As a user who logged in early, I wait for the chat panel state to start and see it know my session at once', () => {
    // Given
    remove();
    authState.set({ tag: 'Connected', session: { connected: true } });

    // When
    remove = chatPanelState.start({ chat: () => Promise.resolve(chat), connections });

    // Then
    expect(chatPanelState.store.get().loggedIn).toBe(true);
  });

  it('As a user whose page stopped the chat panel state before its chat store loaded, I get a product message and see nothing unread', async () => {
    // Given a panel state stopped while its chat store still loads
    remove();
    const loading = createDeferred<ChatStore>();
    chatPanelState.start({ chat: () => loading.promise, connections })();
    remove = noop;
    await showProduct('app', ['a']);

    // When the store loads and the product posts
    loading.resolve(chat);
    await postProductMessage('app', 'a');

    // Then
    expect(chatPanelState.store.get().unreadByRoom).toEqual({});
  });
});

describe('chat panel state, rooms seen', () => {
  /** A chat store whose conversation reads wait for `release`, wired into the panel state in place of the default. */
  function holdReads(): { release: () => Promise<void> } {
    const repo = createMemoryChatRepo();
    repo.reads.hold.messages = true;
    remove();
    chat = createChatStore({ repo, connections });
    remove = chatPanelState.start({ chat: () => Promise.resolve(chat), connections });
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
    await showProduct('app', ['r1']);
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
    await showProduct('app', ['r1']);
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
    await showProduct('app', ['r1']);
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

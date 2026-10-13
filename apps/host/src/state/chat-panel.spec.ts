// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryChatRepo, recordingConnection } from '../runtime/chat/store.fake.js';
import { createChatConnections, createChatStore, type ChatStore } from '../runtime/chat/store.js';
import { labelToProductId } from '../runtime/runtime-config.js';
import { setProductError, setProductLoaded } from '../runtime/state/product.js';
import { setAuthState } from '../runtime/state/auth.js';
import { reportBlockingModals, setTopbarVisible } from './topbar.js';
import {
  backToChatRooms,
  chatButtonVisible,
  chatPanelStore,
  currentChatProductId,
  initChatPanelState,
  markChatRoomSeen,
  markFollowedRoomSeen,
  openChatRoom,
  persistChatPanelWidth,
  setChatComposerError,
  setChatPanelOpen,
  setChatPanelWidth,
  totalChatUnread,
} from './chat-panel.js';
import { memoryStorage, resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

let remove: () => void = () => undefined;
let local: Storage;
let chat: ChatStore;
let connections: ReturnType<typeof createChatConnections>;

function showProduct(label: string): void {
  setProductLoaded(label, labelToProductId(label), { chat: true });
  setAuthState({ tag: 'Connected', session: { connected: true } });
}

async function productMessage(label: string, roomId: string): Promise<void> {
  await chat.postProductMessage(labelToProductId(label), roomId, { tag: 'Text', value: { text: 'hi' } });
}

beforeEach(() => {
  local = memoryStorage();
  connections = createChatConnections();
  chat = createChatStore({ repo: memoryChatRepo(), connections });
  remove = initChatPanelState(chat, () => local);
});

afterEach(() => {
  remove();
  resetStores();
});

describe('chat panel state', () => {
  it('As a user, the chat button shows only for a chat-capable product while I am logged in', () => {
    // Given a product that declares no chat
    setProductLoaded('first-app', labelToProductId('first-app'));

    // Then
    expect(chatButtonVisible()).toBe(false);

    // When it loads again declaring chat
    setProductLoaded('first-app', labelToProductId('first-app'), { chat: true });

    // Then
    expect(chatButtonVisible()).toBe(false);

    // When
    setAuthState({ tag: 'Connected', session: { connected: true } });

    // Then
    expect(chatButtonVisible()).toBe(true);
  });

  it('As a user, the chat button goes away when my product fails to load', () => {
    // Given
    showProduct('app');

    // When
    setProductError();

    // Then
    expect(chatButtonVisible()).toBe(false);
    expect(chatPanelStore.get().available).toBe(false);
  });

  it('As a user, the panel closes when the button goes away (logout or product error)', () => {
    // Given
    showProduct('app');
    setChatPanelOpen(true);

    // When
    setAuthState({ tag: 'Disconnected' });

    // Then
    expect(chatButtonVisible()).toBe(false);
    expect(chatPanelStore.get().open).toBe(false);

    // When
    setAuthState({ tag: 'Connected', session: { connected: true } });
    setChatPanelOpen(true);
    setProductError();

    // Then
    expect(chatButtonVisible()).toBe(false);
    expect(chatPanelStore.get().open).toBe(false);
    expect(currentChatProductId()).toBeNull();
  });

  it('As a user, product messages outside the room I am viewing count as unread, per room', async () => {
    // Given
    showProduct('app');

    // When
    await productMessage('app', 'a');
    await productMessage('app', 'a');
    await productMessage('app', 'b');

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ a: 2, b: 1 });
    expect(totalChatUnread()).toBe(3);

    // When: viewing room a, a new message there is seen at once
    setChatPanelOpen(true);
    openChatRoom('a');
    markChatRoomSeen('a');
    await productMessage('app', 'a');

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ b: 1 });
  });

  it('As a user, my own messages and messages for another product do not count as unread', async () => {
    // Given
    showProduct('app');
    connections.register(labelToProductId('app'), recordingConnection());

    // When
    await chat.postUserMessage(labelToProductId('app'), 'a', 'hello');
    await productMessage('other', 'a');

    // Then
    expect(totalChatUnread()).toBe(0);
  });

  it('As a user, loading a different product resets the open room, unread counts and composer error', async () => {
    // Given
    showProduct('app');
    await productMessage('app', 'a');
    setChatPanelOpen(true);
    openChatRoom('a');
    setChatComposerError('oops');

    // When
    setProductLoaded('next', 'next.dot');

    // Then
    const state = chatPanelStore.get();
    expect(state.activeRoomId).toBeNull();
    expect(state.unreadByRoom).toEqual({});
    expect(state.composerError).toBeNull();
    expect(currentChatProductId()).toBe('next.dot');
  });

  it('As a user, reloading the same product keeps my open room', () => {
    // Given
    showProduct('app');
    setChatPanelOpen(true);
    openChatRoom('a');

    // When
    setProductLoaded('app', labelToProductId('app'), { chat: true });

    // Then
    expect(chatPanelStore.get().activeRoomId).toBe('a');
  });

  it('As a user whose product loaded before the chat panel state started, the panel follows that product', () => {
    // Given
    remove();
    setProductLoaded('early', 'early.dot');

    // When
    remove = initChatPanelState(undefined, () => local);

    // Then
    expect(currentChatProductId()).toBe('early.dot');
  });

  it('As a user, going back to the room list clears the composer error', () => {
    // Given
    showProduct('app');
    setChatPanelOpen(true);
    openChatRoom('a');
    setChatComposerError('oops');

    // When
    backToChatRooms();

    // Then
    expect(chatPanelStore.get().activeRoomId).toBeNull();
    expect(chatPanelStore.get().composerError).toBeNull();
  });

  it('As a user, the panel width is clamped, persisted, and restored when the panel opens', () => {
    // Given
    showProduct('app');

    // When
    setChatPanelWidth(9999);
    persistChatPanelWidth();

    // Then
    expect(chatPanelStore.get().width).toBe(560);
    expect(local.getItem('dotli:chat-panel-width')).toBe('560');

    // When
    setChatPanelWidth(10);

    // Then
    expect(chatPanelStore.get().width).toBe(280);

    // When
    setChatPanelOpen(true);

    // Then
    expect(chatPanelStore.get().width).toBe(560);
  });

  it('As the chat panel, a width drag past the clamp, a cleared composer error and an unchanged topbar notify nobody', () => {
    // Given
    setProductLoaded('app', 'app.dot', { chat: true });
    setChatPanelWidth(10_000);
    let notified = 0;
    const stop = chatPanelStore.subscribe(() => {
      notified += 1;
    });

    // When
    setChatPanelWidth(10_000);
    setChatPanelWidth(900);
    setChatComposerError(null);
    setTopbarVisible(true);
    reportBlockingModals({ waiting: 0, active: true });

    // Then
    expect(notified).toBe(0);

    // When
    setChatPanelWidth(400);

    // Then
    expect(notified).toBe(1);
    stop();
  });

  it('As a user, the topbar visibility is tracked for the panel', () => {
    // When
    setTopbarVisible(false);

    // Then
    expect(chatPanelStore.get().topbarVisible).toBe(false);
  });

  it('As a dotli page whose shell state stopped, the chat panel no longer follows the topbar', () => {
    // Given the panel state, wired and then stopped
    remove();
    remove = () => undefined;

    // When
    setTopbarVisible(false);

    // Then
    expect(chatPanelStore.get().topbarVisible).toBe(true);
  });

  it('As a panel wired after a login, the session and the hidden topbar are already known', () => {
    // Given
    remove();
    setAuthState({ tag: 'Connected', session: { connected: true } });
    setTopbarVisible(false);

    // When
    remove = initChatPanelState(chat, () => local);

    // Then
    expect(chatPanelStore.get()).toMatchObject({
      loggedIn: true,
      topbarVisible: false,
    });
  });
});

describe('chat panel state, rooms seen', () => {
  /** A chat store whose conversation reads wait for `release`, wired into the panel state in place of the default. */
  function heldReads(): { release: () => Promise<void> } {
    const repo = memoryChatRepo();
    const held: (() => void)[] = [];
    let onHeld = (): void => undefined;
    const listMessages = repo.listMessages.bind(repo);
    repo.listMessages = async (productId, roomId) => {
      const messages = await listMessages(productId, roomId);
      await new Promise<void>(resolve => {
        held.push(resolve);
        onHeld();
      });
      return messages;
    };
    remove();
    chat = createChatStore({ repo, connections });
    remove = initChatPanelState(chat, () => local);
    return {
      /** Lets the waiting read land, once it has started. */
      release: async () => {
        if (held.length === 0) {
          await new Promise<void>(resolve => {
            onHeld = resolve;
          });
        }
        held.splice(0).forEach(go => {
          go();
        });
      },
    };
  }

  it('As a user, opening a room with unread messages marks it seen once its messages show', async () => {
    // Given
    showProduct('app');
    setChatPanelOpen(true);
    await productMessage('app', 'r1');
    expect(chatPanelStore.get().unreadByRoom).toEqual({ r1: 1 });
    const stop = markFollowedRoomSeen(chat.view);

    // When
    chat.follow({ productId: labelToProductId('app'), roomId: 'r1', loadId: 1 });
    await chat.settle();

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({});
    stop();
  });

  it('As a user who closed the panel, a conversation read that lands late marks nothing seen', async () => {
    // Given: an unread message in a room, opened with its read waiting.
    const reads = heldReads();
    showProduct('app');
    setChatPanelOpen(true);
    await productMessage('app', 'r1');
    const stop = markFollowedRoomSeen(chat.view);
    chat.follow({ productId: labelToProductId('app'), roomId: 'r1', loadId: 1 });

    // When: the panel closes, then the read lands.
    setChatPanelOpen(false);
    chat.follow(null);
    await reads.release();
    await chat.settle();

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ r1: 1 });
    stop();
  });

  it('As a user who went back to the list, a conversation read that lands late marks nothing seen', async () => {
    // Given: a room open, and its read waiting.
    const reads = heldReads();
    showProduct('app');
    setChatPanelOpen(true);
    await productMessage('app', 'r1');
    const stop = markFollowedRoomSeen(chat.view);
    chat.follow({ productId: labelToProductId('app'), roomId: 'r1', loadId: 1 });

    // When: back to the list, then the read lands.
    chat.follow({ productId: labelToProductId('app'), roomId: null, loadId: 1 });
    await reads.release();
    await chat.settle();

    // Then
    expect(chat.view.get().messages).toBeNull();
    expect(chatPanelStore.get().unreadByRoom).toEqual({ r1: 1 });
    stop();
  });
});

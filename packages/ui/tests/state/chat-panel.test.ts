// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_AVAILABILITY_EVENT } from '@dotli/shared';
import { CHAT_BOTS_CHANGED_EVENT, CHAT_MESSAGE_EVENT, CHAT_ROOMS_CHANGED_EVENT } from '../../src/chat/service.js';
import { labelToProductId } from '../../src/runtime-config.js';
import { setLoggedIn } from '../../src/state/auth.js';
import { setTopbarVisible } from '../../src/state/topbar.js';
import {
  backToChatRooms,
  chatButtonVisible,
  chatPanelStore,
  chatUnreadLabel,
  currentChatProductId,
  initChatPanelState,
  markChatRoomSeen,
  openChatRoom,
  persistChatPanelWidth,
  resetChatPanelStateForTests,
  setChatComposerError,
  setChatPanelOpen,
  setChatPanelWidth,
  totalChatUnread,
} from '../../src/state/chat-panel.js';
import { resetAllStoresForTests as resetStores } from '../../src/state/create-store.js';

let remove: () => void = () => undefined;

function fire(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function showProduct(label: string): void {
  fire('dotli:product-loaded', { label });
  fire(CHAT_AVAILABILITY_EVENT, { label, chat: true });
  setLoggedIn(true);
}

function productMessage(label: string, roomId: string): void {
  fire(CHAT_MESSAGE_EVENT, {
    productId: labelToProductId(label),
    roomId,
    author: 'product',
  });
}

beforeEach(() => {
  localStorage.clear();
  remove = initChatPanelState();
});

afterEach(() => {
  remove();
  resetStores();
  resetChatPanelStateForTests();
});

describe('chat panel state', () => {
  it('As a user, the chat button shows only for a chat-capable product while I am logged in', () => {
    // Given
    fire('dotli:product-loaded', { label: 'app' });

    // Then
    expect(chatButtonVisible()).toBe(false);

    // When
    fire(CHAT_AVAILABILITY_EVENT, { label: 'app', chat: true });

    // Then
    expect(chatButtonVisible()).toBe(false);

    // When
    setLoggedIn(true);

    // Then
    expect(chatButtonVisible()).toBe(true);
  });

  it('As a user, availability for another product is ignored', () => {
    // Given
    showProduct('app');

    // When
    fire(CHAT_AVAILABILITY_EVENT, { label: 'other', chat: false });

    // Then
    expect(chatButtonVisible()).toBe(true);
  });

  it('As a user, the panel closes when the button goes away (logout or product error)', () => {
    // Given
    showProduct('app');
    setChatPanelOpen(true);

    // When
    setLoggedIn(false);

    // Then
    expect(chatPanelStore.get().open).toBe(false);

    // When
    setLoggedIn(true);
    setChatPanelOpen(true);
    fire('dotli:product-error', undefined);

    // Then
    expect(chatPanelStore.get().open).toBe(false);
    expect(currentChatProductId()).toBeNull();
  });

  it('As a user, product messages outside the room I am viewing count as unread, per room', () => {
    // Given
    showProduct('app');

    // When
    productMessage('app', 'a');
    productMessage('app', 'a');
    productMessage('app', 'b');

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ a: 2, b: 1 });
    expect(totalChatUnread()).toBe(3);

    // When: viewing room a, a new message there is seen at once
    setChatPanelOpen(true);
    openChatRoom('a');
    markChatRoomSeen('a');
    productMessage('app', 'a');

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ b: 1 });
  });

  it('As a user, my own messages and messages for another product do not count as unread', () => {
    // Given
    showProduct('app');

    // When
    fire(CHAT_MESSAGE_EVENT, {
      productId: labelToProductId('app'),
      roomId: 'a',
      author: 'user',
    });
    productMessage('other', 'a');

    // Then
    expect(totalChatUnread()).toBe(0);
  });

  it("As a dotli integrator, each message bumps only its own room's sequence, and a room or bot change bumps the contact version", () => {
    // Given
    showProduct('app');
    const before = chatPanelStore.get().contactsVersion;

    // When
    productMessage('app', 'a');
    productMessage('app', 'b');
    fire(CHAT_ROOMS_CHANGED_EVENT, { productId: labelToProductId('app') });
    fire(CHAT_BOTS_CHANGED_EVENT, { productId: labelToProductId('app') });
    fire(CHAT_ROOMS_CHANGED_EVENT, { productId: labelToProductId('other') });

    // Then
    expect(chatPanelStore.get().roomSeq).toEqual({ a: 1, b: 1 });
    expect(chatPanelStore.get().contactsVersion).toBe(before + 2);
  });

  it('As a user, loading a different product resets the open room, unread counts and composer error', () => {
    // Given
    showProduct('app');
    productMessage('app', 'a');
    setChatPanelOpen(true);
    openChatRoom('a');
    setChatComposerError('oops');

    // When
    fire('dotli:product-loaded', { label: 'next', productId: 'next.dot' });

    // Then
    const state = chatPanelStore.get();
    expect(state.activeRoomId).toBeNull();
    expect(state.unreadByRoom).toEqual({});
    expect(state.composerError).toBeNull();
    expect(currentChatProductId()).toBe('next.dot');
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
    expect(localStorage.getItem('dotli:chat-panel-width')).toBe('560');

    // When
    setChatPanelWidth(10);

    // Then
    expect(chatPanelStore.get().width).toBe(280);

    // When
    setChatPanelOpen(true);

    // Then
    expect(chatPanelStore.get().width).toBe(560);
  });

  it('As a user, the topbar visibility is tracked for the panel', () => {
    // When
    setTopbarVisible(false);

    // Then
    expect(chatPanelStore.get().topbarVisible).toBe(false);
  });

  it('As a panel wired after a login, the session and the hidden topbar are already known', () => {
    // Given
    remove();
    setLoggedIn(true);
    setTopbarVisible(false);

    // When
    remove = initChatPanelState();

    // Then
    expect(chatPanelStore.get()).toMatchObject({
      loggedIn: true,
      topbarVisible: false,
    });
  });

  it('As a user, unread counts above nine read 9+', () => {
    expect(chatUnreadLabel(3)).toBe('3');
    expect(chatUnreadLabel(10)).toBe('9+');
  });
});

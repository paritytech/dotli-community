// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ChatButton island beside the ChatDock island, against the page's real chat state: the button shows once the
// product has a room, and opens the drawer it names. A missing binding would fail silently, so these pin the wiring.
// The button's own looks are tested by its story plays.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asProductId } from '@parity/truapi';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { byId } from '@dotli/ui/testing';
import { createChatConnections } from '../../createChatConnections.js';
import { createChatStore, type ChatStore } from '../../createChatStore.js';
import { toProductId } from '../../../../kit/getAskedProductId.js';
import { authState } from '../../../account/session/authState.js';
import { productState } from '../../../page/productState.js';
import { createRecordingConnection } from '../../createChatConnections.fake.js';
import { createMemoryChatRepo } from '../../createChatStore.fake.js';
import { ChatButtonIsland } from '../../ChatButtonIsland.js';
import { ChatDockIsland } from '../../ChatDockIsland.js';
import { chatPanelState } from '../../chatPanelState.js';

const PRODUCT = asProductId(toProductId('chatty'));

let chat: ChatStore;
let stopState: () => void = () => undefined;
let unmount: (() => void) | undefined;

beforeEach(() => {
  const connections = createChatConnections();
  chat = createChatStore({ repo: createMemoryChatRepo(), connections });
  stopState = chatPanelState.start({ chat: () => Promise.resolve(chat), connections });
  connections.register(PRODUCT, createRecordingConnection());
  productState.setLoaded({ label: 'chatty', productId: PRODUCT });
  authState.set({ tag: 'Connected', session: { connected: true } });
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(
    () => (
      <>
        <ChatButtonIsland />
        <ChatDockIsland chat={chat} />
      </>
    ),
    slot,
  );
  flush();
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  stopState();
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('ChatButton island', () => {
  it('As a logged-in user, I see the chat button appear when my product adds its first room', async () => {
    // Given
    const hidden = byId('chat-button').hasAttribute('hidden');

    // When
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });

    // Then
    await waitForDom(() => !byId('chat-button').hasAttribute('hidden'));
    expect(hidden).toBe(true);
  });

  it('As a user, I press the chat button and the drawer it names opens', async () => {
    // Given
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    await waitForDom(() => !byId('chat-button').hasAttribute('hidden'));

    // When
    byId('chat-button').click();

    // Then
    const controlled = byId('chat-button').getAttribute('aria-controls') ?? '';
    await waitForDom(() => document.getElementById(controlled)?.hasAttribute('data-open') ?? false);
    expect(byId('chat-button').getAttribute('aria-expanded')).toBe('true');
  });
});

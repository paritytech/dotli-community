// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createChatPlatform } from './chat.js';
import { createChatConnections, createChatStore } from '../chat/store.js';
import { memoryChatRepo } from '../chat/store.fake.js';
import { createChanges } from '../../testing/changes.js';
import { yielded } from '../../testing/fixtures.js';

const PRODUCT: ProductContext = { productId: 'chatty.dot', executionKind: 'Worker' };
const OTHER: ProductContext = { productId: 'other.dot', executionKind: 'Worker' };

function room(roomId: string): { roomId: string; name: string; icon: string } {
  return { roomId, name: roomId, icon: '' };
}

describe('chat platform', () => {
  it('As a product, I create rooms and my room list stream hears only mine', async () => {
    // Given
    const chat = createChatStore({ repo: memoryChatRepo(), connections: createChatConnections() });
    const platform = createChatPlatform(chat);
    const stream = platform.subscribeChatRooms(PRODUCT)[Symbol.asyncIterator]();
    expect(yielded(await stream.next())._unsafeUnwrap()).toEqual({ rooms: [] });

    // When
    await platform.createChatRoom(OTHER, room('elsewhere'));
    await platform.createChatRoom(PRODUCT, room('main'));

    // Then
    expect(yielded(await stream.next())._unsafeUnwrap()).toEqual({
      rooms: [{ roomId: 'main', participatingAs: 'RoomHost' }],
    });
    await stream.return?.();
  });

  it('As a product, when my rooms change during a read, my stream ends on the newest list after one more read', async () => {
    // Given: a repo whose room reads wait for the test.
    const repo = memoryChatRepo();
    const held: (() => void)[] = [];
    const changes = createChanges();
    let reads = 0;
    const listRooms = repo.listRooms.bind(repo);
    repo.listRooms = async productId => {
      reads += 1;
      const rooms = await listRooms(productId);
      await new Promise<void>(resolve => {
        held.push(resolve);
        changes.notify();
      });
      return rooms;
    };
    const chat = createChatStore({ repo, connections: createChatConnections() });
    const platform = createChatPlatform(chat);
    const stream = platform.subscribeChatRooms(PRODUCT)[Symbol.asyncIterator]();
    const first = stream.next();

    // When: two rooms are created while the first read waits.
    await platform.createChatRoom(PRODUCT, room('a'));
    await platform.createChatRoom(PRODUCT, room('b'));
    held.shift()?.();
    expect(yielded(await first)._unsafeUnwrap()).toEqual({ rooms: [] });
    const second = stream.next();
    await changes.until(() => held.length === 1);
    held.shift()?.();

    // Then
    expect(yielded(await second)._unsafeUnwrap()).toEqual({
      rooms: [
        { roomId: 'a', participatingAs: 'RoomHost' },
        { roomId: 'b', participatingAs: 'RoomHost' },
      ],
    });
    expect(reads).toBe(2);
    await stream.return?.();
  });

  it('As a product that stops listening to its rooms, a read queued behind a running one is not made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // Given: a read that waits for the test, and a change that queues another behind it
      const repo = memoryChatRepo();
      const held: (() => void)[] = [];
      const changes = createChanges();
      let reads = 0;
      const listRooms = repo.listRooms.bind(repo);
      repo.listRooms = async productId => {
        reads += 1;
        const rooms = await listRooms(productId);
        await new Promise<void>(resolve => {
          held.push(resolve);
          changes.notify();
        });
        return rooms;
      };
      const chat = createChatStore({ repo, connections: createChatConnections() });
      const platform = createChatPlatform(chat);
      const stream = platform.subscribeChatRooms(PRODUCT)[Symbol.asyncIterator]();
      await changes.until(() => held.length === 1);
      await platform.createChatRoom(PRODUCT, room('a'));

      // When: the product stops listening, then the running read ends
      await stream.return?.();
      held.shift()?.();
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a product, I register a bot and post a message, and both are stored for my product', async () => {
    // Given
    const repo = memoryChatRepo();
    const platform = createChatPlatform(createChatStore({ repo, connections: createChatConnections() }));

    // When
    const bot = await platform.registerChatBot(PRODUCT, { botId: 'helper', name: 'Helper', icon: '' });
    const posted = await platform.postChatMessage(PRODUCT, {
      roomId: 'helper',
      payload: { tag: 'Text', value: { text: 'hi' } },
    });

    // Then
    expect(bot).toEqual({ status: 'New' });
    expect(repo.messages).toMatchObject([{ productId: 'chatty.dot', roomId: 'helper', messageId: posted.messageId }]);
  });
});

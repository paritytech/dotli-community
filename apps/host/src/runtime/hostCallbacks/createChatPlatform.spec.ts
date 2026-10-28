// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createAsyncTaskPool, type AsyncTaskPool } from '@dotli/shared';
import { createChatPlatform } from './createChatPlatform.js';
import { createChatConnections } from '../chat/createChatConnections.js';
import { createChatStore } from '../chat/createChatStore.js';
import { createMemoryChatRepo } from '../chat/createChatStore.fake.js';
import { yielded } from '../../testing/fixtures.js';

const PRODUCT: ProductContext = { productId: 'chatty.dot', executionKind: 'Worker' };
const OTHER: ProductContext = { productId: 'other.dot', executionKind: 'Worker' };

describe('chat platform', () => {
  it('As a product developer, I create rooms and my room list stream hears only mine', async () => {
    // Given
    const chat = createChatStore({ repo: createMemoryChatRepo(), connections: createChatConnections() });
    const platform = createChatPlatform({ chat });
    const stream = platform.subscribeChatRooms(PRODUCT)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await stream.return?.();
    });
    const initial = await stream.next();

    // When
    await platform.createChatRoom(OTHER, buildRoom('elsewhere'));
    await platform.createChatRoom(PRODUCT, buildRoom('main'));
    const changed = await stream.next();

    // Then
    expect([initial, changed].map(step => yielded(step)._unsafeUnwrap())).toEqual([
      { rooms: [] },
      { rooms: [{ roomId: 'main', participatingAs: 'RoomHost' }] },
    ]);
  });

  it('As a product developer, I set the footer of my room and it is stored on the room', async () => {
    // Given
    const repo = createMemoryChatRepo();
    const platform = createChatPlatform({ chat: createChatStore({ repo, connections: createChatConnections() }) });
    await platform.createChatRoom(PRODUCT, buildRoom('main'));

    // When
    await platform.setChatRoomFooter(PRODUCT, { roomId: 'main', footer: 'Empty' });

    // Then
    expect(repo.rooms).toMatchObject([{ productId: PRODUCT.productId, roomId: 'main', footer: 'Empty' }]);
  });

  it("As a product developer, I set the footer of another product's room and the call fails", async () => {
    // Given
    const repo = createMemoryChatRepo();
    const platform = createChatPlatform({ chat: createChatStore({ repo, connections: createChatConnections() }) });
    await platform.createChatRoom(OTHER, buildRoom('main'));

    // When
    const set = platform.setChatRoomFooter(PRODUCT, { roomId: 'main', footer: 'Empty' });

    // Then
    await expect(set).rejects.toThrow('No chat room main');
    expect(repo.rooms[0]?.footer).toBeUndefined();
  });

  it('As a product developer whose rooms change during a read, I follow my rooms and my stream ends on the newest list after one more read', async () => {
    // Given a repo whose room reads wait for the test
    const repo = createMemoryChatRepo();
    repo.reads.hold.rooms = true;
    const chat = createChatStore({ repo, connections: createChatConnections() });
    const platform = createChatPlatform({ chat });
    const stream = platform.subscribeChatRooms(PRODUCT)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await stream.return?.();
    });
    const first = stream.next();

    // When two rooms are created while the first read waits, and the reads then land
    await platform.createChatRoom(PRODUCT, buildRoom('a'));
    await platform.createChatRoom(PRODUCT, buildRoom('b'));
    repo.reads.releaseOne();
    const firstList = await first;
    const second = stream.next();
    await repo.reads.holding(1);
    repo.reads.releaseOne();
    const secondList = await second;

    // Then
    expect([firstList, secondList].map(step => yielded(step)._unsafeUnwrap())).toEqual([
      { rooms: [] },
      {
        rooms: [
          { roomId: 'a', participatingAs: 'RoomHost' },
          { roomId: 'b', participatingAs: 'RoomHost' },
        ],
      },
    ]);
    expect(repo.reads.count.rooms).toBe(2);
  });

  it('As a product developer, I stop listening to my rooms and a read queued behind a running one is not made', async () => {
    // Given a read that waits for the test, and a change that queues another behind it, on a read pool the test keeps
    const repo = createMemoryChatRepo();
    repo.reads.hold.rooms = true;
    const chat = createChatStore({ repo, connections: createChatConnections() });
    const pools: AsyncTaskPool[] = [];
    const platform = createChatPlatform({
      chat,
      createReadPool() {
        const pool = createAsyncTaskPool({ poolSize: 1 });
        pools.push(pool);
        return pool;
      },
    });
    const stream = platform.subscribeChatRooms(PRODUCT)[Symbol.asyncIterator]();
    await repo.reads.holding(1);
    await platform.createChatRoom(PRODUCT, buildRoom('a'));

    // When the product stops listening, then the running read lands and the read pool settles, with any later read let
    // through at once
    await stream.return?.();
    repo.reads.hold.rooms = false;
    const landed = repo.reads.waitForLanded(1);
    repo.reads.releaseOne();
    await landed;
    await pools[0]?.settle();

    // Then
    expect(repo.reads.count.rooms).toBe(1);
  });

  it('As a product developer, I register a bot and post a message and both are stored for my product', async () => {
    // Given
    const repo = createMemoryChatRepo();
    const platform = createChatPlatform({ chat: createChatStore({ repo, connections: createChatConnections() }) });

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

function buildRoom(roomId: string): { roomId: string; name: string; icon: string } {
  return { roomId, name: roomId, icon: '' };
}

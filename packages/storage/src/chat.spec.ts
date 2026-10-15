// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import { type ChatRecords, createChatRecords } from './chat.js';
import { memoryIdb, type MemoryIdb } from './testing/index.js';
import { abortAtCommit } from './testing/abort-at-commit.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let chat: ChatRecords;

beforeEach(() => {
  idb = memoryIdb();
  chat = createChatRecords(idb);
});

const textContent = (text: string): unknown => ({
  tag: 'Text',
  value: { text },
});

describe('chat rooms', () => {
  it('As a product, creating a room reports New then Exists', async () => {
    // Given
    const room = {
      productId: 'roomstatus.dot',
      roomId: 'main',
      name: 'Main',
      icon: '',
    };

    // When / Then
    expect(await chat.createRoom(room)).toBe('New');
    expect(await chat.createRoom(room)).toBe('Exists');
  });

  it('As a product, I set a room footer and it outlives a re-creation of the room', async () => {
    // Given
    const room = { productId: 'footer.dot', roomId: 'main', name: 'Main', icon: '' };
    await chat.createRoom(room);

    // When
    const found = await chat.setRoomFooter('footer.dot', 'main', 'Empty');
    await chat.createRoom({ ...room, name: 'Renamed' });

    // Then
    expect(found).toBe(true);
    expect(await chat.listRooms('footer.dot')).toEqual([
      expect.objectContaining({ roomId: 'main', name: 'Renamed', footer: 'Empty' }),
    ]);
  });

  it('As a product, I set a footer on a room I never created and nothing is stored', async () => {
    // When
    const found = await chat.setRoomFooter('footer.dot', 'missing', 'Empty');

    // Then
    expect(found).toBe(false);
    expect(await chat.listRooms('footer.dot')).toEqual([]);
  });

  it('As a host, rooms are scoped per product', async () => {
    // Given
    await chat.createRoom({ productId: 'a.dot', roomId: 'r', name: 'A', icon: '' });
    await chat.createRoom({ productId: 'b.dot', roomId: 'r', name: 'B', icon: '' });

    // When
    const rooms = await chat.listRooms('a.dot');

    // Then
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.name).toBe('A');
  });

  it('As a product, I create a room the browser cannot store and the creation rejects rather than hangs', async () => {
    // Given an icon structured clone refuses, so the put inside the transaction throws and aborts it
    const room = { productId: 'abort.dot', roomId: 'main', name: 'Main', icon: (() => '') as unknown as string };

    // When
    const created = chat.createRoom(room);

    // Then
    await expect(created).rejects.toMatchObject({ name: 'AbortError' });
    expect(await chat.listRooms('abort.dot')).toEqual([]);
  });
});

describe('chat messages', () => {
  it('As a host, messages come back in insertion order per room', async () => {
    // Given
    const base = {
      productId: 'order.dot',
      author: 'product' as const,
      timestamp: 1,
    };
    await chat.appendMessage({
      ...base,
      roomId: 'main',
      messageId: 'm1',
      content: textContent('first'),
    });
    await chat.appendMessage({
      ...base,
      roomId: 'other',
      messageId: 'm2',
      content: textContent('elsewhere'),
    });
    await chat.appendMessage({
      ...base,
      roomId: 'main',
      messageId: 'm3',
      author: 'user',
      content: textContent('second'),
    });

    // When
    const messages = await chat.listMessages('order.dot', 'main');

    // Then
    expect(messages.map(m => m.messageId)).toEqual(['m1', 'm3']);
    expect(messages[1]?.author).toBe('user');
  });

  it('As a host, the message list caps at the latest `limit` entries', async () => {
    // Given
    for (let i = 0; i < 5; i++) {
      await chat.appendMessage({
        productId: 'cap.dot',
        roomId: 'main',
        messageId: `m${String(i)}`,
        author: 'product',
        content: textContent(String(i)),
        timestamp: i,
      });
    }

    // When
    const messages = await chat.listMessages('cap.dot', 'main', 2);

    // Then
    expect(messages.map(m => m.messageId)).toEqual(['m3', 'm4']);
  });

  it('As a product, a message the browser refuses at commit fails to send and is not listed', async () => {
    // Given a database that refuses every commit, as a full quota does
    const refusing = createChatRecords(memoryIdb({ onTransaction: abortAtCommit }));

    // When
    const sent = refusing.appendMessage({
      productId: 'quota.dot',
      roomId: 'main',
      messageId: 'm1',
      author: 'user',
      content: textContent('kept?'),
      timestamp: 1,
    });

    // Then
    await expect(sent).rejects.toBeInstanceOf(Error);
    expect(await refusing.listMessages('quota.dot', 'main')).toEqual([]);
  });
});

describe('chat bots', () => {
  it('As a product, registering a bot reports New then Exists', async () => {
    // Given
    const bot = {
      productId: 'botstatus.dot',
      botId: 'echo',
      name: 'Echo',
      icon: '',
    };

    // When / Then
    expect(await chat.registerBot(bot)).toBe('New');
    expect(await chat.registerBot(bot)).toBe('Exists');
  });

  it('As a product, re-registering refreshes the stored name and icon', async () => {
    // Given
    await chat.registerBot({
      productId: 'refresh.dot',
      botId: 'echo',
      name: 'Echo',
      icon: '',
    });
    await chat.registerBot({
      productId: 'refresh.dot',
      botId: 'echo',
      name: 'Echo v2',
      icon: 'https://example.com/icon.png',
    });

    // When
    const bots = await chat.listBots('refresh.dot');

    // Then
    expect(bots).toHaveLength(1);
    expect(bots[0]?.name).toBe('Echo v2');
    expect(bots[0]?.icon).toBe('https://example.com/icon.png');
  });

  it('As a host, bots are scoped per product', async () => {
    // Given
    await chat.registerBot({ productId: 'a.dot', botId: 'b', name: 'A', icon: '' });
    await chat.registerBot({ productId: 'b.dot', botId: 'b', name: 'B', icon: '' });

    // When
    const bots = await chat.listBots('a.dot');

    // Then
    expect(bots).toHaveLength(1);
    expect(bots[0]?.name).toBe('A');
  });
});

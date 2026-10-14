// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { RendererNode } from '@parity/truapi';
import { createChatConnections, createChatStore, type ChatChange } from './store.js';
import { memoryChatRepo, recordingConnection } from './store.fake.js';
import { createChanges } from '../../testing/changes.js';

const captured: string[] = [];
bindCaptureSink({
  exception: (_error: unknown, ctx: { step: string }) => {
    captured.push(ctx.step);
  },
  expected: () => undefined,
});

const PRODUCT = 'chatty.dot';

function setup(): {
  repo: ReturnType<typeof memoryChatRepo>;
  chat: ReturnType<typeof createChatStore>;
  connections: ReturnType<typeof createChatConnections>;
  changes: ChatChange[];
} {
  const repo = memoryChatRepo();
  const connections = createChatConnections();
  const chat = createChatStore({ repo, connections });
  const changes: ChatChange[] = [];
  chat.subscribe(change => changes.push(change));
  return { repo, chat, connections, changes };
}

describe('chat store', () => {
  it('As a product, I create a room, register a bot and post a message, and each write is stored before it is announced', async () => {
    // Given
    const { repo, chat, changes } = setup();
    const storedWhenAnnounced: number[] = [];
    chat.subscribe(() => storedWhenAnnounced.push(repo.rooms.length + repo.bots.length + repo.messages.length));

    // When
    const room = await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    const again = await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Renamed', icon: '' });
    const bot = await chat.registerBot(PRODUCT, { botId: 'helper', name: 'Helper', icon: '' });
    const messageId = await chat.postProductMessage(PRODUCT, 'main', { tag: 'Text', value: { text: 'hi' } });

    // Then
    expect([room, again, bot]).toEqual(['New', 'Exists', 'New']);
    expect(await chat.rooms(PRODUCT)).toMatchObject([{ roomId: 'main', name: 'Renamed' }]);
    expect(repo.messages).toMatchObject([{ messageId, author: 'product' }]);
    expect(changes).toEqual([
      { kind: 'rooms', productId: PRODUCT },
      { kind: 'rooms', productId: PRODUCT },
      { kind: 'bots', productId: PRODUCT },
      { kind: 'message', productId: PRODUCT, roomId: 'main', author: 'product' },
    ]);
    expect(storedWhenAnnounced).toEqual([1, 1, 2, 3]);
  });

  it('As a user, I reply and my message is stored, announced and published to the product', async () => {
    // Given
    const { repo, chat, connections, changes } = setup();
    const connection = recordingConnection();
    connections.register(PRODUCT, connection);

    // When
    await chat.postUserMessage(PRODUCT, 'main', 'hello');

    // Then
    expect(repo.messages).toMatchObject([{ author: 'user', content: { tag: 'Text', value: { text: 'hello' } } }]);
    expect(changes).toEqual([{ kind: 'message', productId: PRODUCT, roomId: 'main', author: 'user' }]);
    expect(connection.published).toEqual([
      {
        roomId: 'main',
        peer: 'user',
        payload: { tag: 'MessagePosted', value: { tag: 'Text', value: { text: 'hello' } } },
      },
    ]);
  });

  it('As a user without a live connection, my reply is refused and nothing is stored', async () => {
    // Given
    const { repo, chat, changes } = setup();

    // When
    const reply = chat.postUserMessage(PRODUCT, 'main', 'hello');

    // Then
    await expect(reply).rejects.toThrow('Chat is not connected for this product');
    expect(repo.messages).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('As a user whose product cannot be reached, my reply stays stored and the failure surfaces', async () => {
    // Given
    const { repo, chat, connections } = setup();
    connections.register(PRODUCT, recordingConnection({ fails: true }));

    // When
    const reply = chat.postUserMessage(PRODUCT, 'main', 'hello');

    // Then
    await expect(reply).rejects.toThrow('product unreachable');
    expect(repo.messages).toHaveLength(1);
  });

  it('As a user, my taps reach the product only while it is connected', async () => {
    // Given
    const { chat, connections } = setup();
    const connection = recordingConnection();
    const unregister = connections.register(PRODUCT, connection);
    const item = {
      context: { tag: 'ChatMessage' as const, value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
      actionId: 'vote',
      payload: '0x' as const,
    };

    // When
    await chat.triggerAction(PRODUCT, 'main', { messageId: 'm1', actionId: 'yes' });
    await chat.triggerRendererAction(PRODUCT, item);
    unregister();

    // Then
    expect(connection.published).toEqual([
      {
        roomId: 'main',
        peer: 'user',
        payload: { tag: 'ActionTriggered', value: { messageId: 'm1', actionId: 'yes' } },
      },
    ]);
    expect(connection.rendererActions).toEqual([item]);
    await expect(chat.triggerAction(PRODUCT, 'main', { messageId: 'm1', actionId: 'yes' })).rejects.toThrow(
      'Chat is not connected for this product',
    );
  });

  it('As the bridge, a stale unregister after a newer registration leaves the newer connection live', async () => {
    // Given
    const { chat, connections } = setup();
    const unregisterOld = connections.register(PRODUCT, recordingConnection());
    const fresh = recordingConnection();
    connections.register(PRODUCT, fresh);

    // When
    unregisterOld();
    await chat.triggerAction(PRODUCT, 'main', { messageId: 'm1', actionId: 'yes' });

    // Then
    expect(fresh.published).toHaveLength(1);
  });

  it('As a user without a live connection, a custom message fails its render at once', () => {
    // Given
    const { chat } = setup();
    const errors: unknown[] = [];

    // When
    chat.renderCustomMessage(
      PRODUCT,
      {
        context: { tag: 'ChatMessage', value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
        payload: '0x01',
      },
      { onUpdate: (_node: RendererNode) => undefined, onError: error => errors.push(error) },
    );

    // Then
    expect(errors).toHaveLength(1);
  });

  it('As a product, my write succeeds even when a subscriber throws, and the failure is reported', async () => {
    // Given
    const { chat, changes } = setup();
    captured.length = 0;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    chat.subscribe(() => {
      throw new Error('broken panel');
    });

    // When
    const status = await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });

    // Then
    expect(status).toBe('New');
    expect(changes).toHaveLength(1);
    expect(captured).toEqual(['listener']);
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'chat_store.change' },
    ]);
  });
});

/** Counts the room list and conversation reads, and holds each one while `hold` is set. */
function gatedReads(repo: ReturnType<typeof memoryChatRepo>): {
  reads: { contacts: number; messages: number };
  hold: boolean;
  held: (() => void)[];
  failing: boolean;
  /** Resolves once `count` reads are held. */
  holding: (count: number) => Promise<void>;
} {
  const changes = createChanges();
  const gate = {
    reads: { contacts: 0, messages: 0 },
    hold: false,
    held: [] as (() => void)[],
    failing: false,
    holding: (count: number) => changes.until(() => gate.held.length === count),
  };
  const wait = async (): Promise<void> => {
    if (gate.hold) {
      await new Promise<void>(resolve => {
        gate.held.push(resolve);
        changes.notify();
      });
    }
    if (gate.failing) {
      throw new Error('IndexedDB is gone');
    }
  };
  const listRooms = repo.listRooms.bind(repo);
  const listMessages = repo.listMessages.bind(repo);
  repo.listRooms = async productId => {
    gate.reads.contacts += 1;
    const rooms = await listRooms(productId);
    await wait();
    return rooms;
  };
  repo.listMessages = async (productId, roomId) => {
    gate.reads.messages += 1;
    const messages = await listMessages(productId, roomId);
    await wait();
    return messages;
  };
  return gate;
}

const TEXT = { tag: 'Text', value: { text: 'hi' } } as const;

describe('chat store view', () => {
  it('As the open panel, I follow a product and see its rooms, bots and message times', async () => {
    // Given
    const { chat } = setup();
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    await chat.registerBot(PRODUCT, { botId: 'helper', name: 'Helper', icon: '' });
    await chat.postProductMessage(PRODUCT, 'main', TEXT);

    // When
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    const { contacts } = chat.view.get();
    expect(contacts?.rooms.map(room => room.roomId)).toEqual(['main']);
    expect(contacts?.bots.map(bot => bot.botId)).toEqual(['helper']);
    expect([...(contacts?.lastMessageTimes.keys() ?? [])]).toEqual(['main']);
  });

  it('As the open panel, I follow the same target twice and it is read once', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(gate.reads).toEqual({ contacts: 1, messages: 1 });
  });

  it('As the open panel on a conversation, a message there re-reads only it, and one elsewhere re-reads the list once I go back', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await chat.postProductMessage(PRODUCT, 'side', TEXT);
    await chat.settle();

    // Then
    expect(gate.reads).toEqual({ contacts: 1, messages: 2 });
    expect(chat.view.get().messages).toHaveLength(1);

    // When
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    expect(gate.reads).toEqual({ contacts: 2, messages: 2 });
    expect(chat.view.get().messages).toBeNull();
  });

  it('As the open panel on the room list, a message or a room change re-reads the list, and going back with nothing missed reads nothing', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // When
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await chat.settle();
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    await chat.settle();
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    expect(gate.reads).toEqual({ contacts: 3, messages: 1 });
  });

  it('As the open panel, a reload of the same product reads the room list again', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 2 });
    await chat.settle();

    // Then
    expect(gate.reads).toEqual({ contacts: 2, messages: 1 });
  });

  it('As the open panel, when the rooms change during a read, the list ends on the newest rooms after one more read', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    gate.hold = true;
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });

    // When: two rooms are created while the first read waits.
    await chat.createRoom(PRODUCT, { roomId: 'a', name: 'A', icon: '' });
    await chat.createRoom(PRODUCT, { roomId: 'b', name: 'B', icon: '' });
    gate.hold = false;
    gate.held.shift()?.();
    await chat.settle();

    // Then
    expect(gate.reads.contacts).toBe(2);
    expect(chat.view.get().contacts?.rooms.map(room => room.roomId)).toEqual(['a', 'b']);
  });

  it('As the panel that closed, a read that lands late changes nothing', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    gate.hold = true;
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await gate.holding(2);

    // When
    chat.follow(null);
    gate.held.splice(0).forEach(release => {
      release();
    });
    await chat.settle();

    // Then
    expect(chat.view.get()).toEqual({
      productId: null,
      contacts: null,
      contactsFailed: false,
      roomId: null,
      messages: null,
      messagesFailed: false,
    });
  });

  it('As the open panel, a failed read is reported and says so until a read works, keeping what it showed', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();
    captured.length = 0;

    // When
    gate.failing = true;
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(true);
    expect(chat.view.get().contacts?.rooms).toHaveLength(1);
    expect(captured).toEqual(['chat_contacts_read']);

    // When
    gate.failing = false;
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(false);
  });

  it('As the open panel, a failed read for a product I have left is still reported and leaves my view alone', async () => {
    // Given
    const { repo, chat } = setup();
    await chat.createRoom('other.dot', { roomId: 'side', name: 'Side', icon: '' });
    const listRooms = repo.listRooms.bind(repo);
    let failFirst: (error: Error) => void = () => undefined;
    let reads = 0;
    repo.listRooms = productId => {
      reads += 1;
      if (reads === 1) {
        return new Promise((_, reject) => {
          failFirst = reject;
        });
      }
      return listRooms(productId);
    };
    captured.length = 0;
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    chat.follow({ productId: 'other.dot', roomId: null, loadId: 2 });

    // When
    failFirst(new Error('IndexedDB is gone'));
    await chat.settle();

    // Then
    expect(captured).toEqual(['chat_contacts_read']);
    expect(chat.view.get().contactsFailed).toBe(false);
    expect(chat.view.get().contacts?.rooms.map(room => room.roomId)).toEqual(['side']);
  });

  it('As the open panel, following another product shows none of the first one', async () => {
    // Given
    const { chat } = setup();
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When
    chat.follow({ productId: 'other.dot', roomId: null, loadId: 2 });

    // Then
    expect(chat.view.get()).toMatchObject({ productId: 'other.dot', contacts: null, messages: null });
    await chat.settle();
    expect(chat.view.get().contacts?.rooms).toEqual([]);
  });
});

/** Fails the room list or the conversation reads while their flag is set. */
function failingReads(repo: ReturnType<typeof memoryChatRepo>): { rooms: boolean; messages: boolean } {
  const fail = { rooms: false, messages: false };
  const listRooms = repo.listRooms.bind(repo);
  const listMessages = repo.listMessages.bind(repo);
  repo.listRooms = productId => (fail.rooms ? Promise.reject(new Error('IndexedDB is gone')) : listRooms(productId));
  repo.listMessages = (productId, roomId) =>
    fail.messages ? Promise.reject(new Error('IndexedDB is gone')) : listMessages(productId, roomId);
  return fail;
}

describe('chat store view, failed reads', () => {
  it('As the open panel, a conversation that cannot be read is reported and says so', async () => {
    // Given
    const { repo, chat } = setup();
    const fail = failingReads(repo);
    fail.messages = true;
    captured.length = 0;

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(chat.view.get()).toMatchObject({ messagesFailed: true, contactsFailed: false });
    expect(captured).toEqual(['chat_messages_read']);
  });

  it('As the open panel back on a working list, a conversation that could not be read no longer says so', async () => {
    // Given
    const { repo, chat } = setup();
    const gate = gatedReads(repo);
    const fail = failingReads(repo);
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();
    fail.messages = true;
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();
    expect(chat.view.get().messagesFailed).toBe(true);
    const reads = gate.reads.contacts;

    // When: back to the list, which missed nothing.
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    expect(gate.reads.contacts).toBe(reads);
    expect(chat.view.get()).toMatchObject({ messagesFailed: false, contactsFailed: false });
  });

  it('As the open panel, a conversation that could not be read stops saying so once it can be', async () => {
    // Given
    const { repo, chat } = setup();
    const fail = failingReads(repo);
    fail.messages = true;
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When: a new message, and this time the read works.
    fail.messages = false;
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await chat.settle();

    // Then
    expect(chat.view.get().messagesFailed).toBe(false);
    expect(chat.view.get().messages).toHaveLength(1);
  });

  it('As the open panel, a room list that could not be re-read keeps saying so until it can be, whatever the conversation reads', async () => {
    // Given: the list shows, then a re-read of it fails.
    const { repo, chat } = setup();
    const fail = failingReads(repo);
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();
    fail.rooms = true;
    await chat.postProductMessage(PRODUCT, 'side', TEXT);
    await chat.settle();
    expect(chat.view.get().contactsFailed).toBe(true);

    // When: a conversation is read fine.
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(chat.view.get().messages).toHaveLength(1);
    expect(chat.view.get().contactsFailed).toBe(true);

    // When: back on the list, a message and a re-read that works.
    fail.rooms = false;
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.postProductMessage(PRODUCT, 'side', TEXT);
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(false);
  });
});

describe('chat store view, message reads', () => {
  it('As the open panel, when messages arrive during a conversation read, the conversation ends on the newest messages after one more read', async () => {
    // Given: a room open, and reads that wait for the test.
    const { repo, chat } = setup();
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    const gate = gatedReads(repo);
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();
    gate.hold = true;
    const start = gate.reads.messages;

    // When: two messages arrive while the first read waits.
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await chat.postProductMessage(PRODUCT, 'main', TEXT);
    await gate.holding(1);
    gate.hold = false;
    gate.held.shift()?.();
    await chat.settle();

    // Then
    expect(gate.reads.messages - start).toBe(2);
    expect(chat.view.get().messages).toHaveLength(3);
  });
});

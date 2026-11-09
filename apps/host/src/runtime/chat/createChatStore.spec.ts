// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { IdbOpenBlockedError } from '@dotli/shared';
import { createManualTimers } from '@dotli/shared/testing';
import type { RendererNode } from '@parity/truapi';
import { createChatConnections } from './createChatConnections.js';
import { createChatStore, type ChatChange } from './createChatStore.js';
import { createRecordingConnection, type RecordedRender } from './createChatConnections.fake.js';
import { createMemoryChatRepo } from './createChatStore.fake.js';

const PRODUCT = 'chatty.dot';
const GONE = new Error('IndexedDB is gone');
const NOW = 1_700_000_000_000;

function setup(): {
  repo: ReturnType<typeof createMemoryChatRepo>;
  chat: ReturnType<typeof createChatStore>;
  connections: ReturnType<typeof createChatConnections>;
  changes: ChatChange[];
  /** The step of every exception reported while the test runs. */
  captured: string[];
} {
  const captured: string[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (_error: unknown, context: { step: string }) => {
        captured.push(context.step);
      },
      expected: () => undefined,
    }),
  );
  const repo = createMemoryChatRepo();
  const connections = createChatConnections();
  const chat = createChatStore({ repo, connections, timers: createManualTimers({ start: NOW }) });
  const changes: ChatChange[] = [];
  chat.subscribe(change => changes.push(change));
  return { repo, chat, connections, changes, captured };
}

/** A custom message's render request and a sink that records what reaches it. */
function openCustomMessage(chat: ReturnType<typeof createChatStore>) {
  const heard: { updates: RendererNode[]; errors: unknown[]; completed: number } = {
    updates: [],
    errors: [],
    completed: 0,
  };
  const stop = chat.renderCustomMessage({
    productId: PRODUCT,
    request: {
      context: { tag: 'ChatMessage', value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
      payload: '0x01',
    },
    sink: {
      onUpdate: node => heard.updates.push(node),
      onError: error => heard.errors.push(error),
      onComplete: () => {
        heard.completed += 1;
      },
    },
  });
  return { heard, stop };
}

/** The connection's render at `index`, which the spec expects to exist. */
function getRender(connection: { renders: RecordedRender[] }, index: number): RecordedRender {
  const render = connection.renders[index];
  if (render === undefined) {
    throw new Error(`No render ${String(index)} on the connection`);
  }
  return render;
}

const TREE: RendererNode = {
  tag: 'Text',
  value: { modifiers: [], props: {}, children: [{ tag: 'String', value: { text: 'Poll results' } }] },
};

describe('chat store', () => {
  it('As a product developer, I create a room, register a bot and post a message and each write is stored before it is announced', async () => {
    // Given
    const { repo, chat, changes } = setup();
    const storedWhenAnnounced: number[] = [];
    chat.subscribe(() => storedWhenAnnounced.push(repo.rooms.length + repo.bots.length + repo.messages.length));

    // When
    const room = await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    const again = await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Renamed', icon: '' });
    const bot = await chat.registerBot(PRODUCT, { botId: 'helper', name: 'Helper', icon: '' });
    const messageId = await chat.postProductMessage({
      productId: PRODUCT,
      roomId: 'main',
      content: { tag: 'Text', value: { text: 'hi' } },
    });
    const rooms = await chat.listRooms(PRODUCT);

    // Then
    expect([room, again, bot]).toEqual(['New', 'Exists', 'New']);
    expect(rooms).toMatchObject([{ roomId: 'main', name: 'Renamed' }]);
    expect(repo.messages).toMatchObject([{ messageId, author: 'product', timestamp: NOW }]);
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
    const connection = createRecordingConnection();
    connections.register(PRODUCT, connection);

    // When
    await chat.postUserMessage({ productId: PRODUCT, roomId: 'main', text: 'hello' });

    // Then
    expect(repo.messages).toMatchObject([
      { author: 'user', content: { tag: 'Text', value: { text: 'hello' } }, timestamp: NOW },
    ]);
    expect(changes).toEqual([{ kind: 'message', productId: PRODUCT, roomId: 'main', author: 'user' }]);
    expect(connection.published).toEqual([
      {
        roomId: 'main',
        peer: 'user',
        payload: { tag: 'MessagePosted', value: { tag: 'Text', value: { text: 'hello' } } },
      },
    ]);
  });

  it('As a user without a live connection, I reply and my reply is refused with nothing stored', async () => {
    // Given
    const { repo, chat, changes } = setup();

    // When
    const reply = chat.postUserMessage({ productId: PRODUCT, roomId: 'main', text: 'hello' });

    // Then
    await expect(reply).rejects.toThrow('Chat is not connected for this product');
    expect(repo.messages).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('As a user whose product cannot be reached, I reply and my reply stays stored while the failure surfaces', async () => {
    // Given
    const { repo, chat, connections } = setup();
    connections.register(PRODUCT, createRecordingConnection({ fails: true }));

    // When
    const reply = chat.postUserMessage({ productId: PRODUCT, roomId: 'main', text: 'hello' });

    // Then
    await expect(reply).rejects.toThrow('product unreachable');
    expect(repo.messages).toHaveLength(1);
  });

  it('As a user, I tap while the product is connected and my taps reach it', async () => {
    // Given
    const { chat, connections } = setup();
    const connection = createRecordingConnection();
    connections.register(PRODUCT, connection);
    const item = {
      context: { tag: 'ChatMessage' as const, value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
      actionId: 'vote',
      payload: '0x' as const,
    };

    // When
    await chat.triggerAction({ productId: PRODUCT, roomId: 'main', trigger: { messageId: 'm1', actionId: 'yes' } });
    await chat.triggerRendererAction(PRODUCT, item);

    // Then
    expect(connection.published).toEqual([
      {
        roomId: 'main',
        peer: 'user',
        payload: { tag: 'ActionTriggered', value: { messageId: 'm1', actionId: 'yes' } },
      },
    ]);
    expect(connection.rendererActions).toEqual([item]);
  });

  it('As a user, I tap after the product disconnected and my tap is refused', async () => {
    // Given
    const { chat, connections } = setup();
    const unregister = connections.register(PRODUCT, createRecordingConnection());
    unregister();

    // When
    const tap = chat.triggerAction({
      productId: PRODUCT,
      roomId: 'main',
      trigger: { messageId: 'm1', actionId: 'yes' },
    });

    // Then
    await expect(tap).rejects.toThrow('Chat is not connected for this product');
  });

  it('As a dotli integrator, I run a stale unregister after a newer registration and the newer connection stays live', async () => {
    // Given
    const { chat, connections } = setup();
    const unregisterOld = connections.register(PRODUCT, createRecordingConnection());
    const fresh = createRecordingConnection();
    connections.register(PRODUCT, fresh);

    // When
    unregisterOld();
    await chat.triggerAction({ productId: PRODUCT, roomId: 'main', trigger: { messageId: 'm1', actionId: 'yes' } });

    // Then
    expect(fresh.published).toHaveLength(1);
  });

  it('As a user without a live connection, I open a custom message and its render fails at once', () => {
    // Given
    const { chat } = setup();
    const errors: unknown[] = [];

    // When
    chat.renderCustomMessage({
      productId: PRODUCT,
      request: {
        context: { tag: 'ChatMessage', value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
        payload: '0x01',
      },
      sink: { onUpdate: (_node: RendererNode) => undefined, onError: error => errors.push(error) },
    });

    // Then
    expect(errors).toEqual([new Error('Chat is not connected for this product')]);
  });

  it('As a user reading a custom message, I see its frame rebuilt and the message renders again on the new connection at once', () => {
    // Given a message rendering on the old frame's connection while the rebuilt frame registers its own
    const { chat, connections } = setup();
    const old = createRecordingConnection();
    connections.register(PRODUCT, old);
    const { heard } = openCustomMessage(chat);
    const rebuilt = createRecordingConnection();
    connections.register(PRODUCT, rebuilt);

    // When the old provider is disposed
    getRender(old, 0).sink.onError?.(new Error('provider disposed'));
    getRender(rebuilt, 0).sink.onUpdate(TREE);

    // Then
    expect(heard.errors).toEqual([new Error('provider disposed')]);
    expect(old.renders).toHaveLength(1);
    expect(rebuilt.renders).toHaveLength(1);
    expect(heard.updates).toEqual([TREE]);
  });

  it('As a user reading a custom message, I see its core die and the message renders again once the replacement registers', () => {
    // Given a message whose render the dead core failed
    const { chat, connections } = setup();
    const dead = createRecordingConnection();
    connections.register(PRODUCT, dead);
    openCustomMessage(chat);
    getRender(dead, 0).sink.onError?.(new Error('provider disposed'));
    const rendersBeforeReplacement = dead.renders.length;
    const replacement = createRecordingConnection();

    // When
    connections.register(PRODUCT, replacement);

    // Then
    expect(rendersBeforeReplacement).toBe(1);
    expect(replacement.renders).toHaveLength(1);
  });

  it("As a user, I open a custom message before the product connects and it renders once the product's connection registers", () => {
    // Given a message opened with no connection
    const { chat, connections } = setup();
    const { heard } = openCustomMessage(chat);
    const errorsBeforeConnection = [...heard.errors];
    const connection = createRecordingConnection();

    // When
    connections.register(PRODUCT, connection);

    // Then
    expect(errorsBeforeConnection).toEqual([new Error('Chat is not connected for this product')]);
    expect(connection.renders).toHaveLength(1);
  });

  it('As a user, I read a custom message whose connections cannot render and it fails once per connection and waits', () => {
    // Given a message opened on a connection that cannot render
    const { chat, connections } = setup();
    const first = createRecordingConnection({ failsRender: true });
    connections.register(PRODUCT, first);
    const { heard } = openCustomMessage(chat);
    const errorsOnFirst = [...heard.errors];
    const rendersOnFirst = first.renders.length;
    const second = createRecordingConnection({ failsRender: true });

    // When
    connections.register(PRODUCT, second);

    // Then
    expect(errorsOnFirst).toEqual([new Error('rendering unavailable')]);
    expect(rendersOnFirst).toBe(1);
    expect(second.renders).toHaveLength(1);
    expect(first.renders).toHaveLength(1);
    expect(heard.errors).toHaveLength(2);
  });

  it('As a user, I read a custom message that completed and no later connection renders it again', () => {
    // Given a message whose render completed
    const { chat, connections } = setup();
    const first = createRecordingConnection();
    connections.register(PRODUCT, first);
    const { heard } = openCustomMessage(chat);
    getRender(first, 0).sink.onComplete?.();
    const second = createRecordingConnection();

    // When
    connections.register(PRODUCT, second);

    // Then
    expect(heard.completed).toBe(1);
    expect(second.renders).toHaveLength(0);
  });

  it('As a user, I scroll a custom message off the page and nothing renders it after while a late tree reaches no one', () => {
    // Given a message that showed a tree
    const { chat, connections } = setup();
    const first = createRecordingConnection();
    connections.register(PRODUCT, first);
    const { heard, stop } = openCustomMessage(chat);
    getRender(first, 0).sink.onUpdate(TREE);
    const second = createRecordingConnection();

    // When it scrolls off, then a late tree arrives and another connection registers
    stop();
    getRender(first, 0).sink.onUpdate(TREE);
    connections.register(PRODUCT, second);

    // Then
    expect(getRender(first, 0).stopped).toBe(true);
    expect(heard.updates).toEqual([TREE]);
    expect(second.renders).toHaveLength(0);
  });

  it('As a user, I scroll a custom message off the page while it waits and no later connection renders it', () => {
    // Given a message waiting for a connection
    const { chat, connections } = setup();
    const { stop } = openCustomMessage(chat);
    const connection = createRecordingConnection();

    // When it scrolls off, then a connection registers
    stop();
    connections.register(PRODUCT, connection);

    // Then
    expect(connection.renders).toHaveLength(0);
  });

  it('As a user, I scroll a custom message off the page as its render fails and nothing renders it after', () => {
    // Given a message whose row stops it when it hears the error, while a rebuilt frame registered
    const { chat, connections } = setup();
    const first = createRecordingConnection();
    connections.register(PRODUCT, first);
    const stop = chat.renderCustomMessage({
      productId: PRODUCT,
      request: {
        context: { tag: 'ChatMessage', value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
        payload: '0x01',
      },
      sink: {
        onUpdate: (_node: RendererNode) => undefined,
        onError: () => {
          stop();
        },
      },
    });
    const rebuilt = createRecordingConnection();
    connections.register(PRODUCT, rebuilt);

    // When the old render fails
    getRender(first, 0).sink.onError?.(new Error('provider disposed'));

    // Then
    expect(rebuilt.renders).toHaveLength(0);
  });

  it('As a user, I read a custom message while a connection registers for another product and it does not render it', () => {
    // Given a message waiting for its product's connection
    const { chat, connections } = setup();
    openCustomMessage(chat);
    const other = createRecordingConnection();

    // When
    connections.register('other.dot', other);

    // Then
    expect(other.renders).toHaveLength(0);
  });

  it('As a product developer, I write while a subscriber throws and my write succeeds while the failure is reported', async () => {
    // Given
    const { chat, changes, captured } = setup();
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

  it('As a product developer, I list my rooms while the store cannot read them and the failure is reported and counted while my call still rejects', async () => {
    // Given a store whose room list reads fail
    const { repo, chat, captured } = setup();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    repo.reads.error.rooms = GONE;

    // When
    const listing = chat.listRooms(PRODUCT);

    // Then
    await expect(listing).rejects.toBe(GONE);
    expect(captured).toEqual(['chat_rooms_read']);
    expect(sentry.counted('chat.read')).toEqual([{ outcome: 'error', reason: GONE.name }]);
  });
});

const TEXT = { tag: 'Text', value: { text: 'hi' } } as const;

describe('chat store view', () => {
  it('As a user with the chat panel open, I follow a product and see its rooms, bots and message times', async () => {
    // Given
    const { chat } = setup();
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    await chat.registerBot(PRODUCT, { botId: 'helper', name: 'Helper', icon: '' });
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });

    // When
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();
    const { contacts } = chat.view.get();

    // Then
    expect(contacts?.rooms.map(room => room.roomId)).toEqual(['main']);
    expect(contacts?.bots.map(bot => bot.botId)).toEqual(['helper']);
    expect([...(contacts?.lastMessageTimes.keys() ?? [])]).toEqual(['main']);
  });

  it('As a user with the chat panel open, I follow the same target twice and it is read once', async () => {
    // Given
    const { repo, chat } = setup();

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(repo.reads.count).toEqual({ rooms: 1, messages: 1 });
  });

  it('As a user on a conversation, I get a message there and one elsewhere and only the conversation is read until I go back to the list', async () => {
    // Given
    const { repo, chat } = setup();
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'side', content: TEXT });
    await chat.settle();

    // Then
    expect(repo.reads.count).toEqual({ rooms: 1, messages: 2 });
    expect(chat.view.get().messages).toHaveLength(1);

    // When
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    expect(repo.reads.count).toEqual({ rooms: 2, messages: 2 });
    expect(chat.view.get().messages).toBeNull();
  });

  it('As a user on the room list, I get a message and a room change and the list is read again for each but not when I come back with nothing missed', async () => {
    // Given
    const { repo, chat } = setup();
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // When
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await chat.settle();
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    await chat.settle();
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    expect(repo.reads.count).toEqual({ rooms: 3, messages: 1 });
  });

  it('As a user with the chat panel open, I reload the same product and the room list is read again', async () => {
    // Given
    const { repo, chat } = setup();
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 2 });
    await chat.settle();

    // Then
    expect(repo.reads.count).toEqual({ rooms: 2, messages: 1 });
  });

  it('As a user with the chat panel open, I see rooms change during a read and the list ends on the newest rooms after one more read', async () => {
    // Given
    const { repo, chat } = setup();
    repo.reads.hold.rooms = true;
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });

    // When: two rooms are created while the first read waits.
    await chat.createRoom(PRODUCT, { roomId: 'a', name: 'A', icon: '' });
    await chat.createRoom(PRODUCT, { roomId: 'b', name: 'B', icon: '' });
    repo.reads.hold.rooms = false;
    repo.reads.releaseOne();
    await chat.settle();

    // Then
    expect(repo.reads.count.rooms).toBe(2);
    expect(chat.view.get().contacts?.rooms.map(room => room.roomId)).toEqual(['a', 'b']);
  });

  it('As a user who closed the chat panel, I let a late read land and nothing changes', async () => {
    // Given
    const { repo, chat } = setup();
    repo.reads.hold = { rooms: true, messages: true };
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await repo.reads.holding(2);

    // When
    chat.follow(null);
    repo.reads.releaseAll();
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

  it('As a user with the chat panel open, I hit a failed read and see it reported and flagged until a read works while I keep what was shown', async () => {
    // Given
    const { repo, chat, captured } = setup();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // When
    repo.reads.error = { rooms: GONE, messages: GONE };
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(true);
    expect(chat.view.get().contacts?.rooms).toHaveLength(1);
    expect(captured).toEqual(['chat_contacts_read']);
    expect(sentry.counted('chat.read')).toEqual([{ outcome: 'error', reason: GONE.name }]);

    // When
    repo.reads.error = { rooms: null, messages: null };
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(false);
  });

  it('As a user with the chat panel open, I leave a product whose read then fails and the failure is reported while my view is left alone', async () => {
    // Given
    const { repo, chat, captured } = setup();
    await chat.createRoom('other.dot', { roomId: 'side', name: 'Side', icon: '' });
    repo.reads.hold.rooms = true;
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    chat.follow({ productId: 'other.dot', roomId: null, loadId: 2 });

    // When
    await repo.reads.holding(1);
    repo.reads.releaseOne(GONE);
    await repo.reads.holding(1);

    // Then: the failure is reported while the read of the product I am on is still running.
    expect(captured).toEqual(['chat_contacts_read']);
    expect(chat.view.get().contactsFailed).toBe(false);

    // When
    repo.reads.hold.rooms = false;
    repo.reads.releaseAll();
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(false);
    expect(chat.view.get().contacts?.rooms.map(room => room.roomId)).toEqual(['side']);
  });

  it('As a user with the chat panel open, I follow another product and see none of the first one', async () => {
    // Given
    const { chat } = setup();
    await chat.createRoom(PRODUCT, { roomId: 'main', name: 'Main', icon: '' });
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When
    chat.follow({ productId: 'other.dot', roomId: null, loadId: 2 });

    // Then
    expect(chat.view.get()).toMatchObject({ productId: 'other.dot', contacts: null, messages: null });

    // When
    await chat.settle();

    // Then
    expect(chat.view.get().contacts?.rooms).toEqual([]);
  });
});

describe('chat store view, failed reads', () => {
  it('As a user with the chat panel open, I open a conversation that cannot be read and see it flagged while the failure is reported', async () => {
    // Given
    const { repo, chat, captured } = setup();
    repo.reads.error.messages = GONE;

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(chat.view.get()).toMatchObject({ messagesFailed: true, contactsFailed: false });
    expect(captured).toEqual(['chat_messages_read']);
  });

  it('As a user with the chat panel open, I open a conversation while another tab blocks the database and the failed read is counted with no exception captured', async () => {
    // Given
    const { repo, chat, captured } = setup();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    repo.reads.error.messages = new IdbOpenBlockedError('dotli');

    // When
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(chat.view.get().messagesFailed).toBe(true);
    expect(captured).toEqual([]);
    expect(sentry.counted('chat.read')).toEqual([{ outcome: 'error', reason: 'IdbOpenBlockedError' }]);
  });

  it('As a user with the chat panel open, I go back to a working list from a conversation that could not be read and it is no longer flagged', async () => {
    // Given
    const { repo, chat } = setup();
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();
    repo.reads.error.messages = GONE;
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();
    const reads = repo.reads.count.rooms;

    // When: back to the list, which missed nothing.
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();

    // Then
    expect(repo.reads.count.rooms).toBe(reads);
    expect(chat.view.get()).toMatchObject({ messagesFailed: false, contactsFailed: false });
  });

  it('As a user with the chat panel open, I get a message in a conversation that could not be read and it is no longer flagged once it can be', async () => {
    // Given
    const { repo, chat } = setup();
    repo.reads.error.messages = GONE;
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // When: a new message, and this time the read works.
    repo.reads.error.messages = null;
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await chat.settle();

    // Then
    expect(chat.view.get().messagesFailed).toBe(false);
    expect(chat.view.get().messages).toHaveLength(1);
  });

  it('As a user with the chat panel open, I read a conversation while the room list cannot be re-read and the list stays flagged until it can be', async () => {
    // Given: the list shows, then a re-read of it fails.
    const { repo, chat } = setup();
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.settle();
    repo.reads.error.rooms = GONE;
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'side', content: TEXT });
    await chat.settle();

    // When: a conversation is read fine.
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();

    // Then
    expect(chat.view.get().messages).toHaveLength(1);
    expect(chat.view.get().contactsFailed).toBe(true);

    // When: back on the list, a message and a re-read that works.
    repo.reads.error.rooms = null;
    chat.follow({ productId: PRODUCT, roomId: null, loadId: 1 });
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'side', content: TEXT });
    await chat.settle();

    // Then
    expect(chat.view.get().contactsFailed).toBe(false);
  });
});

describe('chat store view, message reads', () => {
  it('As a user on a conversation, I get messages during its read and the conversation ends on the newest messages after one more read', async () => {
    // Given: a room open, and reads that wait for the test.
    const { repo, chat } = setup();
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    chat.follow({ productId: PRODUCT, roomId: 'main', loadId: 1 });
    await chat.settle();
    repo.reads.hold.messages = true;
    const start = repo.reads.count.messages;

    // When: two messages arrive while the first read waits.
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await chat.postProductMessage({ productId: PRODUCT, roomId: 'main', content: TEXT });
    await repo.reads.holding(1);
    repo.reads.hold.messages = false;
    repo.reads.releaseOne();
    await chat.settle();

    // Then
    expect(repo.reads.count.messages - start).toBe(2);
    expect(chat.view.get().messages).toHaveLength(3);
  });
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Local product chat. Records live on the product origin, so the browser isolates each product's rooms.

import { pageIdb, type DotliIdb } from './db.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { waitForIdbRequest, runIdbTransaction } from '@dotli/shared';

const ROOM_STORE = 'chat_rooms';
const MESSAGE_STORE = 'chat_messages';
const BOT_STORE = 'chat_bots';
const BY_ROOM = 'byRoom';

/** What a room shows below its messages. Matches TrUAPI `ChatRoomFooter`. */
export type ChatRoomFooter = 'TextInput' | 'Empty';

export type ChatRoomRecord = {
  productId: string;
  roomId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
  /** Unset until the product sets one, and an unset room shows the text input. */
  footer?: ChatRoomFooter;
};

export type ChatBotRecord = {
  productId: string;
  botId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
};

export type ChatMessageAuthor = 'product' | 'user';

export type ChatMessageRecord = {
  seq: number;
  productId: string;
  roomId: string;
  messageId: string;
  author: ChatMessageAuthor;
  /** Decoded TrUAPI `ChatMessageContent`, kept codec-agnostic so readers must tolerate unknown tags. */
  content: unknown;
  timestamp: number;
};

export type NewChatMessage = Omit<ChatMessageRecord, 'seq'>;

type Params = {
  /** The database the chat records live in. */
  idb?: DotliIdb;
};

type SetRoomFooterParams = {
  /** The product that owns the room. */
  productId: string;
  /** The room whose footer changes. */
  roomId: string;
  /** The footer to show from now on. */
  footer: ChatRoomFooter;
};

type ListMessagesParams = {
  /** How many of the latest messages to list. */
  limit?: number;
};

/**
 * Chat rooms, bots and messages over `idb`, the page's own by default. Every member rejects when the database fails.
 */
export function createChatRecords({ idb = pageIdb }: Params = {}) {
  async function createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
    const db = await idb.connect();
    let status: 'New' | 'Exists' = 'New';
    await runIdbTransaction({
      db,
      stores: ROOM_STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(ROOM_STORE);
        const request = store.get([room.productId, room.roomId]);
        request.onsuccess = () => {
          const existing = unsafe_readStoredRecord<ChatRoomRecord | undefined>(request.result);
          status = existing === undefined ? 'New' : 'Exists';
          store.put({
            ...existing,
            ...room,
            createdAt: existing?.createdAt ?? Date.now(),
          } satisfies ChatRoomRecord);
        };
      },
    });
    return status;
  }

  async function setRoomFooter({ productId, roomId, footer }: SetRoomFooterParams): Promise<boolean> {
    const db = await idb.connect();
    let found = false;
    await runIdbTransaction({
      db,
      stores: ROOM_STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(ROOM_STORE);
        const request = store.get([productId, roomId]);
        request.onsuccess = () => {
          const existing = unsafe_readStoredRecord<ChatRoomRecord | undefined>(request.result);
          if (existing !== undefined) {
            found = true;
            store.put({ ...existing, footer } satisfies ChatRoomRecord);
          }
        };
      },
    });
    return found;
  }

  async function registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
    const db = await idb.connect();
    let status: 'New' | 'Exists' = 'New';
    await runIdbTransaction({
      db,
      stores: BOT_STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(BOT_STORE);
        const request = store.get([bot.productId, bot.botId]);
        request.onsuccess = () => {
          const existing = unsafe_readStoredRecord<ChatBotRecord | undefined>(request.result);
          status = existing === undefined ? 'New' : 'Exists';
          store.put({ ...bot, createdAt: existing?.createdAt ?? Date.now() } satisfies ChatBotRecord);
        };
      },
    });
    return status;
  }

  async function listBots(productId: string): Promise<ChatBotRecord[]> {
    const db = await idb.connect();
    const store = db.transaction(BOT_STORE, 'readonly').objectStore(BOT_STORE);
    const range = idb.keyRange().bound([productId, ''], [productId, '￿']);
    const bots = (await waitForIdbRequest(store.getAll(range))).map(bot => unsafe_readStoredRecord<ChatBotRecord>(bot));
    return bots.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function listRooms(productId: string): Promise<ChatRoomRecord[]> {
    const db = await idb.connect();
    const store = db.transaction(ROOM_STORE, 'readonly').objectStore(ROOM_STORE);
    const range = idb.keyRange().bound([productId, ''], [productId, '￿']);
    const rooms = (await waitForIdbRequest(store.getAll(range))).map(room =>
      unsafe_readStoredRecord<ChatRoomRecord>(room),
    );
    return rooms.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function appendMessage(message: NewChatMessage): Promise<number> {
    const db = await idb.connect();
    let seq = 0;
    await runIdbTransaction({
      db,
      stores: MESSAGE_STORE,
      mode: 'readwrite',
      body: transaction => {
        const request = transaction.objectStore(MESSAGE_STORE).add(message);
        request.onsuccess = () => {
          // The message store generates its keys, and a generated key is a number.
          seq = request.result as number;
        };
      },
    });
    return seq;
  }

  async function getLatestMessageTimestamps(productId: string): Promise<Map<string, number>> {
    const db = await idb.connect();
    const index = db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).index(BY_ROOM);
    const range = idb.keyRange().bound([productId, ''], [productId, '￿']);
    const all = (await waitForIdbRequest(index.getAll(range))).map(message =>
      unsafe_readStoredRecord<ChatMessageRecord>(message),
    );
    const latest = new Map<string, number>();
    for (const message of all) {
      if (message.timestamp > (latest.get(message.roomId) ?? 0)) {
        latest.set(message.roomId, message.timestamp);
      }
    }
    return latest;
  }

  async function listMessages(
    productId: string,
    roomId: string,
    { limit = 200 }: ListMessagesParams = {},
  ): Promise<ChatMessageRecord[]> {
    const db = await idb.connect();
    const index = db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).index(BY_ROOM);
    const all = (await waitForIdbRequest(index.getAll(idb.keyRange().only([productId, roomId])))).map(message =>
      unsafe_readStoredRecord<ChatMessageRecord>(message),
    );
    return all.length > limit ? all.slice(all.length - limit) : all;
  }

  return {
    /** Answers TrUAPI `ChatRoomRegistrationStatus`. A re-creation refreshes the name and icon and keeps the footer. */
    createRoom,
    /** Resolves false, writing nothing, when the product has no room with this id. */
    setRoomFooter,
    /** Answers TrUAPI `ChatBotRegistrationStatus`. A re-registration refreshes the name and icon. */
    registerBot,
    /** The product's bots, oldest first. */
    listBots,
    /** The product's rooms, oldest first. */
    listRooms,
    /** Resolves the message's `seq` once it commits, so a sent message is one that was kept. */
    appendMessage,
    /** The time of the latest message in each of the product's rooms that has one, by room id. */
    getLatestMessageTimestamps,
    /** The latest `limit` messages, in insertion order. */
    listMessages,
  };
}

export type ChatRecords = ReturnType<typeof createChatRecords>;

/** The page's chat records. */
export const chat = createChatRecords();

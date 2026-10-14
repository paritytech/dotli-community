// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Local product chat. Records live on the product origin, so the browser isolates each product's rooms.

import { pageIdb, type DotliIdb } from './db.js';
import { idbRequest, idbTransaction } from '@dotli/shared';

const ROOM_STORE = 'chat_rooms';
const MESSAGE_STORE = 'chat_messages';
const BOT_STORE = 'chat_bots';
const BY_ROOM = 'byRoom';

/** What a room shows below its messages. Matches TrUAPI `ChatRoomFooter`. */
export type ChatRoomFooter = 'TextInput' | 'Empty';

export interface ChatRoomRecord {
  productId: string;
  roomId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
  /** Unset until the product sets one, and an unset room shows the text input. */
  footer?: ChatRoomFooter;
}

export interface ChatBotRecord {
  productId: string;
  botId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
}

export type ChatMessageAuthor = 'product' | 'user';

export interface ChatMessageRecord {
  seq: number;
  productId: string;
  roomId: string;
  messageId: string;
  author: ChatMessageAuthor;
  /** Decoded TrUAPI `ChatMessageContent`, kept codec-agnostic so readers must tolerate unknown tags. */
  content: unknown;
  timestamp: number;
}

export type NewChatMessage = Omit<ChatMessageRecord, 'seq'>;

/** Chat rooms, bots and messages over `idb`, the page's own by default. */
export function createChatRecords(idb: DotliIdb = pageIdb) {
  /** Answers TrUAPI `ChatRoomRegistrationStatus`. A re-creation refreshes the name and icon and keeps the footer. */
  async function createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
    const db = await idb.connect();
    let status: 'New' | 'Exists' = 'New';
    await idbTransaction(db, ROOM_STORE, 'readwrite', tx => {
      const store = tx.objectStore(ROOM_STORE);
      const existing = store.get([room.productId, room.roomId]) as IDBRequest<ChatRoomRecord | undefined>;
      existing.onsuccess = () => {
        status = existing.result === undefined ? 'New' : 'Exists';
        store.put({
          ...existing.result,
          ...room,
          createdAt: existing.result?.createdAt ?? Date.now(),
        } satisfies ChatRoomRecord);
      };
    });
    return status;
  }

  /** Resolves false, writing nothing, when the product has no room with this id. */
  async function setRoomFooter(productId: string, roomId: string, footer: ChatRoomFooter): Promise<boolean> {
    const db = await idb.connect();
    let found = false;
    await idbTransaction(db, ROOM_STORE, 'readwrite', tx => {
      const store = tx.objectStore(ROOM_STORE);
      const existing = store.get([productId, roomId]) as IDBRequest<ChatRoomRecord | undefined>;
      existing.onsuccess = () => {
        if (existing.result !== undefined) {
          found = true;
          store.put({ ...existing.result, footer } satisfies ChatRoomRecord);
        }
      };
    });
    return found;
  }

  /** Answers TrUAPI `ChatBotRegistrationStatus`. A re-registration refreshes the name and icon. */
  async function registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
    const db = await idb.connect();
    let status: 'New' | 'Exists' = 'New';
    await idbTransaction(db, BOT_STORE, 'readwrite', tx => {
      const store = tx.objectStore(BOT_STORE);
      const existing = store.get([bot.productId, bot.botId]) as IDBRequest<ChatBotRecord | undefined>;
      existing.onsuccess = () => {
        status = existing.result === undefined ? 'New' : 'Exists';
        store.put({ ...bot, createdAt: existing.result?.createdAt ?? Date.now() } satisfies ChatBotRecord);
      };
    });
    return status;
  }

  async function listBots(productId: string): Promise<ChatBotRecord[]> {
    const db = await idb.connect();
    const store = db.transaction(BOT_STORE, 'readonly').objectStore(BOT_STORE);
    const range = idb.keyRange().bound([productId, ''], [productId, '￿']);
    const bots = await idbRequest(store.getAll(range) as IDBRequest<ChatBotRecord[]>);
    return bots.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function listRooms(productId: string): Promise<ChatRoomRecord[]> {
    const db = await idb.connect();
    const store = db.transaction(ROOM_STORE, 'readonly').objectStore(ROOM_STORE);
    const range = idb.keyRange().bound([productId, ''], [productId, '￿']);
    const rooms = await idbRequest(store.getAll(range) as IDBRequest<ChatRoomRecord[]>);
    return rooms.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function appendMessage(message: NewChatMessage): Promise<number> {
    const db = await idb.connect();
    const store = db.transaction(MESSAGE_STORE, 'readwrite').objectStore(MESSAGE_STORE);
    const seq = await idbRequest(store.add(message));
    return seq as number;
  }

  async function latestMessageTimestamps(productId: string): Promise<Map<string, number>> {
    const db = await idb.connect();
    const index = db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).index(BY_ROOM);
    const range = idb.keyRange().bound([productId, ''], [productId, '￿']);
    const all = await idbRequest(index.getAll(range) as IDBRequest<ChatMessageRecord[]>);
    const latest = new Map<string, number>();
    for (const message of all) {
      if (message.timestamp > (latest.get(message.roomId) ?? 0)) {
        latest.set(message.roomId, message.timestamp);
      }
    }
    return latest;
  }

  /** The latest `limit` messages, in insertion order. */
  async function listMessages(productId: string, roomId: string, limit = 200): Promise<ChatMessageRecord[]> {
    const db = await idb.connect();
    const index = db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).index(BY_ROOM);
    const all = await idbRequest(
      index.getAll(idb.keyRange().only([productId, roomId])) as IDBRequest<ChatMessageRecord[]>,
    );
    return all.length > limit ? all.slice(all.length - limit) : all;
  }

  return {
    createRoom,
    setRoomFooter,
    registerBot,
    listBots,
    listRooms,
    appendMessage,
    latestMessageTimestamps,
    listMessages,
  };
}

export type ChatRecords = ReturnType<typeof createChatRecords>;

export const {
  createRoom,
  setRoomFooter,
  registerBot,
  listBots,
  listRooms,
  appendMessage,
  latestMessageTimestamps,
  listMessages,
}: ChatRecords = createChatRecords();

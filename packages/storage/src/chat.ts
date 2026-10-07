// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Local product chat. Records live on the product origin, so the browser isolates each product's rooms.

import { getDb } from './db.js';

const ROOM_STORE = 'chat_rooms';
const MESSAGE_STORE = 'chat_messages';
const BOT_STORE = 'chat_bots';
const BY_ROOM = 'byRoom';

export interface ChatRoomRecord {
  productId: string;
  roomId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
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

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('chat store request failed'));
    };
  });
}

/** Answers TrUAPI `ChatRoomRegistrationStatus`. A re-creation refreshes the name and icon. */
export async function createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, 'readwrite');
    const store = tx.objectStore(ROOM_STORE);
    let status: 'New' | 'Exists' | null = null;
    const getReq = store.get([room.productId, room.roomId]) as IDBRequest<ChatRoomRecord | undefined>;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      status = existing === undefined ? 'New' : 'Exists';
      store.put({
        ...room,
        createdAt: existing?.createdAt ?? Date.now(),
      } satisfies ChatRoomRecord);
    };
    tx.oncomplete = () => {
      if (status !== null) {
        resolve(status);
      } else {
        reject(new Error('createRoom tx completed without a result'));
      }
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('createRoom tx errored'));
    };
  });
}

/** Answers TrUAPI `ChatBotRegistrationStatus`. A re-registration refreshes the name and icon. */
export async function registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOT_STORE, 'readwrite');
    const store = tx.objectStore(BOT_STORE);
    let status: 'New' | 'Exists' | null = null;
    const getReq = store.get([bot.productId, bot.botId]) as IDBRequest<ChatBotRecord | undefined>;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      status = existing === undefined ? 'New' : 'Exists';
      store.put({
        ...bot,
        createdAt: existing?.createdAt ?? Date.now(),
      } satisfies ChatBotRecord);
    };
    tx.oncomplete = () => {
      if (status !== null) {
        resolve(status);
      } else {
        reject(new Error('registerBot tx completed without a result'));
      }
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('registerBot tx errored'));
    };
  });
}

export async function listBots(productId: string): Promise<ChatBotRecord[]> {
  const db = await getDb();
  const store = db.transaction(BOT_STORE, 'readonly').objectStore(BOT_STORE);
  const range = IDBKeyRange.bound([productId, ''], [productId, '￿']);
  const bots = await requestAsPromise(store.getAll(range) as IDBRequest<ChatBotRecord[]>);
  return bots.sort((a, b) => a.createdAt - b.createdAt);
}

export async function listRooms(productId: string): Promise<ChatRoomRecord[]> {
  const db = await getDb();
  const store = db.transaction(ROOM_STORE, 'readonly').objectStore(ROOM_STORE);
  const range = IDBKeyRange.bound([productId, ''], [productId, '￿']);
  const rooms = await requestAsPromise(store.getAll(range) as IDBRequest<ChatRoomRecord[]>);
  return rooms.sort((a, b) => a.createdAt - b.createdAt);
}

export async function appendMessage(message: NewChatMessage): Promise<number> {
  const db = await getDb();
  const store = db.transaction(MESSAGE_STORE, 'readwrite').objectStore(MESSAGE_STORE);
  const seq = await requestAsPromise(store.add(message));
  return seq as number;
}

export async function latestMessageTimestamps(productId: string): Promise<Map<string, number>> {
  const db = await getDb();
  const index = db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).index(BY_ROOM);
  const range = IDBKeyRange.bound([productId, ''], [productId, '￿']);
  const all = await requestAsPromise(index.getAll(range) as IDBRequest<ChatMessageRecord[]>);
  const latest = new Map<string, number>();
  for (const message of all) {
    if (message.timestamp > (latest.get(message.roomId) ?? 0)) {
      latest.set(message.roomId, message.timestamp);
    }
  }
  return latest;
}

/** The latest `limit` messages, in insertion order. */
export async function listMessages(productId: string, roomId: string, limit = 200): Promise<ChatMessageRecord[]> {
  const db = await getDb();
  const index = db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).index(BY_ROOM);
  const all = await requestAsPromise(
    index.getAll(IDBKeyRange.only([productId, roomId])) as IDBRequest<ChatMessageRecord[]>,
  );
  return all.length > limit ? all.slice(all.length - limit) : all;
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persistent IDB store for product chat rooms and messages.
 *
 * Product chat is a local conversation between the user and the loaded
 * product; nothing here leaves the device. Records live on the product
 * origin, so each product's rooms and messages are isolated by the
 * browser's same-origin storage boundary, same as the CID cache.
 *
 * The message `content` is the decoded TrUAPI `ChatMessageContent` value
 * stored as structured-clone data. Storage stays codec-agnostic so a wire
 * bump does not require a migration; readers must tolerate unknown tags.
 */

import { getDb } from "./db";

const ROOM_STORE = "chat_rooms";
const MESSAGE_STORE = "chat_messages";
const BOT_STORE = "chat_bots";
const BY_ROOM = "byRoom";

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

export type ChatMessageAuthor = "product" | "user";

export interface ChatMessageRecord {
  /** Auto-incremented insertion order, assigned by IDB. */
  seq: number;
  productId: string;
  roomId: string;
  messageId: string;
  author: ChatMessageAuthor;
  /** Decoded TrUAPI `ChatMessageContent`, stored as structured-clone data. */
  content: unknown;
  timestamp: number;
}

export type NewChatMessage = Omit<ChatMessageRecord, "seq">;

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("chat store request failed"));
    };
  });
}

/**
 * Create the room if it does not exist yet, mirroring the TrUAPI
 * `ChatRoomRegistrationStatus` values. A re-creation answers `"Exists"`
 * and refreshes the stored name and icon, so a product can rename a room
 * without a new id, same as bot re-registration.
 */
export async function createRoom(
  room: Omit<ChatRoomRecord, "createdAt">,
): Promise<"New" | "Exists"> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, "readwrite");
    const store = tx.objectStore(ROOM_STORE);
    let status: "New" | "Exists" | null = null;
    const getReq = store.get([room.productId, room.roomId]) as IDBRequest<
      ChatRoomRecord | undefined
    >;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      status = existing === undefined ? "New" : "Exists";
      store.put({
        ...room,
        createdAt: existing?.createdAt ?? Date.now(),
      } satisfies ChatRoomRecord);
    };
    tx.oncomplete = () => {
      if (status !== null) {
        resolve(status);
      } else {
        reject(new Error("createRoom tx completed without a result"));
      }
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("createRoom tx errored"));
    };
  });
}

/**
 * Register the bot if it does not exist yet, mirroring the TrUAPI
 * `ChatBotRegistrationStatus` values. A re-registration answers `"Exists"`
 * and refreshes the stored name and icon, so a product can update its bot
 * identity without a new id.
 */
export async function registerBot(
  bot: Omit<ChatBotRecord, "createdAt">,
): Promise<"New" | "Exists"> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOT_STORE, "readwrite");
    const store = tx.objectStore(BOT_STORE);
    let status: "New" | "Exists" | null = null;
    const getReq = store.get([bot.productId, bot.botId]) as IDBRequest<
      ChatBotRecord | undefined
    >;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      status = existing === undefined ? "New" : "Exists";
      store.put({
        ...bot,
        createdAt: existing?.createdAt ?? Date.now(),
      } satisfies ChatBotRecord);
    };
    tx.oncomplete = () => {
      if (status !== null) {
        resolve(status);
      } else {
        reject(new Error("registerBot tx completed without a result"));
      }
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("registerBot tx errored"));
    };
  });
}

/** All bots of a product, in registration order. */
export async function listBots(productId: string): Promise<ChatBotRecord[]> {
  const db = await getDb();
  const store = db.transaction(BOT_STORE, "readonly").objectStore(BOT_STORE);
  const range = IDBKeyRange.bound([productId, ""], [productId, "￿"]);
  const bots = await requestAsPromise(
    store.getAll(range) as IDBRequest<ChatBotRecord[]>,
  );
  return bots.sort((a, b) => a.createdAt - b.createdAt);
}

/** All rooms of a product, in creation order. */
export async function listRooms(productId: string): Promise<ChatRoomRecord[]> {
  const db = await getDb();
  const store = db.transaction(ROOM_STORE, "readonly").objectStore(ROOM_STORE);
  const range = IDBKeyRange.bound([productId, ""], [productId, "￿"]);
  const rooms = await requestAsPromise(
    store.getAll(range) as IDBRequest<ChatRoomRecord[]>,
  );
  return rooms.sort((a, b) => a.createdAt - b.createdAt);
}

/** Append one message. Resolves with the assigned insertion sequence. */
export async function appendMessage(message: NewChatMessage): Promise<number> {
  const db = await getDb();
  const store = db
    .transaction(MESSAGE_STORE, "readwrite")
    .objectStore(MESSAGE_STORE);
  const seq = await requestAsPromise(store.add(message));
  return seq as number;
}

/** Latest message timestamp per room of one product. */
export async function latestMessageTimestamps(
  productId: string,
): Promise<Map<string, number>> {
  const db = await getDb();
  const index = db
    .transaction(MESSAGE_STORE, "readonly")
    .objectStore(MESSAGE_STORE)
    .index(BY_ROOM);
  const range = IDBKeyRange.bound([productId, ""], [productId, "￿"]);
  const all = await requestAsPromise(
    index.getAll(range) as IDBRequest<ChatMessageRecord[]>,
  );
  const latest = new Map<string, number>();
  for (const message of all) {
    if (message.timestamp > (latest.get(message.roomId) ?? 0)) {
      latest.set(message.roomId, message.timestamp);
    }
  }
  return latest;
}

/** Messages of one room in insertion order, capped at `limit` latest. */
export async function listMessages(
  productId: string,
  roomId: string,
  limit = 200,
): Promise<ChatMessageRecord[]> {
  const db = await getDb();
  const index = db
    .transaction(MESSAGE_STORE, "readonly")
    .objectStore(MESSAGE_STORE)
    .index(BY_ROOM);
  const all = await requestAsPromise(
    index.getAll(IDBKeyRange.only([productId, roomId])) as IDBRequest<
      ChatMessageRecord[]
    >,
  );
  return all.length > limit ? all.slice(all.length - limit) : all;
}

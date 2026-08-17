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
const BY_ROOM = "byRoom";

export interface ChatRoomRecord {
  productId: string;
  roomId: string;
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
 * Create the room if it does not exist yet. Returns `"New"` on first
 * creation and `"Exists"` when the (productId, roomId) pair is already
 * stored, mirroring the TrUAPI `ChatRoomRegistrationStatus` values.
 */
export async function createRoom(
  room: Omit<ChatRoomRecord, "createdAt">,
): Promise<"New" | "Exists"> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, "readwrite");
    const store = tx.objectStore(ROOM_STORE);
    let status: "New" | "Exists" | null = null;
    const getReq = store.get([room.productId, room.roomId]);
    getReq.onsuccess = () => {
      if (getReq.result !== undefined) {
        status = "Exists";
        return;
      }
      store.add({ ...room, createdAt: Date.now() } satisfies ChatRoomRecord);
      status = "New";
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

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product chat domain: room/message persistence, the live product
// connection registry, and the window events the chat panel renders from.
//
// Product chat is a local conversation between the user and the loaded
// product. The product drives its side over TrUAPI (`chat.create_room`,
// `chat.post_message`); the user's replies go back to the product through
// the core's `chat.action_subscribe` stream via `publishChatAction` on the
// worker host runtime. Nothing leaves the device.

import type {
  ChatMessageContent,
  HostChatActionSubscribeItem,
} from "@parity/truapi";
import {
  appendMessage,
  createRoom,
  listMessages,
  listRooms,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from "@dotli/storage/chat";

export type { ChatMessageRecord, ChatRoomRecord };

/** Window event: a product's room list changed. Detail: `{ productId }`. */
export const CHAT_ROOMS_CHANGED_EVENT = "dotli:chat-rooms-changed";
/** Window event: a message was appended. Detail: `{ productId, roomId, author }`. */
export const CHAT_MESSAGE_EVENT = "dotli:chat-message";

export interface ChatMessageEventDetail {
  productId: string;
  roomId: string;
  author: "product" | "user";
}

/** Live publish handle for one product's Chat-kind core connection. */
export interface ChatConnection {
  publish(action: HostChatActionSubscribeItem): Promise<void>;
}

const connections = new Map<string, ChatConnection>();

/**
 * Register the publish handle for a product's live Chat connection.
 * Returns the matching unregister; a stale unregister (after a newer
 * registration for the same product) is a no-op.
 */
export function registerChatConnection(
  productId: string,
  connection: ChatConnection,
): () => void {
  connections.set(productId, connection);
  return () => {
    if (connections.get(productId) === connection) {
      connections.delete(productId);
    }
  };
}

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Product-initiated room creation. Idempotent per (productId, roomId). */
export async function productCreateRoom(
  productId: string,
  room: { roomId: string; name: string; icon: string },
): Promise<"New" | "Exists"> {
  const status = await createRoom({ productId, ...room });
  if (status === "New") {
    emit(CHAT_ROOMS_CHANGED_EVENT, { productId });
  }
  return status;
}

/** Product-authored message. Returns the assigned message id. */
export async function productPostMessage(
  productId: string,
  roomId: string,
  content: ChatMessageContent,
): Promise<string> {
  const messageId = crypto.randomUUID();
  await appendMessage({
    productId,
    roomId,
    messageId,
    author: "product",
    content,
    timestamp: Date.now(),
  });
  emit(CHAT_MESSAGE_EVENT, {
    productId,
    roomId,
    author: "product",
  } satisfies ChatMessageEventDetail);
  return messageId;
}

/**
 * User-authored text message from the chat panel. Persists locally first,
 * then publishes a `MessagePosted` action into the product's
 * `chat.action_subscribe` stream. The publish can fail independently of
 * persistence (no live Chat connection, logged out); callers surface that
 * without losing the stored message.
 */
export async function userPostMessage(
  productId: string,
  roomId: string,
  text: string,
): Promise<void> {
  const content: ChatMessageContent = { tag: "Text", value: { text } };
  await appendMessage({
    productId,
    roomId,
    messageId: crypto.randomUUID(),
    author: "user",
    content,
    timestamp: Date.now(),
  });
  emit(CHAT_MESSAGE_EVENT, {
    productId,
    roomId,
    author: "user",
  } satisfies ChatMessageEventDetail);
  const connection = connections.get(productId);
  if (connection === undefined) {
    throw new Error("Chat is not connected for this product");
  }
  await connection.publish({
    roomId,
    peer: "user",
    payload: { tag: "MessagePosted", value: content },
  });
}

/** Rooms of one product, creation order. */
export function chatRooms(productId: string): Promise<ChatRoomRecord[]> {
  return listRooms(productId);
}

/** Messages of one room, insertion order. */
export function chatMessages(
  productId: string,
  roomId: string,
): Promise<ChatMessageRecord[]> {
  return listMessages(productId, roomId);
}

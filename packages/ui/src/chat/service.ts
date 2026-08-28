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
import type {
  CustomMessageRenderRequest,
  CustomMessageRenderSink,
} from "@parity/truapi-host";
import {
  appendMessage,
  createRoom,
  latestMessageTimestamps,
  listBots,
  listMessages,
  listRooms,
  registerBot as storeBot,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from "@dotli/storage/chat";

export type { ChatBotRecord, ChatMessageRecord, ChatRoomRecord };

/** Window event: a product's room list changed. Detail: `{ productId }`. */
export const CHAT_ROOMS_CHANGED_EVENT = "dotli:chat-rooms-changed";
/** Window event: a product's bot registry changed. Detail: `{ productId }`. */
export const CHAT_BOTS_CHANGED_EVENT = "dotli:chat-bots-changed";
/** Window event: a message was appended. Detail: `{ productId, roomId, author }`. */
export const CHAT_MESSAGE_EVENT = "dotli:chat-message";

export interface ChatMessageEventDetail {
  productId: string;
  roomId: string;
  author: "product" | "user";
}

/** Live handles for one product's Worker-kind core connection. */
export interface ChatConnection {
  publish(action: HostChatActionSubscribeItem): Promise<void>;
  renderCustomMessage(
    request: CustomMessageRenderRequest,
    sink: CustomMessageRenderSink,
  ): () => void;
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

/** Product-initiated room creation. A repeat for an existing (productId,
 *  roomId) refreshes the room's name and icon, so always notify. */
export async function productCreateRoom(
  productId: string,
  room: { roomId: string; name: string; icon: string },
): Promise<"New" | "Exists"> {
  const status = await createRoom({ productId, ...room });
  emit(CHAT_ROOMS_CHANGED_EVENT, { productId });
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
 * User-authored text message from the chat panel. Requires a live Chat
 * connection up front, so a message that provably cannot reach the product
 * is never stored looking sent. After that it persists locally, then
 * publishes a `MessagePosted` action into the product's
 * `chat.action_subscribe` stream; a late publish failure (denied, worker
 * gone mid-call) surfaces to the caller without losing the stored message.
 */
export async function userPostMessage(
  productId: string,
  roomId: string,
  text: string,
): Promise<void> {
  const connection = connections.get(productId);
  if (connection === undefined) {
    throw new Error("Chat is not connected for this product");
  }
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
  await connection.publish({
    roomId,
    peer: "user",
    payload: { tag: "MessagePosted", value: content },
  });
}

/**
 * User-triggered action from a rendered custom message (button tap or
 * text-field edit), published into the product's action stream.
 */
export async function userTriggerAction(
  productId: string,
  roomId: string,
  trigger: { messageId: string; actionId: string; payload?: `0x${string}` },
): Promise<void> {
  const connection = connections.get(productId);
  if (connection === undefined) {
    throw new Error("Chat is not connected for this product");
  }
  await connection.publish({
    roomId,
    peer: "user",
    payload: { tag: "ActionTriggered", value: trigger },
  });
}

/**
 * Ask the live product to draw one stored custom message, streaming
 * replacement trees into `sink` until the returned disposer is called.
 * Without a live connection the sink fails immediately; the stored message
 * stays and the next render attempt can succeed.
 */
export function renderCustomMessage(
  productId: string,
  request: CustomMessageRenderRequest,
  sink: CustomMessageRenderSink,
): () => void {
  const connection = connections.get(productId);
  if (connection === undefined) {
    sink.onError?.(new Error("Chat is not connected for this product"));
    return (): void => undefined;
  }
  return connection.renderCustomMessage(request, sink);
}

/**
 * Register a product bot identity. Host-owned and persisted with the rooms
 * it belongs to, so a re-registration after reload resolves to `Exists` and
 * refreshes the stored name and icon.
 */
export async function registerBot(
  productId: string,
  bot: { botId: string; name: string; icon: string },
): Promise<"New" | "Exists"> {
  const status = await storeBot({ productId, ...bot });
  emit(CHAT_BOTS_CHANGED_EVENT, { productId });
  return status;
}

/** Registered bots of one product, registration order. */
export function chatBots(productId: string): Promise<ChatBotRecord[]> {
  return listBots(productId);
}

/** Latest message timestamp per room, for contact-list ordering. */
export function chatLatestMessageTimes(
  productId: string,
): Promise<Map<string, number>> {
  return latestMessageTimestamps(productId);
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

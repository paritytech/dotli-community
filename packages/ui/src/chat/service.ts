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

const BOTS_STORAGE_PREFIX = "dotli:chat-bots:";

/**
 * Register a product bot identity. Host-owned like rooms, persisted so a
 * re-registration after reload resolves to `Exists`.
 */
export function registerBot(
  productId: string,
  bot: { botId: string; name: string; icon: string },
): "New" | "Exists" {
  const key = `${BOTS_STORAGE_PREFIX}${productId}`;
  let bots: Record<string, { name: string; icon: string }> = {};
  try {
    bots = JSON.parse(localStorage.getItem(key) ?? "{}") as typeof bots;
    // eslint-disable-next-line no-restricted-syntax -- a corrupt or unavailable registry re-registers the bot as New; nothing else is lost.
  } catch {
    /* fall through with an empty registry */
  }
  const status = bot.botId in bots ? "Exists" : "New";
  bots[bot.botId] = { name: bot.name, icon: bot.icon };
  try {
    localStorage.setItem(key, JSON.stringify(bots));
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); only Exists detection across reloads is lost.
  } catch {
    /* registration still answered for this load */
  }
  return status;
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

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product chat is a local conversation with the loaded product, and nothing leaves the device. User
// replies and custom-message taps go back through the worker host runtime's action streams.

import type {
  ChatMessageContent,
  HostChatActionSubscribeItem,
  HostRendererActionSubscribeItem,
  ProductRendererRenderRequest,
} from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';
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
} from '@dotli/storage';
import { recordBotsChanged, recordMessage, recordRoomsChanged } from '../state/chat.js';

export type { ChatBotRecord, ChatMessageRecord, ChatRoomRecord };

/** Detail: `{ productId }`. */
export const CHAT_ROOMS_CHANGED_EVENT = 'dotli:chat-rooms-changed';
/** Detail: `{ productId }`. */
export const CHAT_BOTS_CHANGED_EVENT = 'dotli:chat-bots-changed';
export const CHAT_MESSAGE_EVENT = 'dotli:chat-message';

export interface ChatMessageEventDetail {
  productId: string;
  roomId: string;
  author: 'product' | 'user';
}

/** Live handles for one product's Worker-kind core connection. */
export interface ChatConnection {
  publish(action: HostChatActionSubscribeItem): Promise<void>;
  publishRendererAction(item: HostRendererActionSubscribeItem): Promise<void>;
  render(request: ProductRendererRenderRequest, sink: RenderSink): () => void;
}

const connections = new Map<string, ChatConnection>();

/** A stale unregister, after a newer registration for the same product, is a no-op. */
export function registerChatConnection(productId: string, connection: ChatConnection): () => void {
  connections.set(productId, connection);
  return () => {
    if (connections.get(productId) === connection) {
      connections.delete(productId);
    }
  };
}

/** A repeat for an existing room refreshes its name and icon, so it always notifies. */
export async function productCreateRoom(
  productId: string,
  room: { roomId: string; name: string; icon: string },
): Promise<'New' | 'Exists'> {
  const status = await createRoom({ productId, ...room });
  recordRoomsChanged(productId);
  return status;
}

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
    author: 'product',
    content,
    timestamp: Date.now(),
  });
  recordMessage({
    productId,
    roomId,
    author: 'product',
  } satisfies ChatMessageEventDetail);
  return messageId;
}

/**
 * Requires a live connection up front, so a message that cannot reach the product is never stored
 * looking sent. A later publish failure surfaces without losing the stored message.
 */
export async function userPostMessage(productId: string, roomId: string, text: string): Promise<void> {
  const connection = connections.get(productId);
  if (connection === undefined) {
    throw new Error('Chat is not connected for this product');
  }
  const content: ChatMessageContent = { tag: 'Text', value: { text } };
  await appendMessage({
    productId,
    roomId,
    messageId: crypto.randomUUID(),
    author: 'user',
    content,
    timestamp: Date.now(),
  });
  recordMessage({
    productId,
    roomId,
    author: 'user',
  } satisfies ChatMessageEventDetail);
  await connection.publish({
    roomId,
    peer: 'user',
    payload: { tag: 'MessagePosted', value: content },
  });
}

export async function userTriggerAction(
  productId: string,
  roomId: string,
  trigger: { messageId: string; actionId: string; payload?: `0x${string}` },
): Promise<void> {
  const connection = connections.get(productId);
  if (connection === undefined) {
    throw new Error('Chat is not connected for this product');
  }
  await connection.publish({
    roomId,
    peer: 'user',
    payload: { tag: 'ActionTriggered', value: trigger },
  });
}

export async function userTriggerRendererAction(
  productId: string,
  item: HostRendererActionSubscribeItem,
): Promise<void> {
  const connection = connections.get(productId);
  if (connection === undefined) {
    throw new Error('Chat is not connected for this product');
  }
  await connection.publishRendererAction(item);
}

/**
 * Streams replacement trees into `sink` until disposed. Without a live connection the sink fails at
 * once, and the stored message stays for a later render.
 */
export function renderCustomMessage(
  productId: string,
  request: ProductRendererRenderRequest,
  sink: RenderSink,
): () => void {
  const connection = connections.get(productId);
  if (connection === undefined) {
    sink.onError?.(new Error('Chat is not connected for this product'));
    return (): void => undefined;
  }
  return connection.render(request, sink);
}

/** Persisted with its rooms, so a re-registration after reload resolves to `Exists` and refreshes name and icon. */
export async function registerBot(
  productId: string,
  bot: { botId: string; name: string; icon: string },
): Promise<'New' | 'Exists'> {
  const status = await storeBot({ productId, ...bot });
  recordBotsChanged(productId);
  return status;
}

/** In registration order. */
export function chatBots(productId: string): Promise<ChatBotRecord[]> {
  return listBots(productId);
}

/** For contact-list ordering. */
export function chatLatestMessageTimes(productId: string): Promise<Map<string, number>> {
  return latestMessageTimestamps(productId);
}

/** In creation order. */
export function chatRooms(productId: string): Promise<ChatRoomRecord[]> {
  return listRooms(productId);
}

/** In insertion order. */
export function chatMessages(productId: string, roomId: string): Promise<ChatMessageRecord[]> {
  return listMessages(productId, roomId);
}

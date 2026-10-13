// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostChatActionSubscribeItem, HostRendererActionSubscribeItem } from '@parity/truapi';
import type { ChatBotRecord, ChatConnection, ChatMessageRecord, ChatRepo, ChatRoomRecord } from './store.js';

/** A chat repo in memory, keeping IndexedDB's orders: rooms and bots by creation, messages by insertion. */
export function memoryChatRepo(): ChatRepo & {
  rooms: ChatRoomRecord[];
  bots: ChatBotRecord[];
  messages: ChatMessageRecord[];
} {
  let clock = 0;
  const repo = {
    rooms: [] as ChatRoomRecord[],
    bots: [] as ChatBotRecord[],
    messages: [] as ChatMessageRecord[],
    createRoom: (room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'> => {
      const existing = repo.rooms.find(r => r.productId === room.productId && r.roomId === room.roomId);
      if (existing !== undefined) {
        Object.assign(existing, room);
        return Promise.resolve('Exists');
      }
      repo.rooms.push({ ...room, createdAt: (clock += 1) });
      return Promise.resolve('New');
    },
    registerBot: (bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'> => {
      const existing = repo.bots.find(b => b.productId === bot.productId && b.botId === bot.botId);
      if (existing !== undefined) {
        Object.assign(existing, bot);
        return Promise.resolve('Exists');
      }
      repo.bots.push({ ...bot, createdAt: (clock += 1) });
      return Promise.resolve('New');
    },
    appendMessage: (message: Omit<ChatMessageRecord, 'seq'>): Promise<number> => {
      const seq = repo.messages.length + 1;
      repo.messages.push({ ...message, seq });
      return Promise.resolve(seq);
    },
    listRooms: (productId: string) => Promise.resolve(repo.rooms.filter(r => r.productId === productId)),
    listBots: (productId: string) => Promise.resolve(repo.bots.filter(b => b.productId === productId)),
    latestMessageTimestamps: (productId: string) =>
      Promise.resolve(
        new Map(repo.messages.filter(m => m.productId === productId).map(m => [m.roomId, m.timestamp] as const)),
      ),
    listMessages: (productId: string, roomId: string) =>
      Promise.resolve(repo.messages.filter(m => m.productId === productId && m.roomId === roomId)),
  };
  return repo;
}

/** A product connection that records what reaches the product. */
export function recordingConnection(options: { fails?: boolean } = {}): ChatConnection & {
  published: HostChatActionSubscribeItem[];
  rendererActions: HostRendererActionSubscribeItem[];
} {
  const outcome = (): Promise<void> =>
    options.fails === true ? Promise.reject(new Error('product unreachable')) : Promise.resolve();
  const connection = {
    published: [] as HostChatActionSubscribeItem[],
    rendererActions: [] as HostRendererActionSubscribeItem[],
    publish: (action: HostChatActionSubscribeItem) => {
      connection.published.push(action);
      return outcome();
    },
    publishRendererAction: (item: HostRendererActionSubscribeItem) => {
      connection.rendererActions.push(item);
      return outcome();
    },
    render: () => () => undefined,
  };
  return connection;
}

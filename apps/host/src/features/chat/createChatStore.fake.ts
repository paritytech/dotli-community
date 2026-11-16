// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ChatBotRecord,
  ChatMessageRecord,
  ChatRepo,
  ChatRoomRecord,
  SetRoomFooterParams,
} from './createChatStore.js';
import { createChanges } from '../../testing/changes.js';

/** The room list and conversation reads of a memory chat repo, which a spec can count, hold and fail. */
type ChatRepoReads = {
  /** Reads made so far. */
  readonly count: { rooms: number; messages: number };
  /** While set, each read of that kind waits until released. */
  hold: { rooms: boolean; messages: boolean };
  /** While set, each read of that kind rejects with it, after any hold. */
  error: { rooms: Error | null; messages: Error | null };
  /** Resolves once `count` reads are held at once. */
  holding(count: number): Promise<void>;
  /** Resolves once `count` reads have landed since the repo was made, whether they then return or fail. */
  waitForLanded(count: number): Promise<void>;
  /** Lets the oldest held read land, or fail with `error`. */
  releaseOne(error?: Error): void;
  /** Lets every held read land. */
  releaseAll(): void;
};

/** A chat repo in memory, keeping IndexedDB's orders: rooms and bots by creation, messages by insertion. */
export function createMemoryChatRepo(): ChatRepo & {
  rooms: ChatRoomRecord[];
  bots: ChatBotRecord[];
  messages: ChatMessageRecord[];
  reads: ChatRepoReads;
} {
  let clock = 0;
  const changes = createChanges();
  const held: ((error?: Error) => void)[] = [];
  let landed = 0;
  const reads: ChatRepoReads = {
    count: { rooms: 0, messages: 0 },
    hold: { rooms: false, messages: false },
    error: { rooms: null, messages: null },
    holding: count => changes.until(() => held.length === count),
    waitForLanded: count => changes.until(() => landed >= count),
    releaseOne(error) {
      held.shift()?.(error);
    },
    releaseAll() {
      for (const land of held.splice(0)) {
        land();
      }
    },
  };
  async function runGatedRead<T>(kind: 'rooms' | 'messages', read: () => T): Promise<T> {
    reads.count[kind] += 1;
    // Rows are taken before the hold, as a read that was already running when the rows changed would have seen them.
    const rows = read();
    try {
      if (reads.hold[kind]) {
        await new Promise<void>((resolve, reject) => {
          held.push(error => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
          changes.notify();
        });
      }
      const failure = reads.error[kind];
      if (failure !== null) {
        throw failure;
      }
      return rows;
    } finally {
      landed += 1;
      changes.notify();
    }
  }
  const rooms: ChatRoomRecord[] = [];
  const bots: ChatBotRecord[] = [];
  const messages: ChatMessageRecord[] = [];
  const repo = {
    reads,
    rooms,
    bots,
    messages,
    createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
      const existing = repo.rooms.find(r => r.productId === room.productId && r.roomId === room.roomId);
      if (existing !== undefined) {
        Object.assign(existing, room);
        return Promise.resolve('Exists');
      }
      repo.rooms.push({ ...room, createdAt: (clock += 1) });
      return Promise.resolve('New');
    },
    setRoomFooter({ productId, roomId, footer }: SetRoomFooterParams): Promise<boolean> {
      const existing = repo.rooms.find(r => r.productId === productId && r.roomId === roomId);
      if (existing !== undefined) {
        existing.footer = footer;
      }
      return Promise.resolve(existing !== undefined);
    },
    registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'> {
      const existing = repo.bots.find(b => b.productId === bot.productId && b.botId === bot.botId);
      if (existing !== undefined) {
        Object.assign(existing, bot);
        return Promise.resolve('Exists');
      }
      repo.bots.push({ ...bot, createdAt: (clock += 1) });
      return Promise.resolve('New');
    },
    appendMessage(message: Omit<ChatMessageRecord, 'seq'>): Promise<number> {
      const seq = repo.messages.length + 1;
      repo.messages.push({ ...message, seq });
      return Promise.resolve(seq);
    },
    listRooms: (productId: string) => runGatedRead('rooms', () => repo.rooms.filter(r => r.productId === productId)),
    listBots: (productId: string) => Promise.resolve(repo.bots.filter(b => b.productId === productId)),
    readLatestMessageTimestamps: (productId: string) =>
      Promise.resolve(
        new Map(repo.messages.filter(m => m.productId === productId).map(m => [m.roomId, m.timestamp] as const)),
      ),
    listMessages: (productId: string, roomId: string) =>
      runGatedRead('messages', () => repo.messages.filter(m => m.productId === productId && m.roomId === roomId)),
  };
  return repo;
}

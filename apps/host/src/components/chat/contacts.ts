// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatBot, ChatRoom } from './chat.js';

/** A room or a registered bot. A bot's conversation is keyed by its botId, which the product uses as the roomId. */
export interface ContactEntry {
  kind: 'room' | 'bot';
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  /** Null until the conversation has a message. */
  lastMessageAt: number | null;
}

export function contactEntries(
  rooms: readonly ChatRoom[],
  bots: readonly ChatBot[],
  lastMessageTimes: ReadonlyMap<string, number>,
): ContactEntry[] {
  const entries: ContactEntry[] = [
    ...rooms.map(room => ({
      kind: 'room' as const,
      id: room.roomId,
      name: room.name,
      icon: room.icon,
      createdAt: room.createdAt,
      lastMessageAt: lastMessageTimes.get(room.roomId) ?? null,
    })),
    ...bots.map(bot => ({
      kind: 'bot' as const,
      id: bot.botId,
      name: bot.name,
      icon: bot.icon,
      createdAt: bot.createdAt,
      lastMessageAt: lastMessageTimes.get(bot.botId) ?? null,
    })),
  ];
  const recency = (entry: ContactEntry): number => entry.lastMessageAt ?? entry.createdAt;
  return entries.sort((a, b) => recency(b) - recency(a));
}

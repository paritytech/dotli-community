// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatBotRecord, ChatRoomRecord } from '../../chat/service.js';

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
  rooms: ChatRoomRecord[],
  bots: ChatBotRecord[],
  lastMessageTimes: Map<string, number>,
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

/** A bubble's relative time label, such as "5 mins ago". */
export function relativeTime(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return minutes === 1 ? 'a min ago' : `${String(minutes)} mins ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? 'an hour ago' : `${String(hours)} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

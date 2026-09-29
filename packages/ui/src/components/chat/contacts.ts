// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatBotRecord, ChatRoomRecord } from '../../chat/service.js';

/** One list entry: a room, or a registered bot. Both open a conversation;
 *  a bot's is keyed by its botId, which the product uses as the roomId when
 *  it posts into or reads from that conversation. */
export interface ContactEntry {
  kind: 'room' | 'bot';
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  // null until the conversation has messages; the list then falls back to
  // creation time, so one recency order covers active and new contacts.
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

/** "just now" / "5 mins ago" / "an hour ago" style label for a bubble. */
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

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatRoomFooter } from './createChatStore.js';
import type { ChatRoom } from './chat.js';

/** A room of the product's contact list. */
export type ContactEntry = {
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  /** Null until the conversation has a message. */
  lastMessageAt: number | null;
  /** What the conversation shows below its messages. */
  footer: ChatRoomFooter;
};

export function contactEntries(
  rooms: readonly ChatRoom[],
  lastMessageTimes: ReadonlyMap<string, number>,
): ContactEntry[] {
  const entries: ContactEntry[] = [
    ...rooms.map(room => ({
      id: room.roomId,
      name: room.name,
      icon: room.icon,
      createdAt: room.createdAt,
      lastMessageAt: lastMessageTimes.get(room.roomId) ?? null,
      footer: room.footer ?? 'TextInput',
    })),
  ];
  const recency = (entry: ContactEntry): number => entry.lastMessageAt ?? entry.createdAt;
  return entries.sort((a, b) => recency(b) - recency(a));
}

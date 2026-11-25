// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatRoomFooter } from './createChatStore.js';
import type { ChatRoom } from './chat.js';

/** A room of the product's contact list. */
export type ContactEntry = {
  id: string;
  productId: string;
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
      productId: room.productId,
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

/** The room the chat shows, and whether it is the only room, so no room list stands behind it. */
export type ShownContact = { contact: ContactEntry; sole: boolean };

/**
 * Picks the room the chat shows. With no active room, the only room of a one-room list shows. An active room that the
 * list does not hold (yet) shows none, so the list shows instead. Null when none shows.
 */
export function getShownContact(
  contacts: readonly ContactEntry[] | null,
  activeRoomId: string | null,
): ShownContact | null {
  if (contacts === null) {
    return null;
  }
  const sole = contacts.length === 1;
  const contact = activeRoomId === null ? (sole ? contacts[0] : undefined) : contacts.find(c => c.id === activeRoomId);
  return contact === undefined ? null : { contact, sole };
}

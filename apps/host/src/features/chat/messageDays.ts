// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatMessageRecord } from './createChatStore.js';

type DayMessage = Pick<ChatMessageRecord, 'timestamp'>;

/**
 * Whether `message` opens a day of the conversation: it is the oldest, or falls on another local calendar day than
 * `previous`, the message before it, undefined for the oldest.
 */
export function startsDay(message: DayMessage, previous: DayMessage | undefined): boolean {
  return previous === undefined || startOfDay(previous.timestamp) !== startOfDay(message.timestamp);
}

/** The day divider's label: "Today", "Yesterday", or the date, with its year when that is not the year of `now`. */
export function getDayLabel(timestamp: number, now: number): string {
  const day = startOfDay(timestamp);
  const today = new Date(now);
  if (day === startOfDay(now)) {
    return 'Today';
  }
  if (day === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) {
    return 'Yesterday';
  }
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

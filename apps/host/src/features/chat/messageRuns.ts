// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatMessageRecord } from './createChatStore.js';

type RunMessage = Pick<ChatMessageRecord, 'author' | 'timestamp'>;

const MINUTE_MS = 60_000;

function minuteOf(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS);
}

/**
 * Whether `message` ends its run, the messages one author sent within one clock minute. `next` is the message after
 * it, undefined for the newest.
 */
export function endsRun(message: RunMessage, next: RunMessage | undefined): boolean {
  return next?.author !== message.author || minuteOf(next.timestamp) !== minuteOf(message.timestamp);
}

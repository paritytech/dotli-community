// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount, type CountMetric } from '@dotli/metrics';
import { isExpectedDbError } from '@dotli/storage';

type ChatStorageStep = 'chat_contacts_read' | 'chat_messages_read' | 'chat_rooms_read' | 'chat_reply_store';

const report = createReporter({ flow: 'chat' });

/**
 * One failed read of the chat store: the panel's contacts or messages, after which the panel keeps its last view, or
 * a product's room list, which then rejects to its caller. Tagged `outcome` (error) and `reason` (the error's name).
 */
const chatReadMetric = defineCount<'error'>('chat.read');

/** A user's reply the store could not keep. Tagged `outcome` (error) and `reason` (the error's name). */
const chatReplyStoreMetric = defineCount<'error'>('chat.reply_store');

const STEP_METRICS = {
  chat_contacts_read: chatReadMetric,
  chat_messages_read: chatReadMetric,
  chat_rooms_read: chatReadMetric,
  chat_reply_store: chatReplyStoreMetric,
} satisfies Record<ChatStorageStep, CountMetric<'error'>>;

/** Reports a failed read or write of the chat store, as expected when the database caused it. */
export function reportFailedChatStorage(error: unknown, step: ChatStorageStep): void {
  const metric = STEP_METRICS[step];
  if (isExpectedDbError(error)) {
    report.expected(error, { step, metric });
    return;
  }
  report.defect(error, {
    step,
    metric,
    message: `[dot.li chat] ${step} failed:`,
  });
}

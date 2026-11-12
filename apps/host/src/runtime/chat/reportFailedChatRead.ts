// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { isExpectedDbError } from '@dotli/storage';

const report = createReporter({ flow: 'chat' });

/**
 * One failed read of the chat store: the panel's contacts or messages, after which the panel keeps its last view, or
 * a product's room list, which then rejects to its caller. Tagged `outcome` (error) and `reason` (the error's name).
 */
const chatReadMetric = defineCount<'error'>('chat.read');

/** Reports a failed chat read, as expected when the database caused it. */
export function reportFailedChatRead(
  error: unknown,
  step: 'chat_contacts_read' | 'chat_messages_read' | 'chat_rooms_read',
): void {
  if (isExpectedDbError(error)) {
    report.expected(error, { step, metric: chatReadMetric });
    return;
  }
  report.defect(error, {
    step,
    metric: chatReadMetric,
    message: `[dot.li chat] ${step} failed:`,
    tags: { kind: 'chat_panel_read_error' },
  });
}

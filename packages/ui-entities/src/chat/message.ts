// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a message bubble reads. The record is a structural copy of the runtime's, so the host passes its own in and its
// typecheck catches a drift.

export interface ChatMessage {
  seq: number;
  productId: string;
  roomId: string;
  messageId: string;
  author: 'product' | 'user';
  /** Decoded TrUAPI `ChatMessageContent`, kept codec-agnostic so the bubble tolerates unknown tags. */
  content: unknown;
  timestamp: number;
}

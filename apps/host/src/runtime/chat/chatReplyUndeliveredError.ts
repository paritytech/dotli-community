// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A user's reply that was stored but could not reach the product. Its `cause` is the publish failure. */
export class ChatReplyUndeliveredError extends Error {
  override name = 'ChatReplyUndeliveredError';

  constructor(roomId: string, error: unknown) {
    super(`The reply stored in chat room ${roomId} could not reach the product`, { cause: error });
  }
}

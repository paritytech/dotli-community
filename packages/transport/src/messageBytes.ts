// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Branded } from '@dotli/shared';

/** One method's message as the bytes it is, which a frame carries on a call. */
export type MessageBytes = Branded<Uint8Array, 'MessageBytes'>;

/** Marks `bytes` as one method's message. Returns the same bytes. */
export function toMessageBytes(bytes: Uint8Array): MessageBytes {
  // The one place plain bytes become a method's message
  return bytes as MessageBytes;
}

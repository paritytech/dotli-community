// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toHex } from '@dotli/shared';

/** Each message as JSON text, with a byte array written as its hex. */
export function writeMessages(messages: readonly unknown[]): string[] {
  // JSON would write a byte array as an object of indices.
  return messages.map(message =>
    JSON.stringify(message, (_key, value: unknown) => (value instanceof Uint8Array ? toHex(value) : value)),
  );
}

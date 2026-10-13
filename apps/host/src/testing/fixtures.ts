// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure fixtures shared by the runtime specs.

import type { Result } from 'neverthrow';

export const genesisHash = `0x${'11'.repeat(32)}` as const;
export const blockHash = `0x${'22'.repeat(32)}` as const;

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) {
    throw new Error(`expected Ok, got Err: ${String(result.error)}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/** Narrows an iterator step, whose value an async iterator types as `any`, throwing if the iterator finished. */
export function yielded<T>(step: IteratorResult<T, unknown>): T {
  if (step.done === true) {
    throw new Error('expected a yielded value, the iterator finished');
  }
  return step.value;
}

export function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

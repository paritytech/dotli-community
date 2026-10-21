// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure fixtures shared by the runtime specs.

export const genesisHash = `0x${'11'.repeat(32)}` as const;
export const blockHash = `0x${'22'.repeat(32)}` as const;

/** Narrows an iterator step, whose value an async iterator types as `any`, throwing if the iterator finished. */
export function yielded<T>(step: IteratorResult<T, unknown>): T {
  if (step.done === true) {
    throw new Error('expected a yielded value, the iterator finished');
  }
  return step.value;
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Returns a record's own enumerable string keys, typed by the record, and never throws.
 *
 * It suits a record with no keys past its type, such as a literal table. A wider value's extra keys come back typed as
 * its known ones.
 *
 * @example
 * const levels = getKeys({ low: 1, high: 2 }); // ('low' | 'high')[]
 */
export function getKeys<T extends object>(record: T): Extract<keyof T, string>[] {
  // `Object.keys` types every key as `string`, though a record with no keys past its type has only its typed ones.
  return Object.keys(record) as Extract<keyof T, string>[];
}

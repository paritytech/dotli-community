// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The number stored text holds, or undefined when it is not a JSON number. */
export function decodeNumber(raw: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof value === 'number' ? value : undefined;
}

/** The stored text of a number. */
export function encodeNumber(value: number): string {
  return JSON.stringify(value);
}

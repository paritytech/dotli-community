// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The message of a thrown `Error`, or the thrown value as text, for copy and logs that read the message alone. */
export function getErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The `name` of an `Error`, such as `TypeError`, and `undefined` for any other value. */
export function getErrorName(value: unknown): string | undefined {
  return value instanceof Error ? value.name : undefined;
}

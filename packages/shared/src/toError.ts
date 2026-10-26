// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { serializeError } from './serializeError.js';

/** A thrown value as an `Error`. An `Error` passes through, and anything else becomes the cause of a new one. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(serializeError(value), { cause: value });
}

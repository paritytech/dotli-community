// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An error with its `name` set, so it reaches Sentry as its own exception type.
 *
 * CAUTION: sets `name` on the error it is given, in place, and returns that same error.
 */
export function setErrorName<E extends Error>(error: E, name: string): E {
  error.name = name;
  return error;
}

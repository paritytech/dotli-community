// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Callers branch on `error.name`, not `instanceof`, because errors are rebuilt across postMessage.
// Kept apart from the throwing modules so importing a name pulls in no hashing code.

export const CONTENT_ERRORS = {
  /** Fetched bytes are not the content the CID names, or cannot be checked. */
  VERIFICATION: 'ContentVerificationError',
} as const;

/** `err` with its `name` set, so it reaches Sentry as its own exception type. */
export function named<E extends Error>(err: E, name: string): E {
  err.name = name;
  return err;
}

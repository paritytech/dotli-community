// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const API_STOPPED_ERROR_NAME = 'ApiStoppedError';

/** The chainHead follow stopped, so the caller must redial. Distinct from a `null` unset slot. */
export class ApiStoppedError extends Error {
  override readonly name = API_STOPPED_ERROR_NAME;

  constructor(cause?: unknown) {
    super('chainHead follow stopped', { cause });
  }
}

/**
 * Whether `error` is an `ApiStoppedError`, or one rebuilt under its name after crossing to another context. Never
 * throws.
 */
export function isApiStoppedError(error: unknown): boolean {
  return error instanceof Error && error.name === API_STOPPED_ERROR_NAME;
}

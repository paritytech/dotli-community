// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The steps the root and the executable manifest validators share.

import { getErrorMessage } from '@dotli/shared';
import type { ValidationErr, ValidationResult } from './manifestTypes.js';

/** Parses a manifest record's text, failing with an error that names the manifest as `what`. */
export function parseManifestJson(json: string, what: string): ValidationResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    return { ok: false, errors: [`${what} is not valid JSON: ${getErrorMessage(error)}`] };
  }
}

/** Returns the unsupported-version result for a `$v` other than 1, or `null` for a v1 manifest. */
export function checkVersion(input: Record<string, unknown>, what: string): ValidationErr | null {
  const version = input['$v'];
  if (version === 1) {
    return null;
  }
  return {
    ok: false,
    unsupportedVersion: version,
    errors: [`${what} $v ${JSON.stringify(version)} is not supported (expected 1)`],
  };
}

/** Narrows a value to a string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ManifestRecordResult, ValidationResult } from './manifestTypes.js';

/** Maps a record's text to its result: no text is `empty`, and a failed parse keeps the text. */
export function toManifestResult<T>(
  raw: string | null,
  parse: (json: string) => ValidationResult<T>,
): ManifestRecordResult<T> {
  if (raw === null || raw.length === 0) {
    return { kind: 'empty' };
  }
  const parsed = parse(raw);
  if (parsed.ok) {
    return { kind: 'ok', value: parsed.value, raw };
  }
  if ('unsupportedVersion' in parsed) {
    const version = parsed.unsupportedVersion === undefined ? 'undefined' : JSON.stringify(parsed.unsupportedVersion);
    return { kind: 'unsupported-version', version, raw };
  }
  return { kind: 'invalid', errors: parsed.errors, raw };
}

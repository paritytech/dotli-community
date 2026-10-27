// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isStringArray } from '@dotli/shared';
import { describeValueType } from './describeValueType.js';

/** `value` when it is an array of strings. Throws an error naming `path` and what was found otherwise. */
export function readStrings(value: unknown, path: string): readonly string[] {
  if (!isStringArray(value)) {
    throw new Error(`${path} must be an array of strings, got ${describeFound(value)}.`);
  }
  return value;
}

// An array that reaches the message failed the string check, so it has a non-string item.
function describeFound(value: unknown): string {
  if (Array.isArray(value)) {
    return 'an array with a non-string item';
  }
  return describeValueType(value);
}

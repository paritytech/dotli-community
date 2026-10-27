// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from '@dotli/shared';
import { describeValueType } from './describeValueType.js';

/** `value` when it is a non-array object. Throws an error naming `path` and what was found otherwise. */
export function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object, got ${describeValueType(value)}.`);
  }
  return value;
}

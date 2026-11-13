// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallErrorValue } from '@parity/truapi';

/** The call error a core answers with, its domain error in the method's `version` envelope. */
export function toVersionedError<Value, Version extends string>(
  error: CallErrorValue<Value>,
  version: Version,
): CallErrorValue<{ tag: Version; value: Value }> {
  return error.tag === 'Domain' ? { tag: 'Domain', value: { tag: version, value: error.value } } : error;
}

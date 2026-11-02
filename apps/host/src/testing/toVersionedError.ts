// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallErrorValue } from '@parity/truapi';

/** The call error a core answers with, its domain error in the version 1 envelope. */
export function toVersionedError<Value>(error: CallErrorValue<Value>): CallErrorValue<{ tag: 'V1'; value: Value }> {
  return error.tag === 'Domain' ? { tag: 'Domain', value: { tag: 'V1', value: error.value } } : error;
}

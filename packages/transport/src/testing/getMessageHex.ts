// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Message bytes as hex, for byte-level assertions.

import { toHex } from '@dotli/shared';
import { getFrameName } from './getFrameName.js';
import { readFrame } from './readFrame.js';
import { testSchema } from './testSchema.js';

/**
 * The message bytes of the calls a channel delivered under one name, such as `request:notes.read`, as hex, which
 * compares a large message at once.
 */
export function getMessageHex(delivered: readonly Uint8Array[], name: string): string[] {
  return delivered.flatMap(data => {
    const heard = readFrame(testSchema, data);
    return heard.kind === 'call' && getFrameName(heard) === name ? [toHex(heard.message)] : [];
  });
}

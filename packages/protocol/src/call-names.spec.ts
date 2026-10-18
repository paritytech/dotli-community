// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { callName, callNameOf } from './call-names.js';

describe('call names', () => {
  it('As a dotli operator, I read a call the transport names by strings under its flat name, and any other by its names', () => {
    // Given
    const named = [
      ['resolve', 'owner'],
      ['chain', 'connect'],
      ['resolve', 'constructor'],
      ['toString', 'owner'],
      ['notes', 'read'],
    ] as const;

    // When
    const names = named.map(([trait, method]) => callNameOf(trait, method));

    // Then
    expect(names).toEqual([
      callName('resolve', 'owner'),
      'chainConnect',
      'resolve.constructor',
      'toString.owner',
      'notes.read',
    ]);
  });
});

// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { callName, callNameAt } from './call-names.js';
import { protocolSchema } from './schema.js';

describe('call names', () => {
  it('As a dotli operator, I read each protocol method under its flat name', () => {
    // Given
    const methods = [...protocolSchema.addresses.keys()];

    // When
    const names = methods.map(callName);

    // Then
    expect(new Set(names).size).toBe(methods.length);
    expect(callName(protocolSchema.traits.resolve.owner)).toBe('resolveOwner');
  });

  it('As a dotli operator, I read a call the transport names by strings under its flat name, and any other by its place', () => {
    // Given
    const named = [
      ['resolve', 'owner'],
      ['chain', 'connect'],
      ['resolve', 'constructor'],
      ['toString', 'owner'],
      ['notes', 'read'],
    ] as const;

    // When
    const names = named.map(([trait, method]) => callNameAt(trait, method));

    // Then
    expect(names).toEqual(['resolveOwner', 'chainConnect', 'resolve.constructor', 'toString.owner', 'notes.read']);
  });
});

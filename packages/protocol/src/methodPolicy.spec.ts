// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AnyMethod } from '@dotli/transport';
import { describe, expect, it } from 'vitest';
import { getCallName, getCallNameAt } from './methodPolicy.js';
import { protocolSchema } from './schema.js';

describe('method policy', () => {
  it('As a dotli operator, I read each protocol method under its flat name', () => {
    // Given
    const methods = Object.values(protocolSchema.sections).flatMap((section: Readonly<Record<string, AnyMethod>>) =>
      Object.values(section),
    );

    // When
    const names = methods.map(getCallName);

    // Then
    expect(new Set(names).size).toBe(methods.length);
    expect(getCallName(protocolSchema.sections.resolve.owner)).toBe('resolveOwner');
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
    const names = named.map(([section, method]) => getCallNameAt(section, method));

    // Then
    expect(names).toEqual(['resolveOwner', 'chainConnect', 'resolve.constructor', 'toString.owner', 'notes.read']);
  });
});

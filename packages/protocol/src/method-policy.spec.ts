// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AnyMethod } from '@dotli/transport';
import { describe, expect, it } from 'vitest';
import { callName, callNameAt, policyOf } from './method-policy.js';
import { protocolSchema } from './schema.js';

describe('method policy', () => {
  it('As a dotli operator, I read each protocol method under its flat name', () => {
    // Given
    const methods = Object.values(protocolSchema.sections).flatMap((section: Readonly<Record<string, AnyMethod>>) =>
      Object.values(section),
    );

    // When
    const names = methods.map(callName);

    // Then
    expect(new Set(names).size).toBe(methods.length);
    expect(callName(protocolSchema.sections.resolve.owner)).toBe('resolveOwner');
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
    const names = named.map(([section, method]) => callNameAt(section, method));

    // Then
    expect(names).toEqual(['resolveOwner', 'chainConnect', 'resolve.constructor', 'toString.owner', 'notes.read']);
  });

  it('As a dotli operator, I see a page load step trailed, a chain message untimed, and the shared store asked once the frame listens', () => {
    // Given
    const { resolve, chain, storage, wallet, frame } = protocolSchema.sections;

    // When
    const [owner, send, authRead, walletRead, warmup] = [
      resolve.owner,
      chain.send,
      storage.authRead,
      wallet.read,
      frame.warmup,
    ].map(policyOf);

    // Then
    expect(owner).toMatchObject({ trailed: true, timed: true, whenListening: false, budgetMs: 90_000 });
    expect(send).toMatchObject({ trailed: false, timed: false, whenListening: false });
    expect(authRead).toMatchObject({ whenListening: true, budgetMs: 30_000 });
    expect(walletRead).toMatchObject({ whenListening: true, budgetMs: 5_000 });
    expect(warmup).toMatchObject({ trailed: true, budgetMs: null });
  });
});

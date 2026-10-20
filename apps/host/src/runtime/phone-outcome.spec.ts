// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeWireMessage } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { decodePhoneOutcome } from './phone-outcome.js';
import { responseFrame } from './phone-requests.fake.js';
import type { PhoneMethod } from './phone-requests.js';

function outcomeOf(method: PhoneMethod, result: Parameters<typeof responseFrame>[2]) {
  const decoded = decodeWireMessage(responseFrame('a', method, result));
  if (decoded.isErr()) {
    throw decoded.error;
  }
  return decodePhoneOutcome(method, decoded.value.payload.value);
}

const SIGNATURE = { signature: '0x01' };

describe.each([
  ['signPayload', SIGNATURE],
  ['signRaw', SIGNATURE],
  ['requestResourceAllocation', { outcomes: ['Allocated'] }],
] as [PhoneMethod, unknown][])('phone outcome of %s', (method, ok) => {
  it('As a product, a successful answer reads as ok', () => {
    // Given
    const result = { ok };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome.kind).toBe('ok');
    expect(outcome).toMatchObject({ method });
  });

  it('As a product, a cancelled call reads as withdrawn', () => {
    // Given
    const result = { error: { tag: 'Cancelled' as const } };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'withdrawn' });
  });

  it('As a user, an unknown domain error reads as failed with its reason', () => {
    // Given
    const result = { domain: { tag: 'Unknown', value: { reason: 'phone offline' } } };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', reason: 'phone offline' });
  });
});

describe.each(['signPayload', 'signRaw'] as PhoneMethod[])('phone outcome of %s', method => {
  it('As a user, a rejection on the phone reads as rejected', () => {
    // Given
    const result = { domain: { tag: 'Rejected' } };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'rejected' });
  });
});

describe('phone outcome', () => {
  it('As a user, an error without a reason reads as failed with its tag', () => {
    // Given
    const result = { error: { tag: 'Denied' as const } };

    // When
    const outcome = outcomeOf('signPayload', result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', reason: 'Denied' });
  });

  it('As a user, an allocation response carries every outcome', () => {
    // Given
    const result = { ok: { outcomes: ['Allocated', 'Rejected', 'NotAvailable'] } };

    // When
    const outcome = outcomeOf('requestResourceAllocation', result);

    // Then
    expect(outcome).toEqual({
      kind: 'ok',
      method: 'requestResourceAllocation',
      allocations: ['Allocated', 'Rejected', 'NotAvailable'],
    });
  });
});

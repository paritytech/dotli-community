// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeWireMessage } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { decodePhoneOutcome, phoneMetricOutcome, type PhoneOutcome } from './phone-outcome.js';
import { responseFrame } from './phone-requests.fake.js';
import type { PhoneMethod } from './phone-methods.js';

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
  it('As a host, I decode a successful answer and read it as ok', () => {
    // Given
    const result = { ok };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome.kind).toBe('ok');
    expect(outcome).toMatchObject({ method });
  });

  it('As a host, I decode a cancelled call and read it as withdrawn', () => {
    // Given
    const result = { error: { tag: 'Cancelled' as const } };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'withdrawn' });
  });

  it('As a host, I decode an unknown domain error and read it as failed with its reason', () => {
    // Given
    const result = { domain: { tag: 'Unknown', value: { reason: 'phone offline' } } };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', tag: 'Unknown', reason: 'phone offline' });
  });
});

describe.each(['signPayload', 'signRaw'] as PhoneMethod[])('phone outcome of %s', method => {
  it('As a host, I decode a rejection on the phone and read it as rejected', () => {
    // Given
    const result = { domain: { tag: 'Rejected' } };

    // When
    const outcome = outcomeOf(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'rejected' });
  });
});

describe('phone outcome', () => {
  it('As a host, I decode a denied call and read it as failed with its tag', () => {
    // Given
    const result = { error: { tag: 'Denied' as const } };

    // When
    const outcome = outcomeOf('signPayload', result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', tag: 'Denied', reason: 'Denied' });
  });

  it('As a host, I decode an allocation response and read every outcome', () => {
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

describe('phone outcome failures', () => {
  it('As a host, I decode a malformed frame error and read its reason', () => {
    // Given
    const result = { error: { tag: 'MalformedFrame' as const, value: { reason: 'bad bytes' } } };

    // When
    const outcome = outcomeOf('signRaw', result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', tag: 'MalformedFrame', reason: 'bad bytes' });
  });

  it('As a host, I decode a host failure and read its reason', () => {
    // Given
    const result = { error: { tag: 'HostFailure' as const, value: { reason: 'phone unreachable' } } };

    // When
    const outcome = outcomeOf('signRaw', result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', tag: 'HostFailure', reason: 'phone unreachable' });
  });

  it('As a host, I decode an unsupported call and read its tag as the reason', () => {
    // Given
    const result = { error: { tag: 'Unsupported' as const } };

    // When
    const outcome = outcomeOf('signRaw', result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', tag: 'Unsupported', reason: 'Unsupported' });
  });
});

describe('phone metric outcome', () => {
  it('As a host, I count each ending with the shared metric vocabulary', () => {
    // Given
    const endings: PhoneOutcome[] = [
      { kind: 'ok', method: 'signRaw' },
      { kind: 'rejected' },
      { kind: 'withdrawn' },
      { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' },
      { kind: 'gone' },
    ];

    // When
    const outcomes = endings.map(outcome => phoneMetricOutcome(outcome));

    // Then
    expect(outcomes).toEqual(['ok', 'refused', 'aborted', 'error', 'gone']);
  });

  it('As a host, I count an answer that did not decode as undecodable, not as an error', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'undecodable' };

    // When
    const counted = phoneMetricOutcome(outcome);

    // Then
    expect(counted).toBe('undecodable');
  });
});

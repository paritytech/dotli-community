// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeWireMessage } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { decodePhoneOutcome, getPhoneMetricOutcome, type PhoneOutcome } from './phoneOutcome.js';
import { encodePhoneResponseFrame, type PhoneResult } from '../testing/encodePhoneResponseFrame.js';
import type { PhoneMethod } from './phoneMethods.js';

const SIGNATURE = { signature: '0x01' };

const SUCCESSES: [PhoneMethod, unknown][] = [
  ['signPayload', SIGNATURE],
  ['signRaw', SIGNATURE],
  ['requestResourceAllocation', { outcomes: ['Allocated'] }],
];

const SIGNING_METHODS: PhoneMethod[] = ['signPayload', 'signRaw'];

/** The outcome `method`'s answer carrying `result` decodes to. Throws when the frame does not decode. */
function decodeOutcome(method: PhoneMethod, result: PhoneResult): PhoneOutcome {
  const decoded = decodeWireMessage(encodePhoneResponseFrame({ requestId: 'a', method, result }));
  if (decoded.isErr()) {
    throw decoded.error;
  }
  return decodePhoneOutcome(method, decoded.value.payload.value);
}

describe.each(SUCCESSES)('phone outcome of %s', (method, ok) => {
  it('As a Polkadot App user, I approve on my phone and the answer decodes as ok', () => {
    // Given
    const result: PhoneResult = { kind: 'ok', value: ok };

    // When
    const outcome = decodeOutcome(method, result);

    // Then
    expect(outcome.kind).toBe('ok');
    expect(outcome).toMatchObject({ method });
  });

  it('As a Polkadot App user, I see the call cancelled and the answer decodes as withdrawn', () => {
    // Given
    const result: PhoneResult = { kind: 'error', error: { tag: 'Cancelled' } };

    // When
    const outcome = decodeOutcome(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'withdrawn' });
  });

  it('As a Polkadot App user, I hit an unknown domain error and the answer decodes as failed with its reason', () => {
    // Given
    const result: PhoneResult = { kind: 'domain', value: { tag: 'Unknown', value: { reason: 'phone offline' } } };

    // When
    const outcome = decodeOutcome(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'failed', tag: 'Unknown', reason: 'phone offline' });
  });
});

describe.each(SIGNING_METHODS)('phone outcome of %s', method => {
  it('As a Polkadot App user, I reject on my phone and the answer decodes as rejected', () => {
    // Given
    const result: PhoneResult = { kind: 'domain', value: { tag: 'Rejected' } };

    // When
    const outcome = decodeOutcome(method, result);

    // Then
    expect(outcome).toEqual({ kind: 'rejected' });
  });
});

describe('phone outcome', () => {
  it('As a Polkadot App user, I answer an allocation request and the answer decodes with every outcome', () => {
    // Given
    const result: PhoneResult = { kind: 'ok', value: { outcomes: ['Allocated', 'Rejected', 'NotAvailable'] } };

    // When
    const outcome = decodeOutcome('requestResourceAllocation', result);

    // Then
    expect(outcome).toEqual({
      kind: 'ok',
      method: 'requestResourceAllocation',
      allocations: ['Allocated', 'Rejected', 'NotAvailable'],
    });
  });
});

describe('phone outcome failures', () => {
  it.each([
    {
      method: 'signPayload',
      error: { tag: 'Denied' as const },
      failed: { kind: 'failed', tag: 'Denied', reason: 'Denied' },
    },
    {
      method: 'signRaw',
      error: { tag: 'MalformedFrame' as const, value: { reason: 'bad bytes' } },
      failed: { kind: 'failed', tag: 'MalformedFrame', reason: 'bad bytes' },
    },
    {
      method: 'signRaw',
      error: { tag: 'HostFailure' as const, value: { reason: 'phone unreachable' } },
      failed: { kind: 'failed', tag: 'HostFailure', reason: 'phone unreachable' },
    },
    {
      method: 'signRaw',
      error: { tag: 'Unsupported' as const },
      failed: { kind: 'failed', tag: 'Unsupported', reason: 'Unsupported' },
    },
  ] satisfies { method: PhoneMethod; error: unknown; failed: PhoneOutcome }[])(
    'As a Polkadot App user, I get a $error.tag call error and the answer decodes as failed with its reason',
    ({ method, error, failed }) => {
      // Given
      const result: PhoneResult = { kind: 'error', error };

      // When
      const outcome = decodeOutcome(method, result);

      // Then
      expect(outcome).toEqual(failed);
    },
  );
});

describe('phone metric outcome', () => {
  it('As an operator, I count each ending and get the shared metric vocabulary', () => {
    // Given
    const endings: PhoneOutcome[] = [
      { kind: 'ok', method: 'signRaw' },
      { kind: 'rejected' },
      { kind: 'withdrawn' },
      { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' },
      { kind: 'gone' },
    ];

    // When
    const outcomes = endings.map(outcome => getPhoneMetricOutcome(outcome));

    // Then
    expect(outcomes).toEqual(['ok', 'refused', 'aborted', 'error', 'gone']);
  });

  it('As an operator, I count an answer that did not decode and get undecodable, not an error', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'undecodable' };

    // When
    const counted = getPhoneMetricOutcome(outcome);

    // Then
    expect(counted).toBe('undecodable');
  });
});

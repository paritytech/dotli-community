// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { readSessionTuning, resolveBudgetCapMs } from './session-tuning.js';

describe('readSessionTuning', () => {
  it('As a visitor whose browser blocks frame storage, my direct-mode light client still starts, with its default tuning', () => {
    // Given a session store the browser refuses to hand over
    const expected: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: (_err, ctx) => {
          expected.push(ctx.step);
        },
      }),
    );

    // When
    const session = readSessionTuning(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    // Then the light client starts without the tuning, and the refusal is an expected failure
    expect(session).toBeNull();
    expect(expected).toEqual(['session_tuning']);
  });

  it('As a tester, the session I tuned reaches my light client', () => {
    // Given
    const store = { getItem: (key: string) => (key === 'dotli:truapi-provider-log' ? 'debug' : null) };

    // When
    const session = readSessionTuning(() => store);

    // Then
    expect(session?.getItem('dotli:truapi-provider-log')).toBe('debug');
  });
});

describe('resolveBudgetCapMs', () => {
  it.each([
    ['a positive whole number of milliseconds', '1000', 1000],
    ['no key', null, undefined],
    ['a value that is not a number', 'soon', undefined],
    ['zero', '0', undefined],
  ])('As a tester, %s in the session gives a resolve budget cap of %j', (_case, raw, cap) => {
    // Given
    const session = { getItem: (key: string) => (key === 'dotli:resolve-budget-ms' ? raw : null) };

    // When / Then
    expect(resolveBudgetCapMs(session)).toBe(cap);
  });

  it('As a tester whose browser blocks frame storage, I get no resolve budget cap', () => {
    // When / Then
    expect(resolveBudgetCapMs(null)).toBeUndefined();
  });
});

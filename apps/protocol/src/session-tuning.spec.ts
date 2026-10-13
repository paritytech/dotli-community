// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { readSessionTuning } from './session-tuning.js';

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

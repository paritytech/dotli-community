// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { readSessionTuning } from './readSessionTuning.js';

describe('readSessionTuning', () => {
  it('As a visitor whose browser blocks frame storage, I start my direct-mode light client and it runs with its default tuning', () => {
    // Given a session store the browser refuses to hand over
    const expected: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: (_error, context) => {
          expected.push(context.step);
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
});

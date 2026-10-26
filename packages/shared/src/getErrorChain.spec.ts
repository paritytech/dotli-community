// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getErrorChain } from './getErrorChain.js';

// Cycle detection follows the active path, so shared references are not cycles.
describe('getErrorChain cycle semantics', () => {
  it('As an operator reading a failure, I walk a cause shared by two branches and read it under each', () => {
    // Given
    const inner = new Error('inner boom');
    const left = new Error('left branch', { cause: inner });
    const right = new Error('right branch', { cause: inner });
    const aggregate = new AggregateError([left, right], 'both failed');

    // When
    const chain = getErrorChain(aggregate);

    // Then
    expect(chain.causes).toHaveLength(2);
    expect(chain.causes[0]?.message).toBe('left branch');
    expect(chain.causes[0]?.causes[0]?.message).toBe('inner boom');
    expect(chain.causes[0]?.causes[0]?.name).not.toBe('Cycle');
    expect(chain.causes[1]?.message).toBe('right branch');
    expect(chain.causes[1]?.causes[0]?.message).toBe('inner boom');
    expect(chain.causes[1]?.causes[0]?.name).not.toBe('Cycle');
  });

  it('As an operator reading a failure, I walk a cause that loops back and read it marked as a Cycle', () => {
    // Given
    const first = new Error('a');
    const second = new Error('b');
    first.cause = second;
    second.cause = first;

    // When
    const chain = getErrorChain(first);

    // Then
    expect(chain.message).toBe('a');
    expect(chain.causes).toHaveLength(1);
    expect(chain.causes[0]?.message).toBe('b');
    expect(chain.causes[0]?.causes).toHaveLength(1);
    expect(chain.causes[0]?.causes[0]?.name).toBe('Cycle');
  });
});

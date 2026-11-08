// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ChainHaltError, getHaltReason } from './chainHaltError.js';

describe('getHaltReason', () => {
  it('As a dotli integrator, I read from a chain halt error why its chain halted', () => {
    // Given
    const chain = new ChainHaltError('chain');
    const frame = new ChainHaltError('frame');

    // When
    const reasons = [getHaltReason(chain), getHaltReason(frame)];

    // Then
    expect(reasons).toEqual(['chain', 'frame']);
    expect(frame).toBeInstanceOf(Error);
    expect(frame.name).toBe('ChainHaltError');
    expect(frame.message).toBe('Chain halted (frame)');
  });

  it.each([
    { kind: 'a plain error', halt: new Error('smoldot died') },
    { kind: 'no error', halt: undefined },
    { kind: 'a string', halt: 'frame' },
    { kind: 'a plain object with a reason', halt: { reason: 'frame' } },
    {
      kind: 'an error that only carries the name',
      halt: Object.assign(new Error('Chain halted (frame)'), { name: 'ChainHaltError', reason: 'frame' }),
    },
  ])('As a dotli integrator, I read any other halt as a halt of the chain: $kind', ({ halt }) => {
    // When
    const reason = getHaltReason(halt);

    // Then
    expect(reason).toBe('chain');
  });
});

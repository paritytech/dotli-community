// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ChainHaltError, haltReasonOf } from '../src/chain-halted.js';

describe('haltReasonOf', () => {
  it('As a dotli integrator, a chain halt error tells why its chain halted', () => {
    // Given
    const chain = new ChainHaltError('chain');
    const frame = new ChainHaltError('frame');

    // When
    const reasons = [haltReasonOf(chain), haltReasonOf(frame)];

    // Then
    expect(reasons).toEqual(['chain', 'frame']);
    expect(frame).toBeInstanceOf(Error);
    expect(frame.name).toBe('ChainHaltError');
    expect(frame.message).toBe('Chain halted (frame)');
  });

  it('As a dotli integrator, a halt error from another realm is read by its name', () => {
    // Given
    const foreign = Object.assign(new Error('Chain halted (frame)'), { name: 'ChainHaltError', reason: 'frame' });

    // When
    const reason = haltReasonOf(foreign);

    // Then
    expect(reason).toBe('frame');
  });

  it('As a dotli integrator, any other halt is a halt of the chain', () => {
    // Given
    const others: unknown[] = [new Error('smoldot died'), undefined, 'frame', { reason: 'frame' }];

    // When
    const reasons = others.map(haltReasonOf);

    // Then
    expect(reasons).toEqual(['chain', 'chain', 'chain', 'chain']);
  });
});

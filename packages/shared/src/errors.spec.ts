// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { serializeError, fullErrorChain } from './errors.js';

describe('serializeError', () => {
  it('As an operator reading a failure, I see null thrown as null', () => {
    // When / Then
    expect(serializeError(null)).toBe('null');
  });

  it('As an operator reading a failure, I see undefined thrown as undefined', () => {
    // When / Then
    expect(serializeError(undefined)).toBe('undefined');
  });

  it('As an operator reading a failure, I see a thrown string as it is', () => {
    // When / Then
    expect(serializeError('boom')).toBe('boom');
  });

  it('As an operator reading a failure, I see an empty thrown string as Unknown error', () => {
    // When / Then
    expect(serializeError('')).toBe('Unknown error');
  });

  it('As an operator reading a failure, I see a thrown number or boolean as text', () => {
    // When / Then
    expect(serializeError(42)).toBe('42');
    expect(serializeError(false)).toBe('false');
  });

  it('As an operator reading a failure, I see an Error as its message', () => {
    // When / Then
    expect(serializeError(new Error('kaboom'))).toBe('kaboom');
  });

  it('As an operator reading a failure, I see an Error without a message as its name (DOTLI-1K)', () => {
    // Given
    const err = new Error('');

    // When / Then
    expect(serializeError(err)).toBe('Error');
  });

  it('As an operator reading a failure, I see an Error subclass without a message as its own name', () => {
    // Given
    class AlreadyDestroyedError extends Error {
      override name = 'AlreadyDestroyedError';
    }

    // When / Then
    expect(serializeError(new AlreadyDestroyedError(''))).toBe('AlreadyDestroyedError');
  });

  it('As an operator reading a failure, I see an Error with its cause described after it', () => {
    // Given
    const inner = new Error('inner boom');
    const outer = new Error('outer boom', { cause: inner });

    // When / Then
    expect(serializeError(outer)).toBe('outer boom (cause: inner boom)');
  });

  it('As an operator reading a failure, I see an Error with a cause that is no Error described after it', () => {
    // Given
    const outer = new Error('outer boom', { cause: 'string cause' });

    // When / Then
    expect(serializeError(outer)).toBe('outer boom (cause: string cause)');
  });

  it('As an operator reading a failure, I see an Error whose causes cycle described once, without recursing forever', () => {
    // Given
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;

    // When / Then
    expect(serializeError(a)).toBe('a (cause: b (cause: [cycle]))');
  });

  it('As an operator reading a failure, I see an AggregateError with its inner errors', () => {
    // Given
    const agg = new AggregateError([new Error('first'), new Error('second')], 'all failed');

    // When / Then
    expect(serializeError(agg)).toBe('all failed [first; second]');
  });

  it('As an operator reading a failure, I see an AggregateError with at most 3 of its inner errors', () => {
    // Given
    const agg = new AggregateError(
      [new Error('a'), new Error('b'), new Error('c'), new Error('d'), new Error('e')],
      'many failed',
    );

    // When / Then
    expect(serializeError(agg)).toBe('many failed [a; b; c, ...]');
  });

  it('As an operator reading a failure, I see a thrown object as its message', () => {
    // When / Then
    expect(serializeError({ message: 'plain object error' })).toBe('plain object error');
  });

  it('As an operator reading a failure, I see a thrown object with an empty message as its JSON', () => {
    // When / Then
    expect(serializeError({ message: '', code: 42 })).toBe('{"message":"","code":42}');
  });

  it('As an operator reading a failure, I see a thrown object without a message as its JSON', () => {
    // When / Then
    expect(serializeError({ code: -32603 })).toBe('{"code":-32603}');
  });

  it('As an operator reading a failure, I see an empty thrown object as [object Object]', () => {
    // When / Then
    expect(serializeError({})).toBe('[object Object]');
  });

  it('As an operator reading a failure, I see a thrown object that refers to itself without the report failing', () => {
    // Given
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    // When / Then
    expect(serializeError(cyclic)).toBe('[object Object]');
  });

  it('As an operator reading a failure, I see some text for anything thrown, never an empty string', () => {
    // Given
    const inputs: unknown[] = [null, undefined, '', 0, false, {}, [], new Error(''), new Error(), { message: '' }];

    // When / Then
    for (const value of inputs) {
      const out = serializeError(value);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

// Cycle detection follows the active path, so shared references are not cycles.
describe('fullErrorChain cycle semantics', () => {
  it('As an operator reading a failure, I see a cause shared by two branches described under each', () => {
    // Given
    const inner = new Error('inner boom');
    const left = new Error('left branch', { cause: inner });
    const right = new Error('right branch', { cause: inner });
    const agg = new AggregateError([left, right], 'both failed');

    // When
    const chain = fullErrorChain(agg);

    // Then
    expect(chain.causes).toHaveLength(2);
    expect(chain.causes[0]?.message).toBe('left branch');
    expect(chain.causes[0]?.causes[0]?.message).toBe('inner boom');
    expect(chain.causes[0]?.causes[0]?.name).not.toBe('Cycle');
    expect(chain.causes[1]?.message).toBe('right branch');
    expect(chain.causes[1]?.causes[0]?.message).toBe('inner boom');
    expect(chain.causes[1]?.causes[0]?.name).not.toBe('Cycle');
  });

  it('As an operator reading a failure, I see a cause that loops back marked as a Cycle', () => {
    // Given
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;

    // When
    const chain = fullErrorChain(a);

    // Then
    expect(chain.message).toBe('a');
    expect(chain.causes).toHaveLength(1);
    expect(chain.causes[0]?.message).toBe('b');
    expect(chain.causes[0]?.causes).toHaveLength(1);
    expect(chain.causes[0]?.causes[0]?.name).toBe('Cycle');
  });
});
